#include "format_cache.hpp"

#include <algorithm>
#include <utility>

namespace chdash {

FormatCache::FormatCache(
    size_t max_entries,
    size_t max_bytes,
    std::chrono::milliseconds ttl
) : max_entries_(max_entries),
    max_bytes_(max_bytes),
    ttl_(std::max(ttl, std::chrono::milliseconds(0))) {
  entries_.reserve(max_entries_);
}

FormatCache::ValuePtr FormatCache::get(const std::string& key) {
  if (max_entries_ == 0 || max_bytes_ == 0 || ttl_.count() <= 0) return {};

  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lk(mu_);
  auto it = entries_.find(key);
  if (it == entries_.end()) return {};
  if (it->second.expires_at <= now) {
    erase_locked(it);
    return {};
  }
  lru_.splice(lru_.begin(), lru_, it->second.lru_it);
  return it->second.value;
}

void FormatCache::put(std::string key, ValuePtr value) {
  if (!value || max_entries_ == 0 || max_bytes_ == 0 || ttl_.count() <= 0) return;

  const size_t entry_bytes = key.size() + value->size();
  if (entry_bytes > max_bytes_) return;

  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lk(mu_);
  auto existing = entries_.find(key);
  if (existing != entries_.end()) erase_locked(existing);

  lru_.push_front(key);
  Entry entry;
  entry.value = std::move(value);
  entry.expires_at = now + ttl_;
  entry.bytes = entry_bytes;
  entry.lru_it = lru_.begin();
  bytes_ += entry.bytes;
  entries_.emplace(std::move(key), std::move(entry));
  enforce_limits_locked();
}

void FormatCache::clear() {
  std::lock_guard<std::mutex> lk(mu_);
  entries_.clear();
  lru_.clear();
  bytes_ = 0;
}

void FormatCache::erase_locked(std::unordered_map<std::string, Entry>::iterator it) {
  bytes_ -= std::min(bytes_, it->second.bytes);
  lru_.erase(it->second.lru_it);
  entries_.erase(it);
}

void FormatCache::enforce_limits_locked() {
  while (!lru_.empty() && (entries_.size() > max_entries_ || bytes_ > max_bytes_)) {
    const auto it = entries_.find(lru_.back());
    if (it == entries_.end()) {
      lru_.pop_back();
      continue;
    }
    erase_locked(it);
  }
}

} // namespace chdash
