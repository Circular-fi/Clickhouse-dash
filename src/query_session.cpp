#include "query_session.hpp"
#include "api_error.hpp"
#include "ch_client_pool.hpp"
#include "ch_query.hpp"
#include "log.hpp"
#include "ch_uri.hpp"
#include "block_encoder.hpp"
#include "query_result_events.hpp"
#include "query_result_plan.hpp"
#include "query_run_profile.hpp"
#include "sql_scan.hpp"
#include "json_text.hpp"
#include "sql_literal.hpp"

#include <clickhouse/query.h>
#include <clickhouse/columns/enum.h>
#include <clickhouse/exceptions.h>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <exception>
#include <functional>
#include <iterator>
#include <limits>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <system_error>
#include <unordered_map>
#include <utility>

namespace chdash {

namespace {
using sql::quote_ident;
using sql::quote_string;
}

static int64_t ms_since(const std::chrono::steady_clock::time_point& start,
                        const std::chrono::steady_clock::time_point& end_or_zero) {
  if (start.time_since_epoch().count() == 0) return 0;
  const auto end = (end_or_zero.time_since_epoch().count() == 0) ? std::chrono::steady_clock::now() : end_or_zero;
  return std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
}


// Decoded blocks that wait for the encoder thread (QuerySession::run_query): the memory bound.
constexpr size_t kEncodeQueueBlocks = 4;

QuerySession::QuerySession(
  std::string query_id,
  std::string host_id,
  std::string sql,
  std::string database,
  std::string runner_uri,
  std::string stats_uri,
  std::shared_ptr<ClickHouseClientPool> client_pool,
  int result_preview_row_limit,
  QuerySessionOptions options,
  bool detailed_profiling,
  std::function<void(const std::string&)> native_query_id_observer,
  std::function<void(SessionStatus, int64_t)> terminal_status_observer
) : query_id_(std::move(query_id)),
    host_id_(std::move(host_id)),
    sql_(std::move(sql)),
    database_(std::move(database)),
    runner_uri_(std::move(runner_uri)),
    stats_uri_(std::move(stats_uri)),
    client_pool_(std::move(client_pool)),
    result_preview_row_limit_(result_preview_row_limit),
    options_(options),
    detailed_profiling_(detailed_profiling),
    native_query_id_observer_(std::move(native_query_id_observer)),
    terminal_status_observer_(std::move(terminal_status_observer)) {
}

QuerySession::~QuerySession() {
  request_cancel();
  if (!query_thread_.joinable()) return;

  // A disconnected stream may erase the server-owned reference while the
  // worker still owns the last shared_ptr. In that case destruction happens at
  // the end of the worker itself; joining the current thread would terminate.
  if (query_thread_.get_id() == std::this_thread::get_id()) {
    query_thread_.detach();
  } else {
    query_thread_.join();
  }
}

void QuerySession::start() {
  bool expected = false;
  if (!started_.compare_exchange_strong(expected, true)) return;

  {
    std::lock_guard<std::mutex> lk(mu_);
    if (cancel_requested_.load(std::memory_order_relaxed)) {
      status_ = SessionStatus::Canceled;
      finished_at_ = std::chrono::steady_clock::now();
    } else {
      status_ = SessionStatus::Running;
      started_at_ = std::chrono::steady_clock::now();
    }
  }

  if (cancel_requested_.load(std::memory_order_relaxed)) {
    cv_.notify_all();
    notify_terminal_status(SessionStatus::Canceled);
    return;
  }

  // The thread leaves the worker group as its last step, after the session it held: the session may end in this
  // thread (its last owner), and the server destroys what the session uses only once the group is empty.
  const std::shared_ptr<WorkerGroup> group = worker_group_;
  if (group && !group->enter()) {
    request_cancel();
    return;
  }
  try {
    query_thread_ = std::thread([self = shared_from_this(), group]() mutable {
      self->run_query();
      self.reset();
      if (group) group->leave();
    });
  } catch (...) {
    if (group) group->leave();
    throw;
  }
}

void QuerySession::request_cancel() {
  cancel_requested_.store(true, std::memory_order_relaxed);

  bool became_terminal = false;
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (status_ == SessionStatus::Running || status_ == SessionStatus::Created) {
      status_ = SessionStatus::Canceled;
      finished_at_ = std::chrono::steady_clock::now();
      became_terminal = true;
    }
  }
  cv_.notify_all();
  if (became_terminal) notify_terminal_status(SessionStatus::Canceled);
}


