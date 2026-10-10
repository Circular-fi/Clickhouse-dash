#include "trace_sql.hpp"

#include "sql_literal.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace chdash {
namespace trace {

std::vector<std::string> split_char(std::string_view text, char delimiter) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= text.size(); ++i) {
    if (i != text.size() && text[i] != delimiter) continue;
    out.emplace_back(text.substr(start, i - start));
    start = i + 1;
  }
  return out;
}

std::string qualified(std::string_view database, std::string_view table) { return sql::quote_ident(database) + "." + sql::quote_ident(table); }

std::string ns_time(int64_t ns) { return "fromUnixTimestamp64Nano(" + std::to_string(ns) + ")"; }

std::string time_predicate(int64_t start_ms, int64_t end_ms) {
  return "Timestamp >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND Timestamp <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")";
}

const char* const kTraceDurationExpr =
    "(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - "
    "toInt64(min(toUnixTimestamp64Nano(Timestamp))))";

std::string having_terms(const std::string& having) {
  static const std::string kPrefix = " HAVING ";
  return having.rfind(kPrefix, 0) == 0 ? having.substr(kPrefix.size()) : having;
}

uint64_t duration_ns_from_ms(double duration_ms) { return static_cast<uint64_t>(std::llround(duration_ms * 1000000.0)); }

std::string duration_having(double min_duration_ms, double max_duration_ms) {
  std::string having;
  if (min_duration_ms > 0.0) {
    having += std::string(having.empty() ? " HAVING " : " AND ") + kTraceDurationExpr + " >= " + std::to_string(duration_ns_from_ms(min_duration_ms));
  }
  if (max_duration_ms > 0.0) {
    having += std::string(having.empty() ? " HAVING " : " AND ") + kTraceDurationExpr + " <= " + std::to_string(duration_ns_from_ms(max_duration_ms));
  }
  return having;
}

int choose_bucket_seconds(int64_t range_ms) {
  // Aim for roughly 60 visible buckets. A one-hour range therefore has one bar per minute.
  const int64_t desired = std::max<int64_t>(60, range_ms / 1000 / 60);
  const int candidates[] = {60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800, 1209600, 2592000};
  for (int value : candidates) if (value >= desired) return value;
  return candidates[sizeof(candidates) / sizeof(candidates[0]) - 1];
}

int choose_quantile_bucket_seconds(int64_t range_ms) {
  // Keep latency quantiles denser than the count chart while retaining a one-minute floor.
  const int64_t desired = std::max<int64_t>(60, range_ms / 1000 / 120);
  const int candidates[] = {60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800};
  for (int value : candidates) if (value >= desired) return value;
  return candidates[sizeof(candidates) / sizeof(candidates[0]) - 1];
}

int64_t grid_origin_ms(int64_t bucket_origin_ms, int64_t size_ms) { return ((bucket_origin_ms % size_ms) + size_ms) % size_ms; }

int64_t grid_floor_ms(int64_t t, int64_t size_ms, int64_t origin) {
  const int64_t offset = t - origin;
  return origin + (offset >= 0 ? offset / size_ms : -((-offset + size_ms - 1) / size_ms)) * size_ms;
}

std::string grid_bucket_sql(const std::string& column, int64_t size_ms, int64_t origin) {
  return "toString(" + std::to_string(origin) + " + intDiv(toUnixTimestamp64Milli(" + column + ") - " +
         std::to_string(origin) + ", " + std::to_string(size_ms) + ") * " + std::to_string(size_ms) + ")";
}

std::string attribute_maps_sql(const std::string& database, const std::string& table) {
  return "SELECT toString(name), toString(type) FROM system.columns WHERE database = " + sql::quote_string(database) +
         " AND `table` = " + sql::quote_string(table) + " AND name IN ('SpanAttributes','ResourceAttributes')";
}

// ---- the analytics ----

