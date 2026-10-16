#pragma once

// Every statement of the Metrics page is a pure function of the request. It needs no connection and no clock.
// The native tests compare each text with the text that the code before the split logged for the same request (tests/native/metrics_golden.hpp).
// A value that a user wrote (a service, a metric, an attribute key or value) is a query parameter of the statement (sql_params.hpp).
// A table name comes from the configuration. It is quoted as an identifier.
//
// Every statement filters on the primary-key prefix (ServiceName, MetricName). It uses PREWHERE on the TimeUnix window.
// So a read touches the granules of one metric. For the catalog, a read touches the granules of the window.

#include "metrics_request.hpp"
#include "otel_settings.hpp"
#include "sql_params.hpp"

#include <cstdint>
#include <set>
#include <string>
#include <vector>

namespace chdash {
namespace metrics {

using Statement = SqlStatement;

// The time that one statement can run. A ClickHouse statement takes this SETTINGS clause as its own.
// The scope of the request keeps the bounds of the whole request below it.
constexpr const char* kQuerySettings = " SETTINGS max_execution_time = 30";
// The statements of the series group and rank every point of a window. Their memory is bounded. Past 1 GB, a grouping or a sort goes to disk.
constexpr const char* kSeriesSettings =
    " SETTINGS max_execution_time = 30, max_memory_usage = 2000000000, max_bytes_before_external_group_by = 1000000000, "
    "max_bytes_before_external_sort = 1000000000";
// The key of the group that holds the groups which are not among the best ones.
constexpr const char* kOtherGroupKey = "__other__";

constexpr size_t kCatalogLimit = 5000;
// The catalog groups every point of its window. Past this many rows read, the scan stops. The counts are then estimates (`estimated: true`).
constexpr uint64_t kCatalogReadRowsCap = 200'000'000;
constexpr size_t kAttributeKeyLimit = 200;
constexpr size_t kAttributeValueLimit = 100;
constexpr size_t kMaxSeriesRows = 300000;
// Per-series differences need the previous point of each series. The scan of a series starts earlier by this amount: the larger of this value and one bucket.
constexpr int64_t kLagLookbackMinMs = 15 * 60 * 1000;

// The aggregation of a series depends on its kind. Each kind of point has one aggregation state (metrics_aggregate.hpp).
enum class Mode { Gauge, Delta, Histogram, Exponential, SummaryQuantile, SummaryDelta };

// <database>.<table_prefix>_<kind>, quoted.
std::string kind_table(const MetricSettings& metrics, const std::string& kind);

std::string time_predicate(int64_t start_ms, int64_t end_ms);
// `service` and `metric` are the placeholders of the parameters that hold them (SqlParams::text).
std::string metric_predicate(const std::string& service, const std::string& metric, int64_t start_ms, int64_t end_ms);

// Same key and operator: "=" values become IN (OR). "!=" values become NOT IN. The keys and the values are parameters of the statement.
std::string filters_sql(const std::vector<AttributeFilter>& filters, SqlParams& params, const std::string& skip_key = {});

// ---- the kinds and the catalog ----

// The kind tables that exist (system.tables).
std::string existing_kinds_sql(const MetricSettings& metrics);
// The kind tables that have the scope columns which tell two instrumentation scopes apart (system.columns): their names.
std::string scope_columns_sql(const MetricSettings& metrics);
// One row for each (kind, service, metric) of the window. The result is "" when no kind table exists.
std::string catalog_sql(const MetricSettings& metrics, const std::set<std::string>& kinds, const std::string& visibility,
                        const TimeWindow& window);

// ---- attributes ----

Statement attribute_keys_statement(const std::string& table, const std::string& visibility, const AttributesRequest& request);
Statement attribute_values_statement(const std::string& table, const std::string& visibility, const AttributesRequest& request);

// ---- series ----

// The statements of one series request. The parameters are numbered in the order in which the statements use them.
// The filters come first. Then come the service and the metric, which the information statement needs. Last come the attribute keys of the grouping.
class SeriesStatements {
 public:
  // `with_scope`: the table has ScopeName and ScopeVersion. These columns tell two instrumentation scopes apart that write the same attributes.
  SeriesStatements(const SeriesRequest& request, const std::string& table, const std::string& visibility, bool with_scope);

  // Unit, description, temporality, monotonicity, point count and (summary) quantiles of the metric over the window.
  Statement info() const;
  // The statement that reads the buckets. `all_delta`: every point is a delta, so there is nothing to difference.
  // `quantile` (summary): the literal of the wanted quantile. `keep`: the groups to read, when the groups are ranked.
  // The other groups form one group, kOtherGroupKey. A summary reads only the kept series.
  Statement series(Mode mode, bool all_delta, const std::string& quantile, const std::vector<std::string>* keep = nullptr) const;
  // The `top_k` best groups, best first. Each row holds the key of a group, the number of groups, its score and the sum of the scores of every group.
  // ClickHouse ranks them by the score of rank_groups, with the formulas of the aggregation `agg`.
  // Only a request that groups by an attribute needs this ranking.
  Statement ranking(Mode mode, bool all_delta, const std::string& quantile, const std::string& agg, double bucket_seconds, size_t top_k) const;

  const std::string& series_id() const { return series_id_; }

 private:
  // The statement of the buckets without its order and its limit, and the order as separate text.
  struct Body {
    std::string cells;
    std::string order;
    SqlParams params;
  };
  Body body(Mode mode, bool all_delta, const std::string& quantile, const std::vector<std::string>* keep) const;

  const SeriesRequest& request_;
  std::string table_;
  SqlParams params_;
  std::string where_, window_prewhere_, lag_prewhere_;
  std::string series_id_;
  std::string service_param_, metric_param_;
};

// ---- exemplars ----

Statement exemplars_statement(const std::string& table, const std::string& visibility, const ExemplarsRequest& request);

}  // namespace metrics
}  // namespace chdash
