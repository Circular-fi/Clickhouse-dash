#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "log.hpp"
#include "secure_random.hpp"
#include "sql_util.hpp"
#include "time_util.hpp"
#include "user_sql_policy.hpp"
#include "json_text.hpp"
#include "sql_literal.hpp"

#include <chrono>
#include <string>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

namespace {

static std::string terminal_status_name(SessionStatus status) {
  switch (status) {
    case SessionStatus::Finished: return "finished";
    case SessionStatus::Error: return "error";
    case SessionStatus::Canceled: return "canceled";
    case SessionStatus::ResultLimitReached: return "result_limit_reached";
    case SessionStatus::Created: return "created";
    case SessionStatus::Running: return "running";
  }
  return "unknown";
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
  if (user_sql_is_forbidden(sql)) {
    return json_error(
        res,
        403,
        "sql_forbidden",
        "Direct KILL QUERY is disabled in panel SQL; use the query cancel capability.");
  }
  const std::string host_id = doc["host_id"].GetString();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  QueryRunMode run_mode = QueryRunMode::Normal;
  if (doc.HasMember("mode")) {
    if (!doc["mode"].IsString()) {
      return json_error(res, 400, "invalid_run_mode", "mode must be either normal or profiling.");
    }
    const std::string mode = doc["mode"].GetString();
    if (mode == "normal") run_mode = QueryRunMode::Normal;
    else if (mode == "profiling") run_mode = QueryRunMode::Profiling;
    else return json_error(res, 400, "invalid_run_mode", "mode must be either normal or profiling.");
  }
  const bool detailed_profiling = run_mode == QueryRunMode::Profiling;

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

  const std::string qid = random_uuid_v4();
  const std::string registry_sql = sql;

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
      cfg_.query_options,
      detailed_profiling,
      [registry = query_registry_, qid](const std::string& native_query_id) {
        if (registry) registry->add_native_query_id(qid, native_query_id);
      },
      [registry = query_registry_, qid](SessionStatus status, int64_t session_elapsed_ms) {
        if (!registry) return;
        registry->mark_terminal(
            qid,
            terminal_status_name(status),
            status == SessionStatus::ResultLimitReached,
            session_elapsed_ms);
      });
  session->set_worker_group(query_workers_);
  session->set_describe_cache(describe_plans_);
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (sessions_.size() >= cfg_.query_session_max_count) {
      return json_error(res, 429, "too_many_queries", "Too many concurrent query sessions.");
    }
    sessions_.emplace(qid, session);
  }
  if (query_registry_) {
    query_registry_->register_query(qid, host_id, run_mode, registry_sql);
  }
  // The query starts when the SSE consumer attaches. A client that abandons
  // POST /run therefore cannot execute an expensive query and fill the queue
  // without ever consuming the result.

  JwtClaims claims;
  claims.query_id = qid;
  claims.host_id = host_id;
  claims.issued_at_unix = now_unix_sec();
  claims.expires_at_unix = claims.issued_at_unix +
      std::max<int64_t>(1, cfg_.cancel_token_ttl_ms / 1000);
  const std::string cancel_token = jwt_.sign_cancel_token(claims);

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); write_json_text(w, qid);
  w.Key("run_mode"); w.String(detailed_profiling ? "profiling" : "normal");
  w.Key("analysis_available"); w.Bool(detailed_profiling);
  w.Key("cancel_token"); write_json_text(w, cancel_token);
  std::string stream = "api/query/stream?query_id=" + qid;
  w.Key("stream_url"); write_json_text(w, stream);
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
  auto claims = jwt_.verify_cancel_token(token, now_unix_sec());
  if (!claims) {
    return json_error(res, 401, "invalid_token", "Invalid cancel_token.");
  }

  const std::string qid = claims->query_id;
  const std::string host_id = claims->host_id;

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  std::shared_ptr<QuerySession> session;
  {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = sessions_.find(qid);
    if (it != sessions_.end()) session = it->second;
  }

  // The answer says what happened (docs/configuration.md, "Authorization model"): `stopped` when a run of this server
  // owned the query and stopped streaming it, `killed` how many ClickHouse queries KILL QUERY found
  // (0: nothing was running any more), `kill_error` when the KILL could not run.
  KillOutcome kill;
  if (session) {
    session->request_cancel();
    // Compatibility retries use distinct native ids while keeping the public
    // browser id stable. Cancel every native attempt owned by the session.
    kill = session->cancel_native_queries_best_effort(false);
  } else {
    // The session may already have been reaped while ClickHouse still finishes
    // removing a compatibility attempt. Match both the public id and the
    // deterministic retry prefix without relying on in-memory session state.
    const std::string& cancel_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
    const std::string qid_quoted = sql::quote_string(qid);
    const std::string retry_prefix_quoted = sql::quote_string(qid + "-attempt-");
    kill = kill_queries(cancel_uri,
                        "query_id = " + qid_quoted + " OR startsWith(query_id, " + retry_prefix_quoted + ")", false);
    if (!kill.sent) {
      log_event(LogLevel::Warn, "query.cancel_failed", {{"host", host_id}, {"error", kill.error}});
      return json_error(res, 502, "cancel_failed",
                        "The query could not be canceled: " + (kill.error.empty() ? std::string("no answer") : kill.error));
    }
  }

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("ok"); w.Bool(true);
  w.Key("stopped"); w.Bool(static_cast<bool>(session));
  w.Key("killed"); w.Uint64(kill.matched);
  if (!kill.sent) {
    w.Key("kill_error"); write_json_text(w, kill.error);
  }
  w.EndObject();
  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
