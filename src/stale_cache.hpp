#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>

namespace chdash {

template <typename Key, typename Value>
class StaleCache {
public:
  struct Result {
    bool has_value = false;
    bool stale = false;
    bool had_error = false;
    std::string error_code;
    std::string error_message;
    Value value{};
  };

  template <typename FetchFn>
  Result get_or_refresh(const Key& key, uint64_t now_ms, uint64_t ttl_ms, int wait_ms, FetchFn fetch_fn) {
    {
      std::unique_lock<std::mutex> lk(mu_);
      auto& e = entries_[key];
      if (e.has_value && (now_ms - e.fetched_at_ms) <= ttl_ms) {
        Result r;
        r.has_value = true;
        r.stale = e.stale;
        r.value = e.value;
        return r;
      }

      if (e.refreshing) {
        if (wait_ms > 0) {
          e.cv.wait_for(lk, std::chrono::milliseconds(wait_ms), [&] { return !e.refreshing; });
        }
        if (e.has_value) {
          Result r;
          r.has_value = true;
          r.stale = e.stale;
          r.value = e.value;
          return r;
        }
      }

      e.refreshing = true;
    }

    Value v;
    std::string err_code;
    std::string err_msg;
    const bool ok = fetch_fn(v, err_code, err_msg);

    std::unique_lock<std::mutex> lk(mu_);
    auto& e = entries_[key];
    e.refreshing = false;
    if (ok) {
      e.fetched_at_ms = now_ms;
      e.has_value = true;
      e.stale = false;
      e.last_error_code.clear();
      e.last_error_message.clear();
      e.value = std::move(v);
      e.cv.notify_all();
      Result r;
      r.has_value = true;
      r.value = e.value;
      return r;
    }

    e.last_error_code = std::move(err_code);
    e.last_error_message = std::move(err_msg);
    if (e.has_value) {
      e.stale = true;
      e.cv.notify_all();
      Result r;
      r.has_value = true;
      r.stale = true;
      r.had_error = true;
      r.error_code = e.last_error_code;
      r.error_message = e.last_error_message;
      r.value = e.value;
      return r;
    }

    e.cv.notify_all();
    Result r;
    r.has_value = false;
    r.had_error = true;
    r.error_code = e.last_error_code;
    r.error_message = e.last_error_message;
    return r;
  }

  bool is_stale(const Key& key) const {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = entries_.find(key);
    if (it == entries_.end()) return false;
    return it->second.stale;
  }

private:
  struct Entry {
    uint64_t fetched_at_ms = 0;
    bool has_value = false;
    bool stale = false;
    bool refreshing = false;
    std::string last_error_code;
    std::string last_error_message;
    Value value{};
    std::condition_variable cv;
  };

  mutable std::mutex mu_;
  std::unordered_map<Key, Entry> entries_;
};

} // namespace chdash
