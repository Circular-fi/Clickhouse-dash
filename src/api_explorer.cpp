// The routes of the Explorer (/api/explorer/...). A route is an adapter.
// A route finds the host, reads the parameters and calls the service (explorer_service.hpp). It passes the context of the request.
// A route writes the JSON of its answer (explorer_json.hpp). The units that the service calls hold the reads from ClickHouse.
// They also hold the privileges of the runner that bound every name, the caches and the error of each failure. The list below names the units:
//
//   explorer_service      the order of a read, the caches, the two connections, the error of a failed read
//   explorer_catalog      the catalog of the graph; explorer_index (the sidebar), explorer_storage, explorer_table and explorer_detail (a table),
//                         explorer_lineage, explorer_functions, explorer_preview: the readers, over a ChExecutor
//   explorer_sql          every statement, as a pure function
//   explorer_rules        what is decided on the rows that were read
//   explorer_graph*       the reads of the graph, its builder, and the scope of a request
//   explorer_json         the JSON of each answer
#include "server.hpp"

#include "api_error.hpp"
#include "api_params.hpp"
#include "ch_executor.hpp"
#include "ch_uri.hpp"
#include "explorer_json.hpp"
#include "explorer_service.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "json_parse.hpp"

#include <rapidjson/document.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <string>

namespace chdash {
namespace {

// Every route answers this way before it reads anything. The host is not named, unknown, or down.
struct ExplorerRoute {
  std::string host_id;
  const HostSpec* host = nullptr;
};

bool open_explorer_route(const AppConfig& cfg, const HealthRunner* health, const httplib::Request& req, httplib::Response& res, const std::string& host_id,
                         ExplorerRoute* route) {
  if (host_id.empty()) { json_error(res, 400, "missing_host_id", "Missing host_id."); return false; }
  route->host = find_request_host(cfg, req, host_id);
  if (!route->host) { json_error(res, 404, "unknown_host", "Unknown host_id."); return false; }
  if (!is_host_healthy(health, host_id)) {
    json_error(res, 503, "host_unavailable", "Selected host is down.");
    return false;
  }
  route->host_id = host_id;
  return true;
}

std::string param_of(const httplib::Request& req, const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; }

bool refresh_of(const httplib::Request& req) { return req.has_param("refresh") && req.get_param_value("refresh") == "1"; }

void send_json(httplib::Response& res, const std::string& body) {
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(body, "application/json");
}

}  // namespace

// A connection with the account of `uri`. It has five seconds to connect, and fifteen to read and to write.
std::unique_ptr<ChExecutor> Server::open_explorer_executor(const std::string& uri, std::string* error) {
  return ClientExecutor::open(
      client_pool_,
      [this, uri](std::string* reason) {
        return client_pool_ ? client_pool_->acquire(uri, std::chrono::seconds(5), std::chrono::seconds(15), std::chrono::seconds(15), reason)
                            : make_client_from_uri(uri, std::chrono::seconds(5), std::chrono::seconds(15), std::chrono::seconds(15), reason);
      },
      error);
}

void Server::handle_explorer_catalog(const httplib::Request& req, httplib::Response& res) {
  ExplorerRoute route;
  if (!open_explorer_route(cfg_, health_.get(), req, res, param_of(req, "host_id"), &route)) return;
  const std::string database_filter = param_of(req, "database");
  const auto answer = explorer_service_.catalog(current_request_context(), *route.host, route.host_id, database_filter, refresh_of(req));
  if (!answer.value) return send_error(res, answer.error);
  send_json(res, explorer::catalog_json(route.host_id, database_filter, *answer.value->value, answer.value->stale));
}

void Server::handle_explorer_storage(const httplib::Request& req, httplib::Response& res) {
  ExplorerRoute route;
  if (!open_explorer_route(cfg_, health_.get(), req, res, param_of(req, "host_id"), &route)) return;
  const auto answer = explorer_service_.storage(current_request_context(), *route.host, route.host_id, refresh_of(req));
  if (!answer.value) return send_error(res, answer.error);
  // The map holds every database. A grant on some databases keeps only those (docs/access.md): one batch asks each database.
  const ExplorerStorageMap& map = *answer.value->value;
  std::vector<std::string> databases;
  databases.reserve(map.databases.size());
  for (const auto& database : map.databases) databases.push_back(database.name);
  if (const auto readable = access_readable_databases({"explorer.read"}, databases)) {
    return send_json(res, explorer::storage_json(route.host_id, explorer::keep_storage_databases(map, *readable), answer.value->stale));
  }
  send_json(res, explorer::storage_json(route.host_id, map, answer.value->stale));
}

void Server::handle_explorer_table(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = param_of(req, "host_id");
  const std::string database = param_of(req, "database");
  const std::string table = param_of(req, "table");
  if (host_id.empty() || database.empty() || table.empty()) {
    return json_error(res, 400, "missing_scope", "host_id, database and table are required.");
  }
  ExplorerRoute route;
  if (!open_explorer_route(cfg_, health_.get(), req, res, host_id, &route)) return;
  const auto answer = explorer_service_.table(current_request_context(), *route.host, route.host_id, database, table, refresh_of(req));
  if (!answer.value) return send_error(res, answer.error);
  send_json(res, explorer::table_json(route.host_id, *answer.value->value, answer.value->stale, explorer::kTableDetailCacheTtlMs));
}

void Server::handle_explorer_functions(const httplib::Request& req, httplib::Response& res) {
  ExplorerRoute route;
  if (!open_explorer_route(cfg_, health_.get(), req, res, param_of(req, "host_id"), &route)) return;
  const auto answer = explorer_service_.functions(current_request_context(), *route.host, route.host_id, refresh_of(req));
  if (!answer.value) return send_error(res, answer.error);
  send_json(res, explorer::functions_json(route.host_id, *answer.value->value, answer.value->stale, cfg_.explorer.function_markdown_links));
}

void Server::handle_explorer_table_data(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString() ||
      !doc.HasMember("database") || !doc["database"].IsString() ||
      !doc.HasMember("table") || !doc["table"].IsString()) {
    return json_error(res, 400, "missing_scope", "host_id, database and table are required.");
  }
  const std::string host_id = doc["host_id"].GetString();
  const std::string database = doc["database"].GetString();
  const std::string table = doc["table"].GetString();
  // The database is in the body. This code asks for the decision of explorer.read for it (docs/access.md).
  if (!access_allows(res, "explorer.read", database)) return;
  size_t limit = 100;
  if (doc.HasMember("limit") && doc["limit"].IsUint64()) limit = static_cast<size_t>(doc["limit"].GetUint64());
  limit = std::max<size_t>(1, std::min<size_t>(limit, 500));