std::vector<std::string> QuerySession::native_query_ids() const {
  std::lock_guard<std::mutex> lock(mu_);
  return native_query_ids_;
}

std::string QuerySession::begin_native_query_attempt() {
  std::string native_id;
  {
    std::lock_guard<std::mutex> lock(mu_);
    const size_t attempt_index = native_query_ids_.size();
    native_id = query_id_;
    if (attempt_index > 0) {
      native_id += "-attempt-";
      native_id += std::to_string(attempt_index + 1);
    }
    native_query_ids_.push_back(native_id);
  }

  if (native_query_id_observer_) {
    try {
      native_query_id_observer_(native_id);
    } catch (...) {
      // Registry/observability bookkeeping must never fail query execution.
    }
  }
  return native_id;
}

std::string QuerySession::latest_native_query_id() const {
  std::lock_guard<std::mutex> lock(mu_);
  return native_query_ids_.empty() ? query_id_ : native_query_ids_.back();
}

KillOutcome QuerySession::cancel_native_query_ids_best_effort(
  const std::vector<std::string>& query_ids,
  bool synchronous
) {
  if (query_ids.empty()) return {};
  std::string where = "query_id IN (";
  for (size_t i = 0; i < query_ids.size(); ++i) {
    if (i > 0) where += ", ";
    where += quote_string(query_ids[i]);
  }
  where += ")";
  return kill_queries(stats_uri_.empty() ? runner_uri_ : stats_uri_, where, synchronous);
}

KillOutcome QuerySession::cancel_native_queries_best_effort(bool synchronous) {
  auto ids = native_query_ids();
  if (ids.empty()) ids.push_back(query_id_);
  return cancel_native_query_ids_best_effort(ids, synchronous);
}

bool QuerySession::attach_stream() {
  std::lock_guard<std::mutex> lk(mu_);
  if (stream_attached_) return false;
  stream_attached_ = true;
  return true;
}

void QuerySession::detach_stream() {
  {
    std::lock_guard<std::mutex> lk(mu_);
    stream_attached_ = false;
  }
  cv_.notify_all();
}

bool QuerySession::should_reap(int abandoned_ttl_ms, int terminal_ttl_ms) const {
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lk(mu_);
  if (stream_attached_) return false;

  const bool terminal = status_ == SessionStatus::Finished || status_ == SessionStatus::Error ||
                        status_ == SessionStatus::Canceled || status_ == SessionStatus::ResultLimitReached;
  if (terminal) {
    if (terminal_ttl_ms <= 0) return true;
    const auto since = finished_at_.time_since_epoch().count() == 0 ? created_at_ : finished_at_;
    return now - since >= std::chrono::milliseconds(terminal_ttl_ms);
  }

  if (abandoned_ttl_ms <= 0) return true;
  return now - created_at_ >= std::chrono::milliseconds(abandoned_ttl_ms);
}

SessionSnapshot QuerySession::snapshot() const {
  std::lock_guard<std::mutex> lk(mu_);
  SessionSnapshot s;
  s.query_id = query_id_;
  s.status = status_;
  s.read_rows_total = read_rows_total_;
  s.read_bytes_total = read_bytes_total_;
  s.total_rows_to_read = total_rows_to_read_;
  s.result_rows_emitted = result_rows_emitted_;
  s.result_bytes_emitted = result_bytes_emitted_;
  s.written_rows_total = written_rows_total_;
  s.written_bytes_total = written_bytes_total_;
  s.user_time_us_total = profile_.user_time_us_total;
  s.system_time_us_total = profile_.system_time_us_total;
  s.cpu_time_available = profile_.cpu_time_available;
  s.current_mem_bytes = profile_.current_mem_bytes;
  s.peak_mem_bytes = profile_.peak_mem_bytes;
  s.elapsed_ms = ms_since(started_at_, finished_at_);
  s.receive_ms = receive_ns_ / 1000000;
  s.encode_ms = encode_ns_ / 1000000;
  s.backpressure_ms = backpressure_ns_ / 1000000;
  return s;
}

