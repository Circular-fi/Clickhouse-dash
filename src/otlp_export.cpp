#include "otlp_export.hpp"

#include "json_text.hpp"
#include "log.hpp"
#include "metrics.hpp"

#include <httplib.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>

namespace chdash {
namespace {

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

// A retry of a failed batch waits this long, then twice as long.
constexpr std::chrono::milliseconds kRetryWait{500};
constexpr int kMaxAttempts = 3;
// One warning in the log for each signal and each minute, at most: a receiver that is down does not fill the log.
constexpr std::chrono::seconds kWarningInterval{60};

void put(Writer& w, std::string_view text) { write_json_text(w, text); }

// A 64-bit integer of OTLP JSON is a string (the JSON mapping of protobuf).
void put_u64(Writer& w, uint64_t value) { put(w, std::to_string(value)); }

void write_attributes(Writer& w, const std::vector<OtlpAttribute>& attributes) {
  w.Key("attributes");
  w.StartArray();
  for (const OtlpAttribute& a : attributes) {
    w.StartObject();
    w.Key("key");
    put(w, a.key);
    w.Key("value");
    w.StartObject();
    switch (a.type) {
      case OtlpAttribute::Type::String:
        w.Key("stringValue");
        put(w, a.text);
        break;
      case OtlpAttribute::Type::Int:
        w.Key("intValue");
        put(w, std::to_string(a.number));
        break;
      case OtlpAttribute::Type::Bool:
        w.Key("boolValue");
        w.Bool(a.flag);
        break;
    }
    w.EndObject();
    w.EndObject();
  }
  w.EndArray();
}

void write_resource_and_scope_start(Writer& w, const OtlpResource& resource, const char* scope_key) {
  w.Key("resource");
  w.StartObject();
  write_attributes(w, resource.attributes);
  w.EndObject();
  w.Key(scope_key);
  w.StartArray();
  w.StartObject();
  w.Key("scope");
  w.StartObject();
  w.Key("name");
  put(w, resource.scope_name);
  if (!resource.scope_version.empty()) {
    w.Key("version");
    put(w, resource.scope_version);
  }
  w.EndObject();
}

bool retryable_status(int status) { return status == 429 || status == 502 || status == 503 || status == 504; }

} // namespace

uint64_t otlp_now_unix_nano() {
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}

std::string otlp_traces_json(const OtlpResource& resource, const std::vector<OtlpSpan>& spans) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("resourceSpans");
  w.StartArray();
  w.StartObject();
  write_resource_and_scope_start(w, resource, "scopeSpans");
  w.Key("spans");
  w.StartArray();
  for (const OtlpSpan& span : spans) {
    w.StartObject();
    w.Key("traceId");
    put(w, span.trace_id);
    w.Key("spanId");
    put(w, span.span_id);
    if (!span.parent_span_id.empty()) {
      w.Key("parentSpanId");
      put(w, span.parent_span_id);
    }
    w.Key("name");
    put(w, span.name);
    w.Key("kind");
    w.Int(static_cast<int>(span.kind));
    w.Key("startTimeUnixNano");
    put_u64(w, span.start_unix_nano);
    w.Key("endTimeUnixNano");
    put_u64(w, span.end_unix_nano);
    write_attributes(w, span.attributes);
    if (span.error) {
      w.Key("status");
      w.StartObject();
      w.Key("code");
      w.Int(2);  // STATUS_CODE_ERROR
      if (!span.status_message.empty()) {
        w.Key("message");
        put(w, span.status_message);
      }
      w.EndObject();
    }
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();  // the scope
  w.EndArray();
  w.EndObject();  // the resource
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string otlp_logs_json(const OtlpResource& resource, const std::vector<OtlpLogRecord>& records) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("resourceLogs");
  w.StartArray();
  w.StartObject();
  write_resource_and_scope_start(w, resource, "scopeLogs");
  w.Key("logRecords");
  w.StartArray();
  for (const OtlpLogRecord& record : records) {
    w.StartObject();
    w.Key("timeUnixNano");
    put_u64(w, record.time_unix_nano);
    w.Key("observedTimeUnixNano");
    put_u64(w, record.time_unix_nano);
    w.Key("severityNumber");
    w.Int(9);  // SEVERITY_NUMBER_INFO
    w.Key("severityText");
    w.String("INFO");
    if (!record.event_name.empty()) {
      w.Key("eventName");
      put(w, record.event_name);
    }
    w.Key("body");
    w.StartObject();
    w.Key("stringValue");
    put(w, record.body);
    w.EndObject();
    write_attributes(w, record.attributes);
    if (!record.trace_id.empty()) {
      w.Key("traceId");
      put(w, record.trace_id);
    }
    if (!record.span_id.empty()) {
      w.Key("spanId");
      put(w, record.span_id);
    }
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();  // the scope
  w.EndArray();
  w.EndObject();  // the resource
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

// ---- OtlpExporter ---------------------------------------------------------------------------------------------------

OtlpExporter::OtlpExporter(OtlpExporterOptions options, OtlpResource resource)
    : options_(std::move(options)), resource_(std::move(resource)) {
  thread_ = std::thread([this] { loop(); });
}

OtlpExporter::~OtlpExporter() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    stop_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

bool OtlpExporter::add_spans(std::vector<OtlpSpan> spans) {
  if (spans.empty()) return true;
  bool wake = false;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (stop_ || flush_ || spans_.size() + spans.size() > options_.max_queue_size) {
      spans_.dropped_queue_full.fetch_add(spans.size(), std::memory_order_relaxed);
      return false;
    }
    // The thread wakes when the queue was empty (it then knows when the interval ends) and when a batch is full.
    const bool was_empty = spans_.size() == 0;
    if (was_empty) spans_.oldest = std::chrono::steady_clock::now();
    for (auto& span : spans) spans_.spans.push_back(std::move(span));
    spans_.queued.store(spans_.size(), std::memory_order_relaxed);
    wake = was_empty || spans_.size() >= options_.max_export_batch_size;
  }
  if (wake) cv_.notify_all();
  return true;
}

bool OtlpExporter::add_log(OtlpLogRecord record) {
  if (!options_.logs) return true;
  bool wake = false;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (stop_ || flush_ || logs_.size() + 1 > options_.max_queue_size) {
      logs_.dropped_queue_full.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    const bool was_empty = logs_.size() == 0;
    if (was_empty) logs_.oldest = std::chrono::steady_clock::now();
    logs_.logs.push_back(std::move(record));
    logs_.queued.store(logs_.size(), std::memory_order_relaxed);
    wake = was_empty || logs_.size() >= options_.max_export_batch_size;
  }
  if (wake) cv_.notify_all();
  return true;
}

void OtlpExporter::shutdown(std::chrono::milliseconds budget) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (stop_ || flush_) return;
    flush_ = true;
    flush_deadline_ = std::chrono::steady_clock::now() + budget;
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

size_t OtlpExporter::take_batch(Signal& signal, std::vector<OtlpSpan>* spans, std::vector<OtlpLogRecord>* logs) {
  // Called with mu_ held: only moves the items. The encoding is done after the lock is released.
  size_t count = 0;
  if (!signal.spans.empty()) {
    count = std::min(signal.spans.size(), options_.max_export_batch_size);
    spans->reserve(count);
    for (size_t i = 0; i < count; ++i) {
      spans->push_back(std::move(signal.spans.front()));
      signal.spans.pop_front();
    }
  } else if (!signal.logs.empty()) {
    count = std::min(signal.logs.size(), options_.max_export_batch_size);
    logs->reserve(count);
    for (size_t i = 0; i < count; ++i) {
      logs->push_back(std::move(signal.logs.front()));
      signal.logs.pop_front();
    }
  }
  signal.queued.store(signal.size(), std::memory_order_relaxed);
  if (signal.size() != 0) signal.oldest = std::chrono::steady_clock::now();
  return count;
}

bool OtlpExporter::send(Signal& signal, const std::string& body, size_t items, std::chrono::steady_clock::time_point deadline) {
  httplib::Client client(options_.endpoint.host, options_.endpoint.port);
  client.set_keep_alive(false);
  const std::string path = options_.endpoint.base_path + signal.path;
  std::string last_error;
  for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) break;
    const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    const auto timeout = std::min(options_.export_timeout, left);
    const auto connect = std::min(options_.connect_timeout, timeout);
    client.set_connection_timeout(connect);
    client.set_read_timeout(timeout);
    client.set_write_timeout(timeout);
    client.set_max_timeout(timeout);
    const auto result = client.Post(path, body, "application/json");
    bool retry = false;
    if (!result) {
      last_error = httplib::to_string(result.error());
      retry = true;
    } else if (result->status >= 200 && result->status < 300) {
      signal.requests_ok.fetch_add(1, std::memory_order_relaxed);
      signal.exported.fetch_add(items, std::memory_order_relaxed);
      return true;
    } else {
      last_error = "HTTP " + std::to_string(result->status);
      retry = retryable_status(result->status);
    }
    signal.requests_failed.fetch_add(1, std::memory_order_relaxed);
    if (!retry || attempt == kMaxAttempts) break;
    // The wait before the next attempt ends at once when the exporter stops.
    std::unique_lock<std::mutex> lock(mu_);
    const auto wait_until = std::min(deadline, std::chrono::steady_clock::now() + kRetryWait * attempt);
    cv_.wait_until(lock, wait_until, [this] { return stop_; });
    if (stop_) break;
  }
  signal.dropped_export_failed.fetch_add(items, std::memory_order_relaxed);
  const auto now = std::chrono::steady_clock::now();
  bool warn = false;
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (signal.last_warning == std::chrono::steady_clock::time_point{} || now - signal.last_warning >= kWarningInterval) {
      signal.last_warning = now;
      warn = true;
    }
  }
  if (warn) {
    log_event(LogLevel::Warn, "telemetry.export_failed",
              {{"signal", signal.name}, {"path", path}, {"error", last_error}, {"dropped", static_cast<uint64_t>(items)}});
  }
  return false;
}

