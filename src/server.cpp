#include "server.hpp"

#include "api_error.hpp"
#include "host_util.hpp"
#include "json_parse.hpp"
#include "ch_uri.hpp"
#include "log.hpp"
#include "mcp_grants.hpp"
#include "secure_random.hpp"
#include "serve_embedded_static.hpp"
#include "json_text.hpp"

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
#include <string>
#include <vector>

namespace chdash {

struct FsStaticAsset {
  std::string body;
  std::string mime;
  std::string etag;
  // The SHA-256 of the body in hexadecimal: a ?v= that starts it is the version of these bytes.
  std::string content_hash;
  std::filesystem::file_time_type modified{};
  uintmax_t size = 0;
};

// The files that a build without embedded assets served, kept until they change on disk (Server owns it).
struct FsStaticCache {
  std::mutex mu;
  std::unordered_map<std::string, std::shared_ptr<FsStaticAsset>> assets;
};

namespace {

static int64_t steady_now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
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

// The query-string parameter that says a redirect was not a move but an address that has no page: the page shows a notice with the
// address that was asked for (app_route_notice.js) and takes the parameter off the address bar. The path is cut and percent-encoded.
static std::string redirected_from_parameter(const std::string& path) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  std::string out = "redirected_from=";
  for (const unsigned char ch : path.substr(0, 200)) {
    const bool plain = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == '~';
    if (plain) {
      out.push_back(static_cast<char>(ch));
    } else {
      out.push_back('%');
      out.push_back(kHex[ch >> 4]);
      out.push_back(kHex[ch & 0x0f]);
    }
  }
  return out;
}

// `location` with the query string of the request kept, and the marker added.
static std::string with_query_and_marker(std::string location, const httplib::Request& req) {
  if (const auto mark = req.target.find('?'); mark != std::string::npos) location += req.target.substr(mark);
  location += location.find('?') == std::string::npos ? '?' : '&';
  location += redirected_from_parameter(req.path);
  return location;
}

#ifdef CHDASH_EMBED_STATIC
// A build with embedded assets serves only them: no file of the disk is ever an answer.
static bool try_serve_fs(const httplib::Request&, httplib::Response&, FsStaticCache&) { return false; }
#else
static std::int64_t file_time_nanoseconds(std::filesystem::file_time_type value) {
  const auto nanoseconds = std::chrono::duration_cast<std::chrono::nanoseconds>(
      value.time_since_epoch());
  return static_cast<std::int64_t>(nanoseconds.count());
}

// A relative asset path that stays inside the static directory: one or more segments of
// printable characters, none empty, "." or "..", no backslash and no colon. (An absolute
// path would replace the base: path("./static") / "/etc/passwd" is "/etc/passwd".)
static bool safe_static_rel(const std::string& rel) {
  if (rel.empty() || rel.size() > 512) return false;
  size_t start = 0;
  while (start <= rel.size()) {
    size_t end = rel.find('/', start);
    if (end == std::string::npos) end = rel.size();
    const std::string_view segment(rel.data() + start, end - start);
    if (segment.empty() || segment == "." || segment == "..") return false;
    for (const char c : segment) {
      const auto u = static_cast<unsigned char>(c);
      if (u < 0x20 || u == 0x7f || c == '\\' || c == ':') return false;
    }
    start = end + 1;
  }
  return true;
}

// The static directory of a build without embedded assets (./static, next to the working
// directory), resolved once; empty when it does not exist.
static const std::filesystem::path& fs_static_root() {
  static const std::filesystem::path root = [] {
    std::error_code ec;
    auto resolved = std::filesystem::canonical("./static", ec);
    return ec ? std::filesystem::path() : resolved;
  }();
  return root;
}

static bool try_serve_fs(const httplib::Request& req, httplib::Response& res, FsStaticCache& cache) {
  std::string path = req.path;
  if (path.empty() || path == "/") path = "/query.html";

  std::string rel;
  if (path.rfind("/static/", 0) == 0) rel = path.substr(std::string("/static/").size());
  else if (!path.empty() && path[0] == '/') rel = path.substr(1);
  else rel = path;

  if (!safe_static_rel(rel)) return false;
  const std::filesystem::path& root = fs_static_root();
  if (root.empty()) return false;

  // The resolved file must still be under the root (a symbolic link may point anywhere).
  std::error_code ec;
  const std::filesystem::path full = std::filesystem::canonical(root / rel, ec);
  if (ec) return false;
  const auto [root_end, full_at] = std::mismatch(root.begin(), root.end(), full.begin(), full.end());
  if (root_end != root.end() || full_at == full.end()) return false;
  if (!std::filesystem::is_regular_file(full, ec)) return false;
  const auto modified = std::filesystem::last_write_time(full, ec);
  if (ec) return false;
  const uintmax_t size = std::filesystem::file_size(full, ec);
  if (ec) return false;

  std::shared_ptr<FsStaticAsset> asset;
  const std::string cache_key = full.lexically_normal().string();
  {
    std::lock_guard<std::mutex> lk(cache.mu);
    auto it = cache.assets.find(cache_key);
    if (it != cache.assets.end() && it->second->modified == modified && it->second->size == size) {
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
      const auto digest = sha256_digest(reinterpret_cast<const uint8_t*>(loaded->body.data()), loaded->body.size());
      static constexpr char kHex[] = "0123456789abcdef";
      for (const uint8_t b : digest) {
        loaded->content_hash.push_back(kHex[b >> 4]);
        loaded->content_hash.push_back(kHex[b & 15]);
      }
      cache.assets[cache_key] = loaded;
      asset = std::move(loaded);
    }
  }

  res.set_header("ETag", asset->etag);
  const bool html = rel.size() > 5 && rel.compare(rel.size() - 5, 5, ".html") == 0;
  if (!html && req.has_param("v") && !asset_version_matches(req.get_param_value("v"), asset->content_hash)) {
    res.set_header("Cache-Control", "no-store");
  } else {
    res.set_header("Cache-Control", cache_control_for(rel, req.has_param("v") && !html));
  }
  // A shell runs its inline scripts: the policy of the page lists their hashes (http_guard.hpp).
  if (html) set_page_security_policy(res, asset->body);
  if (req.has_header("If-None-Match") && req.get_header_value("If-None-Match") == asset->etag) {
    res.status = 304;
    return true;
  }
  res.set_content(asset->body, asset->mime);
  return true;
}
#endif

// The health settings, with the tables that the system user reads for the features that the
// configuration turns on: the access audit (health_runner.hpp, HostAccess) checks them.
HealthSettings health_settings_for(const AppConfig& cfg) {
  // The OpenTelemetry tables that the system user must read are the ones of each host (audit_access reads them from the
  // host), so the settings hold only what is the same for every host.
  HealthSettings settings = cfg.health;
  if (cfg.mcp.enabled) {
    // What each tool needs from the MCP user is in mcp_grants.hpp; the audit checks all of it.
    settings.mcp_audit = true;
    settings.mcp_reads = mcp_user_reads();
  }
  return settings;
}

} // namespace

