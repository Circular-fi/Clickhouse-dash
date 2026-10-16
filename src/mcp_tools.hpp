#pragma once

// The MCP tools (docs/mcp.md): schema, read, observability, SQL and the analysis of the keys.
// The tools reach ClickHouse only through McpDatabase. They reach the usage, the rate limit and the cost only through McpAnalysis.
// So the native tests drive the tools with fakes.

#include "mcp_protocol.hpp"
#include "mcp_usage.hpp"

#include <cstdint>
#include <map>
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
  std::string key_id;            // for log_comment and the query_id
  std::string tool;              // the tool of the call: the query_id of its statements (mcp_cost.hpp)
  // agent.caller of the baggage of the call (mcp_trace.hpp). It is the log_comment of the statements.
  // The cost of a statement names the agent. It is never a permission. The value is empty when the call has none.
  std::string agent_caller;
  // Run with the system user of the host, not with the MCP user. The OpenTelemetry tools read their tables as the pages do.
  bool as_system = false;
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

// code: timeout, permission_denied, readonly, memory_limit, read_limit, unavailable, query_failed.
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

// One call of the API of ChDash itself, for an API tool (mcp_api_tools.cpp).
// The server runs the handler of the route in the process (Server::call_mcp_api).
// The tests answer the call with a fake.
struct McpApiRequest {
  std::string method;  // GET or POST
  std::string path;
  std::vector<std::pair<std::string, std::string>> query;  // a name can repeat
  std::string body;                                        // POST: JSON
  int64_t timeout_seconds = 30;
  int64_t max_bytes = 1048576;  // an answer above it is `too_large`
  std::string key_id;           // the key that made the call: the audit and the label of the statements
  std::string tool;             // the tool that made the call: with the key, the query_id of the statements (mcp_cost.hpp)
  std::string agent_caller;     // agent.caller of the call: the log_comment of the statements
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

// The analysis tools (mcp_tools_analysis.cpp) ask the server for three things.
// They ask for the state of the rate limit of a key, the usage of the keys, and the ClickHouse cost of a key.
// The tools never reach Server. api_mcp.cpp implements these calls, with the usage, the limiter and the cost cache.
// The native tests answer the calls with a fake. A failure is a McpAnalysisError. The tool turns it into its own error.
//
// A cap that a key meets has a source. The source shows what binds the cap.
// It is `key` (its own limit), `mcp` (the configuration of MCP), or `clickhouse` (the settings profile of the MCP user of its host).
// It is `both` when the last two are equal.
struct McpAnalysisCap {
  int64_t value = 0;
  std::string source = "mcp";
};

// The server knows these limits of a key. The tools do not. The tools know the configuration of MCP and the key.
struct McpAnalysisLimits {
  // The name of this ChDash in the usage. The value is empty when the usage is off, because an instance has a name only then.
  std::string instance;
  // The bucket of the key on this instance. The call in progress has already taken its token.
  McpRateStatus rate;
  // The largest `max_rows` and `timeout_seconds` of a key of its host. Each value is the smaller of the configuration and the profile of the MCP user.
  McpAnalysisCap max_rows;
  McpAnalysisCap timeout_seconds;
};

// code: not_enabled (the usage is off, or reading all the keys), invalid_argument.
class McpAnalysisError : public std::runtime_error {
public:
  McpAnalysisError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}
  const std::string& code() const { return code_; }

private:
  std::string code_;
};

