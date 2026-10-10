#pragma once

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <exception>
#include <functional>
#include <list>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chdash {

// The threads that refresh TtlCache values in the background (stale-while-revalidate). The queue is bounded: a
// refresh that does not fit is not started; the stale value is served again and the next request asks again.
class CacheRefresher {
public:
  explicit CacheRefresher(size_t threads = 2, size_t max_queued = 64) : max_queued_(std::max<size_t>(1, max_queued)) {
    for (size_t i = 0; i < std::max<size_t>(1, threads); ++i) workers_.emplace_back([this] { run(); });
  }
  ~CacheRefresher() { stop(); }
  CacheRefresher(const CacheRefresher&) = delete;
  CacheRefresher& operator=(const CacheRefresher&) = delete;

  bool submit(std::function<void()> task) {
    std::lock_guard<std::mutex> lk(mu_);
    if (stopping_ || queue_.size() >= max_queued_) return false;
    queue_.push_back(std::move(task));
    cv_.notify_one();
    return true;
  }

  // Drops the queued refreshes and waits for the running ones.
  void stop() {
    std::deque<std::function<void()>> dropped;
    {
      std::lock_guard<std::mutex> lk(mu_);
      stopping_ = true;
      dropped.swap(queue_);
    }
    cv_.notify_all();
    for (auto& worker : workers_) {
      if (worker.joinable()) worker.join();
    }
  }

private:
  void run() {
    for (;;) {
      std::function<void()> task;
      {
        std::unique_lock<std::mutex> lk(mu_);
        cv_.wait(lk, [this] { return stopping_ || !queue_.empty(); });
        if (stopping_) return;
        task = std::move(queue_.front());
        queue_.pop_front();
      }
      try {
        task();
      } catch (...) {
      }
    }
  }

  const size_t max_queued_;
  std::mutex mu_;
  std::condition_variable cv_;
  bool stopping_ = false;
  std::deque<std::function<void()>> queue_;
  std::vector<std::thread> workers_;
};

inline size_t cache_key_bytes(const std::string& key) { return sizeof(std::string) + key.size(); }
template <typename Key>
size_t cache_key_bytes(const Key&) { return sizeof(Key); }

// The cache of the values that the server reads from ClickHouse (metadata, ACL, System and OTEL reads).
//
//   - A value is fresh for `ttl` after its fetch ENDED (monotonic clock; the wall clock never ages a value).
//   - One fetch per key at a time. A request that needs the value while it is being read waits for that fetch, up to
//     `wait`, then gets its answer: a second identical request never fails because the first one is still reading.
//   - get_revalidating(): past its TTL, and for `stale_for` more, the value is served at once with stale = true and ONE
//     refresh runs in the background. Its fetch then runs after the request has returned: it must own what it uses
//     (capture by value, never a reference to the request). get() never runs a fetch in the background.
//   - force (refresh=1) and invalidate() never remove an entry: they ask for a fetch that starts after them. A fetch
//     already running is waited for first; all the requests that asked meanwhile share the next fetch, so a loop of
//     refresh=1 never runs two reads of one key at a time.
//   - A failed fetch is never stored as a value. Its error is answered for `failure_backoff` (a down host is not asked
//     again on every request); with serve_stale_on_error the previous value is answered instead (stale = true), unless
//     an invalidation asked for a newer one.
//   - Bounded: `max_entries` and `max_bytes` (LRU), and no value older than `max_age` is served or kept.
template <typename Key, typename Value, typename Clock = std::chrono::steady_clock>
class TtlCache {
public:
  using Duration = std::chrono::milliseconds;
  // Fills `value` and returns true, or fills the error code and message and returns false. It may throw.
  using Fetch = std::function<bool(Value& value, std::string& error_code, std::string& error_message)>;

  struct Options {
    Duration ttl{5000};
    Duration stale_for{0};
    Duration max_age{std::chrono::minutes(10)};
    Duration failure_backoff{2000};
    Duration wait{std::chrono::seconds(60)};
    bool serve_stale_on_error = true;
    size_t max_entries = 1024;
    size_t max_bytes = 64u << 20;
    // The size of a value in memory (an estimate); sizeof(Value) when not set.
    std::function<size_t(const Value&)> value_bytes;
    // A TTL per value (for example shorter for an incomplete answer); `ttl` when not set.
    std::function<Duration(const Value&)> ttl_of;
    // Starts a background refresh; false when it cannot. No background refresh when not set.
    std::function<bool(std::function<void()>)> submit;
  };