void OtlpExporter::loop() {
  std::unique_lock<std::mutex> lock(mu_);
  const auto due = [this](const Signal& signal, std::chrono::steady_clock::time_point now) {
    const size_t size = signal.size();
    return size >= options_.max_export_batch_size || (size > 0 && now - signal.oldest >= options_.export_interval);
  };
  while (true) {
    if (stop_) break;
    const auto now = std::chrono::steady_clock::now();
    if (!flush_ && !due(spans_, now) && !due(logs_, now)) {
      // Nothing to send: wait for the end of the interval of the oldest item, or for a call of add_* that changes it.
      auto wake_at = now + std::chrono::hours(1);
      for (const Signal* signal : {&spans_, &logs_}) {
        if (signal->size() > 0) wake_at = std::min(wake_at, signal->oldest + options_.export_interval);
      }
      cv_.wait_until(lock, wake_at);
      continue;
    }
    for (Signal* signal : {&spans_, &logs_}) {
      while (!stop_ && (flush_ || due(*signal, std::chrono::steady_clock::now()))) {
        if (flush_ && std::chrono::steady_clock::now() >= flush_deadline_) break;
        std::vector<OtlpSpan> spans;
        std::vector<OtlpLogRecord> logs;
        const size_t items = take_batch(*signal, &spans, &logs);
        if (items == 0) break;
        // All the attempts of one batch: three requests and the two waits between them. At the stop, what remains of the budget.
        const auto deadline = flush_ ? flush_deadline_
                                     : std::chrono::steady_clock::now() + options_.export_timeout * kMaxAttempts + kRetryWait * 3;
        lock.unlock();
        const std::string body = spans.empty() ? otlp_logs_json(resource_, logs) : otlp_traces_json(resource_, spans);
        send(*signal, body, items, deadline);
        lock.lock();
      }
    }
    if (flush_) break;
  }
  // What is left when the exporter stops is dropped and counted.
  for (Signal* signal : {&spans_, &logs_}) {
    signal->dropped_shutdown.fetch_add(signal->size(), std::memory_order_relaxed);
    signal->spans.clear();
    signal->logs.clear();
    signal->queued.store(0, std::memory_order_relaxed);
  }
}

