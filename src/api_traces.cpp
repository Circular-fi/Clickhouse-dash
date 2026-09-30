#include "server.hpp"
#include "time_util.hpp"

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
#include <mutex>
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
  // Wide-window span aggregations (analytics, duration search) can spend tens
  // of seconds merging without sending a packet. The arguments are
  // (connect, receive, send): they used to be swapped, which made the receive
  // timeout 15 s and aborted such queries with "can't receive string data".
  const auto receive_timeout = std::chrono::seconds(60);
  return pool
      ? pool->acquire(uri, connect_timeout, receive_timeout, send_timeout, error)
      : make_client_from_uri(uri, connect_timeout, receive_timeout, send_timeout, error);
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
  // Searches convert bounds to nanoseconds (int64 overflows after year 2262).
  constexpr int64_t kMaxTraceTimeMs = INT64_MAX / 1000000 - 1;
  if (lo < 0 || hi <= lo || hi > kMaxTraceTimeMs) {
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

// Tagged searches only need to know whether the attribute columns are Maps.
// That schema fact changes on DDL, not per request, so cache it per source
// (system URI + table) instead of querying system.columns on every search.
// /api/traces/meta always reads it fresh and refreshes the cache.
struct AttributeMapCacheEntry {
  bool span_map = false;
  bool resource_map = false;
  std::chrono::steady_clock::time_point loaded_at;
};
constexpr auto kAttributeMapCacheTtl = std::chrono::seconds(60);
std::mutex g_attribute_map_mutex;
std::unordered_map<std::string, AttributeMapCacheEntry> g_attribute_map_cache;

std::string attribute_map_cache_key(const HostSpec& host, const TraceSettings& cfg) {
  return host.system_uri + '\x1f' + cfg.database + '\x1f' + cfg.table;
}

void store_trace_attribute_maps(const HostSpec& host, const TraceSettings& cfg, bool span_map, bool resource_map) {
  std::lock_guard<std::mutex> lock(g_attribute_map_mutex);
  g_attribute_map_cache[attribute_map_cache_key(host, cfg)] =
      AttributeMapCacheEntry{span_map, resource_map, std::chrono::steady_clock::now()};
}

void cached_trace_attribute_maps(clickhouse::Client& client, const HostSpec& host, const TraceSettings& cfg,
                                 bool* span_map, bool* resource_map) {
  const std::string key = attribute_map_cache_key(host, cfg);
  {
    std::lock_guard<std::mutex> lock(g_attribute_map_mutex);
    const auto it = g_attribute_map_cache.find(key);
    if (it != g_attribute_map_cache.end() &&
        std::chrono::steady_clock::now() - it->second.loaded_at < kAttributeMapCacheTtl) {
      *span_map = it->second.span_map;
      *resource_map = it->second.resource_map;
      return;
    }
  }
  // Only successful lookups are cached; a transient failure is retried next time.
  if (trace_attribute_maps(client, cfg, span_map, resource_map)) {
    store_trace_attribute_maps(host, cfg, *span_map, *resource_map);
  }
}

constexpr int64_t kNsPerMs = 1000000;

std::string ns_time(int64_t ns) {
  return "fromUnixTimestamp64Nano(" + std::to_string(ns) + ")";
}

std::string trace_id_list_sql(const std::vector<std::string>& ids) {
  std::string out = "(";
  for (size_t i = 0; i < ids.size(); ++i) {
    if (i) out += ",";
    out += quote_string(ids[i]);
  }
  out += ")";
  return out;
}

// Walks the trace index newest-first in the order of
//   ORDER BY Start DESC LIMIT 1 BY TraceId
// over the whole search window, i.e. traces ranked by their newest in-window
// index row (ties at an identical Start are unordered, as in that query).
// Paging that query with OFFSET re-sorts the entire window for every page (a
// 7-day window reads ~25M index rows per page). The cursor instead walks
// disjoint Start slices [lo, hi] newest-first through prj_start and reads each
// slice *completely*, one row per trace (max(Start) GROUP BY TraceId), into a
// buffer that next() drains:
//   * slices never overlap, so equal Starts can never straddle a page seam
//     (no skipped or duplicated trace on ties);
//   * a trace appears at most once per slice however many index rows it has
//     (the OTel MV writes one row per insert batch), so long-lived traces cannot
//     multiply the number of queries;
//   * a trace whose newest row was in an earlier slice re-appears in later
//     slices only through older rows and is dropped via seen_.
// Slice width adapts to the observed density; a slice holding more than
// kSliceRowCap traces is halved and re-read, so memory and per-query cost stay
// bounded.
class TraceIndexCursor {
 public:
  struct Hit {
    std::string trace_id;
    int64_t start_ns = 0;
  };

  TraceIndexCursor(clickhouse::Client& client, std::string index_table, int64_t start_ms, int64_t end_ms)
      : client_(client),
        table_(std::move(index_table)),
        window_("Start >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND "
                "Start <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")"),
        lo_ns_(start_ms * kNsPerMs),
        hi_ns_(end_ms * kNsPerMs),
        slice_ns_(std::max<int64_t>(1, std::min<int64_t>(kInitialSliceNs, hi_ns_ - lo_ns_ + 1))) {}

  const std::string& window() const { return window_; }
  const std::string& table() const { return table_; }

  // Up to n not-yet-emitted traces in rank order; fewer only when the window
  // has no more traces.
  std::vector<Hit> next(size_t n) {
    std::vector<Hit> out;
    while (out.size() < n) {
      if (buffer_pos_ < buffer_.size()) {
        out.push_back(std::move(buffer_[buffer_pos_++]));
        continue;
      }
      if (exhausted_) break;
      fill(n - out.size());
    }
    return out;
  }

 private:
  static constexpr int64_t kInitialSliceNs = 60LL * 1000 * kNsPerMs;
  static constexpr size_t kSliceRowCap = 20000;

  // Read the next non-empty slice below hi_ns_ into buffer_ (or exhaust).
  void fill(size_t wanted) {
    buffer_.clear();
    buffer_pos_ = 0;
    while (buffer_.empty() && !exhausted_) {
      if (hi_ns_ < lo_ns_) {
        exhausted_ = true;
        return;
      }
      const int64_t lo = std::max(lo_ns_, hi_ns_ - slice_ns_ + 1);
      // toDateTime64(…, 9) accepts both DateTime and DateTime64 index schemas.
      const std::string sql =
          "SELECT toString(TraceId), toString(toUnixTimestamp64Nano(toDateTime64(max(Start), 9))) FROM " + table_ +
          " PREWHERE " + window_ + " AND Start >= " + ns_time(lo) + " AND Start <= " + ns_time(hi_ns_) +
          " GROUP BY TraceId LIMIT " + std::to_string(kSliceRowCap + 1);
      std::vector<Hit> rows;
      client_.Select(sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          rows.push_back(Hit{ch_block_text_at(block, 0, row), std::stoll(ch_block_text_at(block, 1, row))});
        }
      });
      if (rows.size() > kSliceRowCap && slice_ns_ > 1) {
        // Too dense to read in one piece: re-read a narrower slice.
        slice_ns_ = std::max<int64_t>(1, slice_ns_ / 4);
        continue;
      }
      size_t fresh = 0;
      for (auto& row : rows) {
        if (!seen_.insert(row.trace_id).second) continue;
        buffer_.push_back(std::move(row));
        ++fresh;
      }
      std::sort(buffer_.begin(), buffer_.end(), [](const Hit& a, const Hit& b) {
        if (a.start_ns != b.start_ns) return a.start_ns > b.start_ns;
        return a.trace_id < b.trace_id;
      });
      if (lo <= lo_ns_) {
        exhausted_ = true;
      } else {
        hi_ns_ = lo - 1;
        // Aim the next slice at roughly the traces still wanted (x2 headroom),
        // growing at most 8x per step; empty slices grow 4x.
        double factor = 4.0;
        if (fresh > 0) {
          factor = std::min(8.0, std::max(0.5, 2.0 * static_cast<double>(std::max<size_t>(wanted, 1)) /
                                                    static_cast<double>(fresh)));
        }
        const double next = static_cast<double>(slice_ns_) * factor;
        const double remaining = static_cast<double>(hi_ns_ - lo_ns_ + 1);
        slice_ns_ = static_cast<int64_t>(std::max(1.0, std::min(next, remaining)));
      }
    }
  }

  clickhouse::Client& client_;
  std::string table_;
  std::string window_;
  int64_t lo_ns_ = 0;
  int64_t hi_ns_ = 0;
  int64_t slice_ns_ = 1;
  bool exhausted_ = false;
  std::vector<Hit> buffer_;
  size_t buffer_pos_ = 0;
  std::unordered_set<std::string> seen_;
};

