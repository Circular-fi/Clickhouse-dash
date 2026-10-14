#pragma once

#include "acl_service.hpp"
#include "admission.hpp"
#include "ch_client_pool.hpp"
#include "format_cache.hpp"
#include "allowed_objects.hpp"
#include "explorer_catalog.hpp"
#include "explorer_graph.hpp"
#include "explorer_service.hpp"
#include "logs_service.hpp"
#include "metrics_service.hpp"
#include "system_disks.hpp"
#include "system_monitor.hpp"
#include "system_overview.hpp"
#include "system_queries.hpp"
#include "system_series.hpp"
#include "system_service.hpp"
#include "system_settings.hpp"
#include "system_activity.hpp"
#include "deep_analysis_jobs.hpp"
#include "export_job.hpp"
#include "facet_limits.hpp"
#include "health_runner.hpp"
#include "jwt.hpp"
#include "metrics.hpp"
#include "mcp_keys.hpp"
#include "mcp_tools.hpp"
#include "otel_caches.hpp"
#include "otel_settings.hpp"
#include "query_library.hpp"
#include "query_session.hpp"
#include "query_registry.hpp"
#include "request_context.hpp"
#include "routed_server.hpp"
#include "cache_sizes.hpp"
#include "explorer_catalog.hpp"
#include "system_log_flush.hpp"
#include "trace_service.hpp"
#include "ttl_cache.hpp"
#include "worker_group.hpp"

#include <httplib.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <map>
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
  // What the runner of a host may read (CHECK GRANT discovery) is kept this long, then served while one refresh runs
  // for as long again. refresh=1 reads it again at once.
  int acl_cache_ttl_ms = 60 * 1000;
  int live_refresh_ms = 2000;
  int function_cache_ttl_ms = 60 * 60 * 1000;
  // Markdown links in ClickHouse function documentation are disabled by
  // default. When enabled, the browser still accepts only ClickHouse-relative
  // references (/... or ./...) and strips every arbitrary external URL.
  bool function_markdown_links = false;
};

// Server-side query library (folders + saved queries), persisted in one JSON
// file. Disabled by default: the browser keeps its localStorage library. The
// history of the runs is always the browser's. See docs/query-library.md.
struct QueryLibrarySettings {
  bool enabled = false;
  // The id the API names (?library=), and the name the UI shows. The first library is the default one: it needs no name
  // ("default"); the others do.
  std::string name;
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
  // The request header that carries the key. "Authorization" takes "Bearer <key>". Another name (for
  // a deployment where a proxy in front already uses Authorization) takes the key alone, or "Bearer <key>".
  std::string auth_header = "Authorization";
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
  int64_t deep_max_execution_time_s = 300;
};

struct ExportSettings {
  // The ClickHouse bounds of each exported statement; 0 = the settings profile of the runner.
  int64_t max_execution_time_s = 0;
  uint64_t max_memory_usage = 0;
  // A statement that sends nothing (no data, no progress) for this long fails; 0 = no limit.
  int receive_timeout_ms = 10 * 60 * 1000;
  size_t max_concurrent = 1;
  size_t output_buffer_bytes = 256 * 1024;
  std::string archive_format = "zip";
  bool compression = false;
  int token_ttl_ms = 120 * 1000;
  size_t pending_max_entries = 32;
  size_t pending_sql_max_bytes = 16 * 1024 * 1024;
  size_t max_queries = 256;
};

// The capacity of the HTTP server (the server { } block). A stream (Server-Sent Events, an export)
// holds one worker thread for as long as it lasts, so the pool grows with the work up to
// max_worker_threads; past it, requests wait in a bounded queue, and past the queue the
// connection is closed rather than kept waiting without end.
struct ServerLimits {
  size_t worker_threads = 0;        // threads kept ready; 0 = max(8, hardware threads)
  size_t max_worker_threads = 256;  // threads at most (the pool grows with the load, idle ones exit)
  size_t max_queued_requests = 1024;
  size_t max_body_bytes = 0;        // largest request body; 0 = from query.max_sql_bytes and the query library
  size_t max_host_streams = 64;     // open host status streams (one per visible page); past it, pages poll
  // How long one write of a response may wait for a client that does not read (a paused download,
  // a slow disk). Past it, the response ends; for an export or a run, that cancels it.
  int write_timeout_ms = 120 * 1000;
  // A stop (SIGTERM, SIGINT) drains the server for at most this long (docs/operations.md, "Shutdown"); past it the
  // process exits with status 1.
  int shutdown_timeout_ms = 10 * 1000;
  // GET /metrics, the Prometheus text format (docs/operations.md, "Metrics").
  bool metrics = true;
  // One log line for each request (docs/operations.md, "Logs"); the probes that succeed are left out.
  bool access_log = true;
  // A "server.stats" log line this often; 0 = never.
  int stats_log_interval_ms = 5 * 60 * 1000;
};

