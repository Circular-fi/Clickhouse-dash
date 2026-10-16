#pragma once

#include "query_result_plan.hpp"
#include "query_run_profile.hpp"
#include "worker_group.hpp"

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

  // Coalesce several already-framed SSE events into one socket write.
  // This bounds the producer memory when the browser or reverse proxy is slower than ClickHouse.
  size_t sse_write_batch_events = 8;
  size_t sse_write_batch_bytes = 256 * 1024;
  size_t sse_queue_max_bytes = 8 * 1024 * 1024;

  // These are the hard limits for interactive result serialization.
  // The massive export has its own streaming path. These values do not limit it on purpose.
  size_t max_result_cell_bytes = 32 * 1024 * 1024;
  size_t max_result_event_bytes = 32 * 1024 * 1024;

  // A compatibility plan is deterministic for a query and schema pair.
  // Reuse of a recent DESCRIBE result removes the extra round trip for repeated complex SQL.
  size_t describe_cache_entries = 256;
  int describe_cache_ttl_ms = 60 * 1000;

  // These are the ClickHouse bounds of a run (the query { } block, docs/configuration.md).
  // A value of 0 means that the settings profile of the runner user decides.
  // A bound is never looser than the profile (ch_query.hpp).
  int64_t max_execution_time_s = 0;
  uint64_t max_memory_usage = 0;
  uint64_t max_rows_to_read = 0;
  // readonly = 1 on every statement of the run.
  // The access of humans (docs/access.md) sets it for a user who has query.run.read and not query.run.write.
  // It is never a value of the file.
  bool read_only_strict = false;
};

struct SessionSnapshot {
  std::string query_id;
  SessionStatus status = SessionStatus::Created;

  uint64_t read_rows_total = 0;
  uint64_t read_bytes_total = 0;
  uint64_t total_rows_to_read = 0;

  // This is the result payload that goes to the browser. This is not ClickHouse write I/O.
  uint64_t result_rows_emitted = 0;
  uint64_t result_bytes_emitted = 0;

  // These are the rows and bytes that ClickHouse writes. Native Progress packets give the values.
  uint64_t written_rows_total = 0;
  uint64_t written_bytes_total = 0;

  int64_t user_time_us_total = 0;
  int64_t system_time_us_total = 0;
  bool cpu_time_available = false;

  int64_t current_mem_bytes = -1;
  int64_t peak_mem_bytes = -1;

  int64_t elapsed_ms = 0;

  // This shows where the elapsed time of the result went, in milliseconds (docs/telemetry.md).
  // receive_ms is the time inside the native client. In this time, ClickHouse makes and sends the blocks, and the client decodes their columns.
  // encode_ms is the time that ChDash takes to turn the rows into JSON events.
  // backpressure_ms is the time that ChDash waits. The browser has not read the events yet in this time.
  // The rest of elapsed_ms is the connection, USE and DESCRIBE.
  int64_t receive_ms = 0;
  int64_t encode_ms = 0;
  int64_t backpressure_ms = 0;
};

// High-frequency samples keep the original dashboard metrics. They omit the inferred thread count.
// Every value comes from native Progress packets or from query-group ProfileEvents that ClickHouse sends.
struct SamplePoint {
  int64_t elapsed_ms = 0;
  uint64_t read_rows_total = 0;
  uint64_t read_bytes_total = 0;
  uint64_t written_rows_total = 0;
  uint64_t written_bytes_total = 0;
  int64_t cpu_centi = -1;  // centi-percent, -1 means unavailable
  int64_t mem_bytes = -1;  // -1 means unavailable
};

// The outcome of a KILL QUERY: whether ClickHouse answered it, and how many queries it found.
struct KillOutcome {
  bool sent = false;
  uint64_t matched = 0;
  std::string error;
};

// This runs KILL QUERY WHERE <where> ASYNC (or SYNC) on a connection of its own.
// A cancel never waits for a lease of the pool. The statement has the label chdash:cancel. This function never throws.
KillOutcome kill_queries(const std::string& uri, const std::string& where, bool synchronous);

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

  // The query thread enters this group when it starts and leaves it at its end (worker_group.hpp).
  // The server waits for the group at shutdown. Set the group before start().
  // When the server stops, a closed group cancels the session instead.
  void set_worker_group(std::shared_ptr<WorkerGroup> group) { worker_group_ = std::move(group); }
  // Without a cache, every compatibility plan is read again.
  void set_describe_cache(std::shared_ptr<DescribePlanCache> cache) { describe_cache_ = std::move(cache); }

  void start();
  void request_cancel();

  // The browser-facing query id is stable. Compatibility retries can use distinct native ClickHouse ids.
  // Cancellation must target every native attempt that belongs to this session.
  std::vector<std::string> native_query_ids() const;
  KillOutcome cancel_native_queries_best_effort(bool synchronous);

  // A query has one consuming SSE stream. The attachment tracking lets the server remove abandoned POST /run sessions.
  // It does not touch active downloads.
  bool attach_stream();
  void detach_stream();
  bool should_reap(int abandoned_ttl_ms, int terminal_ttl_ms) const;

  SessionSnapshot snapshot() const;

  // Move out all buffered high-frequency samples and empty the buffer.
  // To keep the payload size bounded, the backend can drop older points. It returns at most `max_points` points.
  // The default of `max_points` is 6. That is about 250ms of samples at 40ms sampling.
  std::vector<SamplePoint> drain_samples(size_t max_points = 6);

  // This function waits and then combines the SSE chunks that the query thread produced.
  // It returns false when the session is terminal and the queue is empty.
  // An empty output with a true return value means that the wait time ended while the query still runs.
  bool wait_pop_sse_batch(std::string& out, int wait_ms);

private:
  void run_query();
  std::string begin_native_query_attempt();
  std::string latest_native_query_id() const;
  KillOutcome cancel_native_query_ids_best_effort(
    const std::vector<std::string>& query_ids,
    bool synchronous
  );

  // Records a sample point at most once every options_.sample_interval_ms.
  // The driver callbacks call this function. The caller must hold mu_.
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

  // The first native attempt keeps the public UUID for observability. Each retry gets a unique suffix.
  // ClickHouse then never sees two concurrent queries with the same id, even when the previous socket is closed.
  std::vector<std::string> native_query_ids_;

  uint64_t read_rows_total_ = 0;
  uint64_t read_bytes_total_ = 0;
  uint64_t total_rows_to_read_ = 0;

  uint64_t result_rows_emitted_ = 0;
  uint64_t result_bytes_emitted_ = 0;
  // This is the time split of the last SELECT attempt (SessionSnapshot::receive_ms and the two fields after it).
  int64_t receive_ns_ = 0;
  int64_t encode_ns_ = 0;
  int64_t backpressure_ns_ = 0;
  uint64_t written_rows_total_ = 0;
  uint64_t written_bytes_total_ = 0;

  // The CPU time and the memory that the ProfileEvents packets report (query_run_profile.hpp). The mutex mu_ guards this data.
  RunProfile profile_;

  // High-frequency samples that are in the legacy-compatible tick payload.
  std::deque<SamplePoint> samples_;
  std::chrono::steady_clock::time_point last_sample_at_{};
  std::chrono::steady_clock::time_point last_sample_cpu_at_{};
  int64_t last_sample_cpu_total_us_ = 0;

  std::condition_variable cv_;
  std::deque<std::string> sse_chunks_;
  size_t queued_sse_bytes_ = 0;

  std::thread query_thread_;
  std::shared_ptr<WorkerGroup> worker_group_;
  std::shared_ptr<DescribePlanCache> describe_cache_;
};

} // namespace chdash
