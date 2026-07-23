#include "health_runner.hpp"

#include "ch_uri.hpp"

#include <clickhouse/client.h>

#include <algorithm>
#include <chrono>
#include <future>
#include <iostream>
#include <string_view>

namespace chdash {

static int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}


int normalize_health_interval_ms(int interval_ms) {
  return std::max(250, std::min(600 * 1000, interval_ms));
}

static constexpr int64_t kSystemTablesRefreshMs = 10 * 60 * 1000;
static constexpr int64_t kHostVersionRefreshMs = 10 * 60 * 1000;
// A health connection is useful only while checks are frequent. Close it
// before a long sleep so ClickHouse never has to reap an idle dashboard socket
// through its receive/idle timeout path.
static constexpr int kMaxPersistentHealthClientIdleMs = 60 * 1000;

static HostSystemTables detect_system_tables(clickhouse::Client* client, int64_t ts_ms) {
  HostSystemTables out;
  out.checked = true;
  out.checked_at_ms = ts_ms;
  if (!client) return out;

  try {
    client->Select(
      "SELECT name FROM system.tables WHERE database = 'system' AND name IN "
      "('query_log', 'query_thread_log', 'trace_log', 'processors_profile_log', 'jemalloc_profile_text')",
      [&](const clickhouse::Block& b) {
        if (b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;
        auto col = b[0]->As<clickhouse::ColumnString>();
        if (!col) return;
        for (size_t i = 0; i < b.GetRowCount(); ++i) {
          const std::string_view sv = col->At(i);
          if (sv == "query_log") out.query_log = true;
          else if (sv == "query_thread_log") out.query_thread_log = true;
          else if (sv == "trace_log") out.trace_log = true;
          else if (sv == "processors_profile_log") out.processors_profile_log = true;
          else if (sv == "jemalloc_profile_text") out.jemalloc_profile_text = true;
        }
      }
    );
  } catch (...) {
    return out;
  }

  out.logs_table_available = out.query_log;
  out.flamegraph_tables_available = out.trace_log || out.processors_profile_log || out.jemalloc_profile_text || out.query_thread_log;
  return out;
}

static std::string detect_host_version(clickhouse::Client* client) {
  std::string out;
  if (!client) return out;
  try {
    client->Select(
      "SELECT version()",
      [&](const clickhouse::Block& b) {
        if (!out.empty() || b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;
        auto col = b[0]->As<clickhouse::ColumnString>();
        if (!col) return;
        out = std::string(col->At(0));
      }
    );
  } catch (...) {
    return std::string();
  }
  return out;
}

HealthRunner::HealthRunner(std::vector<HostSpec> hosts, HealthSettings settings)
  : hosts_(std::move(hosts)), settings_(settings) {

  settings_.interval_ms = normalize_health_interval_ms(settings_.interval_ms);
  settings_.timeout_ms = std::max(100, std::min(60 * 1000, settings_.timeout_ms));

  // Initialize snapshot with all hosts non-healthy.
  std::lock_guard<std::mutex> lk(mu_);
  ctx_.reserve(hosts_.size());
  for (const auto& h : hosts_) {
    HostCtx c;
    c.spec = h;
    c.last.id = h.id;
    c.last.label = h.label;
    c.last.healthy = false;
    c.last.ping_ms = -1;
    c.last.checked_at_ms = 0;
    ctx_.push_back(std::move(c));
  }
}

HealthRunner::~HealthRunner() {
  stop();
}

void HealthRunner::start() {
  if (th_.joinable()) return;
  stop_.store(false, std::memory_order_relaxed);
  th_ = std::thread([this] { loop(); });
}

void HealthRunner::stop() {
  stop_.store(true, std::memory_order_relaxed);
  cv_.notify_all();
  if (th_.joinable()) th_.join();
}

HostsSnapshot HealthRunner::snapshot() const {
  HostsSnapshot s;
  s.ts_ms = now_ms();
  s.interval_ms = settings_.interval_ms;
  s.timeout_ms = settings_.timeout_ms;

  std::lock_guard<std::mutex> lk(mu_);
  s.hosts.reserve(ctx_.size());
  for (const auto& c : ctx_) {
    s.hosts.push_back(c.last);
  }
  return s;
}

uint64_t HealthRunner::version() const {
  std::lock_guard<std::mutex> lk(mu_);
  return version_;
}

bool HealthRunner::wait_for_update(uint64_t last_version, int wait_ms, uint64_t* new_version) {
  if (wait_ms < 0) wait_ms = 0;
  std::unique_lock<std::mutex> lk(mu_);
  const auto pred = [&]() { return version_ != last_version || stop_.load(std::memory_order_relaxed); };
  if (wait_ms == 0) {
    if (pred()) {
      if (new_version) *new_version = version_;
      return version_ != last_version;
    }
    return false;
  }
  cv_.wait_for(lk, std::chrono::milliseconds(wait_ms), pred);
  if (new_version) *new_version = version_;
  return version_ != last_version;
}

bool HealthRunner::all_healthy() const {
  std::lock_guard<std::mutex> lk(mu_);
  if (ctx_.empty()) return false;
  for (const auto& c : ctx_) {
    if (!c.last.healthy) return false;
  }
  return true;
}

void HealthRunner::loop() {
  using namespace std::chrono;

  while (!stop_.load(std::memory_order_relaxed)) {
    const auto tick_start = steady_clock::now();
    const int64_t ts = now_ms();

    struct InitJob {
      size_t index = 0;
      std::string id;
      std::string uri;
    };

    std::vector<InitJob> init_jobs;
    {
      std::lock_guard<std::mutex> lk(mu_);
      init_jobs.reserve(ctx_.size());
      for (size_t i = 0; i < ctx_.size(); ++i) {
        if (!ctx_[i].client) init_jobs.push_back(InitJob{i, ctx_[i].spec.id, ctx_[i].spec.runner_uri});
      }
    }

    // Client creation is intentionally outside the runner mutex because DNS and
    // connect timeouts may block. Repeated identical failures are logged once,
    // not every retry cycle.
    for (const auto& job : init_jobs) {
      if (stop_.load(std::memory_order_relaxed)) break;
      std::string err;
      auto client = make_client_from_uri(
          job.uri,
          milliseconds(settings_.timeout_ms),
          milliseconds(settings_.timeout_ms),
          milliseconds(settings_.timeout_ms),
          &err);

      std::lock_guard<std::mutex> lk(mu_);
      if (job.index >= ctx_.size() || ctx_[job.index].client) continue;
      auto& ctx = ctx_[job.index];
      if (client) {
        ctx.client = std::move(client);
        ctx.last_error.clear();
      } else {
        const std::string message = err.empty() ? "client initialization failed" : err;
        if (ctx.last_error != message) {
          std::cerr << "[health] host=" << job.id << " client init error: " << message << "\n";
        }
        ctx.last_error = message;
        ctx.last.checked_at_ms = ts;
        ctx.last.healthy = false;
        ctx.last.ping_ms = -1;
      }
    }

    struct PingJob {
      size_t index = 0;
      std::shared_ptr<clickhouse::Client> client;
    };
    struct PingResult {
      size_t index = 0;
      bool ok = false;
      bool discard_client = false;
      int64_t ping_ms = -1;
      std::string error;
    };
    struct AuxiliaryJob {
      size_t index = 0;
      std::shared_ptr<clickhouse::Client> client;
      std::string uri;
    };

    std::vector<PingJob> ping_jobs;
    std::vector<AuxiliaryJob> caps_jobs;
    std::vector<AuxiliaryJob> version_jobs;
    size_t context_count = 0;
    {
      std::lock_guard<std::mutex> lk(mu_);
      context_count = ctx_.size();
      ping_jobs.reserve(ctx_.size());
      for (size_t i = 0; i < ctx_.size(); ++i) {
        const auto& ctx = ctx_[i];
        ping_jobs.push_back(PingJob{i, ctx.client});
        if (ctx.client &&
            (ctx.last.system_tables.checked_at_ms == 0 ||
             ts - ctx.last.system_tables.checked_at_ms >= kSystemTablesRefreshMs)) {
          const bool same_credentials = ctx.spec.system_uri == ctx.spec.runner_uri;
          caps_jobs.push_back(AuxiliaryJob{
              i,
              same_credentials ? ctx.client : std::shared_ptr<clickhouse::Client>{},
              same_credentials ? std::string{} : ctx.spec.system_uri,
          });
        }
        if (ctx.client &&
            (ctx.last.version_checked_at_ms == 0 ||
             ts - ctx.last.version_checked_at_ms >= kHostVersionRefreshMs)) {
          version_jobs.push_back(AuxiliaryJob{i, ctx.client, {}});
        }
      }
    }

    auto ping_one = [](const PingJob& job) {
      PingResult result;
      result.index = job.index;
      if (!job.client) {
        result.error = "no client";
        return result;
      }
      try {
        const auto started = steady_clock::now();
        job.client->Ping();
        result.ok = true;
        result.ping_ms = duration_cast<milliseconds>(steady_clock::now() - started).count();
      } catch (const std::exception& e) {
        result.error = e.what();
        try {
          const auto started = steady_clock::now();
          job.client->ResetConnection();
          job.client->Ping();
          result.ok = true;
          result.ping_ms = duration_cast<milliseconds>(steady_clock::now() - started).count();
          result.error.clear();
        } catch (const std::exception& reconnect_error) {
          result.discard_client = true;
          result.error += "; reconnect failed: ";
          result.error += reconnect_error.what();
        } catch (...) {
          result.discard_client = true;
          result.error += "; reconnect failed";
        }
      } catch (...) {
        result.error = "unknown ping failure";
        try {
          const auto started = steady_clock::now();
          job.client->ResetConnection();
          job.client->Ping();
          result.ok = true;
          result.ping_ms = duration_cast<milliseconds>(steady_clock::now() - started).count();
          result.error.clear();
        } catch (const std::exception& reconnect_error) {
          result.discard_client = true;
          result.error += "; reconnect failed: ";
          result.error += reconnect_error.what();
        } catch (...) {
          result.discard_client = true;
          result.error += "; reconnect failed";
        }
      }
      return result;
    };

    std::vector<PingResult> ping_results;
    ping_results.reserve(ping_jobs.size());
    if (ping_jobs.size() <= 1) {
      for (const auto& job : ping_jobs) ping_results.push_back(ping_one(job));
    } else {
      // Preserve parallel health checks for multiple hosts, but avoid spawning a
      // short-lived std::async worker every five seconds in the common 1-host case.
      std::vector<std::future<PingResult>> futures;
      futures.reserve(ping_jobs.size());
      for (const auto& job : ping_jobs) {
        futures.push_back(std::async(std::launch::async, [job, ping_one] { return ping_one(job); }));
      }
      for (auto& future : futures) ping_results.push_back(future.get());
    }

    std::vector<bool> ping_ok(context_count, false);
    for (const auto& result : ping_results) {
      if (result.index < ping_ok.size()) ping_ok[result.index] = result.ok;
    }

    std::vector<std::pair<size_t, HostSystemTables>> caps_results;
    caps_results.reserve(caps_jobs.size());
    for (const auto& job : caps_jobs) {
      if (job.index < ping_ok.size() && ping_ok[job.index]) {
        if (job.client) {
          caps_results.emplace_back(job.index, detect_system_tables(job.client.get(), ts));
          continue;
        }

        std::string error;
        auto system_client = make_client_from_uri(
            job.uri,
            milliseconds(settings_.timeout_ms),
            milliseconds(settings_.timeout_ms),
            milliseconds(settings_.timeout_ms),
            &error);
        if (system_client) {
          caps_results.emplace_back(job.index, detect_system_tables(system_client.get(), ts));
        } else {
          HostSystemTables unavailable;
          unavailable.checked = true;
          unavailable.checked_at_ms = ts;
          caps_results.emplace_back(job.index, std::move(unavailable));
        }
      }
    }

    std::vector<std::pair<size_t, std::string>> version_results;
    version_results.reserve(version_jobs.size());
    for (const auto& job : version_jobs) {
      if (job.index < ping_ok.size() && ping_ok[job.index]) {
        version_results.emplace_back(job.index, detect_host_version(job.client.get()));
      }
    }

    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& result : ping_results) {
        if (result.index >= ctx_.size()) continue;
        auto& ctx = ctx_[result.index];
        const bool was_healthy = ctx.last.healthy;
        ctx.last.checked_at_ms = ts;
        ctx.last.healthy = result.ok;
        ctx.last.ping_ms = result.ok ? result.ping_ms : -1;
        if (result.ok) {
          ctx.last_error.clear();
        } else {
          const std::string message = result.error.empty() ? "ping failed" : result.error;
          if (was_healthy || ctx.last_error != message) {
            std::cerr << "[health] host=" << ctx.spec.id << " down: " << message << "\n";
          }
          ctx.last_error = message;
        }
        if (result.discard_client) ctx.client.reset();
      }
      for (auto& result : caps_results) {
        if (result.first < ctx_.size()) ctx_[result.first].last.system_tables = std::move(result.second);
      }
      for (auto& result : version_results) {
        if (result.first >= ctx_.size()) continue;
        auto& health = ctx_[result.first].last;
        health.version_checked_at_ms = ts;
        if (!result.second.empty()) health.clickhouse_version = std::move(result.second);
      }
      ++version_;
    }
    cv_.notify_all();

    const auto elapsed = duration_cast<milliseconds>(steady_clock::now() - tick_start);
    int effective_interval_ms = settings_.interval_ms;
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& ctx : ctx_) {
        if (!ctx.client) {
          effective_interval_ms = std::min(effective_interval_ms, 1000);
          break;
        }
      }
    }

    const bool release_clients_before_wait =
        effective_interval_ms > kMaxPersistentHealthClientIdleMs;
    if (release_clients_before_wait) {
      {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& ctx : ctx_) ctx.client.reset();
      }
      // The job vectors also own shared references. Release them before the
      // sleep so the TCP sockets are actually closed now, not next cycle.
      ping_jobs.clear();
      caps_jobs.clear();
      version_jobs.clear();
    }

    const auto remaining = milliseconds(effective_interval_ms) - elapsed;
    if (remaining.count() > 0) {
      std::unique_lock<std::mutex> lk(mu_);
      cv_.wait_for(lk, remaining, [&] { return stop_.load(std::memory_order_relaxed); });
    }
  }
}

} // namespace chdash
