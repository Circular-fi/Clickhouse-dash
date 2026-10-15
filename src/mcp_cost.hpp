#pragma once

// The ClickHouse cost of an MCP key (docs/mcp.md, "The ClickHouse cost of a key"). Every statement that ChDash sends for a call of a
// key is named chdash-mcp/<key id>/<tool>/<uuid>: its query_id, a field of the statement that no setting and no SQL changes, and that a
// user whose profile takes no setting (readonly = 1) gets too. The tools that build their SQL name their statements (api_mcp.cpp); an
// API tool names the statements of the route that it calls (the scope of the call, Server::make_context). system.query_log of the host
// of the key then says what the statements of the key cost: GET /api/mcp/keys/<id>/cost reads it on demand, with the runner account and
// the bounds of System > Queries (api_mcp_cost.cpp).

#include "ch_executor.hpp"
#include "secure_random.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

// "chdash-mcp/<key id>/": no key id holds a "/" (the name of a key of the configuration, or ui_ and 12 hexadecimal digits).
inline std::string mcp_query_id_prefix(std::string_view key_id) { return "chdash-mcp/" + std::string(key_id) + "/"; }

// The query_id of one statement of a call: the prefix of its key, its tool, and a UUID (two statements that run at once never share an
// id: ClickHouse would refuse the second one).
inline std::string mcp_query_id(std::string_view key_id, std::string_view tool) {
  return mcp_query_id_prefix(key_id) + std::string(tool.empty() ? std::string_view("-") : tool) + "/" + random_uuid_v4();
}

// A window of the cost: the last hour, 6 hours, 24 hours or 7 days, to the end of the current minute, cut to the longest window of System >
// Queries (system.query_log_max_lookback_hours; `clamped` then).
struct McpCostWindow {
  std::string name;
  int64_t from_s = 0;
  int64_t to_s = 0;
  bool clamped = false;
};
std::vector<std::string> mcp_cost_windows();
std::optional<McpCostWindow> mcp_cost_window(std::string_view name, int64_t max_lookback_hours, int64_t now_s);

// The statements of a key in a window, by the ClickHouse user that ran them and the tool that sent them.
struct McpCostRow {
  std::string user;
  std::string tool;
  uint64_t statements = 0;
  uint64_t failed = 0;
  uint64_t canceled = 0;  // stopped by ChDash once it had what a call asked for (QUERY_WAS_CANCELLED): not a failure
  uint64_t read_rows = 0;
  uint64_t read_bytes = 0;
  uint64_t result_rows = 0;
  uint64_t result_bytes = 0;
  uint64_t duration_ms = 0;
  uint64_t cpu_us = 0;
  uint64_t memory_peak_bytes = 0;
};

struct McpCost {
  McpCostWindow window;
  int64_t read_at_s = 0;
  std::vector<McpCostRow> rows;
  bool rows_truncated = false;
  // The tables that the statements read ("db.table") and how many statements read each, the most read first.
  std::vector<std::pair<std::string, uint64_t>> tables;
  bool tables_truncated = false;
  // What the read of system.query_log cost.
  uint64_t log_rows_read = 0;
  uint64_t log_bytes_read = 0;
  uint64_t log_elapsed_ms = 0;
};

inline constexpr size_t kMcpCostMaxRows = 500;
inline constexpr size_t kMcpCostTables = 10;

// The one statement that reads the cost of a key: one scan of the window of system.query_log (the prefix of the key is the bound parameter
// chdash_prefix), grouped by user and tool, with the bounds of System > Queries.
std::string mcp_cost_sql(const McpCostWindow& window, uint64_t max_rows_to_read);

// Reads the cost of `key_id` in `window`. Throws what ClickHouse throws (monitor_reason_of tells why).
McpCost mcp_read_cost(ChExecutor& runner, const std::string& key_id, const McpCostWindow& window, uint64_t max_rows_to_read, int64_t now_s);

}  // namespace chdash
