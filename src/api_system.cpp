#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <set>
#include <string>

// System page endpoints (docs/system.md). Fixed,
// allowlisted, bounded system-table reads built in system_monitor.cpp; the
// request only names the host. Rows that name an object pass the runner SHOW
// boundary before they count; the rest is server-level.

namespace chdash {
namespace {

// What a host exposes changes with its configuration or version only.
constexpr uint64_t kMonitorCapabilitiesTtlMs = 10 * 60 * 1000;

uint64_t monitor_api_now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

std::shared_ptr<clickhouse::Client> acquire_monitor_client(
    const std::shared_ptr<ClickHouseClientPool>& pool,
    const std::string& uri,
    std::string* error) {
  return pool ? pool->acquire(uri, std::chrono::seconds(5), std::chrono::seconds(15), std::chrono::seconds(15), error)
              : make_client_from_uri(uri, std::chrono::seconds(5), std::chrono::seconds(15), std::chrono::seconds(15), error);
}

// Live state, as the Activity: never older than the Explorer cache
// TTL, at most one read per second per host however many pages refresh.
uint64_t monitor_live_ttl_ms(int cache_ttl_ms) {
  return static_cast<uint64_t>(std::max(1000, std::min(cache_ttl_ms, 5000)));
}

void write_string(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::string& value) {
  w.Key(key);
  w.String(value.c_str(), static_cast<rapidjson::SizeType>(value.size()));
}

void write_string_value(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::string& value) {
  w.String(value.c_str(), static_cast<rapidjson::SizeType>(value.size()));
}

void write_optional(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::optional<uint64_t>& value) {
  w.Key(key);
  if (value) w.Uint64(*value);
  else w.Null();
}

// Series values to 6 significant digits (a chart needs no more); null for a
// bucket without a sample.
void write_series_value(rapidjson::Writer<rapidjson::StringBuffer>& w, double value) {
  if (!std::isfinite(value)) {
    w.Null();
    return;
  }
  char buffer[32];
  const int size = std::snprintf(buffer, sizeof(buffer), "%.6g", value);
  if (size <= 0 || size >= static_cast<int>(sizeof(buffer))) {
    w.Double(value);
    return;
  }
  w.RawValue(buffer, static_cast<size_t>(size), rapidjson::kNumberType);
}

// A whole number of milliseconds, decimal digits only (no sign, no space).
bool parse_ms(const std::string& text, uint64_t& out) {
  if (text.empty() || text.size() > 16) return false;
  if (!std::all_of(text.begin(), text.end(), [](char ch) { return ch >= '0' && ch <= '9'; })) return false;
  out = std::stoull(text);
  return true;
}

// Series windows of one host share an entry for this long (proposal: 15 s
// per aligned window); the map is emptied past this many windows.
constexpr uint64_t kMonitorSeriesTtlMs = 15 * 1000;
constexpr size_t kMonitorSeriesCacheEntries = 256;

// Disks: 60 s per host (capacity, policies and the bytes by database move
// slowly); growth: 5 min per aligned window (an hour-long step for the
// default week).
constexpr uint64_t kMonitorDisksTtlMs = 60 * 1000;
constexpr uint64_t kMonitorGrowthTtlMs = 5 * 60 * 1000;
constexpr size_t kMonitorGrowthCacheEntries = 64;

void write_optional_bool(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::optional<bool>& value) {
  w.Key(key);
  if (value) w.Bool(*value);
  else w.Null();
}

void write_source(rapidjson::Writer<rapidjson::StringBuffer>& w, const MonitorSeriesSource& source) {
  w.StartObject();
  write_string(w, "table", source.table);
  write_string(w, "status", source.status);
  write_string(w, "message", source.message);
  write_string(w, "hint", source.hint);
  w.Key("rows_read"); w.Uint64(source.rows_read);
  w.Key("elapsed_ms"); w.Uint64(source.elapsed_ms);
  w.Key("missing");
  w.StartArray();
  for (const auto& item : source.missing) write_string_value(w, item);
  w.EndArray();
  w.EndObject();
}

// Queries: 60 s per minute-aligned window (and sort, kind, filter). A second
// viewer of the same window waits for the read in flight rather than
// starting another (phase 1 may take its whole 15 s budget).
constexpr uint64_t kMonitorQueriesTtlMs = 60 * 1000;
constexpr int kMonitorQueriesWaitMs = 30 * 1000;
constexpr size_t kMonitorQueriesCacheEntries = 256;

// The runner client of the Queries reads: the receive timeout outlasts
// their time budgets, so ClickHouse answers TIMEOUT_EXCEEDED first.
std::shared_ptr<clickhouse::Client> acquire_queries_client(
    const std::shared_ptr<ClickHouseClientPool>& pool,
    const std::string& uri,
    std::string* error) {
  return pool ? pool->acquire(uri, std::chrono::seconds(5), std::chrono::seconds(30), std::chrono::seconds(15), error)
              : make_client_from_uri(uri, std::chrono::seconds(5), std::chrono::seconds(30), std::chrono::seconds(15), error);
}

// A normalized_query_hash: decimal digits of a UInt64, nothing else.
bool parse_hash(const std::string& text, uint64_t& out) {
  static const std::string kMax = "18446744073709551615";
  if (text.empty() || text.size() > kMax.size()) return false;
  if (!std::all_of(text.begin(), text.end(), [](char ch) { return ch >= '0' && ch <= '9'; })) return false;
  if (text.size() == kMax.size() && text > kMax) return false;
  out = std::stoull(text);
  return true;
}

void write_query_read(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const MonitorQueryRead& read) {
  w.Key(key);
  w.StartObject();
  write_string(w, "status", read.status);
  write_string(w, "message", read.message);
  w.Key("rows_read"); w.Uint64(read.rows_read);
  w.Key("bytes_read"); w.Uint64(read.bytes_read);
  w.Key("elapsed_ms"); w.Uint64(read.elapsed_ms);
  w.EndObject();
}

void write_strings(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::vector<std::string>& values) {
  w.Key(key);
  w.StartArray();
  for (const auto& value : values) write_string_value(w, value);
  w.EndArray();
}

// The answer's status in the Overview's unavailable_panels shape.
void write_queries_status(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::string& status, const std::string& message,
                          const std::string& hint, uint64_t suggested_span_s) {
  write_string(w, "status", status);
  write_string(w, "message", message);
  write_string(w, "hint", hint);
  w.Key("suggested_span_ms");
  if (suggested_span_s) w.Uint64(suggested_span_s * 1000);
  else w.Null();
  w.Key("unavailable_panels");
  w.StartArray();
  if (status != "ok") {
    w.StartObject();
    write_string(w, "panel", "queries");
    write_string(w, "table", "query_log");
    write_string(w, "reason", status);
    write_string(w, "message", message);
    write_string(w, "hint", hint);
    w.EndObject();
  }
  w.EndArray();
}

} // namespace

// What a host exposes (its optional system logs and versioned columns),
// detected once and cached 10 minutes. Until a detection succeeds (retried
// after a short back-off) the panels read their base columns and let
// ClickHouse answer.
std::shared_ptr<const MonitorCapabilities> Server::system_monitor_capabilities(const std::string& host_id, const std::string& system_uri) {
  const std::string caps_key = host_id + std::string("\0monitor-caps", 13);
  auto caps = system_monitor_caps_cache_.get_or_refresh(
      caps_key, monitor_api_now_ms(), kMonitorCapabilitiesTtlMs, 250,
      [&](MonitorCapabilities& value, std::string& code, std::string& message) {
        std::string error;
        auto system = acquire_monitor_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        if (!detect_monitor_capabilities(*system, value, &error)) {
          code = "system_monitor_detection_failed";
          message = error.empty() ? "The server's system tables could not be listed." : error;
          return false;
        }
        return true;
      });
  if (caps.has_value && caps.value) return caps.value;
  return std::make_shared<const MonitorCapabilities>();
}

void Server::handle_system_overview(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }
  const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  const uint64_t now = monitor_api_now_ms();

