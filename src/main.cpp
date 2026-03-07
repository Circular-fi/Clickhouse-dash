#include "server.hpp"

#include "hcl.hpp"

#include <algorithm>
#include <cctype>
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

static bool envb(const char* k, bool def) {
  const char* v = std::getenv(k);
  if (!v || !*v) return def;
  std::string s(v);
  for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return (s == "1" || s == "true" || s == "yes" || s == "on");
}

static std::string trim(std::string s) {
  auto not_space = [](unsigned char c) { return !std::isspace(c); };
  s.erase(s.begin(), std::find_if(s.begin(), s.end(), not_space));
  s.erase(std::find_if(s.rbegin(), s.rend(), not_space).base(), s.end());
  return s;
}

// Parse "host:port" or "tcp://host:port" or "[::1]:9000".
static bool parse_hostport(const std::string& in, std::string& host_out, int& port_out) {
  std::string s = trim(in);
  if (s.empty()) return false;

  // Strip scheme.
  auto pos_scheme = s.find("://");
  if (pos_scheme != std::string::npos) s = s.substr(pos_scheme + 3);

  // Strip path/query.
  auto pos_slash = s.find('/');
  if (pos_slash != std::string::npos) s = s.substr(0, pos_slash);

  s = trim(s);
  if (s.empty()) return false;

  // IPv6 in brackets.
  if (s.front() == '[') {
    auto rb = s.find(']');
    if (rb == std::string::npos) return false;
    host_out = s.substr(1, rb - 1);
    if (rb + 1 < s.size() && s[rb + 1] == ':') {
      try {
        port_out = std::stoi(s.substr(rb + 2));
      } catch (...) {
        return false;
      }
    }
    return true;
  }

  // Regular host:port (use last ':' to avoid ipv6 without brackets).
  auto pos_colon = s.rfind(':');
  if (pos_colon == std::string::npos) {
    host_out = s;
    return true;
  }

  host_out = s.substr(0, pos_colon);
  std::string port_s = s.substr(pos_colon + 1);
  if (port_s.empty()) return true;
  try {
    port_out = std::stoi(port_s);
  } catch (...) {
    return false;
  }
  return true;
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

static void load_hosts_from_legacy_env(chdash::AppConfig& cfg) {
  // Backward-compatible single host configuration.
  std::string host = envs("CH_HOST", "clickhouse");
  int port = envi("CH_PORT", 9000);

  // docker-compose.yml uses: CH_URL, CH_USER, CH_PASS
  {
    const std::string ch_url = envs("CH_URL", "");
    if (!ch_url.empty()) {
      std::string h = host;
      int p = port;
      if (parse_hostport(ch_url, h, p)) {
        if (!h.empty()) host = h;
        if (p > 0) port = p;
      }
    }
  }

  const bool tls = envb("CH_TLS", false);
  const int tls_port = envi("CH_TLS_PORT", 9440);
  const std::string user = envs("CH_USER", "default");
  const std::string pass = envs("CH_PASS", envs("CH_PASSWORD", ""));

  int use_port = tls ? tls_port : port;

  std::string uri = "clickhouse://" + user + ":" + pass + "@" + host + ":" + std::to_string(use_port);
  if (tls) uri += "?secure=1";

  chdash::HostSpec hs;
  hs.id = "default";
  hs.label = "default";
  hs.runner_uri = uri;
  hs.system_uri = uri;
  cfg.hosts.push_back(std::move(hs));
}

int main(int argc, char** argv) {
  chdash::AppConfig cfg;

  // Static assets directory (index.html, app.js, style.css, fonts/...).
  cfg.static_dir = envs("STATIC_DIR", "./static");

  // --- Listen address ---
  // Priority:
  //   1) CHDASH_LISTEN ("host:port")
  //   2) LISTEN_HOST + LISTEN_PORT
  //   3) PORT (platform default)
  //   4) 0.0.0.0:8080
  {
    const std::string listen = envs("CHDASH_LISTEN", "");
    if (!listen.empty()) {
      cfg.listen = listen;
    } else {
      const std::string host = envs("LISTEN_HOST", "0.0.0.0");
      const int port = envi("LISTEN_PORT", envi("PORT", 8080));
      cfg.listen = host + ":" + std::to_string(port);
    }
  }

  cfg.result_preview_row_limit = envi("RESULT_PREVIEW_ROW_LIMIT", 10000);
  cfg.health.interval_ms = envi("HEALTH_INTERVAL_MS", 5000);
  cfg.health.timeout_ms = envi("HEALTH_TIMEOUT_MS", 800);
  if (cfg.health.interval_ms > 600 * 1000) cfg.health.interval_ms = 600 * 1000;

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

  // --- ClickHouse hosts ---
  const std::string ch_hosts = envs("CH_HOSTS", "");
  try {
    if (!ch_hosts.empty()) {
      load_hosts_from_hcl(cfg, ch_hosts);
    } else {
      load_hosts_from_legacy_env(cfg);
    }
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
