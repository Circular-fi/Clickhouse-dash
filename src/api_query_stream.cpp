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
  rapidjson::StringBuffer buffer(nullptr, 128);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("query_id"); writer.String(query_id.c_str());
  writer.Key("status"); writer.String("connected");
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
  int64_t cpu_inst_max_centi = -1;
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
  int64_t percent_centi = 0;
  const bool percent_known = snapshot.total_rows_to_read > 0;
  if (percent_known) {
    const __int128 numerator = static_cast<__int128>(snapshot.read_rows_total) * 10000;
    percent_centi = static_cast<int64_t>(
        numerator / static_cast<__int128>(snapshot.total_rows_to_read));
    percent_centi = std::clamp<int64_t>(percent_centi, 0, 10000);
  }

  const auto now = std::chrono::steady_clock::now();
  const bool has_previous_publish = state.last_publish.time_since_epoch().count() != 0;

  int64_t rows_per_second = 0;
  int64_t bytes_per_second = 0;
  int64_t cpu_centi = -1;
  const int64_t cpu_total_us = snapshot.user_time_us_total + snapshot.system_time_us_total;

  if (has_previous_publish) {
    const auto elapsed_us = std::chrono::duration_cast<std::chrono::microseconds>(
        now - state.last_publish).count();
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

      const int64_t delta_cpu_us = cpu_total_us - state.prev_cpu_total_us;
      if (snapshot.cpu_time_available && delta_cpu_us >= 0) {
        cpu_centi = static_cast<int64_t>(
            static_cast<__int128>(delta_cpu_us) * 10000 / elapsed_us);
        state.cpu_inst_max_centi = std::max(state.cpu_inst_max_centi, cpu_centi);
      }
    }
  }

  state.prev_read_rows = snapshot.read_rows_total;
  state.prev_read_bytes = snapshot.read_bytes_total;
  state.prev_cpu_total_us = cpu_total_us;
  state.last_publish = now;

  rapidjson::StringBuffer buffer(nullptr, 512);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartArray();
  writer.Int64(snapshot.elapsed_ms);
  writer.Int64(percent_centi);
  writer.Int(percent_known ? 1 : 0);
  writer.Uint64(snapshot.read_rows_total);
  writer.Uint64(snapshot.read_bytes_total);
  writer.Uint64(snapshot.total_rows_to_read);
  writer.Int64(rows_per_second);
  writer.Int64(bytes_per_second);
  write_nullable_int64(writer, cpu_centi);
  write_nullable_int64(writer, state.cpu_inst_max_centi);
  write_nullable_int64(writer, snapshot.current_mem_bytes);
  write_nullable_int64(writer, snapshot.peak_mem_bytes);

  // Positions 12 and 13 used to contain inferred current/peak thread counts.
  // Keep null placeholders for wire compatibility while removing the metric.
  writer.Null();
  writer.Null();

  const auto samples = state.session->drain_samples();
  if (samples.empty()) {
    writer.Null();
  } else {
    writer.StartArray();
    for (const auto& sample : samples) {
      // [elapsed_ms, read_rows, read_bytes, cpu_centi, memory_bytes]
      writer.StartArray();
      writer.Int64(sample.elapsed_ms);
      writer.Uint64(sample.read_rows_total);
      writer.Uint64(sample.read_bytes_total);
      write_nullable_int64(writer, sample.cpu_centi);
      write_nullable_int64(writer, sample.mem_bytes);
      writer.EndArray();
    }
    writer.EndArray();
  }
  writer.EndArray();
  return std::string(buffer.GetString(), buffer.GetSize());
}

static std::string build_done_json(const SessionSnapshot& snapshot, bool truncated) {
  rapidjson::StringBuffer buffer(nullptr, 256);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("query_id"); writer.String(snapshot.query_id.c_str());
  writer.Key("status");
  switch (snapshot.status) {
    case SessionStatus::Finished: writer.String("finished"); break;
    case SessionStatus::Canceled: writer.String("canceled"); break;
    case SessionStatus::Error: writer.String("error"); break;
    case SessionStatus::ResultLimitReached: writer.String("result_limit_reached"); break;
    default: writer.String("finished"); break;
  }
  writer.Key("elapsed_seconds");
  writer.Double(static_cast<double>(snapshot.elapsed_ms) / 1000.0);
  writer.Key("read_rows"); writer.Uint64(snapshot.read_rows_total);
  writer.Key("read_bytes"); writer.Uint64(snapshot.read_bytes_total);
  writer.Key("result_rows_returned"); writer.Uint64(snapshot.wrote_rows_total);
  writer.Key("result_truncated"); writer.Bool(truncated);
  writer.EndObject();
  return std::string(buffer.GetString(), buffer.GetSize());
}

