#pragma once

// What an MCP key may reach: hosts, tools and data (docs/mcp.md, "Key model").
// Everything here is pure: no I/O, no ClickHouse, no global state.

#include "access_pdp.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

// ---- tool catalog ---------------------------------------------------------

// A group is a family of permissions. The page lists the tools by group. To add a group, add one more row to mcp_tool_groups().
struct McpToolGroup {
  const char* id;
  const char* title;
  const char* note;
};

// The list has the order of the page. The groups of the API tools (mcp_api_tools.cpp) are also in this list.
const std::vector<McpToolGroup>& mcp_tool_groups();

struct McpApiTool;

// The sections of a family. The page draws each section as a sub-heading of the card of the family.
// Observability has one section for each signal. A tool names its section in McpToolInfo::section.
struct McpToolSection {
  const char* group;
  const char* id;
  const char* title;
};

// The list has the order of the page.
const std::vector<McpToolSection>& mcp_tool_sections();

// The configuration values that a tool needs (McpToolInfo::needs). This is a set of these flags.
enum McpToolNeeds : unsigned {
  kMcpNeedsNothing = 0,
  kMcpNeedsUsage = 1,    // mcp.usage.enabled: the usage of the keys is counted
  kMcpNeedsAllKeys = 2,  // mcp.usage.all_keys, which only counts with the usage: a key may read the usage of every key
};

// The configuration enables the tools that need one of its values.
// A tool whose needs are not met is not offered. tools/list omits it.
// tools/call answers `not_enabled`, also for a key that holds the tool.
struct McpToolAvailability {
  bool usage = false;
  bool all_keys = false;
// Every flag is on. A key is entitled to every tool, whatever the configuration enables.
  static McpToolAvailability everything() { return {true, true}; }
};

struct McpToolInfo {
  const char* name;
  // The id of a group of mcp_tool_groups().
  const char* group;
  const char* title;
  const char* description;
// Free SQL and the API tools about the server cannot be limited to some tables.
// Views, sub-queries and server-wide answers are examples. Only keys whose data scope is "*" get these tools.
  bool needs_all_data;
// Set for an API tool. It holds the route that the one wrapper calls.
  const McpApiTool* api = nullptr;
  // A section of the family (mcp_tool_sections), or null.
  const char* section = nullptr;
// Every key has the tool, whatever its list of tools says. This includes an empty list. The tool gives the analysis of the key's own limits and usage.
  bool always = false;
// "*" does not include this tool. A key has it only when its list of tools names it.
  bool explicit_only = false;
// The configuration values that the tool needs (McpToolNeeds).
  unsigned needs = kMcpNeedsNothing;
};

const std::vector<McpToolInfo>& mcp_tool_catalog();
const McpToolInfo* mcp_find_tool(std::string_view name);

// Whether the configuration offers the tool now (its needs are met).
bool mcp_tool_available(const McpToolInfo& tool, const McpToolAvailability& availability);
// The reason why it is not offered, as a sentence for a client. The reason names the value that is off. The string is empty when the tool is offered.
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

// One entry of `databases` has one of these forms: `*`, `db` or `db.table`. `*` is a wildcard in each part.
// The allowed characters are letters, digits, `_`, `-`, `$`, `*` and one `.`.
bool mcp_valid_database_pattern(std::string_view pattern, std::string* reason = nullptr);

// True when one entry is exactly `*`.
bool mcp_scope_all_data(const std::vector<std::string>& databases);

// The database shows in the schema listings. At least one entry names it (`db`, `db.table` or `*`).
bool mcp_scope_database_visible(const std::vector<std::string>& databases, std::string_view database);

// Every table of the database is readable. An entry `*`, `db` or `db.*` matches it. A `db.table` entry does not match it.
bool mcp_scope_database_whole(const std::vector<std::string>& databases, std::string_view database);

// The table is readable. An entry `*`, `db` or `db.table` matches it.
bool mcp_scope_table_allowed(const std::vector<std::string>& databases, std::string_view database,
                             std::string_view table);

// The database parts of the entries narrow a read of system.tables. This is never the final check.
std::vector<std::string> mcp_scope_database_globs(const std::vector<std::string>& databases);

// ---- hosts and tools ------------------------------------------------------

// `hosts` holds a host name or `*`. The `*` matches every host that has an mcp_uri.
bool mcp_scope_host_allowed(const std::vector<std::string>& hosts, std::string_view host);

// The hosts of `available` that the entries name. The order is the order of `available`.
std::vector<std::string> mcp_scope_hosts(const std::vector<std::string>& hosts,
                                         const std::vector<std::string>& available);

// The tools that the key holds, in the order of the catalog.
// `*` expands to every tool that the key may hold, except the tools that `*` does not give (explicit_only).
// A tool that every key has (always) is there, whatever the list says. Unknown names are removed.
//
// The SQL tools are removed, unless the data scope is `*`. A tool that `availability` does not offer is removed too.
// The default availability holds what the key is entitled to, whatever the configuration enables.
std::vector<std::string> mcp_effective_tools(const std::vector<std::string>& tools,
                                             const std::vector<std::string>& databases,
                                             const McpToolAvailability& availability = McpToolAvailability::everything());

// The key is entitled to the tool through its list and its data scope. This is true whether or not the configuration offers the tool now (mcp_tool_available).
bool mcp_scope_tool_allowed(const std::vector<std::string>& tools, const std::vector<std::string>& databases,
                            std::string_view tool);

// ---- the access of humans --------------------------------------------------

// The action of the access of humans (docs/access.md) that the tool uses, or null when it uses none.
// An API tool has the action of its route (access_rule). A route of a run gives query.run.read.
// The tools of the data use explorer.read, the tools of Observability observability.read, the SQL tools query.run.read and
// mcp_analysis_all_usage mcp.usage.read. list_hosts and the analysis of the key itself use none.
// A route that the table of the rules does not know gives "unknown": the PDP refuses it (fail closed).
const char* mcp_tool_access_action(const McpToolInfo& tool);

// The questions that the creator of a key must pass for that key (docs/mcp.md, "Keys and the access of humans"). Each tool of the
// key (mcp_effective_tools, with all the tools that the key is entitled to) gives its action once.
// An action that can also take a database (explorer.read for the tools that read only the tables of the scope) is asked on each
// database that the scope names. It is asked on the service when an entry has a wildcard in its database part.
// Every other action is asked on the service `service_id`. The questions have no duplicates.
std::vector<AccessQuestion> mcp_key_access_questions(const std::vector<std::string>& tools, const std::vector<std::string>& databases,
                                                     const std::string& service_id);
// The questions of one tool, with the same rules: the questions that the creator of a key must pass to call this tool.
// The list is empty for a tool that uses no action.
std::vector<AccessQuestion> mcp_tool_access_questions(const McpToolInfo& tool, const std::vector<std::string>& databases,
                                                      const std::string& service_id);

} // namespace chdash