// How much heavy work runs at once (docs/operations.md, "Admission"). A request past a limit waits `wait_ms`, then is
// refused with 503 server_busy. 0 = no limit.
struct AdmissionSettings {
  size_t heavy_per_host = 16;    // reads of the Explorer, System, Traces, Logs and Metrics pages, for each ClickHouse host
  size_t analysis_per_host = 1;  // Query Analysis and Deep Analyze (they read the logs of a run or run it again), for each host
  size_t mcp_max = 8;            // calls of the API tools of MCP, in all
  int wait_ms = 5000;
};

enum class WorkClass { Heavy, Analysis, Mcp };

// The bounds of the queries that ChDash writes itself, for every page but the Run of the Query page
// and the export (the generated_queries { } block). Each statement of a request gets
// max_execution_time = what remains of timeout_ms, and max_memory_usage; neither is ever looser than
// the settings profile of the ClickHouse user (ch_query.hpp).
struct GeneratedQuerySettings {
  int timeout_ms = 60 * 1000;
  uint64_t max_memory_usage = uint64_t{4} * 1024 * 1024 * 1024;  // 0 = the settings profile
  // Rows that one statement of a page may read (0 = the settings profile). A statement that would read more fails with
  // <page>_scan_limit; the preview of a table and the catalog of the metrics stop at it instead and say so.
  uint64_t max_rows_to_read = uint64_t{20} * 1000 * 1000 * 1000;
};

struct AppConfig {
  std::string listen = "0.0.0.0:8080";
  ServerLimits server;


  // ClickHouse hosts (multi-host).
  // Each HostSpec contains a runner_uri and a system_uri.
  std::vector<HostSpec> hosts;
  // The identities of the API tools of MCP (mcp_identity.hpp): two entries for each host that has an mcp_uri,
  // which only a request with the internal token can name. Never listed, never health-checked.
  std::vector<HostSpec> mcp_hosts;

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
  // The connections lent at once for one ClickHouse URI (0 = no limit), and how long
  // a request waits for one before it fails with pool_exhausted.
  size_t client_pool_max_leased_per_uri = 128;
  int client_pool_lease_wait_ms = 5 * 1000;

  GeneratedQuerySettings generated_queries;
  AdmissionSettings admission;

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
  // The `observability` block: the settings of the three signals for every host. A request is served with the settings of
  // its host (HostSpec::otel), which are these with the override of the host applied.
  OtelSettings otel_defaults;
  // A signal is on when it is on for at least one host: the pages and the routes exist; each request answers for its host.
  bool traces_on() const {
    for (const auto& host : hosts) if (host.otel.traces.enabled) return true;
    return false;
  }
  bool logs_on() const {
    for (const auto& host : hosts) if (host.otel.logs.enabled) return true;
    return false;
  }
  bool metrics_on() const {
    for (const auto& host : hosts) if (host.otel.metrics.enabled) return true;
    return false;
  }
  ExportSettings export_settings;
  // The block being read (the table of keys writes into it); after loading, query_libraries holds the enabled ones in
  // the order of the file, and the first is the default.
  QueryLibrarySettings query_library;
  std::vector<QueryLibrarySettings> query_libraries;
  McpSettings mcp;

  // /api/version
  std::string version_semver = "dev";
  std::string version_git_sha = "unknown";
  std::string version_build_time = "unknown";
};

// Query library routes (api_query_library.cpp).
enum class QueryLibraryRoute {
  Get,
  QueryGet,
  Search,
  Export,
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
  KeyAccess,
  // How many databases and tables each key reaches, for the table of the page.
  AccessSummary,
};

struct FsStaticCache;

