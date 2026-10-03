#include "explorer_monitor.hpp"

#include "allowed_objects.hpp"
#include "ch_block_value.hpp"

#include <clickhouse/exceptions.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string_view>
#include <unordered_map>
#include <utility>

namespace chdash {
namespace {

uint64_t monitor_now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

std::string text(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_text_at(block, column, row);
}

uint64_t u64(const std::string& value) {
  if (value.empty()) return 0;
  try {
    size_t pos = 0;
    const unsigned long long parsed = std::stoull(value, &pos, 10);
    return pos == value.size() ? static_cast<uint64_t>(parsed) : 0;
  } catch (...) {
    return 0;
  }
}

std::optional<double> finite(const std::string& value) {
  if (value.empty()) return std::nullopt;
  try {
    size_t pos = 0;
    const double parsed = std::stod(value, &pos);
    if (pos != value.size() || !std::isfinite(parsed)) return std::nullopt;
    return parsed;
  } catch (...) {
    return std::nullopt;
  }
}

bool flag(const std::string& value) {
  return value == "1" || value == "true";
}

std::string quote_string(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('\'');
  for (const char ch : value) {
    if (ch == '\\') out += "\\\\";
    else if (ch == '\'') out += "\\'";
    else out.push_back(ch);
  }
  out.push_back('\'');
  return out;
}

std::string in_list(const std::vector<std::string>& names) {
  std::string sql = "(";
  for (size_t index = 0; index < names.size(); ++index) {
    if (index) sql += ", ";
    sql += quote_string(names[index]);
  }
  return sql + ")";
}

// Columns of system tables that changed across ClickHouse versions, read only
// when detected. Later sections add their tables here (metric_log, disks).
const std::map<std::string, std::vector<std::string>>& detected_columns() {
  static const std::map<std::string, std::vector<std::string>> columns{
    {"clusters", {"errors_count", "slowdowns_count", "estimated_recovery_time"}},
  };
  return columns;
}

// The runner's SHOW boundary for the replication summary, resolved lazily per
// database (the RunnerVisibility of explorer_ops.cpp).
class VisibleTables {
public:
  explicit VisibleTables(clickhouse::Client& runner) : runner_(runner), databases_(discover_visible_databases(runner)) {
    std::sort(databases_.begin(), databases_.end());
  }

  const std::vector<std::string>& databases() const { return databases_; }

