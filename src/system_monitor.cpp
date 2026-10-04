#include "system_monitor.hpp"

#include "allowed_objects.hpp"
#include "ch_block_numeric.hpp"
#include "ch_block_value.hpp"
#include "facet_limits.hpp"

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

// One series of the metric_log pass: its name, the expression over a bucket
// ("{span}" is the seconds the bucket covers) and the columns it needs.
struct MetricLogSeries {
  const char* name;
  const char* expression;
  std::vector<const char*> columns;
};

// ProfileEvent_* columns are per-sample deltas: a rate is their sum over the
// seconds the bucket covers, whatever collect_interval_milliseconds is.
// CurrentMetric_* columns are gauges: avg, or max for a peak.
const std::vector<MetricLogSeries>& metric_log_series() {
  static const std::vector<MetricLogSeries> series{
    {"qps", "sum(ProfileEvent_Query) / {span}", {"ProfileEvent_Query"}},
    {"select_qps", "sum(ProfileEvent_SelectQuery) / {span}", {"ProfileEvent_SelectQuery"}},
    {"insert_qps", "sum(ProfileEvent_InsertQuery) / {span}", {"ProfileEvent_InsertQuery"}},
    {"failed_qps", "sum(ProfileEvent_FailedQuery) / {span}", {"ProfileEvent_FailedQuery"}},
    {"avg_query_ms", "sum(ProfileEvent_QueryTimeMicroseconds) / greatest(sum(ProfileEvent_Query), 1) / 1000",
     {"ProfileEvent_QueryTimeMicroseconds", "ProfileEvent_Query"}},
    {"cpu_cores", "sum(ProfileEvent_OSCPUVirtualTimeMicroseconds) / 1e6 / {span}", {"ProfileEvent_OSCPUVirtualTimeMicroseconds"}},
    {"io_wait_cores", "sum(ProfileEvent_OSIOWaitMicroseconds) / 1e6 / {span}", {"ProfileEvent_OSIOWaitMicroseconds"}},
    {"memory_tracked", "avg(CurrentMetric_MemoryTracking)", {"CurrentMetric_MemoryTracking"}},
    {"memory_tracked_max", "max(CurrentMetric_MemoryTracking)", {"CurrentMetric_MemoryTracking"}},
    {"memory_merges", "avg(CurrentMetric_MergesMutationsMemoryTracking)", {"CurrentMetric_MergesMutationsMemoryTracking"}},
    {"queries_running", "avg(CurrentMetric_Query)", {"CurrentMetric_Query"}},
    {"merges_running", "avg(CurrentMetric_Merge)", {"CurrentMetric_Merge"}},
    {"mutations_running", "avg(CurrentMetric_PartMutation)", {"CurrentMetric_PartMutation"}},
    {"merged_rows_s", "sum(ProfileEvent_MergedRows) / {span}", {"ProfileEvent_MergedRows"}},
    {"inserted_rows_s", "sum(ProfileEvent_InsertedRows) / {span}", {"ProfileEvent_InsertedRows"}},
    {"inserted_bytes_s", "sum(ProfileEvent_InsertedBytes) / {span}", {"ProfileEvent_InsertedBytes"}},
    {"delayed_inserts_s", "sum(ProfileEvent_DelayedInserts) / {span}", {"ProfileEvent_DelayedInserts"}},
    {"rejected_inserts_s", "sum(ProfileEvent_RejectedInserts) / {span}", {"ProfileEvent_RejectedInserts"}},
    {"selected_rows_s", "sum(ProfileEvent_SelectedRows) / {span}", {"ProfileEvent_SelectedRows"}},
    {"selected_bytes_s", "sum(ProfileEvent_SelectedBytes) / {span}", {"ProfileEvent_SelectedBytes"}},
    {"pool_merges_task", "avg(CurrentMetric_BackgroundMergesAndMutationsPoolTask)", {"CurrentMetric_BackgroundMergesAndMutationsPoolTask"}},
    {"pool_merges_size", "max(CurrentMetric_BackgroundMergesAndMutationsPoolSize)", {"CurrentMetric_BackgroundMergesAndMutationsPoolSize"}},
    {"pool_fetches_task", "avg(CurrentMetric_BackgroundFetchesPoolTask)", {"CurrentMetric_BackgroundFetchesPoolTask"}},
    {"pool_fetches_size", "max(CurrentMetric_BackgroundFetchesPoolSize)", {"CurrentMetric_BackgroundFetchesPoolSize"}},
    {"pool_moves_task", "avg(CurrentMetric_BackgroundMovePoolTask)", {"CurrentMetric_BackgroundMovePoolTask"}},
    {"pool_schedule_task", "avg(CurrentMetric_BackgroundSchedulePoolTask)", {"CurrentMetric_BackgroundSchedulePoolTask"}},
    {"pool_common_task", "avg(CurrentMetric_BackgroundCommonPoolTask)", {"CurrentMetric_BackgroundCommonPoolTask"}},
    {"parts_active", "avg(CurrentMetric_PartsActive)", {"CurrentMetric_PartsActive"}},
    {"parts_outdated", "avg(CurrentMetric_PartsOutdated)", {"CurrentMetric_PartsOutdated"}},
  };
  return series;
}

// A wide (or bucketed) metric_log has this column; the transposed layout
// (metric, value rows) has none and is treated as no metric_log in v1.
constexpr const char* kMetricLogWideMarker = "ProfileEvent_Query";

std::vector<std::string> metric_log_columns() {
  std::set<std::string> names;
  for (const auto& item : metric_log_series()) names.insert(item.columns.begin(), item.columns.end());
  return {names.begin(), names.end()};
}

// The optional columns of system.disks and system.storage_policies (the
// Disks section), in the order their SELECT reads them.
const std::vector<std::string>& disk_columns() {
  static const std::vector<std::string> names{
    "unreserved_space", "keep_free_space", "type", "object_storage_type", "cache_path",
    "is_read_only", "is_broken", "is_encrypted", "is_remote",
  };
  return names;
}

const std::vector<std::string>& storage_policy_columns() {
  static const std::vector<std::string> names{
    "volume_type", "max_data_part_size", "move_factor", "prefer_not_to_merge", "perform_ttl_move_on_insert", "load_balancing",
  };
  return names;
}

// Columns of system tables that changed across ClickHouse versions, read only
// when detected. asynchronous_metric_log.key is ClickHouse 26.8's: per-disk
// metrics become metric = 'DiskUsed', key = '<disk>'.
const std::map<std::string, std::vector<std::string>>& detected_columns() {
  static const std::map<std::string, std::vector<std::string>> columns{
    {"clusters", {"errors_count", "slowdowns_count", "estimated_recovery_time"}},
    {"metric_log", metric_log_columns()},
    {"disks", disk_columns()},
    {"storage_policies", storage_policy_columns()},
    {"asynchronous_metric_log", {"key"}},
  };
  return columns;
}

// asynchronous_metric_log names and the series they give. OSUserTime,
// OSSystemTime and OSIOWaitTime are summed over the cores (in cores, like
// metric_log's CPU); OSUserTimeNormalized only gives the core count.
const std::vector<std::pair<std::string, std::string>>& async_series() {
  static const std::vector<std::pair<std::string, std::string>> names{
    {"OSUserTime", "os_user_cores"},
    {"OSSystemTime", "os_system_cores"},
    {"OSIOWaitTime", "os_iowait_cores"},
    {"OSUserTimeNormalized", "os_user_ratio"},
    {"LoadAverage1", "load_1m"},
    {"MemoryResident", "memory_resident"},
    {"OSMemoryAvailable", "os_memory_available"},
    {"TotalPartsOfMergeTreeTables", "parts_total"},
    {"MaxPartCountForPartition", "parts_max_partition"},
    {"ReplicasMaxAbsoluteDelay", "replicas_max_delay"},
    {"ReplicasSumQueueSize", "replicas_queue"},
  };
  return names;
}

