#include "trace_service.hpp"

#include "api_error.hpp"
#include "otel_allowlist.hpp"
#include "trace_sql.hpp"

#include <algorithm>
#include <chrono>

namespace chdash {
namespace trace {

namespace {

uint64_t elapsed_ms_since(std::chrono::steady_clock::time_point since) {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - since).count());
}

}  // namespace

std::string TraceService::connect_error(const std::string& reason) const {
  return reason.empty() ? "Cannot connect to trace ClickHouse source." : reason;
}

Result<TraceService::OpenedScope> TraceService::open_scope(const HostSpec& host, const WindowRequest& request) const {
  using Out = Result<OpenedScope>;
  const TraceSettings& traces = host.otel.traces;
  OpenedScope opened;
  std::string error;
  opened.db = open_(host, &error);
  if (!opened.db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));

  // The span filter SQL of the request (" AND ..." or empty), or the error when a tag filter needs an unusable attribute map. The
  // attribute schema is looked up (cached) only when tag filters are present.
  std::string tags;
  if (!request.filters.tags.empty()) {
    const AttributeColumns columns = attribute_columns(*opened.db, attribute_maps_, host, traces);
    std::string code, message;
    if (!tag_filters_sql(request.filters.tags, columns, &tags, &code, &message)) {
      return Out::fail(make_error(filter_error_status(code), code, message));
    }
  }
  TraceScope& scope = opened.scope;
  scope.span_filters = span_filters_sql(request.filters, tags);
  scope.having = duration_having(request.min_duration_ms, request.max_duration_ms);
  scope.table = qualified(traces.database, traces.table);
  scope.index_table = traces.trace_index_table.empty() ? std::string{} : qualified(traces.database, traces.trace_index_table);
  scope.visibility = otel::service_allowlist_predicate(traces);
  scope.start_ms = request.start_ms;
  scope.end_ms = request.end_ms;
  return Out::ok(std::move(opened));
}

Result<SearchAnswer> TraceService::search(const RequestContext&, const HostSpec& host, const WindowRequest& request, size_t limit) const {
  using Out = Result<SearchAnswer>;
  const auto started = std::chrono::steady_clock::now();
  auto opened = open_scope(host, request);
  if (!opened.value) return Out::fail(std::move(opened.error));
  const TraceScope& scope = opened.value->scope;
  SearchAnswer answer;
  answer.source_host_id = request.source_host_id;
  // Only service / operation filters (primary-key columns) may use the broad form.
  const bool key_only_filters = !scope.span_filters.empty() && request.filters.key_only();
  try {
    answer.outcome = search_traces(*opened.value->db, scope, key_only_filters, limit);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_search_failed"));
  }
  answer.all_services = scope.all_services();
  answer.total_ms = elapsed_ms_since(started);
  return Out::ok(std::move(answer));
}


Result<AnalyticsAnswer> TraceService::analytics(const RequestContext&, const HostSpec& host, const AnalyticsRequest& request) const {
  using Out = Result<AnalyticsAnswer>;
  const auto started = std::chrono::steady_clock::now();
  auto opened = open_scope(host, request.window);
  if (!opened.value) return Out::fail(std::move(opened.error));
  const TraceScope& scope = opened.value->scope;
  bool want_counts = true, want_durations = true;
  if (!parse_charts(request.charts, &want_counts, &want_durations)) {
    return Out::fail(make_error(400, "invalid_trace_charts", "charts must list counts and/or durations."));
  }
  const AnalyticsGrid grid = analytics_grid(scope.start_ms, scope.end_ms, request.bucket_origin_ms, request.align_buckets);
  // Only service / operation filters (primary-key columns) may use the broad form.
  const bool key_only_filters = !scope.span_filters.empty() && request.window.filters.key_only();
  AnalyticsAnswer answer;
  answer.source_host_id = request.window.source_host_id;
  try {
    auto outcome = run_analytics(*opened.value->db, scope, key_only_filters, grid, want_counts, want_durations);
    if (!outcome.value) return Out::fail(std::move(outcome.error));
    answer.outcome = std::move(*outcome.value);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_analytics_failed"));
  }
  answer.total_ms = elapsed_ms_since(started);
  return Out::ok(std::move(answer));
}

Result<ServiceMapAnswer> TraceService::service_map(const RequestContext&, const HostSpec& host, const ServiceMapRequest& request) const {
  using Out = Result<ServiceMapAnswer>;
  const auto started = std::chrono::steady_clock::now();
  auto opened = open_scope(host, request.window);
  if (!opened.value) return Out::fail(std::move(opened.error));
  ServiceMapAnswer answer;
  answer.source_host_id = request.window.source_host_id;
  answer.start_ms = opened.value->scope.start_ms;
  answer.end_ms = opened.value->scope.end_ms;
  try {
    auto outcome = run_service_map(*opened.value->db, opened.value->scope, request.forced_factor);
    if (!outcome.value) return Out::fail(std::move(outcome.error));
    answer.outcome = std::move(*outcome.value);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_service_map_failed"));
  }
  answer.total_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  return Out::ok(std::move(answer));
}