AclService::Options Server::acl_options() {
  AclService::Options options;
  options.ttl = std::chrono::milliseconds(std::max(0, cfg_.explorer.acl_cache_ttl_ms));
  options.stale_for = options.ttl;
  options.submit = [this](std::function<void()> task) { return cache_refresher_ && cache_refresher_->submit(std::move(task)); };
  return options;
}

Server::Server(AppConfig cfg, bool start_background)
    : cfg_(std::move(cfg)),
      health_(std::make_unique<HealthRunner>(cfg_.hosts, health_settings_for(cfg_))),
      jwt_(secure_random_bytes(32)),
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
          std::chrono::milliseconds(cfg_.client_pool_reaper_interval_ms),
          cfg_.client_pool_max_leased_per_uri,
          std::chrono::milliseconds(cfg_.client_pool_lease_wait_ms))),
      format_cache_(std::make_unique<FormatCache>(
          cfg_.format_cache_max_entries,
          cfg_.format_cache_max_bytes,
          std::chrono::milliseconds(cfg_.format_cache_ttl_ms))),
      background_enabled_(start_background) {
  fs_static_cache_ = std::make_shared<FsStaticCache>();

  if (cfg_.query_library.enabled) {
    QueryLibraryOptions library;
    library.file = cfg_.query_library.file;
    for (const auto& host : cfg_.hosts) library.host_ids.push_back(host.id);
    library.writable = cfg_.query_library.writable;
    library.max_file_bytes = cfg_.query_library.max_file_bytes;
    library.max_query_bytes = cfg_.query_library.max_query_bytes;
    query_library_ = std::make_unique<QueryLibraryStore>(std::move(library));
  }

  // The threads of the background cache refreshes (stale-while-revalidate): two, and a short queue.
  cache_refresher_ = std::make_unique<CacheRefresher>(2, 64);

  if (cfg_.mcp.enabled) init_mcp();

  // The capacity of the HTTP server (ServerLimits): a pool that grows with the streams in progress,
  // a bounded queue, and a bounded request body, refused (413) before it is read.
  {
    const ServerLimits limits = cfg_.server;
    const std::shared_ptr<HttpMetrics> metrics = http_metrics_;
    http_.new_task_queue = [limits, metrics] {
      return new MeteredTaskQueue(limits.worker_threads, limits.max_worker_threads, limits.max_queued_requests, metrics);
    };
    http_.set_payload_max_length(limits.max_body_bytes);
    http_.set_write_timeout(std::chrono::milliseconds(limits.write_timeout_ms));
  }
  install_http_hooks();

  if (background_enabled_ && health_) health_->start();
  if (background_enabled_) {
    session_reaper_thread_ = std::thread([this] { session_reaper_loop(); });
  }

  const auto serve_query_shell = [&](const auto& req, auto& res) {
    httplib::Request shell_req = req;
    shell_req.path = "/query.html";
    if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res, *fs_static_cache_)) {
      res.status = 404;
      res.set_content("query.html not found", "text/plain");
    }
  };
  const auto serve_explorer_shell = [&](const auto& req, auto& res) {
    httplib::Request shell_req = req;
    shell_req.path = "/explorer.html";
    if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res, *fs_static_cache_)) {
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
      if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res, *fs_static_cache_)) {
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
    if (cfg_.traces_on()) view = "traces";
    else if (cfg_.logs_on()) view = "logs";
    else if (cfg_.metrics_on()) view = "metrics";
    if (view.empty()) {
      res.status = 404;
      res.set_content("no observability view is enabled", "text/plain");
      return;
    }
    std::string location;
    static const std::string marker = "/observability/";
    const auto at = req.path.find(marker);
    bool no_page = false;  // an address that has no page: a view that is turned off, a name that is not one
    if (at == std::string::npos) {
      location = "observability/" + view;  // the bare /observability
    } else {
      // One "../" per directory level below /observability/ (a trailing slash is one).
      const std::string below = req.path.substr(at + marker.size());
      for (const char c : below) {
        if (c == '/') location += "../";
      }
      location += view;
      no_page = !below.empty();
    }
    // The bare /observability is a move, not a mistake; the other addresses carry the marker (UI-008).
    if (no_page) {
      location = with_query_and_marker(location, req);
    } else if (const auto mark = req.target.find('?'); mark != std::string::npos) {
      location += req.target.substr(mark);
    }
    res.status = 302;
    res.set_header("Location", location);
    res.set_header("Cache-Control", "no-store");
  };

  // One trace is a page of its own (trace.html): /observability/traces/<trace id>.
  const auto serve_trace_shell = [&](const auto& req, auto& res) {
    httplib::Request shell_req = req;
    shell_req.path = "/trace.html";
    if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res, *fs_static_cache_)) {
      res.status = 404;
      res.set_content("trace.html not found", "text/plain");
    }
  };

  // One query shape is a page of its own (shape.html): /system/queries/<hash>.
  const auto serve_shape_shell = [&](const auto& req, auto& res) {
    httplib::Request shell_req = req;
    shell_req.path = "/shape.html";
    if (!try_serve_embedded(shell_req, res) && !try_serve_fs(shell_req, res, *fs_static_cache_)) {
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
    // /system/<name> is an address that has no page: the marker says so (UI-008).
    location = with_query_and_marker(location, req);
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
  if (cfg_.traces_on()) {
    http_.Get(R"(/observability/traces/?)", serve_view_shell("traces.html"));
    http_.Get(R"(/observability/traces/[^/]+/?)", serve_trace_shell);
  }
  if (cfg_.logs_on()) http_.Get(R"(/observability/logs/?)", serve_view_shell("logs.html"));
  if (cfg_.metrics_on()) http_.Get(R"(/observability/metrics/?)", serve_view_shell("metrics.html"));
  if (cfg_.traces_on() || cfg_.logs_on() || cfg_.metrics_on()) {
    http_.Get("/observability", redirect_to_first_view);
    http_.Get(R"(/observability/.*)", redirect_to_first_view);
  }

  // The MCP page shell is always served (its "MCP disabled" state shows the HCL to turn it on); 404 while mcp.html is absent.
  http_.Get("/mcp-integration", serve_view_shell("mcp.html"));

  http_.Get(R"(/static/.*)", [&](const auto& req, auto& res) {
    if (!try_serve_embedded(req, res) && !try_serve_fs(req, res, *fs_static_cache_)) {
      res.status = 404;
      res.set_content("asset not found", "text/plain");
    }
  });

  // A route that reads ClickHouse runs its handler inside a query scope (ch_query.hpp,
  // request_limits): its statements carry the label and the deadline of the request,
  // and stop when the browser goes away.
  const auto scoped = [this](auto handler) {
    return [this, handler](const httplib::Request& req, httplib::Response& res) {
      RequestScope scope(make_context(req));
      handler(req, res);
    };
  };

  // A route that does a lot of work for a host takes a place first (admission.hpp): a burst of them waits, and past the wait is
  // refused with 503 server_busy, instead of opening as many connections to the host as there are requests.
  const auto limited = [this](WorkClass work, auto handler) {
    return [this, work, handler](const httplib::Request& req, httplib::Response& res) {
      RequestScope scope(make_context(req));
      const auto ticket = admit(work, req, res);
      if (!ticket) return;
      handler(req, res);
    };
  };

  // The probes (docs/operations.md, "Health probes"): the process (no ClickHouse), the hosts, and the strict form of v2.
  http_.Get("/livez", [&](const auto& req, auto& res) { handle_livez(req, res); });
  http_.Get("/readyz", [&](const auto& req, auto& res) { handle_readyz(req, res); });
  http_.Get("/healthz", [&](const auto& req, auto& res) { handle_healthz(req, res); });
  if (cfg_.server.metrics) http_.Get("/metrics", [&](const auto& req, auto& res) { handle_metrics(req, res); });
  http_.Get("/api/version", [&](const auto& req, auto& res) { handle_api_version(req, res); });
  http_.Get("/api/meta", scoped([&](const auto& req, auto& res) { handle_api_meta(req, res); }));
  http_.Get("/api/hosts", [&](const auto& req, auto& res) { handle_api_hosts(req, res); });
  http_.Get("/api/hosts/stream", [&](const auto& req, auto& res) { handle_api_hosts_stream(req, res); });
  http_.Get("/api/health", [&](const auto& req, auto& res) { handle_api_health(req, res); });

  http_.Post("/api/format", scoped([&](const auto& req, auto& res) { handle_api_format(req, res); }));

  http_.Post("/api/query/run", [&](const auto& req, auto& res) { handle_query_run(req, res); });
  http_.Post("/api/query", [&](const auto& req, auto& res) { handle_query_run(req, res); });

  http_.Get("/api/query/stream", [&](const auto& req, auto& res) { handle_query_stream(req, res); });
  http_.Post("/api/query/cancel", scoped([&](const auto& req, auto& res) { handle_query_cancel(req, res); }));
  http_.Post("/api/query/analysis", limited(WorkClass::Analysis, [&](const auto& req, auto& res) { handle_query_analysis(req, res); }));
  // Deep Analyze is a job (deep_analysis_jobs.hpp): POST starts it (the job takes its own place of the analysis admission), GET polls it, POST
  // .../cancel stops it.
  http_.Post("/api/query/deep-analysis", scoped([&](const auto& req, auto& res) { handle_query_deep_analysis(req, res); }));
  http_.Get("/api/query/deep-analysis", scoped([&](const auto& req, auto& res) { handle_query_deep_analysis_status(req, res); }));
  http_.Post("/api/query/deep-analysis/cancel", scoped([&](const auto& req, auto& res) { handle_query_deep_analysis_cancel(req, res); }));
  http_.Get("/api/query/execution", scoped([&](const auto& req, auto& res) { handle_query_execution(req, res); }));

  http_.Post("/api/export/run", scoped([&](const auto& req, auto& res) { handle_export_run(req, res); }));
  http_.Post("/api/export/stream", scoped([&](const auto& req, auto& res) { handle_export_stream(req, res); }));
  http_.Get("/api/export/stream", scoped([&](const auto& req, auto& res) { handle_export_stream_not_allowed(req, res); }));

  if (cfg_.traces_on()) {
    http_.Get("/api/traces/meta", scoped([&](const auto& req, auto& res) { handle_traces_meta(req, res); }));
    http_.Get("/api/traces/search", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_search(req, res); }));
    http_.Get("/api/traces/analytics", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_analytics(req, res); }));
    http_.Get("/api/traces/service_map", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_service_map(req, res); }));
    http_.Get("/api/traces/heatmap", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_heatmap(req, res); }));
    http_.Get("/api/traces/deltas", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_deltas(req, res); }));
    http_.Get("/api/traces/services", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_services(req, res); }));
    http_.Get("/api/traces/services/db", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_services_db(req, res); }));
    http_.Get("/api/traces/prefill", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_prefill(req, res); }));
    http_.Get("/api/traces/facets", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_facets(req, res); }));
    http_.Get("/api/traces/facet_values", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_facet_values(req, res); }));
    http_.Get("/api/traces/trace", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_trace_detail(req, res); }));
    http_.Get("/api/traces/linked_from", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_linked_from(req, res); }));
    http_.Get("/api/traces/context", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_context(req, res); }));
    http_.Get("/api/traces/spans", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_spans(req, res); }));
    http_.Get("/api/traces/span", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_traces_span(req, res); }));
    // Answers {"enabled": false, ...} when logs are disabled (no 404).
    http_.Get("/api/traces/logs", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_trace_logs(req, res); }));
  }

  // Always registered: when logs/metrics are disabled the meta routes answer
  // {"enabled": false, ...} so a UI can explain why instead of seeing a 404.
  http_.Get("/api/logs/meta", scoped([&](const auto& req, auto& res) { handle_logs_meta(req, res); }));
  http_.Get("/api/metrics/meta", scoped([&](const auto& req, auto& res) { handle_metrics_meta(req, res); }));
  if (cfg_.logs_on()) {
    http_.Get("/api/logs/search", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_logs_search(req, res); }));
    http_.Get("/api/logs/histogram", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_logs_histogram(req, res); }));
    http_.Get("/api/logs/context", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_logs_context(req, res); }));
    http_.Get("/api/logs/patterns", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_logs_patterns(req, res); }));
    http_.Get("/api/logs/services", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_logs_services(req, res); }));
    http_.Get("/api/logs/facets", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_logs_facets(req, res); }));
    http_.Get("/api/logs/facet_values", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_logs_facet_values(req, res); }));
  }
  if (cfg_.metrics_on()) {
    http_.Get("/api/metrics/catalog", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_metrics_catalog(req, res); }));
    http_.Get("/api/metrics/attributes", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_metrics_attributes(req, res); }));
    http_.Get("/api/metrics/series", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_metrics_series(req, res); }));
    http_.Get("/api/metrics/exemplars", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_metrics_exemplars(req, res); }));
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
    const auto mcp_api = [this, scoped](McpApiRoute route) {
      return scoped([this, route](const httplib::Request& req, httplib::Response& res) { handle_api_mcp(req, res, route); });
    };
    http_.Get("/api/mcp/meta", mcp_api(McpApiRoute::Meta));
    http_.Get("/api/mcp/keys", mcp_api(McpApiRoute::KeysList));
    http_.Post("/api/mcp/keys", mcp_api(McpApiRoute::KeyCreate));
    http_.Delete(R"(/api/mcp/keys/([A-Za-z0-9_.\-]+))", mcp_api(McpApiRoute::KeyDelete));
    http_.Get(R"(/api/mcp/keys/([A-Za-z0-9_.\-]+)/access)", mcp_api(McpApiRoute::KeyAccess));
    http_.Get("/api/mcp/access", mcp_api(McpApiRoute::AccessSummary));
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
    http_.Get("/api/system/overview", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_system_overview(req, res); }));
    http_.Get("/api/system/series", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_system_series(req, res); }));
    http_.Get("/api/system/disks", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_system_disks(req, res); }));
    // Queries (runner context): system.top_queries.
    if (cfg_.system.top_queries_enabled()) {
      http_.Get("/api/system/queries", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_system_queries(req, res); }));
      http_.Get(R"(/api/system/queries/([^/]+))", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_system_query(req, res); }));
    }
    // Activity and Keeper keep the v2.14.0 addresses of the Explorer's
    // Server operations as aliases (/api/explorer/ops/activity and
    // /api/explorer/ops/keeper, docs/configuration.md).
    if (cfg_.system.activity_enabled()) {
      const auto activity = limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_system_activity(req, res); });
      http_.Get("/api/system/activity", activity);
      http_.Get("/api/explorer/ops/activity", activity);
    }
    if (cfg_.system.keeper_enabled()) {
      const auto keeper = limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_system_keeper(req, res); });
      http_.Get("/api/system/keeper", keeper);
      http_.Get("/api/explorer/ops/keeper", keeper);
    }
  }

  if (cfg_.explorer.enabled()) {
    http_.Get("/api/explorer/catalog", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_explorer_catalog(req, res); }));
    http_.Get("/api/explorer/table", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_explorer_table(req, res); }));
    http_.Post("/api/explorer/table/data", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_explorer_table_data(req, res); }));
    http_.Get("/api/explorer/functions", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_explorer_functions(req, res); }));
    http_.Get("/api/explorer/storage", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_explorer_storage(req, res); }));
    if (cfg_.explorer.graph_enabled()) {
      http_.Get("/api/explorer/graph", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_explorer_graph(req, res); }));
      http_.Get("/api/explorer/graph/definition", limited(WorkClass::Heavy, [&](const auto& req, auto& res) { handle_explorer_graph_definition(req, res); }));
    }
  }

}

