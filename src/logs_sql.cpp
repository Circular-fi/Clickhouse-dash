#include "logs_sql.hpp"

#include "api_params.hpp"
#include "facet_limits.hpp"
#include "sql_literal.hpp"

#include <algorithm>
#include <cmath>
#include <iterator>

namespace chdash {
namespace logs {

namespace {

using sql::quote_ident;
using sql::quote_string;

std::string join_sql(const std::vector<std::string>& parts) {
  std::string out;
  for (size_t i = 0; i < parts.size(); ++i) out += (i ? ", " : "") + parts[i];
  return out;
}

}  // namespace

std::string settings_clause(int max_execution_seconds) {
  return " SETTINGS max_execution_time = " + std::to_string(max_execution_seconds) +
         ", timeout_overflow_mode = 'throw', max_rows_to_read = " + std::to_string(kMaxRowsToRead) + ", read_overflow_mode = 'throw'";
}

std::string table_name(const LogSettings& logs) { return quote_ident(logs.database) + "." + quote_ident(logs.table); }

// ---------------------------------------------------------------------------
// The schema probe

SqlStatement schema_columns_statement(const LogSettings& logs) {
  SqlStatement statement;
  const std::string database = statement.params.text(logs.database), table = statement.params.text(logs.table);
  statement.sql = "SELECT toString(name), toString(type) FROM system.columns WHERE database = " + database + " AND `table` = " + table;
  return statement;
}

SqlStatement schema_indexes_statement(const LogSettings& logs) {
  SqlStatement statement;
  const std::string database = statement.params.text(logs.database), table = statement.params.text(logs.table);
  statement.sql = "SELECT toString(type), toString(expr) FROM system.data_skipping_indices WHERE database = " + database + " AND `table` = " + table;
  return statement;
}

// ---------------------------------------------------------------------------
// Time, order and the keyset

std::string time_predicate(const LogsSchema& schema, int64_t lo_ns, int64_t hi_ns) {
  std::string out;
  if (schema.timestamp_time) {
    out += "TimestampTime >= toDateTime(" + std::to_string(lo_ns / 1000000000) + ") AND TimestampTime <= toDateTime(" +
           std::to_string(hi_ns / 1000000000) + ") AND ";
  }
  out += "Timestamp >= fromUnixTimestamp64Nano(toInt64(" + std::to_string(lo_ns) + ")) AND Timestamp <= fromUnixTimestamp64Nano(toInt64(" +
         std::to_string(hi_ns) + "))";
  return out;
}

std::string tiebreak_expr(const LogsSchema& schema) {
  std::string out = "cityHash64(ServiceName";
  if (schema.trace_id) out += ", TraceId";
  if (schema.span_id) out += ", SpanId";
  return out + ", SeverityNumber, Body)";
}

std::string ts_literal(int64_t ns) { return "fromUnixTimestamp64Nano(toInt64(" + std::to_string(ns) + "))"; }

bool parse_u64(const std::string& text, uint64_t* out) {
  if (text.empty() || text[0] == '-') return false;
  try {
    size_t used = 0;
    const unsigned long long value = std::stoull(text, &used);
    if (used != text.size()) return false;
    *out = value;
    return true;
  } catch (...) {
    return false;
  }
}

bool parse_cursor(const std::string& text, Cursor* out) {
  const size_t dash = text.find('-');
  if (dash == std::string::npos) return false;
  const auto ts = parse_whole_i64(text.substr(0, dash));
  if (!ts) return false;
  out->ts_ns = *ts;
  return parse_u64(text.substr(dash + 1), &out->tie) && out->ts_ns >= 0;
}

std::string cursor_text(const Cursor& cursor) { return std::to_string(cursor.ts_ns) + "-" + std::to_string(cursor.tie); }

std::string keyset_predicate(const std::string& tie_expr, const Cursor& cursor, bool older) {
  const char* op = older ? "<" : ">";
  return "(Timestamp " + std::string(op) + " " + ts_literal(cursor.ts_ns) + " OR (Timestamp = " + ts_literal(cursor.ts_ns) + " AND " +
         tie_expr + " " + op + " " + std::to_string(cursor.tie) + "))";
}

std::string row_columns(const LogsSchema& schema) {
  const auto opt = [](bool present, const std::string& expr, const char* fallback) { return present ? expr : std::string(fallback); };
  return "toString(toUnixTimestamp64Nano(Timestamp)), toString(" + tiebreak_expr(schema) +
         "), toString(ServiceName), toString(SeverityText), toString(SeverityNumber), substringUTF8(Body, 1, " + std::to_string(kBodyMaxChars) +
         "), toString(lengthUTF8(Body)), " + opt(schema.trace_id, "toString(TraceId)", "''") + ", " +
         opt(schema.span_id, "toString(SpanId)", "''") + ", " + opt(schema.trace_flags, "toString(TraceFlags)", "'0'") + ", " +
         opt(schema.scope_name, "toString(ScopeName)", "''") + ", " + opt(schema.scope_version, "toString(ScopeVersion)", "''") + ", " +
         opt(schema.log_attributes, "toJSONString(LogAttributes)", "'{}'") + ", " +
         opt(schema.resource_attributes, "toJSONString(ResourceAttributes)", "'{}'") + ", " +
         opt(schema.scope_attributes, "toJSONString(ScopeAttributes)", "'{}'");
}

// ---------------------------------------------------------------------------
// The routes

SqlStatement search_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, int64_t lo_ns, int64_t hi_ns,
                              const std::optional<Cursor>& after, size_t limit, int window_seconds) {
  const std::string tie = tiebreak_expr(schema);
  std::string predicate = time_predicate(schema, lo_ns, hi_ns);
  if (after) predicate += " AND " + keyset_predicate(tie, *after, true);
  SqlStatement statement;
  statement.params = query.params;
  statement.sql = "SELECT " + row_columns(schema) + " FROM " + table + " WHERE " + predicate + query.where + " ORDER BY Timestamp DESC, " + tie +
                  " DESC LIMIT " + std::to_string(limit) + settings_clause(window_seconds);
  return statement;
}

int64_t choose_bucket_ms(int64_t range_ms, int target) {
  static const int64_t candidates[] = {1000,   2000,   5000,    10000,   15000,   30000,    60000,    120000,   300000,   600000,
                                       900000, 1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000, 172800000, 604800000};
  const int64_t desired = std::max<int64_t>(1000, range_ms / std::max(1, target));
  for (int64_t value : candidates) {
    if (value >= desired) return value;
  }
  return candidates[sizeof(candidates) / sizeof(candidates[0]) - 1];
}

int64_t grid_floor(int64_t t, int64_t size, int64_t origin) {
  const int64_t offset = t - origin;
  return origin + (offset >= 0 ? offset / size : -((-offset + size - 1) / size)) * size;
}

std::string bucket_sql(const LogsSchema& schema, int64_t size, int64_t origin) {
  // Grids that align to the second bucket TimestampTime (4 bytes), not Timestamp.
  const std::string ms = schema.timestamp_time && size % 1000 == 0 && origin % 1000 == 0 ? "(toInt64(toUnixTimestamp(TimestampTime)) * 1000)"
                                                                                           : "toUnixTimestamp64Milli(Timestamp)";
  return std::to_string(origin) + " + intDiv(" + ms + " - " + std::to_string(origin) + ", " + std::to_string(size) + ") * " + std::to_string(size);
}

SqlStatement histogram_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, int64_t bucket_ms, int64_t origin) {
  SqlStatement statement;
  statement.params = query.params;
  statement.sql = "SELECT toString(" + bucket_sql(schema, bucket_ms, origin) + ") AS b, "
                  "toString(countIf(SeverityNumber >= 17)), toString(countIf(SeverityNumber >= 13 AND SeverityNumber < 17)), "
                  "toString(countIf(SeverityNumber >= 9 AND SeverityNumber < 13)), toString(countIf(SeverityNumber < 9)) FROM " +
                  table + " WHERE " + time_predicate(schema, query.start_ms * 1000000, query.end_ms * 1000000 + 999999) + query.where +
                  " GROUP BY b ORDER BY toInt64(b)" + settings_clause();
  return statement;
}

