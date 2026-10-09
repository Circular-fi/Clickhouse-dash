#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>

// System Activity and Keeper endpoints. Both are fixed, allowlisted,
// bounded reads (see system_activity.cpp); no SQL or filter is taken from the
// request. Activity rows that name an object pass the runner SHOW boundary
// before serialization; Keeper status is server-level and names no object.

namespace chdash {
namespace {

// Rows per activity section. system.merges / mutations / replication_queue /
// replicas / distribution_queue are in-memory tables; the bound only keeps a
// pathological server (thousands of stuck mutations) from producing a huge
// page.
constexpr size_t kSystemActivityRowLimit = 200;

uint64_t ops_api_now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

std::shared_ptr<clickhouse::Client> acquire_ops_client(
    const std::shared_ptr<ClickHouseClientPool>& pool,
    const std::string& uri,
    std::string* error) {
  return pool ? pool->acquire(uri, std::chrono::seconds(5), std::chrono::seconds(15), std::chrono::seconds(15), error)
              : make_client_from_uri(uri, std::chrono::seconds(5), std::chrono::seconds(15), std::chrono::seconds(15), error);
}

// The activity is live state: never older than the Explorer cache TTL, and at
// most one read per second per host however many pages auto-refresh.
uint64_t ops_ttl_ms(int cache_ttl_ms) {
  return static_cast<uint64_t>(std::max(1000, std::min(cache_ttl_ms, 5000)));
}

void write_string(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::string& value) {
  w.Key(key);
  w.String(value.c_str(), static_cast<rapidjson::SizeType>(value.size()));
}

void write_strings(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::vector<std::string>& values) {
  w.Key(key);
  w.StartArray();
  for (const auto& value : values) w.String(value.c_str(), static_cast<rapidjson::SizeType>(value.size()));
  w.EndArray();
}

} // namespace

void Server::handle_system_activity(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_request_host(cfg_, req, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const std::string key = host_id + std::string("\0ops-activity", 13);
  if (req.has_param("refresh") && req.get_param_value("refresh") == "1") system_activity_cache_.erase(key);
  auto result = system_activity_cache_.get_or_refresh(
      key, ops_api_now_ms(), ops_ttl_ms(cfg_.explorer.cache_ttl_ms), 250,
      [&](SystemActivity& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_ops_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        auto system = acquire_ops_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        try {
          if (!load_system_activity(*system, *runner, kSystemActivityRowLimit, value, &error)) {
            code = "system_activity_failed";
            message = error.empty() ? "The server activity is unavailable." : error;
            return false;
          }
          return true;
        } catch (const std::exception& e) {
          code = "system_activity_failed";
          message = e.what();
          if (client_pool_) {
            client_pool_->invalidate(runner);
            client_pool_->invalidate(system);
          }
          return false;
        }
      });
  if (!result.has_value || !result.value) {
    return json_error(
        res, 503,
        result.error_code.empty() ? "system_activity_unavailable" : result.error_code,
        result.error_message.empty() ? "The server activity is unavailable." : result.error_message);
  }

  const SystemActivity& ops = *result.value;
  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  w.Key("generated_at_ms"); w.Uint64(ops.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  w.Key("row_limit"); w.Uint64(ops.row_limit);
  write_strings(w, "unavailable_sections", ops.unavailable_sections);
  write_strings(w, "truncated_sections", ops.truncated_sections);

  w.Key("merges");
  w.StartArray();
  for (const auto& item : ops.merges) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    w.Key("elapsed_seconds"); w.Double(item.elapsed_seconds);
    w.Key("progress"); w.Double(item.progress);
    w.Key("num_parts"); w.Uint64(item.num_parts);
    write_string(w, "result_part_name", item.result_part_name);
    write_string(w, "partition_id", item.partition_id);
    w.Key("is_mutation"); w.Bool(item.is_mutation);
    write_string(w, "merge_type", item.merge_type);
    w.Key("total_bytes_compressed"); w.Uint64(item.total_bytes_compressed);
    w.Key("bytes_read_uncompressed"); w.Uint64(item.bytes_read_uncompressed);
    w.Key("rows_read"); w.Uint64(item.rows_read);
    w.Key("memory_usage"); w.Uint64(item.memory_usage);
    w.EndObject();
  }
  w.EndArray();

  w.Key("mutations");
  w.StartArray();
  for (const auto& item : ops.mutations) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    write_string(w, "mutation_id", item.mutation_id);
    write_string(w, "command", item.command);
    write_string(w, "create_time", item.create_time);
    w.Key("parts_to_do"); w.Uint64(item.parts_to_do);
    w.Key("is_done"); w.Bool(item.is_done);
    w.Key("is_killed"); w.Bool(item.is_killed);
    write_string(w, "latest_failed_part", item.latest_failed_part);
    write_string(w, "latest_fail_time", item.latest_fail_time);
    write_string(w, "latest_fail_reason", item.latest_fail_reason);
    write_string(w, "latest_fail_error_code_name", item.latest_fail_error_code_name);
    w.EndObject();
  }
  w.EndArray();

  w.Key("replication_queue");
  w.StartArray();
  for (const auto& item : ops.replication_queue) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    w.Key("entries"); w.Uint64(item.entries);
    w.Key("executing"); w.Uint64(item.executing);
    w.Key("postponed"); w.Uint64(item.postponed);
    w.Key("max_tries"); w.Uint64(item.max_tries);
    write_string(w, "oldest_create_time", item.oldest_create_time);
    write_strings(w, "types", item.types);
    write_string(w, "postpone_reason", item.postpone_reason);
    write_string(w, "last_exception", item.last_exception);
    write_string(w, "last_exception_time", item.last_exception_time);
    w.EndObject();
  }
  w.EndArray();

