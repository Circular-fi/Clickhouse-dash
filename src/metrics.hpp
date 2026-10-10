#pragma once

// The metrics of the server, as the Prometheus text format (GET /metrics, docs/operations.md "Metrics"): the
// counters of the HTTP layer kept here, and the writer of the samples that Server::handle_metrics reads from the
// rest of the server (sessions, streams, exports, hosts, ClickHouse connections).

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

  // A request entered the routing (in flight until its answer starts).
  void request_started() { in_flight_.fetch_add(1, std::memory_order_relaxed); }
  // The answer of a request starts: its method, its route (the pattern of the handler; "" when none matched), its
  // status and the time from its first byte to the answer headers. `started` says whether request_started counted it.
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

// The task queue of the HTTP server: the bounded httplib::ThreadPool of the server { } block, with the connections that
// wait, run and are refused counted in `metrics`.
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
