#include "system_monitor.hpp"

#include "ch_executor.hpp"
#include "system_monitor_internal.hpp"

#include <clickhouse/exceptions.h>

#include <algorithm>

namespace chdash {

using namespace monitor_internal;

namespace {

// Columns of system tables that changed across ClickHouse versions. They are read only
// when detected. asynchronous_metric_log.key is a column of ClickHouse 26.8. Per-disk
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

} // namespace

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
    case 241:  // MEMORY_LIMIT_EXCEEDED
    case 396:  // TOO_MANY_ROWS_OR_BYTES
      return "window_too_large";
    case 164:  // READONLY
      return "readonly_account";
    default:
      return "failed";
  }
}

std::string monitor_grant_hint(const std::string& table, const std::string& user, const std::string& account) {
  std::string name = user;
  const bool plain = !name.empty() && std::all_of(name.begin(), name.end(), [](char ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_';
  });
  if (name.empty()) {
    name = "<" + account + ">";
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

bool detect_monitor_capabilities(ChExecutor& system, MonitorCapabilities& out, std::string* error) {
  out = MonitorCapabilities{};
  out.detected_at_ms = monitor_now_ms();
  try {
    system.select("SELECT toString(currentUser())" + monitor_settings_sql(5, 10, 1), [&](const clickhouse::Block& block) {
      if (block.GetRowCount() > 0) out.system_user = text(block, 0, 0);
    });
    std::vector<std::string> tables = monitor_detected_tables();
    for (const auto& [table, columns] : detected_columns()) {
      (void)columns;
      tables.push_back(table);
    }
    system.select(
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
    system.select(
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
    // Whether any replicated table exists. This is a count, not a name. The
    // Performance section's Replication chart shows only in that case. When it cannot be read,
    // the chart stays hidden. The other values are still detected.
    try {
      system.select("SELECT toString(count() > 0) FROM system.replicas" + monitor_settings_sql(5, 1000000, 1),
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

} // namespace chdash
