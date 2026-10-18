#pragma once

#include "access_pdp.hpp"
#include "access_settings.hpp"
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
#include "mcp_cost.hpp"
#include "mcp_creator_access.hpp"
#include "mcp_keys.hpp"
#include "mcp_tools.hpp"
#include "mcp_usage.hpp"
#include "otel_caches.hpp"
#include "otel_settings.hpp"
#include "otlp_export.hpp"
#include "query_library.hpp"
#include "query_session.hpp"
#include "query_registry.hpp"
#include "request_context.hpp"
#include "routed_server.hpp"
#include "cache_sizes.hpp"
#include "explorer_catalog.hpp"
#include "system_log_flush.hpp"
#include "telemetry_settings.hpp"
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
#include <unordered_set>
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
  // The discovery of the runner of a host (CHECK GRANT) is kept for this long.
  // After this time, the old result is served while one refresh runs. That refresh lasts for as long again.
  // refresh=1 reads the discovery again at once.
  int acl_cache_ttl_ms = 60 * 1000;
  int live_refresh_ms = 2000;
  int function_cache_ttl_ms = 60 * 60 * 1000;
  // Markdown links in ClickHouse function documentation are disabled by default.
  // When enabled, the browser still accepts only ClickHouse-relative references (/... or ./...).
  // The browser strips every arbitrary external URL.
  bool function_markdown_links = false;
};

// The server-side query library holds folders and saved queries. They are stored in one JSON file.
// The library is disabled by default. Then the browser keeps its localStorage library.
// The history of the runs is always kept by the browser. See docs/query-library.md.
struct QueryLibrarySettings {
  bool enabled = false;
  // The API names a library by its id (?library=). The UI shows the name of the library.
  // The first library is the default library. It needs no name ("default"). The other libraries need a name.
  std::string name;
  std::string file;
  // false: only GET is allowed.
  // Folder and query create, edit, move, delete and import answer 403 read_only.
  bool writable = false;
  size_t max_file_bytes = 8 * 1024 * 1024;
  size_t max_query_bytes = 256 * 1024;

};

// The usage of each key (docs/mcp.md, "Usage of a key"), from the mcp { usage { } } block.
// It is off by default. Then nothing is counted.
struct McpUsageSettings {
  bool enabled = false;
  // Where the usage is kept: "files" (a directory that several ChDash can share). A database comes later.
  std::string storage = "files";
  // The directory of the files. This value is required when the usage is on.
  std::string dir;
  // The name of this ChDash in the files: [A-Za-z0-9._-], at most 64 bytes.
  // An empty value means the host name. The loader of the configuration fills it.
  std::string instance;
  // The number of days of usage kept for each key. The usage is kept also after the key is deleted.
  int64_t retention_days = 90;
  // Set to true to let a key read the usage of all the keys, of all the instances.
  // These are the tools of MCP: mcp_analysis_all_usage.
  bool all_keys = false;
};

  // The MCP endpoint (POST /mcp), its keys and its limits (docs/mcp.md).
  // It is off by default. Every limit is a global cap. A key can only lower a limit.
