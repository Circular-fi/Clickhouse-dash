#include "mcp_tools_units.hpp"

#include "json_parse.hpp"
#include "mcp_usage.hpp"

#include <algorithm>

namespace chdash {
namespace mcp_tools {

// ---- the analysis of the keys ----------------------------------------------------------------------------------
//
// The analysis has three tools. A key reads its own limits with mcp_analysis_my_limits.
// A key reads its own usage with mcp_analysis_my_usage. This tool adds the ClickHouse cost of the statements, when the key asks for it.
// A key reads the usage of every key of every instance with mcp_analysis_all_usage.
// The key must name this tool, and the configuration must enable it.
//
// The tools run no SQL of the MCP user. They take no host.
// The server gives the rate limit, the usage and the cost through McpAnalysis (mcp_tools.hpp).
// Every answer is bounded by its row limits, and by max_result_bytes like any result.

namespace {

constexpr const char* kMyLimits = "mcp_analysis_my_limits";
constexpr const char* kMyUsage = "mcp_analysis_my_usage";
constexpr const char* kAllUsage = "mcp_analysis_all_usage";
constexpr const char* kDefaultWindow = "24h";
// The row limits of the lists of the usage of one key (its tools, its results, its clients), and of all the keys.
constexpr size_t kMyUsageRows = 20;
constexpr int64_t kDefaultRows = 20;
constexpr int64_t kMaxRows = 200;

// The server side of the analysis checks the configuration of the tool.
// The protocol checks this too. It never runs a tool that is off.
// The tool does not trust its caller, though. The usage of all the keys must not depend on one check.
McpAnalysis& offered(Ctx& ctx, const char* tool) {
  if (!ctx.analysis) fail("not_enabled", "this server does not offer the analysis of the keys");
  const McpToolInfo* info = mcp_find_tool(tool);
  const std::string off = info ? mcp_tool_unavailable_reason(*info, ctx.analysis->availability()) : std::string();
  if (!off.empty()) fail("not_enabled", off);
  return *ctx.analysis;
}

// A failure on the server's side is a failure of the tool, with the same code.
template <typename F>
auto relay(F&& call) -> decltype(call()) {
  try {
    return call();
  } catch (const McpAnalysisError& error) {
    fail(error.code(), error.what());
  }
}

// A list has at most 20 strings. An absent or null argument is an empty list.
// The rules of each value are the rules of the usage (mcp_usage_overview_check).
// The caller applies these rules once the list is whole.
std::vector<std::string> opt_names(const rapidjson::Value& args, const char* name) {
  std::vector<std::string> out;
  const auto it = args.FindMember(name);
  if (it == args.MemberEnd() || it->value.IsNull()) return out;
  if (!it->value.IsArray()) fail("invalid_argument", std::string(name) + " must be a list of strings");
  if (it->value.Size() > kMcpUsageOverviewMaxValues) {
    fail("invalid_argument", std::string(name) + " takes at most " + std::to_string(kMcpUsageOverviewMaxValues) + " values");
  }
  for (const auto& item : it->value.GetArray()) {
    if (!item.IsString()) fail("invalid_argument", std::string(name) + " must be a list of strings");
    out.emplace_back(item.GetString(), item.GetStringLength());
  }
  return out;
}

// The names of instances follow the rule of the filter `instance` of the page. A name appears once. The list has at most 20 names, and each name is valid.
void check_instances(std::vector<std::string>* instances) {
  McpUsageOverviewQuery probe;
  probe.instances = std::move(*instances);
  if (const auto error = mcp_usage_overview_check(&probe)) fail("invalid_argument", error->message);
  *instances = std::move(probe.instances);
}

// The window of the call. It is a window that the retention of the usage keeps. The default is 24h, when none is given.
std::string window_of(McpAnalysis& server, const rapidjson::Value& args) {
  std::string window = opt_string(args, "window", 16).value_or(std::string());
  if (window.empty()) window = kDefaultWindow;
  const std::vector<std::string> windows = server.usage_windows();
  if (std::find(windows.begin(), windows.end(), window) == windows.end()) {
    std::string names;
    for (const auto& name : windows) names += (names.empty() ? "" : ", ") + name;
    fail("invalid_argument", "window must be one of " + names);
  }
  return window;
}

// An answer is bounded by its row limits. The cap of a result still applies (mcp.max_result_bytes).
// An administrator lowers this cap to keep the memory of the calls that run at once low.
std::string bounded(const Ctx& ctx, std::string json) {
  if (static_cast<int64_t>(json.size()) > ctx.config.max_result_bytes) {
    fail("result_too_large", "the answer is larger than " + std::to_string(ctx.config.max_result_bytes) +
                                 " bytes: narrow it (a shorter window, a filter, a smaller limit, no series)");
  }
  return json;
}

// The cap that a key meets for one limit is its own value, when that value lowers the cap of its host.
// Otherwise, the cap of the host applies. The cap of the host is the smaller of the configuration and the profile of the MCP user.
// The source names who sets the cap. A host cap that the server did not say is the configuration's.
McpAnalysisCap cap_of(const McpAnalysisCap& host, int64_t configured, const std::optional<int64_t>& key) {
  const McpAnalysisCap base = host.value > 0 ? host : McpAnalysisCap{configured, "mcp"};
  if (key && *key <= base.value) return McpAnalysisCap{*key, "key"};
  return base;
}

// Format: {"value": n, "source": "..."}. `value` is null for a limit that is not set. In the configuration, 0 means none, and 0 rows is not what it says.
void put_cap(Writer& w, const char* name, int64_t value, const std::string& source, bool zero_is_none = false) {
  w.Key(name);
  w.StartObject();
  w.Key("value");
  if (zero_is_none && value <= 0) w.Null();
  else w.Int64(value);
  w.Key("source"); put(w, source);
  w.EndObject();
}

// The usage of a key names the clients as they name themselves (clientInfo, User-Agent). ChDash did not write this text.
// The tool gives the whole answer of the page in `untrusted` (contract 5.2), as the API tools do.
std::string in_untrusted(const std::string& answer) { return "{\"untrusted\":" + answer + "}"; }

// The cost object is one more member of the usage object. The writers of the usage close their objects themselves.
// So the two are joined as documents. ChDash makes both objects. A parse failure is therefore a bug, and not an input.
std::string with_cost(const std::string& usage, const std::string& cost) {
  rapidjson::Document doc;
  rapidjson::Document cost_doc;
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc, usage);
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(cost_doc, cost);
  if (doc.HasParseError() || !doc.IsObject() || cost_doc.HasParseError() || !cost_doc.IsObject()) {
    fail("internal_error", "the usage or the cost could not be put together");
  }
  rapidjson::Value member;
  member.CopyFrom(cost_doc, doc.GetAllocator());
  doc.AddMember("cost", member, doc.GetAllocator());
  rapidjson::StringBuffer sb;
  Writer w(sb);
  doc.Accept(w);
  return finish(sb);
}

}  // namespace

// ---- mcp_analysis_my_limits ----------------------------------------------------------------------------------------

std::string tool_analysis_my_limits(Ctx& ctx, const rapidjson::Value& args) {
  McpAnalysis& server = offered(ctx, kMyLimits);
  reject_unknown(args, {});
  const McpAnalysisLimits limits = relay([&] { return server.limits(ctx.key); });
  const McpKey& key = ctx.key;
  const McpToolsConfig& config = ctx.config;

  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("key");
  w.StartObject();
  w.Key("id"); put(w, key.id);
  w.Key("name"); put(w, key.name);
  w.Key("host"); put(w, key.hosts.empty() ? std::string() : key.hosts.front());
  w.EndObject();
  // The instance has a name only while the usage is on. The name is the name of its usage file.
  w.Key("instance");
  if (limits.instance.empty()) w.Null();
  else put(w, limits.instance);
  // The bucket of this ChDash. Another instance has its own bucket. A key that uses two instances has two buckets. `null` means no limit.
  const McpRateStatus& rate = limits.rate;
  w.Key("rate_limit");
  w.StartObject();
  w.Key("per_minute");
  if (rate.per_minute > 0) w.Int64(rate.per_minute);
  else w.Null();
  w.Key("scope"); w.String("instance");
  w.Key("remaining");
  if (rate.per_minute > 0) w.Int64(rate.remaining);
  else w.Null();
  w.Key("next_call_in_seconds"); w.Int64(rate.next_call_in_seconds);
  w.Key("full_in_seconds"); w.Int64(rate.full_in_seconds);
  w.EndObject();
  // The key can lower the cap of its host for the rows and the seconds of a call. The other caps are the configuration's.
  // The profile of the MCP user can cut them further. ChDash reads only its rows and its time.
  const McpAnalysisCap rows = cap_of(limits.max_rows, config.max_rows, key.max_rows);
  put_cap(w, "max_rows", rows.value, rows.source);
  const McpAnalysisCap seconds = cap_of(limits.timeout_seconds, config.query_timeout_seconds, key.timeout_seconds);
  put_cap(w, "timeout_seconds", seconds.value, seconds.source);
  put_cap(w, "max_result_bytes", config.max_result_bytes, "mcp");
  put_cap(w, "max_sql_bytes", config.max_sql_bytes, "mcp");
  put_cap(w, "max_memory_bytes", config.max_memory_bytes, "mcp");
  put_cap(w, "max_rows_to_read", config.max_rows_to_read, "mcp", true);
  w.EndObject();
  return finish(sb);
}

// ---- mcp_analysis_my_usage -----------------------------------------------------------------------------------------

std::string tool_analysis_my_usage(Ctx& ctx, const rapidjson::Value& args) {
  McpAnalysis& server = offered(ctx, kMyUsage);
  reject_unknown(args, {"window", "series", "include_cost", "instance"});
  const std::string window = window_of(server, args);
  McpUsageDetailQuery query;
  query.series = opt_bool(args, "series").value_or(false);
  query.limit = kMyUsageRows;
  query.instances = opt_names(args, "instance");
  check_instances(&query.instances);
  const bool include_cost = opt_bool(args, "include_cost").value_or(false);

  std::string json = relay([&] { return server.my_usage(ctx.key, window, query, ctx.now); });
  if (include_cost) {
    // The cost reads system.query_log of the host of the key. The audit line of the call names this host. The cost is only the cost of this key, never another key's.
    if (!ctx.key.hosts.empty()) ctx.host = ctx.key.hosts.front();
    json = with_cost(json, relay([&] { return server.my_cost(ctx.key, window, ctx.now); }));
  }
  return bounded(ctx, in_untrusted(json));
}

// ---- mcp_analysis_all_usage ----------------------------------------------------------------------------------------

std::string tool_analysis_all_usage(Ctx& ctx, const rapidjson::Value& args) {
  McpAnalysis& server = offered(ctx, kAllUsage);
  // The second lock: the answer shows the names, hosts, clients and activity of the other keys. So the key must name the tool.
  // `*` does not name it. The protocol already refuses a key that does not hold the tool. A caller that skips the protocol is refused here.
  const auto& listed = ctx.key.tools;
  if (std::find(listed.begin(), listed.end(), kAllUsage) == listed.end()) {
    fail("tool_not_allowed", std::string("this key cannot use the tool ") + kAllUsage + ": its tools must name it (\"*\" does not include it)");
  }
  reject_unknown(args, {"window", "group", "order", "key", "method", "client", "instance", "series", "limit"});
  const std::string window = window_of(server, args);
  McpUsageOverviewQuery query;
  query.group = opt_string(args, "group", 16).value_or(std::string());
  if (query.group.empty()) query.group = "key";
  if (query.group != "key" && query.group != "method" && query.group != "client" && query.group != "instance") {
    fail("invalid_argument", "group must be key, method, client or instance");
  }
  // The orders are the same as the orders of the page. mcp_usage_overview_check (below) refuses another order and says which orders are valid.
  query.order = opt_string(args, "order", 64).value_or(std::string());
  if (query.order.empty()) query.order = "requests";
  query.keys = opt_names(args, "key");
  query.methods = opt_names(args, "method");
  query.clients = opt_names(args, "client");
  query.instances = opt_names(args, "instance");
  query.series = opt_bool(args, "series").value_or(false);
  query.limit = static_cast<size_t>(opt_int(args, "limit", 1, kMaxRows, kDefaultRows));
  if (const auto error = mcp_usage_overview_check(&query)) fail("invalid_argument", error->message);

  return bounded(ctx, in_untrusted(relay([&] { return server.all_usage(window, query, ctx.now); })));
}

}  // namespace mcp_tools
}  // namespace chdash
