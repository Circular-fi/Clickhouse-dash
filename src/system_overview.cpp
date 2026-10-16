#include "system_overview.hpp"

#include "ch_executor.hpp"
#include "system_disks.hpp"
#include "system_monitor_internal.hpp"

#include <algorithm>

namespace chdash {

using namespace monitor_internal;

namespace {

void add_issue(SystemMonitorOverview& out, const MonitorCapabilities& caps, const std::string& panel,
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

bool load_system_monitor_overview(
    ChExecutor& system,
    AclView& runner_acl,
    const MonitorCapabilities& caps,
    SystemMonitorOverview& out,
    std::string* error) {
  out = SystemMonitorOverview{};
  out.generated_at_ms = monitor_now_ms();
  if (caps.detected) {
    for (const auto& table : monitor_detected_tables()) out.logs[table] = caps.tables.count(table) > 0;
  }
  size_t failed = 0;

  // Server identity: hostName() is the name the server reports for itself
  // (the container or host name, not system.clusters.host_name).
  try {
    system.select("SELECT toString(hostName()), toString(version()), toString(timezone()), toString(uptime())" +
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
    system.select("SELECT toString(metric), toString(value) FROM system.asynchronous_metrics WHERE metric IN " +
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
    system.select("SELECT toString(metric), toString(value) FROM system.metrics WHERE metric IN " +
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
      system.select(sql, [&](const clickhouse::Block& block) {
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

  // Replication summary: only the in-memory columns of system.replicas are read.
  // The columns log_max_index, log_pointer, total_replicas and active_replicas cost one
  // Keeper request for each table. Rows of databases that the runner cannot SHOW are
  // excluded inside ClickHouse. Then each row passes the runner's table-level
  // SHOW boundary before it is counted. So a hidden table changes no figure.
  try {
    VisibleTables visibility(runner_acl);
    MonitorReplicationSummary summary;
    if (!visibility.databases().empty()) {
      const std::string sql =
          "SELECT toString(database), toString(`table`), toString(is_readonly), toString(is_session_expired), "
          "toString(absolute_delay), toString(queue_size), toString(inserts_in_queue), toString(merges_in_queue), "
          "toString(future_parts), toString(parts_to_check) FROM system.replicas WHERE database IN (" + monitor_databases_list(visibility.databases()) + ") LIMIT " + std::to_string(kMonitorReplicaRowLimit + 1) +
          monitor_settings_sql(5, 100000, kMonitorReplicaRowLimit + 1);
      // Read first, then check the result against the runner's boundary. The boundary can ask ClickHouse as the runner. Never call it
      // inside the callback of another read.
      std::vector<std::vector<std::string>> rows;
      system.select(sql, monitor_databases_params(visibility.databases()), [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          if (rows.size() >= kMonitorReplicaRowLimit) {
            summary.truncated = true;
            continue;
          }
          std::vector<std::string> cells;
          cells.reserve(10);
          for (size_t column = 0; column < 10; ++column) cells.push_back(text(block, column, row));
          rows.push_back(std::move(cells));
        }
      });
      for (const auto& cells : rows) {
        if (!visibility.visible(cells[0], cells[1])) continue;
        const uint64_t delay = u64(cells[4]);
        const uint64_t queue = u64(cells[5]);
        const uint64_t inserts = u64(cells[6]);
        summary.tables += 1;
        summary.readonly += flag(cells[2]) ? 1 : 0;
        summary.session_expired += flag(cells[3]) ? 1 : 0;
        summary.max_delay_seconds = std::max(summary.max_delay_seconds, delay);
        summary.queue_size += queue;
        summary.inserts_in_queue += inserts;
        summary.merges_in_queue += u64(cells[7]);
        summary.future_parts_over += u64(cells[8]) > 20 ? 1 : 0;
        summary.parts_to_check_over += u64(cells[9]) > 10 ? 1 : 0;
        summary.queue_over += queue > 20 ? 1 : 0;
        summary.inserts_over += inserts > 10 ? 1 : 0;
      }
    }
    out.replication = summary;
  } catch (const std::exception& e) {
    add_issue(out, caps, "replication", "replicas", e);
    ++failed;
  }

  if (failed == 5) {
    if (error) *error = out.unavailable_panels.empty() ? "No System panel is readable." : out.unavailable_panels.back().message;
    return false;
  }
  return true;
}

} // namespace chdash
