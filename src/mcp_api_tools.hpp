#pragma once

// The API tools of MCP (docs/mcp.md, "API tools"). Each read function of the ChDash API is a tool.
//
// A tool is one row of the table in mcp_api_tools.cpp. The row gives its name, its group, its title, what it does, and the route that it calls.
// Write nothing else for a tool. The input schema, the entry of tools/list, the entry of the page's permission list, the scope rule and the call come from the row.
//
// The one wrapper (tool_api in mcp_tools.cpp) makes these parts. To add a tool, add a row. To remove a tool, delete its row.

#include "mcp_identity.hpp"

#include <string>
#include <vector>

namespace chdash {

// This explains what the data scope of a key (`databases`) means for an API tool. No API tool needs the scope "*".
// The graph, the storage and the names are read as the pages read them. The MCP user decides what is visible.
// The system user adds the figures.
enum class McpApiScope {
  // The answer does not concern the tables of the key.
  // It concerns the functions, the saved queries and the SQL formatter.
  // It also concerns the data that the pages read with the system user (System, and the OpenTelemetry tables of Traces, Logs and Metrics).
  // The patterns of the key cut nothing here. So any key can hold the tool. The permission is what gives the tool to a key.
  Free,
  // The tool reads one table. The table is named by `database` and `table`.
  // The patterns of the key must let the tool read that table.
  Table,
  // The catalog lists the databases and the tables.
  // It is cut to the ones that the patterns of the key show.
  Catalog,
};

struct McpApiTool {
  const char* name;
  // The id of a group of mcp_tool_groups(). The group is the family of permissions of the page.
  const char* group;
  const char* title;
  // What the tool does, and the parameters that matter. The client reads this text to call the tool.
  const char* description;
  // "GET": the params are the query string. "POST": the body argument is the JSON body.
  const char* method;
  // The route. The {name} part comes from params.name (the answer of GET /api/system/queries/{hash}).
  const char* path;
  McpApiScope scope = McpApiScope::Free;
  // The part of a family that the page draws as its own section (a signal of Observability), or null.
  const char* section = nullptr;
};

const std::vector<McpApiTool>& mcp_api_tools();

// The ClickHouse identity that a tool runs with (mcp_identity.hpp). The MCP user takes the place of the runner.
// The system user keeps its role for the pages (figures, System, and the OpenTelemetry tables of Traces, Logs and Metrics).
// The query library does not use a ClickHouse user.
McpIdentity mcp_api_identity(const McpApiTool& tool);

} // namespace chdash
