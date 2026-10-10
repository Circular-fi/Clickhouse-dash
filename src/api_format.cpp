#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "format_clickhouse.hpp"
#include "format_service.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "json_text.hpp"
#include "sql_util.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace chdash {

namespace {

constexpr size_t kMaxFormatSqlBytes = 500 * 1024;
constexpr rapidjson::SizeType kMaxBatchItems = 1024;
constexpr auto kMaxFormatBatchTime = std::chrono::seconds(10);

int requested_line_width(const rapidjson::Document& doc) {
  int width = 80;
  if (doc.HasMember("line_width") && doc["line_width"].IsInt()) width = doc["line_width"].GetInt();
  return std::max(40, std::min(200, width));
}

// The ClickHouse version of the host (its health check): formatQuery may answer another layout after an upgrade, so
// the version is part of the key. An MCP identity (<host>\x1fmcp) formats with the server of its host.
std::string formatter_version(const HealthRunner* health, const std::string& host_id) {
  if (!health) return {};
  const std::string base = host_id.substr(0, host_id.find('\x1f'));
  const HostsSnapshot snap = health->snapshot();
  for (const auto& h : snap.hosts) {
    if (h.id == base) return h.clickhouse_version;
  }
  return {};
}

void set_format_cache_header(httplib::Response& res, size_t hits, size_t misses) {
  const char* value = "miss";
  if (hits > 0 && misses == 0) value = "hit";
  else if (hits > 0) value = "partial";
  res.set_header("X-Chdash-Format-Cache", value);
}

// formatQuery on the pooled connection of the host: one connection for the whole request, taken at the first text that needs ClickHouse
// (a text with comments never does), and given back, or closed when it is no longer good. A connection that failed while
// idle is reconnected once (format_query_with_client).
class PooledFormatPort final : public FormatQueryPort {
public:
  PooledFormatPort(const std::shared_ptr<ClickHouseClientPool>& pool, const HealthRunner* health, const HostSpec& host, std::string host_id)
      : pool_(pool), health_(health), host_(host), host_id_(std::move(host_id)) {}

  FormatQueryResult format_query(const std::string& sql, size_t max_bytes) override {
    FormatQueryResult result;
    auto client = connect();
    if (!client) {
      result.failure = FormatQueryFailureKind::transport;
      result.message = connect_error_.empty() ? "Failed to connect to ClickHouse for formatQuery." : connect_error_;
      return result;
    }
    result = format_query_with_client(*client, sql, max_bytes);
    reconnect_attempted_ = reconnect_attempted_ || result.reconnect_attempted;
    if (!result.connection_reusable && pool_) pool_->invalidate(client);
    return result;
  }

  // The host is down (its health check): the answer is the one of every other route, not a transport error.
  bool host_down() const { return host_down_; }
  bool reconnect_attempted() const { return reconnect_attempted_; }

private:
  std::shared_ptr<clickhouse::Client> connect() {
    if (client_) return client_;
    if (attempted_) return {};
    attempted_ = true;
    if (!is_host_healthy(health_, host_id_)) {
      connect_error_ = "Selected host is down.";
      host_down_ = true;
      return {};
    }
    const auto timeout = std::chrono::seconds(5);
    client_ = pool_ ? pool_->acquire(host_.runner_uri, timeout, timeout, timeout, &connect_error_)
                    : make_client_from_uri(host_.runner_uri, timeout, timeout, timeout, &connect_error_);
    return client_;
  }

  std::shared_ptr<ClickHouseClientPool> pool_;
  const HealthRunner* health_;
  const HostSpec& host_;
  std::string host_id_;
  std::shared_ptr<clickhouse::Client> client_;
  std::string connect_error_;
  bool attempted_ = false;
  bool reconnect_attempted_ = false;
  bool host_down_ = false;
};

// The status and the code of a failure (docs/operations.md, "Errors"): a text that ClickHouse refuses is the user's (422);
// a connection that fails is 502; a time that runs out is 504; a ClickHouse that cannot do it is 503.
int format_error_status(FormatQueryFailureKind kind) {
  if (is_format_transport_failure(kind)) return 502;
  if (kind == FormatQueryFailureKind::timeout) return 504;
  if (kind == FormatQueryFailureKind::refused) return 503;
  return 422;
}

const char* format_error_code(FormatQueryFailureKind kind) {
  if (is_format_transport_failure(kind)) return "clickhouse_transport_error";
  if (kind == FormatQueryFailureKind::timeout) return "format_timeout";
  if (kind == FormatQueryFailureKind::refused) return "format_unavailable";
  return "format_failed";
}

} // namespace

