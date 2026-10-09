#include "mcp_grants.hpp"

#include "mcp_tools.hpp"

#include <algorithm>

namespace chdash {

namespace {

void add_table(std::vector<std::string>* out, const std::string& table) {
  if (std::find(out->begin(), out->end(), table) == out->end()) out->push_back(table);
}

bool has(const std::vector<std::string>& list, const std::string& item) {
  return std::find(list.begin(), list.end(), item) != list.end();
}

} // namespace

McpObservabilityConfig mcp_observability_config(const AppConfig& cfg) {
  McpObservabilityConfig out;
  out.traces = cfg.traces.enabled;
  out.traces_database = cfg.traces.database;
  out.traces_table = cfg.traces.table;
  out.traces_index_table = cfg.traces.trace_index_table;
  out.logs = cfg.logs.enabled;
  out.logs_database = cfg.logs.database;
  out.logs_table = cfg.logs.table;
  out.metrics = cfg.metrics.enabled;
  out.metrics_database = cfg.metrics.database;
  out.metrics_prefix = cfg.metrics.table_prefix;
  out.max_lookback_minutes = cfg.traces.max_lookback_minutes;
  return out;
}

std::vector<std::string> mcp_user_reads(const AppConfig& cfg) {
  // What the MCP user itself reads that the pages do not read with the system user: the documentation of the functions.
  // The OpenTelemetry tables are read with the system user, for the simple tools as for the pages' tools.
  (void)cfg;
  std::vector<std::string> out;
  add_table(&out, "system.documentation");
  return out;
}

std::vector<std::string> mcp_system_reads(const AppConfig& cfg, unsigned reads) {
  // What the system user reads for the OpenTelemetry pages: their tables, and the size and the skipping indices of
  // the tables of Logs and Metrics.
  std::vector<std::string> out = mcp_data_tables(mcp_observability_config(cfg), reads);
  if (((reads & kMcpReadsLogs) && cfg.logs.enabled) || ((reads & kMcpReadsMetrics) && cfg.metrics.enabled)) {
    add_table(&out, "system.parts");
    add_table(&out, "system.data_skipping_indices");
  }
  return out;
}

std::vector<McpToolGap> mcp_tool_gaps(const AppConfig& cfg, const HostAccess& access) {
  std::vector<McpToolGap> out;
  const bool mcp_known = access.mcp_audited && access.mcp_connected;
  const bool system_known = access.checked && !access.system_user.empty();
  for (const auto& tool : mcp_tool_catalog()) {
    const unsigned reads = mcp_tool_reads(tool);
    if (reads == kMcpReadsNone) continue;
    McpToolGap gap;
    gap.tool = tool.name;
    if (reads & kMcpReadsFunctions) {
      // The runner of the call is the MCP user.
      if (!mcp_known) continue;
      gap.role = "MCP user";
      gap.user = access.mcp_user;
      if (has(access.mcp_missing, "SELECT ON system.documentation")) gap.grants.push_back("SELECT ON system.documentation");
    } else {
      // Traces, Logs and Metrics (the pages' tools and the simple tools): the OpenTelemetry tables are read with the
      // system user, as for the pages.
      if (!system_known) continue;
      gap.role = "system user";
      gap.user = access.system_user;
      for (const auto& table : mcp_system_reads(cfg, reads)) {
        if (has(access.system_missing, "SELECT ON " + table)) gap.grants.push_back("SELECT ON " + table);
      }
    }
    if (!gap.grants.empty()) out.push_back(std::move(gap));
  }
  return out;
}

std::string mcp_grant_statement(const std::vector<std::string>& grants, const std::string& user) {
  std::string tables;
  for (const auto& grant : grants) {
    const std::string table = grant.rfind("SELECT ON ", 0) == 0 ? grant.substr(10) : grant;
    tables += (tables.empty() ? "" : ", ") + table;
  }
  return "GRANT SELECT ON " + tables + " TO " + (user.empty() ? std::string("<user>") : user) + ";";
}

} // namespace chdash
