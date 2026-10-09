#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "serve_embedded_static.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <cctype>
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

// The former address of a query shape, /system/queries?q=<hash>: the Location
// of its page, relative to the request (queries/<hash>, under a reverse-proxy
// prefix too) with the other parameters kept as they came; empty when q is not
// a hash (digits, at most 20).
static std::string query_shape_location(const std::string& target, const std::string& hash) {
  if (hash.empty() || hash.size() > 20) return "";
  for (const char c : hash) {
    if (!std::isdigit(static_cast<unsigned char>(c))) return "";
  }
  std::string rest;
  if (const auto mark = target.find('?'); mark != std::string::npos) {
    size_t at = mark + 1;
    while (at <= target.size()) {
      auto end = target.find('&', at);
      if (end == std::string::npos) end = target.size();
      const std::string pair = target.substr(at, end - at);
      const bool shape = pair == "q" || pair.rfind("q=", 0) == 0;
      if (!pair.empty() && !shape) rest += (rest.empty() ? "?" : "&") + pair;
      at = end + 1;
    }
  }
  return "queries/" + hash + rest;
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
  if (path.empty() || path == "/") path = "/query.html";

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
  res.set_header("Cache-Control", cache_control_for(rel, req.has_param("v")));
  if (req.has_header("If-None-Match") && req.get_header_value("If-None-Match") == asset->etag) {
    res.status = 304;
    return true;
  }
  res.set_content(asset->body, asset->mime);
  return true;
}

// The health settings, with the tables that the system user reads for the features that the
// configuration turns on: the access audit (health_runner.hpp, HostAccess) checks them.
HealthSettings health_settings_for(const AppConfig& cfg) {
  HealthSettings settings = cfg.health;
  const auto add = [&](const std::string& database, const std::string& table) {
    if (!database.empty() && !table.empty()) settings.system_reads.push_back(database + "." + table);
  };
  if (cfg.traces.enabled) {
    add(cfg.traces.database, cfg.traces.table);
    add(cfg.traces.database, cfg.traces.trace_index_table);
  }
  if (cfg.logs.enabled) add(cfg.logs.database, cfg.logs.table);
  if (cfg.metrics.enabled) {
    for (const char* kind : {"gauge", "sum", "histogram"}) add(cfg.metrics.database, cfg.metrics.table_prefix + "_" + kind);
  }
  return settings;
}

} // namespace

