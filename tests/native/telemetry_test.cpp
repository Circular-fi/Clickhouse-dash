// Unit tests of the OTLP export (docs/server-telemetry.md): the durations and the endpoint of the telemetry block, the JSON of the two
// requests, the first word of a statement, the spans and the log record of an MCP call, and the exporter against a fake OTLP receiver
// in the process (the batches, the interval, the queue that drops, the retries, the stop). No ClickHouse needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_TELEMETRY_TESTS=ON
//        cmake --build build --target chdash_telemetry_test
// Run:   ./build/chdash_telemetry_test   (exit code 0 = every check passed)

#include "native_check.hpp"

#include "ch_query.hpp"
#include "mcp_telemetry.hpp"
#include "otlp_export.hpp"
#include "telemetry_settings.hpp"

#include <httplib.h>
#include <rapidjson/document.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace chdash;

namespace {

rapidjson::Document parse(const std::string& text) {
  rapidjson::Document doc;
  doc.Parse(text.c_str(), text.size());
  return doc;
}

// The value of the attribute `key` of an OTLP attribute array, as text ("" when absent): a string, an integer (its text) or a boolean.
std::string attribute(const rapidjson::Value& attributes, const char* key) {
  for (const auto& a : attributes.GetArray()) {
    if (std::string(a["key"].GetString()) != key) continue;
    const auto& v = a["value"];
    if (v.HasMember("stringValue")) return v["stringValue"].GetString();
    if (v.HasMember("intValue")) return v["intValue"].GetString();
    if (v.HasMember("boolValue")) return v["boolValue"].GetBool() ? "true" : "false";
  }
  return "";
}

std::string span_attribute(const OtlpSpan& span, const char* key) {
  for (const auto& a : span.attributes) {
    if (a.key == key) return a.type == OtlpAttribute::Type::Int ? std::to_string(a.number) : a.text;
  }
  return "";
}

bool has_attribute(const OtlpSpan& span, const char* key) {
  for (const auto& a : span.attributes) {
    if (a.key == key) return true;
  }
  return false;
}

OtlpSpan sample_span(int n) {
  OtlpSpan span;
  span.trace_id = "0af7651916cd43dd8448eb211c80319c";
  span.span_id = mcp_random_hex(8);
  span.name = "span " + std::to_string(n);
  span.kind = OtlpSpan::Kind::Server;
  span.start_unix_nano = 1000;
  span.end_unix_nano = 2000;
  return span;
}

// A fake OTLP receiver: an HTTP server in the process on a free port of 127.0.0.1. It keeps the bodies that it gets, answers with the
// status that `next_status` gives (200 by default), and can hold each request until `release()`.
class FakeReceiver {
public:
  FakeReceiver() {
    const auto handle = [this](const httplib::Request& req, httplib::Response& res) {
      {
        std::unique_lock<std::mutex> lock(mu_);
        ++arrived_;
        cv_.notify_all();
        cv_.wait(lock, [this] { return !hold_; });
        bodies_.push_back({req.path, req.body});
        res.status = statuses_.empty() ? 200 : statuses_.front();
        if (!statuses_.empty()) statuses_.erase(statuses_.begin());
      }
      cv_.notify_all();
      res.set_content("{}", "application/json");
    };
    server_.Post(R"(.*)", handle);
    port_ = server_.bind_to_any_port("127.0.0.1");
    thread_ = std::thread([this] { server_.listen_after_bind(); });
    server_.wait_until_ready();
  }
  ~FakeReceiver() {
    release();
    server_.stop();
    thread_.join();
  }
  int port() const { return port_; }
  void answer(std::vector<int> statuses) {
    std::lock_guard<std::mutex> lock(mu_);
    statuses_ = std::move(statuses);
  }
  void hold() {
    std::lock_guard<std::mutex> lock(mu_);
    hold_ = true;
  }
  void release() {
    {
      std::lock_guard<std::mutex> lock(mu_);
      hold_ = false;
    }
    cv_.notify_all();
  }
  // Waits until `count` requests arrived (also those that are held); false after `timeout`.
  bool wait_arrived(size_t count, std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mu_);
    return cv_.wait_for(lock, timeout, [&] { return arrived_ >= count; });
  }
  // Waits until `count` bodies were kept; false after `timeout`.
  bool wait_bodies(size_t count, std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mu_);
    return cv_.wait_for(lock, timeout, [&] { return bodies_.size() >= count; });
  }
  std::vector<std::pair<std::string, std::string>> bodies() {
    std::lock_guard<std::mutex> lock(mu_);
    return bodies_;
  }
  size_t spans_received() {
    size_t total = 0;
    for (const auto& [path, body] : bodies()) {
      if (path.size() < 10 || path.substr(path.size() - 10) != "/v1/traces") continue;
      const auto doc = parse(body);
      total += doc["resourceSpans"][0]["scopeSpans"][0]["spans"].Size();
    }
    return total;
  }

