// Schema detection for OpenTelemetry logs and metrics stored by the
// OpenTelemetry Collector ClickHouse exporter.
//
// Both routes only read system tables (tables, columns, data_skipping_indices,
// parts): no query ever touches the signal data itself, so detection stays
// cheap on multi-billion-row tables. Results are cached per source for
// kSignalMetaCacheTtl; ?refresh=1 bypasses the cache.
#include "server.hpp"

#include "allowed_objects.hpp"
#include "api_error.hpp"
#include "ch_block_value.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"

#include <clickhouse/client.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace chdash {
namespace {

using JsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

constexpr auto kSignalMetaCacheTtl = std::chrono::seconds(60);
constexpr size_t kSignalMetaCacheMaxEntries = 256;

std::string sql_quote(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('\'');
  for (char ch : value) {
    if (ch == '\\') out += "\\\\";
    else if (ch == '\'') out += "\\'";
    else out.push_back(ch);
  }
  out.push_back('\'');
  return out;
}

int64_t text_to_i64(const std::string& text) {
  try {
    return text.empty() ? 0 : std::stoll(text);
  } catch (...) {
    return 0;
  }
}

const HostSpec* signal_host(const AppConfig& cfg, const httplib::Request& req, std::string* host_id) {
  std::string id;
  if (req.has_param("host_id")) id = req.get_param_value("host_id");
  if (id.empty() && cfg.hosts.size() == 1) id = cfg.hosts.front().id;
  if (host_id) *host_id = id;
  return id.empty() ? nullptr : find_request_host(cfg, req, id);
}

std::shared_ptr<clickhouse::Client> acquire_signal_client(
    const HostSpec& host,
    const std::shared_ptr<ClickHouseClientPool>& pool,
    std::string* error) {
  if (host.system_uri.empty()) {
    if (error) *error = "OTel logs/metrics require system credentials for the selected host.";
    return nullptr;
  }
  // (connect, receive, send). Only system-table reads run here.
  const auto connect_timeout = std::chrono::seconds(5);
  const auto receive_timeout = std::chrono::seconds(15);
  const auto send_timeout = std::chrono::seconds(15);
  return pool
      ? pool->acquire(host.system_uri, connect_timeout, receive_timeout, send_timeout, error)
      : make_client_from_uri(host.system_uri, connect_timeout, receive_timeout, send_timeout, error);
}

// ---------------------------------------------------------------------------
// Cache of serialized detection results (successful lookups only).

struct SignalMetaCacheEntry {
  std::string body;
  std::chrono::steady_clock::time_point loaded_at;
};

std::mutex g_signal_meta_mutex;
std::unordered_map<std::string, SignalMetaCacheEntry> g_signal_meta_cache;

bool cached_signal_meta(const std::string& key, std::string* body, int64_t* age_ms) {
  std::lock_guard<std::mutex> lock(g_signal_meta_mutex);
  const auto it = g_signal_meta_cache.find(key);
  if (it == g_signal_meta_cache.end()) return false;
  const auto age = std::chrono::steady_clock::now() - it->second.loaded_at;
  if (age >= kSignalMetaCacheTtl) return false;
  *body = it->second.body;
  *age_ms = std::chrono::duration_cast<std::chrono::milliseconds>(age).count();
  return true;
}

void store_signal_meta(const std::string& key, const std::string& body) {
  std::lock_guard<std::mutex> lock(g_signal_meta_mutex);
  if (g_signal_meta_cache.size() >= kSignalMetaCacheMaxEntries) g_signal_meta_cache.clear();
  g_signal_meta_cache[key] = SignalMetaCacheEntry{body, std::chrono::steady_clock::now()};
}

// The cached body is a JSON object; the cache status is appended per response.
std::string with_cache_status(const std::string& body, bool hit, int64_t age_ms) {
  std::string out = body;
  if (!out.empty() && out.back() == '}') out.pop_back();
  out += ",\"cache\":{\"hit\":";
  out += hit ? "true" : "false";
  out += ",\"age_ms\":" + std::to_string(age_ms);
  out += ",\"ttl_ms\":" + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(kSignalMetaCacheTtl).count());
  out += "}}";
  return out;
}