Server::Server(AppConfig cfg, bool start_background)
    : cfg_(std::move(cfg)),
      health_(std::make_unique<HealthRunner>(cfg_.hosts, health_settings_for(cfg_))),
      jwt_(random_bytes(32)),
      query_registry_(std::make_shared<QueryRegistry>(
          std::chrono::milliseconds(cfg_.analysis.registry_ttl_ms),
          cfg_.analysis.registry_max_entries,
          cfg_.analysis.registry_sql_max_bytes)),
      export_jobs_(std::make_shared<ExportJobStore>(
          std::chrono::milliseconds(cfg_.export_settings.token_ttl_ms),
          cfg_.export_settings.pending_max_entries,
          cfg_.export_settings.pending_sql_max_bytes)),
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

  if (cfg_.query_library.enabled) {
    QueryLibraryOptions library;
    library.file = cfg_.query_library.file;
    for (const auto& host : cfg_.hosts) library.host_ids.push_back(host.id);
    library.writable = cfg_.query_library.writable;
    library.max_file_bytes = cfg_.query_library.max_file_bytes;
    library.max_query_bytes = cfg_.query_library.max_query_bytes;
    query_library_ = std::make_unique<QueryLibraryStore>(std::move(library));
  }

  if (cfg_.mcp.enabled) init_mcp();

  if (background_enabled_ && health_) health_->start();
  if (background_enabled_) {
    session_reaper_thread_ = std::thread([this] { session_reaper_loop(); });
  }

  const auto serve_query_shell = [&](const auto& req, auto& res) {
    httplib::Request shell_req = req;
    shell_req.path = "/query.html";
    if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res)) {
      res.status = 404;
      res.set_content("query.html not found", "text/plain");
    }
  };
  const auto serve_explorer_shell = [&](const auto& req, auto& res) {
    httplib::Request shell_req = req;
    shell_req.path = "/explorer.html";
    if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res)) {
      res.status = 404;
      res.set_content("explorer.html not found", "text/plain");
    }
  };

  // Traces, Logs and Metrics are three pages (traces.html, logs.html, metrics.html):
  // /observability/traces, /observability/logs, /observability/metrics; and
  // /observability sends the browser to the first enabled one. One trace is a
  // page of its own too (trace.html, /observability/traces/<trace id>).
  const auto serve_view_shell = [&](const char* file) {
    return [&, file](const auto& req, auto& res) {
      httplib::Request shell_req = req;
      shell_req.path = std::string("/") + file;
      if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res)) {
        res.status = 404;
        res.set_content(std::string(file) + " not found", "text/plain");
      }
    };
  };
  // Any other /observability address (the bare one, a view turned off, an unknown one): the first
  // enabled view, the query string kept. The Location is relative to the request, so a reverse-proxy
  // prefix is kept: "observability/<view>" from /observability, "<view>" from one segment below it.
  const auto redirect_to_first_view = [&](const auto& req, auto& res) {
    // The first enabled view. (No other local lambda is called from here: a handler outlives the
    // constructor, and a reference to one of its locals dangles.)
    std::string view;
    if (cfg_.traces.enabled) view = "traces";
    else if (cfg_.logs.enabled) view = "logs";
    else if (cfg_.metrics.enabled) view = "metrics";
    if (view.empty()) {
      res.status = 404;
      res.set_content("no observability view is enabled", "text/plain");
      return;
    }
    std::string location;
    static const std::string marker = "/observability/";
    const auto at = req.path.find(marker);
    if (at == std::string::npos) {
      location = "observability/" + view;  // the bare /observability
    } else {
      // One "../" per directory level below /observability/ (a trailing slash is one).
      const std::string below = req.path.substr(at + marker.size());
      for (const char c : below) {
        if (c == '/') location += "../";
      }
      location += view;
    }
    if (const auto mark = req.target.find('?'); mark != std::string::npos) location += req.target.substr(mark);
    res.status = 302;
    res.set_header("Location", location);
    res.set_header("Cache-Control", "no-store");
  };

  // One trace is a page of its own (trace.html): /observability/traces/<trace id>.
  const auto serve_trace_shell = [&](const auto& req, auto& res) {
    httplib::Request shell_req = req;
    shell_req.path = "/trace.html";
    if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res)) {
      res.status = 404;
      res.set_content("trace.html not found", "text/plain");
    }
  };

  // One query shape is a page of its own (shape.html): /system/queries/<hash>.
  const auto serve_shape_shell = [&](const auto& req, auto& res) {
    httplib::Request shell_req = req;
    shell_req.path = "/shape.html";
    if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res)) {
      res.status = 404;
      res.set_content("shape.html not found", "text/plain");
    }
  };

  // The System sections are three pages of their own (docs/system.md): /system
  // (system.html, the Overview), /system/queries (queries.html) and /system/disks
  // (disks.html). Any other /system/<name> goes to the Overview, the query string kept.
  const auto redirect_to_system_overview = [&](const auto& req, auto& res) {
    // One "../" per directory level below /system/ (a trailing slash is one), then "system".
    static const std::string marker = "/system/";
    std::string location = "../";
    if (const auto at = req.path.find(marker); at != std::string::npos) {
      for (const char c : req.path.substr(at + marker.size())) {
        if (c == '/') location += "../";
      }
    }
    location += "system";
    if (const auto mark = req.target.find('?'); mark != std::string::npos) location += req.target.substr(mark);
    res.status = 302;
    res.set_header("Location", location);
    res.set_header("Cache-Control", "no-store");
  };

  // A former /explorer address answers a redirect to `target`, an address below /explorer/, the query
  // string kept. The Location is relative to the request, so a reverse-proxy prefix is kept:
  // "explorer/<target>" from /explorer, one "../" per directory level below /explorer/ otherwise.
  const auto redirect_in_explorer = [&](const auto& req, auto& res, const std::string& target) {
    static const std::string marker = "/explorer/";
    std::string location;
    if (const auto at = req.path.find(marker); at == std::string::npos) {
      location = "explorer/";
    } else {
      for (const char c : req.path.substr(at + marker.size())) {
        if (c == '/') location += "../";
      }
    }
    location += target;
    if (const auto mark = req.target.find('?'); mark != std::string::npos) location += req.target.substr(mark);
    res.status = 302;
    res.set_header("Location", location);
    res.set_header("Cache-Control", "no-store");
  };

  http_.Get("/", serve_query_shell);
  http_.Get("/query", serve_query_shell);
  if (cfg_.system.enabled) {
    if (cfg_.system.top_queries_enabled()) {
      // Registered before /system/.*, which would answer them with the System page.
      http_.Get(R"(/system/queries/[0-9]{1,20}/?)", serve_shape_shell);
      // A handler keeps its own copy of the lambdas it calls (it outlives this constructor).
      http_.Get(R"(/system/queries/?)", [&, serve_view_shell](const auto& req, auto& res) {
        const auto location = query_shape_location(req.target, req.get_param_value("q"));
        if (location.empty()) {
          serve_view_shell("queries.html")(req, res);
          return;
        }
        res.status = 302;
        res.set_header("Location", location);
        res.set_header("Cache-Control", "no-store");
      });
    }
    http_.Get(R"(/system/?)", serve_view_shell("system.html"));
    http_.Get(R"(/system/disks/?)", serve_view_shell("disks.html"));
    http_.Get(R"(/system/.*)", redirect_to_system_overview);
    // The Explorer's former Monitoring tab (/explorer/_monitoring[/<section>])
    // and its v2.14.0 Server operations (/explorer/_operations) moved here:
    // the matching System address, the query string kept. Registered before
    // the Explorer's routes, so they win over /explorer/.*.
    http_.Get(R"(/explorer/_monitoring(/.*)?)", [&](const auto& req, auto& res) { redirect_to_system(req, res); });
    http_.Get("/explorer/_operations", [&](const auto& req, auto& res) { redirect_to_system(req, res); });
  }
  if (cfg_.explorer.enabled()) {
    // The Catalog (explorer.html) is /explorer/catalog[/<db>[/<table>[/<tab>]]] and Functions its own
    // page (functions.html) is /explorer/functions[/<name>]: two fixed prefixes, so a database named
    // "functions" or "catalog" is only ever /explorer/catalog/<name>.
    http_.Get(R"(/explorer/catalog(/.*)?)", serve_explorer_shell);
    http_.Get(R"(/explorer/functions(/[^/]+)?/?)", serve_view_shell("functions.html"));
    // /explorer/_system[?database=&table=] stays an alias of the storage views: the Catalog page
    // rewrites it to its canonical address.
    http_.Get("/explorer/_system", serve_explorer_shell);
    // The former addresses answer a redirect: /explorer/_functions[/<name>], and
    // /explorer[/<db>[/<table>[/<tab>]]] (with /explorer/databases, the Catalog root).
    http_.Get(R"(/explorer/_functions(/[^/]+)?/?)", [&, redirect_in_explorer](const auto& req, auto& res) {
      static const std::string prefix = "/explorer/_functions";
      redirect_in_explorer(req, res, "functions" + req.path.substr(req.path.find(prefix) + prefix.size()));
    });
    http_.Get(R"(/explorer/?)", [&, redirect_in_explorer](const auto& req, auto& res) { redirect_in_explorer(req, res, "catalog"); });
    http_.Get(R"(/explorer/(_monitoring|_operations)(/.*)?)", [&, redirect_in_explorer](const auto& req, auto& res) { redirect_in_explorer(req, res, "catalog"); });
    http_.Get(R"(/explorer/databases/?)", [&, redirect_in_explorer](const auto& req, auto& res) { redirect_in_explorer(req, res, "catalog"); });
    http_.Get(R"(/explorer/(.+))", [&, redirect_in_explorer](const auto& req, auto& res) {
      static const std::string marker = "/explorer/";
      redirect_in_explorer(req, res, "catalog/" + req.path.substr(req.path.find(marker) + marker.size()));
    });
  }
  if (cfg_.traces.enabled) {
    http_.Get(R"(/observability/traces/?)", serve_view_shell("traces.html"));
    http_.Get(R"(/observability/traces/[^/]+/?)", serve_trace_shell);
  }
  if (cfg_.logs.enabled) http_.Get(R"(/observability/logs/?)", serve_view_shell("logs.html"));
  if (cfg_.metrics.enabled) http_.Get(R"(/observability/metrics/?)", serve_view_shell("metrics.html"));
  if (cfg_.traces.enabled || cfg_.logs.enabled || cfg_.metrics.enabled) {
    http_.Get("/observability", redirect_to_first_view);
    http_.Get(R"(/observability/.*)", redirect_to_first_view);
  }

  // The MCP page shell is always served (its "MCP disabled" state shows the HCL to turn it on); 404 while mcp.html is absent.
  http_.Get("/mcp-integration", serve_view_shell("mcp.html"));

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
  http_.Post("/api/query/analysis", [&](const auto& req, auto& res) { handle_query_analysis(req, res); });
  http_.Post("/api/query/deep-analysis", [&](const auto& req, auto& res) { handle_query_deep_analysis(req, res); });
  http_.Get("/api/query/execution", [&](const auto& req, auto& res) { handle_query_execution(req, res); });

  http_.Post("/api/export/run", [&](const auto& req, auto& res) { handle_export_run(req, res); });
  http_.Get("/api/export/stream", [&](const auto& req, auto& res) { handle_export_stream(req, res); });

  if (cfg_.traces.enabled) {
    http_.Get("/api/traces/meta", [&](const auto& req, auto& res) { handle_traces_meta(req, res); });
    http_.Get("/api/traces/search", [&](const auto& req, auto& res) { handle_traces_search(req, res); });
    http_.Get("/api/traces/analytics", [&](const auto& req, auto& res) { handle_traces_analytics(req, res); });
    http_.Get("/api/traces/service_map", [&](const auto& req, auto& res) { handle_traces_service_map(req, res); });
    http_.Get("/api/traces/heatmap", [&](const auto& req, auto& res) { handle_traces_heatmap(req, res); });
    http_.Get("/api/traces/deltas", [&](const auto& req, auto& res) { handle_traces_deltas(req, res); });
    http_.Get("/api/traces/services", [&](const auto& req, auto& res) { handle_traces_services(req, res); });
    http_.Get("/api/traces/services/db", [&](const auto& req, auto& res) { handle_traces_services_db(req, res); });
    http_.Get("/api/traces/prefill", [&](const auto& req, auto& res) { handle_traces_prefill(req, res); });
    http_.Get("/api/traces/facets", [&](const auto& req, auto& res) { handle_traces_facets(req, res); });
    http_.Get("/api/traces/facet_values", [&](const auto& req, auto& res) { handle_traces_facet_values(req, res); });
    http_.Get("/api/traces/trace", [&](const auto& req, auto& res) { handle_trace_detail(req, res); });
    http_.Get("/api/traces/linked_from", [&](const auto& req, auto& res) { handle_traces_linked_from(req, res); });
    http_.Get("/api/traces/context", [&](const auto& req, auto& res) { handle_traces_context(req, res); });
    http_.Get("/api/traces/spans", [&](const auto& req, auto& res) { handle_traces_spans(req, res); });
    http_.Get("/api/traces/span", [&](const auto& req, auto& res) { handle_traces_span(req, res); });
    // Answers {"enabled": false, ...} when logs are disabled (no 404).
    http_.Get("/api/traces/logs", [&](const auto& req, auto& res) { handle_trace_logs(req, res); });
  }

  // Always registered: when logs/metrics are disabled the meta routes answer
  // {"enabled": false, ...} so a UI can explain why instead of seeing a 404.
  http_.Get("/api/logs/meta", [&](const auto& req, auto& res) { handle_logs_meta(req, res); });
  http_.Get("/api/metrics/meta", [&](const auto& req, auto& res) { handle_metrics_meta(req, res); });
  if (cfg_.logs.enabled) {
    http_.Get("/api/logs/search", [&](const auto& req, auto& res) { handle_logs_search(req, res); });
    http_.Get("/api/logs/histogram", [&](const auto& req, auto& res) { handle_logs_histogram(req, res); });
    http_.Get("/api/logs/context", [&](const auto& req, auto& res) { handle_logs_context(req, res); });
    http_.Get("/api/logs/patterns", [&](const auto& req, auto& res) { handle_logs_patterns(req, res); });
    http_.Get("/api/logs/services", [&](const auto& req, auto& res) { handle_logs_services(req, res); });
    http_.Get("/api/logs/facets", [&](const auto& req, auto& res) { handle_logs_facets(req, res); });
    http_.Get("/api/logs/facet_values", [&](const auto& req, auto& res) { handle_logs_facet_values(req, res); });
  }
  if (cfg_.metrics.enabled) {
    http_.Get("/api/metrics/catalog", [&](const auto& req, auto& res) { handle_metrics_catalog(req, res); });
    http_.Get("/api/metrics/attributes", [&](const auto& req, auto& res) { handle_metrics_attributes(req, res); });
    http_.Get("/api/metrics/series", [&](const auto& req, auto& res) { handle_metrics_series(req, res); });
    http_.Get("/api/metrics/exemplars", [&](const auto& req, auto& res) { handle_metrics_exemplars(req, res); });
  }

  // Query library: every route is absent (404) unless query_library.enabled.
  // There is no history route: the history of the runs is the browser's.
  if (cfg_.query_library.enabled) {
    const auto library = [this](QueryLibraryRoute route) {
      return [this, route](const httplib::Request& req, httplib::Response& res) { handle_query_library(req, res, route); };
    };
    http_.Get("/api/query-library", library(QueryLibraryRoute::Get));
    http_.Post("/api/query-library/folders", library(QueryLibraryRoute::FolderCreate));
    http_.Patch(R"(/api/query-library/folders/([A-Za-z0-9_.\-]+))", library(QueryLibraryRoute::FolderUpdate));
    http_.Delete(R"(/api/query-library/folders/([A-Za-z0-9_.\-]+))", library(QueryLibraryRoute::FolderDelete));
    http_.Post("/api/query-library/queries", library(QueryLibraryRoute::QueryCreate));
    http_.Patch(R"(/api/query-library/queries/([A-Za-z0-9_.\-]+))", library(QueryLibraryRoute::QueryUpdate));
    http_.Delete(R"(/api/query-library/queries/([A-Za-z0-9_.\-]+))", library(QueryLibraryRoute::QueryDelete));
    http_.Post("/api/query-library/import", library(QueryLibraryRoute::Import));
  }

  // MCP (docs/mcp.md): the endpoint and its page exist only when mcp.enabled; the
  // /api/mcp routes always answer (meta says enabled: false, the others 404 mcp_disabled).
  {
    const auto mcp_api = [this](McpApiRoute route) {
      return [this, route](const httplib::Request& req, httplib::Response& res) { handle_api_mcp(req, res, route); };
    };
    http_.Get("/api/mcp/meta", mcp_api(McpApiRoute::Meta));
    http_.Get("/api/mcp/keys", mcp_api(McpApiRoute::KeysList));
    http_.Post("/api/mcp/keys", mcp_api(McpApiRoute::KeyCreate));
    http_.Delete(R"(/api/mcp/keys/([A-Za-z0-9_.\-]+))", mcp_api(McpApiRoute::KeyDelete));
    http_.Get(R"(/api/mcp/keys/([A-Za-z0-9_.\-]+)/secret)", mcp_api(McpApiRoute::KeyReveal));
    http_.Get(R"(/api/mcp/keys/([A-Za-z0-9_.\-]+)/access)", mcp_api(McpApiRoute::KeyAccess));
  }
  if (cfg_.mcp.enabled) {
    http_.Post("/mcp", [this](const httplib::Request& req, httplib::Response& res, const httplib::ContentReader& reader) {
      handle_mcp_post(req, res, reader);
    });
    const auto not_allowed = [this](const httplib::Request& req, httplib::Response& res) { handle_mcp_not_allowed(req, res); };
    http_.Get("/mcp", not_allowed);
    http_.Delete("/mcp", not_allowed);
    http_.Put("/mcp", not_allowed);
    http_.Patch("/mcp", not_allowed);
  }

  // The System page (docs/system.md): fixed, bounded system-table reads of
  // the selected host. system.enabled = false removes the page and every route.
  if (cfg_.system.enabled) {
    http_.Get("/api/system/overview", [&](const auto& req, auto& res) { handle_system_overview(req, res); });
    http_.Get("/api/system/series", [&](const auto& req, auto& res) { handle_system_series(req, res); });
    http_.Get("/api/system/disks", [&](const auto& req, auto& res) { handle_system_disks(req, res); });
    // Queries (runner context): system.top_queries.
    if (cfg_.system.top_queries_enabled()) {
      http_.Get("/api/system/queries", [&](const auto& req, auto& res) { handle_system_queries(req, res); });
      http_.Get(R"(/api/system/queries/([^/]+))", [&](const auto& req, auto& res) { handle_system_query(req, res); });
    }
    // Activity and Keeper keep the v2.14.0 addresses of the Explorer's
    // Server operations as aliases (/api/explorer/ops/activity and
    // /api/explorer/ops/keeper, docs/configuration.md).
    if (cfg_.system.activity_enabled()) {
      const auto activity = [&](const auto& req, auto& res) { handle_system_activity(req, res); };
      http_.Get("/api/system/activity", activity);
      http_.Get("/api/explorer/ops/activity", activity);
    }
    if (cfg_.system.keeper_enabled()) {
      const auto keeper = [&](const auto& req, auto& res) { handle_system_keeper(req, res); };
      http_.Get("/api/system/keeper", keeper);
      http_.Get("/api/explorer/ops/keeper", keeper);
    }
  }

  if (cfg_.explorer.enabled()) {
    http_.Get("/api/explorer/catalog", [&](const auto& req, auto& res) { handle_explorer_catalog(req, res); });
    http_.Get("/api/explorer/table", [&](const auto& req, auto& res) { handle_explorer_table(req, res); });
    http_.Post("/api/explorer/table/data", [&](const auto& req, auto& res) { handle_explorer_table_data(req, res); });
    http_.Get("/api/explorer/functions", [&](const auto& req, auto& res) { handle_explorer_functions(req, res); });
    http_.Get("/api/explorer/storage", [&](const auto& req, auto& res) { handle_explorer_storage(req, res); });
    if (cfg_.explorer.graph_enabled()) {
      http_.Get("/api/explorer/graph", [&](const auto& req, auto& res) { handle_explorer_graph(req, res); });
      http_.Get("/api/explorer/graph/definition", [&](const auto& req, auto& res) { handle_explorer_graph_definition(req, res); });
    }
  }

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

