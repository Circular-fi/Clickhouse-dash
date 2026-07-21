#pragma once

#include <clickhouse/client.h>

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <chrono>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <vector>

namespace chdash {

class ClickHouseClientPool;

enum class SessionStatus {
  Created,
  Running,
  Finished,
  Error,
  Canceled,
  ResultLimitReached,
};

enum class QueryDescribeMode {
  Auto,    // fast path: run directly, retry once with DESCRIBE+wrapper before streaming any rows
  Always,  // old behavior: DESCRIBE before every SELECT/WITH
  Never,   // fastest, but complex ClickHouse types may be degraded or fail
};

struct QuerySessionOptions {
  QueryDescribeMode describe_mode = QueryDescribeMode::Auto;

  // Querying system.query_log is intentionally disabled by default: it adds an
  // extra system query after every run and the old SYSTEM FLUSH LOGS path was
  // especially expensive for interactive dashboards. Progress/ProfileEvents
  // remain available through the native TCP query stream.
  bool final_stats_from_query_log = false;
  bool flush_query_log_for_final_stats = false;

  int sample_interval_ms = 40;
  int result_rows_batch_size = 1000;
  size_t result_rows_batch_bytes = 256 * 1024;

  // Coalesce several already-framed SSE events into one socket write and bound
  // producer memory when the browser or reverse proxy is slower than ClickHouse.
  size_t sse_write_batch_events = 8;
  size_t sse_write_batch_bytes = 256 * 1024;
  size_t sse_queue_max_bytes = 8 * 1024 * 1024;

  // Compatibility plans are deterministic for a query/schema pair. Reusing a
  // recent DESCRIBE result removes the extra round trip on repeated complex SQL.
  size_t describe_cache_entries = 256;
  int describe_cache_ttl_ms = 60 * 1000;
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
// New layout:
//   [elapsedMs, readRowsTotal, readBytesTotal, cpuCenti, memBytes|null, threads]
// app_run.js still understands the old 5-field layout for compatibility.
struct SamplePoint {
  int64_t elapsed_ms = 0;
  uint64_t read_rows_total = 0;
  uint64_t read_bytes_total = 0;
  int64_t cpu_centi = -1;   // centi-percent, may be -1 if unknown
  int64_t mem_bytes = -1;   // -1 means unknown; server encodes as JSON null
  int64_t threads = 0;
};

class QuerySession : public std::enable_shared_from_this<QuerySession> {
public:
  QuerySession(
    std::string query_id,
    std::string host_id,
    std::string sql,
    std::string database,
    std::string runner_uri,
    std::string stats_uri,
    std::shared_ptr<ClickHouseClientPool> client_pool,
    int result_preview_row_limit,
    QuerySessionOptions options = {}
  );

  ~QuerySession();

  const std::string& id() const { return query_id_; }

  void start();
  void request_cancel();

  // A query has one consuming SSE stream. Tracking attachment lets the server
  // reap abandoned POST /run sessions without touching active downloads.
  bool attach_stream();
  void detach_stream();
  bool should_reap(int abandoned_ttl_ms, int terminal_ttl_ms) const;

  SessionSnapshot snapshot() const;

  // Drain (move out) any buffered high-frequency samples.
  // To keep payload size bounded, the backend may drop older points and return
  // at most `max_points` (defaults to 6, i.e. ~250ms worth at 40ms sampling).
  std::vector<SamplePoint> drain_samples(size_t max_points = 6);

  // Wait and coalesce produced SSE chunks from the query thread. Returns false
  // when the session is terminal and the queue is empty. An empty output with a
  // true return value means the wait elapsed while the query is still running.
  bool wait_pop_sse_batch(std::string& out, int wait_ms);

private:
  void run_query();

  // Records a sample point at most every options_.sample_interval_ms (called from driver callbacks).
  // Caller must hold mu_.
  void maybe_record_sample_locked(const std::chrono::steady_clock::time_point& now);

  void push_sse_json_event(std::string_view event_name, std::string_view json);

  void finish_ok();
  void finish_error(const std::string& message);
  void finish_canceled();
  void refresh_stats_from_query_log_best_effort();

  std::string query_id_;
  std::string host_id_;
  std::string sql_;
  std::string database_;

  std::string runner_uri_;
  std::string stats_uri_;
  std::shared_ptr<ClickHouseClientPool> client_pool_;

  std::shared_ptr<clickhouse::Client> client_query_;
  std::shared_ptr<clickhouse::Client> client_stats_;

  const int result_preview_row_limit_ = 0;
  QuerySessionOptions options_;

  std::atomic<bool> started_{false};
  std::atomic<bool> cancel_requested_{false};

  mutable std::mutex mu_;
  SessionStatus status_ = SessionStatus::Created;

  std::chrono::steady_clock::time_point created_at_{std::chrono::steady_clock::now()};
  std::chrono::steady_clock::time_point started_at_{};
  std::chrono::steady_clock::time_point finished_at_{};
  bool stream_attached_ = false;

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
  size_t queued_sse_bytes_ = 0;

  std::thread query_thread_;
};

} // namespace chdash
