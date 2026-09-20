#include "server.hpp"

#include "api_error.hpp"
#include "ch_block_value.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"

#include <clickhouse/client.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <iterator>
#include <memory>
#include <map>
#include <numeric>
#include <set>
#include <stdexcept>
#include <unordered_map>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace {

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

std::string quote_string(std::string_view value) {
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

std::string qualified(std::string_view database, std::string_view table) {
  return quote_ident(database) + "." + quote_ident(table);
}

const HostSpec* trace_host(const AppConfig& cfg, const httplib::Request& req, std::string* host_id) {
  std::string id;
  if (req.has_param("host_id")) id = req.get_param_value("host_id");
  if (id.empty() && cfg.hosts.size() == 1) id = cfg.hosts.front().id;
  if (host_id) *host_id = id;
  return id.empty() ? nullptr : find_host(cfg.hosts, id);
}

std::shared_ptr<clickhouse::Client> acquire_trace_client(
    const AppConfig& cfg,
    const HostSpec& host,
    const std::shared_ptr<ClickHouseClientPool>& pool,
    std::string* error) {
  if (host.system_uri.empty()) {
    if (error) *error = "Trace Explorer requires system credentials for the selected host.";
    return nullptr;
  }
  const std::string& uri = host.system_uri;
  const auto connect_timeout = std::chrono::seconds(5);
  const auto send_timeout = std::chrono::seconds(15);
  const auto receive_timeout = std::chrono::seconds(30);
  return pool
      ? pool->acquire(uri, connect_timeout, send_timeout, receive_timeout, error)
      : make_client_from_uri(uri, connect_timeout, send_timeout, receive_timeout, error);
}

int int_param(const httplib::Request& req, const char* name, int fallback, int lo, int hi) {
  if (!req.has_param(name)) return fallback;
  try {
    long long value = std::stoll(req.get_param_value(name));
    return static_cast<int>(std::max<long long>(lo, std::min<long long>(hi, value)));
  } catch (...) {
    return fallback;
  }
}

double double_param(const httplib::Request& req, const char* name, double fallback, double lo, double hi) {
  if (!req.has_param(name)) return fallback;
  try {
    const double value = std::stod(req.get_param_value(name));
    if (!std::isfinite(value)) return fallback;
    return std::max(lo, std::min(hi, value));
  } catch (...) {
    return fallback;
  }
}

std::vector<std::string> split_us(std::string_view text) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= text.size(); ++i) {
    if (i != text.size() && text[i] != '\x1f') continue;
    if (i > start) out.emplace_back(text.substr(start, i - start));
    start = i + 1;
  }
  return out;
}

void write_string_array(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::vector<std::string>& values) {
  w.StartArray();
  for (const auto& value : values) w.String(value.c_str());
  w.EndArray();
}

std::string regex_escape(std::string_view value) {
  std::string out;
  out.reserve(value.size() * 2);
  for (char ch : value) {
    switch (ch) {
      case '.': case '^': case '$': case '|': case '(': case ')':
      case '[': case ']': case '{': case '}': case '+': case '?': case '\\':
        out.push_back('\\');
        break;
      default:
        break;
    }
    out.push_back(ch);
  }
  return out;
}

std::string service_pattern_predicate(std::string_view pattern) {
  if (pattern == "*") return "1";
  const size_t first = pattern.find('*');
  if (first == std::string_view::npos) {
    return "ServiceName = " + quote_string(pattern);
  }
  if (first == pattern.size() - 1 && pattern.find('*', first + 1) == std::string_view::npos) {
    return "startsWith(ServiceName, " + quote_string(pattern.substr(0, pattern.size() - 1)) + ")";
  }
  if (first == 0 && pattern.find('*', 1) == std::string_view::npos) {
    return "endsWith(ServiceName, " + quote_string(pattern.substr(1)) + ")";
  }

  std::string regex = "^";
  size_t start = 0;
  while (start <= pattern.size()) {
    const size_t star = pattern.find('*', start);
    const size_t end = star == std::string_view::npos ? pattern.size() : star;
    regex += regex_escape(pattern.substr(start, end - start));
    if (star == std::string_view::npos) break;
    regex += ".*";
    start = star + 1;
  }
  regex += "$";
  return "match(ServiceName, " + quote_string(regex) + ")";
}

std::string service_allowlist_predicate(const TraceSettings& cfg) {
  if (cfg.service_allowlist.empty()) return "0";
  for (const auto& pattern : cfg.service_allowlist) {
    if (pattern == "*") return "1";
  }
  std::string out = "(";
  bool first = true;
  for (const auto& pattern : cfg.service_allowlist) {
    if (!first) out += " OR ";
    first = false;
    out += service_pattern_predicate(pattern);
  }
  out += ")";
  return out;
}

bool feature_param_rejected(const TraceSettings& cfg, const httplib::Request& req, std::string* message) {
  struct Check { const char* param; bool enabled; const char* label; };
  const Check checks[] = {
    {"service", cfg.features.service_filter, "service filter"},
    {"operation", cfg.features.operation_filter, "operation filter"},
    {"status", cfg.features.status_filter, "status filter"},
    {"min_duration_ms", cfg.features.duration_filter, "duration filter"},
    {"max_duration_ms", cfg.features.duration_filter, "duration filter"},
  };
  for (const auto& check : checks) {
    if (req.has_param(check.param) && !req.get_param_value(check.param).empty() && !check.enabled) {
      if (message) *message = std::string(check.label) + " is disabled by traces.features";
      return true;
    }
  }
  return false;
}


bool parse_i64_param(const httplib::Request& req, const char* name, int64_t* out) {
  if (!req.has_param(name) || req.get_param_value(name).empty()) return false;
  try {
    *out = std::stoll(req.get_param_value(name));
    return true;
  } catch (...) {
    return false;
  }
}