OtlpExporter::SignalStats OtlpExporter::stats_of(const Signal& signal) const {
  SignalStats out;
  out.exported = signal.exported.load(std::memory_order_relaxed);
  out.dropped_queue_full = signal.dropped_queue_full.load(std::memory_order_relaxed);
  out.dropped_export_failed = signal.dropped_export_failed.load(std::memory_order_relaxed);
  out.dropped_shutdown = signal.dropped_shutdown.load(std::memory_order_relaxed);
  out.requests_ok = signal.requests_ok.load(std::memory_order_relaxed);
  out.requests_failed = signal.requests_failed.load(std::memory_order_relaxed);
  out.queued = signal.queued.load(std::memory_order_relaxed);
  return out;
}

OtlpExporter::SignalStats OtlpExporter::span_stats() const { return stats_of(spans_); }
OtlpExporter::SignalStats OtlpExporter::log_stats() const { return stats_of(logs_); }

void OtlpExporter::write_metrics(std::string& out) const {
  const SignalStats spans = span_stats();
  const SignalStats logs = log_stats();
  const auto both = [&](const char* name, uint64_t SignalStats::*field) {
    prom_sample(out, name, {{"signal", "spans"}}, static_cast<double>(spans.*field));
    prom_sample(out, name, {{"signal", "logs"}}, static_cast<double>(logs.*field));
  };
  prom_family(out, "chdash_telemetry_exported_total", "counter", "Items (spans, log records) that the OTLP receiver took.");
  both("chdash_telemetry_exported_total", &SignalStats::exported);
  prom_family(out, "chdash_telemetry_dropped_total", "counter",
              "Items that were not sent: queue_full (the queue was full), export_failed (the receiver did not take the batch), shutdown (left at the stop).");
  for (const auto& [signal, stats] : {std::pair<const char*, const SignalStats*>{"spans", &spans}, {"logs", &logs}}) {
    prom_sample(out, "chdash_telemetry_dropped_total", {{"signal", signal}, {"reason", "queue_full"}}, static_cast<double>(stats->dropped_queue_full));
    prom_sample(out, "chdash_telemetry_dropped_total", {{"signal", signal}, {"reason", "export_failed"}}, static_cast<double>(stats->dropped_export_failed));
    prom_sample(out, "chdash_telemetry_dropped_total", {{"signal", signal}, {"reason", "shutdown"}}, static_cast<double>(stats->dropped_shutdown));
  }
  prom_family(out, "chdash_telemetry_export_requests_total", "counter", "Export requests to the OTLP receiver, by result (a retry is one more request).");
  for (const auto& [signal, stats] : {std::pair<const char*, const SignalStats*>{"spans", &spans}, {"logs", &logs}}) {
    prom_sample(out, "chdash_telemetry_export_requests_total", {{"signal", signal}, {"result", "ok"}}, static_cast<double>(stats->requests_ok));
    prom_sample(out, "chdash_telemetry_export_requests_total", {{"signal", signal}, {"result", "error"}}, static_cast<double>(stats->requests_failed));
  }
  prom_family(out, "chdash_telemetry_queue_items", "gauge", "Items that wait in the export queue.");
  both("chdash_telemetry_queue_items", &SignalStats::queued);
}

} // namespace chdash
