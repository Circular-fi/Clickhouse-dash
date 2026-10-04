// Logs explorer routes over the OpenTelemetry Collector ClickHouse exporter
// logs table (logs { } block, see docs/logs.md):
//
//   GET /api/logs/search     newest-first rows, keyset pagination, progressive
//                            time windows (newest slice first, widened until
//                            the limit is filled).
//   GET /api/logs/histogram  volume over time stacked by severity class.
//   GET /api/logs/context    records around one record (any / same service /
//                            same host / same trace), bounded windows.
//   GET /api/logs/patterns   Drain templates mined from a bounded sample.
//   GET /api/logs/facets     the Fields panel: field keys (attribute map keys
//                            and record columns) of the matching records.
//   GET /api/logs/facet_values  top values of one field.
//
// Every query filters on the primary-key columns first (ServiceName through
// the allowlist and the service filter, TimestampTime / Timestamp through the
// time range), searches Body with hasToken() so the exporter's tokenbf_v1
// idx_body skips granules, and runs with max_execution_time and a
// max_rows_to_read guard.
#include "server.hpp"

#include "api_error.hpp"
#include "ch_block_value.hpp"
#include "ch_uri.hpp"
#include "facet_limits.hpp"
#include "host_util.hpp"
#include "otel_allowlist.hpp"
#include "time_util.hpp"

#include <clickhouse/client.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chdash {
namespace {

using JsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;
using Clock = std::chrono::steady_clock;

// Per-query guards. A query that would read more rows fails with
// logs_scan_limit instead of scanning a whole multi-billion-row table.
constexpr int kMaxExecutionSeconds = 30;
constexpr uint64_t kMaxRowsToRead = 1000000000ULL;
// A search stops widening its windows once this much time has been spent and
// answers with a cursor that continues where it stopped.
constexpr int64_t kSearchBudgetMs = 12000;
// Progressive search windows (HyperDX searchWindows): newest slice first.
constexpr int64_t kSearchWindowsSeconds[] = {15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60};
// body_search = "substring" scans Body: searches use short windows only, and
// histograms / patterns with a text filter are limited to this range.
constexpr int64_t kSubstringWindowSeconds = 15 * 60;
constexpr int64_t kSubstringMaxRangeMs = 6LL * 60 * 60 * 1000;
constexpr size_t kBodyMaxChars = 16384;
constexpr size_t kMaxTextTerms = 16;
constexpr size_t kMaxAttrFilters = 16;
constexpr auto kSchemaCacheTtl = std::chrono::seconds(60);

std::string quote_ident(std::string_view ident) {
  std::string out = "`";
  for (char ch : ident) {
    if (ch == '`') out += "``";
    else out.push_back(ch);
  }
  return out + "`";
}

std::string quote(std::string_view value) { return otel::allowlist_quote_string(value); }

std::string settings_clause() {
  return " SETTINGS max_execution_time = " + std::to_string(kMaxExecutionSeconds) +
         ", timeout_overflow_mode = 'throw', max_rows_to_read = " + std::to_string(kMaxRowsToRead) +
         ", read_overflow_mode = 'throw'";
}

int64_t elapsed_ms(Clock::time_point since) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - since).count();
}

const HostSpec* logs_host(const AppConfig& cfg, const httplib::Request& req, std::string* host_id) {
  std::string id;
  if (req.has_param("host_id")) id = req.get_param_value("host_id");
  if (id.empty() && cfg.hosts.size() == 1) id = cfg.hosts.front().id;
  if (host_id) *host_id = id;
  return id.empty() ? nullptr : find_host(cfg.hosts, id);
}

std::shared_ptr<clickhouse::Client> acquire_logs_client(
    const HostSpec& host, const std::shared_ptr<ClickHouseClientPool>& pool, std::string* error) {
  if (host.system_uri.empty()) {
    if (error) *error = "OTel logs require system credentials for the selected host.";
    return nullptr;
  }
  // (connect, receive, send); the receive timeout outlasts max_execution_time.
  const auto connect_timeout = std::chrono::seconds(5);
  const auto receive_timeout = std::chrono::seconds(kMaxExecutionSeconds + 15);
  const auto send_timeout = std::chrono::seconds(15);
  return pool ? pool->acquire(host.system_uri, connect_timeout, receive_timeout, send_timeout, error)
              : make_client_from_uri(host.system_uri, connect_timeout, receive_timeout, send_timeout, error);
}

bool parse_i64(const std::string& text, int64_t* out) {
  if (text.empty()) return false;
  try {
    size_t used = 0;
    const long long value = std::stoll(text, &used);
    if (used != text.size()) return false;
    *out = value;
    return true;
  } catch (...) {
    return false;
  }
}

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

std::string param(const httplib::Request& req, const char* name) {
  return req.has_param(name) ? req.get_param_value(name) : std::string{};
}

int int_param(const httplib::Request& req, const char* name, int fallback, int lo, int hi) {
  int64_t value = 0;
  if (!parse_i64(param(req, name), &value)) return fallback;
  return static_cast<int>(std::max<int64_t>(lo, std::min<int64_t>(hi, value)));
}

std::vector<std::string> repeated(const httplib::Request& req, const char* name) {
  std::vector<std::string> values;
  const auto range = req.params.equal_range(name);
  for (auto it = range.first; it != range.second; ++it) {
    if (!it->second.empty()) values.push_back(it->second);
  }
  std::sort(values.begin(), values.end());
  values.erase(std::unique(values.begin(), values.end()), values.end());
  return values;
}

void send_json(httplib::Response& res, const rapidjson::StringBuffer& sb) {
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

// ---------------------------------------------------------------------------
// Schema probe (system tables only, cached): which optional columns and
// indexes the exporter layout has.

struct LogsSchema {
  bool exists = false;
  bool timestamp_time = false;
  bool trace_id = false;
  bool span_id = false;
  bool trace_flags = false;
  bool scope_name = false;
  bool scope_version = false;
  bool log_attributes = false;
  bool resource_attributes = false;
  bool scope_attributes = false;
  // Map(String, String) attribute columns (the facets read their key
  // subcolumns; a JSON column filters but is not faceted).
  bool log_attributes_map = false;
  bool resource_attributes_map = false;
  bool scope_attributes_map = false;
  bool body_lower_index = false;
  bool body_token_index = false;
};

std::mutex g_schema_mutex;
std::unordered_map<std::string, std::pair<LogsSchema, Clock::time_point>> g_schema_cache;

bool attribute_column(const std::string& type) {
  return type.rfind("Map(", 0) == 0 || type.rfind("JSON", 0) == 0;
}

LogsSchema load_schema(clickhouse::Client& client, const HostSpec& host, const LogSettings& logs) {
  const std::string key = host.system_uri + '\x1f' + logs.database + '\x1f' + logs.table;
  {
    std::lock_guard<std::mutex> lock(g_schema_mutex);
    const auto it = g_schema_cache.find(key);
    if (it != g_schema_cache.end() && Clock::now() - it->second.second < kSchemaCacheTtl) return it->second.first;
  }
  LogsSchema schema;
  std::map<std::string, std::string> columns;
  client.Select(
      "SELECT toString(name), toString(type) FROM system.columns WHERE database = " + quote(logs.database) +
          " AND `table` = " + quote(logs.table),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          columns[ch_block_text_at(block, 0, row)] = ch_block_text_at(block, 1, row);
        }
      });
  schema.exists = columns.count("Timestamp") && columns.count("ServiceName") && columns.count("Body") &&
                  columns.count("SeverityNumber") && columns.count("SeverityText");
  schema.timestamp_time = columns.count("TimestampTime") > 0;
  schema.trace_id = columns.count("TraceId") > 0;
  schema.span_id = columns.count("SpanId") > 0;
  schema.trace_flags = columns.count("TraceFlags") > 0;
  schema.scope_name = columns.count("ScopeName") > 0;
  schema.scope_version = columns.count("ScopeVersion") > 0;
  schema.log_attributes = columns.count("LogAttributes") && attribute_column(columns["LogAttributes"]);
  schema.resource_attributes = columns.count("ResourceAttributes") && attribute_column(columns["ResourceAttributes"]);
  schema.scope_attributes = columns.count("ScopeAttributes") && attribute_column(columns["ScopeAttributes"]);
  const auto map_column = [&](const char* name) { return columns.count(name) && columns[name].rfind("Map(", 0) == 0; };
  schema.log_attributes_map = map_column("LogAttributes");
  schema.resource_attributes_map = map_column("ResourceAttributes");
  schema.scope_attributes_map = map_column("ScopeAttributes");
  if (schema.exists) {
    client.Select(
        "SELECT toString(type), toString(expr) FROM system.data_skipping_indices WHERE database = " +
            quote(logs.database) + " AND `table` = " + quote(logs.table),
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            const std::string type = ch_block_text_at(block, 0, row);
            const std::string expr = ch_block_text_at(block, 1, row);
            const bool token = type == "tokenbf_v1" || type == "text" || type == "full_text" || type == "inverted";
            if (!token) continue;
            if (expr == "Body" || expr == "`Body`") schema.body_token_index = true;
            if (expr == "lower(Body)" || expr == "lower(`Body`)") schema.body_lower_index = true;
          }
        });
  }
  // A lower(Body) index is only preferred when there is no exact-case one.
  if (schema.body_token_index) schema.body_lower_index = false;
  std::lock_guard<std::mutex> lock(g_schema_mutex);
  if (g_schema_cache.size() > 64) g_schema_cache.clear();
  g_schema_cache[key] = {schema, Clock::now()};
  return schema;
}

// ---------------------------------------------------------------------------
// Filters.

// tokenbf_v1 / hasToken() split on every ASCII non-alphanumeric byte; bytes
// >= 0x80 (UTF-8) belong to tokens.
bool token_byte(unsigned char ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch >= 0x80;
}

