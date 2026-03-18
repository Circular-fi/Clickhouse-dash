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


static constexpr int64_t kSystemTablesRefreshMs = 30000;

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

HealthRunner::HealthRunner(std::vector<HostSpec> hosts, HealthSettings settings)
  : hosts_(std::move(hosts)), settings_(settings) {

  if (settings_.interval_ms > 600 * 1000) settings_.interval_ms = 600 * 1000;

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
      size_t idx;
      std::string id;
      std::string uri;
    };

    std::vector<InitJob> init;
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (size_t i = 0; i < ctx_.size(); ++i) {
        const auto& c = ctx_[i];
        if (c.client) continue;
        init.push_back(InitJob{i, c.spec.id, c.spec.system_uri});
      }
    }

    for (const auto& j : init) {
      std::string err;
      auto client = make_client_from_uri(
        j.uri,
        milliseconds(settings_.timeout_ms),
        milliseconds(settings_.timeout_ms),
        milliseconds(settings_.timeout_ms),
        &err
      );
      if (!client) {
        std::cerr << "[health] host=" << j.id << " client init error: " << err << "\n";
        continue;
      }
      std::lock_guard<std::mutex> lk(mu_);
      if (j.idx < ctx_.size() && !ctx_[j.idx].client) {
        ctx_[j.idx].client = std::move(client);
      }
    }

    // Ping each host concurrently (one client per host).
    struct PingRes {
      std::string id;
      bool ok;
      int64_t ping_ms;
      std::string err;
    };

    struct PingJob {
      std::string id;
      std::shared_ptr<clickhouse::Client> client;
    };

    struct CapsJob {
      std::string id;
      std::shared_ptr<clickhouse::Client> client;
    };

    std::vector<PingJob> jobs;
    std::vector<CapsJob> caps_jobs;
    {
      std::lock_guard<std::mutex> lk(mu_);
      jobs.reserve(ctx_.size());
      for (auto& c : ctx_) {
        jobs.push_back(PingJob{c.spec.id, c.client});
        if (c.client && (c.last.system_tables.checked_at_ms == 0 || (ts - c.last.system_tables.checked_at_ms) >= kSystemTablesRefreshMs)) {
          caps_jobs.push_back(CapsJob{c.spec.id, c.client});
        }
      }
    }

    std::vector<std::future<PingRes>> futs;
    futs.reserve(jobs.size());
    for (const auto& j : jobs) {
      futs.push_back(std::async(std::launch::async, [j]() -> PingRes {
        PingRes r;
        r.id = j.id;
        r.ok = false;
        r.ping_ms = -1;
        if (!j.client) {
          r.err = "no client";
          return r;
        }
        try {
          auto t0 = std::chrono::steady_clock::now();
          j.client->Ping();
          auto t1 = std::chrono::steady_clock::now();
          r.ok = true;
          r.ping_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
          return r;
        } catch (const std::exception& e) {
          r.err = e.what();
          try {
            j.client->ResetConnection();
          } catch (...) {}
          return r;
        }
      }));
    }

    std::vector<PingRes> ping_results;
    ping_results.reserve(futs.size());
    for (auto& f : futs) ping_results.push_back(f.get());

    std::vector<std::pair<std::string, HostSystemTables>> caps_results;
    caps_results.reserve(caps_jobs.size());
    for (const auto& j : caps_jobs) {
      bool ping_ok = false;
      for (const auto& r : ping_results) {
        if (r.id == j.id) {
          ping_ok = r.ok;
          break;
        }
      }
      if (!ping_ok) continue;
      caps_results.emplace_back(j.id, detect_system_tables(j.client.get(), ts));
    }

    // Apply results
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& r : ping_results) {
        for (auto& c : ctx_) {
          if (c.spec.id != r.id) continue;
          c.last.checked_at_ms = ts;
          c.last.healthy = r.ok;
          c.last.ping_ms = r.ok ? r.ping_ms : -1;
          if (!r.ok) {
            std::cerr << "[health] host=" << c.spec.id << " down: " << r.err << "\n";
          }
          break;
        }
      }
      for (const auto& item : caps_results) {
        for (auto& c : ctx_) {
          if (c.spec.id != item.first) continue;
          c.last.system_tables = item.second;
          break;
        }
      }

      // Publish update.
      version_++;
    }

    cv_.notify_all();

    // Sleep until next interval.
    const auto elapsed = duration_cast<milliseconds>(steady_clock::now() - tick_start);
    int effective_interval_ms = settings_.interval_ms;
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& c : ctx_) {
        if (!c.client) {
          effective_interval_ms = std::min(effective_interval_ms, 1000);
          break;
        }
      }
    }
    const auto wait_ms = milliseconds(effective_interval_ms) - elapsed;
    if (wait_ms.count() > 0) {
      const auto step = milliseconds(50);
      auto remaining = wait_ms;
      while (remaining.count() > 0 && !stop_.load(std::memory_order_relaxed)) {
        auto s = remaining < step ? remaining : step;
        std::this_thread::sleep_for(s);
        remaining -= s;
      }
    }
  }
}

} // namespace chdash
