#include "server.hpp"
#include "serve_embedded_static.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <chrono>
#include <deque>
#include <ctime>
#include <fstream>
#include <random>
#include <sstream>
#include <thread>

namespace chdash {

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

static void json_error(httplib::Response& res, int status, const std::string& code, const std::string& message) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("error_code"); w.String(code.c_str(), (rapidjson::SizeType)code.size());
  w.Key("message"); w.String(message.c_str(), (rapidjson::SizeType)message.size());
  w.EndObject();
  res.status = status;
  res.set_header("Content-Type", "application/json");
  res.set_content(sb.GetString(), "application/json");
}

static bool parse_json_body(const httplib::Request& req, rapidjson::Document& doc) {
  doc.Parse(req.body.c_str());
  return !doc.HasParseError() && doc.IsObject();
}

static std::string sse_json_event(const std::string& event, const std::string& json) {
  std::ostringstream oss;
  oss << "event: " << event << "\n";
  oss << "data: " << json << "\n\n";
  return oss.str();
}

static std::string build_meta_json(const std::string& qid) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(qid.c_str());
  w.Key("status"); w.String("connected");
  w.EndObject();
  return sb.GetString();
}

static std::string build_keepalive_json(const std::string& qid) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(qid.c_str());

  auto t = std::time(nullptr);
  std::tm tm{};
#if defined(_WIN32)
  gmtime_s(&tm, &t);
#else
  gmtime_r(&t, &tm);
#endif
  char buf[64];
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);

  w.Key("time"); w.String(buf);
  w.EndObject();
  return sb.GetString();
}

struct StreamState {
  std::shared_ptr<QuerySession> session;
  std::string query_id;

  std::chrono::steady_clock::time_point last_publish{};
  std::chrono::steady_clock::time_point last_keepalive{};

  uint64_t prev_read_rows = 0;
  uint64_t prev_read_bytes = 0;

  int64_t prev_cpu_total_us = 0;

  int64_t cpu_inst_max_centi = 0;
  int64_t thread_peak = 0;

  std::deque<std::string> local_chunks;
};

static std::string build_tick_json(const SessionSnapshot& snap, StreamState& st) {
  int64_t percentCenti = 0;
  int64_t knownInt = 0;
  if (snap.total_rows_to_read > 0) {
    knownInt = 1;
    const __int128 num = static_cast<__int128>(snap.read_rows_total) * 10000;
    percentCenti = static_cast<int64_t>(num / static_cast<__int128>(snap.total_rows_to_read));
    if (percentCenti < 0) percentCenti = 0;
    if (percentCenti > 10000) percentCenti = 10000;
  }

  const auto now = std::chrono::steady_clock::now();
  const auto prev_publish = st.last_publish;

  int64_t rowsPerSec = 0;
  int64_t bytesPerSec = 0;

  if (prev_publish.time_since_epoch().count() != 0) {
    const double dt = std::chrono::duration_cast<std::chrono::duration<double>>(now - prev_publish).count();
    if (dt > 1e-9) {
      rowsPerSec = static_cast<int64_t>(double(snap.read_rows_total - st.prev_read_rows) / dt);
      bytesPerSec = static_cast<int64_t>(double(snap.read_bytes_total - st.prev_read_bytes) / dt);
      if (rowsPerSec < 0) rowsPerSec = 0;
      if (bytesPerSec < 0) bytesPerSec = 0;
    }
  }

  st.prev_read_rows = snap.read_rows_total;
  st.prev_read_bytes = snap.read_bytes_total;

  int64_t cpuCenti = 0;
  {
    const int64_t cpu_total_us = snap.user_time_us_total + snap.system_time_us_total;
    if (prev_publish.time_since_epoch().count() != 0) {
      const auto dt_us = std::chrono::duration_cast<std::chrono::microseconds>(now - prev_publish).count();
      const int64_t d_cpu = cpu_total_us - st.prev_cpu_total_us;
      if (dt_us > 0 && d_cpu >= 0) {
        cpuCenti = static_cast<int64_t>((__int128)d_cpu * 10000 / dt_us);
      }
    }
    st.prev_cpu_total_us = cpu_total_us;
    if (cpuCenti > st.cpu_inst_max_centi) st.cpu_inst_max_centi = cpuCenti;
  }

  st.last_publish = now;

  const int64_t memInst = snap.current_mem_bytes;
  const int64_t memMax = snap.peak_mem_bytes;

  const int64_t thrInst = snap.threads_inst;
  if (snap.threads_peak > st.thread_peak) st.thread_peak = snap.threads_peak;
  const int64_t thrMax = st.thread_peak;

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartArray();
  w.Int64(snap.elapsed_ms);
  w.Int64(percentCenti);
  w.Int64(knownInt);
  w.Int64((int64_t)snap.read_rows_total);
  w.Int64((int64_t)snap.read_bytes_total);
  w.Int64((int64_t)snap.total_rows_to_read);
  w.Int64(rowsPerSec);
  w.Int64(bytesPerSec);
  w.Int64(cpuCenti);
  w.Int64(st.cpu_inst_max_centi);
  if (memInst < 0) w.Null(); else w.Int64(memInst);
  if (memMax < 0) w.Null(); else w.Int64(memMax);
  w.Int64(thrInst);
  w.Int64(thrMax);
  auto samples = st.session->drain_samples();
  if (samples.empty()) {
    w.Null();
  } else {
    w.StartArray();
    for (const auto& s : samples) {
      w.StartArray();
      w.Int64(s.elapsed_ms);
      w.Uint64(s.read_bytes_total);
      if (s.cpu_centi < 0) w.Null(); else w.Int64(s.cpu_centi);
      if (s.mem_bytes < 0) w.Null(); else w.Int64(s.mem_bytes);
      w.Int64(s.threads);
      w.EndArray();
    }
    w.EndArray();
  }
  w.EndArray();
  return sb.GetString();
}