// Peaks rather than averages for these.
const std::vector<std::string>& async_max_metrics() {
  static const std::vector<std::string> names{"MaxPartCountForPartition", "LoadAverage1", "ReplicasMaxAbsoluteDelay"};
  return names;
}

const std::vector<std::string>& query_log_series() {
  static const std::vector<std::string> names{"finished_qps", "error_qps", "p50_ms", "p95_ms", "p99_ms"};
  return names;
}

// Time budget and read caps of the series SELECTs (proposal step 6, 3.2).
constexpr int kSeriesTimeBudgetSeconds = 10;
constexpr uint64_t kSeriesReadRowsCap = 50'000'000;

std::string replace_all(std::string text, const std::string& from, const std::string& to) {
  for (size_t pos = text.find(from); pos != std::string::npos; pos = text.find(from, pos + to.size())) {
    text.replace(pos, from.size(), to);
  }
  return text;
}

// The bucket key, the seconds it covers and the time predicate (the primary
// key of every *_log table: event_date, event_time). Every number here is an
// integer the handler validated.
std::string series_bucket_sql(const MonitorSeriesWindow& w) {
  const std::string step = std::to_string(w.step_s);
  // The bucket still in progress covers up to its last sample, not the whole step.
  return "toUInt64(toUnixTimestamp(toStartOfInterval(event_time, INTERVAL " + step + " SECOND))) AS t, "
         "toFloat64(if(t + " + step + " > " + std::to_string(w.now_s) + ", greatest(1, toUInt64(toUnixTimestamp(max(event_time))) + 1 - t), " +
         step + ")) AS bucket_span";
}

std::string series_time_predicate(const MonitorSeriesWindow& w) {
  const std::string from = "toDateTime(" + std::to_string(w.from_s) + ")";
  const std::string to = "toDateTime(" + std::to_string(w.to_s) + ")";
  return "event_date BETWEEN toDate(" + from + ") AND toDate(" + to + ") AND event_time >= " + from + " AND event_time < " + to;
}

uint64_t series_bucket_count(const MonitorSeriesWindow& w) {
  return w.step_s ? (w.to_s - w.from_s) / w.step_s : 0;
}

// The runner's SHOW boundary for the replication summary, resolved lazily per
// database (the RunnerVisibility of system_activity.cpp).
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
      ", result_overflow_mode = 'throw', log_comment = 'chdash-system'";
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
    // Whether any replicated table exists (a count, no name): the
    // Performance section's Replication chart shows only then. Not readable:
    // the chart stays hidden, the rest is detected.
    try {
      system.Select("SELECT toString(count() > 0) FROM system.replicas" + monitor_settings_sql(5, 1000000, 1),
                    [&](const clickhouse::Block& block) {
                      if (block.GetRowCount() > 0) out.replicated_tables = flag(text(block, 0, 0));
                    });
    } catch (const clickhouse::ServerException&) {
      out.replicated_tables = false;
    }
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

bool load_system_monitor_overview(
    clickhouse::Client& system,
    clickhouse::Client& runner,
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
    if (error) *error = out.unavailable_panels.empty() ? "No System panel is readable." : out.unavailable_panels.back().message;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Performance series

const std::vector<uint32_t>& monitor_series_steps() {
  static const std::vector<uint32_t> steps{10, 30, 60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 86400};
  return steps;
}

uint32_t monitor_series_step_seconds(uint64_t span_seconds) {
  const auto& steps = monitor_series_steps();
  for (const uint32_t step : steps) {
    if ((span_seconds + step - 1) / step <= kMonitorSeriesMaxPoints) return step;
  }
  return steps.back();
}

std::vector<std::string> monitor_series_metric_log_names() {
  std::vector<std::string> names;
  for (const auto& item : metric_log_series()) names.emplace_back(item.name);
  return names;
}

const std::vector<std::string>& monitor_series_async_metrics() {
  static const std::vector<std::string> names = [] {
    std::vector<std::string> out;
    for (const auto& item : async_series()) out.push_back(item.first);
    return out;
  }();
  return names;
}

std::vector<std::string> monitor_series_query_log_names() {
  return query_log_series();
}

std::string monitor_series_metric_log_sql(const MonitorCapabilities& caps, const MonitorSeriesWindow& window,
                                          std::vector<std::string>* names, std::vector<std::string>* missing) {
  std::string sql = "SELECT " + series_bucket_sql(window);
  for (const auto& item : metric_log_series()) {
    // The column list is intersected with the detected columns (all of them
    // when the detection failed: ClickHouse then answers).
    const bool present = !caps.detected || std::all_of(item.columns.begin(), item.columns.end(), [&](const char* column) {
      return caps.has_column("metric_log", column);
    });
    if (!present) {
      if (missing) missing->emplace_back(item.name);
      continue;
    }
    if (names) names->emplace_back(item.name);
    sql += ", toFloat64(" + replace_all(item.expression, "{span}", "bucket_span") + ") AS " + item.name;
  }
  const uint64_t rows = series_bucket_count(window) + 2;
  return sql + " FROM system.metric_log WHERE " + series_time_predicate(window) + " GROUP BY t ORDER BY t" +
         monitor_settings_sql(kSeriesTimeBudgetSeconds, kSeriesReadRowsCap, rows);
}

std::string monitor_series_async_sql(const MonitorSeriesWindow& window) {
  const uint64_t rows = (series_bucket_count(window) + 2) * async_series().size();
  // metric IN (...) first: the table's key is (metric, event_date, event_time).
  return "SELECT toUInt64(toUnixTimestamp(toStartOfInterval(event_time, INTERVAL " + std::to_string(window.step_s) +
         " SECOND))) AS t, toString(metric) AS name, toFloat64(if(metric IN " + in_list(async_max_metrics()) +
         ", max(value), avg(value))) AS v FROM system.asynchronous_metric_log WHERE metric IN " +
         in_list(monitor_series_async_metrics()) + " AND " + series_time_predicate(window) +
         " GROUP BY t, metric ORDER BY t" + monitor_settings_sql(kSeriesTimeBudgetSeconds, kSeriesReadRowsCap, rows);
}

std::string monitor_series_query_log_sql(const MonitorSeriesWindow& window) {
  const uint64_t rows = series_bucket_count(window) + 2;
  // Narrow columns only: the key, type, is_initial_query and the duration.
  return "SELECT " + series_bucket_sql(window) +
         ", toFloat64(count() / bucket_span) AS finished_qps, toFloat64(countIf(type != 'QueryFinish') / bucket_span) AS error_qps"
         ", quantilesTDigest(0.5, 0.95, 0.99)(query_duration_ms) AS latency_ms"
         ", toFloat64(latency_ms[1]) AS p50_ms, toFloat64(latency_ms[2]) AS p95_ms, toFloat64(latency_ms[3]) AS p99_ms"
         " FROM system.query_log WHERE " + series_time_predicate(window) +
         " AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart') AND is_initial_query"
         " GROUP BY t ORDER BY t" + monitor_settings_sql(kSeriesTimeBudgetSeconds, window.query_log_max_rows, rows);
}

namespace {

double f64_at(const clickhouse::Block& block, size_t column, size_t row) {
  if (column < block.GetColumnCount() && block[column]) {
    if (auto values = block[column]->As<clickhouse::ColumnFloat64>()) return values->At(row);
  }
  const auto value = finite(text(block, column, row));
  return value ? *value : std::nan("");
}

void source_failed(MonitorSeriesSource& source, const MonitorCapabilities& caps, const std::exception& error) {
  source.status = monitor_reason_of(error);
  source.message = error.what();
  if (source.status == "not_granted") source.hint = monitor_grant_hint(source.table, caps.system_user);
}

// Runs one series SELECT (bounded_select: its rows read and time are
// reported); each row's bucket lands at its index of out.buckets.
void read_series(clickhouse::Client& system, const std::string& sql, SystemMonitorSeries& out, MonitorSeriesSource& source,
                 const std::function<void(const clickhouse::Block&, size_t, size_t)>& on_row) {
  const uint64_t from = out.window.from_s;
  const uint64_t step = out.window.step_s;
  const size_t count = out.buckets.size();
  const BoundedRead read = bounded_select(system, sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const uint64_t t = ch_block_u64_at(block, 0, row);
      if (t < from || (t - from) % step != 0) continue;
      const size_t index = static_cast<size_t>((t - from) / step);
      if (index < count) on_row(block, row, index);
    }
  });
  source.rows_read = read.read_rows;
  source.elapsed_ms = read.elapsed_ms;
}

} // namespace

