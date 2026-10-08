#pragma once

#include "ch_client_pool.hpp"
#include "format_cache.hpp"
#include "allowed_objects.hpp"
#include "explorer_catalog.hpp"
#include "explorer_graph.hpp"
#include "system_monitor.hpp"
#include "system_activity.hpp"
#include "export_job.hpp"
#include "health_runner.hpp"
#include "jwt.hpp"
#include "mcp_keys.hpp"
#include "mcp_tools.hpp"
#include "query_library.hpp"
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
#include <utility>
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

// The System page (docs/system.md): the selected server, not a database
// or a table. Overview (server tiles, databases, topology, Keeper,
// replication, the performance history and the background activity),
// Queries (system.query_log) and Disks. Every read is a fixed, bounded
// system-table SELECT.
struct SystemSettings {
  bool enabled = true;
  // The Activity part of the Overview (merges, mutations, replication and
  // Distributed queues: /api/system/activity). v2.14.0's
  // explorer.operations.enabled sets it too.
  bool activity = true;
  // The Keeper / ZooKeeper session (/api/system/keeper); v2.14.0's
  // explorer.operations.keeper sets it too.
  bool keeper = true;
  // The Queries section (top queries of system.query_log, runner context).
  bool top_queries = true;
  // clusterAllReplicas() views; needs GRANT REMOTE for the system account.
  bool cluster_fanout = false;
  // Time windows and caps of the history parts.
  int default_lookback_minutes = 60;
  int max_lookback_days = 30;
  int query_log_max_lookback_hours = 7 * 24;
  uint64_t query_log_max_rows = 50'000'000;
  int disk_growth_days = 7;
  bool activity_enabled() const { return enabled && activity; }
  bool keeper_enabled() const { return enabled && keeper; }
  bool top_queries_enabled() const { return enabled && top_queries; }
};

struct TraceFeatureSettings {
  bool service_filter = true;
  bool operation_filter = true;
  bool status_filter = true;
  bool duration_filter = true;
  bool resource_attributes = true;
  bool span_attributes = true;
  bool events = true;
  bool links = true;
};

struct TraceSettings {
  bool enabled = false;
  bool analytics = false;
  std::string database = "otel";
  std::string table = "otel_traces";
  std::string trace_index_table = "otel_traces_trace_id_ts";
  std::vector<std::string> service_allowlist{"*"};
  int default_lookback_minutes = 60;
  int max_lookback_minutes = 7 * 24 * 60;
  size_t search_limit = 100;
  size_t max_spans_per_trace = 10000;
  // Attributes shown as key: value chips in the trace header (root span
  // first, then the first span carrying the key).
  std::vector<std::string> highlighted_attributes{
      "service.version", "deployment.environment.name", "deployment.environment", "http.route", "user.id"};
  // "Linked from" lookups scan the trace's own window widened by this margin.
  int linked_from_margin_minutes = 60;
  TraceFeatureSettings features;
};

// OpenTelemetry logs (ClickHouse exporter otel_logs table). ServiceName
// access control reuses traces.service_allowlist.
struct LogSettings {
  bool enabled = false;
  std::string database = "otel";
  std::string table = "otel_logs";
  int max_lookback_minutes = 7 * 24 * 60;
  size_t search_limit = 200;
  // "token" (hasToken, index-backed by a tokenbf_v1/text Body index),
  // "substring" (ILIKE-style scan) or "off" (no Body search).
  std::string body_search = "token";
  // Logs of one trace (trace detail): at most trace_logs_limit records, read
  // from the trace start - trace_margin_before_seconds to its end +
  // trace_margin_after_seconds (records are often written after their span).
  size_t trace_logs_limit = 1000;
  int trace_margin_before_seconds = 5;
  int trace_margin_after_seconds = 30;
};

// OpenTelemetry metrics (ClickHouse exporter <table_prefix>_{gauge,sum,
// histogram,exponential_histogram,summary} tables).
struct MetricSettings {
  bool enabled = false;
  std::string database = "otel";
  std::string table_prefix = "otel_metrics";
};