struct McpSettings {
  bool enabled = false;
  // The JSON file of the keys that are made on the MCP page. An empty value means no keys from the UI.
  std::string storage_file;
  // The older form of keys.mode (deprecated). false is the static mode, and true is the hybrid mode.
  // Never use it together with keys.mode.
  bool manage_from_ui = true;
  // mcp.keys.mode has these values. static uses the keys of the configuration.
  // dynamic uses the keys of the page. hybrid uses both.
  McpKeysMode keys_mode = McpKeysMode::Hybrid;
  McpUsageSettings usage;
  // The request header that carries the key. "Authorization" takes "Bearer <key>".
  // Use another name when a proxy in front already uses Authorization. That header takes the key alone, or "Bearer <key>".
  std::string auth_header = "Authorization";
  int64_t max_rows = 1000;
  int64_t max_result_bytes = 1048576;
  int64_t query_timeout_seconds = 30;
  int64_t max_sql_bytes = 65536;
  int64_t max_memory_bytes = 1073741824;
  // The value 0 means no limit.
  int64_t max_rows_to_read = 0;
  // This limit applies to each key. The value 0 means no limit.
  int64_t rate_limit_per_minute = 600;
  // Origins (scheme://host[:port]) that may call from a browser.
  // A request without an Origin header is always accepted. A request with an Origin that is not listed gets a 403.
  std::vector<std::string> allowed_origins;
  // The keys of the `mcp_key "name" { }` blocks and of the older `key { }` blocks.
  // The server reads these keys at start. It never writes them back.
  std::vector<McpKey> keys;
  // The name of this instance in the call log (mcp.call, field `instance`).
  // The value is mcp.usage.instance when it is set. Otherwise it is the host name of the machine.
  std::string instance;
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
  // The ClickHouse bounds of each exported statement.
  // The value 0 uses the settings profile of the runner.
  int64_t max_execution_time_s = 0;
  uint64_t max_memory_usage = 0;
  // A statement that sends nothing (no data, no progress) for this long fails.
  // The value 0 means no limit.
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

// The capacity of the HTTP server (the server { } block).
// A stream (Server-Sent Events, an export) holds one worker thread for as long as it lasts.
// So the pool grows with the work, up to max_worker_threads.
// When the pool is full, requests wait in a bounded queue. When the queue is also full, the server closes the connection.
// The server does not let a connection wait without end.
struct ServerLimits {
  size_t worker_threads = 0;        // threads kept ready; 0 = max(8, hardware threads)
  size_t max_worker_threads = 256;  // threads at most (the pool grows with the load, idle ones exit)
  size_t max_queued_requests = 1024;
  size_t max_body_bytes = 0;        // largest request body; 0 = from query.max_sql_bytes and the query library
  size_t max_host_streams = 64;     // open host status streams (one per visible page); past it, pages poll
// The time that one write of a response may wait for a client that does not read.
// Examples are a paused download and a slow disk.
// After this time, the response ends. For an export or a run, that cancels it.
  int write_timeout_ms = 120 * 1000;
// A stop (SIGTERM, SIGINT) drains the server for at most this long (docs/operations.md, "Shutdown").
// After this time, the process exits with status 1.
  int shutdown_timeout_ms = 10 * 1000;
// GET /metrics gives the Prometheus text format (docs/operations.md, "Metrics").
  bool metrics = true;
// The server writes one log line for each request (docs/operations.md, "Logs").
// The probes that succeed are left out.
  bool access_log = true;
// The server writes a "server.stats" log line at this interval.
// The value 0 means never.
  int stats_log_interval_ms = 5 * 60 * 1000;
};

// The amount of heavy work that runs at once (docs/operations.md, "Admission").
// A request past a limit waits `wait_ms`. Then the server refuses it with 503 server_busy.
// The value 0 means no limit.
struct AdmissionSettings {
  size_t heavy_per_host = 16;    // reads of the Explorer, System, Traces, Logs and Metrics pages, for each ClickHouse host
  size_t analysis_per_host = 1;  // Query Analysis and Deep Analyze (they read the logs of a run or run it again), for each host
  size_t mcp_max = 8;            // calls of the API tools of MCP, in all
  int wait_ms = 5000;
};

enum class WorkClass { Heavy, Analysis, Mcp };

// The bounds of the queries that ChDash writes itself.
// These bounds apply to every page except the Run of the Query page and the export (the generated_queries { } block).
// Each statement of a request gets max_execution_time = what remains of timeout_ms, and max_memory_usage.
// Neither bound is ever looser than the settings profile of the ClickHouse user (ch_query.hpp).
struct GeneratedQuerySettings {
  int timeout_ms = 60 * 1000;
  uint64_t max_memory_usage = uint64_t{4} * 1024 * 1024 * 1024;  // 0 = the settings profile
  // The rows that one statement of a page may read. The value 0 uses the settings profile.
  // A statement that would read more fails with <page>_scan_limit.
  // The preview of a table and the catalog of the metrics stop at this limit instead. They say so.
  uint64_t max_rows_to_read = uint64_t{20} * 1000 * 1000 * 1000;
};

struct AppConfig {
  std::string listen = "0.0.0.0:8080";
  ServerLimits server;


  // The ClickHouse hosts (multi-host).
  // Each HostSpec contains a runner_uri and a system_uri.
  std::vector<HostSpec> hosts;
  // The identities of the API tools of MCP (mcp_identity.hpp).
  // The list has two entries for each host that has an mcp_uri. Only a request with the internal token can name these entries.
  // The server never lists these entries and never health-checks them.
  std::vector<HostSpec> mcp_hosts;

  // The settings of the health runner.
  HealthSettings health;

  // The number of result rows to stream before the output is truncated. The value 0 means unlimited.
  int result_preview_row_limit = 0;
  size_t query_max_sql_bytes = 4 * 1024 * 1024;

  // The knobs of the native TCP query execution. The defaults give a low interactive latency.
  QuerySessionOptions query_options;

  // The lifecycle of the native TCP pool.
  // The server closes idle sockets before ClickHouse or an intermediary reaches its receive or idle timeout.
  // The server validates a reused socket only after a meaningful idle period.
  // This keeps the hot path free of an extra round trip.
  size_t client_pool_max_idle_per_key = 4;
  int client_pool_idle_ttl_ms = 60 * 1000;
  int client_pool_validate_after_idle_ms = 15 * 1000;
  int client_pool_reaper_interval_ms = 5 * 1000;
  // The number of connections lent at once for one ClickHouse URI. The value 0 means no limit.
  // The time that a request waits for a connection before it fails with pool_exhausted.
  size_t client_pool_max_leased_per_uri = 128;
  int client_pool_lease_wait_ms = 5 * 1000;

