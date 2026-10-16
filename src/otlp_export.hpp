#pragma once

// The OTLP/HTTP export of the server (docs/server-telemetry.md): the spans and the log records that ChDash makes, encoded as OTLP
// JSON and sent by POST to <endpoint>/v1/traces and <endpoint>/v1/logs. It is not an OpenTelemetry SDK: it reads no environment
// variable, and its settings come from the telemetry { } block only.
//
// A request of ChDash never waits for the export. It puts its items in a bounded queue (a short lock, no I/O) and goes on. One
// thread sends the queue in batches: when a batch is full, or when the oldest item waited export_interval. When the queue is full,
// a new item is dropped and counted (chdash_telemetry_dropped_total{reason="queue_full"}). A batch that the receiver refuses, or
// that it does not answer, is sent again at most two times (only for a status that a retry can repair), then dropped and counted.

#include "telemetry_settings.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace chdash {

// One attribute: a key and a string, integer or boolean value.
struct OtlpAttribute {
  enum class Type { String, Int, Bool };
  std::string key;
  Type type = Type::String;
  std::string text;
  int64_t number = 0;
  bool flag = false;

  static OtlpAttribute string(std::string key, std::string value) {
    OtlpAttribute a;
    a.key = std::move(key);
    a.text = std::move(value);
    return a;
  }
  static OtlpAttribute integer(std::string key, int64_t value) {
    OtlpAttribute a;
    a.key = std::move(key);
    a.type = Type::Int;
    a.number = value;
    return a;
  }
  static OtlpAttribute boolean(std::string key, bool value) {
    OtlpAttribute a;
    a.key = std::move(key);
    a.type = Type::Bool;
    a.flag = value;
    return a;
  }
};

// One span. The identifiers are lower-case hexadecimal text (32 and 16 characters), as the OTLP JSON encoding writes them.
struct OtlpSpan {
  enum class Kind { Internal = 1, Server = 2, Client = 3 };
  std::string trace_id;
  std::string span_id;
  std::string parent_span_id;  // empty: a root span
  std::string name;
  Kind kind = Kind::Internal;
  uint64_t start_unix_nano = 0;
  uint64_t end_unix_nano = 0;
  std::vector<OtlpAttribute> attributes;
  bool error = false;  // the status code ERROR; else UNSET
  std::string status_message;
};

// One log record (the call log of contract 7.5).
struct OtlpLogRecord {
  uint64_t time_unix_nano = 0;
  std::string event_name;  // "mcp.call"
  std::string body;
  std::string trace_id;
  std::string span_id;
  std::vector<OtlpAttribute> attributes;
};

// The resource of every item (service.name and the others) and the instrumentation scope.
struct OtlpResource {
  std::vector<OtlpAttribute> attributes;
  std::string scope_name = "chdash";
  std::string scope_version;
};

// The bodies of the two requests (ExportTraceServiceRequest and ExportLogsServiceRequest, OTLP JSON encoding).
std::string otlp_traces_json(const OtlpResource& resource, const std::vector<OtlpSpan>& spans);
std::string otlp_logs_json(const OtlpResource& resource, const std::vector<OtlpLogRecord>& records);

// The current time, in nanoseconds since the Unix epoch.
uint64_t otlp_now_unix_nano();

struct OtlpExporterOptions {
  OtlpEndpoint endpoint;
  std::chrono::milliseconds export_interval{5000};
  std::chrono::milliseconds export_timeout{10000};
  std::chrono::milliseconds connect_timeout{2000};
  size_t max_queue_size = 2048;
  size_t max_export_batch_size = 512;
  // Send the log records. When false, add_log drops nothing and counts nothing: it does nothing.
  bool logs = true;
};

class OtlpExporter {
public:
  OtlpExporter(OtlpExporterOptions options, OtlpResource resource);
  // Stops the thread at once. Call shutdown() first to send what waits.
  ~OtlpExporter();
  OtlpExporter(const OtlpExporter&) = delete;
  OtlpExporter& operator=(const OtlpExporter&) = delete;

  // Puts the spans of one request in the queue, all or none: false when they do not all fit (they are then dropped and counted).
  // Never waits for the network.
  bool add_spans(std::vector<OtlpSpan> spans);
  // The same for one log record.
  bool add_log(OtlpLogRecord record);
  bool logs_enabled() const { return options_.logs; }

  // Sends what waits, for at most `budget`, then stops the thread. What is left is dropped and counted (reason "shutdown").
  void shutdown(std::chrono::milliseconds budget);

  // The counters of one signal.
  struct SignalStats {
    uint64_t exported = 0;
    uint64_t dropped_queue_full = 0;
    uint64_t dropped_export_failed = 0;
    uint64_t dropped_shutdown = 0;
    uint64_t requests_ok = 0;
    uint64_t requests_failed = 0;
    uint64_t queued = 0;
  };
  SignalStats span_stats() const;
  SignalStats log_stats() const;

  // The metric families chdash_telemetry_* (Prometheus text format), for GET /metrics.
  void write_metrics(std::string& out) const;

private:
  struct Signal {
    Signal(const char* signal_name, const char* signal_path) : name(signal_name), path(signal_path) {}
    const char* name;  // "spans" or "logs"
    const char* path;  // "/v1/traces" or "/v1/logs"
    std::deque<OtlpSpan> spans;
    std::deque<OtlpLogRecord> logs;
    std::chrono::steady_clock::time_point oldest{};
    std::atomic<uint64_t> exported{0};
    std::atomic<uint64_t> dropped_queue_full{0};
    std::atomic<uint64_t> dropped_export_failed{0};
    std::atomic<uint64_t> dropped_shutdown{0};
    std::atomic<uint64_t> requests_ok{0};
    std::atomic<uint64_t> requests_failed{0};
    std::atomic<uint64_t> queued{0};
    std::chrono::steady_clock::time_point last_warning{};
    size_t size() const { return spans.size() + logs.size(); }
  };

  void loop();
  // Moves one batch of `signal` out of its queue (with mu_ held); returns its size, 0 when the queue is empty.
  size_t take_batch(Signal& signal, std::vector<OtlpSpan>* spans, std::vector<OtlpLogRecord>* logs);
  // Sends one body: true when the receiver took it. Retries a status that a retry can repair, while time remains before `deadline`.
  bool send(Signal& signal, const std::string& body, size_t items, std::chrono::steady_clock::time_point deadline);
  SignalStats stats_of(const Signal& signal) const;

  const OtlpExporterOptions options_;
  const OtlpResource resource_;
  mutable std::mutex mu_;
  std::condition_variable cv_;
  bool stop_ = false;
  bool flush_ = false;
  std::chrono::steady_clock::time_point flush_deadline_{};
  Signal spans_{"spans", "/v1/traces"};
  Signal logs_{"logs", "/v1/logs"};
  std::thread thread_;
};

} // namespace chdash
