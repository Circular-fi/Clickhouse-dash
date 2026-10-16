#include "metrics_sql.hpp"

#include "sql_literal.hpp"

#include <map>
#include <utility>

namespace chdash {
namespace metrics {

using sql::quote_ident;
using sql::quote_string;

std::string kind_table(const MetricSettings& metrics, const std::string& kind) {
  return quote_ident(metrics.database) + "." + quote_ident(metrics.table_prefix + "_" + kind);
}

std::string time_predicate(int64_t start_ms, int64_t end_ms) {
  return "TimeUnix >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND TimeUnix <= fromUnixTimestamp64Milli(" +
         std::to_string(end_ms) + ")";
}

std::string metric_predicate(const std::string& service, const std::string& metric, int64_t start_ms, int64_t end_ms) {
  return "ServiceName = " + service + " AND MetricName = " + metric + " AND " + time_predicate(start_ms, end_ms);
}

std::string filters_sql(const std::vector<AttributeFilter>& filters, SqlParams& params, const std::string& skip_key) {
  std::map<std::pair<std::string, std::string>, std::vector<std::string>> grouped;
  for (const auto& f : filters) {
    if (!skip_key.empty() && f.key == skip_key) continue;
    grouped[{f.key, f.op}].push_back(f.value);
  }
  std::string out;
  for (const auto& [key_op, values] : grouped) {
    const std::string key = params.text(key_op.first);
    const std::string list = params.texts(values);
    out += " AND Attributes[" + key + "] " + (key_op.second == "=" ? "IN (" : "NOT IN (") + list + ")";
  }
  return out;
}

namespace {

// ('otel_metrics_gauge', 'otel_metrics_sum', ...)
std::string kind_table_names(const MetricSettings& metrics) {
  std::string names = "(";
  for (size_t i = 0; i < kKindCount; ++i) {
    if (i) names += ", ";
    names += quote_string(metrics.table_prefix + "_" + kKinds[i]);
  }
  return names + ")";
}

}  // namespace

std::string existing_kinds_sql(const MetricSettings& metrics) {
  return "SELECT toString(name) FROM system.tables WHERE database = " + quote_string(metrics.database) + " AND name IN " +
         kind_table_names(metrics);
}

std::string scope_columns_sql(const MetricSettings& metrics) {
  return "SELECT toString(`table`) FROM system.columns WHERE database = " + quote_string(metrics.database) + " AND `table` IN " +
         kind_table_names(metrics) + " AND name IN ('ScopeName', 'ScopeVersion') GROUP BY `table` HAVING count() = 2";
}

std::string catalog_sql(const MetricSettings& metrics, const std::set<std::string>& kinds, const std::string& visibility,
                        const TimeWindow& window) {
  std::vector<std::string> branches;
  const std::string window_sql = time_predicate(window.start_ms, window.end_ms);
  for (const char* kind : kKinds) {
    if (!kinds.count(kind)) continue;
    const std::string k = kind;
    const bool has_temporality = k == "sum" || k == "histogram" || k == "exponential_histogram";
    branches.push_back(
        "SELECT '" + k + "' AS kind, toString(ServiceName) AS service, MetricName AS metric, any(MetricUnit) AS unit, "
        "any(MetricDescription) AS description, " +
        (has_temporality ? std::string("toString(min(AggregationTemporality)) AS tmin, toString(max(AggregationTemporality)) AS tmax, ")
                         : std::string("'' AS tmin, '' AS tmax, ")) +
        (k == "sum" ? std::string("toString(min(toUInt8(IsMonotonic))) AS mono_min, toString(max(toUInt8(IsMonotonic))) AS mono_max, ")
                    : std::string("'' AS mono_min, '' AS mono_max, ")) +
        "toString(count()) AS points FROM " + kind_table(metrics, k) + " PREWHERE " + window_sql + " WHERE " + visibility +
        " GROUP BY ServiceName, MetricName");
  }
  if (branches.empty()) return {};
  std::string sql = "SELECT kind, service, metric, unit, description, tmin, tmax, mono_min, mono_max, points FROM (";
  for (size_t i = 0; i < branches.size(); ++i) {
    if (i) sql += " UNION ALL ";
    sql += branches[i];
  }
  sql += ") ORDER BY service, metric, kind LIMIT " + std::to_string(kCatalogLimit + 1) + kQuerySettings;
  return sql;
}

Statement attribute_keys_statement(const std::string& table, const std::string& visibility, const AttributesRequest& request) {
  Statement out;
  SqlParams& params = out.params;
  const std::string service = params.text(request.service);
  const std::string metric = params.text(request.metric);
  const std::string prewhere = metric_predicate(service, metric, request.window.start_ms, request.window.end_ms);
  const std::string filters = filters_sql(request.filters, params);
  out.sql = "SELECT DISTINCT toString(arrayJoin(mapKeys(Attributes))) AS k FROM " + table + " PREWHERE " + prewhere + " WHERE " +
            visibility + filters + " LIMIT " + std::to_string(kAttributeKeyLimit + 1) + kQuerySettings;
  return out;
}

Statement attribute_values_statement(const std::string& table, const std::string& visibility, const AttributesRequest& request) {
  Statement out;
  SqlParams& params = out.params;
  const std::string service = params.text(request.service);
  const std::string metric = params.text(request.metric);
  const std::string prewhere = metric_predicate(service, metric, request.window.start_ms, request.window.end_ms);
  const std::string key_param = params.text(request.key);
  const std::string filters = filters_sql(request.filters, params, request.key);
  out.sql = "SELECT v, toString(n) FROM (SELECT Attributes[" + key_param + "] AS v, count() AS n FROM " + table + " PREWHERE " +
            prewhere + " WHERE " + visibility + " AND mapContains(Attributes, " + key_param + ")" +
            filters + " GROUP BY v ORDER BY n DESC, v LIMIT " +
            std::to_string(kAttributeValueLimit + 1) + ")" + kQuerySettings;
  return out;
}

SeriesStatements::SeriesStatements(const SeriesRequest& request, const std::string& table, const std::string& visibility, bool with_scope)
    : request_(request), table_(table) {
  where_ = visibility + filters_sql(request.filters, params_);
  service_param_ = params_.text(request.service);
  metric_param_ = params_.text(request.metric);
  window_prewhere_ = metric_predicate(service_param_, metric_param_, request.window.start_ms, request.window.end_ms);
  // Per-series differences need the previous point of each series. So, the scan starts earlier. Only points inside the window contribute.
  const int64_t scan_start_ms = std::max<int64_t>(0, request.window.start_ms - std::max(request.grid.size_ms, kLagLookbackMinMs));
  lag_prewhere_ = metric_predicate(service_param_, metric_param_, scan_start_ms, request.window.end_ms);
  series_id_ = with_scope ? "cityHash64(Attributes, ResourceAttributes, ScopeName, ScopeVersion)" : "cityHash64(Attributes, ResourceAttributes)";
}

Statement SeriesStatements::info() const {
  const std::string& kind = request_.kind;
  const bool has_temporality = kind == "sum" || kind == "histogram" || kind == "exponential_histogram";
  Statement out;
  out.params = params_;
  out.sql =
      "SELECT any(MetricUnit), any(MetricDescription), " +
      std::string(has_temporality ? "toString(min(AggregationTemporality)), toString(max(AggregationTemporality)), " : "'0', '0', ") +
      std::string(kind == "sum" ? "toString(max(toUInt8(IsMonotonic))), " : "'0', ") + "toString(count()), " +
      std::string(kind == "summary"
                      ? "arrayStringConcat(arrayMap(x -> toString(x), arraySort(groupUniqArrayArray(`ValueAtQuantiles.Quantile`))), ',')"
                      : "''") +
      std::string(kind == "sum" ? ", toString(min(toUInt8(IsMonotonic)))" : ", '0'") + " FROM " + table_ + " PREWHERE " + window_prewhere_ + " WHERE " + where_ + kQuerySettings;
  return out;
}

namespace {

// The expression of the group of a point. It has the values of the attributes of the group setting, joined.
// The groups that are not kept become one group, "other". This file folds them here. The rows of ClickHouse are then the kept groups and one more.
std::string group_expression(const SeriesRequest& request, Mode mode, const std::vector<std::string>* keep, SqlParams& params) {
  if (request.group_by.empty() || mode == Mode::SummaryQuantile) return "''";
  std::string expr = "arrayStringConcat([";
  for (size_t i = 0; i < request.group_by.size(); ++i) {
    if (i) expr += ", ";
    expr += "Attributes[" + params.text(request.group_by[i]) + "]";
  }
  expr += "], char(31))";
  if (keep) expr = "if(" + expr + " IN (" + params.texts(*keep) + "), " + expr + ", " + quote_string(kOtherGroupKey) + ")";
  return expr;
}

}  // namespace

SeriesStatements::Body SeriesStatements::body(Mode mode, bool all_delta, const std::string& quantile, const std::vector<std::string>* keep) const {
  SqlParams params = params_;
  const std::string group_expr = group_expression(request_, mode, keep, params);
  const std::string& series_id = series_id_;
  const std::string& table = table_;
  const std::string& where = where_;
  const std::string& window_prewhere = window_prewhere_;
  const std::string& lag_prewhere = lag_prewhere_;
  const std::string in_window = "TimeUnix >= fromUnixTimestamp64Milli(" + std::to_string(request_.window.start_ms) + ")";
  const std::string bucket = request_.grid.sql("TimeUnix");
  const std::string lag_window = " WINDOW w AS (PARTITION BY " + series_id +
                                 " ORDER BY TimeUnix ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)";

  Body out;
  if (mode == Mode::Gauge) {
    out.cells = "SELECT g, toString(b), toString(sum(s_sum)) AS c1, toString(sum(s_cnt)) AS c2, toString(min(s_min)) AS c3, "
                "toString(max(s_max)) AS c4, toString(sum(s_last)) AS c5, toString(count()) AS c6 FROM (SELECT " + group_expr + " AS g, " +
                bucket + " AS b, " + series_id +
                " AS sid, sum(Value) AS s_sum, count() AS s_cnt, min(Value) AS s_min, max(Value) AS s_max, "
                "argMax(Value, TimeUnix) AS s_last FROM " + table + " PREWHERE " + window_prewhere + " WHERE " + where +
                " GROUP BY g, b, sid) GROUP BY g, b";
    out.order = " ORDER BY g, b";
  } else if (mode == Mode::Delta && all_delta) {
    out.cells = "SELECT " + group_expr + " AS g, toString(" + bucket + ") AS b, toString(sum(Value)) AS c1, toString(count()) AS c2 FROM " +
                table + " PREWHERE " + window_prewhere + " WHERE " + where + " GROUP BY g, b";
    out.order = " ORDER BY g, b";
  } else if (mode == Mode::Delta || mode == Mode::SummaryDelta) {
    // Delta points count as they are. A cumulative point contributes its difference to the previous point of the same series.
    // After a reset (new StartTimeUnix or a decrease), it contributes its whole value. The first point of a series has no predecessor and no difference.
    const bool summary = mode == Mode::SummaryDelta;
    const std::string temporality = summary ? "2" : "AggregationTemporality";
    const std::string v1 = summary ? "Sum" : "Value";
    const std::string v2 = summary ? "toFloat64(Count)" : "toFloat64(0)";
    const std::string reset_value = summary ? "v2 < p2" : "v1 < p1";
    out.cells = "SELECT g, toString(b), toString(sum(d1)) AS c1, toString(sum(d2)) AS c2 FROM (SELECT g, b, TimeUnix, "
                "multiIf(temporality = 1, v1, rn = 1, nan, ps != StartTimeUnix OR " + reset_value + ", v1, v1 - p1) AS d1, "
                "multiIf(temporality = 1, v2, rn = 1, nan, ps != StartTimeUnix OR " + reset_value + ", v2, v2 - p2) AS d2 "
                "FROM (SELECT " + group_expr + " AS g, " + bucket + " AS b, TimeUnix, StartTimeUnix, " + temporality +
                " AS temporality, " + v1 + " AS v1, " + v2 + " AS v2, lagInFrame(v1) OVER w AS p1, lagInFrame(v2) OVER w AS p2, "
                "lagInFrame(StartTimeUnix) OVER w AS ps, row_number() OVER w AS rn FROM " + table + " PREWHERE " + lag_prewhere +
                " WHERE " + where + lag_window + ") WHERE " + in_window + " AND NOT isNaN(d1)) GROUP BY g, b";
    out.order = " ORDER BY g, b";
  } else if (mode == Mode::Histogram) {
    const std::string counts = "arrayStringConcat(arrayMap(x -> toString(x), sumForEach(dc)), ',')";
    if (all_delta) {
      out.cells = "SELECT g, toString(b) AS bt, bstr, " + counts + ", toString(sum(dcount)) AS c1, toString(sum(dsum)) AS c2 FROM (SELECT " +
                  group_expr + " AS g, " + bucket + " AS b, arrayStringConcat(arrayMap(x -> toString(x), ExplicitBounds), ',') AS bstr, "
                  "BucketCounts AS dc, toFloat64(Count) AS dcount, Sum AS dsum FROM " + table + " PREWHERE " + window_prewhere +
                  " WHERE " + where + ") GROUP BY g, b, bstr";
    } else {
      out.cells = "SELECT g, toString(b) AS bt, bstr, " + counts + ", toString(sum(dcount)) AS c1, toString(sum(dsum)) AS c2 FROM (SELECT g, b, bstr, "
                  "if(plain, arrayMap(x -> toInt64(x), BucketCounts), arrayMap((c, i) -> toInt64(c) - toInt64(pc[i]), BucketCounts, "
                  "arrayEnumerate(BucketCounts))) AS dc, if(plain, toFloat64(Count), toFloat64(Count) - toFloat64(pcount)) AS dcount, "
                  "if(plain, Sum, Sum - psum) AS dsum FROM (SELECT g, b, bstr, TimeUnix, BucketCounts, Count, Sum, pc, pcount, psum, rn, "
                  "temporality = 1 OR ps != StartTimeUnix OR Count < pcount OR length(BucketCounts) != length(pc) OR "
                  "ExplicitBounds != pb OR arrayExists((c, i) -> toInt64(c) < toInt64(pc[i]), BucketCounts, "
                  "arrayEnumerate(BucketCounts)) AS plain FROM (SELECT " + group_expr + " AS g, " + bucket + " AS b, "
                  "arrayStringConcat(arrayMap(x -> toString(x), ExplicitBounds), ',') AS bstr, TimeUnix, StartTimeUnix, "
                  "AggregationTemporality AS temporality, BucketCounts, ExplicitBounds, Count, Sum, "
                  "lagInFrame(BucketCounts) OVER w AS pc, lagInFrame(ExplicitBounds) OVER w AS pb, lagInFrame(Count) OVER w AS pcount, "
                  "lagInFrame(Sum) OVER w AS psum, lagInFrame(StartTimeUnix) OVER w AS ps, row_number() OVER w AS rn FROM " + table +
                  " PREWHERE " + lag_prewhere + " WHERE " + where + lag_window + ") WHERE " + in_window +
                  " AND (temporality = 1 OR rn > 1))) GROUP BY g, b, bstr";
    }
    out.order = " ORDER BY g, b, bstr";
  } else if (mode == Mode::Exponential) {
    const std::string sums = "arrayStringConcat(arrayMap(x -> toString(x), sumForEach(dpos)), ','), "
                             "arrayStringConcat(arrayMap(x -> toString(x), sumForEach(dneg)), ','), "
                             "toString(sum(dzero)), toString(sum(dcount)) AS c1, toString(sum(dsum)) AS c2";
    if (all_delta) {
      out.cells = "SELECT g, toString(b) AS bt, toString(Scale), toString(PositiveOffset), toString(NegativeOffset), " + sums +
                  " FROM (SELECT " + group_expr + " AS g, " + bucket + " AS b, Scale, PositiveOffset, NegativeOffset, "
                  "PositiveBucketCounts AS dpos, NegativeBucketCounts AS dneg, toFloat64(ZeroCount) AS dzero, "
                  "toFloat64(Count) AS dcount, Sum AS dsum FROM " + table + " PREWHERE " + window_prewhere + " WHERE " + where +
                  ") GROUP BY g, b, Scale, PositiveOffset, NegativeOffset";
    } else {
      out.cells = "SELECT g, toString(b) AS bt, toString(Scale), toString(PositiveOffset), toString(NegativeOffset), " + sums +
                  " FROM (SELECT g, b, Scale, PositiveOffset, NegativeOffset, "
                  "if(plain, arrayMap(x -> toInt64(x), PositiveBucketCounts), arrayMap((c, i) -> toInt64(c) - toInt64(ppos[i]), "
                  "PositiveBucketCounts, arrayEnumerate(PositiveBucketCounts))) AS dpos, "
                  "if(plain, arrayMap(x -> toInt64(x), NegativeBucketCounts), arrayMap((c, i) -> toInt64(c) - toInt64(pneg[i]), "
                  "NegativeBucketCounts, arrayEnumerate(NegativeBucketCounts))) AS dneg, "
                  "if(plain, toFloat64(ZeroCount), toFloat64(ZeroCount) - toFloat64(pzero)) AS dzero, "
                  "if(plain, toFloat64(Count), toFloat64(Count) - toFloat64(pcount)) AS dcount, if(plain, Sum, Sum - psum) AS dsum "
                  "FROM (SELECT *, temporality = 1 OR ps != StartTimeUnix OR Count < pcount OR Scale != pscale OR "
                  "PositiveOffset != ppoff OR NegativeOffset != pnoff OR length(PositiveBucketCounts) < length(ppos) OR "
                  "length(NegativeBucketCounts) < length(pneg) OR ZeroCount < pzero AS plain FROM (SELECT " + group_expr + " AS g, " +
                  bucket + " AS b, TimeUnix, StartTimeUnix, AggregationTemporality AS temporality, Scale, PositiveOffset, "
                  "NegativeOffset, PositiveBucketCounts, NegativeBucketCounts, ZeroCount, Count, Sum, "
                  "lagInFrame(PositiveBucketCounts) OVER w AS ppos, lagInFrame(NegativeBucketCounts) OVER w AS pneg, "
                  "lagInFrame(ZeroCount) OVER w AS pzero, lagInFrame(Count) OVER w AS pcount, lagInFrame(Sum) OVER w AS psum, "
                  "lagInFrame(Scale) OVER w AS pscale, lagInFrame(PositiveOffset) OVER w AS ppoff, "
                  "lagInFrame(NegativeOffset) OVER w AS pnoff, lagInFrame(StartTimeUnix) OVER w AS ps, row_number() OVER w AS rn FROM " +
                  table + " PREWHERE " + lag_prewhere + " WHERE " + where + lag_window + ") WHERE " + in_window +
                  " AND (temporality = 1 OR rn > 1))) GROUP BY g, b, Scale, PositiveOffset, NegativeOffset";
    }
    out.order = " ORDER BY g, b";
  } else {
    // Summary quantiles: one line for each series, with the last value in each bucket. Only the series that are kept are used, when the series are ranked.
    out.cells = "SELECT toString(sid) AS g, any(attrs), toString(b), toString(argMax(qv, TimeUnix)) AS c1 FROM (SELECT " + series_id +
                " AS sid, toJSONString(Attributes) AS attrs, " + bucket + " AS b, TimeUnix, indexOf(`ValueAtQuantiles.Quantile`, " +
                quantile + ") AS qi, `ValueAtQuantiles.Value`[qi] AS qv FROM " + table + " PREWHERE " + window_prewhere +
                " WHERE " + where + ") WHERE qi > 0" +
                (keep ? " AND toString(sid) IN (" + params.texts(*keep) + ")" : std::string()) + " GROUP BY sid, b";
    out.order = " ORDER BY sid, b";
  }
  out.params = std::move(params);
  return out;
}

Statement SeriesStatements::series(Mode mode, bool all_delta, const std::string& quantile, const std::vector<std::string>* keep) const {
  Body statement = body(mode, all_delta, quantile, keep);
  Statement out;
  out.sql = statement.cells + statement.order + " LIMIT " + std::to_string(kMaxSeriesRows + 1) + kSeriesSettings;
  out.params = std::move(statement.params);
  return out;
}

namespace {

// The value of a cell for an aggregation, as SQL over the columns of the wrapper.
// The columns are: s (the sum), n (the count), mn, mx, ls (the sum of the last values), and sr (the number of the series that have one).
// The formulas are the ones of cell_value (metrics_aggregate.cpp). `seconds` is the value that a rate divides by.
std::string value_sql(Mode mode, const std::string& agg, const std::string& seconds) {
  switch (mode) {
    case Mode::Gauge:
      if (agg == "avg") return "if(n > 0, s / n, nan)";
      if (agg == "min") return "if(n > 0, mn, nan)";
      if (agg == "max") return "if(n > 0, mx, nan)";
      if (agg == "last") return "if(sr > 0, ls / sr, nan)";
      if (agg == "sum") return "if(sr > 0, ls, nan)";
      return "nan";
    case Mode::Delta:
      return agg == "rate" ? "s / " + seconds : std::string("s");
    case Mode::SummaryQuantile:
      return "if(sr > 0, ls / sr, nan)";
    case Mode::Histogram:
    case Mode::Exponential:
    case Mode::SummaryDelta:
      if (agg == "avg") return "if(n > 0, s / n, nan)";
      if (agg == "count") return "n";
      if (agg == "count_rate") return "n / " + seconds;
      return "nan";
  }
  return "nan";
}

// A text that ClickHouse wrote as a number. The result is NaN when the text is not a number. This is what text_to_double does.
std::string number_sql(const std::string& column) { return "toFloat64OrDefault(" + column + ", nan)"; }

}  // namespace

// The answer keeps the `top_k` groups with the largest score. The score is the sum, over the buckets, of the absolute value of the aggregation.
// For the quantiles of a histogram, the score is the count of the observations. The score is the one of rank_groups (metrics_aggregate.cpp).
// The statement of the buckets is wrapped. So, ClickHouse ranks the groups and sends three things: the keys of the best groups, the number of groups, and their scores.
// The scores are the score of each of the best groups, and the sum of the scores of all the groups. ClickHouse does not send every cell of every group.
Statement SeriesStatements::ranking(Mode mode, bool all_delta, const std::string& quantile, const std::string& agg, double bucket_seconds,
                                    size_t top_k) const {
  Body statement = body(mode, all_delta, quantile, nullptr);
  const std::string seconds = std::to_string(bucket_seconds);
  const bool counted = (mode == Mode::Histogram || mode == Mode::Exponential) && !(agg == "avg" || agg == "count" || agg == "count_rate");
  const std::string inner = "(" + statement.cells + ")";
  // The cells of a group, as numbers.
  std::string cells;
  switch (mode) {
    case Mode::Gauge:
      cells = "SELECT g, " + number_sql("c1") + " AS s, " + number_sql("c2") + " AS n, " + number_sql("c3") + " AS mn, " + number_sql("c4") +
              " AS mx, " + number_sql("c5") + " AS ls, " + number_sql("c6") + " AS sr FROM " + inner;
      break;
    case Mode::Delta:
      cells = "SELECT g, " + number_sql("c1") + " AS s FROM " + inner;
      break;
    case Mode::SummaryDelta:
      cells = "SELECT g, " + number_sql("c1") + " AS s, " + number_sql("c2") + " AS n FROM " + inner;
      break;
    case Mode::Histogram:
    case Mode::Exponential:
      // One row for each set of bounds in a bucket: they are one cell (the count is c1 and the sum c2).
      cells = "SELECT g, sum(" + number_sql("c2") + ") AS s, sum(" + number_sql("c1") + ") AS n FROM " + inner + " GROUP BY g, bt";
      break;
    case Mode::SummaryQuantile:
      cells = "SELECT g, if(isFinite(" + number_sql("c1") + "), " + number_sql("c1") + ", 0) AS ls, toFloat64(isFinite(" + number_sql("c1") +
              ")) AS sr FROM " + inner;
      break;
  }
  const std::string value = counted ? std::string("n") : value_sql(mode, agg, seconds);
  Statement out;
  out.sql = "SELECT g, toString(count() OVER ()), toString(score), toString(sum(score) OVER ()) FROM (SELECT g, sumKahanIf(abs(v), isFinite(v)) AS score "
            "FROM (SELECT g, " + value + " AS v FROM (" + cells + ")) GROUP BY g) ORDER BY score DESC, g LIMIT " + std::to_string(top_k) +
            kSeriesSettings;
  out.params = std::move(statement.params);
  return out;
}

Statement exemplars_statement(const std::string& table, const std::string& visibility, const ExemplarsRequest& request) {
  const std::string start = "fromUnixTimestamp64Milli(" + std::to_string(request.window.start_ms) + ")";
  const std::string end = "fromUnixTimestamp64Milli(" + std::to_string(request.window.end_ms) + ")";
  Statement out;
  SqlParams& params = out.params;
  const std::string service = params.text(request.service);
  const std::string metric = params.text(request.metric);
  const std::string prewhere = metric_predicate(service, metric, request.window.start_ms, request.window.end_ms);
  const std::string filters = filters_sql(request.filters, params);
  out.sql =
      "SELECT toString(" + request.grid.sql("e.1") + ") AS b, toString(toUnixTimestamp64Milli(e.1)), toString(e.2), e.3, e.4, attrs "
      "FROM (SELECT arrayJoin(arrayZip(`Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.TraceId`, `Exemplars.SpanId`)) AS e, "
      "toJSONString(Attributes) AS attrs FROM " + table + " PREWHERE " + prewhere + " WHERE " + visibility + filters +
      " AND notEmpty(`Exemplars.TraceId`)) WHERE notEmpty(e.3) AND e.1 >= " + start + " AND e.1 <= " + end +
      " ORDER BY e.2 DESC, e.1 LIMIT " + std::to_string(request.per_bucket) + " BY b LIMIT " + std::to_string(request.limit + 1) + kQuerySettings;
  return out;
}

}  // namespace metrics
}  // namespace chdash
