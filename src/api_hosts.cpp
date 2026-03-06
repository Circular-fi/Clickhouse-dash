#include "server.hpp"

#include "api_error.hpp"
#include "sse_util.hpp"

#include <chrono>
#include <deque>
#include <thread>
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
    w.Key("ping_ms");
    if (h.ping_ms >= 0) w.Int64(h.ping_ms);
    else w.Null();
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
    std::chrono::steady_clock::time_point last_keepalive{};
    std::deque<std::string> local_chunks;
  };

  auto st = std::make_shared<HostsStreamState>();
  st->last_version = health_->version();
  st->local_chunks.push_back(sse_json_event("hosts", build_hosts_json(health_->snapshot())));

  HealthRunner* runner = health_.get();

  res.set_chunked_content_provider(
      "text/event-stream",
      [st, runner](size_t, httplib::DataSink& sink) {
        if (!st->local_chunks.empty()) {
          auto chunk = std::move(st->local_chunks.front());
          st->local_chunks.pop_front();
          sink.write(chunk.data(), chunk.size());
          return true;
        }

        uint64_t new_ver = st->last_version;
        const bool changed = runner->wait_for_update(st->last_version, 15000, &new_ver);
        if (changed) {
          st->last_version = new_ver;
          const auto ev = sse_json_event("hosts", build_hosts_json(runner->snapshot()));
          sink.write(ev.data(), ev.size());
          return true;
        }

        const auto now = std::chrono::steady_clock::now();
        if (st->last_keepalive.time_since_epoch().count() == 0 || now - st->last_keepalive >= std::chrono::seconds(15)) {
          st->last_keepalive = now;
          const auto ka = sse_json_event("keepalive", "{}");
          sink.write(ka.data(), ka.size());
          return true;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
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
