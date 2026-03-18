#include "server.hpp"

#include "hcl.hpp"

#include <cstdlib>
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

  cfg.result_preview_row_limit = envi("RESULT_PREVIEW_ROW_LIMIT", 10000);

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
    chdash::Server srv(cfg);
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
    std::cerr << "hosts=" << cfg.hosts.size() << " health_interval_ms=" << cfg.health.interval_ms << " timeout_ms=" << cfg.health.timeout_ms << "\n";
    for (const auto& h : cfg.hosts) {
      std::cerr << "host=" << h.id << " runner_uri=" << h.runner_uri << " system_uri=" << h.system_uri << "\n";
    }
    return s.run();
  } catch (const std::exception& e) {
    std::cerr << "fatal: " << e.what() << "\n";
    return 1;
  }
}
