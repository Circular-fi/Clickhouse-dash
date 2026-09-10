#include "query_registry.hpp"

#include <algorithm>
#include <iterator>

namespace chdash {

QueryRegistry::QueryRegistry(
    std::chrono::milliseconds ttl,
    size_t max_entries,
    size_t max_sql_bytes)
    : ttl_(std::max(std::chrono::milliseconds(1000), ttl)),
      max_entries_(std::max<size_t>(1, max_entries)),
      max_sql_bytes_(max_sql_bytes) {}

void QueryRegistry::register_query(
    const std::string& query_id,
    const std::string& host_id,
    QueryRunMode run_mode,
    std::string original_sql) {
  if (query_id.empty() || host_id.empty()) return;
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(now);

  if (auto existing = records_.find(query_id); existing != records_.end()) {
    retained_sql_bytes_ -= existing->second.original_sql.size();
    records_.erase(existing);
  }

  QueryRegistryRecord record;
  record.query_id = query_id;
  record.host_id = host_id;
  record.run_mode = run_mode;
  if (original_sql.size() <= max_sql_bytes_) {
    record.original_sql = std::move(original_sql);
    retained_sql_bytes_ += record.original_sql.size();
  }
  record.created_at = now;
  record.updated_at = now;
  records_[query_id] = std::move(record);

  while (records_.size() > max_entries_) evict_oldest_locked();
  trim_sql_budget_locked(query_id);
}

void QueryRegistry::add_native_query_id(
    const std::string& query_id,
    const std::string& native_query_id) {
  if (native_query_id.empty()) return;
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(now);
  const auto it = records_.find(query_id);
  if (it == records_.end()) return;

  auto& ids = it->second.native_query_ids;
  if (std::find(ids.begin(), ids.end(), native_query_id) == ids.end()) ids.push_back(native_query_id);
  it->second.updated_at = now;
}

void QueryRegistry::mark_terminal(
    const std::string& query_id,
    std::string terminal_status,
    bool partial_execution,
    int64_t session_elapsed_ms) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(now);
  const auto it = records_.find(query_id);
  if (it == records_.end()) return;
  it->second.terminal_status = std::move(terminal_status);
  it->second.partial_execution = partial_execution;
  it->second.session_elapsed_ms = std::max<int64_t>(0, session_elapsed_ms);
  it->second.updated_at = now;
}

std::optional<QueryRegistryRecord> QueryRegistry::find(
    const std::string& query_id,
    const std::string& host_id) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(now);
  const auto it = records_.find(query_id);
  if (it == records_.end() || it->second.host_id != host_id) return std::nullopt;
  return it->second;
}

size_t QueryRegistry::size() {
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(std::chrono::steady_clock::now());
  return records_.size();
}

size_t QueryRegistry::retained_sql_bytes() {
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(std::chrono::steady_clock::now());
  return retained_sql_bytes_;
}

void QueryRegistry::prune() {
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(std::chrono::steady_clock::now());
}

void QueryRegistry::erase_record_locked(
    std::unordered_map<std::string, QueryRegistryRecord>::iterator it) {
  retained_sql_bytes_ -= it->second.original_sql.size();
  records_.erase(it);
}

void QueryRegistry::prune_locked(std::chrono::steady_clock::time_point now) {
  for (auto it = records_.begin(); it != records_.end();) {
    if (now - it->second.updated_at >= ttl_) {
      auto expired = it++;
      erase_record_locked(expired);
    } else {
      ++it;
    }
  }
}

void QueryRegistry::evict_oldest_locked() {
  if (records_.empty()) return;
  auto oldest = records_.begin();
  for (auto it = std::next(records_.begin()); it != records_.end(); ++it) {
    if (it->second.updated_at < oldest->second.updated_at) oldest = it;
  }
  erase_record_locked(oldest);
}

void QueryRegistry::trim_sql_budget_locked(const std::string& protected_query_id) {
  while (retained_sql_bytes_ > max_sql_bytes_) {
    auto oldest = records_.end();
    for (auto it = records_.begin(); it != records_.end(); ++it) {
      if (it->first == protected_query_id || it->second.original_sql.empty()) continue;
      if (oldest == records_.end() || it->second.updated_at < oldest->second.updated_at) oldest = it;
    }
    if (oldest == records_.end()) {
      auto current = records_.find(protected_query_id);
      if (current != records_.end() && !current->second.original_sql.empty()) {
        retained_sql_bytes_ -= current->second.original_sql.size();
        current->second.original_sql.clear();
      }
      break;
    }
    retained_sql_bytes_ -= oldest->second.original_sql.size();
    oldest->second.original_sql.clear();
  }
}

} // namespace chdash
