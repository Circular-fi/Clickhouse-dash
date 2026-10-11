// The routes of the Metrics browser (/api/metrics/catalog, attributes, series, exemplars) over the ClickHouse exporter tables
// <database>.<table_prefix>_{gauge,sum,histogram,exponential_histogram,summary}. A route is an adapter: it parses the request
// (metrics_request.hpp), finds the host, calls the service (metrics_service.hpp) with the context of the request, and writes the JSON of
// its answer (metrics_json.hpp). What a route reads from ClickHouse, and the rules of each read, are in the units that the service calls:
//
//   metrics_request    the parameters of a request: kind, window, attribute filters, grouping, bucket grid
//   metrics_sql        every statement, as a pure function
//   metrics_aggregate  the cells, the merge of histograms, the quantiles, the choice of aggregations, the top-K and "other" fold
//   metrics_service    the connection, the kind tables, the read of each route, the error of a failed statement
//   metrics_json       the JSON of each answer
//
// Counter increases, histogram bucket differences, quantile interpolation, exponential bucket merging and the top-K + "other" folding are
// documented in docs/metrics.md ("Metrics browser API").
#include "server.hpp"

#include "api_error.hpp"
#include "ch_executor.hpp"
#include "host_util.hpp"
#include "metrics_json.hpp"
#include "metrics_request.hpp"
#include "metrics_service.hpp"
#include "otel_request.hpp"
#include "time_util.hpp"

#include <chrono>
#include <memory>
#include <string>

namespace chdash {
namespace {

// The two answers that every route gives before it reads anything: the host is unknown, or the page is off for it.
struct MetricsRoute {
  std::string source_host_id;
  const HostSpec* host = nullptr;
};

bool open_metrics_route(const AppConfig& cfg, const httplib::Request& req, httplib::Response& res, MetricsRoute* route) {
  route->host = otel::request_host(cfg, req, &route->source_host_id);
  if (!route->host) {
    json_error(res, 404, "unknown_host", "Metrics source host is not configured.");
    return false;
  }
  if (!route->host->otel.metrics.enabled) {
    json_error(res, 404, "metrics_disabled",
               "OTel metrics are disabled for this host. Add observability { metrics { enabled = true } } to the ChDash configuration.");
    return false;
  }
  return true;
}

// The answer of a service: its error, or its JSON.
template <typename Answer, typename Json>
void send_metrics_result(httplib::Response& res, const Result<Answer>& result, Json json) {
  if (!result.value) return send_error(res, result.error);
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(json(*result.value), "application/json");
}

} // namespace

// Aggregations over wide windows may stay silent for a while before the first block: the receive timeout is 60 s.
std::unique_ptr<ChExecutor> Server::open_metrics_executor(const HostSpec& host, std::string* error) {
  const HostSpec* spec = &host;
  return ClientExecutor::open(
      client_pool_,
      [this, spec](std::string* reason) {
        return otel::acquire_client(*spec, client_pool_, "OTel metrics", std::chrono::seconds(60), reason);
      },
      error);
}

// GET /api/metrics/catalog
void Server::handle_metrics_catalog(const httplib::Request& req, httplib::Response& res) {
  metrics::CatalogRequest request;
  ApiError error;
  if (!metrics::parse_catalog(req, now_ms(), &request, &error)) return send_error(res, error);
  MetricsRoute route;
  if (!open_metrics_route(cfg_, req, res, &route)) return;
  send_metrics_result(res, metrics_service_.catalog(current_request_context(), *route.host, route.source_host_id, request), metrics::catalog_json);
}

// GET /api/metrics/attributes
void Server::handle_metrics_attributes(const httplib::Request& req, httplib::Response& res) {
  metrics::AttributesRequest request;
  ApiError error;
  if (!metrics::parse_attributes(req, &request, &error)) return send_error(res, error);
  MetricsRoute route;
  if (!open_metrics_route(cfg_, req, res, &route)) return;
  send_metrics_result(res, metrics_service_.attributes(current_request_context(), *route.host, request), metrics::attributes_json);
}

// GET /api/metrics/series
void Server::handle_metrics_series(const httplib::Request& req, httplib::Response& res) {
  metrics::SeriesRequest request;
  ApiError error;
  if (!metrics::parse_series(req, &request, &error)) return send_error(res, error);
  MetricsRoute route;
  if (!open_metrics_route(cfg_, req, res, &route)) return;
  send_metrics_result(res, metrics_service_.series(current_request_context(), *route.host, route.source_host_id, request), metrics::series_json);
}

// GET /api/metrics/exemplars
void Server::handle_metrics_exemplars(const httplib::Request& req, httplib::Response& res) {
  metrics::ExemplarsRequest request;
  ApiError error;
  if (!metrics::parse_exemplars(req, &request, &error)) return send_error(res, error);
  MetricsRoute route;
  if (!open_metrics_route(cfg_, req, res, &route)) return;
  send_metrics_result(res, metrics_service_.exemplars(current_request_context(), *route.host, route.source_host_id, request), metrics::exemplars_json);
}

} // namespace chdash
