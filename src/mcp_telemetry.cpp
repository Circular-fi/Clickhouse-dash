#include "mcp_telemetry.hpp"

#include <algorithm>

namespace chdash {
namespace {

uint64_t unix_nano(std::chrono::system_clock::time_point at) {
  const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(at.time_since_epoch()).count();
  return ns > 0 ? static_cast<uint64_t>(ns) : 0;
}

void add_text(std::vector<OtlpAttribute>& out, const char* key, const std::string& value) {
  if (!value.empty()) out.push_back(OtlpAttribute::string(key, value));
}

// A statement that the caller stopped on purpose (it had the rows it needed) ends with one of these codes: not a failure.
bool canceled_on_purpose(int code) { return code == 394 || code == 735; }

} // namespace

std::vector<LogField> McpCallRecord::log_fields(const std::string& status, int64_t duration_ms, uint64_t bytes) const {
  static const std::string kNoHost = "-";
  return {{"server", "chdash"},
          {"instance", instance},
          {"key", key},
          {"key_source", key_source},
          {"subject", subject},
          {"client.name", client_name},
          {"client.version", client_version},
          {"client.address", client_address},
          {"mcp.protocol.version", protocol_version},
          {"mcp.method.name", method},
          {"gen_ai.tool.name", tool},
          {"status", status},
          {"duration_ms", duration_ms},
          {"rows", rows},
          {"bytes", bytes},
          {"trace_id", trace_id},
          {"span_id", span_id},
          {"gen_ai.conversation.id", trace.run_id},
          {"agent.caller", trace.caller},
          {"agent.on_behalf_of", trace.on_behalf_of},
          {"host", host.empty() ? kNoHost : host}};
}

void McpCallRecord::write(const std::string& status, int64_t duration_ms, uint64_t bytes) const {
  log_event(LogLevel::Info, "mcp.call", log_fields(status, duration_ms, bytes));
}

void McpStatementSpans::add(const ChStatementRecord& record) {
  std::lock_guard<std::mutex> lock(mu_);
  if (statements_.size() >= kMaxStatements) {
    ++dropped_;
    return;
  }
  statements_.push_back(record);
}

std::vector<ChStatementRecord> McpStatementSpans::take() {
  std::lock_guard<std::mutex> lock(mu_);
  return std::move(statements_);
}

uint64_t McpStatementSpans::dropped() const {
  std::lock_guard<std::mutex> lock(mu_);
  return dropped_;
}

std::vector<OtlpSpan> mcp_call_spans(const McpCallRecord& record, const std::string& status, std::chrono::system_clock::time_point ended,
                                    const std::vector<ChStatementRecord>& statements) {
  std::vector<OtlpSpan> out;
  if (!record.trace.sampled) return out;
  OtlpSpan server;
  server.trace_id = record.trace_id;
  server.span_id = record.span_id;
  // The parent is the span of the caller when the context gave a valid one (its trace is the trace of this span).
  if (!record.trace.trace_id.empty() && record.trace.trace_id == record.trace_id) server.parent_span_id = record.trace.parent_span_id;
  server.name = record.tool.empty() ? record.method : record.method + " " + record.tool;
  server.kind = OtlpSpan::Kind::Server;
  server.start_unix_nano = unix_nano(record.started);
  server.end_unix_nano = std::max(server.start_unix_nano, unix_nano(ended));
  auto& a = server.attributes;
  a.push_back(OtlpAttribute::string("mcp.method.name", record.method));
  add_text(a, "gen_ai.tool.name", record.tool);
  if (record.method == "tools/call") a.push_back(OtlpAttribute::string("gen_ai.operation.name", "execute_tool"));
  add_text(a, "mcp.protocol.version", record.protocol_version);
  add_text(a, "jsonrpc.request.id", record.request_id);
  add_text(a, "client.address", record.client_address);
  add_text(a, "gen_ai.conversation.id", record.trace.run_id);
  add_text(a, "agent.run_id", record.trace.run_id);
  add_text(a, "agent.caller", record.trace.caller);
  add_text(a, "agent.on_behalf_of", record.trace.on_behalf_of);
  if (status != "ok") {
    a.push_back(OtlpAttribute::string("error.type", status));
    server.error = true;
    server.status_message = status;
  }
  out.push_back(std::move(server));

  for (const ChStatementRecord& statement : statements) {
    OtlpSpan child;
    child.trace_id = record.trace_id;
    child.span_id = mcp_random_hex(8);
    child.parent_span_id = record.span_id;
    child.name = statement.operation.empty() ? std::string("clickhouse") : statement.operation;
    child.kind = OtlpSpan::Kind::Client;
    child.start_unix_nano = unix_nano(statement.started);
    child.end_unix_nano = std::max(child.start_unix_nano, unix_nano(statement.ended));
    auto& c = child.attributes;
    c.push_back(OtlpAttribute::string("db.system.name", "clickhouse"));
    add_text(c, "db.operation.name", statement.operation);
    add_text(c, "server.address", statement.server_address);
    if (statement.server_port > 0) c.push_back(OtlpAttribute::integer("server.port", statement.server_port));
    if (statement.error_code != 0) c.push_back(OtlpAttribute::string("db.response.status_code", std::to_string(statement.error_code)));
    if (!statement.error_type.empty() && !canceled_on_purpose(statement.error_code)) {
      c.push_back(OtlpAttribute::string("error.type", statement.error_type));
      child.error = true;
      child.status_message = statement.error_type;
    }
    out.push_back(std::move(child));
  }
  return out;
}

OtlpLogRecord mcp_call_log_record(const McpCallRecord& record, const std::string& status, int64_t duration_ms, uint64_t bytes,
                                  std::chrono::system_clock::time_point ended) {
  OtlpLogRecord out;
  out.time_unix_nano = unix_nano(ended);
  out.event_name = "mcp.call";
  out.body = "mcp.call";
  out.trace_id = record.trace_id;
  out.span_id = record.span_id;
  for (const LogField& field : record.log_fields(status, duration_ms, bytes)) {
    const std::string key(field.key());
    switch (field.kind()) {
      case LogField::Kind::String: out.attributes.push_back(OtlpAttribute::string(key, std::string(field.text()))); break;
      case LogField::Kind::Int: out.attributes.push_back(OtlpAttribute::integer(key, field.int_value())); break;
      case LogField::Kind::Uint: out.attributes.push_back(OtlpAttribute::integer(key, static_cast<int64_t>(field.uint_value()))); break;
      case LogField::Kind::Bool: out.attributes.push_back(OtlpAttribute::boolean(key, field.int_value() != 0)); break;
      case LogField::Kind::Double: out.attributes.push_back(OtlpAttribute::string(key, std::to_string(field.double_value()))); break;
    }
  }
  return out;
}

} // namespace chdash
