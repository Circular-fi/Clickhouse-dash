#include "trace_search.hpp"

#include "ch_block_value.hpp"
#include "ch_error.hpp"
#include "log.hpp"
#include "sql_literal.hpp"

#include <algorithm>
#include <chrono>
#include <limits>
#include <unordered_map>

namespace chdash {
namespace trace {

namespace {

// Thrown inside search_traces to leave the index path when the scan reached its cap with nothing to keep. Not an error.
struct IndexScanCapReached {};

uint64_t elapsed_ms_since(std::chrono::steady_clock::time_point since) {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - since).count());
}

}  // namespace

// ---- the trace index ----

TraceIndexCursor::TraceIndexCursor(ChExecutor& db, std::string index_table, int64_t start_ms, int64_t end_ms)
    : db_(db),
      table_(std::move(index_table)),
      window_(index_window_predicate(start_ms, end_ms)),
      lo_ns_(start_ms * kNsPerMs),
      hi_ns_(end_ms * kNsPerMs),
      slice_ns_(std::max<int64_t>(1, std::min<int64_t>(kInitialSliceNs, hi_ns_ - lo_ns_ + 1))) {}

std::vector<TraceIndexCursor::Hit> TraceIndexCursor::next(size_t n) {
  std::vector<Hit> out;
  while (out.size() < n) {
    if (buffer_pos_ < buffer_.size()) {
      out.push_back(std::move(buffer_[buffer_pos_++]));
      continue;
    }
    if (exhausted_) break;
    fill(n - out.size());
  }
  return out;
}

void TraceIndexCursor::fill(size_t wanted) {
  buffer_.clear();
  buffer_pos_ = 0;
  while (buffer_.empty() && !exhausted_) {
    if (hi_ns_ < lo_ns_) {
      exhausted_ = true;
      return;
    }
    const int64_t lo = std::max(lo_ns_, hi_ns_ - slice_ns_ + 1);
    const std::string sql = index_slice_sql(table_, window_, lo, hi_ns_, kSliceRowCap);
    std::vector<Hit> rows;
    db_.select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        rows.push_back(Hit{ch_block_text_at(block, 0, row), std::stoll(ch_block_text_at(block, 1, row))});
      }
    });
    if (rows.size() > kSliceRowCap && slice_ns_ > 1) {
      // Too dense to read in one piece: re-read a narrower slice.
      slice_ns_ = std::max<int64_t>(1, slice_ns_ / 4);
      continue;
    }
    size_t fresh = 0;
    for (auto& row : rows) {
      if (!seen_.insert(row.trace_id).second) continue;
      buffer_.push_back(std::move(row));
      ++fresh;
    }
    std::sort(buffer_.begin(), buffer_.end(), [](const Hit& a, const Hit& b) {
      if (a.start_ns != b.start_ns) return a.start_ns > b.start_ns;
      return a.trace_id < b.trace_id;
    });
    if (lo <= lo_ns_) {
      exhausted_ = true;
    } else {
      hi_ns_ = lo - 1;
      // Aim the next slice at roughly the traces still wanted (x2 headroom), growing at most 8x per step; empty slices grow 4x.
      double factor = 4.0;
      if (fresh > 0) {
        factor = std::min(8.0, std::max(0.5, 2.0 * static_cast<double>(std::max<size_t>(wanted, 1)) / static_cast<double>(fresh)));
      }
      const double next = static_cast<double>(slice_ns_) * factor;
      const double remaining = static_cast<double>(hi_ns_ - lo_ns_ + 1);
      slice_ns_ = static_cast<int64_t>(std::max(1.0, std::min(next, remaining)));
    }
  }
}

// ---- the broad form of the filters ----

bool filters_are_broad(ChExecutor& db, const TraceScope& scope) {
  if (scope.span_filters.empty() || scope.index_table.empty()) return false;
  // Only a performance hint: any failure (e.g. a missing index table) keeps the narrow form, which needs no index.
  try {
    uint64_t index_rows = 0;
    db.select(index_count_sql(scope.index_table, scope.start_ms, scope.end_ms), [&](const clickhouse::Block& block) {
      if (block.GetRowCount()) index_rows = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
    });
    // Index rows >= traces (one row per insert batch), so the share is conservative.
    const uint64_t threshold =
        std::max<uint64_t>(1000, static_cast<uint64_t>(static_cast<double>(index_rows) * kBroadFilterShare));
    uint64_t matching = 0;
    db.select(broad_probe_sql(scope, static_cast<size_t>(threshold)), [&](const clickhouse::Block& block) {
      if (block.GetRowCount()) matching = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
    });
    return matching >= threshold;
  } catch (const std::exception& e) {
    // The cheap path for broad filters is not taken; the exact one answers.
    log_event(LogLevel::Warn, "traces.filters_are_broad_failed", {{"error", std::string(e.what()).substr(0, 300)}});
    return false;
  }
}

