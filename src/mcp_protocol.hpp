#pragma once

// The MCP wire protocol (docs/mcp.md): JSON-RPC 2.0 messages of the Streamable
// HTTP transport, answered as one JSON body. Stateless: no session, no stream.
// The tools sit behind McpToolBackend, so a fake backend can drive the tests.

#include "mcp_keys.hpp"
#include "mcp_scope.hpp"

#include <rapidjson/document.h>

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

inline constexpr const char* kMcpLatestProtocolVersion = "2025-06-18";
const std::vector<std::string>& mcp_protocol_versions();

// JSON-RPC error codes.
inline constexpr int kRpcParseError = -32700;
inline constexpr int kRpcInvalidRequest = -32600;
inline constexpr int kRpcMethodNotFound = -32601;
inline constexpr int kRpcInvalidParams = -32602;
inline constexpr int kRpcInternalError = -32603;

struct McpServerInfo {
  std::string name = "chdash";
  std::string title = "ChDash";
  std::string version = "dev";
};

// What a tool returns. `json` is one JSON object: the payload on success,
// {"error": code, "message": text} on failure. It is sent as the text content
// and, for a client that reads it, as structuredContent.
struct McpToolOutcome {
  bool is_error = false;
  std::string json;
  // For the audit line (never SQL, never data).
  std::string host;
  uint64_t rows = 0;
  std::string error_code;
};

McpToolOutcome mcp_tool_error(const std::string& code, const std::string& message);

class McpToolBackend {
public:
  virtual ~McpToolBackend() = default;
  // What the configuration turns on for the tools that need something of it (the usage of the keys, the reading of all of it): a tool whose
  // needs are not met is not listed, and a call to it is `not_enabled`. Nothing is on by default.
  virtual McpToolAvailability availability() const { return {}; }
  // `tool` is a tool of the catalog that the key holds and that the configuration offers. `arguments` is an object. `now` is Unix seconds.
  virtual McpToolOutcome call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments,
                                   int64_t now) = 0;
};

struct McpRpcResult {
  // 202 with no body: a notification or a response of the client.
  int http_status = 200;
  std::string body;
  // For the audit line and the usage. The method of a message whose method was read, also when it failed (at most 128 bytes); empty
  // when the message could not be read (not JSON, a batch, no "jsonrpc": "2.0", a method that is not text).
  std::string method;
  std::string tool;
  bool tool_called = false;
  McpToolOutcome outcome;
  int rpc_error = 0;
  // initialize: the clientInfo of the client (at most 256 bytes each), for the usage of the key (mcp_usage.hpp).
  std::string client_name;
  std::string client_version;
};

// The JSON Schema of a tool's arguments, as JSON text.
const char* mcp_tool_input_schema(std::string_view tool);

// `protocol_version` is the MCP-Protocol-Version header of the request ("" when it has none). A tool result always has the JSON of
// the tool as text (content[0].text); structuredContent, the same JSON again, only for a client of 2025-06-18 or later and for a
// request without the header (docs/mcp.md, "Decisions").
McpRpcResult mcp_handle_message(std::string_view body, const McpKey& key, McpToolBackend& backend,
                                const McpServerInfo& info, int64_t now, std::string_view protocol_version = {});

} // namespace chdash