Server::~Server() {
  // The same cancellation as a stop: a server that run() left for another reason (its socket failed) stops too.
  stop();
  {
    // Under the lock of the wait: the reaper cannot miss the notification between its check and its wait.
    std::lock_guard<std::mutex> lk(session_reaper_mu_);
    session_reaper_stop_.store(true, std::memory_order_relaxed);
  }
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
  remaining.clear();

  // A query thread may outlive its session's last owner (QuerySession::start): wait until each one has ended
  // before anything that it uses goes (the pool, the registry, the caches), at most until the deadline of the stop.
  const int64_t left_ms = stop_deadline_ms_.load(std::memory_order_acquire) - steady_now_ms();
  if (!query_workers_->close_and_wait(std::chrono::milliseconds(std::max<int64_t>(0, left_ms)))) {
    log_event(LogLevel::Error, "server.shutdown_timeout",
              {{"query_threads", query_workers_->active()}, {"timeout_ms", cfg_.server.shutdown_timeout_ms}});
    // Destroying the server under a running thread is undefined behaviour: end the process instead.
    std::_Exit(1);
  }

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
    if (session_reaper_stop_.load(std::memory_order_relaxed)) break;
    reap_sessions_once();
    const auto now = std::chrono::steady_clock::now();
    if (cfg_.server.stats_log_interval_ms > 0 && now - last_stats_log_ >= std::chrono::milliseconds(cfg_.server.stats_log_interval_ms)) {
      last_stats_log_ = now;
      log_stats();
    }
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
  if (stopping()) return 0;
  if (!http_.bind_to_port(host, port)) {
    log_event(LogLevel::Error, "server.listen_failed", {{"listen", cfg_.listen}});
    return 1;
  }
  // A stop() that came before the bind found no socket to close: close it now (one after the bind closes it itself).
  if (stopping()) http_.stop();
  log_event(LogLevel::Info, "server.listening", {{"listen", cfg_.listen}});
  const bool served = http_.listen_after_bind();
  if (stopping()) {
    log_event(LogLevel::Info, "server.stopped", {});
    return 0;
  }
  return served ? 0 : 1;
}

