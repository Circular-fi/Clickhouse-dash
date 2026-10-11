#include "deep_analysis_jobs.hpp"

#include <algorithm>
#include <utility>

namespace chdash {

const char* deep_job_state_name(DeepJobState state) {
  switch (state) {
    case DeepJobState::Running: return "running";
    case DeepJobState::Finished: return "finished";
    case DeepJobState::Failed: return "failed";
    case DeepJobState::Canceled: return "canceled";
  }
  return "failed";
}

void DeepJobControl::add_statement(std::string query_id) {
  std::lock_guard<std::mutex> lock(mu_);
  statements_.push_back(std::move(query_id));
}

std::vector<std::string> DeepJobControl::statements() const {
  std::lock_guard<std::mutex> lock(mu_);
  return statements_;
}

DeepAnalysisJobs::DeepAnalysisJobs(size_t max_jobs, size_t max_bytes, std::chrono::milliseconds retention)
    : max_jobs_(std::max<size_t>(1, max_jobs)), max_bytes_(max_bytes), retention_(retention) {}

size_t DeepAnalysisJobs::bytes_of(const Entry& entry) const {
  return entry.result_json ? entry.result_json->size() : 0;
}

void DeepAnalysisJobs::erase_locked(std::unordered_map<std::string, Entry>::iterator it) {
  const size_t bytes = bytes_of(it->second);
  retained_bytes_ = bytes > retained_bytes_ ? 0 : retained_bytes_ - bytes;
  jobs_.erase(it);
}

void DeepAnalysisJobs::prune_locked(std::chrono::steady_clock::time_point now) {
  for (auto it = jobs_.begin(); it != jobs_.end();) {
    if (it->second.state != DeepJobState::Running && it->second.ended + retention_ <= now) {
      auto gone = it++;
      erase_locked(gone);
    } else {
      ++it;
    }
  }
}

// Drops the jobs that ended, the oldest first, until one more job and `bytes` more of result fit.
void DeepAnalysisJobs::make_room_locked(size_t bytes) {
  while (jobs_.size() >= max_jobs_ || (retained_bytes_ > 0 && retained_bytes_ + bytes > max_bytes_)) {
    auto oldest = jobs_.end();
    for (auto it = jobs_.begin(); it != jobs_.end(); ++it) {
      if (it->second.state == DeepJobState::Running) continue;
      if (oldest == jobs_.end() || it->second.ended < oldest->second.ended) oldest = it;
    }
    if (oldest == jobs_.end()) return;  // only running jobs are left: the admission bounds them
    erase_locked(oldest);
  }
}

DeepAnalysisJobs::Started DeepAnalysisJobs::start(const std::string& host_id, const std::string& query_id, const std::string& job_id) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(now);
  for (const auto& [id, entry] : jobs_) {
    if (entry.state == DeepJobState::Running && entry.host_id == host_id && entry.query_id == query_id) {
      return Started{id, nullptr, false};
    }
  }
  make_room_locked(0);
  Entry entry;
  entry.job_id = job_id;
  entry.host_id = host_id;
  entry.query_id = query_id;
  entry.started = now;
  entry.control = std::make_shared<DeepJobControl>();
  Started out{job_id, entry.control, true};
  jobs_.emplace(job_id, std::move(entry));
  return out;
}

void DeepAnalysisJobs::finish(const std::string& job_id, std::string result_json) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  const auto it = jobs_.find(job_id);
  if (it == jobs_.end() || it->second.state != DeepJobState::Running) return;
  const size_t bytes = result_json.size();
  // The job itself is already counted in jobs_: make room for its result among the jobs that ended.
  Entry running = std::move(it->second);
  jobs_.erase(it);
  make_room_locked(bytes);
  running.state = DeepJobState::Finished;
  running.ended = now;
  running.result_json = std::make_shared<const std::string>(std::move(result_json));
  retained_bytes_ += bytes;
  jobs_.emplace(job_id, std::move(running));
}

void DeepAnalysisJobs::fail(const std::string& job_id, std::string code, std::string message, int status) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  const auto it = jobs_.find(job_id);
  if (it == jobs_.end() || it->second.state != DeepJobState::Running) return;
  it->second.state = DeepJobState::Failed;
  it->second.ended = now;
  it->second.error_code = std::move(code);
  it->second.error_message = std::move(message);
  it->second.error_status = status;
}

void DeepAnalysisJobs::cancel_done(const std::string& job_id) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  const auto it = jobs_.find(job_id);
  if (it == jobs_.end() || it->second.state != DeepJobState::Running) return;
  it->second.state = DeepJobState::Canceled;
  it->second.ended = now;
}

void DeepAnalysisJobs::discard(const std::string& job_id) {
  std::lock_guard<std::mutex> lock(mu_);
  const auto it = jobs_.find(job_id);
  if (it != jobs_.end() && it->second.state == DeepJobState::Running) erase_locked(it);
}

bool DeepAnalysisJobs::snapshot(const std::string& job_id, const std::string& host_id, DeepJobSnapshot* out) {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(now);
  const auto it = jobs_.find(job_id);
  if (it == jobs_.end() || it->second.host_id != host_id) return false;
  const Entry& entry = it->second;
  if (out) {
    out->job_id = entry.job_id;
    out->host_id = entry.host_id;
    out->query_id = entry.query_id;
    out->state = entry.state;
    const auto until = entry.state == DeepJobState::Running ? now : entry.ended;
    out->elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(until - entry.started).count();
    out->result_json = entry.result_json;
    out->error_code = entry.error_code;
    out->error_message = entry.error_message;
    out->error_status = entry.error_status;
  }
  return true;
}

bool DeepAnalysisJobs::request_cancel(const std::string& job_id, const std::string& host_id, std::shared_ptr<DeepJobControl>* control) {
  std::lock_guard<std::mutex> lock(mu_);
  const auto it = jobs_.find(job_id);
  if (it == jobs_.end() || it->second.host_id != host_id) return false;
  if (it->second.state == DeepJobState::Running && it->second.control) {
    it->second.control->request_cancel();
    if (control) *control = it->second.control;
  }
  return true;
}

std::vector<std::shared_ptr<DeepJobControl>> DeepAnalysisJobs::running_controls() {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<std::shared_ptr<DeepJobControl>> out;
  for (const auto& [id, entry] : jobs_) {
    if (entry.state == DeepJobState::Running && entry.control) out.push_back(entry.control);
  }
  return out;
}

size_t DeepAnalysisJobs::size() {
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(std::chrono::steady_clock::now());
  return jobs_.size();
}

size_t DeepAnalysisJobs::retained_bytes() {
  std::lock_guard<std::mutex> lock(mu_);
  prune_locked(std::chrono::steady_clock::now());
  return retained_bytes_;
}

} // namespace chdash
