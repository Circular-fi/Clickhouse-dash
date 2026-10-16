#pragma once

#include "system_monitor.hpp"

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace chdash {

class ChExecutor;

// ---------------------------------------------------------------------------
// Performance: the bucketed history of the system logs of the server (/api/system/series).
// Three SELECTs make one pass each. They read system.metric_log, system.asynchronous_metric_log, and narrow columns of system.query_log.
// Every name in them comes from the allowlists below.
// The window and the step are integers that the handler validated.

// The window is in whole seconds. From is aligned down to the step. To is aligned up to the step.
// So every request of the same aligned window shares one cache entry.
struct MonitorSeriesWindow {
  uint64_t from_s = 0;
  uint64_t to_s = 0;
  uint32_t step_s = 0;
  // The current second: the bucket still in progress divides its counters
  // by the time it covers, not by the whole step.
  uint64_t now_s = 0;
  // The span asked for, before the alignment widened it by up to two steps.
  uint64_t span_s = 0;
  // query_log is read only when the window spans at most this many seconds (system.query_log_max_lookback_hours).
  // The read uses this read cap.
  uint64_t query_log_max_span_s = 0;
  uint64_t query_log_max_rows = 0;
};

// The steps that the server can use (seconds): at most kMonitorSeriesMaxPoints
// buckets, never under 10 s (metric_log samples every second).
const std::vector<uint32_t>& monitor_series_steps();
constexpr uint64_t kMonitorSeriesMaxPoints = 300;
uint32_t monitor_series_step_seconds(uint64_t span_seconds);

// A source (one system log) of the series, and how its read went.
//   status  ok | disabled (no such table) | unsupported (metric_log in the
//           transposed layout, or columns absent) | out_of_range (query_log
//           and a window wider than its lookback) | not_granted |
//           window_too_large | readonly_account | failed
struct MonitorSeriesSource {
  std::string table;
  std::string status = "ok";
  std::string message;
  std::string hint;
  uint64_t rows_read = 0;
  uint64_t elapsed_ms = 0;
  // metric_log: the allowlisted series this server's columns cannot give.
  std::vector<std::string> missing;
};

struct SystemMonitorSeries {
  uint64_t generated_at_ms = 0;
  MonitorSeriesWindow window;
  // Bucket starts, seconds, from window.from_s to window.to_s - step.
  std::vector<uint64_t> buckets;
  // Series by name, one value per bucket (NaN: no sample in that bucket).
  std::map<std::string, std::vector<double>> series;
  // metric_log, asynchronous_metric_log, query_log.
  std::map<std::string, MonitorSeriesSource> sources;
  bool replicated_tables = false;
};

// The series names of each source, for the contract tests and the docs.
const std::vector<std::string>& monitor_series_async_metrics();

// Reads the three sources. A source that cannot be read is reported in out.sources.
// The other sources still answer.
void load_system_monitor_series(
    ChExecutor& system,
    const MonitorCapabilities& caps,
    const MonitorSeriesWindow& window,
    SystemMonitorSeries& out);

// The SQL of each source, exposed for the contract tests (no I/O).
std::string monitor_series_metric_log_sql(const MonitorCapabilities& caps, const MonitorSeriesWindow& window,
                                          std::vector<std::string>* names, std::vector<std::string>* missing);
std::string monitor_series_async_sql(const MonitorSeriesWindow& window);
std::string monitor_series_query_log_sql(const MonitorSeriesWindow& window);

} // namespace chdash
