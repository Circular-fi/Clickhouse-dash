#pragma once

// This header defines the search of traces. The search finds the traces that answer a window and its filters. It sorts the traces
// newest first, and it gives the summary of each trace. The strategies find the traces. A request takes the first strategy that
// can answer:
//   trace_index           no filter, no duration bound, and a trace index: the newest traces of the index are the answer.
//   trace_index_filtered  span filters, no duration bound: the traces of the index are tested in rank order, a page at a
//                         time, until `limit` of them have a span that matches.
//   span_aggregation      the spans themselves: duration bounds (a trace-level HAVING that the index cannot answer), no trace
//                         index, or the filtered index scan reached its cap. Newest slice first (rank_traces_by_start).
//
// The code sends its statements through a ChExecutor. It builds them with trace_sql.hpp. Therefore the native tests run the
// strategies on a fake executor (tests/native/trace_test.cpp).

#include "ch_executor.hpp"
#include "trace_sql.hpp"

#include <cstdint>
#include <functional>
#include <string>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace trace {

// The walk reads the trace index newest first, in this order:
//   ORDER BY Start DESC LIMIT 1 BY TraceId
// The query runs over the whole search window. It ranks the traces by their newest index row in the window. Ties at an identical
// Start are unordered, as in that query. A query that pages with OFFSET sorts the entire window again for each page. A 7-day
// window reads about 25M index rows for each page.
//
// The cursor reads disjoint Start slices [lo, hi] from newest to oldest, through prj_start. It reads each slice completely. It
// returns one row for each trace (max(Start) GROUP BY TraceId). The rows go into a buffer. next() takes the rows out of this
// buffer:
// * Slices never overlap. Equal Starts can never straddle a page seam, so no trace is skipped or duplicated on ties.
//
// * A trace appears at most once in each slice, however many index rows it has. The OTel MV writes one row for each insert batch.
// Long-lived traces therefore cannot multiply the number of queries.
//
// * A trace whose newest row was in an earlier slice re-appears in later slices only through older rows. The cursor drops such a
// trace through seen_.
// The slice width adapts to the observed density. A slice that holds more than kSliceRowCap traces is halved and read again.
// Memory and the cost of each query therefore stay bounded.
class TraceIndexCursor {
 public:
  struct Hit {
    std::string trace_id;
    int64_t start_ns = 0;
  };

  TraceIndexCursor(ChExecutor& db, std::string index_table, int64_t start_ms, int64_t end_ms);

  const std::string& window() const { return window_; }
  const std::string& table() const { return table_; }

  // This function returns up to n traces that are not yet emitted, in rank order. It returns fewer traces only when the window
  // has no more traces.
  std::vector<Hit> next(size_t n);

  static constexpr size_t kSliceRowCap = 20000;

 private:
  static constexpr int64_t kInitialSliceNs = 60LL * 1000 * kNsPerMs;

  // Read the next non-empty slice below hi_ns_ into buffer_. If no slice is left, the cursor is exhausted.
  void fill(size_t wanted);

  ChExecutor& db_;
  std::string table_;
  std::string window_;
  int64_t lo_ns_ = 0;
  int64_t hi_ns_ = 0;
  int64_t slice_ns_ = 1;
  bool exhausted_ = false;
  std::vector<Hit> buffer_;
  size_t buffer_pos_ = 0;
  std::unordered_set<std::string> seen_;
};

// Span filters (service, operation, status, tags) select the traces that have at least one visible span that matches. Two SQL
// forms exist, and they give the same result:
//   narrow: TraceId IN (candidate_ids)   -- cheap when few traces match
//   broad:  HAVING countIf(filters) > 0  -- one pass, no giant IN set
// With a broad filter, the IN set holds most traces of the window. The IN set costs more to build and to probe than the
// aggregation itself (24 h, one service: 6.5 s vs 3.7 s). Only primary-key filters (service / operation) are probed. Their
// candidate scan is cheap, and a LIMIT stops the scan early when the filter is broad. Status and tag filters keep the narrow
// form.
constexpr double kBroadFilterShare = 0.25;

// This is a performance hint only. Any failure keeps the narrow form, for example when the index table is missing. The narrow
// form needs no index.
bool filters_are_broad(ChExecutor& db, const TraceScope& scope);

struct RankedTrace {
  std::string trace_id;
  int64_t first_span_ns = 0;  // min(Timestamp) of its visible window spans
  // The value is max(Timestamp + Duration) when a duration HAVING already aggregates it. Otherwise the value is 0, which means
  // unknown. An extra per-trace aggregate costs time on wide windows.
  int64_t span_end_ns = 0;
};