void send_meta(httplib::Response& res, const std::string& body) {
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(body, "application/json");
}

// ---------------------------------------------------------------------------
// System-table snapshots.

struct ColumnInfo {
  std::string name;
  std::string type;
  std::string default_kind;
};

struct SkipIndexInfo {
  std::string name;
  std::string type;
  std::string type_full;
  std::string expr;
  int64_t granularity = 0;
};

struct PartsInfo {
  int64_t parts = 0;
  int64_t rows = 0;
  int64_t bytes_on_disk = 0;
  int64_t min_time_s = 0;
  int64_t max_time_s = 0;
  int64_t min_date_s = 0;
  int64_t max_date_s = 0;
};

struct TableInfo {
  bool exists = false;
  std::string engine;
  std::string sorting_key;
  std::string primary_key;
  std::string partition_key;
  std::vector<ColumnInfo> columns;
  std::vector<SkipIndexInfo> skip_indexes;
  PartsInfo parts;

  const ColumnInfo* column(std::string_view name) const {
    for (const auto& c : columns) {
      if (c.name == name) return &c;
    }
    return nullptr;
  }
};

std::string in_list(const std::vector<std::string>& values) {
  std::string out = "(";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out += ", ";
    out += sql_quote(values[i]);
  }
  return out + ")";
}

// Four system-table queries for any number of tables of one database.
std::map<std::string, TableInfo> load_table_infos(
    clickhouse::Client& client,
    const std::string& database,
    const std::vector<std::string>& tables) {
  std::map<std::string, TableInfo> out;
  const std::string db = sql_quote(database);
  const std::string names = in_list(tables);

  client.Select(
      "SELECT toString(name), toString(engine), toString(sorting_key), toString(primary_key), toString(partition_key) "
      "FROM system.tables WHERE database = " + db + " AND name IN " + names,
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          auto& info = out[ch_block_text_at(block, 0, row)];
          info.exists = true;
          info.engine = ch_block_text_at(block, 1, row);
          info.sorting_key = ch_block_text_at(block, 2, row);
          info.primary_key = ch_block_text_at(block, 3, row);
          info.partition_key = ch_block_text_at(block, 4, row);
        }
      });
  if (out.empty()) return out;

  client.Select(
      "SELECT toString(`table`), toString(name), toString(type), toString(default_kind) "
      "FROM system.columns WHERE database = " + db + " AND `table` IN " + names + " ORDER BY `table`, position",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const auto it = out.find(ch_block_text_at(block, 0, row));
          if (it == out.end()) continue;
          it->second.columns.push_back(ColumnInfo{
              ch_block_text_at(block, 1, row), ch_block_text_at(block, 2, row), ch_block_text_at(block, 3, row)});
        }
      });

  client.Select(
      "SELECT toString(`table`), toString(name), toString(type), toString(type_full), toString(expr), toString(granularity) "
      "FROM system.data_skipping_indices WHERE database = " + db + " AND `table` IN " + names + " ORDER BY `table`, name",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const auto it = out.find(ch_block_text_at(block, 0, row));
          if (it == out.end()) continue;
          it->second.skip_indexes.push_back(SkipIndexInfo{
              ch_block_text_at(block, 1, row), ch_block_text_at(block, 2, row), ch_block_text_at(block, 3, row),
              ch_block_text_at(block, 4, row), text_to_i64(ch_block_text_at(block, 5, row))});
        }
      });

  // min_time/max_time come from the partition-key minmax index (exact to the
  // second for toDate(<time column>) partitions); min_date/max_date are the
  // day-precision fallback. Neither reads column data.
  client.Select(
      "SELECT toString(`table`), toString(count()), toString(sum(rows)), toString(sum(bytes_on_disk)), "
      "toString(toUnixTimestamp(min(min_time))), toString(toUnixTimestamp(max(max_time))), "
      "toString(toUnixTimestamp(toDateTime(min(min_date), 'UTC'))), "
      "toString(toUnixTimestamp(toDateTime(max(max_date), 'UTC'))) "
      "FROM system.parts WHERE active AND database = " + db + " AND `table` IN " + names + " GROUP BY `table`",
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const auto it = out.find(ch_block_text_at(block, 0, row));
          if (it == out.end()) continue;
          auto& p = it->second.parts;
          p.parts = text_to_i64(ch_block_text_at(block, 1, row));
          p.rows = text_to_i64(ch_block_text_at(block, 2, row));
          p.bytes_on_disk = text_to_i64(ch_block_text_at(block, 3, row));
          p.min_time_s = text_to_i64(ch_block_text_at(block, 4, row));
          p.max_time_s = text_to_i64(ch_block_text_at(block, 5, row));
          p.min_date_s = text_to_i64(ch_block_text_at(block, 6, row));
          p.max_date_s = text_to_i64(ch_block_text_at(block, 7, row));
        }
      });
  return out;
}

