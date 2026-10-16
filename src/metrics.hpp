#pragma once

// The metrics of the server, in the Prometheus text format (GET /metrics, docs/operations.md "Metrics").
// This file holds the counters of the HTTP layer, and the writer of the samples. Server::handle_metrics reads the samples from the rest of the server.
// The rest of the server has the sessions, streams, exports, hosts and ClickHouse connections.

#include <httplib.h>

#include <array>
#include <atomic>
#include <cstdint>
#include <initializer_list>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <utility>

namespace chdash {

// One metric family: "# HELP" and "# TYPE" lines.
void prom_family(std::string& out, std::string_view name, std::string_view type, std::string_view help);
// One sample: name{label="value",...} value. A label value is escaped (\\, \", \n).
void prom_sample(std::string& out, std::string_view name,
                 std::initializer_list<std::pair<std::string_view, std::string_view>> labels, double value);

class HttpMetrics {
public:
  // The upper bounds (seconds) of the buckets of chdash_http_request_duration_seconds.
  static constexpr std::array<double, 11> kBuckets{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10};

  // A request enters the route lookup. It stays in flight until its answer starts.
  void request_started() { in_flight_.fetch_add(1, std::memory_order_relaxed); }
  // The answer of a request starts. This records its method, its route (the pattern of the handler; "" when none matched) and its status.
  // It also records the time from the first byte to the answer headers. `started` says whether request_started counted the request.
  void request_answered(std::string_view method, std::string_view route, int status, double seconds, bool started);

  // The connections of the worker pool (MeteredTaskQueue): one task is one connection and its keep-alive requests.
  std::atomic<int64_t> connections_queued{0};
  std::atomic<int64_t> connections_active{0};
  std::atomic<uint64_t> connections_refused{0};

  int64_t in_flight() const { return in_flight_.load(std::memory_order_relaxed); }

  void write(std::string& out) const;

private:
  struct Route {
    std::map<int, uint64_t> by_status;
    std::array<uint64_t, kBuckets.size()> buckets{};
    uint64_t count = 0;
    double seconds = 0.0;
  };

  std::atomic<int64_t> in_flight_{0};
  mutable std::mutex mu_;
  // (method, route); bounded by the routes of the server.
  std::map<std::pair<std::string, std::string>, Route> routes_;
};

// The histogram mcp_server_operation_duration_seconds (contract 8.2) gives the time of each request of POST /mcp, by method, tool and status.
// It follows the OpenTelemetry metric mcp.server.operation.duration.
// A label never holds a run_id, a token or an argument (contract 8.3).
// The caller gives a method from a fixed list, a tool of the catalog or "", and a status that the server writes.
class McpOperationMetrics {
public:
  // The upper bounds (seconds) of the buckets: the ones that the OpenTelemetry semantic conventions of MCP advise.
  static constexpr std::array<double, 14> kBuckets{0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300};
  // A label set past this limit goes to status "other" of its method and tool. So, the series stay bounded.
  static constexpr size_t kMaxSeries = 2000;

  void observe(std::string_view method, std::string_view tool, std::string_view status, double seconds);
  void write(std::string& out) const;

private:
  struct Series {
    std::array<uint64_t, kBuckets.size()> buckets{};
    uint64_t count = 0;
    double seconds = 0.0;
  };
  mutable std::mutex mu_;
  std::map<std::array<std::string, 3>, Series> series_;
};

// The task queue of the HTTP server. It is the bounded httplib::ThreadPool of the server { } block.
// The metrics count the connections that wait, run and are refused. They are counted in `metrics`.
class MeteredTaskQueue final : public httplib::TaskQueue {
public:
  MeteredTaskQueue(size_t threads, size_t max_threads, size_t max_queued, std::shared_ptr<HttpMetrics> metrics);
  bool enqueue(std::function<void()> fn) override;
  void shutdown() override { pool_.shutdown(); }
  void on_idle() override { pool_.on_idle(); }

private:
  httplib::ThreadPool pool_;
  std::shared_ptr<HttpMetrics> metrics_;
};

} // namespace chdash
