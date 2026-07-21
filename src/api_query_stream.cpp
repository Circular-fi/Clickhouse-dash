#include "server.hpp"

#include "api_error.hpp"
#include "sse_util.hpp"

#include <algorithm>
#include <chrono>
#include <deque>
#include <memory>
#include <string>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

namespace {

constexpr auto kTickInterval = std::chrono::milliseconds(250);

static std::string build_meta_json(const std::string& qid) {
  rapidjson::StringBuffer sb(nullptr, 128);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(qid.c_str());
  w.Key("status"); w.String("connected");
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

struct StreamState {
  std::shared_ptr<QuerySession> session;
  std::string query_id;
  bool connected_event_sent = false;
  bool terminal_event_sent = false;

  std::chrono::steady_clock::time_point last_publish{};

  uint64_t prev_read_rows = 0;
  uint64_t prev_read_bytes = 0;

  int64_t prev_cpu_total_us = 0;
  int64_t cpu_inst_max_centi = 0;
  int64_t thread_peak = 0;
};

static bool is_terminal(SessionStatus status) {
  return status == SessionStatus::Finished ||
         status == SessionStatus::Error ||
         status == SessionStatus::Canceled ||
         status == SessionStatus::ResultLimitReached;
}

static std::string build_tick_json(const SessionSnapshot& snap, StreamState& st) {
  int64_t percent_centi = 0;
  int64_t known_int = 0;
  if (snap.total_rows_to_read > 0) {
    known_int = 1;
    const __int128 num = static_cast<__int128>(snap.read_rows_total) * 10000;
    percent_centi = static_cast<int64_t>(num / static_cast<__int128>(snap.total_rows_to_read));
    percent_centi = std::max<int64_t>(0, std::min<int64_t>(10000, percent_centi));
  }

  const auto now = std::chrono::steady_clock::now();
  const auto prev_publish = st.last_publish;

  int64_t rows_per_sec = 0;
  int64_t bytes_per_sec = 0;
  if (prev_publish.time_since_epoch().count() != 0) {
    const double dt = std::chrono::duration_cast<std::chrono::duration<double>>(now - prev_publish).count();
    if (dt > 1e-9) {
      const uint64_t delta_rows = snap.read_rows_total >= st.prev_read_rows
        ? snap.read_rows_total - st.prev_read_rows
        : 0;
      const uint64_t delta_bytes = snap.read_bytes_total >= st.prev_read_bytes
        ? snap.read_bytes_total - st.prev_read_bytes
        : 0;
      rows_per_sec = static_cast<int64_t>(static_cast<double>(delta_rows) / dt);
      bytes_per_sec = static_cast<int64_t>(static_cast<double>(delta_bytes) / dt);
    }
  }
  st.prev_read_rows = snap.read_rows_total;
  st.prev_read_bytes = snap.read_bytes_total;

  int64_t cpu_centi = 0;
  const int64_t cpu_total_us = snap.user_time_us_total + snap.system_time_us_total;
  if (prev_publish.time_since_epoch().count() != 0) {
    const auto dt_us = std::chrono::duration_cast<std::chrono::microseconds>(now - prev_publish).count();
    const int64_t delta_cpu = cpu_total_us - st.prev_cpu_total_us;
    if (dt_us > 0 && delta_cpu >= 0) {
      cpu_centi = static_cast<int64_t>(static_cast<__int128>(delta_cpu) * 10000 / dt_us);
    }
  }
  st.prev_cpu_total_us = cpu_total_us;
  st.cpu_inst_max_centi = std::max(st.cpu_inst_max_centi, cpu_centi);
  st.last_publish = now;

  st.thread_peak = std::max(st.thread_peak, snap.threads_peak);

  rapidjson::StringBuffer sb(nullptr, 512);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartArray();
  w.Int64(snap.elapsed_ms);
  w.Int64(percent_centi);
  w.Int64(known_int);
  w.Uint64(snap.read_rows_total);
  w.Uint64(snap.read_bytes_total);
  w.Uint64(snap.total_rows_to_read);
  w.Int64(rows_per_sec);
  w.Int64(bytes_per_sec);
  w.Int64(cpu_centi);
  w.Int64(st.cpu_inst_max_centi);
  if (snap.current_mem_bytes < 0) w.Null(); else w.Int64(snap.current_mem_bytes);
  if (snap.peak_mem_bytes < 0) w.Null(); else w.Int64(snap.peak_mem_bytes);
  w.Int64(snap.threads_inst);
  w.Int64(st.thread_peak);

  auto samples = st.session->drain_samples();
  if (samples.empty()) {
    w.Null();
  } else {
    w.StartArray();
    for (const auto& sample : samples) {
      w.StartArray();
      w.Int64(sample.elapsed_ms);
      w.Uint64(sample.read_rows_total);
      w.Uint64(sample.read_bytes_total);
      if (sample.cpu_centi < 0) w.Null(); else w.Int64(sample.cpu_centi);
      if (sample.mem_bytes < 0) w.Null(); else w.Int64(sample.mem_bytes);
      w.Int64(sample.threads);
      w.EndArray();
    }
    w.EndArray();
  }
  w.EndArray();
  return std::string(sb.GetString(), sb.GetSize());
}

static std::string build_done_json(const SessionSnapshot& snap, bool truncated) {
  rapidjson::StringBuffer sb(nullptr, 256);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(snap.query_id.c_str());
  w.Key("status");
  switch (snap.status) {
    case SessionStatus::Finished: w.String("finished"); break;
    case SessionStatus::Canceled: w.String("canceled"); break;
    case SessionStatus::Error: w.String("error"); break;
    case SessionStatus::ResultLimitReached: w.String("result_limit_reached"); break;
    default: w.String("finished"); break;
  }
  w.Key("elapsed_seconds"); w.Double(static_cast<double>(snap.elapsed_ms) / 1000.0);
  w.Key("read_rows"); w.Uint64(snap.read_rows_total);
  w.Key("read_bytes"); w.Uint64(snap.read_bytes_total);
  w.Key("result_rows_returned"); w.Uint64(snap.wrote_rows_total);
  w.Key("result_truncated"); w.Bool(truncated);
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

static int wait_until_next_tick_ms(const StreamState& st) {
  if (st.last_publish.time_since_epoch().count() == 0) return 0;
  const auto now = std::chrono::steady_clock::now();
  const auto due = st.last_publish + kTickInterval;
  if (now >= due) return 0;
  const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(due - now).count();
  return static_cast<int>(std::max<int64_t>(1, remaining));
}

} // namespace

void Server::handle_query_stream(const httplib::Request& req, httplib::Response& res) {
  const std::string qid = req.get_param_value("query_id");
  if (qid.empty()) {
    return json_error(res, 400, "missing_query_id", "Missing query_id query parameter.");
  }

  std::shared_ptr<QuerySession> session;
  {
    std::lock_guard<std::mutex> lk(mu_);
    const auto it = sessions_.find(qid);
    if (it == sessions_.end()) return json_error(res, 404, "not_found", "Unknown query_id.");
    session = it->second;
  }

  if (!session->attach_stream()) {
    return json_error(res, 409, "stream_already_attached", "This query stream already has a consumer.");
  }
  session->start();

  res.set_header("Content-Type", "text/event-stream; charset=utf-8");
  res.set_header("Cache-Control", "no-cache, no-transform");
  res.set_header("Connection", "keep-alive");
  res.set_header("X-Accel-Buffering", "no");

  auto state = std::make_shared<StreamState>();
  state->session = session;
  state->query_id = qid;
  Server* self = this;

  res.set_chunked_content_provider(
      "text/event-stream",
      [state, self](size_t, httplib::DataSink& sink) {
        if (!state->connected_event_sent) {
          state->connected_event_sent = true;
          const std::string connected = sse_json_event("meta", build_meta_json(state->query_id));
          if (!sink.write(connected.data(), connected.size())) {
            state->session->request_cancel();
            return false;
          }
          return true;
        }

        std::string produced;
        const int wait_ms = wait_until_next_tick_ms(*state);
        const bool query_may_continue = state->session->wait_pop_sse_batch(produced, wait_ms);
        if (!produced.empty()) {
          // Data can flow continuously for large result sets. Piggy-back a due
          // telemetry tick on the same socket write instead of starving charts
          // until the result queue becomes empty.
          const auto now = std::chrono::steady_clock::now();
          if (state->last_publish.time_since_epoch().count() == 0 ||
              now - state->last_publish >= kTickInterval) {
            const auto live = state->session->snapshot();
            const std::string tick = sse_json_event("tick", build_tick_json(live, *state));
            produced.reserve(produced.size() + tick.size());
            produced += tick;
          }
          if (!sink.write(produced.data(), produced.size())) {
            state->session->request_cancel();
            return false;
          }
          return true;
        }

        const auto snapshot = state->session->snapshot();
        if (!query_may_continue || is_terminal(snapshot.status)) {
          if (!state->terminal_event_sent) {
            state->terminal_event_sent = true;
            std::string terminal;
            const std::string tick = sse_json_event("tick", build_tick_json(snapshot, *state));
            const std::string done = sse_json_event(
                "done",
                build_done_json(snapshot, snapshot.status == SessionStatus::ResultLimitReached));
            terminal.reserve(tick.size() + done.size());
            terminal += tick;
            terminal += done;
            if (!sink.write(terminal.data(), terminal.size())) {
              state->session->request_cancel();
            }
          }
          sink.done();
          {
            std::lock_guard<std::mutex> lk(self->mu_);
            self->sessions_.erase(state->query_id);
          }
          return false;
        }

        const auto now = std::chrono::steady_clock::now();
        if (state->last_publish.time_since_epoch().count() == 0 ||
            now - state->last_publish >= kTickInterval) {
          const std::string tick = sse_json_event("tick", build_tick_json(snapshot, *state));
          if (!sink.write(tick.data(), tick.size())) {
            state->session->request_cancel();
            return false;
          }
        }
        return true;
      },
      [session, qid, self](bool success) {
        session->detach_stream();
        if (!success) session->request_cancel();
        std::lock_guard<std::mutex> lk(self->mu_);
        self->sessions_.erase(qid);
      }
  );
}

} // namespace chdash