ChQueryLimits Server::request_limits(const httplib::Request& req, bool with_deadline) const {
  ChQueryLimits limits;
  // The System page labels its own reads 'chdash-system' (System > Queries never lists them); every other
  // route 'chdash:<path>', which System > Queries leaves out with hide_chdash.
  const bool system_page = req.path.rfind("/api/system/", 0) == 0 || req.path.rfind("/api/explorer/ops/", 0) == 0;
  limits.log_comment = system_page ? std::string("chdash-system") : "chdash:" + req.path.substr(0, 160);
  if (with_deadline) {
    limits.deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(cfg_.generated_queries.timeout_ms);
  }
  limits.max_memory_usage = cfg_.generated_queries.max_memory_usage;
  // A read cap for every page: a statement that would read more fails (<page>_scan_limit). The System page sets its own below.
  limits.max_rows_to_read = cfg_.generated_queries.max_rows_to_read;
  limits.read_overflow_mode = "throw";
  // The System page bounds every read as its own system-table reads are (docs/system.md): read only,
  // a read cap and a result cap that fail rather than cut.
  if (system_page) {
    limits.read_only = true;
    limits.timeout_overflow_mode = "throw";
    limits.max_rows_to_read = cfg_.system.query_log_max_rows;
    limits.read_overflow_mode = "throw";
    limits.max_result_rows = 1'000'000;
    limits.result_overflow_mode = "throw";
  }
  // The Explorer reads metadata: each statement ends in 10 s. Its data preview reads the rows of a table
  // (a View or a Distributed table runs its whole source): 30 s, and 64 MiB of result at most (the
  // preview then has fewer rows).
  if (req.path == "/api/explorer/table/data") {
    limits.max_execution_time_s = 30;
    limits.max_result_bytes = 64 * 1024 * 1024;
    limits.result_overflow_mode = "break";
    // A View or a Distributed table runs its whole source: the read stops at the cap and the preview has fewer rows.
    limits.read_overflow_mode = "break";
  } else if (!system_page && req.path.rfind("/api/explorer/", 0) == 0) {
    limits.max_execution_time_s = 10;
  }
  // A statement stops when the browser goes away, and when the server stops.
  limits.canceled = [this, &req] { return stopping() || (req.is_connection_closed && req.is_connection_closed()); };
  return limits;
}