std::string trace_durations_cte(const TraceScope& scope, bool broad) {
  const bool has_filters = !scope.span_filters.empty();
  const bool narrow = has_filters && !broad;
  const std::string candidate_cte = narrow
      ? "candidate_ids AS (SELECT TraceId FROM " + scope.table + " PREWHERE " + scope.window() +
        " WHERE " + scope.visibility + scope.span_filters + " LIMIT 1 BY TraceId)"
      : std::string{};
  const std::string candidate_where = narrow ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : std::string{};
  // Broad service / operation filters aggregate once with HAVING countIf instead of building an IN set of most traces.
  const std::string having = broad ? broad_having(scope.span_filters, scope.having) : scope.having;
  const std::string trace_scope = " FROM " + scope.table + " PREWHERE " + scope.window() + " WHERE " + scope.visibility +
      candidate_where + " GROUP BY TraceId" + having;
  return std::string("WITH ") + (narrow ? candidate_cte + ", " : std::string{}) +
         "trace_durations AS (SELECT min(Timestamp) AS trace_start, " + kTraceDurationExpr + " AS duration_ns" + trace_scope + ") ";
}

AnalyticsGrid analytics_grid(int64_t start_ms, int64_t end_ms, int64_t bucket_origin_ms, bool align_buckets) {
  AnalyticsGrid grid;
  const int bucket_seconds = choose_bucket_seconds(end_ms - start_ms);
  int quantile_bucket_seconds = choose_quantile_bucket_seconds(end_ms - start_ms);
  if (bucket_seconds % quantile_bucket_seconds != 0) {
    quantile_bucket_seconds = std::max(60, std::gcd(bucket_seconds, quantile_bucket_seconds));
  }
  grid.bucket_ms = static_cast<int64_t>(bucket_seconds) * 1000;
  grid.quantile_bucket_ms = static_cast<int64_t>(quantile_bucket_seconds) * 1000;
  // Buckets lie on a grid anchored at bucket_origin_ms. Only the origin modulo the bucket size matters, and the quantile bucket
  // divides the count bucket, so both grids nest.
  grid.count_origin_ms = grid_origin_ms(bucket_origin_ms, grid.bucket_ms);
  grid.quantile_origin_ms = grid_origin_ms(bucket_origin_ms, grid.quantile_bucket_ms);
  grid.range_start_ms = align_buckets ? grid_floor_ms(start_ms, grid.bucket_ms, grid.count_origin_ms) : start_ms;
  grid.range_end_ms = align_buckets ? grid_floor_ms(end_ms + grid.bucket_ms - 1, grid.bucket_ms, grid.count_origin_ms) : end_ms;
  return grid;
}

std::string index_counts_sql(const std::string& index_table, int64_t start_ms, int64_t end_ms, int64_t bucket_ms, int64_t origin_ms) {
  return "SELECT " + grid_bucket_sql("first_start", bucket_ms, origin_ms) + " AS bucket_ms, toString(count()) "
         "FROM (SELECT min(Start) AS first_start FROM " + index_table + " PREWHERE " + index_window_predicate(start_ms, end_ms) +
         " GROUP BY TraceId) GROUP BY bucket_ms ORDER BY bucket_ms";
}

std::string analytics_sql(const TraceScope& scope, bool broad, const AnalyticsGrid& grid) {
  return trace_durations_cte(scope, broad) +
         "SELECT " + grid_bucket_sql("trace_start", grid.quantile_bucket_ms, grid.quantile_origin_ms) + " AS bucket_ms, toString(count()), "
         "toString(toUInt64(quantileTDigest(0.50)(duration_ns))), toString(toUInt64(quantileTDigest(0.90)(duration_ns))), "
         "toString(toUInt64(quantileTDigest(0.95)(duration_ns))), toString(toUInt64(quantileTDigest(0.99)(duration_ns))) "
         "FROM trace_durations GROUP BY bucket_ms ORDER BY bucket_ms";
}

// ---- the heatmap ----