// Span filters (service, operation, status, tags) select traces having at
// least one matching visible span. Two equivalent SQL forms exist:
//   narrow: TraceId IN (candidate_ids)   -- cheap when few traces match
//   broad:  HAVING countIf(filters) > 0  -- one pass, no giant IN set
// With a broad filter the IN set holds most traces of the window, and building
// and probing it costs more than the aggregation itself (24 h, one service:
// 6.5 s vs 3.7 s). Only primary-key filters (service / operation) are probed:
// their candidate scan is cheap, and a LIMIT stops it early when the filter
// is broad. Status and tag filters keep the narrow form.
constexpr double kBroadFilterShare = 0.25;

bool filters_are_broad(clickhouse::Client& client, const std::string& table, const std::string& index_table,
                       const std::string& time_predicate, const std::string& visibility,
                       const std::string& span_filters, int64_t start_ms, int64_t end_ms) {
  if (span_filters.empty() || index_table.empty()) return false;
  // Only a performance hint: any failure (e.g. a missing index table) keeps
  // the narrow form, which needs no index.
  try {
    uint64_t index_rows = 0;
    client.Select(
        "SELECT toString(count()) FROM " + index_table + " PREWHERE Start >= fromUnixTimestamp64Milli(" +
            std::to_string(start_ms) + ") AND Start <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")",
        [&](const clickhouse::Block& block) {
          if (block.GetRowCount()) index_rows = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
        });
    // Index rows >= traces (one row per insert batch), so the share is conservative.
    const uint64_t threshold =
        std::max<uint64_t>(1000, static_cast<uint64_t>(static_cast<double>(index_rows) * kBroadFilterShare));
    uint64_t matching = 0;
    client.Select(
        "SELECT toString(count()) FROM (SELECT TraceId FROM " + table + " PREWHERE " + time_predicate +
            " WHERE " + visibility + span_filters + " LIMIT 1 BY TraceId LIMIT " + std::to_string(threshold) + ")",
        [&](const clickhouse::Block& block) {
          if (block.GetRowCount()) matching = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
        });
    return matching >= threshold;
  } catch (...) {
    return false;
  }
}

