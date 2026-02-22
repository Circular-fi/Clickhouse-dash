#pragma once

#include "query_session.hpp"

#include <clickhouse/client.h>
#include <httplib.h>

#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace chdash {

struct AppConfig {
  std::string listen = "0.0.0.0:8080";

  // Directory that contains the frontend assets (index.html, app.js, style.css, fonts/...).
  // In the provided repo layout this is typically: ./static
  std::string static_dir = "./static";

  std::string ch_host = "127.0.0.1";
  int ch_port = 9000;
  std::string ch_user = "default";
  std::string ch_password = "";
  std::string ch_db = "default";
  bool ch_tls = false;
  int ch_tls_port = 9440;

  // How many result rows to stream before truncating (0 = unlimited)
  int result_preview_row_limit = 0;
};

class Server {
public:
  explicit Server(AppConfig cfg);

  int run();
  bool health_check(std::string* error_message = nullptr);

private:
  std::shared_ptr<clickhouse::Client> make_client(const std::string& db) const;
  
  void handle_healthz(const httplib::Request& req, httplib::Response& res);
  void handle_create_query(const httplib::Request& req, httplib::Response& res);
  void handle_query_stream(const httplib::Request& req, httplib::Response& res);
  void handle_cancel_query(const httplib::Request& req, httplib::Response& res);

  AppConfig cfg_;
  httplib::Server http_;

  std::mutex mu_;
  std::unordered_map<std::string, std::shared_ptr<QuerySession>> sessions_;
};

} // namespace chdash
