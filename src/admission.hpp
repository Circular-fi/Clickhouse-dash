#pragma once

// Admission of the heavy work (docs/operations.md, "Admission"). A request that reads a lot (an Explorer table, the graph,
// a trace search, a System query, an analysis) takes a place before it opens its connection: for each ClickHouse host
// and class of work at most `max` run at once, the others wait up to `wait` and then are refused with a 503 that says
// to retry. Without it a burst (eight tools of MCP, five tabs that refresh, three Deep Analyze) opens as many connections
// to a host as it has requests, and holds as many threads of the server.
//
// A place is a Ticket: it is given back when the request ends. The wait stops when the caller goes away or the server stops.

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace chdash {

class Admission {
public:
  class Ticket {
  public:
    Ticket() = default;
    Ticket(Ticket&& other) noexcept : owner_(other.owner_), key_(std::move(other.key_)) { other.owner_ = nullptr; }
    Ticket& operator=(Ticket&& other) noexcept {
      if (this != &other) {
        release();
        owner_ = other.owner_;
        key_ = std::move(other.key_);
        other.owner_ = nullptr;
      }
      return *this;
    }
    Ticket(const Ticket&) = delete;
    Ticket& operator=(const Ticket&) = delete;
    ~Ticket() { release(); }

  private:
    friend class Admission;
    Ticket(Admission* owner, std::string key) : owner_(owner), key_(std::move(key)) {}
    void release() {
      if (owner_) owner_->give_back(key_);
      owner_ = nullptr;
    }
    Admission* owner_ = nullptr;
    std::string key_;
  };

  struct Stat {
    std::string key;
    uint64_t in_use = 0;
    uint64_t waiting = 0;
    uint64_t admitted = 0;
    uint64_t refused = 0;
  };

  // A place for `key` (a class of work and a host, "heavy\x1flocal"), when fewer than `max` run (0 = no limit: always a
  // ticket that counts only). Waits at most `wait`; returns nothing when the time passes or `stop()` says to stop.
  // `stop` is asked about every 50 ms.
  std::optional<Ticket> acquire(const std::string& key, size_t max, std::chrono::milliseconds wait,
                                const std::function<bool()>& stop = {}) {
    std::unique_lock<std::mutex> lock(mu_);
    State& state = states_[key];
    if (max == 0 || state.in_use < max) {
      ++state.in_use;
      ++state.admitted;
      return Ticket(this, key);
    }
    ++state.waiting;
    const auto deadline = std::chrono::steady_clock::now() + wait;
    bool granted = false;
    while (true) {
      State& now = states_[key];
      if (now.in_use < max) {
        granted = true;
        break;
      }
      if (std::chrono::steady_clock::now() >= deadline || (stop && stop())) break;
      // Wake at least every 50 ms to ask `stop`; a ticket given back wakes it at once.
      const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
      cv_.wait_for(lock, std::max(std::chrono::milliseconds(1), std::min(std::chrono::milliseconds(50), left)));
    }
    State& after = states_[key];
    --after.waiting;
    if (!granted) {
      ++after.refused;
      return std::nullopt;
    }
    ++after.in_use;
    ++after.admitted;
    return Ticket(this, key);
  }

  std::vector<Stat> stats() const {
    std::lock_guard<std::mutex> lock(mu_);
    std::vector<Stat> out;
    for (const auto& [key, state] : states_) out.push_back({key, state.in_use, state.waiting, state.admitted, state.refused});
    return out;
  }

private:
  struct State {
    uint64_t in_use = 0;
    uint64_t waiting = 0;
    uint64_t admitted = 0;
    uint64_t refused = 0;
  };

  void give_back(const std::string& key) {
    {
      std::lock_guard<std::mutex> lock(mu_);
      auto it = states_.find(key);
      if (it != states_.end() && it->second.in_use > 0) --it->second.in_use;
    }
    cv_.notify_all();
  }

  mutable std::mutex mu_;
  std::condition_variable cv_;
  std::map<std::string, State> states_;  // bounded by the classes and the hosts of the configuration
};

} // namespace chdash