std::string Server::admission_host(const httplib::Request& req) const {
  std::string id;
  if (req.has_param("host_id")) {
    id = req.get_param_value("host_id");
  } else if (req.method == "POST" && !req.body.empty() && req.body.size() <= 64 * 1024) {
    // The body names the host (the routes that take a JSON body): a small body, parsed once more here.
    rapidjson::Document doc;
    if (parse_json_bounded(doc, req.body) && doc.IsObject()) {
      const auto it = doc.FindMember("host_id");
      if (it != doc.MemberEnd() && it->value.IsString()) id.assign(it->value.GetString(), it->value.GetStringLength());
    }
  }
  if (id.empty() && cfg_.hosts.size() == 1) id = cfg_.hosts.front().id;
  // An unknown host takes no place of its own: the route answers 404 for it.
  return !id.empty() && find_request_host(cfg_, req, id) ? id : std::string("-");
}

RequestContext Server::make_context(const httplib::Request& req, bool with_deadline) const {
  RequestContext context;
  // A call of MCP runs the handler inside its own scope: the caller is the one of that scope. A request that comes through the
  // socket has no scope yet, so it is a Browser.
  const RequestContext& outer = current_request_context();
  context.caller = outer.caller;
  context.caller_id = outer.caller_id;
  context.route = req.path;
  context.request_id = req.get_header_value("X-Request-Id");
  context.limits = request_limits(req, with_deadline);
  // The statements of a tool carry its key: System > Queries and the log of ClickHouse show who asked.
  if (context.is_mcp()) context.limits.log_comment = "chdash-mcp key=" + context.caller_id + " " + req.path.substr(0, 120);
  return context;
}