void Server::stop() { http_.stop(); }

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

// The Explorer's former Monitoring tab and Server operations live on the
// System page: /explorer/_monitoring opens the Overview, its Performance and
// Activity sections the Overview's part of that name (#performance,
// #activity), Queries and Disks their sections; /explorer/_operations is
// Activity. The query string is kept as it came. The Location is relative to
// the request, so the address stays under a reverse-proxy prefix.
void Server::redirect_to_system(const httplib::Request& req, httplib::Response& res) {
  static const std::string monitoring = "/explorer/_monitoring/";
  std::string section;
  if (req.path.rfind(monitoring, 0) == 0) {
    section = req.path.substr(monitoring.size());
    while (!section.empty() && section.back() == '/') section.pop_back();
    for (auto& c : section) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  } else if (req.path == "/explorer/_operations") {
    section = "activity";
  }
  std::string target = "system";
  std::string fragment;
  if (section == "queries" || section == "disks") target += "/" + section;
  else if (section == "performance" || section == "activity") fragment = "#" + section;
  std::string location;
  const auto depth = std::count(req.path.begin(), req.path.end(), '/');
  for (long i = 1; i < static_cast<long>(depth); ++i) location += "../";
  location += target;
  if (const auto query = req.target.find('?'); query != std::string::npos) location += req.target.substr(query);
  location += fragment;
  res.status = 302;
  res.set_header("Location", location);
  res.set_header("Cache-Control", "no-store");
}

