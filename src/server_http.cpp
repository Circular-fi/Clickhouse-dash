// The hooks of every request (docs/operations.md): the request id, the refusals of a stopping server and the guard of
// the writes before the routing; the access log and the metrics after it; the JSON answer of an exception and of the
// errors that cpp-httplib answers itself. And the probes and the metrics.

#include "server.hpp"

#include "api_error.hpp"
#include "http_guard.hpp"
#include "log.hpp"
#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <exception>
#include <string>
#include <unordered_map>

namespace chdash {

namespace {

// {"error", "error_code", "message"}: the two keys that the error answers of ChDash use.
void refuse(httplib::Response& res, int status, std::string_view code, std::string_view message) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("error"); write_json_text(w, code);
  w.Key("error_code"); write_json_text(w, code);
  w.Key("message"); write_json_text(w, message);
  w.EndObject();
  res.status = status;
  res.headers.erase("Cache-Control");
  res.set_header("Cache-Control", "no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

bool is_probe(const std::string& path) {
  return path == "/livez" || path == "/readyz" || path == "/healthz" || path == "/metrics";
}

bool is_write(const std::string& method) {
  return method == "POST" || method == "PUT" || method == "PATCH" || method == "DELETE";
}

// "Payload Too Large" -> "payload_too_large".
std::string status_code_name(int status) {
  std::string out;
  for (const char* c = httplib::status_message(status); *c; ++c) {
    if (std::isalnum(static_cast<unsigned char>(*c))) out.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(*c))));
    else if (!out.empty() && out.back() != '_') out.push_back('_');
  }
  while (!out.empty() && out.back() == '_') out.pop_back();
  return out.empty() ? "http_error" : out;
}

double seconds_since(const httplib::Request& req) {
  if (req.start_time_ == (std::chrono::steady_clock::time_point::min)()) return 0.0;
  return std::chrono::duration<double>(std::chrono::steady_clock::now() - req.start_time_).count();
}

std::string_view cut(std::string_view text, size_t limit) { return text.size() > limit ? text.substr(0, limit) : text; }

} // namespace

void Server::install_http_hooks() {
  http_.set_default_headers(security_headers());
  http_.set_pre_routing_handler([this](const httplib::Request& req, httplib::Response& res) { return before_routing(req, res); });
  http_.set_post_routing_handler([this](const httplib::Request& req, httplib::Response& res) { after_routing(req, res); });

  // A handler that throws: a JSON 500 and one log line. The text of the exception (it may quote SQL or a host) never
  // reaches the client.
  http_.set_exception_handler([](const httplib::Request& req, httplib::Response& res, std::exception_ptr error) {
    std::string what = "unknown exception";
    try {
      std::rethrow_exception(error);
    } catch (const std::exception& e) {
      what = e.what();
    } catch (...) {
    }
    log_event(LogLevel::Error, "http.unhandled_exception",
              {{"request_id", res.get_header_value("X-Request-Id")}, {"method", req.method}, {"path", cut(req.path, 512)},
               {"error", cut(what, 300)}});
    const std::string request_id = res.get_header_value("X-Request-Id");
    res.headers = security_headers();
    if (!request_id.empty()) res.set_header("X-Request-Id", request_id);
    res.body.clear();
    res.content_length_ = 0;
    res.content_provider_ = nullptr;
    refuse(res, 500, "internal_error", "Internal server error.");
  });

  // The errors that cpp-httplib answers without a body (no route, a body too large, a bad request line): the same
  // JSON shape as every other error.
  http_.set_error_handler([](const httplib::Request&, httplib::Response& res) {
    if (!res.body.empty() || res.content_provider_) return httplib::Server::HandlerResponse::Unhandled;
    refuse(res, res.status, status_code_name(res.status), httplib::status_message(res.status));
    return httplib::Server::HandlerResponse::Handled;
  });
}

