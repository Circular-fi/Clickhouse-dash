// GET /api/traces/logs: the OpenTelemetry log records of one trace, for the
// trace detail page (logs panel, per-span log badges, inspector group).
//
// One query on the exporter logs table, bounded on every side:
//   PREWHERE <time column> BETWEEN <trace start - margin> AND <trace end + margin>
//   WHERE ServiceName IN (<the trace's services>) AND TraceId = <id>
//         [AND SpanId = <id>] AND <traces.service_allowlist>
//   ORDER BY Timestamp LIMIT limit + 1
// The time range serves the partition key and the (ServiceName, TimestampTime)
// primary key, the TraceId bloom filter skips the other granules. A request
// without a time range is rejected: a TraceId lookup over the whole table
// would read every part.
#include "server.hpp"

#include "api_error.hpp"
#include "ch_block_value.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "otel_allowlist.hpp"

#include <clickhouse/client.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace chdash {
namespace {

using JsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

constexpr auto kLogColumnsCacheTtl = std::chrono::seconds(60);
constexpr size_t kLogColumnsCacheMaxEntries = 256;
constexpr int kTraceLogsMaxExecutionSeconds = 10;
constexpr size_t kMaxTraceIdBytes = 256;
constexpr size_t kMaxSpanIdBytes = 128;
constexpr size_t kMaxServices = 1000;
constexpr size_t kMaxServiceBytes = 512;
// Bodies above this are cut in the response (body_bytes keeps the full size).
constexpr int kMaxBodyBytes = 64 * 1024;

std::string quote_ident(std::string_view ident) {
  std::string out;
  out.reserve(ident.size() + 2);
  out.push_back('`');
  for (char ch : ident) {
    if (ch == '`') out += "``";
    else out.push_back(ch);
  }
  out.push_back('`');
  return out;
}

using otel::allowlist_quote_string;

// Schema facts the query depends on, from one system.columns read.
struct LogColumns {
  bool exists = false;
  bool timestamp_time = false;
  bool trace_id = false;
  bool span_id = false;
  bool scope_name = false;
  bool event_name = false;
  std::string log_attributes_type;
  std::string resource_attributes_type;
  std::vector<std::string> missing;
};

struct LogColumnsCacheEntry {
  LogColumns columns;
  std::chrono::steady_clock::time_point loaded_at;
};

std::mutex g_log_columns_mutex;
std::unordered_map<std::string, LogColumnsCacheEntry> g_log_columns_cache;

bool starts_with(std::string_view text, std::string_view prefix) {
  return text.size() >= prefix.size() && text.compare(0, prefix.size(), prefix) == 0;
}

// Same classification as /api/logs/meta (attributes.*.kind).
std::string attribute_kind(const std::string& type) {
  if (type.empty()) return "missing";
  if (starts_with(type, "Map(")) return "map";
  if (starts_with(type, "JSON") || starts_with(type, "Object(")) return "json";
  if (type == "String" || starts_with(type, "LowCardinality(String")) return "string";
  return "other";
}

// A JSON object text for Map / JSON columns; String columns are passed as is
// (the page parses JSON text and shows anything else raw).
std::string attribute_expr(const std::string& column, const std::string& type) {
  const std::string kind = attribute_kind(type);
  if (kind == "map" || kind == "json") return "toJSONString(" + quote_ident(column) + ")";
  if (kind == "string") return "toString(" + quote_ident(column) + ")";
  return "'{}'";
}

LogColumns load_log_columns(clickhouse::Client& client, const LogSettings& logs) {
  LogColumns out;
  std::set<std::string> names;
  client.Select(
      "SELECT toString(name), toString(type) FROM system.columns WHERE database = " + allowlist_quote_string(logs.database) +
      " AND `table` = " + allowlist_quote_string(logs.table),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string name = ch_block_text_at(block, 0, row);
          const std::string type = ch_block_text_at(block, 1, row);
          names.insert(name);
          if (name == "LogAttributes") out.log_attributes_type = type;
          if (name == "ResourceAttributes") out.resource_attributes_type = type;
        }
      });
  out.exists = !names.empty();
  out.timestamp_time = names.count("TimestampTime") > 0;
  out.trace_id = names.count("TraceId") > 0;
  out.span_id = names.count("SpanId") > 0;
  out.scope_name = names.count("ScopeName") > 0;
  out.event_name = names.count("EventName") > 0;
  for (const char* required : {"Timestamp", "ServiceName", "SeverityText", "SeverityNumber", "Body"}) {
    if (!names.count(required)) out.missing.emplace_back(required);
  }
  return out;
}

