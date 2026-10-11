#pragma once

// The reads of one trace and of its surroundings: the spans of a trace with their attributes, events and links; one span by its row key; the
// spans around a time (the context of a span); and the spans of other traces that link to a trace. Every read is bounded by a time window
// (the trace index gives the bounds of a trace) and carries the service allowlist. The statements are in trace_sql.hpp.

#include "ch_executor.hpp"
#include "trace_sql.hpp"

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace trace {

// What an answer may say of the parent of a span (docs/traces.md, "service_allowlist"): never the SpanId of a parent that the allowlist hides.
// With every service allowed (`all_services`) every parent is named. Otherwise an answer about one trace names a parent only when it shows
// that span too (`visible`), and an answer that lists spans of many traces (context, linked-from, span search, one span) names none: it
// cannot know which are hidden. Every serialization of a span goes through this.
std::string_view visible_parent(std::string_view parent, bool all_services, const std::unordered_set<std::string>* visible = nullptr);

// One span row of the linked-from and context answers.
struct SpanRow {
  std::string timestamp, start_ns, trace_id, span_id, parent_span_id, name, kind, service, duration_ns, status;
  std::string link_span_ids, link_attributes;
};
// `with_links`: the two columns of the links follow the ten of kSpanListColumns. Throws what ClickHouse throws.
std::vector<SpanRow> read_span_rows(ChExecutor& db, const std::string& sql, bool with_links);

// One span of a trace, with everything that the page may read of it.
struct DetailSpan {
  std::string timestamp, trace_id, span_id, parent_span_id, name, kind, service, status, status_message;
  std::string span_attributes, resource_attributes, events_timestamp, events_name, events_attributes;
  std::string links_trace_id, links_span_id, links_attributes;
  int64_t start_ns = 0;
  uint64_t duration_ns = 0;
};
std::vector<DetailSpan> read_detail_spans(ChExecutor& db, const std::string& sql);

// The values of the first row of a statement (empty when there is none): the span by its key.
std::vector<std::string> read_first_row(ChExecutor& db, const std::string& sql);

// The spans around an anchor, "around" it (the nearest on each side), or "older" / "newer" than a cursor (Timestamp, SpanId).
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
// "around" returns the spans nearest the anchor on each side. Every read is bounded by the window; "service" hits the ServiceName
// primary-key prefix, the others rely on the time bound (and the attribute bloom filters). Throws what ClickHouse throws.
ContextOutcome read_context(ChExecutor& db, const ContextQuery& query);

}  // namespace trace
}  // namespace chdash