void load_system_monitor_series(
    clickhouse::Client& system,
    const MonitorCapabilities& caps,
    const MonitorSeriesWindow& window,
    SystemMonitorSeries& out) {
  out = SystemMonitorSeries{};
  out.generated_at_ms = monitor_now_ms();
  out.window = window;
  out.replicated_tables = caps.replicated_tables;
  const size_t count = static_cast<size_t>(series_bucket_count(window));
  out.buckets.reserve(count);
  for (size_t index = 0; index < count; ++index) out.buckets.push_back(window.from_s + index * window.step_s);
  const auto column = [&](const std::string& name) -> std::vector<double>& {
    auto& values = out.series[name];
    if (values.empty()) values.assign(count, std::nan(""));
    return values;
  };

  // 1. metric_log: one pass for the counters and gauges. The transposed
  // layout has no ProfileEvent_* column: v1 reads it as no metric_log.
  {
    MonitorSeriesSource& source = out.sources["metric_log"];
    source.table = "metric_log";
    if (!caps.has_table("metric_log")) {
      source.status = "disabled";
    } else if (caps.detected && !caps.has_column("metric_log", kMetricLogWideMarker)) {
      source.status = "unsupported";
      source.message = "system.metric_log uses the transposed layout (no ProfileEvent_* columns), which this version does not read.";
    } else {
      std::vector<std::string> names;
      const std::string sql = monitor_series_metric_log_sql(caps, window, &names, &source.missing);
      std::vector<std::vector<double>*> targets;
      for (const auto& name : names) targets.push_back(&column(name));
      try {
        read_series(system, sql, out, source, [&](const clickhouse::Block& block, size_t row, size_t index) {
          // Columns: t, bucket_span, then the series in order.
          for (size_t k = 0; k < targets.size(); ++k) (*targets[k])[index] = f64_at(block, k + 2, row);
        });
      } catch (const std::exception& e) {
        for (const auto& name : names) out.series.erase(name);
        source_failed(source, caps, e);
      }
    }
  }

  // 2. asynchronous_metric_log: OS CPU, resident memory, parts, replication.
  {
    MonitorSeriesSource& source = out.sources["asynchronous_metric_log"];
    source.table = "asynchronous_metric_log";
    if (!caps.has_table("asynchronous_metric_log")) {
      source.status = "disabled";
    } else {
      std::map<std::string, std::vector<double>*> targets;
      for (const auto& item : async_series()) targets[item.first] = &column(item.second);
      try {
        read_series(system, monitor_series_async_sql(window), out, source, [&](const clickhouse::Block& block, size_t row, size_t index) {
          const auto it = targets.find(text(block, 1, row));
          if (it != targets.end()) (*it->second)[index] = f64_at(block, 2, row);
        });
      } catch (const std::exception& e) {
        for (const auto& item : async_series()) out.series.erase(item.second);
        source_failed(source, caps, e);
      }
    }
  }

  // 3. query_log: latency percentiles and the error rate, narrow columns,
  // only while the window is within its lookback.
  {
    MonitorSeriesSource& source = out.sources["query_log"];
    source.table = "query_log";
    if (!caps.has_table("query_log")) {
      source.status = "disabled";
    } else if (window.span_s > window.query_log_max_span_s) {
      source.status = "out_of_range";
      source.message = "The window is wider than query_log's lookback (system.query_log_max_lookback_hours).";
    } else {
      std::vector<std::vector<double>*> targets;
      for (const auto& name : query_log_series()) targets.push_back(&column(name));
      try {
        read_series(system, monitor_series_query_log_sql(window), out, source, [&](const clickhouse::Block& block, size_t row, size_t index) {
          // Columns: t, bucket_span, finished_qps, error_qps, latency_ms (the
          // array), p50_ms, p95_ms, p99_ms.
          (*targets[0])[index] = f64_at(block, 2, row);
          (*targets[1])[index] = f64_at(block, 3, row);
          for (size_t k = 2; k < targets.size(); ++k) (*targets[k])[index] = f64_at(block, k + 3, row);
        });
      } catch (const std::exception& e) {
        for (const auto& name : query_log_series()) out.series.erase(name);
        source_failed(source, caps, e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Queries: top query shapes and one shape's drill-down, read from
// system.query_log with the runner account.

namespace {

// Time budgets (proposal step 6, 3.3): phase 1 groups the whole window.
constexpr int kQueriesAggregateSeconds = 15;
constexpr int kQueriesTextSeconds = 10;
constexpr int kQueriesDrillSeconds = 10;
// The window-too-large estimate reads the key columns of the last hour only.
constexpr int kQueriesEstimateSeconds = 5;
constexpr uint64_t kQueriesEstimateRowsCap = 10'000'000;
// Phase 1 keeps at most this many distinct shapes (memory bound); past it a
// new shape is not counted.
const char* const kQueriesGroupBySettings =
    ", max_rows_to_group_by = 1000000, group_by_overflow_mode = 'any', max_bytes_before_external_group_by = 0";

// Finished or failed initial queries: every query also logs a QueryStart
// row, and a distributed query's sub-queries are not counted twice.
const char* const kQueryLogRows =
    " AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart') AND is_initial_query";

// The ORDER BY of each allowlisted sort.
const std::vector<std::pair<std::string, std::string>>& queries_sort_expressions() {
  static const std::vector<std::pair<std::string, std::string>> sorts{
    {"total_time", "sum(query_duration_ms)"},
    {"calls", "count()"},
    {"p95", "quantileTDigest(0.95)(query_duration_ms)"},
    {"max_memory", "max(memory_usage)"},
    {"read_bytes", "sum(read_bytes)"},
    {"errors", "countIf(type != 'QueryFinish')"},
  };
  return sorts;
}

const std::vector<std::pair<std::string, std::string>>& query_run_order_expressions() {
  static const std::vector<std::pair<std::string, std::string>> orders{
    {"duration", "query_duration_ms"},
    {"latest", "event_time_microseconds"},
    {"memory", "memory_usage"},
  };
  return orders;
}

const std::string& expression_of(const std::vector<std::pair<std::string, std::string>>& table, const std::string& id) {
  for (const auto& [key, expression] : table) {
    if (key == id) return expression;
  }
  return table.front().second;
}

std::string queries_time_predicate(const MonitorQueriesRequest& r) {
  const std::string from = "toDateTime(" + std::to_string(r.from_s) + ")";
  const std::string to = "toDateTime(" + std::to_string(r.to_s) + ")";
  return "event_date BETWEEN toDate(" + from + ") AND toDate(" + to + ") AND event_time >= " + from + " AND event_time < " + to;
}

// The rows a shape counts: the window's finished or failed initial queries,
// never the System page's own reads; with hide_chdash not the system
// account's either; the kind when the list is filtered by one.
std::string queries_filter_sql(const MonitorQueriesRequest& r, bool with_kind) {
  std::string sql = queries_time_predicate(r) + kQueryLogRows + " AND log_comment != 'chdash-system'";
  if (r.hide_chdash && !r.system_user.empty()) sql += " AND user != " + quote_string(r.system_user);
  if (with_kind) {
    if (r.kind == "Select") sql += " AND query_kind = 'Select'";
    else if (r.kind == "Insert") sql += " AND query_kind = 'Insert'";
    else if (r.kind == "other") sql += " AND query_kind NOT IN ('Select', 'Insert')";
  }
  return sql;
}

std::vector<std::string> split_lines(const std::string& value) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= value.size() && !value.empty()) {
    const size_t end = value.find('\n', start);
    const std::string item = value.substr(start, end == std::string::npos ? std::string::npos : end - start);
    if (!item.empty()) out.push_back(item);
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return out;
}

double f64(const std::string& value) {
  const auto parsed = finite(value);
  return parsed ? *parsed : 0.0;
}

int64_t i64(const std::string& value) {
  try {
    size_t pos = 0;
    const long long parsed = std::stoll(value, &pos, 10);
    return pos == value.size() ? static_cast<int64_t>(parsed) : 0;
  } catch (...) {
    return 0;
  }
}

// Runs one Queries SELECT, its rows read, bytes and time kept in `read`.
void read_query_log(clickhouse::Client& runner, const std::string& sql, MonitorQueryRead& read,
                    const std::function<void(const clickhouse::Block&)>& on_block) {
  const auto started = std::chrono::steady_clock::now();
  try {
    const BoundedRead result = bounded_select(runner, sql, on_block);
    read.rows_read = result.read_rows;
    read.bytes_read = result.read_bytes;
    read.elapsed_ms = result.elapsed_ms;
  } catch (...) {
    read.elapsed_ms = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count());
    throw;
  }
}

// Why a Queries SELECT failed, in the answer's terms; for a read past the
// cap, the span that would fit (estimated from the last hour's rows).
template <typename Answer>
void queries_failed(clickhouse::Client& runner, const MonitorQueriesRequest& r, const clickhouse::ServerException& error,
                    Answer& out, MonitorQueryRead& read) {
  out.status = monitor_reason_of(error);
  out.message = error.what();
  read.status = out.status;
  read.message = out.message;
  if (out.status == "not_granted") out.hint = monitor_grant_hint("query_log", r.runner_user);
  if (out.status != "window_too_large") return;
  uint64_t rows = 0;
  try {
    const uint64_t since = r.now_s > 3600 ? r.now_s - 3600 : 0;
    const std::string sql = "SELECT toString(count()) FROM system.query_log WHERE event_date >= toDate(toDateTime(" +
                            std::to_string(since) + ")) AND event_time >= toDateTime(" + std::to_string(since) + ")" +
                            monitor_settings_sql(kQueriesEstimateSeconds, std::max(r.max_rows, kQueriesEstimateRowsCap), 1);
    runner.Select(sql, [&](const clickhouse::Block& block) {
      if (block.GetRowCount() > 0) rows = u64(text(block, 0, 0));
    });
  } catch (const clickhouse::ServerException&) {
    rows = 0;
  }
  out.suggested_span_s = monitor_queries_suggested_span(r.to_s > r.from_s ? r.to_s - r.from_s : 0, rows, r.max_rows);
}

} // namespace

const std::vector<std::string>& monitor_queries_sorts() {
  static const std::vector<std::string> names = [] {
    std::vector<std::string> out;
    for (const auto& item : queries_sort_expressions()) out.push_back(item.first);
    return out;
  }();
  return names;
}

const std::vector<std::string>& monitor_queries_kinds() {
  static const std::vector<std::string> names{"all", "Select", "Insert", "other"};
  return names;
}

const std::vector<std::string>& monitor_query_run_orders() {
  static const std::vector<std::string> names = [] {
    std::vector<std::string> out;
    for (const auto& item : query_run_order_expressions()) out.push_back(item.first);
    return out;
  }();
  return names;
}

uint64_t monitor_queries_suggested_span(uint64_t span_s, uint64_t rows_last_hour, uint64_t max_rows) {
  static const uint64_t spans[] = {60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 3 * 86400};
  uint64_t fit = span_s / 2;
  if (rows_last_hour > 0 && max_rows > 0) {
    // Four fifths of the cap, at the last hour's rate.
    const double seconds = static_cast<double>(max_rows) * 0.8 / (static_cast<double>(rows_last_hour) / 3600.0);
    fit = std::min<uint64_t>(fit, seconds >= 1e12 ? fit : static_cast<uint64_t>(seconds));
  }
  uint64_t best = spans[0];
  for (const uint64_t span : spans) {
    if (span <= fit) best = span;
  }
  return best;
}

std::string monitor_queries_top_sql(const MonitorQueriesRequest& r) {
  return "SELECT toString(normalized_query_hash), toString(any(query_kind)), toString(count()), "
         "toString(countIf(type != 'QueryFinish')), toString(sum(query_duration_ms)), toString(avg(query_duration_ms)), "
         "toString(quantileTDigest(0.95)(query_duration_ms)), toString(max(query_duration_ms)), "
         "toString(sum(read_rows)), toString(sum(read_bytes)), toString(sum(written_rows)), toString(sum(result_rows)), "
         "toString(avg(memory_usage)), toString(max(memory_usage)), "
         "arrayStringConcat(arrayMap(x -> replaceAll(toString(x), '\\n', ' '), groupUniqArray(5)(user)), '\\n'), "
         "arrayStringConcat(arrayMap(x -> replaceAll(toString(x), '\\n', ' '), arraySlice(groupUniqArrayArray(tables), 1, 8)), '\\n'), "
         "toString(toUnixTimestamp(min(event_time))), toString(toUnixTimestamp(max(event_time))), "
         // The window's totals over every shape: window functions run after
         // the GROUP BY and before the LIMIT.
         "toString(sum(count()) OVER ()), toString(sum(countIf(type != 'QueryFinish')) OVER ()), "
         "toString(sum(sum(query_duration_ms)) OVER ()), toString(sum(sum(read_bytes)) OVER ()), toString(count() OVER ())"
         " FROM system.query_log WHERE " + queries_filter_sql(r, true) +
         " GROUP BY normalized_query_hash ORDER BY " + expression_of(queries_sort_expressions(), r.sort) +
         " DESC, normalized_query_hash LIMIT " + std::to_string(kMonitorTopQueries) +
         monitor_settings_sql(kQueriesAggregateSeconds, r.max_rows, kMonitorTopQueries + 1) + kQueriesGroupBySettings;
}

std::string monitor_queries_text_sql(const MonitorQueriesRequest& r, const std::vector<uint64_t>& hashes) {
  std::string list;
  for (const uint64_t hash : hashes) {
    if (!list.empty()) list += ", ";
    list += std::to_string(hash);
  }
  const std::string chars = std::to_string(kMonitorQueryTextChars);
  // The key column first (PREWHERE): the text is read only for the granules
  // of the listed shapes.
  return "SELECT toString(normalized_query_hash), substringUTF8(argMax(query, event_time), 1, " + chars + ") AS example, "
         "normalizeQuery(example), toString(lengthUTF8(argMax(query, event_time)) > " + chars + "), "
         "toString(argMax(query_id, event_time)) FROM system.query_log PREWHERE normalized_query_hash IN (" + list + ") WHERE " +
         queries_filter_sql(r, true) + " GROUP BY normalized_query_hash" +
         monitor_settings_sql(kQueriesTextSeconds, r.max_rows, kMonitorTopQueries + 1);
}

std::string monitor_query_timeline_sql(const MonitorQueriesRequest& r) {
  const std::string step = std::to_string(std::max<uint32_t>(1, r.step_s));
  const uint64_t buckets = r.step_s ? (r.to_s - r.from_s) / r.step_s + 2 : 2;
  return "SELECT toUInt64(toUnixTimestamp(toStartOfInterval(event_time, INTERVAL " + step + " SECOND))) AS t, "
         "toString(count()), toString(countIf(type != 'QueryFinish')), "
         "quantilesTDigest(0.5, 0.95)(query_duration_ms) AS latency_ms, toString(latency_ms[1]), toString(latency_ms[2]), "
         "toString(sum(read_rows)), toString(max(memory_usage)), "
         "toString(sum(ProfileEvents['OSCPUVirtualTimeMicroseconds']) / 1e6), "
         // The whole window (window functions over the buckets; the p95
         // merges the buckets' digests).
         "toString(sum(count()) OVER ()), toString(sum(countIf(type != 'QueryFinish')) OVER ()), "
         "toString(sum(sum(query_duration_ms)) OVER ()), "
         "toString(quantileTDigestMerge(0.95)(quantileTDigestState(query_duration_ms)) OVER ()), "
         "toString(max(max(query_duration_ms)) OVER ()), toString(sum(sum(read_rows)) OVER ()), "
         "toString(sum(sum(read_bytes)) OVER ()), toString(max(max(memory_usage)) OVER ()), "
         "toString(sum(sum(ProfileEvents['OSCPUVirtualTimeMicroseconds'])) OVER () / 1e6) "
         "FROM system.query_log PREWHERE normalized_query_hash = " + std::to_string(r.hash) + " WHERE " +
         queries_filter_sql(r, false) + " GROUP BY t ORDER BY t" +
         monitor_settings_sql(kQueriesDrillSeconds, r.max_rows, buckets);
}

std::string monitor_query_runs_sql(const MonitorQueriesRequest& r) {
  return "SELECT toString(toUnixTimestamp64Milli(event_time_microseconds)), toString(query_id), toString(user), toString(type), "
         "toString(query_duration_ms), toString(read_rows), toString(read_bytes), toString(result_rows), toString(written_rows), "
         "toString(memory_usage), toString(ProfileEvents['OSCPUVirtualTimeMicroseconds']), toString(exception_code), "
         "substringUTF8(exception, 1, 512) "
         "FROM system.query_log PREWHERE normalized_query_hash = " + std::to_string(r.hash) + " WHERE " +
         queries_filter_sql(r, false) + " ORDER BY " + expression_of(query_run_order_expressions(), r.order) +
         " DESC, event_time_microseconds DESC LIMIT " + std::to_string(kMonitorQueryRuns) +
         monitor_settings_sql(kQueriesDrillSeconds, r.max_rows, kMonitorQueryRuns + 1);
}

std::string monitor_query_example_sql(const MonitorQueriesRequest& r) {
  const std::string chars = std::to_string(kMonitorQueryExampleChars);
  return "SELECT substringUTF8(query, 1, " + chars + ") AS example, toString(lengthUTF8(query) > " + chars + "), "
         "toString(query_id), normalizeQuery(example), toString(query_kind) "
         "FROM system.query_log PREWHERE normalized_query_hash = " + std::to_string(r.hash) + " WHERE " +
         queries_filter_sql(r, false) + " ORDER BY event_time_microseconds DESC LIMIT 1" +
         monitor_settings_sql(kQueriesDrillSeconds, r.max_rows, 2);
}

bool load_system_monitor_queries(clickhouse::Client& runner, const MonitorCapabilities& caps,
                                   const MonitorQueriesRequest& request, SystemMonitorQueries& out, std::string* error) {
  out = SystemMonitorQueries{};
  out.generated_at_ms = monitor_now_ms();
  out.request = request;
  if (!caps.has_table("query_log")) {
    out.status = "disabled";
    out.message = "system.query_log does not exist on this server.";
    return true;
  }

  // Phase 1: the narrow numbers of every shape, the top ones kept.
  try {
    read_query_log(runner, monitor_queries_top_sql(request), out.aggregate, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        if (out.queries.size() >= kMonitorTopQueries) continue;
        MonitorQueryShape shape;
        shape.hash = u64(text(block, 0, row));
        shape.kind = text(block, 1, row);
        shape.calls = u64(text(block, 2, row));
        shape.errors = u64(text(block, 3, row));
        shape.total_ms = f64(text(block, 4, row));
        shape.avg_ms = f64(text(block, 5, row));
        shape.p95_ms = f64(text(block, 6, row));
        shape.max_ms = f64(text(block, 7, row));
        shape.read_rows = u64(text(block, 8, row));
        shape.read_bytes = u64(text(block, 9, row));
        shape.written_rows = u64(text(block, 10, row));
        shape.result_rows = u64(text(block, 11, row));
        shape.avg_memory = f64(text(block, 12, row));
        shape.max_memory = u64(text(block, 13, row));
        shape.users = split_lines(text(block, 14, row));
        shape.tables = split_lines(text(block, 15, row));
        shape.first_seen_s = u64(text(block, 16, row));
        shape.last_seen_s = u64(text(block, 17, row));
        out.totals.calls = u64(text(block, 18, row));
        out.totals.errors = u64(text(block, 19, row));
        out.totals.total_ms = f64(text(block, 20, row));
        out.totals.read_bytes = u64(text(block, 21, row));
        out.totals.shapes = u64(text(block, 22, row));
        out.queries.push_back(std::move(shape));
      }
    });
  } catch (const clickhouse::ServerException& e) {
    out.queries.clear();
    out.totals = MonitorQueriesTotals{};
    queries_failed(runner, request, e, out, out.aggregate);
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
  if (out.queries.empty()) return true;

  // Phase 2: the text of those shapes only (the last run's, cut).
  std::vector<uint64_t> hashes;
  std::unordered_map<uint64_t, size_t> index;
  for (size_t i = 0; i < out.queries.size(); ++i) {
    hashes.push_back(out.queries[i].hash);
    index.emplace(out.queries[i].hash, i);
  }
  try {
    read_query_log(runner, monitor_queries_text_sql(request, hashes), out.text, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const auto it = index.find(u64(text(block, 0, row)));
        if (it == index.end()) continue;
        MonitorQueryShape& shape = out.queries[it->second];
        shape.has_text = true;
        shape.example = text(block, 1, row);
        shape.normalized = text(block, 2, row);
        shape.example_truncated = flag(text(block, 3, row));
        shape.last_query_id = text(block, 4, row);
      }
    });
  } catch (const clickhouse::ServerException& e) {
    // The numbers stand; the list names the shapes by hash.
    out.text.status = monitor_reason_of(e);
    out.text.message = e.what();
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
  return true;
}

bool load_system_monitor_query(clickhouse::Client& runner, const MonitorCapabilities& caps,
                                 const MonitorQueriesRequest& request, SystemMonitorQuery& out, std::string* error) {
  out = SystemMonitorQuery{};
  out.generated_at_ms = monitor_now_ms();
  out.request = request;
  if (!caps.has_table("query_log")) {
    out.status = "disabled";
    out.message = "system.query_log does not exist on this server.";
    return true;
  }
  const uint32_t step = std::max<uint32_t>(1, request.step_s);
  const size_t count = static_cast<size_t>((request.to_s - request.from_s) / step);
  out.buckets.reserve(count);
  for (size_t i = 0; i < count; ++i) out.buckets.push_back(request.from_s + i * step);
  static const char* const kSeries[] = {"calls", "errors", "p50_ms", "p95_ms", "read_rows", "max_memory", "cpu_seconds"};
  for (const char* name : kSeries) out.series[name].assign(count, std::nan(""));

  try {
    read_query_log(runner, monitor_query_timeline_sql(request), out.timeline_read, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const uint64_t t = ch_block_u64_at(block, 0, row);
        if (t < request.from_s || (t - request.from_s) % step != 0) continue;
        const size_t i = static_cast<size_t>((t - request.from_s) / step);
        if (i >= count) continue;
        // Columns: t, calls, errors, latency_ms (the array), p50, p95,
        // read_rows, max_memory, cpu_seconds.
        out.series["calls"][i] = f64(text(block, 1, row));
        out.series["errors"][i] = f64(text(block, 2, row));
        out.series["p50_ms"][i] = f64(text(block, 4, row));
        out.series["p95_ms"][i] = f64(text(block, 5, row));
        out.series["read_rows"][i] = f64(text(block, 6, row));
        out.series["max_memory"][i] = f64(text(block, 7, row));
        out.series["cpu_seconds"][i] = f64(text(block, 8, row));
        MonitorQuerySummary& s = out.summary;
        s.calls = u64(text(block, 9, row));
        s.errors = u64(text(block, 10, row));
        s.total_ms = f64(text(block, 11, row));
        s.p95_ms = f64(text(block, 12, row));
        s.max_ms = f64(text(block, 13, row));
        s.read_rows = u64(text(block, 14, row));
        s.read_bytes = u64(text(block, 15, row));
        s.max_memory = u64(text(block, 16, row));
        s.cpu_seconds = f64(text(block, 17, row));
      }
    });
  } catch (const clickhouse::ServerException& e) {
    out.series.clear();
    out.buckets.clear();
    queries_failed(runner, request, e, out, out.timeline_read);
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }

  try {
    read_query_log(runner, monitor_query_runs_sql(request), out.runs_read, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        if (out.runs.size() >= kMonitorQueryRuns) continue;
        MonitorQueryRun run;
        run.event_time_ms = u64(text(block, 0, row));
        run.query_id = text(block, 1, row);
        run.user = text(block, 2, row);
        run.type = text(block, 3, row);
        run.duration_ms = u64(text(block, 4, row));
        run.read_rows = u64(text(block, 5, row));
        run.read_bytes = u64(text(block, 6, row));
        run.result_rows = u64(text(block, 7, row));
        run.written_rows = u64(text(block, 8, row));
        run.memory_usage = u64(text(block, 9, row));
        run.cpu_us = u64(text(block, 10, row));
        run.exception_code = i64(text(block, 11, row));
        run.exception = text(block, 12, row);
        out.runs.push_back(std::move(run));
      }
    });
  } catch (const clickhouse::ServerException& e) {
    out.runs.clear();
    out.runs_read.status = monitor_reason_of(e);
    out.runs_read.message = e.what();
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }

  try {
    read_query_log(runner, monitor_query_example_sql(request), out.example_read, [&](const clickhouse::Block& block) {
      if (block.GetRowCount() == 0 || !out.example_query_id.empty()) return;
      out.example = text(block, 0, 0);
      out.example_truncated = flag(text(block, 1, 0));
      out.example_query_id = text(block, 2, 0);
      out.normalized = text(block, 3, 0);
      out.kind = text(block, 4, 0);
    });
  } catch (const clickhouse::ServerException& e) {
    out.example_read.status = monitor_reason_of(e);
    out.example_read.message = e.what();
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Disks: system.disks, system.storage_policies and the active parts of the
// runner-visible databases by disk (system context, metadata only), then the
// growth of each disk (asynchronous_metric_log) and what was written and
// moved (part_log).

namespace {

constexpr int kDisksTimeBudgetSeconds = 5;
constexpr int kDiskUsageTimeBudgetSeconds = 10;
constexpr uint64_t kDiskUsageReadRowsCap = 10'000'000;
constexpr int kGrowthTimeBudgetSeconds = 10;
constexpr uint64_t kGrowthReadRowsCap = 50'000'000;

std::optional<uint64_t> optional_u64(const std::string& value, bool present) {
  if (!present) return std::nullopt;
  return u64(value);
}

std::optional<bool> optional_flag(const std::string& value, bool present) {
  if (!present) return std::nullopt;
  return flag(value);
}

// "toString(<column>)" when this server has it, "''" otherwise: the SELECT
// keeps its column positions whatever the version.
std::string optional_column_sql(const MonitorCapabilities& caps, const std::string& table, const std::string& column) {
  return caps.has_column(table, column) ? ", toString(`" + column + "`)" : ", ''";
}

void add_disks_issue(SystemMonitorDisks& out, const MonitorCapabilities& caps, const std::string& panel,
                     const std::string& table, const std::exception& error) {
  MonitorPanelIssue issue;
  issue.panel = panel;
  issue.table = table;
  issue.reason = monitor_reason_of(error);
  issue.message = error.what();
  if (issue.reason == "not_granted") issue.hint = monitor_grant_hint(table, caps.system_user);
  out.unavailable_panels.push_back(std::move(issue));
}

// The window's time predicate and bucket key (the Performance series').
std::string growth_bucket_sql(const MonitorSeriesWindow& w) {
  return "toUInt64(toUnixTimestamp(toStartOfInterval(event_time, INTERVAL " + std::to_string(w.step_s) + " SECOND))) AS t";
}

} // namespace

std::string monitor_disks_sql(const MonitorCapabilities& caps) {
  std::string sql = "SELECT toString(name), toString(path), toString(free_space), toString(total_space)";
  for (const auto& column : disk_columns()) sql += optional_column_sql(caps, "disks", column);
  return sql + " FROM system.disks ORDER BY name LIMIT " + std::to_string(kMonitorDiskRowLimit + 1) +
         monitor_settings_sql(kDisksTimeBudgetSeconds, 100000, kMonitorDiskRowLimit + 1);
}

std::string monitor_storage_policies_sql(const MonitorCapabilities& caps) {
  std::string sql =
      "SELECT toString(policy_name), toString(volume_name), toString(volume_priority), "
      "arrayStringConcat(arrayMap(x -> replaceAll(toString(x), '\\n', ' '), disks), '\\n')";
  for (const auto& column : storage_policy_columns()) sql += optional_column_sql(caps, "storage_policies", column);
  return sql + " FROM system.storage_policies ORDER BY policy_name, volume_priority LIMIT " +
         std::to_string(kMonitorPolicyRowLimit + 1) + monitor_settings_sql(kDisksTimeBudgetSeconds, 100000, kMonitorPolicyRowLimit + 1);
}

std::string monitor_disk_usage_sql(const std::vector<std::string>& databases) {
  // The disk's totals over every listed database are window functions: they
  // run after the GROUP BY and before the LIMIT, so a cut list still knows
  // what it leaves out.
  return "SELECT toString(disk_name), toString(database), toString(sum(bytes_on_disk)), toString(sum(rows)), "
         "toString(count()), toString(countIf(part_type = 'Compact')), "
         "toString(sum(sum(bytes_on_disk)) OVER (PARTITION BY disk_name)), toString(sum(count()) OVER (PARTITION BY disk_name)), "
         "toString(count() OVER (PARTITION BY disk_name)) "
         "FROM system.parts WHERE active AND database IN " + in_list(databases) +
         " GROUP BY disk_name, database ORDER BY sum(bytes_on_disk) DESC, disk_name, database LIMIT " +
         std::to_string(kMonitorDiskUsageRowLimit + 1) +
         monitor_settings_sql(kDiskUsageTimeBudgetSeconds, kDiskUsageReadRowsCap, kMonitorDiskUsageRowLimit + 1);
}

bool load_system_monitor_disks(clickhouse::Client& system, clickhouse::Client& runner, const MonitorCapabilities& caps,
                                 SystemMonitorDisks& out, std::string* error) {
  out = SystemMonitorDisks{};
  out.generated_at_ms = monitor_now_ms();
  if (caps.detected) {
    for (const char* table : {"asynchronous_metric_log", "part_log"}) out.logs[table] = caps.tables.count(table) > 0;
  }
  size_t failed = 0;

  // The disks: capacity, free and reserved space, kind and flags.
  try {
    const bool unreserved = caps.has_column("disks", "unreserved_space");
    const bool keep_free = caps.has_column("disks", "keep_free_space");
    const bool read_only = caps.has_column("disks", "is_read_only");
    const bool broken = caps.has_column("disks", "is_broken");
    const bool encrypted = caps.has_column("disks", "is_encrypted");
    const bool remote = caps.has_column("disks", "is_remote");
    system.Select(monitor_disks_sql(caps), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        if (out.disks.size() >= kMonitorDiskRowLimit) {
          out.disks_truncated = true;
          continue;
        }
        MonitorDisk disk;
        disk.name = text(block, 0, row);
        disk.path = text(block, 1, row);
        disk.free_space = u64(text(block, 2, row));
        disk.total_space = u64(text(block, 3, row));
        // Columns 4.. follow disk_columns().
        disk.unreserved_space = optional_u64(text(block, 4, row), unreserved);
        disk.keep_free_space = optional_u64(text(block, 5, row), keep_free);
        disk.type = text(block, 6, row);
        disk.object_storage_type = text(block, 7, row);
        disk.cache_path = text(block, 8, row);
        disk.is_read_only = optional_flag(text(block, 9, row), read_only);
        disk.is_broken = optional_flag(text(block, 10, row), broken);
        disk.is_encrypted = optional_flag(text(block, 11, row), encrypted);
        disk.is_remote = optional_flag(text(block, 12, row), remote);
        out.disks.push_back(std::move(disk));
      }
    });
  } catch (const std::exception& e) {
    out.disks.clear();
    out.disks_truncated = false;
    add_disks_issue(out, caps, "disks", "disks", e);
    ++failed;
  }

  // Storage policies: one row per volume, in priority order.
  try {
    const bool max_part = caps.has_column("storage_policies", "max_data_part_size");
    const bool move_factor = caps.has_column("storage_policies", "move_factor");
    const bool no_merge = caps.has_column("storage_policies", "prefer_not_to_merge");
    const bool ttl_on_insert = caps.has_column("storage_policies", "perform_ttl_move_on_insert");
    system.Select(monitor_storage_policies_sql(caps), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        if (out.volumes.size() >= kMonitorPolicyRowLimit) {
          out.volumes_truncated = true;
          continue;
        }
        MonitorStorageVolume volume;
        volume.policy = text(block, 0, row);
        volume.volume = text(block, 1, row);
        volume.priority = u64(text(block, 2, row));
        volume.disks = split_lines(text(block, 3, row));
        // Columns 4.. follow storage_policy_columns().
        volume.volume_type = text(block, 4, row);
        volume.max_data_part_size = optional_u64(text(block, 5, row), max_part);
        if (move_factor) {
          if (const auto value = finite(text(block, 6, row))) volume.move_factor = *value;
        }
        volume.prefer_not_to_merge = optional_flag(text(block, 7, row), no_merge);
        volume.perform_ttl_move_on_insert = optional_flag(text(block, 8, row), ttl_on_insert);
        volume.load_balancing = text(block, 9, row);
        out.volumes.push_back(std::move(volume));
      }
    });
  } catch (const std::exception& e) {
    out.volumes.clear();
    out.volumes_truncated = false;
    add_disks_issue(out, caps, "policies", "storage_policies", e);
    ++failed;
  }

  // Bytes by disk and database: active parts of the databases the runner can
  // SHOW (inside the SQL), each row re-checked against that list.
  try {
    std::vector<std::string> databases = discover_visible_databases(runner);
    std::sort(databases.begin(), databases.end());
    if (!databases.empty()) {
      system.Select(monitor_disk_usage_sql(databases), [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          if (out.usage.size() >= kMonitorDiskUsageRowLimit) {
            out.usage_truncated = true;
            continue;
          }
          MonitorDiskUsage usage;
          usage.disk = text(block, 0, row);
          usage.database = text(block, 1, row);
          if (!std::binary_search(databases.begin(), databases.end(), usage.database)) continue;
          usage.bytes = u64(text(block, 2, row));
          usage.rows = u64(text(block, 3, row));
          usage.parts = u64(text(block, 4, row));
          usage.compact_parts = u64(text(block, 5, row));
          usage.disk_bytes = u64(text(block, 6, row));
          usage.disk_parts = u64(text(block, 7, row));
          usage.disk_databases = u64(text(block, 8, row));
          out.usage.push_back(std::move(usage));
        }
      });
    }
  } catch (const std::exception& e) {
    out.usage.clear();
    out.usage_truncated = false;
    add_disks_issue(out, caps, "usage", "parts", e);
    ++failed;
  }

  if (failed == 3) {
    if (error) *error = out.unavailable_panels.empty() ? "No Disks panel is readable." : out.unavailable_panels.back().message;
    return false;
  }
  return true;
}

