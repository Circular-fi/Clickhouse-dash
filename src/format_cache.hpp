#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace chdash {

// Bounded O(1) LRU for deterministic SQL formatting results. Values are shared
// immutable strings, so cache hits and duplicate batch entries do not copy the
// formatted SQL before JSON serialization.
class FormatCache {
public:
  using ValuePtr = std::shared_ptr<const std::string>;

  FormatCache(size_t max_entries, size_t max_bytes, std::chrono::milliseconds ttl);

  ValuePtr get(const std::string& key);
  void put(std::string key, ValuePtr value);
  void clear();

private:
  struct Entry {
    ValuePtr value;
    std::chrono::steady_clock::time_point expires_at{};
    size_t bytes = 0;
    std::list<std::string>::iterator lru_it;
  };

  void erase_locked(std::unordered_map<std::string, Entry>::iterator it);
  void enforce_limits_locked();

  const size_t max_entries_;
  const size_t max_bytes_;
  const std::chrono::milliseconds ttl_;

  std::mutex mu_;
  std::unordered_map<std::string, Entry> entries_;
  std::list<std::string> lru_; // most recently used at the front
  size_t bytes_ = 0;
};

} // namespace chdash