std::string heatmap_sql(const TraceScope& scope, bool broad, int64_t bucket_ms, int64_t origin_ms) {
  return trace_durations_cte(scope, broad) +
         "SELECT " + grid_bucket_sql("trace_start", bucket_ms, origin_ms) + " AS bucket_ms, "
         "toString(toInt32(floor(log2(greatest(duration_ns, 1)) * " + std::to_string(kHeatmapBinsPerOctave) + "))) AS fine_bin, "
         "toString(count()) FROM trace_durations GROUP BY bucket_ms, fine_bin"
         " SETTINGS max_execution_time = " + std::to_string(kHeatmapTimeBudgetSeconds);
}

// ---- the deltas ----

DeltaWindows delta_windows(const TraceScope& scope, int64_t t0, int64_t t1, double d1_ms) {
  DeltaWindows out;
  const int64_t width = t1 - t0;
  if (width <= kDeltaMaxCoreMs) {
    out.cores.emplace_back(t0, t1);
  } else {
    const int64_t slice = kDeltaMaxCoreMs / kDeltaSlices;
    for (int i = 0; i < kDeltaSlices; ++i) {
      const int64_t center = t0 + static_cast<int64_t>((static_cast<double>(i) + 0.5) * static_cast<double>(width) / kDeltaSlices);
      out.cores.emplace_back(std::max(t0, center - slice / 2), std::min(t1, center + slice / 2));
    }
  }
  out.margin_ms = std::max<int64_t>(1000, std::min<int64_t>(300000, static_cast<int64_t>(std::ceil(d1_ms * 2.0))));
  for (const auto& [lo, hi] : out.cores) {
    out.sampled_ms += hi - lo;
    out.reads += std::string(out.reads.empty() ? "" : " OR ") + "(" +
                 time_predicate(std::max(scope.start_ms, lo - out.margin_ms), std::min(scope.end_ms, hi + out.margin_ms)) + ")";
    out.core_having += std::string(out.core_having.empty() ? "" : " OR ") + "(trace_start >= fromUnixTimestamp64Milli(" +
                       std::to_string(lo) + ") AND trace_start <= fromUnixTimestamp64Milli(" + std::to_string(hi) + "))";
  }
  out.reads = "(" + out.reads + ")";
  return out;
}

std::string deltas_sample_sql(const TraceScope& scope, const DeltaWindows& windows, uint64_t d0_ns, uint64_t d1_ns, int sample) {
  const bool has_filters = !scope.span_filters.empty();
  const std::string candidates = has_filters
      ? "WITH candidate_ids AS (SELECT TraceId FROM " + scope.table + " PREWHERE " + windows.reads + " WHERE " +
        scope.visibility + scope.span_filters + " LIMIT 1 BY TraceId) "
      : std::string{};
  return candidates +
      "SELECT toString(TraceId), toString(in_box), toString(count() OVER (PARTITION BY in_box)) FROM ("
      "SELECT TraceId, duration_ns >= " + std::to_string(d0_ns) + " AND duration_ns <= " + std::to_string(d1_ns) + " AS in_box FROM ("
      "SELECT TraceId, min(Timestamp) AS trace_start, " + kTraceDurationExpr + " AS duration_ns FROM " + scope.table +
      " PREWHERE " + windows.reads + " WHERE " + scope.visibility +
      (has_filters ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : "") +
      " GROUP BY TraceId HAVING (" + windows.core_having + ")" +
      (scope.having.empty() ? std::string{} : " AND " + having_terms(scope.having)) +
      ")) ORDER BY in_box DESC, cityHash64(TraceId) LIMIT " + std::to_string(sample) + " BY in_box" +
      " SETTINGS max_execution_time = " + std::to_string(kDeltaTimeBudgetSeconds);
}