LogColumns cached_log_columns(clickhouse::Client& client, const HostSpec& host, const LogSettings& logs) {
  const std::string key = host.system_uri + '\x1f' + logs.database + '\x1f' + logs.table;
  {
    std::lock_guard<std::mutex> lock(g_log_columns_mutex);
    const auto it = g_log_columns_cache.find(key);
    if (it != g_log_columns_cache.end() && std::chrono::steady_clock::now() - it->second.loaded_at < kLogColumnsCacheTtl) {
      return it->second.columns;
    }
  }
  LogColumns columns = load_log_columns(client, logs);
  // A missing table is not cached: it may be created by the exporter any time.
  if (columns.exists) {
    std::lock_guard<std::mutex> lock(g_log_columns_mutex);
    if (g_log_columns_cache.size() >= kLogColumnsCacheMaxEntries) g_log_columns_cache.clear();
    g_log_columns_cache[key] = LogColumnsCacheEntry{columns, std::chrono::steady_clock::now()};
  }
  return columns;
}

bool parse_i64(const httplib::Request& req, const char* name, int64_t* out) {
  if (!req.has_param(name)) return false;
  const std::string text = req.get_param_value(name);
  if (text.empty() || text.size() > 20) return false;
  size_t used = 0;
  try {
    *out = std::stoll(text, &used);
  } catch (...) {
    return false;
  }
  return used == text.size();
}

void send_json(httplib::Response& res, const std::string& body) {
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(body, "application/json");
}

// Disabled source or unusable table: a 200 answer the page can explain.
void send_unavailable(httplib::Response& res, bool enabled, bool table_exists, const char* code, const std::string& message) {
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("enabled"); w.Bool(enabled);
  w.Key("signal"); w.String("logs");
  if (enabled) { w.Key("table_exists"); w.Bool(table_exists); }
  w.Key("error_code"); w.String(code);
  w.Key("message"); w.String(message.c_str());
  w.Key("count"); w.Int(0);
  w.Key("truncated"); w.Bool(false);
  w.Key("logs"); w.StartArray(); w.EndArray();
  w.EndObject();
  send_json(res, sb.GetString());
}

int64_t floor_div(int64_t value, int64_t divisor) {
  const int64_t q = value / divisor;
  return (value % divisor != 0 && value < 0) ? q - 1 : q;
}

} // namespace