std::vector<SamplePoint> QuerySession::drain_samples(size_t max_points) {
  std::lock_guard<std::mutex> lk(mu_);
  std::vector<SamplePoint> out;
  if (max_points == 0) {
    samples_.clear();
    return out;
  }

  while (samples_.size() > max_points) {
    samples_.pop_front();
  }

  out.reserve(samples_.size());
  while (!samples_.empty()) {
    out.push_back(samples_.front());
    samples_.pop_front();
  }
  return out;
}

bool QuerySession::wait_pop_sse_batch(std::string& out, int wait_ms) {
  out.clear();
  std::unique_lock<std::mutex> lk(mu_);
  auto is_terminal = [&]() {
    return status_ == SessionStatus::Finished || status_ == SessionStatus::Error ||
           status_ == SessionStatus::Canceled || status_ == SessionStatus::ResultLimitReached;
  };

  if (sse_chunks_.empty() && wait_ms > 0) {
    cv_.wait_for(lk, std::chrono::milliseconds(wait_ms), [&] {
      return !sse_chunks_.empty() || is_terminal();
    });
  }

  if (!sse_chunks_.empty()) {
    const size_t event_limit = std::max<size_t>(1, options_.sse_write_batch_events);
    const size_t byte_limit = std::max<size_t>(1, options_.sse_write_batch_bytes);
    const size_t reserve_bytes = std::min(queued_sse_bytes_, byte_limit);

    queued_sse_bytes_ -= std::min(queued_sse_bytes_, sse_chunks_.front().size());
    out = std::move(sse_chunks_.front());
    sse_chunks_.pop_front();
    out.reserve(std::max(out.size(), reserve_bytes));

    size_t events = 1;
    while (!sse_chunks_.empty() && events < event_limit) {
      const std::string& next = sse_chunks_.front();
      if (out.size() + next.size() > byte_limit) break;
      queued_sse_bytes_ -= std::min(queued_sse_bytes_, next.size());
      out += next;
      sse_chunks_.pop_front();
      ++events;
      if (out.size() >= byte_limit) break;
    }
    lk.unlock();
    cv_.notify_all(); // wake a producer blocked by queue backpressure
    return true;
  }

  return !is_terminal();
}

void QuerySession::push_sse_json_event(std::string_view event_name, std::string_view json) {
  std::string chunk;
  chunk.reserve(event_name.size() + json.size() + 16);
  chunk += "event: ";
  chunk += event_name;
  chunk += "\ndata: ";
  chunk += json;
  chunk += "\n\n";

  if ((event_name == "result_rows" || event_name == "result_meta") &&
      chunk.size() > options_.max_result_event_bytes) {
    throw std::runtime_error(
        "result_event_too_large: Result event exceeds query.max_result_event_bytes (" +
        std::to_string(options_.max_result_event_bytes) + " bytes).");
  }

  std::unique_lock<std::mutex> lk(mu_);
  const auto wait_started = std::chrono::steady_clock::now();
  cv_.wait(lk, [&] {
    return cancel_requested_.load(std::memory_order_relaxed) ||
           sse_chunks_.empty() ||
           queued_sse_bytes_ + chunk.size() <= options_.sse_queue_max_bytes;
  });
  backpressure_ns_ += std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now() - wait_started).count();
  if (cancel_requested_.load(std::memory_order_relaxed)) return;
  queued_sse_bytes_ += chunk.size();
  sse_chunks_.push_back(std::move(chunk));
  lk.unlock();
  cv_.notify_all();
}

void QuerySession::notify_terminal_status(SessionStatus status) {
  if (!terminal_status_observer_) return;
  bool expected = false;
  if (!terminal_status_notified_.compare_exchange_strong(expected, true)) return;

  int64_t elapsed_ms = 0;
  {
    std::lock_guard<std::mutex> lk(mu_);
    elapsed_ms = ms_since(started_at_, finished_at_);
  }

  try {
    terminal_status_observer_(status, elapsed_ms);
  } catch (...) {
    // Registry bookkeeping must never change query execution semantics.
  }
}

void QuerySession::finish_ok() {
  bool changed = false;
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (status_ == SessionStatus::Canceled) return;
    status_ = SessionStatus::Finished;
    finished_at_ = std::chrono::steady_clock::now();
    changed = true;
  }
  cv_.notify_all();
  if (changed) notify_terminal_status(SessionStatus::Finished);
}