  GeneratedQuerySettings generated_queries;
  AdmissionSettings admission;

  // Editor actions often trigger SQL formatting.
  // Cache the deterministic results. This avoids a ClickHouse round trip and a formatter pass.
  size_t format_cache_max_entries = 512;
  size_t format_cache_max_bytes = 16 * 1024 * 1024;
  int format_cache_ttl_ms = 10 * 60 * 1000;

  // Protect the process from abandoned /api/query/run calls, whose SSE stream is never opened.
  // Also limit the memory of the concurrent queries.
  size_t query_session_max_count = 256;
  int query_session_abandoned_ttl_ms = 60 * 1000;
  int query_session_terminal_ttl_ms = 30 * 1000;
  int query_session_reaper_interval_ms = 5 * 1000;

  // The lifetime of the internal cancel capability.
  // A server restart also invalidates the tokens, because the signing secret is generated at boot.
  int cancel_token_ttl_ms = 48 * 60 * 60 * 1000;

  // The settings of the Explorer, the analysis and the export features.
  ExplorerSettings explorer;
  SystemSettings system;
  AnalysisSettings analysis;
  // The `observability` block has the settings of the three signals for every host.
  // A request is served with the settings of its host (HostSpec::otel).
  // These settings are the values of this block, with the override of the host applied.
  OtelSettings otel_defaults;
  // A signal is on when it is on for at least one host.
  // The pages and the routes of a signal exist in that case. Each request answers for its host.
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
  // The block that the loader reads. The table of keys writes into it.
  // After loading, query_libraries holds the enabled libraries, in the order of the file.
  // The first library is the default.
  QueryLibrarySettings query_library;
  std::vector<QueryLibrarySettings> query_libraries;
  McpSettings mcp;
  // The telemetry { } block sets the OTLP export of the spans and of the call log of MCP (docs/server-telemetry.md).
  TelemetrySettings telemetry;
  // The access { } block sets the identity token and the PDP for the access of humans (docs/access.md).
  AccessSettings access;

  // This map gives the source of each value that the file sets.
  // The key is the name that --print-config shows, for example "server.listen",
  // "clickhouse.host[prod].runner_password" or "query_library[team].file".
  // The source is "file", "env:VAR" or "file:/path".
  // A name that is not in this map has its default value (config_schema.cpp).
  std::map<std::string, std::string> value_sources;

  // The warnings of the start. Examples are a deprecated block, a key with an older token, and a key file that the static mode does not read.
  // main.cpp writes each warning to the log as config.warning.
  // --print-config writes the warnings to the standard error.
  std::vector<std::string> warnings;

  // The values that /api/version returns.
  std::string version_semver = "dev";
  std::string version_git_sha = "unknown";
  std::string version_build_time = "unknown";
};

// The routes of the query library (api_query_library.cpp).
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

// The routes of the MCP page (api_mcp.cpp).
enum class McpApiRoute {
  Meta,
  KeysList,
  KeyCreate,
  KeyDelete,
  // A person adopts a key of the page that has no creator, or whose creator the PDP does not know any more.
  KeyAdopt,
  KeyAccess,
  // The number of databases and tables that each key reaches. The page shows them in a table.
  AccessSummary,
  // The usage of every key in a window (the Used column). The usage of one key is also here (its details).
  Usage,
  KeyUsage,
  // The requests of every key, cut by method, result and type. The page can filter them (the Usage tab).
  UsageOverview,
  // The cost of the statements of one key for ClickHouse.
  // The server reads it from system.query_log (api_mcp_cost.cpp).
  KeyCost,
};

struct FsStaticCache;

class Server {
public:
  explicit Server(AppConfig cfg, bool start_background = true);
  ~Server();

  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  int run();
  // Stop the server. Any thread can call it. main.cpp calls it on SIGTERM or SIGINT (docs/operations.md, "Shutdown").
  // The readiness probe answers 503. A new run, export or stream answers 503 server_stopping.
  // The running queries are cancelled (KILL QUERY). Their streams end with an error event server_stopping.
  // The listening socket closes.
  //
  // run() returns when the requests in progress have ended.
  // The destructor then waits for the query threads, at most server.shutdown_timeout_ms from the stop.
  void stop();
  bool stopping() const { return stopping_.load(std::memory_order_acquire); }

  // The API tools of MCP call the routes of the API in the process (docs/mcp.md, "API tools").
  // The handler of `request.path` runs on the thread of the caller, with the context of an Mcp call (request_context.hpp).
  // The answer is read from the response of the handler.
  // No socket and no second worker are used.
  // The call holds one place of the class Mcp (admission.hpp). It stops when the caller goes away or the server stops.
  McpApiResponse call_mcp_api(const McpApiRequest& request);