// ---- the ranking by first span ----

std::vector<RankedTrace> rank_traces_by_start(ChExecutor& db, const TraceScope& scope, bool broad_filters, size_t limit,
                                              const RankBounds& bounds) {
  const int64_t lo_ns = scope.start_ms * kNsPerMs;
  const int64_t hi_ns = bounds.upper_ns > 0 ? bounds.upper_ns : scope.end_ms * kNsPerMs;
  const int64_t range_ns = hi_ns - lo_ns;
  constexpr int64_t kMinSliceNs = 5LL * 60 * 1000 * kNsPerMs;
  const bool has_filters = !scope.span_filters.empty() && !broad_filters;
  std::string having = scope.having;
  if (!scope.span_filters.empty() && broad_filters) having = broad_having(scope.span_filters, scope.having);
  double fraction = range_ns > 16 * kMinSliceNs ? 1.0 / 16.0 : 1.0;
  size_t pad = 16;
  ChParams params;
  if (!bounds.excluded.empty()) params.emplace_back("excluded", sql::quote_array(bounds.excluded));

  while (true) {
    const bool whole = fraction >= 1.0;
    const int64_t t = whole ? lo_ns : hi_ns - static_cast<int64_t>(static_cast<double>(range_ns) * fraction);
    const size_t fetch = whole ? limit : limit + pad;
    RankSlice slice;
    slice.scope = &scope;
    slice.narrow_filters = has_filters;
    slice.whole = whole;
    slice.from_ns = t;
    slice.having = having;
    slice.fetch = fetch;
    slice.upper_ns = bounds.upper_ns;
    slice.exclude_ids = !bounds.excluded.empty();
    std::vector<RankedTrace> rows;
    db.select(rank_sql(slice), params, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        rows.push_back(RankedTrace{ch_block_text_at(block, 0, row), std::stoll(ch_block_text_at(block, 1, row)),
                                   std::stoll(ch_block_text_at(block, 2, row))});
      }
    });
    if (whole) return rows;

    std::unordered_set<std::string> straddlers;
    if (!rows.empty()) {
      std::vector<std::string> ids;
      ids.reserve(rows.size());
      for (const auto& row : rows) ids.push_back(row.trace_id);
      db.select(rank_probe_sql(scope, t), trace_ids_params(ids), [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) straddlers.insert(ch_block_text_at(block, 0, row));
      });
    }
    std::vector<RankedTrace> kept;
    for (auto& row : rows) {
      if (straddlers.count(row.trace_id) == 0) kept.push_back(std::move(row));
    }
    if (kept.size() >= limit) {
      kept.resize(limit);
      return kept;
    }
    if (rows.size() >= fetch && pad < 1024) {
      // Straddlers took result slots and the slice holds more traces.
      pad *= 4;
      continue;
    }
    // Widen from the observed density; an empty slice goes straight to the whole window so sparse results cost at most one extra slice.
    fraction = kept.empty()
        ? fraction * 8.0
        : fraction * std::max(2.0, 1.5 * static_cast<double>(limit) / static_cast<double>(kept.size()));
    if (fraction > 0.4 || rows.size() >= fetch) fraction = 1.0;
    pad = 16;
  }
}

// ---- the search ----

namespace {

void read_summary(ChExecutor& db, const std::string& sql, const std::vector<std::string>& ids, std::vector<TraceSummary>* rows) {
  db.select(sql, trace_ids_params(ids), [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      TraceSummary out;
      out.trace_id = ch_block_text_at(block, 0, row);
      out.start_ms = std::stoll(ch_block_text_at(block, 1, row));
      out.operation = ch_block_text_at(block, 2, row);
      out.service = ch_block_text_at(block, 3, row);
      out.duration_ns = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row)));
      out.spans = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)));
      out.errors = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 6, row)));
      // One "service RS spans RS errors RS first_span_ns" item per service (see summary_sql).
      for (const auto& item : split_char(ch_block_text_at(block, 7, row), '\x1f')) {
        const size_t first_sep = item.rfind('\x1e');
        if (first_sep == std::string::npos || first_sep == 0) continue;
        const size_t errors_sep = item.rfind('\x1e', first_sep - 1);
        if (errors_sep == std::string::npos || errors_sep == 0) continue;
        const size_t spans_sep = item.rfind('\x1e', errors_sep - 1);
        if (spans_sep == std::string::npos || spans_sep == 0) continue;
        ServiceStat stat;
        stat.service = item.substr(0, spans_sep);
        stat.spans = static_cast<uint64_t>(std::stoull(item.substr(spans_sep + 1, errors_sep - spans_sep - 1)));
        stat.errors = static_cast<uint64_t>(std::stoull(item.substr(errors_sep + 1, first_sep - errors_sep - 1)));
        stat.first_span_ns = static_cast<uint64_t>(std::stoull(item.substr(first_sep + 1)));
        out.service_stats.push_back(std::move(stat));
      }
      std::sort(out.service_stats.begin(), out.service_stats.end(), [](const ServiceStat& a, const ServiceStat& b) {
        if (a.spans != b.spans) return a.spans > b.spans;
        return a.service < b.service;
      });
      out.missing_parents = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 8, row)));
      rows->push_back(std::move(out));
    }
  });
}