void QuerySession::finish_canceled() {
  {
    std::lock_guard<std::mutex> lk(mu_);
    status_ = SessionStatus::Canceled;
    finished_at_ = std::chrono::steady_clock::now();
  }
  cv_.notify_all();
  notify_terminal_status(SessionStatus::Canceled);
}

void QuerySession::finish_result_limit_reached() {
  {
    std::lock_guard<std::mutex> lk(mu_);
    status_ = SessionStatus::ResultLimitReached;
    finished_at_ = std::chrono::steady_clock::now();
  }
  cv_.notify_all();
  notify_terminal_status(SessionStatus::ResultLimitReached);
}

void QuerySession::finish_error(const std::string& message) {
  if (cancel_requested_.load(std::memory_order_relaxed)) {
    finish_canceled();
    return;
  }

  const auto location = parse_clickhouse_error_location(message, sql_);
  const ClickHouseErrorLocation* location_ptr =
      (location.has_code || location.has_position || location.has_line_col || location.has_near)
      ? &location
      : nullptr;
  std::string error_code = "query_failed";
  std::string public_message = message;
  for (const char* code : {"result_cell_too_large", "result_event_too_large"}) {
    const std::string prefix = std::string(code) + ":";
    if (public_message.rfind(prefix, 0) == 0) {
      error_code = code;
      public_message.erase(0, prefix.size());
      while (!public_message.empty() && public_message.front() == ' ') public_message.erase(public_message.begin());
      break;
    }
  }
  const std::string payload = build_error_payload_json(
      error_code, public_message, location_ptr, &query_id_, nullptr);
  push_sse_json_event("error", payload);

  SessionStatus terminal = SessionStatus::Error;
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (status_ == SessionStatus::Canceled || cancel_requested_.load(std::memory_order_relaxed)) {
      status_ = SessionStatus::Canceled;
      terminal = SessionStatus::Canceled;
    } else {
      status_ = SessionStatus::Error;
    }
    finished_at_ = std::chrono::steady_clock::now();
  }
  cv_.notify_all();
  notify_terminal_status(terminal);
}

void QuerySession::maybe_record_sample_locked(const std::chrono::steady_clock::time_point& now) {
  const auto min_interval = std::chrono::milliseconds(std::max(10, options_.sample_interval_ms));
  if (last_sample_at_.time_since_epoch().count() != 0 && now - last_sample_at_ < min_interval) {
    return;
  }
  last_sample_at_ = now;

  // One fully busy CPU core is 100.00%. Parallel ClickHouse queries may
  // legitimately exceed 100% because the value is based on native query-group
  // user and system CPU counters.
  const int64_t cpu_total_us = profile_.user_time_us_total + profile_.system_time_us_total;
  int64_t cpu_centi = -1;
  if (last_sample_cpu_at_.time_since_epoch().count() != 0) {
    const auto dt_us = std::chrono::duration_cast<std::chrono::microseconds>(
        now - last_sample_cpu_at_).count();
    const int64_t delta_cpu_us = cpu_total_us - last_sample_cpu_total_us_;
    if (profile_.cpu_time_available && dt_us > 0 && delta_cpu_us >= 0) {
      cpu_centi = static_cast<int64_t>(
          static_cast<__int128>(delta_cpu_us) * 10000 / dt_us);
    }
  }
  last_sample_cpu_at_ = now;
  last_sample_cpu_total_us_ = cpu_total_us;

  samples_.push_back(SamplePoint{
      ms_since(started_at_, now),
      read_rows_total_,
      read_bytes_total_,
      written_rows_total_,
      written_bytes_total_,
      cpu_centi,
      profile_.current_mem_bytes,
  });
  while (samples_.size() > 512) samples_.pop_front();
}


