#include "query_session.hpp"
#include "api_error.hpp"
#include "ch_client_pool.hpp"
#include "ch_uri.hpp"
#include "json_clickhouse.hpp"
#include "sql_scan.hpp"

#include <clickhouse/query.h>
#include <clickhouse/columns/enum.h>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <functional>
#include <iterator>
#include <limits>
#include <optional>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace chdash {

// ClickHouse may pretty-print complex types returned by DESCRIBE with newlines/indentation.
// This produces noisy JSON ("\n    ") in result_meta. Normalize it to a single-line form
// while keeping the type parseable for the frontend.
static std::string normalize_type_string(std::string s) {
  std::string out;
  out.reserve(s.size());

  bool space_pending = false;
  bool in_squote = false;
  bool in_btick = false;

  auto is_ws = [](unsigned char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
  };

  for (size_t i = 0; i < s.size(); ++i) {
    const char ch = s[i];
    const char prev = (i > 0) ? s[i - 1] : '\0';

    // Preserve content inside quotes/backticks (best-effort).
    if (!in_btick && ch == '\'' && prev != '\\') {
      in_squote = !in_squote;
      space_pending = false;
      out.push_back(ch);
      continue;
    }
    if (!in_squote && ch == '`') {
      in_btick = !in_btick;
      space_pending = false;
      out.push_back(ch);
      continue;
    }
    if (in_squote || in_btick) {
      out.push_back(ch);
      continue;
    }

    if (is_ws(static_cast<unsigned char>(ch))) {
      space_pending = true;
      continue;
    }

    if (!out.empty() && (ch == ')' || ch == ']' || ch == '}' || ch == ',')) {
      while (!out.empty() && out.back() == ' ') out.pop_back();
    }

    if (space_pending) {
      const char last = out.empty() ? '\0' : out.back();
      const bool no_space_before = (ch == ')' || ch == ']' || ch == '}' || ch == ',');
      const bool no_space_after = (last == '(' || last == '[' || last == '{' || last == ',');
      if (!no_space_before && !no_space_after && last != ' ' && last != '\0') {
        out.push_back(' ');
      }
      space_pending = false;
    }

    out.push_back(ch);
    if (ch == ',') {
      out.push_back(' ');
    }
  }

  // Trim.
  while (!out.empty() && out.back() == ' ') out.pop_back();
  size_t start = 0;
  while (start < out.size() && out[start] == ' ') start++;
  if (start > 0) out.erase(0, start);

  return out;
}

static int64_t ms_since(const std::chrono::steady_clock::time_point& start,
                        const std::chrono::steady_clock::time_point& end_or_zero) {
  if (start.time_since_epoch().count() == 0) return 0;
  const auto end = (end_or_zero.time_since_epoch().count() == 0) ? std::chrono::steady_clock::now() : end_or_zero;
  return std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
}

static std::string sql_quote_string(std::string_view s);


QuerySession::QuerySession(
  std::string query_id,
  std::string host_id,
  std::string sql,
  std::string database,
  std::string runner_uri,
  std::string stats_uri,
  std::shared_ptr<ClickHouseClientPool> client_pool,
  int result_preview_row_limit,
  QuerySessionOptions options
) : query_id_(std::move(query_id)),
    host_id_(std::move(host_id)),
    sql_(std::move(sql)),
    database_(std::move(database)),
    runner_uri_(std::move(runner_uri)),
    stats_uri_(std::move(stats_uri)),
    client_pool_(std::move(client_pool)),
    result_preview_row_limit_(result_preview_row_limit),
    options_(std::move(options)) {
  if (options_.sample_interval_ms < 10) options_.sample_interval_ms = 10;
  if (options_.sample_interval_ms > 1000) options_.sample_interval_ms = 1000;
  if (options_.result_rows_batch_size <= 0) options_.result_rows_batch_size = 1000;
  if (options_.result_rows_batch_size > 10000) options_.result_rows_batch_size = 10000;
  options_.result_rows_batch_bytes = std::max<size_t>(16 * 1024, std::min<size_t>(4 * 1024 * 1024, options_.result_rows_batch_bytes));
  options_.sse_write_batch_events = std::max<size_t>(1, std::min<size_t>(64, options_.sse_write_batch_events));
  options_.sse_write_batch_bytes = std::max<size_t>(16 * 1024, std::min<size_t>(4 * 1024 * 1024, options_.sse_write_batch_bytes));
  options_.sse_queue_max_bytes = std::max<size_t>(options_.sse_write_batch_bytes, std::min<size_t>(128 * 1024 * 1024, options_.sse_queue_max_bytes));
  options_.describe_cache_entries = std::min<size_t>(4096, options_.describe_cache_entries);
  options_.describe_cache_ttl_ms = std::max(0, std::min(60 * 60 * 1000, options_.describe_cache_ttl_ms));
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
      cv_.notify_all();
      return;
    }
    status_ = SessionStatus::Running;
    started_at_ = std::chrono::steady_clock::now();
  }

  query_thread_ = std::thread([self = shared_from_this()] { self->run_query(); });
}

