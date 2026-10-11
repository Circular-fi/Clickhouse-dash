#include "system_series.hpp"

#include "ch_block_numeric.hpp"
#include "ch_executor.hpp"
#include "system_monitor_internal.hpp"

#include <algorithm>
#include <cmath>
#include <functional>

namespace chdash {

using namespace monitor_internal;

namespace {

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
    // The time of a query is added when it ends and the counter Query when it starts, so a bucket that ends with queries still running (or begins
    // with queries that started before it) has the time of some queries over the count of others. The queries that ended in the bucket are the
    // ones that started in it, less the growth of the running ones (CurrentMetric_Query at the end of the bucket and at the end of the one
    // before: the first bucket has no earlier one and counts the started ones). Against the avg of query_log on a load of 20 s queries across a
    // bucket edge, the old ratio was 36 % high and this one 0.01 %.
    {"avg_query_ms",
     "sum(ProfileEvent_QueryTimeMicroseconds) / greatest(sum(ProfileEvent_Query) + "
     "lagInFrame(argMax(CurrentMetric_Query, event_time), 1, argMax(CurrentMetric_Query, event_time)) OVER (ORDER BY t) - "
     "argMax(CurrentMetric_Query, event_time), 1) / 1000",
     {"ProfileEvent_QueryTimeMicroseconds", "ProfileEvent_Query", "CurrentMetric_Query"}},
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

}  // namespace

namespace monitor_internal {

std::vector<std::string> metric_log_columns() {
  std::set<std::string> names;
  for (const auto& item : metric_log_series()) names.insert(item.columns.begin(), item.columns.end());
  return {names.begin(), names.end()};
}

}  // namespace monitor_internal

namespace {

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

}  // namespace

namespace monitor_internal {

std::string series_time_predicate(const MonitorSeriesWindow& w) {
  const std::string from = "toDateTime(" + std::to_string(w.from_s) + ")";
  const std::string to = "toDateTime(" + std::to_string(w.to_s) + ")";
  return "event_date BETWEEN toDate(" + from + ") AND toDate(" + to + ") AND event_time >= " + from + " AND event_time < " + to;
}

uint64_t series_bucket_count(const MonitorSeriesWindow& w) {
  return w.step_s ? (w.to_s - w.from_s) / w.step_s : 0;
}

}  // namespace monitor_internal

// ---------------------------------------------------------------------------
// Performance series

const std::vector<uint32_t>& monitor_series_steps() {
  static const std::vector<uint32_t> steps{10, 30, 60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 86400, 2 * 86400};
  return steps;
}

uint32_t monitor_series_step_seconds(uint64_t span_seconds) {
  const auto& steps = monitor_series_steps();
  for (const uint32_t step : steps) {
    if ((span_seconds + step - 1) / step <= kMonitorSeriesMaxPoints) return step;
  }
  return steps.back();
}

const std::vector<std::string>& monitor_series_async_metrics() {
  static const std::vector<std::string> names = [] {
    std::vector<std::string> out;
    for (const auto& item : async_series()) out.push_back(item.first);
    return out;
  }();
  return names;
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

namespace monitor_internal {

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

}  // namespace monitor_internal

namespace {

// Runs one series SELECT (bounded_select: its rows read and time are
// reported); each row's bucket lands at its index of out.buckets.
void read_series(ChExecutor& system, const std::string& sql, SystemMonitorSeries& out, MonitorSeriesSource& source,
                 const std::function<void(const clickhouse::Block&, size_t, size_t)>& on_row) {
  const uint64_t from = out.window.from_s;
  const uint64_t step = out.window.step_s;
  const size_t count = out.buckets.size();
  const BoundedRead read = system.bounded_select(sql, [&](const clickhouse::Block& block) {
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
    ChExecutor& system,
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

} // namespace chdash
