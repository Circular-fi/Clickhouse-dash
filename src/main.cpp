#include "server.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <iostream>
#include <string>

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

int main(int argc, char** argv) {
  chdash::AppConfig cfg;

  // Static assets directory (index.html, app.js, style.css, fonts/...).
  cfg.static_dir = envs("STATIC_DIR", envs("CHDASH_STATIC_DIR", "./static"));

  // --- Listen address ---
  // Priority:
  //   1) CHDASH_LISTEN ("host:port")
  //   2) LISTEN_HOST + LISTEN_PORT (docker-compose.yml)
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

  // --- ClickHouse connection ---
  // docker-compose.yml uses: CH_URL, CH_USER, CH_PASS
  // We also accept: CH_HOST/CH_PORT and CH_PASSWORD
  cfg.ch_host = envs("CH_HOST", "clickhouse");
  cfg.ch_port = envi("CH_PORT", 9000);

  {
    const std::string ch_url = envs("CH_URL", "");
    if (!ch_url.empty()) {
      std::string host = cfg.ch_host;
      int port = cfg.ch_port;
      if (parse_hostport(ch_url, host, port)) {
        if (!host.empty()) cfg.ch_host = host;
        if (port > 0) cfg.ch_port = port;
      }
    }
  }

  cfg.ch_tls = envb("CH_TLS", false);
  cfg.ch_tls_port = envi("CH_TLS_PORT", 9440);

  cfg.ch_user = envs("CH_USER", "default");
  cfg.ch_password = envs("CH_PASS", envs("CH_PASSWORD", ""));
  cfg.ch_db = envs("CH_DB", envs("CH_DATABASE", "default"));

  cfg.result_preview_row_limit = envi("RESULT_PREVIEW_ROW_LIMIT", 500);
  
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
    std::cerr << "clickhouse_host=" << cfg.ch_host << " clickhouse_port=" << cfg.ch_port << " db=" << cfg.ch_db << "\n";
    return s.run();
  } catch (const std::exception& e) {
    std::cerr << "fatal: " << e.what() << "\n";
    return 1;
  }
}