// What the scan of the trace index found, and where it stopped.
struct IndexSelection {
  std::vector<std::string> ids;  // the traces that match, newest first
  // Start (ns) of the oldest trace that was tested: the traces that were not tested have their newest index row at or before it.
  int64_t oldest_tested_ns = 0;
  std::string stop;  // "": found `limit` or reached the start of the window; "scan_cap": tested `candidate_cap` traces; "time_budget"
};

void select_by_index(ChExecutor& db, const TraceScope& scope, bool needs_span_match, size_t limit, const SearchBudget& budget,
                     size_t candidate_cap, IndexSelection* selection) {
  TraceIndexCursor cursor(db, scope.index_table, scope.start_ms, scope.end_ms);
  std::vector<std::string>& selected_ids = selection->ids;
  if (!needs_span_match) {
    for (auto& hit : cursor.next(limit)) selected_ids.push_back(std::move(hit.trace_id));
    return;
  }
  // Traces are tested in index rank order until `limit` match, over at most the newest `candidate_cap` traces (then the span ranking
  // completes the answer). Pages start at kCandidateBatch traces and grow when matches are rare, so a rare filter reaches the cap in a
  // handful of pages instead of 64 fixed ones; the traces tested and their order are unchanged.
  size_t considered = 0;
  size_t batch_size = std::min(kCandidateBatch, candidate_cap);
  bool exhausted = false;

  while (selected_ids.size() < limit && considered < candidate_cap) {
    if (budget.short_of_time()) {
      selection->stop = "time_budget";
      return;
    }
    const auto batch = cursor.next(std::min(batch_size, candidate_cap - considered));
    if (batch.empty()) {
      exhausted = true;
      break;
    }
    considered += batch.size();
    selection->oldest_tested_ns = batch.back().start_ns;

    // The page is every trace whose newest index row lies in [newest, oldest] Start of the page (plus older rows of already
    // tested traces, discarded below). Its spans lie inside the page's index bounds, so matching reads only that time range
    // rather than probing the whole window.
    const std::string batch_ids = batch_ids_sql(scope.index_table, cursor.window(), batch.back().start_ns, batch.front().start_ns);
    std::unordered_set<std::string> matching_ids;
    db.select(batch_match_sql(scope, batch_ids), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) matching_ids.insert(ch_block_text_at(block, 0, row));
    });

    for (const auto& hit : batch) {
      if (matching_ids.find(hit.trace_id) == matching_ids.end()) continue;
      selected_ids.push_back(hit.trace_id);
      if (selected_ids.size() >= limit) break;
    }
    if (batch.size() < std::min(batch_size, candidate_cap - (considered - batch.size()))) {
      exhausted = true;
      break;
    }

    const size_t missing = limit - std::min(selected_ids.size(), limit);
    if (missing == 0) break;
    const double projected = selected_ids.empty()
        ? static_cast<double>(batch_size) * 4.0
        : 1.25 * static_cast<double>(missing) * static_cast<double>(considered) / static_cast<double>(selected_ids.size());
    batch_size = std::max(std::min(kCandidateBatch, candidate_cap), std::min(kMaxCandidateBatch, static_cast<size_t>(projected)));
  }

  if (selected_ids.size() < limit && !exhausted && considered >= candidate_cap) selection->stop = "scan_cap";
}

// The other traces of an answer that the index began: the traces that it did not test, which match, newest first by their first span.
std::vector<std::string> complete_by_spans(ChExecutor& db, const TraceScope& scope, const IndexSelection& selection, size_t limit) {
  RankBounds bounds;
  bounds.upper_ns = selection.oldest_tested_ns;
  bounds.excluded = selection.ids;
  std::vector<std::string> ids;
  for (const auto& trace : rank_traces_by_start(db, scope, /*broad_filters=*/false, limit - selection.ids.size(), bounds)) {
    ids.push_back(trace.trace_id);
  }
  return ids;
}

}  // namespace

