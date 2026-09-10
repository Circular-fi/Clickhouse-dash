#pragma once

#include <clickhouse/client.h>

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
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
  Auto,    // direct path: run immediately, retry once with DESCRIBE+wrapper before streaming any rows
  Always,  // old behavior: DESCRIBE before every SELECT/WITH
  Never,   // lowest overhead, but complex ClickHouse types may be degraded or fail
};

struct QuerySessionOptions {
  QueryDescribeMode describe_mode = QueryDescribeMode::Auto;

  int sample_interval_ms = 40;
  int result_rows_batch_size = 1000;
  size_t result_rows_batch_bytes = 256 * 1024;

  // Coalesce several already-framed SSE events into one socket write and bound
  // producer memory when the browser or reverse proxy is slower than ClickHouse.
  size_t sse_write_batch_events = 8;
  size_t sse_write_batch_bytes = 256 * 1024;
  size_t sse_queue_max_bytes = 8 * 1024 * 1024;

  // Hard limits for interactive result serialization. Massive export has its
  // own streaming path and is intentionally not constrained by these values.
  size_t max_result_cell_bytes = 32 * 1024 * 1024;
  size_t max_result_event_bytes = 32 * 1024 * 1024;

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

  // Result payload emitted to the browser. This is not ClickHouse write I/O.
  uint64_t result_rows_emitted = 0;
  uint64_t result_bytes_emitted = 0;

  // Rows/bytes written by ClickHouse, accumulated from native Progress packets.
  uint64_t written_rows_total = 0;
  uint64_t written_bytes_total = 0;

  int64_t user_time_us_total = 0;
  int64_t system_time_us_total = 0;
  bool cpu_time_available = false;

  int64_t current_mem_bytes = -1;
  int64_t peak_mem_bytes = -1;

  int64_t elapsed_ms = 0;
};

// High-frequency samples keep the original dashboard metrics while omitting
// the inferred thread count. Every value comes from native Progress packets or
// query-group ProfileEvents emitted by ClickHouse.
struct SamplePoint {
  int64_t elapsed_ms = 0;
  uint64_t read_rows_total = 0;
  uint64_t read_bytes_total = 0;
  uint64_t written_rows_total = 0;
  uint64_t written_bytes_total = 0;
  int64_t cpu_centi = -1;  // centi-percent, -1 means unavailable
  int64_t mem_bytes = -1;  // -1 means unavailable
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
    QuerySessionOptions options = {},
    bool detailed_profiling = false,
    std::function<void(const std::string&)> native_query_id_observer = {},
    std::function<void(SessionStatus, int64_t)> terminal_status_observer = {}
  );

  ~QuerySession();

  const std::string& id() const { return query_id_; }

  void start();
  void request_cancel();

  // The browser-facing query id is stable, while compatibility retries may
  // use distinct native ClickHouse ids. Cancellation must target every native
  // attempt that belongs to this session.
  std::vector<std::string> native_query_ids() const;
  void cancel_native_queries_best_effort(bool synchronous);

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
  std::string begin_native_query_attempt();
  std::string latest_native_query_id() const;
  void cancel_native_query_ids_best_effort(
    const std::vector<std::string>& query_ids,
    bool synchronous
  );

  // Records a sample point at most every options_.sample_interval_ms (called from driver callbacks).
  // Caller must hold mu_.
  void maybe_record_sample_locked(const std::chrono::steady_clock::time_point& now);

  void push_sse_json_event(std::string_view event_name, std::string_view json);

  void finish_ok();
  void finish_error(const std::string& message);
  void finish_canceled();
  void finish_result_limit_reached();
  void notify_terminal_status(SessionStatus status);

  std::string query_id_;
  std::string host_id_;
  std::string sql_;
  std::string database_;

  std::string runner_uri_;
  std::string stats_uri_;
  std::shared_ptr<ClickHouseClientPool> client_pool_;

  std::shared_ptr<clickhouse::Client> client_query_;

  const int result_preview_row_limit_ = 0;
  QuerySessionOptions options_;
  bool detailed_profiling_ = false;
  std::function<void(const std::string&)> native_query_id_observer_;
  std::function<void(SessionStatus, int64_t)> terminal_status_observer_;
  std::atomic<bool> terminal_status_notified_{false};

  std::atomic<bool> started_{false};
  std::atomic<bool> cancel_requested_{false};

  mutable std::mutex mu_;
  SessionStatus status_ = SessionStatus::Created;

  std::chrono::steady_clock::time_point created_at_{std::chrono::steady_clock::now()};
  std::chrono::steady_clock::time_point started_at_{};
  std::chrono::steady_clock::time_point finished_at_{};
  bool stream_attached_ = false;

  // First native attempt keeps the public UUID for observability. Any retry
  // receives a unique suffix so ClickHouse never sees two concurrent queries
  // with the same id while the previous socket is being torn down.
  std::vector<std::string> native_query_ids_;

  uint64_t read_rows_total_ = 0;
  uint64_t read_bytes_total_ = 0;
  uint64_t total_rows_to_read_ = 0;

  uint64_t result_rows_emitted_ = 0;
  uint64_t result_bytes_emitted_ = 0;
  uint64_t written_rows_total_ = 0;
  uint64_t written_bytes_total_ = 0;

  int64_t user_time_us_total_ = 0;
  int64_t system_time_us_total_ = 0;
  bool cpu_time_available_ = false;

  int64_t current_mem_bytes_ = -1;
  int64_t peak_mem_bytes_ = -1;
  std::unordered_map<std::string, int64_t> memory_usage_by_host_;
  std::unordered_map<std::string, int64_t> peak_memory_usage_by_host_;

  // High-frequency samples embedded in the legacy-compatible tick payload.
  std::deque<SamplePoint> samples_;
  std::chrono::steady_clock::time_point last_sample_at_{};
  std::chrono::steady_clock::time_point last_sample_cpu_at_{};
  int64_t last_sample_cpu_total_us_ = 0;

  std::condition_variable cv_;
  std::deque<std::string> sse_chunks_;
  size_t queued_sse_bytes_ = 0;

  std::thread query_thread_;
};

} // namespace chdash
