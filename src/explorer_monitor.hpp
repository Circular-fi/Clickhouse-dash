#pragma once

#include <clickhouse/client.h>

#include <cstdint>
#include <exception>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace chdash {

// Explorer "Monitoring" tab (docs/explorer.md "Monitoring"): the selected
// server's health, read from its system tables. Every SELECT is fixed and
// built here; a request only picks the host (and, in later sections, a
// clamped time range and allowlisted enums). Every SELECT ends with
// monitor_settings_sql(): read-only, a time budget and a read cap that throw
// rather than return a silently partial answer, and the 'chdash-monitoring'
// log_comment that keeps our own load auditable in system.query_log.

// What the server exposes, detected once per host and cached (10 min): the
// optional system tables and the allowlisted columns of the system tables
// whose schema changed across ClickHouse versions. A panel whose table or
// columns are missing is reported in unavailable_panels instead of failing.
struct MonitorCapabilities {
  uint64_t detected_at_ms = 0;
  // false when the detection itself failed: the panels then read their base
  // columns only and let ClickHouse answer.
  bool detected = false;
  std::set<std::string> tables;   // system.<name>
  std::set<std::string> columns;  // "<table>.<column>"
  // currentUser() of the system context, for the GRANT hints.
  std::string system_user;
  // The server has replicated tables (system.replicas is not empty): the
  // Performance section's Replication chart shows only then. A count, no name.
  bool replicated_tables = false;

  bool has_table(const std::string& table) const { return !detected || tables.count(table) > 0; }
  bool has_column(const std::string& table, const std::string& column) const {
    return detected && columns.count(table + "." + column) > 0;
  }
};

bool detect_monitor_capabilities(clickhouse::Client& system, MonitorCapabilities& out, std::string* error);

// The SETTINGS clause of every Monitoring SELECT.
std::string monitor_settings_sql(int max_execution_time_seconds, uint64_t max_rows_to_read, uint64_t max_result_rows);

// A panel that could not be read, and why:
//   disabled          the system table does not exist (log disabled in the
//                     server config): ClickHouse code 60 / 81
//   not_granted       the account lacks a grant (497); hint names it
//   unsupported       a column this server version lacks (47 / 16)
//   window_too_large  the time budget or the read cap stopped it (159 / 158)
//   readonly_account  the account's profile has readonly = 1 (164): no
//                     query-level limits can be set
//   failed            anything else
struct MonitorPanelIssue {
  std::string panel;
  // The system table it reads (system.<table>).
  std::string table;
  std::string reason;
  std::string message;
  std::string hint;
};

// The reason of an exception thrown by a Monitoring SELECT.
std::string monitor_reason_of(const std::exception& error);
// "GRANT SELECT ON system.<table> TO <user>" (the user quoted when needed).
std::string monitor_grant_hint(const std::string& table, const std::string& user);

struct MonitorClusterNode {
  std::string cluster;
  uint64_t shard_num = 0;
  uint64_t shard_weight = 0;
  uint64_t replica_num = 0;
  std::string host_name;
  std::string host_address;
  uint64_t port = 0;
  bool is_local = false;
  // Absent on servers without these columns.
  std::optional<uint64_t> errors_count;
  std::optional<uint64_t> slowdowns_count;
  std::optional<uint64_t> estimated_recovery_time;
};

// Replicated tables the runner can see, summarised (in-memory columns of
// system.replicas only; the thresholds are Altinity's replica alerts).
struct MonitorReplicationSummary {
  uint64_t tables = 0;
  uint64_t readonly = 0;
  uint64_t session_expired = 0;
  uint64_t max_delay_seconds = 0;
  uint64_t queue_size = 0;
  uint64_t inserts_in_queue = 0;
  uint64_t merges_in_queue = 0;
  uint64_t future_parts_over = 0;    // future_parts > 20
  uint64_t parts_to_check_over = 0;  // parts_to_check > 10
  uint64_t queue_over = 0;           // queue_size > 20
  uint64_t inserts_over = 0;         // inserts_in_queue > 10
  bool truncated = false;
};

struct ExplorerMonitorOverview {
  uint64_t generated_at_ms = 0;
  std::string hostname;
  std::string version;
  std::string timezone;
  std::optional<uint64_t> uptime_seconds;
  // Allowlisted system.asynchronous_metrics and system.metrics values, by name.
  std::map<std::string, double> metrics;
  std::vector<MonitorClusterNode> topology;
  bool topology_truncated = false;
  std::optional<MonitorReplicationSummary> replication;
  // Optional system logs, as detected (the Performance, Queries and Disks
  // sections read them).
  std::map<std::string, bool> logs;
  std::vector<MonitorPanelIssue> unavailable_panels;
};

// Rows of system.clusters kept per response.
constexpr size_t kMonitorTopologyRowLimit = 1000;
// Replicated tables read for the replication summary.
constexpr size_t kMonitorReplicaRowLimit = 10000;

