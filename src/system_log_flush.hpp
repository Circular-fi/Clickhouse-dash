#pragma once

#include <clickhouse/client.h>

#include <chrono>
#include <condition_variable>
#include <exception>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

// SYSTEM FLUSH LOGS is a server-wide operation: it forces every buffered
// system-log entry of the named logs into a new MergeTree part. ChDash only
// uses it as a last resort (analysis.flush_logs = true AND the rows needed are
// still missing), and this gate makes concurrent/nearby callers share one
// flush: a flush that *started* after a caller needed the data already covers
// that caller, so it is not repeated.
class SystemLogFlushGate {
public:
  static SystemLogFlushGate& instance() {
    static SystemLogFlushGate gate;
    return gate;
  }

  // Ensure every log in `logs` (comma-separated system log names) was flushed
  // on the server identified by `scope` by a flush that started at or after
  // `needed_after` (the moment the wanted rows existed server-side, e.g. the
  // end of the query). Coverage is tracked per log name, so flushing
  // "query_log, processors_profile_log" also satisfies a later "query_log"
  // request. Returns false with `error` set if the flush this caller had to
  // perform failed.
  bool ensure_flushed_after(
      clickhouse::Client& client,
      const std::string& scope,
      const std::string& logs,
      std::chrono::steady_clock::time_point needed_after,
      std::string* error) {
    const auto names = split_logs(logs);
    std::unique_lock<std::mutex> lk(mu_);
    auto& slot = scopes_[scope];
    if (!slot) slot = std::make_unique<Scope>();
    Scope& state = *slot;
    for (;;) {
      if (covered(state, names, needed_after)) return true;
      if (!state.in_flight) break;
      // One flush per server at a time; its completion may cover us.
      state.cv.wait(lk, [&state] { return !state.in_flight; });
    }

    state.in_flight = true;
    const auto started = std::chrono::steady_clock::now();
    lk.unlock();
    std::string failure;
    try {
      client.Execute("SYSTEM FLUSH LOGS " + logs);
    } catch (const std::exception& e) {
      failure = e.what();
    }
    lk.lock();
    state.in_flight = false;
    if (failure.empty()) {
      for (const auto& name : names) state.last_success_started[name] = started;
    }
    state.cv.notify_all();
    if (!failure.empty()) {
      if (error) *error = failure;
      return false;
    }
    return true;
  }

private:
  struct Scope {
    bool in_flight = false;
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> last_success_started;
    std::condition_variable cv;
  };

  static std::vector<std::string> split_logs(const std::string& logs) {
    std::vector<std::string> out;
    std::string current;
    for (const char ch : logs) {
      if (ch == ',') {
        if (!current.empty()) out.push_back(current);
        current.clear();
      } else if (ch != ' ') {
        current.push_back(ch);
      }
    }
    if (!current.empty()) out.push_back(current);
    return out;
  }

  static bool covered(const Scope& state,
                      const std::vector<std::string>& names,
                      std::chrono::steady_clock::time_point needed_after) {
    for (const auto& name : names) {
      const auto it = state.last_success_started.find(name);
      if (it == state.last_success_started.end() || it->second < needed_after) return false;
    }
    return !names.empty();
  }

  std::mutex mu_;
  std::unordered_map<std::string, std::unique_ptr<Scope>> scopes_;
};

} // namespace chdash
