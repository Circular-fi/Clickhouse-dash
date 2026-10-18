#include "access_actions.hpp"

#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {
namespace {

bool starts_with(std::string_view text, std::string_view prefix) { return text.substr(0, prefix.size()) == prefix; }

// One segment of a path: no slash, not empty.
bool one_segment(std::string_view text) { return !text.empty() && text.find('/') == std::string_view::npos; }

AccessRule rule(AccessRuleKind kind, const char* action = nullptr) {
  AccessRule out;
  out.kind = kind;
  out.action = action;
  return out;
}

// A rule on the host of the request. `database_param`: the parameter (or the field) database narrows it to one database of the host.
// `body`: the host and the database are in the JSON body.
AccessRule host_rule(AccessRuleKind kind, const char* action, bool database_param = false, bool body = false) {
  AccessRule out = rule(kind, action);
  out.host = true;
  out.database_param = database_param;
  out.body = body;
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

const std::vector<AccessResourceType>& access_resource_types() {
  static const std::vector<AccessResourceType> types = {
      {"host", "service", "One ClickHouse server of the configuration: the name of its clickhouse.host block."},
      {"database", "host", "One database of a host."},
  };
  return types;
}

const std::vector<AccessAction>& access_actions() {
  static const std::vector<AccessAction> actions = {
      {"query.run.read", true, true, "Run queries on the Query page. Without query.run.write, each statement runs with readonly = 1."},
      {"query.run.write", true, true, "Run queries that change data or settings (no readonly = 1)."},
      {"query.export", true, false, "Export the results of queries to a file."},
      {"library.read", false, false, "Read the saved queries of the server query library."},
      {"library.write", false, false, "Save, change, move, delete and import the queries of the server query library."},
      {"explorer.read", true, true, "Open the Explorer: databases, tables, columns, data preview, lineage and storage."},
      {"system.read", true, false, "Open the System page: overview, queries, disks, activity and Keeper."},
      {"system.kill_query", true, false, "Stop the queries of other users. ChDash has no such control yet: the action is reserved."},
      {"observability.read", true, false, "Open the Traces, Logs and Metrics pages."},
      {"mcp.keys.read", false, false, "See the MCP keys and what each key can read."},
      {"mcp.keys.write", false, false, "Make, delete and adopt MCP keys."},
      {"mcp.usage.read", false, false, "See the usage and the cost of the MCP keys."},
  };
  return actions;
}

const AccessAction* access_action(std::string_view name) {
  for (const AccessAction& action : access_actions()) {
    if (name == action.name) return &action;
  }
  return nullptr;
}

std::string access_actions_json(std::string_view server) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("server");
  write_json_text(w, server);
  // The tree under the service (contract 11.4). The service is the root: it is not in the list.
  w.Key("resource_types");
  w.StartArray();
  for (const AccessResourceType& type : access_resource_types()) {
    w.StartObject();
    w.Key("name");
    w.String(type.name);
    w.Key("parent");
    w.String(type.parent);
    w.Key("description");
    w.String(type.description);
    w.EndObject();
  }
  w.EndArray();
  w.Key("actions");
  w.StartArray();
  for (const AccessAction& action : access_actions()) {
    w.StartObject();
    w.Key("name");
    w.String(action.name);
    w.Key("resource_types");
    w.StartArray();
    w.String("service");
    if (action.host) w.String("host");
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
  // A run names its host in the JSON body (POST) or in the parameter host_id (GET).
  if ((path == "/api/query/run" || path == "/api/query" || path == "/api/query/analysis" || path == "/api/format" ||
       path == "/api/query/deep-analysis") &&
      method == "POST") {
    return host_rule(AccessRuleKind::Run, nullptr, false, true);
  }
  if ((path == "/api/query/deep-analysis" || path == "/api/query/execution") && method == "GET") return host_rule(AccessRuleKind::Run, nullptr);
  // The names of the editor (keywords, functions, the tables and the columns of a database).
  if (path == "/api/meta" && method == "GET") return host_rule(AccessRuleKind::Run, nullptr, true);
  if (path == "/api/export/run" || path == "/api/export/stream") return host_rule(AccessRuleKind::Export, nullptr, false, method == "POST");

  if (starts_with(path, "/api/traces/") || starts_with(path, "/api/logs/") || starts_with(path, "/api/metrics/")) {
    return method == "GET" ? host_rule(AccessRuleKind::Action, "observability.read") : rule(AccessRuleKind::Unknown);
  }
  if (path == "/api/query-library" || starts_with(path, "/api/query-library/")) {
    if (method == "GET") return rule(AccessRuleKind::Action, "library.read");
    if (method == "POST" || method == "PATCH" || method == "DELETE") return rule(AccessRuleKind::Action, "library.write");
    return rule(AccessRuleKind::Unknown);
  }
  if (starts_with(path, "/api/mcp/")) return mcp_rule(method, path);
  if (starts_with(path, "/api/system/") || starts_with(path, "/api/explorer/ops/")) {
    return method == "GET" ? host_rule(AccessRuleKind::Action, "system.read") : rule(AccessRuleKind::Unknown);
  }
  // The data preview names its host and its database in the body.
  if (path == "/api/explorer/table/data") {
    return method == "POST" ? host_rule(AccessRuleKind::Action, "explorer.read", true, true) : rule(AccessRuleKind::Unknown);
  }
  if (starts_with(path, "/api/explorer/")) {
    return method == "GET" ? host_rule(AccessRuleKind::Action, "explorer.read", true) : rule(AccessRuleKind::Unknown);
  }
  return rule(AccessRuleKind::Unknown);
}

} // namespace chdash
