#include "server.hpp"

#include "api_error.hpp"
#include "allowed_objects.hpp"
#include "ch_uri.hpp"
#include "export_serializer.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "query_execution.hpp"
#include "sql_util.hpp"
#include "user_sql_policy.hpp"
#include "time_util.hpp"
#include "zip_stream.hpp"

#include <clickhouse/client.h>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {
namespace {

std::string random_uuid_v4() {
  static thread_local std::mt19937_64 rng{std::random_device{}()};
  std::array<uint8_t, 16> bytes{};
  const uint64_t a = rng();
  const uint64_t b = rng();
  for (size_t i = 0; i < 8; ++i) bytes[i] = static_cast<uint8_t>(a >> (i * 8));
  for (size_t i = 0; i < 8; ++i) bytes[i + 8] = static_cast<uint8_t>(b >> (i * 8));
  bytes[6] = static_cast<uint8_t>((bytes[6] & 0x0fU) | 0x40U);
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

std::string csv_escape(std::string_view value) {
  bool quote = false;
  for (const char ch : value) {
    if (ch == ',' || ch == '"' || ch == '\n' || ch == '\r') {
      quote = true;
      break;
    }
  }
  if (!quote) return std::string(value);
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('"');
  for (const char ch : value) {
    if (ch == '"') out += "\"\"";
    else out.push_back(ch);
  }
  out.push_back('"');
  return out;
}

std::string join_semicolon(const std::vector<std::string>& values) {
  std::string out;
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out.push_back(';');
    out += values[i];
  }
  return out;
}

std::optional<std::pair<std::string, std::string>> split_qualified_name(std::string value) {
  if (value.empty()) return std::nullopt;
  auto clean = [](std::string part) {
    if (part.size() >= 2 && part.front() == '`' && part.back() == '`') {
      part = part.substr(1, part.size() - 2);
    }
    return part;
  };
  const size_t dot = value.find('.');
  if (dot == std::string::npos || dot == 0 || dot + 1 >= value.size()) return std::nullopt;
  std::string database = clean(value.substr(0, dot));
  std::string table = clean(value.substr(dot + 1));
  if (database.empty() || table.empty()) return std::nullopt;
  return std::make_pair(std::move(database), std::move(table));
}

void filter_execution_stats(QueryExecutionStats& stats, const AllowedObjectSet* allowed) {
  if (!allowed) {
    stats.databases.clear();
    stats.tables.clear();
    stats.projections.clear();
    return;
  }
  stats.databases.erase(
      std::remove_if(stats.databases.begin(), stats.databases.end(), [&](const std::string& db) {
        return !allowed->allows_database(db);
      }), stats.databases.end());
  stats.tables.erase(
      std::remove_if(stats.tables.begin(), stats.tables.end(), [&](const std::string& table) {
        const auto parsed = split_qualified_name(table);
        return !parsed || !allowed->allows_table(parsed->first, parsed->second);
      }), stats.tables.end());
  if (stats.tables.empty()) stats.projections.clear();
}

std::string execution_csv(
    const QueryExecutionStats& stats,
    const std::string& terminal_status,
    bool query_failed) {
  static constexpr const char* header =
      "query_id,native_query_id,status,event_time,duration_ms,read_rows,read_bytes,"
      "written_rows,written_bytes,result_rows,result_bytes,memory_usage,peak_threads_usage,"
      "database,tables,projections,exception_code,exception,logs_pending,collector_error\n";
  std::vector<std::string> values;
  values.reserve(20);
  values.push_back(stats.query_id);
  values.push_back(stats.native_query_id);
  values.push_back(terminal_status);
  values.push_back(stats.event_time);
  values.push_back(stats.available ? std::to_string(stats.duration_ms) : "");
  values.push_back(stats.available ? std::to_string(stats.read_rows) : "");
  values.push_back(stats.available ? std::to_string(stats.read_bytes) : "");
  values.push_back(stats.available ? std::to_string(stats.written_rows) : "");
  values.push_back(stats.available ? std::to_string(stats.written_bytes) : "");
  values.push_back(stats.available ? std::to_string(stats.result_rows) : "");
  values.push_back(stats.available ? std::to_string(stats.result_bytes) : "");
  values.push_back(stats.available ? std::to_string(stats.memory_usage) : "");
  values.push_back(stats.available ? std::to_string(stats.peak_threads_usage) : "");
  values.push_back(join_semicolon(stats.databases));
  values.push_back(join_semicolon(stats.tables));
  values.push_back(join_semicolon(stats.projections));
  values.push_back(stats.available ? std::to_string(stats.exception_code) : (query_failed ? "-1" : ""));
  values.push_back(stats.exception);
  values.push_back(stats.logs_pending ? "true" : "false");
  values.push_back(stats.error);

  std::string out = header;
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out.push_back(',');
    out += csv_escape(values[i]);
  }
  out.push_back('\n');
  return out;
}

