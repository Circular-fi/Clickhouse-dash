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

// The System page (docs/system.md): the selected
// server's health, read from its system tables. Every SELECT is fixed and
// built here; a request only picks the host (and, in later sections, a
// clamped time range and allowlisted enums). Every SELECT ends with
// monitor_settings_sql(): read-only, a time budget and a read cap that throw
// rather than return a silently partial answer, and the 'chdash-system'
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

class ChExecutor;

bool detect_monitor_capabilities(ChExecutor& system, MonitorCapabilities& out, std::string* error);

// The optional system tables that the detection looks for (system_monitor_caps.cpp), for the contract tests and the docs.
const std::vector<std::string>& monitor_detected_tables();

// The SETTINGS clause of every System SELECT.
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

// The reason of an exception thrown by a System SELECT.
std::string monitor_reason_of(const std::exception& error);
// "GRANT SELECT ON system.<table> TO <user>" (the user quoted when needed). `user` is the account that did the read: the system account for
// every panel but the Queries, which read with the runner account. When the user is not known, `account` names it in the statement
// ("<system user>", "<runner user>").
std::string monitor_grant_hint(const std::string& table, const std::string& user, const std::string& account = "system user");

} // namespace chdash
