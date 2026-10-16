#pragma once

// This header defines the span-level search (/api/traces/spans). The search returns the newest spans first. Each span must match
// all the span filters. The search is based on the row search of HyperDX (DBSearchPage, useOffsetPaginatedQuery, searchWindows).
// It pages by keyset, not by OFFSET.
//
// * Order: Timestamp DESC, SpanId DESC, TraceId DESC. (TraceId, SpanId) is not unique, because a span exported twice has two
// timestamps. The key therefore starts with Timestamp. Rows that are equal on all three columns stay on one page.
//
// * Slices: a page reads [lo, upper] time slices, newest first. The widths are 15 min, 1 h, 6 h, 24 h, and then 24 h again. A
// page reads until it holds `limit` spans.
//
// * A top-N query over a slice reads about every row of the slice. A dense range therefore answers from its first slice, and a
// sparse filter widens the search. Each slice is sized from the cost seen so far, to keep the page within kSpanPageBudgetMs. When
// the budget is spent, the page stops with a resume cursor at the slice boundary. The page is then incomplete. It does not widen
// further.
//
// * The cursor has this form: "1.<ts_ns>.<slice_ns>.<k|b>.<hex SpanId>.<hex TraceId>". The value k means the spans after the row
// key (ts, SpanId, TraceId). The value b means every span at or before ts, which is a slice boundary. The field slice_ns is the
// width that the next page starts with.

#include "ch_executor.hpp"
#include "trace_sql.hpp"

#include <clickhouse/exceptions.h>

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {
namespace trace {

constexpr int kSpanPageDefaultLimit = 100;
constexpr int kSpanPageMaxLimit = 500;
constexpr int64_t kNsPerMinute = 60LL * 1000 * kNsPerMs;
constexpr int64_t kSpanSlicesNs[] = {15 * kNsPerMinute, 60 * kNsPerMinute, 360 * kNsPerMinute, 1440 * kNsPerMinute};
constexpr int64_t kSpanMinSliceNs = kNsPerMinute;
constexpr double kSpanPageBudgetMs = 2000.0;
constexpr size_t kSpanKindsMax = 16;

struct SpanCursor {
  bool present = false;
  int64_t ts_ns = 0;
  int64_t slice_ns = 0;
  bool after_key = false;  // k: after (ts, span_id, trace_id); b: Timestamp <= ts
  std::string span_id, trace_id;
};

std::string hex_text(std::string_view raw);
bool unhex_text(std::string_view hex, std::string* out);
std::string encode_span_cursor(const SpanCursor& cursor);
bool decode_span_cursor(std::string_view text, SpanCursor* out);

// This function returns the next slice width after `width` in the sequence. The 24 h width repeats at the end of the sequence.
int64_t next_span_slice_ns(int64_t width);

// A guard error is a read bound or the time bound of a slice (ch_error.hpp: TOO_MANY_ROWS, TOO_MANY_BYTES, TIMEOUT_EXCEEDED).
bool slice_guard_error(const clickhouse::ServerException& error);

// This struct is one span of the search. It holds the attribute columns that the request asked for. Each column has a present
// flag and a value.
struct SpanSearchRow {
  std::string timestamp, start_ns, trace_id, span_id, parent_span_id, service, name, kind, duration_ns, status, status_message;
  std::vector<std::pair<bool, std::string>> attributes;
  bool same_key(const SpanSearchRow& other) const {
    return start_ns == other.start_ns && span_id == other.span_id && trace_id == other.trace_id;
  }
};

struct SpanSlice {
  int64_t lo_ns = 0, hi_ns = 0;
  size_t rows = 0;
  double ms = 0;
};

struct SpanSearchPlan {
  SpanSearchSql sql;
  size_t attribute_count = 0;
  int64_t start_ns = 0, end_ns = 0;
  int limit = kSpanPageDefaultLimit;
  // The widening budget. The request can only lower it. The tests use it to reach a resume point in a deterministic way.
  double budget_ms = kSpanPageBudgetMs;
  SpanCursor cursor;
};

struct SpanSearchOutcome {
  std::vector<SpanSearchRow> rows;
  std::vector<SpanSlice> slices;
  bool exhausted = false;   // no span left in the range
  bool incomplete = false;  // stopped by the budget or a slice guard
  std::string stop_reason;  // time_budget, slice_timeout, read_rows_limit
  SpanCursor next;
  double query_ms = 0;
};

// This function reads slices until the page holds `limit` spans. A slice that fails a guard is retried once, with a narrower
// width, when it is the first slice of the page. After answered slices, a guard stop is a resume point. Otherwise, this function
// throws what ClickHouse throws.
SpanSearchOutcome run_span_search(ChExecutor& db, const SpanSearchPlan& plan);

}  // namespace trace
}  // namespace chdash