// Server-side query library (folders + saved queries), persisted in one JSON
// file. Disabled by default: the browser keeps its localStorage library. The
// history of the runs is always the browser's. See docs/query-library.md.
struct QueryLibrarySettings {
  bool enabled = false;
  std::string file;
  // false: GET only; folder/query create, edit, move, delete and import answer
  // 403 read_only.
  bool writable = false;
  size_t max_file_bytes = 8 * 1024 * 1024;
  size_t max_query_bytes = 256 * 1024;

};

// The MCP endpoint (POST /mcp), its keys and its limits (docs/mcp.md). Off by
// default. Every limit is a global cap that a key may only lower.
struct McpSettings {
  bool enabled = false;
  // The JSON file of the keys made on the MCP page; empty = no UI keys.
  std::string storage_file;
  // false: the page is read-only and every key write answers 403 manage_disabled.
  bool manage_from_ui = true;
  int64_t max_rows = 1000;
  int64_t max_result_bytes = 1048576;
  int64_t query_timeout_seconds = 30;
  int64_t max_sql_bytes = 65536;
  int64_t max_memory_bytes = 1073741824;
  // 0 = no limit.
  int64_t max_rows_to_read = 0;
  // Per key; 0 = no limit.
  int64_t rate_limit_per_minute = 600;
  // Origins (scheme://host[:port]) that may call from a browser. A request
  // without an Origin header is always accepted; one with an unlisted Origin is a 403.
  std::vector<std::string> allowed_origins;
  // The keys of the `key { }` blocks, read at start and never written back.
  std::vector<McpKey> keys;
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
  SystemSettings system;
  AnalysisSettings analysis;
  TraceSettings traces;
  LogSettings logs;
  MetricSettings metrics;
  ExportSettings export_settings;
  QueryLibrarySettings query_library;
  McpSettings mcp;

  // /api/version
  std::string version_semver = "dev";
  std::string version_git_sha = "unknown";
  std::string version_build_time = "unknown";
};

// Query library routes (api_query_library.cpp).
enum class QueryLibraryRoute {
  Get,
  FolderCreate,
  FolderUpdate,
  FolderDelete,
  QueryCreate,
  QueryUpdate,
  QueryDelete,
  Import,
};

// MCP page routes (api_mcp.cpp).
enum class McpApiRoute {
  Meta,
  KeysList,
  KeyCreate,
  KeyDelete,
  KeyReveal,
};

