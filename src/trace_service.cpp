#include "trace_service.hpp"

#include "api_error.hpp"
#include "ch_block_value.hpp"
#include "jwt.hpp"
#include "otel_allowlist.hpp"
#include "sql_literal.hpp"
#include "trace_budget.hpp"
#include "trace_sql.hpp"

#include <algorithm>
#include <algorithm>
#include <chrono>
#include <unordered_set>

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

  // The span filter SQL of the request is " AND ..." or empty. The error is returned when a tag filter needs an attribute map
  // that is not usable. The attribute schema is looked up, from the cache, only when tag filters are present.
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

Result<SearchAnswer> TraceService::search(const RequestContext& context, const HostSpec& host, const WindowRequest& request, size_t limit,
                                          size_t candidate_cap) const {
  using Out = Result<SearchAnswer>;
  const auto started = std::chrono::steady_clock::now();
  // The statements of the search share the time of its budget. The scan of the index stops before the time runs out
  // (SearchBudget).
  const BudgetScope bounds(context, kSearchBudget);
  auto opened = open_scope(host, request);
  if (!opened.value) return Out::fail(std::move(opened.error));
  const TraceScope& scope = opened.value->scope;
  SearchAnswer answer;
  answer.source_host_id = request.source_host_id;
  // Only service and operation filters (primary-key columns) may use the broad form.
  const bool key_only_filters = !scope.span_filters.empty() && request.filters.key_only();
  SearchBudget budget;
  budget.remaining_ms = [&bounds] { return bounds.remaining_ms(); };
  try {
    answer.outcome = search_traces(*opened.value->db, scope, key_only_filters, limit, budget, candidate_cap);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_search_failed"));
  }
  answer.all_services = scope.all_services();
  answer.total_ms = elapsed_ms_since(started);
  return Out::ok(std::move(answer));
}

Result<AnalyticsAnswer> TraceService::analytics(const RequestContext& context, const HostSpec& host, const AnalyticsRequest& request) const {
  using Out = Result<AnalyticsAnswer>;
  const auto started = std::chrono::steady_clock::now();
  const BudgetScope bounds(context, kAnalyticsBudget);
  auto opened = open_scope(host, request.window);
  if (!opened.value) return Out::fail(std::move(opened.error));
  const TraceScope& scope = opened.value->scope;
  bool want_counts = true, want_durations = true;
  if (!parse_charts(request.charts, &want_counts, &want_durations)) {
    return Out::fail(make_error(400, "invalid_trace_charts", "charts must list counts and/or durations."));
  }
  const AnalyticsGrid grid = analytics_grid(scope.start_ms, scope.end_ms, request.bucket_origin_ms, request.align_buckets);
  // Only service and operation filters (primary-key columns) may use the broad form.
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

Result<TraceService::OpenedServices> TraceService::open_services(const HostSpec& host, const ServicesRequest& request) const {
  using Out = Result<OpenedServices>;
  const TraceSettings& traces = host.otel.traces;
  OpenedServices opened;
  std::string error;
  opened.db = open_(host, &error);
  if (!opened.db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));
  std::string tags;
  if (!request.filters.tags.empty()) {
    const AttributeColumns columns = attribute_columns(*opened.db, attribute_maps_, host, traces);
    std::string code, message;
    if (!tag_filters_sql(request.filters.tags, columns, &tags, &code, &message)) {
      return Out::fail(make_error(filter_error_status(code), code, message));
    }
  }
  ServicesQuery& query = opened.query;
  query.where = span_filters_sql(request.filters, tags);
  if (!request.detail.empty()) query.where += " AND ServiceName = " + sql::quote_string(request.detail);
  if (request.min_duration_ms > 0.0) query.where += " AND Duration >= " + std::to_string(duration_ns_from_ms(request.min_duration_ms));
  if (request.max_duration_ms > 0.0) query.where += " AND Duration <= " + std::to_string(duration_ns_from_ms(request.max_duration_ms));
  opened.columns = attribute_columns(*opened.db, attribute_maps_, host, traces);
  query.table = qualified(traces.database, traces.table);
  query.visibility = otel::service_allowlist_predicate(traces);
  query.span_scope = request.span_scope;
  query.detail = request.detail;
  query.start_ms = request.start_ms;
  query.end_ms = request.end_ms;
  query.bucket_origin_ms = request.bucket_origin_ms;
  query.align_buckets = request.align_buckets;
  query.exact = request.exact;
  query.releases_supported = opened.columns.resource();
  return Out::ok(std::move(opened));
}

