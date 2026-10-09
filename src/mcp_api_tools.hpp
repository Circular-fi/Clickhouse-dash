#pragma once

// The API tools of MCP (docs/mcp.md, "API tools"): each read function of the ChDash API as a tool.
//
// A tool is one row of the table in mcp_api_tools.cpp: its name, its group, its title, what it does and
// which route it calls. Nothing else is written for it: the input schema, the entry of tools/list and of
// the page's permission list, the scope rule and the call itself come from the row, through the one
// wrapper (tool_api in mcp_tools.cpp). To add a tool, add a row; to remove one, delete its row.

#include "mcp_identity.hpp"

#include <string>
#include <vector>

namespace chdash {

struct McpApiTool {
  const char* name;
  // The id of a group of mcp_tool_groups(): the family of permissions of the page.
  const char* group;
  const char* title;
  // What it does, and the parameters that matter (the client reads this to call it).
  const char* description;
  // "GET": params are the query string. "POST": the body argument is the JSON body.
  const char* method;
  // The route. {name} is taken from params.name (the answer of GET /api/system/queries/{hash}).
  const char* path;
};

const std::vector<McpApiTool>& mcp_api_tools();

// The ClickHouse identity that a tool runs with (mcp_identity.hpp), by its family: the Explorer, System and Query
// tools take the MCP user as runner; Traces, Logs and Metrics (read with the system user by the pages) take the MCP
// user for both; the query library involves no ClickHouse user.
McpIdentity mcp_api_identity(const McpApiTool& tool);

} // namespace chdash
