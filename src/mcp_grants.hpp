#pragma once

// The grants that the MCP user of a host must hold for each tool (docs/mcp.md, "The MCP user").
//
// The tools run as the MCP user (mcp_identity.hpp). Most tools read only what ClickHouse lets that user read.
// When ClickHouse does not let the user read, the tool says so (`permission_denied`).
//
// A few tools need a grant that is not about the data of the key.
// Those grants cover the tables of the OpenTelemetry pages, the size and the skipping indices of those tables, and the documentation of the functions.
//
// The access audit (health_runner.hpp) lists the grants that the user lacks (`mcp_missing`). This file says which tool each missing grant removes.
// A key cannot be given such a tool. The page shows it greyed, and the API refuses it.
// A key that promises a tool that always fails is worse than a key without it.

#include "health_runner.hpp"
#include "mcp_scope.hpp"
#include "mcp_tools.hpp"
#include "server.hpp"

#include <string>
#include <vector>

namespace chdash {

// This gives where the OpenTelemetry data lives for a host, as the tools take it.
// The settings come from the Observability pages for that host.
McpObservabilityConfig mcp_observability_config(const OtelSettings& otel);

// This gives what the MCP user itself must read for the access audit: `system.documentation` (explorer_functions).
// Every tool of Traces, Logs and Metrics reads the OpenTelemetry tables with the system user (mcp_system_reads). The pages do the same.
std::vector<std::string> mcp_user_reads();

// This gives what the system user must read on a host.
// It applies to the tools of Traces, Logs and Metrics, to the pages' tools, and to the simple tools (`reads`: McpReads flags).
// The grants are the same as for the pages.
std::vector<std::string> mcp_system_reads(const OtelSettings& otel, unsigned reads);

// A tool that its identity cannot serve. The entry gives the user that lacks the grant, and the grants that it lacks ("SELECT ON system.parts").
struct McpToolGap {
  std::string tool;
  std::string role;  // "MCP user" or "system user"
  std::string user;
  std::vector<std::string> grants;
};

// This lists the tools that the last audit of the host shows as not served.
// A tool whose user was not audited is not listed. This happens when the host was down, or when MCP is off.
// A tool whose user cannot connect is also not listed. The caller treats those cases apart.
std::vector<McpToolGap> mcp_tool_gaps(const OtelSettings& otel, const HostAccess& access);

// `GRANT SELECT ON a, b TO user;`
std::string mcp_grant_statement(const std::vector<std::string>& grants, const std::string& user);

} // namespace chdash
