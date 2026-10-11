#include "trace_filters.hpp"

#include "sql_literal.hpp"

#include <algorithm>

namespace chdash {
namespace trace {

using sql::quote_string;

bool valid_status(std::string_view status) { return status == "Error" || status == "Ok" || status == "Unset"; }

std::string split_tag_scope(std::string_view text, std::string_view* rest) {
  for (std::string_view scope : {std::string_view("span"), std::string_view("resource")}) {
    if (text.size() > scope.size() && text.substr(0, scope.size()) == scope && text[scope.size()] == ':') {
      *rest = text.substr(scope.size() + 1);
      return std::string(scope);
    }
  }
  *rest = text;
  return "any";
}

std::string exact_values_predicate(std::string_view column, const std::vector<std::string>& values) {
  if (values.empty()) return {};
  if (values.size() == 1) return std::string(column) + " = " + quote_string(values.front());
  std::string out = std::string(column) + " IN (";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out += ", ";
    out += quote_string(values[i]);
  }
  out += ")";
  return out;
}

namespace {

// One (scope, key) of the tag filters with all its conditions.
struct TagGroup {
  std::string scope, key;
  std::vector<std::string> eq, ne;
  bool exists = false, missing = false;
};

std::vector<TagGroup> group_tag_filters(const std::vector<TagFilter>& tags) {
  std::vector<TagGroup> groups;
  for (const auto& tag : tags) {
    auto it = std::find_if(groups.begin(), groups.end(), [&](const TagGroup& g) { return g.scope == tag.scope && g.key == tag.key; });
    if (it == groups.end()) it = groups.insert(groups.end(), TagGroup{tag.scope, tag.key, {}, {}, false, false});
    if (tag.op == TagOp::Eq) it->eq.push_back(tag.value);
    else if (tag.op == TagOp::Ne) it->ne.push_back(tag.value);
    else if (tag.op == TagOp::Exists) it->exists = true;
    else it->missing = true;
  }
  for (auto& group : groups) {
    for (auto* values : {&group.eq, &group.ne}) {
      std::sort(values->begin(), values->end());
      values->erase(std::unique(values->begin(), values->end()), values->end());
    }
  }
  return groups;
}

// (mapContains(C, 'k') AND C['k'] IN (...)): mapContains first, since a missing key reads as '' and must not match an empty value.
std::string map_values_predicate(const std::string& column, const std::string& key, const std::vector<std::string>& values) {
  return "(mapContains(" + column + ", " + quote_string(key) + ") AND " +
         exact_values_predicate(column + "[" + quote_string(key) + "]", values) + ")";
}

std::string any_of(const std::vector<std::string>& terms) {
  if (terms.size() == 1) return terms.front();
  std::string out = "(";
  for (size_t i = 0; i < terms.size(); ++i) out += (i ? " OR " : "") + terms[i];
  return out + ")";
}

}  // namespace

void set_attribute_scope_error(const AttributeColumns& cols, bool disabled, const char* what, std::string* error_code,
                               std::string* error) {
  if (disabled) {
    *error_code = "trace_filter_disabled";
    *error = std::string("Attribute ") + what + " on this scope are disabled by traces.features.";
  } else if (cols.lookup_failed) {
    *error_code = "trace_schema_unavailable";
    *error = "The attribute columns of the traces table could not be read. Try again.";
  } else {
    *error_code = "trace_tag_search_unsupported";
    *error = "Selected attribute scope is not stored as Map(String, String).";
  }
}

int filter_error_status(const std::string& code) { return code == "trace_schema_unavailable" ? 503 : 400; }

bool tag_filters_sql(const std::vector<TagFilter>& tags, const AttributeColumns& cols, std::string* out, std::string* error_code,
                     std::string* error, const std::string* skip_scope, const std::string* skip_key) {
  for (const auto& group : group_tag_filters(tags)) {
    if (skip_key && group.key == *skip_key && (group.scope == "any" || group.scope == *skip_scope)) continue;
    std::vector<std::string> columns;
    const bool want_span = group.scope != "resource";
    const bool want_resource = group.scope != "span";
    if (want_span && cols.span()) columns.push_back("SpanAttributes");
    if (want_resource && cols.resource()) columns.push_back("ResourceAttributes");
    if (columns.empty() || (group.scope == "span" && !cols.span()) || (group.scope == "resource" && !cols.resource())) {
      const bool disabled = (group.scope == "span" && !cols.span_enabled) || (group.scope == "resource" && !cols.resource_enabled) ||
                            (group.scope == "any" && !cols.span_enabled && !cols.resource_enabled);
      set_attribute_scope_error(cols, disabled, "filters", error_code, error);
      return false;
    }
    auto per_column = [&](auto make) {
      std::vector<std::string> terms;
      for (const auto& column : columns) terms.push_back(make(column));
      return any_of(terms);
    };
    const std::string key = quote_string(group.key);
    if (!group.eq.empty()) *out += " AND " + per_column([&](const std::string& c) { return map_values_predicate(c, group.key, group.eq); });
    if (!group.ne.empty()) *out += " AND NOT " + per_column([&](const std::string& c) { return map_values_predicate(c, group.key, group.ne); });
    if (group.exists) *out += " AND " + per_column([&](const std::string& c) { return "mapContains(" + c + ", " + key + ")"; });
    if (group.missing) *out += " AND NOT " + per_column([&](const std::string& c) { return "mapContains(" + c + ", " + key + ")"; });
  }
  return true;
}

std::string span_filters_sql(const TraceFilterSpec& spec, const std::string& tags_sql) {
  std::vector<std::string> filters;
  if (!spec.services.empty()) filters.push_back(exact_values_predicate("ServiceName", spec.services));
  if (!spec.operations.empty()) filters.push_back(exact_values_predicate("SpanName", spec.operations));
  if (!spec.services_not.empty()) filters.push_back("NOT (" + exact_values_predicate("ServiceName", spec.services_not) + ")");
  if (!spec.operations_not.empty()) filters.push_back("NOT (" + exact_values_predicate("SpanName", spec.operations_not) + ")");
  if (!spec.status.empty()) filters.push_back("StatusCode = " + quote_string(spec.status));
  if (!spec.status_not.empty()) filters.push_back("NOT (" + exact_values_predicate("StatusCode", spec.status_not) + ")");
  std::string out;
  for (const auto& filter : filters) out += " AND " + filter;
  return out + tags_sql;
}

bool span_columns_sql(const std::vector<SpanAttributeColumn>& columns, const AttributeColumns& cols, std::string* out,
                      std::string* error_code, std::string* error) {
  for (const auto& column : columns) {
    std::vector<std::string> maps;
    if (column.scope != "resource" && cols.span()) maps.push_back("SpanAttributes");
    if (column.scope != "span" && cols.resource()) maps.push_back("ResourceAttributes");
    if (maps.empty() || (column.scope == "span" && !cols.span()) || (column.scope == "resource" && !cols.resource())) {
      const bool disabled = (column.scope == "span" && !cols.span_enabled) ||
                            (column.scope == "resource" && !cols.resource_enabled) ||
                            (column.scope == "any" && !cols.span_enabled && !cols.resource_enabled);
      set_attribute_scope_error(cols, disabled, "columns", error_code, error);
      return false;
    }
    const std::string key = quote_string(column.key);
    const std::string has0 = "mapContains(" + maps[0] + ", " + key + ")";
    if (maps.size() == 1) {
      *out += ", toString(toUInt8(" + has0 + ")), toString(" + maps[0] + "[" + key + "])";
    } else {
      const std::string has1 = "mapContains(" + maps[1] + ", " + key + ")";
      *out += ", toString(toUInt8(" + has0 + " OR " + has1 + ")), toString(if(" + has0 + ", " + maps[0] + "[" + key +
              "], " + maps[1] + "[" + key + "]))";
    }
  }
  return true;
}

}  // namespace trace
}  // namespace chdash