class Server {
public:
  explicit Server(AppConfig cfg, bool start_background = true);
  ~Server();

  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  int run();
  // Stops the server (any thread; main.cpp calls it on SIGTERM or SIGINT; docs/operations.md, "Shutdown"): the
  // readiness probe answers 503, a new run, export or stream answers 503 server_stopping, the running queries are
  // cancelled (KILL QUERY) and their streams end with an error event server_stopping, and the listening socket
  // closes. run() returns once the requests in progress have ended; the destructor then waits for the query
  // threads, at most server.shutdown_timeout_ms from the stop.
  void stop();
  bool stopping() const { return stopping_.load(std::memory_order_acquire); }

  // The API tools of MCP call the routes of the API in the process (docs/mcp.md, "API tools"): the handler of `request.path`
  // runs on the thread of the caller, with the context of an Mcp call (request_context.hpp), and the answer is read from
  // its response. No socket, no second worker: the call holds one place of the class Mcp (admission.hpp) and stops when
  // the caller goes away or the server stops.
  McpApiResponse call_mcp_api(const McpApiRequest& request);

  // A function that stop() calls (an export cancels its ClickHouse query with it). Returns its id for
  // remove_stop_hook; a hook added once the server stops runs at once.
  uint64_t add_stop_hook(std::function<void()> hook);
  void remove_stop_hook(uint64_t id);

private:
  // The hooks of every request (server_http.cpp): the request id, the refusals of a stopping server and the guard of
  // the writes before the routing; the access log and the metrics after it; the JSON answer of an exception.
  void install_http_hooks();
  httplib::Server::HandlerResponse before_routing(const httplib::Request& req, httplib::Response& res);
  void after_routing(const httplib::Request& req, httplib::Response& res);
  void handle_livez(const httplib::Request& req, httplib::Response& res);
  void handle_readyz(const httplib::Request& req, httplib::Response& res);
  void handle_metrics(const httplib::Request& req, httplib::Response& res);
  void log_stats();

  void handle_healthz(const httplib::Request& req, httplib::Response& res);
  void handle_api_version(const httplib::Request& req, httplib::Response& res);
  // /explorer/_monitoring[/<section>] and /explorer/_operations: a 302 to the
  // matching System address (relative, so a reverse-proxy prefix stays).
  void redirect_to_system(const httplib::Request& req, httplib::Response& res);
  // The query scope of a request of the pages (ch_query.hpp): log_comment "chdash:<path>" ("chdash-system"
  // for the System page), the deadline generated_queries.timeout_ms, generated_queries.max_memory_usage,
  // and "canceled" when the client closed the connection. `with_deadline` false: no deadline (MCP).
  ChQueryLimits request_limits(const httplib::Request& req, bool with_deadline = true) const;
  // The context of the request that this thread serves (request_context.hpp): its caller (a call of MCP keeps the one of its
  // outer scope), its route and the limits of its statements. A handler runs inside RequestScope(make_context(req)).
  RequestContext make_context(const httplib::Request& req, bool with_deadline = true) const;
  // A place for the heavy work of a request (admission.hpp): for the host that the request names, in its class. A request past
  // the limit waits (and stops waiting when the browser goes away or the server stops); when no place comes, the answer is
  // 503 server_busy and nothing is returned. A request that needs none (the limit is 0) always gets a ticket.
  std::optional<Admission::Ticket> admit(WorkClass work, const httplib::Request& req, httplib::Response& res);
  // The host that a request names, for the key of its place: its id when configured, else "-".
  std::string admission_host(const httplib::Request& req) const;

  // The bounds of user SQL outside of the Query page run (Deep Analyze): the ones of the query { } block.
  ChQueryLimits user_sql_limits(const httplib::Request& req, std::string log_comment) const;

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
  void handle_query_deep_analysis_status(const httplib::Request& req, httplib::Response& res);
  void handle_query_deep_analysis_cancel(const httplib::Request& req, httplib::Response& res);
  void handle_query_execution(const httplib::Request& req, httplib::Response& res);

  void handle_export_run(const httplib::Request& req, httplib::Response& res);
  void handle_export_stream(const httplib::Request& req, httplib::Response& res);
  void handle_export_stream_not_allowed(const httplib::Request& req, httplib::Response& res);

