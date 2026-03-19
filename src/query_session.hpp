#pragma once

#include <clickhouse/client.h>

#include <atomic>
#include <condition_variable>
#include <chrono>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace chdash {

enum class SessionStatus {
  Created,
  Running,
  Finished,
  Error,
  Canceled,
  ResultLimitReached,
};

struct SessionSnapshot {
  std::string query_id;
  SessionStatus status = SessionStatus::Created;

  uint64_t read_rows_total = 0;
  uint64_t read_bytes_total = 0;
  uint64_t total_rows_to_read = 0;

  uint64_t wrote_rows_total = 0;
  uint64_t wrote_bytes_total = 0;

  int64_t user_time_us_total = 0;
  int64_t system_time_us_total = 0;

  int64_t current_mem_bytes = -1;
  int64_t peak_mem_bytes = -1;

  int64_t threads_inst = 0;
  int64_t threads_peak = 0;

  int64_t elapsed_ms = 0;
};

// High-frequency sampling stream (packed by the backend and sent in tick[14]).
// Layout must match app.js expectations:
//   [elapsedMs, readBytesTotal, cpuCenti, memBytes|null, threads]
struct SamplePoint {
  int64_t elapsed_ms = 0;
  uint64_t read_bytes_total = 0;
  int64_t cpu_centi = -1;   // centi-percent, may be -1 if unknown
  int64_t mem_bytes = -1;   // -1 means unknown; server encodes as JSON null
  int64_t threads = 0;
};

class QuerySession : public std::enable_shared_from_this<QuerySession> {
public:
  QuerySession(
    std::string query_id,
    std::string sql,
    std::string database,
    std::shared_ptr<clickhouse::Client> client_for_query,
    std::shared_ptr<clickhouse::Client> client_for_stats,
    int result_preview_row_limit
  );

  ~QuerySession();

  const std::string& id() const { return query_id_; }

  void start();
  void request_cancel();

  SessionSnapshot snapshot() const;

  // Drain (move out) any buffered high-frequency samples.
  // To keep payload size bounded, the backend may drop older points and return
  // at most `max_points` (defaults to 6, i.e. ~250ms worth at 40ms sampling).
  std::vector<SamplePoint> drain_samples(size_t max_points = 6);

  // Wait and pop a produced SSE chunk from the query thread.
  // Returns false when session is done and queue empty.
  bool wait_pop_sse_chunk(std::string& out, int wait_ms);

private:
  void run_query();

  // Records a sample point at most every 40ms (called from driver callbacks).
  // Caller must hold mu_.
  void maybe_record_sample_locked(const std::chrono::steady_clock::time_point& now);

  void push_sse_json_event(const std::string& event_name, const std::string& json);

  void finish_ok();
  void finish_error(const std::string& message);
  void finish_canceled();
  void refresh_stats_from_query_log_best_effort();

  std::string query_id_;
  std::string sql_;
  std::string database_;

  std::shared_ptr<clickhouse::Client> client_query_;
  std::shared_ptr<clickhouse::Client> client_stats_;

  const int result_preview_row_limit_ = 0;

  std::atomic<bool> started_{false};
  std::atomic<bool> cancel_requested_{false};

  mutable std::mutex mu_;
  SessionStatus status_ = SessionStatus::Created;

  std::chrono::steady_clock::time_point started_at_{};
  std::chrono::steady_clock::time_point finished_at_{};

  uint64_t read_rows_total_ = 0;
  uint64_t read_bytes_total_ = 0;
  uint64_t total_rows_to_read_ = 0;

  uint64_t wrote_rows_total_ = 0;
  uint64_t wrote_bytes_total_ = 0;

  int64_t user_time_us_total_ = 0;
  int64_t system_time_us_total_ = 0;
  int64_t real_time_us_total_ = 0;

  int64_t current_mem_bytes_ = -1;
  int64_t peak_mem_bytes_ = -1;

  int64_t threads_inst_ = 0;
  int64_t threads_peak_ = 0;
  bool saw_profile_events_ = false;
  std::unordered_map<uint64_t, std::chrono::steady_clock::time_point> thread_last_seen_;

  // High-frequency samples (sent in tick[14]).
  std::deque<SamplePoint> samples_;
  std::chrono::steady_clock::time_point last_sample_at_{};
  std::chrono::steady_clock::time_point last_sample_cpu_at_{};
  int64_t last_sample_cpu_total_us_ = 0;
  std::chrono::steady_clock::time_point last_sample_rt_at_{};
  int64_t last_sample_rt_total_us_ = 0;

  std::condition_variable cv_;
  std::deque<std::string> sse_chunks_;

  std::thread query_thread_;
};

} // namespace chdash
