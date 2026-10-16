#pragma once

// The trace context of an MCP request (docs/mcp.md, "Trace context"; contract 7.3): W3C Trace Context (`traceparent`,
// `tracestate`) and W3C Baggage (`baggage`) with the keys agent.run_id, agent.caller and agent.on_behalf_of. The server reads
// the context in params._meta first and in the HTTP headers of the same names when _meta has none. The context never gives a
// permission: only the key does.

#include <string>
#include <string_view>

namespace chdash {

struct McpTraceContext {
  // From traceparent: 32 and 16 lower-case hexadecimal characters. Empty when there is no valid traceparent.
  std::string trace_id;
  std::string parent_span_id;
  // The flag "sampled" of traceparent (bit 0 of the flags). A call whose parent is not sampled exports no span (docs/server-telemetry.md);
  // the call log still has its identifiers. True when there is no traceparent.
  bool sampled = true;
  // The three values of the baggage, as text for a log record: printable characters only, at most 128 bytes each.
  std::string run_id;        // agent.run_id: the gen_ai.conversation.id of the call log
  std::string caller;        // agent.caller
  std::string on_behalf_of;  // agent.on_behalf_of
  // Where the context came from: "meta", "headers" or "" (no context).
  std::string source;
};

// Reads a traceparent (version 00: 00-<32 hex>-<16 hex>-<2 hex>). False for a value that is not valid, or an identifier of zeros.
bool mcp_parse_traceparent(std::string_view text, std::string* trace_id, std::string* span_id);

// Reads the three agent.* keys of a baggage header into `out`. The other keys are ignored. A value is percent-decoded, then cut.
void mcp_parse_baggage(std::string_view text, McpTraceContext* out);

// The context from the values of _meta when one of them is there, else from the values of the headers.
McpTraceContext mcp_trace_context(std::string_view meta_traceparent, std::string_view meta_baggage, bool meta_has_context,
                                  std::string_view header_traceparent, std::string_view header_baggage);

// `bytes` random bytes as lower-case hexadecimal text (a span id: 8 bytes, a trace id: 16 bytes).
std::string mcp_random_hex(size_t bytes);

// A text for a field of a log record: printable ASCII and the bytes of UTF-8 sequences, a control character removed, at most
// `max_bytes` bytes (a sequence is not cut).
std::string mcp_log_text(std::string_view text, size_t max_bytes);

// The agent of a call in the log_comment of a ClickHouse statement: A-Z a-z 0-9 . _ - @ : / +, other bytes as _, at most 64.
std::string mcp_comment_caller(std::string_view caller);

} // namespace chdash