std::string deltas_attribute_sql(const TraceScope& scope, const DeltaWindows& windows, bool span_map, bool resource_map, size_t n_in,
                                 size_t n_out) {
  std::string pairs = "[('column', 'ServiceName', toString(ServiceName)), ('column', 'SpanName', toString(SpanName)), "
                      "('column', 'StatusCode', toString(StatusCode))]";
  if (span_map) pairs += ", arrayMap((k, v) -> ('span', toString(k), toString(v)), SpanAttributes.keys, SpanAttributes.values)";
  if (resource_map) pairs += ", arrayMap((k, v) -> ('resource', toString(k), toString(v)), ResourceAttributes.keys, ResourceAttributes.values)";
  // Share of the side's sampled traces, so that values are ranked alike whatever the two sample sizes.
  const std::string share = "x.2 / " + std::to_string(n_in) + " + x.3 / " + std::to_string(std::max<size_t>(1, n_out));
  return "SELECT scope, key, toString(uniq_in), toString(uniq_out), toString(occ_in), toString(occ_out), "
         "tv.1, toString(tv.2), toString(tv.3) FROM ("
         "SELECT scope, key, countIf(n_in > 0) AS uniq_in, countIf(n_out > 0) AS uniq_out, sum(n_in) AS occ_in, sum(n_out) AS occ_out, "
         "arraySlice(arrayReverseSort(x -> " + share + ", groupArray((value, n_in, n_out))), 1, " +
         std::to_string(kDeltaTopValuesPerKey) + ") AS top FROM ("
         "SELECT kv.1 AS scope, kv.2 AS key, kv.3 AS value, uniqExactIf(TraceId, side) AS n_in, uniqExactIf(TraceId, NOT side) AS n_out FROM ("
         "SELECT TraceId, TraceId IN {ids_in:Array(String)} AS side, arrayJoin(arrayConcat(" + pairs + ")) AS kv FROM " +
         scope.table + " PREWHERE " + windows.reads + " AND TraceId IN {all_ids:Array(String)} WHERE " + scope.visibility +
         ") WHERE length(kv.3) <= " + std::to_string(kDeltaMaxValueBytes) +
         " GROUP BY scope, key, value) GROUP BY scope, key HAVING occ_in + occ_out >= " + std::to_string(kDeltaMinOccurrences) +
         ") ARRAY JOIN top AS tv" + " SETTINGS max_execution_time = " + std::to_string(kDeltaTimeBudgetSeconds);
}

// ---- the service map ----

namespace {

// The time predicate of a service map read: the whole window, or `count` equally long slices (together `coverage` of the window),
// each centred in its share of the window. *actual is the coverage really read.
std::string service_map_time_predicate(int64_t start_ms, int64_t end_ms, double coverage, int* slices, double* actual) {
  const int64_t window_ms = end_ms - start_ms;
  *slices = 0;
  *actual = 1.0;
  if (coverage >= 1.0) return time_predicate(start_ms, end_ms);
  const double covered_ms = static_cast<double>(window_ms) * coverage;
  const int count = static_cast<int>(std::max<long long>(1, std::min<long long>(kServiceMapMaxSlices, std::llround(covered_ms / kServiceMapSliceMs))));
  const int64_t length_ms = std::max<int64_t>(1000, static_cast<int64_t>(covered_ms / count));
  if (length_ms * count >= window_ms) return time_predicate(start_ms, end_ms);
  const double stride_ms = static_cast<double>(window_ms) / count;
  std::string out = "(";
  for (int i = 0; i < count; ++i) {
    const int64_t lo = start_ms + static_cast<int64_t>(i * stride_ms + (stride_ms - static_cast<double>(length_ms)) / 2.0);
    if (i) out += " OR ";
    out += "(Timestamp >= fromUnixTimestamp64Milli(" + std::to_string(lo) + ") AND Timestamp < fromUnixTimestamp64Milli(" +
           std::to_string(lo + length_ms) + "))";
  }
  *slices = count;
  *actual = static_cast<double>(length_ms * count) / static_cast<double>(window_ms);
  return out + ")";
}

}  // namespace

