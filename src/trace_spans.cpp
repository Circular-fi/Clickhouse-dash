#include "trace_spans.hpp"

#include "ch_block_value.hpp"
#include "ch_error.hpp"

#include <algorithm>
#include <chrono>
#include <iterator>

namespace chdash {
namespace trace {

namespace {

double elapsed_ms_since(std::chrono::steady_clock::time_point started) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
}

std::vector<SpanSearchRow> select_span_search_rows(ChExecutor& db, const std::string& sql, size_t attribute_count) {
  std::vector<SpanSearchRow> rows;
  db.select(sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      SpanSearchRow out;
      out.timestamp = ch_block_text_at(block, 0, row);
      out.start_ns = ch_block_text_at(block, 1, row);
      out.trace_id = ch_block_text_at(block, 2, row);
      out.span_id = ch_block_text_at(block, 3, row);
      out.parent_span_id = ch_block_text_at(block, 4, row);
      out.service = ch_block_text_at(block, 5, row);
      out.name = ch_block_text_at(block, 6, row);
      out.kind = ch_block_text_at(block, 7, row);
      out.duration_ns = ch_block_text_at(block, 8, row);
      out.status = ch_block_text_at(block, 9, row);
      out.status_message = ch_block_text_at(block, 10, row);
      for (size_t i = 0; i < attribute_count; ++i) {
        out.attributes.emplace_back(ch_block_text_at(block, 11 + 2 * i, row) == "1", ch_block_text_at(block, 12 + 2 * i, row));
      }
      rows.push_back(std::move(out));
    }
  });
  return rows;
}

}  // namespace

std::string hex_text(std::string_view raw) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  out.reserve(raw.size() * 2);
  for (unsigned char ch : raw) {
    out.push_back(digits[ch >> 4]);
    out.push_back(digits[ch & 15]);
  }
  return out;
}

bool unhex_text(std::string_view hex, std::string* out) {
  if (hex.size() % 2) return false;
  auto nibble = [](char ch) -> int {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
  };
  out->clear();
  for (size_t i = 0; i < hex.size(); i += 2) {
    const int hi = nibble(hex[i]), lo = nibble(hex[i + 1]);
    if (hi < 0 || lo < 0) return false;
    out->push_back(static_cast<char>(hi * 16 + lo));
  }
  return true;
}

std::string encode_span_cursor(const SpanCursor& c) {
  return "1." + std::to_string(c.ts_ns) + "." + std::to_string(c.slice_ns) + "." + (c.after_key ? "k" : "b") + "." +
         hex_text(c.span_id) + "." + hex_text(c.trace_id);
}

bool decode_span_cursor(std::string_view text, SpanCursor* out) {
  if (text.size() > 2048) return false;
  const auto parts = split_char(text, '.');
  if (parts.size() != 6 || parts[0] != "1" || (parts[3] != "k" && parts[3] != "b")) return false;
  try {
    size_t used = 0;
    out->ts_ns = std::stoll(parts[1], &used);
    if (used != parts[1].size()) return false;
    out->slice_ns = std::stoll(parts[2], &used);
    if (used != parts[2].size()) return false;
  } catch (...) {
    return false;
  }
  out->after_key = parts[3] == "k";
  if (!unhex_text(parts[4], &out->span_id) || !unhex_text(parts[5], &out->trace_id)) return false;
  if (out->ts_ns < 0 || out->slice_ns < 0) return false;
  out->present = true;
  return true;
}

int64_t next_span_slice_ns(int64_t width) {
  for (int64_t candidate : kSpanSlicesNs) {
    if (candidate > width) return candidate;
  }
  return kSpanSlicesNs[std::size(kSpanSlicesNs) - 1];
}

bool slice_guard_error(const clickhouse::ServerException& e) {
  const ChErrorKind kind = classify_clickhouse_error(e).kind;
  return kind == ChErrorKind::ScanLimit || kind == ChErrorKind::Timeout;
}