SqlStatement context_older_statement(const LogsSchema& schema, const std::string& table, const std::string& filter, const SqlParams& params,
                                     int64_t ts_ns, const std::optional<uint64_t>& tie, int64_t delta_ns, size_t limit) {
  const std::string tie_expr = tiebreak_expr(schema);
  const std::string key = tie ? keyset_predicate(tie_expr, Cursor{ts_ns, *tie}, true) : "Timestamp < " + ts_literal(ts_ns);
  SqlStatement statement;
  statement.params = params;
  statement.sql = "SELECT " + row_columns(schema) + " FROM " + table + " WHERE " +
                  time_predicate(schema, std::max<int64_t>(0, ts_ns - delta_ns), ts_ns) + " AND " + key + filter +
                  " ORDER BY Timestamp DESC, " + tie_expr + " DESC LIMIT " + std::to_string(limit + 1) + settings_clause();
  return statement;
}

SqlStatement context_newer_statement(const LogsSchema& schema, const std::string& table, const std::string& filter, const SqlParams& params,
                                     int64_t ts_ns, const std::optional<uint64_t>& tie, int64_t delta_ns, size_t limit) {
  const std::string tie_expr = tiebreak_expr(schema);
  const std::string key = tie ? "(" + keyset_predicate(tie_expr, Cursor{ts_ns, *tie}, false) + " OR (Timestamp = " + ts_literal(ts_ns) +
                                    " AND " + tie_expr + " = " + std::to_string(*tie) + "))"
                              : "Timestamp >= " + ts_literal(ts_ns);
  SqlStatement statement;
  statement.params = params;
  statement.sql = "SELECT " + row_columns(schema) + " FROM " + table + " WHERE " + time_predicate(schema, ts_ns, ts_ns + delta_ns) + " AND " +
                  key + filter + " ORDER BY Timestamp ASC, " + tie_expr + " ASC LIMIT " + std::to_string(limit + 2) + settings_clause();
  return statement;
}