Result<ServicesAnswer> TraceService::services(const RequestContext&, const HostSpec& host, const ServicesRequest& request) const {
  using Out = Result<ServicesAnswer>;
  const auto started = std::chrono::steady_clock::now();
  auto opened = open_services(host, request);
  if (!opened.value) return Out::fail(std::move(opened.error));
  ServicesAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.span_scope = request.span_scope;
  answer.detail = request.detail;
  answer.start_ms = request.start_ms;
  answer.end_ms = request.end_ms;
  try {
    auto outcome = run_services(*opened.value->db, opened.value->query);
    if (!outcome.value) return Out::fail(std::move(outcome.error));
    answer.outcome = std::move(*outcome.value);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_services_failed"));
  }
  answer.total_ms = elapsed_ms_since(started);
  return Out::ok(std::move(answer));
}

Result<ServicesDbAnswer> TraceService::services_db(const RequestContext&, const HostSpec& host, const ServicesRequest& request) const {
  using Out = Result<ServicesDbAnswer>;
  auto opened = open_services(host, request);
  if (!opened.value) return Out::fail(std::move(opened.error));
  ServicesDbAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.detail = request.detail;
  answer.start_ms = request.start_ms;
  answer.end_ms = request.end_ms;
  try {
    answer.outcome = run_services_db(*opened.value->db, opened.value->query, opened.value->columns.span());
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_services_failed"));
  }
  return Out::ok(std::move(answer));
}

Result<MetaAnswer> TraceService::meta(const RequestContext&, const HostSpec& host, const std::string& source_host_id) const {
  using Out = Result<MetaAnswer>;
  const TraceSettings& traces = host.otel.traces;
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));
  MetaAnswer answer;
  answer.source_host_id = source_host_id;
  answer.traces = traces;
  try {
    read_schema(*db, traces, &answer.outcome);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_schema_failed"));
  }
  if (read_attribute_maps(*db, traces, &answer.outcome.span_attribute_map, &answer.outcome.resource_attribute_map)) {
    store_attribute_maps(attribute_maps_, host, traces, answer.outcome.span_attribute_map, answer.outcome.resource_attribute_map);
  }
  return Out::ok(std::move(answer));
}

Result<PrefillAnswer> TraceService::prefill(const RequestContext&, const HostSpec& host, const PrefillRequest& request) const {
  using Out = Result<PrefillAnswer>;
  const TraceSettings& traces = host.otel.traces;
  // Only the tag filters narrow the picker lists. The scans are bounded: each pass reads at most kPrefillPassRows rows, and all
  // passes read at most kPrefillReadRows rows. The parameter read_rows_limit lowers both bounds. The list is reported as an
  // estimate when a bound stops the scans.
  std::string tag_filters;
  if (!request.filters.tags.empty()) {
    std::string error;
    auto db = open_(host, &error);
    if (!db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));
    std::string code, message;
    if (!tag_filters_sql(request.filters.tags, attribute_columns(*db, attribute_maps_, host, traces), &tag_filters, &code, &message)) {
      return Out::fail(make_error(filter_error_status(code), code, message));
    }
  }
  // The filter part of the key is a digest. The key does not keep the filters themselves, which can be up to 32 filters of 4 KiB
  // each.
  const std::string cache_key = request.source_host_id + '\0' + std::to_string(request.aligned_start_ms) + '\0' +
      std::to_string(request.aligned_end_ms) + '\0' + std::to_string(request.read_budget) + '\0' + sha256_hex(tag_filters);
  const auto cached = prefill_.get(cache_key, [&](Prefill& value, std::string& code, std::string& message) {
    std::string error;
    auto db = open_(host, &error);
    if (!db) {
      code = "trace_source_unavailable";
      message = connect_error(error);
      return false;
    }
    try {
      value = read_prefill(*db, qualified(traces.database, traces.table), otel::service_allowlist_predicate(traces), tag_filters,
                           request.aligned_start_ms, request.aligned_end_ms, request.read_budget);
    } catch (const std::exception& e) {
      db->invalidate();
      code = "trace_prefill_failed";
      message = e.what();
      return false;
    }
    return true;
  });
  if (!cached.has_value || !cached.value) {
    return Out::fail(make_error(503, cached.error_code.empty() ? "trace_prefill_failed" : cached.error_code,
                                cached.error_message.empty() ? "Trace prefill failed." : cached.error_message));
  }
  PrefillAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.start_ms = request.start_ms;
  answer.end_ms = request.end_ms;
  answer.tag_filtered = !tag_filters.empty();
  answer.read_budget = request.read_budget;
  answer.value = cached.value;
  return Out::ok(std::move(answer));
}

