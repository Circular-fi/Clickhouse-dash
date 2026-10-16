#include "server.hpp"

#include "api_error.hpp"
#include "error_envelope.hpp"
#include "ch_uri.hpp"
#include "format_clickhouse.hpp"
#include "format_pooled_port.hpp"
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

void set_format_cache_header(httplib::Response& res, size_t hits, size_t misses) {
  const char* value = "miss";
  if (hits > 0 && misses == 0) value = "hit";
  else if (hits > 0) value = "partial";
  res.set_header("X-Chdash-Format-Cache", value);
}

// The status and the code of a failure (docs/operations.md, "Errors"). A text that ClickHouse refuses is an error of the user (422).
// A connection that fails gives 502. A timeout gives 504. A ClickHouse that cannot do the work gives 503.
int format_error_status(FormatQueryFailureKind kind) {
  if (is_format_transport_failure(kind)) return 502;
  if (kind == FormatQueryFailureKind::timeout) return 504;
  if (kind == FormatQueryFailureKind::refused) return 503;
  return 422;
}

// The formatter gives this warning for a text that it did not lay out: {"warning": {"code": ..., "message": ...}}. The answer is the text as written.
void write_warning(rapidjson::Writer<rapidjson::StringBuffer>& w, const FormatOutcome& outcome) {
  if (!outcome.warning) return;
  w.Key("warning");
  w.StartObject();
  w.Key("code"); write_json_text(w, outcome.warning->code);
  w.Key("message"); write_json_text(w, outcome.warning->message);
  w.EndObject();
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
  const FormatterHost formatter = formatter_host(health_.get(), host_id);
  settings.cache_scope = host_id + '\x1f' + formatter.version;
  settings.clickhouse_max_query_size = formatter.max_query_size;
  // `"cache": false` formats from scratch. The idempotence checks of the formatter suite run the formatter on its own output.
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
  // A text that could not be formatted. The answer names it (`index` in a batch). For an error of ClickHouse, the answer names the place.
  const auto fail = [&](const std::string& sql, const FormatOutcome& outcome, const int* index) {
    // The position is in the text that the user sent. The service counts it back from the text that ClickHouse read.
    const auto loc = parse_clickhouse_error_location(outcome.error, sql);
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
    std::vector<std::string> texts;
    texts.reserve(arr.Size());
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      if (!arr[i].IsString()) {
        return json_error(res, 400, "invalid_sqls", "sqls must be an array of strings.");
      }
      texts.emplace_back(arr[i].GetString(), arr[i].GetStringLength());
    }

    // One text stops after 2 s (postprocess_format_query). The batch has a time limit of its own (kMaxFormatBatchTime).
    // The texts that start after this time are skipped. The same applies to a caller that went away, or to a server that stops.
    // A failed text affects no other text. Every other text has its own answer.
    FormatBatchLimits limits;
    limits.deadline = std::chrono::steady_clock::now() + kMaxFormatBatchTime;
    limits.stop = [this, &req] { return stopping() || (req.is_connection_closed && req.is_connection_closed()); };
    const std::vector<FormatItem> items = format_texts(batch, texts, limits);

    size_t formatted = 0, failed = 0, skipped = 0;
    rapidjson::StringBuffer sb(nullptr, 4096);
    rapidjson::Writer<rapidjson::StringBuffer> w(sb);
    w.StartObject();
    w.Key("results");
    w.StartArray();
    for (size_t i = 0; i < items.size(); ++i) {
      const FormatItem& item = items[i];
      const int index = static_cast<int>(i);
      w.StartObject();
      w.Key("index"); w.Int(index);
      if (item.status == FormatItemStatus::Formatted) {
        ++formatted;
        w.Key("status"); w.String("formatted");
        w.Key("formatted_sql"); write_json_text(w, *item.outcome.formatted);
        write_warning(w, item.outcome);
      } else {
        ApiError error;
        error.index = index;
        if (item.status == FormatItemStatus::Skipped) {
          ++skipped;
          w.Key("status"); w.String("skipped");
          error.status = item.skipped_for_stop ? 503 : 504;
          error.code = item.skipped_for_stop ? "canceled" : "format_timeout";
          error.message = item.skipped_for_stop ? "This statement was not formatted: the request was stopped."
                                                : "This statement was not formatted: the time of the request ran out. Format it again.";
        } else {
          ++failed;
          w.Key("status"); w.String("error");
          const auto loc = parse_clickhouse_error_location(item.outcome.error, texts[i]);
          if (loc.has_code || loc.has_position || loc.has_line_col || loc.has_near) error.clickhouse = loc;
          if (port.host_down() && is_format_transport_failure(item.outcome.failure)) {
            error.status = 503;
            error.code = "host_unavailable";
            error.message = "Selected host is down.";
          } else {
            error.status = format_error_status(item.outcome.failure);
            error.code = format_error_code(item.outcome.failure);
            error.message = item.outcome.error;
          }
        }
        const std::string json = error_json(error);
        w.Key("error");
        w.RawValue(json.data(), json.size(), rapidjson::kObjectType);
      }
      w.EndObject();
    }
    w.EndArray();
    w.Key("formatted"); w.Uint64(formatted);
    w.Key("failed"); w.Uint64(failed);
    w.Key("skipped"); w.Uint64(skipped);
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
  write_warning(w, outcome);
  write_cache_meta(w);
  w.EndObject();

  finish_headers();
  res.status = 200;
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

} // namespace chdash