  bool visible(const std::string& database, const std::string& table) {
    if (!std::binary_search(databases_.begin(), databases_.end(), database)) return false;
    auto it = objects_.find(database);
    if (it == objects_.end()) {
      auto objects = discover_visible_objects(runner_, database);
      std::sort(objects.begin(), objects.end());
      it = objects_.emplace(database, std::move(objects)).first;
    }
    return std::binary_search(it->second.begin(), it->second.end(), table);
  }

private:
  clickhouse::Client& runner_;
  std::vector<std::string> databases_;
  std::unordered_map<std::string, std::vector<std::string>> objects_;
};

void add_issue(ExplorerMonitorOverview& out, const MonitorCapabilities& caps, const std::string& panel,
               const std::string& table, const std::exception& error) {
  MonitorPanelIssue issue;
  issue.panel = panel;
  issue.table = table;
  issue.reason = monitor_reason_of(error);
  issue.message = error.what();
  if (issue.reason == "not_granted") issue.hint = monitor_grant_hint(table, caps.system_user);
  out.unavailable_panels.push_back(std::move(issue));
}

} // namespace

const std::vector<std::string>& monitor_overview_async_metrics() {
  static const std::vector<std::string> names{
    "Uptime", "OSMemoryTotal", "CGroupMemoryTotal", "MemoryResident", "LoadAverage1", "LoadAverage15",
    "OSUserTimeNormalized", "OSSystemTimeNormalized", "TotalPartsOfMergeTreeTables", "MaxPartCountForPartition",
    "TotalBytesOfMergeTreeTables", "ReplicasMaxAbsoluteDelay", "ReplicasSumQueueSize",
    "KeeperIsLeader", "KeeperIsFollower", "KeeperIsObserver", "KeeperIsStandalone", "KeeperZnodeCount",
    "KeeperAvgLatency", "KeeperMaxLatency", "KeeperFollowers", "KeeperSyncedFollowers",
  };
  return names;
}

const std::vector<std::string>& monitor_overview_metrics() {
  static const std::vector<std::string> names{
    "Query", "Merge", "PartMutation", "TCPConnection", "HTTPConnection", "MySQLConnection", "PostgreSQLConnection",
    "InterserverConnection", "ReadonlyReplica", "DelayedInserts", "ZooKeeperSession",
    "BackgroundMergesAndMutationsPoolTask", "BackgroundMergesAndMutationsPoolSize",
  };
  return names;
}

const std::vector<std::string>& monitor_detected_tables() {
  static const std::vector<std::string> names{
    "query_log", "metric_log", "asynchronous_metric_log", "part_log", "zookeeper_connection",
  };
  return names;
}

std::string monitor_settings_sql(int max_execution_time_seconds, uint64_t max_rows_to_read, uint64_t max_result_rows) {
  return " SETTINGS readonly = 2, max_execution_time = " + std::to_string(std::max(1, max_execution_time_seconds)) +
      ", timeout_overflow_mode = 'throw', max_rows_to_read = " + std::to_string(max_rows_to_read) +
      ", read_overflow_mode = 'throw', max_result_rows = " + std::to_string(max_result_rows) +
      ", result_overflow_mode = 'throw', log_comment = 'chdash-monitoring'";
}

std::string monitor_reason_of(const std::exception& error) {
  const auto* server = dynamic_cast<const clickhouse::ServerException*>(&error);
  if (!server) return "failed";
  switch (server->GetCode()) {
    case 60:   // UNKNOWN_TABLE
    case 81:   // UNKNOWN_DATABASE
      return "disabled";
    case 497:  // ACCESS_DENIED
      return "not_granted";
    case 16:   // NO_SUCH_COLUMN_IN_TABLE
    case 47:   // UNKNOWN_IDENTIFIER
      return "unsupported";
    case 158:  // TOO_MANY_ROWS
    case 159:  // TIMEOUT_EXCEEDED
      return "window_too_large";
    case 164:  // READONLY
      return "readonly_account";
    default:
      return "failed";
  }
}

std::string monitor_grant_hint(const std::string& table, const std::string& user) {
  std::string name = user;
  const bool plain = !name.empty() && std::all_of(name.begin(), name.end(), [](char ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_';
  });
  if (name.empty()) {
    name = "<system user>";
  } else if (!plain) {
    std::string quoted = "`";
    for (const char ch : name) {
      if (ch == '`' || ch == '\\') quoted.push_back('\\');
      quoted.push_back(ch);
    }
    name = quoted + "`";
  }
  return "GRANT SELECT ON system." + table + " TO " + name;
}

bool detect_monitor_capabilities(clickhouse::Client& system, MonitorCapabilities& out, std::string* error) {
  out = MonitorCapabilities{};
  out.detected_at_ms = monitor_now_ms();
  try {
    system.Select("SELECT toString(currentUser())" + monitor_settings_sql(5, 10, 1), [&](const clickhouse::Block& block) {
      if (block.GetRowCount() > 0) out.system_user = text(block, 0, 0);
    });
    std::vector<std::string> tables = monitor_detected_tables();
    for (const auto& [table, columns] : detected_columns()) {
      (void)columns;
      tables.push_back(table);
    }
    system.Select(
        "SELECT toString(name) FROM system.tables WHERE database = 'system' AND name IN " + in_list(tables) +
            monitor_settings_sql(5, 1000000, 1000),
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) out.tables.insert(text(block, 0, row));
        });
    std::vector<std::string> column_tables;
    std::vector<std::string> column_names;
    for (const auto& [table, columns] : detected_columns()) {
      column_tables.push_back(table);
      column_names.insert(column_names.end(), columns.begin(), columns.end());
    }
    system.Select(
        "SELECT toString(`table`), toString(name) FROM system.columns WHERE database = 'system' AND `table` IN " +
            in_list(column_tables) + " AND name IN " + in_list(column_names) + monitor_settings_sql(5, 1000000, 10000),
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            const std::string table = text(block, 0, row);
            const std::string column = text(block, 1, row);
            const auto it = detected_columns().find(table);
            if (it == detected_columns().end()) continue;
            if (std::find(it->second.begin(), it->second.end(), column) == it->second.end()) continue;
            out.columns.insert(table + "." + column);
          }
        });
    out.detected = true;
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    // Unknown capabilities: the panels read their base columns.
    const std::string user = out.system_user;
    out = MonitorCapabilities{};
    out.detected_at_ms = monitor_now_ms();
    out.system_user = user;
    return false;
  }
}

