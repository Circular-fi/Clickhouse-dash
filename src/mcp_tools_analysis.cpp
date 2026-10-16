#include "mcp_tools_units.hpp"

#include "json_parse.hpp"
#include "mcp_usage.hpp"

#include <algorithm>

namespace chdash {
namespace mcp_tools {

// ---- the analysis of the keys ----------------------------------------------------------------------------------
//
// Three tools by which a key reads its own limits (mcp_analysis_my_limits), its own usage with the ClickHouse cost of its statements when it
// asks (mcp_analysis_my_usage), and the usage of every key of every instance (mcp_analysis_all_usage, which a key must name and the
// configuration must allow). They run no SQL of the MCP user and take no host: the rate limit, the usage and the cost come from the server
// through McpAnalysis (mcp_tools.hpp). Every answer is bounded by its row limits, and by max_result_bytes like any result.

namespace {

constexpr const char* kMyLimits = "mcp_analysis_my_limits";
constexpr const char* kMyUsage = "mcp_analysis_my_usage";
constexpr const char* kAllUsage = "mcp_analysis_all_usage";
constexpr const char* kDefaultWindow = "24h";
// The rows of each list of the usage of one key (its tools, its results, its clients), and the rows of each list of all the keys.
constexpr size_t kMyUsageRows = 20;
constexpr int64_t kDefaultRows = 20;
constexpr int64_t kMaxRows = 200;

// The server's side of the analysis, when the configuration offers the tool. The protocol checks this too and never runs a tool that is off,
// but the tool does not trust its caller: the usage of all the keys must not depend on one check.
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

// A list of at most 20 strings (an absent or null argument is an empty list). The rules of each value are the ones of the usage
// (mcp_usage_overview_check), which the caller applies once the list is whole.
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

// The names of instances follow the rule of the filter `instance` of the page: a name once, at most 20, each one valid.
void check_instances(std::vector<std::string>* instances) {
  McpUsageOverviewQuery probe;
  probe.instances = std::move(*instances);
  if (const auto error = mcp_usage_overview_check(&probe)) fail("invalid_argument", error->message);
  *instances = std::move(probe.instances);
}

// The window of the call: one that the retention of the usage keeps (24h when none is given).
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

// An answer is bounded by its row limits, and the cap of a result still holds (mcp.max_result_bytes, which an administrator lowers to keep the
// memory of the calls that run at once low).
std::string bounded(const Ctx& ctx, std::string json) {
  if (static_cast<int64_t>(json.size()) > ctx.config.max_result_bytes) {
    fail("result_too_large", "the answer is larger than " + std::to_string(ctx.config.max_result_bytes) +
                                 " bytes: narrow it (a shorter window, a filter, a smaller limit, no series)");
  }
  return json;
}

// The cap that a key meets for one limit: its own value when it lowers the cap of its host (the smaller of the configuration and the profile
// of the MCP user), else the cap of the host and who sets it. A host cap that the server did not say is the configuration's.
McpAnalysisCap cap_of(const McpAnalysisCap& host, int64_t configured, const std::optional<int64_t>& key) {
  const McpAnalysisCap base = host.value > 0 ? host : McpAnalysisCap{configured, "mcp"};
  if (key && *key <= base.value) return McpAnalysisCap{*key, "key"};
  return base;
}

// {"value": n, "source": "..."}; `value` is null for a limit that is not set (0 is "none" in the configuration, and 0 rows is not what it says).
void put_cap(Writer& w, const char* name, int64_t value, const std::string& source, bool zero_is_none = false) {
  w.Key(name);
  w.StartObject();
  w.Key("value");
  if (zero_is_none && value <= 0) w.Null();
  else w.Int64(value);
  w.Key("source"); put(w, source);
  w.EndObject();
}

// The usage object with the cost object as one more member: the writers of the usage close their objects themselves, so the two are joined as
// documents. Both are made by ChDash, so a parse failure is a bug and not an input.
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
  // The instance has a name only while the usage is on (it is the name of its usage file).
  w.Key("instance");
  if (limits.instance.empty()) w.Null();
  else put(w, limits.instance);
  // The bucket of this ChDash: another instance has its own (a key that goes through two of them has two). `null` is no limit.
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
  // The rows and the seconds of a call: the key lowers the cap of its host. The other caps are the configuration's (the profile of the MCP user can
  // cut them further: ChDash reads only its rows and its time).
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
    // The cost reads system.query_log of the host of the key: the audit line of the call names it. Only the cost of this key, never another's.
    if (!ctx.key.hosts.empty()) ctx.host = ctx.key.hosts.front();
    json = with_cost(json, relay([&] { return server.my_cost(ctx.key, window, ctx.now); }));
  }
  return bounded(ctx, std::move(json));
}

// ---- mcp_analysis_all_usage ----------------------------------------------------------------------------------------

std::string tool_analysis_all_usage(Ctx& ctx, const rapidjson::Value& args) {
  McpAnalysis& server = offered(ctx, kAllUsage);
  // The second lock: the answer shows the names, hosts, clients and activity of the other keys, so the key must name the tool. `*` does not,
  // and the protocol already refuses a key that does not hold it; a caller that skips the protocol is refused here.
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
  // The same orders as the page: mcp_usage_overview_check (below) refuses another one and says which are valid.
  query.order = opt_string(args, "order", 64).value_or(std::string());
  if (query.order.empty()) query.order = "requests";
  query.keys = opt_names(args, "key");
  query.methods = opt_names(args, "method");
  query.clients = opt_names(args, "client");
  query.instances = opt_names(args, "instance");
  query.series = opt_bool(args, "series").value_or(false);
  query.limit = static_cast<size_t>(opt_int(args, "limit", 1, kMaxRows, kDefaultRows));
  if (const auto error = mcp_usage_overview_check(&query)) fail("invalid_argument", error->message);

  return bounded(ctx, relay([&] { return server.all_usage(window, query, ctx.now); }));
}

}  // namespace mcp_tools
}  // namespace chdash
