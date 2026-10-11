#include "system_service.hpp"

#include "acl_service.hpp"
#include "ch_uri.hpp"

#include <algorithm>
#include <memory>

namespace chdash {
namespace system_page {

namespace {

// The answer of a cache: the value, or the error of the route (503 with the code and the message of the read that failed, or the default).
template <typename T>
Result<Cached<T>> finished(const typename TtlCache<std::string, T>::Result& result, const char* default_code, const char* default_message) {
  using Out = Result<Cached<T>>;
  if (!result.has_value || !result.value) {
    return Out::fail(make_error(503, result.error_code.empty() ? default_code : result.error_code,
                                result.error_message.empty() ? default_message : result.error_message));
  }
  Cached<T> cached;
  cached.value = result.value;
  cached.stale = result.stale;
  return Out::ok(std::move(cached));
}

std::string runner_user_of(const HostSpec& host) {
  const auto parsed = parse_clickhouse_uri(host.runner_uri, nullptr);
  return parsed ? parsed->user : std::string();
}

// A connection could not be had: the code and the message of the read.
bool no_connection(const std::unique_ptr<ChExecutor>& db, const std::string& error, const char* code, const char* fallback, std::string& out_code,
                   std::string& out_message) {
  if (db) return false;
  out_code = code;
  out_message = error.empty() ? fallback : error;
  return true;
}

// A source that failed outside ClickHouse (a broken connection) leaves the connection in an unknown state.
template <typename Value>
bool any_source_failed(const Value& value) {
  for (const auto& entry : value.sources) {
    if (entry.second.status == "failed") return true;
  }
  return false;
}

}  // namespace

std::shared_ptr<const MonitorCapabilities> SystemService::capabilities(const HostSpec& host) const {
  const std::string key = host.id + std::string("\0monitor-caps", 13);
  auto caps = caches_.capabilities.get(key, [&](MonitorCapabilities& value, std::string& code, std::string& message) {
    std::string error;
    auto db = ports_.system(host, &error);
    if (no_connection(db, error, "system_context_unavailable", "Cannot connect to the system context.", code, message)) return false;
    if (!detect_monitor_capabilities(*db, value, &error)) {
      code = "system_monitor_detection_failed";
      message = error.empty() ? "The server's system tables could not be listed." : error;
      return false;
    }
    return true;
  });
  if (caps.has_value && caps.value) return caps.value;
  return std::make_shared<const MonitorCapabilities>();
}

Result<Cached<SystemMonitorOverview>> SystemService::overview(const RequestContext&, const HostSpec& host, const HostRequest& request) const {
  const auto caps = capabilities(host);
  const std::string key = request.host_id + std::string("\0monitor-overview", 17);
  const AclAccess access = ports_.runner_access(host);
  if (request.refresh) acl_.invalidate(access);
  // Served at once past its TTL while one refresh runs: the fetch owns what it uses.
  auto result = caches_.overview.get_revalidating(
      key,
      [this, access, host, caps](SystemMonitorOverview& value, std::string& code, std::string& message) {
        std::string error;
        auto db = ports_.system(host, &error);
        if (no_connection(db, error, "system_context_unavailable", "Cannot connect to the system context.", code, message)) return false;
        try {
          AclView acl(acl_, access);
          if (!load_system_monitor_overview(*db, acl, *caps, value, &error)) {
            code = "system_monitor_failed";
            message = error.empty() ? "The server overview is unavailable." : error;
            return false;
          }
          return true;
        } catch (const std::exception& e) {
          code = "system_monitor_failed";
          message = e.what();
          db->invalidate();
          return false;
        }
      },
      request.refresh);
  return finished<SystemMonitorOverview>(result, "system_monitor_unavailable", "The server overview is unavailable.");
}

Result<Cached<SystemMonitorSeries>> SystemService::series(const RequestContext&, const HostSpec& host, const SeriesRequest& request) const {
  const MonitorSeriesWindow& window = request.window;
  const auto caps = capabilities(host);
  const std::string key = request.host_id + std::string("\0monitor-series\0", 16) + "performance" + "|" + std::to_string(window.from_s) + "-" +
                          std::to_string(window.to_s) + "/" + std::to_string(window.step_s) +
                          (window.span_s > window.query_log_max_span_s ? "/no-query-log" : "");
  // Relative windows move with the clock: a window nobody asks for again leaves the cache with its age or the LRU.
  auto result = caches_.series.get(
      key,
      [&](SystemMonitorSeries& value, std::string& code, std::string& message) {
        std::string error;
        auto db = ports_.system(host, &error);
        if (no_connection(db, error, "system_context_unavailable", "Cannot connect to the system context.", code, message)) return false;
        load_system_monitor_series(*db, *caps, window, value);
        if (any_source_failed(value)) db->invalidate();
        return true;
      },
      request.refresh);
  return finished<SystemMonitorSeries>(result, "system_monitor_unavailable", "The performance history is unavailable.");
}

// Disk growth (/series?panel=disk_growth): each disk's used bytes over the window, its trend and days until full, the MergeTree tables' bytes, and
// what the runner-visible databases wrote and moved. The window was validated with the request; 5 minutes for each aligned window.
Result<Cached<SystemMonitorDiskGrowth>> SystemService::disk_growth(const RequestContext&, const HostSpec& host, const SeriesRequest& request) const {
  const MonitorSeriesWindow& window = request.window;
  const auto caps = capabilities(host);
  const std::string key = request.host_id + std::string("\0monitor-growth\0", 16) + std::to_string(window.from_s) + "-" + std::to_string(window.to_s) +
                          "/" + std::to_string(window.step_s);
  const AclAccess access = ports_.runner_access(host);
  if (request.refresh) acl_.invalidate(access);
  auto result = caches_.growth.get(
      key,
      [&](SystemMonitorDiskGrowth& value, std::string& code, std::string& message) {
        std::string error;
        auto db = ports_.system(host, &error);
        if (no_connection(db, error, "system_context_unavailable", "Cannot connect to the system context.", code, message)) return false;
        AclView acl(acl_, access);
        load_system_monitor_disk_growth(*db, acl, *caps, window, value);
        if (any_source_failed(value)) db->invalidate();
        return true;
      },
      request.refresh);
  return finished<SystemMonitorDiskGrowth>(result, "system_monitor_unavailable", "The disk growth is unavailable.");
}

Result<Cached<SystemMonitorDisks>> SystemService::disks(const RequestContext&, const HostSpec& host, const HostRequest& request) const {
  const auto caps = capabilities(host);
  const std::string key = request.host_id + std::string("\0monitor-disks", 14);
  const AclAccess access = ports_.runner_access(host);
  if (request.refresh) acl_.invalidate(access);
  auto result = caches_.disks.get(
      key,
      [&](SystemMonitorDisks& value, std::string& code, std::string& message) {
        std::string error;
        auto db = ports_.system(host, &error);
        if (no_connection(db, error, "system_context_unavailable", "Cannot connect to the system context.", code, message)) return false;
        try {
          AclView acl(acl_, access);
          if (!load_system_monitor_disks(*db, acl, *caps, value, &error)) {
            code = "system_monitor_failed";
            message = error.empty() ? "The disks are unavailable." : error;
            return false;
          }
          return true;
        } catch (const std::exception& e) {
          code = "system_monitor_failed";
          message = e.what();
          db->invalidate();
          return false;
        }
      },
      request.refresh);
  return finished<SystemMonitorDisks>(result, "system_monitor_unavailable", "The disks are unavailable.");
}

// The top shapes of the window's queries by an allowlisted measure, read from system.query_log with the RUNNER account (ClickHouse grants
// decide; the Query page reads the same rows).
Result<Cached<SystemMonitorQueries>> SystemService::queries(const RequestContext&, const HostSpec& host, const QueriesRequest& request) const {
  const auto caps = capabilities(host);
  MonitorQueriesRequest query = request.query;
  query.system_user = caps->system_user;
  query.runner_user = runner_user_of(host);
  const std::string hide = query.hide_chdash ? "1" : "0";
  // Every filter is in the key; the user, the database and the table last, length-prefixed (any byte).
  const std::string key = request.host_id + std::string("\0monitor-queries\0", 17) + std::to_string(query.from_s) + "-" + std::to_string(query.to_s) +
                          "|" + query.sort + "|" + query.kind + "|" + query.errors + "|" + hide + "|" + std::to_string(query.user.size()) + ":" +
                          query.user + "|" + std::to_string(query.database.size()) + ":" + query.database + "|" +
                          std::to_string(query.table.size()) + ":" + query.table;
  // A second viewer of the same window waits for the read in flight rather than starting another (phase 1 may take its whole 15 s budget).
  const AclAccess access = ports_.runner_access(host);
  if (request.refresh) acl_.invalidate(access);
  auto result = caches_.queries.get(
      key,
      [&](SystemMonitorQueries& value, std::string& code, std::string& message) {
        std::string error;
        auto db = ports_.runner(host, &error);
        if (no_connection(db, error, "runner_unavailable", "Cannot connect to the runner context.", code, message)) return false;
        AclView acl(acl_, access);
        if (!load_system_monitor_queries(*db, acl, *caps, query, value, &error)) {
          db->invalidate();
          code = "system_monitor_failed";
          message = error.empty() ? "The top queries are unavailable." : error;
          return false;
        }
        return true;
      },
      request.refresh);
  return finished<SystemMonitorQueries>(result, "system_monitor_unavailable", "The top queries are unavailable.");
}

// One query shape: its timeline over the window and its 20 slowest, latest or largest runs, with the latest run's text. Runner account, as the list.
Result<Cached<SystemMonitorQuery>> SystemService::query(const RequestContext&, const HostSpec& host, const QueryRequest& request) const {
  const auto caps = capabilities(host);
  MonitorQueriesRequest query = request.query;
  query.system_user = caps->system_user;
  query.runner_user = runner_user_of(host);
  const std::string key = request.host_id + std::string("\0monitor-query\0", 15) + std::to_string(query.hash) + "|" + std::to_string(query.from_s) +
                          "-" + std::to_string(query.to_s) + "/" + std::to_string(query.step_s) + "|" + query.order + "|" +
                          (query.hide_chdash ? "1" : "0");
  auto result = caches_.query.get(
      key,
      [&](SystemMonitorQuery& value, std::string& code, std::string& message) {
        std::string error;
        auto db = ports_.runner(host, &error);
        if (no_connection(db, error, "runner_unavailable", "Cannot connect to the runner context.", code, message)) return false;
        if (!load_system_monitor_query(*db, *caps, query, value, &error)) {
          db->invalidate();
          code = "system_monitor_failed";
          message = error.empty() ? "The query's history is unavailable." : error;
          return false;
        }
        return true;
      },
      request.refresh);
  return finished<SystemMonitorQuery>(result, "system_monitor_unavailable", "The query's history is unavailable.");
}

// The Activity is live state: never older than the Explorer cache TTL, at most one read a second per host however many pages auto-refresh; past its
// TTL it is served at once while one refresh runs (the fetch owns what it uses).
Result<Cached<SystemActivity>> SystemService::activity(const RequestContext&, const HostSpec& host, const HostRequest& request) const {
  const std::string key = request.host_id + std::string("\0ops-activity", 13);
  const AclAccess access = ports_.runner_access(host);
  if (request.refresh) acl_.invalidate(access);
  auto result = caches_.activity.get_revalidating(
      key,
      [this, access, host](SystemActivity& value, std::string& code, std::string& message) {
        std::string error;
        auto db = ports_.system(host, &error);
        if (no_connection(db, error, "system_context_unavailable", "Cannot connect to the system context.", code, message)) return false;
        try {
          AclView acl(acl_, access);
          if (!load_system_activity(*db, ports_.replica_counts, acl, kSystemActivityRowLimit, value, &error)) {
            code = "system_activity_failed";
            message = error.empty() ? "The server activity is unavailable." : error;
            return false;
          }
          return true;
        } catch (const AclUnavailable& e) {
          code = e.code;
          message = e.what();
          return false;
        } catch (const std::exception& e) {
          code = "system_activity_failed";
          message = e.what();
          db->invalidate();
          return false;
        }
      },
      request.refresh);
  return finished<SystemActivity>(result, "system_activity_unavailable", "The server activity is unavailable.");
}

Result<Cached<SystemKeeperStatus>> SystemService::keeper(const RequestContext&, const HostSpec& host, const HostRequest& request) const {
  const std::string key = request.host_id + std::string("\0ops-keeper", 11);
  auto result = caches_.keeper.get_revalidating(
      key,
      [this, host](SystemKeeperStatus& value, std::string& code, std::string& message) {
        std::string error;
        auto db = ports_.system(host, &error);
        if (no_connection(db, error, "system_context_unavailable", "Cannot connect to the system context.", code, message)) return false;
        try {
          if (!load_system_keeper_status(*db, value, &error)) {
            code = "system_keeper_failed";
            message = error.empty() ? "Keeper status is unavailable." : error;
            return false;
          }
          return true;
        } catch (const std::exception& e) {
          code = "system_keeper_failed";
          message = e.what();
          db->invalidate();
          return false;
        }
      },
      request.refresh);
  return finished<SystemKeeperStatus>(result, "system_keeper_unavailable", "Keeper status is unavailable.");
}

}  // namespace system_page
}  // namespace chdash