SearchOutcome search_traces(ChExecutor& db, const TraceScope& scope, bool key_only_filters, size_t limit, const SearchBudget& budget,
                            size_t candidate_cap) {
  SearchOutcome out;
  const bool has_candidate_filters = !scope.span_filters.empty();
  const bool needs_span_match = has_candidate_filters || !scope.all_services();
  const bool has_duration_filters = !scope.having.empty();
  const bool index_fast_path_eligible = !has_duration_filters && scope.has_index();
  bool used_trace_index_fast_path = false;

  if (index_fast_path_eligible) {
    IndexSelection selection;
    try {
      const auto candidate_started = std::chrono::steady_clock::now();
      select_by_index(db, scope, needs_span_match, limit, budget, candidate_cap, &selection);
      out.search_path = needs_span_match ? "trace_index_filtered" : "trace_index";
      if (selection.stop == "time_budget") {
        out.partial = true;
        out.partial_reason = "time_budget";
      } else if (selection.stop == "scan_cap" && !selection.ids.empty()) {
        // The traces that were found are kept; the span ranking completes the answer from the older part of the window, unless the time
        // of the route is short.
        out.fallback_reason = "index_scan_cap";
        if (budget.short_of_time()) {
          out.partial = true;
          out.partial_reason = "time_budget";
        } else {
          const auto more = complete_by_spans(db, scope, selection, limit);
          selection.ids.insert(selection.ids.end(), more.begin(), more.end());
          out.search_path = "trace_index_then_spans";
        }
      } else if (selection.stop == "scan_cap") {
        // Nothing to keep: the span aggregation answers the whole window.
        out.fallback_reason = "index_scan_cap";
        out.search_path = "span_aggregation";
        throw IndexScanCapReached();
      }
      out.candidate_ms = elapsed_ms_since(candidate_started);

      if (!selection.ids.empty()) {
        const auto summary_started = std::chrono::steady_clock::now();
        read_summary(db, summary_sql(scope, 0, 0, limit), selection.ids, &out.rows);
        out.summary_ms = elapsed_ms_since(summary_started);
      }

      used_trace_index_fast_path = true;
    } catch (const IndexScanCapReached&) {
      // Not a failure: the cap was reached with nothing to keep (fallback_reason is set).
      out.rows.clear();
      out.candidate_ms = 0;
      out.summary_ms = 0;
    } catch (const std::exception& e) {
      // The index path gives way to the span aggregation. The caller is told why (`fallback_reason`), and an error is in
      // the log: a failure of the index is no longer a silent change of path. A caller that went away stops here.
      if (classify_clickhouse_error(e).kind == ChErrorKind::Canceled) throw;
      out.fallback_reason = "index_error";
      log_event(LogLevel::Warn, "traces.index_fallback", {{"table", scope.index_table}, {"error", std::string(e.what()).substr(0, 300)}});
      out.rows.clear();
      out.candidate_ms = 0;
      out.summary_ms = 0;
      out.search_path = "span_aggregation";
      out.partial = false;
      out.partial_reason.clear();
    }
  }

  if (!used_trace_index_fast_path) {
    // Span-based search: duration filters (a trace-level HAVING the index cannot answer -- the OTel exporter's trace_id_ts MV
    // stores End = max(Timestamp), the last span *start*), no trace index, or the filtered index scan reached its cap with nothing to
    // keep. Rank the TraceIds with only the cheap min/max aggregates (newest slice first, see rank_traces_by_start), then compute the
    // expensive summary (argMin*, per-service stats) for those <= limit traces only. Same spans, same HAVING, same ORDER BY as a
    // single whole-window aggregation.
    const auto candidate_started = std::chrono::steady_clock::now();
    const bool broad = key_only_filters && filters_are_broad(db, scope);
    const auto ranked = rank_traces_by_start(db, scope, broad, limit);
    out.candidate_ms = elapsed_ms_since(candidate_started);
    if (!ranked.empty()) {
      std::vector<std::string> selected_ids;
      int64_t first_span_ns = std::numeric_limits<int64_t>::max();
      int64_t span_end_ns = 0;
      bool span_end_known = true;
      for (const auto& trace : ranked) {
        selected_ids.push_back(trace.trace_id);
        first_span_ns = std::min(first_span_ns, trace.first_span_ns);
        span_end_known = span_end_known && trace.span_end_ns > 0;
        span_end_ns = std::max(span_end_ns, trace.span_end_ns);
      }
      if (!span_end_known) span_end_ns = 0;
      const auto summary_started = std::chrono::steady_clock::now();
      read_summary(db, summary_sql(scope, first_span_ns, span_end_ns, limit), selected_ids, &out.rows);
      out.summary_ms = elapsed_ms_since(summary_started);
    }
    if (has_duration_filters) out.search_path = "span_duration_two_phase";
  }
  return out;
}

}  // namespace trace
}  // namespace chdash
