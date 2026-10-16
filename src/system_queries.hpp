#pragma once

#include "system_monitor.hpp"

#include <cstdint>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace chdash {

class AclView;
class ChExecutor;

// ---------------------------------------------------------------------------
// Queries: the top query shapes of a window (/api/system/queries).
// The timeline and the runs of one shape (/api/system/queries/<hash>).
// They read system.query_log with the RUNNER account. ClickHouse grants decide what the account reads.
// The runner can already read the same rows in the Query page.
//
// The read has two phases. Phase 1 groups the narrow numbers by normalized_query_hash.
// Phase 2 reads the text of the top kMonitorTopQueries shapes only, because text costs 6 to 8 times more.
//
// The System page's own reads (log_comment 'chdash-system') are never listed.
// hide_chdash also drops the queries of the system account.
//
// The list has these filters: the statement kind, the shapes with or without failed runs, and one user.
// The user is a bound query parameter, {chdash_user:String}. It is never written into the SQL text.
//
// One database and / or one table a shape involves filters the list.
// The filters use query_log's `databases` and `tables` arrays. A shape is kept whole when one of its runs involved it.
// The bound parameters are {chdash_database:String} and {chdash_table:String}.

constexpr size_t kMonitorTopQueries = 50;
// The users of the window that the user filter offers. The most active users come first.
constexpr size_t kMonitorQueryUsers = 50;
// The longest user name the user filter accepts (bytes).
constexpr size_t kMonitorQueryUserMaxBytes = 256;
// The databases and tables of the window that their filters offer. The most involved come first.
// Only the names that the runner can see are offered. They come from the first kMonitorQueryObjectCandidates of the read.
constexpr size_t kMonitorQueryObjects = 50;
constexpr size_t kMonitorQueryObjectCandidates = 200;
// The longest database or table ("database.table") filter value (bytes).
constexpr size_t kMonitorQueryObjectMaxBytes = 512;
constexpr size_t kMonitorQueryRuns = 20;
// This limit sets the query text characters that the list keeps for each shape.
// It also sets the characters of the example that a drill-down opens in the Query page.
constexpr size_t kMonitorQueryTextChars = 4096;
constexpr size_t kMonitorQueryExampleChars = 262144;

// These are the allowlists. They hold the sort ids, and each one maps to a fixed ORDER BY expression.
// They hold the kinds, which are query_kind values, with "other" for the rest.
// They hold the error filters, and each one maps to a fixed HAVING.
// They hold the drill-down run orders.
const std::vector<std::string>& monitor_queries_sorts();
const std::vector<std::string>& monitor_queries_kinds();
const std::vector<std::string>& monitor_queries_error_filters();
const std::vector<std::string>& monitor_query_run_orders();
// The list accepts a user filter value of 1 to kMonitorQueryUserMaxBytes bytes.
// The value holds no control character. ClickHouse user names are plain text.
bool monitor_queries_user_valid(const std::string& user);
// A database filter value has 1 to kMonitorQueryObjectMaxBytes bytes. It holds no control character.
// A table filter value follows the same rule. It is written as query_log writes it, "database.table".
// The dot has text on both sides. A name may hold dots of its own.
bool monitor_queries_database_valid(const std::string& database);
bool monitor_queries_table_valid(const std::string& table);

struct MonitorQueriesRequest {
  // Minute-aligned window, whole seconds.
  uint64_t from_s = 0;
  uint64_t to_s = 0;
  // The current second (the window-too-large estimate counts the last hour).
  uint64_t now_s = 0;
  std::string sort = "total_time";
  std::string kind = "all";
  // all | with (shapes with a failed run) | without (shapes without one).
  std::string errors = "all";
  // One user's queries (empty: every user). A bound query parameter.
  std::string user;
  // The shapes that involve one database / one table ("database.table"). Empty means any.
  // These are bound query parameters.
  std::string database;
  std::string table;
  bool hide_chdash = true;
  // The user of the system account. The code excludes it when hide_chdash is set.
  // The value comes from the capability detection. It is empty when the user is unknown.
  std::string system_user;
  // The runner account's user, for the GRANT hint.
  std::string runner_user;
  // system.query_log_max_rows: the read cap of each SELECT.
  uint64_t max_rows = 50'000'000;
  // Drill-down only: the shape, the order of its runs and the timeline step.
  uint64_t hash = 0;
  std::string order = "duration";
  uint32_t step_s = 0;
};