// ---------------------------------------------------------------------------
// JSON fragments shared by both routes.

bool starts_with(std::string_view text, std::string_view prefix) {
  return text.size() >= prefix.size() && text.compare(0, prefix.size(), prefix) == 0;
}

// Map vs JSON attribute storage decides how filters are written
// (m['k'] / mapKeys vs JSON subcolumns).
std::string attribute_kind(const ColumnInfo* column) {
  if (!column) return "missing";
  if (starts_with(column->type, "Map(")) return "map";
  if (starts_with(column->type, "JSON") || starts_with(column->type, "Object(")) return "json";
  if (column->type == "String" || starts_with(column->type, "LowCardinality(String")) return "string";
  return "other";
}

void write_attribute(JsonWriter& w, const TableInfo& table, const char* key, const char* column_name) {
  const ColumnInfo* column = table.column(column_name);
  w.Key(key);
  w.StartObject();
  w.Key("column"); w.String(column_name);
  w.Key("kind"); w.String(attribute_kind(column).c_str());
  w.Key("type");
  if (column) w.String(column->type.c_str());
  else w.Null();
  w.EndObject();
}

void write_columns(JsonWriter& w, const TableInfo& table) {
  w.Key("columns");
  w.StartArray();
  for (const auto& c : table.columns) {
    w.StartObject();
    w.Key("name"); w.String(c.name.c_str());
    w.Key("type"); w.String(c.type.c_str());
    if (!c.default_kind.empty()) {
      w.Key("default_kind"); w.String(c.default_kind.c_str());
    }
    w.EndObject();
  }
  w.EndArray();
}

void write_skip_index(JsonWriter& w, const SkipIndexInfo& index) {
  w.StartObject();
  w.Key("name"); w.String(index.name.c_str());
  w.Key("type"); w.String(index.type.c_str());
  w.Key("type_full"); w.String(index.type_full.c_str());
  w.Key("expr"); w.String(index.expr.c_str());
  w.Key("granularity"); w.Int64(index.granularity);
  w.EndObject();
}

void write_skip_indexes(JsonWriter& w, const TableInfo& table) {
  w.Key("skip_indexes");
  w.StartArray();
  for (const auto& index : table.skip_indexes) write_skip_index(w, index);
  w.EndArray();
}

// Table-wide bounds (not narrowed by the service allowlist).
void write_time_bounds(JsonWriter& w, const PartsInfo& parts) {
  w.Key("time_bounds");
  if (parts.rows <= 0) {
    w.Null();
    return;
  }
  int64_t min_s = parts.min_time_s;
  int64_t max_s = parts.max_time_s;
  const char* source = "system.parts.min_max_time";
  const char* precision = "second";
  if (max_s <= 0) {
    min_s = parts.min_date_s;
    max_s = parts.max_date_s > 0 ? parts.max_date_s + 24 * 60 * 60 - 1 : 0;
    source = "system.parts.min_max_date";
    precision = "day";
  }
  if (max_s <= 0) {
    w.Null();
    return;
  }
  w.StartObject();
  w.Key("min_ms"); w.Int64(min_s * 1000);
  // max_time is truncated to the second: the newest row is before max + 1 s.
  w.Key("max_ms"); w.Int64(max_s * 1000 + 999);
  w.Key("source"); w.String(source);
  w.Key("precision"); w.String(precision);
  w.Key("scope"); w.String("table");
  w.EndObject();
}