  // Add a function that stop() calls. An export uses it to cancel its ClickHouse query.
  // The function returns an id for remove_stop_hook. A hook that is added after the server stops runs at once.
  uint64_t add_stop_hook(std::function<void()> hook);
  void remove_stop_hook(uint64_t id);

private:
  // The hooks of every request (server_http.cpp) handle the request id.
  // They also refuse the requests of a stopping server, and they guard the writes before the routing.
  // After the routing, the hooks write the access log and the metrics.
  // The hooks also make the JSON answer of an exception.
  void install_http_hooks();
  httplib::Server::HandlerResponse before_routing(const httplib::Request& req, httplib::Response& res);
  void after_routing(const httplib::Request& req, httplib::Response& res);
  // The access of humans (docs/access.md, server_http.cpp).
  // before_routing calls check_access for each request of the socket.
  // check_access checks the identity token (401). Then it asks the PDP for the decision on the action of the route (403).
  // It returns true when it answered.
  bool check_access(const httplib::Request& req, httplib::Response& res, const std::string& request_id);
  // Return the decisions of the subject of this request for `questions`.
  // This makes one call to the PDP for the questions that its cache does not answer.
  std::vector<AccessDecision> access_decide(const std::vector<AccessQuestion>& questions);
  // Use this function for a route whose rule is Deferred (the database is in the body).
  // Return the decision of `action` on `database`. Return false after the function writes the 403.
  // Return true when no check applies, for example in the open mode or for a call of MCP.
  bool access_allows(httplib::Response& res, const char* action, const std::string& database);
  // Return true when the subject of this request passes every question. Else write the 403 of the first refused action, and
  // return false. Return true when no check applies.
  bool access_allows_all(httplib::Response& res, const std::vector<AccessQuestion>& questions);
  // Write the 403 of a refused action (docs/access.md, "Enforcement").
  static void access_forbidden(httplib::Response& res, const std::string& action);
  // The databases of `databases` that the subject of this request may read: one batch asks each action of `actions` on the
  // service and on each database. A database passes when one action is true on it or on the service.
  // Return nullopt when every database passes: no check applies, or an action is true on the service.
  std::optional<std::unordered_set<std::string>> access_readable_databases(const std::vector<const char*>& actions,
                                                                          const std::vector<std::string>& databases);
  // Return the decision of `action` on the service for the subject of this request.
  // The page uses it to show or hide a control. Return true when no check applies.
  bool access_permits(const char* action);
  // Return true when the statements of this request must run with readonly = 1.
  // This is the case when the subject has query.run.read and not query.run.write.
  // It is also the case for an export (query.export and query.run.read) without query.run.write.
  bool access_read_only() const;
  // Return the access part of /api/version, as a JSON object.
  // The object has the mode, the subject and the decisions for every action on the service.
  // The server makes one batch for each page.
  std::string access_json();
  // Return the name of this server for the PDP (access.identity.audience).
  // The name is "chdash" in the open mode.
  std::string access_server_name() const;
  void init_access();
  // The state of the access check belongs to the thread that serves the request.
  // before_routing resets this state first.
  static void reset_access_state();
  // Return the subject of the request that this thread serves.
  // The subject is empty in the open mode and before the check.
  static std::string access_subject();
  static std::string access_subject_or_dash();

  void handle_livez(const httplib::Request& req, httplib::Response& res);
  void handle_readyz(const httplib::Request& req, httplib::Response& res);
  void handle_metrics(const httplib::Request& req, httplib::Response& res);
  void log_stats();

  void handle_healthz(const httplib::Request& req, httplib::Response& res);
  void handle_api_version(const httplib::Request& req, httplib::Response& res);
  // These routes are /explorer/_monitoring[/<section>] and /explorer/_operations.
  // They send a 302 to the matching System address. The address is relative, so a reverse-proxy prefix stays.
  void redirect_to_system(const httplib::Request& req, httplib::Response& res);
  // Return the query scope of a request of the pages (ch_query.hpp).
  // The scope has log_comment "chdash:<path>" ("chdash-system" for the System page).
  // It has the deadline generated_queries.timeout_ms and generated_queries.max_memory_usage.
  // It has "canceled" when the client closed the connection.
  // When `with_deadline` is false, there is no deadline (MCP).
  ChQueryLimits request_limits(const httplib::Request& req, bool with_deadline = true) const;
  // Return the context of the request that this thread serves (request_context.hpp).
  // The context has its caller, its route and the limits of its statements.
  // A call of MCP keeps the caller of its outer scope.
  // A handler runs inside RequestScope(make_context(req)).
  RequestContext make_context(const httplib::Request& req, bool with_deadline = true) const;
  // Return a place for the heavy work of a request (admission.hpp).
  // The place is for the host that the request names, in its class.
  // A request past the limit waits. It stops the wait when the browser goes away or the server stops.
  // When no place comes, the answer is 503 server_busy, and nothing is returned.
  // A request that needs no place (the limit is 0) always gets a ticket.
  std::optional<Admission::Ticket> admit(WorkClass work, const httplib::Request& req, httplib::Response& res);
  // This overload works the same, for a host that the handler finds itself.
  // A route that names no host_id uses it. For example, the cost of an MCP key reads the host of the key.
  std::optional<Admission::Ticket> admit(WorkClass work, const std::string& host_id, const httplib::Request& req, httplib::Response& res);
  // Return the place itself. This function writes no answer.
  // The wait ends when `stop` says so. The cost of a key that an MCP tool reads has no route to answer (api_mcp_cost.cpp).
  std::optional<Admission::Ticket> acquire_ticket(WorkClass work, const std::string& host_id, const std::function<bool()>& stop);
  // admit() answers 503 server_busy when no place came. It answers server_stopping when the server stops.
  void send_no_place(httplib::Response& res);
  // Return the host that a request names, for the key of its place.
  // The id is used when it is configured. Otherwise the value is "-".
  std::string admission_host(const httplib::Request& req) const;