  struct Result {
    std::shared_ptr<const Value> value;
    bool has_value = false;
    bool stale = false;    // older than its TTL: served while a refresh runs, or because the refresh failed
    bool fetched = false;  // this request ran the fetch
    bool had_error = false;
    std::string error_code;
    std::string error_message;
    std::exception_ptr exception;  // what the fetch threw, when it threw
    uint64_t age_ms = 0;
  };

  struct Stats {
    uint64_t hits = 0;
    uint64_t stale_hits = 0;
    uint64_t misses = 0;
    uint64_t fetches = 0;
    uint64_t failures = 0;
    uint64_t evictions = 0;
    size_t entries = 0;
    size_t bytes = 0;
  };

  explicit TtlCache(Options options = Options{}) : options_(std::move(options)) {
    if (options_.max_age < options_.ttl + options_.stale_for) options_.max_age = options_.ttl + options_.stale_for;
  }
  TtlCache(const TtlCache&) = delete;
  TtlCache& operator=(const TtlCache&) = delete;

  Result get(const Key& key, const Fetch& fetch, bool force = false) { return lookup(key, fetch, force, false); }

  // The value of a result, or what its fetch threw (a std::runtime_error with the message when it returned false).
  static std::shared_ptr<const Value> value_or_throw(const Result& result) {
    if (result.has_value && result.value) return result.value;
    if (result.exception) std::rethrow_exception(result.exception);
    throw std::runtime_error(result.error_message.empty() ? "The data could not be read." : result.error_message);
  }
  Result get_revalidating(const Key& key, const Fetch& fetch, bool force = false) { return lookup(key, fetch, force, true); }

  // The next request of `key` gets a value read after this call.
  void invalidate(const Key& key) {
    std::lock_guard<std::mutex> lk(mu_);
    const auto it = map_.find(key);
    if (it != map_.end()) invalidate_locked(*it->second);
  }

  // Every key that starts with `prefix` (string keys).
  void invalidate_prefix(const Key& prefix) {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& [key, entry] : map_) {
      if (key.compare(0, prefix.size(), prefix) == 0) invalidate_locked(*entry);
    }
  }

  void invalidate_all() {
    std::lock_guard<std::mutex> lk(mu_);
    for (auto& item : map_) invalidate_locked(*item.second);
  }

  Stats stats() const {
    std::lock_guard<std::mutex> lk(mu_);
    Stats out = stats_;
    out.entries = map_.size();
    out.bytes = bytes_;
    return out;
  }

  const Options& options() const { return options_; }

