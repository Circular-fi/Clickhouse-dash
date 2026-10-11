#include "trace_detail.hpp"

#include "ch_block_value.hpp"

#include <chrono>

namespace chdash {
namespace trace {

std::string_view visible_parent(std::string_view parent, bool all_services, const std::unordered_set<std::string>* visible) {
  if (parent.empty()) return parent;
  if (visible) return visible->count(std::string(parent)) ? parent : std::string_view{};
  return all_services ? parent : std::string_view{};
}

std::vector<SpanRow> read_span_rows(ChExecutor& db, const std::string& sql, bool with_links) {
  std::vector<SpanRow> rows;
  db.select(sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      SpanRow out;
      out.timestamp = ch_block_text_at(block, 0, row);
      out.start_ns = ch_block_text_at(block, 1, row);
      out.trace_id = ch_block_text_at(block, 2, row);
      out.span_id = ch_block_text_at(block, 3, row);
      out.parent_span_id = ch_block_text_at(block, 4, row);
      out.name = ch_block_text_at(block, 5, row);
      out.kind = ch_block_text_at(block, 6, row);
      out.service = ch_block_text_at(block, 7, row);
      out.duration_ns = ch_block_text_at(block, 8, row);
      out.status = ch_block_text_at(block, 9, row);
      if (with_links) {
        out.link_span_ids = ch_block_text_at(block, 10, row);
        out.link_attributes = ch_block_text_at(block, 11, row);
      }
      rows.push_back(std::move(out));
    }
  });
  return rows;
}

std::vector<DetailSpan> read_detail_spans(ChExecutor& db, const std::string& sql) {
  std::vector<DetailSpan> spans;
  db.select(sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      DetailSpan out;
      out.timestamp = ch_block_text_at(block, 0, row);
      out.start_ns = std::stoll(ch_block_text_at(block, 1, row));
      out.trace_id = ch_block_text_at(block, 2, row);
      out.span_id = ch_block_text_at(block, 3, row);
      out.parent_span_id = ch_block_text_at(block, 4, row);
      out.name = ch_block_text_at(block, 5, row);
      out.kind = ch_block_text_at(block, 6, row);
      out.service = ch_block_text_at(block, 7, row);
      out.duration_ns = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 8, row)));
      out.status = ch_block_text_at(block, 9, row);
      out.status_message = ch_block_text_at(block, 10, row);
      out.span_attributes = ch_block_text_at(block, 11, row);
      out.resource_attributes = ch_block_text_at(block, 12, row);
      out.events_timestamp = ch_block_text_at(block, 13, row);
      out.events_name = ch_block_text_at(block, 14, row);
      out.events_attributes = ch_block_text_at(block, 15, row);
      out.links_trace_id = ch_block_text_at(block, 16, row);
      out.links_span_id = ch_block_text_at(block, 17, row);
      out.links_attributes = ch_block_text_at(block, 18, row);
      spans.push_back(std::move(out));
    }
  });
  return spans;
}

std::vector<std::string> read_first_row(ChExecutor& db, const std::string& sql) {
  std::vector<std::string> values;
  db.select(sql, [&](const clickhouse::Block& block) {
    if (!values.empty() || block.GetRowCount() == 0) return;
    for (size_t column = 0; column < block.GetColumnCount(); ++column) values.push_back(ch_block_text_at(block, column, 0));
  });
  return values;
}

ContextOutcome read_context(ChExecutor& db, const ContextQuery& query) {
  ContextOutcome out;
  const int64_t lo_ns = query.anchor_ns - query.window_ns;
  const int64_t hi_ns = query.anchor_ns + query.window_ns;
  const std::string base = context_base_sql(query.table, lo_ns, hi_ns, query.visibility, query.filter_sql);
  const int limit = query.limit;
  const auto started = std::chrono::steady_clock::now();
  if (query.direction == "around") {
    const int newer_limit = limit / 2;
    const int older_limit = limit - newer_limit;
    out.query_older = true;
    out.older = read_span_rows(db, context_page_sql(base, context_keyset_around(query.anchor_ns, false), older_limit, false), false);
    out.more_older = out.older.size() > static_cast<size_t>(older_limit);
    if (out.more_older) out.older.resize(older_limit);
    out.query_newer = true;
    if (newer_limit > 0) {
      out.newer = read_span_rows(db, context_page_sql(base, context_keyset_around(query.anchor_ns, true), newer_limit, true), false);
      out.more_newer = out.newer.size() > static_cast<size_t>(newer_limit);
      if (out.more_newer) out.newer.resize(newer_limit);
    } else {
      const auto probe = read_span_rows(db, context_page_sql(base, context_keyset_around(query.anchor_ns, true), 0, true), false);
      out.more_newer = !probe.empty();
    }
  } else if (query.direction == "older") {
    out.query_older = true;
    out.older = read_span_rows(db, context_page_sql(base, context_keyset_after(query.cursor_ns, query.cursor_span, false), limit, false), false);
    out.more_older = out.older.size() > static_cast<size_t>(limit);
    if (out.more_older) out.older.resize(limit);
  } else {
    out.query_newer = true;
    out.newer = read_span_rows(db, context_page_sql(base, context_keyset_after(query.cursor_ns, query.cursor_span, true), limit, true), false);
    out.more_newer = out.newer.size() > static_cast<size_t>(limit);
    if (out.more_newer) out.newer.resize(limit);
  }
  out.elapsed_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
  return out;
}

}  // namespace trace
}  // namespace chdash