httplib::Server::HandlerResponse Server::before_routing(const httplib::Request& req, httplib::Response& res) {
  res.set_header("X-Request-Id", request_id_for(req));
  http_metrics_->request_started();
  // The probes and the metrics answer while the server stops: an orchestrator reads them.
  if (stopping() && !is_probe(req.path)) {
    res.set_header("Connection", "close");
    refuse(res, 503, "server_stopping", "the server is stopping");
    return httplib::Server::HandlerResponse::Handled;
  }
  // Every write but the MCP endpoint (its Origin list and its Content-Type check are its own, api_mcp.cpp). The body
  // is not read yet: close the connection rather than read it.
  if (is_write(req.method) && req.path != "/mcp") {
    if (const auto refusal = check_browser_write(req)) {
      res.set_header("Connection", "close");
      refuse(res, refusal->status, refusal->code, refusal->message);
      return httplib::Server::HandlerResponse::Handled;
    }
  }
  return httplib::Server::HandlerResponse::Unhandled;
}

void Server::after_routing(const httplib::Request& req, httplib::Response& res) {
  const std::string request_id = res.get_header_value("X-Request-Id");
  const double seconds = seconds_since(req);
  // Only a request that went through before_routing counts as in flight (a bad request line never reaches it).
  http_metrics_->request_answered(req.method, req.matched_route, res.status, seconds, !request_id.empty());
  if (!cfg_.server.access_log) return;
  // A probe that succeeds is not logged: an orchestrator asks every few seconds.
  if (is_probe(req.path) && res.status < 400) return;

  const bool stream = static_cast<bool>(res.content_provider_);
  const double duration_ms = std::round(seconds * 10000.0) / 10.0;
  log_event(res.status >= 500 ? LogLevel::Warn : LogLevel::Info, "http.request",
            {{"request_id", request_id.empty() ? std::string("-") : request_id},
             {"method", req.method},
             {"path", cut(req.path, 512)},
             {"route", req.matched_route},
             {"status", res.status},
             {"duration_ms", duration_ms},
             {"bytes", stream ? static_cast<uint64_t>(0) : static_cast<uint64_t>(res.body.size())},
             {"stream", stream},
             {"remote", req.remote_addr}});
  if (!stream) return;
  // A stream (a query, an export, the host status) logs a second line when it ends: how long it lasted.
  const auto started = req.start_time_ == (std::chrono::steady_clock::time_point::min)() ? std::chrono::steady_clock::now() : req.start_time_;
  auto inner = std::move(res.content_provider_resource_releaser_);
  res.content_provider_resource_releaser_ = [inner = std::move(inner), request_id, path = std::string(cut(req.path, 512)),
                                             started](bool success) {
    if (inner) inner(success);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    log_event(LogLevel::Info, "http.stream_end",
              {{"request_id", request_id}, {"path", path}, {"duration_ms", std::round(ms * 10.0) / 10.0}});
  };
}

// The process answers: no ClickHouse host is asked. A liveness probe that fails only means a stuck process.
void Server::handle_livez(const httplib::Request&, httplib::Response& res) {
  res.set_header("Cache-Control", "no-store");
  res.status = 200;
  res.set_content("ok", "text/plain");
}

