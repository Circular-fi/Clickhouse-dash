#include "access_actions.hpp"

#include "access_resource.hpp"
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
      {"observability.read", true, false, "Open the Traces, Logs and Metrics pages."},
      {"mcp.keys.read", false, false, "See the MCP keys and what each key can read."},
      {"mcp.keys.write", false, false, "Make, delete and adopt MCP keys."},
      {"mcp.usage.read", false, false, "See the usage and the cost of the MCP keys."},
      {"mcp.hosts.read", false, false, "List the ClickHouse hosts that the person can see: the MCP tool list_hosts."},
      {"mcp.analysis.read", false, false, "Read the limits and the usage of the person himself: the MCP tools mcp_analysis_my_limits and mcp_analysis_my_usage."},
      {"mcp.session", false, false, "Use the MCP endpoint: its requests that call no tool (initialize, ping, server/discover and the notifications)."},
  };
  return actions;
}

const AccessAction* access_action(std::string_view name) {
  for (const AccessAction& action : access_actions()) {
    if (name == action.name) return &action;
  }
  return nullptr;
}

AccessFeatures access_features_for(const AccessFeatureInputs& in) {
  AccessFeatures out;
  out.query_library = in.query_library;
  out.query_library_writable = in.query_library && in.query_library_writable;
  out.explorer = in.explorer;
  out.system = in.system;
  out.observability = in.observability;
  out.mcp = in.mcp;
  out.mcp_keys_write = in.mcp && in.mcp_keys_write;
  out.mcp_session = in.mcp && in.mcp_identity;
  const bool identity = out.mcp_session;
  out.mcp_write_tool = identity && in.any_mcp_host && in.any_mcp_write_host;
  out.mcp_export_tool = identity && in.any_mcp_host;
  out.mcp_library_write_tool = identity && out.query_library_writable;
  out.mcp_usage = in.usage;
  out.mcp_usage_tool = in.usage && in.usage_all_keys;
  return out;
}

bool access_action_published(const AccessAction& action, const AccessFeatures& features) {
  const std::string_view name = action.name;
  if (name == "library.read") return features.query_library;
  // A write of the library, a write of SQL and an export are published only when a tool serves them (the identity mode offers the tools
  // library_write, run_write_query and export_query). Without MCP, no tool exists and the pages publish what they serve.
  if (name == "library.write") return features.query_library && features.query_library_writable && (!features.mcp || features.mcp_library_write_tool);
  if (name == "query.run.write") return !features.mcp || features.mcp_write_tool;
  if (name == "query.export") return !features.mcp || features.mcp_export_tool;
  if (name == "explorer.read") return features.explorer;
  if (starts_with(name, "system.")) return features.system;
  if (name == "observability.read") return features.observability;
  // The identity mode has no key of ChDash: the keys live in the portal, and the routes of the keys answer 403 forbidden (the actions are not published). Nothing is left to
  // read or to write, so these two actions are not published there (docs/access.md, "Approval of an action").
  if (name == "mcp.keys.read") return features.mcp && !features.mcp_session;
  if (name == "mcp.keys.write") return features.mcp && features.mcp_keys_write && !features.mcp_session;
  // The usage is counted only when mcp.usage.enabled is true. In the identity mode the only function of the action is the tool
  // mcp_analysis_all_usage, which needs mcp.usage.all_keys too. The pages of the keys mode read the usage of the keys of their creator.
  if (name == "mcp.usage.read") return features.mcp && features.mcp_usage && (!features.mcp_session || features.mcp_usage_tool);
  // The two actions of the tools that read no data of a host (list_hosts and the analysis of the caller). They are in the identity mode: the mode keys
  // has no action for these tools. mcp.session is for the requests that call no tool.
  if (name == "mcp.hosts.read" || name == "mcp.analysis.read" || name == "mcp.session") return features.mcp && features.mcp_session;
  return true;
}

std::vector<AccessAction> access_published_actions(const AccessFeatures& features) {
  std::vector<AccessAction> out;
  for (const AccessAction& action : access_actions()) {
    if (access_action_published(action, features)) out.push_back(action);
  }
  return out;
}

