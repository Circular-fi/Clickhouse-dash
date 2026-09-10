#include "export_job.hpp"

#include <algorithm>

namespace chdash {

namespace {

size_t sql_bytes(const ExportJob& job) {
  size_t total = 0;
  for (const auto& query : job.queries) total += query.size();
  return total;
}

} // namespace

ExportJobStore::ExportJobStore(
    std::chrono::milliseconds ttl,
    size_t max_entries,
    size_t max_total_sql_bytes)
    : ttl_(std::max(std::chrono::milliseconds(1000), ttl)),
      max_entries_(std::max<size_t>(1, max_entries)),
      max_total_sql_bytes_(std::max<size_t>(1024, max_total_sql_bytes)) {}

bool ExportJobStore::put(ExportJob job, std::string* error) {
  const auto now = std::chrono::steady_clock::now();
  const size_t bytes = sql_bytes(job);
  if (job.export_id.empty() || job.host_id.empty() || job.queries.empty()) {
    if (error) *error = "invalid export job";
    return false;
  }
  if (bytes > max_total_sql_bytes_) {
    if (error) *error = "export SQL exceeds the configured in-memory handshake budget";
    return false;
  }

  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(now);
  if (jobs_.size() >= max_entries_) {
    if (error) *error = "too many pending export handshakes";
    return false;
  }
  if (retained_sql_bytes_ > max_total_sql_bytes_ - bytes) {
    if (error) *error = "pending export SQL memory budget is exhausted";
    return false;
  }

  job.created_at = now;
  job.expires_at = now + ttl_;
  retained_sql_bytes_ += bytes;
  jobs_.emplace(job.export_id, std::move(job));
  if (error) error->clear();
  return true;
}

std::optional<ExportJob> ExportJobStore::consume(
    const std::string& export_id,
    const std::string& host_id) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(now);
  const auto it = jobs_.find(export_id);
  if (it == jobs_.end()) return std::nullopt;
  if (it->second.host_id != host_id) return std::nullopt;

  const size_t bytes = sql_bytes(it->second);
  ExportJob job = std::move(it->second);
  retained_sql_bytes_ = bytes > retained_sql_bytes_ ? 0 : retained_sql_bytes_ - bytes;
  jobs_.erase(it);
  return job;
}

size_t ExportJobStore::size() {
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(std::chrono::steady_clock::now());
  return jobs_.size();
}

size_t ExportJobStore::retained_sql_bytes() {
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(std::chrono::steady_clock::now());
  return retained_sql_bytes_;
}

void ExportJobStore::prune() {
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(std::chrono::steady_clock::now());
}

void ExportJobStore::prune_locked(std::chrono::steady_clock::time_point now) {
  for (auto it = jobs_.begin(); it != jobs_.end();) {
    if (it->second.expires_at <= now) {
      auto expired = it++;
      erase_locked(expired);
    } else {
      ++it;
    }
  }
}

void ExportJobStore::erase_locked(std::unordered_map<std::string, ExportJob>::iterator it) {
  const size_t bytes = sql_bytes(it->second);
  retained_sql_bytes_ = bytes > retained_sql_bytes_ ? 0 : retained_sql_bytes_ - bytes;
  jobs_.erase(it);
}

const char* export_format_name(ExportFormat format) {
  return format == ExportFormat::Json ? "json" : "csv";
}

} // namespace chdash