namespace {

std::string patterns_where(const LogsSchema& schema, const LogsQuery& query) {
  return " WHERE " + time_predicate(schema, query.start_ms * 1000000, query.end_ms * 1000000 + 999999) + query.where;
}

}  // namespace

SqlStatement patterns_count_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query) {
  SqlStatement statement;
  statement.params = query.params;
  statement.sql = "SELECT toString(count()) FROM " + table + patterns_where(schema, query) + settings_clause();
  return statement;
}

uint64_t sample_rate_ppm(uint64_t total, size_t target) {
  return std::max<uint64_t>(1, static_cast<uint64_t>(std::ceil(1e6 * static_cast<double>(target) / static_cast<double>(total))));
}

SqlStatement patterns_sample_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, uint64_t rate_ppm,
                                       size_t fetch_limit) {
  std::string where = patterns_where(schema, query);
  if (rate_ppm > 0) {
    where += " AND cityHash64(_part, intDiv(_part_offset, " + std::to_string(kSampleBlockRows) + ")) % 1000000 < " + std::to_string(rate_ppm);
  }
  SqlStatement statement;
  statement.params = query.params;
  statement.sql = "SELECT toString(toUnixTimestamp64Milli(Timestamp)), toString(SeverityNumber), toString(ServiceName), substringUTF8(Body, 1, " +
                  std::to_string(kPatternBodyChars) + ") FROM " + table + where + " LIMIT " + std::to_string(fetch_limit) + settings_clause();
  return statement;
}

SqlStatement services_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query) {
  SqlStatement statement;
  statement.params = query.params;
  statement.sql = "SELECT toString(ServiceName), toString(count()) FROM " + table + " WHERE " +
                  time_predicate(schema, query.start_ms * 1000000, query.end_ms * 1000000 + 999999) + query.where +
                  " GROUP BY ServiceName ORDER BY ServiceName LIMIT 1000" + settings_clause();
  return statement;
}

// ---------------------------------------------------------------------------
// The facets

const char* const kFacetColumns[4] = {"ServiceName", "SeverityText", "ScopeName", "ScopeVersion"};

bool facet_column_known(const std::string& name) {
  return std::any_of(std::begin(kFacetColumns), std::end(kFacetColumns), [&](const char* c) { return name == c; });
}

bool facet_column_present(const LogsSchema& schema, const std::string& name) {
  if (name == "ScopeName") return schema.scope_name;
  if (name == "ScopeVersion") return schema.scope_version;
  return name == "ServiceName" || name == "SeverityText";
}

const char* facet_map_column(const std::string& scope) {
  if (scope == "log") return "LogAttributes";
  if (scope == "resource") return "ResourceAttributes";
  if (scope == "scope") return "ScopeAttributes";
  return nullptr;
}