bool write_text_entry(Zip64StreamWriter& zip, const std::string& name, std::string_view content) {
  return zip.begin_entry(name) && zip.write_data(content.data(), content.size()) && zip.finish_entry();
}

std::string sql_error_text(const std::exception& e) {
  const char* text = e.what();
  return text ? std::string(text) : std::string("ClickHouse export query failed.");
}

std::string command_result_payload(ExportFormat format) {
  if (format == ExportFormat::Json) return "[{\"status\":\"OK\"}]\n";
  return "status\nOK\n";
}

struct ClientDisconnected final : public std::runtime_error {
  ClientDisconnected() : std::runtime_error("download client disconnected") {}
};

std::shared_ptr<clickhouse::Client> make_export_client(const std::string& runner_uri, std::string* error) {
  // A streamed export owns its native socket. Never return a partially-canceled
  // multi-terabyte connection to the interactive pool.
  return make_client_from_uri(
      runner_uri,
      std::chrono::seconds(10),
      std::chrono::hours(24),
      std::chrono::hours(24),
      error);
}

void cancel_export_best_effort(
    const HostSpec& host,
    const std::string& query_id) {
  if (query_id.empty()) return;
  try {
    std::string error;
    auto cancel = make_client_from_uri(
        host.runner_uri,
        std::chrono::seconds(5),
        std::chrono::seconds(5),
        std::chrono::seconds(5),
        &error);
    if (!cancel) return;
    std::string escaped;
    escaped.reserve(query_id.size() + 8);
    for (char ch : query_id) {
      if (ch == '\\') escaped += "\\\\";
      else if (ch == '\'') escaped += "\\'";
      else escaped.push_back(ch);
    }
    cancel->Execute("KILL QUERY WHERE query_id = '" + escaped + "' ASYNC");
  } catch (...) {
  }
}

std::optional<AllowedObjectSet> discover_export_allowed(
    const HostSpec& host,
    const std::shared_ptr<ClickHouseClientPool>& pool,
    std::string* error = nullptr) {
  try {
    std::string connect_error;
    auto runner = pool ? pool->acquire(
        host.runner_uri,
        std::chrono::seconds(5),
        std::chrono::seconds(15),
        std::chrono::seconds(15),
        &connect_error)
      : make_client_from_uri(
        host.runner_uri,
        std::chrono::seconds(5),
        std::chrono::seconds(15),
        std::chrono::seconds(15),
        &connect_error);
    if (!runner) {
      if (error) *error = connect_error.empty() ? "Cannot connect to ClickHouse runner context." : connect_error;
      return std::nullopt;
    }
    return discover_allowed_objects(*runner);
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return std::nullopt;
  }
}

bool preflight_export_metadata(
    const HostSpec& host,
    const std::shared_ptr<ClickHouseClientPool>& pool,
    bool flush_logs,
    AllowedObjectSet& allowed,
    std::string* error) {
  std::string discovery_error;
  auto discovered = discover_export_allowed(host, pool, &discovery_error);
  if (!discovered) {
    if (error) {
      *error = discovery_error.empty()
          ? "Unable to determine readable ClickHouse objects for export metadata."
          : discovery_error;
    }
    return false;
  }
  allowed = std::move(*discovered);

  const std::string system_uri = host.system_uri.empty() ? host.runner_uri : host.system_uri;
  std::string connect_error;
  auto system = pool ? pool->acquire(
      system_uri,
      std::chrono::seconds(5),
      std::chrono::seconds(15),
      std::chrono::seconds(15),
      &connect_error)
    : make_client_from_uri(
      system_uri,
      std::chrono::seconds(5),
      std::chrono::seconds(15),
      std::chrono::seconds(15),
      &connect_error);
  if (!system) {
    if (error) *error = connect_error.empty() ? "Cannot connect to ClickHouse system context." : connect_error;
    return false;
  }

  if (!flush_logs) return true;
  try {
    // The streamed archive treats execution.csv as required metadata. Validate
    // the exact privilege before the HTTP download begins so a missing grant
    // cannot produce a superficially successful ZIP with collector_error.
    system->Execute("SYSTEM FLUSH LOGS query_log");
    return true;
  } catch (const std::exception& e) {
    if (pool) pool->invalidate(system);
    if (error) *error = e.what();
    return false;
  }
}

} // namespace

