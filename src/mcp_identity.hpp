#pragma once

// The identity of the API tools of MCP (docs/mcp.md, "API tools").
//
// A tool calls the API of ChDash, and the API runs with the ClickHouse users of the host. For MCP these
// users are not the runner and the system user of the pages: they are the MCP user (mcp_uri) of the host.
// The host is not copied and nothing is started twice. The configuration holds, for each host that has an
// mcp_uri, two more entries that only the tools can name (AppConfig::mcp_hosts); their ids are the id of the
// host followed by a suffix with a control character, which a host name cannot hold:
//
//   <host>\x1fmcp       runner = the MCP user, system user = the system user of the host
//                       (the Explorer, the System page, the Query helpers: the runner decides what is
//                       visible, the system user only adds figures to what is visible, as for the pages);
//   <host>\x1fmcp-otel  runner = system user = the MCP user (Traces, Logs, Metrics read their tables
//                       with the system user, so for MCP it is the MCP user).
//
// The caches of the API are keyed by the host id: the entries of the MCP never mix with the ones of the pages.
// A request is allowed to name such an id only when it carries the internal token of the process (a random
// value of each start, known to the tool wrapper and to nothing else): the browser, or any client of the
// port, gets "unknown host".

#include <string>
#include <string_view>

namespace chdash {

inline constexpr std::string_view kMcpRunnerSuffix = "\x1f" "mcp";
inline constexpr std::string_view kMcpOtelSuffix = "\x1f" "mcp-otel";

// The header of the internal call, and the one that marks the caller (docs/mcp.md).
inline constexpr const char* kMcpInternalHeader = "X-ChDash-Internal";

// The identity that a tool runs with, by the family (group) of the tool.
enum class McpIdentity {
  Runner,  // <host>\x1fmcp
  Otel,    // <host>\x1fmcp-otel
  Page,    // the host as it is (no ClickHouse user is involved: the query library)
};

// The token of this process: 32 random hexadecimal characters, made at the first use.
const std::string& mcp_internal_token();

// True when `text` is the token (constant-time).
bool mcp_internal_token_matches(std::string_view text);

// The id that the API takes for a tool: the host, and the suffix of its identity.
std::string mcp_api_host(std::string_view host, McpIdentity identity);

// An answer of the API names the host that it served: the suffix is cut, so a client sees its host id.
std::string mcp_strip_identity(std::string body);

} // namespace chdash
