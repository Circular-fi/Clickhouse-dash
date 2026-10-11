#pragma once

// What the Metrics page does with the rows that ClickHouse sends back: the aggregation state of one (group, bucket) cell for every kind of
// point, the merge of cells, the quantiles of explicit and exponential histograms, the choice of the aggregations that a metric offers, and
// the ranking of the groups with the top-K and "other" fold. Everything is a plain function of rows (a row is the text of the columns of
// a ClickHouse block), so the native tests run it without a server. The formulas are the ones of docs/metrics.md ("Metrics browser API").

#include "metrics_request.hpp"
#include "metrics_sql.hpp"

#include <clickhouse/block.h>

#include <cstdint>
#include <limits>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace metrics {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

// ---- text from ClickHouse ----

double text_to_double(const std::string& text);
int64_t text_to_i64(const std::string& text);
std::vector<double> text_to_doubles(const std::string& text);
// Splits on a delimiter, keeping empty fields (an absent attribute is "").
std::vector<std::string> split_keep(std::string_view text, char delimiter);

// ---- the state of a cell ----

struct ExpState {
  bool present = false;
  int scale = 0;
  std::map<int64_t, double> positive;  // absolute bucket index -> count
  std::map<int64_t, double> negative;
  double zero = 0;
};

// One struct covers every kind: the fields a mode does not use stay at their neutral value.
struct Cell {
  double sum = 0;      // gauge: sum of values; sums: sum of deltas; histograms/summary: Sum delta
  double count = 0;    // gauge: number of points; histograms/summary: Count delta
  double min = std::numeric_limits<double>::infinity();
  double max = -std::numeric_limits<double>::infinity();
  double last_sum = 0; // sum over series of each series' last value
  double series = 0;   // number of series contributing a last value
  std::vector<double> bounds;  // explicit histogram
  std::vector<double> counts;
  ExpState exp;
};

struct Group {
  std::string key;
  std::string labels_json;  // summary per-series: toJSONString(Attributes)
  std::map<int64_t, Cell> cells;
  double score = 0;
};

void merge_cell(Cell& into, const Cell& from);

// Prometheus histogram_quantile: the bucket holding rank q * total, linear inside it; the first bucket starts at 0 when its upper bound is
// positive, and a rank in the +Inf bucket answers the largest finite bound.
double explicit_quantile(double q, const std::vector<double>& bounds, const std::vector<double>& counts);
// Exponential buckets: index k covers (base^k, base^(k+1)] with base = 2^(2^-scale); negative buckets mirror them; linear inside a bucket.
double exponential_quantile(double q, const ExpState& state);

// "p50" -> 0.5, "p99.9" -> 0.999
double quantile_of(const std::string& agg);
bool is_quantile_agg(const std::string& agg);
// Summary quantile names: 0.5 -> "p50", 0.999 -> "p99.9", 1 -> "p100".
std::string quantile_agg_name(double q);

// The value of a cell for an aggregation; NaN when it has none. `bucket_seconds` is what a rate divides by.
double cell_value(const Cell& cell, Mode mode, const std::string& agg, double bucket_seconds);

// ---- what a metric is ----

struct MetricInfo {
  std::string unit;
  std::string description;
  int64_t temporality_min = 0;
  int64_t temporality_max = 0;
  bool monotonic = false;
  int64_t points = 0;
  std::vector<std::string> quantiles;  // summary: textual quantile values ("0.5")
};

// The row of metric_info_statement.
void read_metric_info(const clickhouse::Block& block, MetricInfo* info);
// "delta", "cumulative", "mixed", or "" when the metric has no temporality.
std::string temporality_name(const MetricInfo& info);

// The aggregations that a kind of metric offers (the first is the default; a summary offers its own quantiles), and the mode that reads it.
struct AggregationPlan {
  std::vector<std::string> aggs;
  std::string default_agg;
  std::string agg;  // the one that the request chose
  Mode mode = Mode::Gauge;
  bool any_cumulative = false;
  bool all_delta = false;
  bool per_series = false;  // summary quantiles: one line for each series, no grouping
};
// False, with the message of the 400 answer, when the requested aggregation is not one of the offered ones.
bool plan_aggregation(const std::string& kind, const MetricInfo& info, const std::string& requested, AggregationPlan* plan,
                      std::string* error);
// The literal of the wanted summary quantile in the SQL.
std::string summary_quantile_literal(const MetricInfo& info, const std::string& agg);

// ---- rows to groups ----

// Adds the row of a series statement of `mode` to its group and cell.
void add_series_row(const clickhouse::Block& block, size_t row, Mode mode, std::map<std::string, Group>* groups);

// The groups ordered by score (descending, ties by key); the `top_k` first are kept, the others fold into "other" (not for a summary: it
// has no folding).
struct RankedGroups {
  std::vector<Group*> ordered;
  size_t kept = 0;
  Group other;
  size_t other_count = 0;
};
RankedGroups rank_groups(std::map<std::string, Group>* groups, Mode mode, const std::string& agg, double bucket_seconds, int top_k,
                         bool per_series);

// The bucket starts of the window (at most 5000).
std::vector<int64_t> bucket_timestamps(const BucketGrid& grid, const TimeWindow& window);
// The seconds of the bucket that start at `t` that lie in the window: a rate divides by it.
double covered_seconds(const BucketGrid& grid, const TimeWindow& window, int64_t t, double bucket_seconds);

}  // namespace metrics
}  // namespace chdash
