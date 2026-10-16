// The routes of the Logs explorer. They read the logs table of the OpenTelemetry Collector ClickHouse exporter (logs { } block, docs/logs.md):
//
//   GET /api/logs/search        newest-first rows, keyset pagination, progressive time windows (newest slice first, widened until the
//                               limit is filled).
//   GET /api/logs/histogram     volume over time stacked by severity class.
//   GET /api/logs/context       records around one record (any / same service / same host / same trace), bounded windows.
//   GET /api/logs/patterns      Drain templates mined from a bounded sample.
//   GET /api/logs/services      the services with records in the range.
//   GET /api/logs/facets        the Fields panel: field keys (attribute map keys and record columns) of the matching records.
//   GET /api/logs/facet_values  top values of one field.
//
// A route is an adapter. It parses the request (logs_request.hpp), finds the host and calls the service (logs_service.hpp).
// The route passes the context of the request to the service. Then it writes the JSON of its answer (logs_json.hpp).
// The units that the service calls hold the reads from ClickHouse and the rules of each read. They are:
//
//   logs_request   the parameters of a request: the filters that the routes share, and what each route adds
//   logs_filters   the filters checked against the schema of the table, as the WHERE clause (values are query parameters)
//   logs_sql       every statement, as a pure function
//   logs_text      the text search (tokens, terms, the SQL of a term)
//   logs_drain     the masking of a message and the Drain tree
//   logs_patterns  the mining of a sample into patterns
//   logs_service   the connection, the schema, the read of each route, the error of a failed statement
//   logs_json      the JSON of each answer
//
// Every query filters on the primary-key columns first. ServiceName uses the allowlist and the service filter. TimestampTime and
// Timestamp use the time range. The query searches Body with hasToken(). The tokenbf_v1 index idx_body of the exporter skips granules.
// Every query runs with max_execution_time and a max_rows_to_read guard.
#include "server.hpp"

#include "api_error.hpp"
#include "ch_executor.hpp"
#include "host_util.hpp"
#include "logs_json.hpp"
#include "logs_request.hpp"
#include "logs_service.hpp"
#include "otel_request.hpp"

#include <chrono>
#include <memory>
#include <string>

namespace chdash {
namespace {

// Every route gives one of two answers before it reads anything. The host is unknown, or the page is off for the host.
struct LogsRoute {
  std::string source_host_id;
  const HostSpec* host = nullptr;
};

bool open_logs_route(const AppConfig& cfg, const httplib::Request& req, httplib::Response& res, LogsRoute* route) {
  route->host = otel::request_host(cfg, req, &route->source_host_id);
  if (!route->host) {
    json_error(res, 404, "unknown_host", "Logs source host is not configured.");
    return false;
  }
  if (!route->host->otel.logs.enabled) {
    json_error(res, 404, "logs_disabled",
               "OTel logs are disabled for this host. Add observability { logs { enabled = true } } to the ChDash configuration.");
    return false;
  }
  return true;
}

// The answer of a service: its error, or its JSON.
template <typename Answer, typename Json>
void send_logs_result(httplib::Response& res, const Result<Answer>& result, Json json) {
  if (!result.value) return send_error(res, result.error);
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(json(*result.value), "application/json");
}

} // namespace

// The receive timeout outlasts max_execution_time.
std::unique_ptr<ChExecutor> Server::open_logs_executor(const HostSpec& host, std::string* error) {
  const HostSpec* spec = &host;
  return ClientExecutor::open(
      client_pool_,
      [this, spec](std::string* reason) {
        return otel::acquire_client(*spec, client_pool_, "OTel logs", std::chrono::seconds(logs::kMaxExecutionSeconds + 15), reason);
      },
      error);
}

// GET /api/logs/search
void Server::handle_logs_search(const httplib::Request& req, httplib::Response& res) {
  const logs::SearchRequest request = logs::parse_search(req);
  LogsRoute route;
  if (!open_logs_route(cfg_, req, res, &route)) return;
  send_logs_result(res, logs_service_.search(current_request_context(), *route.host, route.source_host_id, request), logs::search_json);
}

// GET /api/logs/histogram
void Server::handle_logs_histogram(const httplib::Request& req, httplib::Response& res) {
  const logs::HistogramRequest request = logs::parse_histogram(req);
  LogsRoute route;
  if (!open_logs_route(cfg_, req, res, &route)) return;
  send_logs_result(res, logs_service_.histogram(current_request_context(), *route.host, route.source_host_id, request), logs::histogram_json);
}

// GET /api/logs/context
void Server::handle_logs_context(const httplib::Request& req, httplib::Response& res) {
  const logs::ContextRequest request = logs::parse_context(req);
  LogsRoute route;
  if (!open_logs_route(cfg_, req, res, &route)) return;
  send_logs_result(res, logs_service_.context(current_request_context(), *route.host, route.source_host_id, request), logs::context_json);
}

// GET /api/logs/patterns
void Server::handle_logs_patterns(const httplib::Request& req, httplib::Response& res) {
  const logs::PatternsRequest request = logs::parse_patterns(req);
  LogsRoute route;
  if (!open_logs_route(cfg_, req, res, &route)) return;
  send_logs_result(res, logs_service_.patterns(current_request_context(), *route.host, route.source_host_id, request), logs::patterns_json);
}

// GET /api/logs/services: the choices of the service picker. The allowlist applies. The other filters do not.
void Server::handle_logs_services(const httplib::Request& req, httplib::Response& res) {
  const logs::ServicesRequest request = logs::parse_services(req);
  LogsRoute route;
  if (!open_logs_route(cfg_, req, res, &route)) return;
  send_logs_result(res, logs_service_.services(current_request_context(), *route.host, route.source_host_id, request), logs::services_json);
}

// GET /api/logs/facets
void Server::handle_logs_facets(const httplib::Request& req, httplib::Response& res) {
  const logs::FacetsRequest request = logs::parse_facets(req);
  LogsRoute route;
  if (!open_logs_route(cfg_, req, res, &route)) return;
  send_logs_result(res, logs_service_.facets(current_request_context(), *route.host, route.source_host_id, request), logs::facets_json);
}

// GET /api/logs/facet_values: the top values of one field. The filters on the field itself are left out, so its other values stay visible.
// A value can be added. Several values of one key match any of them.
void Server::handle_logs_facet_values(const httplib::Request& req, httplib::Response& res) {
  logs::FacetValuesRequest request;
  ApiError error;
  if (!logs::parse_facet_values(req, &request, &error)) return send_error(res, error);
  LogsRoute route;
  if (!open_logs_route(cfg_, req, res, &route)) return;
  send_logs_result(res, logs_service_.facet_values(current_request_context(), *route.host, route.source_host_id, request), logs::facet_values_json);
}

} // namespace chdash