MonitorDiskTrend monitor_disk_trend(const std::vector<uint64_t>& times_s, const std::vector<double>& used,
                                    uint64_t free_space, uint64_t total_space) {
  MonitorDiskTrend out;
  std::vector<std::pair<double, double>> points;
  const size_t count = std::min(times_s.size(), used.size());
  for (size_t i = 0; i < count; ++i) {
    if (std::isfinite(used[i])) points.emplace_back(static_cast<double>(times_s[i]), used[i]);
  }
  out.points = points.size();
  out.span_s = points.size() > 1 ? static_cast<uint64_t>(points.back().first - points.front().first) : 0;
  if (total_space == 0) {
    out.status = "no_capacity";
    return out;
  }
  if (points.size() < kMonitorDiskTrendMinPoints || out.span_s < kMonitorDiskTrendMinSpanSeconds) {
    out.status = "not_enough_history";
    return out;
  }
  // Least squares over the buckets (time centred, so the sums stay small).
  double mean_t = 0;
  double mean_v = 0;
  for (const auto& [t, v] : points) {
    mean_t += t;
    mean_v += v;
  }
  mean_t /= static_cast<double>(points.size());
  mean_v /= static_cast<double>(points.size());
  double num = 0;
  double den = 0;
  for (const auto& [t, v] : points) {
    num += (t - mean_t) * (v - mean_v);
    den += (t - mean_t) * (t - mean_t);
  }
  const double slope = den > 0 ? num / den : 0.0;  // bytes per second
  out.slope_bytes_per_day = slope * 86400.0;
  // Flat: what the trend adds over the window is under 1 part in 10,000 of
  // the capacity (or under 1 MiB). Falling or flat: no forecast.
  const double grown = slope * static_cast<double>(out.span_s);
  if (!(slope > 0) || grown < std::max(static_cast<double>(total_space) * 1e-4, 1048576.0)) {
    out.status = "not_growing";
    return out;
  }
  out.status = "growing";
  out.days_until_full = static_cast<double>(free_space) / out.slope_bytes_per_day;
  return out;
}