void write_storage(JsonWriter& w, const TableInfo& table) {
  w.Key("engine"); w.String(table.engine.c_str());
  w.Key("sorting_key"); w.String(table.sorting_key.c_str());
  w.Key("primary_key"); w.String(table.primary_key.c_str());
  w.Key("partition_key"); w.String(table.partition_key.c_str());
  w.Key("rows"); w.Int64(table.parts.rows);
  w.Key("parts"); w.Int64(table.parts.parts);
  w.Key("bytes_on_disk"); w.Int64(table.parts.bytes_on_disk);
}

std::vector<std::string> missing_columns(const TableInfo& table, const std::vector<const char*>& required) {
  std::vector<std::string> out;
  for (const char* name : required) {
    if (!table.column(name)) out.emplace_back(name);
  }
  return out;
}

void write_string_list(JsonWriter& w, const std::vector<std::string>& values) {
  w.StartArray();
  for (const auto& v : values) w.String(v.c_str());
  w.EndArray();
}

void write_allowlist(JsonWriter& w, const TraceSettings& traces) {
  // Logs and metrics reuse traces.service_allowlist for ServiceName filtering.
  w.Key("service_allowlist");
  write_string_list(w, traces.service_allowlist);
  const bool unrestricted = std::find(traces.service_allowlist.begin(), traces.service_allowlist.end(), "*") !=
      traces.service_allowlist.end();
  w.Key("service_filter_applied"); w.Bool(!unrestricted);
}

void write_disabled(httplib::Response& res, const char* signal, const char* code, const char* message) {
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("enabled"); w.Bool(false);
  w.Key("signal"); w.String(signal);
  w.Key("error_code"); w.String(code);
  w.Key("message"); w.String(message);
  w.EndObject();
  send_meta(res, sb.GetString());
}

// ---------------------------------------------------------------------------
// Logs.

bool token_index_type(std::string_view type) {
  return type == "tokenbf_v1" || type == "text" || type == "full_text" || type == "inverted" || type == "sparse_grams";
}

bool is_body_expr(std::string_view expr) {
  return expr == "Body" || expr == "lower(Body)" || expr == "`Body`" || expr == "lower(`Body`)";
}

bool is_trace_id_expr(std::string_view expr) {
  return expr == "TraceId" || expr == "`TraceId`";
}