  // The bounds of user SQL outside of the Query page run (Deep Analyze).
  // These bounds are the ones of the query { } block.
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
  // The connections of the System service.
  // These are the system account of a host and its runner account for the Queries.
  std::unique_ptr<ChExecutor> open_system_executor(const HostSpec& host, std::string* error);
  std::unique_ptr<ChExecutor> open_system_runner_executor(const HostSpec& host, std::string* error);
  // The formatter of a shape's text (system_query_format.hpp).
  // It formats the masked text with the runner account of the host, in the scope of the request.
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
  // Return the connection of the Traces service to the trace source of a host (the system account).
  // Return null when the connection fails. The reason is in *error.
  std::unique_ptr<ChExecutor> open_trace_executor(const HostSpec& host, std::string* error);
  std::unique_ptr<ChExecutor> open_metrics_executor(const HostSpec& host, std::string* error);
  std::unique_ptr<ChExecutor> open_logs_executor(const HostSpec& host, std::string* error);
  // Span-level search uses keyset pages over newest-first time slices.
  // It also gets one span by its row key, for the search page's Spans mode.
  void handle_traces_spans(const httplib::Request& req, httplib::Response& res);
  void handle_traces_span(const httplib::Request& req, httplib::Response& res);

  // Detect the schema of the OTel logs and metrics (api_otel_signals.cpp).
  void handle_logs_meta(const httplib::Request& req, httplib::Response& res);
  // Return the logs of one trace for the trace detail page (api_trace_logs.cpp).
  void handle_trace_logs(const httplib::Request& req, httplib::Response& res);
  void handle_logs_search(const httplib::Request& req, httplib::Response& res);
  void handle_logs_histogram(const httplib::Request& req, httplib::Response& res);
  void handle_logs_context(const httplib::Request& req, httplib::Response& res);
  void handle_logs_patterns(const httplib::Request& req, httplib::Response& res);
  void handle_logs_services(const httplib::Request& req, httplib::Response& res);
  void handle_logs_facets(const httplib::Request& req, httplib::Response& res);
  void handle_logs_facet_values(const httplib::Request& req, httplib::Response& res);
  void handle_metrics_meta(const httplib::Request& req, httplib::Response& res);

  // The OTel metrics browser (api_metrics.cpp).
  void handle_metrics_catalog(const httplib::Request& req, httplib::Response& res);
  void handle_metrics_attributes(const httplib::Request& req, httplib::Response& res);
  void handle_metrics_series(const httplib::Request& req, httplib::Response& res);
  void handle_metrics_exemplars(const httplib::Request& req, httplib::Response& res);

  // The server-side query library (api_query_library.cpp). This code never runs SQL.
  void handle_query_library(const httplib::Request& req, httplib::Response& res, QueryLibraryRoute route);