  ExplorerRoute route;
  if (!open_explorer_route(cfg_, health_.get(), req, res, host_id, &route)) return;
  const auto answer = explorer_service_.preview(current_request_context(), *route.host, database, table, limit);
  if (!answer.value) return send_error(res, answer.error);
  const auto body = explorer::preview_json(route.host_id, database, table, *answer.value);
  if (!body) return json_error(res, 500, "preview_serialization_failed", "Explorer produced an invalid typed JSON cell.");
  send_json(res, *body);
}

void Server::handle_explorer_graph(const httplib::Request& req, httplib::Response& res) {
  ExplorerRoute route;
  if (!open_explorer_route(cfg_, health_.get(), req, res, param_of(req, "host_id"), &route)) return;
  const explorer::GraphScopeRequest scope = explorer::read_graph_scope(req);
  // The focus names its own database: the subject must be able to read it (docs/access.md).
  if (!scope.focus_database.empty()) {
    const auto readable = access_readable_databases({"explorer.read"}, {scope.focus_database});
    if (readable && readable->count(scope.focus_database) == 0) {
      return access_forbidden(res, "explorer.read");
    }
  }
  const auto answer = explorer_service_.graph(current_request_context(), *route.host, route.host_id, scope, cfg_.explorer.lineage,
                                              cfg_.explorer.storage_topology, refresh_of(req));
  if (!answer.value) return send_error(res, answer.error);
  const explorer::GraphScopeAnswer& graph = *answer.value;
  // A lineage or a cluster topology crosses databases. A grant on some databases keeps only their nodes: one batch asks each
  // database of the answer.
  if (const auto readable = access_readable_databases({"explorer.read"}, explorer::graph_databases(graph.scoped))) {
    return send_json(res, explorer::graph_json(route.host_id, *graph.graph, explorer::keep_graph_databases(graph.scoped, *readable), scope,
                                               graph.scope_has_more, graph.storage_available, graph.stale, cfg_.explorer.live_refresh_ms));
  }
  send_json(res, explorer::graph_json(route.host_id, *graph.graph, graph.scoped, scope, graph.scope_has_more, graph.storage_available, graph.stale,
                                      cfg_.explorer.live_refresh_ms));
}

// This route explains one logical object for an edge or node panel. The explanation covers its SELECT, its destination or source, and its Distributed routing.
// It is served from the cached authorized graph only. An object outside AllowedObjectSet is simply absent (404). No SQL is executed for the caller.
void Server::handle_explorer_graph_definition(const httplib::Request& req, httplib::Response& res) {
  const std::string database = param_of(req, "database");
  const std::string table = param_of(req, "table");
  if (database.empty() || table.empty()) return json_error(res, 400, "missing_object", "Missing database or table.");
  ExplorerRoute route;
  if (!open_explorer_route(cfg_, health_.get(), req, res, param_of(req, "host_id"), &route)) return;
  const auto answer = explorer_service_.definition(current_request_context(), *route.host, route.host_id, database, table, refresh_of(req));
  if (!answer.value) return send_error(res, answer.error);
  send_json(res, explorer::definition_json(route.host_id, *answer.value->node, *answer.value->definition, answer.value->stale));
}

} // namespace chdash
