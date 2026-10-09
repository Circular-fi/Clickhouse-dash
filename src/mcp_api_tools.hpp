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

// What a key's data scope (`databases`) means for an API tool.
enum class McpApiScope {
  // The answer mixes every table (the graph, the sizes of everything): no pattern can cut it, so the tool goes only
  // to keys whose data is "*".
  AllData,
  // The answer is not about the tables of the key: the functions, the saved queries, the SQL formatter, and what the
  // pages read with the system user (System, the OpenTelemetry tables of Traces, Logs and Metrics). The key's patterns
  // cut nothing here, so any key may hold the tool; it is the permission that gives it.
  Free,
  // The tool reads one table named by `database` and `table`: the key's patterns must allow it.
  Table,
  // The catalog: databases and tables, cut to the ones that the key's patterns show.
  Catalog,
};

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
  McpApiScope scope = McpApiScope::AllData;
};

const std::vector<McpApiTool>& mcp_api_tools();

// The ClickHouse identity that a tool runs with (mcp_identity.hpp): the MCP user takes the place of the runner, the
// system user stays what it is for the pages (figures, System, the OpenTelemetry tables of Traces, Logs and Metrics);
// the query library involves no ClickHouse user.
McpIdentity mcp_api_identity(const McpApiTool& tool);

} // namespace chdash