Result<HeatmapAnswer> TraceService::heatmap(const RequestContext&, const HostSpec& host, const HeatmapRequest& request) const {
  using Out = Result<HeatmapAnswer>;
  const auto started = std::chrono::steady_clock::now();
  auto opened = open_scope(host, request.window);
  if (!opened.value) return Out::fail(std::move(opened.error));
  const TraceScope& scope = opened.value->scope;
  HeatmapAnswer answer;
  answer.source_host_id = request.window.source_host_id;
  answer.bucket_ms = static_cast<int64_t>(choose_bucket_seconds(scope.end_ms - scope.start_ms)) * 1000;
  answer.origin_ms = grid_origin_ms(request.bucket_origin_ms, answer.bucket_ms);
  answer.range_start_ms = request.align_buckets ? grid_floor_ms(scope.start_ms, answer.bucket_ms, answer.origin_ms) : scope.start_ms;
  answer.range_end_ms = request.align_buckets ? grid_floor_ms(scope.end_ms + answer.bucket_ms - 1, answer.bucket_ms, answer.origin_ms) : scope.end_ms;
  answer.has_filters = !scope.span_filters.empty();
  const bool key_only_filters = answer.has_filters && request.window.filters.key_only();
  try {
    answer.run = run_heatmap(*opened.value->db, scope, key_only_filters, answer.bucket_ms, answer.origin_ms);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_heatmap_failed"));
  }
  answer.bins = bin_heatmap(answer.run.fine_cells, answer.run.fine_totals, request.rows);
  answer.total_ms = elapsed_ms_since(started);
  return Out::ok(std::move(answer));
}

Result<DeltasAnswer> TraceService::deltas(const RequestContext&, const HostSpec& host, const DeltasRequest& request) const {
  using Out = Result<DeltasAnswer>;
  const auto started = std::chrono::steady_clock::now();
  auto opened = open_scope(host, request.window);
  if (!opened.value) return Out::fail(std::move(opened.error));
  const TraceScope& scope = opened.value->scope;
  const TraceSettings& traces = host.otel.traces;

  int64_t t0 = request.t0, t1 = request.t1;
  if (!request.t0_present || !request.t1_present || t1 <= t0) {
    return Out::fail(make_error(400, "invalid_trace_box", "t0 and t1 (epoch ms, t0 < t1) are required."));
  }
  t0 = std::max(t0, scope.start_ms);
  t1 = std::min(t1, scope.end_ms);
  if (t1 <= t0) return Out::fail(make_error(400, "invalid_trace_box", "The box lies outside the time range."));
  if (request.d0_ms < 0.0 || request.d1_ms <= 0.0 || request.d0_ms > request.d1_ms) {
    return Out::fail(make_error(400, "invalid_trace_box", "d0 and d1 (trace duration in ms, d0 <= d1) are required."));
  }
  if (request.baseline != "outside" && request.baseline != "all") {
    return Out::fail(make_error(400, "invalid_trace_baseline", "baseline must be outside or all."));
  }

  DeltasAnswer answer;
  answer.source_host_id = request.window.source_host_id;
  answer.t0 = t0;
  answer.t1 = t1;
  answer.d0_ms = request.d0_ms;
  answer.d1_ms = request.d1_ms;
  answer.baseline = request.baseline;
  answer.sample = request.sample;
  answer.window_sampled = t1 - t0 > kDeltaMaxCoreMs;
  answer.windows = delta_windows(scope, t0, t1, request.d1_ms);
  ChExecutor& db = *opened.value->db;
  std::vector<DeltaKey> keys;
  try {
    answer.samples = read_delta_samples(db, scope, answer.windows, duration_ns_from_ms(request.d0_ms), duration_ns_from_ms(request.d1_ms), request.sample);
    if (!answer.samples.ids_in.empty()) {
      const AttributeColumns columns = attribute_columns(db, attribute_maps_, host, traces);
      keys = read_delta_keys(db, scope, answer.windows, answer.samples, columns, &answer.attributes_ms);
    }
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_deltas_failed"));
  }
  answer.ranking = rank_deltas(std::move(keys), answer.samples.ids_in.size(), answer.samples.ids_out.size(), answer.samples.total_in,
                               answer.samples.total_out, request.baseline == "all");
  answer.total_ms = elapsed_ms_since(started);
  return Out::ok(std::move(answer));
}

}  // namespace trace
}  // namespace chdash