  void handle_explorer_catalog(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_table(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_table_data(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_graph(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_graph_definition(const httplib::Request& req, httplib::Response& res);
  std::unique_ptr<ChExecutor> open_explorer_executor(const std::string& uri, std::string* error);
  void handle_explorer_functions(const httplib::Request& req, httplib::Response& res);
  void handle_explorer_storage(const httplib::Request& req, httplib::Response& res);
  void handle_system_activity(const httplib::Request& req, httplib::Response& res);
  void handle_system_keeper(const httplib::Request& req, httplib::Response& res);
  void handle_system_overview(const httplib::Request& req, httplib::Response& res);
  void handle_system_series(const httplib::Request& req, httplib::Response& res);
  void handle_system_queries(const httplib::Request& req, httplib::Response& res);
  void handle_system_query(const httplib::Request& req, httplib::Response& res);
  void handle_system_disks(const httplib::Request& req, httplib::Response& res);
  // The connections of the System service: the system account of a host, and its runner account for the Queries.
  std::unique_ptr<ChExecutor> open_system_executor(const HostSpec& host, std::string* error);
  std::unique_ptr<ChExecutor> open_system_runner_executor(const HostSpec& host, std::string* error);
  // The formatter of a shape's text (system_query_format.hpp): the masked text on the runner account of the host, in the scope of the request.
  system_page::ShapeFormatReply format_shape_sql(const HostSpec& host, const std::string& masked_sql);

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
  // The connection of the Traces service to the trace source of a host (the system account); null with the reason in *error.
  std::unique_ptr<ChExecutor> open_trace_executor(const HostSpec& host, std::string* error);
  std::unique_ptr<ChExecutor> open_metrics_executor(const HostSpec& host, std::string* error);
  std::unique_ptr<ChExecutor> open_logs_executor(const HostSpec& host, std::string* error);
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

  AppConfig cfg_;
  RoutedServer http_;

  Admission admission_;
  std::unique_ptr<HealthRunner> health_;
  JwtService jwt_;
  std::shared_ptr<QueryRegistry> query_registry_;
  std::shared_ptr<ExportJobStore> export_jobs_;
  std::atomic<size_t> active_exports_{0};
  // The jobs of Deep Analyze: at most 16 kept, 64 MiB of results, each for 10 minutes after it ends (deep_analysis_jobs.hpp).
  DeepAnalysisJobs deep_jobs_{16, 64u * 1024u * 1024u, std::chrono::minutes(10)};
  std::atomic<size_t> active_host_streams_{0};
  std::atomic<size_t> active_query_streams_{0};
  std::shared_ptr<ClickHouseClientPool> client_pool_;
  std::unique_ptr<FormatCache> format_cache_;
  // One store per enabled query_library block, in the order of the file (the first is the default).
  std::vector<std::unique_ptr<QueryLibraryStore>> query_libraries_;
  // Only constructed when mcp.enabled = true. The database outlives the tools that use it.
  std::unique_ptr<McpKeyStore> mcp_keys_;
  std::unique_ptr<McpDatabase> mcp_db_;
  std::unique_ptr<McpApiClient> mcp_api_;
  std::unique_ptr<McpTools> mcp_tools_;
  McpRateLimiter mcp_rate_;

  std::mutex mu_;
  std::unordered_map<std::string, std::shared_ptr<QuerySession>> sessions_;

  // Shutdown (stop()): the state, its deadline, the hooks, and the query threads that the destructor waits for.
  std::atomic<bool> stopping_{false};
  std::atomic<int64_t> stop_deadline_ms_{0};  // steady clock
  std::mutex stop_hooks_mu_;
  std::map<uint64_t, std::function<void()>> stop_hooks_;
  uint64_t next_stop_hook_ = 0;
  std::shared_ptr<WorkerGroup> query_workers_ = std::make_shared<WorkerGroup>();

  // GET /metrics and the access log (server_http.cpp).
  std::shared_ptr<HttpMetrics> http_metrics_ = std::make_shared<HttpMetrics>();
  const std::chrono::system_clock::time_point started_at_ = std::chrono::system_clock::now();
  std::chrono::steady_clock::time_point last_stats_log_ = std::chrono::steady_clock::now();

  const bool background_enabled_ = true;
  std::atomic<bool> session_reaper_stop_{false};
  std::mutex session_reaper_mu_;
  std::condition_variable session_reaper_cv_;
  std::thread session_reaper_thread_;

  // ---- Caches (docs/configuration.md, "Caches and privileges"). They are declared after cfg_ and client_pool_, which
  // their fetches use; cache_refresher_ is the last member, so the background refreshes stop before anything goes.
  template <typename Value>
  typename TtlCache<std::string, Value>::Options cache_options(
      std::chrono::milliseconds ttl,
      std::chrono::milliseconds stale_for,
      size_t max_entries,
      size_t max_bytes,
      std::function<size_t(const Value&)> bytes = {}) {
    typename TtlCache<std::string, Value>::Options options;
    options.ttl = ttl;
    options.stale_for = stale_for;
    options.max_age = std::max<std::chrono::milliseconds>(ttl + stale_for, std::chrono::minutes(10));
    options.max_entries = max_entries;
    options.max_bytes = max_bytes;
    options.value_bytes = std::move(bytes);
    options.submit = [this](std::function<void()> task) { return cache_refresher_ && cache_refresher_->submit(std::move(task)); };
    return options;
  }
  AclService::Options acl_options();
  // The runner identity of a host for the ACL: refresh=1 of a page calls acl_.invalidate() with it.
  AclAccess runner_access(const HostSpec& host) const { return make_acl_access(client_pool_, host.runner_uri); }
  std::chrono::milliseconds explorer_ttl() const { return std::chrono::milliseconds(std::max(0, cfg_.explorer.cache_ttl_ms)); }
  // Live state (Activity, Keeper, Overview): never older than the Explorer TTL, at most one read a second per host.
  std::chrono::milliseconds live_ttl() const {
    return std::chrono::milliseconds(std::max(1000, std::min(cfg_.explorer.cache_ttl_ms, 5000)));
  }

  AclService acl_{acl_options()};
  // The files of a build without embedded assets (server.cpp).
  std::shared_ptr<FsStaticCache> fs_static_cache_;
  // One flush of the system logs is shared between the callers that need it (system_log_flush.hpp).
  SystemLogFlushGate system_log_flush_gate_;
  // The cached DDL texts and replica counts of the Explorer, the graph and the System activity.
  ExplorerCaches explorer_caches_;
  // The recent DESCRIBE plans of the runs (query_session.hpp).
  std::shared_ptr<DescribePlanCache> describe_plans_ = std::make_shared<DescribePlanCache>();
  TtlCache<std::string, MetaKeywords> meta_keywords_cache_{cache_options<MetaKeywords>(
      std::chrono::minutes(10), {}, 256, 16u << 20,
      [](const MetaKeywords& v) { return sizeof(v) + 64 * v.items.size(); })};
  TtlCache<std::string, MetaFunctions> meta_functions_cache_{cache_options<MetaFunctions>(
      std::chrono::minutes(10), {}, 256, 32u << 20,
      [](const MetaFunctions& v) { return sizeof(v) + 128 * v.items.size(); })};
  TtlCache<std::string, MetaCatalog> meta_catalog_cache_{cache_options<MetaCatalog>(
      std::chrono::minutes(10), {}, 2048, 64u << 20,
      [](const MetaCatalog& v) { return sizeof(v) + 192 * v.items.size(); })};
  // Browse uses a tiny identity-only catalog (one entry per host and database). Rich summaries are loaded only when a
  // table is opened or Graph needs them.
  TtlCache<std::string, ExplorerCatalog> explorer_catalog_list_cache_{cache_options<ExplorerCatalog>(
      explorer_ttl(), std::chrono::minutes(1), 4096, 64u << 20, cache_size::catalog)};
  TtlCache<std::string, ExplorerCatalog> explorer_catalog_cache_{cache_options<ExplorerCatalog>(
      explorer_ttl(), std::chrono::minutes(1), 256, 128u << 20, cache_size::catalog)};
  // Per-table detail is request-driven and expires after 30 s. There is no periodic refresh.
  TtlCache<std::string, ExplorerTableDetail> explorer_table_detail_cache_{cache_options<ExplorerTableDetail>(
      std::chrono::seconds(30), {}, 1024, 64u << 20, cache_size::table_detail)};
  TtlCache<std::string, ExplorerGraph> explorer_graph_cache_{cache_options<ExplorerGraph>(
      explorer_ttl(), std::chrono::minutes(1), 256, 128u << 20, cache_size::graph)};
  TtlCache<std::string, ExplorerFunctionsCatalog> explorer_functions_cache_{cache_options<ExplorerFunctionsCatalog>(
      std::chrono::milliseconds(std::max(1000, cfg_.explorer.function_cache_ttl_ms)), {}, 256, 64u << 20, cache_size::functions)};
  // Server-wide storage distribution for the Explorer System section.
  TtlCache<std::string, ExplorerStorageMap> explorer_storage_cache_{cache_options<ExplorerStorageMap>(
      explorer_ttl(), std::chrono::minutes(1), 256, 32u << 20, cache_size::storage)};

  // The Explorer service (explorer_service.hpp): the privileges of the runner, these caches, and the two connections of a read.
  explorer::ExplorerService explorer_service_{
      [this](const std::string& uri, std::string* error) { return open_explorer_executor(uri, error); },
      [this](const HostSpec& host) { return runner_access(host); }, acl_, explorer_caches_,
      explorer::ExplorerStores{explorer_catalog_list_cache_, explorer_catalog_cache_, explorer_table_detail_cache_, explorer_graph_cache_,
                               explorer_functions_cache_, explorer_storage_cache_}};
  // Short-lived snapshots shared by every viewer of a host, so an auto-refreshing page costs one read per TTL.
  TtlCache<std::string, SystemActivity> system_activity_cache_{cache_options<SystemActivity>(
      live_ttl(), std::chrono::seconds(10), 256, 32u << 20, cache_size::activity)};
  TtlCache<std::string, SystemKeeperStatus> system_keeper_cache_{cache_options<SystemKeeperStatus>(
      live_ttl(), std::chrono::seconds(10), 256, 8u << 20)};
  // What each host exposes: 10 min, 1 min while an optional log table is still missing (ClickHouse creates them at
  // their first flush), and a failed detection is not kept beyond the short back-off.
  TtlCache<std::string, MonitorCapabilities>::Options capabilities_cache_options();
  TtlCache<std::string, MonitorCapabilities> system_monitor_caps_cache_{capabilities_cache_options()};
  TtlCache<std::string, SystemMonitorOverview> system_monitor_overview_cache_{cache_options<SystemMonitorOverview>(
      live_ttl(), std::chrono::seconds(10), 256, 16u << 20)};
  // Performance: 15 s per host and aligned window (the step-aligned from / to), so relative windows refreshed within a
  // step share one read.
  TtlCache<std::string, SystemMonitorSeries> system_monitor_series_cache_{cache_options<SystemMonitorSeries>(
      std::chrono::seconds(15), {}, 256, 32u << 20, cache_size::series)};
  // Queries: 60 s per host, minute-aligned window and allowlisted choice (one read in flight per key); a drill-down
  // per shape the same way.
  TtlCache<std::string, SystemMonitorQueries> system_monitor_queries_cache_{cache_options<SystemMonitorQueries>(
      std::chrono::minutes(1), {}, 256, 32u << 20, cache_size::queries)};
  TtlCache<std::string, SystemMonitorQuery> system_monitor_query_cache_{cache_options<SystemMonitorQuery>(
      std::chrono::minutes(1), {}, 256, 32u << 20, cache_size::query)};
  // The formatted text of a shape: the layout depends on the text, the host and its version only, so 10 min per host and text, whatever the
  // window; a text that cannot be formatted is kept the same time (a failure of the host is not: it is asked again after 2 s).
  TtlCache<std::string, system_page::ShapeFormatted> system_shape_format_cache_{[this] {
    auto options = cache_options<system_page::ShapeFormatted>(std::chrono::minutes(10), {}, 512, 16u << 20, cache_size::shape_format);
    options.wait = std::chrono::seconds(20);
    return options;
  }()};
  // Disks: 60 s per host; their growth 5 min per host and aligned window.
  TtlCache<std::string, SystemMonitorDisks> system_monitor_disks_cache_{cache_options<SystemMonitorDisks>(
      std::chrono::minutes(1), {}, 256, 16u << 20)};
  TtlCache<std::string, SystemMonitorDiskGrowth> system_monitor_growth_cache_{cache_options<SystemMonitorDiskGrowth>(
      std::chrono::minutes(5), {}, 64, 16u << 20, cache_size::growth)};
  // The System service (system_service.hpp): the caches above are its caches.
  system_page::SystemService system_service_{
      system_page::SystemService::Ports{
          [this](const HostSpec& host, std::string* error) { return open_system_executor(host, error); },
          [this](const HostSpec& host, std::string* error) { return open_system_runner_executor(host, error); },
          [this](const HostSpec& host) { return runner_access(host); },
          [this](ChExecutor& db, const std::vector<std::pair<std::string, std::string>>& tables) {
            std::string error;
            std::unordered_map<std::string, SystemReplicaCounts> counts;
            for (const auto& [key, value] : load_cached_replica_counts(db, explorer_caches_, tables, &error)) {
              counts[key] = SystemReplicaCounts{value.total, value.active};
            }
            return counts;
          },
          [this](const HostSpec& host, const std::string& masked_sql) { return format_shape_sql(host, masked_sql); }},
      system_page::SystemCaches{system_monitor_caps_cache_, system_monitor_overview_cache_, system_monitor_series_cache_,
                                system_monitor_queries_cache_, system_monitor_query_cache_, system_shape_format_cache_, system_monitor_disks_cache_,
                                system_monitor_growth_cache_, system_activity_cache_, system_keeper_cache_},
      acl_};
  trace::PrefillCache trace_prefill_cache_{cache_options<trace::Prefill>(
      std::chrono::minutes(1), {}, 256, 64u << 20,
      [](const trace::Prefill& v) { return sizeof(v) + cache_size::pairs(v.pairs); })};
  trace::FacetKeysCache trace_facet_keys_cache_{cache_options<trace::FacetKeys>(
      std::chrono::milliseconds(kFacetTtlMs), {}, 512, 16u << 20,
      [](const trace::FacetKeys& v) { return sizeof(v) + 96 * v.keys.size(); })};
  trace::FacetValuesCache trace_facet_values_cache_{cache_options<trace::FacetValues>(
      std::chrono::milliseconds(kFacetTtlMs), {}, 1024, 16u << 20,
      [](const trace::FacetValues& v) { return sizeof(v) + cache_size::counted(v.values); })};
  logs::FacetKeysCache log_facet_keys_cache_{cache_options<logs::LogFacetKeys>(
      std::chrono::milliseconds(kFacetTtlMs), {}, 512, 16u << 20,
      [](const logs::LogFacetKeys& v) { return sizeof(v) + 96 * v.keys.size(); })};
  logs::FacetValuesCache log_facet_values_cache_{cache_options<logs::LogFacetValues>(
      std::chrono::milliseconds(kFacetTtlMs), {}, 1024, 16u << 20,
      [](const logs::LogFacetValues& v) { return sizeof(v) + cache_size::counted(v.values); })};

  // The catalog of the Metrics page: per host, source and minute-aligned window.
  metrics::CatalogCache metrics_catalog_cache_{cache_options<metrics::CatalogSnapshot>(
      std::chrono::minutes(1), {}, 256, 64u << 20, [](const metrics::CatalogSnapshot& v) { return metrics::snapshot_bytes(v); })};

  // What the Logs, Metrics and Traces-logs routes read about a source (otel_caches.hpp).
  SignalMetaCache signal_meta_cache_{signal_meta_cache_options()};
  LogsSchemaCache logs_schema_cache_{logs_schema_cache_options()};
  LogColumnsCache log_columns_cache_{log_columns_cache_options()};
  KindTablesCache kind_tables_cache_{kind_tables_cache_options()};

  // The Logs service (logs_service.hpp): the schema of the table and the facets are its caches.
  logs::LogsService logs_service_{[this](const HostSpec& host, std::string* error) { return open_logs_executor(host, error); },
                                  logs::LogsCaches{logs_schema_cache_, log_facet_keys_cache_, log_facet_values_cache_}};

  // The Metrics service (metrics_service.hpp): the catalog and the kind tables are its caches.
  metrics::MetricsService metrics_service_{[this](const HostSpec& host, std::string* error) { return open_metrics_executor(host, error); },
                                           metrics::MetricsCaches{metrics_catalog_cache_, kind_tables_cache_}};

  // The Traces service (trace_service.hpp) and the cache of its attribute columns.
  trace::AttributeMapCache trace_attribute_maps_cache_{trace::attribute_map_cache_options()};
  trace::TraceService trace_service_{[this](const HostSpec& host, std::string* error) { return open_trace_executor(host, error); },
                                     trace::TraceCaches{trace_attribute_maps_cache_, trace_prefill_cache_, trace_facet_keys_cache_,
                                                        trace_facet_values_cache_}};

  std::unique_ptr<CacheRefresher> cache_refresher_;
};

} // namespace chdash
