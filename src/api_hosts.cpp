#include "server.hpp"

#include "api_error.hpp"
#include "sse_util.hpp"

#include <algorithm>
#include <chrono>
#include <string>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

namespace {

static std::string build_hosts_json(const HostsSnapshot& snap) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("ts_ms"); w.Int64(snap.ts_ms);
  w.Key("interval_ms"); w.Int(snap.interval_ms);
  w.Key("timeout_ms"); w.Int(snap.timeout_ms);
  w.Key("hosts");
  w.StartArray();
  for (const auto& h : snap.hosts) {
    w.StartObject();
    w.Key("id"); w.String(h.id.c_str());
    w.Key("label"); w.String(h.label.c_str());
    w.Key("healthy"); w.Bool(h.healthy);
    w.Key("checked_at_ms"); w.Int64(h.checked_at_ms);
    w.Key("clickhouse_version");
    if (!h.clickhouse_version.empty()) w.String(h.clickhouse_version.c_str());
    else w.Null();
    w.Key("version_checked_at_ms");
    if (h.version_checked_at_ms > 0) w.Int64(h.version_checked_at_ms);
    else w.Null();
    w.Key("ping_ms");
    if (h.ping_ms >= 0) w.Int64(h.ping_ms);
    else w.Null();
    w.Key("system_tables");
    w.StartObject();
    w.Key("checked"); w.Bool(h.system_tables.checked);
    w.Key("checked_at_ms");
    if (h.system_tables.checked_at_ms > 0) w.Int64(h.system_tables.checked_at_ms);
    else w.Null();
    w.Key("query_log"); w.Bool(h.system_tables.query_log);
    w.Key("query_thread_log"); w.Bool(h.system_tables.query_thread_log);
    w.Key("trace_log"); w.Bool(h.system_tables.trace_log);
    w.Key("processors_profile_log"); w.Bool(h.system_tables.processors_profile_log);
    w.Key("jemalloc_profile_text"); w.Bool(h.system_tables.jemalloc_profile_text);
    w.Key("logs_table_available"); w.Bool(h.system_tables.logs_table_available);
    w.Key("flamegraph_tables_available"); w.Bool(h.system_tables.flamegraph_tables_available);
    w.EndObject();
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return sb.GetString();
}

}

void Server::handle_api_hosts(const httplib::Request&, httplib::Response& res) {
  if (!health_) return json_error(res, 500, "no_runner", "health runner not initialized");
  HostsSnapshot snap = health_->snapshot();
  const std::string json = build_hosts_json(snap);
  res.status = 200;
  res.set_content(json, "application/json");
}

void Server::handle_api_hosts_stream(const httplib::Request&, httplib::Response& res) {
  if (!health_) return json_error(res, 500, "no_runner", "health runner not initialized");

  res.set_header("Content-Type", "text/event-stream");
  res.set_header("Cache-Control", "no-cache");
  res.set_header("Connection", "keep-alive");
  res.set_header("X-Accel-Buffering", "no");

  struct HostsStreamState {
    uint64_t last_version = 0;
    int emit_every_ms = 5000;
    bool initial_event_pending = true;
    std::string initial_event;
    std::chrono::steady_clock::time_point last_keepalive{};
    std::chrono::steady_clock::time_point last_hosts_emit{};
  };

  const HostsSnapshot initial_snapshot = health_->snapshot();
  auto st = std::make_shared<HostsStreamState>();
  st->last_version = health_->version();
  st->emit_every_ms = std::min(15000, std::max(1000, initial_snapshot.interval_ms));
  st->initial_event = sse_json_event("hosts", build_hosts_json(initial_snapshot));
  st->last_hosts_emit = std::chrono::steady_clock::now();
  st->last_keepalive = st->last_hosts_emit;

  HealthRunner* runner = health_.get();

  res.set_chunked_content_provider(
      "text/event-stream",
      [st, runner](size_t, httplib::DataSink& sink) {
        if (st->initial_event_pending) {
          st->initial_event_pending = false;
          sink.write(st->initial_event.data(), st->initial_event.size());
          st->initial_event.clear();
          return true;
        }

        const auto now = std::chrono::steady_clock::now();
        const auto hosts_due = st->last_hosts_emit + std::chrono::milliseconds(st->emit_every_ms);
        const auto keepalive_due = st->last_keepalive + std::chrono::seconds(15);
        const auto next_due = std::min(hosts_due, keepalive_due);
        const int wait_ms = now >= next_due
          ? 0
          : static_cast<int>(std::max<int64_t>(1, std::chrono::duration_cast<std::chrono::milliseconds>(next_due - now).count()));

        uint64_t new_version = st->last_version;
        const bool changed = runner->wait_for_update(st->last_version, wait_ms, &new_version);
        if (changed) {
          st->last_version = new_version;
          st->last_hosts_emit = std::chrono::steady_clock::now();
          const auto event = sse_json_event("hosts", build_hosts_json(runner->snapshot()));
          sink.write(event.data(), event.size());
          return true;
        }

        const auto after_wait = std::chrono::steady_clock::now();
        if (after_wait >= st->last_hosts_emit + std::chrono::milliseconds(st->emit_every_ms)) {
          st->last_hosts_emit = after_wait;
          const auto event = sse_json_event("hosts", build_hosts_json(runner->snapshot()));
          sink.write(event.data(), event.size());
          return true;
        }

        st->last_keepalive = after_wait;
        const auto keepalive = sse_json_event("keepalive", "{}");
        sink.write(keepalive.data(), keepalive.size());
        return true;
      },
      [](bool) {}
  );
}

void Server::handle_api_health(const httplib::Request&, httplib::Response& res) {
  if (!health_) return json_error(res, 500, "no_runner", "health runner not initialized");
  HostsSnapshot snap = health_->snapshot();
  int healthy = 0;
  for (const auto& h : snap.hosts) if (h.healthy) ++healthy;
  const int total = static_cast<int>(snap.hosts.size());
  const bool ok = (total > 0 && healthy == total);

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("ok"); w.Bool(ok);
  w.Key("healthy_hosts"); w.Int(healthy);
  w.Key("total_hosts"); w.Int(total);
  w.Key("ts_ms"); w.Int64(snap.ts_ms);
  w.EndObject();

  res.status = ok ? 200 : 503;
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
