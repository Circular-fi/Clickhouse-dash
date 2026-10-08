#pragma once

// The MCP wire protocol (docs/mcp.md): JSON-RPC 2.0 messages of the Streamable
// HTTP transport, answered as one JSON body. Stateless: no session, no stream.
// The tools sit behind McpToolBackend, so a fake backend can drive the tests.

#include "mcp_keys.hpp"

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
// and as structuredContent.
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
  // `tool` is a tool of the catalog that the key holds. `arguments` is an object.
  virtual McpToolOutcome call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments,
                                   int64_t now) = 0;
};

struct McpRpcResult {
  // 202 with no body: a notification or a response of the client.
  int http_status = 200;
  std::string body;
  // For the audit line.
  std::string method;
  std::string tool;
  bool tool_called = false;
  McpToolOutcome outcome;
  int rpc_error = 0;
};

// The JSON Schema of a tool's arguments, as JSON text.
const char* mcp_tool_input_schema(std::string_view tool);

McpRpcResult mcp_handle_message(std::string_view body, const McpKey& key, McpToolBackend& backend,
                                const McpServerInfo& info, int64_t now);

} // namespace chdash
