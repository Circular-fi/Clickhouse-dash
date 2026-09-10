#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "http_json.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <unordered_set>

namespace chdash {
namespace {

uint64_t now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

std::string explorer_security_key(const std::string& host_id) {
  return host_id;
}


void write_optional_u64(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::optional<uint64_t>& value) {
  if (value) w.Uint64(*value);
  else w.Null();
}

void write_optional_double(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::optional<double>& value) {
  if (value) w.Double(*value);
  else w.Null();
}

void write_rate(rapidjson::Writer<rapidjson::StringBuffer>& w, const ExplorerRate& rate) {
  w.StartObject();
  w.Key("rows_per_second_1m"); write_optional_double(w, rate.rows_per_second_1m);
  w.Key("rows_per_second_5m"); write_optional_double(w, rate.rows_per_second_5m);
  w.Key("rows_per_second_1h"); write_optional_double(w, rate.rows_per_second_1h);
  w.Key("bytes_per_second_1m"); write_optional_double(w, rate.bytes_per_second_1m);
  w.Key("bytes_per_second_5m"); write_optional_double(w, rate.bytes_per_second_5m);
  w.Key("bytes_per_second_1h"); write_optional_double(w, rate.bytes_per_second_1h);
  w.Key("new_parts_per_minute"); write_optional_u64(w, rate.new_parts_per_minute);
  w.Key("rows_total_1h"); write_optional_u64(w, rate.rows_total_1h);
  w.Key("bytes_total_1h"); write_optional_u64(w, rate.bytes_total_1h);
  w.Key("last_event_time"); w.String(rate.last_event_time.c_str());
  w.EndObject();
}

void write_replication(rapidjson::Writer<rapidjson::StringBuffer>& w, const ExplorerReplication& replication) {
  w.StartObject();
  w.Key("available"); w.Bool(replication.available);
  w.Key("total_replicas"); w.Uint64(replication.total_replicas);
  w.Key("active_replicas"); w.Uint64(replication.active_replicas);
  w.Key("queue_size"); w.Uint64(replication.queue_size);
  w.Key("absolute_delay_seconds"); w.Uint64(replication.absolute_delay_seconds);
  w.Key("readonly"); w.Bool(replication.readonly);
  w.Key("session_expired"); w.Bool(replication.session_expired);
  w.Key("replica_name"); w.String(replication.replica_name.c_str());
  w.Key("zookeeper_path"); w.String(replication.zookeeper_path.c_str());
  w.EndObject();
}

void write_summary(rapidjson::Writer<rapidjson::StringBuffer>& w, const ExplorerTableSummary& table) {
  w.StartObject();
  w.Key("database"); w.String(table.database.c_str());
  w.Key("name"); w.String(table.name.c_str());
  w.Key("engine"); w.String(table.engine.c_str());
  w.Key("engine_full"); w.String(table.engine_full.c_str());
  w.Key("rows"); write_optional_u64(w, table.rows);
  w.Key("logical_bytes"); write_optional_u64(w, table.logical_bytes);
  w.Key("physical_bytes"); write_optional_u64(w, table.physical_bytes);
  w.Key("compressed_bytes"); write_optional_u64(w, table.compressed_bytes);
  w.Key("uncompressed_bytes"); write_optional_u64(w, table.uncompressed_bytes);
  w.Key("resident_bytes"); write_optional_u64(w, table.resident_bytes);
  w.Key("secondary_indices_bytes"); write_optional_u64(w, table.secondary_indices_bytes);
  w.Key("projection_bytes"); write_optional_u64(w, table.projection_bytes);
  w.Key("active_parts"); w.Uint64(table.active_parts);
  w.Key("partitions"); w.Uint64(table.partitions);
  w.Key("sorting_key"); w.String(table.sorting_key.c_str());
  w.Key("primary_key"); w.String(table.primary_key.c_str());
  w.Key("partition_key"); w.String(table.partition_key.c_str());
  w.Key("sampling_key"); w.String(table.sampling_key.c_str());
  w.Key("storage_policy"); w.String(table.storage_policy.c_str());
  w.Key("last_part_time"); w.String(table.last_part_time.c_str());
  w.Key("disks");
  w.StartArray();
  for (const auto& disk : table.disks) w.String(disk.c_str());
  w.EndArray();
  w.Key("client_ingress"); write_rate(w, table.client_ingress);
  w.Key("physical_ingress"); write_rate(w, table.physical_ingress);
  w.Key("replication"); write_replication(w, table.replication);
  w.Key("health"); w.String(table.health.c_str());
  w.Key("warnings");
  w.StartArray();
  for (const auto& warning : table.warnings) w.String(warning.c_str());
  w.EndArray();
  w.EndObject();
}

std::shared_ptr<clickhouse::Client> acquire_explorer_client(
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

} // namespace

void Server::handle_explorer_catalog(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const uint64_t ts = now_ms();
  const uint64_t ttl = static_cast<uint64_t>(std::max(0, cfg_.explorer.cache_ttl_ms));
  const std::string security_key = explorer_security_key(host_id);
  const std::string catalog_key = security_key + std::string("\0catalog", 8);
  const std::string graph_key = security_key + std::string("\0graph", 6);
  const std::string functions_key = security_key + std::string("\0functions", 10);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  if (force_refresh) {
    // A manual refresh is also an ACL refresh. This lets permission changes take
    // effect immediately instead of reusing metadata built under older grants.
    // Invalidate Graph too: a topology created under older grants must never
    // survive an explicit ACL refresh and leak an object that was just revoked.
    explorer_allowed_cache_.erase(security_key);
    explorer_catalog_cache_.erase(catalog_key);
    explorer_graph_cache_.erase(graph_key);
    explorer_functions_cache_.erase(functions_key);
  }

  auto allowed_result = explorer_allowed_cache_.get_or_refresh(
      security_key, ts, ttl, 250,
      [&](AllowedObjectSet& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
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
        res, 503,
        allowed_result.error_code.empty() ? "acl_unavailable" : allowed_result.error_code,
        allowed_result.error_message.empty() ? "Unable to determine readable ClickHouse objects." : allowed_result.error_message);
  }

  auto catalog_result = explorer_catalog_cache_.get_or_refresh(
      catalog_key, ts, ttl, 250,
      [&](ExplorerCatalog& value, std::string& code, std::string& message) {
        const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        std::string error;
        auto system = acquire_explorer_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        if (!load_explorer_catalog(*system, *runner, *allowed_result.value, value, &error)) {
          code = "explorer_catalog_failed";
          message = error.empty() ? "Unable to load Explorer metadata." : error;
          return false;
        }
        return true;
      });

  if (!catalog_result.has_value || !catalog_result.value) {
    return json_error(
        res, 503,
        catalog_result.error_code.empty() ? "explorer_unavailable" : catalog_result.error_code,
        catalog_result.error_message.empty() ? "Explorer metadata is unavailable." : catalog_result.error_message);
  }

  const std::string database_filter = req.has_param("database") ? req.get_param_value("database") : std::string{};
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("generated_at_ms"); w.Uint64(catalog_result.value->generated_at_ms);
  w.Key("stale"); w.Bool(catalog_result.stale || allowed_result.stale);
  w.Key("metric_scope"); w.String(catalog_result.value->metric_scope.c_str());
  w.Key("availability");
  w.StartObject();
  w.Key("query_log"); w.Bool(catalog_result.value->query_log_available);
  w.Key("part_log"); w.Bool(catalog_result.value->part_log_available);
  w.Key("replication"); w.Bool(catalog_result.value->replication_available);
  w.EndObject();
  w.Key("databases");
  w.StartArray();
  for (const auto& database : catalog_result.value->databases) w.String(database.c_str());
  w.EndArray();
  w.Key("database_summaries");
  w.StartArray();
  for (const auto& database : catalog_result.value->database_summaries) {
    w.StartObject();
    w.Key("name"); w.String(database.name.c_str());
    w.Key("tables"); w.Uint64(database.tables);
    w.Key("rows"); w.Uint64(database.rows);
    w.Key("bytes"); w.Uint64(database.bytes);
    w.Key("disks"); w.StartArray();
    for (const auto& disk : database.disks) {
      w.StartObject();
      w.Key("name"); w.String(disk.name.c_str());
      w.Key("host_name"); w.String(disk.host_name.c_str());
      w.Key("path"); w.String(disk.path.c_str());
      w.Key("type"); w.String(disk.type.c_str());
      w.Key("bytes"); w.Uint64(disk.bytes);
      w.Key("free_space"); write_optional_u64(w, disk.free_space);
      w.Key("total_space"); write_optional_u64(w, disk.total_space);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("tables");
  w.StartArray();
  for (const auto& table : catalog_result.value->tables) {
    if (!database_filter.empty() && table.database != database_filter) continue;
    write_summary(w, table);
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_explorer_table(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  const std::string database = req.has_param("database") ? req.get_param_value("database") : std::string{};
  const std::string table = req.has_param("table") ? req.get_param_value("table") : std::string{};
  if (host_id.empty() || database.empty() || table.empty()) {
    return json_error(res, 400, "missing_scope", "host_id, database and table are required.");
  }
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  const uint64_t ts = now_ms();
  const uint64_t ttl = static_cast<uint64_t>(std::max(0, cfg_.explorer.cache_ttl_ms));
  const std::string security_key = explorer_security_key(host_id);
  auto allowed_result = explorer_allowed_cache_.get_or_refresh(
      security_key, ts, ttl, 250,
      [&](AllowedObjectSet& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) { code = "runner_unavailable"; message = error; return false; }
        try { value = discover_allowed_objects(*runner); return true; }
        catch (const std::exception& e) { code = "acl_discovery_failed"; message = e.what(); return false; }
      });
  if (!allowed_result.has_value || !allowed_result.value) {
    return json_error(
        res, 503,
        allowed_result.error_code.empty() ? "acl_unavailable" : allowed_result.error_code,
        allowed_result.error_message.empty() ? "Unable to determine readable ClickHouse objects." : allowed_result.error_message);
  }
  if (!allowed_result.value->allows_table(database, table)) {
    return json_error(res, 404, "object_not_found", "Object not found.");
  }

  // Reuse the same bulk catalog cache used by the List page. Opening a table
  // must not rerun query_log/part_log/parts aggregation for every detail click.
  const std::string catalog_key = security_key + std::string("\0catalog", 8);
  auto catalog_result = explorer_catalog_cache_.get_or_refresh(
      catalog_key, ts, ttl, 250,
      [&](ExplorerCatalog& value, std::string& code, std::string& message) {
        const std::string uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        std::string fetch_error;
        auto client = acquire_explorer_client(client_pool_, uri, &fetch_error);
        if (!client) {
          code = "system_context_unavailable";
          message = fetch_error.empty() ? "Cannot connect to the system context." : fetch_error;
          return false;
        }
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &fetch_error);
        if (!runner) {
          code = "runner_unavailable";
          message = fetch_error.empty() ? "Cannot connect to the runner context." : fetch_error;
          return false;
        }
        if (!load_explorer_catalog(*client, *runner, *allowed_result.value, value, &fetch_error)) {
          code = "explorer_catalog_failed";
          message = fetch_error.empty() ? "Unable to load Explorer metadata." : fetch_error;
          return false;
        }
        return true;
      });
  if (!catalog_result.has_value || !catalog_result.value) {
    return json_error(
        res, 503,
        catalog_result.error_code.empty() ? "explorer_unavailable" : catalog_result.error_code,
        catalog_result.error_message.empty() ? "Explorer metadata is unavailable." : catalog_result.error_message);
  }

  const ExplorerTableSummary* summary = nullptr;
  for (const auto& candidate : catalog_result.value->tables) {
    if (candidate.database == database && candidate.name == table) {
      summary = &candidate;
      break;
    }
  }
  if (!summary) return json_error(res, 404, "object_not_found", "Object not found.");

  const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  std::string error;
  auto system = acquire_explorer_client(client_pool_, system_uri, &error);
  if (!system) {
    return json_error(
        res, 503, "system_context_unavailable",
        error.empty() ? "Cannot connect to the system metadata context." : error);
  }
  std::string runner_error;
  auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &runner_error);
  if (!runner) {
    return json_error(
        res, 503, "runner_unavailable",
        runner_error.empty() ? "Cannot connect to the runner context." : runner_error);
  }

  ExplorerTableDetail detail;
  if (!load_explorer_table_detail(*system, *runner, *allowed_result.value, database, table, *summary, detail, &error)) {
    return json_error(
        res, 503, "explorer_table_metadata_failed",
        error.empty() ? "Unable to load Explorer table metadata." : error);
  }

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("metric_scope"); w.String("local-replica");
  w.Key("summary"); write_summary(w, detail.summary);

  w.Key("default_compression_codecs");
  w.StartArray();
  for (const auto& codec : detail.default_compression_codecs) w.String(codec.c_str());
  w.EndArray();

  w.Key("columns"); w.StartArray();
  for (const auto& column : detail.columns) {
    w.StartObject();
    w.Key("name"); w.String(column.name.c_str());
    w.Key("type"); w.String(column.type.c_str());
    w.Key("default_kind"); w.String(column.default_kind.c_str());
    w.Key("default_expression"); w.String(column.default_expression.c_str());
    w.Key("codec"); w.String(column.codec_expression.c_str());
    w.Key("ttl_expression"); w.String(column.ttl_expression.c_str());
    w.Key("is_subcolumn"); w.Bool(column.is_subcolumn);
    w.Key("parent_name"); w.String(column.parent_name.c_str());
    w.Key("compressed_bytes"); write_optional_u64(w, column.compressed_bytes);
    w.Key("uncompressed_bytes"); write_optional_u64(w, column.uncompressed_bytes);
    w.Key("relative_weight"); write_optional_double(w, column.relative_weight);
    w.EndObject();
  }
  w.EndArray();

  w.Key("column_storage"); w.StartObject();
  w.Key("compact_parts"); w.Uint64(detail.column_storage.compact_parts);
  w.Key("wide_parts"); w.Uint64(detail.column_storage.wide_parts);
  w.Key("compact_on_disk_bytes"); write_optional_u64(w, detail.column_storage.compact_on_disk_bytes);
  w.Key("wide_on_disk_bytes"); write_optional_u64(w, detail.column_storage.wide_on_disk_bytes);
  w.Key("compact_compressed_bytes"); write_optional_u64(w, detail.column_storage.compact_compressed_bytes);
  w.Key("compact_uncompressed_bytes"); write_optional_u64(w, detail.column_storage.compact_uncompressed_bytes);
  w.Key("wide_compressed_bytes"); write_optional_u64(w, detail.column_storage.wide_compressed_bytes);
  w.Key("wide_uncompressed_bytes"); write_optional_u64(w, detail.column_storage.wide_uncompressed_bytes);
  w.EndObject();

  w.Key("storage"); w.StartArray();
  for (const auto& disk : detail.storage) {
    w.StartObject();
    w.Key("disk"); w.String(disk.disk.c_str());
    w.Key("path"); w.String(disk.path.c_str());
    w.Key("bytes"); write_optional_u64(w, disk.bytes);
    w.Key("rows"); write_optional_u64(w, disk.rows);
    w.Key("free_space"); write_optional_u64(w, disk.free_space);
    w.Key("total_space"); write_optional_u64(w, disk.total_space);
    w.Key("parts"); w.Uint64(disk.parts);
    w.EndObject();
  }
  w.EndArray();

  w.Key("parts"); w.StartArray();
  for (const auto& part : detail.parts) {
    w.StartObject();
    w.Key("name"); w.String(part.name.c_str());
    w.Key("partition"); w.String(part.partition.c_str());
    w.Key("disk"); w.String(part.disk.c_str());
    w.Key("rows"); w.Uint64(part.rows);
    w.Key("bytes"); w.Uint64(part.bytes);
    w.Key("marks"); w.Uint64(part.marks);
    w.Key("files"); w.Uint64(part.files);
    w.Key("level"); w.Uint64(part.level);
    w.Key("age_seconds"); w.Uint64(part.age_seconds);
    w.Key("active"); w.Bool(part.active);
    w.EndObject();
  }
  w.EndArray();

  w.Key("partitions"); w.StartArray();
  for (const auto& partition : detail.partitions) {
    w.StartObject();
    w.Key("partition"); w.String(partition.partition.c_str());
    w.Key("rows"); w.Uint64(partition.rows);
    w.Key("bytes"); w.Uint64(partition.bytes);
    w.Key("parts"); w.Uint64(partition.parts);
    w.EndObject();
  }
  w.EndArray();

  w.Key("indexes_and_projections"); w.StartArray();
  for (const auto& item : detail.indexes_and_projections) {
    w.StartObject();
    w.Key("name"); w.String(item.name.c_str());
    w.Key("kind"); w.String(item.kind.c_str());
    w.Key("expression"); w.String(item.expression.c_str());
    w.Key("compressed_bytes"); write_optional_u64(w, item.compressed_bytes);
    w.Key("uncompressed_bytes"); write_optional_u64(w, item.uncompressed_bytes);
    w.Key("on_disk_bytes"); write_optional_u64(w, item.on_disk_bytes);
    w.EndObject();
  }
  w.EndArray();

  w.Key("mutations"); w.StartArray();
  for (const auto& item : detail.mutations) {
    w.StartObject();
    w.Key("mutation_id"); w.String(item.mutation_id.c_str());
    w.Key("command"); w.String(item.command.c_str());
    w.Key("create_time"); w.String(item.create_time.c_str());
    w.Key("done"); w.Bool(item.done);
    w.Key("parts_to_do"); w.Uint64(item.parts_to_do);
    w.Key("latest_failed_part"); w.String(item.latest_failed_part.c_str());
    w.Key("latest_fail_time"); w.String(item.latest_fail_time.c_str());
    w.Key("latest_fail_reason"); w.String(item.latest_fail_reason.c_str());
    w.EndObject();
  }
  w.EndArray();

  w.Key("merges"); w.StartArray();
  for (const auto& item : detail.merges) {
    w.StartObject();
    w.Key("partition"); w.String(item.partition.c_str());
    w.Key("result_part_name"); w.String(item.result_part_name.c_str());
    w.Key("elapsed_seconds"); w.Double(item.elapsed_seconds);
    w.Key("progress"); w.Double(item.progress);
    w.Key("num_parts"); w.Uint64(item.num_parts);
    w.Key("rows_read"); w.Uint64(item.rows_read);
    w.Key("bytes_read"); w.Uint64(item.bytes_read);
    w.Key("memory_usage"); w.Uint64(item.memory_usage);
    w.EndObject();
  }
  w.EndArray();

  w.Key("topology"); w.StartArray();
  for (const auto& node : detail.topology) {
    w.StartObject();
    w.Key("cluster"); w.String(node.cluster.c_str());
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    w.Key("host_name"); w.String(node.host_name.c_str());
    w.Key("host_address"); w.String(node.host_address.c_str());
    w.Key("port"); w.Uint64(node.port);
    w.Key("is_local"); w.Bool(node.is_local);
    w.Key("errors_count"); w.Uint64(node.errors_count);
    w.Key("slowdowns_count"); w.Uint64(node.slowdowns_count);
    w.Key("estimated_recovery_time"); w.Uint64(node.estimated_recovery_time);
    w.EndObject();
  }
  w.EndArray();

  w.Key("distribution_queue"); w.StartArray();
  for (const auto& item : detail.distribution_queue) {
    w.StartObject();
    w.Key("data_path"); w.String(item.data_path.c_str());
    w.Key("blocked"); w.Bool(item.blocked);
    w.Key("error_count"); w.Uint64(item.error_count);
    w.Key("data_files"); w.Uint64(item.data_files);
    w.Key("data_compressed_bytes"); w.Uint64(item.data_compressed_bytes);
    w.Key("broken_data_files"); w.Uint64(item.broken_data_files);
    w.Key("broken_data_compressed_bytes"); w.Uint64(item.broken_data_compressed_bytes);
    w.Key("last_exception"); w.String(item.last_exception.c_str());
    w.Key("last_exception_time"); w.String(item.last_exception_time.c_str());
    w.EndObject();
  }
  w.EndArray();

  w.Key("replication_queue"); w.StartArray();
  for (const auto& item : detail.replication_queue) {
    w.StartObject();
    w.Key("type"); w.String(item.type.c_str());
    w.Key("create_time"); w.String(item.create_time.c_str());
    w.Key("source_replica"); w.String(item.source_replica.c_str());
    w.Key("new_part_name"); w.String(item.new_part_name.c_str());
    w.Key("num_tries"); w.Uint64(item.num_tries);
    w.Key("last_attempt_time"); w.String(item.last_attempt_time.c_str());
    w.Key("last_exception"); w.String(item.last_exception.c_str());
    w.EndObject();
  }
  w.EndArray();

  w.Key("dependencies"); w.StartArray();
  for (const auto& item : detail.dependencies) {
    w.StartObject();
    w.Key("database"); w.String(item.database.c_str());
    w.Key("table"); w.String(item.table.c_str());
    w.Key("relation"); w.String(item.relation.c_str());
    w.EndObject();
  }
  w.EndArray();

  w.Key("ddl"); w.String(detail.create_table_query.c_str());
  w.Key("unavailable_sections"); w.StartArray();
  for (const auto& section : detail.unavailable_sections) w.String(section.c_str());
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_explorer_functions(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const uint64_t ts = now_ms();
  const uint64_t ttl = static_cast<uint64_t>(std::max(1000, cfg_.explorer.function_cache_ttl_ms));
  const std::string security_key = explorer_security_key(host_id);
  const std::string functions_key = security_key + std::string("\0functions", 10);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  if (force_refresh) explorer_functions_cache_.erase(functions_key);

  // Function discovery is intentionally executed with runner_uri. Unlike table
  // observability, there is no reason to elevate this metadata query through
  // the technical metadata account; the runner remains ClickHouse's own visibility boundary.
  auto functions_result = explorer_functions_cache_.get_or_refresh(
      functions_key, ts, ttl, 250,
      [&](ExplorerFunctionsCatalog& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        if (!load_explorer_functions(*runner, value, &error)) {
          code = "functions_unavailable";
          message = error.empty() ? "Function metadata is unavailable on this server." : error;
          return false;
        }
        return true;
      });
  if (!functions_result.has_value || !functions_result.value) {
    return json_error(
        res, 503,
        functions_result.error_code.empty() ? "functions_unavailable" : functions_result.error_code,
        functions_result.error_message.empty() ? "Function metadata is unavailable on this server." : functions_result.error_message);
  }

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("stale"); w.Bool(functions_result.stale);
  w.Key("documentation_available"); w.Bool(functions_result.value->documentation_available);
  w.Key("markdown_links_enabled"); w.Bool(cfg_.explorer.function_markdown_links);
  w.Key("functions"); w.StartArray();
  for (const auto& function : functions_result.value->functions) {
    w.StartObject();
    w.Key("name"); w.String(function.name.c_str());
    w.Key("kind"); w.String(function.kind.c_str());
    w.Key("category"); w.String(function.category.c_str());
    w.Key("description"); w.String(function.description.c_str());
    w.Key("syntax"); w.String(function.syntax.c_str());
    w.Key("arguments"); w.String(function.arguments.c_str());
    w.Key("parameters"); w.String(function.parameters.c_str());
    w.Key("returned_value"); w.String(function.returned_value.c_str());
    w.Key("examples"); w.String(function.examples.c_str());
    w.Key("introduced_in"); w.String(function.introduced_in.c_str());
    w.Key("source"); w.String(function.source.c_str());
    w.Key("origin"); w.String(function.origin.c_str());
    w.Key("alias_documents"); w.StartArray();
    for (const auto& alias : function.alias_documents) {
      w.StartObject();
      w.Key("name"); w.String(alias.name.c_str());
      w.Key("description"); w.String(alias.description.c_str());
      w.Key("syntax"); w.String(alias.syntax.c_str());
      w.Key("arguments"); w.String(alias.arguments.c_str());
      w.Key("parameters"); w.String(alias.parameters.c_str());
      w.Key("returned_value"); w.String(alias.returned_value.c_str());
      w.Key("examples"); w.String(alias.examples.c_str());
      w.Key("introduced_in"); w.String(alias.introduced_in.c_str());
      w.EndObject();
    }
    w.EndArray();
    w.Key("user_defined"); w.Bool(function.user_defined);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_explorer_table_data(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString() ||
      !doc.HasMember("database") || !doc["database"].IsString() ||
      !doc.HasMember("table") || !doc["table"].IsString()) {
    return json_error(res, 400, "missing_scope", "host_id, database and table are required.");
  }
  const std::string host_id = doc["host_id"].GetString();
  const std::string database = doc["database"].GetString();
  const std::string table = doc["table"].GetString();
  size_t limit = 100;
  if (doc.HasMember("limit") && doc["limit"].IsUint64()) limit = static_cast<size_t>(doc["limit"].GetUint64());
  limit = std::max<size_t>(1, std::min<size_t>(limit, 500));

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  std::string error;
  auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
  if (!runner) {
    return json_error(
        res, 503, "runner_unavailable",
        error.empty() ? "Cannot connect to the runner context." : error);
  }

  AllowedObjectSet allowed;
  try {
    allowed = discover_allowed_objects(*runner);
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(runner);
    return json_error(res, 503, "acl_discovery_failed", e.what());
  }
  if (!allowed.allows_table(database, table)) {
    return json_error(res, 404, "object_not_found", "Object not found.");
  }

  ExplorerPreview preview;
  if (!load_explorer_preview(*runner, allowed, database, table, limit, preview, &error)) {
    return json_error(
        res, 503, "preview_failed",
        error.empty() ? "Unable to preview object data." : error);
  }

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("database"); w.String(database.c_str());
  w.Key("table"); w.String(table.c_str());
  w.Key("limit"); w.Uint64(preview.limit);
  w.Key("columns"); w.StartArray();
  for (const auto& column : preview.columns) {
    w.StartObject();
    w.Key("name"); w.String(column.name.c_str());
    w.Key("type"); w.String(column.type.c_str());
    w.Key("finalized_for_preview"); w.Bool(column.finalized_for_preview);
    w.EndObject();
  }
  w.EndArray();
  w.Key("rows"); w.StartArray();
  for (const auto& row : preview.rows) {
    w.StartArray();
    for (const auto& value_json : row) {
      rapidjson::Document value;
      value.Parse(value_json.data(), value_json.size());
      if (value.HasParseError()) {
        return json_error(res, 500, "preview_serialization_failed", "Explorer produced an invalid typed JSON cell.");
      }
      value.Accept(w);
    }
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}


void Server::handle_explorer_graph(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const uint64_t ts = now_ms();
  const uint64_t ttl = static_cast<uint64_t>(std::max(0, cfg_.explorer.cache_ttl_ms));
  const std::string security_key = explorer_security_key(host_id);
  const std::string catalog_key = security_key + std::string("\0catalog", 8);
  const std::string graph_key = security_key + std::string("\0graph", 6);
  const std::string functions_key = security_key + std::string("\0functions", 10);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  if (force_refresh) {
    explorer_allowed_cache_.erase(security_key);
    explorer_catalog_cache_.erase(catalog_key);
    explorer_graph_cache_.erase(graph_key);
    explorer_functions_cache_.erase(functions_key);
  }

  auto allowed_result = explorer_allowed_cache_.get_or_refresh(
      security_key, ts, ttl, 250,
      [&](AllowedObjectSet& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) { code = "runner_unavailable"; message = error; return false; }
        try { value = discover_allowed_objects(*runner); return true; }
        catch (const std::exception& e) { code = "acl_discovery_failed"; message = e.what(); return false; }
      });
  if (!allowed_result.has_value || !allowed_result.value) {
    return json_error(
        res, 503,
        allowed_result.error_code.empty() ? "acl_unavailable" : allowed_result.error_code,
        allowed_result.error_message.empty() ? "Unable to determine readable ClickHouse objects." : allowed_result.error_message);
  }

  auto catalog_result = explorer_catalog_cache_.get_or_refresh(
      catalog_key, ts, ttl, 250,
      [&](ExplorerCatalog& value, std::string& code, std::string& message) {
        const std::string uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        std::string error;
        auto system = acquire_explorer_client(client_pool_, uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        if (!load_explorer_catalog(*system, *runner, *allowed_result.value, value, &error)) {
          code = "explorer_catalog_failed"; message = error; return false;
        }
        return true;
      });
  if (!catalog_result.has_value || !catalog_result.value) {
    return json_error(
        res, 503,
        catalog_result.error_code.empty() ? "explorer_unavailable" : catalog_result.error_code,
        catalog_result.error_message.empty() ? "Explorer metadata is unavailable." : catalog_result.error_message);
  }

  auto graph_result = explorer_graph_cache_.get_or_refresh(
      graph_key, ts, ttl, 250,
      [&](ExplorerGraph& value, std::string& code, std::string& message) {
        const std::string uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        std::string error;
        auto system = acquire_explorer_client(client_pool_, uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        if (!load_explorer_graph(*system, *allowed_result.value, *catalog_result.value, value, &error)) {
          code = "explorer_graph_failed"; message = error; return false;
        }
        return true;
      });
  if (!graph_result.has_value || !graph_result.value) {
    return json_error(
        res, 503,
        graph_result.error_code.empty() ? "explorer_graph_unavailable" : graph_result.error_code,
        graph_result.error_message.empty() ? "Explorer graph is unavailable." : graph_result.error_message);
  }

  const std::string database_filter = req.has_param("database") ? req.get_param_value("database") : std::string{};
  std::unordered_set<std::string> included;
  for (const auto& node : graph_result.value->nodes) {
    if (!database_filter.empty() && node.database != database_filter) continue;
    const bool layer_enabled =
        (node.layer == "logical" && cfg_.explorer.lineage) ||
        (node.layer == "physical" && cfg_.explorer.storage_topology);
    if (layer_enabled) included.insert(node.id);
  }

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("generated_at_ms"); w.Uint64(graph_result.value->generated_at_ms);
  w.Key("stale"); w.Bool(graph_result.stale || catalog_result.stale || allowed_result.stale);
  w.Key("metric_scope"); w.String(graph_result.value->metric_scope.c_str());
  w.Key("refreshable_views_available"); w.Bool(graph_result.value->refreshable_views_available);
  w.Key("live_refresh_ms"); w.Int(cfg_.explorer.live_refresh_ms);
  w.Key("nodes"); w.StartArray();
  for (const auto& node : graph_result.value->nodes) {
    if (!included.count(node.id)) continue;
    w.StartObject();
    w.Key("id"); w.String(node.id.c_str());
    w.Key("layer"); w.String(node.layer.c_str());
    w.Key("parent_id"); w.String(node.parent_id.c_str());
    w.Key("kind"); w.String(node.kind.c_str());
    w.Key("database"); w.String(node.database.c_str());
    w.Key("name"); w.String(node.name.c_str());
    w.Key("engine"); w.String(node.engine.c_str());
    w.Key("label"); w.String(node.label.c_str());
    w.Key("health"); w.String(node.health.c_str());
    w.Key("topology_badge"); w.String(node.topology_badge.c_str());
    w.Key("rows"); write_optional_u64(w, node.rows);
    w.Key("logical_bytes"); write_optional_u64(w, node.logical_bytes);
    w.Key("physical_bytes"); write_optional_u64(w, node.physical_bytes);
    w.Key("resident_bytes"); write_optional_u64(w, node.resident_bytes);
    w.Key("active_parts"); w.Uint64(node.active_parts);
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    w.Key("host_name"); w.String(node.host_name.c_str());
    w.Key("disk_name"); w.String(node.disk_name.c_str());
    w.Key("disk_path"); w.String(node.disk_path.c_str());
    w.Key("disk_type"); w.String(node.disk_type.c_str());
    w.Key("storage_policy"); w.String(node.storage_policy.c_str());
    w.Key("volume_name"); w.String(node.volume_name.c_str());
    w.Key("volume_priority"); w.Uint64(node.volume_priority);
    w.Key("move_factor"); w.Double(node.move_factor);
    w.Key("disk_free_space"); write_optional_u64(w, node.disk_free_space);
    w.Key("disk_total_space"); write_optional_u64(w, node.disk_total_space);
    w.Key("buffer_layers"); w.Uint64(node.buffer_layers);
    w.Key("buffer_min_time"); write_optional_u64(w, node.buffer_min_time);
    w.Key("buffer_max_time"); write_optional_u64(w, node.buffer_max_time);
    w.Key("buffer_min_rows"); write_optional_u64(w, node.buffer_min_rows);
    w.Key("buffer_max_rows"); write_optional_u64(w, node.buffer_max_rows);
    w.Key("buffer_min_bytes"); write_optional_u64(w, node.buffer_min_bytes);
    w.Key("buffer_max_bytes"); write_optional_u64(w, node.buffer_max_bytes);
    w.Key("ttl_rules"); w.StartArray();
    for (const auto& rule : node.ttl_rules) {
      w.StartObject();
      w.Key("expression"); w.String(rule.expression.c_str());
      w.Key("base_expression"); w.String(rule.base_expression.c_str());
      w.Key("offset_label"); w.String(rule.offset_label.c_str());
      w.Key("action"); w.String(rule.action.c_str());
      w.Key("target_kind"); w.String(rule.target_kind.c_str());
      w.Key("target"); w.String(rule.target.c_str());
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("edges"); w.StartArray();
  for (const auto& edge : graph_result.value->edges) {
    if (!included.count(edge.from) || !included.count(edge.to)) continue;
    w.StartObject();
    w.Key("id"); w.String(edge.id.c_str());
    w.Key("from"); w.String(edge.from.c_str());
    w.Key("to"); w.String(edge.to.c_str());
    w.Key("kind"); w.String(edge.kind.c_str());
    w.Key("label"); w.String(edge.label.c_str());
    w.Key("can_animate"); w.Bool(edge.can_animate);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_explorer_activity(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  const uint64_t ts = now_ms();
  const uint64_t ttl = static_cast<uint64_t>(std::max(0, cfg_.explorer.cache_ttl_ms));
  const std::string security_key = explorer_security_key(host_id);
  const std::string catalog_key = security_key + std::string("\0catalog", 8);
  const std::string graph_key = security_key + std::string("\0graph", 6);

  auto allowed_result = explorer_allowed_cache_.get_or_refresh(
      security_key, ts, ttl, 250,
      [&](AllowedObjectSet& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) { code = "runner_unavailable"; message = error; return false; }
        try { value = discover_allowed_objects(*runner); return true; }
        catch (const std::exception& e) { code = "acl_discovery_failed"; message = e.what(); return false; }
      });
  if (!allowed_result.has_value || !allowed_result.value) {
    return json_error(
        res, 503,
        allowed_result.error_code.empty() ? "acl_unavailable" : allowed_result.error_code,
        allowed_result.error_message.empty() ? "Unable to determine readable ClickHouse objects." : allowed_result.error_message);
  }

  auto catalog_result = explorer_catalog_cache_.get_or_refresh(
      catalog_key, ts, ttl, 250,
      [&](ExplorerCatalog& value, std::string& code, std::string& message) {
        const std::string uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        std::string error;
        auto system = acquire_explorer_client(client_pool_, uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        if (!load_explorer_catalog(*system, *runner, *allowed_result.value, value, &error)) {
          code = "explorer_catalog_failed"; message = error; return false;
        }
        return true;
      });
  if (!catalog_result.has_value || !catalog_result.value) {
    return json_error(
        res, 503,
        catalog_result.error_code.empty() ? "explorer_unavailable" : catalog_result.error_code,
        catalog_result.error_message.empty() ? "Explorer metadata is unavailable." : catalog_result.error_message);
  }

  auto graph_result = explorer_graph_cache_.get_or_refresh(
      graph_key, ts, ttl, 250,
      [&](ExplorerGraph& value, std::string& code, std::string& message) {
        const std::string uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        std::string error;
        auto system = acquire_explorer_client(client_pool_, uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        if (!load_explorer_graph(*system, *allowed_result.value, *catalog_result.value, value, &error)) {
          code = "explorer_graph_failed"; message = error; return false;
        }
        return true;
      });
  if (!graph_result.has_value || !graph_result.value) {
    return json_error(
        res, 503,
        graph_result.error_code.empty() ? "explorer_graph_unavailable" : graph_result.error_code,
        graph_result.error_message.empty() ? "Explorer graph is unavailable." : graph_result.error_message);
  }

  const std::string uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  std::string error;
  auto system = acquire_explorer_client(client_pool_, uri, &error);
  if (!system) {
    return json_error(
        res, 503, "system_context_unavailable",
        error.empty() ? "Cannot connect to the Explorer activity context." : error);
  }
  ExplorerGraphActivity activity;
  if (!load_explorer_graph_activity(*system, *allowed_result.value, *graph_result.value, activity, &error)) {
    return json_error(
        res, 503, "explorer_activity_failed",
        error.empty() ? "Unable to load Explorer graph activity." : error);
  }

  const std::string database_filter = req.has_param("database") ? req.get_param_value("database") : std::string{};
  std::unordered_set<std::string> included;
  for (const auto& node : graph_result.value->nodes) {
    if ((database_filter.empty() || node.database == database_filter) && node.layer == "logical") included.insert(node.id);
  }
  std::unordered_set<std::string> included_edges;
  for (const auto& edge : graph_result.value->edges) {
    if (included.count(edge.from) && included.count(edge.to)) included_edges.insert(edge.id);
  }

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("generated_at_ms"); w.Uint64(activity.generated_at_ms);
  w.Key("metric_scope"); w.String(activity.metric_scope.c_str());
  w.Key("nodes"); w.StartArray();
  for (const auto& node : activity.nodes) {
    if (!included.count(node.node_id)) continue;
    w.StartObject();
    w.Key("node_id"); w.String(node.node_id.c_str());
    w.Key("read_rows_per_second"); write_optional_double(w, node.read_rows_per_second);
    w.Key("read_bytes_per_second"); write_optional_double(w, node.read_bytes_per_second);
    w.Key("client_write_rows_per_second"); write_optional_double(w, node.client_write_rows_per_second);
    w.Key("client_write_bytes_per_second"); write_optional_double(w, node.client_write_bytes_per_second);
    w.Key("physical_write_rows_per_second"); write_optional_double(w, node.physical_write_rows_per_second);
    w.Key("physical_write_bytes_per_second"); write_optional_double(w, node.physical_write_bytes_per_second);
    w.Key("replication_queue"); w.Uint64(node.replication_queue);
    w.Key("replication_delay_seconds"); w.Uint64(node.replication_delay_seconds);
    w.Key("refresh_status"); w.String(node.refresh_status.c_str());
    w.Key("last_refresh_time"); w.String(node.last_refresh_time.c_str());
    w.Key("next_refresh_time"); w.String(node.next_refresh_time.c_str());
    w.Key("refresh_read_rows"); write_optional_u64(w, node.refresh_read_rows);
    w.Key("refresh_written_rows"); write_optional_u64(w, node.refresh_written_rows);
    w.EndObject();
  }
  w.EndArray();
  w.Key("edges"); w.StartArray();
  for (const auto& edge : activity.edges) {
    if (!included_edges.count(edge.edge_id)) continue;
    w.StartObject();
    w.Key("edge_id"); w.String(edge.edge_id.c_str());
    w.Key("rows_per_second"); w.Double(edge.rows_per_second);
    w.Key("bytes_per_second"); w.Double(edge.bytes_per_second);
    w.Key("active"); w.Bool(edge.active);
    w.Key("state"); w.String(edge.state.c_str());
    w.EndObject();
  }
  w.EndArray();
  if (!error.empty()) { w.Key("warning"); w.String(error.c_str()); }
  w.EndObject();
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
