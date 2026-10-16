#pragma once

// The identity of the API tools of MCP (docs/mcp.md, "API tools").
//
// A tool calls the API of ChDash. The API runs with the ClickHouse users of the host.
// For MCP, these users are not the runner and the system user of the pages.
// They are the MCP user (mcp_uri) of the host. The host is not copied, and nothing starts twice.
//
// The configuration holds one more entry for each host that has an mcp_uri.
// Only the tools can name this entry (AppConfig::mcp_hosts).
// Its id is the id of the host, followed by a suffix with a control character.
// A host name cannot hold such a control character:
//
//   <host>\x1fmcp       runner = the MCP user, system user = the system user of the host.
//                       The runner decides what is visible, and what the data is.
//                       The system user only adds figures to what is visible.
//                       It reads the OpenTelemetry tables, as the pages do
//                       (the Explorer, System, Query helpers, Traces, Logs, Metrics).
//
// The caches of the API use the host id as the key. The MCP entries never mix with the entries of the pages.
// A request can name such an id only when it is a call of an API tool.
//
// The handler of the route runs the call in the process (request_context.hpp).
// The context of the call says Mcp. Nothing that a client sends can say it.
// The browser, and any other client of the port, gets "unknown host".

#include <string>
#include <string_view>

namespace chdash {

inline constexpr std::string_view kMcpRunnerSuffix = "\x1f" "mcp";

// The identity that a tool runs with. It depends on the family (group) of the tool.
enum class McpIdentity {
  Runner,  // <host>\x1fmcp
  Page,    // the host as it is (no ClickHouse user is involved: the query library)
};

// The id that the API takes for a tool. It contains the host and the suffix of its identity.
std::string mcp_api_host(std::string_view host, McpIdentity identity);

// This returns the configured host behind an id.
// The result is the id itself, or the host of an MCP identity without its suffix.
// The records that the query registry keeps by host use the configured host.
std::string_view mcp_base_host(std::string_view host_id);

// An answer of the API names the host that it served. The suffix is cut. So a client sees its host id.
std::string mcp_strip_identity(std::string body);

} // namespace chdash
