#pragma once

// The MCP wire protocol (docs/mcp.md): JSON-RPC 2.0 messages of the Streamable
// HTTP transport. The server sends each answer as one JSON body.
// The server keeps no session and no stream. The tools sit behind McpToolBackend.
// A fake backend can drive the tests.
//
// Two generations of the protocol use the one endpoint (contract 2.4 to 2.6):
// - 2026-07-28: each request has params._meta["io.modelcontextprotocol/protocolVersion"].
//   The headers MCP-Protocol-Version, Mcp-Method and Mcp-Name must agree with the message (-32020).
//   The version must be supported (-32022). Each result has resultType.
//   The methods are server/discover, tools/list and tools/call. There is no initialize and no ping.
// - legacy (2025-11-25, 2025-06-18, and the older 2025-03-26 and 2024-11-05): initialize, ping, tools/list, tools/call.

#include "mcp_keys.hpp"
#include "mcp_scope.hpp"
#include "mcp_trace.hpp"

#include <rapidjson/document.h>

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

// The version of the stateless protocol. initialize gives this version when it does not know the version of the client.
inline constexpr const char* kMcpModernProtocolVersion = "2026-07-28";
inline constexpr const char* kMcpLatestProtocolVersion = "2025-11-25";
// Every supported version, the newest first (data.supported of -32022, supportedVersions of server/discover).
const std::vector<std::string>& mcp_protocol_versions();
// The versions of the legacy generation (initialize), the newest first.
const std::vector<std::string>& mcp_legacy_protocol_versions();

// JSON-RPC error codes.
inline constexpr int kRpcParseError = -32700;
inline constexpr int kRpcInvalidRequest = -32600;
inline constexpr int kRpcMethodNotFound = -32601;
inline constexpr int kRpcInvalidParams = -32602;
inline constexpr int kRpcInternalError = -32603;
inline constexpr int kRpcUnauthorized = -32001;      // HTTP 401: no key, an unknown key or an expired key
inline constexpr int kRpcRateLimited = -32002;       // HTTP 429
inline constexpr int kRpcHeaderMismatch = -32020;    // HTTP 400: a header does not agree with the message
inline constexpr int kRpcUnsupportedVersion = -32022;  // HTTP 400: data.supported lists the versions

// The constant bodies of the refusals before the message (contract 2.7).
inline constexpr const char* kMcpUnauthorizedBody = R"({"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"unauthorized"}})";
inline constexpr const char* kMcpRateLimitedBody = R"({"jsonrpc":"2.0","id":null,"error":{"code":-32002,"message":"rate_limited"}})";

// The HTTP headers that the protocol compares with the message (2026-07-28). This struct also holds the trace context of the headers.
struct McpRequestHeaders {
  bool has_protocol_version = false;
  std::string protocol_version;  // MCP-Protocol-Version
  bool has_method = false;
  std::string method;            // Mcp-Method
  bool has_name = false;
  std::string name;              // Mcp-Name, as sent (the Base64 form =?base64?...?= is decoded before the comparison)
  bool repeated = false;         // one of the three headers came more than one time
  std::string traceparent;
  std::string baggage;
};

// What the tools of a call know besides the key. This is the agent that calls (agent.caller of the baggage).
// The tools use it for the log_comment of the ClickHouse statements. It is never a permission.
struct McpCallInfo {
  std::string agent_caller;
};

struct McpServerInfo {
  std::string name = "chdash";
  std::string title = "ChDash";
  std::string version = "dev";
};

// What a tool returns. `json` is one JSON object.
// On success, it holds the payload. On failure, it holds {"error": {"code", "message", "retryable"}} (contract 6.1).
// The server sends it as the text content. A client that reads it also gets it as structuredContent.
struct McpToolOutcome {
  bool is_error = false;
  std::string json;
  // For the audit line (never SQL, never data).
  std::string host;
  uint64_t rows = 0;
  std::string error_code;
};

// `message` is text that ChDash writes. `untrusted_detail` is text that ChDash did not write (an error of ClickHouse or of a
// route): when it is not empty, the error object holds it as untrusted.detail (contract 5.2).
McpToolOutcome mcp_tool_error(const std::string& code, const std::string& message, const std::string& untrusted_detail = std::string());
// The message of a tool error, from its code only. ChDash writes it: it never holds the text of ClickHouse.
std::string mcp_error_message(const std::string& code);
// A failure that a retry can repair: timeout, unavailable, api_unavailable.
bool mcp_error_retryable(const std::string& code);

class McpToolBackend {
public:
  virtual ~McpToolBackend() = default;
// The configuration enables the tools that need one of its values, such as the usage of the keys.
// The reading of all of it is another example. A tool whose needs are not met is not listed.
// A call to such a tool gives `not_enabled`. No tool is enabled by default.
  virtual McpToolAvailability availability() const { return {}; }
// `tool` is a tool of the catalog. The key holds it, and the configuration offers it. `arguments` is an object. `now` is Unix seconds.
  virtual McpToolOutcome call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments,
                                   int64_t now) = 0;
// The same, with the agent information of the call. By default, the implementation does not use this information.
  virtual McpToolOutcome call_tool_for(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments, int64_t now,
                                       const McpCallInfo& info) {
    (void)info;
    return call_tool(key, tool, arguments, now);
  }
};

struct McpRpcResult {
  // 202 with no body: a notification or a response of the client.
  int http_status = 200;
  std::string body;
// For the audit line and the usage. This is the method of a message whose method was read.
// The method is kept also when the request failed. It holds at most 128 bytes.
// The value is empty when the server could not read the message. Examples are text that is not JSON,
// a batch, a message without "jsonrpc": "2.0", or a method that is not text.
  std::string method;
  std::string tool;
  bool tool_called = false;
  McpToolOutcome outcome;
  int rpc_error = 0;
// The clientInfo of the client, at most 256 bytes each. It comes from initialize (legacy).
// Or it comes from _meta["io.modelcontextprotocol/clientInfo"] (2026-07-28).
// The server uses it for the usage of the key (mcp_usage.hpp) and for the call log.
  std::string client_name;
  std::string client_version;
// The protocol version of the request. It is 2026-07-28, or the legacy version from the header or from initialize. It is "" when neither gives a version.
  std::string protocol_version;
  bool modern = false;
// The trace context of the request. The server takes it from _meta. If _meta has none, it takes it from the headers (contract 7.3).
  McpTraceContext trace;
// The JSON-RPC id of the request as text. A string id is cut to 128 bytes.
// The value is the jsonrpc.request.id of the span of the request. It is empty for a notification.
// It is also empty for a message whose id the server could not read.
  std::string request_id;
};

// The JSON Schema of a tool's arguments, as JSON text.
const char* mcp_tool_input_schema(std::string_view tool);

// `headers` are the headers of the request. A tool result always has the JSON of the tool as text (content[0].text).
// The server also gives structuredContent, which is the same JSON again.
// It does so for a request of 2026-07-28, of 2025-06-18 or later, and for a request without the version header
// (docs/mcp.md, "Decisions").
McpRpcResult mcp_handle_message(std::string_view body, const McpKey& key, McpToolBackend& backend,
                                const McpServerInfo& info, int64_t now, const McpRequestHeaders& headers);
// The same, with the MCP-Protocol-Version header only. The value is "" when the request has no such header.
McpRpcResult mcp_handle_message(std::string_view body, const McpKey& key, McpToolBackend& backend,
                                const McpServerInfo& info, int64_t now, std::string_view protocol_version = {});

} // namespace chdash