McpApiResponse Server::call_mcp_api(const McpApiRequest& request) {
  McpApiResponse out;
  if (stopping()) {
    out.error = "the server is stopping";
    return out;
  }
  // The caller of the tool: the statements that it already holds stop the call when the client of MCP goes away.
  const ChQueryLimits* outer = ChQueryScope::current();
  const std::function<bool()> canceled = outer ? outer->canceled : std::function<bool()>();
  const auto stop = [this, canceled] { return stopping() || (canceled && canceled()); };

  auto ticket = admission_.acquire(std::string("mcp") + '\x1f', cfg_.admission.mcp_max, std::chrono::milliseconds(cfg_.admission.wait_ms), stop);
  if (!ticket) {
    out.error = "too many API calls at once through MCP: retry in a moment";
    return out;
  }

  httplib::Request req;
  req.method = request.method;
  req.path = request.path;
  req.target = request.path;
  for (const auto& [name, value] : request.query) req.params.emplace(name, value);
  req.body = request.body;
  req.set_header("Accept", "application/json");
  if (request.method == "POST") req.set_header("Content-Type", "application/json");
  req.is_connection_closed = [stop] { return stop(); };
  req.version = "HTTP/1.1";
  httplib::Response res;

  RequestContext caller;
  caller.caller = RequestContext::Caller::Mcp;
  caller.caller_id = request.key_id;
  caller.route = request.path;
  caller.limits = ChQueryScope::current_copy();
  RequestScope scope(std::move(caller));
  try {
    if (!http_.dispatch(req, res)) {
      // No route of this path: the part of ChDash is off in its configuration. The tool reads an empty answer with a 404 as
      // not_enabled (mcp_tools.cpp).
      out.status = 404;
      return out;
    }
  } catch (const std::exception& error) {
    log_event(LogLevel::Error, "mcp.api_failed", {{"path", request.path}, {"key", request.key_id}, {"error", std::string(error.what()).substr(0, 300)}});
    out.status = 500;
    out.body = R"({"error_code":"internal_error","message":"Internal server error.","retryable":false})";
    return out;
  }
  // A handler that sets no status answers 200, as the server of httplib does after it.
  out.status = res.status == -1 ? 200 : res.status;
  if (static_cast<int64_t>(res.body.size()) > request.max_bytes) {
    out.too_large = true;
    return out;
  }
  out.body = std::move(res.body);
  return out;
}

