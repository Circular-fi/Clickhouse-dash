#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "query_sql_store.hpp"
#include "sql_util.hpp"
#include "time_util.hpp"

#include <chrono>
#include <iostream>
#include <random>
#include <sstream>
#include <string>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

namespace {

static std::string gen_query_id() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  auto hex = [](uint64_t x, int n) {
    std::ostringstream oss;
    oss << std::hex;
    oss.width(n);
    oss.fill('0');
    if (n >= 16) oss << x;
    else oss << (x & ((1ull << (4 * n)) - 1));
    return oss.str();
  };
  uint64_t a = rng();
  uint64_t b = rng();
  return hex(a, 8) + "-" + hex(a >> 32, 4) + "-" + hex(a >> 48, 4) + "-" + hex(b, 4) + "-" + hex(b >> 16, 12);
}

}

void Server::handle_query_run(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("sql") || !doc["sql"].IsString()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString()) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }

  std::string sql_raw = doc["sql"].GetString();
  std::string sql = trim_sql(sql_raw);
  if (sql.empty()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }
  const std::string host_id = doc["host_id"].GetString();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  if (health_) {
    HostsSnapshot hs = health_->snapshot();
    for (const auto& h : hs.hosts) {
      if (h.id == host_id && !h.healthy) {
        return json_error(res, 503, "host_down", "Selected host is down.");
      }
    }
  }

  const std::string qid = gen_query_id();
  remember_query_sql(qid, sql);

  std::string client_err;
  auto client_query = make_client_from_uri(
    host->runner_uri,
    std::chrono::seconds(5),
    std::chrono::milliseconds(0),
    std::chrono::milliseconds(0),
    &client_err
  );
  if (!client_query) {
    return json_error(res, 503, "host_down", "Could not connect to host.");
  }

  auto session = std::make_shared<QuerySession>(qid, sql, "", client_query, cfg_.result_preview_row_limit);
  {
    std::lock_guard<std::mutex> lk(mu_);
    sessions_[qid] = session;
  }
  session->start();

  JwtClaims claims;
  claims.query_id = qid;
  claims.host_id = host_id;
  claims.issued_at_unix = now_unix_sec();
  const std::string cancel_token = jwt_.sign_cancel_token(claims);

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(qid.c_str());
  w.Key("cancel_token"); w.String(cancel_token.c_str());
  std::string stream = "api/query/stream?query_id=" + qid;
  w.Key("stream_url"); w.String(stream.c_str());
  w.EndObject();

  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_query_cancel(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("cancel_token") || !doc["cancel_token"].IsString()) {
    return json_error(res, 400, "missing_cancel_token", "Missing cancel_token.");
  }

  const std::string token = doc["cancel_token"].GetString();
  auto claims = jwt_.verify_cancel_token(token);
  if (!claims) {
    return json_error(res, 401, "invalid_token", "Invalid cancel_token.");
  }

  const std::string qid = claims->query_id;
  const std::string host_id = claims->host_id;

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = sessions_.find(qid);
    if (it != sessions_.end()) {
      it->second->request_cancel();
    }
  }

  try {
    std::string err;
    auto c = make_client_from_uri(
      host->system_uri,
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      &err
    );
    if (!c) {
      std::cerr << "[cancel] host=" << host_id << " qid=" << qid << " connect error: " << err << "\n";
    } else {
      const std::string qid_esc = escape_single_quotes(qid);
      const std::string kill_sql = "KILL QUERY WHERE query_id = '" + qid_esc + "'";
      c->Execute(kill_sql);
    }
  } catch (const std::exception& e) {
    std::cerr << "[cancel] host=" << host_id << " qid=" << qid << " error: " << e.what() << "\n";
  }

  forget_query_sql(qid);

  res.status = 200;
  res.set_content("{\"ok\":true}", "application/json");
}

} // namespace chdash
