#include "server.hpp"

#include "ch_uri.hpp"
#include "config.hpp"

#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>

namespace {

struct CliOptions {
  std::optional<std::string> config_path;
  bool health = false;
  bool version = false;
  bool help = false;
};

CliOptions parse_cli(int argc, char** argv) {
  CliOptions options;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--config") {
      if (options.config_path) throw std::runtime_error("--config may only be specified once");
      if (i + 1 >= argc) throw std::runtime_error("--config requires a file path");
      const std::string path = argv[++i];
      if (path.empty() || path.rfind("--", 0) == 0) throw std::runtime_error("--config requires a file path");
      options.config_path = path;
    } else if (arg == "--health") {
      options.health = true;
    } else if (arg == "--version" || arg == "-v") {
      options.version = true;
    } else if (arg == "--help" || arg == "-h") {
      options.help = true;
    } else {
      throw std::runtime_error("unknown option: " + arg);
    }
  }
  return options;
}

void print_help() {
  std::cout
      << "Usage: chdash [--config <path>] [--health]\n"
      << "       chdash --version\n\n"
      << "When --config is present, application environment variables are ignored.\n";
}

void print_version() {
#ifdef CHDASH_SEMVER
  const char* version = CHDASH_SEMVER;
#else
  const char* version = "dev";
#endif
  std::cout << "clickhouse-dash " << version << std::endl;
}

} // namespace

int main(int argc, char** argv) {
  CliOptions cli;
  try {
    cli = parse_cli(argc, argv);
  } catch (const std::exception& error) {
    std::cerr << "argument error: " << error.what() << "\n";
    std::cerr << "Try --help for usage.\n";
    return 2;
  }

  if (cli.help) {
    print_help();
    return 0;
  }
  if (cli.version) {
    print_version();
    return 0;
  }

  chdash::AppConfig cfg;
  try {
    // This branch is the environment isolation boundary: the file loader does
    // not call getenv, and the environment loader is never reached.
    cfg = cli.config_path
        ? chdash::load_config_from_file(*cli.config_path)
        : chdash::load_config_from_environment();
  } catch (const std::exception& error) {
    std::cerr << "config error: " << error.what() << std::endl;
    return 1;
  }

  if (cli.health) {
    // The one-shot health command must not start the periodic health worker or
    // the query-session reaper just to perform a single ping.
    chdash::Server server(cfg, false);
    std::string error;
    if (server.health_check(&error)) return 0;
    std::cerr << "Health check failed: " << error << std::endl;
    return 1;
  }

  try {
    chdash::Server server(cfg);
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
    for (const auto& host : cfg.hosts) {
      std::cerr << "host=" << host.id
                << " runner_uri=" << chdash::redact_clickhouse_uri(host.runner_uri)
                << " system_uri=" << chdash::redact_clickhouse_uri(host.system_uri) << "\n";
    }
    return server.run();
  } catch (const std::exception& error) {
    std::cerr << "fatal: " << error.what() << "\n";
    return 1;
  }
}
