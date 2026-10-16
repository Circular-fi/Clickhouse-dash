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

// This exception is thrown inside search_traces. It makes the search leave the index path when the scan reaches its cap and no
// trace is kept. It is not an error.
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
      // The slice is too dense to read in one piece. Read a narrower slice again.
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
      // The next slice aims at about the traces that are still wanted (x2 headroom). The slice grows at most 8x for each step. An
      // empty slice grows 4x.
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
  // This is a performance hint only. Any failure keeps the narrow form, for example when the index table is missing. The narrow
  // form needs no index.
  try {
    uint64_t index_rows = 0;
    db.select(index_count_sql(scope.index_table, scope.start_ms, scope.end_ms), [&](const clickhouse::Block& block) {
      if (block.GetRowCount()) index_rows = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
    });
    // The index has at least as many rows as traces, because it has one row for each insert batch. The share is therefore
    // conservative.
    const uint64_t threshold =
        std::max<uint64_t>(1000, static_cast<uint64_t>(static_cast<double>(index_rows) * kBroadFilterShare));
    uint64_t matching = 0;
    db.select(broad_probe_sql(scope, static_cast<size_t>(threshold)), [&](const clickhouse::Block& block) {
      if (block.GetRowCount()) matching = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
    });
    return matching >= threshold;
  } catch (const std::exception& e) {
    // The cheap path for broad filters is not used. The exact path gives the answer.
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
      // Straddlers took result slots, and the slice holds more traces.
      pad *= 4;
      continue;
    }
    // Widen the slice from the observed density. An empty slice goes straight to the whole window. Sparse results then cost at
    // most one extra slice.
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
      // Each service gives one item of the form "service RS spans RS errors RS first_span_ns". See summary_sql.
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

// The scan of the trace index shows what it found and where it stopped.
struct IndexSelection {
  std::vector<std::string> ids;  // the traces that match, newest first
  // The Start (ns) of the oldest trace that was tested. The traces that were not tested have their newest index row at or before
  // this Start.
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
  // The traces are tested in index rank order until `limit` traces match. The test covers at most the newest `candidate_cap`
  // traces. Then the span ranking completes the answer.
  //
  // A page starts at kCandidateBatch traces. The page size grows when matches are rare. A rare filter therefore reaches the cap
  // in a few pages, not in 64 fixed pages. The traces tested, and their order, do not change.
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

    // The page holds every trace whose newest index row lies in the Start range [newest, oldest] of the page. The page also holds
    // older rows of traces that were already tested. These older rows are discarded below. The spans of the page lie inside the
    // index bounds of the page. Therefore the matching reads only that time range. It does not probe the whole window.
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

// The other traces of an answer that the index began. These are the traces that the index did not test and that match. They are
// sorted newest first, by their first span.
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

std::string rank_by_of(const std::string& search_path) {
  if (search_path == "trace_index" || search_path == "trace_index_filtered") return "newest_index_row";
  if (search_path == "trace_index_then_spans") return "newest_index_row_then_first_span";
  return "first_span";
}

namespace {

SearchOutcome search_traces_unranked(ChExecutor& db, const TraceScope& scope, bool key_only_filters, size_t limit, const SearchBudget& budget,
                                     size_t candidate_cap);

}  // namespace

SearchOutcome search_traces(ChExecutor& db, const TraceScope& scope, bool key_only_filters, size_t limit, const SearchBudget& budget,
                            size_t candidate_cap) {
  SearchOutcome out = search_traces_unranked(db, scope, key_only_filters, limit, budget, candidate_cap);
  out.rank_by = rank_by_of(out.search_path);
  return out;
}

namespace {

SearchOutcome search_traces_unranked(ChExecutor& db, const TraceScope& scope, bool key_only_filters, size_t limit, const SearchBudget& budget,
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
        // The traces that were found are kept. The span ranking completes the answer from the older part of the window. It does
        // this unless the time of the route is short.
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
        // No trace is kept. The span aggregation answers the whole window.
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
      // This is not a failure. The cap was reached, and no trace is kept. The field fallback_reason is set.
      out.rows.clear();
      out.candidate_ms = 0;
      out.summary_ms = 0;
    } catch (const std::exception& e) {
      // The index path is replaced by the span aggregation. The caller learns the reason from `fallback_reason`. An error is also
      // written to the log. A failure of the index is therefore never a silent change of path. A caller that disconnected stops
      // here.
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
    // This is the span-based search. It runs for duration filters. The index cannot answer a trace-level HAVING. The OTel
    // exporter's trace_id_ts MV stores End = max(Timestamp), which is the start of the last span *start*. It also runs when there
    // is no trace index, or when the filtered index scan reaches its cap and no trace is kept.
    //
    // The search ranks the TraceIds with only the cheap min and max aggregates. It uses newest slice first (see
    // rank_traces_by_start). Then it computes the expensive summary (argMin*, per-service stats) for those <= limit traces only.
    // The spans, the HAVING and the ORDER BY are the same as in a single whole-window aggregation.
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

}  // namespace

}  // namespace trace
}  // namespace chdash