  w.Key("replicas");
  w.StartArray();
  for (const auto& item : ops.replicas) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    write_string(w, "replica_name", item.replica_name);
    w.Key("is_leader"); w.Bool(item.is_leader);
    w.Key("is_readonly"); w.Bool(item.is_readonly);
    w.Key("is_session_expired"); w.Bool(item.is_session_expired);
    w.Key("queue_size"); w.Uint64(item.queue_size);
    w.Key("inserts_in_queue"); w.Uint64(item.inserts_in_queue);
    w.Key("merges_in_queue"); w.Uint64(item.merges_in_queue);
    w.Key("absolute_delay_seconds"); w.Uint64(item.absolute_delay_seconds);
    write_string(w, "queue_oldest_time", item.queue_oldest_time);
    write_string(w, "last_queue_update", item.last_queue_update);
    write_string(w, "last_queue_update_exception", item.last_queue_update_exception);
    w.Key("total_replicas");
    if (item.total_replicas) w.Uint64(*item.total_replicas); else w.Null();
    w.Key("active_replicas");
    if (item.active_replicas) w.Uint64(*item.active_replicas); else w.Null();
    w.EndObject();
  }
  w.EndArray();

  w.Key("distribution_queue");
  w.StartArray();
  for (const auto& item : ops.distribution_queue) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    write_string(w, "data_path", item.data_path);
    w.Key("is_blocked"); w.Bool(item.is_blocked);
    w.Key("error_count"); w.Uint64(item.error_count);
    w.Key("data_files"); w.Uint64(item.data_files);
    w.Key("data_compressed_bytes"); w.Uint64(item.data_compressed_bytes);
    w.Key("broken_data_files"); w.Uint64(item.broken_data_files);
    w.Key("broken_data_compressed_bytes"); w.Uint64(item.broken_data_compressed_bytes);
    write_string(w, "last_exception", item.last_exception);
    write_string(w, "last_exception_time", item.last_exception_time);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

void Server::handle_system_keeper(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_request_host(cfg_, req, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const std::string key = host_id + std::string("\0ops-keeper", 11);
  if (req.has_param("refresh") && req.get_param_value("refresh") == "1") system_keeper_cache_.erase(key);
  auto result = system_keeper_cache_.get_or_refresh(
      key, ops_api_now_ms(), ops_ttl_ms(cfg_.explorer.cache_ttl_ms), 250,
      [&](SystemKeeperStatus& value, std::string& code, std::string& message) {
        std::string error;
        const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        auto system = acquire_ops_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        try {
          if (!load_system_keeper_status(*system, value, &error)) {
            code = "system_keeper_failed";
            message = error.empty() ? "Keeper status is unavailable." : error;
            return false;
          }
          return true;
        } catch (const std::exception& e) {
          code = "system_keeper_failed";
          message = e.what();
          if (client_pool_) client_pool_->invalidate(system);
          return false;
        }
      });
  if (!result.has_value || !result.value) {
    return json_error(
        res, 503,
        result.error_code.empty() ? "system_keeper_unavailable" : result.error_code,
        result.error_message.empty() ? "Keeper status is unavailable." : result.error_message);
  }

  const SystemKeeperStatus& keeper = *result.value;
  const auto event = [&](const char* name) -> uint64_t {
    const auto it = keeper.events.find(name);
    return it == keeper.events.end() ? 0 : it->second;
  };
  rapidjson::StringBuffer sb(nullptr, 4 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  w.Key("generated_at_ms"); w.Uint64(keeper.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  w.Key("configured"); w.Bool(keeper.configured);
  write_strings(w, "unavailable_sections", keeper.unavailable_sections);
  w.Key("connections");
  w.StartArray();
  for (const auto& item : keeper.connections) {
    w.StartObject();
    write_string(w, "name", item.name);
    write_string(w, "host", item.host);
    w.Key("port"); w.Uint64(item.port);
    w.Key("index"); w.Uint64(item.index);
    write_string(w, "connected_time", item.connected_time);
    w.Key("session_uptime_seconds"); w.Uint64(item.session_uptime_seconds);
    w.Key("is_expired"); w.Bool(item.is_expired);
    w.Key("keeper_api_version"); w.Uint64(item.keeper_api_version);
    w.Key("session_timeout_ms");
    if (item.session_timeout_ms) w.Uint64(*item.session_timeout_ms); else w.Null();
    w.EndObject();
  }
  w.EndArray();
  w.Key("metrics");
  w.StartObject();
  for (const auto& [name, value] : keeper.metrics) {
    w.Key(name.c_str());
    w.Int64(value);
  }
  w.EndObject();
  w.Key("events");
  w.StartObject();
  for (const auto& [name, value] : keeper.events) {
    w.Key(name.c_str());
    w.Uint64(value);
  }
  w.EndObject();
  // Average wait per Keeper transaction since server start. The browser
  // derives the recent latency from two snapshots while auto-refreshing.
  const uint64_t transactions = event("ZooKeeperTransactions");
  w.Key("average_wait_ms");
  if (transactions > 0) w.Double(static_cast<double>(event("ZooKeeperWaitMicroseconds")) / 1000.0 / static_cast<double>(transactions));
  else w.Null();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

} // namespace chdash
