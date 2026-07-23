#include "server.hpp"

#include "ch_uri.hpp"

#include "hcl.hpp"

#include <algorithm>
#include <cstdlib>
#include <cctype>
#include <iostream>
#include <stdexcept>
#include <string>
#include <unordered_set>

static std::string envs(const char* k, const std::string& def = "") {
  const char* v = std::getenv(k);
  if (!v || !*v) return def;
  return std::string(v);
}

static int envi(const char* k, int def) {
  const char* v = std::getenv(k);
  if (!v || !*v) return def;
  try {
    return std::stoi(v);
  } catch (...) {
    return def;
  }
}

static bool envb(const char* k, bool def) {
  const char* v = std::getenv(k);
  if (!v || !*v) return def;
  std::string s(v);
  for (auto& ch : s) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  if (s == "1" || s == "true" || s == "yes" || s == "on") return true;
  if (s == "0" || s == "false" || s == "no" || s == "off") return false;
  return def;
}

static chdash::QueryDescribeMode env_describe_mode(const char* k, chdash::QueryDescribeMode def) {
  const char* v = std::getenv(k);
  if (!v || !*v) return def;
  std::string s(v);
  for (auto& ch : s) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  if (s == "always" || s == "on" || s == "1" || s == "true") return chdash::QueryDescribeMode::Always;
  if (s == "never" || s == "off" || s == "0" || s == "false") return chdash::QueryDescribeMode::Never;
  if (s == "auto") return chdash::QueryDescribeMode::Auto;
  return def;
}

static void load_hosts_from_hcl(chdash::AppConfig& cfg, const std::string& hcl_src) {
  using namespace chdash;

  auto root = parse_hcl(hcl_src);

  // health { interval_ms = 5000 timeout_ms = 800 }
  if (auto it = root.blocks.find("health"); it != root.blocks.end() && !it->second.empty()) {
    const auto& h = it->second.front();
    if (auto v = hcl_get_int(h, "interval_ms")) cfg.health.interval_ms = static_cast<int>(*v);
    if (auto v = hcl_get_int(h, "timeout_ms")) cfg.health.timeout_ms = static_cast<int>(*v);
  }

  // clickhouse { host { ... } host { ... } }
  auto it_ch = root.blocks.find("clickhouse");
  if (it_ch == root.blocks.end() || it_ch->second.empty()) {
    throw std::runtime_error("CH_HOSTS: missing clickhouse { ... } block");
  }
  const auto& ch = it_ch->second.front();
  auto it_hosts = ch.blocks.find("host");
  if (it_hosts == ch.blocks.end() || it_hosts->second.empty()) {
    throw std::runtime_error("CH_HOSTS: missing clickhouse { host { ... } } blocks");
  }

  std::unordered_set<std::string> ids;
  for (const auto& ho : it_hosts->second) {
    auto name = hcl_get_string(ho, "name");
    auto runner_uri = hcl_get_string(ho, "runner_uri");
    auto system_uri = hcl_get_string(ho, "system_uri");
    if (!name || name->empty()) throw std::runtime_error("CH_HOSTS: host.name is required");
    if (!runner_uri || runner_uri->empty()) throw std::runtime_error("CH_HOSTS: host.runner_uri is required");
    if (!system_uri || system_uri->empty()) throw std::runtime_error("CH_HOSTS: host.system_uri is required");
    if (!ids.insert(*name).second) throw std::runtime_error("CH_HOSTS: duplicate host.name: " + *name);

    HostSpec hs;
    hs.id = *name;
    hs.label = *name;
    hs.runner_uri = *runner_uri;
    hs.system_uri = *system_uri;
    cfg.hosts.push_back(std::move(hs));
  }

  if (cfg.hosts.empty()) {
    throw std::runtime_error("CH_HOSTS: no hosts configured");
  }
}

