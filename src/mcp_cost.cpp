#include "mcp_cost.hpp"

#include "system_monitor.hpp"
#include "system_monitor_internal.hpp"

#include <algorithm>

namespace chdash {

using namespace monitor_internal;

namespace {

// The time of one read, as for a section of System > Queries: a window of a busy server ends with window_too_large instead.
constexpr int kCostSeconds = 15;
// The (user, tool) pairs that one read groups: far more than a key has (a user or two, 61 tools at most).
constexpr uint64_t kCostGroups = 10000;

int64_t window_seconds(std::string_view name) { return name == "7d" ? 7 * 86400 : 86400; }

}  // namespace

std::vector<std::string> mcp_cost_windows() { return {"24h", "7d"}; }

std::optional<McpCostWindow> mcp_cost_window(std::string_view name, int64_t max_lookback_hours, int64_t now_s) {
  if (name != "24h" && name != "7d") return std::nullopt;
  McpCostWindow window;
  window.name = std::string(name);
  // To the end of the current minute: a second request in the same minute reads the same window (the cache keeps it 60 s).
  window.to_s = now_s - now_s % 60 + 60;
  const int64_t span = window_seconds(name);
  const int64_t cap = std::max<int64_t>(1, max_lookback_hours) * 3600;
  window.clamped = span > cap;
  window.from_s = window.to_s - std::min(span, cap);
  return window;
}

std::string mcp_cost_sql(const McpCostWindow& window, uint64_t max_rows_to_read) {
  // The rows of the statements of the key: finished or failed, the first statement of each query only (a distributed query logs its
  // parts on the other servers, with is_initial_query = 0). The prefix is read first (PREWHERE): the other columns only for its rows.
  // QUERY_WAS_CANCELLED (394, 735): a statement that ChDash stopped once it had what the call asked for (the rows of the key's cap).
  return "SELECT toString(user), splitByChar('/', query_id)[3] AS tool, toString(count()), "
         "toString(countIf(type != 'QueryFinish' AND exception_code NOT IN (394, 735))), "
         "toString(countIf(type != 'QueryFinish' AND exception_code IN (394, 735))), "
         "toString(sum(read_rows)), toString(sum(read_bytes)), toString(sum(result_rows)), toString(sum(result_bytes)), "
         "toString(sum(query_duration_ms)), toString(sum(ProfileEvents['OSCPUVirtualTimeMicroseconds'])), toString(max(memory_usage)), " +
         query_log_object_list_sql("tables", "key_tables", kMcpCostTables + 1) +
         " FROM system.query_log PREWHERE startsWith(query_id, {chdash_prefix:String}) WHERE " +
         query_log_time_predicate(window.from_s, window.to_s) +
         " AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart') AND is_initial_query"
         " GROUP BY user, tool ORDER BY user, tool LIMIT " + std::to_string(kMcpCostMaxRows + 1) +
         monitor_settings_sql(kCostSeconds, max_rows_to_read, kMcpCostMaxRows + 2) +
         ", max_rows_to_group_by = " + std::to_string(kCostGroups) + ", group_by_overflow_mode = 'any'";
}

McpCost mcp_read_cost(ChExecutor& runner, const std::string& key_id, const McpCostWindow& window, uint64_t max_rows_to_read, int64_t now_s) {
  McpCost out;
  out.window = window;
  out.read_at_s = now_s;
  bool tables_read = false;
  const BoundedRead read = runner.bounded_select(
      mcp_cost_sql(window, max_rows_to_read),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          if (!tables_read && block.GetColumnCount() > 13) {
            tables_read = true;
            for (const std::string& line : split_lines(text(block, 13, row))) {
              const size_t tab = line.rfind('\t');
              if (tab == std::string::npos || tab == 0) continue;
              out.tables.emplace_back(line.substr(0, tab), u64(line.substr(tab + 1)));
            }
          }
          if (out.rows.size() >= kMcpCostMaxRows) {
            out.rows_truncated = true;
            continue;
          }
          McpCostRow item;
          item.user = text(block, 0, row);
          item.tool = text(block, 1, row);
          uint64_t* counts[] = {&item.statements, &item.failed, &item.canceled, &item.read_rows, &item.read_bytes, &item.result_rows,
                                &item.result_bytes, &item.duration_ms, &item.cpu_us, &item.memory_peak_bytes};
          for (size_t i = 0; i < 10; ++i) *counts[i] = u64(text(block, i + 2, row));
          out.rows.push_back(std::move(item));
        }
      },
      ChParams{{"chdash_prefix", mcp_query_id_prefix(key_id)}});
  if (out.tables.size() > kMcpCostTables) {
    out.tables.resize(kMcpCostTables);
    out.tables_truncated = true;
  }
  out.log_rows_read = read.read_rows;
  out.log_bytes_read = read.read_bytes;
  out.log_elapsed_ms = read.elapsed_ms;
  return out;
}

}  // namespace chdash