void Server::handle_api_version(const httplib::Request&, httplib::Response& res) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("name"); w.String("clickhouse-dash");
  w.Key("version"); w.String(cfg_.version_semver.c_str());
  w.Key("git_sha"); w.String(cfg_.version_git_sha.c_str());
  w.Key("build_time"); w.String(cfg_.version_build_time.c_str());
  w.Key("features");
  w.StartObject();
  w.Key("explorer");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.explorer.enabled());
  w.Key("browse"); w.Bool(cfg_.explorer.browse);
  w.Key("graph");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.explorer.graph_enabled());
  w.Key("lineage"); w.Bool(cfg_.explorer.lineage);
  w.Key("storage_topology"); w.Bool(cfg_.explorer.storage_topology);
  w.EndObject();
  // v2.14.0 reported its Server operations here: the System page's
  // Activity and Keeper now.
  w.Key("operations");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.system.activity_enabled());
  w.Key("keeper"); w.Bool(cfg_.system.keeper_enabled());
  w.EndObject();
  w.EndObject();
  // The System page and the windows its history parts may ask for.
  w.Key("system");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.system.enabled);
  w.Key("activity"); w.Bool(cfg_.system.activity_enabled());
  w.Key("keeper"); w.Bool(cfg_.system.keeper_enabled());
  w.Key("top_queries"); w.Bool(cfg_.system.top_queries_enabled());
  w.Key("cluster_fanout"); w.Bool(cfg_.system.enabled && cfg_.system.cluster_fanout);
  w.Key("default_lookback_minutes"); w.Int(cfg_.system.default_lookback_minutes);
  w.Key("max_lookback_days"); w.Int(cfg_.system.max_lookback_days);
  w.Key("query_log_max_lookback_hours"); w.Int(cfg_.system.query_log_max_lookback_hours);
  w.Key("disk_growth_days"); w.Int(cfg_.system.disk_growth_days);
  w.EndObject();
  w.Key("traces");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.traces.enabled);
  w.EndObject();
  w.Key("logs");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.logs.enabled);
  w.Key("body_search"); w.String(cfg_.logs.body_search.c_str());
  w.EndObject();
  w.Key("metrics");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.metrics.enabled);
  w.EndObject();
  // writable is the effective state: false when the file failed to load.
  w.Key("query_library");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.query_library.enabled);
  w.Key("writable"); w.Bool(query_library_ ? query_library_->writable() : false);
  w.EndObject();
  w.Key("mcp");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.mcp.enabled);
  w.EndObject();
  w.EndObject();
  w.EndObject();
  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
