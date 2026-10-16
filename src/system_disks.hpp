#pragma once

#include "ch_query.hpp"
#include "system_series.hpp"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

class AclView;
class ChExecutor;

// ---------------------------------------------------------------------------
// Disks: the server's disks, its storage policies, and the bytes that each
// runner-visible database keeps on each disk (/api/system/disks).
// Then, how the disks grow (/api/system/series?panel=disk_growth).
// These reads use the system context. Any query that names a database is limited to the
// databases that the runner can SHOW. This limit is in the SQL, and each row is checked again.

constexpr size_t kMonitorDiskRowLimit = 200;
constexpr size_t kMonitorPolicyRowLimit = 500;
constexpr size_t kMonitorDiskUsageRowLimit = 1000;

struct MonitorDisk {
  std::string name;
  std::string path;
  uint64_t free_space = 0;
  uint64_t total_space = 0;
  // Absent on servers without the column. The detection finds this.
  std::optional<uint64_t> unreserved_space;
  std::optional<uint64_t> keep_free_space;
  std::string type;
  std::string object_storage_type;
  std::string cache_path;
  std::optional<bool> is_read_only;
  std::optional<bool> is_broken;
  std::optional<bool> is_encrypted;
  std::optional<bool> is_remote;
};

// One volume of a storage policy. system.storage_policies has one row for each
// volume, in priority order.
struct MonitorStorageVolume {
  std::string policy;
  std::string volume;
  uint64_t priority = 0;
  std::vector<std::string> disks;
  std::string volume_type;
  std::optional<uint64_t> max_data_part_size;
  std::optional<double> move_factor;
  std::optional<bool> prefer_not_to_merge;
  std::optional<bool> perform_ttl_move_on_insert;
  std::string load_balancing;
};

// Active parts of one runner-visible database on one disk. disk_bytes and
// disk_parts are the disk's totals over every runner-visible database. They are window
// functions, so a cut list still knows what it leaves out.
struct MonitorDiskUsage {
  std::string disk;
  std::string database;
  uint64_t bytes = 0;
  uint64_t rows = 0;
  uint64_t parts = 0;
  uint64_t compact_parts = 0;
  uint64_t disk_bytes = 0;
  uint64_t disk_parts = 0;
  uint64_t disk_databases = 0;
};

struct SystemMonitorDisks {
  uint64_t generated_at_ms = 0;
  std::vector<MonitorDisk> disks;
  bool disks_truncated = false;
  std::vector<MonitorStorageVolume> volumes;
  bool volumes_truncated = false;
  std::vector<MonitorDiskUsage> usage;
  bool usage_truncated = false;
  // asynchronous_metric_log (growth) and part_log (written and moved).
  std::map<std::string, bool> logs;
  std::vector<MonitorPanelIssue> unavailable_panels;
};

// Disks, policies and the bytes by disk and database. Returns false only when
// no data can be read.
bool load_system_monitor_disks(ChExecutor& system, AclView& runner_acl, const MonitorCapabilities& caps,
                                 SystemMonitorDisks& out, std::string* error);

// The SQL, exposed for the contract and unit tests. It does no I/O. `databases` are
// the runner-visible ones. They are quoted here.
std::string monitor_disks_sql(const MonitorCapabilities& caps);
std::string monitor_storage_policies_sql(const MonitorCapabilities& caps);
// The bytes of the active parts by disk and database, of the databases of `databases_list` (monitor_databases_list).
std::string monitor_disk_usage_sql(const std::string& databases_list);
// The visible databases are query parameters, one String for each name. A name is a value and never SQL text.
// It can hold a quote mark or a backslash. An Array(String) parameter needs the quoting rules of the ClickHouse version.
// The list is the inside of `database IN (...)`: "{p1:String}, {p2:String}, ...". monitor_databases_params gives the values that belong to the statement.
std::string monitor_databases_list(const std::vector<std::string>& databases);
ChParams monitor_databases_params(const std::vector<std::string>& databases);

// Growth: the trend of a disk over the window. When the disk grows, this gives the days until
// its free space is gone. Never extrapolate from too little history. That is fewer
// than kMonitorDiskTrendMinPoints buckets, or a span under kMonitorDiskTrendMinSpanSeconds.
// Never extrapolate from a flat or falling trend.
//   status  growing | not_growing | not_enough_history | no_capacity (the
//           disk reports no total, object storage)
constexpr size_t kMonitorDiskTrendMinPoints = 6;
constexpr uint64_t kMonitorDiskTrendMinSpanSeconds = 6 * 3600;

struct MonitorDiskTrend {
  std::string status = "not_enough_history";
  size_t points = 0;
  uint64_t span_s = 0;
  // Least-squares slope of the used bytes (only meaningful when growing or
  // not_growing).
  double slope_bytes_per_day = 0;
  std::optional<double> days_until_full;
};

// times_s and used: the buckets and their used bytes (NaN: no sample).
MonitorDiskTrend monitor_disk_trend(const std::vector<uint64_t>& times_s, const std::vector<double>& used,
                                    uint64_t free_space, uint64_t total_space);

struct MonitorDiskGrowth {
  std::string name;
  uint64_t free_space = 0;
  uint64_t total_space = 0;
  std::vector<double> used;
  MonitorDiskTrend trend;
};

struct SystemMonitorDiskGrowth {
  uint64_t generated_at_ms = 0;
  MonitorSeriesWindow window;
  std::vector<uint64_t> buckets;
  std::vector<MonitorDiskGrowth> disks;
  // The series keys are merge_tree_bytes (asynchronous_metric_log), written_bytes, moved_bytes
  // and moves (part_log, runner-visible databases). Each key has one value for each bucket.
  std::map<std::string, std::vector<double>> series;
  // The sources are disks, asynchronous_metric_log and part_log.
  std::map<std::string, MonitorSeriesSource> sources;
  // ClickHouse 26.8 and later: asynchronous_metric_log has a `key` column. It names
  // the per-disk metric DiskUsed with key = '<disk>'. A server that keeps
  // the legacy names does not use this form. Both forms are read.
  bool key_column = false;
};

void load_system_monitor_disk_growth(ChExecutor& system, AclView& runner_acl, const MonitorCapabilities& caps,
                                       const MonitorSeriesWindow& window, SystemMonitorDiskGrowth& out);

// The growth SQL. with_key selects the 26.8 form: `(metric IN ('DiskUsed_<d>', ...)
// OR (metric = 'DiskUsed' AND key IN ('<d>', ...)))`. The disk is
// `if(metric = 'DiskUsed', key, substring(metric, 10))`. Disk names come from
// system.disks, and they are quoted here.
std::string monitor_disk_growth_sql(const MonitorSeriesWindow& window, const std::vector<std::string>& disks, bool with_key);
// The SQL also names the databases through `databases_list`.
std::string monitor_disk_written_sql(const MonitorSeriesWindow& window, const std::string& databases_list);

} // namespace chdash