ServiceMapSampling service_map_sampling(int64_t start_ms, int64_t end_ms, uint64_t estimated_spans, int forced_factor) {
  ServiceMapSampling out;
  const double wanted_coverage = estimated_spans > kServiceMapReadRows
      ? static_cast<double>(kServiceMapReadRows) / static_cast<double>(estimated_spans)
      : 1.0;
  out.time_predicate = service_map_time_predicate(start_ms, end_ms, wanted_coverage, &out.slices, &out.time_coverage);
  const double spans_read = static_cast<double>(estimated_spans) * out.time_coverage;
  out.trace_factor = forced_factor > 0
      ? static_cast<uint64_t>(forced_factor)
      : std::max<uint64_t>(1, static_cast<uint64_t>(std::ceil(spans_read / static_cast<double>(kServiceMapJoinRows))));
  return out;
}

std::string service_map_estimate_sql(const std::string& table, int64_t start_ms, int64_t end_ms) {
  return "EXPLAIN ESTIMATE SELECT 1 FROM " + table + " PREWHERE " + time_predicate(start_ms, end_ms);
}

std::string service_map_sql(const TraceScope& scope, const ServiceMapSampling& sampling) {
  const std::string sample_sql = sampling.trace_factor > 1 ? " AND cityHash64(TraceId) % " + std::to_string(sampling.trace_factor) + " = 0" : std::string{};
  // Trace selection by the search filters, on the same (sampled) spans.
  const std::string duration_terms = scope.having.empty() ? std::string{} : having_terms(scope.having);
  const std::string scan = " FROM " + scope.table + " PREWHERE " + sampling.time_predicate + sample_sql + " WHERE " + scope.visibility;
  std::string candidate;
  if (!duration_terms.empty()) {
    std::string having = scope.span_filters.empty() ? std::string{} : "countIf(1" + scope.span_filters + ") > 0";
    having += (having.empty() ? "" : " AND ") + duration_terms;
    candidate = "SELECT TraceId" + scan + " GROUP BY TraceId HAVING " + having;
  } else if (!scope.span_filters.empty()) {
    candidate = "SELECT TraceId" + scan + scope.span_filters;
  }
  const std::string side = scan + (candidate.empty() ? std::string{} : " AND TraceId IN (" + candidate + ")");
  return
      "SELECT toString(GROUPING(caller)), caller, service, toString(count()), toString(countIf(err)), "
      "toString(toUInt64(quantiles(0.5, 0.95, 0.99)(dur)[1])), toString(toUInt64(quantiles(0.5, 0.95, 0.99)(dur)[2])), "
      "toString(toUInt64(quantiles(0.5, 0.95, 0.99)(dur)[3])), toString(countIf(c.consumer OR p.producer)) "
      "FROM (SELECT if(ParentSpanId = '', 0, cityHash64(TraceId, ParentSpanId)) AS pk, toString(ServiceName) AS service, "
      "Duration AS dur, StatusCode = 'Error' AS err, SpanKind IN ('Consumer', 'SPAN_KIND_CONSUMER') AS consumer" + side + ") AS c "
      "ANY LEFT JOIN (SELECT cityHash64(TraceId, SpanId) AS k, toString(ServiceName) AS parent_service, "
      "SpanKind IN ('Producer', 'SPAN_KIND_PRODUCER') AS producer" + side + ") AS p ON c.pk = p.k "
      "GROUP BY GROUPING SETS ((if(p.parent_service != c.service, p.parent_service, '') AS caller, service), (service)) "
      "HAVING GROUPING(caller) = 1 OR caller != '' "
      "SETTINGS max_execution_time = " + std::to_string(kServiceMapTimeBudgetSeconds) +
      ", timeout_overflow_mode = 'throw', force_grouping_standard_compatibility = 1, join_use_nulls = 0";
}

// ---- the search ----

std::string index_window_predicate(int64_t start_ms, int64_t end_ms) {
  return "Start >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND "
         "Start <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")";
}

