#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "serve_embedded_static.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <vector>

namespace chdash {

namespace {

static int64_t now_ms_local() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

static std::vector<uint8_t> random_bytes(size_t n) {
  std::vector<uint8_t> out(n);
  std::random_device rd;
  for (size_t i = 0; i < n; ++i) out[i] = static_cast<uint8_t>(rd() & 0xFF);
  return out;
}

static bool try_serve_fs(const httplib::Request& req, httplib::Response& res) {
  std::string path = req.path;
  if (path.empty() || path == "/") path = "/index.html";

  std::string rel;
  if (path.rfind("/static/", 0) == 0) rel = path.substr(std::string("/static/").size());
  else if (!path.empty() && path[0] == '/') rel = path.substr(1);
  else rel = path;

  if (rel.find("..") != std::string::npos) return false;
  if (rel.find('\\') != std::string::npos) return false;

  std::filesystem::path full = std::filesystem::path("./static") / rel;
  std::error_code ec;
  if (!std::filesystem::is_regular_file(full, ec)) return false;

  std::ifstream in(full, std::ios::binary);
  if (!in) return false;
  std::string body((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  res.set_header("Cache-Control", "no-cache");
  res.set_content(std::move(body), mime_from_path(rel));
  return true;
}

} // namespace

Server::Server(AppConfig cfg)
    : cfg_(std::move(cfg)),
      health_(std::make_unique<HealthRunner>(cfg_.hosts, cfg_.health)),
      jwt_(random_bytes(32)) {

  if (health_) health_->start();

  http_.Get("/", [&](const auto& req, auto& res) {
    if (!try_serve_embedded(req, res) && !try_serve_fs(req, res)) {
      res.status = 404;
      res.set_content("index.html not found", "text/plain");
    }
  });

  http_.Get(R"(/static/.*)", [&](const auto& req, auto& res) {
    if (!try_serve_embedded(req, res) && !try_serve_fs(req, res)) {
      res.status = 404;
      res.set_content("asset not found", "text/plain");
    }
  });

  http_.Get("/healthz", [&](const auto& req, auto& res) { handle_healthz(req, res); });
  http_.Get("/api/version", [&](const auto& req, auto& res) { handle_api_version(req, res); });
  http_.Get("/api/meta", [&](const auto& req, auto& res) { handle_api_meta(req, res); });
  http_.Get("/api/hosts", [&](const auto& req, auto& res) { handle_api_hosts(req, res); });
  http_.Get("/api/hosts/stream", [&](const auto& req, auto& res) { handle_api_hosts_stream(req, res); });
  http_.Get("/api/health", [&](const auto& req, auto& res) { handle_api_health(req, res); });

  http_.Post("/api/format", [&](const auto& req, auto& res) { handle_api_format(req, res); });

  http_.Post("/api/query/run", [&](const auto& req, auto& res) { handle_query_run(req, res); });
  http_.Post("/api/query", [&](const auto& req, auto& res) { handle_query_run(req, res); });

  http_.Get("/api/query/stream", [&](const auto& req, auto& res) { handle_query_stream(req, res); });
  http_.Post("/api/query/cancel", [&](const auto& req, auto& res) { handle_query_cancel(req, res); });

  (void)now_ms_local;
}

int Server::run() {
  auto pos = cfg_.listen.rfind(':');
  std::string host = "0.0.0.0";
  int port = 8080;
  if (pos != std::string::npos) {
    host = cfg_.listen.substr(0, pos);
    port = std::stoi(cfg_.listen.substr(pos + 1));
  }
  return http_.listen(host.c_str(), port) ? 0 : 1;
}

bool Server::health_check(std::string* error_message) {
  if (cfg_.hosts.empty()) {
    if (error_message) *error_message = "no ClickHouse hosts configured";
    return false;
  }
  for (const auto& h : cfg_.hosts) {
    std::string err;
    auto c = make_client_from_uri(
      h.system_uri,
      std::chrono::milliseconds(cfg_.health.timeout_ms),
      std::chrono::milliseconds(cfg_.health.timeout_ms),
      std::chrono::milliseconds(cfg_.health.timeout_ms),
      &err
    );
    if (!c) {
      if (error_message) *error_message = "host=" + h.id + " connect error: " + err;
      return false;
    }
    try {
      c->Ping();
    } catch (const std::exception& e) {
      if (error_message) *error_message = "host=" + h.id + " ping error: " + std::string(e.what());
      return false;
    }
  }
  return true;
}

void Server::handle_healthz(const httplib::Request&, httplib::Response& res) {
  const bool ok = health_ ? health_->all_healthy() : false;
  if (ok) {
    res.status = 200;
    res.set_content("ok", "text/plain");
    return;
  }
  json_error(res, 503, "db_unhealthy", "one or more ClickHouse hosts are unhealthy");
}

void Server::handle_api_version(const httplib::Request&, httplib::Response& res) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("name"); w.String("clickhouse-dash");
  w.Key("version"); w.String(cfg_.version_semver.c_str());
  w.Key("git_sha"); w.String(cfg_.version_git_sha.c_str());
  w.Key("build_time"); w.String(cfg_.version_build_time.c_str());
  w.EndObject();
  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