Result<FacetKeysAnswer> TraceService::facet_keys(const RequestContext&, const HostSpec& host, const FacetRequest& request) const {
  using Out = Result<FacetKeysAnswer>;
  const TraceSettings& traces = host.otel.traces;
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));
  const AttributeColumns columns = attribute_columns(*db, attribute_maps_, host, traces);
  std::string tags, code, message;
  if (!request.filters.tags.empty() && !tag_filters_sql(request.filters.tags, columns, &tags, &code, &message)) {
    return Out::fail(make_error(filter_error_status(code), code, message));
  }
  const std::string span_filters = span_filters_sql(request.filters, tags);
  const bool span = columns.span();
  const bool resource = columns.resource();
  const std::string cache_key = request.source_host_id + '\0' + std::to_string(request.aligned_start_ms) + '\0' +
      std::to_string(request.aligned_end_ms) + '\0' + (span ? "s" : "") + (resource ? "r" : "") + '\0' +
      std::to_string(request.read_cap) + '\0' + sha256_hex(span_filters);
  const auto cached = facet_keys_.get(cache_key, [&](FacetKeys& value, std::string& fetch_code, std::string& fetch_message) {
    if (!span && !resource) return true;
    try {
      value = read_facet_keys(*db,
          facet_keys_sql(qualified(traces.database, traces.table), request.aligned_start_ms, request.aligned_end_ms,
                         otel::service_allowlist_predicate(traces), span_filters, span, resource, request.read_cap),
          request.read_cap);
    } catch (const std::exception& e) {
      db->invalidate();
      fetch_code = "trace_facets_failed";
      fetch_message = e.what();
      return false;
    }
    return true;
  });
  if (!cached.has_value || !cached.value) {
    return Out::fail(make_error(503, cached.error_code.empty() ? "trace_facets_failed" : cached.error_code,
                                cached.error_message.empty() ? "Trace attribute discovery failed." : cached.error_message));
  }
  FacetKeysAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.request = request;
  answer.span = span;
  answer.resource = resource;
  answer.cached = !cached.fetched;
  answer.value = cached.value;
  return Out::ok(std::move(answer));
}