static std::string build_done_json(const SessionSnapshot& snap, const std::string& message, bool truncated) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(snap.query_id.c_str());
  w.Key("status");
  switch (snap.status) {
    case SessionStatus::Finished: w.String("finished"); break;
    case SessionStatus::Canceled: w.String("canceled"); break;
    case SessionStatus::Error: w.String("error"); break;
    case SessionStatus::ResultLimitReached: w.String("result_limit_reached"); break;
    default: w.String("finished"); break;
  }
  w.Key("elapsed_seconds"); w.Double(double(snap.elapsed_ms) / 1000.0);
  w.Key("read_rows"); w.Uint64(snap.read_rows_total);
  w.Key("read_bytes"); w.Uint64(snap.read_bytes_total);
  w.Key("result_rows_returned"); w.Uint64(snap.wrote_rows_total);
  w.Key("result_truncated"); w.Bool(truncated);
  if (!message.empty()) {
    w.Key("message"); w.String(message.c_str());
  }
  w.EndObject();
  return sb.GetString();
}

Server::Server(AppConfig cfg) : cfg_(std::move(cfg)) {
  http_.Get("/", [&](const auto& /*req*/, auto& res) {
    httplib::Request fake;
    fake.method = "GET";
    fake.path = "/";
    if (!try_serve_embedded(fake, res)) {
      res.status = 404;
      res.set_content("embedded index.html not found", "text/plain");
    }
  });

  http_.Get(R"(/static/.*)", [&](const auto& req, auto& res) {
    if (!try_serve_embedded(req, res)) {
      res.status = 404;
      res.set_content("embedded asset not found", "text/plain");
    }
  });

  http_.Get("/healthz", [&](const auto& req, auto& res) { handle_healthz(req, res); });
  http_.Post("/api/query", [&](const auto& req, auto& res) { handle_create_query(req, res); });
  http_.Get("/api/query/stream", [&](const auto& req, auto& res) { handle_query_stream(req, res); });
  http_.Post("/api/query/cancel", [&](const auto& req, auto& res) { handle_cancel_query(req, res); });
}

std::shared_ptr<clickhouse::Client> Server::make_client(const std::string& db) const {
  clickhouse::ClientOptions opt;
  opt.SetHost(cfg_.ch_host);
  opt.SetUser(cfg_.ch_user);
  opt.SetPassword(cfg_.ch_password);
  opt.SetDefaultDatabase(db.empty() ? cfg_.ch_db : db);

  if (cfg_.ch_tls) {
    opt.SetPort(cfg_.ch_tls_port);
    opt.SetSSLOptions({});
  } else {
    opt.SetPort(cfg_.ch_port);
  }

  return std::make_shared<clickhouse::Client>(opt);
}

int Server::run() {
  auto pos = cfg_.listen.rfind(':');
  std::string host = "0.0.0.0";
  int port = 8080;
  if (pos != std::string::npos) {
    host = cfg_.listen.substr(0, pos);
    port = std::stoi(cfg_.listen.substr(pos + 1));
  }
  return http_.listen(host.c_str(), port) ? 0 : 1;
}


bool Server::health_check(std::string* error_message) {
  try {
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& kv : sessions_) {
        const auto snap = kv.second->snapshot();
        if (snap.status == SessionStatus::Running || snap.status == SessionStatus::Created) {
          return true;
        }
      }
    }

    auto c = make_client(cfg_.ch_db);
    c->Execute("SELECT 1");
    return true;
  } catch (const std::exception& e) {
    if (error_message) *error_message = e.what();
    return false;
  }
}

void Server::handle_healthz(const httplib::Request& , httplib::Response& res) {
  std::string err;
  if (this->health_check(&err)) {
    res.status = 200;
    res.set_content("ok", "text/plain");
  } else {
    json_error(res, 503, "db_unhealthy", err);
  }
}

