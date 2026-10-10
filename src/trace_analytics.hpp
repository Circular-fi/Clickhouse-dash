#pragma once

// The reads over a window of traces that are not a list: the charts (counts and duration quantiles), the duration heatmap and
// the attribute deltas of a box of it, and the service map. Each function takes the scope of the request (trace_sql.hpp) and a
// ChExecutor, sends its statements, and returns the numbers; the pure parts (the bins of the heatmap, the ranking of the deltas)
// are functions of their own, so a native test runs them on numbers.

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
  // "trace_index": the counts come from the trace index alone; "span_aggregation": counts and quantiles from the spans.
  std::string analytics_path = "span_aggregation";
  std::string trace_count_source = "span_bounds";
  bool have_counts = false, have_durations = false;
};

// charts=counts asks for the trace count chart alone, charts=durations for the percentiles alone; both by default. False when
// the text names neither.
bool parse_charts(const std::string& charts, bool* want_counts, bool* want_durations);

// Duration quantiles are always computed from the spans themselves. The trace index cannot provide them: the OTel exporter's
// trace_id_ts MV stores End = max(Timestamp), i.e. the *start* of the last span, and one row per insert batch (so any single row
// may hold partial bounds). When both charts are asked for, trace counts come from the same query, so both describe exactly the
// same set of traces. A count-only request reads the trace index when nothing restricts the traces (7 days take < 1 s instead of
// ~15 s). A missing or unreadable index falls back to the span aggregation, on a fresh connection.
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

// The traces counted in fine log2 bins (32 per octave) by time bucket become `rows_wanted` rows: the lowest row starts at the bin
// holding the 1 % quantile, the top row ends at the slowest bin. Row edges lie on fine-bin edges, so every count is exact.
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

// The two sides of a box: the sampled traces in it, and the sampled traces out of it with the number of traces that each side
// stands for.
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

// The keys that never explain a difference: identifiers and timestamps (every value is nearly unique), and the OTel
// semantic-convention keys that win ties (HyperDX semanticBoost).
bool id_or_time_key(std::string_view key);
bool id_like_value(std::string_view value);
bool semconv_key(std::string_view key);

// HyperDX's eventDeltas.ts: keys seen fewer than 5 times, identifier / timestamp keys and high-cardinality keys (> 90 % unique
// values on both sides, > 20 occurrences) are hidden; a key's score is the largest |selection % - baseline %| of its values, + 2
// points for OTel semantic-convention keys and the three columns. `baseline_all`: the baseline is every trace of the sampled
// time range (both samples weighted by the traces they stand for), else the outside sample.
DeltaRanking rank_deltas(std::vector<DeltaKey> keys, uint64_t n_in, uint64_t n_out, uint64_t total_in, uint64_t total_out,
                         bool baseline_all);

// 1. Two stable samples: the traces in the duration range form the selection, the others the baseline; each side keeps its
//    first `sample` traces by cityHash64(TraceId) (the same traces on every request).
DeltaSamples read_delta_samples(ChExecutor& db, const TraceScope& scope, const DeltaWindows& windows, uint64_t d0_ns, uint64_t d1_ns,
                                int sample);
// 2. One aggregation over the spans of the sampled traces only, counting per (key, value) the sampled traces of each side having
//    a span with it (a filter on that value matches exactly those traces).
std::vector<DeltaKey> read_delta_keys(ChExecutor& db, const TraceScope& scope, const DeltaWindows& windows, const DeltaSamples& samples,
                                      const AttributeColumns& columns, uint64_t* attributes_ms);

// ---- the service map ----
// The services and the calls between them, after HyperDX's DBServiceMapPage. An edge A -> B counts the spans of service B whose
// parent span (same TraceId) belongs to another service A. That covers Client -> Server / Producer -> Consumer instrumentation as
// well as flat traces whose root span's direct children run in other services. Edge metrics describe the callee spans; node
// metrics every span of the service. The filters are the search's and select traces (a trace is on the map when one of its spans
// matches them, as in the result list); the map then counts every visible span of those traces inside the window.
//
// Two budgets bound the self-join: the rows read (when the window holds more than kServiceMapReadRows spans, only evenly spaced
// time slices are read) and the join size (cityHash64(TraceId) % N keeps whole traces). Counts are scaled by N / time coverage,
// and the factors are reported.

constexpr size_t kServiceMapMaxNodes = 500;
constexpr size_t kServiceMapMaxEdges = 2000;

struct ServiceMapStats {
  uint64_t count = 0, errors = 0, p50 = 0, p95 = 0, p99 = 0;
};
struct ServiceMapNode {
  std::string service;
  ServiceMapStats stats;
};
// "async" when most of the child spans of an edge are Consumer spans or have a Producer parent (messaging), else "sync".
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
