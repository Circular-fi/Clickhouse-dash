// The routes of the Traces page (/api/traces/...). A route is an adapter.
// It finds the host, parses the request (trace_request.hpp) and calls the service (trace_service.hpp) with the context of the request.
// The route then writes the JSON of its answer (trace_json.hpp).
// The reads from ClickHouse, and the rules of each read, are in the units that the service calls:
//
//   trace_search      the search of traces: the index, the span filters, the ranking
//   trace_analytics   the charts, the heatmap, the deltas and the service map
//   trace_services    the services view and the database statements
//   trace_facets      the schema (meta), the pickers (prefill), the attribute keys and values
//   trace_detail      one trace, one span, the spans around a time, the spans that link to a trace
//   trace_spans       the span search
//   trace_sql         every statement, as a pure function
#include "server.hpp"

#include "api_error.hpp"
#include "ch_executor.hpp"
#include "host_util.hpp"
#include "otel_request.hpp"
#include "trace_json.hpp"
#include "trace_request.hpp"
#include "trace_service.hpp"

#include <chrono>
#include <memory>
#include <string>

namespace chdash {
namespace {

const HostSpec* trace_host(const AppConfig& cfg, const httplib::Request& req, std::string* host_id) {
  return otel::request_host(cfg, req, host_id);
}

// Every route gives one of two answers before it reads anything.
// The host is unknown, or the page is off for the host.
struct TraceRoute {
  std::string source_host_id;
  const HostSpec* host = nullptr;
};

bool open_trace_route(const AppConfig& cfg, const httplib::Request& req, httplib::Response& res, TraceRoute* route) {
  route->host = trace_host(cfg, req, &route->source_host_id);
  if (!route->host) { json_error(res, 404, "unknown_host", "Trace source host is not configured."); return false; }
  if (!route->host->otel.traces.enabled) { json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host."); return false; }
  return true;
}

// The answer of a service. It is either an error or JSON.
template <typename Answer, typename Json>
void send_trace_result(httplib::Response& res, const trace::Result<Answer>& result, Json json) {
  if (!result.value) return send_error(res, result.error);
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(json(*result.value), "application/json");
}

} // namespace

// Wide-window span aggregations (analytics, duration search) can spend tens of seconds in a merge. They send no packet in that time.
// The receive timeout is 60 s.
std::unique_ptr<ChExecutor> Server::open_trace_executor(const HostSpec& host, std::string* error) {
  const HostSpec* spec = &host;
  return ClientExecutor::open(
      client_pool_,
      [this, spec](std::string* reason) {
        return otel::acquire_client(*spec, client_pool_, "Trace Explorer", std::chrono::seconds(60), reason);
      },
      error);
}

// The schema of the source: the columns, the trace index and the attribute maps.
void Server::handle_traces_meta(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  send_trace_result(res, trace_service_.meta(current_request_context(), *route.host, route.source_host_id), trace::meta_json);
}

void Server::handle_traces_prefill(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::PrefillRequest request;
  ApiError error;
  if (!trace::parse_prefill(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.prefill(current_request_context(), *route.host, request), trace::prefill_json);
}

// Top attribute keys (span + resource) of the spans that match the filters. The keys are ranked by the number of sampled spans that carry them.
// One capped pass reads only the key subcolumns of the maps.
void Server::handle_traces_facets(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::FacetRequest request;
  ApiError error;
  if (!trace::parse_facets(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.facet_keys(current_request_context(), *route.host, request), trace::facet_keys_json);
}

// Top values of one attribute key, with their sampled span counts. The filters of this key are left out. Its other values stay visible.
// A value can be added as a filter. Several values of one key match any of them.
void Server::handle_traces_facet_values(const httplib::Request& req, httplib::Response& res) {
  trace::FacetRequest request;
  ApiError error;
  // The key is checked before the host. The route always did this.
  if (!trace::parse_facet_key(req, &request, &error)) return send_error(res, error);
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  if (!trace::parse_facets(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.facet_values(current_request_context(), *route.host, request), trace::facet_values_json);
}

void Server::handle_traces_search(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  const TraceSettings& traces = route.host->otel.traces;
  trace::WindowRequest window;
  ApiError error;
  if (!trace::parse_window(req, traces, /*analytics_required=*/false, &window, &error)) return send_error(res, error);
  window.source_host_id = route.source_host_id;
  const int limit = trace::int_param(req, "limit", static_cast<int>(traces.search_limit), 1, static_cast<int>(traces.search_limit));
  // index_candidate_cap=N lowers the number of traces that the filtered index scan tests. It never raises that number.
  // The tests use it to reach the cap.
  const int candidate_cap = trace::int_param(req, "index_candidate_cap", static_cast<int>(trace::kCandidateScanCap), 1,
                                             static_cast<int>(trace::kCandidateScanCap));
  send_trace_result(res,
                    trace_service_.search(current_request_context(), *route.host, window, static_cast<size_t>(limit),
                                          static_cast<size_t>(candidate_cap)),
                    trace::search_json);
}

void Server::handle_traces_analytics(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::AnalyticsRequest request;
  ApiError error;
  if (!trace::parse_analytics(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.window.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.analytics(current_request_context(), *route.host, request), trace::analytics_json);
}

// GET /api/traces/service_map: the services and the calls between them. It follows HyperDX's DBServiceMapPage (trace_analytics.hpp).
void Server::handle_traces_service_map(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::ServiceMapRequest request;
  ApiError error;
  if (!trace::parse_service_map(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.window.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.service_map(current_request_context(), *route.host, request), trace::service_map_json);
}

// GET /api/traces/heatmap: trace counts per (time bucket, log-scaled duration row).
// It takes the same parameters as /api/traces/analytics, plus rows (8..80, default 40).
// It uses one pass. HyperDX uses two passes (quantile / max, then widthBucket). See bin_heatmap.
void Server::handle_traces_heatmap(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::HeatmapRequest request;
  ApiError error;
  if (!trace::parse_heatmap(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.window.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.heatmap(current_request_context(), *route.host, request), trace::heatmap_json);
}

// GET /api/traces/deltas: which attribute values set the traces of a heatmap box apart.
// Parameters: the heatmap's window and filters, plus the box t0 / t1 (epoch ms, trace start) and d0 / d1 (trace duration, ms).
// The baseline value outside uses the other traces of the box's time range. This is the default.
//
// The baseline value all uses every trace of that time range.
// The sample value (per side, 100..2500, default 1000) sets the sample size.
void Server::handle_traces_deltas(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::DeltasRequest request;
  ApiError error;
  if (!trace::parse_deltas(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.window.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.deltas(current_request_context(), *route.host, request), trace::deltas_json);
}

// Per service, the route returns these values. With detail=<service>, it returns them per endpoint (SpanName of that service).
// The values are: entry-span rate, errors, p50 / p95 / p99 Duration, and total time (sum of Duration).
// The route also returns the same values per chart bucket (sparklines and the RED charts).
// The detail drill-down also lists the slowest entry spans.
//
// It also lists the first time each ResourceAttributes['service.version'] was seen (release markers). See trace_services.hpp.
void Server::handle_traces_services(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::ServicesRequest request;
  ApiError error;
  if (!trace::parse_services(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.services(current_request_context(), *route.host, request), trace::services_json);
}

// Database statements (HyperDX DatabaseTab). The route reads spans that carry db.query.text (current semconv) or db.statement (older).
// It groups the spans by statement text. For each group, it gives count, total time, p95 Duration and the service.
// Any span kind is allowed. Database calls are Client spans.
void Server::handle_traces_services_db(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::ServicesRequest request;
  ApiError error;
  if (!trace::parse_services(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.services_db(current_request_context(), *route.host, request), trace::services_db_json);
}

// Spans of OTHER traces whose Links point to this trace (or to one of its spans). Links are stored only on the span that creates the link.
// The lookup scans otel_traces.
// It always stays inside the trace's own window. The window is widened by traces.linked_from_margin_minutes on each side.
// It is never unbounded.
void Server::handle_traces_linked_from(const httplib::Request& req, httplib::Response& res) {
  trace::LinkedFromRequest request;
  ApiError error;
  if (!trace::parse_linked_from(req, &request, &error)) return send_error(res, error);
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.linked_from(current_request_context(), *route.host, request), trace::linked_from_json);
}

// Spans around an anchor timestamp (±window_ms), newest first. The keyset cursor uses (Timestamp, SpanId) in both directions.
// See trace_detail.hpp.
void Server::handle_traces_context(const httplib::Request& req, httplib::Response& res) {
  trace::ContextRequest request;
  ApiError error;
  if (!trace::parse_context(req, &request, &error)) return send_error(res, error);
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.context(current_request_context(), *route.host, request), trace::context_json);
}

void Server::handle_trace_detail(const httplib::Request& req, httplib::Response& res) {
  trace::TraceDetailRequest request;
  ApiError error;
  if (!trace::parse_trace_detail(req, &request, &error)) return send_error(res, error);
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.trace_detail(current_request_context(), *route.host, request), trace::trace_detail_json);
}

// Newest-first spans that match the span filters. The spans come in keyset pages over time slices (trace_spans.hpp).
void Server::handle_traces_spans(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::SpansRequest request;
  ApiError error;
  if (!trace::parse_spans(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.spans(current_request_context(), *route.host, request), trace::spans_json);
}

// One span with its attributes, events and links. The route addresses the span by its full row key (HyperDX's row WHERE).
// The exact Timestamp bounds limit the read to a few granules.
void Server::handle_traces_span(const httplib::Request& req, httplib::Response& res) {
  trace::SpanRequest request;
  ApiError error;
  if (!trace::parse_span(req, &request, &error)) return send_error(res, error);
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.span(current_request_context(), *route.host, request), trace::span_json);
}

} // namespace chdash