std::optional<Admission::Ticket> Server::admit(WorkClass work, const httplib::Request& req, httplib::Response& res) {
  const AdmissionSettings& limits = cfg_.admission;
  const char* name = work == WorkClass::Analysis ? "analysis" : work == WorkClass::Mcp ? "mcp" : "heavy";
  const size_t max = work == WorkClass::Analysis ? limits.analysis_per_host : work == WorkClass::Mcp ? limits.mcp_max : limits.heavy_per_host;
  // The MCP limit is global; the others are for each host.
  const std::string key = std::string(name) + '\x1f' + (work == WorkClass::Mcp ? std::string() : admission_host(req));
  auto ticket = admission_.acquire(key, max, std::chrono::milliseconds(limits.wait_ms), [this, &req] {
    return stopping() || (req.is_connection_closed && req.is_connection_closed());
  });
  if (ticket) return ticket;
  if (!stopping()) {
    res.set_header("Retry-After", "1");
    ApiError busy;
    busy.status = 503;
    busy.code = "server_busy";
    busy.message = "Too many heavy requests are running for this host. Try again in a moment.";
    busy.retryable = true;
    send_error(res, busy);
  } else {
    json_error(res, 503, "server_stopping", "the server is stopping");
  }
  return std::nullopt;
}

ChQueryLimits Server::user_sql_limits(const httplib::Request& req, std::string log_comment) const {
  ChQueryLimits limits;
  limits.log_comment = std::move(log_comment);
  limits.max_execution_time_s = cfg_.query_options.max_execution_time_s;
  limits.max_memory_usage = cfg_.query_options.max_memory_usage;
  limits.max_rows_to_read = cfg_.query_options.max_rows_to_read;
  limits.canceled = [&req] { return req.is_connection_closed && req.is_connection_closed(); };
  return limits;
}

