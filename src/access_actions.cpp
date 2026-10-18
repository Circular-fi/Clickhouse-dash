#include "access_actions.hpp"

#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {
namespace {

bool starts_with(std::string_view text, std::string_view prefix) { return text.substr(0, prefix.size()) == prefix; }

// One segment of a path: no slash, not empty.
bool one_segment(std::string_view text) { return !text.empty() && text.find('/') == std::string_view::npos; }

AccessRule rule(AccessRuleKind kind, const char* action = nullptr, bool database_param = false) {
  AccessRule out;
  out.kind = kind;
  out.action = action;
  out.database_param = database_param;
  return out;
}

AccessRule mcp_rule(std::string_view method, std::string_view path) {
  if (path == "/api/mcp/meta") return method == "GET" ? rule(AccessRuleKind::Identity) : rule(AccessRuleKind::Unknown);
  if (path == "/api/mcp/keys") {
    if (method == "GET") return rule(AccessRuleKind::Action, "mcp.keys.read");
    if (method == "POST") return rule(AccessRuleKind::Action, "mcp.keys.write");
    return rule(AccessRuleKind::Unknown);
  }
  if (path == "/api/mcp/access") return rule(AccessRuleKind::Action, "mcp.keys.read");
  if (path == "/api/mcp/usage" || path == "/api/mcp/usage/overview") return rule(AccessRuleKind::Action, "mcp.usage.read");
  static constexpr std::string_view kKeys = "/api/mcp/keys/";
  if (starts_with(path, kKeys)) {
    const std::string_view rest = path.substr(kKeys.size());
    const size_t slash = rest.find('/');
    if (slash == std::string_view::npos) {
      return one_segment(rest) && method == "DELETE" ? rule(AccessRuleKind::Action, "mcp.keys.write") : rule(AccessRuleKind::Unknown);
    }
    if (!one_segment(rest.substr(0, slash))) return rule(AccessRuleKind::Unknown);
    const std::string_view tail = rest.substr(slash);
    if (tail == "/adopt") return method == "POST" ? rule(AccessRuleKind::Action, "mcp.keys.write") : rule(AccessRuleKind::Unknown);
    if (tail == "/access") return rule(AccessRuleKind::Action, "mcp.keys.read");
    if (tail == "/usage" || tail == "/cost") return rule(AccessRuleKind::Action, "mcp.usage.read");
  }
  return rule(AccessRuleKind::Unknown);
}

} // namespace

const std::vector<AccessAction>& access_actions() {
  static const std::vector<AccessAction> actions = {
      {"query.run.read", true, "Run queries on the Query page. Without query.run.write, each statement runs with readonly = 1."},
      {"query.run.write", true, "Run queries that change data or settings (no readonly = 1)."},
      {"query.export", true, "Export the results of queries to a file."},
      {"library.read", false, "Read the saved queries of the server query library."},
      {"library.write", false, "Save, change, move, delete and import the queries of the server query library."},
      {"explorer.read", true, "Open the Explorer: databases, tables, columns, data preview, lineage and storage."},
      {"system.read", false, "Open the System page: overview, queries, disks, activity and Keeper."},
      {"system.kill_query", false, "Stop the queries of other users. ChDash has no such control yet: the action is reserved."},
      {"observability.read", false, "Open the Traces, Logs and Metrics pages."},
      {"mcp.keys.read", false, "See the MCP keys and what each key can read."},
      {"mcp.keys.write", false, "Make, delete and adopt MCP keys."},
      {"mcp.usage.read", false, "See the usage and the cost of the MCP keys."},
  };
  return actions;
}

std::string access_actions_json(std::string_view server) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("server");
  write_json_text(w, server);
  w.Key("actions");
  w.StartArray();
  for (const AccessAction& action : access_actions()) {
    w.StartObject();
    w.Key("name");
    w.String(action.name);
    w.Key("resource_types");
    w.StartArray();
    w.String("service");
    if (action.database) w.String("database");
    w.EndArray();
    w.Key("description");
    w.String(action.description);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

AccessRule access_rule(std::string_view method_in, std::string_view path) {
  const std::string_view method = method_in == "HEAD" ? std::string_view("GET") : method_in;
  if (path == "/livez" || path == "/readyz" || path == "/healthz" || path == "/metrics" || path == "/.well-known/access-actions" ||
      path == "/mcp") {
    return rule(AccessRuleKind::Exempt);
  }
  // The pages, their files and the redirects of former addresses: they read no data.
  if (!starts_with(path, "/api/")) return rule(AccessRuleKind::Identity);

  if (path == "/api/version" || path == "/api/hosts" || path == "/api/hosts/stream" || path == "/api/health") {
    return method == "GET" ? rule(AccessRuleKind::Identity) : rule(AccessRuleKind::Unknown);
  }
  // The stream and the cancel of a run, and the cancel of a Deep Analyze: the query id and the cancel token come from a request
  // that the rule of its route checked.
  if ((path == "/api/query/stream" && method == "GET") || (path == "/api/query/cancel" && method == "POST") ||
      (path == "/api/query/deep-analysis/cancel" && method == "POST")) {
    return rule(AccessRuleKind::Identity);
  }
  if (((path == "/api/query/run" || path == "/api/query" || path == "/api/query/analysis" || path == "/api/format") && method == "POST") ||
      (path == "/api/query/deep-analysis" && (method == "POST" || method == "GET")) || (path == "/api/query/execution" && method == "GET")) {
    return rule(AccessRuleKind::Run);
  }
  // The names of the editor (keywords, functions, the tables and the columns of a database).
  if (path == "/api/meta" && method == "GET") return rule(AccessRuleKind::Run, nullptr, true);
  if (path == "/api/export/run" || path == "/api/export/stream") return rule(AccessRuleKind::Export);

  if (starts_with(path, "/api/traces/") || starts_with(path, "/api/logs/") || starts_with(path, "/api/metrics/")) {
    return method == "GET" ? rule(AccessRuleKind::Action, "observability.read") : rule(AccessRuleKind::Unknown);
  }
  if (path == "/api/query-library" || starts_with(path, "/api/query-library/")) {
    if (method == "GET") return rule(AccessRuleKind::Action, "library.read");
    if (method == "POST" || method == "PATCH" || method == "DELETE") return rule(AccessRuleKind::Action, "library.write");
    return rule(AccessRuleKind::Unknown);
  }
  if (starts_with(path, "/api/mcp/")) return mcp_rule(method, path);
  if (starts_with(path, "/api/system/") || starts_with(path, "/api/explorer/ops/")) {
    return method == "GET" ? rule(AccessRuleKind::Action, "system.read") : rule(AccessRuleKind::Unknown);
  }
  if (path == "/api/explorer/table/data") {
    return method == "POST" ? rule(AccessRuleKind::Deferred, "explorer.read") : rule(AccessRuleKind::Unknown);
  }
  if (starts_with(path, "/api/explorer/")) {
    return method == "GET" ? rule(AccessRuleKind::Action, "explorer.read", true) : rule(AccessRuleKind::Unknown);
  }
  return rule(AccessRuleKind::Unknown);
}

} // namespace chdash