  // MCP (api_mcp.cpp) handles POST /mcp and the key routes of the MCP page.
  // The endpoint and the keys exist only when mcp.enabled = true.
  // The route /api/mcp/meta always answers.
  void init_mcp();
  // Set up the OTLP exporter of the telemetry { } block (docs/server-telemetry.md).
  // The constructor calls this function when telemetry.enabled is true.
  void init_telemetry();
  void handle_mcp_post(const httplib::Request& req, httplib::Response& res, const httplib::ContentReader& reader);
  // Save the usage of the MCP keys. The reaper loop calls this function.
  // With force = false, the function saves the file of this instance when a minute has passed and something changed.
  // It saves the files of the other instances when a minute has passed.
  // With force = true, at the stop, it saves the file of this instance now.
  void save_mcp_usage(bool force);
  void handle_mcp_not_allowed(const httplib::Request& req, httplib::Response& res);
  void handle_api_mcp(const httplib::Request& req, httplib::Response& res, McpApiRoute route);
  // Handle GET /api/mcp/keys/<id>/cost (api_mcp_cost.cpp).
  // handle_api_mcp calls this function after the guard of the page.
  void handle_mcp_key_cost(const httplib::Request& req, httplib::Response& res, int64_t now);
  // Return the cost of a key, as the page and the tool read it (api_mcp_cost.cpp).
  // The function uses a 60 s cache. On a cache miss, it reads system.query_log with the runner account of the host.
  // This read holds a place of heavy work.
  //
  // The field `json` is the answer. The field `busy` is true when no place came in time.
  // The field `stopping` is true when the server stops. When either field is true, nothing was read, and `json` is empty.
  //
  // When `for_page` is true, the answer is for the page. It has the text of an error and the GRANT statement.
  // Otherwise the answer is for the tool. It has neither, because they are for the administrator.
  struct McpCostAnswer {
    std::string json;
    std::string status;  // "ok", or why there is no cost (no_host, not_granted, window_too_large, ...): for the audit line
    bool busy = false;
    bool stopping = false;
  };
  McpCostAnswer answer_mcp_cost(const std::string& key_id, const std::string& host_id, const McpCostWindow& window, bool refresh, bool for_page,
                                const std::function<bool()>& stop, int64_t now);
  // Return the cost of the key that an MCP tool asks for, for a window of its usage.
  // The result is a JSON object. When there is no cost, the object says why (api_mcp_cost.cpp).
  std::string mcp_tool_cost(const McpKey& key, const std::string& usage_window, int64_t now);
  // Return what the configuration turns on for the tools that need the usage (mcp_scope.hpp).
  // The usage is counted, and all the keys may be read.
  McpToolAvailability mcp_tool_availability() const;
  // The analysis tools reach the usage, the rate limit and the cost through this port (api_mcp.cpp).
  // They never reach Server itself.
  class McpAnalysisPort;

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
  // The jobs of Deep Analyze (deep_analysis_jobs.hpp).
  // The server keeps at most 16 jobs and 64 MiB of results. Each job is kept for 10 minutes after it ends.
  DeepAnalysisJobs deep_jobs_{16, 64u * 1024u * 1024u, std::chrono::minutes(10)};
  std::atomic<size_t> active_host_streams_{0};
  std::atomic<size_t> active_query_streams_{0};
  std::shared_ptr<ClickHouseClientPool> client_pool_;
  std::unique_ptr<FormatCache> format_cache_;
  // One store for each enabled query_library block, in the order of the file.
  // The first store is the default.
  std::vector<std::unique_ptr<QueryLibraryStore>> query_libraries_;
  // The server constructs this member only when mcp.enabled = true.
  // The database outlives the tools that use it.
  std::unique_ptr<McpKeyStore> mcp_keys_;
  // The usage of each key (mcp_usage.hpp).
  // handle_mcp_post counts the usage. The reaper saves it every minute and at the stop.
  // The pointer is null when the usage is off (mcp.usage.enabled = false). Then nothing is counted.
  std::unique_ptr<McpUsage> mcp_usage_;
  std::unique_ptr<McpDatabase> mcp_db_;
  std::unique_ptr<McpApiClient> mcp_api_;
  std::unique_ptr<McpAnalysis> mcp_analysis_;
  std::unique_ptr<McpTools> mcp_tools_;
  McpRateLimiter mcp_rate_;

  std::mutex mu_;
  std::unordered_map<std::string, std::shared_ptr<QuerySession>> sessions_;

  // The shutdown (stop()) uses these members: the state, its deadline, the hooks and the query threads.
  // The destructor waits for the query threads.
  std::atomic<bool> stopping_{false};
  std::atomic<int64_t> stop_deadline_ms_{0};  // steady clock
  std::mutex stop_hooks_mu_;
  std::map<uint64_t, std::function<void()>> stop_hooks_;
  uint64_t next_stop_hook_ = 0;
  std::shared_ptr<WorkerGroup> query_workers_ = std::make_shared<WorkerGroup>();

  // The metrics of GET /metrics and of the access log (server_http.cpp).
  std::shared_ptr<HttpMetrics> http_metrics_ = std::make_shared<HttpMetrics>();
  // The metric mcp_server_operation_duration_seconds covers the requests of POST /mcp (api_mcp.cpp).
  McpOperationMetrics mcp_metrics_;
  // The access of humans (docs/access.md). These pointers are null in the open mode.
  std::unique_ptr<IdentityVerifier> identity_;
  std::unique_ptr<PdpClient> pdp_;
  // The access of humans for the MCP keys of the page (mcp_creator_access.hpp). Set in the authzen mode when MCP is on.
  std::unique_ptr<McpCreatorAccess> mcp_creator_;
  // The OTLP export of the spans and of the call log of MCP. The pointer is null when telemetry.enabled is false.
  // A request only puts its items in the queue of the exporter.
  // The destructor sends the items that wait, within the time of the stop.
  std::unique_ptr<OtlpExporter> telemetry_;
  const std::chrono::system_clock::time_point started_at_ = std::chrono::system_clock::now();
  std::chrono::steady_clock::time_point last_stats_log_ = std::chrono::steady_clock::now();