static int wait_until_next_tick_ms(const StreamState& state) {
  if (state.last_publish.time_since_epoch().count() == 0) return 0;
  const auto now = std::chrono::steady_clock::now();
  const auto due = state.last_publish + kTickInterval;
  if (now >= due) return 0;
  const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
      due - now).count();
  return static_cast<int>(std::max<int64_t>(1, remaining));
}

} // namespace

void Server::handle_query_stream(const httplib::Request& req, httplib::Response& res) {
  const std::string query_id = req.get_param_value("query_id");
  if (query_id.empty()) {
    return json_error(res, 400, "missing_query_id", "Missing query_id query parameter.");
  }

  std::shared_ptr<QuerySession> session;
  {
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = sessions_.find(query_id);
    if (it == sessions_.end()) {
      return json_error(res, 404, "not_found", "Unknown query_id.");
    }
    session = it->second;
  }

  if (!session->attach_stream()) {
    return json_error(
        res,
        409,
        "stream_already_attached",
        "This query stream already has a consumer.");
  }
  session->start();

  // set_chunked_content_provider owns Content-Type. Setting it separately
  // creates duplicate values in cpp-httplib.
  res.set_header("Cache-Control", "no-cache, no-transform");
  res.set_header("Connection", "keep-alive");
  res.set_header("X-Accel-Buffering", "no");

  auto state = std::make_shared<StreamState>();
  state->session = session;
  state->query_id = query_id;
  Server* self = this;

  res.set_chunked_content_provider(
      "text/event-stream; charset=utf-8",
      [state, self](size_t, httplib::DataSink& sink) {
        if (!state->connected_event_sent) {
          state->connected_event_sent = true;
          const std::string connected = sse_json_event(
              "meta", build_meta_json(state->query_id));
          if (!sink.write(connected.data(), connected.size())) {
            state->session->request_cancel();
            return false;
          }

          // Establish a baseline without emitting an all-zero initial tick.
          const auto baseline = state->session->snapshot();
          state->prev_read_rows = baseline.read_rows_total;
          state->prev_read_bytes = baseline.read_bytes_total;
          state->prev_cpu_total_us =
              baseline.user_time_us_total + baseline.system_time_us_total;
          state->last_publish = std::chrono::steady_clock::now();
          return true;
        }

        std::string produced;
        const int wait_ms = wait_until_next_tick_ms(*state);
        const bool query_may_continue =
            state->session->wait_pop_sse_batch(produced, wait_ms);

        if (!produced.empty()) {
          const auto now = std::chrono::steady_clock::now();
          if (now - state->last_publish >= kTickInterval) {
            const auto live = state->session->snapshot();
            produced += sse_json_event("tick", build_tick_json(live, *state));
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
            const std::string tick = sse_json_event(
                "tick", build_tick_json(snapshot, *state));
            const std::string done = sse_json_event(
                "done",
                build_done_json(
                    snapshot,
                    snapshot.status == SessionStatus::ResultLimitReached));
            terminal.reserve(tick.size() + done.size());
            terminal += tick;
            terminal += done;
            if (!sink.write(terminal.data(), terminal.size())) {
              state->session->request_cancel();
            }
          }
          sink.done();
          {
            std::lock_guard<std::mutex> lock(self->mu_);
            self->sessions_.erase(state->query_id);
          }
          return false;
        }

        const auto now = std::chrono::steady_clock::now();
        if (now - state->last_publish >= kTickInterval) {
          const std::string tick = sse_json_event(
              "tick", build_tick_json(snapshot, *state));
          if (!sink.write(tick.data(), tick.size())) {
            state->session->request_cancel();
            return false;
          }
        }
        return true;
      },
      [session, query_id, self](bool success) {
        session->detach_stream();
        if (!success) session->request_cancel();
        std::lock_guard<std::mutex> lock(self->mu_);
        self->sessions_.erase(query_id);
      });
}

} // namespace chdash