class McpAnalysis {
public:
  virtual ~McpAnalysis() = default;
  // The configuration enables the usage of the keys, and the reading of all of it.
  virtual McpToolAvailability availability() const = 0;
  // The windows of the usage that its retention keeps. The windows are 1h, 6h, 24h, then 7d, 30d, 90d and 365d, as far as it goes.
  // The list is empty when the usage is off.
  virtual std::vector<std::string> usage_windows() const = 0;
  virtual McpAnalysisLimits limits(const McpKey& key) = 0;
  // The JSON object of the usage of the key in `window`, as the page gives it (mcp_usage.hpp).
  // Every instance is summed, or only the instances that `query` names.
  //
  virtual std::string my_usage(const McpKey& key, const std::string& window, const McpUsageDetailQuery& query, int64_t now) = 0;
  // The JSON object of what the statements of the key cost ClickHouse, for the window of the usage.
  // The page's cost reads 1h, 6h, 24h and 7d. A longer window reads 7d, and the object says so.
  // It never throws for a cost that cannot be read. Its `status` says why.
  //
  // The call runs outside the scope of the MCP call. So its own read of system.query_log is not a statement of the key.
  virtual std::string my_cost(const McpKey& key, const std::string& window, int64_t now) = 0;
  // The JSON object of the usage of every key of every instance in `window`, cut and grouped by `query`. It never holds a cost.
  virtual std::string all_usage(const std::string& window, const McpUsageOverviewQuery& query, int64_t now) = 0;
};

struct McpHostInfo {
  std::string name;
  std::string label;
};

// Where the OpenTelemetry data lives. These are the traces, logs and metrics settings of the configuration.
// A signal that is off answers `not_enabled`.
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
  // traces.service_allowlist is the one allowlist of the three signals (otel_allowlist.hpp).
  // The tools read with the system user. The allowlist keeps them within what the pages show.
  // A service that the allowlist does not allow is never read.
  std::vector<std::string> service_allowlist{"*"};
};

// The tables ("db.table") of the OpenTelemetry data that the tools of `reads` read (McpReads, mcp_scope.hpp).
// The configuration sets these tables. A signal that is off has none.
// The patterns of a key must allow these tables for the tool to read.
std::vector<std::string> mcp_data_tables(const McpObservabilityConfig& config, unsigned reads);

struct McpToolsConfig {
  std::vector<McpHostInfo> hosts;  // the hosts that have an mcp_uri
  // Where the OpenTelemetry data is. This is the default, and the settings of the hosts that differ, by host name.
  // The tables of a host can differ from the tables of another host (`clickhouse.host { observability { ... } }`).
  McpObservabilityConfig observability;
  std::map<std::string, McpObservabilityConfig> observability_by_host;
  int64_t max_rows = 1000;
  int64_t max_result_bytes = 1048576;
  int64_t query_timeout_seconds = 30;
  int64_t max_sql_bytes = 65536;
  int64_t max_memory_bytes = 1073741824;
  int64_t max_rows_to_read = 0;
};

// Schema tools read this many rows of the system tables. The key's own row cap does not apply here.
// The scope filters the rows after the read. The tools return at most kMcpSchemaOutputRows tables.
inline constexpr int64_t kMcpSchemaReadRows = 20000;
inline constexpr size_t kMcpSchemaOutputRows = 2000;
inline constexpr int64_t kMcpSchemaReadBytes = 64LL * 1024 * 1024;
inline constexpr size_t kMcpCreateQueryMaxBytes = 64 * 1024;

class McpTools : public McpToolBackend {
public:
  // When `analysis` is null, the tools of the analysis of the keys answer `not_enabled`. The usage is off then.
  McpTools(McpToolsConfig config, McpDatabase& database, McpApiClient* api = nullptr, McpAnalysis* analysis = nullptr)
      : config_(std::move(config)), db_(database), api_(api), analysis_(analysis) {}

  McpToolAvailability availability() const override { return analysis_ ? analysis_->availability() : McpToolAvailability{}; }
  McpToolOutcome call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments,
                           int64_t now) override;
  McpToolOutcome call_tool_for(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments, int64_t now,
                               const McpCallInfo& info) override;

private:
  McpToolsConfig config_;
  McpDatabase& db_;
  McpApiClient* api_;
  McpAnalysis* analysis_;
};

} // namespace chdash