void Server::handle_export_run(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString()) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }
  if (!doc.HasMember("format") || !doc["format"].IsString()) {
    return json_error(res, 400, "missing_format", "Export format must be csv or json.");
  }
  if (!doc.HasMember("queries") || !doc["queries"].IsArray()) {
    return json_error(res, 400, "missing_queries", "queries must be a non-empty array of SQL statements.");
  }

  const std::string host_id = doc["host_id"].GetString();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_down", "Selected host is down.");
  }

  ExportFormat format;
  const std::string requested_format = doc["format"].GetString();
  if (requested_format == "csv") format = ExportFormat::Csv;
  else if (requested_format == "json") format = ExportFormat::Json;
  else return json_error(res, 400, "invalid_format", "Export format must be csv or json.");

  const auto array = doc["queries"].GetArray();
  if (array.Empty()) return json_error(res, 400, "missing_queries", "At least one SQL statement is required.");
  if (array.Size() > cfg_.export_settings.max_queries) {
    return json_error(res, 413, "too_many_queries", "The export contains too many SQL statements.");
  }

  ExportJob job;
  job.export_id = random_uuid_v4();
  job.host_id = host_id;
  job.format = format;
  job.queries.reserve(array.Size());
  size_t total_sql_bytes = 0;
  for (const auto& item : array) {
    if (!item.IsString()) return json_error(res, 400, "invalid_queries", "Every export query must be a string.");
    std::string sql = trim_sql(item.GetString());
    if (sql.empty()) return json_error(res, 400, "invalid_queries", "Export queries cannot be empty.");
    if (sql.size() > cfg_.query_max_sql_bytes) {
      return json_error(res, 413, "sql_too_large", "A SQL statement exceeds the configured query limit.");
    }
    if (user_sql_is_forbidden(sql)) {
      return json_error(
          res,
          403,
          "cancel_requires_token",
          "Direct KILL QUERY is disabled in export SQL; use the query cancel capability.");
    }
    total_sql_bytes += sql.size();
    if (total_sql_bytes > cfg_.export_settings.pending_sql_max_bytes) {
      return json_error(res, 413, "export_sql_too_large", "Combined export SQL exceeds the configured handshake memory budget.");
    }
    job.queries.push_back(std::move(sql));
  }

  // Export execution metadata is part of the download contract, not a
  // best-effort decoration. Fail the JSON handshake while the UI can still
  // render an explicit error instead of starting an archive we cannot fully
  // describe.
  AllowedObjectSet preflight_allowed;
  std::string preflight_error;
  if (!preflight_export_metadata(
          *host,
          client_pool_,
          cfg_.analysis.flush_logs,
          preflight_allowed,
          &preflight_error)) {
    return json_error(
        res,
        503,
        "export_metadata_unavailable",
        preflight_error.empty()
            ? "Required ClickHouse export metadata is unavailable."
            : preflight_error);
  }

  std::string store_error;
  if (!export_jobs_ || !export_jobs_->put(job, &store_error)) {
    return json_error(
        res,
        429,
        "export_queue_full",
        store_error.empty() ? "Too many pending exports." : store_error);
  }

  ExportJwtClaims claims;
  claims.export_id = job.export_id;
  claims.host_id = host_id;
  claims.issued_at_unix = now_unix_sec();
  claims.expires_at_unix = claims.issued_at_unix + std::max<int64_t>(5, cfg_.export_settings.token_ttl_ms / 1000);
  const std::string token = jwt_.sign_export_token(claims);

  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("export_id"); writer.String(job.export_id.c_str());
  writer.Key("format"); writer.String(export_format_name(format));
  writer.Key("expires_in_ms"); writer.Int(cfg_.export_settings.token_ttl_ms);
  const std::string url = "api/export/stream?token=" + token;
  writer.Key("download_url"); writer.String(url.c_str());
  writer.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "no-store");
  res.set_content(buffer.GetString(), "application/json");
}

