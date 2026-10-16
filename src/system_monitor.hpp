#pragma once

#include <clickhouse/block.h>

#include <cstdint>
#include <exception>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace chdash {

// The System page (docs/system.md). It shows the health of the selected server, read from its system tables.
// Every SELECT is fixed and built here. A request only picks the host. In later sections, a request also picks
// a clamped time range and allowlisted enums.
// Every SELECT ends with monitor_settings_sql(). It sets read-only mode, a time budget and a read cap.
// These settings make the query throw an error, not return a silently partial answer.
// The 'chdash-system' log_comment keeps the load of ChDash auditable in system.query_log.

// What the server exposes. ChDash detects this once for each host and caches the result for 10 min. The result holds
// the optional system tables, and the allowlisted columns of the system tables
// whose schema changed across ClickHouse versions. A panel whose table or
// columns are missing is reported in unavailable_panels. It does not fail.
struct MonitorCapabilities {
  uint64_t detected_at_ms = 0;
  // false when the detection itself failed. The panels then read their base
  // columns only, and ClickHouse answers.
  bool detected = false;
  std::set<std::string> tables;   // system.<name>
  std::set<std::string> columns;  // "<table>.<column>"
  // currentUser() of the system context. It is used for the GRANT hints.
  std::string system_user;
  // The server has replicated tables (system.replicas is not empty). The
  // Performance section's Replication chart shows only in that case. This is a count, not a name.
  bool replicated_tables = false;

  bool has_table(const std::string& table) const { return !detected || tables.count(table) > 0; }
  bool has_column(const std::string& table, const std::string& column) const {
    return detected && columns.count(table + "." + column) > 0;
  }
};

class ChExecutor;

bool detect_monitor_capabilities(ChExecutor& system, MonitorCapabilities& out, std::string* error);

// The optional system tables that the detection looks for (system_monitor_caps.cpp). The contract tests and the docs use them.
const std::vector<std::string>& monitor_detected_tables();

// The SETTINGS clause of every System SELECT.
std::string monitor_settings_sql(int max_execution_time_seconds, uint64_t max_rows_to_read, uint64_t max_result_rows);

// A panel that cannot be read, and the reason:
//   disabled          the system table does not exist (the log is disabled in the
//                     server config): ClickHouse code 60 / 81
//   not_granted       the account lacks a grant (497). The hint names the grant.
//   unsupported       this server version lacks a column (47 / 16)
//   window_too_large  the time budget or the read cap stopped the query (159 / 158)
//   readonly_account  the profile of the account has readonly = 1 (164). No
//                     query-level limits can be set.
//   failed            any other error
struct MonitorPanelIssue {
  std::string panel;
  // The system table it reads (system.<table>).
  std::string table;
  std::string reason;
  std::string message;
  std::string hint;
};

// The reason of an exception thrown by a System SELECT.
std::string monitor_reason_of(const std::exception& error);
// "GRANT SELECT ON system.<table> TO <user>" (the user is quoted when needed). `user` is the account that did the read.
// This is the system account for every panel, except the Queries panel. The Queries panel reads with the runner account.
// When the user is not known, `account` names it in the statement ("<system user>", "<runner user>").
std::string monitor_grant_hint(const std::string& table, const std::string& user, const std::string& account = "system user");

} // namespace chdash