  const bool background_enabled_ = true;
  std::atomic<bool> session_reaper_stop_{false};
  std::mutex session_reaper_mu_;
  std::condition_variable session_reaper_cv_;
  std::thread session_reaper_thread_;

  // ---- Caches (docs/configuration.md, "Caches and privileges").
  // The caches are declared after cfg_ and client_pool_, because their fetches use these members.
  // cache_refresher_ is the last member. So the background refreshes stop before anything else is destroyed.
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
  // The runner identity of a host for the ACL. A page with refresh=1 calls acl_.invalidate() with it.
  AclAccess runner_access(const HostSpec& host) const { return make_acl_access(client_pool_, host.runner_uri); }
  std::chrono::milliseconds explorer_ttl() const { return std::chrono::milliseconds(std::max(0, cfg_.explorer.cache_ttl_ms)); }
  // The live state (Activity, Keeper, Overview) is never older than the Explorer TTL.
  // The server reads it at most once a second for each host.
  std::chrono::milliseconds live_ttl() const {
    return std::chrono::milliseconds(std::max(1000, std::min(cfg_.explorer.cache_ttl_ms, 5000)));
  }

  AclService acl_{acl_options()};
  // The files of a build that has no embedded assets (server.cpp).
  std::shared_ptr<FsStaticCache> fs_static_cache_;
  // The callers that need a flush of the system logs share one flush (system_log_flush.hpp).
  SystemLogFlushGate system_log_flush_gate_;
  // These caches hold the DDL texts and replica counts of the Explorer, the graph and the System activity.
  ExplorerCaches explorer_caches_;
  // This cache holds the recent DESCRIBE plans of the runs (query_session.hpp).
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
  // Browse uses a small catalog that holds only the identity (one entry for each host and database).
  // The rich summaries are loaded only when a table is opened or when Graph needs them.
  TtlCache<std::string, ExplorerCatalog> explorer_catalog_list_cache_{cache_options<ExplorerCatalog>(
      explorer_ttl(), std::chrono::minutes(1), 4096, 64u << 20, cache_size::catalog)};
  TtlCache<std::string, ExplorerCatalog> explorer_catalog_cache_{cache_options<ExplorerCatalog>(
      explorer_ttl(), std::chrono::minutes(1), 256, 128u << 20, cache_size::catalog)};
  // The detail of each table comes from a request, and it expires after 30 s.
  // There is no periodic refresh.
  TtlCache<std::string, ExplorerTableDetail> explorer_table_detail_cache_{cache_options<ExplorerTableDetail>(
      std::chrono::seconds(30), {}, 1024, 64u << 20, cache_size::table_detail)};
  TtlCache<std::string, ExplorerGraph> explorer_graph_cache_{cache_options<ExplorerGraph>(
      explorer_ttl(), std::chrono::minutes(1), 256, 128u << 20, cache_size::graph)};
  TtlCache<std::string, ExplorerFunctionsCatalog> explorer_functions_cache_{cache_options<ExplorerFunctionsCatalog>(
      std::chrono::milliseconds(std::max(1000, cfg_.explorer.function_cache_ttl_ms)), {}, 256, 64u << 20, cache_size::functions)};
  // The storage distribution of the whole server. The Explorer System section uses it.
  TtlCache<std::string, ExplorerStorageMap> explorer_storage_cache_{cache_options<ExplorerStorageMap>(
      explorer_ttl(), std::chrono::minutes(1), 256, 32u << 20, cache_size::storage)};

