#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace chdash {

// Thread-safe stale-while-revalidate cache. Values are immutable shared objects
// so serving a large metadata catalog never copies the whole vector on a hit.
template <typename Key, typename Value>
class StaleCache {
public:
  struct Result {
    bool has_value = false;
    bool stale = false;
    bool had_error = false;
    std::string error_code;
    std::string error_message;
    std::shared_ptr<const Value> value;
  };

  template <typename FetchFn>
  Result get_or_refresh(
      const Key& key,
      uint64_t now_ms,
      uint64_t ttl_ms,
      int wait_ms,
      FetchFn fetch_fn,
      uint64_t failure_backoff_ms = 2000
  ) {
    {
      std::unique_lock<std::mutex> lk(mu_);
      auto& e = entries_[key];
      const uint64_t age_ms = now_ms >= e.fetched_at_ms ? now_ms - e.fetched_at_ms : 0;
      if (e.value && age_ms <= ttl_ms) {
        return make_value_result(e, false);
      }

      if (e.refreshing) {
        if (wait_ms > 0) {
          e.cv.wait_for(lk, std::chrono::milliseconds(wait_ms), [&] { return !e.refreshing; });
        }
        if (e.value) {
          return make_value_result(e, e.stale && !e.last_error_code.empty());
        }
        if (e.refreshing) {
          Result r;
          r.had_error = true;
          r.error_code = "refresh_in_progress";
          r.error_message = "metadata refresh is already in progress";
          return r;
        }
      }

      // Do not hammer a down or permission-restricted ClickHouse on every UI
      // request. Serve stale data, or the cached error, until the short backoff
      // elapses. Successful values keep their normal TTL.
      if (e.retry_after_ms > now_ms) {
        if (e.value) return make_value_result(e, true);
        Result r;
        r.had_error = true;
        r.error_code = e.last_error_code.empty() ? "refresh_backoff" : e.last_error_code;
        r.error_message = e.last_error_message.empty()
          ? "metadata refresh is temporarily backed off"
          : e.last_error_message;
        return r;
      }

      e.refreshing = true;
    }

    Value fetched;
    std::string err_code;
    std::string err_msg;
    bool ok = false;
    try {
      ok = fetch_fn(fetched, err_code, err_msg);
    } catch (const std::exception& e) {
      err_code = "refresh_exception";
      err_msg = e.what();
    } catch (...) {
      err_code = "refresh_exception";
      err_msg = "unknown metadata refresh exception";
    }

    std::unique_lock<std::mutex> lk(mu_);
    auto& e = entries_[key];
    e.refreshing = false;
    if (ok) {
      e.fetched_at_ms = now_ms;
      e.retry_after_ms = 0;
      e.stale = false;
      e.last_error_code.clear();
      e.last_error_message.clear();
      e.value = std::make_shared<const Value>(std::move(fetched));
      e.cv.notify_all();

      Result r;
      r.has_value = true;
      r.value = e.value;
      return r;
    }

    e.retry_after_ms = saturating_add(now_ms, failure_backoff_ms);
    e.last_error_code = err_code.empty() ? "refresh_failed" : std::move(err_code);
    e.last_error_message = err_msg.empty() ? "metadata refresh failed" : std::move(err_msg);
    e.stale = static_cast<bool>(e.value);
    e.cv.notify_all();

    if (e.value) return make_value_result(e, true);

    Result r;
    r.had_error = true;
    r.error_code = e.last_error_code;
    r.error_message = e.last_error_message;
    return r;
  }

  bool is_stale(const Key& key) const {
    std::lock_guard<std::mutex> lk(mu_);
    const auto it = entries_.find(key);
    return it != entries_.end() && it->second.stale;
  }

  void clear() {
    std::lock_guard<std::mutex> lk(mu_);
    entries_.clear();
  }

private:
  struct Entry {
    uint64_t fetched_at_ms = 0;
    uint64_t retry_after_ms = 0;
    bool stale = false;
    bool refreshing = false;
    std::string last_error_code;
    std::string last_error_message;
    std::shared_ptr<const Value> value;
    std::condition_variable cv;
  };

  static uint64_t saturating_add(uint64_t a, uint64_t b) {
    const uint64_t max = static_cast<uint64_t>(-1);
    return b > max - a ? max : a + b;
  }

  static Result make_value_result(const Entry& e, bool include_error) {
    Result r;
    r.has_value = static_cast<bool>(e.value);
    r.stale = e.stale;
    r.value = e.value;
    if (include_error && !e.last_error_code.empty()) {
      r.had_error = true;
      r.error_code = e.last_error_code;
      r.error_message = e.last_error_message;
    }
    return r;
  }

  mutable std::mutex mu_;
  std::unordered_map<Key, Entry> entries_;
};

} // namespace chdash
