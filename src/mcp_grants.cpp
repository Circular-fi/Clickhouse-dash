#include "mcp_grants.hpp"

#include <algorithm>
#include <cstring>

namespace chdash {

namespace {

void add_table(std::vector<std::string>* out, const std::string& database, const std::string& table) {
  if (database.empty() || table.empty()) return;
  const std::string name = database + "." + table;
  if (std::find(out->begin(), out->end(), name) == out->end()) out->push_back(name);
}

} // namespace

unsigned mcp_tool_reads(const McpToolInfo& tool) {
  const std::string name = tool.name;
  const std::string group = tool.group;
  if (group == "traces") return name == "traces_logs" ? (kMcpReadsTraces | kMcpReadsLogs) : kMcpReadsTraces;
  if (group == "logs") return kMcpReadsLogs;
  if (group == "metrics") return kMcpReadsMetrics;
  if (name == "search_traces" || name == "get_trace") return kMcpReadsTraces;
  if (name == "search_logs") return kMcpReadsLogs;
  if (name == "list_metrics" || name == "query_metric") return kMcpReadsMetrics;
  if (name == "explorer_functions") return kMcpReadsFunctions;
  // list_services reads traces or logs by its `signal`: the call tells, the key cannot.
  return kMcpReadsNone;
}

std::vector<std::string> mcp_reads_tables(const AppConfig& cfg, unsigned reads) {
  std::vector<std::string> out;
  if ((reads & kMcpReadsTraces) && cfg.traces.enabled) {
    add_table(&out, cfg.traces.database, cfg.traces.table);
    add_table(&out, cfg.traces.database, cfg.traces.trace_index_table);
  }
  if ((reads & kMcpReadsLogs) && cfg.logs.enabled) {
    add_table(&out, cfg.logs.database, cfg.logs.table);
    // The Logs page shows the size and the skipping indices of its table.
    add_table(&out, "system", "parts");
    add_table(&out, "system", "data_skipping_indices");
  }
  if ((reads & kMcpReadsMetrics) && cfg.metrics.enabled) {
    for (const char* kind : {"gauge", "sum", "histogram"}) add_table(&out, cfg.metrics.database, cfg.metrics.table_prefix + "_" + kind);
    add_table(&out, "system", "parts");
    add_table(&out, "system", "data_skipping_indices");
  }
  if (reads & kMcpReadsFunctions) add_table(&out, "system", "documentation");
  return out;
}

std::vector<McpToolGap> mcp_tool_gaps(const AppConfig& cfg, const HostAccess& access) {
  std::vector<McpToolGap> out;
  if (!access.mcp_audited || !access.mcp_connected || access.mcp_missing.empty()) return out;
  for (const auto& tool : mcp_tool_catalog()) {
    const unsigned reads = mcp_tool_reads(tool);
    if (reads == kMcpReadsNone) continue;
    McpToolGap gap;
    gap.tool = tool.name;
    for (const auto& table : mcp_reads_tables(cfg, reads)) {
      const std::string grant = "SELECT ON " + table;
      if (std::find(access.mcp_missing.begin(), access.mcp_missing.end(), grant) != access.mcp_missing.end()) gap.grants.push_back(grant);
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
