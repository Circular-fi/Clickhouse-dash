#pragma once

// The jobs of Deep Analyze. See docs/query-analysis.md, "Deep Analyze backend".
// The analysis replays the SQL of a run with EXPLAIN ANALYZE.
// The analysis can last as long as the run did. A request does not wait for it.
// POST starts a job and answers at once. The client polls the job. The client can cancel the job.
//
// The store keeps only what a poll needs. The store has fixed bounds.
// A job that runs holds one place of the admission control (admission.hpp) until the job ends.
// The store holds at most `max_jobs` jobs and at most `max_bytes` bytes of results.
// A job that ended stays for `retention`. A client that polls a little late still reads it. Then the poll answers "not found".
// When the store is full, the oldest job that ended goes first. A job that runs never goes. The admission bounds these jobs.

#include <atomic>
#include <chrono>
#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

enum class DeepJobState { Running, Finished, Failed, Canceled };

const char* deep_job_state_name(DeepJobState state);

// The answer of a poll for a job.
struct DeepJobSnapshot {
  std::string job_id;
  std::string host_id;
  std::string query_id;
  DeepJobState state = DeepJobState::Running;
  int64_t elapsed_ms = 0;
  // Finished: the JSON object of the analysis.
  std::shared_ptr<const std::string> result_json;
  // Failed: the code, the message and the HTTP status. A synchronous answer has the same values.
  std::string error_code;
  std::string error_message;
  int error_status = 0;
};

// The part of a job that the thread of the job shares. It holds the cancel flag and the ids of the
// ClickHouse statements that run for the job. The statements read the cancel flag without a lock. A cancel KILLs these statements.
class DeepJobControl {
public:
  void request_cancel() { cancel_.store(true, std::memory_order_release); }
  bool cancel_requested() const { return cancel_.load(std::memory_order_acquire); }
  void add_statement(std::string query_id);
  std::vector<std::string> statements() const;

private:
  std::atomic<bool> cancel_{false};
  mutable std::mutex mu_;
  std::vector<std::string> statements_;
};

class DeepAnalysisJobs {
public:
  DeepAnalysisJobs(size_t max_jobs, size_t max_bytes, std::chrono::milliseconds retention);

  struct Started {
    std::string job_id;
    std::shared_ptr<DeepJobControl> control;
    // False: the job of this query already runs. job_id is its id and control is nullptr. The caller starts nothing.
    bool created = false;
  };

  // Returns the active job of (host, query), or a new job. A second call for a query with an active job returns that job.
  Started start(const std::string& host_id, const std::string& query_id, const std::string& job_id);

  void finish(const std::string& job_id, std::string result_json);
  void fail(const std::string& job_id, std::string code, std::string message, int status);
  void cancel_done(const std::string& job_id);
  // Removes a job that never started. This happens when no place is free in the admission, or when the server stops. The job leaves no trace.
  void discard(const std::string& job_id);

  // Returns the job of this host. A job id of another host is not found. False: the job is unknown, or its retention ended.
  bool snapshot(const std::string& job_id, const std::string& host_id, DeepJobSnapshot* out);

  // Asks the job of this host to stop. False: no such job. `control` (when not null) belongs to the job. It KILLs the statements of the job.
  bool request_cancel(const std::string& job_id, const std::string& host_id, std::shared_ptr<DeepJobControl>* control);

  // Stops every active job. The server calls this at its stop.
  std::vector<std::shared_ptr<DeepJobControl>> running_controls();

  size_t size();
  size_t retained_bytes();

private:
  struct Entry {
    std::string job_id;
    std::string host_id;
    std::string query_id;
    DeepJobState state = DeepJobState::Running;
    std::chrono::steady_clock::time_point started{};
    std::chrono::steady_clock::time_point ended{};
    std::shared_ptr<const std::string> result_json;
    std::string error_code;
    std::string error_message;
    int error_status = 0;
    std::shared_ptr<DeepJobControl> control;
  };

  void prune_locked(std::chrono::steady_clock::time_point now);
  void make_room_locked(size_t bytes);
  void erase_locked(std::unordered_map<std::string, Entry>::iterator it);
  size_t bytes_of(const Entry& entry) const;

  const size_t max_jobs_;
  const size_t max_bytes_;
  const std::chrono::milliseconds retention_;
  std::mutex mu_;
  std::unordered_map<std::string, Entry> jobs_;
  size_t retained_bytes_ = 0;
};

} // namespace chdash
