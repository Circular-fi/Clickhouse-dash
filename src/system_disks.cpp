#include "system_disks.hpp"

#include "ch_block_numeric.hpp"
#include "ch_executor.hpp"
#include "sql_params.hpp"
#include "system_monitor_internal.hpp"

#include <algorithm>
#include <cmath>
#include <functional>

namespace chdash {

using namespace monitor_internal;

namespace monitor_internal {

// The optional columns of system.disks and system.storage_policies (the Disks section), in the order their SELECT reads them.
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

}  // namespace monitor_internal

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

std::string monitor_databases_list(const std::vector<std::string>& databases) {
  SqlParams params;
  return params.texts(databases);
}

ChParams monitor_databases_params(const std::vector<std::string>& databases) {
  SqlParams params;
  params.texts(databases);
  return params.list();
}

std::string monitor_disk_usage_sql(const std::string& databases_list) {
  // The disk's totals over every listed database are window functions: they
  // run after the GROUP BY and before the LIMIT, so a cut list still knows
  // what it leaves out.
  return "SELECT toString(disk_name), toString(database), toString(sum(bytes_on_disk)), toString(sum(rows)), "
         "toString(count()), toString(countIf(part_type = 'Compact')), "
         "toString(sum(sum(bytes_on_disk)) OVER (PARTITION BY disk_name)), toString(sum(count()) OVER (PARTITION BY disk_name)), "
         "toString(count() OVER (PARTITION BY disk_name)) "
         "FROM system.parts WHERE active AND database IN (" + databases_list + ")"
         " GROUP BY disk_name, database ORDER BY sum(bytes_on_disk) DESC, disk_name, database LIMIT " +
         std::to_string(kMonitorDiskUsageRowLimit + 1) +
         monitor_settings_sql(kDiskUsageTimeBudgetSeconds, kDiskUsageReadRowsCap, kMonitorDiskUsageRowLimit + 1);
}

bool load_system_monitor_disks(ChExecutor& system, AclView& runner_acl, const MonitorCapabilities& caps,
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
    system.select(monitor_disks_sql(caps), [&](const clickhouse::Block& block) {
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
    system.select(monitor_storage_policies_sql(caps), [&](const clickhouse::Block& block) {
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
          if (const auto value = finite(text(block, 6, row))) volume.move_factor = value;
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
    const std::vector<std::string> databases = runner_acl.databases();
    if (!databases.empty()) {
      system.select(monitor_disk_usage_sql(monitor_databases_list(databases)), monitor_databases_params(databases), [&](const clickhouse::Block& block) {
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

std::string monitor_disk_written_sql(const MonitorSeriesWindow& window, const std::string& databases_list) {
  const uint64_t rows = series_bucket_count(window) + 2;
  // New parts (inserts) and part moves (TTL and policy moves) of the
  // runner-visible databases, summed over them: no database is named.
  return "SELECT " + growth_bucket_sql(window) +
         ", toFloat64(sumIf(size_in_bytes, event_type = 'NewPart')), toFloat64(sumIf(size_in_bytes, event_type = 'MovePart')), "
         "toFloat64(countIf(event_type = 'MovePart')) FROM system.part_log WHERE " + series_time_predicate(window) +
         " AND database IN (" + databases_list + ") AND event_type IN ('NewPart', 'MovePart') GROUP BY t ORDER BY t" +
         monitor_settings_sql(kGrowthTimeBudgetSeconds, kGrowthReadRowsCap, rows);
}

namespace {

// One growth SELECT, its rows read and time kept in `source`; each row's
// bucket lands at its index of the window.
void read_growth(ChExecutor& client, const std::string& sql, const MonitorSeriesWindow& window, size_t count,
                 MonitorSeriesSource& source, const std::function<void(const clickhouse::Block&, size_t, size_t)>& on_row,
                 const ChParams& params = {}) {
  const BoundedRead read = client.bounded_select(sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const uint64_t t = ch_block_u64_at(block, 0, row);
      if (t < window.from_s || (t - window.from_s) % window.step_s != 0) continue;
      const size_t index = static_cast<size_t>((t - window.from_s) / window.step_s);
      if (index < count) on_row(block, row, index);
    }
  }, params);
  source.rows_read = read.read_rows;
  source.elapsed_ms = read.elapsed_ms;
}

} // namespace

void load_system_monitor_disk_growth(ChExecutor& system, AclView& runner_acl, const MonitorCapabilities& caps,
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
      system.select("SELECT toString(name), toString(free_space), toString(total_space) FROM system.disks ORDER BY name LIMIT " +
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
        const std::vector<std::string> databases = runner_acl.databases();
        for (const char* name : kNames) out.series[name].assign(count, std::nan(""));
        if (!databases.empty()) {
          read_growth(system, monitor_disk_written_sql(window, monitor_databases_list(databases)), window, count, source,
                      [&](const clickhouse::Block& block, size_t row, size_t index) {
                        // Columns: t, written, moved, moves.
                        for (size_t k = 0; k < 3; ++k) out.series[kNames[k]][index] = f64_at(block, k + 1, row);
                      },
                      monitor_databases_params(databases));
        }
      } catch (const std::exception& e) {
        for (const char* name : kNames) out.series.erase(name);
        source_failed(source, caps, e);
      }
    }
  }
}

} // namespace chdash