class Server {
public:
  explicit Server(AppConfig cfg, bool start_background = true);
  ~Server();

  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  int run();
  // Makes run() return (any thread). Used by the shutdown hook of the sanitizer builds.
  void stop();
  bool health_check(std::string* error_message = nullptr);

private:
  void handle_healthz(const httplib::Request& req, httplib::Response& res);
  void handle_api_version(const httplib::Request& req, httplib::Response& res);
  // /explorer/_monitoring[/<section>] and /explorer/_operations: a 302 to the
  // matching System address (relative, so a reverse-proxy prefix stays).
  void redirect_to_system(const httplib::Request& req, httplib::Response& res);
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
  void handle_explorer_graph_definition(const httplib::Request& req, httplib::Response& res);
  bool explorer_graph_snapshot(const httplib::Request& req, httplib::Response& res, const std::string& host_id,
                               std::shared_ptr<const ExplorerGraph>& graph, bool& stale);
  void handle_explorer_functions(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_storage(const httplib::Request& req, httplib::Response& res);
  void handle_system_activity(const httplib::Request& req, httplib::Response& res);
  void handle_system_keeper(const httplib::Request& req, httplib::Response& res);
  void handle_system_overview(const httplib::Request& req, httplib::Response& res);
  void handle_system_series(const httplib::Request& req, httplib::Response& res);
  void handle_system_queries(const httplib::Request& req, httplib::Response& res);
  void handle_system_query(const httplib::Request& req, httplib::Response& res);
  void handle_system_disks(const httplib::Request& req, httplib::Response& res);
  void system_monitor_disk_growth(const httplib::Request& req, httplib::Response& res, const HostSpec& host,
                                    const std::string& system_uri, const std::shared_ptr<const MonitorCapabilities>& caps,
                                    const MonitorSeriesWindow& window, uint64_t from_ms, uint64_t to_ms, uint64_t now_ms);
  bool system_monitor_queries_window(const httplib::Request& req, httplib::Response& res, uint64_t now_ms,
                                       uint64_t& from_ms, uint64_t& to_ms);
  std::shared_ptr<const MonitorCapabilities> system_monitor_capabilities(const std::string& host_id, const std::string& system_uri);

  void handle_traces_meta(const httplib::Request& req, httplib::Response& res);
  void handle_traces_search(const httplib::Request& req, httplib::Response& res);
  void handle_traces_analytics(const httplib::Request& req, httplib::Response& res);
  void handle_traces_service_map(const httplib::Request& req, httplib::Response& res);
  void handle_traces_heatmap(const httplib::Request& req, httplib::Response& res);
  void handle_traces_deltas(const httplib::Request& req, httplib::Response& res);
  void handle_traces_services(const httplib::Request& req, httplib::Response& res);
  void handle_traces_services_db(const httplib::Request& req, httplib::Response& res);
  void handle_traces_prefill(const httplib::Request& req, httplib::Response& res);
  void handle_traces_facets(const httplib::Request& req, httplib::Response& res);
  void handle_traces_facet_values(const httplib::Request& req, httplib::Response& res);
  void handle_trace_detail(const httplib::Request& req, httplib::Response& res);
  void handle_traces_linked_from(const httplib::Request& req, httplib::Response& res);
  void handle_traces_context(const httplib::Request& req, httplib::Response& res);
  // Span-level search (keyset pages over newest-first time slices) and one
  // span by its row key, for the search page's Spans mode.
  void handle_traces_spans(const httplib::Request& req, httplib::Response& res);
  void handle_traces_span(const httplib::Request& req, httplib::Response& res);

  // OTel logs / metrics schema detection (api_otel_signals.cpp).
  void handle_logs_meta(const httplib::Request& req, httplib::Response& res);
  // Logs of one trace for the trace detail page (api_trace_logs.cpp).
  void handle_trace_logs(const httplib::Request& req, httplib::Response& res);
  void handle_logs_search(const httplib::Request& req, httplib::Response& res);
  void handle_logs_histogram(const httplib::Request& req, httplib::Response& res);
  void handle_logs_context(const httplib::Request& req, httplib::Response& res);
  void handle_logs_patterns(const httplib::Request& req, httplib::Response& res);
  void handle_logs_services(const httplib::Request& req, httplib::Response& res);
  void handle_logs_facets(const httplib::Request& req, httplib::Response& res);
  void handle_logs_facet_values(const httplib::Request& req, httplib::Response& res);
  void handle_metrics_meta(const httplib::Request& req, httplib::Response& res);

  // OTel metrics browser (api_metrics.cpp).
  void handle_metrics_catalog(const httplib::Request& req, httplib::Response& res);
  void handle_metrics_attributes(const httplib::Request& req, httplib::Response& res);
  void handle_metrics_series(const httplib::Request& req, httplib::Response& res);
  void handle_metrics_exemplars(const httplib::Request& req, httplib::Response& res);

  // Server-side query library (api_query_library.cpp). Never runs SQL.
  void handle_query_library(const httplib::Request& req, httplib::Response& res, QueryLibraryRoute route);

  // MCP (api_mcp.cpp): POST /mcp and the key routes of the MCP page. The endpoint and the
  // keys exist only when mcp.enabled = true; /api/mcp/meta always answers.
  void init_mcp();
  void handle_mcp_post(const httplib::Request& req, httplib::Response& res, const httplib::ContentReader& reader);
  void handle_mcp_not_allowed(const httplib::Request& req, httplib::Response& res);
  void handle_api_mcp(const httplib::Request& req, httplib::Response& res, McpApiRoute route);

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
  // Browse uses a tiny identity-only catalog. Rich summaries are loaded only
  // when a table is opened or Graph explicitly needs them.
  StaleCache<std::string, ExplorerCatalog> explorer_catalog_list_cache_;
  StaleCache<std::string, ExplorerCatalog> explorer_catalog_cache_;
  // Per-table detail is request-driven and expires after 30s. There is no
  // periodic refresh: stale entries are refreshed only when requested again.
  StaleCache<std::string, ExplorerTableDetail> explorer_table_detail_cache_;
  StaleCache<std::string, ExplorerGraph> explorer_graph_cache_;
  StaleCache<std::string, ExplorerFunctionsCatalog> explorer_functions_cache_;
  // Server-wide storage distribution for the Explorer System section.
  StaleCache<std::string, ExplorerStorageMap> explorer_storage_cache_;
  // Server operations view: short-lived snapshots shared by every viewer of
  // a host, so an auto-refreshing page costs one read per TTL, not per tab.
  StaleCache<std::string, SystemActivity> system_activity_cache_;
  StaleCache<std::string, SystemKeeperStatus> system_keeper_cache_;
  // Monitoring: what each host exposes (10 min), and the Overview snapshot
  // (the operations TTL), shared by every viewer of a host.
  StaleCache<std::string, MonitorCapabilities> system_monitor_caps_cache_;
  StaleCache<std::string, SystemMonitorOverview> system_monitor_overview_cache_;
  // Performance: 15 s per host and aligned window (the step-aligned
  // from / to), so relative windows refreshed within a step share one read.
  StaleCache<std::string, SystemMonitorSeries> system_monitor_series_cache_;
  // Queries: 60 s per host, minute-aligned window and allowlisted choice
  // (one read in flight per key); a drill-down per shape the same way.
  StaleCache<std::string, SystemMonitorQueries> system_monitor_queries_cache_;
  StaleCache<std::string, SystemMonitorQuery> system_monitor_query_cache_;
  // Disks: 60 s per host; their growth 5 min per host and aligned window.
  StaleCache<std::string, SystemMonitorDisks> system_monitor_disks_cache_;
  StaleCache<std::string, SystemMonitorDiskGrowth> system_monitor_growth_cache_;
  // Trace service/operation prefill. The browser re-requests it on every
  // time-range change and page load; each miss scans every span of the window
  // (seconds on wide windows), so identical minute-aligned ranges share one
  // result for a short TTL.
  struct TracePrefill {
    std::vector<std::pair<std::string, std::string>> pairs;
    bool truncated = false;
    // A read bound stopped the scans: the pairs are then a subset.
    bool estimated = false;
    // The scans: passes run and rows read.
    int passes = 0;
    uint64_t read_rows = 0;
    int64_t start_ms = 0;
    int64_t end_ms = 0;
  };
  StaleCache<std::string, TracePrefill> trace_prefill_cache_;

  AppConfig cfg_;
  httplib::Server http_;

  std::unique_ptr<HealthRunner> health_;
  JwtService jwt_;
  std::shared_ptr<QueryRegistry> query_registry_;
  std::shared_ptr<ExportJobStore> export_jobs_;
  std::atomic<size_t> active_exports_{0};
  std::shared_ptr<ClickHouseClientPool> client_pool_;
  std::unique_ptr<FormatCache> format_cache_;
  // Only constructed when query_library.enabled = true.
  std::unique_ptr<QueryLibraryStore> query_library_;
  // Only constructed when mcp.enabled = true. The database outlives the tools that use it.
  std::unique_ptr<McpKeyStore> mcp_keys_;
  std::unique_ptr<McpDatabase> mcp_db_;
  std::unique_ptr<McpApiClient> mcp_api_;
  std::unique_ptr<McpTools> mcp_tools_;
  McpRateLimiter mcp_rate_;

  std::mutex mu_;
  std::unordered_map<std::string, std::shared_ptr<QuerySession>> sessions_;

  const bool background_enabled_ = true;
  std::atomic<bool> session_reaper_stop_{false};
  std::mutex session_reaper_mu_;
  std::condition_variable session_reaper_cv_;
  std::thread session_reaper_thread_;
};

} // namespace chdash
