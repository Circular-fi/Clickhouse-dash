#pragma once

#include "ch_client_pool.hpp"
#include "format_cache.hpp"
#include "allowed_objects.hpp"
#include "explorer_catalog.hpp"
#include "explorer_graph.hpp"
#include "export_job.hpp"
#include "health_runner.hpp"
#include "jwt.hpp"
#include "query_session.hpp"
#include "query_registry.hpp"
#include "stale_cache.hpp"

#include <httplib.h>

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace chdash {

struct ExplorerSettings {
  bool browse = true;
  bool lineage = true;
  bool storage_topology = true;

  bool graph_enabled() const { return lineage || storage_topology; }
  bool enabled() const { return browse || graph_enabled(); }
  int cache_ttl_ms = 5000;
  int live_refresh_ms = 2000;
  int function_cache_ttl_ms = 60 * 60 * 1000;
  // Markdown links in ClickHouse function documentation are disabled by
  // default. When enabled, the browser still accepts only ClickHouse-relative
  // references (/... or ./...) and strips every arbitrary external URL.
  bool function_markdown_links = false;
};

struct AnalysisSettings {
  int registry_ttl_ms = 60 * 60 * 1000;
  size_t registry_max_entries = 10000;
  size_t registry_sql_max_bytes = 32 * 1024 * 1024;
  int log_lookup_timeout_ms = 2000;
  bool flush_logs = false;
  bool allow_deep_analyze = false;
};

struct ExportSettings {
  size_t max_concurrent = 1;
  size_t output_buffer_bytes = 256 * 1024;
  std::string archive_format = "zip";
  bool compression = false;
  int token_ttl_ms = 120 * 1000;
  size_t pending_max_entries = 32;
  size_t pending_sql_max_bytes = 16 * 1024 * 1024;
  size_t max_queries = 256;
};

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

  // Native TCP pool lifecycle. Idle sockets are closed proactively before
  // ClickHouse or an intermediary reaches its receive/idle timeout. Reused
  // sockets are validated only after a meaningful idle period to keep the hot
  // path free of an extra round trip.
  size_t client_pool_max_idle_per_key = 4;
  int client_pool_idle_ttl_ms = 60 * 1000;
  int client_pool_validate_after_idle_ms = 15 * 1000;
  int client_pool_reaper_interval_ms = 5 * 1000;

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

  // Internal cancel capability lifetime. Tokens are additionally invalidated by
  // a server restart because the signing secret is generated at boot.
  int cancel_token_ttl_ms = 48 * 60 * 60 * 1000;

  // Explorer, analysis, and export feature settings.
  ExplorerSettings explorer;
  AnalysisSettings analysis;
  ExportSettings export_settings;

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
  void handle_query_analysis(const httplib::Request& req, httplib::Response& res);
  void handle_query_deep_analysis(const httplib::Request& req, httplib::Response& res);
  void handle_query_execution(const httplib::Request& req, httplib::Response& res);

  void handle_export_run(const httplib::Request& req, httplib::Response& res);
  void handle_export_stream(const httplib::Request& req, httplib::Response& res);

  void handle_explorer_catalog(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_table(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_table_data(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_graph(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_activity(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_functions(const httplib::Request& req, httplib::Response& res);

  void session_reaper_loop();
  void reap_sessions_once();

  struct MetaKeywords {
    uint64_t updated_at_ms = 0;
    std::string source = "clickhouse";
    std::string credential_scope = "system";
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
    std::string credential_scope = "system";
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
    std::string credential_scope;
    std::vector<MetaCatalogItem> items;
  };

  StaleCache<std::string, MetaKeywords> meta_keywords_cache_;
  StaleCache<std::string, MetaFunctions> meta_functions_cache_;
  StaleCache<std::string, MetaCatalog> meta_catalog_cache_;
  StaleCache<std::string, AllowedObjectSet> explorer_allowed_cache_;
  StaleCache<std::string, ExplorerCatalog> explorer_catalog_cache_;
  StaleCache<std::string, ExplorerGraph> explorer_graph_cache_;
  StaleCache<std::string, ExplorerFunctionsCatalog> explorer_functions_cache_;

  AppConfig cfg_;
  httplib::Server http_;

  std::unique_ptr<HealthRunner> health_;
  JwtService jwt_;
  std::shared_ptr<QueryRegistry> query_registry_;
  std::shared_ptr<ExportJobStore> export_jobs_;
  std::atomic<size_t> active_exports_{0};
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