private:
  httplib::Server server_;
  int port_ = 0;
  std::thread thread_;
  std::mutex mu_;
  std::condition_variable cv_;
  bool hold_ = false;
  size_t arrived_ = 0;
  std::vector<int> statuses_;
  std::vector<std::pair<std::string, std::string>> bodies_;
};

OtlpExporterOptions options_for(int port) {
  OtlpExporterOptions options;
  options.endpoint.host = "127.0.0.1";
  options.endpoint.port = port;
  options.export_interval = std::chrono::milliseconds(100);
  options.export_timeout = std::chrono::milliseconds(2000);
  options.connect_timeout = std::chrono::milliseconds(500);
  options.max_queue_size = 100;
  options.max_export_batch_size = 10;
  return options;
}

OtlpResource test_resource() {
  OtlpResource resource;
  resource.attributes.push_back(OtlpAttribute::string("service.name", "chdash-test"));
  resource.scope_version = "1.2.3";
  return resource;
}

// Waits until `predicate` is true; false after `timeout`.
bool eventually(const std::function<bool()>& predicate, std::chrono::milliseconds timeout) {
  const auto end = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < end) {
    if (predicate()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return predicate();
}

// ---- the settings ------------------------------------------------------------------------------------------------------------------

void test_durations() {
  CHECK(parse_duration_ms("500ms") == std::optional<int64_t>(500));
  CHECK(parse_duration_ms("15s") == std::optional<int64_t>(15000));
  CHECK(parse_duration_ms("2m") == std::optional<int64_t>(120000));
  CHECK(parse_duration_ms("1h") == std::optional<int64_t>(3600000));
  CHECK(parse_duration_ms("0s") == std::optional<int64_t>(0));
  // No coercion: every other text is refused.
  for (const char* bad : {"", "15", "1.5s", " 15s", "15s ", "-1s", "15S", "15sec", "s", "1d", "9999999999999s"}) CHECK(!parse_duration_ms(bad));
  CHECK_EQ(duration_text(500), std::string("500ms"));
  CHECK_EQ(duration_text(15000), std::string("15s"));
  CHECK_EQ(duration_text(1500), std::string("1500ms"));
  CHECK_EQ(duration_text(120000), std::string("2m"));
  CHECK_EQ(duration_text(3600000), std::string("1h"));
  CHECK_EQ(duration_text(0), std::string("0ms"));
}

void test_endpoint() {
  std::string error;
  auto e = otlp_parse_endpoint("http://otel-collector:4318", &error);
  CHECK(e && e->host == "otel-collector" && e->port == 4318 && e->base_path.empty());
  e = otlp_parse_endpoint("http://collector", &error);
  CHECK(e && e->host == "collector" && e->port == 80);
  e = otlp_parse_endpoint("http://collector:4318/otlp/", &error);
  CHECK(e && e->base_path == "/otlp");
  e = otlp_parse_endpoint("http://[::1]:4318", &error);
  CHECK(e && e->host == "::1" && e->port == 4318);
  CHECK(!otlp_parse_endpoint("https://collector:4318", &error) && error.find("TLS") != std::string::npos);
  CHECK(!otlp_parse_endpoint("collector:4318", &error));
  CHECK(!otlp_parse_endpoint("http://user:pass@collector:4318", &error) && error.find("password") != std::string::npos);
  CHECK(!otlp_parse_endpoint("http://collector:0", &error));
  CHECK(!otlp_parse_endpoint("http://collector:65536", &error));
  CHECK(!otlp_parse_endpoint("http://collector:43x8", &error));
  CHECK(!otlp_parse_endpoint("http://collector:", &error));
  CHECK(!otlp_parse_endpoint("http://:4318", &error));
  CHECK(!otlp_parse_endpoint("http://collector:4318/v1?x=1", &error));
  CHECK(!otlp_parse_endpoint("http://coll ector:4318", &error));
}

// ---- the encoding --------------------------------------------------------------------------------------------------------------------

void test_traces_json() {
  OtlpSpan server = sample_span(1);
  server.span_id = "b7ad6b7169203331";
  server.parent_span_id = "00f067aa0ba902b7";
  server.name = "tools/call query_table";
  server.start_unix_nano = 1700000000123456789ull;
  server.end_unix_nano = 1700000000223456789ull;
  server.attributes = {OtlpAttribute::string("mcp.method.name", "tools/call"), OtlpAttribute::integer("server.port", 9000),
                       OtlpAttribute::boolean("flag", true), OtlpAttribute::string("bad.utf8", std::string("a\xff" "b"))};
  server.error = true;
  server.status_message = "timeout";
  OtlpSpan child = sample_span(2);
  child.kind = OtlpSpan::Kind::Client;
  const auto doc = parse(otlp_traces_json(test_resource(), {server, child}));
  CHECK(!doc.HasParseError());
  const auto& rs = doc["resourceSpans"][0];
  CHECK_EQ(attribute(rs["resource"]["attributes"], "service.name"), std::string("chdash-test"));
  const auto& scope = rs["scopeSpans"][0];
  CHECK_EQ(std::string(scope["scope"]["name"].GetString()), std::string("chdash"));
  CHECK_EQ(std::string(scope["scope"]["version"].GetString()), std::string("1.2.3"));
  const auto& spans = scope["spans"];
  CHECK_EQ(spans.Size(), 2u);
  const auto& s = spans[0];
  CHECK_EQ(std::string(s["traceId"].GetString()), std::string("0af7651916cd43dd8448eb211c80319c"));
  CHECK_EQ(std::string(s["spanId"].GetString()), std::string("b7ad6b7169203331"));
  CHECK_EQ(std::string(s["parentSpanId"].GetString()), std::string("00f067aa0ba902b7"));
  CHECK_EQ(std::string(s["name"].GetString()), std::string("tools/call query_table"));
  CHECK_EQ(s["kind"].GetInt(), 2);
  // A 64-bit integer is a string in OTLP JSON.
  CHECK(s["startTimeUnixNano"].IsString());
  CHECK_EQ(std::string(s["startTimeUnixNano"].GetString()), std::string("1700000000123456789"));
  CHECK_EQ(std::string(s["endTimeUnixNano"].GetString()), std::string("1700000000223456789"));
  CHECK_EQ(attribute(s["attributes"], "server.port"), std::string("9000"));
  CHECK_EQ(attribute(s["attributes"], "flag"), std::string("true"));
  CHECK_EQ(attribute(s["attributes"], "bad.utf8"), std::string("a\xef\xbf\xbd" "b"));
  CHECK_EQ(s["status"]["code"].GetInt(), 2);
  CHECK_EQ(std::string(s["status"]["message"].GetString()), std::string("timeout"));
  const auto& c = spans[1];
  CHECK(!c.HasMember("parentSpanId"));
  CHECK(!c.HasMember("status"));
  CHECK_EQ(c["kind"].GetInt(), 3);
}

void test_logs_json() {
  OtlpLogRecord record;
  record.time_unix_nano = 42;
  record.event_name = "mcp.call";
  record.body = "mcp.call";
  record.trace_id = "0af7651916cd43dd8448eb211c80319c";
  record.span_id = "b7ad6b7169203331";
  record.attributes = {OtlpAttribute::string("status", "ok"), OtlpAttribute::integer("rows", 3)};
  const auto doc = parse(otlp_logs_json(test_resource(), {record}));
  CHECK(!doc.HasParseError());
  const auto& rl = doc["resourceLogs"][0];
  CHECK_EQ(attribute(rl["resource"]["attributes"], "service.name"), std::string("chdash-test"));
  const auto& r = rl["scopeLogs"][0]["logRecords"][0];
  CHECK_EQ(std::string(r["timeUnixNano"].GetString()), std::string("42"));
  CHECK_EQ(r["severityNumber"].GetInt(), 9);
  CHECK_EQ(std::string(r["eventName"].GetString()), std::string("mcp.call"));
  CHECK_EQ(std::string(r["body"]["stringValue"].GetString()), std::string("mcp.call"));
  CHECK_EQ(std::string(r["traceId"].GetString()), std::string("0af7651916cd43dd8448eb211c80319c"));
  CHECK_EQ(std::string(r["spanId"].GetString()), std::string("b7ad6b7169203331"));
  CHECK_EQ(attribute(r["attributes"], "status"), std::string("ok"));
  CHECK_EQ(attribute(r["attributes"], "rows"), std::string("3"));
}

void test_statement_operation() {
  CHECK_EQ(ch_statement_operation("SELECT 1"), std::string("SELECT"));
  CHECK_EQ(ch_statement_operation("  \n select 1"), std::string("SELECT"));
  CHECK_EQ(ch_statement_operation("-- a comment\n/* two */ (SELECT 1)"), std::string("SELECT"));
  CHECK_EQ(ch_statement_operation("WITH x AS (SELECT 1) SELECT * FROM x"), std::string("SELECT"));
  CHECK_EQ(ch_statement_operation("desc t"), std::string("DESCRIBE"));
  CHECK_EQ(ch_statement_operation("EXPLAIN PLAN SELECT 1"), std::string("EXPLAIN"));
  CHECK_EQ(ch_statement_operation("SHOW TABLES"), std::string("SHOW"));
  // A word that is not a statement gives "": the text of a statement never becomes the name of a span.
  CHECK_EQ(ch_statement_operation("secret_table_name"), std::string(""));
  CHECK_EQ(ch_statement_operation(""), std::string(""));
  CHECK_EQ(ch_statement_operation("/* only a comment"), std::string(""));
}

// ---- the spans of an MCP call -----------------------------------------------------------------------------------------------------

McpCallRecord sample_record() {
  McpCallRecord record;
  record.instance = "chdash-1";
  record.key = "k1";
  record.key_source = "config";
  record.client_address = "10.0.0.7";
  record.protocol_version = "2026-07-28";
  record.method = "tools/call";
  record.tool = "query_table";
  record.request_id = "7";
  record.rows = 3;
  record.trace = mcp_trace_context("00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01",
                                   "agent.run_id=run-1,agent.caller=planner,agent.on_behalf_of=alice", true, "", "");
  record.trace_id = record.trace.trace_id;
  record.span_id = "b7ad6b7169203331";
  return record;
}

void test_call_spans() {
  McpCallRecord record = sample_record();
  const auto ended = record.started + std::chrono::milliseconds(25);
  ChStatementRecord ok;
  ok.operation = "SELECT";
  ok.server_address = "clickhouse";
  ok.server_port = 9000;
  ok.started = record.started + std::chrono::milliseconds(2);
  ok.ended = record.started + std::chrono::milliseconds(20);
  ChStatementRecord failed = ok;
  failed.operation = "";
  failed.error_code = 159;
  failed.error_type = "159";
  ChStatementRecord cut = ok;
  cut.error_code = 394;
  cut.error_type = "394";

  auto spans = mcp_call_spans(record, "ok", ended, {ok, failed, cut});
  CHECK_EQ(spans.size(), 4u);
  const OtlpSpan& server = spans[0];
  CHECK_EQ(server.name, std::string("tools/call query_table"));
  CHECK(server.kind == OtlpSpan::Kind::Server);
  CHECK_EQ(server.trace_id, std::string("0af7651916cd43dd8448eb211c80319c"));
  CHECK_EQ(server.span_id, std::string("b7ad6b7169203331"));
  CHECK_EQ(server.parent_span_id, std::string("00f067aa0ba902b7"));
  CHECK_EQ(server.end_unix_nano - server.start_unix_nano, 25000000ull);
  CHECK_EQ(span_attribute(server, "mcp.method.name"), std::string("tools/call"));
  CHECK_EQ(span_attribute(server, "gen_ai.tool.name"), std::string("query_table"));
  CHECK_EQ(span_attribute(server, "gen_ai.operation.name"), std::string("execute_tool"));
  CHECK_EQ(span_attribute(server, "mcp.protocol.version"), std::string("2026-07-28"));
  CHECK_EQ(span_attribute(server, "jsonrpc.request.id"), std::string("7"));
  CHECK_EQ(span_attribute(server, "client.address"), std::string("10.0.0.7"));
  CHECK_EQ(span_attribute(server, "gen_ai.conversation.id"), std::string("run-1"));
  CHECK_EQ(span_attribute(server, "agent.run_id"), std::string("run-1"));
  CHECK_EQ(span_attribute(server, "agent.caller"), std::string("planner"));
  CHECK_EQ(span_attribute(server, "agent.on_behalf_of"), std::string("alice"));
  CHECK(!has_attribute(server, "error.type"));
  CHECK(!server.error);
  // The contract forbids these.
  CHECK(!has_attribute(server, "mcp.session.id"));
  CHECK(!has_attribute(server, "gen_ai.tool.call.arguments"));
  CHECK(!has_attribute(server, "gen_ai.tool.call.result"));

  for (size_t i = 1; i < spans.size(); ++i) {
    CHECK(spans[i].kind == OtlpSpan::Kind::Client);
    CHECK_EQ(spans[i].trace_id, server.trace_id);
    CHECK_EQ(spans[i].parent_span_id, server.span_id);
    CHECK_EQ(spans[i].span_id.size(), 16u);
    CHECK(spans[i].span_id != server.span_id);
    CHECK_EQ(span_attribute(spans[i], "db.system.name"), std::string("clickhouse"));
    CHECK_EQ(span_attribute(spans[i], "server.address"), std::string("clickhouse"));
    CHECK_EQ(span_attribute(spans[i], "server.port"), std::string("9000"));
  }
  CHECK_EQ(spans[1].name, std::string("SELECT"));
  CHECK_EQ(span_attribute(spans[1], "db.operation.name"), std::string("SELECT"));
  CHECK_EQ(spans[1].end_unix_nano - spans[1].start_unix_nano, 18000000ull);
  CHECK(!spans[1].error);
  CHECK_EQ(spans[2].name, std::string("clickhouse"));
  CHECK(spans[2].error);
  CHECK_EQ(span_attribute(spans[2], "error.type"), std::string("159"));
  CHECK_EQ(span_attribute(spans[2], "db.response.status_code"), std::string("159"));
  // A statement that the caller stopped when it had its rows is not a failure.
  CHECK(!spans[3].error);
  CHECK_EQ(span_attribute(spans[3], "db.response.status_code"), std::string("394"));

  // A failed call: error.type is its status, and the span status is ERROR.
  spans = mcp_call_spans(record, "rpc_-32602", ended, {});
  CHECK_EQ(spans.size(), 1u);
  CHECK(spans[0].error);
  CHECK_EQ(span_attribute(spans[0], "error.type"), std::string("rpc_-32602"));

  // A request without a tool: the name is the method only. Without a context, the span is a root span of a new trace.
  McpCallRecord bare;
  bare.method = "initialize";
  bare.trace_id = mcp_random_hex(16);
  bare.span_id = mcp_random_hex(8);
  spans = mcp_call_spans(bare, "ok", bare.started, {});
  CHECK_EQ(spans.size(), 1u);
  CHECK_EQ(spans[0].name, std::string("initialize"));
  CHECK(spans[0].parent_span_id.empty());
  CHECK(!has_attribute(spans[0], "gen_ai.tool.name"));
  CHECK(!has_attribute(spans[0], "gen_ai.operation.name"));
  CHECK(!has_attribute(spans[0], "agent.caller"));

  // A parent that is not sampled: no span. The log record still has the identifiers.
  McpCallRecord unsampled = sample_record();
  unsampled.trace = mcp_trace_context("00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-00", "", true, "", "");
  CHECK(!unsampled.trace.sampled);
  CHECK(mcp_call_spans(unsampled, "ok", ended, {ok}).empty());
  CHECK(sample_record().trace.sampled);
  CHECK(mcp_trace_context("", "", false, "", "").sampled);
}

void test_call_log_record() {
  const McpCallRecord record = sample_record();
  const OtlpLogRecord log = mcp_call_log_record(record, "ok", 25, 512, record.started);
  CHECK_EQ(log.event_name, std::string("mcp.call"));
  CHECK_EQ(log.trace_id, std::string("0af7651916cd43dd8448eb211c80319c"));
  CHECK_EQ(log.span_id, std::string("b7ad6b7169203331"));
  const auto doc = parse(otlp_logs_json(test_resource(), {log}));
  const auto& a = doc["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["attributes"];
  // The fields of the JSON line of contract 7.5.
  CHECK_EQ(attribute(a, "server"), std::string("chdash"));
  CHECK_EQ(attribute(a, "instance"), std::string("chdash-1"));
  CHECK_EQ(attribute(a, "key"), std::string("k1"));
  CHECK_EQ(attribute(a, "key_source"), std::string("config"));
  CHECK_EQ(attribute(a, "subject"), std::string("-"));
  CHECK_EQ(attribute(a, "client.address"), std::string("10.0.0.7"));
  CHECK_EQ(attribute(a, "mcp.protocol.version"), std::string("2026-07-28"));
  CHECK_EQ(attribute(a, "mcp.method.name"), std::string("tools/call"));
  CHECK_EQ(attribute(a, "gen_ai.tool.name"), std::string("query_table"));
  CHECK_EQ(attribute(a, "status"), std::string("ok"));
  CHECK_EQ(attribute(a, "duration_ms"), std::string("25"));
  CHECK_EQ(attribute(a, "rows"), std::string("3"));
  CHECK_EQ(attribute(a, "bytes"), std::string("512"));
  CHECK_EQ(attribute(a, "trace_id"), std::string("0af7651916cd43dd8448eb211c80319c"));
  CHECK_EQ(attribute(a, "span_id"), std::string("b7ad6b7169203331"));
  CHECK_EQ(attribute(a, "gen_ai.conversation.id"), std::string("run-1"));
  CHECK_EQ(attribute(a, "agent.caller"), std::string("planner"));
  CHECK_EQ(attribute(a, "agent.on_behalf_of"), std::string("alice"));
  CHECK_EQ(attribute(a, "host"), std::string("-"));
}

void test_statement_spans_cap() {
  McpStatementSpans statements;
  ChStatementRecord record;
  for (size_t i = 0; i < McpStatementSpans::kMaxStatements + 5; ++i) statements.add(record);
  CHECK_EQ(statements.dropped(), 5u);
  CHECK_EQ(statements.take().size(), McpStatementSpans::kMaxStatements);
  CHECK(statements.take().empty());
}

// A scope with on_statement keeps it in a copy (an API tool of MCP opens its own scope from the copy).
void test_scope_keeps_observer() {
  ChQueryLimits limits;
  int calls = 0;
  limits.on_statement = [&calls](const ChStatementRecord&) { ++calls; };
  ChQueryScope outer(std::move(limits));
  ChQueryLimits copy = ChQueryScope::current_copy();
  CHECK(static_cast<bool>(copy.on_statement));
  ChQueryScope inner(std::move(copy));
  ChQueryScope::current()->on_statement(ChStatementRecord{});
  CHECK_EQ(calls, 1);
}

// ---- the exporter ----------------------------------------------------------------------------------------------------------------

void test_exporter_batches() {
  FakeReceiver receiver;
  auto options = options_for(receiver.port());
  options.max_export_batch_size = 3;
  options.endpoint.base_path = "/otlp";
  OtlpExporter exporter(options, test_resource());
  for (int i = 0; i < 7; ++i) CHECK(exporter.add_spans({sample_span(i)}));
  CHECK(eventually([&] { return receiver.spans_received() == 7; }, std::chrono::milliseconds(5000)));
  CHECK(eventually([&] { return exporter.span_stats().exported == 7; }, std::chrono::milliseconds(2000)));
  for (const auto& [path, body] : receiver.bodies()) {
    CHECK_EQ(path, std::string("/otlp/v1/traces"));
    const auto doc = parse(body);
    CHECK(doc["resourceSpans"][0]["scopeSpans"][0]["spans"].Size() <= 3u);
    CHECK_EQ(attribute(doc["resourceSpans"][0]["resource"]["attributes"], "service.name"), std::string("chdash-test"));
  }
  CHECK(receiver.bodies().size() >= 3u);
  // The log records go to /v1/logs.
  OtlpLogRecord record;
  record.event_name = "mcp.call";
  CHECK(exporter.add_log(record));
  CHECK(eventually([&] {
    for (const auto& [path, body] : receiver.bodies()) {
      if (path == "/otlp/v1/logs") return true;
    }
    return false;
  }, std::chrono::milliseconds(3000)));
  CHECK_EQ(exporter.log_stats().exported, 1u);
  CHECK_EQ(exporter.span_stats().dropped_queue_full, 0u);
  exporter.shutdown(std::chrono::milliseconds(1000));
}

// One span waits for export_interval at most, though the batch is not full.
void test_exporter_interval() {
  FakeReceiver receiver;
  auto options = options_for(receiver.port());
  options.export_interval = std::chrono::milliseconds(200);
  OtlpExporter exporter(options, test_resource());
  const auto started = std::chrono::steady_clock::now();
  CHECK(exporter.add_spans({sample_span(1)}));
  CHECK(receiver.wait_bodies(1, std::chrono::milliseconds(3000)));
  const auto waited = std::chrono::steady_clock::now() - started;
  CHECK(waited >= std::chrono::milliseconds(150));
  CHECK(waited < std::chrono::milliseconds(2000));
  exporter.shutdown(std::chrono::milliseconds(1000));
}

// A receiver that does not answer never makes a request wait: the queue fills, then a new item is dropped and counted.
void test_exporter_drops_under_pressure() {
  FakeReceiver receiver;
  receiver.hold();
  auto options = options_for(receiver.port());
  options.max_queue_size = 4;
  options.max_export_batch_size = 2;
  options.export_timeout = std::chrono::milliseconds(5000);
  OtlpExporter exporter(options, test_resource());
  CHECK(exporter.add_spans({sample_span(1), sample_span(2)}));  // a full batch: the thread takes it and waits for the receiver
  CHECK(receiver.wait_arrived(1, std::chrono::milliseconds(3000)));
  const auto started = std::chrono::steady_clock::now();
  CHECK(exporter.add_spans({sample_span(3), sample_span(4)}));
  CHECK(exporter.add_spans({sample_span(5), sample_span(6)}));
  CHECK(!exporter.add_spans({sample_span(7)}));             // the queue holds 4
  CHECK(!exporter.add_spans({sample_span(8), sample_span(9)}));
  CHECK(std::chrono::steady_clock::now() - started < std::chrono::milliseconds(200));
  CHECK_EQ(exporter.span_stats().dropped_queue_full, 3u);
  CHECK_EQ(exporter.span_stats().queued, 4u);
  std::string metrics;
  exporter.write_metrics(metrics);
  CHECK(metrics.find("chdash_telemetry_dropped_total{signal=\"spans\",reason=\"queue_full\"} 3") != std::string::npos);
  CHECK(metrics.find("chdash_telemetry_queue_items{signal=\"spans\"} 4") != std::string::npos);
  CHECK(metrics.find("# TYPE chdash_telemetry_exported_total counter") != std::string::npos);
  CHECK(metrics.find("chdash_telemetry_export_requests_total{signal=\"logs\",result=\"error\"} 0") != std::string::npos);
  receiver.release();
  CHECK(eventually([&] { return exporter.span_stats().exported == 6; }, std::chrono::milliseconds(5000)));
  exporter.shutdown(std::chrono::milliseconds(1000));
}

// 503 can be repaired by a retry: the batch is sent again. 400 cannot: the batch is dropped and counted at once.
void test_exporter_retries() {
  {
    FakeReceiver receiver;
    receiver.answer({503, 503, 200});
    OtlpExporter exporter(options_for(receiver.port()), test_resource());
    CHECK(exporter.add_spans({sample_span(1)}));
    CHECK(eventually([&] { return exporter.span_stats().exported == 1; }, std::chrono::milliseconds(6000)));
    CHECK_EQ(exporter.span_stats().requests_failed, 2u);
    CHECK_EQ(exporter.span_stats().requests_ok, 1u);
    CHECK_EQ(exporter.span_stats().dropped_export_failed, 0u);
    exporter.shutdown(std::chrono::milliseconds(1000));
  }
  {
    FakeReceiver receiver;
    receiver.answer({400});
    OtlpExporter exporter(options_for(receiver.port()), test_resource());
    CHECK(exporter.add_spans({sample_span(1), sample_span(2)}));
    CHECK(eventually([&] { return exporter.span_stats().dropped_export_failed == 2; }, std::chrono::milliseconds(3000)));
    CHECK_EQ(exporter.span_stats().requests_failed, 1u);
    CHECK_EQ(exporter.span_stats().exported, 0u);
    exporter.shutdown(std::chrono::milliseconds(1000));
  }
  {
    // Three refusals: the batch is dropped after the third request.
    FakeReceiver receiver;
    receiver.answer({503, 503, 503});
    OtlpExporter exporter(options_for(receiver.port()), test_resource());
    CHECK(exporter.add_spans({sample_span(1)}));
    CHECK(eventually([&] { return exporter.span_stats().dropped_export_failed == 1; }, std::chrono::milliseconds(6000)));
    CHECK_EQ(exporter.span_stats().requests_failed, 3u);
    exporter.shutdown(std::chrono::milliseconds(1000));
  }
}

// The stop sends what waits, though the interval did not end.
void test_exporter_shutdown_flushes() {
  FakeReceiver receiver;
  auto options = options_for(receiver.port());
  options.export_interval = std::chrono::milliseconds(3600 * 1000);
  OtlpExporter exporter(options, test_resource());
  CHECK(exporter.add_spans({sample_span(1), sample_span(2)}));
  OtlpLogRecord record;
  CHECK(exporter.add_log(record));
  exporter.shutdown(std::chrono::milliseconds(3000));
  CHECK_EQ(receiver.spans_received(), 2u);
  CHECK_EQ(exporter.span_stats().exported, 2u);
  CHECK_EQ(exporter.log_stats().exported, 1u);
  // After the stop, nothing more is taken.
  CHECK(!exporter.add_spans({sample_span(3)}));
}

// A receiver that is not there: the stop ends within its budget and counts what it could not send.
void test_exporter_shutdown_receiver_down() {
  int port = 0;
  {
    FakeReceiver receiver;
    port = receiver.port();
  }  // the port is closed now
  auto options = options_for(port);
  options.export_interval = std::chrono::milliseconds(3600 * 1000);
  options.connect_timeout = std::chrono::milliseconds(200);
  options.export_timeout = std::chrono::milliseconds(200);
  OtlpExporter exporter(options, test_resource());
  CHECK(exporter.add_spans({sample_span(1)}));
  const auto started = std::chrono::steady_clock::now();
  exporter.shutdown(std::chrono::milliseconds(500));
  CHECK(std::chrono::steady_clock::now() - started < std::chrono::milliseconds(3000));
  const auto stats = exporter.span_stats();
  CHECK_EQ(stats.exported, 0u);
  CHECK_EQ(stats.dropped_export_failed + stats.dropped_shutdown, 1u);
}

// With call_log = false, the log records are not sent and not counted.
void test_exporter_without_logs() {
  FakeReceiver receiver;
  auto options = options_for(receiver.port());
  options.logs = false;
  OtlpExporter exporter(options, test_resource());
  CHECK(!exporter.logs_enabled());
  CHECK(exporter.add_log(OtlpLogRecord{}));
  exporter.shutdown(std::chrono::milliseconds(1000));
  CHECK(receiver.bodies().empty());
  CHECK_EQ(exporter.log_stats().exported, 0u);
  CHECK_EQ(exporter.log_stats().dropped_queue_full, 0u);
}

} // namespace

int main() {
  RUN(test_durations);
  RUN(test_endpoint);
  RUN(test_traces_json);
  RUN(test_logs_json);
  RUN(test_statement_operation);
  RUN(test_call_spans);
  RUN(test_call_log_record);
  RUN(test_statement_spans_cap);
  RUN(test_scope_keeps_observer);
  RUN(test_exporter_batches);
  RUN(test_exporter_interval);
  RUN(test_exporter_drops_under_pressure);
  RUN(test_exporter_retries);
  RUN(test_exporter_shutdown_flushes);
  RUN(test_exporter_shutdown_receiver_down);
  RUN(test_exporter_without_logs);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