void Server::handle_export_stream(const httplib::Request& req, httplib::Response& res) {
  if (!req.has_param("token")) {
    return json_error(res, 400, "missing_export_token", "Missing export download token.");
  }
  const std::string token = req.get_param_value("token");
  const auto claims = jwt_.verify_export_token(token, now_unix_sec());
  if (!claims) return json_error(res, 404, "export_not_found", "Export is unavailable or expired.");

  const HostSpec* host = find_host(cfg_.hosts, claims->host_id);
  if (!host || !export_jobs_) {
    return json_error(res, 404, "export_not_found", "Export is unavailable or expired.");
  }

  size_t active = active_exports_.load(std::memory_order_relaxed);
  for (;;) {
    if (active >= cfg_.export_settings.max_concurrent) {
      return json_error(res, 429, "export_capacity", "The export concurrency limit is currently reached.");
    }
    if (active_exports_.compare_exchange_weak(
            active, active + 1, std::memory_order_acq_rel, std::memory_order_relaxed)) break;
  }

  auto job = export_jobs_->consume(claims->export_id, claims->host_id);
  if (!job) {
    active_exports_.fetch_sub(1, std::memory_order_acq_rel);
    return json_error(res, 404, "export_not_found", "Export is unavailable or expired.");
  }

  // Revalidate at token consumption time. Grants or connectivity may have
  // changed after the handshake. Crucially, this still happens before the
  // attachment headers/chunked body are committed.
  AllowedObjectSet stream_allowed;
  std::string preflight_error;
  if (!preflight_export_metadata(
          *host,
          client_pool_,
          cfg_.analysis.flush_logs,
          stream_allowed,
          &preflight_error)) {
    active_exports_.fetch_sub(1, std::memory_order_acq_rel);
    return json_error(
        res,
        503,
        "export_metadata_unavailable",
        preflight_error.empty()
            ? "Required ClickHouse export metadata is unavailable."
            : preflight_error);
  }

  const bool multi = job->queries.size() > 1;
  res.status = 200;
  res.set_header("Cache-Control", "no-store, no-transform");
  res.set_header("X-Accel-Buffering", "no");
  res.set_header("Accept-Ranges", "none");
  res.set_header(
      "Content-Disposition",
      std::string("attachment; filename=\"") + (multi ? "queries.zip" : "query.zip") + "\"");

  auto stream_job = std::make_shared<ExportJob>(std::move(*job));
  auto allowed = std::make_shared<AllowedObjectSet>(std::move(stream_allowed));
  const HostSpec host_copy = *host;
  auto stream_started = std::make_shared<std::atomic<bool>>(false);

  res.set_chunked_content_provider(
      "application/zip",
      [this, stream_job, allowed, host_copy, stream_started](size_t, httplib::DataSink& sink) -> bool {
        bool expected = false;
        if (!stream_started->compare_exchange_strong(expected, true)) {
          sink.done();
          return true;
        }

        bool disconnected = false;
        auto sink_write = [&](const char* data, size_t size) -> bool {
          if (size == 0) return true;
          if (!sink.is_writable || !sink.is_writable()) {
            disconnected = true;
            return false;
          }
          if (!sink.write(data, size)) {
            disconnected = true;
            return false;
          }
          return true;
        };

        Zip64StreamWriter zip(sink_write);
        const std::string system_uri = host_copy.system_uri.empty() ? host_copy.runner_uri : host_copy.system_uri;
        bool stop_after_error = false;

        for (size_t index = 0; index < stream_job->queries.size() && !stop_after_error; ++index) {
          const std::string& sql = stream_job->queries[index];
          const std::string prefix = stream_job->queries.size() > 1
              ? "query-" + std::string(3 - std::min<size_t>(3, std::to_string(index + 1).size()), '0') + std::to_string(index + 1) + "/"
              : std::string();
          const std::string query_id = random_uuid_v4();
          const std::string result_name = prefix + (stream_job->format == ExportFormat::Csv ? "results.csv" : "results.json");

          if (!write_text_entry(zip, prefix + "query.sql", sql)) return false;

          bool query_failed = false;
          std::string query_error;
          bool result_entry_open = false;
          bool result_entry_written = false;
          std::unique_ptr<ExportSerializer> serializer;
          std::string connect_error;
          auto client = make_export_client(host_copy.runner_uri, &connect_error);
          if (!client) {
            query_failed = true;
            query_error = connect_error.empty() ? "Cannot connect to ClickHouse runner context." : connect_error;
          } else {
            try {
              clickhouse::Query query(sql, query_id);
              clickhouse::QuerySettingsField enabled;
              enabled.value = "1";
              query.SetSetting("log_queries", enabled);

              query.OnProgress([&](const clickhouse::Progress&) {
                if (sink.is_writable && !sink.is_writable()) {
                  disconnected = true;
                  throw ClientDisconnected();
                }
              });

              // Execute is the arbitrary-query API in clickhouse-cpp. Attach a
              // data callback for every statement instead of guessing from the
              // first SQL keyword which commands may return blocks.
              query.OnDataCancelable([&](const clickhouse::Block& block) -> bool {
                if (disconnected || (sink.is_writable && !sink.is_writable())) {
                  disconnected = true;
                  return false;
                }
                if (!result_entry_open) {
                  if (!zip.begin_entry(result_name)) {
                    disconnected = true;
                    return false;
                  }
                  result_entry_open = true;
                  result_entry_written = true;
                  serializer = std::make_unique<ExportSerializer>(
                      zip, stream_job->format, cfg_.export_settings.output_buffer_bytes);
                }
                if (!serializer->write_block(block)) {
                  disconnected = true;
                  return false;
                }
                return true;
              });

              // User/panel SQL always executes through runner_uri, including
              // CREATE/ALTER/INSERT/etc. system_uri is never used here.
              client->Execute(query);
              if (serializer && !serializer->finish()) disconnected = true;
              if (disconnected) throw ClientDisconnected();
              if (result_entry_open) {
                if (!zip.finish_entry()) return false;
                result_entry_open = false;
              }
              if (!result_entry_written) {
                // A successful statement that produced no result blocks gets a
                // stable synthetic result instead of an ambiguous empty/missing
                // archive member.
                const std::string payload = command_result_payload(stream_job->format);
                if (!write_text_entry(zip, result_name, payload)) return false;
                result_entry_written = true;
              }
            } catch (const ClientDisconnected&) {
              disconnected = true;
              try {
                if (client && client->IsSelecting()) client->Cancel();
              } catch (...) {
              }
              cancel_export_best_effort(host_copy, query_id);
            } catch (const std::exception& e) {
              query_failed = true;
              query_error = sql_error_text(e);
              try {
                if (client && client->IsSelecting()) client->Cancel();
              } catch (...) {
              }
            }
          }

          if (disconnected) return false;
          if (result_entry_open) {
            if (!zip.finish_entry()) return false;
            result_entry_open = false;
          }
          if (query_failed && !result_entry_written) {
            // Preserve a stable archive layout even when the runner fails
            // before ClickHouse emits the first result block.
            if (!write_text_entry(zip, result_name, std::string_view{})) return false;
            result_entry_written = true;
          }

          QueryRegistryRecord record;
          record.query_id = query_id;
          record.host_id = stream_job->host_id;
          record.native_query_ids.push_back(query_id);
          record.terminal_status = query_failed ? "error" : "finished";
          record.original_sql = sql;
          QueryExecutionStats stats = collect_query_execution(
              record,
              system_uri,
              client_pool_,
              cfg_.analysis.log_lookup_timeout_ms,
              cfg_.analysis.flush_logs);
          filter_execution_stats(stats, allowed.get());
          const bool metadata_failed = !stats.available;
          const std::string archive_status = query_failed
              ? "error"
              : (metadata_failed ? "export_error" : "finished");
          if (!write_text_entry(zip, prefix + "execution.csv", execution_csv(stats, archive_status, query_failed))) {
            return false;
          }

          if (query_failed || metadata_failed) {
            std::string terminal_error;
            if (query_failed) terminal_error = query_error;
            if (metadata_failed) {
              const std::string metadata_error = !stats.error.empty()
                  ? stats.error
                  : (stats.logs_pending
                      ? "ClickHouse query_log did not publish required execution metadata before the bounded lookup window expired."
                      : "Required ClickHouse execution metadata is unavailable.");
              if (!terminal_error.empty()) terminal_error += "\n\n";
              terminal_error += "Export metadata failure: " + metadata_error;
            }
            if (!write_text_entry(zip, prefix + "error.txt", terminal_error)) return false;
            stop_after_error = true;
          }
        }

        if (!zip.finish_archive()) return false;
        sink.done();
        return true;
      },
      [this](bool) {
        active_exports_.fetch_sub(1, std::memory_order_acq_rel);
      });
}

} // namespace chdash
