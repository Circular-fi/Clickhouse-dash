#pragma once

// What the tools of MCP (mcp_tools.cpp) share. This includes the failure of a tool, the reading of its arguments,
// and the context of one call. The context holds the key, the host and the limits of each kind of statement.
// The shared code also runs a statement, and writes cells and rows.
// A tool is a function of the context and of its arguments (mcp_tools_units.hpp).
// A tool returns the JSON of its answer, or it throws ToolFailure.

#include "mcp_scope.hpp"
#include "mcp_tools.hpp"
#include "json_text.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <cstdint>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace mcp_tools {

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

struct ToolFailure {
  std::string code;
  std::string message;
};

[[noreturn]] void fail(const std::string& code, const std::string& message);

inline void put(Writer& w, std::string_view s) { write_json_text(w, s); }
inline std::string finish(rapidjson::StringBuffer& sb) { return std::string(sb.GetString(), sb.GetSize()); }

// ---- arguments ----
void reject_unknown(const rapidjson::Value& args, std::initializer_list<const char*> allowed);
std::optional<std::string> opt_string(const rapidjson::Value& args, const char* name, size_t max_bytes = 4096);
std::string req_string(const rapidjson::Value& args, const char* name, size_t max_bytes = 4096);
std::optional<bool> opt_bool(const rapidjson::Value& args, const char* name);
// A whole number in [lo, hi]. The function returns `fallback` when the argument is absent or null.
int64_t opt_int(const rapidjson::Value& args, const char* name, int64_t lo, int64_t hi, int64_t fallback);

// ---- the call context ----
struct Ctx {
  const McpKey& key;
  const McpToolsConfig& config;
  McpDatabase& db;
  McpApiClient* api = nullptr;
  // The analysis of the keys (mcp_tools_analysis.cpp). It has the rate limit, the usage and the cost. It is null when the server offers none.
  McpAnalysis* analysis = nullptr;
  // The time of the call, in Unix seconds.
  int64_t now = 0;
  std::string host;
  int64_t max_rows = 0;
  McpDbLimits user_limits;
  McpDbLimits schema_limits;
  // The same limits apply to the OpenTelemetry tools. These tools run with the system user of the host, as the pages do.
  McpDbLimits system_limits;
  McpDbLimits system_schema_limits;
  uint64_t rows_out = 0;
};

// The hosts that the key may use.
std::vector<std::string> key_hosts(const McpKey& key, const McpToolsConfig& config);
// The host of the call is the argument `host`, or the only host that the key has. The function fails with not_found, no_host or host_required.
void resolve_host(Ctx& ctx, const rapidjson::Value& args);
// `tool` names the statements of the call. The name gives their query_id (mcp_cost.hpp).
Ctx make_ctx(const McpKey& key, const McpToolsConfig& config, McpDatabase& db, const std::string& tool = {});
// Runs one statement on the host of the call. A McpDbError becomes a ToolFailure with its code.
McpDbResult run(Ctx& ctx, const std::string& sql, const McpDbLimits& limits);

// ---- cells and rows ----
std::string cell_text(const std::string& cell);
uint64_t cell_u64(const std::string& cell);
void put_cell(Writer& w, const std::string& cell);
void write_columns(Writer& w, const McpDbResult& res);
void write_rows(Writer& w, const McpDbResult& res);

// ---- SQL shared by the schema and the query tools ----
std::string glob_conditions(const char* column, const std::vector<std::string>& globs);
// The function fails with not_found when the data scope of the key does not allow the table. The error is the same as for a table that does not exist.
void check_table_scope(const Ctx& ctx, const std::string& database, const std::string& table);
std::string describe_table_filter(const std::string& database, const std::string& table, const char* table_column);

}  // namespace mcp_tools
}  // namespace chdash