std::string monitor_disk_growth_sql(const MonitorSeriesWindow& window, const std::vector<std::string>& disks, bool with_key) {
  std::vector<std::string> metrics;
  metrics.reserve(disks.size());
  for (const auto& disk : disks) metrics.push_back("DiskUsed_" + disk);
  const std::string total = "'TotalBytesOfMergeTreeTables'";
  // metric IN (...) first: the table's key starts with metric.
  std::string predicate;
  std::string disk_expr;
  if (with_key) {
    // 26.8+: DiskUsed with key = '<disk>' (the default), DiskUsed_<disk>
    // with asynchronous_metrics_key_values_mode = legacy_names or both.
    predicate = "(metric = " + total + (metrics.empty() ? "" : " OR metric IN " + in_list(metrics)) +
                (disks.empty() ? "" : " OR (metric = 'DiskUsed' AND key IN " + in_list(disks) + ")") + ")";
    disk_expr = "if(metric = " + total + ", '', if(metric = 'DiskUsed', toString(key), substring(toString(metric), 10)))";
  } else {
    std::vector<std::string> names = metrics;
    names.push_back("TotalBytesOfMergeTreeTables");
    predicate = "metric IN " + in_list(names);
    disk_expr = "if(metric = " + total + ", '', substring(toString(metric), 10))";
  }
  const uint64_t rows = (series_bucket_count(window) + 2) * (disks.size() + 1);
  // `both` mode logs a disk twice per sample (DiskUsed_<d> and DiskUsed with
  // its key): the maximum of a bucket is the same either way.
  return "SELECT " + growth_bucket_sql(window) + ", " + disk_expr + " AS disk, toString(metric = " + total +
         ") AS merge_tree, toFloat64(max(value)) AS v FROM system.asynchronous_metric_log WHERE " + predicate + " AND " +
         series_time_predicate(window) + " GROUP BY t, disk, merge_tree ORDER BY t" +
         monitor_settings_sql(kGrowthTimeBudgetSeconds, kGrowthReadRowsCap, rows);
}

