#pragma once

// The actions of ChDash for the access of humans (docs/access.md, contract 11.4) and the action that each route needs.
// Pure code: no HTTP server, no PDP. server_http.cpp applies the rule of a route before the route runs.

#include <string>
#include <string_view>
#include <vector>

namespace chdash {

struct AccessAction {
  const char* name;
  // True: a decision can be asked for one host ({"type": "host", "id": <name>, ancestors [service]}) as well as for the service.
  bool host;
  // True: a decision can also be asked for one database of a host ({"type": "database", ancestors [service, host]}).
  // An action with `database` always has `host`: the parent of a database is its host.
  bool database;
  const char* description;
};

// The types of resources under the service, in the order of the document: {name, parent, description}.
struct AccessResourceType {
  const char* name;
  const char* parent;
  const char* description;
};
const std::vector<AccessResourceType>& access_resource_types();

// The actions, in the order of the document. `access` is not one of them: the access gateway decides it.
const std::vector<AccessAction>& access_actions();
// The action of a name, or null.
const AccessAction* access_action(std::string_view name);

// The document of GET /.well-known/access-actions: {"server": <server>, "resource_types": [{name, parent, description}],
// "actions": [{name, resource_types, description}]}. The types of an action are "service", then "host" and "database" when it takes them.
std::string access_actions_json(std::string_view server);

// What a route needs.
enum class AccessRuleKind {
  // No identity token: the probes, the metrics, the list of actions, and the MCP endpoint (it has its keys).
  Exempt,
  // A valid identity token and no action: the page shells, the files, the hosts, and the routes of a capability that a
  // checked request gave (the stream and the cancel of a run).
  Identity,
  // One action: `action`. With `host`, on the host of the request (its parameter host_id, or the field host_id of its body), or on
  // the database of that host that the parameter `database` names when `database_param` is true and the request has it. Without
  // `host`, on the service.
  Action,
  // A run of SQL: query.run.read or query.run.write. Without query.run.write, the statements run with readonly = 1.
  Run,
  // An export: query.export, and query.run.read or query.run.write (an export runs SQL). Without query.run.write, the
  // statements run with readonly = 1.
  Export,
  // A route that has no rule: refused (fail closed).
  Unknown,
};

struct AccessRule {
  AccessRuleKind kind = AccessRuleKind::Unknown;
  const char* action = nullptr;
  // The question names the host of the request (and its database with database_param). Run and Export always name the host.
  bool host = false;
  bool database_param = false;
  // The host and the database are in the JSON body (a POST): the check waits until the server has read the body.
  bool body = false;
};

// The rule of a request. HEAD has the rule of GET.
AccessRule access_rule(std::string_view method, std::string_view path);

} // namespace chdash