private:
  using TimePoint = typename Clock::time_point;

  struct Entry {
    std::shared_ptr<const Value> value;
    TimePoint fetched_at{};
    Duration ttl{0};
    uint64_t value_gen = 0;  // the fetch that produced `value`
    uint64_t started = 0;    // fetches started
    uint64_t done = 0;       // fetches ended
    uint64_t min_valid = 0;  // a value of an older fetch is not answered (invalidate, force)
    bool refreshing = false;
    bool queued = false;     // the running fetch is a background refresh that has not started yet
    bool last_ok = false;
    TimePoint retry_after{};
    std::string error_code;
    std::string error_message;
    std::exception_ptr exception;
    size_t bytes = 0;
    typename std::list<Key>::iterator lru;
    std::condition_variable cv;
  };

  Result lookup(const Key& key, const Fetch& fetch, bool force, bool revalidate) {
    std::unique_lock<std::mutex> lk(mu_);
    const TimePoint arrival = Clock::now();
    const std::shared_ptr<Entry> entry = find_or_insert_locked(key, arrival);
    Entry& e = *entry;
    if (force) invalidate_locked(e);
    if (servable(e, arrival, e.ttl)) {
      ++stats_.hits;
      return value_result(e, arrival);
    }
    if (revalidate && servable(e, arrival, e.ttl + options_.stale_for)) {
      ++stats_.stale_hits;
      if (!e.refreshing && e.retry_after <= arrival && options_.submit) start_background_locked(key, entry, fetch);
      return value_result(e, arrival);
    }

    ++stats_.misses;
    // The fetch that answers this request: the one that runs now, or one that starts after an invalidation.
    const uint64_t target = std::max(e.min_valid, e.done + 1);
    const bool asked = e.min_valid > e.done;
    const auto deadline = std::chrono::steady_clock::now() + options_.wait;
    for (;;) {
      if (e.done >= target) return outcome_locked(e, Clock::now());
      if (e.refreshing && e.queued) {
        // A background refresh that has not started yet: this request runs it now. It starts now, so it answers
        // every invalidation made before it.
        e.queued = false;
        e.min_valid = std::min(e.min_valid, e.started);
        run_fetch_locked(lk, key, entry, fetch, e.started);
        Result out = outcome_locked(e, Clock::now());
        out.fetched = true;
        return out;
      }
      if (e.refreshing) {
        if (e.cv.wait_until(lk, deadline) == std::cv_status::timeout && e.refreshing && e.done < target) {
          return timeout_locked(e, Clock::now());
        }
        continue;
      }
      // A recent failure is answered again, unless a newer value was asked for.
      if (!asked && e.done > 0 && !e.last_ok && Clock::now() < e.retry_after) return outcome_locked(e, Clock::now());
      run_fetch_locked(lk, key, entry, fetch, begin_fetch_locked(e));
      Result out = outcome_locked(e, Clock::now());
      out.fetched = true;
      return out;
    }
  }

  bool servable(const Entry& e, TimePoint now, Duration window) const {
    if (!e.value || e.value_gen < e.min_valid) return false;
    const auto age = now >= e.fetched_at ? now - e.fetched_at : Clock::duration::zero();
    return age <= window && age <= options_.max_age;
  }

  static uint64_t age_ms(const Entry& e, TimePoint now) {
    if (now <= e.fetched_at) return 0;
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(now - e.fetched_at).count());
  }

  Result value_result(const Entry& e, TimePoint now) const {
    Result out;
    out.value = e.value;
    out.has_value = true;
    out.age_ms = age_ms(e, now);
    out.stale = out.age_ms > static_cast<uint64_t>(e.ttl.count());
    return out;
  }

  Result error_result(const Entry& e) const {
    Result out;
    out.had_error = true;
    out.error_code = e.error_code;
    out.error_message = e.error_message;
    out.exception = e.exception;
    return out;
  }

  // The answer of the last fetch: its value, or its error (the previous value when serve_stale_on_error).
  Result outcome_locked(const Entry& e, TimePoint now) const {
    if (e.last_ok && e.value) return value_result(e, now);
    if (options_.serve_stale_on_error && servable(e, now, options_.max_age)) {
      Result out = value_result(e, now);
      out.stale = true;
      out.had_error = true;
      out.error_code = e.error_code;
      out.error_message = e.error_message;
      out.exception = e.exception;
      return out;
    }
    return error_result(e);
  }

  Result timeout_locked(const Entry& e, TimePoint now) const {
    if (options_.serve_stale_on_error && servable(e, now, options_.max_age)) {
      Result out = value_result(e, now);
      out.stale = true;
      out.had_error = true;
      out.error_code = "refresh_timeout";
      out.error_message = "The data is still being read; the previous answer is shown.";
      return out;
    }
    Result out;
    out.had_error = true;
    out.error_code = "refresh_timeout";
    out.error_message = "The data is still being read; try again.";
    return out;
  }

  void invalidate_locked(Entry& e) { e.min_valid = e.started + 1; }

  // Runs fetch number `gen` (the lock is released meanwhile) and stores its outcome.
  void run_fetch_locked(std::unique_lock<std::mutex>& lk, const Key& key, const std::shared_ptr<Entry>& entry, const Fetch& fetch,
                        uint64_t gen) {
    lk.unlock();
    Value fetched{};
    std::string code;
    std::string message;
    std::exception_ptr exception;
    bool ok = false;
    try {
      ok = fetch(fetched, code, message);
    } catch (const std::exception& error) {
      exception = std::current_exception();
      code = "refresh_exception";
      message = error.what();
    } catch (...) {
      exception = std::current_exception();
      code = "refresh_exception";
      message = "unknown error while reading the data";
    }
    std::shared_ptr<const Value> value;
    size_t bytes = 0;
    Duration ttl = options_.ttl;
    if (ok) {
      value = std::make_shared<const Value>(std::move(fetched));
      bytes = options_.value_bytes ? options_.value_bytes(*value) : sizeof(Value);
      if (options_.ttl_of) ttl = std::min(options_.ttl_of(*value), options_.max_age);
    }
    lk.lock();
    complete_locked(key, entry, gen, value, bytes, ttl, std::move(code), std::move(message), exception);
  }

  uint64_t begin_fetch_locked(Entry& e) {
    e.refreshing = true;
    ++stats_.fetches;
    return ++e.started;
  }

  // The refresh waits in the queue of the refresher (`queued`). A request that needs it before it starts runs it
  // itself (lookup), and the queued task then does nothing: no request ever waits for a refresh that has not started.
  void start_background_locked(const Key& key, const std::shared_ptr<Entry>& entry, const Fetch& fetch) {
    const uint64_t gen = begin_fetch_locked(*entry);
    entry->queued = true;
    auto task = [this, key, entry, fetch, gen]() {
      std::unique_lock<std::mutex> lk(mu_);
      if (!entry->queued || entry->started != gen) return;
      entry->queued = false;
      run_fetch_locked(lk, key, entry, fetch, gen);
    };
    if (!options_.submit(std::move(task))) {
      --entry->started;
      --stats_.fetches;
      entry->refreshing = false;
      entry->queued = false;
    }
  }

  void complete_locked(const Key& key, const std::shared_ptr<Entry>& entry, uint64_t gen, std::shared_ptr<const Value> value,
                       size_t value_bytes, Duration ttl, std::string code, std::string message, std::exception_ptr exception) {
    Entry& e = *entry;
    const TimePoint now = Clock::now();
    e.refreshing = false;
    e.done = gen;
    e.last_ok = static_cast<bool>(value);
    const auto it = map_.find(key);
    const bool mapped = it != map_.end() && it->second == entry;
    if (value) {
      e.value = std::move(value);
      e.value_gen = gen;
      e.fetched_at = now;
      e.ttl = ttl;
      e.retry_after = TimePoint{};
      e.error_code.clear();
      e.error_message.clear();
      e.exception = nullptr;
      const size_t bytes = cache_key_bytes(key) + value_bytes;
      if (mapped) bytes_ = bytes_ - std::min(bytes_, e.bytes) + bytes;
      e.bytes = bytes;
    } else {
      ++stats_.failures;
      e.retry_after = now + options_.failure_backoff;
      e.error_code = code.empty() ? "refresh_failed" : std::move(code);
      e.error_message = message.empty() ? "The data could not be read." : std::move(message);
      e.exception = exception;
    }
    e.cv.notify_all();
    if (mapped) enforce_limits_locked(nullptr);
  }

  std::shared_ptr<Entry> find_or_insert_locked(const Key& key, TimePoint now) {
    const auto it = map_.find(key);
    if (it != map_.end()) {
      lru_.splice(lru_.begin(), lru_, it->second->lru);
      return it->second;
    }
    sweep_locked(now);
    auto entry = std::make_shared<Entry>();
    entry->ttl = options_.ttl;
    lru_.push_front(key);
    entry->lru = lru_.begin();
    entry->bytes = cache_key_bytes(key);
    bytes_ += entry->bytes;
    map_.emplace(key, entry);
    enforce_limits_locked(&key);
    return entry;
  }

  // Entries past max_age, and errors past their back-off, are removed (at most once per sweep interval).
  void sweep_locked(TimePoint now) {
    const auto interval = std::min<Duration>(std::max<Duration>(options_.ttl, Duration(1000)), Duration(30000));
    if (swept_ != TimePoint{} && now - swept_ < interval) return;
    swept_ = now;
    for (auto it = map_.begin(); it != map_.end();) {
      const Entry& e = *it->second;
      const bool expired = e.value ? now - e.fetched_at > options_.max_age : (e.done > 0 && now >= e.retry_after);
      if (!e.refreshing && expired) it = erase_locked(it);
      else ++it;
    }
  }

  void enforce_limits_locked(const Key* keep) {
    auto victim = lru_.end();
    while ((map_.size() > options_.max_entries || bytes_ > options_.max_bytes) && victim != lru_.begin()) {
      --victim;
      if (keep && *victim == *keep) continue;
      const auto it = map_.find(*victim);
      if (it == map_.end() || it->second->refreshing) continue;
      ++stats_.evictions;
      const auto next = std::next(victim);
      erase_locked(it);
      victim = next;
    }
  }

  typename std::unordered_map<Key, std::shared_ptr<Entry>>::iterator erase_locked(
      typename std::unordered_map<Key, std::shared_ptr<Entry>>::iterator it) {
    bytes_ -= std::min(bytes_, it->second->bytes);
    lru_.erase(it->second->lru);
    return map_.erase(it);
  }

  Options options_;
  mutable std::mutex mu_;
  std::unordered_map<Key, std::shared_ptr<Entry>> map_;
  std::list<Key> lru_;  // the most recently used first
  size_t bytes_ = 0;
  TimePoint swept_{};
  Stats stats_;
};

} // namespace chdash