  const auto caps = system_monitor_capabilities(host_id, system_uri);
  const MonitorCapabilities& capabilities = *caps;

  const std::string key = host_id + std::string("\0monitor-overview", 17);
  if (req.has_param("refresh") && req.get_param_value("refresh") == "1") system_monitor_overview_cache_.erase(key);
  auto result = system_monitor_overview_cache_.get_or_refresh(
      key, now, monitor_live_ttl_ms(cfg_.explorer.cache_ttl_ms), 250,
      [&](SystemMonitorOverview& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_monitor_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        auto system = acquire_monitor_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        try {
          if (!load_system_monitor_overview(*system, *runner, capabilities, value, &error)) {
            code = "system_monitor_failed";
            message = error.empty() ? "The server overview is unavailable." : error;
            return false;
          }
          return true;
        } catch (const std::exception& e) {
          code = "system_monitor_failed";
          message = e.what();
          if (client_pool_) {
            client_pool_->invalidate(runner);
            client_pool_->invalidate(system);
          }
          return false;
        }
      });
  if (!result.has_value || !result.value) {
    return json_error(
        res, 503,
        result.error_code.empty() ? "system_monitor_unavailable" : result.error_code,
        result.error_message.empty() ? "The server overview is unavailable." : result.error_message);
  }

