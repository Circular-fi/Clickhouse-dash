#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace clickhouse { class Client; }

namespace chdash {

int normalize_health_interval_ms(int interval_ms);

struct HostSpec {
  std::string id;         // stable id used by frontend (stored in localStorage)
  std::string label;      // display name
  std::string runner_uri; // clickhouse://...
  std::string system_uri; // clickhouse://...
};

struct HealthSettings {
  int interval_ms = 5000;
  int timeout_ms = 800;
};

struct HostSystemTables {
  bool checked = false;
  int64_t checked_at_ms = 0;
  bool query_log = false;
  bool query_thread_log = false;
  bool trace_log = false;
  bool processors_profile_log = false;
  bool jemalloc_profile_text = false;
  bool logs_table_available = false;
  bool flamegraph_tables_available = false;
};

struct HostHealth {
  std::string id;
  std::string label;
  bool healthy = false;
  int64_t ping_ms = -1;
  int64_t checked_at_ms = 0;
  std::string clickhouse_version;
  int64_t version_checked_at_ms = 0;
  HostSystemTables system_tables;
};

struct HostsSnapshot {
  int64_t ts_ms = 0;
  int interval_ms = 5000;
  int timeout_ms = 800;
  std::vector<HostHealth> hosts;
};

class HealthRunner {
public:
  HealthRunner(std::vector<HostSpec> hosts, HealthSettings settings);
  ~HealthRunner();

  void start();
  void stop();

  HostsSnapshot snapshot() const;

  // Monotonic snapshot version that increments after each health check cycle.
  uint64_t version() const;

  // Blocks until version changes from last_version or wait_ms elapses.
  // Returns true if version changed.
  bool wait_for_update(uint64_t last_version, int wait_ms, uint64_t* new_version);

  // Strict: all hosts healthy.
  bool all_healthy() const;

private:
  void loop();

  std::vector<HostSpec> hosts_;
  HealthSettings settings_;

  // One system client per host, owned by the runner thread.
  struct HostCtx {
    HostSpec spec;
    std::shared_ptr<clickhouse::Client> client;
    HostHealth last;
  };

  mutable std::mutex mu_;
  mutable std::condition_variable cv_;
  uint64_t version_{0};
  std::vector<HostCtx> ctx_;
  std::atomic<bool> stop_{false};
  std::thread th_;
};

} // namespace chdash
