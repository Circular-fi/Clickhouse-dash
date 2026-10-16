#pragma once

// These are the reads over a window of traces that are not a list.
// They are the charts (counts and duration quantiles), the duration heatmap, the attribute deltas of a box of it, and the service map.
// Each function takes the scope of the request (trace_sql.hpp) and a ChExecutor. It sends its statements and returns the numbers.
//
// The pure parts are the bins of the heatmap and the sort of the deltas. They are functions of their own.
// A native test runs them on numbers.

#include "ch_executor.hpp"
#include "trace_filters.hpp"
#include "trace_result.hpp"
#include "trace_sql.hpp"

#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {
namespace trace {

// ---- the charts ----

struct AnalyticsOutcome {
  struct Quantile { int64_t bucket_ms = 0; uint64_t p50 = 0, p90 = 0, p95 = 0, p99 = 0; };
  AnalyticsGrid grid;
  std::vector<std::pair<int64_t, uint64_t>> trace_counts;  // (bucket, traces)
  std::vector<Quantile> quantiles;
  uint64_t query_ms = 0;
  // "trace_index": the counts come from the trace index alone. "span_aggregation": the counts and quantiles come from the spans.
  std::string analytics_path = "span_aggregation";
  std::string trace_count_source = "span_bounds";
  bool have_counts = false, have_durations = false;
};

// charts=counts asks for the trace count chart alone. charts=durations asks for the percentiles alone.
// Both charts are used by default. The value is false when the text names neither chart.
bool parse_charts(const std::string& charts, bool* want_counts, bool* want_durations);

// The duration quantiles are always computed from the spans themselves. The trace index cannot give them.
// The OTel exporter's trace_id_ts MV stores End = max(Timestamp). That is the *start* of the last span.
// It also stores one row for each insert batch. So any single row may hold partial bounds.
//
// When both charts are asked for, the trace counts come from the same query. So both charts describe exactly the same set of traces.
// A count-only request reads the trace index when nothing restricts the traces. For example, 7 days take < 1 s instead of ~15 s.
// An index that is absent or unreadable uses the span aggregation instead. This runs on a fresh connection.
Result<AnalyticsOutcome> run_analytics(ChExecutor& db, const TraceScope& scope, bool key_only_filters, const AnalyticsGrid& grid,
                                       bool want_counts, bool want_durations);

// ---- the heatmap ----

struct HeatmapBins {
  int rows = 0;
  uint64_t total = 0;
  uint64_t below_count = 0;  // the traces faster than the lowest row, counted in it
  uint64_t max_count = 0;
  std::vector<double> edges;                                 // rows + 1 edges, ns
  std::map<std::pair<int64_t, int>, uint64_t> cells;         // (bucket, row)
};

// The traces are counted in fine log2 bins (32 per octave), by time bucket. They become `rows_wanted` rows.
// The lowest row starts at the bin that holds the 1 % quantile. The top row ends at the slowest bin.
// Row edges lie on fine-bin edges, so every count is exact.
HeatmapBins bin_heatmap(const std::map<std::pair<int64_t, int>, uint64_t>& fine_cells, const std::map<int, uint64_t>& fine_totals,
                        int rows_wanted);

struct HeatmapOutcome {
  std::map<std::pair<int64_t, int>, uint64_t> fine_cells;
  std::map<int, uint64_t> fine_totals;
  bool broad = false;
  uint64_t query_ms = 0;
};
HeatmapOutcome run_heatmap(ChExecutor& db, const TraceScope& scope, bool key_only_filters, int64_t bucket_ms, int64_t origin_ms);

// ---- the deltas ----

struct DeltaValue {
  std::string value;
  uint64_t n_in = 0, n_out = 0;
  double in_pct = 0, base_pct = 0;
};
struct DeltaKey {
  std::string scope, key;
  uint64_t uniq_in = 0, uniq_out = 0, occ_in = 0, occ_out = 0;
  std::vector<DeltaValue> values;
  double score = 0;
  bool boosted = false;
};
struct DeltaHidden {
  std::string scope, key, reason;
};

// A box has two sides. The inside side holds the sampled traces in the box.
// The outside side holds the sampled traces out of the box. Each side has the number of traces that it stands for.
struct DeltaSamples {
  std::vector<std::string> ids_in, ids_out;
  uint64_t total_in = 0, total_out = 0;
  uint64_t sample_ms = 0;
};

struct DeltaRanking {
  std::vector<DeltaKey> ranked;  // at most kDeltaMaxKeys
  size_t ranked_keys = 0;        // before the cut
  std::vector<DeltaHidden> hidden;
};
constexpr size_t kDeltaMaxKeys = 20;
constexpr size_t kDeltaValuesShown = 6;

// These keys never explain a difference. They are identifiers and timestamps, since every value is nearly unique.
// They also include the OTel semantic-convention keys that win ties (HyperDX semanticBoost).
bool id_or_time_key(std::string_view key);
bool id_like_value(std::string_view value);
bool semconv_key(std::string_view key);

// This follows HyperDX's eventDeltas.ts. These keys are hidden: keys seen fewer than 5 times, identifier and timestamp keys, and high-cardinality keys.
// A high-cardinality key has more than 90 % unique values on both sides, with more than 20 occurrences.
//
// The score of a key is the largest |selection % - baseline %| of its values. It adds 2 points for OTel semantic-convention keys and for the three columns.
//
// `baseline_all` makes the baseline every trace of the sampled time range. Both samples are weighted by the traces that they stand for.
// Otherwise, the baseline is the outside sample.
DeltaRanking rank_deltas(std::vector<DeltaKey> keys, uint64_t n_in, uint64_t n_out, uint64_t total_in, uint64_t total_out,
                         bool baseline_all);

// 1. Take two stable samples. The traces in the duration range form the selection. The other traces form the baseline.
// Each side keeps its first `sample` traces by cityHash64(TraceId). The same traces are kept on every request.
DeltaSamples read_delta_samples(ChExecutor& db, const TraceScope& scope, const DeltaWindows& windows, uint64_t d0_ns, uint64_t d1_ns,
                                int sample);
// 2. Run one aggregation over the spans of the sampled traces only.
// It counts, for each (key, value), the sampled traces of each side that have a span with it. A filter on that value matches exactly those traces.
std::vector<DeltaKey> read_delta_keys(ChExecutor& db, const TraceScope& scope, const DeltaWindows& windows, const DeltaSamples& samples,
                                      const AttributeColumns& columns, uint64_t* attributes_ms);

// ---- the service map ----
// The services and the calls between them, after HyperDX's DBServiceMapPage.
// An edge A -> B counts the spans of service B. The parent span (same TraceId) of each of these spans belongs to another service A.
// This covers Client -> Server and Producer -> Consumer instrumentation. It also covers flat traces, where the direct children of the root span run in other services.
//
// Edge metrics describe the callee spans. Node metrics describe every span of the service.
//
// The filters are the search's filters. They select traces. A trace is on the map when one of its spans matches them, as in the result list.
// The map then counts every visible span of those traces inside the window.
//
// Two budgets bound the self-join. The first budget is the rows read. When the window holds more than kServiceMapReadRows spans, only evenly spaced time slices are read.
// The second budget is the join size. cityHash64(TraceId) % N keeps whole traces. Counts are scaled by N / time coverage, and the factors are reported.

constexpr size_t kServiceMapMaxNodes = 500;
constexpr size_t kServiceMapMaxEdges = 2000;

struct ServiceMapStats {
  uint64_t count = 0, errors = 0, p50 = 0, p95 = 0, p99 = 0;
};
struct ServiceMapNode {
  std::string service;
  ServiceMapStats stats;
};
// The value is "async" when most child spans of an edge are Consumer spans or have a Producer parent (messaging). Otherwise, it is "sync".
struct ServiceMapEdge {
  std::string source, target;
  ServiceMapStats stats;
  uint64_t async = 0;
  bool is_async() const { return async > 0 && async * 2 >= stats.count; }
};
struct ServiceMapOutcome {
  ServiceMapSampling sampling;
  uint64_t estimated_spans = 0;
  std::string estimate_source = "explain";  // "window": the estimate failed, the size of the window decided
  double estimate_ms = 0, query_ms = 0;
  std::vector<ServiceMapNode> nodes;  // busiest first
  std::vector<ServiceMapEdge> edges;
  bool truncated = false;  // a map beyond kServiceMapMaxNodes / kServiceMapMaxEdges is unreadable anyway
};
Result<ServiceMapOutcome> run_service_map(ChExecutor& db, const TraceScope& scope, int forced_factor);

}  // namespace trace
}  // namespace chdash