std::vector<std::string> split_tokens(std::string_view text) {
  std::vector<std::string> out;
  std::string current;
  for (char c : text) {
    if (token_byte(static_cast<unsigned char>(c))) {
      current.push_back(c);
    } else if (!current.empty()) {
      out.push_back(current);
      current.clear();
    }
  }
  if (!current.empty()) out.push_back(current);
  return out;
}

struct TextTerm {
  std::string text;
  bool negate = false;
};

// Whitespace-separated terms, "quoted phrases" and -negated terms.
std::vector<TextTerm> parse_terms(std::string_view q) {
  std::vector<TextTerm> terms;
  size_t i = 0;
  while (i < q.size()) {
    while (i < q.size() && std::isspace(static_cast<unsigned char>(q[i]))) ++i;
    if (i >= q.size()) break;
    TextTerm term;
    if (q[i] == '-' && i + 1 < q.size() && !std::isspace(static_cast<unsigned char>(q[i + 1]))) {
      term.negate = true;
      ++i;
    }
    if (q[i] == '"') {
      const size_t close = q.find('"', i + 1);
      const size_t end = close == std::string_view::npos ? q.size() : close;
      term.text = std::string(q.substr(i + 1, end - i - 1));
      i = close == std::string_view::npos ? q.size() : close + 1;
    } else {
      size_t end = i;
      while (end < q.size() && !std::isspace(static_cast<unsigned char>(q[end]))) ++end;
      term.text = std::string(q.substr(i, end - i));
      i = end;
    }
    if (!term.text.empty()) terms.push_back(std::move(term));
  }
  return terms;
}

std::string to_lower_ascii(std::string text) {
  for (char& c : text) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return text;
}

std::string like_escape(std::string_view text) {
  std::string out;
  for (char c : text) {
    if (c == '%' || c == '_' || c == '\\') out.push_back('\\');
    out.push_back(c);
  }
  return out;
}

// Token mode: every token of a term must be present (hasToken, served by the
// tokenbf index); a term with separators ("analytics.events_buffer",
// "key=user:12") must also appear verbatim, which position() checks on the
// granules the index kept.
std::string token_term_sql(const TextTerm& term, bool lower_index) {
  const std::string body = lower_index ? "lower(Body)" : "Body";
  const std::string text = lower_index ? to_lower_ascii(term.text) : term.text;
  const auto tokens = split_tokens(text);
  std::vector<std::string> parts;
  for (const auto& token : tokens) parts.push_back("hasToken(" + body + ", " + quote(token) + ")");
  if (!(tokens.size() == 1 && tokens.front() == text)) {
    parts.push_back(std::string(lower_index ? "positionCaseInsensitive(Body, " : "position(Body, ") + quote(term.text) + ") > 0");
  }
  std::string sql = "(";
  for (size_t i = 0; i < parts.size(); ++i) sql += (i ? " AND " : "") + parts[i];
  sql += ")";
  return term.negate ? "NOT " + sql : sql;
}

std::string substring_term_sql(const TextTerm& term) {
  return std::string("Body ") + (term.negate ? "NOT " : "") + "ILIKE " + quote("%" + like_escape(term.text) + "%");
}

struct Severity {
  const char* name;
  int lo;
  int hi;  // inclusive
};

// Histogram classes: error >= 17 (fatal included), warn 13-16, info 9-12,
// debug below 9 (trace and unset included).
const Severity kSeverityClasses[] = {
    {"error", 17, 255}, {"warn", 13, 16}, {"info", 9, 12}, {"debug", 0, 8}};

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

struct LogsQuery {
  int64_t start_ms = 0;
  int64_t end_ms = 0;
  std::string where;       // " AND ..." filters (allowlist included), no time predicate
  bool text_search = false;
  bool text_index_backed = false;
  std::string body_mode;   // effective body search mode
};

const char* kTopLevelColumns[] = {"ServiceName", "SeverityText", "TraceId", "SpanId", "ScopeName", "ScopeVersion"};