void QuerySession::request_cancel() {
  cancel_requested_.store(true, std::memory_order_relaxed);

  {
    std::lock_guard<std::mutex> lk(mu_);
    if (status_ == SessionStatus::Running || status_ == SessionStatus::Created) {
      status_ = SessionStatus::Canceled;
      finished_at_ = std::chrono::steady_clock::now();
    }
  }
  cv_.notify_all();
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
  s.wrote_rows_total = wrote_rows_total_;
  s.wrote_bytes_total = wrote_bytes_total_;
  s.user_time_us_total = user_time_us_total_;
  s.system_time_us_total = system_time_us_total_;
  s.cpu_wait_time_us_total = cpu_wait_time_us_total_;
  s.io_wait_time_us_total = io_wait_time_us_total_;
  s.cpu_time_available = cpu_time_available_;
  s.cpu_wait_available = cpu_wait_available_;
  s.io_wait_available = io_wait_available_;
  s.current_mem_bytes = current_mem_bytes_;
  s.peak_mem_bytes = peak_mem_bytes_;
  s.temporary_data_bytes = temporary_data_bytes_;
  s.elapsed_ms = ms_since(started_at_, finished_at_);
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
    out.push_back(std::move(samples_.front()));
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

  std::unique_lock<std::mutex> lk(mu_);
  cv_.wait(lk, [&] {
    return cancel_requested_.load(std::memory_order_relaxed) ||
           sse_chunks_.empty() ||
           queued_sse_bytes_ + chunk.size() <= options_.sse_queue_max_bytes;
  });
  if (cancel_requested_.load(std::memory_order_relaxed)) return;
  queued_sse_bytes_ += chunk.size();
  sse_chunks_.push_back(std::move(chunk));
  lk.unlock();
  cv_.notify_all();
}

void QuerySession::finish_ok() {
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (status_ == SessionStatus::Canceled) return;
    status_ = SessionStatus::Finished;
    finished_at_ = std::chrono::steady_clock::now();
  }
  cv_.notify_all();
}

void QuerySession::finish_canceled() {
  {
    std::lock_guard<std::mutex> lk(mu_);
    status_ = SessionStatus::Canceled;
    finished_at_ = std::chrono::steady_clock::now();
  }
  cv_.notify_all();
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
  const std::string payload = build_error_payload_json(
      "query_failed", message, location_ptr, &query_id_, nullptr);
  push_sse_json_event("error", payload);

  {
    std::lock_guard<std::mutex> lk(mu_);
    if (status_ == SessionStatus::Canceled || cancel_requested_.load(std::memory_order_relaxed)) {
      status_ = SessionStatus::Canceled;
    } else {
      status_ = SessionStatus::Error;
    }
    finished_at_ = std::chrono::steady_clock::now();
  }
  cv_.notify_all();
}

