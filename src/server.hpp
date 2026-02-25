#pragma once

#include "health_runner.hpp"
#include "jwt.hpp"
#include "query_session.hpp"

#include <httplib.h>

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

struct AppConfig {
  std::string listen = "0.0.0.0:8080";

  // Directory that contains the frontend assets (index.html, app.js, style.css, fonts/...).
  // In the provided repo layout this is typically: ./static
  std::string static_dir = "./static";

  // ClickHouse hosts (multi-host).
  // Each HostSpec contains a runner_uri and a system_uri.
  std::vector<HostSpec> hosts;

  // Health runner settings.
  HealthSettings health;

  // How many result rows to stream before truncating (0 = unlimited)
  int result_preview_row_limit = 0;

  // /api/meta
  std::string version_semver = "dev";
  std::string version_git_sha = "unknown";
  std::string version_build_time = "unknown";
};

class Server {
public:
  explicit Server(AppConfig cfg);

  int run();
  bool health_check(std::string* error_message = nullptr);

private:
  void handle_healthz(const httplib::Request& req, httplib::Response& res);
  void handle_api_meta(const httplib::Request& req, httplib::Response& res);
  void handle_api_hosts(const httplib::Request& req, httplib::Response& res);
  void handle_api_hosts_stream(const httplib::Request& req, httplib::Response& res);
  void handle_api_health(const httplib::Request& req, httplib::Response& res);

  void handle_query_run(const httplib::Request& req, httplib::Response& res);
  void handle_query_stream(const httplib::Request& req, httplib::Response& res);
  void handle_query_cancel(const httplib::Request& req, httplib::Response& res);

  AppConfig cfg_;
  httplib::Server http_;

  std::unique_ptr<HealthRunner> health_;
  JwtService jwt_;

  std::mutex mu_;
  std::unordered_map<std::string, std::shared_ptr<QuerySession>> sessions_;
};

} // namespace chdash