void QuerySession::run_query() {
  auto discard_query_connection = [&]() {
    if (!client_query_) return;
    if (client_pool_) client_pool_->invalidate(client_query_);
    client_query_.reset();
  };

  auto acquire_query_connection = [&]() {
    std::string error;
    client_query_ = client_pool_ ? client_pool_->acquire(
        runner_uri_,
        std::chrono::seconds(5),
        std::chrono::milliseconds(0),
        std::chrono::milliseconds(0),
        &error)
      : make_client_from_uri(
        runner_uri_,
        std::chrono::seconds(5),
        std::chrono::milliseconds(0),
        std::chrono::milliseconds(0),
        &error);
    if (!client_query_) {
      throw std::runtime_error(
          error.empty() ? "Could not connect to ClickHouse." : error);
    }
  };

  auto reset_stats_for_compat_retry = [&]() {
    std::lock_guard<std::mutex> lk(mu_);
    read_rows_total_ = 0;
    read_bytes_total_ = 0;
    total_rows_to_read_ = 0;
    result_rows_emitted_ = 0;
    result_bytes_emitted_ = 0;
    written_rows_total_ = 0;
    written_bytes_total_ = 0;
        profile_.reset();
    samples_.clear();
    receive_ns_ = 0;
    encode_ns_ = 0;
    backpressure_ns_ = 0;
    last_sample_at_ = {};
    last_sample_cpu_at_ = {};
    last_sample_cpu_total_us_ = 0;
  };

  // Every statement of the run carries its bounds and its label; a cancel stops
  // the next one before it is sent.
  ChQueryLimits limits;
  limits.log_comment = "chdash-run";
  limits.max_execution_time_s = options_.max_execution_time_s;
  limits.max_memory_usage = options_.max_memory_usage;
  limits.max_rows_to_read = options_.max_rows_to_read;
  limits.canceled = [this] { return cancel_requested_.load(std::memory_order_relaxed); };
  ChQueryScope scope(std::move(limits));

  try {
    if (cancel_requested_.load(std::memory_order_relaxed)) {
      finish_canceled();
      return;
    }

    // Acquire the TCP connection only when the SSE consumer is attached. This
    // makes POST /api/query/run allocation-only, avoids holding pooled sockets
    // for abandoned runs, and keeps connection latency in the measured stream.
    try {
      acquire_query_connection();
    } catch (const std::exception& e) {
      finish_error(e.what() ? e.what() : "Could not connect to ClickHouse.");
      return;
    }

    if (!database_.empty()) ch_execute(*client_query_, "USE " + quote_ident(database_));
    const std::string first_keyword = sql_first_keyword_lower(sql_);
    const bool is_wrappable_select = first_keyword == "select" || first_keyword == "with";
    const bool is_select_like = is_wrappable_select || first_keyword == "show" ||
                                first_keyword == "describe" || first_keyword == "desc" ||
                                first_keyword == "explain";

    auto apply_explicit_profiling_settings = [this](clickhouse::Query& query) {
      if (!detailed_profiling_) return;
      const auto set_bool = [&query](const char* name) {
        clickhouse::QuerySettingsField field;
        field.value = "1";
        query.SetSetting(name, field);
      };
      set_bool("log_queries");
      set_bool("log_profile_events");
      set_bool("log_processors_profiles");
      set_bool("log_query_views");
      // Profiling mode is explicitly opt-in, so collect a real wall-clock
      // processor trace only for this query instead of globally sampling all
      // dashboard traffic.
      set_bool("opentelemetry_trace_processors");
      set_bool("opentelemetry_start_trace_probability");
    };

    if (!is_select_like) {
      if (cancel_requested_.load(std::memory_order_relaxed)) {
        throw std::runtime_error("canceled");
      }
      clickhouse::Query command(sql_, begin_native_query_attempt());
      apply_explicit_profiling_settings(command);
      if (cancel_requested_.load(std::memory_order_relaxed)) {
        throw std::runtime_error("canceled");
      }
      ch_execute(*client_query_, command);
      // USE, SET (including SET ROLE) and temporary tables change native
      // *session* state. Returning such a connection to the shared pool would
      // leak the current database/settings/temporary objects into unrelated
      // later runs (other tabs or users), so drop it instead.
      if (first_keyword == "use" || first_keyword == "set" ||
          mask_sql_surface(sql_).code_lower.find("temporary") != std::string::npos) {
        discard_query_connection();
      }
      {
        rapidjson::StringBuffer sb;
        rapidjson::Writer<rapidjson::StringBuffer> w(sb);
        w.StartObject();
        w.Key("query_id"); write_json_text(w, query_id_);
        w.Key("columns"); w.StartArray(); w.String("status"); w.EndArray();
        w.Key("types"); w.StartArray(); w.String("String"); w.EndArray();
        w.EndObject();
        push_sse_json_event("result_meta", sb.GetString());
      }
      {
        rapidjson::StringBuffer sb;
        rapidjson::Writer<rapidjson::StringBuffer> w(sb);
        w.StartObject();
        w.Key("query_id"); write_json_text(w, query_id_);
        w.Key("rows");
        w.StartArray();
        w.StartArray();
        w.String("OK");
        w.EndArray();
        w.EndArray();
        w.EndObject();
        push_sse_json_event("result_rows", sb.GetString());
      }

      {
        std::lock_guard<std::mutex> lk(mu_);
        result_rows_emitted_ = 1;
      }

      client_query_.reset();
      finish_ok();
      return;
    }

    bool result_limit_reached = false;
    ResultEventLimits event_limits;
    event_limits.row_limit = result_preview_row_limit_ > 0 ? static_cast<size_t>(result_preview_row_limit_) : std::numeric_limits<size_t>::max();
    event_limits.max_rows_per_event = static_cast<size_t>(std::max(1, options_.result_rows_batch_size));
    event_limits.max_bytes_per_event = std::max<size_t>(16 * 1024, options_.result_rows_batch_bytes);
    event_limits.max_result_cell_bytes = options_.max_result_cell_bytes;
    ResultEventWriter writer(
        query_id_, event_limits,
        [this](std::string_view event, std::string_view json) { push_sse_json_event(event, json); },
        [this](size_t rows, size_t bytes) {
          std::lock_guard<std::mutex> lk(mu_);
          result_rows_emitted_ += rows;
          result_bytes_emitted_ += bytes;
        });
    const std::string plan_cache_key = describe_cache_key(host_id_, database_, sql_);
    bool attempt_used_cached_plan = false;

    auto apply_database = [&]() {
      if (!database_.empty()) ch_execute(*client_query_, "USE " + quote_ident(database_));
    };

    auto execute_select_attempt = [&](bool use_describe, bool allow_cached_plan) {
      if (cancel_requested_.load(std::memory_order_relaxed)) {
        throw std::runtime_error("canceled");
      }
      // The direct path intentionally skips DESCRIBE. Auto mode pre-plans SQL
      // that visibly produces driver-incompatible result types, and otherwise
      // retries once only if the native decoder fails before any SSE payload.
      ResultPlan result_plan;
      bool cache_new_plan_after_success = false;
      attempt_used_cached_plan = false;

      if (use_describe && is_wrappable_select) {
        if (allow_cached_plan) {
          if (auto cached = get_cached_describe_plan(describe_cache_.get(), plan_cache_key, options_.describe_cache_entries, options_.describe_cache_ttl_ms)) {
            result_plan = std::move(*cached);
            attempt_used_cached_plan = true;
          }
        }

        if (result_plan.empty()) {
          const std::string ds = strip_trailing_semicolon_copy(sql_);
          clickhouse::Query dq("DESCRIBE (" + ds + ")");
          dq.OnData([&](const clickhouse::Block& b) { add_described_columns(b, &result_plan); });
          ch_execute(*client_query_, dq);
          cache_new_plan_after_success = !result_plan.empty();
        }
      }

      bool used_transport_wrapper = false;
      std::string effective_sql = sql_;
      if (use_describe && is_wrappable_select && !result_plan.empty()) {
        effective_sql = build_transport_wrapper_sql(sql_, result_plan, &used_transport_wrapper);
      }

      writer.begin_attempt(&result_plan, used_transport_wrapper, use_describe, attempt_used_cached_plan);

      const std::string native_query_id = begin_native_query_attempt();
      {
        std::lock_guard<std::mutex> lk(mu_);
        backpressure_ns_ = 0;
      }
      clickhouse::Query q(effective_sql, native_query_id);
      apply_explicit_profiling_settings(q);

      // Ensure ClickHouse sends query-group ProfileEvents over native TCP.
      // Only counters and gauges emitted by ClickHouse are exposed. Missing
      // events remain unavailable instead of being inferred from another value.
      {
        clickhouse::QuerySettingsField f;
        f.value = "1";
        q.SetSetting("send_profile_events", f);
      }

      q.OnProgress([self = shared_from_this()](const clickhouse::Progress& p) {
        if (self->cancel_requested_.load(std::memory_order_relaxed)) {
          throw std::runtime_error("canceled");
        }
        const auto now = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lk(self->mu_);
        self->read_rows_total_ += p.rows;
        self->read_bytes_total_ += p.bytes;
        self->written_rows_total_ += p.written_rows;
        self->written_bytes_total_ += p.written_bytes;
        if (p.total_rows > 0) {
          self->total_rows_to_read_ = std::max<uint64_t>(self->total_rows_to_read_, p.total_rows);
        }

        self->maybe_record_sample_locked(now);
      });

      // ClickHouse ProfileEvents packets have a stable schema:
      // host_name, current_time, thread_id, type, name, value. Consume only the
      // query-group aggregate (thread_id = 0). Thread counts are deliberately
      // not inferred or exposed.
      q.OnProfileEvents([self = shared_from_this()](const clickhouse::Block& block) -> bool {
        if (self->cancel_requested_.load(std::memory_order_relaxed)) return false;
        const auto now = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lock(self->mu_);
        if (self->profile_.apply(block)) self->maybe_record_sample_locked(now);
        return true;
      });

      // The time of the callbacks, to split the time of Select() into what the
      // native client spent (receive) and what ChDash spent (encode).
      int64_t on_data_ns = 0;
      int64_t encode_busy_ns = 0;
      const auto select_started = std::chrono::steady_clock::now();
      auto encode_block = [&](const clickhouse::Block& block) {
        struct BusyTimer {
          int64_t& total;
          std::chrono::steady_clock::time_point since = std::chrono::steady_clock::now();
          ~BusyTimer() {
            total += std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - since).count();
          }
        } busy_timer{encode_busy_ns};
        if (cancel_requested_.load(std::memory_order_relaxed)) {
          throw std::runtime_error("canceled");
        }

        writer.write(block);
      };

      // The first block with rows is encoded in the receiving thread: most
      // results are one block, and they never pay for a thread. From the second
      // block on, a thread encodes while the client decodes the next block. The
      // encoder (and its thread) end before the state it uses.
      //
      // The preview limit is a normal end, not an error: once the result has a
      // row past the limit, the callback returns false once. clickhouse-cpp then
      // sends a Cancel packet and reads the rest of the stream, so the
      // connection goes back to the pool and no KILL QUERY is needed. The
      // blocks that still arrive are dropped.
      std::optional<BlockEncoder> encoder;
      bool first_rows_block_encoded = false;
      const uint64_t row_limit = result_preview_row_limit_ > 0
        ? static_cast<uint64_t>(result_preview_row_limit_)
        : std::numeric_limits<uint64_t>::max();
      uint64_t rows_received = 0;
      bool limit_reached = false;
      q.OnDataCancelable([&](const clickhouse::Block& block) -> bool {
        struct OnDataTimer {
          int64_t& total;
          std::chrono::steady_clock::time_point since = std::chrono::steady_clock::now();
          ~OnDataTimer() {
            total += std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - since).count();
          }
        } on_data_timer{on_data_ns};
        if (limit_reached) return true;
        if (cancel_requested_.load(std::memory_order_relaxed)) {
          throw std::runtime_error("canceled");
        }
        const uint64_t block_rows = block.GetRowCount();
        if (block_rows > 0 && rows_received >= row_limit) {
          limit_reached = true;
          return false;
        }
        rows_received += block_rows;
        if (encoder) {
          if (block_rows > 0) encoder->submit(block, cancel_requested_);
        } else if (block_rows > 0 && first_rows_block_encoded) {
          encoder.emplace(encode_block, kEncodeQueueBlocks);
          encoder->submit(block, cancel_requested_);
        } else {
          if (block_rows > 0) first_rows_block_encoded = true;
          encode_block(block);
        }
        // The encoder writes the rows up to the limit; a block that crosses it ends the result.
        if (rows_received > row_limit) {
          limit_reached = true;
          return false;
        }
        return true;
      });

      if (cancel_requested_.load(std::memory_order_relaxed)) {
        throw std::runtime_error("canceled");
      }
      try {
        ch_execute(*client_query_, q);
      } catch (const clickhouse::ServerError& error) {
        // Some servers end a canceled stream with QUERY_WAS_CANCELLED (394) or
        // QUERY_WAS_CANCELLED_BY_CLIENT (735): after the limit, it is the expected
        // last packet.
        if (!(limit_reached && (error.GetCode() == 394 || error.GetCode() == 735))) throw;
      }
      if (encoder) encoder->finish();
      if (limit_reached) result_limit_reached = true;
      {
        const int64_t select_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - select_started).count();
        std::lock_guard<std::mutex> lk(mu_);
        // receive: the time in the native client; encode: the time of the encoding
        // (which can run beside the client); backpressure: the wait for the browser.
        receive_ns_ = std::max<int64_t>(0, select_ns - on_data_ns);
        encode_ns_ = std::max<int64_t>(0, encode_busy_ns - backpressure_ns_);
      }
      if (cache_new_plan_after_success) {
        put_cached_describe_plan(describe_cache_.get(), plan_cache_key, result_plan, options_.describe_cache_entries, options_.describe_cache_ttl_ms);
      }
    };

    const bool force_describe = options_.describe_mode == QueryDescribeMode::Always;
    const bool auto_describe = options_.describe_mode == QueryDescribeMode::Auto &&
                               is_wrappable_select &&
                               sql_likely_requires_compat_describe(sql_);
    const bool initial_describe = force_describe || auto_describe;
    const bool allow_describe_retry = options_.describe_mode == QueryDescribeMode::Auto &&
                                      is_wrappable_select && !initial_describe;

    try {
      execute_select_attempt(initial_describe, true);
    } catch (const std::exception& e) {
      const std::string msg = e.what() ? std::string(e.what()) : std::string("error");
      // Result metadata may already have been emitted from a native header block
      // before clickhouse-cpp fails while decoding the first data block (notably
      // for JSON serialization compatibility). Retrying is still safe as long as
      // no result row has reached the client: a second result_meta simply replaces
      // the provisional schema before any rows are appended.
      const bool can_retry_without_emitted_rows = writer.rows_returned() == 0 &&
          msg != "canceled" &&
          !cancel_requested_.load(std::memory_order_relaxed);

      if (initial_describe && attempt_used_cached_plan && can_retry_without_emitted_rows) {
        // Schema changed while a plan was cached. The failed native attempt may
        // remain visible in system.processes briefly after its socket closes.
        // Stop it synchronously and use a distinct id for the retry so a slow
        // cleanup can never trigger QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING.
        const std::string failed_native_id = latest_native_query_id();
        invalidate_cached_describe_plan(describe_cache_.get(), plan_cache_key);
        discard_query_connection();
        cancel_native_query_ids_best_effort({failed_native_id}, true);
        acquire_query_connection();
        apply_database();
        reset_stats_for_compat_retry();
        writer.restart();
        execute_select_attempt(true, false);
      } else if (allow_describe_retry && can_retry_without_emitted_rows &&
                 should_retry_with_describe_after_direct_path_error(msg)) {
        // A failed native decode can leave both the connection mid-packet and
        // the server-side query alive for a short period. Discard the transport,
        // synchronously stop the failed attempt, then retry under a unique id.
        const std::string failed_native_id = latest_native_query_id();
        discard_query_connection();
        cancel_native_query_ids_best_effort({failed_native_id}, true);
        acquire_query_connection();
        apply_database();
        reset_stats_for_compat_retry();
        writer.restart();
        execute_select_attempt(true, true);
      } else {
        throw;
      }
    }

    if (result_limit_reached) {
      finish_result_limit_reached();
    } else {
      finish_ok();
    }
    client_query_.reset();

  } catch (const std::exception& e) {
    std::string msg = e.what() ? std::string(e.what()) : std::string("error");
    // An error of the server ended the statement: the connection is clean and
    // nothing runs any more. Anything else (a transport failure, a cancel, a
    // limit of the encoder) left the statement in an unknown state: the pool
    // closes the connection, and the native attempt that may still run is
    // stopped.
    if (client_query_ && ch_connection_dirty(*client_query_)) {
      discard_query_connection();
      cancel_native_queries_best_effort(false);
    }
    client_query_.reset();
    if (msg == "canceled" || cancel_requested_.load(std::memory_order_relaxed)) {
      finish_canceled();
    } else {
      finish_error(msg);
    }
  }
}

} // namespace chdash