void Server::handle_api_format(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString()) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }

  const std::string host_id = doc["host_id"].GetString();
  const HostSpec* host = find_request_host(cfg_, req, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  FormatSettings settings;
  settings.line_width = requested_line_width(doc);
  settings.cache_scope = host_id + '\x1f' + formatter_version(health_.get(), host_id);
  // `"cache": false` formats from scratch (the idempotence checks of the formatter suite run the formatter on its own output).
  settings.use_cache = !(doc.HasMember("cache") && doc["cache"].IsBool() && !doc["cache"].GetBool());
  settings.max_sql_bytes = kMaxFormatSqlBytes;
  PooledFormatPort port(client_pool_, health_.get(), *host, host_id);
  FormatBatch batch(format_cache_.get(), settings, port);

  const auto write_cache_meta = [&](rapidjson::Writer<rapidjson::StringBuffer>& w) {
    const FormatStats& stats = batch.stats();
    w.Key("cache");
    w.StartObject();
    w.Key("hits"); w.Uint64(stats.cache_hits);
    w.Key("misses"); w.Uint64(stats.cache_misses);
    w.Key("deduplicated"); w.Uint64(stats.deduplicated);
    w.EndObject();
    w.Key("line_width"); w.Int(settings.line_width);
  };
  const auto finish_headers = [&] {
    const FormatStats& stats = batch.stats();
    set_format_cache_header(res, stats.cache_hits + stats.deduplicated, stats.cache_misses);
    if (port.reconnect_attempted()) res.set_header("X-Chdash-Format-Reconnect", "1");
  };
  // A text that could not be formatted: the answer names it (`index` in a batch) and, for an error of ClickHouse, where.
  const auto fail = [&](const std::string& sql, const FormatOutcome& outcome, const int* index) {
    const std::string sql_trimmed = trim_sql(sql);
    const auto loc = parse_clickhouse_error_location(outcome.error, sql_trimmed);
    const ClickHouseErrorLocation* locp = (loc.has_code || loc.has_position || loc.has_line_col || loc.has_near) ? &loc : nullptr;
    if (port.reconnect_attempted()) res.set_header("X-Chdash-Format-Reconnect", "1");
    if (port.host_down()) return json_error(res, 503, "host_unavailable", "Selected host is down.");
    return json_error_with_payload(res, format_error_status(outcome.failure), format_error_code(outcome.failure), outcome.error, locp,
                                   nullptr, index);
  };

  if (doc.HasMember("sqls") && doc["sqls"].IsArray()) {
    const auto& arr = doc["sqls"];
    if (arr.Size() > kMaxBatchItems) {
      return json_error(res, 413, "too_many_sqls", "Too many SQL statements in one format request.");
    }
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      if (!arr[i].IsString()) {
        return json_error(res, 400, "invalid_sqls", "sqls must be an array of strings.");
      }
    }

    std::vector<FormatCache::ValuePtr> formatted_sqls;
    formatted_sqls.reserve(arr.Size());
    // One statement gives up after 2 s (postprocess_format_query); a batch gives up after kMaxFormatBatchTime: the statements
    // left come back as written rather than holding a worker thread for minutes.
    const auto batch_deadline = std::chrono::steady_clock::now() + kMaxFormatBatchTime;
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      const std::string text(arr[i].GetString(), arr[i].GetStringLength());
      if (std::chrono::steady_clock::now() > batch_deadline) {
        formatted_sqls.push_back(std::make_shared<const std::string>(trim_sql(text)));
        continue;
      }
      FormatOutcome outcome = batch.format(text);
      if (!outcome.ok()) {
        const int index = static_cast<int>(i);
        return fail(text, outcome, &index);
      }
      formatted_sqls.push_back(std::move(outcome.formatted));
    }

    rapidjson::StringBuffer sb(nullptr, 4096);
    rapidjson::Writer<rapidjson::StringBuffer> w(sb);
    w.StartObject();
    w.Key("formatted_sqls");
    w.StartArray();
    for (const auto& pretty : formatted_sqls) write_json_text(w, *pretty);
    w.EndArray();
    write_cache_meta(w);
    w.EndObject();

    finish_headers();
    res.status = 200;
    res.set_content(sb.GetString(), sb.GetSize(), "application/json");
    return;
  }

  if (!doc.HasMember("sql") || !doc["sql"].IsString()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }

  const std::string text(doc["sql"].GetString(), doc["sql"].GetStringLength());
  FormatOutcome outcome = batch.format(text);
  if (!outcome.ok()) return fail(text, outcome, nullptr);

  rapidjson::StringBuffer sb(nullptr, std::max<size_t>(1024, outcome.formatted->size() + 128));
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("formatted_sql");
  write_json_text(w, *outcome.formatted);
  write_cache_meta(w);
  w.EndObject();

  finish_headers();
  res.status = 200;
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

} // namespace chdash