// " HAVING a AND b" -> "a AND b".
std::string having_terms(const std::string& having) {
  static const std::string kPrefix = " HAVING ";
  return having.rfind(kPrefix, 0) == 0 ? having.substr(kPrefix.size()) : having;
}

struct SpanRankQuery {
  std::string table;
  std::string time_predicate;
  std::string visibility;
  std::string span_filters;  // " AND ..." or empty
  std::string having;        // " HAVING ..." or empty
  bool broad_filters = false;  // evaluate span_filters as HAVING countIf(...) > 0
  int64_t start_ms = 0;
  int64_t end_ms = 0;
  size_t limit = 0;
};

struct RankedTrace {
  std::string trace_id;
  int64_t first_span_ns = 0;  // min(Timestamp) of its visible window spans
  // max(Timestamp + Duration) when a duration HAVING already aggregates it,
  // else 0 (unknown): an extra per-trace aggregate is not free on wide windows.
  int64_t span_end_ns = 0;
};

// Exact, newest-slice-first evaluation of
//   [WITH candidate_ids AS (spans matching the filters, LIMIT 1 BY TraceId)]
//   SELECT TraceId FROM spans PREWHERE window WHERE visibility [AND TraceId IN candidate_ids]
//   GROUP BY TraceId [HAVING duration] ORDER BY min(Timestamp) DESC LIMIT limit
// Aggregating every trace of a wide window only to keep the newest `limit` is
// the dominant cost of span-based search. A trace whose first visible window
// span is at or after t has all of its window spans in [t, end], so a query
// restricted to that slice computes exactly the same min/duration/filter
// match for it. Other traces seen in the slice ("straddlers") have visible
// spans before t; they rank below every trace starting at or after t, their
// slice aggregates are partial, and they are dropped after an IN-list
// existence probe on [start, t). When the slice yields `limit` exact traces
// they are the global answer; otherwise the slice widens, ending with the
// plain whole-window query.
std::vector<RankedTrace> rank_traces_by_start(clickhouse::Client& client, const SpanRankQuery& q) {
  const int64_t lo_ns = q.start_ms * kNsPerMs;
  const int64_t hi_ns = q.end_ms * kNsPerMs;
  const int64_t range_ns = hi_ns - lo_ns;
  constexpr int64_t kMinSliceNs = 5LL * 60 * 1000 * kNsPerMs;
  const bool has_filters = !q.span_filters.empty() && !q.broad_filters;
  std::string having = q.having;
  if (!q.span_filters.empty() && q.broad_filters) {
    having = " HAVING countIf(1" + q.span_filters + ") > 0" + (q.having.empty() ? std::string{} : " AND " + having_terms(q.having));
  }
  double fraction = range_ns > 16 * kMinSliceNs ? 1.0 / 16.0 : 1.0;
  size_t pad = 16;

  while (true) {
    const bool whole = fraction >= 1.0;
    const int64_t t = whole ? lo_ns : hi_ns - static_cast<int64_t>(static_cast<double>(range_ns) * fraction);
    const std::string slice = whole ? std::string{} : " AND Timestamp >= " + ns_time(t);
    const std::string candidates = has_filters
        ? "WITH candidate_ids AS (SELECT TraceId FROM " + q.table + " PREWHERE " + q.time_predicate + slice +
          " WHERE " + q.visibility + q.span_filters + " LIMIT 1 BY TraceId) "
        : std::string{};
    const std::string candidate_where = has_filters ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : std::string{};
    const size_t fetch = whole ? q.limit : q.limit + pad;
    // Same expression as the duration HAVING, so it is aggregated only once.
    const std::string span_end = q.having.empty()
        ? std::string("'0'")
        : std::string("toString(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)))");
    const std::string sql = candidates +
        "SELECT toString(TraceId), toString(toUnixTimestamp64Nano(min(Timestamp))), " + span_end +
        " FROM " + q.table +
        " PREWHERE " + q.time_predicate + slice + " WHERE " + q.visibility + candidate_where +
        " GROUP BY TraceId" + having + " ORDER BY min(Timestamp) DESC LIMIT " + std::to_string(fetch);
    std::vector<RankedTrace> rows;
    client.Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        rows.push_back(RankedTrace{ch_block_text_at(block, 0, row), std::stoll(ch_block_text_at(block, 1, row)),
                                   std::stoll(ch_block_text_at(block, 2, row))});
      }
    });
    if (whole) return rows;

    std::unordered_set<std::string> straddlers;
    if (!rows.empty()) {
      std::vector<std::string> ids;
      ids.reserve(rows.size());
      for (const auto& row : rows) ids.push_back(row.trace_id);
      const std::string probe_sql =
          "SELECT DISTINCT toString(TraceId) FROM " + q.table + " PREWHERE " + q.time_predicate +
          " AND Timestamp < " + ns_time(t) + " WHERE " + q.visibility + " AND TraceId IN " + trace_id_list_sql(ids);
      client.Select(probe_sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) straddlers.insert(ch_block_text_at(block, 0, row));
      });
    }
    std::vector<RankedTrace> kept;
    for (auto& row : rows) {
      if (straddlers.count(row.trace_id) == 0) kept.push_back(std::move(row));
    }
    if (kept.size() >= q.limit) {
      kept.resize(q.limit);
      return kept;
    }
    if (rows.size() >= fetch && pad < 1024) {
      // Straddlers took result slots and the slice holds more traces.
      pad *= 4;
      continue;
    }
    // Widen from the observed density; an empty slice goes straight to the
    // whole window so sparse results cost at most one extra slice.
    fraction = kept.empty()
        ? fraction * 8.0
        : fraction * std::max(2.0, 1.5 * static_cast<double>(q.limit) / static_cast<double>(kept.size()));
    if (fraction > 0.4 || rows.size() >= fetch) fraction = 1.0;
    pad = 16;
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

  if (trace_attribute_maps(*client, cfg_.traces, &span_attribute_map, &resource_attribute_map)) {
    store_trace_attribute_maps(*host, cfg_.traces, span_attribute_map, resource_attribute_map);
  }

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

  // Minute-aligned superset of the requested range: the list only feeds the
  // service/operation pickers, and alignment lets "last N minutes" requests
  // made within the same minute (reloads, range toggles) share one scan.
  constexpr int64_t kPrefillAlignMs = 60 * 1000;
  constexpr uint64_t kPrefillTtlMs = 60 * 1000;
  const int64_t aligned_start_ms = (start_ms / kPrefillAlignMs) * kPrefillAlignMs;
  const int64_t aligned_end_ms = ((end_ms + kPrefillAlignMs - 1) / kPrefillAlignMs) * kPrefillAlignMs;
  const std::string cache_key = source_host_id + '\0' + std::to_string(aligned_start_ms) + '\0' +
      std::to_string(aligned_end_ms);
  const size_t hard_limit = 20000;

  auto cached = trace_prefill_cache_.get_or_refresh(
      cache_key, static_cast<uint64_t>(now_ms()), kPrefillTtlMs, 5000,
      [&](TracePrefill& value, std::string& code, std::string& message) {
        std::string error;
        auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
        if (!client) {
          code = "trace_source_unavailable";
          message = error.empty() ? "Cannot connect to trace ClickHouse source." : error;
          return false;
        }
        const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
        const std::string visibility = service_allowlist_predicate(cfg_.traces);
        const std::string time_predicate = trace_time_predicate(aligned_start_ms, aligned_end_ms);
        try {
          // Discovery only needs existence. Counting every span per service/operation pair
          // turns a cheap dictionary prefill into a large aggregation on busy trace tables.
          const std::string sql =
              "SELECT toString(ServiceName), toString(SpanName) FROM " + table +
              " PREWHERE " + time_predicate + " WHERE " + visibility +
              " LIMIT 1 BY ServiceName, SpanName LIMIT " + std::to_string(hard_limit + 1);
          client->Select(sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              value.pairs.emplace_back(ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row));
            }
          });
        } catch (const std::exception& e) {
          if (client_pool_) client_pool_->invalidate(client);
          code = "trace_prefill_failed";
          message = e.what();
          return false;
        }
        std::sort(value.pairs.begin(), value.pairs.end());
        value.truncated = value.pairs.size() > hard_limit;
        if (value.truncated) value.pairs.resize(hard_limit);
        value.start_ms = aligned_start_ms;
        value.end_ms = aligned_end_ms;
        return true;
      });
  if (!cached.has_value || !cached.value) {
    return json_error(res, 503, cached.error_code.empty() ? "trace_prefill_failed" : cached.error_code,
                      cached.error_message.empty() ? "Trace prefill failed." : cached.error_message);
  }
  const bool truncated = cached.value->truncated;
  const auto& pairs = cached.value->pairs;

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("range"); w.StartArray(); w.Int64(start_ms); w.Int64(end_ms); w.EndArray();
  w.Key("truncated"); w.Bool(truncated);
  w.Key("pairs"); w.StartArray();
  for (const auto& [service, operation] : pairs) {
    // The count column is kept for payload compatibility (existence only).
    w.StartArray(); w.String(service.c_str()); w.String(operation.c_str()); w.Uint64(1); w.EndArray();
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
    cached_trace_attribute_maps(*client, *host, cfg_.traces, &span_map, &resource_map);
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
  // Only service / operation filters (primary-key columns) may use the broad form.
  const bool key_only_filters = has_candidate_filters &&
      (!req.has_param("status") || req.get_param_value("status").empty()) &&
      (!req.has_param("tag_key") || req.get_param_value("tag_key").empty());
  const bool has_duration_filters = min_duration_ms > 0.0 || max_duration_ms > 0.0;
  const bool needs_span_match = has_candidate_filters || visibility != "1";
  const bool has_index = !cfg_.traces.trace_index_table.empty();
  const std::string index_table = has_index ? qualified(cfg_.traces.database, cfg_.traces.trace_index_table) : std::string{};

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

  // first_span_ns: offset of the service's earliest window span from the
  // trace's earliest window span (the UI orders services by it).
  struct ServiceStat { std::string service; uint64_t spans = 0, errors = 0, first_span_ns = 0; };
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
        // One "service RS spans RS errors RS first_span_ns" item per service
        // (see aggregate_select).
        for (const auto& item : split_char(ch_block_text_at(block, 7, row), '\x1f')) {
          const size_t first_sep = item.rfind('\x1e');
          if (first_sep == std::string::npos || first_sep == 0) continue;
          const size_t errors_sep = item.rfind('\x1e', first_sep - 1);
          if (errors_sep == std::string::npos || errors_sep == 0) continue;
          const size_t spans_sep = item.rfind('\x1e', errors_sep - 1);
          if (spans_sep == std::string::npos || spans_sep == 0) continue;
          ServiceStat stat;
          stat.service = item.substr(0, spans_sep);
          stat.spans = static_cast<uint64_t>(std::stoull(item.substr(spans_sep + 1, errors_sep - spans_sep - 1)));
          stat.errors = static_cast<uint64_t>(std::stoull(item.substr(errors_sep + 1, first_sep - errors_sep - 1)));
          stat.first_span_ns = static_cast<uint64_t>(std::stoull(item.substr(first_sep + 1)));
          out.service_stats.push_back(std::move(stat));
        }
        std::sort(out.service_stats.begin(), out.service_stats.end(), [](const ServiceStat& a, const ServiceStat& b) {
          if (a.spans != b.spans) return a.spans > b.spans;
          return a.service < b.service;
        });
        rows.push_back(std::move(out));
      }
    });
  };

  // Per-service span/error counts are aggregated server-side with sumMap, so
  // the per-trace state and the payload are O(services), not O(spans).
  // Spans without a ServiceName are not reported as a service (as before).
  // minMap keeps each service's earliest span start in the same O(services)
  // state; both maps sort the same key set, so their arrays zip aligned.
  const std::string service_stats_map =
      "sumMap([toString(ServiceName)], [toUInt64(1)], [toUInt64(StatusCode = 'Error')])";
  const std::string service_first_span_map = "minMap([toString(ServiceName)], [toUnixTimestamp64Nano(Timestamp)])";
  const std::string aggregate_select =
      "SELECT toString(TraceId), toString(toUnixTimestamp64Milli(min(Timestamp))), "
      "toString(if(empty(argMinIf(SpanName, Timestamp, empty(ParentSpanId))), argMin(SpanName, Timestamp), argMinIf(SpanName, Timestamp, empty(ParentSpanId)))), "
      "toString(if(empty(argMinIf(ServiceName, Timestamp, empty(ParentSpanId))), argMin(ServiceName, Timestamp), argMinIf(ServiceName, Timestamp, empty(ParentSpanId)))), "
      "toString(" + duration_expr + "), toString(count()), toString(countIf(StatusCode = 'Error')), "
      "arrayStringConcat(arrayMap(stat -> concat(stat.1, char(30), toString(stat.2), char(30), toString(stat.3), char(30), "
      "toString(stat.4 - toUnixTimestamp64Nano(min(Timestamp)))), "
      "arrayFilter(stat -> notEmpty(stat.1), arrayZip(tupleElement(" + service_stats_map + ", 1), tupleElement(" +
      service_stats_map + ", 2), tupleElement(" + service_stats_map + ", 3), tupleElement(" + service_first_span_map +
      ", 2)))), char(31)) ";

  // The summary aggregates every window span of <= limit selected traces, so
  // it only needs the time range those spans occupy instead of probing every
  // part of the window. Span-ranked traces carry exact bounds (earliest window
  // span, and the latest span end when the duration HAVING computed it);
  // index-selected traces use their index bounds (every span Timestamp is
  // covered by the [Start, End] row of its insert batch) with the same 1 s
  // margin as trace detail.
  auto summary_sql_for = [&](const std::vector<std::string>& selected_ids, int64_t first_span_ns, int64_t span_end_ns) {
    const std::string trace_id_list = trace_id_list_sql(selected_ids);
    std::string with;
    std::string bounds;
    if (first_span_ns > 0) {
      bounds = " AND Timestamp >= " + ns_time(first_span_ns);
      if (span_end_ns >= first_span_ns) bounds += " AND Timestamp <= " + ns_time(span_end_ns);
    } else if (has_index) {
      with = "WITH (SELECT tuple(min(Start) - toIntervalSecond(1), max(End) + toIntervalSecond(1)) FROM " + index_table +
             " WHERE TraceId IN " + trace_id_list + ") AS trace_bounds ";
      bounds = " AND Timestamp >= tupleElement(trace_bounds, 1) AND Timestamp <= tupleElement(trace_bounds, 2)";
    }
    return with + aggregate_select +
        "FROM " + table + " PREWHERE " + time_predicate + bounds +
        " WHERE " + visibility + " AND TraceId IN " + trace_id_list +
        " GROUP BY TraceId ORDER BY min(Timestamp) DESC LIMIT " + std::to_string(limit);
  };

  auto elapsed_ms = [](std::chrono::steady_clock::time_point since) {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - since).count());
  };

  uint64_t candidate_query_ms = 0;
  uint64_t summary_query_ms = 0;
  bool used_trace_index_fast_path = false;
  std::string search_path = "span_aggregation";
  const bool index_fast_path_eligible = !has_duration_filters && has_index;

  if (index_fast_path_eligible) {
    try {
      TraceIndexCursor cursor(*client, index_table, start_ms, end_ms);
      std::vector<std::string> selected_ids;
      const auto candidate_started = std::chrono::steady_clock::now();

      if (!needs_span_match) {
        for (auto& hit : cursor.next(static_cast<size_t>(limit))) selected_ids.push_back(std::move(hit.trace_id));
        search_path = "trace_index";
      } else {
        // Traces are tested in index rank order until `limit` match, over at
        // most the newest kCandidateScanCap traces (then the span fallback
        // below answers). Pages start at kCandidateBatch traces and grow when
        // matches are rare, so a rare filter reaches the cap in a handful of
        // pages instead of 64 fixed ones; the traces tested and their order
        // are unchanged.
        constexpr size_t kCandidateBatch = 1000;
        constexpr size_t kMaxCandidateBatch = 32000;
        constexpr size_t kCandidateScanCap = 64000;
        size_t considered = 0;
        size_t batch_size = kCandidateBatch;
        bool exhausted = false;

        while (selected_ids.size() < static_cast<size_t>(limit) && considered < kCandidateScanCap) {
          const auto batch = cursor.next(std::min(batch_size, kCandidateScanCap - considered));
          if (batch.empty()) {
            exhausted = true;
            break;
          }
          considered += batch.size();

          // The page is every trace whose newest index row lies in
          // [newest, oldest] Start of the page (plus older rows of already
          // tested traces, discarded below). Its spans lie inside the page's
          // index bounds, so matching reads only that time range rather than
          // probing the whole window.
          const std::string batch_ids =
              "(SELECT TraceId FROM " + index_table + " PREWHERE " + cursor.window() +
              " AND Start >= " + ns_time(batch.back().start_ns) + " AND Start <= " + ns_time(batch.front().start_ns) + ")";
          std::unordered_set<std::string> matching_ids;
          const std::string match_sql =
              "WITH (SELECT tuple(min(Start) - toIntervalSecond(1), max(End) + toIntervalSecond(1)) FROM " + index_table +
              " WHERE TraceId IN " + batch_ids + ") AS batch_bounds "
              "SELECT toString(TraceId) FROM " + table +
              " PREWHERE " + time_predicate +
              " AND Timestamp >= tupleElement(batch_bounds, 1) AND Timestamp <= tupleElement(batch_bounds, 2)"
              " WHERE " + visibility + span_filters + " AND TraceId IN " + batch_ids +
              " LIMIT 1 BY TraceId";
          client->Select(match_sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) matching_ids.insert(ch_block_text_at(block, 0, row));
          });

          for (const auto& hit : batch) {
            if (matching_ids.find(hit.trace_id) == matching_ids.end()) continue;
            selected_ids.push_back(hit.trace_id);
            if (selected_ids.size() >= static_cast<size_t>(limit)) break;
          }
          if (batch.size() < std::min(batch_size, kCandidateScanCap - (considered - batch.size()))) {
            exhausted = true;
            break;
          }

          const size_t missing = static_cast<size_t>(limit) - std::min(selected_ids.size(), static_cast<size_t>(limit));
          if (missing == 0) break;
          const double projected = selected_ids.empty()
              ? static_cast<double>(batch_size) * 4.0
              : 1.25 * static_cast<double>(missing) * static_cast<double>(considered) / static_cast<double>(selected_ids.size());
          batch_size = std::max(kCandidateBatch, std::min(kMaxCandidateBatch, static_cast<size_t>(projected)));
        }

        if (selected_ids.size() < static_cast<size_t>(limit) && !exhausted && considered >= kCandidateScanCap) {
          throw std::runtime_error("filtered trace-index candidate scan cap reached");
        }
        search_path = "trace_index_filtered";
      }

      candidate_query_ms = elapsed_ms(candidate_started);

      if (!selected_ids.empty()) {
        const auto summary_started = std::chrono::steady_clock::now();
        read_summary(summary_sql_for(selected_ids, 0, 0));
        summary_query_ms = elapsed_ms(summary_started);
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
    // Span-based search: duration filters (a trace-level HAVING the index
    // cannot answer -- the OTel exporter's trace_id_ts MV stores
    // End = max(Timestamp), the last span *start*), no trace index, or the
    // filtered index scan reached its cap. Rank the TraceIds with only the
    // cheap min/max aggregates (newest slice first, see
    // rank_traces_by_start), then compute the expensive summary (argMin*,
    // per-service stats) for those <= limit traces only. Same spans, same
    // HAVING, same ORDER BY as a single whole-window aggregation.
    try {
      const auto candidate_started = std::chrono::steady_clock::now();
      SpanRankQuery rank;
      rank.table = table;
      rank.time_predicate = time_predicate;
      rank.visibility = visibility;
      rank.span_filters = span_filters;
      rank.having = having;
      rank.broad_filters = key_only_filters &&
          filters_are_broad(*client, table, index_table, time_predicate, visibility, span_filters, start_ms, end_ms);
      rank.start_ms = start_ms;
      rank.end_ms = end_ms;
      rank.limit = static_cast<size_t>(limit);
      const auto ranked = rank_traces_by_start(*client, rank);
      candidate_query_ms = elapsed_ms(candidate_started);
      if (!ranked.empty()) {
        std::vector<std::string> selected_ids;
        int64_t first_span_ns = std::numeric_limits<int64_t>::max();
        int64_t span_end_ns = 0;
        bool span_end_known = true;
        for (const auto& trace : ranked) {
          selected_ids.push_back(trace.trace_id);
          first_span_ns = std::min(first_span_ns, trace.first_span_ns);
          span_end_known = span_end_known && trace.span_end_ns > 0;
          span_end_ns = std::max(span_end_ns, trace.span_end_ns);
        }
        if (!span_end_known) span_end_ns = 0;
        const auto summary_started = std::chrono::steady_clock::now();
        read_summary(summary_sql_for(selected_ids, first_span_ns, span_end_ns));
        summary_query_ms = elapsed_ms(summary_started);
      }
      if (has_duration_filters) search_path = "span_duration_two_phase";
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
      w.StartArray(); w.Uint64(intern_service(stat.service)); w.Uint64(stat.spans); w.Uint64(stat.errors); w.Uint64(stat.first_span_ns);
      w.EndArray();
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
    cached_trace_attribute_maps(*client, *host, cfg_.traces, &span_map, &resource_map);
    const std::string scope = req.has_param("tag_scope") ? req.get_param_value("tag_scope") : std::string{};
    if ((scope == "span" && !span_map) || (scope == "resource" && !resource_map) ||
        (scope == "any" && !span_map && !resource_map)) {
      return json_error(res, 400, "trace_tag_search_unsupported", "Selected attribute scope is not stored as Map(String, String).");
    }
  }

  const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string index_table = cfg_.traces.trace_index_table.empty()
      ? std::string{}
      : qualified(cfg_.traces.database, cfg_.traces.trace_index_table);
  const std::string time_predicate = trace_time_predicate(start_ms, end_ms);
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const bool has_candidate_filters = !span_filters.empty();
  // Only service / operation filters (primary-key columns) may use the broad form.
  const bool key_only_filters = has_candidate_filters &&
      (!req.has_param("status") || req.get_param_value("status").empty()) &&
      (!req.has_param("tag_key") || req.get_param_value("tag_key").empty());

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

  // Duration quantiles are always computed from the spans themselves. The
  // trace index cannot provide them: the OTel exporter's trace_id_ts MV stores
  // End = max(Timestamp), i.e. the *start* of the last span, and one row per
  // insert batch (so any single row may hold partial bounds). Index-based
  // quantiles were therefore systematically wrong (e.g. P50 226 ms instead of
  // 182 ms on the local fixture). Trace counts come from the same query so
  // both charts describe exactly the same set of traces.
  uint64_t analytics_query_ms = 0;
  const std::string analytics_path = "span_aggregation";
  const std::string quantile_source = "span_bounds";

  {
    try {
      const auto analytics_started = std::chrono::steady_clock::now();
      // Broad service / operation filters aggregate once with HAVING countIf
      // instead of building an IN set of most traces (see filters_are_broad).
      const bool broad = key_only_filters && filters_are_broad(
          *client, table, index_table, time_predicate, visibility, span_filters, start_ms, end_ms);
      const std::string scope_having = broad
          ? " HAVING countIf(1" + span_filters + ") > 0" + (having.empty() ? std::string{} : " AND " + having_terms(having))
          : having;
      const std::string trace_scope = " FROM " + table + " PREWHERE " + time_predicate + " WHERE " + visibility +
          (broad ? std::string{} : candidate_where) + " GROUP BY TraceId" + scope_having;
      const std::string with_candidate = has_candidate_filters && !broad ? "WITH " + candidate_cte + ", " : "WITH ";
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
    // One index lookup yields both bounds (previously two scalar subqueries
    // each read the trace's index rows).
    const std::string indexed_sql =
        "WITH " + trace_literal + " AS trace, "
        "(SELECT tuple(min(Start) - toIntervalSecond(1), max(End) + toIntervalSecond(1)) FROM " + index_table +
        " WHERE TraceId = trace) AS trace_bounds " +
        select_columns +
        "FROM " + main_table + " PREWHERE Timestamp >= tupleElement(trace_bounds, 1) AND Timestamp <= tupleElement(trace_bounds, 2) "
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