std::string index_slice_sql(const std::string& index_table, const std::string& window, int64_t lo_ns, int64_t hi_ns, size_t row_cap) {
  // toDateTime64(…, 9) accepts both DateTime and DateTime64 index schemas.
  return "SELECT toString(TraceId), toString(toUnixTimestamp64Nano(toDateTime64(max(Start), 9))) FROM " + index_table +
         " PREWHERE " + window + " AND Start >= " + ns_time(lo_ns) + " AND Start <= " + ns_time(hi_ns) +
         " GROUP BY TraceId LIMIT " + std::to_string(row_cap + 1);
}

std::string index_count_sql(const std::string& index_table, int64_t start_ms, int64_t end_ms) {
  return "SELECT toString(count()) FROM " + index_table + " PREWHERE " + index_window_predicate(start_ms, end_ms);
}

std::string broad_probe_sql(const TraceScope& scope, size_t threshold) {
  return "SELECT toString(count()) FROM (SELECT TraceId FROM " + scope.table + " PREWHERE " + scope.window() +
         " WHERE " + scope.visibility + scope.span_filters + " LIMIT 1 BY TraceId LIMIT " + std::to_string(threshold) + ")";
}

std::string batch_ids_sql(const std::string& index_table, const std::string& window, int64_t oldest_ns, int64_t newest_ns) {
  return "(SELECT TraceId FROM " + index_table + " PREWHERE " + window +
         " AND Start >= " + ns_time(oldest_ns) + " AND Start <= " + ns_time(newest_ns) + ")";
}

std::string batch_match_sql(const TraceScope& scope, const std::string& batch_ids) {
  return "WITH (SELECT tuple(min(Start) - toIntervalSecond(1), max(End) + toIntervalSecond(1)) FROM " + scope.index_table +
         " WHERE TraceId IN " + batch_ids + ") AS batch_bounds "
         "SELECT toString(TraceId) FROM " + scope.table +
         " PREWHERE " + scope.window() +
         " AND Timestamp >= tupleElement(batch_bounds, 1) AND Timestamp <= tupleElement(batch_bounds, 2)"
         " WHERE " + scope.visibility + scope.span_filters + " AND TraceId IN " + batch_ids +
         " LIMIT 1 BY TraceId";
}

std::string broad_having(const std::string& span_filters, const std::string& having) {
  return " HAVING countIf(1" + span_filters + ") > 0" + (having.empty() ? std::string{} : " AND " + having_terms(having));
}

std::string rank_sql(const RankSlice& slice) {
  const TraceScope& scope = *slice.scope;
  const std::string from = slice.whole ? std::string{} : " AND Timestamp >= " + ns_time(slice.from_ns);
  const std::string candidates = slice.narrow_filters
      ? "WITH candidate_ids AS (SELECT TraceId FROM " + scope.table + " PREWHERE " + scope.window() + from +
        " WHERE " + scope.visibility + scope.span_filters + " LIMIT 1 BY TraceId) "
      : std::string{};
  const std::string candidate_where = slice.narrow_filters ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : std::string{};
  // Same expression as the duration HAVING, so it is aggregated only once.
  const std::string span_end = scope.having.empty()
      ? std::string("'0'")
      : std::string("toString(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)))");
  return candidates +
         "SELECT toString(TraceId), toString(toUnixTimestamp64Nano(min(Timestamp))), " + span_end +
         " FROM " + scope.table +
         " PREWHERE " + scope.window() + from + " WHERE " + scope.visibility + candidate_where +
         " GROUP BY TraceId" + slice.having + " ORDER BY min(Timestamp) DESC LIMIT " + std::to_string(slice.fetch);
}

std::string rank_probe_sql(const TraceScope& scope, int64_t before_ns, const std::string& ids_list) {
  return "SELECT DISTINCT toString(TraceId) FROM " + scope.table + " PREWHERE " + scope.window() +
         " AND Timestamp < " + ns_time(before_ns) + " WHERE " + scope.visibility + " AND TraceId IN " + ids_list;
}

std::string trace_id_list_sql(const std::vector<std::string>& ids) {
  std::string out = "(";
  for (size_t i = 0; i < ids.size(); ++i) {
    if (i) out += ",";
    out += sql::quote_string(ids[i]);
  }
  out += ")";
  return out;
}

