#include "explorer_monitor.hpp"

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

// Columns of system tables that changed across ClickHouse versions, read only
// when detected. Later sections add their tables here (disks).
const std::map<std::string, std::vector<std::string>>& detected_columns() {
  static const std::map<std::string, std::vector<std::string>> columns{
    {"clusters", {"errors_count", "slowdowns_count", "estimated_recovery_time"}},
    {"metric_log", metric_log_columns()},
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
void read_series(clickhouse::Client& system, const std::string& sql, ExplorerMonitorSeries& out, MonitorSeriesSource& source,
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

void load_explorer_monitor_series(
    clickhouse::Client& system,
    const MonitorCapabilities& caps,
    const MonitorSeriesWindow& window,
    ExplorerMonitorSeries& out) {
  out = ExplorerMonitorSeries{};
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
      source.message = "The window is wider than query_log's lookback (explorer.monitoring.query_log_max_lookback_hours).";
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

} // namespace chdash
