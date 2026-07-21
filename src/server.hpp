#pragma once

#include "ch_client_pool.hpp"
#include "format_cache.hpp"
#include "health_runner.hpp"
#include "jwt.hpp"
#include "query_session.hpp"
#include "stale_cache.hpp"

#include <httplib.h>

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace chdash {

struct AppConfig {
  std::string listen = "0.0.0.0:8080";


  // ClickHouse hosts (multi-host).
  // Each HostSpec contains a runner_uri and a system_uri.
  std::vector<HostSpec> hosts;

  // Health runner settings.
  HealthSettings health;

  // How many result rows to stream before truncating (0 = unlimited).
  int result_preview_row_limit = 0;
  size_t query_max_sql_bytes = 4 * 1024 * 1024;

  // Native TCP query execution knobs. Defaults favor low interactive latency.
  QuerySessionOptions query_options;

  // Number of idle clickhouse::Client TCP connections to keep per URI/timeout key.
  size_t client_pool_max_idle_per_key = 4;

  // SQL formatting is frequently triggered repeatedly by editor actions. Cache
  // deterministic results to avoid a ClickHouse round trip and formatter pass.
  size_t format_cache_max_entries = 512;
  size_t format_cache_max_bytes = 16 * 1024 * 1024;
  int format_cache_ttl_ms = 10 * 60 * 1000;

  // Protect the process from abandoned /api/query/run calls whose SSE stream
  // was never opened, and bound concurrent query memory.
  size_t query_session_max_count = 256;
  int query_session_abandoned_ttl_ms = 60 * 1000;
  int query_session_terminal_ttl_ms = 30 * 1000;
  int query_session_reaper_interval_ms = 5 * 1000;

  // /api/version
  std::string version_semver = "dev";
  std::string version_git_sha = "unknown";
  std::string version_build_time = "unknown";
};

class Server {
public:
  explicit Server(AppConfig cfg, bool start_background = true);
  ~Server();

  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  int run();
  bool health_check(std::string* error_message = nullptr);

private:
  void handle_healthz(const httplib::Request& req, httplib::Response& res);
  void handle_api_version(const httplib::Request& req, httplib::Response& res);
  void handle_api_meta(const httplib::Request& req, httplib::Response& res);
  void handle_api_hosts(const httplib::Request& req, httplib::Response& res);
  void handle_api_hosts_stream(const httplib::Request& req, httplib::Response& res);
  void handle_api_health(const httplib::Request& req, httplib::Response& res);

  void handle_api_format(const httplib::Request& req, httplib::Response& res);

  void handle_query_run(const httplib::Request& req, httplib::Response& res);
  void handle_query_stream(const httplib::Request& req, httplib::Response& res);
  void handle_query_cancel(const httplib::Request& req, httplib::Response& res);

  void session_reaper_loop();
  void reap_sessions_once();

  struct MetaKeywords {
    uint64_t updated_at_ms = 0;
    std::vector<std::string> items;
  };

  struct MetaFunction {
    std::string name;
    bool is_aggregate = false;
    bool case_insensitive = false;
    bool is_user_defined = false;
    std::string origin;
  };

  struct MetaFunctions {
    uint64_t updated_at_ms = 0;
    std::vector<MetaFunction> items;
  };

  struct MetaCatalogItem {
    std::string name;
    std::string database;
    std::string table;
    std::string type;
    std::string detail;
    std::string parent;
  };

  struct MetaCatalog {
    uint64_t updated_at_ms = 0;
    std::vector<MetaCatalogItem> items;
  };

  StaleCache<std::string, MetaKeywords> meta_keywords_cache_;
  StaleCache<std::string, MetaFunctions> meta_functions_cache_;
  StaleCache<std::string, MetaCatalog> meta_catalog_cache_;

  AppConfig cfg_;
  httplib::Server http_;

  std::unique_ptr<HealthRunner> health_;
  JwtService jwt_;
  std::shared_ptr<ClickHouseClientPool> client_pool_;
  std::unique_ptr<FormatCache> format_cache_;

  std::mutex mu_;
  std::unordered_map<std::string, std::shared_ptr<QuerySession>> sessions_;

  const bool background_enabled_ = true;
  std::atomic<bool> session_reaper_stop_{false};
  std::mutex session_reaper_mu_;
  std::condition_variable session_reaper_cv_;
  std::thread session_reaper_thread_;
};

} // namespace chdash