std::string build_logs_meta(const OtelSettings& otel, const std::string& host_id, const TableInfo& table) {
  const LogSettings& logs = otel.logs;
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("enabled"); w.Bool(true);
  w.Key("signal"); w.String("logs");
  w.Key("source_host_id"); w.String(host_id.c_str());
  w.Key("database"); w.String(logs.database.c_str());
  w.Key("table"); w.String(logs.table.c_str());
  w.Key("table_exists"); w.Bool(table.exists);
  w.Key("max_lookback_minutes"); w.Int(logs.max_lookback_minutes);
  w.Key("search_limit"); w.Uint64(logs.search_limit);
  write_allowlist(w, otel.traces);

  if (!table.exists) {
    const std::string message = "Table " + logs.database + "." + logs.table + " does not exist on host " + host_id +
        ". Point observability.logs.database and observability.logs.table (or the observability block of the host) at the OpenTelemetry Collector ClickHouse exporter logs table.";
    w.Key("schema_ok"); w.Bool(false);
    w.Key("error_code"); w.String("logs_table_missing");
    w.Key("message"); w.String(message.c_str());
    w.Key("body_search");
    w.StartObject();
    w.Key("configured"); w.String(logs.body_search.c_str());
    w.Key("effective"); w.String("off");
    w.Key("index_backed"); w.Bool(false);
    w.EndObject();
    w.Key("features");
    w.StartObject();
    w.Key("search"); w.Bool(false);
    w.Key("trace_correlation"); w.Bool(false);
    w.EndObject();
    w.EndObject();
    return sb.GetString();
  }

  const auto missing = missing_columns(table, {"Timestamp", "ServiceName", "SeverityText", "SeverityNumber", "Body"});
  const bool schema_ok = missing.empty();
  const bool has_timestamp_time = table.column("TimestampTime") != nullptr;
  const bool has_trace_id = table.column("TraceId") != nullptr;
  const bool has_span_id = table.column("SpanId") != nullptr;
  const bool has_body = table.column("Body") != nullptr;

  const SkipIndexInfo* trace_index = nullptr;
  const SkipIndexInfo* body_index = nullptr;
  for (const auto& index : table.skip_indexes) {
    if (!trace_index && is_trace_id_expr(index.expr)) trace_index = &index;
    if (!body_index && is_body_expr(index.expr)) body_index = &index;
  }

  std::string effective = has_body ? logs.body_search : "off";
  bool index_backed = false;
  if (body_index && effective == "token") index_backed = token_index_type(body_index->type);
  if (body_index && effective == "substring") index_backed = body_index->type == "ngrambf_v1";

  w.Key("schema_ok"); w.Bool(schema_ok);
  w.Key("missing_columns"); write_string_list(w, missing);
  if (!schema_ok) {
    const std::string message = "Table " + logs.database + "." + logs.table +
        " is not an OpenTelemetry exporter logs table (missing required columns).";
    w.Key("error_code"); w.String("logs_schema_mismatch");
    w.Key("message"); w.String(message.c_str());
  }
  write_storage(w, table);
  // Older exporter layouts sort by (ServiceName, TimestampTime, Timestamp):
  // coarse range filters belong on TimestampTime there, on Timestamp otherwise.
  w.Key("timestamp_time_column"); w.Bool(has_timestamp_time);
  w.Key("time_column"); w.String(has_timestamp_time ? "TimestampTime" : "Timestamp");
  w.Key("precise_time_column"); w.String("Timestamp");
  write_time_bounds(w, table.parts);
  w.Key("attributes");
  w.StartObject();
  write_attribute(w, table, "log", "LogAttributes");
  write_attribute(w, table, "resource", "ResourceAttributes");
  write_attribute(w, table, "scope", "ScopeAttributes");
  w.EndObject();
  write_skip_indexes(w, table);
  w.Key("trace_id_index");
  if (trace_index) write_skip_index(w, *trace_index);
  else w.Null();
  w.Key("body_index");
  if (body_index) {
    w.StartObject();
    w.Key("name"); w.String(body_index->name.c_str());
    w.Key("type"); w.String(body_index->type.c_str());
    w.Key("type_full"); w.String(body_index->type_full.c_str());
    w.Key("expr"); w.String(body_index->expr.c_str());
    w.Key("granularity"); w.Int64(body_index->granularity);
    w.Key("lowercase"); w.Bool(starts_with(body_index->expr, "lower("));
    w.Key("token_search"); w.Bool(token_index_type(body_index->type));
    w.Key("substring_search"); w.Bool(body_index->type == "ngrambf_v1");
    w.EndObject();
  } else {
    w.Null();
  }
  w.Key("body_search");
  w.StartObject();
  w.Key("configured"); w.String(logs.body_search.c_str());
  w.Key("effective"); w.String(effective.c_str());
  w.Key("index_backed"); w.Bool(index_backed);
  w.EndObject();
  write_columns(w, table);
  w.Key("features");
  w.StartObject();
  w.Key("search"); w.Bool(schema_ok);
  w.Key("severity_filter"); w.Bool(schema_ok);
  w.Key("body_search"); w.Bool(schema_ok && effective != "off");
  w.Key("trace_correlation"); w.Bool(has_trace_id && has_span_id);
  w.Key("trace_id_index"); w.Bool(trace_index != nullptr);
  w.Key("traces_enabled"); w.Bool(otel.traces.enabled);
  w.Key("log_attributes"); w.Bool(attribute_kind(table.column("LogAttributes")) == "map" ||
                                   attribute_kind(table.column("LogAttributes")) == "json");
  w.Key("resource_attributes"); w.Bool(attribute_kind(table.column("ResourceAttributes")) == "map" ||
                                        attribute_kind(table.column("ResourceAttributes")) == "json");
  w.EndObject();
  w.EndObject();
  return sb.GetString();
}

