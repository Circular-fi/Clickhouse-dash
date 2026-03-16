#include "query_session.hpp"
#include "json_clickhouse.hpp"

#include <clickhouse/query.h>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <sstream>

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

QuerySession::QuerySession(
  std::string query_id,
  std::string sql,
  std::string database,
  std::shared_ptr<clickhouse::Client> client_for_query,
  int result_preview_row_limit
) : query_id_(std::move(query_id)),
    sql_(std::move(sql)),
    database_(std::move(database)),
    client_query_(std::move(client_for_query)),
    result_preview_row_limit_(result_preview_row_limit) {}

QuerySession::~QuerySession() {
  request_cancel();
  if (query_thread_.joinable()) query_thread_.join();
}

void QuerySession::start() {
  bool expected = false;
  if (!started_.compare_exchange_strong(expected, true)) return;

  {
    std::lock_guard<std::mutex> lk(mu_);
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
  s.current_mem_bytes = current_mem_bytes_;
  s.peak_mem_bytes = peak_mem_bytes_;
  // Best-effort "current threads" estimation: count thread IDs that produced events recently.
  // Mirrors the Go implementation: activity window = 2 seconds.
  const auto now = std::chrono::steady_clock::now();
  int64_t thr_cur = 0;
  const auto window = std::chrono::seconds(2);
  for (const auto& kv : thread_last_seen_) {
    if (now - kv.second <= window) thr_cur++;
  }
  if (thr_cur == 0 && saw_profile_events_) {
    // Some servers omit per-thread IDs (or set them to 0). Still report at least 1 thread.
    thr_cur = 1;
  }
  s.threads_inst = thr_cur;
  s.threads_peak = std::max<int64_t>(threads_peak_, thr_cur);
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

  // Drop old points if we accumulated too many (e.g. lots of result_rows events
  // and fewer tick publishes). Keep only the most recent `max_points`.
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

bool QuerySession::wait_pop_sse_chunk(std::string& out, int wait_ms) {
  std::unique_lock<std::mutex> lk(mu_);
  if (sse_chunks_.empty()) {
    cv_.wait_for(lk, std::chrono::milliseconds(wait_ms), [&] {
      return !sse_chunks_.empty() || status_ == SessionStatus::Finished || status_ == SessionStatus::Error || status_ == SessionStatus::Canceled || status_ == SessionStatus::ResultLimitReached;
    });
  }

  if (!sse_chunks_.empty()) {
    out = std::move(sse_chunks_.front());
    sse_chunks_.pop_front();
    return true;
  }

  if (status_ == SessionStatus::Finished || status_ == SessionStatus::Error || status_ == SessionStatus::Canceled || status_ == SessionStatus::ResultLimitReached) {
    return false;
  }

  return true;
}

void QuerySession::push_sse_json_event(const std::string& event_name, const std::string& json) {
  std::ostringstream oss;
  oss << "event: " << event_name << "\n";
  oss << "data: " << json << "\n\n";
  {
    std::lock_guard<std::mutex> lk(mu_);
    sse_chunks_.push_back(oss.str());
  }
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
  // Emit an "error" event compatible with app.js
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(query_id_.c_str());
  w.Key("message"); w.String(message.c_str());
  w.EndObject();
  push_sse_json_event("error", sb.GetString());

  {
    std::lock_guard<std::mutex> lk(mu_);
    status_ = SessionStatus::Error;
    finished_at_ = std::chrono::steady_clock::now();
  }
  cv_.notify_all();
}

void QuerySession::maybe_record_sample_locked(const std::chrono::steady_clock::time_point& now) {
  if (last_sample_at_.time_since_epoch().count() != 0 && now - last_sample_at_ < std::chrono::milliseconds(10)) {
    return;
  }
  last_sample_at_ = now;
  int64_t thr_cur = 0;
  const auto window = std::chrono::seconds(2);
  for (const auto& kv : thread_last_seen_) {
    if (now - kv.second <= window) thr_cur++;
  }
  if (thr_cur == 0 && saw_profile_events_) {
    thr_cur = 1;
  }

  int64_t thr_est = 0;
  if (last_sample_rt_at_.time_since_epoch().count() != 0) {
    const auto dt_us = std::chrono::duration_cast<std::chrono::microseconds>(now - last_sample_rt_at_).count();
    const int64_t d_rt = real_time_us_total_ - last_sample_rt_total_us_;
    if (dt_us > 0 && d_rt >= 0) {
      thr_est = std::max<int64_t>(thr_est, (d_rt + dt_us / 2) / dt_us);
    }
  }
  last_sample_rt_at_ = now;
  last_sample_rt_total_us_ = real_time_us_total_;
  // CPU instant (centi-percent) from delta CPU us / delta wall us.
  const int64_t cpu_total_us = user_time_us_total_ + system_time_us_total_;
  int64_t cpu_centi = -1;
  if (last_sample_cpu_at_.time_since_epoch().count() != 0) {
    const auto dt_us = std::chrono::duration_cast<std::chrono::microseconds>(now - last_sample_cpu_at_).count();
    const int64_t d_cpu = cpu_total_us - last_sample_cpu_total_us_;
    if (dt_us > 0 && d_cpu >= 0) {
      cpu_centi = static_cast<int64_t>((__int128)d_cpu * 10000 / dt_us);
      thr_est = std::max<int64_t>(thr_est, (d_cpu + dt_us / 2) / dt_us);
    } else {
      cpu_centi = 0;
    }
  }
  last_sample_cpu_at_ = now;
  last_sample_cpu_total_us_ = cpu_total_us;

  if (thr_est > 0) {
    if (thr_est > 4096) thr_est = 4096;
    thr_cur = std::max<int64_t>(thr_cur, thr_est);
  }

  threads_inst_ = thr_cur;
  threads_peak_ = std::max<int64_t>(threads_peak_, thr_cur);

  const int64_t elapsed_ms = ms_since(started_at_, now);
  samples_.push_back(SamplePoint{elapsed_ms, read_bytes_total_, cpu_centi, current_mem_bytes_, thr_cur});
  if (samples_.size() > 5000) {
    samples_.pop_front();
  }
}

static bool starts_with_ci(const std::string& s, const char* pfx) {
  const size_t n = std::strlen(pfx);
  if (s.size() < n) return false;
  for (size_t i = 0; i < n; ++i) {
    char a = s[i];
    char b = pfx[i];
    if (a >= 'A' && a <= 'Z') a = char(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = char(b - 'A' + 'a');
    if (a != b) return false;
  }
  return true;
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

static bool has_aggregate_function_type(std::string_view type) {
  return icontains(type, "AggregateFunction(");
}

static ResultTransportMode classify_result_transport(std::string_view type) {
  if (has_aggregate_function_type(type)) return ResultTransportMode::Opaque;
  if (has_256_bit_int_type(type) || has_json_like_type(type)) return ResultTransportMode::Stringify;
  return ResultTransportMode::Passthrough;
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

  std::ostringstream oss;
  oss << "SELECT\n";
  for (size_t i = 0; i < columns.size(); ++i) {
    oss << "    " << build_projected_expr(columns[i].first, columns[i].second);
    if (i + 1 < columns.size()) oss << ",";
    oss << "\n";
  }
  oss << "FROM\n(\n";
  oss << strip_trailing_semicolon_copy(original_sql) << "\n";
  oss << ") AS _q";
  return oss.str();
}


void QuerySession::run_query() {
  try {
    if (cancel_requested_.load(std::memory_order_relaxed)) {
      finish_canceled();
      return;
    }
    try {
      if (!database_.empty()) client_query_->Execute("USE " + database_);
    } catch (...) {}
    const std::string sql_trim = trim_copy(sql_);

    const bool is_wrappable_select = starts_with_ci(sql_trim, "select") || starts_with_ci(sql_trim, "with");
    const bool is_select_like =
      is_wrappable_select || starts_with_ci(sql_trim, "show") || starts_with_ci(sql_trim, "describe") || starts_with_ci(sql_trim, "explain");

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

      finish_ok();
      return;
    }

    bool meta_sent = false;
    int rows_returned = 0;

    // clickhouse-cpp currently loses named Tuple element names (it only keeps element types).
    // To let the frontend display Tuple / Array(Tuple(...)) as objects with field names, we
    // prefetch verbose column types from the server via DESCRIBE (SELECT ...).
    std::unordered_map<std::string, std::string> described_types;
    std::vector<std::string> described_column_order;
    try {
      std::string ds = strip_trailing_semicolon_copy(sql_);

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
          const std::string_view t = c_type->At(r);
          const std::string name(n);
          if (described_types.find(name) == described_types.end()) {
            described_column_order.push_back(name);
          }
          described_types[name] = normalize_type_string(std::string(t));
        }
      });

      client_query_->Select(dq);
    } catch (...) {
      // Best-effort: if DESCRIBE fails (e.g. invalid SQL), fall back to clickhouse-cpp types.
    }

    std::vector<std::pair<std::string, ResultColumnPlan>> result_plan;
    result_plan.reserve(described_column_order.size());
    for (const auto& name : described_column_order) {
      auto it = described_types.find(name);
      if (it == described_types.end()) continue;
      ResultColumnPlan plan;
      plan.original_type = it->second;
      plan.mode = classify_result_transport(it->second);
      plan.transport_type = (plan.mode == ResultTransportMode::Passthrough)
        ? it->second
        : (is_top_level_nullable_type(it->second) ? std::string("Nullable(String)") : std::string("String"));
      result_plan.push_back({name, std::move(plan)});
    }

    bool used_transport_wrapper = false;
    std::string effective_sql = sql_;
    if (is_wrappable_select && !result_plan.empty()) {
      effective_sql = build_transport_wrapper_sql(sql_, result_plan, &used_transport_wrapper);
    }

    clickhouse::Query q(effective_sql, query_id_);

    // Ensure ClickHouse actually sends ProfileEvents packets to the client (native TCP).
    // Otherwise CPU/RAM/thread stats will stay empty.
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

    // clickhouse-cpp expects ProfileEventsCallback = std::function<bool(const Block&)>.
    // Returning false aborts query processing (used here for cancellation).
    q.OnProfileEvents([self = shared_from_this()](const clickhouse::Block& b) -> bool {
      if (self->cancel_requested_.load(std::memory_order_relaxed)) {
        return false;
      }
      if (b.GetRowCount() == 0 || b.GetColumnCount() < 2) return true;

      int idx_name = -1;
      int idx_value = -1;
      int idx_thread = -1;

      for (size_t i = 0; i < b.GetColumnCount(); ++i) {
        const auto& cn = b.GetColumnName(i);
        if (iequals_ascii(cn, "name") || iequals_ascii(cn, "event") || iequals_ascii(cn, "profileevent") || iequals_ascii(cn, "profile_event")) idx_name = static_cast<int>(i);
        else if (iequals_ascii(cn, "value")) idx_value = static_cast<int>(i);
        else if (iequals_ascii(cn, "thread_id") || iequals_ascii(cn, "thread") || iequals_ascii(cn, "threadid")) idx_thread = static_cast<int>(i);
      }

      if (idx_name < 0) {
        for (size_t i = 0; i < b.GetColumnCount(); ++i) {
          const auto& cn = b.GetColumnName(i);
          if (b[i]->As<clickhouse::ColumnString>() && !icontains(cn, "host") && (icontains(cn, "event") || icontains(cn, "name"))) {
            idx_name = static_cast<int>(i);
            break;
          }
        }
      }
      if (idx_value < 0) {
        for (size_t i = 0; i < b.GetColumnCount(); ++i) {
          const auto& cn = b.GetColumnName(i);
          if ((b[i]->As<clickhouse::ColumnUInt64>() || b[i]->As<clickhouse::ColumnInt64>()) && icontains(cn, "value")) {
            idx_value = static_cast<int>(i);
            break;
          }
        }
      }
      if (idx_thread < 0) {
        for (size_t i = 0; i < b.GetColumnCount(); ++i) {
          const auto& cn = b.GetColumnName(i);
          if ((b[i]->As<clickhouse::ColumnUInt64>() || b[i]->As<clickhouse::ColumnInt64>()) && icontains(cn, "thread")) {
            idx_thread = static_cast<int>(i);
            break;
          }
        }
      }
      if (idx_name < 0) {
        for (size_t i = 0; i < b.GetColumnCount(); ++i) {
          if (b[i]->As<clickhouse::ColumnString>()) { idx_name = static_cast<int>(i); break; }
        }
      }
      if (idx_value < 0) {
        for (size_t i = 0; i < b.GetColumnCount(); ++i) {
          if (b[i]->As<clickhouse::ColumnUInt64>() || b[i]->As<clickhouse::ColumnInt64>()) { idx_value = static_cast<int>(i); break; }
        }
      }
      if (idx_name < 0 || idx_value < 0) return true;

      auto c_name = b[idx_name]->As<clickhouse::ColumnString>();
      auto c_val_u64 = b[idx_value]->As<clickhouse::ColumnUInt64>();
      auto c_val_i64 = b[idx_value]->As<clickhouse::ColumnInt64>();

      clickhouse::ColumnRef c_thr_ref;
      if (idx_thread >= 0 && static_cast<size_t>(idx_thread) < b.GetColumnCount()) c_thr_ref = b[idx_thread];
      auto c_thr_u64 = c_thr_ref ? c_thr_ref->As<clickhouse::ColumnUInt64>() : nullptr;
      auto c_thr_i64 = c_thr_ref ? c_thr_ref->As<clickhouse::ColumnInt64>() : nullptr;

      if (!c_name || (!c_val_u64 && !c_val_i64)) return true;

      const auto now = std::chrono::steady_clock::now();
      std::lock_guard<std::mutex> lk(self->mu_);

      for (size_t r = 0; r < b.GetRowCount(); ++r) {
        self->saw_profile_events_ = true;

        const std::string_view name = c_name->At(r);
        const int64_t v = c_val_u64 ? static_cast<int64_t>(c_val_u64->At(r)) : c_val_i64->At(r);

        // Thread tracking: even if server omits thread IDs, keep a synthetic thread=0 so we report >=1.
        uint64_t tid = 0;
        if (c_thr_u64) {
          tid = c_thr_u64->At(r);
        } else if (c_thr_i64) {
          const int64_t tv = c_thr_i64->At(r);
          if (tv > 0) tid = static_cast<uint64_t>(tv);
        }
        self->thread_last_seen_[tid] = now;

        // CPU time (increments). Some servers use OS* variants.
        if (name == "UserTimeMicroseconds" || name == "OSUserTimeMicroseconds") {
          self->user_time_us_total_ += v;
        } else if (name == "SystemTimeMicroseconds" || name == "OSSystemTimeMicroseconds") {
          self->system_time_us_total_ += v;
        } else if (name == "RealTimeMicroseconds") {
          self->real_time_us_total_ += v;
        }

        // Memory: mimic the Go implementation (substring match; best-effort).
        if (icontains(name, "memory") || icontains(name, "mem")) {
          const bool is_peak = icontains(name, "peak");
          const bool looks_current = icontains(name, "tracking") || icontains(name, "current") || icontains(name, "usage") || icontains(name, "used");
          if (is_peak) {
            if (self->peak_mem_bytes_ < 0) self->peak_mem_bytes_ = v;
            else self->peak_mem_bytes_ = std::max<int64_t>(self->peak_mem_bytes_, v);
          }
          if (looks_current || (!is_peak && self->current_mem_bytes_ < 0)) {
            self->current_mem_bytes_ = v;
            if (self->peak_mem_bytes_ < 0) self->peak_mem_bytes_ = v;
            else self->peak_mem_bytes_ = std::max<int64_t>(self->peak_mem_bytes_, v);
          }
        }
      }

      // Record a sample point (throttled).
      self->maybe_record_sample_locked(now);

      return true;
    });

    q.OnData([&](const clickhouse::Block& block) {
      if (cancel_requested_.load(std::memory_order_relaxed)) {
        throw std::runtime_error("canceled");
      }

      if (!meta_sent && block.GetColumnCount() > 0) {
        rapidjson::StringBuffer sb;
        rapidjson::Writer<rapidjson::StringBuffer> w(sb);
        w.StartObject();
        w.Key("query_id"); w.String(query_id_.c_str());
        w.Key("columns");
        w.StartArray();
        for (size_t i = 0; i < block.GetColumnCount(); ++i) {
          const auto& name = block.GetColumnName(i);
          w.String(name.c_str(), (rapidjson::SizeType)name.size());
        }
        w.EndArray();
        w.Key("types");
        w.StartArray();
        for (size_t i = 0; i < block.GetColumnCount(); ++i) {
          const auto& name = block.GetColumnName(i);
          auto it = described_types.find(name);
          if (it != described_types.end()) {
            const ResultTransportMode mode = classify_result_transport(it->second);
            const std::string transport_type = (mode == ResultTransportMode::Passthrough)
              ? it->second
              : (is_top_level_nullable_type(it->second) ? std::string("Nullable(String)") : std::string("String"));
            w.String(transport_type.c_str(), (rapidjson::SizeType)transport_type.size());
          } else {
            const auto& tn = block[i]->Type()->GetName();
            w.String(tn.c_str(), (rapidjson::SizeType)tn.size());
          }
        }
        w.EndArray();
        w.Key("original_types");
        w.StartArray();
        for (size_t i = 0; i < block.GetColumnCount(); ++i) {
          const auto& name = block.GetColumnName(i);
          auto it = described_types.find(name);
          if (it != described_types.end()) {
            const auto& tn = it->second;
            w.String(tn.c_str(), (rapidjson::SizeType)tn.size());
          } else {
            const auto& tn = block[i]->Type()->GetName();
            w.String(tn.c_str(), (rapidjson::SizeType)tn.size());
          }
        }
        w.EndArray();
        w.Key("transport_modes");
        w.StartArray();
        for (size_t i = 0; i < block.GetColumnCount(); ++i) {
          const auto& name = block.GetColumnName(i);
          auto it = described_types.find(name);
          const char* mode_name = "passthrough";
          if (it != described_types.end()) {
            mode_name = transport_mode_name(classify_result_transport(it->second));
          }
          w.String(mode_name);
        }
        w.EndArray();
        w.Key("used_transport_wrapper"); w.Bool(used_transport_wrapper);
        w.EndObject();
        push_sse_json_event("result_meta", sb.GetString());
        meta_sent = true;
      }

      if (block.GetRowCount() == 0) return;

      const size_t n = block.GetRowCount();
      const size_t batch = 200;

      for (size_t begin = 0; begin < n; begin += batch) {
        const size_t end = std::min(n, begin + batch);

        rapidjson::StringBuffer sb;
        rapidjson::Writer<rapidjson::StringBuffer> w(sb);
        w.StartObject();
        w.Key("query_id"); w.String(query_id_.c_str());
        w.Key("rows");
        w.StartArray();
        for (size_t r = begin; r < end; ++r) {
          w.StartArray();
          for (size_t c = 0; c < block.GetColumnCount(); ++c) {
            write_cell_json(w, block[c], r);
          }
          w.EndArray();
        }
        w.EndArray();
        w.EndObject();

        push_sse_json_event("result_rows", sb.GetString());

        {
          std::lock_guard<std::mutex> lk(mu_);
          wrote_rows_total_ += (end - begin);
          wrote_bytes_total_ += sb.GetSize();
        }

        rows_returned += static_cast<int>(end - begin);
        if (result_preview_row_limit_ > 0 && rows_returned >= result_preview_row_limit_) {
          {
            std::lock_guard<std::mutex> lk(mu_);
            status_ = SessionStatus::ResultLimitReached;
            finished_at_ = std::chrono::steady_clock::now();
          }
          throw std::runtime_error("result_limit_reached");
        }
      }
    });

    client_query_->Select(q);

    finish_ok();

  } catch (const std::exception& e) {
    std::string msg = e.what() ? std::string(e.what()) : std::string("error");
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
