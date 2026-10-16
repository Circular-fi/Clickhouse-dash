#pragma once

// This header defines the span filters of the Traces page and the SQL that they become. The functions are pure. They use no
// request and no connection.
//
// Each filter describes one span. A trace matches when at least one of its visible spans satisfies all the filters (Jaeger's
// semantics). The values arrive as request parameters (trace_request.hpp). A value reaches the SQL only through
// sql::quote_string().
//
//   service / operation / status             column equals (repeated: any of)
//   service_not / operation_not / status_not column differs from every value
//   tag=[scope:]key=value                    attribute equals
//   tag_not=[scope:]key=value                attribute absent or different
//   tag_exists=[scope:]key / tag_missing=... attribute key present / absent
//
// The scope is "span:" (SpanAttributes), "resource:" (ResourceAttributes) or none (either map). Different keys are ANDed. Several
// `tag` values of one key match any of them, because one attribute holds one value and AND can never match. Several `tag_not`
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
  // Only primary-key predicates (ServiceName / SpanName, positive or negated) may use the broad HAVING countIf form. See
  // filters_are_broad in trace_search.hpp.
  bool key_only() const { return status.empty() && status_not.empty() && tags.empty(); }
};

constexpr size_t kMaxTagFilters = 32;
constexpr size_t kMaxTagKeyBytes = 512;
constexpr size_t kMaxTagValueBytes = 4096;

bool valid_status(std::string_view status);

// This function reads the attribute scope prefix of a tag parameter, "[span:|resource:]rest". It returns "span", "resource" or
// "any".
std::string split_tag_scope(std::string_view text, std::string_view* rest);

// This struct tells which attribute maps the tag filters and the facets may read. A map is usable when it is stored as
// Map(String, String). JSON columns are not supported. The map must also be enabled by traces.features, because a hidden
// attribute scope must not become an oracle.
struct AttributeColumns {
  bool span_map = false, resource_map = false;
  bool span_enabled = true, resource_enabled = true;
  // The columns cannot be read because the system table failed. The maps are unknown, not absent.
  bool lookup_failed = false;
  bool span() const { return span_map && span_enabled; }
  bool resource() const { return resource_map && resource_enabled; }
};

// This function builds `column = 'a'` or `column IN ('a', 'b')`. It returns an empty string for no value.
std::string exact_values_predicate(std::string_view column, const std::vector<std::string>& values);

// This function sets the error code and the error message for an attribute scope that cannot be used. The reasons are:
// traces.features turns the scope off, the scope is not stored as Map(String, String), or the columns are not known. The columns
// are not known when the columns of the table cannot be read. That case is a failure of the server, not an answer about the
// table, and it gives 503.
void set_attribute_scope_error(const AttributeColumns& cols, bool disabled, const char* what, std::string* error_code,
                               std::string* error);

// This function returns the HTTP status of a filter error. A table that cannot be read is a failure of the server, so the client
// can retry. Every other error is a fault in the request.
int filter_error_status(const std::string& code);

// This function builds the SQL " AND ..." for the tag filters. When `skip_scope` and `skip_key` are given, it skips the group of
// that key. A facet uses this skip, so that its own values ignore its own filters. The function returns false with an error code
// when a filter needs an attribute map that is not usable.
bool tag_filters_sql(const std::vector<TagFilter>& tags, const AttributeColumns& cols, std::string* out, std::string* error_code,
                     std::string* error, const std::string* skip_scope = nullptr, const std::string* skip_key = nullptr);

// This function builds the SQL " AND ..." for the column filters. The tag SQL follows the column SQL.
std::string span_filters_sql(const TraceFilterSpec& spec, const std::string& tags_sql);

// This function builds the SQL ", toString(has), toString(value)" for each attribute column of the span search. It returns false
// when a column needs an attribute map that is not usable. The same rules apply as for the filters.
struct SpanAttributeColumn {
  std::string scope, key;
};
bool span_columns_sql(const std::vector<SpanAttributeColumn>& columns, const AttributeColumns& cols, std::string* out,
                      std::string* error_code, std::string* error);

}  // namespace trace
}  // namespace chdash