// ---------------------------------------------------------------------------
// Metrics.

struct MetricKind {
  const char* kind;
  const char* suffix;
  std::vector<const char*> required;
  bool has_exemplars;
};

const std::vector<MetricKind>& metric_kinds() {
  static const std::vector<MetricKind> kinds = {
    {"gauge", "_gauge", {"ServiceName", "MetricName", "Attributes", "TimeUnix", "Value"}, true},
    {"sum", "_sum", {"ServiceName", "MetricName", "Attributes", "TimeUnix", "Value",
                     "AggregationTemporality", "IsMonotonic"}, true},
    {"histogram", "_histogram", {"ServiceName", "MetricName", "Attributes", "TimeUnix", "Count", "Sum",
                                 "BucketCounts", "ExplicitBounds", "AggregationTemporality"}, true},
    {"exponential_histogram", "_exponential_histogram", {"ServiceName", "MetricName", "Attributes", "TimeUnix",
                                 "Count", "Sum", "Scale", "ZeroCount", "PositiveOffset", "PositiveBucketCounts",
                                 "NegativeOffset", "NegativeBucketCounts", "AggregationTemporality"}, true},
    {"summary", "_summary", {"ServiceName", "MetricName", "Attributes", "TimeUnix", "Count", "Sum",
                             "ValueAtQuantiles.Quantile", "ValueAtQuantiles.Value"}, false},
  };
  return kinds;
}