void Server::stop() {
  bool expected = false;
  if (!stopping_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) return;
  stop_deadline_ms_.store(steady_now_ms() + cfg_.server.shutdown_timeout_ms, std::memory_order_release);

  // The running queries: cancelled, and KILL QUERY sent. Their streams see the stop and end with server_stopping.
  std::vector<std::shared_ptr<QuerySession>> sessions;
  {
    std::lock_guard<std::mutex> lk(mu_);
    for (const auto& item : sessions_) sessions.push_back(item.second);
  }
  // The exports: each hook kills the ClickHouse query of its export.
  std::vector<std::function<void()>> hooks;
  {
    std::lock_guard<std::mutex> lk(stop_hooks_mu_);
    for (const auto& item : stop_hooks_) hooks.push_back(item.second);
  }
  log_event(LogLevel::Info, "server.stopping",
            {{"sessions", sessions.size()}, {"exports", hooks.size()}, {"timeout_ms", cfg_.server.shutdown_timeout_ms}});
  for (const auto& session : sessions) {
    if (!session) continue;
    session->request_cancel();
    session->cancel_native_queries_best_effort(false);
  }
  for (const auto& hook : hooks) {
    try {
      hook();
    } catch (...) {
    }
  }
  // The health threads end, which also wakes the host status streams (they end on the stop).
  if (health_) health_->stop();
  // No new connection; run() returns once the connections in progress end (the streams end above).
  http_.stop();
}

uint64_t Server::add_stop_hook(std::function<void()> hook) {
  {
    std::lock_guard<std::mutex> lk(stop_hooks_mu_);
    if (!stopping()) {
      const uint64_t id = ++next_stop_hook_;
      stop_hooks_.emplace(id, std::move(hook));
      return id;
    }
  }
  hook();
  return 0;
}

void Server::remove_stop_hook(uint64_t id) {
  if (id == 0) return;
  std::lock_guard<std::mutex> lk(stop_hooks_mu_);
  stop_hooks_.erase(id);
}

// The strict probe of v2 (docs/operations.md, "Health probes"): 200 only when every host answers and the server
// does not stop. For an orchestrator, /livez and /readyz are the probes.
void Server::handle_healthz(const httplib::Request&, httplib::Response& res) {
  res.set_header("Cache-Control", "no-store");
  if (stopping()) return json_error(res, 503, "server_stopping", "the server is stopping");
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
  w.Key("version"); write_json_text(w, cfg_.version_semver);
  w.Key("git_sha"); write_json_text(w, cfg_.version_git_sha);
  w.Key("build_time"); write_json_text(w, cfg_.version_build_time);
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
  w.Key("enabled"); w.Bool(cfg_.traces_on());
  w.EndObject();
  w.Key("logs");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.logs_on());
  w.Key("body_search"); write_json_text(w, cfg_.otel_defaults.logs.body_search);
  w.EndObject();
  w.Key("metrics");
  w.StartObject();
  w.Key("enabled"); w.Bool(cfg_.metrics_on());
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