  const SystemMonitorOverview& overview = *result.value;
  rapidjson::StringBuffer sb(nullptr, 8 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  w.Key("generated_at_ms"); w.Uint64(overview.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  // Every figure is this server's own (system tables are per node); the
  // clusterAllReplicas view is opt-in (system.cluster_fanout).
  write_string(w, "scope", "server");

  w.Key("server");
  w.StartObject();
  write_string(w, "hostname", overview.hostname);
  write_string(w, "version", overview.version);
  write_string(w, "timezone", overview.timezone);
  write_optional(w, "uptime_seconds", overview.uptime_seconds);
  w.EndObject();

  w.Key("metrics");
  w.StartObject();
  for (const auto& [name, value] : overview.metrics) {
    w.Key(name.c_str());
    w.Double(value);
  }
  w.EndObject();

  w.Key("topology");
  w.StartObject();
  w.Key("row_limit"); w.Uint64(kMonitorTopologyRowLimit);
  w.Key("truncated"); w.Bool(overview.topology_truncated);
  w.Key("nodes");
  w.StartArray();
  for (const auto& node : overview.topology) {
    w.StartObject();
    write_string(w, "cluster", node.cluster);
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("shard_weight"); w.Uint64(node.shard_weight);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    write_string(w, "host_name", node.host_name);
    write_string(w, "host_address", node.host_address);
    w.Key("port"); w.Uint64(node.port);
    w.Key("is_local"); w.Bool(node.is_local);
    write_optional(w, "errors_count", node.errors_count);
    write_optional(w, "slowdowns_count", node.slowdowns_count);
    write_optional(w, "estimated_recovery_time", node.estimated_recovery_time);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  w.Key("replication");
  if (overview.replication) {
    const auto& r = *overview.replication;
    w.StartObject();
    w.Key("tables"); w.Uint64(r.tables);
    w.Key("readonly"); w.Uint64(r.readonly);
    w.Key("session_expired"); w.Uint64(r.session_expired);
    w.Key("max_delay_seconds"); w.Uint64(r.max_delay_seconds);
    w.Key("queue_size"); w.Uint64(r.queue_size);
    w.Key("inserts_in_queue"); w.Uint64(r.inserts_in_queue);
    w.Key("merges_in_queue"); w.Uint64(r.merges_in_queue);
    w.Key("future_parts_over"); w.Uint64(r.future_parts_over);
    w.Key("parts_to_check_over"); w.Uint64(r.parts_to_check_over);
    w.Key("queue_over"); w.Uint64(r.queue_over);
    w.Key("inserts_over"); w.Uint64(r.inserts_over);
    w.Key("truncated"); w.Bool(r.truncated);
    w.EndObject();
  } else {
    w.Null();
  }

  w.Key("logs");
  w.StartObject();
  for (const auto& [name, present] : overview.logs) {
    w.Key(name.c_str());
    w.Bool(present);
  }
  w.EndObject();

  w.Key("unavailable_panels");
  w.StartArray();
  for (const auto& issue : overview.unavailable_panels) {
    w.StartObject();
    write_string(w, "panel", issue.panel);
    write_string(w, "table", issue.table);
    write_string(w, "reason", issue.reason);
    write_string(w, "message", issue.message);
    write_string(w, "hint", issue.hint);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

// Performance: bucketed history of the server's system logs. The request
// names the host, a window (milliseconds, clamped and validated here), an
// allowlisted panel and scope, and nothing else: an unknown parameter is
// refused, so no request text can reach the SQL.
void Server::handle_system_series(const httplib::Request& req, httplib::Response& res) {
  static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "panel", "scope", "refresh"};
  for (const auto& [name, value] : req.params) {
    (void)value;
    if (!kParams.count(name)) return json_error(res, 400, "unknown_parameter", "Unknown parameter: " + name + ".");
  }
  const auto param = [&](const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; };
  const std::string host_id = param("host_id");
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const std::string panel = req.has_param("panel") ? param("panel") : std::string("performance");
  if (panel != "performance" && panel != "disk_growth") {
    return json_error(res, 400, "invalid_panel", "panel must be performance or disk_growth.");
  }
  const bool growth = panel == "disk_growth";
  // Cluster fan-out (clusterAllReplicas) is opt-in: system.cluster_fanout.
  const std::string scope = req.has_param("scope") ? param("scope") : std::string("server");
  if (scope == "cluster") {
    if (!cfg_.system.cluster_fanout) {
      return json_error(res, 400, "cluster_fanout_disabled", "The cluster view is off (system.cluster_fanout).");
    }
    return json_error(res, 501, "cluster_scope_unsupported", "The Performance section reads this server only.");
  }
  if (scope != "server") return json_error(res, 400, "invalid_scope", "scope must be server or cluster.");

  // The window: the default lookback when absent, at most max_lookback_days.
  const uint64_t now_ms = monitor_api_now_ms();
  const uint64_t max_span_ms = static_cast<uint64_t>(cfg_.system.max_lookback_days) * 86'400'000ULL;
  uint64_t to_ms = now_ms;
  uint64_t from_ms = 0;
  if (req.has_param("to_ms") && !parse_ms(param("to_ms"), to_ms)) {
    return json_error(res, 400, "invalid_range", "to_ms must be a whole number of milliseconds.");
  }
  if (req.has_param("from_ms")) {
    if (!parse_ms(param("from_ms"), from_ms)) return json_error(res, 400, "invalid_range", "from_ms must be a whole number of milliseconds.");
  } else {
    // Disk growth opens on system.disk_growth_days.
    const uint64_t lookback = growth ? static_cast<uint64_t>(cfg_.system.disk_growth_days) * 86'400'000ULL
                                     : static_cast<uint64_t>(cfg_.system.default_lookback_minutes) * 60'000ULL;
    from_ms = to_ms > lookback ? to_ms - lookback : 0;
  }
  // A window ending in the future ends now.
  to_ms = std::min(to_ms, now_ms);
  if (from_ms >= to_ms) return json_error(res, 400, "invalid_range", "from_ms must be before to_ms (and before now).");
  if (to_ms - from_ms > max_span_ms) {
    return json_error(res, 400, "range_too_large",
                      "The window is wider than " + std::to_string(cfg_.system.max_lookback_days) +
                          " days (system.max_lookback_days).");
  }

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }
  const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;

  MonitorSeriesWindow window;
  window.step_s = monitor_series_step_seconds((to_ms - from_ms + 999) / 1000);
  window.from_s = from_ms / 1000 / window.step_s * window.step_s;
  window.to_s = ((to_ms + 999) / 1000 + window.step_s - 1) / window.step_s * window.step_s;
  window.now_s = now_ms / 1000;
  window.span_s = (to_ms - from_ms + 999) / 1000;
  window.query_log_max_span_s = static_cast<uint64_t>(cfg_.system.query_log_max_lookback_hours) * 3600ULL;
  window.query_log_max_rows = cfg_.system.query_log_max_rows;

  const auto caps = system_monitor_capabilities(host_id, system_uri);
  if (growth) return system_monitor_disk_growth(req, res, *host, system_uri, caps, window, from_ms, to_ms, now_ms);
  const std::string key = host_id + std::string("\0monitor-series\0", 16) + panel + "|" + std::to_string(window.from_s) + "-" +
                          std::to_string(window.to_s) + "/" + std::to_string(window.step_s) +
                          (window.span_s > window.query_log_max_span_s ? "/no-query-log" : "");
  if (param("refresh") == "1") system_monitor_series_cache_.erase(key);
  // Relative windows move with the clock: past this many windows the map is
  // emptied rather than kept for windows nobody asks for again.
  if (system_monitor_series_cache_.size() > kMonitorSeriesCacheEntries) system_monitor_series_cache_.clear();
  auto result = system_monitor_series_cache_.get_or_refresh(
      key, now_ms, kMonitorSeriesTtlMs, 250,
      [&](SystemMonitorSeries& value, std::string& code, std::string& message) {
        std::string error;
        auto system = acquire_monitor_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        load_system_monitor_series(*system, *caps, window, value);
        // A source that failed outside ClickHouse (a broken connection)
        // leaves the client in an unknown state.
        if (client_pool_) {
          for (const auto& [name, source] : value.sources) {
            (void)name;
            if (source.status == "failed") {
              client_pool_->invalidate(system);
              break;
            }
          }
        }
        return true;
      });
  if (!result.has_value || !result.value) {
    return json_error(
        res, 503,
        result.error_code.empty() ? "system_monitor_unavailable" : result.error_code,
        result.error_message.empty() ? "The performance history is unavailable." : result.error_message);
  }

  const SystemMonitorSeries& series = *result.value;
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  write_string(w, "panel", panel);
  write_string(w, "scope", "server");
  w.Key("generated_at_ms"); w.Uint64(series.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  // The window asked for, and the aligned one the buckets cover.
  w.Key("requested");
  w.StartObject();
  w.Key("from_ms"); w.Uint64(from_ms);
  w.Key("to_ms"); w.Uint64(to_ms);
  w.EndObject();
  w.Key("from_ms"); w.Uint64(series.window.from_s * 1000);
  w.Key("to_ms"); w.Uint64(series.window.to_s * 1000);
  w.Key("step_seconds"); w.Uint(series.window.step_s);
  w.Key("limits");
  w.StartObject();
  w.Key("max_lookback_days"); w.Int(cfg_.system.max_lookback_days);
  w.Key("query_log_max_lookback_hours"); w.Int(cfg_.system.query_log_max_lookback_hours);
  w.Key("max_points"); w.Uint64(kMonitorSeriesMaxPoints);
  w.EndObject();
  w.Key("replicated_tables"); w.Bool(series.replicated_tables);

  w.Key("timestamps");
  w.StartArray();
  for (const uint64_t t : series.buckets) w.Uint64(t * 1000);
  w.EndArray();

  w.Key("series");
  w.StartObject();
  for (const auto& [name, values] : series.series) {
    w.Key(name.c_str());
    w.StartArray();
    for (const double value : values) write_series_value(w, value);
    w.EndArray();
  }
  w.EndObject();

  w.Key("sources");
  w.StartObject();
  for (const auto& [name, source] : series.sources) {
    w.Key(name.c_str());
    w.StartObject();
    write_string(w, "table", source.table);
    write_string(w, "status", source.status);
    write_string(w, "message", source.message);
    write_string(w, "hint", source.hint);
    w.Key("rows_read"); w.Uint64(source.rows_read);
    w.Key("elapsed_ms"); w.Uint64(source.elapsed_ms);
    w.Key("missing");
    w.StartArray();
    for (const auto& item : source.missing) write_string_value(w, item);
    w.EndArray();
    w.EndObject();
  }
  w.EndObject();

  // The sources that could not be read, in the Overview's shape (the
  // window being wider than query_log's lookback is not a failure).
  w.Key("unavailable_panels");
  w.StartArray();
  for (const auto& [name, source] : series.sources) {
    if (source.status == "ok" || source.status == "out_of_range") continue;
    w.StartObject();
    write_string(w, "panel", name);
    write_string(w, "table", source.table);
    write_string(w, "reason", source.status);
    write_string(w, "message", source.message);
    write_string(w, "hint", source.hint);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

// Disk growth (/series?panel=disk_growth): each disk's used bytes over the
// window, its trend and days until full, the MergeTree tables' bytes, and
// what the runner-visible databases wrote and moved. The window was
// validated by the series handler; 5 min per aligned window.
void Server::system_monitor_disk_growth(const httplib::Request& req, httplib::Response& res, const HostSpec& host,
                                          const std::string& system_uri, const std::shared_ptr<const MonitorCapabilities>& caps,
                                          const MonitorSeriesWindow& window, uint64_t from_ms, uint64_t to_ms, uint64_t now_ms) {
  const std::string key = host.id + std::string("\0monitor-growth\0", 16) + std::to_string(window.from_s) + "-" +
                          std::to_string(window.to_s) + "/" + std::to_string(window.step_s);
  if (req.has_param("refresh") && req.get_param_value("refresh") == "1") system_monitor_growth_cache_.erase(key);
  if (system_monitor_growth_cache_.size() > kMonitorGrowthCacheEntries) system_monitor_growth_cache_.clear();
  auto result = system_monitor_growth_cache_.get_or_refresh(
      key, now_ms, kMonitorGrowthTtlMs, 250,
      [&](SystemMonitorDiskGrowth& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_monitor_client(client_pool_, host.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        auto system = acquire_monitor_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        load_system_monitor_disk_growth(*system, *runner, *caps, window, value);
        // A source that failed outside ClickHouse (a broken connection)
        // leaves the clients in an unknown state.
        if (client_pool_) {
          for (const auto& [name, source] : value.sources) {
            (void)name;
            if (source.status == "failed") {
              client_pool_->invalidate(system);
              client_pool_->invalidate(runner);
              break;
            }
          }
        }
        return true;
      });
  if (!result.has_value || !result.value) {
    return json_error(
        res, 503,
        result.error_code.empty() ? "system_monitor_unavailable" : result.error_code,
        result.error_message.empty() ? "The disk growth is unavailable." : result.error_message);
  }

  const SystemMonitorDiskGrowth& data = *result.value;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host.id);
  write_string(w, "panel", "disk_growth");
  write_string(w, "scope", "server");
  w.Key("generated_at_ms"); w.Uint64(data.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  w.Key("requested");
  w.StartObject();
  w.Key("from_ms"); w.Uint64(from_ms);
  w.Key("to_ms"); w.Uint64(to_ms);
  w.EndObject();
  w.Key("from_ms"); w.Uint64(data.window.from_s * 1000);
  w.Key("to_ms"); w.Uint64(data.window.to_s * 1000);
  w.Key("step_seconds"); w.Uint(data.window.step_s);
  w.Key("limits");
  w.StartObject();
  w.Key("max_lookback_days"); w.Int(cfg_.system.max_lookback_days);
  w.Key("disk_growth_days"); w.Int(cfg_.system.disk_growth_days);
  w.Key("max_points"); w.Uint64(kMonitorSeriesMaxPoints);
  w.Key("trend_min_points"); w.Uint64(kMonitorDiskTrendMinPoints);
  w.Key("trend_min_span_seconds"); w.Uint64(kMonitorDiskTrendMinSpanSeconds);
  w.EndObject();
  // Which form of the per-disk metrics this server logs: "key" (26.8+:
  // metric 'DiskUsed' with the disk in `key`, the legacy names read too) or
  // "names" (DiskUsed_<disk>).
  write_string(w, "disk_metric_form", data.key_column ? "key" : "names");

  w.Key("timestamps");
  w.StartArray();
  for (const uint64_t t : data.buckets) w.Uint64(t * 1000);
  w.EndArray();

  w.Key("disks");
  w.StartArray();
  for (const auto& disk : data.disks) {
    w.StartObject();
    write_string(w, "name", disk.name);
    w.Key("free_space"); w.Uint64(disk.free_space);
    w.Key("total_space"); w.Uint64(disk.total_space);
    w.Key("used");
    w.StartArray();
    for (const double value : disk.used) write_series_value(w, value);
    w.EndArray();
    w.Key("trend");
    w.StartObject();
    write_string(w, "status", disk.trend.status);
    w.Key("points"); w.Uint64(disk.trend.points);
    w.Key("span_seconds"); w.Uint64(disk.trend.span_s);
    w.Key("slope_bytes_per_day");
    if (disk.trend.status == "growing" || disk.trend.status == "not_growing") write_series_value(w, disk.trend.slope_bytes_per_day);
    else w.Null();
    w.Key("days_until_full");
    if (disk.trend.days_until_full) write_series_value(w, *disk.trend.days_until_full);
    else w.Null();
    w.EndObject();
    w.EndObject();
  }
  w.EndArray();

  w.Key("series");
  w.StartObject();
  for (const auto& [name, values] : data.series) {
    w.Key(name.c_str());
    w.StartArray();
    for (const double value : values) write_series_value(w, value);
    w.EndArray();
  }
  w.EndObject();

  w.Key("sources");
  w.StartObject();
  for (const auto& [name, source] : data.sources) {
    w.Key(name.c_str());
    write_source(w, source);
  }
  w.EndObject();

  w.Key("unavailable_panels");
  w.StartArray();
  for (const auto& [name, source] : data.sources) {
    if (source.status == "ok") continue;
    w.StartObject();
    write_string(w, "panel", name);
    write_string(w, "table", source.table);
    write_string(w, "reason", source.status);
    write_string(w, "message", source.message);
    write_string(w, "hint", source.hint);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

// Disks: the server's disks (capacity, free and reserved space, kind, flags,
// the policies they belong to), its storage policies, and the bytes of the
// active parts of each runner-visible database on each disk. The request
// names the host (and refresh) only.
void Server::handle_system_disks(const httplib::Request& req, httplib::Response& res) {
  static const std::set<std::string> kParams{"host_id", "refresh"};
  for (const auto& [name, value] : req.params) {
    (void)value;
    if (!kParams.count(name)) return json_error(res, 400, "unknown_parameter", "Unknown parameter: " + name + ".");
  }
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }
  const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  const uint64_t now = monitor_api_now_ms();
  const auto caps = system_monitor_capabilities(host_id, system_uri);

  const std::string key = host_id + std::string("\0monitor-disks", 14);
  if (req.has_param("refresh") && req.get_param_value("refresh") == "1") system_monitor_disks_cache_.erase(key);
  auto result = system_monitor_disks_cache_.get_or_refresh(
      key, now, kMonitorDisksTtlMs, 250,
      [&](SystemMonitorDisks& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_monitor_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        auto system = acquire_monitor_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        try {
          if (!load_system_monitor_disks(*system, *runner, *caps, value, &error)) {
            code = "system_monitor_failed";
            message = error.empty() ? "The disks are unavailable." : error;
            return false;
          }
          return true;
        } catch (const std::exception& e) {
          code = "system_monitor_failed";
          message = e.what();
          if (client_pool_) {
            client_pool_->invalidate(runner);
            client_pool_->invalidate(system);
          }
          return false;
        }
      });
  if (!result.has_value || !result.value) {
    return json_error(
        res, 503,
        result.error_code.empty() ? "system_monitor_unavailable" : result.error_code,
        result.error_message.empty() ? "The disks are unavailable." : result.error_message);
  }

  const SystemMonitorDisks& data = *result.value;
  // The policies and volumes each disk belongs to.
  std::map<std::string, std::vector<std::pair<std::string, std::string>>> membership;
  for (const auto& volume : data.volumes) {
    for (const auto& disk : volume.disks) membership[disk].emplace_back(volume.policy, volume.volume);
  }

  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  write_string(w, "scope", "server");
  w.Key("generated_at_ms"); w.Uint64(data.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  w.Key("limits");
  w.StartObject();
  w.Key("disk_row_limit"); w.Uint64(kMonitorDiskRowLimit);
  w.Key("policy_row_limit"); w.Uint64(kMonitorPolicyRowLimit);
  w.Key("usage_row_limit"); w.Uint64(kMonitorDiskUsageRowLimit);
  w.Key("disk_growth_days"); w.Int(cfg_.system.disk_growth_days);
  w.Key("max_lookback_days"); w.Int(cfg_.system.max_lookback_days);
  w.EndObject();

  w.Key("disks");
  w.StartArray();
  for (const auto& disk : data.disks) {
    w.StartObject();
    write_string(w, "name", disk.name);
    write_string(w, "path", disk.path);
    write_string(w, "type", disk.type);
    write_string(w, "object_storage_type", disk.object_storage_type);
    write_string(w, "cache_path", disk.cache_path);
    w.Key("free_space"); w.Uint64(disk.free_space);
    w.Key("total_space"); w.Uint64(disk.total_space);
    // Used: what is not free, null when the disk reports no capacity
    // (object storage).
    w.Key("used_space");
    if (disk.total_space > 0) w.Uint64(disk.total_space > disk.free_space ? disk.total_space - disk.free_space : 0);
    else w.Null();
    write_optional(w, "unreserved_space", disk.unreserved_space);
    write_optional(w, "keep_free_space", disk.keep_free_space);
    write_optional_bool(w, "is_read_only", disk.is_read_only);
    write_optional_bool(w, "is_broken", disk.is_broken);
    write_optional_bool(w, "is_encrypted", disk.is_encrypted);
    write_optional_bool(w, "is_remote", disk.is_remote);
    w.Key("policies");
    w.StartArray();
    const auto it = membership.find(disk.name);
    if (it != membership.end()) {
      for (const auto& [policy, volume] : it->second) {
        w.StartObject();
        write_string(w, "policy", policy);
        write_string(w, "volume", volume);
        w.EndObject();
      }
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("disks_truncated"); w.Bool(data.disks_truncated);

  // Policies, their volumes in priority order.
  w.Key("policies");
  w.StartArray();
  for (size_t i = 0; i < data.volumes.size();) {
    const std::string& policy = data.volumes[i].policy;
    w.StartObject();
    write_string(w, "name", policy);
    w.Key("volumes");
    w.StartArray();
    for (; i < data.volumes.size() && data.volumes[i].policy == policy; ++i) {
      const auto& volume = data.volumes[i];
      w.StartObject();
      write_string(w, "name", volume.volume);
      w.Key("priority"); w.Uint64(volume.priority);
      write_strings(w, "disks", volume.disks);
      write_string(w, "volume_type", volume.volume_type);
      write_optional(w, "max_data_part_size", volume.max_data_part_size);
      w.Key("move_factor");
      if (volume.move_factor) write_series_value(w, *volume.move_factor);
      else w.Null();
      write_optional_bool(w, "prefer_not_to_merge", volume.prefer_not_to_merge);
      write_optional_bool(w, "perform_ttl_move_on_insert", volume.perform_ttl_move_on_insert);
      write_string(w, "load_balancing", volume.load_balancing);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("policies_truncated"); w.Bool(data.volumes_truncated);

  // Bytes by disk and database: the runner-visible databases only.
  w.Key("usage");
  w.StartObject();
  w.Key("truncated"); w.Bool(data.usage_truncated);
  w.Key("rows");
  w.StartArray();
  for (const auto& usage : data.usage) {
    w.StartObject();
    write_string(w, "disk", usage.disk);
    write_string(w, "database", usage.database);
    w.Key("bytes"); w.Uint64(usage.bytes);
    w.Key("rows"); w.Uint64(usage.rows);
    w.Key("parts"); w.Uint64(usage.parts);
    w.Key("compact_parts"); w.Uint64(usage.compact_parts);
    w.EndObject();
  }
  w.EndArray();
  // Per disk: every runner-visible database's bytes, parts and count, the
  // rows past the cut included.
  w.Key("disks");
  w.StartObject();
  std::set<std::string> written;
  for (const auto& usage : data.usage) {
    if (!written.insert(usage.disk).second) continue;
    w.Key(usage.disk.c_str(), static_cast<rapidjson::SizeType>(usage.disk.size()));
    w.StartObject();
    w.Key("bytes"); w.Uint64(usage.disk_bytes);
    w.Key("parts"); w.Uint64(usage.disk_parts);
    w.Key("databases"); w.Uint64(usage.disk_databases);
    w.EndObject();
  }
  w.EndObject();
  w.EndObject();

  w.Key("logs");
  w.StartObject();
  for (const auto& [name, present] : data.logs) {
    w.Key(name.c_str());
    w.Bool(present);
  }
  w.EndObject();

  w.Key("unavailable_panels");
  w.StartArray();
  for (const auto& issue : data.unavailable_panels) {
    w.StartObject();
    write_string(w, "panel", issue.panel);
    write_string(w, "table", issue.table);
    write_string(w, "reason", issue.reason);
    write_string(w, "message", issue.message);
    write_string(w, "hint", issue.hint);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

// Queries: the window of a request (the list and a drill-down share it).
// Absent: the last default_lookback_minutes (at most the lookback); a window
// ending in the future ends now; wider than query_log_max_lookback_hours is
// refused. Writes the error and returns false when the window is invalid.
bool Server::system_monitor_queries_window(const httplib::Request& req, httplib::Response& res,
                                             uint64_t now_ms, uint64_t& from_ms, uint64_t& to_ms) {
  const auto param = [&](const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; };
  const uint64_t max_span_ms = static_cast<uint64_t>(cfg_.system.query_log_max_lookback_hours) * 3'600'000ULL;
  to_ms = now_ms;
  from_ms = 0;
  if (req.has_param("to_ms") && !parse_ms(param("to_ms"), to_ms)) {
    json_error(res, 400, "invalid_range", "to_ms must be a whole number of milliseconds.");
    return false;
  }
  if (req.has_param("from_ms")) {
    if (!parse_ms(param("from_ms"), from_ms)) {
      json_error(res, 400, "invalid_range", "from_ms must be a whole number of milliseconds.");
      return false;
    }
  } else {
    const uint64_t lookback = std::min<uint64_t>(
        static_cast<uint64_t>(cfg_.system.default_lookback_minutes) * 60'000ULL, max_span_ms);
    from_ms = to_ms > lookback ? to_ms - lookback : 0;
  }
  to_ms = std::min(to_ms, now_ms);
  if (from_ms >= to_ms) {
    json_error(res, 400, "invalid_range", "from_ms must be before to_ms (and before now).");
    return false;
  }
  if (to_ms - from_ms > max_span_ms) {
    json_error(res, 400, "range_too_large",
               "The window is wider than " + std::to_string(cfg_.system.query_log_max_lookback_hours) +
                   " hours (system.query_log_max_lookback_hours).");
    return false;
  }
  return true;
}

// Top queries: the shapes of the window's queries by an allowlisted measure,
// read from system.query_log with the RUNNER account (ClickHouse grants
// decide; the Query page reads the same rows). The request names the host,
// a window and allowlisted sort / kind / errors / hide_chdash values, and
// optionally one user (a bound query parameter of the SELECT, never SQL
// text); anything else is refused before the host is looked up.
void Server::handle_system_queries(const httplib::Request& req, httplib::Response& res) {
  static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "sort", "kind", "errors", "user", "hide_chdash", "refresh"};
  for (const auto& [name, value] : req.params) {
    (void)value;
    if (!kParams.count(name)) return json_error(res, 400, "unknown_parameter", "Unknown parameter: " + name + ".");
  }
  const auto param = [&](const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; };
  const std::string host_id = param("host_id");
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const auto one_of = [](const std::vector<std::string>& names) {
    std::string out;
    for (const auto& name : names) out += (out.empty() ? "" : ", ") + name;
    return out;
  };
  const std::string sort = req.has_param("sort") ? param("sort") : std::string("total_time");
  const auto& sorts = monitor_queries_sorts();
  if (std::find(sorts.begin(), sorts.end(), sort) == sorts.end()) {
    return json_error(res, 400, "invalid_sort", "sort must be one of " + one_of(sorts) + ".");
  }
  const std::string kind = req.has_param("kind") ? param("kind") : std::string("all");
  const auto& kinds = monitor_queries_kinds();
  if (std::find(kinds.begin(), kinds.end(), kind) == kinds.end()) {
    return json_error(res, 400, "invalid_kind", "kind must be one of " + one_of(kinds) + ".");
  }
  const std::string errors = req.has_param("errors") ? param("errors") : std::string("all");
  const auto& error_filters = monitor_queries_error_filters();
  if (std::find(error_filters.begin(), error_filters.end(), errors) == error_filters.end()) {
    return json_error(res, 400, "invalid_errors", "errors must be one of " + one_of(error_filters) + ".");
  }
  // One user, or every user (absent or empty).
  const std::string user = param("user");
  if (!user.empty() && !monitor_queries_user_valid(user)) {
    return json_error(res, 400, "invalid_user", "user must be 1 to " + std::to_string(kMonitorQueryUserMaxBytes) +
                                                   " bytes without control characters.");
  }
  const std::string hide = req.has_param("hide_chdash") ? param("hide_chdash") : std::string("1");
  if (hide != "1" && hide != "0") return json_error(res, 400, "invalid_hide_chdash", "hide_chdash must be 1 or 0.");

  const uint64_t now_ms = monitor_api_now_ms();
  uint64_t from_ms = 0;
  uint64_t to_ms = 0;
  if (!system_monitor_queries_window(req, res, now_ms, from_ms, to_ms)) return;

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }
  const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  const auto caps = system_monitor_capabilities(host_id, system_uri);

  MonitorQueriesRequest request;
  // Minute-aligned: every request of the same minute shares one read.
  request.from_s = from_ms / 60'000 * 60;
  request.to_s = (to_ms + 59'999) / 60'000 * 60;
  request.now_s = now_ms / 1000;
  request.sort = sort;
  request.kind = kind;
  request.errors = errors;
  request.user = user;
  request.hide_chdash = hide == "1";
  request.system_user = caps->system_user;
  if (const auto parsed = parse_clickhouse_uri(host->runner_uri, nullptr)) request.runner_user = parsed->user;
  request.max_rows = cfg_.system.query_log_max_rows;

  // Every filter is in the key; the user last, length-prefixed (any byte).
  const std::string key = host_id + std::string("\0monitor-queries\0", 17) + std::to_string(request.from_s) + "-" +
                          std::to_string(request.to_s) + "|" + sort + "|" + kind + "|" + errors + "|" + hide + "|" +
                          std::to_string(user.size()) + ":" + user;
  if (param("refresh") == "1") system_monitor_queries_cache_.erase(key);
  if (system_monitor_queries_cache_.size() > kMonitorQueriesCacheEntries) system_monitor_queries_cache_.clear();
  auto result = system_monitor_queries_cache_.get_or_refresh(
      key, now_ms, kMonitorQueriesTtlMs, kMonitorQueriesWaitMs,
      [&](SystemMonitorQueries& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_queries_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        if (!load_system_monitor_queries(*runner, *caps, request, value, &error)) {
          if (client_pool_) client_pool_->invalidate(runner);
          code = "system_monitor_failed";
          message = error.empty() ? "The top queries are unavailable." : error;
          return false;
        }
        return true;
      });
  if (!result.has_value || !result.value) {
    return json_error(
        res, 503,
        result.error_code.empty() ? "system_monitor_unavailable" : result.error_code,
        result.error_message.empty() ? "The top queries are unavailable." : result.error_message);
  }

  const SystemMonitorQueries& data = *result.value;
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  write_string(w, "scope", "server");
  w.Key("generated_at_ms"); w.Uint64(data.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  w.Key("requested");
  w.StartObject();
  w.Key("from_ms"); w.Uint64(from_ms);
  w.Key("to_ms"); w.Uint64(to_ms);
  w.EndObject();
  w.Key("from_ms"); w.Uint64(data.request.from_s * 1000);
  w.Key("to_ms"); w.Uint64(data.request.to_s * 1000);
  write_string(w, "sort", data.request.sort);
  write_string(w, "kind", data.request.kind);
  write_string(w, "errors", data.request.errors);
  write_string(w, "user", data.request.user);
  w.Key("hide_chdash"); w.Bool(data.request.hide_chdash);
  w.Key("limits");
  w.StartObject();
  w.Key("query_log_max_lookback_hours"); w.Int(cfg_.system.query_log_max_lookback_hours);
  w.Key("query_log_max_rows"); w.Uint64(cfg_.system.query_log_max_rows);
  w.Key("row_limit"); w.Uint64(kMonitorTopQueries);
  w.Key("user_limit"); w.Uint64(kMonitorQueryUsers);
  w.EndObject();
  // The user filter's choices: the window's users (same filters), with their
  // query counts, the most active first.
  w.Key("users");
  w.StartArray();
  for (const auto& [name, calls] : data.users) {
    w.StartObject();
    write_string(w, "name", name);
    w.Key("calls"); w.Uint64(calls);
    w.EndObject();
  }
  w.EndArray();
  write_queries_status(w, data.status, data.message, data.hint, data.suggested_span_s);
  w.Key("phases");
  w.StartObject();
  write_query_read(w, "aggregate", data.aggregate);
  write_query_read(w, "text", data.text);
  w.EndObject();
  w.Key("totals");
  w.StartObject();
  w.Key("calls"); w.Uint64(data.totals.calls);
  w.Key("errors"); w.Uint64(data.totals.errors);
  w.Key("total_ms"); w.Double(data.totals.total_ms);
  w.Key("read_bytes"); w.Uint64(data.totals.read_bytes);
  w.Key("shapes"); w.Uint64(data.totals.shapes);
  w.EndObject();
  w.Key("queries");
  w.StartArray();
  for (const auto& shape : data.queries) {
    w.StartObject();
    // A UInt64: a string, so no digit is lost in JavaScript.
    write_string(w, "hash", std::to_string(shape.hash));
    write_string(w, "kind", shape.kind);
    w.Key("calls"); w.Uint64(shape.calls);
    w.Key("errors"); w.Uint64(shape.errors);
    w.Key("total_ms"); w.Double(shape.total_ms);
    w.Key("avg_ms"); w.Double(shape.avg_ms);
    w.Key("p95_ms"); w.Double(shape.p95_ms);
    w.Key("max_ms"); w.Double(shape.max_ms);
    w.Key("read_rows"); w.Uint64(shape.read_rows);
    w.Key("read_bytes"); w.Uint64(shape.read_bytes);
    w.Key("written_rows"); w.Uint64(shape.written_rows);
    w.Key("result_rows"); w.Uint64(shape.result_rows);
    w.Key("avg_memory"); w.Double(shape.avg_memory);
    w.Key("max_memory"); w.Uint64(shape.max_memory);
    write_strings(w, "users", shape.users);
    write_strings(w, "tables", shape.tables);
    w.Key("first_seen_ms"); w.Uint64(shape.first_seen_s * 1000);
    w.Key("last_seen_ms"); w.Uint64(shape.last_seen_s * 1000);
    w.Key("has_text"); w.Bool(shape.has_text);
    write_string(w, "normalized", shape.normalized);
    write_string(w, "example", shape.example);
    w.Key("example_truncated"); w.Bool(shape.example_truncated);
    write_string(w, "last_query_id", shape.last_query_id);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

// One query shape: its timeline over the window and its 20 slowest, latest
// or largest runs, with the latest run's text. Runner context, as the list.
void Server::handle_system_query(const httplib::Request& req, httplib::Response& res) {
  static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "order", "hide_chdash", "refresh"};
  for (const auto& [name, value] : req.params) {
    (void)value;
    if (!kParams.count(name)) return json_error(res, 400, "unknown_parameter", "Unknown parameter: " + name + ".");
  }
  const auto param = [&](const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; };
  const std::string host_id = param("host_id");
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  uint64_t hash = 0;
  const std::string hash_text = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
  if (!parse_hash(hash_text, hash)) {
    return json_error(res, 400, "invalid_hash", "The query hash must be a normalized_query_hash (a UInt64).");
  }
  const std::string order = req.has_param("order") ? param("order") : std::string("duration");
  const auto& orders = monitor_query_run_orders();
  if (std::find(orders.begin(), orders.end(), order) == orders.end()) {
    return json_error(res, 400, "invalid_order", "order must be one of duration, latest, memory.");
  }
  const std::string hide = req.has_param("hide_chdash") ? param("hide_chdash") : std::string("1");
  if (hide != "1" && hide != "0") return json_error(res, 400, "invalid_hide_chdash", "hide_chdash must be 1 or 0.");

  const uint64_t now_ms = monitor_api_now_ms();
  uint64_t from_ms = 0;
  uint64_t to_ms = 0;
  if (!system_monitor_queries_window(req, res, now_ms, from_ms, to_ms)) return;

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }
  const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  const auto caps = system_monitor_capabilities(host_id, system_uri);

  MonitorQueriesRequest request;
  // The Performance steps (at most 300 buckets); the window aligned to the
  // step, which a minute-aligned window already is up to 1 min steps.
  request.step_s = monitor_series_step_seconds((to_ms - from_ms + 999) / 1000);
  request.from_s = from_ms / 1000 / request.step_s * request.step_s;
  request.to_s = ((to_ms + 999) / 1000 + request.step_s - 1) / request.step_s * request.step_s;
  request.now_s = now_ms / 1000;
  request.hash = hash;
  request.order = order;
  request.hide_chdash = hide == "1";
  request.system_user = caps->system_user;
  if (const auto parsed = parse_clickhouse_uri(host->runner_uri, nullptr)) request.runner_user = parsed->user;
  request.max_rows = cfg_.system.query_log_max_rows;

  const std::string key = host_id + std::string("\0monitor-query\0", 15) + std::to_string(hash) + "|" +
                          std::to_string(request.from_s) + "-" + std::to_string(request.to_s) + "/" +
                          std::to_string(request.step_s) + "|" + order + "|" + hide;
  if (param("refresh") == "1") system_monitor_query_cache_.erase(key);
  if (system_monitor_query_cache_.size() > kMonitorQueriesCacheEntries) system_monitor_query_cache_.clear();
  auto result = system_monitor_query_cache_.get_or_refresh(
      key, now_ms, kMonitorQueriesTtlMs, kMonitorQueriesWaitMs,
      [&](SystemMonitorQuery& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_queries_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        if (!load_system_monitor_query(*runner, *caps, request, value, &error)) {
          if (client_pool_) client_pool_->invalidate(runner);
          code = "system_monitor_failed";
          message = error.empty() ? "The query's history is unavailable." : error;
          return false;
        }
        return true;
      });
  if (!result.has_value || !result.value) {
    return json_error(
        res, 503,
        result.error_code.empty() ? "system_monitor_unavailable" : result.error_code,
        result.error_message.empty() ? "The query's history is unavailable." : result.error_message);
  }

  const SystemMonitorQuery& data = *result.value;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  write_string(w, "scope", "server");
  write_string(w, "hash", std::to_string(data.request.hash));
  w.Key("generated_at_ms"); w.Uint64(data.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  w.Key("requested");
  w.StartObject();
  w.Key("from_ms"); w.Uint64(from_ms);
  w.Key("to_ms"); w.Uint64(to_ms);
  w.EndObject();
  w.Key("from_ms"); w.Uint64(data.request.from_s * 1000);
  w.Key("to_ms"); w.Uint64(data.request.to_s * 1000);
  w.Key("step_seconds"); w.Uint(data.request.step_s);
  write_string(w, "order", data.request.order);
  w.Key("hide_chdash"); w.Bool(data.request.hide_chdash);
  w.Key("limits");
  w.StartObject();
  w.Key("query_log_max_lookback_hours"); w.Int(cfg_.system.query_log_max_lookback_hours);
  w.Key("query_log_max_rows"); w.Uint64(cfg_.system.query_log_max_rows);
  w.Key("run_limit"); w.Uint64(kMonitorQueryRuns);
  w.EndObject();
  write_queries_status(w, data.status, data.message, data.hint, data.suggested_span_s);
  w.Key("summary");
  w.StartObject();
  w.Key("calls"); w.Uint64(data.summary.calls);
  w.Key("errors"); w.Uint64(data.summary.errors);
  w.Key("total_ms"); w.Double(data.summary.total_ms);
  w.Key("avg_ms"); w.Double(data.summary.calls ? data.summary.total_ms / static_cast<double>(data.summary.calls) : 0.0);
  w.Key("p95_ms"); w.Double(data.summary.p95_ms);
  w.Key("max_ms"); w.Double(data.summary.max_ms);
  w.Key("read_rows"); w.Uint64(data.summary.read_rows);
  w.Key("read_bytes"); w.Uint64(data.summary.read_bytes);
  w.Key("max_memory"); w.Uint64(data.summary.max_memory);
  w.Key("cpu_seconds"); w.Double(data.summary.cpu_seconds);
  w.EndObject();
  write_string(w, "kind", data.kind);
  write_string(w, "normalized", data.normalized);
  w.Key("example");
  w.StartObject();
  write_string(w, "text", data.example);
  w.Key("truncated"); w.Bool(data.example_truncated);
  write_string(w, "query_id", data.example_query_id);
  w.EndObject();
  w.Key("reads");
  w.StartObject();
  write_query_read(w, "timeline", data.timeline_read);
  write_query_read(w, "runs", data.runs_read);
  write_query_read(w, "example", data.example_read);
  w.EndObject();
  w.Key("timestamps");
  w.StartArray();
  for (const uint64_t t : data.buckets) w.Uint64(t * 1000);
  w.EndArray();
  w.Key("series");
  w.StartObject();
  for (const auto& [name, values] : data.series) {
    w.Key(name.c_str());
    w.StartArray();
    for (const double value : values) write_series_value(w, value);
    w.EndArray();
  }
  w.EndObject();
  w.Key("runs");
  w.StartArray();
  for (const auto& run : data.runs) {
    w.StartObject();
    w.Key("event_time_ms"); w.Uint64(run.event_time_ms);
    write_string(w, "query_id", run.query_id);
    write_string(w, "user", run.user);
    write_string(w, "type", run.type);
    w.Key("duration_ms"); w.Uint64(run.duration_ms);
    w.Key("read_rows"); w.Uint64(run.read_rows);
    w.Key("read_bytes"); w.Uint64(run.read_bytes);
    w.Key("result_rows"); w.Uint64(run.result_rows);
    w.Key("written_rows"); w.Uint64(run.written_rows);
    w.Key("memory_usage"); w.Uint64(run.memory_usage);
    w.Key("cpu_us"); w.Uint64(run.cpu_us);
    w.Key("exception_code"); w.Int64(run.exception_code);
    write_string(w, "exception", run.exception);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

} // namespace chdash