// Parses the shared filter parameters. Returns false with (code, message) on
// invalid input.
bool build_filters(const AppConfig& cfg, const LogsSchema& schema, const httplib::Request& req, LogsQuery* out,
                   std::string* code, std::string* message, bool need_range = true) {
  const LogSettings& logs = cfg.logs;
  if (need_range) {
    int64_t lo = 0, hi = 0;
    const bool has_lo = parse_i64(param(req, "start_ms"), &lo);
    const bool has_hi = parse_i64(param(req, "end_ms"), &hi);
    if (has_lo != has_hi) {
      *code = "invalid_logs_range";
      *message = "start_ms and end_ms must be provided together.";
      return false;
    }
    if (!has_lo) {
      const int lookback = int_param(req, "lookback_minutes", 15, 1, logs.max_lookback_minutes);
      hi = now_ms();
      lo = hi - static_cast<int64_t>(lookback) * 60000;
    }
    constexpr int64_t kMaxMs = INT64_MAX / 1000000 - 1;
    if (lo < 0 || hi <= lo || hi > kMaxMs) {
      *code = "invalid_logs_range";
      *message = "Invalid logs time range.";
      return false;
    }
    if (hi - lo > static_cast<int64_t>(logs.max_lookback_minutes) * 60000) {
      *code = "invalid_logs_range";
      *message = "Logs time range exceeds logs.max_lookback_minutes.";
      return false;
    }
    out->start_ms = lo;
    out->end_ms = hi;
  }

  std::string where = " AND " + service_allowlist_predicate(cfg.traces);
  const auto services = repeated(req, "service");
  if (!services.empty()) {
    where += " AND ServiceName IN (";
    for (size_t i = 0; i < services.size(); ++i) where += (i ? ", " : "") + quote(services[i]);
    where += ")";
  }

  const std::string severity_min = param(req, "severity_min");
  if (!severity_min.empty()) {
    int64_t value = 0;
    if (!parse_i64(severity_min, &value) || value < 0 || value > 24) {
      *code = "invalid_logs_filter";
      *message = "severity_min must be a SeverityNumber between 0 and 24.";
      return false;
    }
    if (value > 0) where += " AND SeverityNumber >= " + std::to_string(value);
  }
  const auto classes = repeated(req, "severity");
  if (!classes.empty()) {
    std::vector<std::string> parts;
    for (const auto& name : classes) {
      const Severity* s = severity_class(name);
      if (!s) {
        *code = "invalid_logs_filter";
        *message = "severity must be error, warn, info or debug.";
        return false;
      }
      parts.push_back(s->lo == 0 ? "SeverityNumber <= " + std::to_string(s->hi)
                                 : "(SeverityNumber >= " + std::to_string(s->lo) + " AND SeverityNumber <= " +
                                       std::to_string(s->hi) + ")");
    }
    std::sort(parts.begin(), parts.end());
    parts.erase(std::unique(parts.begin(), parts.end()), parts.end());
    where += " AND (";
    for (size_t i = 0; i < parts.size(); ++i) where += (i ? " OR " : "") + parts[i];
    where += ")";
  }

  const std::string trace_id = param(req, "trace_id");
  if (!trace_id.empty()) {
    if (!schema.trace_id || !valid_hex_id(trace_id, 64)) {
      *code = "invalid_logs_filter";
      *message = "trace_id must be a hexadecimal trace id.";
      return false;
    }
    where += " AND TraceId = " + quote(trace_id);
  }
  const std::string span_id = param(req, "span_id");
  if (!span_id.empty()) {
    if (!schema.span_id || !valid_hex_id(span_id, 32)) {
      *code = "invalid_logs_filter";
      *message = "span_id must be a hexadecimal span id.";
      return false;
    }
    where += " AND SpanId = " + quote(span_id);
  }

  // attr=key=value / attr=key!=value. A bare key matches LogAttributes or
  // ResourceAttributes; LogAttributes.<key> / ResourceAttributes.<key> pick
  // one map; ServiceName, SeverityText, TraceId, SpanId, ScopeName and
  // ScopeVersion compare the column. Several key=value filters of one key
  // match any of their values (the Fields panel's checked values, as the
  // Traces attribute facets); key!=value filters each exclude their value.
  const auto attrs = repeated(req, "attr");
  if (attrs.size() > kMaxAttrFilters) {
    *code = "invalid_logs_filter";
    *message = "Too many attribute filters.";
    return false;
  }
  std::map<std::string, std::vector<std::string>> included;  // key -> predicates (ORed)
  for (const auto& raw : attrs) {
    const size_t eq = raw.find('=');
    if (eq == std::string::npos || eq == 0) {
      *code = "invalid_logs_filter";
      *message = "attr filters are key=value or key!=value.";
      return false;
    }
    const bool negate = raw[eq - 1] == '!';
    const std::string key = raw.substr(0, negate ? eq - 1 : eq);
    const std::string value = raw.substr(eq + 1);
    if (key.empty()) {
      *code = "invalid_logs_filter";
      *message = "attr filters need a key.";
      return false;
    }
    std::string predicate;
    bool top_level = false;
    for (const char* column : kTopLevelColumns) {
      if (key == column) top_level = true;
    }
    if (top_level) {
      if ((key == "TraceId" && !schema.trace_id) || (key == "SpanId" && !schema.span_id) ||
          (key == "ScopeName" && !schema.scope_name) || (key == "ScopeVersion" && !schema.scope_version)) {
        *code = "invalid_logs_filter";
        *message = "Column " + key + " is not in the logs table.";
        return false;
      }
      predicate = quote_ident(key) + " = " + quote(value);
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
      for (const auto& map : maps) {
        const bool present = (map == "LogAttributes" && schema.log_attributes) ||
                             (map == "ResourceAttributes" && schema.resource_attributes) ||
                             (map == "ScopeAttributes" && schema.scope_attributes);
        if (present) parts.push_back(map + "[" + quote(name) + "] = " + quote(value));
      }
      if (parts.empty() || name.empty()) {
        *code = "invalid_logs_filter";
        *message = "Attribute maps are not available for " + key + ".";
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

  const std::string q = param(req, "q");
  auto terms = parse_terms(q);
  out->body_mode = logs.body_search;
  if (!terms.empty()) {
    if (logs.body_search == "off") {
      *code = "logs_body_search_disabled";
      *message = "Body search is disabled (logs.body_search = \"off\").";
      return false;
    }
    if (terms.size() > kMaxTextTerms) terms.resize(kMaxTextTerms);
    out->text_search = true;
    const bool substring = logs.body_search == "substring";
    out->text_index_backed = !substring && (schema.body_token_index || schema.body_lower_index);
    for (const auto& term : terms) {
      where += " AND " + (substring ? substring_term_sql(term) : token_term_sql(term, schema.body_lower_index));
    }
  }
  out->where = where;
  return true;
}

// Time predicate for Timestamp in [lo_ns, hi_ns]: the coarse TimestampTime
// bound (primary key of the older exporter layout) plus the exact one.
std::string time_predicate(const LogsSchema& schema, int64_t lo_ns, int64_t hi_ns) {
  std::string out;
  if (schema.timestamp_time) {
    out += "TimestampTime >= toDateTime(" + std::to_string(lo_ns / 1000000000) + ") AND TimestampTime <= toDateTime(" +
           std::to_string(hi_ns / 1000000000) + ") AND ";
  }
  out += "Timestamp >= fromUnixTimestamp64Nano(toInt64(" + std::to_string(lo_ns) +
         ")) AND Timestamp <= fromUnixTimestamp64Nano(toInt64(" + std::to_string(hi_ns) + "))";
  return out;
}

// Stable tiebreak for records sharing a Timestamp (keyset pagination order is
// Timestamp DESC, tiebreak DESC).
std::string tiebreak_expr(const LogsSchema& schema) {
  std::string out = "cityHash64(ServiceName";
  if (schema.trace_id) out += ", TraceId";
  if (schema.span_id) out += ", SpanId";
  return out + ", SeverityNumber, Body)";
}

std::string ts_literal(int64_t ns) { return "fromUnixTimestamp64Nano(toInt64(" + std::to_string(ns) + "))"; }

struct Cursor {
  int64_t ts_ns = 0;
  uint64_t tie = 0;
};

// "<timestamp ns>-<tiebreak>".
bool parse_cursor(const std::string& text, Cursor* out) {
  const size_t dash = text.find('-');
  if (dash == std::string::npos) return false;
  return parse_i64(text.substr(0, dash), &out->ts_ns) && parse_u64(text.substr(dash + 1), &out->tie) && out->ts_ns >= 0;
}

std::string cursor_text(const Cursor& c) { return std::to_string(c.ts_ns) + "-" + std::to_string(c.tie); }

// Rows strictly after / before (ts, tie) in (Timestamp, tiebreak) order.
std::string keyset_predicate(const std::string& tie_expr, const Cursor& c, bool older) {
  const char* op = older ? "<" : ">";
  return "(Timestamp " + std::string(op) + " " + ts_literal(c.ts_ns) + " OR (Timestamp = " + ts_literal(c.ts_ns) +
         " AND " + tie_expr + " " + op + " " + std::to_string(c.tie) + "))";
}

std::string row_columns(const LogsSchema& schema) {
  const auto opt = [](bool present, const std::string& expr, const char* fallback) {
    return present ? expr : std::string(fallback);
  };
  return "toString(toUnixTimestamp64Nano(Timestamp)), toString(" + tiebreak_expr(schema) +
         "), toString(ServiceName), toString(SeverityText), toString(SeverityNumber), substringUTF8(Body, 1, " +
         std::to_string(kBodyMaxChars) + "), toString(lengthUTF8(Body)), " +
         opt(schema.trace_id, "toString(TraceId)", "''") + ", " + opt(schema.span_id, "toString(SpanId)", "''") + ", " +
         opt(schema.trace_flags, "toString(TraceFlags)", "'0'") + ", " +
         opt(schema.scope_name, "toString(ScopeName)", "''") + ", " +
         opt(schema.scope_version, "toString(ScopeVersion)", "''") + ", " +
         opt(schema.log_attributes, "toJSONString(LogAttributes)", "'{}'") + ", " +
         opt(schema.resource_attributes, "toJSONString(ResourceAttributes)", "'{}'") + ", " +
         opt(schema.scope_attributes, "toJSONString(ScopeAttributes)", "'{}'");
}

struct LogRow {
  int64_t ts_ns = 0;
  uint64_t tie = 0;
  std::string service, severity_text, body, trace_id, span_id, scope_name, scope_version;
  std::string log_attrs, resource_attrs, scope_attrs;
  int severity_number = 0;
  int64_t body_length = 0;
  int trace_flags = 0;
};

void read_rows(clickhouse::Client& client, const std::string& sql, std::vector<LogRow>* rows) {
  client.Select(sql, [&](const clickhouse::Block& block) {
    for (size_t r = 0; r < block.GetRowCount(); ++r) {
      LogRow row;
      parse_i64(ch_block_text_at(block, 0, r), &row.ts_ns);
      parse_u64(ch_block_text_at(block, 1, r), &row.tie);
      row.service = ch_block_text_at(block, 2, r);
      row.severity_text = ch_block_text_at(block, 3, r);
      int64_t sev = 0;
      parse_i64(ch_block_text_at(block, 4, r), &sev);
      row.severity_number = static_cast<int>(sev);
      row.body = ch_block_text_at(block, 5, r);
      parse_i64(ch_block_text_at(block, 6, r), &row.body_length);
      row.trace_id = ch_block_text_at(block, 7, r);
      row.span_id = ch_block_text_at(block, 8, r);
      int64_t flags = 0;
      parse_i64(ch_block_text_at(block, 9, r), &flags);
      row.trace_flags = static_cast<int>(flags);
      row.scope_name = ch_block_text_at(block, 10, r);
      row.scope_version = ch_block_text_at(block, 11, r);
      row.log_attrs = ch_block_text_at(block, 12, r);
      row.resource_attrs = ch_block_text_at(block, 13, r);
      row.scope_attrs = ch_block_text_at(block, 14, r);
      rows->push_back(std::move(row));
    }
  });
}

void write_raw_object(JsonWriter& w, const std::string& json) {
  if (json.size() >= 2 && json.front() == '{' && json.back() == '}') w.RawValue(json.c_str(), json.size(), rapidjson::kObjectType);
  else w.RawValue("{}", 2, rapidjson::kObjectType);
}

void write_row(JsonWriter& w, const LogRow& row) {
  w.StartObject();
  w.Key("id"); w.String(cursor_text(Cursor{row.ts_ns, row.tie}).c_str());
  w.Key("ts_ns"); w.String(std::to_string(row.ts_ns).c_str());
  w.Key("ts_ms"); w.Int64(row.ts_ns / 1000000);
  w.Key("service"); w.String(row.service.c_str());
  w.Key("severity_text"); w.String(row.severity_text.c_str());
  w.Key("severity_number"); w.Int(row.severity_number);
  w.Key("body"); w.String(row.body.c_str(), static_cast<rapidjson::SizeType>(row.body.size()));
  if (row.body_length > static_cast<int64_t>(kBodyMaxChars)) {
    w.Key("body_truncated"); w.Bool(true);
    w.Key("body_length"); w.Int64(row.body_length);
  }
  w.Key("trace_id"); w.String(row.trace_id.c_str());
  w.Key("span_id"); w.String(row.span_id.c_str());
  w.Key("trace_flags"); w.Int(row.trace_flags);
  w.Key("scope_name"); w.String(row.scope_name.c_str());
  w.Key("scope_version"); w.String(row.scope_version.c_str());
  w.Key("log_attributes"); write_raw_object(w, row.log_attrs);
  w.Key("resource_attributes"); write_raw_object(w, row.resource_attrs);
  w.Key("scope_attributes"); write_raw_object(w, row.scope_attrs);
  w.EndObject();
}

// Maps a ClickHouse failure to an HTTP answer.
void query_failed(httplib::Response& res, const std::string& what, const char* fallback_code) {
  if (what.find("TOO_MANY_ROWS") != std::string::npos || what.find("Limit for rows") != std::string::npos) {
    return json_error(res, 422, "logs_scan_limit",
                      "The logs query would read too many rows. Narrow the time range or add a service filter.");
  }
  if (what.find("TIMEOUT_EXCEEDED") != std::string::npos || what.find("Timeout exceeded") != std::string::npos) {
    return json_error(res, 504, "logs_timeout",
                      "The logs query exceeded its time limit. Narrow the time range or add filters.");
  }
  json_error(res, 503, fallback_code, what);
}

struct LogsRequest {
  const HostSpec* host = nullptr;
  std::string host_id;
  std::shared_ptr<clickhouse::Client> client;
  LogsSchema schema;
  LogsQuery query;
  std::string table;
};

// Shared prologue: config, host, client, schema, filters.
bool open_request(const AppConfig& cfg, const std::shared_ptr<ClickHouseClientPool>& pool, const httplib::Request& req,
                  httplib::Response& res, LogsRequest* out, bool need_range = true) {
  if (!cfg.logs.enabled) {
    json_error(res, 404, "logs_disabled", "OTel logs are disabled. Add logs { enabled = true } to the ChDash configuration.");
    return false;
  }
  out->host = logs_host(cfg, req, &out->host_id);
  if (!out->host) {
    json_error(res, 404, "unknown_host", "Logs source host is not configured.");
    return false;
  }
  std::string error;
  out->client = acquire_logs_client(*out->host, pool, &error);
  if (!out->client) {
    json_error(res, 503, "logs_source_unavailable", error.empty() ? "Cannot connect to the logs ClickHouse source." : error);
    return false;
  }
  try {
    out->schema = load_schema(*out->client, *out->host, cfg.logs);
  } catch (const std::exception& e) {
    if (pool) pool->invalidate(out->client);
    json_error(res, 503, "logs_schema_failed", e.what());
    return false;
  }
  if (!out->schema.exists) {
    json_error(res, 404, "logs_table_missing",
               "Table " + cfg.logs.database + "." + cfg.logs.table + " is missing or is not an OpenTelemetry exporter logs table.");
    return false;
  }
  std::string code, message;
  if (!build_filters(cfg, out->schema, req, &out->query, &code, &message, need_range)) {
    json_error(res, 400, code, message);
    return false;
  }
  out->table = quote_ident(cfg.logs.database) + "." + quote_ident(cfg.logs.table);
  return true;
}

bool substring_range_rejected(const LogsRequest& r, httplib::Response& res) {
  if (r.query.text_search && r.query.body_mode == "substring" && r.query.end_ms - r.query.start_ms > kSubstringMaxRangeMs) {
    json_error(res, 400, "logs_substring_range",
               "Substring Body search is limited to 6 hours for histograms and patterns (logs.body_search = \"substring\").");
    return true;
  }
  return false;
}

void write_text_search(JsonWriter& w, const LogsQuery& q) {
  w.Key("text_search");
  w.StartObject();
  w.Key("active"); w.Bool(q.text_search);
  w.Key("mode"); w.String(q.body_mode.c_str());
  w.Key("index_backed"); w.Bool(q.text_index_backed);
  w.EndObject();
}

// ---------------------------------------------------------------------------
// Histogram helpers.

int64_t choose_bucket_ms(int64_t range_ms, int target) {
  static const int64_t candidates[] = {
      1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000,
      3600000, 7200000, 10800000, 21600000, 43200000, 86400000, 172800000, 604800000};
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

// SQL for the bucket start (ms) of each row on the grid (origin, size).
std::string bucket_sql(const LogsSchema& schema, int64_t size, int64_t origin) {
  // Second-aligned grids bucket TimestampTime (4 bytes) instead of Timestamp.
  const std::string ms = schema.timestamp_time && size % 1000 == 0 && origin % 1000 == 0
      ? "(toInt64(toUnixTimestamp(TimestampTime)) * 1000)"
      : "toUnixTimestamp64Milli(Timestamp)";
  return std::to_string(origin) + " + intDiv(" + ms + " - " + std::to_string(origin) + ", " + std::to_string(size) +
         ") * " + std::to_string(size);
}

// ---------------------------------------------------------------------------
// Patterns: masking + a Drain port (He et al. 2017, as in HyperDX's
// common-utils/drain: depth 4, similarity 0.4, 100 children per node).

const std::string kParam = "<*>";

bool is_hex(char c) { return std::isxdigit(static_cast<unsigned char>(c)) != 0; }
bool is_digit(char c) { return c >= '0' && c <= '9'; }
bool is_word(char c) { return std::isalnum(static_cast<unsigned char>(c)) != 0 || c == '_'; }

// Replaces variable parts with <*>: quoted strings, UUIDs, long hex ids,
// IPv4 addresses and numbers that are not glued to a word (v1 stays).
std::string mask_body(std::string_view body) {
  std::string out;
  out.reserve(std::min<size_t>(body.size(), 2048));
  const size_t n = std::min<size_t>(body.size(), 2048);
  size_t i = 0;
  const auto emit_param = [&]() {
    if (out.size() < kParam.size() || out.compare(out.size() - kParam.size(), kParam.size(), kParam) != 0) out += kParam;
  };
  while (i < n) {
    const char c = body[i];
    if ((c == '"' || c == '\'') && (i == 0 || !is_word(body[i - 1]))) {
      const size_t close = body.find(c, i + 1);
      if (close != std::string_view::npos && close < n && close - i <= 256) {
        emit_param();
        i = close + 1;
        continue;
      }
    }
    if (is_hex(c) && (i == 0 || !is_word(body[i - 1]))) {
      // Run of hex digits and dashes (UUIDs, trace ids, traceparent parts).
      size_t j = i;
      size_t hex_count = 0;
      bool digit = false, dash = false;
      while (j < n && (is_hex(body[j]) || body[j] == '-')) {
        if (body[j] == '-') dash = true;
        else ++hex_count;
        if (is_digit(body[j])) digit = true;
        ++j;
      }
      if (hex_count >= 8 && digit && (j == n || !is_word(body[j]))) {
        (void)dash;
        emit_param();
        i = j;
        continue;
      }
    }
    if (is_digit(c) && (i == 0 || !std::isalpha(static_cast<unsigned char>(body[i - 1])))) {
      size_t j = i;
      while (j < n && (is_digit(body[j]) || (body[j] == '.' && j + 1 < n && is_digit(body[j + 1])))) ++j;
      if (j == n || !std::isalpha(static_cast<unsigned char>(body[j]))) {
        emit_param();
        i = j;
        continue;
      }
      out.append(body.substr(i, j - i));
      i = j;
      continue;
    }
    out.push_back(c);
    ++i;
  }
  return out;
}

std::vector<std::string> whitespace_tokens(const std::string& text) {
  std::vector<std::string> out;
  std::string current;
  for (char c : text) {
    if (std::isspace(static_cast<unsigned char>(c))) {
      if (!current.empty()) out.push_back(std::move(current));
      current.clear();
    } else {
      current.push_back(c);
    }
  }
  if (!current.empty()) out.push_back(std::move(current));
  if (out.size() > 64) out.resize(64);
  return out;
}

struct Cluster {
  std::vector<std::string> tokens;
  size_t size = 0;
  std::string sample;
  std::vector<uint32_t> buckets;
  std::map<std::string, size_t> services;
  size_t severity[4] = {0, 0, 0, 0};
};

struct DrainNode {
  std::map<std::string, std::unique_ptr<DrainNode>> children;
  std::vector<size_t> clusters;
};

class Drain {
 public:
  static constexpr int kDepth = 4;
  static constexpr double kSimilarity = 0.4;
  static constexpr size_t kMaxChildren = 100;

  size_t add(const std::vector<std::string>& tokens) {
    DrainNode* leaf = descend(tokens, false);
    if (leaf) {
      const size_t match = best_match(*leaf, tokens);
      if (match != SIZE_MAX) {
        Cluster& c = clusters_[match];
        for (size_t i = 0; i < c.tokens.size(); ++i) {
          if (c.tokens[i] != tokens[i]) c.tokens[i] = kParam;
        }
        ++c.size;
        return match;
      }
    }
    clusters_.push_back(Cluster{tokens, 1, {}, {}, {}, {0, 0, 0, 0}});
    const size_t id = clusters_.size() - 1;
    descend(tokens, true)->clusters.push_back(id);
    return id;
  }

  std::vector<Cluster>& clusters() { return clusters_; }

 private:
  static bool has_digit(const std::string& token) {
    return std::any_of(token.begin(), token.end(), is_digit);
  }

  // Root -> token count -> first (depth - 2) tokens -> leaf cluster list.
  DrainNode* descend(const std::vector<std::string>& tokens, bool create) {
    const std::string length_key = std::to_string(tokens.size());
    auto it = root_.children.find(length_key);
    if (it == root_.children.end()) {
      if (!create) return nullptr;
      it = root_.children.emplace(length_key, std::make_unique<DrainNode>()).first;
    }
    DrainNode* node = it->second.get();
    int depth = 1;
    for (const auto& token : tokens) {
      if (depth >= kDepth - 2 || depth >= static_cast<int>(tokens.size())) break;
      auto child = node->children.find(token);
      if (child != node->children.end()) {
        node = child->second.get();
      } else if (!create) {
        auto wildcard = node->children.find(kParam);
        if (wildcard == node->children.end()) return nullptr;
        node = wildcard->second.get();
      } else {
        const bool wildcard_exists = node->children.count(kParam) > 0;
        std::string key = token;
        if (has_digit(token) || token == kParam) key = kParam;
        else if (wildcard_exists ? node->children.size() >= kMaxChildren : node->children.size() + 1 >= kMaxChildren) key = kParam;
        auto& slot = node->children[key];
        if (!slot) slot = std::make_unique<DrainNode>();
        node = slot.get();
      }
      ++depth;
    }
    return node;
  }

  size_t best_match(const DrainNode& leaf, const std::vector<std::string>& tokens) const {
    double best_similarity = -1;
    int best_params = -1;
    size_t best = SIZE_MAX;
    for (size_t id : leaf.clusters) {
      const Cluster& c = clusters_[id];
      if (c.tokens.size() != tokens.size()) continue;
      size_t same = 0;
      int params = 0;
      for (size_t i = 0; i < tokens.size(); ++i) {
        if (c.tokens[i] == kParam) ++params;
        else if (c.tokens[i] == tokens[i]) ++same;
      }
      const double similarity = tokens.empty() ? 1.0 : static_cast<double>(same) / static_cast<double>(tokens.size());
      if (similarity > best_similarity || (similarity == best_similarity && params > best_params)) {
        best_similarity = similarity;
        best_params = params;
        best = id;
      }
    }
    return best_similarity >= kSimilarity ? best : SIZE_MAX;
  }

  DrainNode root_;
  std::vector<Cluster> clusters_;
};

// The constant words of a template as a token search: "<*>" parts dropped,
// "key=user:<*>" kept as the term "key=user:".
std::string pattern_search_text(const std::vector<std::string>& tokens) {
  std::string out;
  size_t terms = 0;
  for (const auto& token : tokens) {
    size_t start = 0;
    while (start <= token.size() && terms < kMaxTextTerms) {
      const size_t at = token.find(kParam, start);
      const std::string piece = token.substr(start, at == std::string::npos ? std::string::npos : at - start);
      if (!split_tokens(piece).empty()) {
        const bool needs_quotes = piece.find('"') == std::string::npos && piece.front() == '-';
        if (!out.empty()) out.push_back(' ');
        out += needs_quotes ? "\"" + piece + "\"" : piece;
        ++terms;
      }
      if (at == std::string::npos) break;
      start = at + kParam.size();
    }
  }
  return out;
}

int severity_index(int number) {
  if (number >= 17) return 0;
  if (number >= 13) return 1;
  if (number >= 9) return 2;
  return 3;
}

} // namespace

// ---------------------------------------------------------------------------

void Server::handle_logs_search(const httplib::Request& req, httplib::Response& res) {
  const auto started = Clock::now();
  LogsRequest r;
  if (!open_request(cfg_, client_pool_, req, res, &r)) return;
  const LogsQuery& q = r.query;
  const size_t limit = static_cast<size_t>(int_param(req, "limit", static_cast<int>(cfg_.logs.search_limit), 1,
                                                     static_cast<int>(cfg_.logs.search_limit)));
  const std::string tie = tiebreak_expr(r.schema);
  const int64_t range_lo_ns = q.start_ms * 1000000;
  const int64_t range_hi_ns = q.end_ms * 1000000 + 999999;

  Cursor cursor;
  const bool has_cursor = !param(req, "cursor").empty();
  if (has_cursor && !parse_cursor(param(req, "cursor"), &cursor)) {
    return json_error(res, 400, "invalid_logs_cursor", "cursor must be <timestamp_ns>-<tiebreak>.");
  }
  // No live tail: a former client's after=<row id> is ignored (a page).

  struct WindowStat { int64_t lo_ns, hi_ns; size_t rows; int64_t ms; };
  std::vector<WindowStat> windows;
  std::vector<LogRow> rows;
  bool exhausted = false;
  bool budget_hit = false;
  int64_t scanned_lo_ns = range_hi_ns;
  const std::string columns = row_columns(r.schema);

  try {
    int64_t hi_ns = has_cursor ? std::min(range_hi_ns, cursor.ts_ns) : range_hi_ns;
    const bool substring = q.text_search && q.body_mode == "substring";
    size_t index = 0;
    bool first = true;
    while (rows.size() < limit) {
      if (hi_ns < range_lo_ns) { exhausted = true; break; }
      if (!first && elapsed_ms(started) > kSearchBudgetMs) { budget_hit = true; break; }
      const size_t count = sizeof(kSearchWindowsSeconds) / sizeof(kSearchWindowsSeconds[0]);
      const int64_t size_s = substring ? kSubstringWindowSeconds : kSearchWindowsSeconds[std::min(index, count - 1)];
      const int64_t lo_ns = std::max<int64_t>(range_lo_ns, hi_ns - size_s * int64_t{1000000000} + 1);
      std::string predicate = time_predicate(r.schema, lo_ns, hi_ns);
      if (first && has_cursor) predicate += " AND " + keyset_predicate(tie, cursor, true);
      const auto t0 = Clock::now();
      const size_t before = rows.size();
      const std::string sql = "SELECT " + columns + " FROM " + r.table + " WHERE " + predicate + q.where +
          " ORDER BY Timestamp DESC, " + tie + " DESC LIMIT " + std::to_string(limit - rows.size()) + settings_clause();
      read_rows(*r.client, sql, &rows);
      windows.push_back({lo_ns, hi_ns, rows.size() - before, elapsed_ms(t0)});
      scanned_lo_ns = lo_ns;
      hi_ns = lo_ns - 1;
      first = false;
      ++index;
    }
    if (rows.size() < limit && hi_ns < range_lo_ns) exhausted = true;
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(r.client);
    return query_failed(res, e.what(), "logs_search_failed");
  }

  // Next page: after the last row when the page is full, else from where the
  // windows stopped (rows at scanned_lo_ns were read: continue strictly below).
  std::string next_cursor;
  if (!exhausted) {
    next_cursor = rows.size() >= limit ? cursor_text(Cursor{rows.back().ts_ns, rows.back().tie})
                                       : cursor_text(Cursor{scanned_lo_ns, 0});
  }

  rapidjson::StringBuffer sb(nullptr, 256 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(r.host_id.c_str());
  w.Key("range"); w.StartArray(); w.Int64(q.start_ms); w.Int64(q.end_ms); w.EndArray();
  w.Key("limit"); w.Uint64(limit);
  w.Key("mode"); w.String("page");
  w.Key("rows"); w.StartArray();
  for (const auto& row : rows) write_row(w, row);
  w.EndArray();
  w.Key("row_count"); w.Uint64(rows.size());
  w.Key("next_cursor");
  if (next_cursor.empty()) w.Null(); else w.String(next_cursor.c_str());
  w.Key("exhausted"); w.Bool(exhausted);
  w.Key("truncated"); w.Bool(!exhausted);
  w.Key("budget_exhausted"); w.Bool(budget_hit);
  w.Key("scanned_from_ms"); w.Int64(scanned_lo_ns / 1000000);
  write_text_search(w, q);
  w.Key("windows"); w.StartArray();
  for (const auto& win : windows) {
    w.StartObject();
    w.Key("start_ms"); w.Int64(win.lo_ns / 1000000);
    w.Key("end_ms"); w.Int64(win.hi_ns / 1000000);
    w.Key("rows"); w.Uint64(win.rows);
    w.Key("ms"); w.Int64(win.ms);
    w.EndObject();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject(); w.Key("total"); w.Int64(elapsed_ms(started)); w.EndObject();
  w.EndObject();
  send_json(res, sb);
}

void Server::handle_logs_histogram(const httplib::Request& req, httplib::Response& res) {
  const auto started = Clock::now();
  LogsRequest r;
  if (!open_request(cfg_, client_pool_, req, res, &r)) return;
  if (substring_range_rejected(r, res)) return;
  const LogsQuery& q = r.query;
  const int target = int_param(req, "buckets", 80, 10, 300);
  const int64_t bucket_ms = choose_bucket_ms(q.end_ms - q.start_ms, target);
  // Buckets lie on a grid anchored at bucket_origin_ms (the browser's local
  // midnight), as in the Traces analytics; only origin mod size matters.
  int64_t origin = 0;
  parse_i64(param(req, "bucket_origin_ms"), &origin);
  origin = ((origin % bucket_ms) + bucket_ms) % bucket_ms;

  struct Bucket { int64_t t; uint64_t c[4]; };
  std::vector<Bucket> buckets;
  uint64_t totals[4] = {0, 0, 0, 0};
  try {
    const std::string sql = "SELECT toString(" + bucket_sql(r.schema, bucket_ms, origin) + ") AS b, "
        "toString(countIf(SeverityNumber >= 17)), toString(countIf(SeverityNumber >= 13 AND SeverityNumber < 17)), "
        "toString(countIf(SeverityNumber >= 9 AND SeverityNumber < 13)), toString(countIf(SeverityNumber < 9)) FROM " +
        r.table + " WHERE " + time_predicate(r.schema, q.start_ms * 1000000, q.end_ms * 1000000 + 999999) + q.where +
        " GROUP BY b ORDER BY toInt64(b)" + settings_clause();
    r.client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        Bucket b{};
        parse_i64(ch_block_text_at(block, 0, row), &b.t);
        for (int k = 0; k < 4; ++k) {
          parse_u64(ch_block_text_at(block, static_cast<size_t>(k + 1), row), &b.c[k]);
          totals[k] += b.c[k];
        }
        buckets.push_back(b);
      }
    });
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(r.client);
    return query_failed(res, e.what(), "logs_histogram_failed");
  }

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(r.host_id.c_str());
  w.Key("range"); w.StartArray(); w.Int64(q.start_ms); w.Int64(q.end_ms); w.EndArray();
  w.Key("grid_start_ms"); w.Int64(grid_floor(q.start_ms, bucket_ms, origin));
  w.Key("bucket_ms"); w.Int64(bucket_ms);
  w.Key("bucket_origin_ms"); w.Int64(origin);
  w.Key("classes"); w.StartArray();
  for (const auto& s : kSeverityClasses) w.String(s.name);
  w.EndArray();
  w.Key("buckets"); w.StartArray();
  for (const auto& b : buckets) {
    w.StartArray(); w.Int64(b.t);
    for (int k = 0; k < 4; ++k) w.Uint64(b.c[k]);
    w.EndArray();
  }
  w.EndArray();
  w.Key("totals"); w.StartObject();
  uint64_t total = 0;
  for (int k = 0; k < 4; ++k) {
    w.Key(kSeverityClasses[k].name); w.Uint64(totals[k]);
    total += totals[k];
  }
  w.Key("total"); w.Uint64(total);
  w.EndObject();
  write_text_search(w, q);
  w.Key("timing_ms"); w.StartObject(); w.Key("total"); w.Int64(elapsed_ms(started)); w.EndObject();
  w.EndObject();
  send_json(res, sb);
}

void Server::handle_logs_context(const httplib::Request& req, httplib::Response& res) {
  const auto started = Clock::now();
  LogsRequest r;
  // Context ignores the search filters: only the preset narrows it.
  if (!cfg_.logs.enabled) {
    return json_error(res, 404, "logs_disabled", "OTel logs are disabled. Add logs { enabled = true } to the ChDash configuration.");
  }
  httplib::Request bare;
  bare.params.emplace("host_id", param(req, "host_id"));
  if (!open_request(cfg_, client_pool_, bare, res, &r, false)) return;

  int64_t ts_ns = 0;
  if (!parse_i64(param(req, "ts_ns"), &ts_ns) || ts_ns <= 0) {
    return json_error(res, 400, "invalid_logs_context", "ts_ns (record timestamp in nanoseconds) is required.");
  }
  uint64_t anchor_tie = 0;
  const bool has_tie = parse_u64(param(req, "tie"), &anchor_tie);
  const std::string preset = param(req, "preset").empty() ? "anything" : param(req, "preset");
  const int64_t window_ms = int_param(req, "window_ms", 5 * 60 * 1000, 1000, 60 * 60 * 1000);
  const size_t limit = static_cast<size_t>(int_param(req, "limit", 50, 1, 200));

  std::string filter = " AND " + service_allowlist_predicate(cfg_.traces);
  if (preset == "service") {
    const std::string service = param(req, "service");
    if (service.empty()) return json_error(res, 400, "invalid_logs_context", "preset=service needs service.");
    filter += " AND ServiceName = " + quote(service);
  } else if (preset == "host") {
    const std::string host = param(req, "host");
    if (host.empty() || !r.schema.resource_attributes) {
      return json_error(res, 400, "invalid_logs_context", "preset=host needs host (ResourceAttributes host.name).");
    }
    filter += " AND ResourceAttributes['host.name'] = " + quote(host);
  } else if (preset == "trace") {
    const std::string trace_id = param(req, "trace_id");
    if (!r.schema.trace_id || !valid_hex_id(trace_id, 64)) {
      return json_error(res, 400, "invalid_logs_context", "preset=trace needs a hexadecimal trace_id.");
    }
    filter += " AND TraceId = " + quote(trace_id);
  } else if (preset != "anything") {
    return json_error(res, 400, "invalid_logs_context", "preset must be anything, service, host or trace.");
  }

  const std::string tie = tiebreak_expr(r.schema);
  const std::string columns = row_columns(r.schema);
  const int64_t delta_ns = window_ms * 1000000;
  std::vector<LogRow> older, newer;
  try {
    // Older records: [ts - window, anchor), newest first.
    const std::string older_key = has_tie ? keyset_predicate(tie, Cursor{ts_ns, anchor_tie}, true)
                                          : "Timestamp < " + ts_literal(ts_ns);
    read_rows(*r.client, "SELECT " + columns + " FROM " + r.table + " WHERE " +
                  time_predicate(r.schema, std::max<int64_t>(0, ts_ns - delta_ns), ts_ns) + " AND " + older_key + filter +
                  " ORDER BY Timestamp DESC, " + tie + " DESC LIMIT " + std::to_string(limit + 1) + settings_clause(),
              &older);
    // The anchor and newer records: [anchor, ts + window], oldest first.
    const std::string newer_key = has_tie
        ? "(" + keyset_predicate(tie, Cursor{ts_ns, anchor_tie}, false) + " OR (Timestamp = " + ts_literal(ts_ns) +
              " AND " + tie + " = " + std::to_string(anchor_tie) + "))"
        : "Timestamp >= " + ts_literal(ts_ns);
    read_rows(*r.client, "SELECT " + columns + " FROM " + r.table + " WHERE " +
                  time_predicate(r.schema, ts_ns, ts_ns + delta_ns) + " AND " + newer_key + filter +
                  " ORDER BY Timestamp ASC, " + tie + " ASC LIMIT " + std::to_string(limit + 2) + settings_clause(),
              &newer);
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(r.client);
    return query_failed(res, e.what(), "logs_context_failed");
  }
  const bool more_before = older.size() > limit;
  if (more_before) older.resize(limit);
  bool anchor_found = false;
  for (const auto& row : newer) {
    if (has_tie && row.ts_ns == ts_ns && row.tie == anchor_tie) anchor_found = true;
  }
  const size_t newer_limit = limit + (anchor_found ? 1 : 0);
  const bool more_after = newer.size() > newer_limit;
  if (more_after) newer.resize(newer_limit);

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(r.host_id.c_str());
  w.Key("preset"); w.String(preset.c_str());
  w.Key("window_ms"); w.Int64(window_ms);
  w.Key("range"); w.StartArray(); w.Int64((ts_ns - delta_ns) / 1000000); w.Int64((ts_ns + delta_ns) / 1000000); w.EndArray();
  w.Key("anchor_id");
  if (has_tie) w.String(cursor_text(Cursor{ts_ns, anchor_tie}).c_str()); else w.Null();
  w.Key("anchor_found"); w.Bool(anchor_found);
  w.Key("rows"); w.StartArray();
  for (auto it = newer.rbegin(); it != newer.rend(); ++it) write_row(w, *it);
  for (const auto& row : older) write_row(w, row);
  w.EndArray();
  w.Key("before_count"); w.Uint64(older.size());
  w.Key("after_count"); w.Uint64(newer.size() - (anchor_found ? 1 : 0));
  w.Key("more_before"); w.Bool(more_before);
  w.Key("more_after"); w.Bool(more_after);
  w.Key("timing_ms"); w.StartObject(); w.Key("total"); w.Int64(elapsed_ms(started)); w.EndObject();
  w.EndObject();
  send_json(res, sb);
}

void Server::handle_logs_patterns(const httplib::Request& req, httplib::Response& res) {
  const auto started = Clock::now();
  LogsRequest r;
  if (!open_request(cfg_, client_pool_, req, res, &r)) return;
  if (substring_range_rejected(r, res)) return;
  const LogsQuery& q = r.query;
  const size_t sample_target = static_cast<size_t>(int_param(req, "sample", 10000, 100, 20000));
  const int sparkline_buckets = int_param(req, "buckets", 24, 4, 120);
  const size_t max_patterns = static_cast<size_t>(int_param(req, "max_patterns", 200, 1, 1000));
  const std::string where = " WHERE " + time_predicate(r.schema, q.start_ms * 1000000, q.end_ms * 1000000 + 999999) + q.where;

  uint64_t total = 0;
  struct SampleRow { int64_t ts_ms; int severity; std::string service; std::string body; };
  std::vector<SampleRow> sample;
  std::string method = "all";
  uint64_t rate_ppm = 1000000;
  int64_t count_ms = 0, sample_ms = 0;
  try {
    auto t0 = Clock::now();
    r.client->Select("SELECT toString(count()) FROM " + r.table + where + settings_clause(),
                     [&](const clickhouse::Block& block) {
                       if (block.GetRowCount()) parse_u64(ch_block_text_at(block, 0, 0), &total);
                     });
    count_ms = elapsed_ms(t0);
    std::string sample_where = where;
    size_t fetch_limit = sample_target;
    if (total > sample_target) {
      // Deterministic block sample: whole 64-row blocks picked by a hash of
      // (part, block). Only the filter columns are read for every row; Body
      // is read for the granules holding a picked block (~1/5 of the bytes
      // of ORDER BY rand() on the test fixture).
      method = "block_hash";
      rate_ppm = std::max<uint64_t>(1, static_cast<uint64_t>(std::ceil(1e6 * static_cast<double>(sample_target) /
                                                                       static_cast<double>(total))));
      sample_where += " AND cityHash64(_part, intDiv(_part_offset, 64)) % 1000000 < " + std::to_string(rate_ppm);
      fetch_limit = sample_target * 2;
    }
    t0 = Clock::now();
    r.client->Select("SELECT toString(toUnixTimestamp64Milli(Timestamp)), toString(SeverityNumber), toString(ServiceName), "
                     "substringUTF8(Body, 1, 2048) FROM " + r.table + sample_where + " LIMIT " + std::to_string(fetch_limit) +
                     settings_clause(),
                     [&](const clickhouse::Block& block) {
                       for (size_t row = 0; row < block.GetRowCount(); ++row) {
                         SampleRow s;
                         parse_i64(ch_block_text_at(block, 0, row), &s.ts_ms);
                         int64_t sev = 0;
                         parse_i64(ch_block_text_at(block, 1, row), &sev);
                         s.severity = static_cast<int>(sev);
                         s.service = ch_block_text_at(block, 2, row);
                         s.body = ch_block_text_at(block, 3, row);
                         sample.push_back(std::move(s));
                       }
                     });
    sample_ms = elapsed_ms(t0);
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(r.client);
    return query_failed(res, e.what(), "logs_patterns_failed");
  }
  // An overshooting block sample is thinned evenly to the target size.
  if (sample.size() > sample_target) {
    std::vector<SampleRow> thinned;
    thinned.reserve(sample_target);
    const double step = static_cast<double>(sample.size()) / static_cast<double>(sample_target);
    for (size_t i = 0; i < sample_target; ++i) thinned.push_back(std::move(sample[static_cast<size_t>(i * step)]));
    sample.swap(thinned);
  }

  const auto mine_started = Clock::now();
  Drain drain;
  const int64_t span_ms = std::max<int64_t>(1, q.end_ms - q.start_ms);
  for (const auto& row : sample) {
    const size_t id = drain.add(whitespace_tokens(mask_body(row.body)));
    Cluster& c = drain.clusters()[id];
    if (c.sample.empty()) c.sample = row.body;
    if (c.buckets.empty()) c.buckets.assign(static_cast<size_t>(sparkline_buckets), 0);
    const int64_t offset = std::min<int64_t>(span_ms - 1, std::max<int64_t>(0, row.ts_ms - q.start_ms));
    ++c.buckets[static_cast<size_t>(offset * sparkline_buckets / span_ms)];
    ++c.services[row.service];
    ++c.severity[severity_index(row.severity)];
  }
  // Templates that converged to the same text are one pattern.
  struct Pattern { std::string text; Cluster* cluster; size_t size; std::vector<uint32_t> buckets; };
  std::map<std::string, size_t> by_text;
  std::vector<Pattern> patterns;
  for (auto& c : drain.clusters()) {
    std::string text;
    for (size_t i = 0; i < c.tokens.size(); ++i) text += (i ? " " : "") + c.tokens[i];
    const auto it = by_text.find(text);
    if (it == by_text.end()) {
      by_text[text] = patterns.size();
      patterns.push_back(Pattern{text, &c, c.size, c.buckets});
    } else {
      Pattern& p = patterns[it->second];
      p.size += c.size;
      for (size_t i = 0; i < p.buckets.size() && i < c.buckets.size(); ++i) p.buckets[i] += c.buckets[i];
      for (const auto& [service, n] : c.services) p.cluster->services[service] += n;
      for (int k = 0; k < 4; ++k) p.cluster->severity[k] += c.severity[k];
    }
  }
  std::sort(patterns.begin(), patterns.end(), [](const Pattern& a, const Pattern& b) {
    return a.size != b.size ? a.size > b.size : a.text < b.text;
  });
  const size_t pattern_count = patterns.size();
  if (patterns.size() > max_patterns) patterns.resize(max_patterns);
  const double scale = sample.empty() ? 0.0 : static_cast<double>(total) / static_cast<double>(sample.size());
  const int64_t mine_ms = elapsed_ms(mine_started);

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(r.host_id.c_str());
  w.Key("range"); w.StartArray(); w.Int64(q.start_ms); w.Int64(q.end_ms); w.EndArray();
  w.Key("total"); w.Uint64(total);
  w.Key("sample_size"); w.Uint64(sample.size());
  w.Key("sample_target"); w.Uint64(sample_target);
  w.Key("sampled"); w.Bool(sample.size() < total);
  w.Key("sample_method"); w.String(method.c_str());
  w.Key("sample_rate_ppm"); w.Uint64(rate_ppm);
  w.Key("scale"); w.Double(scale);
  w.Key("noise_share"); w.Double(0.10);
  w.Key("pattern_count"); w.Uint64(pattern_count);
  w.Key("sparkline_buckets"); w.Int(sparkline_buckets);
  w.Key("sparkline_bucket_ms"); w.Double(static_cast<double>(span_ms) / sparkline_buckets);
  write_text_search(w, q);
  w.Key("patterns"); w.StartArray();
  for (const auto& p : patterns) {
    const double share = sample.empty() ? 0.0 : static_cast<double>(p.size) / static_cast<double>(sample.size());
    w.StartObject();
    w.Key("pattern"); w.String(p.text.c_str());
    w.Key("sample_count"); w.Uint64(p.size);
    w.Key("count"); w.Uint64(static_cast<uint64_t>(std::llround(static_cast<double>(p.size) * scale)));
    w.Key("share"); w.Double(share);
    w.Key("noisy"); w.Bool(share > 0.10);
    w.Key("sample"); w.String(p.cluster->sample.c_str());
    w.Key("search"); w.String(pattern_search_text(p.cluster->tokens).c_str());
    std::string top_service;
    size_t top_n = 0;
    for (const auto& [service, n] : p.cluster->services) {
      if (n > top_n) { top_n = n; top_service = service; }
    }
    w.Key("service"); w.String(top_service.c_str());
    w.Key("service_count"); w.Uint64(p.cluster->services.size());
    int top_severity = 3;
    for (int k = 0; k < 4; ++k) {
      if (p.cluster->severity[k] > p.cluster->severity[top_severity]) top_severity = k;
    }
    w.Key("severity"); w.String(kSeverityClasses[top_severity].name);
    w.Key("sparkline"); w.StartArray();
    for (uint32_t n : p.buckets) w.Uint64(static_cast<uint64_t>(std::llround(n * scale)));
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("count"); w.Int64(count_ms);
  w.Key("sample"); w.Int64(sample_ms);
  w.Key("mine"); w.Int64(mine_ms);
  w.Key("total"); w.Int64(elapsed_ms(started));
  w.EndObject();
  w.EndObject();
  send_json(res, sb);
}

// Service names with records in the range (allowlist applied, other filters
// ignored): the service picker's choices. ServiceName leads the sorting key,
// so this reads one LowCardinality column.
void Server::handle_logs_services(const httplib::Request& req, httplib::Response& res) {
  const auto started = Clock::now();
  LogsRequest r;
  httplib::Request bare;
  for (const char* key : {"host_id", "start_ms", "end_ms", "lookback_minutes"}) {
    if (req.has_param(key)) bare.params.emplace(key, req.get_param_value(key));
  }
  if (!open_request(cfg_, client_pool_, bare, res, &r)) return;
  const LogsQuery& q = r.query;
  std::vector<std::pair<std::string, uint64_t>> services;
  try {
    r.client->Select("SELECT toString(ServiceName), toString(count()) FROM " + r.table + " WHERE " +
                         time_predicate(r.schema, q.start_ms * 1000000, q.end_ms * 1000000 + 999999) + q.where +
                         " GROUP BY ServiceName ORDER BY ServiceName LIMIT 1000" + settings_clause(),
                     [&](const clickhouse::Block& block) {
                       for (size_t row = 0; row < block.GetRowCount(); ++row) {
                         uint64_t n = 0;
                         parse_u64(ch_block_text_at(block, 1, row), &n);
                         services.emplace_back(ch_block_text_at(block, 0, row), n);
                       }
                     });
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(r.client);
    return query_failed(res, e.what(), "logs_services_failed");
  }
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(r.host_id.c_str());
  w.Key("range"); w.StartArray(); w.Int64(q.start_ms); w.Int64(q.end_ms); w.EndArray();
  w.Key("services"); w.StartArray();
  for (const auto& [name, n] : services) {
    w.StartObject();
    w.Key("name"); w.String(name.c_str());
    w.Key("count"); w.Uint64(n);
    w.EndObject();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject(); w.Key("total"); w.Int64(elapsed_ms(started)); w.EndObject();
  w.EndObject();
  send_json(res, sb);
}

namespace {

// ---------------------------------------------------------------------------
// Fields facets (/api/logs/facets and /api/logs/facet_values): the Logs Fields
// panel, the Traces attribute facets' component, sampled and capped like them
// (facet_limits.hpp). Scopes: "log", "resource" and "scope" (the LogAttributes
// / ResourceAttributes / ScopeAttributes maps, Map columns only) and "column"
// (the record columns below: the ones a key=value filter compares, minus the
// unique TraceId / SpanId).

const char* const kFacetColumns[] = {"ServiceName", "SeverityText", "ScopeName", "ScopeVersion"};

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

bool top_level_column(const std::string& key) {
  return std::any_of(std::begin(kTopLevelColumns), std::end(kTopLevelColumns), [&](const char* c) { return key == c; });
}

struct LogFacetKeys {
  struct Key { std::string scope, key; uint64_t count = 0; };
  std::vector<Key> keys;
  uint64_t sampled = 0;
  bool estimated = false;
  bool timed_out = false;
  uint64_t query_ms = 0;
};

struct LogFacetValues {
  std::vector<std::pair<std::string, uint64_t>> values;
  uint64_t with_key = 0;
  uint64_t distinct_values = 0;
  bool estimated = false;
  bool timed_out = false;
  uint64_t query_ms = 0;
};

StaleCache<std::string, LogFacetKeys> g_log_facet_keys_cache;
StaleCache<std::string, LogFacetValues> g_log_facet_values_cache;

// The key of an attr filter ("k=v" / "k!=v"), or "" when malformed.
std::string attr_filter_key(const std::string& raw) {
  const size_t eq = raw.find('=');
  if (eq == std::string::npos || eq == 0) return {};
  return raw.substr(0, raw[eq - 1] == '!' ? eq - 1 : eq);
}

// The request without the filters on the field (scope, key) itself, so the
// field's values ignore its own filters: its other values stay listed (and
// can be added). A bare key filters both LogAttributes and
// ResourceAttributes, so it counts as either map's own filter.
httplib::Request without_own_filters(const httplib::Request& req, const std::string& scope, const std::string& key) {
  httplib::Request out;
  const char* map = facet_map_column(scope);
  for (const auto& [name, value] : req.params) {
    if (scope == "column" && key == "ServiceName" && name == "service") continue;
    if (name == "attr") {
      const std::string k = attr_filter_key(value);
      const bool own = scope == "column"
          ? k == key
          : k == std::string(map) + "." + key || (k == key && scope != "scope" && !top_level_column(k));
      if (own) continue;
    }
    out.params.emplace(name, value);
  }
  return out;
}

// The minute-aligned window a facet request scans (requests made within the
// same minute share one cached scan), [start, end] inclusive.
struct FacetWindow {
  int64_t start_ms = 0, end_ms = 0;
};

FacetWindow facet_window(const LogsQuery& q) {
  constexpr int64_t kAlignMs = 60 * 1000;
  return FacetWindow{(q.start_ms / kAlignMs) * kAlignMs, ((q.end_ms + kAlignMs - 1) / kAlignMs) * kAlignMs};
}

std::string facet_where(const LogsRequest& r, const FacetWindow& win) {
  return " WHERE " + time_predicate(r.schema, win.start_ms * 1000000, win.end_ms * 1000000) + r.query.where;
}

void write_facet_common(JsonWriter& w, const LogsRequest& r, const FacetWindow& win, bool estimated, bool timed_out_flag,
                        uint64_t query_ms, bool cached) {
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(r.host_id.c_str());
  w.Key("range"); w.StartArray(); w.Int64(r.query.start_ms); w.Int64(r.query.end_ms); w.EndArray();
  w.Key("scanned_range"); w.StartArray(); w.Int64(win.start_ms); w.Int64(win.end_ms); w.EndArray();
  w.Key("estimated"); w.Bool(estimated);
  w.Key("timed_out"); w.Bool(timed_out_flag);
  w.Key("sample_limit"); w.Uint64(kFacetSampleRows);
  w.Key("read_rows_limit"); w.Uint64(kFacetReadRowsCap);
  w.Key("cached"); w.Bool(cached);
  write_text_search(w, r.query);
  w.Key("timing_ms"); w.StartObject(); w.Key("query"); w.Uint64(query_ms); w.EndObject();
}

std::string join_sql(const std::vector<std::string>& parts) {
  std::string out;
  for (size_t i = 0; i < parts.size(); ++i) out += (i ? ", " : "") + parts[i];
  return out;
}

int facet_scope_rank(const std::string& scope) {
  if (scope == "column") return 0;
  if (scope == "log") return 1;
  if (scope == "resource") return 2;
  return 3;
}

} // namespace

// Field keys of the records matching the filters (attribute map keys and the
// record columns), by the number of sampled records carrying them. One capped
// pass reads only the maps' key subcolumns and the columns.
void Server::handle_logs_facets(const httplib::Request& req, httplib::Response& res) {
  LogsRequest r;
  if (!open_request(cfg_, client_pool_, req, res, &r)) return;
  if (substring_range_rejected(r, res)) return;
  const FacetWindow win = facet_window(r.query);
  std::vector<std::string> scopes;
  for (const char* scope : {"log", "resource", "scope"}) {
    if (facet_map_present(r.schema, scope)) scopes.emplace_back(scope);
  }
  std::vector<std::string> columns;
  for (const char* column : kFacetColumns) {
    if (facet_column_present(r.schema, column)) columns.emplace_back(column);
  }
  std::string shape;
  for (const auto& scope : scopes) shape += scope + ",";
  for (const auto& column : columns) shape += column + ",";
  const std::string cache_key = r.host_id + '\0' + r.table + '\0' + std::to_string(win.start_ms) + '\0' +
      std::to_string(win.end_ms) + '\0' + shape + '\0' + r.query.where;
  bool fetched = false;
  auto cached = g_log_facet_keys_cache.get_or_refresh(
      cache_key, static_cast<uint64_t>(now_ms()), kFacetTtlMs, 5000,
      [&](LogFacetKeys& value, std::string& code, std::string& message) {
        fetched = true;
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
          column_tuples.push_back("tuple('column', " + quote(columns[i]) + ", " + n + ")");
        }
        tuples.push_back("[" + join_sql(column_tuples) + "]");
        const std::string sql =
            "SELECT toString(sampled), toString(t.1), toString(t.2), toString(t.3) FROM ("
            "SELECT count() AS sampled, " + join_sql(aggregates) + " FROM ("
            "SELECT " + join_sql(inner) + " FROM " + r.table + facet_where(r, win) +
            " LIMIT " + std::to_string(kFacetSampleRows) + ")) LEFT ARRAY JOIN arrayConcat(" + join_sql(tuples) + ") AS t" +
            facet_settings_sql(kFacetReadRowsCap, false);
        try {
          const BoundedRead read = bounded_select(*r.client, sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              parse_u64(ch_block_text_at(block, 0, row), &value.sampled);
              LogFacetKeys::Key key{ch_block_text_at(block, 1, row), ch_block_text_at(block, 2, row), 0};
              parse_u64(ch_block_text_at(block, 3, row), &key.count);
              // A column empty on every sampled record is not a field.
              if (key.scope.empty() || key.count == 0) continue;
              value.keys.push_back(std::move(key));
            }
          });
          value.timed_out = timed_out(read);
          // The sample LIMIT, the read cap or the time budget stopped it.
          value.estimated = value.sampled >= kFacetSampleRows || read.capped(kFacetReadRowsCap) || value.timed_out;
          value.query_ms = read.elapsed_ms;
        } catch (const std::exception& e) {
          if (client_pool_) client_pool_->invalidate(r.client);
          code = "logs_facets_failed";
          message = e.what();
          return false;
        }
        // Most frequent first; ties: the record columns, then the maps, by key.
        std::sort(value.keys.begin(), value.keys.end(), [](const LogFacetKeys::Key& a, const LogFacetKeys::Key& b) {
          if (a.count != b.count) return a.count > b.count;
          if (a.scope != b.scope) return facet_scope_rank(a.scope) < facet_scope_rank(b.scope);
          return a.key < b.key;
        });
        return true;
      });
  if (!cached.has_value || !cached.value) {
    return json_error(res, 503, cached.error_code.empty() ? "logs_facets_failed" : cached.error_code,
                      cached.error_message.empty() ? "Log field discovery failed." : cached.error_message);
  }
  const auto& value = *cached.value;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("supported"); w.Bool(true);
  w.Key("scopes"); w.StartArray(); for (const auto& scope : scopes) w.String(scope.c_str()); w.String("column"); w.EndArray();
  w.Key("columns"); w.StartArray(); for (const auto& column : columns) w.String(column.c_str()); w.EndArray();
  write_facet_common(w, r, win, value.estimated, value.timed_out, value.query_ms, !fetched);
  w.Key("sampled_records"); w.Uint64(value.sampled);
  w.Key("truncated"); w.Bool(value.keys.size() > kFacetMaxKeys);
  w.Key("keys"); w.StartArray();
  for (size_t i = 0; i < value.keys.size() && i < kFacetMaxKeys; ++i) {
    const auto& key = value.keys[i];
    w.StartArray(); w.String(key.scope.c_str()); w.String(key.key.c_str()); w.Uint64(key.count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  send_json(res, sb);
}

// Top values of one field with their sampled record counts. The field's own
// filters are left out, so its other values stay visible (and can be added:
// several values of one key match any of them).
void Server::handle_logs_facet_values(const httplib::Request& req, httplib::Response& res) {
  const std::string scope = param(req, "scope");
  const std::string key = param(req, "key");
  if (scope != "log" && scope != "resource" && scope != "scope" && scope != "column") {
    return json_error(res, 400, "invalid_logs_facet", "scope must be log, resource, scope or column.");
  }
  if (key.empty() || key.size() > kFacetMaxKeyBytes) return json_error(res, 400, "invalid_logs_facet", "key must be 1 to 512 bytes.");
  if (scope == "column" && !facet_column_known(key)) {
    return json_error(res, 400, "invalid_logs_facet", "column must be ServiceName, SeverityText, ScopeName or ScopeVersion.");
  }
  const int limit = int_param(req, "limit", 10, 1, kFacetMaxValues);
  LogsRequest r;
  if (!open_request(cfg_, client_pool_, without_own_filters(req, scope, key), res, &r)) return;
  if (substring_range_rejected(r, res)) return;
  if (scope == "column" ? !facet_column_present(r.schema, key) : !facet_map_present(r.schema, scope)) {
    return json_error(res, 400, "logs_facet_unsupported",
                      scope == "column" ? "Column " + key + " is not in the logs table."
                                        : std::string(facet_map_column(scope)) + " is not stored as a Map column.");
  }
  const FacetWindow win = facet_window(r.query);
  const std::string cache_key = r.host_id + '\0' + r.table + '\0' + std::to_string(win.start_ms) + '\0' +
      std::to_string(win.end_ms) + '\0' + scope + '\0' + key + '\0' + std::to_string(limit) + '\0' + r.query.where;
  bool fetched = false;
  auto cached = g_log_facet_values_cache.get_or_refresh(
      cache_key, static_cast<uint64_t>(now_ms()), kFacetTtlMs, 5000,
      [&](LogFacetValues& value, std::string& code, std::string& message) {
        fetched = true;
        std::string expr, presence;
        if (scope == "column") {
          expr = "toString(" + quote_ident(key) + ")";
        } else {
          const std::string map = facet_map_column(scope);
          expr = map + "[" + quote(key) + "]";
          presence = " AND mapContains(" + map + ", " + quote(key) + ")";
        }
        const std::string sql =
            "SELECT toString(v), toString(c), toString(sum(c) OVER ()), toString(count() OVER ()) FROM ("
            "SELECT v, count() AS c FROM ("
            "SELECT " + expr + " AS v FROM " + r.table + facet_where(r, win) + presence +
            " LIMIT " + std::to_string(kFacetSampleRows) + ") GROUP BY v) "
            "ORDER BY c DESC, v LIMIT " + std::to_string(limit) + facet_settings_sql(kFacetReadRowsCap, true);
        try {
          const BoundedRead read = bounded_select(*r.client, sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              uint64_t count = 0;
              parse_u64(ch_block_text_at(block, 1, row), &count);
              value.values.emplace_back(ch_block_text_at(block, 0, row), count);
              parse_u64(ch_block_text_at(block, 2, row), &value.with_key);
              parse_u64(ch_block_text_at(block, 3, row), &value.distinct_values);
            }
          });
          value.timed_out = timed_out(read);
          value.estimated = value.with_key >= kFacetSampleRows || read.capped(kFacetReadRowsCap) || value.timed_out ||
              value.distinct_values >= kFacetGroupByCap;
          value.query_ms = read.elapsed_ms;
        } catch (const std::exception& e) {
          if (client_pool_) client_pool_->invalidate(r.client);
          code = "logs_facet_values_failed";
          message = e.what();
          return false;
        }
        return true;
      });
  if (!cached.has_value || !cached.value) {
    return json_error(res, 503, cached.error_code.empty() ? "logs_facet_values_failed" : cached.error_code,
                      cached.error_message.empty() ? "Log field values failed." : cached.error_message);
  }
  const auto& value = *cached.value;
  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("scope"); w.String(scope.c_str());
  w.Key("key"); w.String(key.c_str());
  w.Key("limit"); w.Int(limit);
  write_facet_common(w, r, win, value.estimated, value.timed_out, value.query_ms, !fetched);
  w.Key("records_with_key"); w.Uint64(value.with_key);
  w.Key("distinct_values"); w.Uint64(value.distinct_values);
  w.Key("has_more"); w.Bool(value.distinct_values > value.values.size());
  w.Key("values"); w.StartArray();
  for (const auto& [text, count] : value.values) {
    w.StartArray(); w.String(text.c_str(), static_cast<rapidjson::SizeType>(text.size())); w.Uint64(count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  send_json(res, sb);
}

} // namespace chdash
