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

// Explorer Monitoring endpoints (docs/explorer.md "Monitoring"). Fixed,
// allowlisted, bounded system-table reads built in explorer_monitor.cpp; the
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

// Live state, as the operations view: never older than the Explorer cache
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

} // namespace

// What a host exposes (its optional system logs and versioned columns),
// detected once and cached 10 minutes. Until a detection succeeds (retried
// after a short back-off) the panels read their base columns and let
// ClickHouse answer.
std::shared_ptr<const MonitorCapabilities> Server::explorer_monitor_capabilities(const std::string& host_id, const std::string& system_uri) {
  const std::string caps_key = host_id + std::string("\0monitor-caps", 13);
  auto caps = explorer_monitor_caps_cache_.get_or_refresh(
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
          code = "explorer_monitor_detection_failed";
          message = error.empty() ? "The server's system tables could not be listed." : error;
          return false;
        }
        return true;
      });
  if (caps.has_value && caps.value) return caps.value;
  return std::make_shared<const MonitorCapabilities>();
}

void Server::handle_explorer_monitor_overview(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }
  const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  const uint64_t now = monitor_api_now_ms();

  const auto caps = explorer_monitor_capabilities(host_id, system_uri);
  const MonitorCapabilities& capabilities = *caps;

  const std::string key = host_id + std::string("\0monitor-overview", 17);
  if (req.has_param("refresh") && req.get_param_value("refresh") == "1") explorer_monitor_overview_cache_.erase(key);
  auto result = explorer_monitor_overview_cache_.get_or_refresh(
      key, now, monitor_live_ttl_ms(cfg_.explorer.cache_ttl_ms), 250,
      [&](ExplorerMonitorOverview& value, std::string& code, std::string& message) {
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
          if (!load_explorer_monitor_overview(*system, *runner, capabilities, value, &error)) {
            code = "explorer_monitor_failed";
            message = error.empty() ? "The server overview is unavailable." : error;
            return false;
          }
          return true;
        } catch (const std::exception& e) {
          code = "explorer_monitor_failed";
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
        result.error_code.empty() ? "explorer_monitor_unavailable" : result.error_code,
        result.error_message.empty() ? "The server overview is unavailable." : result.error_message);
  }

  const ExplorerMonitorOverview& overview = *result.value;
  rapidjson::StringBuffer sb(nullptr, 8 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  w.Key("generated_at_ms"); w.Uint64(overview.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  // Every figure is this server's own (system tables are per node); the
  // clusterAllReplicas view is opt-in (explorer.monitoring.cluster_fanout).
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
void Server::handle_explorer_monitor_series(const httplib::Request& req, httplib::Response& res) {
  static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "panel", "scope", "refresh"};
  for (const auto& [name, value] : req.params) {
    (void)value;
    if (!kParams.count(name)) return json_error(res, 400, "unknown_parameter", "Unknown parameter: " + name + ".");
  }
  const auto param = [&](const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; };
  const std::string host_id = param("host_id");
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const std::string panel = req.has_param("panel") ? param("panel") : std::string("performance");
  if (panel != "performance") return json_error(res, 400, "invalid_panel", "panel must be performance.");
  // Cluster fan-out (clusterAllReplicas) is opt-in: explorer.monitoring.cluster_fanout.
  const std::string scope = req.has_param("scope") ? param("scope") : std::string("server");
  if (scope == "cluster") {
    if (!cfg_.explorer.monitoring_cluster_fanout) {
      return json_error(res, 400, "cluster_fanout_disabled", "The cluster view is off (explorer.monitoring.cluster_fanout).");
    }
    return json_error(res, 501, "cluster_scope_unsupported", "The Performance section reads this server only.");
  }
  if (scope != "server") return json_error(res, 400, "invalid_scope", "scope must be server or cluster.");

  // The window: the default lookback when absent, at most max_lookback_days.
  const uint64_t now_ms = monitor_api_now_ms();
  const uint64_t max_span_ms = static_cast<uint64_t>(cfg_.explorer.monitoring_max_lookback_days) * 86'400'000ULL;
  uint64_t to_ms = now_ms;
  uint64_t from_ms = 0;
  if (req.has_param("to_ms") && !parse_ms(param("to_ms"), to_ms)) {
    return json_error(res, 400, "invalid_range", "to_ms must be a whole number of milliseconds.");
  }
  if (req.has_param("from_ms")) {
    if (!parse_ms(param("from_ms"), from_ms)) return json_error(res, 400, "invalid_range", "from_ms must be a whole number of milliseconds.");
  } else {
    const uint64_t lookback = static_cast<uint64_t>(cfg_.explorer.monitoring_default_lookback_minutes) * 60'000ULL;
    from_ms = to_ms > lookback ? to_ms - lookback : 0;
  }
  // A window ending in the future ends now.
  to_ms = std::min(to_ms, now_ms);
  if (from_ms >= to_ms) return json_error(res, 400, "invalid_range", "from_ms must be before to_ms (and before now).");
  if (to_ms - from_ms > max_span_ms) {
    return json_error(res, 400, "range_too_large",
                      "The window is wider than " + std::to_string(cfg_.explorer.monitoring_max_lookback_days) +
                          " days (explorer.monitoring.max_lookback_days).");
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
  window.query_log_max_span_s = static_cast<uint64_t>(cfg_.explorer.monitoring_query_log_max_lookback_hours) * 3600ULL;
  window.query_log_max_rows = cfg_.explorer.monitoring_query_log_max_rows;

  const auto caps = explorer_monitor_capabilities(host_id, system_uri);
  const std::string key = host_id + std::string("\0monitor-series\0", 16) + panel + "|" + std::to_string(window.from_s) + "-" +
                          std::to_string(window.to_s) + "/" + std::to_string(window.step_s) +
                          (window.span_s > window.query_log_max_span_s ? "/no-query-log" : "");
  if (param("refresh") == "1") explorer_monitor_series_cache_.erase(key);
  // Relative windows move with the clock: past this many windows the map is
  // emptied rather than kept for windows nobody asks for again.
  if (explorer_monitor_series_cache_.size() > kMonitorSeriesCacheEntries) explorer_monitor_series_cache_.clear();
  auto result = explorer_monitor_series_cache_.get_or_refresh(
      key, now_ms, kMonitorSeriesTtlMs, 250,
      [&](ExplorerMonitorSeries& value, std::string& code, std::string& message) {
        std::string error;
        auto system = acquire_monitor_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        load_explorer_monitor_series(*system, *caps, window, value);
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
        result.error_code.empty() ? "explorer_monitor_unavailable" : result.error_code,
        result.error_message.empty() ? "The performance history is unavailable." : result.error_message);
  }

  const ExplorerMonitorSeries& series = *result.value;
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
  w.Key("max_lookback_days"); w.Int(cfg_.explorer.monitoring_max_lookback_days);
  w.Key("query_log_max_lookback_hours"); w.Int(cfg_.explorer.monitoring_query_log_max_lookback_hours);
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

} // namespace chdash