// Server tiles, topology and the replication summary of the runner-visible
// replicated tables. Returns false only when nothing at all could be read.
bool load_explorer_monitor_overview(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const MonitorCapabilities& caps,
    ExplorerMonitorOverview& out,
    std::string* error);

// The allowlists, exposed for the contract tests and the docs.
const std::vector<std::string>& monitor_overview_async_metrics();
const std::vector<std::string>& monitor_overview_metrics();
const std::vector<std::string>& monitor_detected_tables();

// ---------------------------------------------------------------------------
// Performance: bucketed history of the server's system logs
// (/api/explorer/monitor/series). Three SELECTs, one pass each over
// system.metric_log, system.asynchronous_metric_log and narrow columns of
// system.query_log; every name in them comes from the allowlists below, the
// window and the step are integers the handler validated.

// The window, in whole seconds: from is aligned down to the step, to up to
// it, so every request of the same aligned window shares one cache entry.
struct MonitorSeriesWindow {
  uint64_t from_s = 0;
  uint64_t to_s = 0;
  uint32_t step_s = 0;
  // The current second: the bucket still in progress divides its counters
  // by the time it covers, not by the whole step.
  uint64_t now_s = 0;
  // The span asked for, before the alignment widened it by up to two steps.
  uint64_t span_s = 0;
  // query_log is read only when the window spans at most this many seconds
  // (explorer.monitoring.query_log_max_lookback_hours), with this read cap.
  uint64_t query_log_max_span_s = 0;
  uint64_t query_log_max_rows = 0;
};

// The steps the server picks from (seconds): at most kMonitorSeriesMaxPoints
// buckets, never under 10 s (metric_log samples every second).
const std::vector<uint32_t>& monitor_series_steps();
constexpr uint64_t kMonitorSeriesMaxPoints = 300;
uint32_t monitor_series_step_seconds(uint64_t span_seconds);

// A source (one system log) of the series, and how its read went.
//   status  ok | disabled (no such table) | unsupported (metric_log in the
//           transposed layout, or columns missing) | out_of_range (query_log
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