Result<FacetValuesAnswer> TraceService::facet_values(const RequestContext&, const HostSpec& host, const FacetRequest& request) const {
  using Out = Result<FacetValuesAnswer>;
  const TraceSettings& traces = host.otel.traces;
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));
  const AttributeColumns columns = attribute_columns(*db, attribute_maps_, host, traces);
  if (request.key_scope == "span" ? !columns.span() : !columns.resource()) {
    const bool disabled = request.key_scope == "span" ? !columns.span_enabled : !columns.resource_enabled;
    std::string code, message;
    set_attribute_scope_error(columns, disabled, "filters", &code, &message);
    return Out::fail(make_error(filter_error_status(code), code, message));
  }
  // The values of a key ignore the filters of that key. Therefore the other values stay visible. A user can add more values,
  // because several values of one key match any of them.
  std::string tags, code, message;
  if (!request.filters.tags.empty() &&
      !tag_filters_sql(request.filters.tags, columns, &tags, &code, &message, &request.key_scope, &request.key)) {
    return Out::fail(make_error(filter_error_status(code), code, message));
  }
  const std::string span_filters = span_filters_sql(request.filters, tags);
  // The text from the client, which is the attribute key and the filters, enters the key as a digest.
  const std::string cache_key = request.source_host_id + '\0' + std::to_string(request.aligned_start_ms) + '\0' +
      std::to_string(request.aligned_end_ms) + '\0' + request.key_scope + '\0' + std::to_string(request.limit) + '\0' +
      std::to_string(request.read_cap) + '\0' + sha256_hex(request.key + '\0' + span_filters);
  const auto cached = facet_values_.get(cache_key, [&](FacetValues& value, std::string& fetch_code, std::string& fetch_message) {
    try {
      value = read_facet_values(*db,
          facet_values_sql(qualified(traces.database, traces.table), request.aligned_start_ms, request.aligned_end_ms,
                           otel::service_allowlist_predicate(traces), span_filters, request.key_scope, request.key, request.limit,
                           request.read_cap),
          request.read_cap);
    } catch (const std::exception& e) {
      db->invalidate();
      fetch_code = "trace_facet_values_failed";
      fetch_message = e.what();
      return false;
    }
    return true;
  });
  if (!cached.has_value || !cached.value) {
    return Out::fail(make_error(503, cached.error_code.empty() ? "trace_facet_values_failed" : cached.error_code,
                                cached.error_message.empty() ? "Trace attribute values failed." : cached.error_message));
  }
  FacetValuesAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.request = request;
  answer.cached = !cached.fetched;
  answer.value = cached.value;
  return Out::ok(std::move(answer));
}

Result<TraceDetailAnswer> TraceService::trace_detail(const RequestContext& context, const HostSpec& host, const TraceDetailRequest& request) const {
  using Out = Result<TraceDetailAnswer>;
  const BudgetScope bounds(context, kTraceDetailBudget);
  const TraceSettings& traces = host.otel.traces;
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));
  if (traces.trace_index_table.empty()) return Out::fail(make_error(503, "trace_index_unavailable", "Trace detail requires traces.trace_index_table."));
  const std::string visibility = otel::service_allowlist_predicate(traces);
  TraceDetailAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.trace_id = request.trace_id;
  answer.features = traces.features;
  try {
    answer.spans = read_detail_spans(*db, trace_detail_sql(traces, request.trace_id, visibility));
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_index_lookup_failed"));
  }
  answer.truncated = answer.spans.size() > traces.max_spans_per_trace;
  if (answer.truncated) answer.spans.resize(traces.max_spans_per_trace);
  if (answer.spans.empty()) return Out::fail(make_error(404, "trace_not_found", "Trace was not found in the configured time scope."));

  // Do not reveal the SpanId of a parent that the service allowlist hid. Instead, treat the first visible descendant as a visible
  // root.
  std::unordered_set<std::string> visible_span_ids;
  visible_span_ids.reserve(answer.spans.size());
  for (const auto& span : answer.spans) visible_span_ids.insert(span.span_id);
  for (auto& span : answer.spans) {
    span.parent_span_id = std::string(visible_parent(span.parent_span_id, visibility == "1", &visible_span_ids));
  }
  return Out::ok(std::move(answer));
}

Result<SpanAnswer> TraceService::span(const RequestContext&, const HostSpec& host, const SpanRequest& request) const {
  using Out = Result<SpanAnswer>;
  const TraceSettings& traces = host.otel.traces;
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));
  const std::string visibility = otel::service_allowlist_predicate(traces);
  SpanAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.features = traces.features;
  answer.all_services = visibility == "1";
  try {
    answer.values = read_first_row(*db, span_sql(traces, request.trace_id, request.span_id, request.timestamp_ns, visibility));
  } catch (const std::exception& e) {
    db->invalidate();
    return Out::fail(error_from_clickhouse(e, "trace", "trace_span_failed"));
  }
  if (answer.values.size() < 19) return Out::fail(make_error(404, "span_not_found", "Span was not found."));
  return Out::ok(std::move(answer));
}

