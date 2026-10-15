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

// The sections of a family: the page draws them as sub-headings of the card of the family (Observability has one for
// each signal). A tool names its section in McpToolInfo::section.
struct McpToolSection {
  const char* group;
  const char* id;
  const char* title;
};

// In the order of the page.
const std::vector<McpToolSection>& mcp_tool_sections();

// What a tool needs of the configuration to exist (McpToolInfo::needs): a set of these flags.
enum McpToolNeeds : unsigned {
  kMcpNeedsNothing = 0,
  kMcpNeedsUsage = 1,    // mcp.usage.enabled: the usage of the keys is counted
  kMcpNeedsAllKeys = 2,  // mcp.usage.all_keys, which only counts with the usage: a key may read the usage of every key
};

// What the configuration turns on, for the tools that need something of it. A tool whose needs are not met is not offered: tools/list leaves it
// out and tools/call answers `not_enabled`, also for a key that holds it.
struct McpToolAvailability {
  bool usage = false;
  bool all_keys = false;
  // Everything on: what a key is entitled to, whatever the configuration turns on.
  static McpToolAvailability everything() { return {true, true}; }
};

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
  // A section of the family (mcp_tool_sections), or null.
  const char* section = nullptr;
  // Every key has the tool, whatever its list of tools says (an empty list too): the analysis of the key's own limits and usage.
  bool always = false;
  // "*" does not include the tool: a key has it only when its list of tools names it.
  bool explicit_only = false;
  // What the tool needs of the configuration (McpToolNeeds).
  unsigned needs = kMcpNeedsNothing;
};

const std::vector<McpToolInfo>& mcp_tool_catalog();
const McpToolInfo* mcp_find_tool(std::string_view name);

// Whether the configuration offers the tool now (its needs are met).
bool mcp_tool_available(const McpToolInfo& tool, const McpToolAvailability& availability);
// Why it does not, as a sentence for a client (the setting that is off); empty when the tool is offered.
std::string mcp_tool_unavailable_reason(const McpToolInfo& tool, const McpToolAvailability& availability);

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

// The tools the key holds, in the order of the catalog: `*` expands to every tool the key may hold but those that `*` does not give
// (explicit_only), a tool that every key has (always) is there whatever the list says, unknown names drop, and the SQL tools drop unless
// the data scope is `*`. A tool that `availability` does not offer drops too: the default holds what the key is entitled to, whatever the
// configuration turns on.
std::vector<std::string> mcp_effective_tools(const std::vector<std::string>& tools,
                                             const std::vector<std::string>& databases,
                                             const McpToolAvailability& availability = McpToolAvailability::everything());

// The key is entitled to the tool (its list and its data scope), whether or not the configuration offers it now (mcp_tool_available).
bool mcp_scope_tool_allowed(const std::vector<std::string>& tools, const std::vector<std::string>& databases,
                            std::string_view tool);

} // namespace chdash