struct ExplorerMonitorSeries {
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
std::vector<std::string> monitor_series_metric_log_names();
const std::vector<std::string>& monitor_series_async_metrics();
std::vector<std::string> monitor_series_query_log_names();

// Reads the three sources. A source that cannot be read is reported in
// out.sources and the others still answer.
void load_explorer_monitor_series(
    clickhouse::Client& system,
    const MonitorCapabilities& caps,
    const MonitorSeriesWindow& window,
    ExplorerMonitorSeries& out);

// The SQL of each source, exposed for the contract tests (no I/O).
std::string monitor_series_metric_log_sql(const MonitorCapabilities& caps, const MonitorSeriesWindow& window,
                                          std::vector<std::string>* names, std::vector<std::string>* missing);
std::string monitor_series_async_sql(const MonitorSeriesWindow& window);
std::string monitor_series_query_log_sql(const MonitorSeriesWindow& window);

// ---------------------------------------------------------------------------
// Queries: the top query shapes of a window (/api/explorer/monitor/queries)
// and one shape's timeline and runs (/api/explorer/monitor/queries/<hash>).
// They read system.query_log with the RUNNER account: ClickHouse grants
// decide, and the runner can already read the same rows in the Query page.
// Two phases: the narrow numbers grouped by normalized_query_hash, then the
// text of the top kMonitorTopQueries only (text costs 6 to 8 times more).
// The monitoring's own reads (log_comment 'chdash-monitoring') are never
// listed; hide_chdash also drops the system account's queries.

constexpr size_t kMonitorTopQueries = 50;
constexpr size_t kMonitorQueryRuns = 20;
// Characters of query text kept per shape in the list, and of the example a
// drill-down opens in the Query page.
constexpr size_t kMonitorQueryTextChars = 4096;
constexpr size_t kMonitorQueryExampleChars = 262144;

// The allowlists: sort ids (each maps to a fixed ORDER BY expression), kinds
// (query_kind values, "other" for the rest) and drill-down run orders.
const std::vector<std::string>& monitor_queries_sorts();
const std::vector<std::string>& monitor_queries_kinds();
const std::vector<std::string>& monitor_query_run_orders();

struct MonitorQueriesRequest {
  // Minute-aligned window, whole seconds.
  uint64_t from_s = 0;
  uint64_t to_s = 0;
  // The current second (the window-too-large estimate counts the last hour).
  uint64_t now_s = 0;
  std::string sort = "total_time";
  std::string kind = "all";
  bool hide_chdash = true;
  // The system account's user, excluded when hide_chdash (from the
  // capability detection; empty when unknown).
  std::string system_user;
  // The runner account's user, for the GRANT hint.
  std::string runner_user;
  // explorer.monitoring.query_log_max_rows: the read cap of each SELECT.
  uint64_t max_rows = 50'000'000;
  // Drill-down only: the shape, the order of its runs and the timeline step.
  uint64_t hash = 0;
  std::string order = "duration";
  uint32_t step_s = 0;
};

// One SELECT's cost, and why it failed (status as MonitorPanelIssue.reason,
// "ok" when it answered).
struct MonitorQueryRead {
  std::string status = "ok";
  std::string message;
  uint64_t rows_read = 0;
  uint64_t bytes_read = 0;
  uint64_t elapsed_ms = 0;
};

struct MonitorQueryShape {
  uint64_t hash = 0;
  std::string kind;
  uint64_t calls = 0;
  uint64_t errors = 0;
  double total_ms = 0;
  double avg_ms = 0;
  double p95_ms = 0;
  double max_ms = 0;
  uint64_t read_rows = 0;
  uint64_t read_bytes = 0;
  uint64_t written_rows = 0;
  uint64_t result_rows = 0;
  double avg_memory = 0;
  uint64_t max_memory = 0;
  std::vector<std::string> users;
  std::vector<std::string> tables;
  uint64_t first_seen_s = 0;
  uint64_t last_seen_s = 0;
  // Phase 2 (absent when it failed).
  bool has_text = false;
  std::string normalized;
  std::string example;
  bool example_truncated = false;
  std::string last_query_id;
};

// The window's figures over every shape, not only the top ones.
struct MonitorQueriesTotals {
  uint64_t calls = 0;
  uint64_t errors = 0;
  double total_ms = 0;
  uint64_t read_bytes = 0;
  uint64_t shapes = 0;
};

// status: ok | disabled | not_granted | unsupported | window_too_large |
// readonly_account | failed. window_too_large carries a suggested span.
struct ExplorerMonitorQueries {
  uint64_t generated_at_ms = 0;
  MonitorQueriesRequest request;
  std::string status = "ok";
  std::string message;
  std::string hint;
  uint64_t suggested_span_s = 0;
  MonitorQueryRead aggregate;
  MonitorQueryRead text;
  MonitorQueriesTotals totals;
  std::vector<MonitorQueryShape> queries;
};

struct MonitorQueryRun {
  uint64_t event_time_ms = 0;
  std::string query_id;
  std::string user;
  std::string type;
  uint64_t duration_ms = 0;
  uint64_t read_rows = 0;
  uint64_t read_bytes = 0;
  uint64_t result_rows = 0;
  uint64_t written_rows = 0;
  uint64_t memory_usage = 0;
  uint64_t cpu_us = 0;
  int64_t exception_code = 0;
  std::string exception;
};

// One shape over the whole window.
struct MonitorQuerySummary {
  uint64_t calls = 0;
  uint64_t errors = 0;
  double total_ms = 0;
  double p95_ms = 0;
  double max_ms = 0;
  uint64_t read_rows = 0;
  uint64_t read_bytes = 0;
  uint64_t max_memory = 0;
  double cpu_seconds = 0;
};

struct ExplorerMonitorQuery {
  uint64_t generated_at_ms = 0;
  MonitorQuerySummary summary;
  MonitorQueriesRequest request;
  std::string status = "ok";
  std::string message;
  std::string hint;
  uint64_t suggested_span_s = 0;
  // Bucket starts (seconds) and, per series, one value per bucket (NaN: no
  // run in it): calls, errors, p50_ms, p95_ms, read_rows, max_memory,
  // cpu_seconds.
  std::vector<uint64_t> buckets;
  std::map<std::string, std::vector<double>> series;
  std::vector<MonitorQueryRun> runs;
  // The latest run's text (kMonitorQueryExampleChars at most).
  std::string example;
  bool example_truncated = false;
  std::string example_query_id;
  std::string normalized;
  std::string kind;
  MonitorQueryRead timeline_read;
  MonitorQueryRead runs_read;
  MonitorQueryRead example_read;
};

// Phase 1 and phase 2. Returns false only for a failure outside ClickHouse
// (a broken connection: the caller drops the client); a ClickHouse error is
// a status of the answer.
bool load_explorer_monitor_queries(clickhouse::Client& runner, const MonitorCapabilities& caps,
                                   const MonitorQueriesRequest& request, ExplorerMonitorQueries& out, std::string* error);
bool load_explorer_monitor_query(clickhouse::Client& runner, const MonitorCapabilities& caps,
                                 const MonitorQueriesRequest& request, ExplorerMonitorQuery& out, std::string* error);

// The SQL, exposed for the contract tests (no I/O).
std::string monitor_queries_top_sql(const MonitorQueriesRequest& request);
std::string monitor_queries_text_sql(const MonitorQueriesRequest& request, const std::vector<uint64_t>& hashes);
std::string monitor_query_timeline_sql(const MonitorQueriesRequest& request);
std::string monitor_query_runs_sql(const MonitorQueriesRequest& request);
std::string monitor_query_example_sql(const MonitorQueriesRequest& request);
// The span (seconds) suggested when a window read too many rows: the rate
// the last hour logged, scaled to fit the read cap, snapped to a round span.
uint64_t monitor_queries_suggested_span(uint64_t span_s, uint64_t rows_last_hour, uint64_t max_rows);

} // namespace chdash