void Server::handle_create_query(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("sql") || !doc["sql"].IsString()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }

  std::string sql = doc["sql"].GetString();
  while (!sql.empty() && (sql.back() == ' ' || sql.back() == '\n' || sql.back() == '\r' || sql.back() == '\t' || sql.back() == ';')) sql.pop_back();
  size_t i = 0;
  while (i < sql.size() && (sql[i] == ' ' || sql[i] == '\n' || sql[i] == '\r' || sql[i] == '\t')) i++;
  if (i > 0) sql.erase(0, i);

  if (sql.empty()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }

  std::string db = cfg_.ch_db;
  if (doc.HasMember("database") && doc["database"].IsString()) {
    db = doc["database"].GetString();
  }

  const std::string qid = gen_query_id();

  auto client_query = make_client(db);
  auto session = std::make_shared<QuerySession>(qid, sql, db, client_query, cfg_.result_preview_row_limit);

  {
    std::lock_guard<std::mutex> lk(mu_);
    sessions_[qid] = session;
  }

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("query_id"); w.String(qid.c_str());
  std::string stream = "api/query/stream?query_id=" + qid;
  w.Key("stream_url"); w.String(stream.c_str());
  w.EndObject();

  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_query_stream(const httplib::Request& req, httplib::Response& res) {
  const std::string qid = req.get_param_value("query_id");
  if (qid.empty()) {
    return json_error(res, 400, "missing_query_id", "Missing query_id query parameter.");
  }

  std::shared_ptr<QuerySession> session;
  {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = sessions_.find(qid);
    if (it == sessions_.end()) return json_error(res, 404, "not_found", "Unknown query_id.");
    session = it->second;
  }

  session->start();

  res.set_header("Content-Type", "text/event-stream");
  res.set_header("Cache-Control", "no-cache");
  res.set_header("Connection", "keep-alive");
  res.set_header("X-Accel-Buffering", "no");

  auto st = std::make_shared<StreamState>();
  st->session = session;
  st->query_id = qid;
  st->local_chunks.push_back(sse_json_event("meta", build_meta_json(qid)));

  res.set_chunked_content_provider(
    "text/event-stream",
    [st](size_t /*offset*/, httplib::DataSink& sink) {
      if (!st->local_chunks.empty()) {
        auto chunk = std::move(st->local_chunks.front());
        st->local_chunks.pop_front();
        sink.write(chunk.data(), chunk.size());
        return true;
      }

      const auto now = std::chrono::steady_clock::now();
      if (st->last_publish.time_since_epoch().count() == 0 || now - st->last_publish >= std::chrono::milliseconds(250)) {
        const auto snap = st->session->snapshot();
        const auto tick = sse_json_event("tick", build_tick_json(snap, *st));
        sink.write(tick.data(), tick.size());

        if (snap.status == SessionStatus::Finished || snap.status == SessionStatus::Error || snap.status == SessionStatus::Canceled || snap.status == SessionStatus::ResultLimitReached) {
          const bool truncated = (snap.status == SessionStatus::ResultLimitReached);
          const auto done = sse_json_event("done", build_done_json(snap, "", truncated));
          sink.write(done.data(), done.size());
          sink.done();
          return false;
        }

        return true;
      }

      std::string produced;
      const bool cont = st->session->wait_pop_sse_chunk(produced, 30);
      if (!produced.empty()) {
        sink.write(produced.data(), produced.size());
        return true;
      }

      if (!cont) {
        const auto snap = st->session->snapshot();
        const bool truncated = (snap.status == SessionStatus::ResultLimitReached);
        const auto done = sse_json_event("done", build_done_json(snap, "", truncated));
        sink.write(done.data(), done.size());
        sink.done();
        return false;
      }

      if (st->last_keepalive.time_since_epoch().count() == 0 || now - st->last_keepalive >= std::chrono::seconds(15)) {
        st->last_keepalive = now;
        const auto ka = sse_json_event("keepalive", build_keepalive_json(st->query_id));
        sink.write(ka.data(), ka.size());
        return cont;
      }

      std::this_thread::sleep_for(std::chrono::milliseconds(10));
      return cont;
    },
    [session](bool success) {
      if (!success) {
        session->request_cancel();
      }
    }
  );
}

void Server::handle_cancel_query(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("query_id") || !doc["query_id"].IsString()) {
    return json_error(res, 400, "missing_query_id", "Missing query_id.");
  }

  std::string qid = doc["query_id"].GetString();

  std::shared_ptr<QuerySession> session;
  {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = sessions_.find(qid);
    if (it == sessions_.end()) return json_error(res, 404, "not_found", "Unknown query_id.");
    session = it->second;
  }

  session->request_cancel();
  res.status = 200;
  res.set_content("{\"ok\":true}", "application/json");
}

} 