int main(int argc, char** argv) {
  if (argc > 1) {
    const std::string arg1 = argv[1];
    if (arg1 == "--version" || arg1 == "-v") {
#ifdef CHDASH_SEMVER
      const char* version = CHDASH_SEMVER;
#else
      const char* version = "dev";
#endif
      std::cout << "clickhouse-dash " << version << std::endl;
      return 0;
    }
  }

  chdash::AppConfig cfg;

  const std::string host = envs("LISTEN_HOST", "0.0.0.0");
  const int port = envi("LISTEN_PORT", 8080);
  cfg.listen = host + ":" + std::to_string(port);

  cfg.result_preview_row_limit = std::max(0, std::min(10'000'000, envi("RESULT_PREVIEW_ROW_LIMIT", 10000)));
  cfg.query_max_sql_bytes = static_cast<size_t>(std::max(1024, std::min(64 * 1024 * 1024,
      envi("QUERY_MAX_SQL_BYTES", 4 * 1024 * 1024))));

  cfg.query_options.describe_mode = env_describe_mode("QUERY_DESCRIBE_MODE", chdash::QueryDescribeMode::Auto);
  cfg.query_options.final_stats_from_query_log = envb("QUERY_FINAL_STATS_FROM_QUERY_LOG", false);
  cfg.query_options.flush_query_log_for_final_stats = envb("QUERY_FINAL_STATS_FLUSH_LOGS", false);
  cfg.query_options.sample_interval_ms = envi("QUERY_SAMPLE_INTERVAL_MS", 40);
  cfg.query_options.result_rows_batch_size = envi("QUERY_RESULT_BATCH_ROWS", 1000);
  cfg.query_options.result_rows_batch_bytes = static_cast<size_t>(std::max(0, envi("QUERY_RESULT_BATCH_BYTES", 256 * 1024)));
  cfg.query_options.sse_write_batch_events = static_cast<size_t>(std::max(1, envi("QUERY_SSE_BATCH_EVENTS", 8)));
  cfg.query_options.sse_write_batch_bytes = static_cast<size_t>(std::max(0, envi("QUERY_SSE_BATCH_BYTES", 256 * 1024)));
  cfg.query_options.sse_queue_max_bytes = static_cast<size_t>(std::max(0, envi("QUERY_SSE_QUEUE_MAX_BYTES", 8 * 1024 * 1024)));
  cfg.query_options.describe_cache_entries = static_cast<size_t>(std::max(0, envi("QUERY_DESCRIBE_CACHE_ENTRIES", 256)));
  cfg.query_options.describe_cache_ttl_ms = std::max(0, envi("QUERY_DESCRIBE_CACHE_TTL_MS", 60 * 1000));
  cfg.client_pool_max_idle_per_key = static_cast<size_t>(std::max(0, std::min(64,
      envi("CH_CLIENT_POOL_MAX_IDLE", 4))));
  cfg.client_pool_idle_ttl_ms = std::max(0, std::min(24 * 60 * 60 * 1000,
      envi("CH_CLIENT_POOL_IDLE_TTL_MS", 60 * 1000)));
  cfg.client_pool_validate_after_idle_ms = std::max(0, std::min(24 * 60 * 60 * 1000,
      envi("CH_CLIENT_POOL_VALIDATE_AFTER_IDLE_MS", 15 * 1000)));
  cfg.client_pool_reaper_interval_ms = std::max(250, std::min(60 * 1000,
      envi("CH_CLIENT_POOL_REAPER_INTERVAL_MS", 5 * 1000)));
  cfg.format_cache_max_entries = static_cast<size_t>(std::max(0, std::min(100'000,
      envi("FORMAT_CACHE_MAX_ENTRIES", 512))));
  cfg.format_cache_max_bytes = static_cast<size_t>(std::max(0, std::min(1024 * 1024 * 1024,
      envi("FORMAT_CACHE_MAX_BYTES", 16 * 1024 * 1024))));
  cfg.format_cache_ttl_ms = std::max(0, std::min(24 * 60 * 60 * 1000,
      envi("FORMAT_CACHE_TTL_MS", 10 * 60 * 1000)));
  cfg.query_session_max_count = static_cast<size_t>(std::max(1, std::min(100'000,
      envi("QUERY_SESSION_MAX_COUNT", 256))));
  cfg.query_session_abandoned_ttl_ms = std::max(1000, envi("QUERY_SESSION_ABANDONED_TTL_MS", 60 * 1000));
  cfg.query_session_terminal_ttl_ms = std::max(0, envi("QUERY_SESSION_TERMINAL_TTL_MS", 30 * 1000));
  cfg.query_session_reaper_interval_ms = std::max(250, envi("QUERY_SESSION_REAPER_INTERVAL_MS", 5 * 1000));

  // Version info (compile-time).
#ifdef CHDASH_SEMVER
  cfg.version_semver = CHDASH_SEMVER;
#endif
#ifdef CHDASH_GIT_SHA
  cfg.version_git_sha = CHDASH_GIT_SHA;
#endif
#ifdef CHDASH_BUILD_TIME
  cfg.version_build_time = CHDASH_BUILD_TIME;
#endif

  const std::string ch_hosts = envs("CH_HOSTS", "");
  try {
    if (ch_hosts.empty()) {
      throw std::runtime_error("CH_HOSTS is required");
    }
    load_hosts_from_hcl(cfg, ch_hosts);
    if (cfg.health.interval_ms > 600 * 1000) cfg.health.interval_ms = 600 * 1000;
  } catch (const std::exception& e) {
    std::cerr << "config error: " << e.what() << std::endl;
    return 1;
  }

  if (argc > 1 && std::string(argv[1]) == "--health") {
    // The one-shot health command must not start the periodic health worker or
    // the query-session reaper just to perform a single ping.
    chdash::Server srv(cfg, false);
    std::string err;
    if (srv.health_check(&err)) {
      return 0;
    } else {
      std::cerr << "Health check failed: " << err << std::endl;
      return 1;
    }
  }

  try {
    chdash::Server s(cfg);
    std::cerr << "listen=http://" << cfg.listen << "\n";
    std::cerr << "hosts=" << cfg.hosts.size() << " health_interval_ms=" << cfg.health.interval_ms << " timeout_ms=" << cfg.health.timeout_ms
              << " client_pool_max_idle=" << cfg.client_pool_max_idle_per_key
              << " client_pool_idle_ttl_ms=" << cfg.client_pool_idle_ttl_ms
              << " client_pool_validate_after_idle_ms=" << cfg.client_pool_validate_after_idle_ms
              << " client_pool_reaper_interval_ms=" << cfg.client_pool_reaper_interval_ms
              << " query_sample_interval_ms=" << cfg.query_options.sample_interval_ms
              << " query_batch_rows=" << cfg.query_options.result_rows_batch_size
              << " query_batch_bytes=" << cfg.query_options.result_rows_batch_bytes
              << " sse_batch_events=" << cfg.query_options.sse_write_batch_events
              << " sse_batch_bytes=" << cfg.query_options.sse_write_batch_bytes
              << " sse_queue_max_bytes=" << cfg.query_options.sse_queue_max_bytes
              << " describe_cache_entries=" << cfg.query_options.describe_cache_entries
              << " describe_cache_ttl_ms=" << cfg.query_options.describe_cache_ttl_ms
              << " final_query_log_stats=" << (cfg.query_options.final_stats_from_query_log ? "on" : "off")
              << " format_cache_entries=" << cfg.format_cache_max_entries
              << " format_cache_ttl_ms=" << cfg.format_cache_ttl_ms
              << " query_session_max_count=" << cfg.query_session_max_count
              << " query_session_abandoned_ttl_ms=" << cfg.query_session_abandoned_ttl_ms
              << "\n";
    for (const auto& h : cfg.hosts) {
      std::cerr << "host=" << h.id
                << " runner_uri=" << chdash::redact_clickhouse_uri(h.runner_uri)
                << " system_uri=" << chdash::redact_clickhouse_uri(h.system_uri) << "\n";
    }
    return s.run();
  } catch (const std::exception& e) {
    std::cerr << "fatal: " << e.what() << "\n";
    return 1;
  }
}
