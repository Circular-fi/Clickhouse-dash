#pragma once

// What the MCP user of a host must hold for each tool (docs/mcp.md, "The MCP user").
//
// The tools run as the MCP user (mcp_identity.hpp). Most of them read only what ClickHouse lets that user read,
// and say so when it does not (`permission_denied`). A few need a grant that is not about the data of the key:
// the tables of the OpenTelemetry pages, the size and the skipping indices of those tables, the documentation
// of the functions. The access audit (health_runner.hpp) lists which of these the user lacks (`mcp_missing`);
// this file says which tool each one takes away. A key cannot be given such a tool (the page greys it, the API
// refuses it), because a key that promises a tool that always fails is worse than a key without it.

#include "health_runner.hpp"
#include "mcp_scope.hpp"
#include "server.hpp"

#include <string>
#include <vector>

namespace chdash {

// What a tool reads besides the tables that the key lets it see: a set of these flags.
enum McpReads : unsigned {
  kMcpReadsNone = 0,
  kMcpReadsTraces = 1,
  kMcpReadsLogs = 2,
  kMcpReadsMetrics = 4,
  kMcpReadsFunctions = 8,
  kMcpReadsAll = 15,
};

unsigned mcp_tool_reads(const McpToolInfo& tool);

// The tables ("db.table") that the tools of `reads` read, as the configuration puts them. A feature that is off
// (traces.enabled = false) has none.
std::vector<std::string> mcp_reads_tables(const AppConfig& cfg, unsigned reads);

// A tool that the MCP user cannot serve, and the grants it lacks ("SELECT ON system.parts").
struct McpToolGap {
  std::string tool;
  std::vector<std::string> grants;
};

// The tools that the last audit of the host shows as not served. Empty when the MCP user was not audited
// (the host was down, MCP is off) or could not connect: the caller treats those cases apart.
std::vector<McpToolGap> mcp_tool_gaps(const AppConfig& cfg, const HostAccess& access);

// `GRANT SELECT ON a, b TO user;`
std::string mcp_grant_statement(const std::vector<std::string>& grants, const std::string& user);

} // namespace chdash