std::string build_metrics_meta(const OtelSettings& otel, const std::string& host_id,
                               const std::map<std::string, TableInfo>& tables) {
  const MetricSettings& metrics = otel.metrics;
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("enabled"); w.Bool(true);
  w.Key("signal"); w.String("metrics");
  w.Key("source_host_id"); w.String(host_id.c_str());
  w.Key("database"); w.String(metrics.database.c_str());
  w.Key("table_prefix"); w.String(metrics.table_prefix.c_str());
  write_allowlist(w, otel.traces);

  std::vector<std::string> available;
  std::vector<std::string> missing_kinds;
  bool any_exemplars = false;
  PartsInfo overall;
  int64_t overall_min_s = 0;
  int64_t overall_max_s = 0;

  w.Key("kinds");
  w.StartObject();
  for (const auto& kind : metric_kinds()) {
    const std::string table_name = metrics.table_prefix + kind.suffix;
    const auto it = tables.find(table_name);
    static const TableInfo kMissing;
    const TableInfo& table = it == tables.end() ? kMissing : it->second;
    w.Key(kind.kind);
    w.StartObject();
    w.Key("table"); w.String(table_name.c_str());
    w.Key("exists"); w.Bool(table.exists);
    if (!table.exists) {
      missing_kinds.emplace_back(kind.kind);
      w.EndObject();
      continue;
    }
    const auto missing = missing_columns(table, kind.required);
    const bool schema_ok = missing.empty();
    if (schema_ok) available.emplace_back(kind.kind);
    w.Key("schema_ok"); w.Bool(schema_ok);
    w.Key("missing_columns"); write_string_list(w, missing);
    write_storage(w, table);
    w.Key("time_column"); w.String("TimeUnix");
    const ColumnInfo* time_unix = table.column("TimeUnix");
    w.Key("time_type");
    if (time_unix) w.String(time_unix->type.c_str());
    else w.Null();
    write_time_bounds(w, table.parts);
    w.Key("attributes");
    w.StartObject();
    write_attribute(w, table, "point", "Attributes");
    write_attribute(w, table, "resource", "ResourceAttributes");
    write_attribute(w, table, "scope", "ScopeAttributes");
    w.EndObject();
    // Exporter layout: Exemplars Nested(FilteredAttributes, TimeUnix, Value,
    // SpanId, TraceId) flattened to Exemplars.* Array columns.
    w.Key("exemplars");
    w.StartObject();
    std::vector<std::string> exemplar_columns;
    for (const auto& c : table.columns) {
      if (starts_with(c.name, "Exemplars.")) exemplar_columns.push_back(c.name);
    }
    const bool trace_id = table.column("Exemplars.TraceId") != nullptr;
    const bool span_id = table.column("Exemplars.SpanId") != nullptr;
    w.Key("present"); w.Bool(!exemplar_columns.empty());
    w.Key("columns"); write_string_list(w, exemplar_columns);
    w.Key("trace_id"); w.Bool(trace_id);
    w.Key("span_id"); w.Bool(span_id);
    w.Key("time_unix"); w.Bool(table.column("Exemplars.TimeUnix") != nullptr);
    w.Key("value"); w.Bool(table.column("Exemplars.Value") != nullptr);
    w.Key("filtered_attributes"); w.Bool(table.column("Exemplars.FilteredAttributes") != nullptr);
    w.EndObject();
    if (kind.has_exemplars && trace_id && span_id) any_exemplars = true;
    write_skip_indexes(w, table);
    write_columns(w, table);
    w.EndObject();

    overall.rows += table.parts.rows;
    overall.parts += table.parts.parts;
    if (table.parts.rows > 0 && table.parts.max_time_s > 0) {
      overall_min_s = overall_min_s == 0 ? table.parts.min_time_s : std::min(overall_min_s, table.parts.min_time_s);
      overall_max_s = std::max(overall_max_s, table.parts.max_time_s);
    }
  }
  w.EndObject();

  overall.min_time_s = overall_min_s;
  overall.max_time_s = overall_max_s;
  w.Key("available_kinds"); write_string_list(w, available);
  w.Key("missing_kinds"); write_string_list(w, missing_kinds);
  w.Key("rows"); w.Int64(overall.rows);
  write_time_bounds(w, overall);
  if (available.empty()) {
    const std::string message = "No OpenTelemetry exporter metrics tables named " + metrics.database + "." +
        metrics.table_prefix + "_{gauge,sum,histogram,exponential_histogram,summary} exist on host " + host_id + ".";
    w.Key("error_code"); w.String("metrics_tables_missing");
    w.Key("message"); w.String(message.c_str());
  }
  const auto has = [&](const char* kind) { return std::find(available.begin(), available.end(), kind) != available.end(); };
  w.Key("features");
  w.StartObject();
  w.Key("browse"); w.Bool(!available.empty());
  w.Key("gauges"); w.Bool(has("gauge"));
  w.Key("sums"); w.Bool(has("sum"));
  w.Key("histograms"); w.Bool(has("histogram"));
  w.Key("exponential_histograms"); w.Bool(has("exponential_histogram"));
  w.Key("summaries"); w.Bool(has("summary"));
  w.Key("exemplars"); w.Bool(any_exemplars);
  w.Key("trace_correlation"); w.Bool(any_exemplars && otel.traces.enabled);
  w.Key("traces_enabled"); w.Bool(otel.traces.enabled);
  w.EndObject();
  w.EndObject();
  return sb.GetString();
}

bool refresh_requested(const httplib::Request& req) {
  if (!req.has_param("refresh")) return false;
  const std::string value = req.get_param_value("refresh");
  return value == "1" || value == "true";
}

} // namespace