std::string summary_sql(const TraceScope& scope, const std::string& ids_list, int64_t first_span_ns, int64_t span_end_ns, size_t limit) {
  // Per-service span/error counts are aggregated server-side with sumMap, so the per-trace state and the payload are
  // O(services), not O(spans). Spans without a ServiceName are not reported as a service. minMap keeps each service's
  // earliest span start in the same O(services) state; both maps sort the same key set, so their arrays zip aligned.
  const std::string service_stats_map =
      "sumMap([toString(ServiceName)], [toUInt64(1)], [toUInt64(StatusCode = 'Error')])";
  const std::string service_first_span_map = "minMap([toString(ServiceName)], [toUnixTimestamp64Nano(Timestamp)])";
  // Parent span ids that no span of the trace carries (Jaeger's "incomplete trace" hint): distinct span and parent ids minus
  // distinct span ids, over the same window spans as the other columns.
  const std::string missing_parents_expr =
      "toString(uniqExactArray(arrayFilter(id -> notEmpty(id), [toString(SpanId), toString(ParentSpanId)])) - "
      "uniqExactIf(toString(SpanId), notEmpty(SpanId)))";
  const std::string aggregate_select =
      "SELECT toString(TraceId), toString(toUnixTimestamp64Milli(min(Timestamp))), "
      "toString(if(empty(argMinIf(SpanName, Timestamp, empty(ParentSpanId))), argMin(SpanName, Timestamp), argMinIf(SpanName, Timestamp, empty(ParentSpanId)))), "
      "toString(if(empty(argMinIf(ServiceName, Timestamp, empty(ParentSpanId))), argMin(ServiceName, Timestamp), argMinIf(ServiceName, Timestamp, empty(ParentSpanId)))), "
      "toString(" + std::string(kTraceDurationExpr) + "), toString(count()), toString(countIf(StatusCode = 'Error')), "
      "arrayStringConcat(arrayMap(stat -> concat(stat.1, char(30), toString(stat.2), char(30), toString(stat.3), char(30), "
      "toString(stat.4 - toUnixTimestamp64Nano(min(Timestamp)))), "
      "arrayFilter(stat -> notEmpty(stat.1), arrayZip(tupleElement(" + service_stats_map + ", 1), tupleElement(" +
      service_stats_map + ", 2), tupleElement(" + service_stats_map + ", 3), tupleElement(" + service_first_span_map +
      ", 2)))), char(31)), " + missing_parents_expr + " ";

  // The summary aggregates every window span of <= limit selected traces, so it only needs the time range those spans occupy
  // instead of probing every part of the window. Span-ranked traces carry exact bounds (earliest window span, and the latest
  // span end when the duration HAVING computed it); index-selected traces use their index bounds (every span Timestamp is
  // covered by the [Start, End] row of its insert batch) with the same 1 s margin as trace detail.
  std::string with;
  std::string bounds;
  if (first_span_ns > 0) {
    bounds = " AND Timestamp >= " + ns_time(first_span_ns);
    if (span_end_ns >= first_span_ns) bounds += " AND Timestamp <= " + ns_time(span_end_ns);
  } else if (scope.has_index()) {
    with = "WITH (SELECT tuple(min(Start) - toIntervalSecond(1), max(End) + toIntervalSecond(1)) FROM " + scope.index_table +
           " WHERE TraceId IN " + ids_list + ") AS trace_bounds ";
    bounds = " AND Timestamp >= tupleElement(trace_bounds, 1) AND Timestamp <= tupleElement(trace_bounds, 2)";
  }
  return with + aggregate_select +
      "FROM " + scope.table + " PREWHERE " + scope.window() + bounds +
      " WHERE " + scope.visibility + " AND TraceId IN " + ids_list +
      " GROUP BY TraceId ORDER BY min(Timestamp) DESC LIMIT " + std::to_string(limit);
}

}  // namespace trace
}  // namespace chdash
