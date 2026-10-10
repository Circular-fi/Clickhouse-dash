#pragma once

// The SQL of the Traces page, as pure functions: a value in (the window, the filters, the plan), the text of a statement out.
// Nothing here reads a request or a connection, so a native test (tests/native/trace_test.cpp) compares each statement to its
// expected text, and the strategies of trace_search.hpp / trace_service.hpp send them through a ChExecutor.

#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {
namespace trace {

constexpr int64_t kNsPerMs = 1000000;

// Surrounding-context windows (± around the anchor span) offered by the span inspector; /api/traces/context accepts only these.
constexpr int64_t kContextWindowsMs[] = {1000, 10000, 60000, 300000};

// The pieces of `text` between `delimiter` (an empty piece too).
std::vector<std::string> split_char(std::string_view text, char delimiter);

// `database`.`table`
std::string qualified(std::string_view database, std::string_view table);

// fromUnixTimestamp64Nano(<ns>)
std::string ns_time(int64_t ns);

// Timestamp >= fromUnixTimestamp64Milli(<start>) AND Timestamp <= fromUnixTimestamp64Milli(<end>)
std::string time_predicate(int64_t start_ms, int64_t end_ms);

// The duration of a trace: its last span end less its first span start, as an aggregate over the spans of the trace.
extern const char* const kTraceDurationExpr;

// " HAVING a AND b" -> "a AND b".
std::string having_terms(const std::string& having);

// " HAVING <duration> >= min AND <duration> <= max" for the trace duration filters (milliseconds; 0 = no bound), or empty.
// Duration is a trace-level filter, not a span filter: the trace index cannot answer it, and it stays after the candidate span matching.
std::string duration_having(double min_duration_ms, double max_duration_ms);

// The duration of a span in nanoseconds, from milliseconds.
uint64_t duration_ns_from_ms(double duration_ms);

// A chart bucket, in seconds, for a window: about 60 buckets, never below a minute.
int choose_bucket_seconds(int64_t range_ms);
// The bucket of the latency quantiles: denser than the count chart, with a one-minute floor.
int choose_quantile_bucket_seconds(int64_t range_ms);

// Buckets lie on a grid anchored at `origin` (the browser sends its local midnight, so 3 h / 1 d buckets start at local 00:00
// rather than UTC 00:00). Only the origin modulo the bucket size matters.
int64_t grid_origin_ms(int64_t bucket_origin_ms, int64_t size_ms);
int64_t grid_floor_ms(int64_t t, int64_t size_ms, int64_t origin);
// toString(<origin> + intDiv(toUnixTimestamp64Milli(<column>) - <origin>, <size>) * <size>)
std::string grid_bucket_sql(const std::string& column, int64_t size_ms, int64_t origin);

// The columns of the traces table that are the attribute maps, with their types.
std::string attribute_maps_sql(const std::string& database, const std::string& table);

// ---- what every statement over a window of spans names ----

// The tables, the window, the allowlist and the filters of one request. The filters are SQL already (the attribute maps were
// known when they were written, trace_service.hpp).
struct TraceScope {
  std::string table;         // `otel`.`otel_traces`
  std::string index_table;   // the trace index, or empty when there is none
  std::string visibility;    // the predicate of the service allowlist ("1": every service)
  std::string span_filters;  // " AND ..." or empty
  std::string having;        // " HAVING <duration> ..." or empty
  int64_t start_ms = 0, end_ms = 0;

