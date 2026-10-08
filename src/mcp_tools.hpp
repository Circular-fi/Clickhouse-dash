#pragma once

// The MCP tools (docs/mcp.md): schema, read, observability and SQL. They reach ClickHouse only through
// McpDatabase, so the native tests drive them with a fake database.

#include "mcp_protocol.hpp"

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
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

// One call of the API of ChDash itself, for an API tool (mcp_api_tools.cpp). The server answers it through its
// own listening port; the tests answer it with a fake.
struct McpApiRequest {
  std::string method;  // GET or POST
  std::string path;
  std::vector<std::pair<std::string, std::string>> query;  // a name can repeat
  std::string body;                                        // POST: JSON
  int64_t timeout_seconds = 30;
  int64_t max_bytes = 1048576;  // an answer above it is `too_large`
};

struct McpApiResponse {
  int status = 0;  // 0: the call did not reach the server (`error` says why)
  std::string body;
  bool too_large = false;
  std::string error;
};

class McpApiClient {
public:
  virtual ~McpApiClient() = default;
  virtual McpApiResponse call(const McpApiRequest& request) = 0;
};

struct McpHostInfo {
  std::string name;
  std::string label;
};

// Where the OpenTelemetry data lives (the traces, logs and metrics settings of the config). A signal that
// is off answers `not_enabled`.
struct McpObservabilityConfig {
  bool traces = false;
  std::string traces_database = "otel";
  std::string traces_table = "otel_traces";
  std::string traces_index_table;  // optional: the bounds of a trace (TraceId, Start, End)
  bool logs = false;
  std::string logs_database = "otel";
  std::string logs_table = "otel_logs";
  bool metrics = false;
  std::string metrics_database = "otel";
  std::string metrics_prefix = "otel_metrics";
  int64_t max_lookback_minutes = 7 * 24 * 60;
};

struct McpToolsConfig {
  std::vector<McpHostInfo> hosts;  // the hosts that have an mcp_uri
  McpObservabilityConfig observability;
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
  McpTools(McpToolsConfig config, McpDatabase& database, McpApiClient* api = nullptr)
      : config_(std::move(config)), db_(database), api_(api) {}

  McpToolOutcome call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments,
                           int64_t now) override;

private:
  McpToolsConfig config_;
  McpDatabase& db_;
  McpApiClient* api_;
};

} // namespace chdash
