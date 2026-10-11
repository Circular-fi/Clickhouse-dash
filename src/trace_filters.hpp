#pragma once

// The span filters of the Traces page and the SQL that they become. Pure: no request, no connection.
//
// Every filter describes one span: a trace matches when at least one of its visible spans satisfies all of them (Jaeger's
// semantics). Values arrive as request parameters (trace_request.hpp) and only ever reach SQL through sql::quote_string().
//
//   service / operation / status             column equals (repeated: any of)
//   service_not / operation_not / status_not column differs from every value
//   tag=[scope:]key=value                    attribute equals
//   tag_not=[scope:]key=value                attribute absent or different
//   tag_exists=[scope:]key / tag_missing=... attribute key present / absent
//
// scope is "span:" (SpanAttributes), "resource:" (ResourceAttributes) or none (either map). Different keys are ANDed; several
// `tag` values of one key match any of them (one attribute holds one value, so AND would never match), several `tag_not`
// values of one key exclude all of them. tag_scope + tag_key + tag_value is the older single-tag form of `tag`.

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace trace {

enum class TagOp { Eq, Ne, Exists, Missing };

struct TagFilter {
  std::string scope;  // "span", "resource" or "any"
  TagOp op = TagOp::Eq;
  std::string key;
  std::string value;
};

struct TraceFilterSpec {
  std::vector<std::string> services, operations, services_not, operations_not, status_not;
  std::string status;
  std::vector<TagFilter> tags;
  // Primary-key predicates only (ServiceName / SpanName, positive or negated): these may use the broad HAVING countIf form
  // (see filters_are_broad in trace_search.hpp).
  bool key_only() const { return status.empty() && status_not.empty() && tags.empty(); }
};

constexpr size_t kMaxTagFilters = 32;
constexpr size_t kMaxTagKeyBytes = 512;
constexpr size_t kMaxTagValueBytes = 4096;

bool valid_status(std::string_view status);

// "[span:|resource:]rest": the attribute scope prefix of a tag parameter. Returns "span", "resource" or "any".
std::string split_tag_scope(std::string_view text, std::string_view* rest);

// Which attribute maps tag filters and facets may read: stored as Map(String, String) (JSON columns are not supported) and
// enabled by traces.features (a hidden attribute scope must not become an oracle).
struct AttributeColumns {
  bool span_map = false, resource_map = false;
  bool span_enabled = true, resource_enabled = true;
  // The columns could not be read (the system table failed): the maps are unknown, not absent.
  bool lookup_failed = false;
  bool span() const { return span_map && span_enabled; }
  bool resource() const { return resource_map && resource_enabled; }
};

// `column = 'a'`, or `column IN ('a', 'b')`; empty for no value.
std::string exact_values_predicate(std::string_view column, const std::vector<std::string>& values);

// Why an attribute scope cannot be used: turned off by traces.features, not stored as Map(String, String), or not known because
// the columns of the table could not be read (a failure of the server, not an answer about the table: 503).
void set_attribute_scope_error(const AttributeColumns& cols, bool disabled, const char* what, std::string* error_code,
                               std::string* error);

// The status of a filter error: a table that cannot be read is a failure of the server (retry), the rest is the request.
int filter_error_status(const std::string& code);

// " AND ..." for the tag filters (skipping the group of `skip_scope` / `skip_key` when given: a facet's own values ignore its
// own filters). False with an error code when a filter needs an attribute map that is not usable.
bool tag_filters_sql(const std::vector<TagFilter>& tags, const AttributeColumns& cols, std::string* out, std::string* error_code,
                     std::string* error, const std::string* skip_scope = nullptr, const std::string* skip_key = nullptr);

// " AND ..." for the column filters followed by the tag SQL.
std::string span_filters_sql(const TraceFilterSpec& spec, const std::string& tags_sql);

// ", toString(has), toString(value)" for each attribute column of the span search, or false when a column needs an attribute map
// that is unusable (same rules as filters).
struct SpanAttributeColumn {
  std::string scope, key;
};
bool span_columns_sql(const std::vector<SpanAttributeColumn>& columns, const AttributeColumns& cols, std::string* out,
                      std::string* error_code, std::string* error);

}  // namespace trace
}  // namespace chdash
