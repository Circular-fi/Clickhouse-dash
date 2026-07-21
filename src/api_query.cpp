#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "sql_util.hpp"
#include "time_util.hpp"

#include <array>
#include <chrono>
#include <iostream>
#include <random>
#include <string>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

namespace {

static std::string gen_query_id() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::array<uint8_t, 16> bytes{};
  const uint64_t a = rng();
  const uint64_t b = rng();
  for (size_t i = 0; i < 8; ++i) bytes[i] = static_cast<uint8_t>(a >> (i * 8));
  for (size_t i = 0; i < 8; ++i) bytes[i + 8] = static_cast<uint8_t>(b >> (i * 8));
  bytes[6] = static_cast<uint8_t>((bytes[6] & 0x0fU) | 0x40U); // UUID v4
  bytes[8] = static_cast<uint8_t>((bytes[8] & 0x3fU) | 0x80U);

  static constexpr char hex[] = "0123456789abcdef";
  std::string out(36, '0');
  size_t pos = 0;
  for (size_t i = 0; i < bytes.size(); ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out[pos++] = '-';
    out[pos++] = hex[bytes[i] >> 4];
    out[pos++] = hex[bytes[i] & 0x0fU];
  }
  return out;
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
  if (sql.size() > cfg_.query_max_sql_bytes) {
    return json_error(res, 413, "sql_too_large", "SQL text exceeds the configured query limit.");
  }
  const std::string host_id = doc["host_id"].GetString();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_down", "Selected host is down.");
  }

  reap_sessions_once();
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (sessions_.size() >= cfg_.query_session_max_count) {
      return json_error(res, 429, "too_many_queries", "Too many concurrent query sessions.");
    }
  }

  const std::string qid = gen_query_id();

  const std::string stats_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  auto session = std::make_shared<QuerySession>(
      qid,
      host_id,
      std::move(sql),
      "",
      host->runner_uri,
      stats_uri,
      client_pool_,
      cfg_.result_preview_row_limit,
      cfg_.query_options);
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (sessions_.size() >= cfg_.query_session_max_count) {
      return json_error(res, 429, "too_many_queries", "Too many concurrent query sessions.");
    }
    sessions_.emplace(qid, session);
  }
  // The query starts when the SSE consumer attaches. A client that abandons
  // POST /run therefore cannot execute an expensive query and fill the queue
  // without ever consuming the result.

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
    const std::string& cancel_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
    auto c = client_pool_ ? client_pool_->acquire(
      cancel_uri,
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      &err
    ) : make_client_from_uri(
      cancel_uri,
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


  res.status = 200;
  res.set_content("{\"ok\":true}", "application/json");
}

} // namespace chdash
