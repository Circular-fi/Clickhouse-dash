#pragma once

// The seven MCP tools (docs/mcp.md). They reach ClickHouse only through
// McpDatabase, so the native tests drive them with a fake database.

#include "mcp_protocol.hpp"

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace chdash {

// The guard rails of one ClickHouse query (docs/mcp.md, "Per-request guard rails").
struct McpDbLimits {
  int64_t max_rows = 1000;
  int64_t max_bytes = 1048576;
  int64_t timeout_seconds = 30;
  int64_t max_memory_bytes = 1073741824;
  int64_t max_rows_to_read = 0;  // 0 = none
  std::string key_id;            // for log_comment
};

struct McpDbColumn {
  std::string name;
  std::string type;
};

struct McpDbResult {
  std::vector<McpDbColumn> columns;
  // Each cell is JSON text (a number, a string with its quotes, null, an array ...).
  std::vector<std::vector<std::string>> rows;
  // Rows or bytes were cut by the limits.
  bool truncated = false;
  int64_t elapsed_ms = 0;
};

// code: timeout, permission_denied, readonly, memory_limit, read_limit, host_unavailable, query_failed.
class McpDbError : public std::runtime_error {
public:
  McpDbError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}
  const std::string& code() const { return code_; }

private:
  std::string code_;
};

class McpDatabase {
public:
  virtual ~McpDatabase() = default;
  // Runs one statement as the MCP identity of `host` with readonly=1 and the limits.
  // Throws McpDbError. Never returns more than limits.max_rows rows.
  virtual McpDbResult run(const std::string& host, const std::string& sql, const McpDbLimits& limits) = 0;
  // true, false or unknown.
  virtual std::optional<bool> host_healthy(const std::string& host) = 0;
};

struct McpHostInfo {
  std::string name;
  std::string label;
};

struct McpToolsConfig {
  std::vector<McpHostInfo> hosts;  // the hosts that have an mcp_uri
  int64_t max_rows = 1000;
  int64_t max_result_bytes = 1048576;
  int64_t query_timeout_seconds = 30;
  int64_t max_sql_bytes = 65536;
  int64_t max_memory_bytes = 1073741824;
  int64_t max_rows_to_read = 0;
};

// Schema tools read this many rows of the system tables (the key's own row cap does not apply:
// the scope filters after the read) and return at most kMcpSchemaOutputRows tables.
inline constexpr int64_t kMcpSchemaReadRows = 20000;
inline constexpr size_t kMcpSchemaOutputRows = 2000;
inline constexpr int64_t kMcpSchemaReadBytes = 64LL * 1024 * 1024;
inline constexpr size_t kMcpCreateQueryMaxBytes = 64 * 1024;

class McpTools : public McpToolBackend {
public:
  McpTools(McpToolsConfig config, McpDatabase& database) : config_(std::move(config)), db_(database) {}

  McpToolOutcome call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments,
                           int64_t now) override;

private:
  McpToolsConfig config_;
  McpDatabase& db_;
};

} // namespace chdash
