#pragma once

// The actions of ChDash for the access of humans (docs/access.md, contract 11.4) and the action that each route needs.
// Pure code: no HTTP server, no PDP. server_http.cpp applies the rule of a route before the route runs.

#include <string>
#include <string_view>
#include <vector>

namespace chdash {

struct AccessAction {
  const char* name;
  // True: a decision can be asked for one database ({"type": "database", "id": <name>}) as well as for the service.
  bool database;
  const char* description;
};

// The actions, in the order of the document. `access` is not one of them: the access gateway decides it.
const std::vector<AccessAction>& access_actions();

// The document of GET /.well-known/access-actions: {"server": <server>, "actions": [{name, resource_types, description}]}.
std::string access_actions_json(std::string_view server);

// What a route needs.
enum class AccessRuleKind {
  // No identity token: the probes, the metrics, the list of actions, and the MCP endpoint (it has its keys).
  Exempt,
  // A valid identity token and no action: the page shells, the files, the hosts, and the routes of a capability that a
  // checked request gave (the stream and the cancel of a run).
  Identity,
  // One action: `action`, on the database that the parameter `database` names when `database_param` is true and the
  // request has it, else on the service.
  Action,
  // A run of SQL: query.run.read or query.run.write. Without query.run.write, the statements run with readonly = 1.
  Run,
  // An export: query.export. Without query.run.write, the statements run with readonly = 1.
  Export,
  // The route itself asks: the database is in the body (the data preview of the Explorer).
  Deferred,
  // A route that has no rule: refused (fail closed).
  Unknown,
};

struct AccessRule {
  AccessRuleKind kind = AccessRuleKind::Unknown;
  const char* action = nullptr;
  bool database_param = false;
};

// The rule of a request. HEAD has the rule of GET.
AccessRule access_rule(std::string_view method, std::string_view path);

} // namespace chdash