SpanSearchOutcome run_span_search(ChExecutor& db, const SpanSearchPlan& plan) {
  SpanSearchOutcome out;
  const int64_t start_ns = plan.start_ns;
  const int limit = plan.limit;
  const double budget_ms = plan.budget_ms;
  SpanCursor position = plan.cursor;  // the spans still to read: at or before / after this
  if (!position.present) {
    position.present = true;
    position.ts_ns = plan.end_ns;
    position.after_key = false;
  }
  int64_t width = plan.cursor.present && plan.cursor.slice_ns > 0
      ? std::max(kSpanMinSliceNs, std::min(plan.cursor.slice_ns, kSpanSlicesNs[std::size(kSpanSlicesNs) - 1]))
      : kSpanSlicesNs[0];
  int64_t covered_ns = 0;
  const auto loop_started = std::chrono::steady_clock::now();
  bool retried = false;
  const int64_t page_upper_ns = position.ts_ns;

  while (true) {
    if (position.ts_ns < start_ns) { out.exhausted = true; break; }
    const int64_t upper = position.ts_ns;
    const int64_t lo = std::max(start_ns, upper - width + 1);
    const size_t need = static_cast<size_t>(limit) - out.rows.size();
    const std::string keyset = position.after_key ? span_keyset_sql(position.ts_ns, position.span_id, position.trace_id) : std::string{};
    const std::string sql = span_slice_sql(plan.sql, lo, upper, keyset, need);
    const auto slice_started = std::chrono::steady_clock::now();
    std::vector<SpanSearchRow> got;
    try {
      got = select_span_search_rows(db, sql, plan.attribute_count);
    } catch (const clickhouse::ServerException& e) {
      if (!slice_guard_error(e)) throw;
      if (out.slices.empty() && width > kSpanMinSliceNs && !retried) {
        // The first slice of the page is too heavy. Retry once, with a narrower width.
        retried = true;
        width = std::max(kSpanMinSliceNs, width / 8);
        continue;
      }
      if (out.slices.empty()) throw;
      // After answered slices, a guard stop is a resume point.
      out.incomplete = true;
      out.stop_reason = classify_clickhouse_error(e).kind == ChErrorKind::ScanLimit ? "read_rows_limit" : "slice_timeout";
      out.next = position;
      out.next.slice_ns = std::max(kSpanMinSliceNs, width / 4);
      break;
    }
    const double ms = elapsed_ms_since(slice_started);
    out.query_ms += ms;
    covered_ns += upper - lo + 1;
    out.slices.push_back(SpanSlice{lo, upper, std::min(got.size(), need), ms});

    if (got.size() > need) {
      // The page is full inside this slice. The page ends after its last row.
      got.resize(need + 1);
      const SpanSearchRow boundary = got[need - 1];
      const bool tie = got[need].same_key(boundary);
      got.resize(need);
      if (tie) {
        // Exact copies of the boundary key straddle the seam. The page takes all of them. Therefore the strict keyset after the
        // page skips no span.
        got.erase(std::remove_if(got.begin(), got.end(), [&](const SpanSearchRow& row) { return row.same_key(boundary); }), got.end());
        auto copies = select_span_search_rows(db, span_ties_sql(plan.sql, std::stoll(boundary.start_ns), boundary.span_id, boundary.trace_id),
                                              plan.attribute_count);
        for (auto& copy : copies) got.push_back(std::move(copy));
      }
      for (auto& row : got) out.rows.push_back(std::move(row));
      out.next.present = true;
      out.next.ts_ns = std::stoll(boundary.start_ns);
      out.next.after_key = true;
      out.next.span_id = boundary.span_id;
      out.next.trace_id = boundary.trace_id;
      // The next page starts with a slice that is about 4x the time that this page covered. Dense ranges then read far fewer rows
      // for each page.
      out.next.slice_ns = std::max(kSpanMinSliceNs, std::min(width, 4 * (page_upper_ns - out.next.ts_ns + 1)));
      break;
    }
    for (auto& row : got) out.rows.push_back(std::move(row));
    if (lo <= start_ns) { out.exhausted = true; break; }
    // The slice is exhausted. Continue strictly before this slice.
    position = SpanCursor{};
    position.present = true;
    position.ts_ns = lo - 1;
    position.after_key = false;
    if (out.rows.size() >= static_cast<size_t>(limit)) {
      out.next = position;
      out.next.slice_ns = width;
      break;
    }
    // Widen the slice, within the page budget and at the cost rate seen so far.
    const double spent = elapsed_ms_since(loop_started);
    const double remaining = budget_ms - spent;
    if (remaining <= 0) {
      out.incomplete = true;
      out.stop_reason = "time_budget";
      out.next = position;
      out.next.slice_ns = width;
      break;
    }
    int64_t wider = next_span_slice_ns(width);
    const double ms_per_ns = covered_ns > 0 ? out.query_ms / static_cast<double>(covered_ns) : 0.0;
    if (ms_per_ns > 0 && ms_per_ns * static_cast<double>(wider) > remaining) {
      wider = std::max(kSpanMinSliceNs, static_cast<int64_t>(0.8 * remaining / ms_per_ns));
    }
    width = wider;
  }
  return out;
}

}  // namespace trace
}  // namespace chdash
