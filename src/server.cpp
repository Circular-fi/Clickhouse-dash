#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "serve_embedded_static.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <unordered_map>
#include <mutex>
#include <thread>
#include <utility>
#include <memory>
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

static std::int64_t file_time_nanoseconds(std::filesystem::file_time_type value) {
  const auto nanoseconds = std::chrono::duration_cast<std::chrono::nanoseconds>(
      value.time_since_epoch());
  return static_cast<std::int64_t>(nanoseconds.count());
}

struct FsStaticAsset {
  std::string body;
  std::string mime;
  std::string etag;
  std::filesystem::file_time_type modified{};
  uintmax_t size = 0;
};

static std::mutex g_fs_static_mu;
static std::unordered_map<std::string, std::shared_ptr<FsStaticAsset>> g_fs_static_cache;

static bool try_serve_fs(const httplib::Request& req, httplib::Response& res) {
  std::string path = req.path;
  if (path.empty() || path == "/") path = "/index.html";

  std::string rel;
  if (path.rfind("/static/", 0) == 0) rel = path.substr(std::string("/static/").size());
  else if (!path.empty() && path[0] == '/') rel = path.substr(1);
  else rel = path;

  if (rel.find("..") != std::string::npos || rel.find('\\') != std::string::npos) return false;

  const std::filesystem::path full = std::filesystem::path("./static") / rel;
  std::error_code ec;
  if (!std::filesystem::is_regular_file(full, ec)) return false;
  const auto modified = std::filesystem::last_write_time(full, ec);
  if (ec) return false;
  const uintmax_t size = std::filesystem::file_size(full, ec);
  if (ec) return false;

  std::shared_ptr<FsStaticAsset> asset;
  const std::string cache_key = full.lexically_normal().string();
  {
    std::lock_guard<std::mutex> lk(g_fs_static_mu);
    auto it = g_fs_static_cache.find(cache_key);
    if (it != g_fs_static_cache.end() && it->second->modified == modified && it->second->size == size) {
      asset = it->second;
    } else {
      std::ifstream in(full, std::ios::binary);
      if (!in) return false;
      auto loaded = std::make_shared<FsStaticAsset>();
      loaded->body.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
      loaded->mime = mime_from_path(rel);
      loaded->modified = modified;
      loaded->size = size;
      loaded->etag = "\"" + std::to_string(size) + "-" +
          std::to_string(file_time_nanoseconds(modified)) + "\"";
      g_fs_static_cache[cache_key] = loaded;
      asset = std::move(loaded);
    }
  }

  res.set_header("ETag", asset->etag);
  res.set_header("Cache-Control", "public, max-age=0, must-revalidate");
  if (req.has_header("If-None-Match") && req.get_header_value("If-None-Match") == asset->etag) {
    res.status = 304;
    return true;
  }
  res.set_content(asset->body, asset->mime);
  return true;
}

} // namespace

Server::Server(AppConfig cfg, bool start_background)
    : cfg_(std::move(cfg)),
      health_(std::make_unique<HealthRunner>(cfg_.hosts, cfg_.health)),
      jwt_(random_bytes(32)),
      client_pool_(std::make_shared<ClickHouseClientPool>(
          cfg_.client_pool_max_idle_per_key,
          std::chrono::milliseconds(cfg_.client_pool_idle_ttl_ms),
          std::chrono::milliseconds(cfg_.client_pool_validate_after_idle_ms),
          std::chrono::milliseconds(cfg_.client_pool_reaper_interval_ms))),
      format_cache_(std::make_unique<FormatCache>(
          cfg_.format_cache_max_entries,
          cfg_.format_cache_max_bytes,
          std::chrono::milliseconds(cfg_.format_cache_ttl_ms))),
      background_enabled_(start_background) {

  if (background_enabled_ && health_) health_->start();
  if (background_enabled_) {
    session_reaper_thread_ = std::thread([this] { session_reaper_loop(); });
  }

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

Server::~Server() {
  session_reaper_stop_.store(true, std::memory_order_relaxed);
  session_reaper_cv_.notify_all();
  if (session_reaper_thread_.joinable()) session_reaper_thread_.join();

  std::vector<std::shared_ptr<QuerySession>> remaining;
  {
    std::lock_guard<std::mutex> lk(mu_);
    remaining.reserve(sessions_.size());
    for (auto& item : sessions_) remaining.push_back(std::move(item.second));
    sessions_.clear();
  }
  for (const auto& session : remaining) {
    if (!session) continue;
    session->request_cancel();
    session->cancel_native_queries_best_effort(false);
  }
  remaining.clear(); // joins query workers before shared infrastructure is destroyed

  if (health_) health_->stop();
}

void Server::reap_sessions_once() {
  std::vector<std::pair<std::string, std::shared_ptr<QuerySession>>> candidates;
  {
    std::lock_guard<std::mutex> lk(mu_);
    candidates.reserve(sessions_.size());
    for (const auto& item : sessions_) candidates.push_back(item);
  }

  std::vector<std::pair<std::string, std::shared_ptr<QuerySession>>> expired;
  for (auto& item : candidates) {
    if (item.second && item.second->should_reap(
          cfg_.query_session_abandoned_ttl_ms,
          cfg_.query_session_terminal_ttl_ms)) {
      expired.push_back(std::move(item));
    }
  }
  if (expired.empty()) return;

  {
    std::lock_guard<std::mutex> lk(mu_);
    for (const auto& item : expired) {
      const auto it = sessions_.find(item.first);
      if (it != sessions_.end() && it->second == item.second) sessions_.erase(it);
    }
  }
  for (const auto& item : expired) {
    if (!item.second) continue;
    const auto status = item.second->snapshot().status;
    const bool terminal = status == SessionStatus::Finished ||
                          status == SessionStatus::Error ||
                          status == SessionStatus::Canceled ||
                          status == SessionStatus::ResultLimitReached;
    if (!terminal) {
      item.second->request_cancel();
      item.second->cancel_native_queries_best_effort(false);
    }
  }
}

void Server::session_reaper_loop() {
  const int interval_ms = std::max(250, std::min(60 * 1000, cfg_.query_session_reaper_interval_ms));
  while (!session_reaper_stop_.load(std::memory_order_relaxed)) {
    {
      std::unique_lock<std::mutex> lk(session_reaper_mu_);
      session_reaper_cv_.wait_for(
          lk,
          std::chrono::milliseconds(interval_ms),
          [this] { return session_reaper_stop_.load(std::memory_order_relaxed); });
    }
    if (!session_reaper_stop_.load(std::memory_order_relaxed)) reap_sessions_once();
  }
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
    auto c = client_pool_ ? client_pool_->acquire(
      h.runner_uri,
      std::chrono::milliseconds(cfg_.health.timeout_ms),
      std::chrono::milliseconds(cfg_.health.timeout_ms),
      std::chrono::milliseconds(cfg_.health.timeout_ms),
      &err
    ) : make_client_from_uri(
      h.runner_uri,
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