std::string monitor_disk_written_sql(const MonitorSeriesWindow& window, const std::vector<std::string>& databases) {
  const uint64_t rows = series_bucket_count(window) + 2;
  // New parts (inserts) and part moves (TTL and policy moves) of the
  // runner-visible databases, summed over them: no database is named.
  return "SELECT " + growth_bucket_sql(window) +
         ", toFloat64(sumIf(size_in_bytes, event_type = 'NewPart')), toFloat64(sumIf(size_in_bytes, event_type = 'MovePart')), "
         "toFloat64(countIf(event_type = 'MovePart')) FROM system.part_log WHERE " + series_time_predicate(window) +
         " AND database IN " + in_list(databases) + " AND event_type IN ('NewPart', 'MovePart') GROUP BY t ORDER BY t" +
         monitor_settings_sql(kGrowthTimeBudgetSeconds, kGrowthReadRowsCap, rows);
}

namespace {

// One growth SELECT, its rows read and time kept in `source`; each row's
// bucket lands at its index of the window.
void read_growth(clickhouse::Client& client, const std::string& sql, const MonitorSeriesWindow& window, size_t count,
                 MonitorSeriesSource& source, const std::function<void(const clickhouse::Block&, size_t, size_t)>& on_row) {
  const BoundedRead read = bounded_select(client, sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const uint64_t t = ch_block_u64_at(block, 0, row);
      if (t < window.from_s || (t - window.from_s) % window.step_s != 0) continue;
      const size_t index = static_cast<size_t>((t - window.from_s) / window.step_s);
      if (index < count) on_row(block, row, index);
    }
  });
  source.rows_read = read.read_rows;
  source.elapsed_ms = read.elapsed_ms;
}

} // namespace

