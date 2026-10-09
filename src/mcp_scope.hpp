#pragma once

// What an MCP key may reach: hosts, tools and data (docs/mcp.md, "Key model").
// Everything here is pure: no I/O, no ClickHouse, no global state.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

// ---- tool catalog ---------------------------------------------------------

// A family of permissions: the page lists the tools by group, and a group is one more row of mcp_tool_groups().
struct McpToolGroup {
  const char* id;
  const char* title;
  const char* note;
};

// In the order of the page. The groups of the API tools (mcp_api_tools.cpp) are here too.
const std::vector<McpToolGroup>& mcp_tool_groups();

struct McpApiTool;

struct McpToolInfo {
  const char* name;
  // The id of a group of mcp_tool_groups().
  const char* group;
  const char* title;
  const char* description;
  // Free SQL, and the API tools about the server, cannot be limited to some tables (views, sub-queries,
  // server-wide answers): these tools go only to keys whose data scope is "*".
  bool needs_all_data;
  // Set for an API tool: the route that the one wrapper calls for it.
  const McpApiTool* api = nullptr;
};

const std::vector<McpToolInfo>& mcp_tool_catalog();
const McpToolInfo* mcp_find_tool(std::string_view name);

// ---- glob patterns --------------------------------------------------------

// `*` matches any run of characters (empty too), everything else matches itself.
bool mcp_glob_match(std::string_view pattern, std::string_view text);

// A LIKE pattern (backslash escapes) that matches the same texts as the glob.
std::string mcp_glob_to_like(std::string_view pattern);

// ---- data scope -----------------------------------------------------------

// One entry of `databases`: `*`, `db`, `db.table`; `*` is a wildcard in each part.
// Characters: letters, digits, `_`, `-`, `$`, `*`, and one `.`.
bool mcp_valid_database_pattern(std::string_view pattern, std::string* reason = nullptr);

// True when one entry is exactly `*`.
bool mcp_scope_all_data(const std::vector<std::string>& databases);

// The database shows in schema listings: some entry names it (`db`, `db.table`, `*`).
bool mcp_scope_database_visible(const std::vector<std::string>& databases, std::string_view database);

// Every table of the database is readable: an entry `*`, `db` or `db.*` matches it (a `db.table` entry does not).
bool mcp_scope_database_whole(const std::vector<std::string>& databases, std::string_view database);

// The table is readable: an entry `*`, `db` or `db.table` matches it.
bool mcp_scope_table_allowed(const std::vector<std::string>& databases, std::string_view database,
                             std::string_view table);

// The database parts of the entries, to narrow a system.tables read (never the final check).
std::vector<std::string> mcp_scope_database_globs(const std::vector<std::string>& databases);

// ---- hosts and tools ------------------------------------------------------

// `hosts` holds the name or `*` (every host that has an mcp_uri).
bool mcp_scope_host_allowed(const std::vector<std::string>& hosts, std::string_view host);

// The hosts of `available` the entries name, in `available` order.
std::vector<std::string> mcp_scope_hosts(const std::vector<std::string>& hosts,
                                         const std::vector<std::string>& available);

// The tools the key holds: `*` expands to every tool the key may hold, unknown
// names drop, and the SQL tools drop unless the data scope is `*`.
std::vector<std::string> mcp_effective_tools(const std::vector<std::string>& tools,
                                             const std::vector<std::string>& databases);

bool mcp_scope_tool_allowed(const std::vector<std::string>& tools, const std::vector<std::string>& databases,
                            std::string_view tool);

} // namespace chdash
