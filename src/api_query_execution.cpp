#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "query_execution.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <utility>

namespace chdash {
namespace {

uint64_t now_ms_execution() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

std::string execution_security_key(const std::string& host_id) {
  return host_id;
}


std::shared_ptr<clickhouse::Client> acquire_runner(
    const std::shared_ptr<ClickHouseClientPool>& pool,
    const std::string& uri,
    std::string* error) {
  return pool ? pool->acquire(
      uri,
      std::chrono::seconds(5),
      std::chrono::seconds(15),
      std::chrono::seconds(15),
      error)
    : make_client_from_uri(
      uri,
      std::chrono::seconds(5),
      std::chrono::seconds(15),
      std::chrono::seconds(15),
      error);
}

std::optional<std::pair<std::string, std::string>> split_qualified_name(std::string value) {
  if (value.empty()) return std::nullopt;
  if (value.front() == '`' && value.back() == '`') value = value.substr(1, value.size() - 2);
  const size_t dot = value.find('.');
  if (dot == std::string::npos || dot == 0 || dot + 1 >= value.size()) return std::nullopt;
  auto clean = [](std::string part) {
    if (part.size() >= 2 && part.front() == '`' && part.back() == '`') {
      part = part.substr(1, part.size() - 2);
    }
    return part;
  };
  std::string database = clean(value.substr(0, dot));
  std::string table = clean(value.substr(dot + 1));
  if (database.empty() || table.empty()) return std::nullopt;
  return std::make_pair(std::move(database), std::move(table));
}

bool allowed_qualified_name(const AllowedObjectSet& allowed, const std::string& value) {
  auto parsed = split_qualified_name(value);
  return parsed && allowed.allows_table(parsed->first, parsed->second);
}

void filter_stats(QueryExecutionStats& stats, const AllowedObjectSet& allowed) {
  stats.databases.erase(
      std::remove_if(stats.databases.begin(), stats.databases.end(), [&](const std::string& db) {
        return !allowed.allows_database(db);
      }),
      stats.databases.end());
  stats.tables.erase(
      std::remove_if(stats.tables.begin(), stats.tables.end(), [&](const std::string& table) {
        return !allowed_qualified_name(allowed, table);
      }),
      stats.tables.end());
  if (stats.tables.empty()) stats.projections.clear();
}

void write_string_array(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const std::vector<std::string>& values) {
  writer.StartArray();
  for (const auto& value : values) writer.String(value.c_str());
  writer.EndArray();
}

} // namespace

void Server::handle_query_execution(const httplib::Request& req, httplib::Response& res) {
  if (!req.has_param("host_id")) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }
  if (!req.has_param("query_id")) {
    return json_error(res, 400, "missing_query_id", "Missing query_id.");
  }

  const std::string host_id = req.get_param_value("host_id");
  const std::string query_id = req.get_param_value("query_id");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  if (!query_registry_) {
    return json_error(res, 404, "execution_not_found", "Query execution statistics are not available.");
  }

  auto record = query_registry_->find(query_id, host_id);
  if (!record) {
    return json_error(res, 404, "execution_not_found", "Query execution statistics are not available.");
  }
  if (record->terminal_status.empty()) {
    return json_error(res, 409, "query_not_finished", "Execution statistics are available after execution finishes.");
  }

  const uint64_t timestamp = now_ms_execution();
  const uint64_t ttl = static_cast<uint64_t>(std::max(0, cfg_.explorer.cache_ttl_ms));
  const std::string security_key = execution_security_key(host_id);
  auto allowed_result = explorer_allowed_cache_.get_or_refresh(
      security_key,
      timestamp,
      ttl,
      250,
      [&](AllowedObjectSet& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_runner(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        try {
          value = discover_allowed_objects(*runner);
          return true;
        } catch (const std::exception& e) {
          code = "acl_discovery_failed";
          message = e.what();
          if (client_pool_) client_pool_->invalidate(runner);
          return false;
        }
      });

  if (!allowed_result.has_value || !allowed_result.value) {
    return json_error(
        res,
        503,
        allowed_result.error_code.empty() ? "acl_discovery_failed" : allowed_result.error_code,
        allowed_result.error_message.empty() ? "Cannot determine readable objects." : allowed_result.error_message);
  }

  const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  QueryExecutionStats stats = collect_query_execution(
      *record,
      system_uri,
      client_pool_,
      cfg_.analysis.log_lookup_timeout_ms,
      cfg_.analysis.flush_logs);
  filter_stats(stats, *allowed_result.value);

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> writer(sb);
  writer.StartObject();
  writer.Key("query_id"); writer.String(stats.query_id.c_str());
  writer.Key("available"); writer.Bool(stats.available);
  writer.Key("logs_pending"); writer.Bool(stats.logs_pending);
  writer.Key("partial_execution"); writer.Bool(record->partial_execution);
  writer.Key("terminal_status"); writer.String(record->terminal_status.c_str());
  writer.Key("run_mode"); writer.String(record->run_mode == QueryRunMode::Profiling ? "profiling" : "normal");
  writer.Key("native_query_id"); writer.String(stats.native_query_id.c_str());
  writer.Key("status"); writer.String(stats.status.c_str());
  writer.Key("event_time"); writer.String(stats.event_time.c_str());
  writer.Key("duration_ms"); writer.Uint64(stats.duration_ms);
  writer.Key("read_rows"); writer.Uint64(stats.read_rows);
  writer.Key("read_bytes"); writer.Uint64(stats.read_bytes);
  writer.Key("written_rows"); writer.Uint64(stats.written_rows);
  writer.Key("written_bytes"); writer.Uint64(stats.written_bytes);
  writer.Key("result_rows"); writer.Uint64(stats.result_rows);
  writer.Key("result_bytes"); writer.Uint64(stats.result_bytes);
  writer.Key("memory_usage"); writer.Int64(stats.memory_usage);
  writer.Key("peak_threads_usage"); writer.Uint64(stats.peak_threads_usage);
  writer.Key("databases"); write_string_array(writer, stats.databases);
  writer.Key("tables"); write_string_array(writer, stats.tables);
  writer.Key("projections"); write_string_array(writer, stats.projections);
  writer.Key("exception_code"); writer.Int(stats.exception_code);
  writer.Key("exception"); writer.String(stats.exception.c_str());
  writer.Key("error"); writer.String(stats.error.c_str());
  writer.EndObject();

  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