void QuerySession::refresh_stats_from_query_log_best_effort() {
  if (!options_.final_stats_from_query_log) return;

  // Keep the optional query_log connection out of the hot query path. Most
  // installations leave these final stats disabled; when enabled, acquire the
  // system client only after the result stream has completed. Reuse the query
  // client when both roles use the same URI.
  if (!client_stats_) {
    if (stats_uri_.empty() || stats_uri_ == runner_uri_) {
      client_stats_ = client_query_;
    } else {
      std::string err;
      client_stats_ = client_pool_ ? client_pool_->acquire(
          stats_uri_,
          std::chrono::seconds(5),
          std::chrono::seconds(5),
          std::chrono::seconds(5),
          &err)
        : make_client_from_uri(
          stats_uri_,
          std::chrono::seconds(5),
          std::chrono::seconds(5),
          std::chrono::seconds(5),
          &err);
    }
  }

  auto client = client_stats_ ? client_stats_ : client_query_;
  if (!client) return;

  const std::string sql =
    "SELECT toUInt64(read_rows) AS read_rows, toUInt64(read_bytes) AS read_bytes, "
    "toInt64(memory_usage) AS memory_usage "
    "FROM system.query_log "
    "WHERE query_id = " + sql_quote_string(query_id_) + " "
    "ORDER BY event_time_microseconds DESC "
    "LIMIT 1";

  uint64_t log_read_rows = 0;
  uint64_t log_read_bytes = 0;
  int64_t log_memory_usage = -1;

  for (int attempt = 0; attempt < 5; ++attempt) {
    if (options_.flush_query_log_for_final_stats) {
      try {
        client->Execute("SYSTEM FLUSH LOGS query_log");
      } catch (...) {
      }
    }

    bool found = false;
    try {
      clickhouse::Query q(sql);
      q.OnData([&](const clickhouse::Block& b) {
        if (b.GetRowCount() == 0 || b.GetColumnCount() < 3) return;

        auto c_read_rows = b[0]->As<clickhouse::ColumnUInt64>();
        auto c_read_bytes = b[1]->As<clickhouse::ColumnUInt64>();
        auto c_memory_i64 = b[2]->As<clickhouse::ColumnInt64>();
        auto c_memory_u64 = b[2]->As<clickhouse::ColumnUInt64>();
        if (!c_read_rows || !c_read_bytes || (!c_memory_i64 && !c_memory_u64)) return;

        log_read_rows = c_read_rows->At(0);
        log_read_bytes = c_read_bytes->At(0);
        log_memory_usage = c_memory_i64 ? c_memory_i64->At(0) : static_cast<int64_t>(c_memory_u64->At(0));
        found = true;
      });
      client->Select(q);
    } catch (...) {
    }

    if (found) {
      std::lock_guard<std::mutex> lk(mu_);
      read_rows_total_ = std::max<uint64_t>(read_rows_total_, log_read_rows);
      read_bytes_total_ = std::max<uint64_t>(read_bytes_total_, log_read_bytes);
      total_rows_to_read_ = std::max<uint64_t>(total_rows_to_read_, read_rows_total_);
      if (log_memory_usage >= 0) {
        current_mem_bytes_ = std::max<int64_t>(current_mem_bytes_, log_memory_usage);
        peak_mem_bytes_ = std::max<int64_t>(peak_mem_bytes_, log_memory_usage);
      }
      return;
    }

    if (attempt + 1 < 5) {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
  }
}

void QuerySession::maybe_record_sample_locked(const std::chrono::steady_clock::time_point& now) {
  const auto min_interval = std::chrono::milliseconds(std::max(10, options_.sample_interval_ms));
  if (last_sample_at_.time_since_epoch().count() != 0 && now - last_sample_at_ < min_interval) {
    return;
  }
  last_sample_at_ = now;

  // Rates are computed from ClickHouse query-group counters. One fully busy
  // core is 100.00%, so parallel queries may legitimately exceed 100%.
  const int64_t cpu_total_us = user_time_us_total_ + system_time_us_total_;
  int64_t cpu_centi = -1;
  int64_t cpu_wait_centi = -1;
  int64_t io_wait_centi = -1;
  if (last_sample_cpu_at_.time_since_epoch().count() != 0) {
    const auto dt_us = std::chrono::duration_cast<std::chrono::microseconds>(now - last_sample_cpu_at_).count();
    const int64_t d_cpu = cpu_total_us - last_sample_cpu_total_us_;
    const int64_t d_cpu_wait = cpu_wait_time_us_total_ - last_sample_cpu_wait_total_us_;
    const int64_t d_io_wait = io_wait_time_us_total_ - last_sample_io_wait_total_us_;
    if (dt_us > 0) {
      if (cpu_time_available_ && d_cpu >= 0) {
        cpu_centi = static_cast<int64_t>((__int128)d_cpu * 10000 / dt_us);
      }
      if (cpu_wait_available_ && d_cpu_wait >= 0) {
        cpu_wait_centi = static_cast<int64_t>((__int128)d_cpu_wait * 10000 / dt_us);
      }
      if (io_wait_available_ && d_io_wait >= 0) {
        io_wait_centi = static_cast<int64_t>((__int128)d_io_wait * 10000 / dt_us);
      }
    }
  }
  last_sample_cpu_at_ = now;
  last_sample_cpu_total_us_ = cpu_total_us;
  last_sample_cpu_wait_total_us_ = cpu_wait_time_us_total_;
  last_sample_io_wait_total_us_ = io_wait_time_us_total_;

  const int64_t elapsed_ms = ms_since(started_at_, now);
  samples_.push_back(SamplePoint{
      elapsed_ms,
      read_rows_total_,
      read_bytes_total_,
      cpu_centi,
      current_mem_bytes_,
      cpu_wait_centi,
      io_wait_centi,
  });
  // The SSE tick drains at most a handful of samples. A small safety window is
  // enough for temporary network stalls and prevents unbounded telemetry growth
  // when a client never opens the stream.
  while (samples_.size() > 512) samples_.pop_front();
}


static bool icontains(std::string_view hay, std::string_view needle) {
  if (needle.empty()) return true;
  for (size_t i = 0; i + needle.size() <= hay.size(); ++i) {
    bool ok = true;
    for (size_t j = 0; j < needle.size(); ++j) {
      char a = hay[i + j];
      char b = needle[j];
      if (a >= 'A' && a <= 'Z') a = char(a - 'A' + 'a');
      if (b >= 'A' && b <= 'Z') b = char(b - 'A' + 'a');
      if (a != b) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

static bool iequals_ascii(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    char x = a[i];
    char y = b[i];
    if (x >= 'A' && x <= 'Z') x = char(x - 'A' + 'a');
    if (y >= 'A' && y <= 'Z') y = char(y - 'A' + 'a');
    if (x != y) return false;
  }
  return true;
}

static std::string trim_copy(std::string s) {
  auto is_ws = [](char ch) {
    return ch == ' ' || ch == 9 || ch == 10 || ch == 13;
  };
  while (!s.empty() && is_ws(s.front())) s.erase(s.begin());
  while (!s.empty() && is_ws(s.back())) s.pop_back();
  return s;
}

static std::string strip_trailing_semicolon_copy(std::string s) {
  s = trim_copy(std::move(s));
  if (!s.empty() && s.back() == ';') {
    s.pop_back();
    s = trim_copy(std::move(s));
  }
  return s;
}

static std::string sql_quote_string(std::string_view s) {
  std::string out;
  out.reserve(s.size() + 2);
  out.push_back('\'');
  for (char ch : s) {
    out.push_back(ch);
    if (ch == '\'') out.push_back('\'');
  }
  out.push_back('\'');
  return out;
}

enum class ResultTransportMode {
  Passthrough,
  Stringify,
  Opaque,
};

struct ResultColumnPlan {
  std::string original_type;
  std::string transport_type;
  ResultTransportMode mode = ResultTransportMode::Passthrough;
};


using ResultPlan = std::vector<std::pair<std::string, ResultColumnPlan>>;

struct CachedDescribePlan {
  ResultPlan plan;
  std::chrono::steady_clock::time_point expires_at{};
  uint64_t access_sequence = 0;
};

static std::mutex g_describe_cache_mu;
static std::unordered_map<std::string, CachedDescribePlan> g_describe_cache;
static uint64_t g_describe_cache_sequence = 0;

static uint64_t fnv1a64(std::string_view value, uint64_t seed) {
  uint64_t hash = seed;
  for (const unsigned char ch : value) {
    hash ^= ch;
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

static std::string describe_cache_key(
    std::string_view host_id,
    std::string_view database,
    std::string_view sql
) {
  // Keep cache keys small even for multi-hundred-kilobyte editor buffers. Two
  // independently seeded 64-bit hashes plus the SQL length make accidental
  // collisions negligible for this process-local, short-lived cache.
  const uint64_t hash_a = fnv1a64(sql, UINT64_C(14695981039346656037));
  const uint64_t hash_b = fnv1a64(sql, UINT64_C(7809847782465536322));
  std::string key;
  key.reserve(host_id.size() + database.size() + 64);
  key.append(host_id.data(), host_id.size());
  key.push_back('\x1f');
  key.append(database.data(), database.size());
  key.push_back('\x1f');
  key += std::to_string(sql.size());
  key.push_back(':');
  key += std::to_string(hash_a);
  key.push_back(':');
  key += std::to_string(hash_b);
  return key;
}

static std::optional<ResultPlan> get_cached_describe_plan(
    const std::string& key,
    const QuerySessionOptions& options
) {
  if (options.describe_cache_entries == 0 || options.describe_cache_ttl_ms <= 0) return std::nullopt;
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lk(g_describe_cache_mu);
  auto it = g_describe_cache.find(key);
  if (it == g_describe_cache.end()) return std::nullopt;
  if (it->second.expires_at <= now) {
    g_describe_cache.erase(it);
    return std::nullopt;
  }
  it->second.access_sequence = ++g_describe_cache_sequence;
  return it->second.plan;
}

static void put_cached_describe_plan(
    const std::string& key,
    ResultPlan plan,
    const QuerySessionOptions& options
) {
  if (key.empty() || plan.empty() || options.describe_cache_entries == 0 || options.describe_cache_ttl_ms <= 0) return;
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lk(g_describe_cache_mu);

  for (auto it = g_describe_cache.begin(); it != g_describe_cache.end();) {
    if (it->second.expires_at <= now) it = g_describe_cache.erase(it);
    else ++it;
  }

  CachedDescribePlan entry;
  entry.plan = std::move(plan);
  entry.expires_at = now + std::chrono::milliseconds(options.describe_cache_ttl_ms);
  entry.access_sequence = ++g_describe_cache_sequence;
  g_describe_cache[key] = std::move(entry);

  while (g_describe_cache.size() > options.describe_cache_entries) {
    auto victim = g_describe_cache.begin();
    for (auto it = std::next(g_describe_cache.begin()); it != g_describe_cache.end(); ++it) {
      if (it->second.access_sequence < victim->second.access_sequence) victim = it;
    }
    g_describe_cache.erase(victim);
  }
}

static void invalidate_cached_describe_plan(const std::string& key) {
  if (key.empty()) return;
  std::lock_guard<std::mutex> lk(g_describe_cache_mu);
  g_describe_cache.erase(key);
}

static const char* transport_mode_name(ResultTransportMode mode) {
  switch (mode) {
    case ResultTransportMode::Passthrough: return "passthrough";
    case ResultTransportMode::Stringify: return "stringify";
    case ResultTransportMode::Opaque: return "opaque";
  }
  return "passthrough";
}

static bool unwrap_outer_type(std::string_view type, std::string_view outer_name, std::string_view* inner_out) {
  if (type.size() <= outer_name.size() + 2) return false;
  if (!iequals_ascii(type.substr(0, outer_name.size()), outer_name)) return false;
  if (type[outer_name.size()] != '(' || type.back() != ')') return false;

  int depth = 0;
  for (size_t i = outer_name.size(); i < type.size(); ++i) {
    const char ch = type[i];
    if (ch == '(') depth++;
    else if (ch == ')') {
      depth--;
      if (depth == 0 && i != type.size() - 1) return false;
    }
  }
  if (depth != 0) return false;

  if (inner_out) {
    *inner_out = type.substr(outer_name.size() + 1, type.size() - outer_name.size() - 2);
  }
  return true;
}

static bool is_top_level_nullable_type(std::string_view type) {
  std::string_view inner;
  return unwrap_outer_type(type, "Nullable", &inner);
}

static bool has_json_like_type(std::string_view type) {
  return icontains(type, "JSON") || icontains(type, "Dynamic") || icontains(type, "Object(");
}

static bool has_256_bit_int_type(std::string_view type) {
  return icontains(type, "UInt256") || icontains(type, "Int256");
}

static bool has_decimal_type(std::string_view type) {
  return icontains(type, "Decimal(") || icontains(type, "Decimal32") ||
         icontains(type, "Decimal64") || icontains(type, "Decimal128") ||
         icontains(type, "Decimal256");
}

static bool has_aggregate_function_type(std::string_view type) {
  return icontains(type, "AggregateFunction(");
}

static ResultTransportMode classify_result_transport(std::string_view type) {
  if (has_aggregate_function_type(type)) return ResultTransportMode::Opaque;
  if (has_256_bit_int_type(type) || has_json_like_type(type) || has_decimal_type(type)) {
    return ResultTransportMode::Stringify;
  }
  return ResultTransportMode::Passthrough;
}


static bool should_retry_with_describe_after_fast_path_error(std::string_view msg) {
  return icontains(msg, "unimplemented") ||
         icontains(msg, "unsupported column type") ||
         icontains(msg, "unsupported custom serialization") ||
         icontains(msg, "cannot create column") ||
         icontains(msg, "cannot read data") ||
         icontains(msg, "cannot parse type");
}

static std::string quote_ident(std::string_view ident) {
  std::string out;
  out.reserve(ident.size() + 2);
  out.push_back('`');
  for (char ch : ident) {
    if (ch == '`') out += "``";
    else out.push_back(ch);
  }
  out.push_back('`');
  return out;
}

static std::string build_projected_expr(const std::string& col_name, const ResultColumnPlan& plan) {
  const std::string ref = std::string("_q.") + quote_ident(col_name);
  const std::string alias = quote_ident(col_name);
  const bool nullable = is_top_level_nullable_type(plan.original_type);

  if (plan.mode == ResultTransportMode::Passthrough) {
    return ref + " AS " + alias;
  }

  std::string converted;
  if (plan.mode == ResultTransportMode::Opaque) {
    converted = "toString(" + ref + ")";
  } else if (has_256_bit_int_type(plan.original_type) && !has_json_like_type(plan.original_type)) {
    converted = "toString(" + ref + ")";
  } else {
    converted = "toJSONString(" + ref + ")";
  }

  if (nullable) {
    converted = "if(isNull(" + ref + "), CAST(NULL AS Nullable(String)), " + converted + ")";
  }
  return converted + " AS " + alias;
}

static std::string build_transport_wrapper_sql(
  const std::string& original_sql,
  const std::vector<std::pair<std::string, ResultColumnPlan>>& columns,
  bool* used_wrapper_out = nullptr
) {
  bool needs_wrapper = false;
  for (const auto& kv : columns) {
    if (kv.second.mode != ResultTransportMode::Passthrough) {
      needs_wrapper = true;
      break;
    }
  }
  if (used_wrapper_out) *used_wrapper_out = needs_wrapper;
  if (!needs_wrapper || columns.empty()) {
    return original_sql;
  }

  std::string out;
  out.reserve(original_sql.size() + columns.size() * 64 + 32);
  out += "SELECT\n";
  for (size_t i = 0; i < columns.size(); ++i) {
    out += "    ";
    out += build_projected_expr(columns[i].first, columns[i].second);
    if (i + 1 < columns.size()) out.push_back(',');
    out.push_back('\n');
  }
  out += "FROM\n(\n";
  out += strip_trailing_semicolon_copy(original_sql);
  out += "\n) AS _q";
  return out;
}


void QuerySession::run_query() {
  auto reset_query_connection_best_effort = [&]() {
    try {
      if (client_query_) client_query_->ResetConnection();
    } catch (...) {
    }
  };

  auto reset_stats_for_compat_retry = [&]() {
    std::lock_guard<std::mutex> lk(mu_);
    read_rows_total_ = 0;
    read_bytes_total_ = 0;
    total_rows_to_read_ = 0;
    wrote_rows_total_ = 0;
    wrote_bytes_total_ = 0;
    user_time_us_total_ = 0;
    system_time_us_total_ = 0;
    cpu_wait_time_us_total_ = 0;
    io_wait_time_us_total_ = 0;
    cpu_time_available_ = false;
    cpu_wait_available_ = false;
    io_wait_available_ = false;
    current_mem_bytes_ = -1;
    peak_mem_bytes_ = -1;
    temporary_data_bytes_ = -1;
    memory_usage_by_host_.clear();
    peak_memory_usage_by_host_.clear();
    temporary_data_by_host_.clear();
    samples_.clear();
    last_sample_at_ = {};
    last_sample_cpu_at_ = {};
    last_sample_cpu_total_us_ = 0;
    last_sample_cpu_wait_total_us_ = 0;
    last_sample_io_wait_total_us_ = 0;
  };

  try {
    if (cancel_requested_.load(std::memory_order_relaxed)) {
      finish_canceled();
      return;
    }

    // Acquire the TCP connection only when the SSE consumer is attached. This
    // makes POST /api/query/run allocation-only, avoids holding pooled sockets
    // for abandoned runs, and keeps connection latency in the measured stream.
    std::string client_error;
    client_query_ = client_pool_ ? client_pool_->acquire(
        runner_uri_,
        std::chrono::seconds(5),
        std::chrono::milliseconds(0),
        std::chrono::milliseconds(0),
        &client_error)
      : make_client_from_uri(
        runner_uri_,
        std::chrono::seconds(5),
        std::chrono::milliseconds(0),
        std::chrono::milliseconds(0),
        &client_error);
    if (!client_query_) {
      finish_error(client_error.empty() ? "Could not connect to ClickHouse." : client_error);
      return;
    }

    try {
      if (!database_.empty()) client_query_->Execute("USE " + quote_ident(database_));
    } catch (...) {}
    const std::string first_keyword = sql_first_keyword_lower(sql_);
    const bool is_wrappable_select = first_keyword == "select" || first_keyword == "with";
    const bool is_select_like = is_wrappable_select || first_keyword == "show" ||
                                first_keyword == "describe" || first_keyword == "desc" ||
                                first_keyword == "explain";

    if (!is_select_like) {
      client_query_->Execute(sql_);
      {
        rapidjson::StringBuffer sb;
        rapidjson::Writer<rapidjson::StringBuffer> w(sb);
        w.StartObject();
        w.Key("query_id"); w.String(query_id_.c_str());
        w.Key("columns"); w.StartArray(); w.String("status"); w.EndArray();
        w.Key("types"); w.StartArray(); w.String("String"); w.EndArray();
        w.EndObject();
        push_sse_json_event("result_meta", sb.GetString());
      }
      {
        rapidjson::StringBuffer sb;
        rapidjson::Writer<rapidjson::StringBuffer> w(sb);
        w.StartObject();
        w.Key("query_id"); w.String(query_id_.c_str());
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
        wrote_rows_total_ = 1;
      }

      refresh_stats_from_query_log_best_effort();
      finish_ok();
      return;
    }

    bool meta_sent = false;
    uint64_t rows_returned = 0;
    const std::string plan_cache_key = describe_cache_key(host_id_, database_, sql_);
    bool attempt_used_cached_plan = false;

    auto apply_database_best_effort = [&]() {
      try {
        if (!database_.empty()) client_query_->Execute("USE " + quote_ident(database_));
      } catch (...) {
      }
    };

    auto execute_select_attempt = [&](bool use_describe, bool allow_cached_plan) {
      // The fast path intentionally skips DESCRIBE. Auto mode pre-plans SQL
      // that visibly produces driver-incompatible result types, and otherwise
      // retries once only if the native decoder fails before any SSE payload.
      ResultPlan result_plan;
      bool cache_new_plan_after_success = false;
      attempt_used_cached_plan = false;

      if (use_describe && is_wrappable_select) {
        if (allow_cached_plan) {
          if (auto cached = get_cached_describe_plan(plan_cache_key, options_)) {
            result_plan = std::move(*cached);
            attempt_used_cached_plan = true;
          }
        }

        if (result_plan.empty()) {
          const std::string ds = strip_trailing_semicolon_copy(sql_);
          clickhouse::Query dq("DESCRIBE (" + ds + ")");
          dq.OnData([&](const clickhouse::Block& b) {
            if (b.GetRowCount() == 0 || b.GetColumnCount() < 2) return;

            int idx_name = -1;
            int idx_type = -1;
            for (size_t i = 0; i < b.GetColumnCount(); ++i) {
              const auto& cn = b.GetColumnName(i);
              if (cn == "name") idx_name = static_cast<int>(i);
              else if (cn == "type") idx_type = static_cast<int>(i);
            }
            if (idx_name < 0) idx_name = 0;
            if (idx_type < 0) idx_type = 1;

            auto c_name = b[idx_name]->As<clickhouse::ColumnString>();
            auto c_type = b[idx_type]->As<clickhouse::ColumnString>();
            if (!c_name || !c_type) return;

            for (size_t r = 0; r < b.GetRowCount(); ++r) {
              const std::string_view n = c_name->At(r);
              const std::string normalized_type = normalize_type_string(std::string(c_type->At(r)));
              ResultColumnPlan plan;
              plan.original_type = normalized_type;
              plan.mode = classify_result_transport(normalized_type);
              plan.transport_type = (plan.mode == ResultTransportMode::Passthrough)
                ? normalized_type
                : (is_top_level_nullable_type(normalized_type)
                    ? std::string("Nullable(String)")
                    : std::string("String"));
              result_plan.emplace_back(std::string(n), std::move(plan));
            }
          });
          client_query_->Select(dq);
          cache_new_plan_after_success = !result_plan.empty();
        }
      }

      bool used_transport_wrapper = false;
      std::string effective_sql = sql_;
      if (use_describe && is_wrappable_select && !result_plan.empty()) {
        effective_sql = build_transport_wrapper_sql(sql_, result_plan, &used_transport_wrapper);
      }

      clickhouse::Query q(effective_sql, query_id_);

      // Ensure ClickHouse sends query-group ProfileEvents over native TCP.
      // CPU time, memory gauges, scheduler wait, I/O wait, and temporary disk
      // usage remain unavailable when the server does not emit these packets.
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
        if (p.total_rows > 0) {
          self->total_rows_to_read_ = std::max<uint64_t>(self->total_rows_to_read_, p.total_rows);
        }

        self->maybe_record_sample_locked(now);
      });

      // ClickHouse ProfileEvents packets have a stable schema:
      // host_name, current_time, thread_id, type, name, value. Match the
      // official clickhouse-client behavior by consuming query-group rows only
      // (thread_id = 0), accumulating increment counters, and replacing gauges.
      q.OnProfileEvents([self = shared_from_this()](const clickhouse::Block& block) -> bool {
        if (self->cancel_requested_.load(std::memory_order_relaxed)) return false;
        if (block.GetRowCount() == 0) return true;

        auto column_index = [&](std::string_view expected) -> int {
          for (size_t i = 0; i < block.GetColumnCount(); ++i) {
            if (block.GetColumnName(i) == expected) return static_cast<int>(i);
          }
          return -1;
        };

        const int host_index = column_index("host_name");
        const int thread_index = column_index("thread_id");
        const int type_index = column_index("type");
        const int name_index = column_index("name");
        const int value_index = column_index("value");
        if (host_index < 0 || thread_index < 0 || type_index < 0 ||
            name_index < 0 || value_index < 0) {
          return true;
        }

        const auto hosts = block[static_cast<size_t>(host_index)]->As<clickhouse::ColumnString>();
        const auto threads = block[static_cast<size_t>(thread_index)]->As<clickhouse::ColumnUInt64>();
        const auto types = block[static_cast<size_t>(type_index)]->As<clickhouse::ColumnEnum8>();
        const auto names = block[static_cast<size_t>(name_index)]->As<clickhouse::ColumnString>();
        const auto values_i64 = block[static_cast<size_t>(value_index)]->As<clickhouse::ColumnInt64>();
        const auto values_u64 = block[static_cast<size_t>(value_index)]->As<clickhouse::ColumnUInt64>();
        if (!hosts || !threads || !types || !names || (!values_i64 && !values_u64)) return true;

        auto saturating_add = [](int64_t current, int64_t increment) {
          if (increment <= 0) return current;
          if (current > std::numeric_limits<int64_t>::max() - increment) {
            return std::numeric_limits<int64_t>::max();
          }
          return current + increment;
        };
        auto sum_gauges = [](const std::unordered_map<std::string, int64_t>& gauges) {
          __int128 total = 0;
          for (const auto& item : gauges) total += std::max<int64_t>(0, item.second);
          if (total > std::numeric_limits<int64_t>::max()) return std::numeric_limits<int64_t>::max();
          return static_cast<int64_t>(total);
        };

        const auto now = std::chrono::steady_clock::now();
        std::lock_guard<std::mutex> lock(self->mu_);
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          // Per-thread rows are implementation details and do not represent a
          // stable live thread count. ClickHouse emits the authoritative
          // query-group aggregate with thread_id = 0.
          if (threads->At(row) != 0) continue;

          const std::string_view event_type = types->NameAt(row);
          const std::string_view event_name = names->At(row);
          int64_t value = 0;
          if (values_i64) {
            value = values_i64->At(row);
          } else {
            const uint64_t unsigned_value = values_u64->At(row);
            value = unsigned_value > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())
              ? std::numeric_limits<int64_t>::max()
              : static_cast<int64_t>(unsigned_value);
          }

          if (event_type == "increment") {
            if (event_name == "UserTimeMicroseconds") {
              self->cpu_time_available_ = true;
              self->user_time_us_total_ = saturating_add(self->user_time_us_total_, value);
            } else if (event_name == "SystemTimeMicroseconds") {
              self->cpu_time_available_ = true;
              self->system_time_us_total_ = saturating_add(self->system_time_us_total_, value);
            } else if (event_name == "OSCPUWaitMicroseconds") {
              self->cpu_wait_available_ = true;
              self->cpu_wait_time_us_total_ = saturating_add(self->cpu_wait_time_us_total_, value);
            } else if (event_name == "OSIOWaitMicroseconds") {
              self->io_wait_available_ = true;
              self->io_wait_time_us_total_ = saturating_add(self->io_wait_time_us_total_, value);
            }
            continue;
          }

          if (event_type != "gauge") continue;
          const std::string_view host_view = hosts->At(row);
          const std::string host(host_view.data(), host_view.size());
          const int64_t gauge_value = std::max<int64_t>(0, value);
          if (event_name == "MemoryTrackerUsage") {
            self->memory_usage_by_host_[host] = gauge_value;
            self->current_mem_bytes_ = sum_gauges(self->memory_usage_by_host_);
          } else if (event_name == "MemoryTrackerPeakUsage") {
            self->peak_memory_usage_by_host_[host] = gauge_value;
            self->peak_mem_bytes_ = sum_gauges(self->peak_memory_usage_by_host_);
          } else if (event_name == "TemporaryDataOnDiskUsage") {
            self->temporary_data_by_host_[host] = gauge_value;
            self->temporary_data_bytes_ = sum_gauges(self->temporary_data_by_host_);
          }
        }

        self->maybe_record_sample_locked(now);
        return true;
      });

      std::vector<const ResultColumnPlan*> resolved_column_plans;
      size_t resolved_column_count = 0;

      q.OnData([&](const clickhouse::Block& block) {
        if (cancel_requested_.load(std::memory_order_relaxed)) {
          throw std::runtime_error("canceled");
        }

        if (resolved_column_count != block.GetColumnCount()) {
          resolved_column_plans.assign(block.GetColumnCount(), nullptr);
          if (result_plan.size() == block.GetColumnCount()) {
            for (size_t i = 0; i < block.GetColumnCount(); ++i) {
              resolved_column_plans[i] = &result_plan[i].second;
            }
          } else if (!result_plan.empty()) {
            // Defensive fallback for servers that reorder DESCRIBE metadata.
            for (size_t i = 0; i < block.GetColumnCount(); ++i) {
              const auto& block_name = block.GetColumnName(i);
              for (const auto& item : result_plan) {
                if (item.first == block_name) {
                  resolved_column_plans[i] = &item.second;
                  break;
                }
              }
            }
          }
          resolved_column_count = block.GetColumnCount();
        }
        const auto& column_plans = resolved_column_plans;

        if (!meta_sent && block.GetColumnCount() > 0) {
          rapidjson::StringBuffer sb(nullptr, 1024);
          rapidjson::Writer<rapidjson::StringBuffer> w(sb);
          w.StartObject();
          w.Key("query_id"); w.String(query_id_.c_str());
          w.Key("columns");
          w.StartArray();
          for (size_t i = 0; i < block.GetColumnCount(); ++i) {
            const auto& name = block.GetColumnName(i);
            w.String(name.c_str(), static_cast<rapidjson::SizeType>(name.size()));
          }
          w.EndArray();
          w.Key("types");
          w.StartArray();
          for (size_t i = 0; i < block.GetColumnCount(); ++i) {
            if (column_plans[i]) {
              const auto& tn = column_plans[i]->transport_type;
              w.String(tn.c_str(), static_cast<rapidjson::SizeType>(tn.size()));
            } else {
              const auto& tn = block[i]->Type()->GetName();
              w.String(tn.c_str(), static_cast<rapidjson::SizeType>(tn.size()));
            }
          }
          w.EndArray();
          w.Key("original_types");
          w.StartArray();
          for (size_t i = 0; i < block.GetColumnCount(); ++i) {
            if (column_plans[i]) {
              const auto& tn = column_plans[i]->original_type;
              w.String(tn.c_str(), static_cast<rapidjson::SizeType>(tn.size()));
            } else {
              const auto& tn = block[i]->Type()->GetName();
              w.String(tn.c_str(), static_cast<rapidjson::SizeType>(tn.size()));
            }
          }
          w.EndArray();
          w.Key("transport_modes");
          w.StartArray();
          for (size_t i = 0; i < block.GetColumnCount(); ++i) {
            w.String(column_plans[i] ? transport_mode_name(column_plans[i]->mode) : "passthrough");
          }
          w.EndArray();
          w.Key("used_transport_wrapper"); w.Bool(used_transport_wrapper);
          w.Key("describe_mode"); w.String(use_describe ? "described" : "fast");
          w.Key("describe_cache_hit"); w.Bool(attempt_used_cached_plan);
          w.EndObject();
          push_sse_json_event("result_meta", std::string_view(sb.GetString(), sb.GetSize()));
          meta_sent = true;
        }

        if (block.GetRowCount() == 0) return;

        const size_t row_limit = result_preview_row_limit_ > 0
          ? static_cast<size_t>(result_preview_row_limit_)
          : std::numeric_limits<size_t>::max();
        const size_t max_rows_per_event = static_cast<size_t>(std::max(1, options_.result_rows_batch_size));
        const size_t max_bytes_per_event = std::max<size_t>(16 * 1024, options_.result_rows_batch_bytes);
        size_t row = 0;

        while (row < block.GetRowCount() && rows_returned < row_limit) {
          const size_t initial_capacity = std::min<size_t>(max_bytes_per_event, 64 * 1024);
          rapidjson::StringBuffer sb(nullptr, initial_capacity);
          rapidjson::Writer<rapidjson::StringBuffer> w(sb);
          w.StartObject();
          w.Key("query_id"); w.String(query_id_.c_str());
          w.Key("rows");
          w.StartArray();

          size_t rows_in_event = 0;
          while (row < block.GetRowCount() &&
                 rows_in_event < max_rows_per_event &&
                 rows_returned < row_limit) {
            w.StartArray();
            for (size_t c = 0; c < block.GetColumnCount(); ++c) {
              // Compatibility projections are already String columns. JSON and
              // 256-bit values stay strings for backwards compatibility. Opaque
              // aggregate states additionally get a valid-UTF8/hex safety guard.
              if (column_plans[c] && column_plans[c]->mode == ResultTransportMode::Opaque) {
                write_cell_json_declared(w, block[c], row, column_plans[c]->original_type);
              } else {
                write_cell_json(w, block[c], row);
              }
            }
            w.EndArray();
            ++row;
            ++rows_in_event;
            ++rows_returned;

            // A single large row is always allowed through; subsequent rows are
            // deferred to avoid multi-megabyte events and browser main-thread stalls.
            if (rows_in_event > 0 && sb.GetSize() >= max_bytes_per_event) break;
          }

          w.EndArray();
          w.EndObject();
          push_sse_json_event("result_rows", std::string_view(sb.GetString(), sb.GetSize()));

          {
            std::lock_guard<std::mutex> lk(mu_);
            wrote_rows_total_ += rows_in_event;
            wrote_bytes_total_ += sb.GetSize();
          }
        }

        if (row < block.GetRowCount()) {
          {
            std::lock_guard<std::mutex> lk(mu_);
            status_ = SessionStatus::ResultLimitReached;
            finished_at_ = std::chrono::steady_clock::now();
          }
          throw std::runtime_error("result_limit_reached");
        }
      });

      client_query_->Select(q);
      if (cache_new_plan_after_success) {
        put_cached_describe_plan(plan_cache_key, result_plan, options_);
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
      const bool can_retry_without_emitted_data = !meta_sent && rows_returned == 0 &&
          msg != "canceled" && msg != "result_limit_reached" &&
          !cancel_requested_.load(std::memory_order_relaxed);

      if (initial_describe && attempt_used_cached_plan && can_retry_without_emitted_data) {
        // Schema changed while a plan was cached. Retry the DESCRIBE once on a
        // fresh native connection rather than returning a stale-plan failure.
        invalidate_cached_describe_plan(plan_cache_key);
        reset_query_connection_best_effort();
        apply_database_best_effort();
        reset_stats_for_compat_retry();
        execute_select_attempt(true, false);
      } else if (allow_describe_retry && can_retry_without_emitted_data &&
                 should_retry_with_describe_after_fast_path_error(msg)) {
        // A failed native decode can leave the connection mid-packet. Reset it
        // before the compatibility retry, but do not emit anything yet.
        reset_query_connection_best_effort();
        apply_database_best_effort();
        reset_stats_for_compat_retry();
        meta_sent = false;
        rows_returned = 0;
        execute_select_attempt(true, true);
      } else {
        throw;
      }
    }

    refresh_stats_from_query_log_best_effort();
    finish_ok();

  } catch (const std::exception& e) {
    std::string msg = e.what() ? std::string(e.what()) : std::string("error");
    // Do not return possibly mid-stream/error-state clients to the idle pool as-is.
    reset_query_connection_best_effort();
    refresh_stats_from_query_log_best_effort();
    if (msg == "canceled" || cancel_requested_.load(std::memory_order_relaxed)) {
      finish_canceled();
    } else if (msg == "result_limit_reached") {
      cv_.notify_all();
    } else {
      finish_error(msg);
    }
  }
}

} // namespace chdash