// Ready for traffic: the server does not stop, and at least one host answered its last ping.
void Server::handle_readyz(const httplib::Request&, httplib::Response& res) {
  const size_t total = cfg_.hosts.size();
  const size_t healthy = health_ ? health_->healthy_count() : 0;
  const bool ready = !stopping() && healthy > 0;
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("ready"); w.Bool(ready);
  w.Key("stopping"); w.Bool(stopping());
  w.Key("healthy_hosts"); w.Uint64(healthy);
  w.Key("total_hosts"); w.Uint64(total);
  w.EndObject();
  res.status = ready ? 200 : 503;
  res.set_header("Cache-Control", "no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

void Server::handle_metrics(const httplib::Request&, httplib::Response& res) {
  std::string out;
  out.reserve(32 * 1024);
  const double now_s = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const double started_s = std::chrono::duration<double>(started_at_.time_since_epoch()).count();

  prom_family(out, "chdash_build_info", "gauge", "The version of the server (always 1).");
  prom_sample(out, "chdash_build_info", {{"version", cfg_.version_semver}, {"git_sha", cfg_.version_git_sha}}, 1);
  prom_family(out, "chdash_process_start_time_seconds", "gauge", "Start of the process, in seconds since the Unix epoch.");
  prom_sample(out, "chdash_process_start_time_seconds", {}, std::floor(started_s));
  prom_family(out, "chdash_uptime_seconds", "gauge", "Seconds since the start of the process.");
  prom_sample(out, "chdash_uptime_seconds", {}, std::floor(now_s - started_s));
  prom_family(out, "chdash_stopping", "gauge", "1 while the server stops (SIGTERM), else 0.");
  prom_sample(out, "chdash_stopping", {}, stopping() ? 1 : 0);

  http_metrics_->write(out);

  // The query sessions by state, and the streams and exports in progress.
  std::unordered_map<std::string, size_t> sessions_by_status;
  for (const char* status : {"created", "running", "finished", "error", "canceled", "result_limit_reached"}) sessions_by_status[status] = 0;
  {
    std::vector<std::shared_ptr<QuerySession>> sessions;
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& item : sessions_) sessions.push_back(item.second);
    }
    for (const auto& session : sessions) {
      if (!session) continue;
      switch (session->snapshot().status) {
        case SessionStatus::Created: ++sessions_by_status["created"]; break;
        case SessionStatus::Running: ++sessions_by_status["running"]; break;
        case SessionStatus::Finished: ++sessions_by_status["finished"]; break;
        case SessionStatus::Error: ++sessions_by_status["error"]; break;
        case SessionStatus::Canceled: ++sessions_by_status["canceled"]; break;
        case SessionStatus::ResultLimitReached: ++sessions_by_status["result_limit_reached"]; break;
      }
    }
  }
  prom_family(out, "chdash_query_sessions", "gauge", "Query sessions that the server holds, by state.");
  for (const auto& [status, count] : sessions_by_status) prom_sample(out, "chdash_query_sessions", {{"state", status}}, static_cast<double>(count));
  prom_family(out, "chdash_query_threads", "gauge", "Query threads that run (each one is a query that ClickHouse executes).");
  prom_sample(out, "chdash_query_threads", {}, static_cast<double>(query_workers_->active()));
  prom_family(out, "chdash_query_streams", "gauge", "Open result streams (GET /api/query/stream).");
  prom_sample(out, "chdash_query_streams", {}, static_cast<double>(active_query_streams_.load(std::memory_order_relaxed)));
  prom_family(out, "chdash_host_streams", "gauge", "Open host status streams (GET /api/hosts/stream).");
  prom_sample(out, "chdash_host_streams", {}, static_cast<double>(active_host_streams_.load(std::memory_order_relaxed)));
  prom_family(out, "chdash_exports_active", "gauge", "Exports that stream (GET /api/export/stream).");
  prom_sample(out, "chdash_exports_active", {}, static_cast<double>(active_exports_.load(std::memory_order_relaxed)));

  // The hosts, as the health runner saw them last.
  if (health_) {
    const HostsSnapshot snapshot = health_->snapshot();
    prom_family(out, "chdash_host_up", "gauge", "1 when the host answered its last ping (runner credentials), else 0.");
    for (const auto& host : snapshot.hosts) prom_sample(out, "chdash_host_up", {{"host", host.id}}, host.healthy ? 1 : 0);
    prom_family(out, "chdash_host_ping_seconds", "gauge", "The time of the last ping of the host (absent while it is down).");
    for (const auto& host : snapshot.hosts) {
      if (host.ping_ms >= 0) prom_sample(out, "chdash_host_ping_seconds", {{"host", host.id}}, static_cast<double>(host.ping_ms) / 1000.0);
    }
    prom_family(out, "chdash_host_access_findings", "gauge", "Findings of the access audit of the host (missing grants).");
    for (const auto& host : snapshot.hosts) {
      prom_sample(out, "chdash_host_access_findings", {{"host", host.id}}, static_cast<double>(host.access.warnings.size()));
    }
  }

  // The native ClickHouse connections, by host and identity (the URIs carry passwords: they never leave the process).
  if (client_pool_) {
    const auto stats = client_pool_->stats();
    struct Identity { std::string host, identity; };
    std::unordered_map<std::string, Identity> identities;
    for (const auto& host : cfg_.hosts) {
      identities.emplace(host.runner_uri, Identity{host.id, "runner"});
      identities.emplace(host.system_uri, Identity{host.id, "system"});
      if (!host.mcp_uri.empty()) identities.emplace(host.mcp_uri, Identity{host.id, "mcp"});
    }
    std::map<std::pair<std::string, std::string>, std::pair<size_t, size_t>> counts;
    for (const auto& host : cfg_.hosts) counts[{host.id, "runner"}];
    const auto identity_of = [&](const std::string& uri) {
      const auto it = identities.find(uri);
      return it == identities.end() ? std::make_pair(std::string("other"), std::string("other"))
                                    : std::make_pair(it->second.host, it->second.identity);
    };
    for (const auto& [uri, n] : stats.idle_by_uri) counts[identity_of(uri)].first += n;
    for (const auto& [uri, n] : stats.leased_by_uri) counts[identity_of(uri)].second += n;
    prom_family(out, "chdash_clickhouse_connections", "gauge", "Native ClickHouse connections of the pool, by host, identity and state.");
    for (const auto& [key, n] : counts) {
      prom_sample(out, "chdash_clickhouse_connections", {{"host", key.first}, {"identity", key.second}, {"state", "idle"}},
                  static_cast<double>(n.first));
      prom_sample(out, "chdash_clickhouse_connections", {{"host", key.first}, {"identity", key.second}, {"state", "leased"}},
                  static_cast<double>(n.second));
    }
    prom_family(out, "chdash_clickhouse_connections_opened_total", "counter", "Native ClickHouse connections that the pool opened.");
    prom_sample(out, "chdash_clickhouse_connections_opened_total", {}, static_cast<double>(stats.opened));
    prom_family(out, "chdash_clickhouse_connections_invalidated_total", "counter",
                "Leased connections that their user marked unsafe (closed instead of reused).");
    prom_sample(out, "chdash_clickhouse_connections_invalidated_total", {}, static_cast<double>(stats.invalidated));
  }

  res.status = 200;
  res.set_header("Cache-Control", "no-store");
  res.set_content(out, "text/plain; version=0.0.4; charset=utf-8");
}

void Server::log_stats() {
  size_t sessions = 0;
  {
    std::lock_guard<std::mutex> lk(mu_);
    sessions = sessions_.size();
  }
  const auto uptime_s = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now() - started_at_).count();
  log_event(LogLevel::Info, "server.stats",
            {{"uptime_s", static_cast<int64_t>(uptime_s)},
             {"requests_in_flight", http_metrics_->in_flight()},
             {"connections_active", http_metrics_->connections_active.load(std::memory_order_relaxed)},
             {"connections_queued", http_metrics_->connections_queued.load(std::memory_order_relaxed)},
             {"connections_refused", http_metrics_->connections_refused.load(std::memory_order_relaxed)},
             {"query_sessions", sessions},
             {"query_threads", query_workers_->active()},
             {"query_streams", active_query_streams_.load(std::memory_order_relaxed)},
             {"host_streams", active_host_streams_.load(std::memory_order_relaxed)},
             {"exports", active_exports_.load(std::memory_order_relaxed)},
             {"hosts_healthy", health_ ? health_->healthy_count() : 0},
             {"hosts", cfg_.hosts.size()}});
}

} // namespace chdash
