#include "metrics.hpp"

#include <cmath>
#include <cstdio>

namespace chdash {

namespace {

void append_number(std::string& out, double value) {
  if (std::isnan(value)) {
    out += "NaN";
  } else if (std::isinf(value)) {
    out += value > 0 ? "+Inf" : "-Inf";
  } else if (value == std::floor(value) && std::fabs(value) < 9.0e15) {
    out += std::to_string(static_cast<int64_t>(value));
  } else {
    char text[32];
    std::snprintf(text, sizeof(text), "%.9g", value);
    out += text;
  }
}

void append_label_value(std::string& out, std::string_view value) {
  for (const char c : value) {
    if (c == '\\') out += "\\\\";
    else if (c == '"') out += "\\\"";
    else if (c == '\n') out += "\\n";
    else out.push_back(c);
  }
}

} // namespace

void prom_family(std::string& out, std::string_view name, std::string_view type, std::string_view help) {
  out += "# HELP ";
  out += name;
  out.push_back(' ');
  out += help;
  out += "\n# TYPE ";
  out += name;
  out.push_back(' ');
  out += type;
  out.push_back('\n');
}

void prom_sample(std::string& out, std::string_view name,
                 std::initializer_list<std::pair<std::string_view, std::string_view>> labels, double value) {
  out += name;
  if (labels.size() > 0) {
    out.push_back('{');
    bool first = true;
    for (const auto& [key, text] : labels) {
      if (!first) out.push_back(',');
      first = false;
      out += key;
      out += "=\"";
      append_label_value(out, text);
      out.push_back('"');
    }
    out.push_back('}');
  }
  out.push_back(' ');
  append_number(out, value);
  out.push_back('\n');
}

void HttpMetrics::request_answered(std::string_view method, std::string_view route, int status, double seconds, bool started) {
  if (started) in_flight_.fetch_sub(1, std::memory_order_relaxed);
  std::lock_guard<std::mutex> lock(mu_);
  Route& stats = routes_[{std::string(method), std::string(route)}];
  ++stats.by_status[status];
  ++stats.count;
  stats.seconds += seconds;
  for (size_t i = 0; i < kBuckets.size(); ++i) {
    if (seconds <= kBuckets[i]) ++stats.buckets[i];
  }
}

void HttpMetrics::write(std::string& out) const {
  prom_family(out, "chdash_http_requests_in_flight", "gauge", "Requests between their routing and the start of their answer.");
  prom_sample(out, "chdash_http_requests_in_flight", {}, static_cast<double>(in_flight()));
  prom_family(out, "chdash_http_connections_queued", "gauge", "Connections that wait for a worker thread.");
  prom_sample(out, "chdash_http_connections_queued", {}, static_cast<double>(connections_queued.load(std::memory_order_relaxed)));
  prom_family(out, "chdash_http_connections_active", "gauge", "Connections that a worker thread serves (a stream holds one).");
  prom_sample(out, "chdash_http_connections_active", {}, static_cast<double>(connections_active.load(std::memory_order_relaxed)));
  prom_family(out, "chdash_http_connections_refused_total", "counter", "Connections closed at once: the queue was full.");
  prom_sample(out, "chdash_http_connections_refused_total", {}, static_cast<double>(connections_refused.load(std::memory_order_relaxed)));

  std::lock_guard<std::mutex> lock(mu_);
  prom_family(out, "chdash_http_requests_total", "counter", "Answered requests, by method, route pattern and status.");
  for (const auto& [key, stats] : routes_) {
    const std::string route = key.second.empty() ? "-" : key.second;
    for (const auto& [status, count] : stats.by_status) {
      prom_sample(out, "chdash_http_requests_total", {{"method", key.first}, {"route", route}, {"code", std::to_string(status)}},
                  static_cast<double>(count));
    }
  }
  prom_family(out, "chdash_http_request_duration_seconds", "histogram",
              "Time from the first byte of a request to its answer headers (a stream counts until its first byte).");
  for (const auto& [key, stats] : routes_) {
    const std::string route = key.second.empty() ? "-" : key.second;
    for (size_t i = 0; i < kBuckets.size(); ++i) {
      std::string le;
      append_number(le, kBuckets[i]);
      prom_sample(out, "chdash_http_request_duration_seconds_bucket", {{"method", key.first}, {"route", route}, {"le", le}},
                  static_cast<double>(stats.buckets[i]));
    }
    prom_sample(out, "chdash_http_request_duration_seconds_bucket", {{"method", key.first}, {"route", route}, {"le", "+Inf"}},
                static_cast<double>(stats.count));
    prom_sample(out, "chdash_http_request_duration_seconds_sum", {{"method", key.first}, {"route", route}}, stats.seconds);
    prom_sample(out, "chdash_http_request_duration_seconds_count", {{"method", key.first}, {"route", route}},
                static_cast<double>(stats.count));
  }
}

void McpOperationMetrics::observe(std::string_view method, std::string_view tool, std::string_view status, double seconds) {
  std::lock_guard<std::mutex> lock(mu_);
  std::array<std::string, 3> labels{std::string(method), std::string(tool), std::string(status)};
  if (series_.size() >= kMaxSeries && series_.find(labels) == series_.end()) labels[2] = "other";
  Series& stats = series_[labels];
  ++stats.count;
  stats.seconds += seconds;
  for (size_t i = 0; i < kBuckets.size(); ++i) {
    if (seconds <= kBuckets[i]) ++stats.buckets[i];
  }
}

void McpOperationMetrics::write(std::string& out) const {
  prom_family(out, "mcp_server_operation_duration_seconds", "histogram",
              "Time of each request of the MCP endpoint, by method, tool and status (OpenTelemetry mcp.server.operation.duration).");
  std::lock_guard<std::mutex> lock(mu_);
  for (const auto& [labels, stats] : series_) {
    const std::string_view method = labels[0];
    const std::string_view tool = labels[1];
    const std::string_view status = labels[2];
    for (size_t i = 0; i < kBuckets.size(); ++i) {
      std::string le;
      append_number(le, kBuckets[i]);
      prom_sample(out, "mcp_server_operation_duration_seconds_bucket", {{"method", method}, {"tool", tool}, {"status", status}, {"le", le}},
                  static_cast<double>(stats.buckets[i]));
    }
    prom_sample(out, "mcp_server_operation_duration_seconds_bucket", {{"method", method}, {"tool", tool}, {"status", status}, {"le", "+Inf"}},
                static_cast<double>(stats.count));
    prom_sample(out, "mcp_server_operation_duration_seconds_sum", {{"method", method}, {"tool", tool}, {"status", status}}, stats.seconds);
    prom_sample(out, "mcp_server_operation_duration_seconds_count", {{"method", method}, {"tool", tool}, {"status", status}},
                static_cast<double>(stats.count));
  }
}

MeteredTaskQueue::MeteredTaskQueue(size_t threads, size_t max_threads, size_t max_queued, std::shared_ptr<HttpMetrics> metrics)
    : pool_(threads, max_threads, max_queued), metrics_(std::move(metrics)) {}

bool MeteredTaskQueue::enqueue(std::function<void()> fn) {
  auto metrics = metrics_;
  metrics->connections_queued.fetch_add(1, std::memory_order_relaxed);
  const bool queued = pool_.enqueue([metrics, task = std::move(fn)] {
    metrics->connections_queued.fetch_sub(1, std::memory_order_relaxed);
    metrics->connections_active.fetch_add(1, std::memory_order_relaxed);
    struct Done {
      HttpMetrics& m;
      ~Done() { m.connections_active.fetch_sub(1, std::memory_order_relaxed); }
    } done{*metrics};
    task();
  });
  if (!queued) {
    metrics->connections_queued.fetch_sub(1, std::memory_order_relaxed);
    metrics->connections_refused.fetch_add(1, std::memory_order_relaxed);
  }
  return queued;
}

} // namespace chdash