// The evaluation is exact and runs newest slice first. Its form is:
//   [WITH candidate_ids AS (spans matching the filters, LIMIT 1 BY TraceId)]
//   SELECT TraceId FROM spans PREWHERE window WHERE visibility [AND TraceId IN candidate_ids]
//   GROUP BY TraceId [HAVING duration] ORDER BY min(Timestamp) DESC LIMIT limit
// The aggregation of every trace of a wide window only to keep the newest `limit` is the main cost of span-based search. A trace whose
// first visible window span is at or after t has all its window spans in [t, end]. A query restricted to that slice therefore
// computes the same min, duration and filter match for the trace. Other traces seen in the slice are called straddlers.
//
// Straddlers have visible spans before t. They rank below every trace that starts at or after t. Their slice aggregates are
// partial. The search drops them after an IN-list existence probe on [start, t).
//
// When the slice yields `limit` exact traces, they are the global answer. Otherwise the slice widens. The last step is the plain
// whole-window query.
//
// `bounds` narrows the ranking to the older part of the window (the completion of an index search, see search_traces). The spans
// that rank a trace are those at or before `upper_ns`, and the traces in `excluded` are not asked for. The filters still read
// every span of the window. Therefore a trace is not missed when its matching span lies after the bound. The broad form cannot do
// this, so it is not used with a bound.
struct RankBounds {
  int64_t upper_ns = 0;
  std::vector<std::string> excluded;
};
std::vector<RankedTrace> rank_traces_by_start(ChExecutor& db, const TraceScope& scope, bool broad_filters, size_t limit,
                                              const RankBounds& bounds = {});

// ---- the search itself ----

struct ServiceStat {
  std::string service;
  uint64_t spans = 0, errors = 0;
  // The offset is the time from the earliest window span of the trace to the earliest window span of the service. The UI orders
  // the services by this offset.
  uint64_t first_span_ns = 0;
};

struct TraceSummary {
  std::string trace_id, operation, service;
  int64_t start_ms = 0;
  uint64_t duration_ns = 0, spans = 0, errors = 0, missing_parents = 0;
  std::vector<ServiceStat> service_stats;
};

struct SearchOutcome {
  std::vector<TraceSummary> rows;
  uint64_t candidate_ms = 0;
  uint64_t summary_ms = 0;
  // The search path is one of these values: "trace_index", "trace_index_filtered", "trace_index_then_spans" (the index began the
  // search and the spans completed it), "span_aggregation" or "span_duration_two_phase".
  std::string search_path = "span_aggregation";
  // This value gives the order of the traces. It is one of these values: "newest_index_row", "first_span" or
  // "newest_index_row_then_first_span".
  //
  // The value "newest_index_row" is used by the index paths. A trace ranks by the Start of its newest index row in the window.
  // The index has one row for each insert batch. Therefore a trace that spans batches ranks by its last batch.
  //
  // The value "first_span" is used by the span paths. A trace ranks by the first span of its window, as one whole-window
  // aggregation does. The value "newest_index_row_then_first_span" applies to an index scan that reached its cap. The span
  // ranking completes that scan. The traces of the index come first, then the older traces that the scan did not test.
  //
  // The two orders differ only for a trace that spans insert batches. In that case, they can change which traces fill the
  // `limit`. See rank_by_of.
  std::string rank_by = "first_span";
  // The reason why the index path was replaced by the span aggregation, or by its completion. The reason is "index_scan_cap" (too
  // many candidates) or "index_error" (a failure).
  std::string fallback_reason;
  // The answer holds the traces that were found before the time of the route ran short. It does not hold all the traces that
  // match. The field `partial_reason` gives the reason.
  bool partial = false;
  std::string partial_reason;
};

// This field gives the order of the answer of a search path (SearchOutcome::rank_by).
std::string rank_by_of(const std::string& search_path);

// The filtered index scan reads pages of kCandidateBatch traces. The page size grows to kMaxCandidateBatch when matches are rare.
// The scan tests at most kCandidateScanCap traces.
constexpr size_t kCandidateBatch = 1000;
constexpr size_t kMaxCandidateBatch = 32000;
constexpr size_t kCandidateScanCap = 64000;

// This value sets what the search may spend (trace_budget.hpp). The scan of the index stops when less than `reserve_ms` remains.
// The summary of the traces that are found still needs this time.
struct SearchBudget {
  std::function<int64_t()> remaining_ms;  // empty: no budget
  int64_t reserve_ms = 5000;
  bool short_of_time() const { return remaining_ms && remaining_ms() < reserve_ms; }
};

// This function finds the `limit` newest traces of the window, with their summaries. The argument `key_only_filters` tells that
// the span filters use only the primary key. In that case the broad form may apply. The argument `candidate_cap` gives the most
// traces that the filtered index scan tests. The tests lower this value.
//
// * The index scan finds the traces that match, newest first. When it reaches its cap with `k` traces found, and `k` is less than
// the limit, it keeps those traces. The span ranking then finds the other limit minus `k` traces. These are older traces that the
// scan did not test. The search path is "trace_index_then_spans".
//
// * When no trace is kept, the span aggregation answers the whole window. The same applies to a failure of the index
// ("index_error").
//
// * When the time of the route runs short, the traces found so far are the answer. In that case, partial = true.
//
// This function throws what ClickHouse throws when the span aggregation fails. A failure of the index path makes the search use
// the span aggregation instead. The exception is the stop of a caller that disconnected. That stop is thrown.
SearchOutcome search_traces(ChExecutor& db, const TraceScope& scope, bool key_only_filters, size_t limit,
                            const SearchBudget& budget = {}, size_t candidate_cap = kCandidateScanCap);

}  // namespace trace
}  // namespace chdash