bool load_explorer_monitor_overview(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const MonitorCapabilities& caps,
    ExplorerMonitorOverview& out,
    std::string* error) {
  out = ExplorerMonitorOverview{};
  out.generated_at_ms = monitor_now_ms();
  if (caps.detected) {
    for (const auto& table : monitor_detected_tables()) out.logs[table] = caps.tables.count(table) > 0;
  }
  size_t failed = 0;

  // Server identity: hostName() is the name the server reports for itself
  // (the container or host name, not system.clusters.host_name).
  try {
    system.Select("SELECT toString(hostName()), toString(version()), toString(timezone()), toString(uptime())" +
                      monitor_settings_sql(5, 10, 1),
                  [&](const clickhouse::Block& block) {
                    if (block.GetRowCount() == 0) return;
                    out.hostname = text(block, 0, 0);
                    out.version = text(block, 1, 0);
                    out.timezone = text(block, 2, 0);
                    out.uptime_seconds = u64(text(block, 3, 0));
                  });
  } catch (const std::exception& e) {
    add_issue(out, caps, "server", "one", e);
    ++failed;
  }

  // Server tiles: allowlisted current values. A metric this server version
  // does not have is simply absent (the tile shows the empty value).
  try {
    system.Select("SELECT toString(metric), toString(value) FROM system.asynchronous_metrics WHERE metric IN " +
                      in_list(monitor_overview_async_metrics()) + monitor_settings_sql(5, 100000, 1000),
                  [&](const clickhouse::Block& block) {
                    for (size_t row = 0; row < block.GetRowCount(); ++row) {
                      if (const auto value = finite(text(block, 1, row))) out.metrics[text(block, 0, row)] = *value;
                    }
                  });
  } catch (const std::exception& e) {
    add_issue(out, caps, "server", "asynchronous_metrics", e);
    ++failed;
  }
  try {
    system.Select("SELECT toString(metric), toString(value) FROM system.metrics WHERE metric IN " +
                      in_list(monitor_overview_metrics()) + monitor_settings_sql(5, 100000, 1000),
                  [&](const clickhouse::Block& block) {
                    for (size_t row = 0; row < block.GetRowCount(); ++row) {
                      if (const auto value = finite(text(block, 1, row))) out.metrics[text(block, 0, row)] = *value;
                    }
                  });
  } catch (const std::exception& e) {
    add_issue(out, caps, "server", "metrics", e);
    ++failed;
  }

  // Topology: the local system.clusters, never a fan-out.
  {
    const bool with_errors = caps.has_column("clusters", "errors_count");
    const bool with_slowdowns = caps.has_column("clusters", "slowdowns_count");
    const bool with_recovery = caps.has_column("clusters", "estimated_recovery_time");
    std::string sql =
        "SELECT toString(cluster), toString(shard_num), toString(shard_weight), toString(replica_num), "
        "toString(host_name), toString(host_address), toString(port), toString(is_local)";
    sql += with_errors ? ", toString(errors_count)" : ", ''";
    sql += with_slowdowns ? ", toString(slowdowns_count)" : ", ''";
    sql += with_recovery ? ", toString(estimated_recovery_time)" : ", ''";
    sql += " FROM system.clusters ORDER BY cluster, shard_num, replica_num LIMIT " +
           std::to_string(kMonitorTopologyRowLimit + 1) + monitor_settings_sql(5, 100000, kMonitorTopologyRowLimit + 1);
    try {
      system.Select(sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          if (out.topology.size() >= kMonitorTopologyRowLimit) {
            out.topology_truncated = true;
            continue;
          }
          MonitorClusterNode node;
          node.cluster = text(block, 0, row);
          node.shard_num = u64(text(block, 1, row));
          node.shard_weight = u64(text(block, 2, row));
          node.replica_num = u64(text(block, 3, row));
          node.host_name = text(block, 4, row);
          node.host_address = text(block, 5, row);
          node.port = u64(text(block, 6, row));
          node.is_local = flag(text(block, 7, row));
          if (with_errors) node.errors_count = u64(text(block, 8, row));
          if (with_slowdowns) node.slowdowns_count = u64(text(block, 9, row));
          if (with_recovery) node.estimated_recovery_time = u64(text(block, 10, row));
          out.topology.push_back(std::move(node));
        }
      });
    } catch (const std::exception& e) {
      out.topology.clear();
      out.topology_truncated = false;
      add_issue(out, caps, "topology", "clusters", e);
      ++failed;
    }
  }

  // Replication summary: the in-memory columns of system.replicas only
  // (log_max_index, log_pointer, total_replicas and active_replicas cost one
  // Keeper request per table). Rows of databases the runner cannot SHOW are
  // excluded inside ClickHouse; each row then passes the runner's table-level
  // SHOW boundary before it is counted, so a hidden table changes no figure.
  try {
    VisibleTables visibility(runner);
    MonitorReplicationSummary summary;
    if (!visibility.databases().empty()) {
      const std::string sql =
          "SELECT toString(database), toString(`table`), toString(is_readonly), toString(is_session_expired), "
          "toString(absolute_delay), toString(queue_size), toString(inserts_in_queue), toString(merges_in_queue), "
          "toString(future_parts), toString(parts_to_check) FROM system.replicas WHERE database IN " +
          in_list(visibility.databases()) + " LIMIT " + std::to_string(kMonitorReplicaRowLimit + 1) +
          monitor_settings_sql(5, 100000, kMonitorReplicaRowLimit + 1);
      size_t seen = 0;
      system.Select(sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          if (++seen > kMonitorReplicaRowLimit) {
            summary.truncated = true;
            continue;
          }
          if (!visibility.visible(text(block, 0, row), text(block, 1, row))) continue;
          const uint64_t delay = u64(text(block, 4, row));
          const uint64_t queue = u64(text(block, 5, row));
          const uint64_t inserts = u64(text(block, 6, row));
          summary.tables += 1;
          summary.readonly += flag(text(block, 2, row)) ? 1 : 0;
          summary.session_expired += flag(text(block, 3, row)) ? 1 : 0;
          summary.max_delay_seconds = std::max(summary.max_delay_seconds, delay);
          summary.queue_size += queue;
          summary.inserts_in_queue += inserts;
          summary.merges_in_queue += u64(text(block, 7, row));
          summary.future_parts_over += u64(text(block, 8, row)) > 20 ? 1 : 0;
          summary.parts_to_check_over += u64(text(block, 9, row)) > 10 ? 1 : 0;
          summary.queue_over += queue > 20 ? 1 : 0;
          summary.inserts_over += inserts > 10 ? 1 : 0;
        }
      });
    }
    out.replication = summary;
  } catch (const std::exception& e) {
    add_issue(out, caps, "replication", "replicas", e);
    ++failed;
  }

  if (failed == 5) {
    if (error) *error = out.unavailable_panels.empty() ? "No Monitoring panel is readable." : out.unavailable_panels.back().message;
    return false;
  }
  return true;
}

} // namespace chdash
