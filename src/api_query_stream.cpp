#include "server.hpp"

#include "api_error.hpp"
#include "sse_util.hpp"

#include <algorithm>
#include <chrono>
#include <memory>
#include <string>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

namespace {

constexpr auto kTickInterval = std::chrono::milliseconds(250);

static std::string build_meta_json(const std::string& query_id) {
  rapidjson::StringBuffer buffer(nullptr, 384);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("query_id"); writer.String(query_id.c_str());
  writer.Key("status"); writer.String("connected");
  writer.Key("telemetry");
  writer.StartObject();
  writer.Key("schema_version"); writer.Int(2);
  writer.Key("source"); writer.String("clickhouse_native_tcp");
  writer.Key("metrics");
  writer.StartArray();
  writer.String("progress");
  writer.String("read_rate");
  writer.String("cpu_time");
  writer.String("memory_tracker");
  writer.String("cpu_scheduler_wait");
  writer.String("io_wait");
  writer.String("temporary_data_on_disk");
  writer.EndArray();
  writer.EndObject();
  writer.EndObject();
  return std::string(buffer.GetString(), buffer.GetSize());
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
  int64_t prev_cpu_wait_total_us = 0;
  int64_t prev_io_wait_total_us = 0;
};

static bool is_terminal(SessionStatus status) {
  return status == SessionStatus::Finished ||
         status == SessionStatus::Error ||
         status == SessionStatus::Canceled ||
         status == SessionStatus::ResultLimitReached;
}

static void write_nullable_int64(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    int64_t value
) {
  if (value < 0) writer.Null();
  else writer.Int64(value);
}

static std::string build_tick_json(const SessionSnapshot& snapshot, StreamState& state) {
  int64_t progress_percent_centi = 0;
  const bool progress_known = snapshot.total_rows_to_read > 0;
  if (progress_known) {
    const __int128 numerator = static_cast<__int128>(snapshot.read_rows_total) * 10000;
    progress_percent_centi = static_cast<int64_t>(
        numerator / static_cast<__int128>(snapshot.total_rows_to_read));
    progress_percent_centi = std::clamp<int64_t>(progress_percent_centi, 0, 10000);
  }

  const auto now = std::chrono::steady_clock::now();
  const auto previous_publish = state.last_publish;
  const bool has_previous_publish = previous_publish.time_since_epoch().count() != 0;

  int64_t rows_per_second = 0;
  int64_t bytes_per_second = 0;
  int64_t cpu_centi = -1;
  int64_t cpu_wait_centi = -1;
  int64_t io_wait_centi = -1;

  const int64_t cpu_total_us = snapshot.user_time_us_total + snapshot.system_time_us_total;
  if (has_previous_publish) {
    const auto elapsed_us = std::chrono::duration_cast<std::chrono::microseconds>(
        now - previous_publish).count();
    if (elapsed_us > 0) {
      const uint64_t delta_rows = snapshot.read_rows_total >= state.prev_read_rows
        ? snapshot.read_rows_total - state.prev_read_rows
        : 0;
      const uint64_t delta_bytes = snapshot.read_bytes_total >= state.prev_read_bytes
        ? snapshot.read_bytes_total - state.prev_read_bytes
        : 0;
      rows_per_second = static_cast<int64_t>(
          static_cast<__int128>(delta_rows) * 1000000 / elapsed_us);
      bytes_per_second = static_cast<int64_t>(
          static_cast<__int128>(delta_bytes) * 1000000 / elapsed_us);

      const int64_t delta_cpu = cpu_total_us - state.prev_cpu_total_us;
      const int64_t delta_cpu_wait = snapshot.cpu_wait_time_us_total - state.prev_cpu_wait_total_us;
      const int64_t delta_io_wait = snapshot.io_wait_time_us_total - state.prev_io_wait_total_us;
      if (snapshot.cpu_time_available && delta_cpu >= 0) {
        cpu_centi = static_cast<int64_t>(
            static_cast<__int128>(delta_cpu) * 10000 / elapsed_us);
      }
      if (snapshot.cpu_wait_available && delta_cpu_wait >= 0) {
        cpu_wait_centi = static_cast<int64_t>(
            static_cast<__int128>(delta_cpu_wait) * 10000 / elapsed_us);
      }
      if (snapshot.io_wait_available && delta_io_wait >= 0) {
        io_wait_centi = static_cast<int64_t>(
            static_cast<__int128>(delta_io_wait) * 10000 / elapsed_us);
      }
    }
  }

  state.prev_read_rows = snapshot.read_rows_total;
  state.prev_read_bytes = snapshot.read_bytes_total;
  state.prev_cpu_total_us = cpu_total_us;
  state.prev_cpu_wait_total_us = snapshot.cpu_wait_time_us_total;
  state.prev_io_wait_total_us = snapshot.io_wait_time_us_total;
  state.last_publish = now;

  rapidjson::StringBuffer buffer(nullptr, 1024);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("schema_version"); writer.Int(2);
  writer.Key("elapsed_ms"); writer.Int64(snapshot.elapsed_ms);

  writer.Key("progress");
  writer.StartObject();
  writer.Key("known"); writer.Bool(progress_known);
  writer.Key("percent_centi");
  if (progress_known) writer.Int64(progress_percent_centi); else writer.Null();
  writer.Key("read_rows"); writer.Uint64(snapshot.read_rows_total);
  writer.Key("read_bytes"); writer.Uint64(snapshot.read_bytes_total);
  writer.Key("total_rows_to_read"); writer.Uint64(snapshot.total_rows_to_read);
  writer.EndObject();

  writer.Key("rates");
  writer.StartObject();
  writer.Key("read_rows_per_second"); writer.Int64(rows_per_second);
  writer.Key("read_bytes_per_second"); writer.Int64(bytes_per_second);
  writer.EndObject();

  writer.Key("profile");
  writer.StartObject();
  writer.Key("cpu_percent_centi"); write_nullable_int64(writer, cpu_centi);
  writer.Key("memory_bytes"); write_nullable_int64(writer, snapshot.current_mem_bytes);
  writer.Key("peak_memory_bytes"); write_nullable_int64(writer, snapshot.peak_mem_bytes);
  writer.Key("cpu_wait_percent_centi"); write_nullable_int64(writer, cpu_wait_centi);
  writer.Key("io_wait_percent_centi"); write_nullable_int64(writer, io_wait_centi);
  writer.Key("temporary_data_bytes"); write_nullable_int64(writer, snapshot.temporary_data_bytes);
  writer.Key("cpu_time_us");
  if (snapshot.cpu_time_available) writer.Int64(cpu_total_us); else writer.Null();
  writer.Key("cpu_wait_time_us");
  if (snapshot.cpu_wait_available) writer.Int64(snapshot.cpu_wait_time_us_total); else writer.Null();
  writer.Key("io_wait_time_us");
  if (snapshot.io_wait_available) writer.Int64(snapshot.io_wait_time_us_total); else writer.Null();
  writer.EndObject();

  writer.Key("samples");
  const auto samples = state.session->drain_samples();
  if (samples.empty()) {
    writer.Null();
  } else {
    writer.StartArray();
    for (const auto& sample : samples) {
      // Compact sample schema:
      // [elapsed_ms, read_rows, read_bytes, cpu_centi, memory_bytes,
      //  cpu_wait_centi, io_wait_centi]
      writer.StartArray();
      writer.Int64(sample.elapsed_ms);
      writer.Uint64(sample.read_rows_total);
      writer.Uint64(sample.read_bytes_total);
      write_nullable_int64(writer, sample.cpu_centi);
      write_nullable_int64(writer, sample.mem_bytes);
      write_nullable_int64(writer, sample.cpu_wait_centi);
      write_nullable_int64(writer, sample.io_wait_centi);
      writer.EndArray();
    }
    writer.EndArray();
  }

  writer.EndObject();
  return std::string(buffer.GetString(), buffer.GetSize());
}

static std::string build_done_json(const SessionSnapshot& snap, bool truncated) {
  rapidjson::StringBuffer sb(nullptr, 512);
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
  w.Key("telemetry");
  w.StartObject();
  w.Key("schema_version"); w.Int(2);
  w.Key("cpu_time_us");
  if (snap.cpu_time_available) w.Int64(snap.user_time_us_total + snap.system_time_us_total); else w.Null();
  w.Key("cpu_wait_time_us");
  if (snap.cpu_wait_available) w.Int64(snap.cpu_wait_time_us_total); else w.Null();
  w.Key("io_wait_time_us");
  if (snap.io_wait_available) w.Int64(snap.io_wait_time_us_total); else w.Null();
  w.Key("memory_bytes"); write_nullable_int64(w, snap.current_mem_bytes);
  w.Key("peak_memory_bytes"); write_nullable_int64(w, snap.peak_mem_bytes);
  w.Key("temporary_data_bytes"); write_nullable_int64(w, snap.temporary_data_bytes);
  w.EndObject();
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

  // set_chunked_content_provider owns Content-Type. Setting it separately
  // creates two header values in cpp-httplib; clients such as requests then
  // parse the combined value as an invalid charset ("utf-8, text/event-stream").
  res.set_header("Cache-Control", "no-cache, no-transform");
  res.set_header("Connection", "keep-alive");
  res.set_header("X-Accel-Buffering", "no");

  auto state = std::make_shared<StreamState>();
  state->session = session;
  state->query_id = qid;
  Server* self = this;

  res.set_chunked_content_provider(
      "text/event-stream; charset=utf-8",
      [state, self](size_t, httplib::DataSink& sink) {
        if (!state->connected_event_sent) {
          state->connected_event_sent = true;
          const std::string connected = sse_json_event("meta", build_meta_json(state->query_id));
          if (!sink.write(connected.data(), connected.size())) {
            state->session->request_cancel();
            return false;
          }

          // Establish a counter baseline without emitting an empty zero-value
          // tick. Short queries now send one meaningful terminal tick, while
          // longer queries still publish at the regular cadence.
          const auto baseline = state->session->snapshot();
          state->prev_read_rows = baseline.read_rows_total;
          state->prev_read_bytes = baseline.read_bytes_total;
          state->prev_cpu_total_us = baseline.user_time_us_total + baseline.system_time_us_total;
          state->prev_cpu_wait_total_us = baseline.cpu_wait_time_us_total;
          state->prev_io_wait_total_us = baseline.io_wait_time_us_total;
          state->last_publish = std::chrono::steady_clock::now();
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
