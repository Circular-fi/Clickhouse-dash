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
#include "mcp_tools.hpp"
#include "server.hpp"

#include <string>
#include <vector>

namespace chdash {

// Where the OpenTelemetry data lives, as the tools take it (the same settings as the Observability pages).
McpObservabilityConfig mcp_observability_config(const AppConfig& cfg);

// What the MCP user itself must read, for the access audit: the OpenTelemetry tables (the simple tools run their SQL as
// this user) and `system.documentation` (explorer_functions). A feature that is off has none.
std::vector<std::string> mcp_user_reads(const AppConfig& cfg);

// What the system user must read for the tools of Traces, Logs and Metrics (`reads`: McpReads flags): the same as for
// the pages.
std::vector<std::string> mcp_system_reads(const AppConfig& cfg, unsigned reads);

// A tool that its identity cannot serve, who lacks it and the grants it lacks ("SELECT ON system.parts").
struct McpToolGap {
  std::string tool;
  std::string role;  // "MCP user" or "system user"
  std::string user;
  std::vector<std::string> grants;
};

// The tools that the last audit of the host shows as not served. A tool whose user was not audited (the host was
// down, MCP is off) or could not connect is not listed: the caller treats those cases apart.
std::vector<McpToolGap> mcp_tool_gaps(const AppConfig& cfg, const HostAccess& access);

// `GRANT SELECT ON a, b TO user;`
std::string mcp_grant_statement(const std::vector<std::string>& grants, const std::string& user);

} // namespace chdash