Result<LinkedFromAnswer> TraceService::linked_from(const RequestContext&, const HostSpec& host, const LinkedFromRequest& request) const {
  using Out = Result<LinkedFromAnswer>;
  const TraceSettings& traces = host.otel.traces;
  if (!traces.features.links) return Out::fail(make_error(404, "trace_links_disabled", "Span links are disabled by traces.features."));
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));

  LinkedFromAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.trace_id = request.trace_id;
  answer.span_id = request.span_id;
  answer.range_source = "request";
  int64_t start_ms = request.start_ms, end_ms = request.end_ms;
  if (!request.has_range) {
    // The caller gives no window. The trace index gives the bounds of the trace.
    if (traces.trace_index_table.empty()) {
      return Out::fail(make_error(503, "trace_index_unavailable", "Linked-from lookups without start_ms/end_ms require traces.trace_index_table."));
    }
    uint64_t count = 0;
    try {
      db->select(trace_index_bounds_sql(traces, request.trace_id), [&](const clickhouse::Block& block) {
        if (!block.GetRowCount()) return;
        count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
        if (count) {
          start_ms = std::stoll(ch_block_text_at(block, 1, 0));
          end_ms = std::stoll(ch_block_text_at(block, 2, 0)) + 1;
        }
      });
    } catch (const std::exception& e) {
      return Out::fail(error_from_clickhouse(e, "trace", "trace_index_lookup_failed"));
    }
    if (!count) return Out::fail(make_error(404, "trace_not_found", "Trace was not found in the trace index."));
    answer.range_source = "trace_index";
  }
  constexpr int64_t kMaxTraceTimeMs = INT64_MAX / 1000000 - 1;
  const int64_t margin_ms = static_cast<int64_t>(traces.linked_from_margin_minutes) * 60 * 1000;
  if (start_ms < 0 || end_ms < start_ms || end_ms > kMaxTraceTimeMs - margin_ms) {
    return Out::fail(make_error(400, "invalid_trace_range", "Invalid trace time range."));
  }
  if (end_ms - start_ms > static_cast<int64_t>(traces.max_lookback_minutes) * 60 * 1000) {
    return Out::fail(make_error(400, "invalid_trace_range", "Trace time range exceeds traces.max_lookback_minutes."));
  }
  answer.lo_ms = std::max<int64_t>(0, start_ms - margin_ms);
  answer.hi_ms = end_ms + margin_ms;
  answer.margin_minutes = traces.linked_from_margin_minutes;

  const std::string visibility = otel::service_allowlist_predicate(traces);
  answer.all_services = visibility == "1";
  const auto started = std::chrono::steady_clock::now();
  try {
    answer.rows = read_span_rows(*db, linked_from_sql(traces, request.trace_id, request.span_id, answer.lo_ms, answer.hi_ms, visibility), true);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_linked_from_failed"));
  }
  answer.elapsed_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  answer.truncated = answer.rows.size() > kLinkedFromLimit;
  if (answer.truncated) answer.rows.resize(kLinkedFromLimit);
  return Out::ok(std::move(answer));
}