// The cost of one SELECT, and the reason why it failed.
// The reason is the status, as MonitorPanelIssue.reason. The status is "ok" when the SELECT answered.
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

// The figures of the window cover every shape. They do not cover only the top shapes.
struct MonitorQueriesTotals {
  uint64_t calls = 0;
  uint64_t errors = 0;
  double total_ms = 0;
  uint64_t read_bytes = 0;
  uint64_t shapes = 0;
  // The window has more shapes than phase 1 keeps. The totals count only the first shapes.
  bool shapes_capped = false;
};

// status: ok | disabled | not_granted | unsupported | window_too_large |
// readonly_account | failed. window_too_large carries a suggested span.
struct SystemMonitorQueries {
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
  // The users of the listed rows of the window. They come from the same read and the same filters as the shapes.
  // Each user has a query count. The most active users come first.
  // The list holds kMonitorQueryUsers entries at most.
  std::vector<std::pair<std::string, uint64_t>> users;
  // The databases and tables ("database.table") that the listed rows of the window involve.
  // Each one has its run count. The most involved come first. Only the names that the runner can see are listed.
  // The list holds kMonitorQueryObjects entries at most for each.
  std::vector<std::pair<std::string, uint64_t>> databases;
  std::vector<std::pair<std::string, uint64_t>> tables;
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

struct SystemMonitorQuery {
  uint64_t generated_at_ms = 0;
  MonitorQuerySummary summary;
  MonitorQueriesRequest request;
  std::string status = "ok";
  std::string message;
  std::string hint;
  uint64_t suggested_span_s = 0;
  // The bucket starts, in seconds. For each series there is one value per bucket. NaN means that no run is in the bucket.
  // The series are: calls, errors, p50_ms, p95_ms, read_rows, max_memory and cpu_seconds.
  std::vector<uint64_t> buckets;
  std::map<std::string, std::vector<double>> series;
  std::vector<MonitorQueryRun> runs;
  // The text of the latest run. The text has kMonitorQueryExampleChars characters at most.
  std::string example;
  bool example_truncated = false;
  std::string example_query_id;
  std::string normalized;
  std::string kind;
  MonitorQueryRead timeline_read;
  MonitorQueryRead runs_read;
  MonitorQueryRead example_read;
};

// Phase 1 and phase 2 run in this call.
// The function returns false only for a failure outside ClickHouse, such as a broken connection.
// The caller then drops the client. A ClickHouse error is a status of the answer.
bool load_system_monitor_queries(ChExecutor& runner, AclView& runner_acl, const MonitorCapabilities& caps,
                                   const MonitorQueriesRequest& request, SystemMonitorQueries& out, std::string* error);
bool load_system_monitor_query(ChExecutor& runner, const MonitorCapabilities& caps,
                                 const MonitorQueriesRequest& request, SystemMonitorQuery& out, std::string* error);

// The SQL is exposed for the contract tests. It does no I/O.
// The SQL of the list names the user filter as {chdash_user:String}. monitor_queries_params gives the value of that parameter.
std::vector<std::pair<std::string, std::string>> monitor_queries_params(const MonitorQueriesRequest& request);
std::string monitor_queries_top_sql(const MonitorQueriesRequest& request);
std::string monitor_queries_text_sql(const MonitorQueriesRequest& request, const std::vector<uint64_t>& hashes);
std::string monitor_query_timeline_sql(const MonitorQueriesRequest& request);
std::string monitor_query_runs_sql(const MonitorQueriesRequest& request);
std::string monitor_query_example_sql(const MonitorQueriesRequest& request);
// The span in seconds is suggested when a window read has too many rows.
// The span uses the rate that the last hour logged. It is scaled to fit the read cap. Then it snaps to a round span.
uint64_t monitor_queries_suggested_span(uint64_t span_s, uint64_t rows_last_hour, uint64_t max_rows);

} // namespace chdash