bool trace_time_range(const TraceSettings& cfg, const httplib::Request& req, int64_t* start_ms, int64_t* end_ms, std::string* error) {
  int64_t lo = 0, hi = 0;
  const bool has_lo = parse_i64_param(req, "start_ms", &lo);
  const bool has_hi = parse_i64_param(req, "end_ms", &hi);
  if (has_lo || has_hi) {
    if (!has_lo || !has_hi) {
      if (error) *error = "start_ms and end_ms must be provided together.";
      return false;
    }
  } else {
    const int lookback = int_param(req, "lookback_minutes", cfg.default_lookback_minutes, 1, cfg.max_lookback_minutes);
    const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    hi = now_ms;
    lo = hi - static_cast<int64_t>(lookback) * 60 * 1000;
  }
  if (lo < 0 || hi <= lo) {
    if (error) *error = "Invalid trace time range.";
    return false;
  }
  const int64_t max_ms = static_cast<int64_t>(cfg.max_lookback_minutes) * 60 * 1000;
  if (hi - lo > max_ms) {
    if (error) *error = "Trace time range exceeds traces.max_lookback_minutes.";
    return false;
  }
  *start_ms = lo;
  *end_ms = hi;
  return true;
}

std::string trace_time_predicate(int64_t start_ms, int64_t end_ms) {
  return "Timestamp >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND Timestamp <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")";
}

std::vector<std::string> repeated_param_values(const httplib::Request& req, std::string_view name) {
  std::vector<std::string> values;
  const auto range = req.params.equal_range(std::string(name));
  for (auto it = range.first; it != range.second; ++it) {
    if (!it->second.empty()) values.push_back(it->second);
  }
  std::sort(values.begin(), values.end());
  values.erase(std::unique(values.begin(), values.end()), values.end());
  return values;
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

std::string trace_span_filters(const TraceSettings& cfg, const httplib::Request& req, std::string* validation_error = nullptr) {
  (void)cfg;
  const auto services = repeated_param_values(req, "service");
  const auto operations = repeated_param_values(req, "operation");
  const std::string status = req.has_param("status") ? req.get_param_value("status") : std::string{};
  const std::string tag_scope = req.has_param("tag_scope") ? req.get_param_value("tag_scope") : std::string{};
  const std::string tag_key = req.has_param("tag_key") ? req.get_param_value("tag_key") : std::string{};
  const std::string tag_value = req.has_param("tag_value") ? req.get_param_value("tag_value") : std::string{};

  if (!status.empty() && status != "Error" && status != "Ok" && status != "Unset") {
    if (validation_error) *validation_error = "status must be Error, Ok, Unset, or empty.";
    return {};
  }
  if ((!tag_key.empty() || !tag_value.empty()) && (tag_key.empty() || tag_value.empty())) {
    if (validation_error) *validation_error = "tag_key and tag_value must be provided together.";
    return {};
  }
  if (!tag_key.empty() && tag_scope != "span" && tag_scope != "resource" && tag_scope != "any") {
    if (validation_error) *validation_error = "tag_scope must be span, resource, or any.";
    return {};
  }

  std::vector<std::string> filters;
  if (!services.empty()) filters.push_back(exact_values_predicate("ServiceName", services));
  if (!operations.empty()) filters.push_back(exact_values_predicate("SpanName", operations));
  if (!status.empty()) filters.push_back("StatusCode = " + quote_string(status));
  if (!tag_key.empty()) {
    if (tag_scope == "any") {
      filters.push_back("((mapContains(SpanAttributes, " + quote_string(tag_key) + ") AND SpanAttributes[" + quote_string(tag_key) + "] = " + quote_string(tag_value) + ") OR "
                        "(mapContains(ResourceAttributes, " + quote_string(tag_key) + ") AND ResourceAttributes[" + quote_string(tag_key) + "] = " + quote_string(tag_value) + "))");
    } else {
      const std::string column = tag_scope == "resource" ? "ResourceAttributes" : "SpanAttributes";
      filters.push_back("mapContains(" + column + ", " + quote_string(tag_key) + ") AND " + column + "[" + quote_string(tag_key) + "] = " + quote_string(tag_value));
    }
  }

  std::string out;
  for (const auto& filter : filters) out += " AND " + filter;
  return out;
}

int choose_trace_bucket_seconds(int64_t range_ms) {
  // Aim for roughly 60 visible buckets. A one-hour range therefore has one bar per minute.
  const int64_t desired = std::max<int64_t>(60, range_ms / 1000 / 60);
  const int candidates[] = {60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800, 1209600, 2592000};
  for (int value : candidates) if (value >= desired) return value;
  return candidates[sizeof(candidates) / sizeof(candidates[0]) - 1];
}

int choose_trace_quantile_bucket_seconds(int64_t range_ms) {
  // Keep latency quantiles denser than the count chart while retaining a one-minute floor.
  const int64_t desired = std::max<int64_t>(60, range_ms / 1000 / 120);
  const int candidates[] = {60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800};
  for (int value : candidates) if (value >= desired) return value;
  return candidates[sizeof(candidates) / sizeof(candidates[0]) - 1];
}

std::vector<std::string> split_char(std::string_view text, char delimiter) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= text.size(); ++i) {
    if (i != text.size() && text[i] != delimiter) continue;
    out.emplace_back(text.substr(start, i - start));
    start = i + 1;
  }
  return out;
}

bool trace_attribute_maps(clickhouse::Client& client, const TraceSettings& cfg, bool* span_map, bool* resource_map) {
  *span_map = false;
  *resource_map = false;
  try {
    client.Select(
        "SELECT toString(name), toString(type) FROM system.columns WHERE database = " + quote_string(cfg.database) +
        " AND `table` = " + quote_string(cfg.table) + " AND name IN ('SpanAttributes','ResourceAttributes')",
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            const std::string name = ch_block_text_at(block, 0, row);
            const std::string type = ch_block_text_at(block, 1, row);
            const bool map = type.rfind("Map(", 0) == 0;
            if (name == "SpanAttributes") *span_map = map;
            if (name == "ResourceAttributes") *resource_map = map;
          }
        });
    return true;
  } catch (...) {
    return false;
  }
}

} // namespace

