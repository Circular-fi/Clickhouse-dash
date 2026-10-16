#pragma once

// The record of one request of POST /mcp (docs/mcp.md, "Call log"; docs/server-telemetry.md):
// - the call log line mcp.call (contract 7.5), always written;
// - when the telemetry { } block is on, the SERVER span of the request (contract 7.4), one CLIENT child span for each ClickHouse
//   statement of the call, and the call log as an OTLP log record.
// The record never holds an argument, SQL, data or a token.

#include "ch_query.hpp"
#include "log.hpp"
#include "mcp_trace.hpp"
#include "otlp_export.hpp"

#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace chdash {

struct McpCallRecord {
  std::string instance;
  std::string key = "-";
  std::string key_source = "-";
  std::string subject = "-";
  std::string client_name;
  std::string client_version;
  std::string client_address;
  std::string protocol_version;
  std::string method = "request";
  std::string tool;
  std::string host;
  std::string request_id;  // the JSON-RPC id, as text; empty when it is not known
  uint64_t rows = 0;
  McpTraceContext trace;
  std::string trace_id;  // of the SERVER span: the trace of the context, or a new one
  std::string span_id;
  std::chrono::system_clock::time_point started = std::chrono::system_clock::now();

  // The fields of the call log, in their order. The fields point into this record and into `status`: keep the two while the vector
  // is used.
  std::vector<LogField> log_fields(const std::string& status, int64_t duration_ms, uint64_t bytes) const;
  // Writes the JSON line mcp.call.
  void write(const std::string& status, int64_t duration_ms, uint64_t bytes) const;
};

// The ClickHouse statements of one call, as ChQueryLimits::on_statement gives them. More than kMaxStatements are counted, not kept.
class McpStatementSpans {
public:
  static constexpr size_t kMaxStatements = 256;
  void add(const ChStatementRecord& record);
  std::vector<ChStatementRecord> take();
  uint64_t dropped() const;

private:
  mutable std::mutex mu_;
  std::vector<ChStatementRecord> statements_;
  uint64_t dropped_ = 0;
};

// The spans of one request: the SERVER span first, then one CLIENT span for each statement. `record.trace_id` and `record.span_id`
// must be set. Empty when the parent of the context is not sampled.
std::vector<OtlpSpan> mcp_call_spans(const McpCallRecord& record, const std::string& status, std::chrono::system_clock::time_point ended,
                                    const std::vector<ChStatementRecord>& statements);

// The call log as an OTLP log record: the fields of the JSON line as attributes, the event name mcp.call, and the identifiers of
// the SERVER span.
OtlpLogRecord mcp_call_log_record(const McpCallRecord& record, const std::string& status, int64_t duration_ms, uint64_t bytes,
                                  std::chrono::system_clock::time_point ended);

} // namespace chdash