Result<ContextAnswer> TraceService::context(const RequestContext&, const HostSpec& host, const ContextRequest& request) const {
  using Out = Result<ContextAnswer>;
  const TraceSettings& traces = host.otel.traces;
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));

  std::string filter_sql;
  const std::string& filter = request.filter;
  const auto invalid = [&](std::string message) { return Out::fail(make_error(400, "invalid_context_filter", std::move(message))); };
  if (filter == "service") {
    if (request.service.empty() || request.service.size() > 1024) return invalid("service is required for the service filter.");
    filter_sql = "ServiceName = " + sql::quote_string(request.service);
  } else if (filter == "host" || filter == "pod" || filter == "attribute") {
    std::string scope = "resource", key, value;
    if (filter == "attribute") {
      scope = request.attr_scope;
      key = request.attr_key;
      value = request.attr_value;
      if (scope != "span" && scope != "resource") return invalid("attr_scope must be span or resource.");
      if (key.empty() || key.size() > 256) return invalid("attr_key must be 1 to 256 bytes.");
    } else {
      key = filter == "host" ? "host.name" : "k8s.pod.name";
      value = request.value;
      if (value.empty()) return invalid("value is required for the " + filter + " filter.");
    }
    if (value.size() > 4096) return invalid("The attribute value is too long.");
    const bool resource = scope == "resource";
    if (!(resource ? traces.features.resource_attributes : traces.features.span_attributes)) {
      return Out::fail(make_error(400, "context_filter_disabled", std::string(resource ? "resource" : "span") + " attributes are disabled by traces.features."));
    }
    bool span_map = false, resource_map = false;
    cached_attribute_maps(*db, attribute_maps_, host, traces, &span_map, &resource_map);
    if (!(resource ? resource_map : span_map)) {
      return Out::fail(make_error(400, "context_filter_unavailable", "Attribute filters need Map attribute columns."));
    }
    filter_sql = context_filter_sql(resource ? "ResourceAttributes" : "SpanAttributes", key, value);
  } else if (filter != "any") {
    return invalid("filter must be any, service, host, pod or attribute.");
  }

  const std::string visibility = otel::service_allowlist_predicate(traces);
  ContextQuery query;
  query.table = qualified(traces.database, traces.table);
  query.visibility = visibility;
  query.filter_sql = filter_sql;
  query.anchor_ns = request.anchor_ns;
  query.window_ns = request.window_ms * kNsPerMs;
  query.direction = request.direction;
  query.limit = request.limit;
  query.cursor_ns = request.cursor_ns;
  query.cursor_span = request.cursor_span;
  ContextAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.request = request;
  answer.lo_ns = request.anchor_ns - query.window_ns;
  answer.hi_ns = request.anchor_ns + query.window_ns;
  answer.all_services = visibility == "1";
  try {
    answer.outcome = read_context(*db, query);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "trace", "trace_context_failed"));
  }
  return Out::ok(std::move(answer));
}

Result<SpansAnswer> TraceService::spans(const RequestContext&, const HostSpec& host, const SpansRequest& request) const {
  using Out = Result<SpansAnswer>;
  const auto started = std::chrono::steady_clock::now();
  const TraceSettings& traces = host.otel.traces;
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "trace_source_unavailable", connect_error(error)));

  // Column predicates go to PREWHERE. These are the primary-key predicates on ServiceName and SpanName, the status, the kind, the
  // duration, and the allowlist. Attribute map predicates stay in WHERE. They read the large map columns, so they run only on the
  // rows that are left.
  std::string tag_sql, columns_sql;
  if (!request.filters.tags.empty() || !request.columns.empty()) {
    const AttributeColumns cols = attribute_columns(*db, attribute_maps_, host, traces);
    std::string code, message;
    if (!tag_filters_sql(request.filters.tags, cols, &tag_sql, &code, &message)) {
      return Out::fail(make_error(filter_error_status(code), code, message));
    }
    if (!span_columns_sql(request.columns, cols, &columns_sql, &code, &message)) {
      return Out::fail(make_error(filter_error_status(code), code, message));
    }
  }
  const std::string visibility = otel::service_allowlist_predicate(traces);
  SpanSearchPlan plan;
  plan.sql.select = std::string("SELECT ") + kSpanSearchColumns + columns_sql + " FROM " + qualified(traces.database, traces.table);
  plan.sql.visibility = visibility;
  plan.sql.column_filters = span_column_filters_sql(span_filters_sql(request.filters, ""), request.kinds, request.min_duration_ms, request.max_duration_ms);
  plan.sql.tag_sql = tag_sql;
  plan.attribute_count = request.columns.size();
  plan.start_ns = request.start_ms * kNsPerMs;
  plan.end_ns = request.end_ms * kNsPerMs;
  plan.limit = request.limit;
  plan.budget_ms = request.budget_ms;
  plan.cursor = request.cursor;
  SpansAnswer answer;
  answer.source_host_id = request.source_host_id;
  answer.request = request;
  // A parent that the service allowlist hides must not reveal its SpanId, as in the trace detail. With a restricted allowlist,
  // the parent ids are not reported.
  answer.all_services = visibility == "1";
  try {
    answer.outcome = run_span_search(*db, plan);
  } catch (const std::exception& e) {
    db->invalidate();
    return Out::fail(error_from_clickhouse(e, "trace", "trace_spans_failed"));
  }
  answer.total_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  return Out::ok(std::move(answer));
}

}  // namespace trace
}  // namespace chdash