void Server::handle_trace_logs(const httplib::Request& req, httplib::Response& res) {
  const LogSettings& logs = cfg_.logs;
  if (!logs.enabled) {
    return send_unavailable(res, false, false, "logs_disabled",
        "OTel logs are disabled. Add logs { enabled = true } to the ChDash configuration.");
  }
  const std::string trace_id = req.has_param("trace_id") ? req.get_param_value("trace_id") : "";
  if (trace_id.empty()) return json_error(res, 400, "missing_trace_id", "trace_id is required.");
  if (trace_id.size() > kMaxTraceIdBytes) return json_error(res, 400, "invalid_trace_id", "trace_id is too long.");
  const std::string span_id = req.has_param("span_id") ? req.get_param_value("span_id") : "";
  if (span_id.size() > kMaxSpanIdBytes) return json_error(res, 400, "invalid_span_id", "span_id is too long.");

  int64_t start_ns = 0;
  int64_t end_ns = 0;
  const bool has_start = parse_i64(req, "start_ns", &start_ns);
  const bool has_end = parse_i64(req, "end_ns", &end_ns);
  if (!has_start || !has_end) {
    return json_error(res, 400, "missing_time_range",
        "start_ns and end_ns (the trace bounds, epoch nanoseconds) are required: logs are never searched without a time range.");
  }
  // DateTime ends in 2106.
  constexpr int64_t kMaxTimeNs = 4294967295LL * 1000000000LL;
  if (start_ns <= 0 || end_ns < start_ns || end_ns > kMaxTimeNs) {
    return json_error(res, 400, "invalid_time_range", "Invalid trace time range.");
  }

  std::vector<std::string> services;
  {
    std::set<std::string> seen;
    const auto range = req.params.equal_range("service");
    for (auto it = range.first; it != range.second; ++it) {
      if (it->second.empty() || !seen.insert(it->second).second) continue;
      if (it->second.size() > kMaxServiceBytes) return json_error(res, 400, "invalid_service", "service is too long.");
      services.push_back(it->second);
    }
    if (services.size() > kMaxServices) return json_error(res, 400, "too_many_services", "At most 1000 service values are accepted.");
  }

  size_t limit = logs.trace_logs_limit;
  if (req.has_param("limit")) {
    int64_t requested = 0;
    if (!parse_i64(req, "limit", &requested) || requested < 1) return json_error(res, 400, "invalid_limit", "limit must be a positive integer.");
    limit = std::min<size_t>(logs.trace_logs_limit, static_cast<size_t>(requested));
  }

  // Whole seconds around the trace (TimestampTime is a DateTime), then the
  // window is clamped to logs.max_lookback_minutes from its start.
  const int64_t max_window_s = static_cast<int64_t>(logs.max_lookback_minutes) * 60;
  const int64_t from_s = floor_div(start_ns, 1000000000) - logs.trace_margin_before_seconds;
  int64_t to_s = floor_div(end_ns, 1000000000) + 1 + logs.trace_margin_after_seconds;
  bool clamped = false;
  if (to_s - from_s > max_window_s) {
    to_s = from_s + max_window_s;
    clamped = true;
  }

  std::string host_id;
  if (req.has_param("host_id")) host_id = req.get_param_value("host_id");
  if (host_id.empty() && cfg_.hosts.size() == 1) host_id = cfg_.hosts.front().id;
  const HostSpec* host = host_id.empty() ? nullptr : find_request_host(cfg_, req, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Logs source host is not configured.");
  if (host->system_uri.empty()) {
    return json_error(res, 503, "logs_source_unavailable", "OTel logs require system credentials for the selected host.");
  }

  const auto started = std::chrono::steady_clock::now();
  std::string error;
  // (connect, receive, send); the query itself stops at max_execution_time.
  auto client = client_pool_
      ? client_pool_->acquire(host->system_uri, std::chrono::seconds(5), std::chrono::seconds(kTraceLogsMaxExecutionSeconds + 10),
                              std::chrono::seconds(15), &error)
      : make_client_from_uri(host->system_uri, std::chrono::seconds(5), std::chrono::seconds(kTraceLogsMaxExecutionSeconds + 10),
                             std::chrono::seconds(15), &error);
  if (!client) {
    return json_error(res, 503, "logs_source_unavailable", error.empty() ? "Cannot connect to the logs ClickHouse source." : error);
  }

  LogColumns columns;
  try {
    columns = cached_log_columns(*client, *host, logs);
  } catch (const std::exception& e) {
    return json_error(res, 503, "logs_schema_failed", e.what());
  }
  const std::string table_name = logs.database + "." + logs.table;
  if (!columns.exists) {
    return send_unavailable(res, true, false, "logs_table_missing",
        "Table " + table_name + " does not exist on host " + host_id +
        ". Point logs.database/logs.table at the OpenTelemetry Collector ClickHouse exporter logs table.");
  }
  if (!columns.missing.empty()) {
    return send_unavailable(res, true, true, "logs_schema_mismatch",
        "Table " + table_name + " is not an OpenTelemetry exporter logs table (missing required columns).");
  }
  if (!columns.trace_id || !columns.span_id) {
    return send_unavailable(res, true, true, "logs_trace_correlation_unavailable",
        "Table " + table_name + " has no TraceId / SpanId columns: logs cannot be attached to traces.");
  }

  // Older exporter layouts sort by (ServiceName, TimestampTime, Timestamp);
  // newer ones have no TimestampTime and a Timestamp-based key.
  const std::string time_range = columns.timestamp_time
      ? "TimestampTime BETWEEN toDateTime(" + std::to_string(from_s) + ") AND toDateTime(" + std::to_string(to_s) + ")"
      : "Timestamp BETWEEN toDateTime64(" + std::to_string(from_s) + ", 9) AND toDateTime64(" + std::to_string(to_s) + ", 9)";
  std::string where;
  if (!services.empty()) {
    where += "ServiceName IN (";
    for (size_t i = 0; i < services.size(); ++i) {
      if (i) where += ", ";
      where += allowlist_quote_string(services[i]);
    }
    where += ") AND ";
  }
  where += "TraceId = " + allowlist_quote_string(trace_id);
  if (!span_id.empty()) where += " AND SpanId = " + allowlist_quote_string(span_id);
  where += " AND " + otel::service_allowlist_predicate(cfg_.traces);

  const std::string sql =
      "SELECT toString(toUnixTimestamp64Nano(Timestamp)), toString(Timestamp, 'UTC'), toString(SeverityText), "
      "toString(SeverityNumber), toString(ServiceName), toString(SpanId), "
      "substring(Body, 1, " + std::to_string(kMaxBodyBytes) + "), toString(length(Body)), " +
      attribute_expr("LogAttributes", columns.log_attributes_type) + ", " +
      attribute_expr("ResourceAttributes", columns.resource_attributes_type) + ", " +
      (columns.scope_name ? "toString(ScopeName)" : "''") + ", " +
      (columns.event_name ? "toString(EventName)" : "''") +
      " FROM " + quote_ident(logs.database) + "." + quote_ident(logs.table) +
      " PREWHERE " + time_range +
      " WHERE " + where +
      " ORDER BY Timestamp LIMIT " + std::to_string(limit + 1) +
      // Few granules survive the indexes: read them with several threads
      // anyway (the default needs ~20 granules per stream).
      " SETTINGS max_execution_time = " + std::to_string(kTraceLogsMaxExecutionSeconds) +
      ", merge_tree_min_rows_for_concurrent_read = 8192, merge_tree_min_bytes_for_concurrent_read = 1";

  struct Record {
    std::string timestamp_ns, timestamp, severity_text, severity_number, service, span_id, body, body_bytes;
    std::string log_attributes, resource_attributes, scope_name, event_name;
  };
  std::vector<Record> records;
  try {
    client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        Record r;
        r.timestamp_ns = ch_block_text_at(block, 0, row);
        r.timestamp = ch_block_text_at(block, 1, row);
        r.severity_text = ch_block_text_at(block, 2, row);
        r.severity_number = ch_block_text_at(block, 3, row);
        r.service = ch_block_text_at(block, 4, row);
        r.span_id = ch_block_text_at(block, 5, row);
        r.body = ch_block_text_at(block, 6, row);
        r.body_bytes = ch_block_text_at(block, 7, row);
        r.log_attributes = ch_block_text_at(block, 8, row);
        r.resource_attributes = ch_block_text_at(block, 9, row);
        r.scope_name = ch_block_text_at(block, 10, row);
        r.event_name = ch_block_text_at(block, 11, row);
        records.push_back(std::move(r));
      }
    });
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_logs_query_failed", e.what());
  }
  const bool truncated = records.size() > limit;
  if (truncated) records.resize(limit);
  const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();

  const auto to_int = [](const std::string& text) {
    try { return text.empty() ? 0LL : std::stoll(text); } catch (...) { return 0LL; }
  };

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("enabled"); w.Bool(true);
  w.Key("signal"); w.String("logs");
  w.Key("table_exists"); w.Bool(true);
  w.Key("source_host_id"); w.String(host_id.c_str());
  w.Key("database"); w.String(logs.database.c_str());
  w.Key("table"); w.String(logs.table.c_str());
  w.Key("trace_id"); w.String(trace_id.c_str());
  w.Key("span_id"); w.String(span_id.c_str());
  w.Key("window");
  w.StartObject();
  w.Key("start_ns"); w.String(std::to_string(start_ns).c_str());
  w.Key("end_ns"); w.String(std::to_string(end_ns).c_str());
  w.Key("from_s"); w.Int64(from_s);
  w.Key("to_s"); w.Int64(to_s);
  w.Key("margin_before_s"); w.Int(logs.trace_margin_before_seconds);
  w.Key("margin_after_s"); w.Int(logs.trace_margin_after_seconds);
  w.Key("time_column"); w.String(columns.timestamp_time ? "TimestampTime" : "Timestamp");
  w.Key("clamped"); w.Bool(clamped);
  w.EndObject();
  w.Key("services");
  w.StartArray();
  for (const auto& service : services) w.String(service.c_str());
  w.EndArray();
  w.Key("attributes");
  w.StartObject();
  w.Key("log"); w.String(attribute_kind(columns.log_attributes_type).c_str());
  w.Key("resource"); w.String(attribute_kind(columns.resource_attributes_type).c_str());
  w.EndObject();
  w.Key("limit"); w.Uint64(limit);
  w.Key("count"); w.Uint64(records.size());
  w.Key("truncated"); w.Bool(truncated);
  w.Key("elapsed_ms"); w.Int64(elapsed_ms);
  w.Key("logs");
  w.StartArray();
  for (const auto& r : records) {
    w.StartObject();
    // Exact epoch nanoseconds as text: a JSON number would lose precision.
    w.Key("timestamp_ns"); w.String(r.timestamp_ns.c_str());
    w.Key("timestamp"); w.String(r.timestamp.c_str());
    w.Key("severity_text"); w.String(r.severity_text.c_str());
    w.Key("severity_number"); w.Int64(to_int(r.severity_number));
    w.Key("service_name"); w.String(r.service.c_str());
    w.Key("span_id"); w.String(r.span_id.c_str());
    w.Key("body"); w.String(r.body.c_str(), static_cast<rapidjson::SizeType>(r.body.size()));
    const long long body_bytes = to_int(r.body_bytes);
    if (body_bytes > static_cast<long long>(r.body.size())) {
      w.Key("body_truncated"); w.Bool(true);
      w.Key("body_bytes"); w.Int64(body_bytes);
    }
    w.Key("log_attributes"); w.String(r.log_attributes.c_str());
    w.Key("resource_attributes"); w.String(r.resource_attributes.c_str());
    w.Key("scope_name"); w.String(r.scope_name.c_str());
    if (columns.event_name) { w.Key("event_name"); w.String(r.event_name.c_str()); }
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  send_json(res, sb.GetString());
}

} // namespace chdash