std::string access_actions_json(std::string_view server, const AccessFeatures& features, const std::vector<AccessHostEntry>& hosts,
                                const AccessCeilings& bounds) {
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
  for (const AccessAction& action : access_published_actions(features)) {
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
    // The ceilings and the budgets of the action (ProcurAuth 5.2, 6.2): the names that the member "limits" of the document declares.
    std::vector<std::string> limits = access_action_ceilings(action.name);
    for (std::string& budget : access_action_budgets(action.name)) limits.push_back(std::move(budget));
    if (!limits.empty()) {
      w.Key("limits");
      w.StartArray();
      for (const std::string& name : limits) write_json_text(w, name);
      w.EndArray();
    }
    w.EndObject();
  }
  w.EndArray();
  if (!hosts.empty()) {
    w.Key("resources");
    w.StartArray();
    for (const AccessHostEntry& host : hosts) {
      w.StartObject();
      w.Key("path");
      write_json_text(w, "host:" + access_encode_id(host.id));
      w.Key("label");
      std::string label = access_cut_label(host.label);
      if (label.empty()) label = access_cut_label(host.id);
      write_json_text(w, label);
      w.EndObject();
    }
    w.EndArray();
  }
  // The declaration of the ceilings (ProcurAuth 6.1). The lowest value is 1: ClickHouse reads 0 as no limit, so a grant never gives it.
  w.Key("limits");
  w.StartArray();
  for (const AccessCeilingInfo& info : access_ceiling_table()) {
    w.StartObject();
    w.Key("name");
    w.String(info.name);
    w.Key("label");
    w.String(info.label);
    w.Key("description");
    w.String(info.description);
    w.Key("unit");
    w.String(info.unit);
    w.Key("kind");
    w.String("ceiling");
    w.Key("min");
    w.Uint64(1);
    w.Key("max");
    w.Uint64(access_ceiling_max(bounds, info));
    w.EndObject();
  }
  // The declaration of the budgets (ProcurAuth 6.1): a budget has no min and no max. A budget is declared when a published action lists it.
  for (const AccessBudgetInfo& info : access_budget_table()) {
    bool listed = false;
    for (const AccessAction& action : access_published_actions(features)) {
      for (const std::string& name : access_action_budgets(action.name)) listed = listed || name == info.name;
    }
    if (!listed) continue;
    w.StartObject();
    w.Key("name");
    w.String(info.name);
    w.Key("label");
    w.String(info.label);
    w.Key("description");
    w.String(info.description);
    w.Key("unit");
    w.String(info.unit);
    w.Key("kind");
    w.String("budget");
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

AccessRule access_rule(std::string_view method_in, std::string_view path) {
  const std::string_view method = method_in == "HEAD" ? std::string_view("GET") : method_in;
  if (path == "/livez" || path == "/readyz" || path == "/healthz" || path == "/metrics" || path == "/.well-known/procurauth/actions" ||
      path == "/mcp") {
    return rule(AccessRuleKind::Exempt);
  }
  // The route of the options (ProcurAuth 5.6) lists the children that the person of the token can see: it needs the token (the edge makes
  // it for the person who fills the form of the grants).
  if (path == "/.well-known/procurauth/resources") return method == "GET" ? rule(AccessRuleKind::Identity) : rule(AccessRuleKind::Unknown);
  // Any other path under /.well-known/ has no route and no data. The router answers 404, also without a token. The former path
  // /.well-known/access-actions is one of them: it has no alias.
  if (starts_with(path, "/.well-known/")) return rule(AccessRuleKind::Exempt);
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
    AccessRule out = host_rule(AccessRuleKind::Run, nullptr, false, true);
    // The run of the Query page and the replay of Deep Analyze run SQL: each one is a use that takes a unit of the budget `queries`.
    out.spend = path == "/api/query/run" || path == "/api/query" || path == "/api/query/deep-analysis";
    return out;
  }
  if ((path == "/api/query/deep-analysis" || path == "/api/query/execution") && method == "GET") return host_rule(AccessRuleKind::Run, nullptr);
  // The names of the editor (keywords, functions, the tables and the columns of a database).
  if (path == "/api/meta" && method == "GET") return host_rule(AccessRuleKind::Run, nullptr, true);
  // The body of the stream holds only the token of the export, so it names no host. The handler asks the actions on the host of the job
  // (Server::access_check_export_stream): a question on the service would refuse a person who has grants on one host only.
  if (path == "/api/export/stream" && method == "POST") return rule(AccessRuleKind::Identity);
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
  if (path == "/api/explorer/catalog" || path == "/api/explorer/storage" || path == "/api/explorer/graph") {
    if (method != "GET") return rule(AccessRuleKind::Unknown);
    AccessRule out = host_rule(AccessRuleKind::Action, "explorer.read", true);
    out.list_filter = true;
    return out;
  }
  if (starts_with(path, "/api/explorer/")) {
    return method == "GET" ? host_rule(AccessRuleKind::Action, "explorer.read", true) : rule(AccessRuleKind::Unknown);
  }
  return rule(AccessRuleKind::Unknown);
}

} // namespace chdash
