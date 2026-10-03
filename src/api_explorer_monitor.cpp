#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
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

void write_optional(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::optional<uint64_t>& value) {
  w.Key(key);
  if (value) w.Uint64(*value);
  else w.Null();
}

} // namespace

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

  const std::string caps_key = host_id + std::string("\0monitor-caps", 13);
  auto caps = explorer_monitor_caps_cache_.get_or_refresh(
      caps_key, now, kMonitorCapabilitiesTtlMs, 250,
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
  // Until a detection succeeds (retried after a short back-off), the panels
  // read their base columns and let ClickHouse answer.
  const MonitorCapabilities unknown;
  const MonitorCapabilities& capabilities = caps.has_value && caps.value ? *caps.value : unknown;

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

} // namespace chdash