bool facet_map_present(const LogsSchema& schema, const std::string& scope) {
  if (scope == "log") return schema.log_attributes_map;
  if (scope == "resource") return schema.resource_attributes_map;
  if (scope == "scope") return schema.scope_attributes_map;
  return false;
}

int facet_scope_rank(const std::string& scope) {
  if (scope == "column") return 0;
  if (scope == "log") return 1;
  if (scope == "resource") return 2;
  return 3;
}

FacetWindow facet_window(const LogsQuery& query) {
  constexpr int64_t kAlignMs = 60 * 1000;
  return FacetWindow{(query.start_ms / kAlignMs) * kAlignMs, ((query.end_ms + kAlignMs - 1) / kAlignMs) * kAlignMs};
}

namespace {

std::string facet_where(const LogsSchema& schema, const LogsQuery& query, const FacetWindow& window) {
  return " WHERE " + time_predicate(schema, window.start_ms * 1000000, window.end_ms * 1000000) + query.where;
}

}  // namespace

SqlStatement facet_keys_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, const FacetWindow& window,
                                  const std::vector<std::string>& scopes, const std::vector<std::string>& columns) {
  std::vector<std::string> inner, aggregates, tuples, column_tuples;
  for (size_t i = 0; i < scopes.size(); ++i) {
    const std::string k = "k" + std::to_string(i), m = "m" + std::to_string(i);
    inner.push_back(std::string(facet_map_column(scopes[i])) + ".keys AS " + k);
    aggregates.push_back("sumMap(" + k + ", arrayResize([toUInt64(1)], length(" + k + "), toUInt64(1))) AS " + m);
    tuples.push_back("arrayMap((k, c) -> tuple('" + scopes[i] + "', toString(k), c), " + m + ".1, " + m + ".2)");
  }
  for (size_t i = 0; i < columns.size(); ++i) {
    const std::string c = "c" + std::to_string(i), n = "n" + std::to_string(i);
    inner.push_back(quote_ident(columns[i]) + " AS " + c);
    aggregates.push_back("countIf(" + c + " != '') AS " + n);
    column_tuples.push_back("tuple('column', " + quote_string(columns[i]) + ", " + n + ")");
  }
  tuples.push_back("[" + join_sql(column_tuples) + "]");
  SqlStatement statement;
  statement.params = query.params;
  statement.sql = "SELECT toString(sampled), toString(t.1), toString(t.2), toString(t.3) FROM ("
                  "SELECT count() AS sampled, " + join_sql(aggregates) + " FROM ("
                  "SELECT " + join_sql(inner) + " FROM " + table + facet_where(schema, query, window) +
                  " LIMIT " + std::to_string(kFacetSampleRows) + ")) LEFT ARRAY JOIN arrayConcat(" + join_sql(tuples) + ") AS t" +
                  // The statement keeps only the served keys, and one more key that says truncated.
                  // The keys are in the order of the sort below.
                  " ORDER BY t.3 DESC, multiIf(t.1 = 'column', 0, t.1 = 'log', 1, t.1 = 'resource', 2, 3), t.2 LIMIT " +
                  std::to_string(kFacetMaxKeys + 1) + facet_settings_sql(kFacetReadRowsCap, false);
  return statement;
}

SqlStatement facet_values_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, const FacetWindow& window,
                                    const std::string& scope, const std::string& key, int limit) {
  SqlStatement statement;
  statement.params = query.params;
  std::string expr, presence;
  if (scope == "column") {
    expr = "toString(" + quote_ident(key) + ")";
  } else {
    const std::string map = facet_map_column(scope);
    const std::string key_param = statement.params.text(key);
    expr = map + "[" + key_param + "]";
    presence = " AND mapContains(" + map + ", " + key_param + ")";
  }
  statement.sql = "SELECT toString(v), toString(c), toString(sum(c) OVER ()), toString(count() OVER ()) FROM ("
                  "SELECT v, count() AS c FROM ("
                  "SELECT " + expr + " AS v FROM " + table + facet_where(schema, query, window) + presence +
                  " LIMIT " + std::to_string(kFacetSampleRows) + ") GROUP BY v) "
                  "ORDER BY c DESC, v LIMIT " + std::to_string(limit) + facet_settings_sql(kFacetReadRowsCap, true);
  return statement;
}

}  // namespace logs
}  // namespace chdash
