#include "logs_filters.hpp"

#include "api_params.hpp"
#include "logs_text.hpp"
#include "otel_allowlist.hpp"
#include "service_result.hpp"
#include "sql_literal.hpp"

#include <algorithm>
#include <cctype>
#include <iterator>

namespace chdash {
namespace logs {

namespace {

using sql::quote_ident;

const char* const kTopLevelColumns[] = {"ServiceName", "SeverityText", "TraceId", "SpanId", "ScopeName", "ScopeVersion"};

bool attribute_column(const std::string& type) { return type.rfind("Map(", 0) == 0 || type.rfind("JSON", 0) == 0; }

ApiError invalid_filter(std::string message) { return make_error(400, "invalid_logs_filter", std::move(message)); }

}  // namespace

const Severity kSeverityClasses[4] = {{"error", 17, 255}, {"warn", 13, 16}, {"info", 9, 12}, {"debug", 0, 8}};

const Severity* severity_class(std::string_view name) {
  if (name == "fatal") name = "error";
  if (name == "warning") name = "warn";
  if (name == "trace") name = "debug";
  for (const auto& s : kSeverityClasses) {
    if (name == s.name) return &s;
  }
  return nullptr;
}

bool valid_hex_id(const std::string& id, size_t max_len) {
  if (id.empty() || id.size() > max_len) return false;
  return std::all_of(id.begin(), id.end(), [](char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; });
}

LogsSchema schema_from_columns(const std::map<std::string, std::string>& columns) {
  LogsSchema schema;
  const auto has = [&](const char* name) { return columns.count(name) > 0; };
  const auto type_of = [&](const char* name) { return columns.at(name); };
  schema.exists = has("Timestamp") && has("ServiceName") && has("Body") && has("SeverityNumber") && has("SeverityText");
  schema.timestamp_time = has("TimestampTime");
  schema.trace_id = has("TraceId");
  schema.span_id = has("SpanId");
  schema.trace_flags = has("TraceFlags");
  schema.scope_name = has("ScopeName");
  schema.scope_version = has("ScopeVersion");
  schema.log_attributes = has("LogAttributes") && attribute_column(type_of("LogAttributes"));
  schema.resource_attributes = has("ResourceAttributes") && attribute_column(type_of("ResourceAttributes"));
  schema.scope_attributes = has("ScopeAttributes") && attribute_column(type_of("ScopeAttributes"));
  const auto map_column = [&](const char* name) { return has(name) && type_of(name).rfind("Map(", 0) == 0; };
  schema.log_attributes_map = map_column("LogAttributes");
  schema.resource_attributes_map = map_column("ResourceAttributes");
  schema.scope_attributes_map = map_column("ScopeAttributes");
  return schema;
}

void apply_skipping_indexes(LogsSchema* schema, const std::vector<std::pair<std::string, std::string>>& indexes) {
  for (const auto& [type, expr] : indexes) {
    const bool token = type == "tokenbf_v1" || type == "text" || type == "full_text" || type == "inverted";
    if (!token) continue;
    if (expr == "Body" || expr == "`Body`") schema->body_token_index = true;
    if (expr == "lower(Body)" || expr == "lower(`Body`)") schema->body_lower_index = true;
  }
  // A lower(Body) index is only preferred when there is no exact-case one.
  if (schema->body_token_index) schema->body_lower_index = false;
}

bool build_filters(const OtelSettings& otel, const LogsSchema& schema, const FilterInput& input, int64_t now_ms, bool need_range,
                   LogsQuery* out, ApiError* error) {
  const LogSettings& logs = otel.logs;
  if (need_range) {
    int64_t lo = 0, hi = 0;
    const bool has_lo = input.start_ms.has_value();
    const bool has_hi = input.end_ms.has_value();
    if (has_lo) lo = *input.start_ms;
    if (has_hi) hi = *input.end_ms;
    if (has_lo != has_hi) {
      *error = make_error(400, "invalid_logs_range", "start_ms and end_ms must be provided together.");
      return false;
    }
    if (!has_lo) {
      const int lookback = clamp_or(input.lookback_minutes, 15, 1, logs.max_lookback_minutes);
      hi = now_ms;
      lo = hi - static_cast<int64_t>(lookback) * 60000;
    }
    constexpr int64_t kMaxMs = INT64_MAX / 1000000 - 1;
    if (lo < 0 || hi <= lo || hi > kMaxMs) {
      *error = make_error(400, "invalid_logs_range", "Invalid logs time range.");
      return false;
    }
    if (hi - lo > static_cast<int64_t>(logs.max_lookback_minutes) * 60000) {
      *error = make_error(400, "invalid_logs_range", "Logs time range exceeds logs.max_lookback_minutes.");
      return false;
    }
    out->start_ms = lo;
    out->end_ms = hi;
  }

  SqlParams params;
  std::string where = " AND " + otel::service_allowlist_predicate(otel.traces);
  if (!input.services.empty()) where += " AND ServiceName IN (" + params.texts(input.services) + ")";

  if (!input.severity_min.empty()) {
    const auto value = parse_whole_i64(input.severity_min);
    if (!value || *value < 0 || *value > 24) {
      *error = invalid_filter("severity_min must be a SeverityNumber between 0 and 24.");
      return false;
    }
    if (*value > 0) where += " AND SeverityNumber >= " + std::to_string(*value);
  }
  if (!input.severities.empty()) {
    std::vector<std::string> parts;
    for (const auto& name : input.severities) {
      const Severity* s = severity_class(name);
      if (!s) {
        *error = invalid_filter("severity must be error, warn, info or debug.");
        return false;
      }
      parts.push_back(s->lo == 0 ? "SeverityNumber <= " + std::to_string(s->hi)
                                 : "(SeverityNumber >= " + std::to_string(s->lo) + " AND SeverityNumber <= " + std::to_string(s->hi) + ")");
    }
    std::sort(parts.begin(), parts.end());
    parts.erase(std::unique(parts.begin(), parts.end()), parts.end());
    where += " AND (";
    for (size_t i = 0; i < parts.size(); ++i) where += (i ? " OR " : "") + parts[i];
    where += ")";
  }

  if (!input.trace_id.empty()) {
    if (!schema.trace_id || !valid_hex_id(input.trace_id, 64)) {
      *error = invalid_filter("trace_id must be a hexadecimal trace id.");
      return false;
    }
    where += " AND TraceId = " + params.text(input.trace_id);
  }
  if (!input.span_id.empty()) {
    if (!schema.span_id || !valid_hex_id(input.span_id, 32)) {
      *error = invalid_filter("span_id must be a hexadecimal span id.");
      return false;
    }
    where += " AND SpanId = " + params.text(input.span_id);
  }

  // attr=key=value / attr=key!=value. A bare key matches LogAttributes or ResourceAttributes; LogAttributes.<key> / ResourceAttributes.<key>
  // pick one map; ServiceName, SeverityText, TraceId, SpanId, ScopeName and ScopeVersion compare the column. Several key=value filters of
  // one key match any of their values (the Fields panel's checked values, as the Traces attribute facets); key!=value filters each
  // exclude their value.
  if (input.attrs.size() > kMaxAttrFilters) {
    *error = invalid_filter("Too many attribute filters.");
    return false;
  }
  std::map<std::string, std::vector<std::string>> included;  // key -> predicates (ORed)
  for (const auto& raw : input.attrs) {
    const size_t eq = raw.find('=');
    if (eq == std::string::npos || eq == 0) {
      *error = invalid_filter("attr filters are key=value or key!=value.");
      return false;
    }
    const bool negate = raw[eq - 1] == '!';
    const std::string key = raw.substr(0, negate ? eq - 1 : eq);
    const std::string value = raw.substr(eq + 1);
    if (key.empty()) {
      *error = invalid_filter("attr filters need a key.");
      return false;
    }
    std::string predicate;
    bool top_level = false;
    for (const char* column : kTopLevelColumns) {
      if (key == column) top_level = true;
    }
    if (top_level) {
      if ((key == "TraceId" && !schema.trace_id) || (key == "SpanId" && !schema.span_id) || (key == "ScopeName" && !schema.scope_name) ||
          (key == "ScopeVersion" && !schema.scope_version)) {
        *error = invalid_filter("Column " + key + " is not in the logs table.");
        return false;
      }
      predicate = quote_ident(key) + " = " + params.text(value);
    } else {
      std::vector<std::string> maps;
      std::string name = key;
      if (key.rfind("LogAttributes.", 0) == 0) {
        name = key.substr(14);
        maps.push_back("LogAttributes");
      } else if (key.rfind("ResourceAttributes.", 0) == 0) {
        name = key.substr(19);
        maps.push_back("ResourceAttributes");
      } else if (key.rfind("ScopeAttributes.", 0) == 0) {
        name = key.substr(16);
        maps.push_back("ScopeAttributes");
      } else {
        maps = {"LogAttributes", "ResourceAttributes"};
      }
      std::vector<std::string> parts;
      const std::string name_param = params.text(name), value_param = params.text(value);
      for (const auto& map : maps) {
        const bool present = (map == "LogAttributes" && schema.log_attributes) || (map == "ResourceAttributes" && schema.resource_attributes) ||
                             (map == "ScopeAttributes" && schema.scope_attributes);
        if (present) parts.push_back(map + "[" + name_param + "] = " + value_param);
      }
      if (parts.empty() || name.empty()) {
        *error = invalid_filter("Attribute maps are not available for " + key + ".");
        return false;
      }
      predicate = parts.size() == 1 ? parts.front() : "(" + parts[0] + " OR " + parts[1] + ")";
    }
    if (negate) where += " AND NOT " + predicate;
    else included[key].push_back(predicate);
  }
  for (const auto& [key, predicates] : included) {
    if (predicates.size() == 1) {
      where += " AND " + predicates.front();
      continue;
    }
    where += " AND (";
    for (size_t i = 0; i < predicates.size(); ++i) where += (i ? " OR " : "") + predicates[i];
    where += ")";
  }

  auto terms = parse_terms(input.q);
  out->body_mode = logs.body_search;
  if (!terms.empty()) {
    if (logs.body_search == "off") {
      *error = make_error(400, "logs_body_search_disabled", "Body search is disabled (logs.body_search = \"off\").");
      return false;
    }
    if (terms.size() > kMaxTextTerms) terms.resize(kMaxTextTerms);
    out->text_search = true;
    const bool substring = logs.body_search == "substring";
    out->text_index_backed = !substring && (schema.body_token_index || schema.body_lower_index);
    for (const auto& term : terms) {
      where += " AND " + (substring ? substring_term_sql(term, params) : token_term_sql(term, schema.body_lower_index, params));
    }
  }
  out->where = where;
  out->params = std::move(params);
  return true;
}

bool build_context_filter(const OtelSettings& otel, const LogsSchema& schema, const ContextRequest& request, const std::string& preset,
                          std::string* where, SqlParams* params, ApiError* error) {
  const auto bad = [&](std::string message) {
    *error = make_error(400, "invalid_logs_context", std::move(message));
    return false;
  };
  std::string filter = " AND " + otel::service_allowlist_predicate(otel.traces);
  if (preset == "service") {
    if (request.service.empty()) return bad("preset=service needs service.");
    filter += " AND ServiceName = " + params->text(request.service);
  } else if (preset == "host") {
    if (request.host.empty() || !schema.resource_attributes) return bad("preset=host needs host (ResourceAttributes host.name).");
    filter += " AND ResourceAttributes['host.name'] = " + params->text(request.host);
  } else if (preset == "trace") {
    if (!schema.trace_id || !valid_hex_id(request.trace_id, 64)) return bad("preset=trace needs a hexadecimal trace_id.");
    filter += " AND TraceId = " + params->text(request.trace_id);
  } else if (preset != "anything") {
    return bad("preset must be anything, service, host or trace.");
  }
  *where = std::move(filter);
  return true;
}

}  // namespace logs
}  // namespace chdash
