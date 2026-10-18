#include "server.hpp"

#include "api_error.hpp"
#include "sse_util.hpp"
#include "json_text.hpp"

#include <algorithm>
#include <chrono>
#include <optional>
#include <set>
#include <string>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

namespace {

// The snapshot without the hosts that the human cannot see (docs/access.md, "Hosts"). nullopt keeps every host.
HostsSnapshot visible_snapshot(HostsSnapshot snap, const std::optional<std::set<std::string>>& visible) {
  if (!visible) return snap;
  snap.hosts.erase(std::remove_if(snap.hosts.begin(), snap.hosts.end(), [&](const auto& host) { return visible->count(host.id) == 0; }),
                   snap.hosts.end());
  return snap;
}

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
    w.Key("id"); write_json_text(w, h.id);
    w.Key("label"); write_json_text(w, h.label);
    w.Key("healthy"); w.Bool(h.healthy);
    w.Key("error");
    if (!h.error.empty()) write_json_text(w, h.error);
    else w.Null();
    w.Key("checked_at_ms"); w.Int64(h.checked_at_ms);
    w.Key("clickhouse_version");
    if (!h.clickhouse_version.empty()) write_json_text(w, h.clickhouse_version);
    else w.Null();
    w.Key("clickhouse_timezone");
    if (!h.clickhouse_timezone.empty()) write_json_text(w, h.clickhouse_timezone);
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
    w.Key("query_views_log"); w.Bool(h.system_tables.query_views_log);
    w.Key("processors_profile_log"); w.Bool(h.system_tables.processors_profile_log);
    w.Key("opentelemetry_span_log"); w.Bool(h.system_tables.opentelemetry_span_log);
    w.EndObject();
    // This shows what each identity may do (CHECK GRANT). A host is healthy when it answers.
    // This value says whether its users can do the work. "warnings" is empty when nothing is missing.
    w.Key("access");
    w.StartObject();
    w.Key("checked"); w.Bool(h.access.checked);
    w.Key("ok"); w.Bool(h.access.checked && h.access.warnings.empty());
    w.Key("runner_user"); write_json_text(w, h.access.runner_user);
    w.Key("system_user"); write_json_text(w, h.access.system_user);
    w.Key("runner_reads_nothing"); w.Bool(h.access.runner_reads_nothing);
    w.Key("runner_shows_secrets"); w.Bool(h.access.runner_shows_secrets);
    const auto write_list = [&](const char* key, const std::vector<std::string>& items) {
      w.Key(key);
      w.StartArray();
      for (const auto& item : items) write_json_text(w, item);
      w.EndArray();
    };
    w.Key("mcp_user"); write_json_text(w, h.access.mcp_user);
    w.Key("mcp_reads_nothing"); w.Bool(h.access.mcp_reads_nothing);
    w.Key("mcp_shows_secrets"); w.Bool(h.access.mcp_shows_secrets);
    w.Key("mcp_audited"); w.Bool(h.access.mcp_audited);
    w.Key("mcp_connected"); w.Bool(h.access.mcp_connected);
    w.Key("mcp_error"); write_json_text(w, h.access.mcp_error);
    write_list("mcp_missing", h.access.mcp_missing);
    write_list("runner_missing", h.access.runner_missing);
    write_list("system_missing", h.access.system_missing);
    write_list("warnings", h.access.warnings);
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
  // In the authzen mode, the list holds only the hosts on which the human holds one action at least (one batch of the PDP, cached).
  const HostsSnapshot snap = visible_snapshot(health_->snapshot(), access_visible_hosts());
  const std::string json = build_hosts_json(snap);
  res.status = 200;
  res.set_content(json, "application/json");
}

void Server::handle_api_hosts_stream(const httplib::Request&, httplib::Response& res) {
  if (!health_) return json_error(res, 500, "no_runner", "health runner not initialized");

  // The chunked response callback sets Content-Type once. Do not send duplicate header
  // values. The HTTP layer allows them, but strict SSE clients fail on them.
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

  // Each open stream holds a worker thread. Past max_host_streams, the page gets 503 and polls
  // GET /api/hosts instead (app_ui.js startHostsSse). This keeps the threads for the queries.
  if (active_host_streams_.fetch_add(1) >= cfg_.server.max_host_streams) {
    active_host_streams_.fetch_sub(1);
    return json_error(res, 503, "too_many_streams", "too many host status streams are open: poll /api/hosts");
  }
  // The hosts that the human can see when the stream starts. The stream keeps them: the identity of a stream is checked once, at its start.
  const std::optional<std::set<std::string>> visible = access_visible_hosts();
  const HostsSnapshot initial_snapshot = visible_snapshot(health_->snapshot(), visible);
  auto st = std::make_shared<HostsStreamState>();
  st->last_version = health_->version();
  st->emit_every_ms = std::min(15000, std::max(1000, initial_snapshot.interval_ms));
  st->initial_event = sse_json_event("hosts", build_hosts_json(initial_snapshot));
  st->last_hosts_emit = std::chrono::steady_clock::now();
  st->last_keepalive = st->last_hosts_emit;

  HealthRunner* runner = health_.get();

  res.set_chunked_content_provider(
      "text/event-stream; charset=utf-8",
      [st, runner, visible, this](size_t, httplib::DataSink& sink) {
        // The server stops (Server::stop). The stream ends. The page reconnects to another replica or polls.
        if (stopping()) {
          sink.done();
          return true;
        }
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
          const auto event = sse_json_event("hosts", build_hosts_json(visible_snapshot(runner->snapshot(), visible)));
          sink.write(event.data(), event.size());
          return true;
        }

        const auto after_wait = std::chrono::steady_clock::now();
        if (after_wait >= st->last_hosts_emit + std::chrono::milliseconds(st->emit_every_ms)) {
          st->last_hosts_emit = after_wait;
          const auto event = sse_json_event("hosts", build_hosts_json(visible_snapshot(runner->snapshot(), visible)));
          sink.write(event.data(), event.size());
          return true;
        }

        st->last_keepalive = after_wait;
        const auto keepalive = sse_json_event("keepalive", "{}");
        sink.write(keepalive.data(), keepalive.size());
        return true;
      },
      [this](bool) { active_host_streams_.fetch_sub(1); }
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