void load_system_monitor_disk_growth(clickhouse::Client& system, clickhouse::Client& runner, const MonitorCapabilities& caps,
                                       const MonitorSeriesWindow& window, SystemMonitorDiskGrowth& out) {
  out = SystemMonitorDiskGrowth{};
  out.generated_at_ms = monitor_now_ms();
  out.window = window;
  out.key_column = caps.has_column("asynchronous_metric_log", "key");
  const size_t count = static_cast<size_t>(series_bucket_count(window));
  out.buckets.reserve(count);
  for (size_t index = 0; index < count; ++index) out.buckets.push_back(window.from_s + index * window.step_s);

  // 1. The disks to follow, with their free space now (the forecast).
  {
    MonitorSeriesSource& source = out.sources["disks"];
    source.table = "disks";
    try {
      system.Select("SELECT toString(name), toString(free_space), toString(total_space) FROM system.disks ORDER BY name LIMIT " +
                        std::to_string(kMonitorDiskRowLimit) + monitor_settings_sql(kDisksTimeBudgetSeconds, 100000, kMonitorDiskRowLimit),
                    [&](const clickhouse::Block& block) {
                      for (size_t row = 0; row < block.GetRowCount(); ++row) {
                        MonitorDiskGrowth disk;
                        disk.name = text(block, 0, row);
                        disk.free_space = u64(text(block, 1, row));
                        disk.total_space = u64(text(block, 2, row));
                        out.disks.push_back(std::move(disk));
                      }
                    });
    } catch (const std::exception& e) {
      out.disks.clear();
      source_failed(source, caps, e);
    }
  }

  // 2. asynchronous_metric_log: each disk's used bytes (the largest sample of
  // a bucket) and the MergeTree tables' bytes.
  {
    MonitorSeriesSource& source = out.sources["asynchronous_metric_log"];
    source.table = "asynchronous_metric_log";
    if (!caps.has_table("asynchronous_metric_log")) {
      source.status = "disabled";
    } else {
      std::vector<std::string> names;
      std::map<std::string, size_t> index_of;
      for (size_t i = 0; i < out.disks.size(); ++i) {
        names.push_back(out.disks[i].name);
        index_of.emplace(out.disks[i].name, i);
        out.disks[i].used.assign(count, std::nan(""));
      }
      auto& merge_tree = out.series["merge_tree_bytes"];
      merge_tree.assign(count, std::nan(""));
      try {
        read_growth(system, monitor_disk_growth_sql(window, names, out.key_column), window, count, source,
                    [&](const clickhouse::Block& block, size_t row, size_t index) {
                      // Columns: t, disk, merge_tree, v.
                      const double value = f64_at(block, 3, row);
                      if (flag(text(block, 2, row))) {
                        merge_tree[index] = value;
                        return;
                      }
                      const auto it = index_of.find(text(block, 1, row));
                      if (it == index_of.end()) return;
                      double& slot = out.disks[it->second].used[index];
                      slot = std::isfinite(slot) ? std::max(slot, value) : value;
                    });
      } catch (const std::exception& e) {
        out.series.erase("merge_tree_bytes");
        for (auto& disk : out.disks) disk.used.clear();
        source_failed(source, caps, e);
      }
    }
    for (auto& disk : out.disks) {
      disk.trend = monitor_disk_trend(out.buckets, disk.used, disk.free_space, disk.total_space);
    }
  }

  // 3. part_log: bytes written (new parts) and moved, the runner-visible
  // databases only.
  {
    MonitorSeriesSource& source = out.sources["part_log"];
    source.table = "part_log";
    if (!caps.has_table("part_log")) {
      source.status = "disabled";
    } else {
      static const char* const kNames[] = {"written_bytes", "moved_bytes", "moves"};
      try {
        const std::vector<std::string> databases = discover_visible_databases(runner);
        for (const char* name : kNames) out.series[name].assign(count, std::nan(""));
        if (!databases.empty()) {
          read_growth(system, monitor_disk_written_sql(window, databases), window, count, source,
                      [&](const clickhouse::Block& block, size_t row, size_t index) {
                        // Columns: t, written, moved, moves.
                        for (size_t k = 0; k < 3; ++k) out.series[kNames[k]][index] = f64_at(block, k + 1, row);
                      });
        }
      } catch (const std::exception& e) {
        for (const char* name : kNames) out.series.erase(name);
        source_failed(source, caps, e);
      }
    }
  }
}

} // namespace chdash
