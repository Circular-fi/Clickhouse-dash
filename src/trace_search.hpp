#pragma once

// The search of traces: which traces answer a window and its filters, newest first, and the summary of each. Two strategies
// find the traces, and a request takes the first that can answer:
//
//   trace_index           no filter, no duration bound, and a trace index: the newest traces of the index are the answer.
//   trace_index_filtered  span filters, no duration bound: the traces of the index are tested in rank order, a page at a
//                         time, until `limit` of them have a span that matches.
//   span_aggregation      the spans themselves: duration bounds (a trace-level HAVING that the index cannot answer), no trace
//                         index, or the filtered index scan reached its cap. Newest slice first (rank_traces_by_start).
//
// The code here sends its statements through a ChExecutor and builds them with trace_sql.hpp, so the native tests run the
// strategies on a fake executor (tests/native/trace_test.cpp).

#include "ch_executor.hpp"
#include "trace_sql.hpp"

#include <cstdint>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace trace {

// The filtered scan of the trace index tested the most candidates that it may: the span aggregation answers.
struct IndexScanCap : std::runtime_error {
  IndexScanCap() : std::runtime_error("filtered trace-index candidate scan cap reached") {}
};

// Walks the trace index newest-first in the order of
//   ORDER BY Start DESC LIMIT 1 BY TraceId
// over the whole search window, i.e. traces ranked by their newest in-window index row (ties at an identical Start are
// unordered, as in that query). Paging that query with OFFSET re-sorts the entire window for every page (a 7-day window reads
// ~25M index rows per page). The cursor instead walks disjoint Start slices [lo, hi] newest-first through prj_start and reads
// each slice *completely*, one row per trace (max(Start) GROUP BY TraceId), into a buffer that next() drains:
//   * slices never overlap, so equal Starts can never straddle a page seam (no skipped or duplicated trace on ties);
//   * a trace appears at most once per slice however many index rows it has (the OTel MV writes one row per insert batch), so
//     long-lived traces cannot multiply the number of queries;
//   * a trace whose newest row was in an earlier slice re-appears in later slices only through older rows and is dropped via
//     seen_.
// Slice width adapts to the observed density; a slice holding more than kSliceRowCap traces is halved and re-read, so memory
// and per-query cost stay bounded.
class TraceIndexCursor {
 public:
  struct Hit {
    std::string trace_id;
    int64_t start_ns = 0;
  };

  TraceIndexCursor(ChExecutor& db, std::string index_table, int64_t start_ms, int64_t end_ms);

  const std::string& window() const { return window_; }
  const std::string& table() const { return table_; }

  // Up to n not-yet-emitted traces in rank order; fewer only when the window has no more traces.
  std::vector<Hit> next(size_t n);

  static constexpr size_t kSliceRowCap = 20000;

 private:
  static constexpr int64_t kInitialSliceNs = 60LL * 1000 * kNsPerMs;

  // Read the next non-empty slice below hi_ns_ into buffer_ (or exhaust).
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

// Span filters (service, operation, status, tags) select traces having at least one matching visible span. Two equivalent SQL
// forms exist:
//   narrow: TraceId IN (candidate_ids)   -- cheap when few traces match
//   broad:  HAVING countIf(filters) > 0  -- one pass, no giant IN set
// With a broad filter the IN set holds most traces of the window, and building and probing it costs more than the aggregation
// itself (24 h, one service: 6.5 s vs 3.7 s). Only primary-key filters (service / operation) are probed: their candidate scan
// is cheap, and a LIMIT stops it early when the filter is broad. Status and tag filters keep the narrow form.
constexpr double kBroadFilterShare = 0.25;

// Only a performance hint: any failure (e.g. a missing index table) keeps the narrow form, which needs no index.
bool filters_are_broad(ChExecutor& db, const TraceScope& scope);

struct RankedTrace {
  std::string trace_id;
  int64_t first_span_ns = 0;  // min(Timestamp) of its visible window spans
  // max(Timestamp + Duration) when a duration HAVING already aggregates it, else 0 (unknown): an extra per-trace aggregate is
  // not free on wide windows.
  int64_t span_end_ns = 0;
};

// Exact, newest-slice-first evaluation of
//   [WITH candidate_ids AS (spans matching the filters, LIMIT 1 BY TraceId)]
//   SELECT TraceId FROM spans PREWHERE window WHERE visibility [AND TraceId IN candidate_ids]
//   GROUP BY TraceId [HAVING duration] ORDER BY min(Timestamp) DESC LIMIT limit
// Aggregating every trace of a wide window only to keep the newest `limit` is the dominant cost of span-based search. A trace
// whose first visible window span is at or after t has all of its window spans in [t, end], so a query restricted to that
// slice computes exactly the same min/duration/filter match for it. Other traces seen in the slice ("straddlers") have visible
// spans before t; they rank below every trace starting at or after t, their slice aggregates are partial, and they are dropped
// after an IN-list existence probe on [start, t). When the slice yields `limit` exact traces they are the global answer;
// otherwise the slice widens, ending with the plain whole-window query.
std::vector<RankedTrace> rank_traces_by_start(ChExecutor& db, const TraceScope& scope, bool broad_filters, size_t limit);

// ---- the search itself ----

struct ServiceStat {
  std::string service;
  uint64_t spans = 0, errors = 0;
  // The offset of the service's earliest window span from the trace's earliest window span (the UI orders services by it).
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
  std::string search_path = "span_aggregation";
  // Why the index path gave way to the span aggregation: "index_scan_cap" (too many candidates), "index_error" (a failure).
  std::string fallback_reason;
};

// The filtered index scan: pages of kCandidateBatch traces, growing to kMaxCandidateBatch when matches are rare, over at most
// kCandidateScanCap traces.
constexpr size_t kCandidateBatch = 1000;
constexpr size_t kMaxCandidateBatch = 32000;
constexpr size_t kCandidateScanCap = 64000;

// Finds the `limit` newest traces of the window and their summaries. `key_only_filters`: the span filters are on the primary key
// only (the broad form may apply). Throws what ClickHouse throws when the span aggregation fails; a failure of the index path
// is the fallback to it, except the stop of a caller that went away, which is thrown.
SearchOutcome search_traces(ChExecutor& db, const TraceScope& scope, bool key_only_filters, size_t limit);

}  // namespace trace
}  // namespace chdash