void Server::handle_logs_meta(const httplib::Request& req, httplib::Response& res) {
  std::string host_id;
  const HostSpec* host = signal_host(cfg_, req, &host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Logs source host is not configured.");
  const LogSettings& logs = host->otel.logs;
  if (!logs.enabled) {
    return write_disabled(res, "logs", "logs_disabled",
        "OTel logs are disabled for this host. Add observability { logs { enabled = true } } to the ChDash configuration.");
  }

  // The answer names the host (source_host_id): hosts that share an identity do not share it.
  const std::string key = "logs\x1f" + host_id + '\x1f' + host->system_uri + '\x1f' + logs.database + '\x1f' + logs.table;
  std::string body;
  int64_t age_ms = 0;
  if (!refresh_requested(req) && cached_signal_meta(key, &body, &age_ms)) {
    return send_meta(res, with_cache_status(body, true, age_ms));
  }

  std::string error;
  auto client = acquire_signal_client(*host, client_pool_, &error);
  if (!client) {
    return json_error(res, 503, "logs_source_unavailable",
        error.empty() ? "Cannot connect to the logs ClickHouse source." : error);
  }
  std::map<std::string, TableInfo> tables;
  try {
    tables = load_table_infos(*client, logs.database, {logs.table});
  } catch (const std::exception& e) {
    return json_error(res, 503, "logs_schema_failed", e.what());
  }
  const auto it = tables.find(logs.table);
  if (it == tables.end() || !it->second.exists) {
    if (const auto grant = missing_select_grant(*client, logs.database, logs.table)) {
      const auto user = parse_clickhouse_uri(host->system_uri, nullptr);
      return json_not_granted(res, 503, "logs_table_not_granted", user ? user->user : std::string(), *grant,
                              "Table " + logs.database + "." + logs.table + " is not readable by the system user");
    }
  }
  static const TableInfo kMissing;
  body = build_logs_meta(host->otel, host_id, it == tables.end() ? kMissing : it->second);
  store_signal_meta(key, body);
  send_meta(res, with_cache_status(body, false, 0));
}

void Server::handle_metrics_meta(const httplib::Request& req, httplib::Response& res) {
  std::string host_id;
  const HostSpec* host = signal_host(cfg_, req, &host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Metrics source host is not configured.");
  const MetricSettings& metrics = host->otel.metrics;
  if (!metrics.enabled) {
    return write_disabled(res, "metrics", "metrics_disabled",
        "OTel metrics are disabled for this host. Add observability { metrics { enabled = true } } to the ChDash configuration.");
  }

  const std::string key = "metrics\x1f" + host_id + '\x1f' + host->system_uri + '\x1f' + metrics.database + '\x1f' +
      metrics.table_prefix;
  std::string body;
  int64_t age_ms = 0;
  if (!refresh_requested(req) && cached_signal_meta(key, &body, &age_ms)) {
    return send_meta(res, with_cache_status(body, true, age_ms));
  }

  std::string error;
  auto client = acquire_signal_client(*host, client_pool_, &error);
  if (!client) {
    return json_error(res, 503, "metrics_source_unavailable",
        error.empty() ? "Cannot connect to the metrics ClickHouse source." : error);
  }
  std::vector<std::string> names;
  for (const auto& kind : metric_kinds()) names.push_back(metrics.table_prefix + kind.suffix);
  std::map<std::string, TableInfo> tables;
  try {
    tables = load_table_infos(*client, metrics.database, names);
  } catch (const std::exception& e) {
    return json_error(res, 503, "metrics_schema_failed", e.what());
  }
  {
    // Every kind table absent from system.tables: a grant that is missing looks the same as a table that is missing.
    bool any = false;
    for (const auto& entry : tables) any = any || entry.second.exists;
    if (!any && !names.empty()) {
      if (const auto grant = missing_select_grant(*client, metrics.database, names.front())) {
        const auto user = parse_clickhouse_uri(host->system_uri, nullptr);
        return json_not_granted(res, 503, "metrics_table_not_granted", user ? user->user : std::string(), *grant,
                                "Table " + metrics.database + "." + names.front() + " is not readable by the system user");
      }
    }
  }
  body = build_metrics_meta(host->otel, host_id, tables);
  store_signal_meta(key, body);
  send_meta(res, with_cache_status(body, false, 0));
}

} // namespace chdash