  // The Explorer service (explorer_service.hpp) uses the privileges of the runner, these caches, and two connections for a read.
  explorer::ExplorerService explorer_service_{
      [this](const std::string& uri, std::string* error) { return open_explorer_executor(uri, error); },
      [this](const HostSpec& host) { return runner_access(host); }, acl_, explorer_caches_,
      explorer::ExplorerStores{explorer_catalog_list_cache_, explorer_catalog_cache_, explorer_table_detail_cache_, explorer_graph_cache_,
                               explorer_functions_cache_, explorer_storage_cache_}};
  // These short-lived snapshots are shared by every viewer of a host.
  // So an auto-refreshing page costs one read for each TTL.
  TtlCache<std::string, SystemActivity> system_activity_cache_{cache_options<SystemActivity>(
      live_ttl(), std::chrono::seconds(10), 256, 32u << 20, cache_size::activity)};
  TtlCache<std::string, SystemKeeperStatus> system_keeper_cache_{cache_options<SystemKeeperStatus>(
      live_ttl(), std::chrono::seconds(10), 256, 8u << 20)};
  // This cache keeps what each host exposes, for 10 min.
  // It keeps the result for 1 min while an optional log table is still missing. ClickHouse creates such a table at its first flush.
  // A failed detection is not kept beyond the short back-off.
  TtlCache<std::string, MonitorCapabilities>::Options capabilities_cache_options();
  TtlCache<std::string, MonitorCapabilities> system_monitor_caps_cache_{capabilities_cache_options()};
  TtlCache<std::string, SystemMonitorOverview> system_monitor_overview_cache_{cache_options<SystemMonitorOverview>(
      live_ttl(), std::chrono::seconds(10), 256, 16u << 20)};
  // Performance: 15 s for each host and aligned window (the step-aligned from and to).
  // So relative windows that refresh within a step share one read.
  TtlCache<std::string, SystemMonitorSeries> system_monitor_series_cache_{cache_options<SystemMonitorSeries>(
      std::chrono::seconds(15), {}, 256, 32u << 20, cache_size::series)};
  // Queries: 60 s for each host, minute-aligned window and allowlisted choice (one read in flight for each key).
  // A drill-down for each shape works the same way.
  TtlCache<std::string, SystemMonitorQueries> system_monitor_queries_cache_{cache_options<SystemMonitorQueries>(
      std::chrono::minutes(1), {}, 256, 32u << 20, cache_size::queries)};
  // The cost of an MCP key: 60 s for each host, key and window (one read in flight for each key).
  // The parameter refresh=1 reads again.
  TtlCache<std::string, McpCost> mcp_cost_cache_{cache_options<McpCost>(
      std::chrono::minutes(1), {}, 256, 8u << 20, [](const McpCost& value) { return sizeof(McpCost) + value.rows.size() * 160 + value.tables.size() * 96; })};
  TtlCache<std::string, SystemMonitorQuery> system_monitor_query_cache_{cache_options<SystemMonitorQuery>(
      std::chrono::minutes(1), {}, 256, 32u << 20, cache_size::query)};
  // The formatted text of a shape. The layout depends only on the text, the host and its version.
  // So the server keeps the result for 10 min for each host and text, whatever the window.
  // A text that cannot be formatted is kept for the same time.
  // A failure of the host is not kept. The server asks again after 2 s.
  TtlCache<std::string, system_page::ShapeFormatted> system_shape_format_cache_{[this] {
    auto options = cache_options<system_page::ShapeFormatted>(std::chrono::minutes(10), {}, 512, 16u << 20, cache_size::shape_format);
    options.wait = std::chrono::seconds(20);
    return options;
  }()};
  // Disks: 60 s for each host.
  // The growth of the disks: 5 min for each host and aligned window.
  TtlCache<std::string, SystemMonitorDisks> system_monitor_disks_cache_{cache_options<SystemMonitorDisks>(
      std::chrono::minutes(1), {}, 256, 16u << 20)};
  TtlCache<std::string, SystemMonitorDiskGrowth> system_monitor_growth_cache_{cache_options<SystemMonitorDiskGrowth>(
      std::chrono::minutes(5), {}, 64, 16u << 20, cache_size::growth)};
  // The System service (system_service.hpp) uses the caches above.
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

  // The catalog of the Metrics page, for each host, source and minute-aligned window.
  metrics::CatalogCache metrics_catalog_cache_{cache_options<metrics::CatalogSnapshot>(
      std::chrono::minutes(1), {}, 256, 64u << 20, [](const metrics::CatalogSnapshot& v) { return metrics::snapshot_bytes(v); })};

  // These caches hold what the Logs, Metrics and Traces-logs routes read about a source (otel_caches.hpp).
  SignalMetaCache signal_meta_cache_{signal_meta_cache_options()};
  LogsSchemaCache logs_schema_cache_{logs_schema_cache_options()};
  LogColumnsCache log_columns_cache_{log_columns_cache_options()};
  KindTablesCache kind_tables_cache_{kind_tables_cache_options()};

  // The Logs service (logs_service.hpp) uses the schema of the table and the facets as its caches.
  logs::LogsService logs_service_{[this](const HostSpec& host, std::string* error) { return open_logs_executor(host, error); },
                                  logs::LogsCaches{logs_schema_cache_, log_facet_keys_cache_, log_facet_values_cache_}};

  // The Metrics service (metrics_service.hpp) uses the catalog and the kind tables as its caches.
  metrics::MetricsService metrics_service_{[this](const HostSpec& host, std::string* error) { return open_metrics_executor(host, error); },
                                           metrics::MetricsCaches{metrics_catalog_cache_, kind_tables_cache_}};

  // The Traces service (trace_service.hpp) has a cache for its attribute columns.
  trace::AttributeMapCache trace_attribute_maps_cache_{trace::attribute_map_cache_options()};
  trace::TraceService trace_service_{[this](const HostSpec& host, std::string* error) { return open_trace_executor(host, error); },
                                     trace::TraceCaches{trace_attribute_maps_cache_, trace_prefill_cache_, trace_facet_keys_cache_,
                                                        trace_facet_values_cache_}};

  std::unique_ptr<CacheRefresher> cache_refresher_;
};

} // namespace chdash