void Server::handle_traces_meta(const httplib::Request& req, httplib::Response& res) {
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  std::set<std::string> columns;
  bool schema_ok = false;
  bool index_available = false;
  bool span_attribute_map = false;
  bool resource_attribute_map = false;
  try {
    const std::string db = quote_string(cfg_.traces.database);
    const std::string table = quote_string(cfg_.traces.table);
    client->Select(
        "SELECT toString(name) FROM system.columns WHERE database = " + db + " AND `table` = " + table,
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) columns.insert(ch_block_text_at(block, 0, row));
        });
    const char* required[] = {"Timestamp", "TraceId", "SpanId", "ParentSpanId", "SpanName", "ServiceName", "Duration", "StatusCode"};
    schema_ok = std::all_of(std::begin(required), std::end(required), [&](const char* name) { return columns.count(name) != 0; });

    if (!cfg_.traces.trace_index_table.empty()) {
      uint64_t count = 0;
      client->Select(
          "SELECT toString(count()) FROM system.tables WHERE database = " + db +
          " AND name = " + quote_string(cfg_.traces.trace_index_table),
          [&](const clickhouse::Block& block) {
            if (block.GetRowCount()) count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
          });
      index_available = count > 0;
    }
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_schema_failed", e.what());
  }

  trace_attribute_maps(*client, cfg_.traces, &span_attribute_map, &resource_attribute_map);

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("enabled"); w.Bool(true);
  w.Key("analytics_enabled"); w.Bool(cfg_.traces.analytics);
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("database"); w.String(cfg_.traces.database.c_str());
  w.Key("table"); w.String(cfg_.traces.table.c_str());
  w.Key("trace_index_table"); w.String(cfg_.traces.trace_index_table.c_str());
  w.Key("trace_index_available"); w.Bool(index_available);
  w.Key("schema_ok"); w.Bool(schema_ok);
  w.Key("default_lookback_minutes"); w.Int(cfg_.traces.default_lookback_minutes);
  w.Key("max_lookback_minutes"); w.Int(cfg_.traces.max_lookback_minutes);
  w.Key("search_limit"); w.Uint64(cfg_.traces.search_limit);
  w.Key("max_spans_per_trace"); w.Uint64(cfg_.traces.max_spans_per_trace);
  w.Key("tag_search_supported"); w.Bool(span_attribute_map || resource_attribute_map);
  w.Key("span_attribute_map"); w.Bool(span_attribute_map);
  w.Key("resource_attribute_map"); w.Bool(resource_attribute_map);
  w.Key("features");
  w.StartObject();
  w.Key("service_filter"); w.Bool(cfg_.traces.features.service_filter);
  w.Key("operation_filter"); w.Bool(cfg_.traces.features.operation_filter);
  w.Key("status_filter"); w.Bool(cfg_.traces.features.status_filter);
  w.Key("duration_filter"); w.Bool(cfg_.traces.features.duration_filter);
  w.Key("resource_attributes"); w.Bool(cfg_.traces.features.resource_attributes);
  w.Key("span_attributes"); w.Bool(cfg_.traces.features.span_attributes);
  w.Key("events"); w.Bool(cfg_.traces.features.events);
  w.Key("links"); w.Bool(cfg_.traces.features.links);
  w.EndObject();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_traces_prefill(const httplib::Request& req, httplib::Response& res) {
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  int64_t start_ms = 0, end_ms = 0;
  std::string range_error;
  if (!trace_time_range(cfg_.traces, req, &start_ms, &end_ms, &range_error)) {
    return json_error(res, 400, "invalid_trace_range", range_error);
  }

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const std::string time_predicate = trace_time_predicate(start_ms, end_ms);
  const size_t hard_limit = 20000;

  struct Pair { std::string service, operation; uint64_t count = 1; };
  std::vector<Pair> pairs;
  try {
    // Discovery only needs existence. Counting every span per service/operation pair
    // turns a cheap dictionary prefill into a large aggregation on busy trace tables.
    const std::string sql =
        "SELECT toString(ServiceName), toString(SpanName) FROM " + table +
        " PREWHERE " + time_predicate + " WHERE " + visibility +
        " LIMIT 1 BY ServiceName, SpanName LIMIT " + std::to_string(hard_limit + 1);
    client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        Pair item;
        item.service = ch_block_text_at(block, 0, row);
        item.operation = ch_block_text_at(block, 1, row);
        pairs.push_back(std::move(item));
      }
    });
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_prefill_failed", e.what());
  }
  std::sort(pairs.begin(), pairs.end(), [](const Pair& a, const Pair& b) {
    if (a.service != b.service) return a.service < b.service;
    return a.operation < b.operation;
  });
  const bool truncated = pairs.size() > hard_limit;
  if (truncated) pairs.resize(hard_limit);

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("range"); w.StartArray(); w.Int64(start_ms); w.Int64(end_ms); w.EndArray();
  w.Key("truncated"); w.Bool(truncated);
  w.Key("pairs"); w.StartArray();
  for (const auto& item : pairs) {
    w.StartArray(); w.String(item.service.c_str()); w.String(item.operation.c_str()); w.Uint64(item.count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_traces_search(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  std::string disabled_message;
  if (feature_param_rejected(cfg_.traces, req, &disabled_message)) {
    return json_error(res, 400, "trace_filter_disabled", disabled_message);
  }

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  int64_t start_ms = 0, end_ms = 0;
  std::string range_error;
  if (!trace_time_range(cfg_.traces, req, &start_ms, &end_ms, &range_error)) {
    return json_error(res, 400, "invalid_trace_range", range_error);
  }

  const int limit = int_param(req, "limit", static_cast<int>(cfg_.traces.search_limit), 1, static_cast<int>(cfg_.traces.search_limit));
  const double min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  const double max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  if (max_duration_ms > 0.0 && min_duration_ms > max_duration_ms) {
    return json_error(res, 400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
  }

  std::string validation_error;
  const std::string span_filters = trace_span_filters(cfg_.traces, req, &validation_error);
  if (!validation_error.empty()) return json_error(res, 400, "invalid_trace_filter", validation_error);

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  if (req.has_param("tag_key") && !req.get_param_value("tag_key").empty()) {
    bool span_map = false, resource_map = false;
    trace_attribute_maps(*client, cfg_.traces, &span_map, &resource_map);
    const std::string scope = req.has_param("tag_scope") ? req.get_param_value("tag_scope") : std::string{};
    if ((scope == "span" && !span_map) || (scope == "resource" && !resource_map) ||
        (scope == "any" && !span_map && !resource_map)) {
      return json_error(res, 400, "trace_tag_search_unsupported", "Selected attribute scope is not stored as Map(String, String).");
    }
  }

  const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string time_predicate = trace_time_predicate(start_ms, end_ms);
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const bool has_candidate_filters = !span_filters.empty();
  const bool has_duration_filters = min_duration_ms > 0.0 || max_duration_ms > 0.0;
  const bool needs_span_match = has_candidate_filters || visibility != "1";

  const std::string candidate_cte = has_candidate_filters
      ? "candidate_ids AS (SELECT TraceId FROM " + table + " PREWHERE " + time_predicate +
        " WHERE " + visibility + span_filters + " LIMIT 1 BY TraceId)"
      : std::string{};
  const std::string candidate_where = has_candidate_filters ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : std::string{};

  // Duration is a trace-level filter and therefore stays after candidate span matching.
  const std::string duration_expr =
      "(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - "
      "toInt64(min(toUnixTimestamp64Nano(Timestamp))))";
  std::string having;
  if (min_duration_ms > 0.0) {
    const uint64_t ns = static_cast<uint64_t>(std::llround(min_duration_ms * 1000000.0));
    having += (having.empty() ? " HAVING " : " AND ") + duration_expr + " >= " + std::to_string(ns);
  }
  if (max_duration_ms > 0.0) {
    const uint64_t ns = static_cast<uint64_t>(std::llround(max_duration_ms * 1000000.0));
    having += (having.empty() ? " HAVING " : " AND ") + duration_expr + " <= " + std::to_string(ns);
  }

  struct ServiceStat { std::string service; uint64_t spans = 0, errors = 0; };
  struct Row {
    std::string trace_id, operation, service;
    int64_t start_ms = 0;
    uint64_t duration_ns = 0, spans = 0, errors = 0;
    std::vector<ServiceStat> service_stats;
  };
  std::vector<Row> rows;

  auto read_summary = [&](const std::string& sql) {
    client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        Row out;
        out.trace_id = ch_block_text_at(block, 0, row);
        out.start_ms = std::stoll(ch_block_text_at(block, 1, row));
        out.operation = ch_block_text_at(block, 2, row);
        out.service = ch_block_text_at(block, 3, row);
        out.duration_ns = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row)));
        out.spans = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)));
        out.errors = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 6, row)));
        std::map<std::string, ServiceStat> stats;
        for (const auto& item : split_char(ch_block_text_at(block, 7, row), '\x1f')) {
          const auto pair = split_char(item, '\x1e');
          if (pair.empty() || pair[0].empty()) continue;
          auto& stat = stats[pair[0]];
          stat.service = pair[0];
          stat.spans += 1;
          if (pair.size() > 1 && pair[1] == "Error") stat.errors += 1;
        }
        for (auto& entry : stats) out.service_stats.push_back(std::move(entry.second));
        std::sort(out.service_stats.begin(), out.service_stats.end(), [](const ServiceStat& a, const ServiceStat& b) {
          if (a.spans != b.spans) return a.spans > b.spans;
          return a.service < b.service;
        });
        rows.push_back(std::move(out));
      }
    });
  };

  const std::string aggregate_select =
      "SELECT toString(TraceId), toString(toUnixTimestamp64Milli(min(Timestamp))), "
      "toString(if(empty(argMinIf(SpanName, Timestamp, empty(ParentSpanId))), argMin(SpanName, Timestamp), argMinIf(SpanName, Timestamp, empty(ParentSpanId)))), "
      "toString(if(empty(argMinIf(ServiceName, Timestamp, empty(ParentSpanId))), argMin(ServiceName, Timestamp), argMinIf(ServiceName, Timestamp, empty(ParentSpanId)))), "
      "toString(" + duration_expr + "), toString(count()), toString(countIf(StatusCode = 'Error')), "
      "arrayStringConcat(groupArray(concat(toString(ServiceName), char(30), toString(StatusCode))), char(31)) ";

  auto trace_id_list_sql = [&](const std::vector<std::string>& ids) {
    std::string out = "(";
    for (size_t i = 0; i < ids.size(); ++i) {
      if (i) out += ",";
      out += quote_string(ids[i]);
    }
    out += ")";
    return out;
  };

  uint64_t candidate_query_ms = 0;
  uint64_t summary_query_ms = 0;
  bool used_trace_index_fast_path = false;
  std::string search_path = "span_aggregation";
  const bool index_fast_path_eligible = !has_duration_filters && !cfg_.traces.trace_index_table.empty();

  if (index_fast_path_eligible) {
    try {
      const std::string index_table = qualified(cfg_.traces.database, cfg_.traces.trace_index_table);
      const std::string index_time_predicate =
          "Start >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND "
          "Start <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")";

      std::vector<std::string> selected_ids;
      const auto candidate_started = std::chrono::steady_clock::now();

      if (!needs_span_match) {
        const std::string candidate_sql =
            "SELECT toString(TraceId), toString(Start), toString(End) FROM " + index_table +
            " PREWHERE " + index_time_predicate +
            " ORDER BY Start DESC LIMIT 1 BY TraceId LIMIT " + std::to_string(limit);
        client->Select(candidate_sql, [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) selected_ids.push_back(ch_block_text_at(block, 0, row));
        });
        search_path = "trace_index";
      } else {
        constexpr size_t kCandidateBatch = 1000;
        constexpr size_t kCandidateScanCap = 64000;
        size_t offset = 0;
        bool exhausted = false;

        while (selected_ids.size() < static_cast<size_t>(limit) && offset < kCandidateScanCap) {
          std::vector<std::string> batch_ids;
          const std::string candidate_sql =
              "SELECT toString(TraceId), toString(Start), toString(End) FROM " + index_table +
              " PREWHERE " + index_time_predicate +
              " ORDER BY Start DESC LIMIT 1 BY TraceId LIMIT " + std::to_string(kCandidateBatch) +
              " OFFSET " + std::to_string(offset);
          client->Select(candidate_sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) batch_ids.push_back(ch_block_text_at(block, 0, row));
          });

          if (batch_ids.empty()) {
            exhausted = true;
            break;
          }

          const std::string batch_list = trace_id_list_sql(batch_ids);
          std::unordered_set<std::string> matching_ids;
          const std::string match_sql =
              "SELECT toString(TraceId) FROM " + table +
              " PREWHERE " + time_predicate +
              " WHERE " + visibility + span_filters + " AND TraceId IN " + batch_list +
              " LIMIT 1 BY TraceId";
          client->Select(match_sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) matching_ids.insert(ch_block_text_at(block, 0, row));
          });

          for (const auto& id : batch_ids) {
            if (matching_ids.find(id) == matching_ids.end()) continue;
            selected_ids.push_back(id);
            if (selected_ids.size() >= static_cast<size_t>(limit)) break;
          }

          if (batch_ids.size() < kCandidateBatch) {
            exhausted = true;
            break;
          }
          offset += kCandidateBatch;
        }

        if (selected_ids.size() < static_cast<size_t>(limit) && !exhausted && offset >= kCandidateScanCap) {
          throw std::runtime_error("filtered trace-index candidate scan cap reached");
        }
        search_path = "trace_index_filtered";
      }

      candidate_query_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - candidate_started).count());

      if (!selected_ids.empty()) {
        const auto summary_started = std::chrono::steady_clock::now();
        const std::string trace_id_list = trace_id_list_sql(selected_ids);
        const std::string summary_sql = aggregate_select +
            "FROM " + table + " PREWHERE " + time_predicate +
            " WHERE " + visibility + " AND TraceId IN " + trace_id_list +
            " GROUP BY TraceId ORDER BY min(Timestamp) DESC LIMIT " + std::to_string(limit);
        read_summary(summary_sql);
        summary_query_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - summary_started).count());
      }

      used_trace_index_fast_path = true;
    } catch (...) {
      rows.clear();
      candidate_query_ms = 0;
      summary_query_ms = 0;
      search_path = "span_aggregation";
    }
  }

  if (!used_trace_index_fast_path) {
    try {
      const auto summary_started = std::chrono::steady_clock::now();
      const std::string summary_sql =
          (has_candidate_filters ? "WITH " + candidate_cte + " " : "") + aggregate_select +
          "FROM " + table + " PREWHERE " + time_predicate + " WHERE " + visibility + candidate_where +
          " GROUP BY TraceId" + having + " ORDER BY min(Timestamp) DESC LIMIT " + std::to_string(limit);
      read_summary(summary_sql);
      summary_query_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - summary_started).count());
    } catch (const std::exception& e) {
      return json_error(res, 503, "trace_search_failed", e.what());
    }
  }

  std::vector<std::string> service_dict;
  std::unordered_map<std::string, size_t> service_index;
  auto intern_service = [&](const std::string& name) -> size_t {
    auto it = service_index.find(name);
    if (it != service_index.end()) return it->second;
    const size_t idx = service_dict.size();
    service_dict.push_back(name);
    service_index.emplace(name, idx);
    return idx;
  };
  for (const auto& row : rows) {
    intern_service(row.service);
    for (const auto& stat : row.service_stats) intern_service(stat.service);
  }

  const uint64_t total_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - request_started).count());

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(3);
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("search_path"); w.String(search_path.c_str());
  w.Key("timing_ms"); w.StartObject();
  w.Key("candidates"); w.Uint64(candidate_query_ms);
  w.Key("summary"); w.Uint64(summary_query_ms);
  w.Key("total"); w.Uint64(total_ms);
  w.EndObject();
  w.Key("services"); write_string_array(w, service_dict);
  w.Key("columns"); w.StartArray();
  for (const char* col : {"trace_id", "start_ms", "root_operation", "root_service", "duration_ns", "span_count", "error_count", "service_stats"}) w.String(col);
  w.EndArray();
  w.Key("rows"); w.StartArray();
  for (const auto& row : rows) {
    w.StartArray();
    w.String(row.trace_id.c_str()); w.Int64(row.start_ms); w.String(row.operation.c_str()); w.Uint64(intern_service(row.service));
    w.Uint64(row.duration_ns); w.Uint64(row.spans); w.Uint64(row.errors);
    w.StartArray();
    for (const auto& stat : row.service_stats) {
      w.StartArray(); w.Uint64(intern_service(stat.service)); w.Uint64(stat.spans); w.Uint64(stat.errors); w.EndArray();
    }
    w.EndArray();
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_traces_analytics(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  if (!cfg_.traces.analytics) return json_error(res, 404, "trace_analytics_disabled", "Trace analytics are disabled by configuration.");

  std::string disabled_message;
  if (feature_param_rejected(cfg_.traces, req, &disabled_message)) {
    return json_error(res, 400, "trace_filter_disabled", disabled_message);
  }

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  int64_t start_ms = 0, end_ms = 0;
  std::string range_error;
  if (!trace_time_range(cfg_.traces, req, &start_ms, &end_ms, &range_error)) {
    return json_error(res, 400, "invalid_trace_range", range_error);
  }

  const double min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  const double max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  if (max_duration_ms > 0.0 && min_duration_ms > max_duration_ms) {
    return json_error(res, 400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
  }

  std::string validation_error;
  const std::string span_filters = trace_span_filters(cfg_.traces, req, &validation_error);
  if (!validation_error.empty()) return json_error(res, 400, "invalid_trace_filter", validation_error);

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  if (req.has_param("tag_key") && !req.get_param_value("tag_key").empty()) {
    bool span_map = false, resource_map = false;
    trace_attribute_maps(*client, cfg_.traces, &span_map, &resource_map);
    const std::string scope = req.has_param("tag_scope") ? req.get_param_value("tag_scope") : std::string{};
    if ((scope == "span" && !span_map) || (scope == "resource" && !resource_map) ||
        (scope == "any" && !span_map && !resource_map)) {
      return json_error(res, 400, "trace_tag_search_unsupported", "Selected attribute scope is not stored as Map(String, String).");
    }
  }

  const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string time_predicate = trace_time_predicate(start_ms, end_ms);
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const bool has_candidate_filters = !span_filters.empty();
  const bool has_duration_filters = min_duration_ms > 0.0 || max_duration_ms > 0.0;
  const bool needs_span_match = has_candidate_filters || visibility != "1";

  const std::string candidate_cte = has_candidate_filters
      ? "candidate_ids AS (SELECT TraceId FROM " + table + " PREWHERE " + time_predicate +
        " WHERE " + visibility + span_filters + " LIMIT 1 BY TraceId)"
      : std::string{};
  const std::string candidate_where = has_candidate_filters ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : std::string{};

  const std::string duration_expr =
      "(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - "
      "toInt64(min(toUnixTimestamp64Nano(Timestamp))))";
  std::string having;
  if (min_duration_ms > 0.0) {
    const uint64_t ns = static_cast<uint64_t>(std::llround(min_duration_ms * 1000000.0));
    having += (having.empty() ? " HAVING " : " AND ") + duration_expr + " >= " + std::to_string(ns);
  }
  if (max_duration_ms > 0.0) {
    const uint64_t ns = static_cast<uint64_t>(std::llround(max_duration_ms * 1000000.0));
    having += (having.empty() ? " HAVING " : " AND ") + duration_expr + " <= " + std::to_string(ns);
  }

  struct TraceCountPoint { int64_t bucket_ms = 0; uint64_t count = 0; };
  struct QuantilePoint { int64_t bucket_ms = 0; uint64_t p50 = 0, p90 = 0, p95 = 0, p99 = 0; };
  std::vector<TraceCountPoint> trace_counts;
  std::vector<QuantilePoint> quantiles;

  const int bucket_seconds = choose_trace_bucket_seconds(end_ms - start_ms);
  int quantile_bucket_seconds = choose_trace_quantile_bucket_seconds(end_ms - start_ms);
  if (bucket_seconds % quantile_bucket_seconds != 0) {
    quantile_bucket_seconds = std::max(60, std::gcd(bucket_seconds, quantile_bucket_seconds));
  }
  const int64_t bucket_ms = static_cast<int64_t>(bucket_seconds) * 1000;
  const int64_t quantile_bucket_ms = static_cast<int64_t>(quantile_bucket_seconds) * 1000;
  const bool align_buckets = req.has_param("align_buckets") && req.get_param_value("align_buckets") == "1";
  const int64_t analytics_start_ms = align_buckets ? (start_ms / bucket_ms) * bucket_ms : start_ms;
  const int64_t analytics_end_ms = align_buckets ? ((end_ms + bucket_ms - 1) / bucket_ms) * bucket_ms : end_ms;

  auto read_analytics = [&](const std::string& sql) {
    std::map<int64_t, uint64_t> count_by_bucket;
    client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const int64_t q_bucket_ms = std::stoll(ch_block_text_at(block, 0, row));
        const uint64_t count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 1, row)));
        const int64_t count_bucket_ms = (q_bucket_ms / bucket_ms) * bucket_ms;
        count_by_bucket[count_bucket_ms] += count;
        quantiles.push_back(QuantilePoint{
            q_bucket_ms,
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row))),
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row))),
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row))),
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)))});
      }
    });
    for (const auto& [bucket, count] : count_by_bucket) trace_counts.push_back(TraceCountPoint{bucket, count});
  };

  uint64_t analytics_query_ms = 0;
  bool used_trace_index_fast_path = false;
  std::string analytics_path = "span_aggregation";
  std::string quantile_source = "span_bounds";
  const bool index_fast_path_eligible = !has_duration_filters && !cfg_.traces.trace_index_table.empty();

  if (index_fast_path_eligible) {
    try {
      const auto analytics_started = std::chrono::steady_clock::now();
      const std::string index_table = qualified(cfg_.traces.database, cfg_.traces.trace_index_table);
      const std::string index_time_predicate =
          "Start >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND "
          "Start <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")";
      const std::string trace_bounds_cte = needs_span_match
          ? "WITH matching_ids AS (SELECT TraceId FROM " + table + " PREWHERE " + time_predicate +
            " WHERE " + visibility + span_filters + " LIMIT 1 BY TraceId), "
            "trace_bounds AS (SELECT TraceId, Start AS trace_start, End AS trace_end FROM " + index_table +
            " PREWHERE " + index_time_predicate +
            " WHERE TraceId IN (SELECT TraceId FROM matching_ids) LIMIT 1 BY TraceId) "
          : "WITH trace_bounds AS (SELECT TraceId, Start AS trace_start, End AS trace_end FROM " + index_table +
            " PREWHERE " + index_time_predicate + " LIMIT 1 BY TraceId) ";

      const std::string index_duration_expr =
          "greatest(toInt64(0), toInt64(toUnixTimestamp64Nano(toDateTime64(trace_end, 9))) - "
          "toInt64(toUnixTimestamp64Nano(toDateTime64(trace_start, 9))))";
      const std::string analytics_sql = trace_bounds_cte +
          "SELECT toString(toUnixTimestamp64Milli(toDateTime64(toStartOfInterval(toDateTime64(trace_start, 9), "
          "toIntervalSecond(" + std::to_string(quantile_bucket_seconds) + ")), 3))) AS bucket_ms, "
          "toString(count()), "
          "toString(toUInt64(quantileTDigest(0.50)(" + index_duration_expr + "))), "
          "toString(toUInt64(quantileTDigest(0.90)(" + index_duration_expr + "))), "
          "toString(toUInt64(quantileTDigest(0.95)(" + index_duration_expr + "))), "
          "toString(toUInt64(quantileTDigest(0.99)(" + index_duration_expr + "))) "
          "FROM trace_bounds GROUP BY bucket_ms ORDER BY bucket_ms";
      read_analytics(analytics_sql);
      analytics_query_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - analytics_started).count());
      used_trace_index_fast_path = true;
      analytics_path = "trace_index";
      quantile_source = "trace_index_bounds";
    } catch (...) {
      trace_counts.clear();
      quantiles.clear();
      analytics_query_ms = 0;
      analytics_path = "span_aggregation";
    }
  }

  if (!used_trace_index_fast_path) {
    try {
      const auto analytics_started = std::chrono::steady_clock::now();
      const std::string trace_scope = " FROM " + table + " PREWHERE " + time_predicate + " WHERE " + visibility + candidate_where +
          " GROUP BY TraceId" + having;
      const std::string with_candidate = has_candidate_filters ? "WITH " + candidate_cte + ", " : "WITH ";
      const std::string trace_durations_cte = with_candidate +
          "trace_durations AS (SELECT min(Timestamp) AS trace_start, " + duration_expr + " AS duration_ns" + trace_scope + ") ";
      const std::string analytics_sql = trace_durations_cte +
          "SELECT toString(toUnixTimestamp64Milli(toDateTime64(toStartOfInterval(trace_start, toIntervalSecond(" +
          std::to_string(quantile_bucket_seconds) + ")), 3))) AS bucket_ms, toString(count()), "
          "toString(toUInt64(quantileTDigest(0.50)(duration_ns))), toString(toUInt64(quantileTDigest(0.90)(duration_ns))), "
          "toString(toUInt64(quantileTDigest(0.95)(duration_ns))), toString(toUInt64(quantileTDigest(0.99)(duration_ns))) "
          "FROM trace_durations GROUP BY bucket_ms ORDER BY bucket_ms";
      read_analytics(analytics_sql);
      analytics_query_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - analytics_started).count());
    } catch (const std::exception& e) {
      return json_error(res, 503, "trace_analytics_failed", e.what());
    }
  }

  const uint64_t total_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - request_started).count());

  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("analytics_path"); w.String(analytics_path.c_str());
  w.Key("duration_quantiles_source"); w.String(quantile_source.c_str());
  w.Key("timing_ms"); w.StartObject();
  w.Key("analytics"); w.Uint64(analytics_query_ms);
  w.Key("total"); w.Uint64(total_ms);
  w.EndObject();
  w.Key("range"); w.StartArray(); w.Int64(analytics_start_ms); w.Int64(analytics_end_ms); w.EndArray();
  w.Key("bucket_ms"); w.Int64(bucket_ms);
  w.Key("quantile_bucket_ms"); w.Int64(quantile_bucket_ms);
  w.Key("trace_count_chart"); w.StartArray();
  for (const auto& point : trace_counts) {
    w.StartArray(); w.Int64(point.bucket_ms); w.Uint64(point.count); w.EndArray();
  }
  w.EndArray();
  w.Key("duration_quantiles"); w.StartArray();
  for (const auto& point : quantiles) {
    w.StartArray(); w.Int64(point.bucket_ms); w.Uint64(point.p50); w.Uint64(point.p90); w.Uint64(point.p95); w.Uint64(point.p99); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_trace_detail(const httplib::Request& req, httplib::Response& res) {
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  if (!req.has_param("trace_id") || req.get_param_value("trace_id").empty()) {
    return json_error(res, 400, "missing_trace_id", "trace_id is required.");
  }
  const std::string trace_id = req.get_param_value("trace_id");
  if (trace_id.size() > 256) return json_error(res, 400, "invalid_trace_id", "trace_id is too long.");

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  const auto& f = cfg_.traces.features;
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const std::string span_attrs = f.span_attributes ? "toJSONString(SpanAttributes)" : "'{}'";
  const std::string resource_attrs = f.resource_attributes ? "toJSONString(ResourceAttributes)" : "'{}'";
  const std::string events_ts = f.events ? "toJSONString(Events.Timestamp)" : "'[]'";
  const std::string events_name = f.events ? "toJSONString(Events.Name)" : "'[]'";
  const std::string events_attrs = f.events ? "toJSONString(Events.Attributes)" : "'[]'";
  const std::string links_trace = f.links ? "toJSONString(Links.TraceId)" : "'[]'";
  const std::string links_span = f.links ? "toJSONString(Links.SpanId)" : "'[]'";
  const std::string links_attrs = f.links ? "toJSONString(Links.Attributes)" : "'[]'";
  const std::string main_table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string trace_literal = quote_string(trace_id);
  const size_t limit = cfg_.traces.max_spans_per_trace + 1;

  const std::string select_columns =
      "SELECT toString(Timestamp), toString(toUnixTimestamp64Nano(Timestamp)), toString(TraceId), toString(SpanId), "
      "toString(ParentSpanId), toString(SpanName), toString(SpanKind), toString(ServiceName), toString(Duration), "
      "toString(StatusCode), toString(StatusMessage), " + span_attrs + ", " + resource_attrs + ", " +
      events_ts + ", " + events_name + ", " + events_attrs + ", " + links_trace + ", " + links_span + ", " + links_attrs + " ";

  struct Span {
    std::string timestamp, trace_id, span_id, parent_span_id, name, kind, service, status, status_message;
    std::string span_attributes, resource_attributes, events_timestamp, events_name, events_attributes;
    std::string links_trace_id, links_span_id, links_attributes;
    int64_t start_ns = 0;
    uint64_t duration_ns = 0;
  };
  std::vector<Span> spans;

  auto load_spans = [&](const std::string& sql) {
    client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        Span out;
        out.timestamp = ch_block_text_at(block, 0, row);
        out.start_ns = std::stoll(ch_block_text_at(block, 1, row));
        out.trace_id = ch_block_text_at(block, 2, row);
        out.span_id = ch_block_text_at(block, 3, row);
        out.parent_span_id = ch_block_text_at(block, 4, row);
        out.name = ch_block_text_at(block, 5, row);
        out.kind = ch_block_text_at(block, 6, row);
        out.service = ch_block_text_at(block, 7, row);
        out.duration_ns = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 8, row)));
        out.status = ch_block_text_at(block, 9, row);
        out.status_message = ch_block_text_at(block, 10, row);
        out.span_attributes = ch_block_text_at(block, 11, row);
        out.resource_attributes = ch_block_text_at(block, 12, row);
        out.events_timestamp = ch_block_text_at(block, 13, row);
        out.events_name = ch_block_text_at(block, 14, row);
        out.events_attributes = ch_block_text_at(block, 15, row);
        out.links_trace_id = ch_block_text_at(block, 16, row);
        out.links_span_id = ch_block_text_at(block, 17, row);
        out.links_attributes = ch_block_text_at(block, 18, row);
        spans.push_back(std::move(out));
      }
    });
  };

  if (cfg_.traces.trace_index_table.empty()) {
    return json_error(res, 503, "trace_index_unavailable", "Trace detail requires traces.trace_index_table.");
  }

  try {
    const std::string index_table = qualified(cfg_.traces.database, cfg_.traces.trace_index_table);
    const std::string indexed_sql =
        "WITH " + trace_literal + " AS trace, "
        "(SELECT min(Start) - toIntervalSecond(1) FROM " + index_table + " WHERE TraceId = trace) AS trace_start, "
        "(SELECT max(End) + toIntervalSecond(1) FROM " + index_table + " WHERE TraceId = trace) AS trace_end " +
        select_columns +
        "FROM " + main_table + " PREWHERE Timestamp >= trace_start AND Timestamp <= trace_end "
        "WHERE TraceId = trace AND " + visibility +
        " ORDER BY Timestamp, SpanId LIMIT " + std::to_string(limit);
    load_spans(indexed_sql);
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_index_lookup_failed", e.what());
  }

  bool truncated = spans.size() > cfg_.traces.max_spans_per_trace;
  if (truncated) spans.resize(cfg_.traces.max_spans_per_trace);
  if (spans.empty()) return json_error(res, 404, "trace_not_found", "Trace was not found in the configured time scope.");

  // Do not leak the SpanId of a parent that was hidden by the service
  // allowlist. Treat the first visible descendant as a visible root instead.
  std::unordered_set<std::string> visible_span_ids;
  visible_span_ids.reserve(spans.size());
  for (const auto& span : spans) visible_span_ids.insert(span.span_id);
  for (auto& span : spans) {
    if (!span.parent_span_id.empty() && visible_span_ids.count(span.parent_span_id) == 0) {
      span.parent_span_id.clear();
    }
  }

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("trace_id"); w.String(trace_id.c_str());
  w.Key("range_source"); w.String("trace_index");
  w.Key("truncated"); w.Bool(truncated);
  w.Key("spans"); w.StartArray();
  for (const auto& span : spans) {
    w.StartObject();
    w.Key("timestamp"); w.String(span.timestamp.c_str());
    w.Key("start_ns"); w.Int64(span.start_ns);
    w.Key("duration_ns"); w.Uint64(span.duration_ns);
    w.Key("trace_id"); w.String(span.trace_id.c_str());
    w.Key("span_id"); w.String(span.span_id.c_str());
    w.Key("parent_span_id"); w.String(span.parent_span_id.c_str());
    w.Key("span_name"); w.String(span.name.c_str());
    w.Key("span_kind"); w.String(span.kind.c_str());
    w.Key("service_name"); w.String(span.service.c_str());
    w.Key("status_code"); w.String(span.status.c_str());
    w.Key("status_message"); w.String(span.status_message.c_str());
    if (f.span_attributes) { w.Key("span_attributes"); w.String(span.span_attributes.c_str()); }
    if (f.resource_attributes) { w.Key("resource_attributes"); w.String(span.resource_attributes.c_str()); }
    if (f.events) {
      w.Key("events_timestamp"); w.String(span.events_timestamp.c_str());
      w.Key("events_name"); w.String(span.events_name.c_str());
      w.Key("events_attributes"); w.String(span.events_attributes.c_str());
    }
    if (f.links) {
      w.Key("links_trace_id"); w.String(span.links_trace_id.c_str());
      w.Key("links_span_id"); w.String(span.links_span_id.c_str());
      w.Key("links_attributes"); w.String(span.links_attributes.c_str());
    }
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