  std::string window() const { return time_predicate(start_ms, end_ms); }
  bool has_index() const { return !index_table.empty(); }
  bool all_services() const { return visibility == "1"; }
};

// ---- the analytics ----

// The traces of the window with their first span and their duration, as the CTE `trace_durations` (WITH ... ). The span filters
// are a candidate_ids CTE (`narrow`), or a HAVING countIf (`broad`: see filters_are_broad in trace_search.hpp).
std::string trace_durations_cte(const TraceScope& scope, bool broad);

// The buckets of a window of the charts: the count bucket and the (finer) quantile bucket, on grids that nest.
struct AnalyticsGrid {
  int64_t bucket_ms = 0, quantile_bucket_ms = 0;
  int64_t count_origin_ms = 0, quantile_origin_ms = 0;
  int64_t range_start_ms = 0, range_end_ms = 0;  // the window, or its whole buckets (align_buckets)
};
AnalyticsGrid analytics_grid(int64_t start_ms, int64_t end_ms, int64_t bucket_origin_ms, bool align_buckets);

// The count of traces by bucket from the trace index alone: a trace is bucketed by its earliest indexed start in the window.
std::string index_counts_sql(const std::string& index_table, int64_t start_ms, int64_t end_ms, int64_t bucket_ms, int64_t origin_ms);
// The count and the quantiles of the duration of the traces by bucket, from the spans.
std::string analytics_sql(const TraceScope& scope, bool broad, const AnalyticsGrid& grid);

// ---- the heatmap ----

constexpr int kHeatmapBinsPerOctave = 32;      // fine log2 bins (~2.2 % wide)
constexpr int kHeatmapTimeBudgetSeconds = 55;  // below the 60 s receive timeout
// The traces counted into fixed log2 bins by bucket.
std::string heatmap_sql(const TraceScope& scope, bool broad, int64_t bucket_ms, int64_t origin_ms);

// ---- the deltas ----

constexpr int kDeltaTimeBudgetSeconds = 30;
constexpr int64_t kDeltaMaxCoreMs = 30LL * 60 * 1000;  // box time sampled at most
constexpr int kDeltaSlices = 6;
constexpr size_t kDeltaTopValuesPerKey = 40;  // read per key, before ranking
constexpr size_t kDeltaMaxValueBytes = 1024;
constexpr uint64_t kDeltaMinOccurrences = 5;  // HyperDX MIN_PROPERTY_OCCURENCES

// The time ranges that the sampling of a box reads: sampled slices of the box's time range ("cores": trace starts), each read
// with a margin so that a selected trace's later spans and an earlier start are seen (a trace no longer than d1 is aggregated
// exactly).
struct DeltaWindows {
  std::vector<std::pair<int64_t, int64_t>> cores;
  int64_t margin_ms = 0;
  int64_t sampled_ms = 0;
  std::string reads;        // the read predicate: the cores widened by the margin
  std::string core_having;  // the trace starts that belong to a core
};
DeltaWindows delta_windows(const TraceScope& scope, int64_t t0, int64_t t1, double d1_ms);

// The two stable samples: the traces of the box (duration d0..d1) and the others, each side by cityHash64(TraceId).
std::string deltas_sample_sql(const TraceScope& scope, const DeltaWindows& windows, uint64_t d0_ns, uint64_t d1_ns, int sample);
// The (key, value) pairs of the sampled traces' spans; the trace ids are the parameters {ids_in} and {all_ids}.
std::string deltas_attribute_sql(const TraceScope& scope, const DeltaWindows& windows, bool span_map, bool resource_map, size_t n_in,
                                 size_t n_out);

// ---- the service map ----

constexpr uint64_t kServiceMapReadRows = 12000000;
constexpr uint64_t kServiceMapJoinRows = 3000000;
constexpr int64_t kServiceMapSliceMs = 3 * 60 * 1000;
constexpr int kServiceMapMaxSlices = 48;
constexpr int kServiceMapTimeBudgetSeconds = 30;
constexpr int64_t kServiceMapFallbackWindowMs = 10 * 60 * 1000;
constexpr int kServiceMapMaxSampleFactor = 10000;

// What a service map reads of a window: the whole of it, or evenly spaced time slices of it (together `coverage` of the window,
// each centred in its share), and one trace in `trace_factor`.
struct ServiceMapSampling {
  std::string time_predicate;
  int slices = 0;
  double time_coverage = 1.0;
  uint64_t trace_factor = 1;
  bool sampled() const { return trace_factor > 1 || slices > 0; }
  // Counts are scaled back by this.
  double scale() const { return static_cast<double>(trace_factor) / time_coverage; }
};
// `forced_factor` > 0 forces the trace sampling factor (1 = every trace); the time slicing still applies above the read budget.
ServiceMapSampling service_map_sampling(int64_t start_ms, int64_t end_ms, uint64_t estimated_spans, int forced_factor);
// The spans of the window from the primary index alone (EXPLAIN ESTIMATE rows: database, table, parts, rows, marks).
std::string service_map_estimate_sql(const std::string& table, int64_t start_ms, int64_t end_ms);
// An edge A -> B counts the spans of service B whose parent span (same TraceId) belongs to another service A; node metrics count
// every span of the service.
std::string service_map_sql(const TraceScope& scope, const ServiceMapSampling& sampling);

// ---- the services view ----
// RED metrics (rate, errors, duration) of each service's entry spans, after HyperDX's ServicesDashboardPage. Entry spans are the
// spans that receive work: SpanKind Server or Consumer (the OTel exporter writes 'Server', the proto enum spelling is
// 'SPAN_KIND_SERVER'), or a root span of any kind. The primary key starts with (ServiceName, SpanName), so a drill-down into one
// service reads only that service's granules. A window estimated (EXPLAIN ESTIMATE, index only) above kServicesExactRows is
// sampled by time: one slice per chart bucket, at a stable pseudo-random offset inside it, sized to read about kServicesSampleRows;
// counts are scaled back by the sampled share of the window and the answer is marked estimated. exact=1 asks for the whole window;
// the time budget still stops it (marked partial).
constexpr const char* kServiceEntrySpans =
    "(SpanKind IN ('Server', 'Consumer', 'SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')";
constexpr const char* kServiceRootSpans = "ParentSpanId = ''";
constexpr uint64_t kServicesExactRows = 150000000;
constexpr uint64_t kServicesSampleRows = 50000000;
constexpr int64_t kServicesMinSliceMs = 60 * 1000;
constexpr int kServicesTimeBudgetSeconds = 25;
constexpr uint64_t kServicesGroupByCap = 200000;
constexpr size_t kServicesMaxEndpoints = 100;
constexpr size_t kServicesSlowestSpans = 20;
constexpr size_t kServicesMaxReleases = 50;
constexpr uint64_t kServicesReleaseReadRowsCap = 200000000;
constexpr size_t kServicesMaxStatements = 50;
constexpr uint64_t kServicesDbReadRowsCap = 200000000;
constexpr size_t kServicesMaxDetailBytes = 1024;

// The time predicate of a services query: the whole window, or one slice per bucket of the chart grid. scale_for(bucket) turns a
// bucket's sampled counts into window counts; `factor` does it for window totals.
struct ServicesWindow {
  bool sampled = false;
  uint64_t estimated_rows = 0;
  int64_t sampled_ms = 0;
  double factor = 1.0;
  std::string time_sql;
  std::map<int64_t, double> bucket_scale;
  double scale_for(int64_t bucket) const {
    const auto it = bucket_scale.find(bucket);
    return it == bucket_scale.end() ? 1.0 : it->second;
  }
};
ServicesWindow services_window(int64_t start_ms, int64_t end_ms, int64_t bucket_ms, int64_t origin_ms, uint64_t estimated_rows, bool exact);

// " FROM <table> PREWHERE <time> AND <span kind> WHERE <allowlist><where>": the span kind test joins the time range in PREWHERE, so it
// drops most rows before Duration, StatusCode and the filter columns are read.
std::string services_from(const std::string& table, const std::string& time_sql, const std::string& span_kind, const std::string& visibility,
                          const std::string& where);
std::string services_estimate_sql(const std::string& from);
// One scan grouped by (service, bucket[, endpoint]) into t-digest states; the outer GROUPING SETS merge them into service totals,
// service buckets and endpoint totals. grouping(b, op): 3 service, 1 bucket, 2 endpoint (a single '' endpoint per service outside
// the drill-down, ignored).
std::string services_sql(const std::string& from, int64_t bucket_ms, int64_t origin_ms, bool detail);
std::string services_slowest_sql(const std::string& from);
// The first span of each service.version in the whole window, any span kind (HyperDX useReleaseAnnotations).
std::string services_releases_sql(const std::string& table, int64_t start_ms, int64_t end_ms, const std::string& service,
                                  const std::string& visibility);
// Database statements (HyperDX DatabaseTab): spans carrying db.query.text (current semconv) or db.statement (older), grouped by
// statement text. Any span kind (database calls are Client spans).
std::string services_db_sql(const std::string& table, int64_t start_ms, int64_t end_ms, const std::string& visibility, const std::string& where);

// ---- the search ----

// Start >= fromUnixTimestamp64Milli(<start>) AND Start <= fromUnixTimestamp64Milli(<end>): the window on the trace index.
std::string index_window_predicate(int64_t start_ms, int64_t end_ms);

// One slice [lo_ns, hi_ns] of the trace index, one row per trace (its newest Start), at most row_cap + 1 rows.
std::string index_slice_sql(const std::string& index_table, const std::string& window, int64_t lo_ns, int64_t hi_ns, size_t row_cap);

// The size of the window on the index, and the traces of a primary-key filter (at most `threshold`): the test of a broad filter.
std::string index_count_sql(const std::string& index_table, int64_t start_ms, int64_t end_ms);
std::string broad_probe_sql(const TraceScope& scope, size_t threshold);

// The traces whose newest index row lies in [oldest_ns, newest_ns] of the window, as a subquery.
std::string batch_ids_sql(const std::string& index_table, const std::string& window, int64_t oldest_ns, int64_t newest_ns);

// Which of those traces have a span that the filters match: the span match reads only the index time bounds of the batch.
std::string batch_match_sql(const TraceScope& scope, const std::string& batch_ids);

// One round of the ranking by first span (rank_traces_by_start, trace_search.hpp).
struct RankSlice {
  const TraceScope* scope = nullptr;
  bool narrow_filters = false;  // evaluate the span filters as a candidate_ids CTE (else as HAVING countIf, or not at all)
  bool whole = false;           // the whole window, not a slice from `from_ns` on
  int64_t from_ns = 0;
  std::string having;           // " HAVING ..." or empty (the broad form already merged)
  size_t fetch = 0;
};
std::string rank_sql(const RankSlice& slice);
// The traces of the slice that also have a visible span before `before_ns` (they started earlier: their slice aggregate is partial).
std::string rank_probe_sql(const TraceScope& scope, int64_t before_ns, const std::string& ids_list);
// " HAVING countIf(1<filters>) > 0 [AND <duration terms>]": the broad form of the filters.
std::string broad_having(const std::string& span_filters, const std::string& having);

// The summary of the traces of a page: root operation, duration, spans, errors, the services with their counts, the missing parents.
// `first_span_ns` > 0: the exact bounds of the spans (span_end_ns when known); else the index bounds of the traces.
std::string summary_sql(const TraceScope& scope, const std::string& ids_list, int64_t first_span_ns, int64_t span_end_ns, size_t limit);

// ('a','b'): the trace ids of a statement.
std::string trace_id_list_sql(const std::vector<std::string>& ids);

}  // namespace trace
}  // namespace chdash
