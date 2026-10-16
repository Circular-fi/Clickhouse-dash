#pragma once

// This header declares the reads of one trace and of its surroundings. The reads return the spans of a trace with their
// attributes, events and links. They also return one span by its row key, the spans around a time (the context of a span), and
// the spans of other traces that link to a trace.
//
// Every read has a time window. The trace index gives the bounds of a trace. Every read also uses the service allowlist. The
// statements are in trace_sql.hpp.

#include "ch_executor.hpp"
#include "trace_sql.hpp"

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace trace {

// This comment defines what an answer may say about the parent of a span (docs/traces.md, "service_allowlist"). An answer never
// gives the SpanId of a parent that the allowlist hides. With every service allowed (`all_services`), every parent is named.
// Otherwise, an answer about one trace names a parent only when the answer also shows that span (`visible`).
//
// An answer that lists spans of many traces names no parent, because it cannot know which parents are hidden. Such answers are
// the context, the linked-from answer, the span search and one span. Every serialization of a span uses this rule.
std::string_view visible_parent(std::string_view parent, bool all_services, const std::unordered_set<std::string>* visible = nullptr);

// This struct is one span row of the linked-from answer and of the context answer.
struct SpanRow {
  std::string timestamp, start_ns, trace_id, span_id, parent_span_id, name, kind, service, duration_ns, status;
  std::string link_span_ids, link_attributes;
};
// The argument `with_links` adds the two link columns. They follow the ten columns of kSpanListColumns. This function throws what
// ClickHouse throws.
std::vector<SpanRow> read_span_rows(ChExecutor& db, const std::string& sql, bool with_links);

// This struct is one span of a trace. It holds all the fields that the page may read.
struct DetailSpan {
  std::string timestamp, trace_id, span_id, parent_span_id, name, kind, service, status, status_message;
  std::string span_attributes, resource_attributes, events_timestamp, events_name, events_attributes;
  std::string links_trace_id, links_span_id, links_attributes;
  int64_t start_ns = 0;
  uint64_t duration_ns = 0;
};
std::vector<DetailSpan> read_detail_spans(ChExecutor& db, const std::string& sql);

// This function returns the values of the first row of a statement. The result is empty when the statement has no row. The
// statement reads the span by its key.
std::vector<std::string> read_first_row(ChExecutor& db, const std::string& sql);

// This struct sets the spans to read around an anchor. The direction "around" reads the nearest spans on each side. The direction
// can also be "older" or "newer" than a cursor (Timestamp, SpanId).
struct ContextQuery {
  std::string table, visibility, filter_sql;
  int64_t anchor_ns = 0, window_ns = 0;
  std::string direction;  // around, older, newer
  int limit = 50;
  int64_t cursor_ns = 0;
  std::string cursor_span;
};
struct ContextOutcome {
  std::vector<SpanRow> older, newer;  // newest first: `older` is at and before the anchor, `newer` after it
  bool query_older = false, query_newer = false, more_older = false, more_newer = false;
  double elapsed_ms = 0;
};
// The direction "around" returns the spans nearest the anchor on each side. Every read has the bound of the window. The direction
// "service" uses the ServiceName primary-key prefix. The other directions rely on the time bound and on the attribute bloom
// filters. This function throws what ClickHouse throws.
ContextOutcome read_context(ChExecutor& db, const ContextQuery& query);

}  // namespace trace
}  // namespace chdash
