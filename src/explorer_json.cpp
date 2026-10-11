#include "explorer_json.hpp"

#include "json_parse.hpp"
#include "json_text.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {
namespace explorer {

namespace {

using JsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

// The sections that a missing grant left out: their names, and for each the user and the grant to give.
void write_unavailable(JsonWriter& w, const std::vector<std::string>& sections,
                       const std::vector<ExplorerUnavailableIssue>& issues) {
  w.Key("unavailable_sections"); w.StartArray();
  for (const auto& section : sections) write_json_text(w, section);
  w.EndArray();
  w.Key("unavailable"); w.StartArray();
  for (const auto& issue : issues) {
    w.StartObject();
    w.Key("section"); write_json_text(w, issue.section);
    w.Key("reason"); w.String("not_granted");
    w.Key("user"); write_json_text(w, issue.user);
    w.Key("grant"); write_json_text(w, issue.grant);
    const std::string hint = "GRANT " + issue.grant + (issue.user.empty() ? std::string() : " TO " + issue.user) + ";";
    w.Key("hint"); write_json_text(w, hint);
    w.EndObject();
  }
  w.EndArray();
}


void write_optional_u64(JsonWriter& w, const std::optional<uint64_t>& value) {
  if (value) w.Uint64(*value);
  else w.Null();
}

void write_optional_double(JsonWriter& w, const std::optional<double>& value) {
  if (value) w.Double(*value);
  else w.Null();
}

void write_rate(JsonWriter& w, const ExplorerRate& rate) {
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
  w.Key("last_event_time"); write_json_text(w, rate.last_event_time);
  w.EndObject();
}

void write_replication(JsonWriter& w, const ExplorerReplication& replication) {
  w.StartObject();
  w.Key("available"); w.Bool(replication.available);
  w.Key("total_replicas"); w.Uint64(replication.total_replicas);
  w.Key("active_replicas"); w.Uint64(replication.active_replicas);
  w.Key("queue_size"); w.Uint64(replication.queue_size);
  w.Key("absolute_delay_seconds"); w.Uint64(replication.absolute_delay_seconds);
  w.Key("readonly"); w.Bool(replication.readonly);
  w.Key("session_expired"); w.Bool(replication.session_expired);
  w.Key("replica_name"); write_json_text(w, replication.replica_name);
  w.Key("zookeeper_path"); write_json_text(w, replication.zookeeper_path);
  w.Key("is_leader"); w.Bool(replication.is_leader);
  w.Key("inserts_in_queue"); w.Uint64(replication.inserts_in_queue);
  w.Key("merges_in_queue"); w.Uint64(replication.merges_in_queue);
  w.Key("log_lag"); w.Uint64(replication.log_lag);
  w.Key("last_queue_update"); write_json_text(w, replication.last_queue_update);
  w.Key("replicas"); w.StartArray();
  for (const auto& [name, active] : replication.replicas) {
    w.StartObject();
    w.Key("name"); write_json_text(w, name);
    w.Key("active"); w.Bool(active);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
}

void write_summary(JsonWriter& w, const ExplorerTableSummary& table) {
  w.StartObject();
  w.Key("database"); write_json_text(w, table.database);
  w.Key("name"); write_json_text(w, table.name);
  w.Key("engine"); write_json_text(w, table.engine);
  w.Key("engine_full"); write_json_text(w, table.engine_full);
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
  w.Key("sorting_key"); write_json_text(w, table.sorting_key);
  w.Key("primary_key"); write_json_text(w, table.primary_key);
  w.Key("partition_key"); write_json_text(w, table.partition_key);
  w.Key("sampling_key"); write_json_text(w, table.sampling_key);
  w.Key("storage_policy"); write_json_text(w, table.storage_policy);
  w.Key("metadata_modification_time"); write_json_text(w, table.metadata_modification_time);
  w.Key("last_part_time"); write_json_text(w, table.last_part_time);
  w.Key("disks");
  w.StartArray();
  for (const auto& disk : table.disks) write_json_text(w, disk);
  w.EndArray();
  w.Key("client_ingress"); write_rate(w, table.client_ingress);
  w.Key("physical_ingress"); write_rate(w, table.physical_ingress);
  w.Key("replication"); write_replication(w, table.replication);
  w.Key("health"); write_json_text(w, table.health);
  w.Key("warnings");
  w.StartArray();
  for (const auto& warning : table.warnings) write_json_text(w, warning);
  w.EndArray();
  w.EndObject();
}


}  // namespace

std::string catalog_json(const std::string& host_id, const std::string& database_filter, const ExplorerCatalog& catalog, bool stale) {
  rapidjson::StringBuffer sb(nullptr, database_filter.empty() ? 8 * 1024 : 32 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(3);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("generated_at_ms"); w.Uint64(catalog.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  // A bound of the privilege discovery stopped it: objects that were not checked are not listed.
  w.Key("acl_truncated"); w.Bool(catalog.acl_truncated);
  w.Key("database"); write_json_text(w, database_filter);
  w.Key("databases");
  w.StartArray();
  for (const auto& database : catalog.databases) write_json_text(w, database);
  w.EndArray();
  w.Key("database_summaries");
  w.StartArray();
  for (const auto& database : catalog.database_summaries) {
    w.StartObject();
    w.Key("name"); write_json_text(w, database.name);
    w.Key("tables"); w.Uint64(database.tables);
    w.Key("rows"); w.Uint64(database.rows);
    w.Key("bytes"); w.Uint64(database.bytes);
    w.EndObject();
  }
  w.EndArray();
  // A database branch (database=<name>) also names the local disks its
  // active parts are on (the database card's Storage tab): the database's
  // bytes on each and the disk's free / total space.
  if (!database_filter.empty()) {
    w.Key("disks");
    w.StartArray();
    for (const auto& disk : catalog.database_disks) {
      w.StartObject();
      w.Key("name"); write_json_text(w, disk.name);
      w.Key("host_name"); write_json_text(w, disk.host_name);
      w.Key("path"); write_json_text(w, disk.path);
      w.Key("type"); write_json_text(w, disk.type);
      w.Key("bytes"); w.Uint64(disk.bytes);
      w.Key("free_space"); write_optional_u64(w, disk.free_space);
      w.Key("total_space"); write_optional_u64(w, disk.total_space);
      w.EndObject();
    }
    w.EndArray();
  }
  w.Key("tables");
  w.StartArray();
  for (const auto& table : catalog.tables) {
    w.StartObject();
    w.Key("database"); write_json_text(w, table.database);
    w.Key("name"); write_json_text(w, table.name);
    w.Key("engine"); write_json_text(w, table.engine);
    w.Key("metadata_modification_time"); write_json_text(w, table.metadata_modification_time);
    w.Key("rows"); write_optional_u64(w, table.rows);
    w.Key("bytes");
    if (table.resident_bytes) w.Uint64(*table.resident_bytes);
    else write_optional_u64(w, table.logical_bytes);
    // Database detail object table: filled by the per-database parts
    // aggregation (MergeTree); null / 0 / "" for other engines.
    w.Key("compressed_bytes"); write_optional_u64(w, table.compressed_bytes);
    w.Key("uncompressed_bytes"); write_optional_u64(w, table.uncompressed_bytes);
    w.Key("active_parts"); w.Uint64(table.active_parts);
    w.Key("last_part_time"); write_json_text(w, table.last_part_time);
    if (table.replication.available) {
      // Local replica state only (no Keeper read): read-only / expired session
      // is an error, a long queue or delay a warning.
      w.Key("replicated"); w.Bool(true);
      w.Key("health"); write_json_text(w, table.health);
    }
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return sb.GetString();
}

std::string storage_json(const std::string& host_id, const ExplorerStorageMap& map, bool stale) {
  uint64_t total_bytes = 0;
  uint64_t total_rows = 0;
  uint64_t total_resident = 0;
  uint64_t total_storing = 0;
  for (const auto& database : map.databases) {
    total_bytes += database.bytes;
    total_rows += database.rows;
    total_resident += database.resident_bytes;
    total_storing += database.storing_tables;
  }

  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("generated_at_ms"); w.Uint64(map.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  w.Key("metric_scope"); write_json_text(w, map.metric_scope);
  w.Key("byte_metric"); w.String("bytes_on_disk");
  w.Key("table_limit_per_database"); w.Uint64(map.table_limit_per_database);
  w.Key("total_bytes"); w.Uint64(total_bytes);
  w.Key("total_rows"); w.Uint64(total_rows);
  w.Key("resident_bytes"); w.Uint64(total_resident);
  w.Key("storing_tables"); w.Uint64(total_storing);
  w.Key("databases");
  w.StartArray();
  for (const auto& database : map.databases) {
    w.StartObject();
    w.Key("name"); write_json_text(w, database.name);
    w.Key("system"); w.Bool(is_system_database(database.name));
    w.Key("bytes"); w.Uint64(database.bytes);
    w.Key("rows"); w.Uint64(database.rows);
    w.Key("resident_bytes"); w.Uint64(database.resident_bytes);
    w.Key("objects"); w.Uint64(database.objects);
    w.Key("storing_tables"); w.Uint64(database.storing_tables);
    w.Key("omitted_tables"); w.Uint64(database.omitted_tables);
    w.Key("omitted_bytes"); w.Uint64(database.omitted_bytes);
    w.Key("omitted_rows"); w.Uint64(database.omitted_rows);
    w.Key("tables");
    w.StartArray();
    for (const auto& table : database.tables) {
      w.StartObject();
      w.Key("name"); write_json_text(w, table.name);
      w.Key("engine"); write_json_text(w, table.engine);
      w.Key("bytes"); w.Uint64(table.bytes);
      w.Key("rows"); write_optional_u64(w, table.rows);
      w.Key("parts"); w.Uint64(table.parts);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return sb.GetString();
}

std::string table_json(const std::string& host_id, const ExplorerTableDetail& detail, bool stale, uint64_t cache_ttl_ms) {
  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("metric_scope"); w.String("local-replica");
  w.Key("stale"); w.Bool(stale);
  w.Key("cache_ttl_ms"); w.Uint64(cache_ttl_ms);
  w.Key("generated_at_ms"); w.Uint64(detail.generated_at_ms);
  w.Key("summary"); write_summary(w, detail.summary);
  w.Key("footprint_scope"); w.StartObject();
  w.Key("database_bytes"); write_optional_u64(w, detail.database_footprint_bytes);
  w.Key("clickhouse_bytes"); write_optional_u64(w, detail.clickhouse_footprint_bytes);
  w.EndObject();

  w.Key("default_compression_codecs");
  w.StartArray();
  for (const auto& codec : detail.default_compression_codecs) write_json_text(w, codec);
  w.EndArray();

  w.Key("columns"); w.StartArray();
  for (const auto& column : detail.columns) {
    w.StartObject();
    w.Key("name"); write_json_text(w, column.name);
    w.Key("type"); write_json_text(w, column.type);
    w.Key("default_kind"); write_json_text(w, column.default_kind);
    w.Key("default_expression"); write_json_text(w, column.default_expression);
    w.Key("codec"); write_json_text(w, column.codec_expression);
    w.Key("ttl_expression"); write_json_text(w, column.ttl_expression);
    w.Key("comment"); write_json_text(w, column.comment);
    w.Key("is_in_partition_key"); w.Bool(column.in_partition_key);
    w.Key("is_in_sorting_key"); w.Bool(column.in_sorting_key);
    w.Key("is_in_primary_key"); w.Bool(column.in_primary_key);
    w.Key("is_in_sampling_key"); w.Bool(column.in_sampling_key);
    w.Key("is_subcolumn"); w.Bool(column.is_subcolumn);
    w.Key("parent_name"); write_json_text(w, column.parent_name);
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
    w.Key("disk"); write_json_text(w, disk.disk);
    w.Key("path"); write_json_text(w, disk.path);
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
    w.Key("name"); write_json_text(w, part.name);
    w.Key("partition"); write_json_text(w, part.partition);
    w.Key("disk"); write_json_text(w, part.disk);
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
    w.Key("partition"); write_json_text(w, partition.partition);
    w.Key("rows"); w.Uint64(partition.rows);
    w.Key("bytes"); w.Uint64(partition.bytes);
    w.Key("parts"); w.Uint64(partition.parts);
    w.EndObject();
  }
  w.EndArray();

  w.Key("indexes_and_projections"); w.StartArray();
  for (const auto& item : detail.indexes_and_projections) {
    w.StartObject();
    w.Key("name"); write_json_text(w, item.name);
    w.Key("kind"); write_json_text(w, item.kind);
    w.Key("expression"); write_json_text(w, item.expression);
    w.Key("compressed_bytes"); write_optional_u64(w, item.compressed_bytes);
    w.Key("uncompressed_bytes"); write_optional_u64(w, item.uncompressed_bytes);
    w.Key("on_disk_bytes"); write_optional_u64(w, item.on_disk_bytes);
    w.EndObject();
  }
  w.EndArray();

  w.Key("mutations"); w.StartArray();
  for (const auto& item : detail.mutations) {
    w.StartObject();
    w.Key("mutation_id"); write_json_text(w, item.mutation_id);
    w.Key("command"); write_json_text(w, item.command);
    w.Key("create_time"); write_json_text(w, item.create_time);
    w.Key("done"); w.Bool(item.done);
    w.Key("parts_to_do"); w.Uint64(item.parts_to_do);
    w.Key("latest_failed_part"); write_json_text(w, item.latest_failed_part);
    w.Key("latest_fail_time"); write_json_text(w, item.latest_fail_time);
    w.Key("latest_fail_reason"); write_json_text(w, item.latest_fail_reason);
    w.EndObject();
  }
  w.EndArray();

  w.Key("merges"); w.StartArray();
  for (const auto& item : detail.merges) {
    w.StartObject();
    w.Key("partition"); write_json_text(w, item.partition);
    w.Key("result_part_name"); write_json_text(w, item.result_part_name);
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
    w.Key("cluster"); write_json_text(w, node.cluster);
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    w.Key("host_name"); write_json_text(w, node.host_name);
    w.Key("host_address"); write_json_text(w, node.host_address);
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
    w.Key("data_path"); write_json_text(w, item.data_path);
    w.Key("blocked"); w.Bool(item.blocked);
    w.Key("error_count"); w.Uint64(item.error_count);
    w.Key("data_files"); w.Uint64(item.data_files);
    w.Key("data_compressed_bytes"); w.Uint64(item.data_compressed_bytes);
    w.Key("broken_data_files"); w.Uint64(item.broken_data_files);
    w.Key("broken_data_compressed_bytes"); w.Uint64(item.broken_data_compressed_bytes);
    w.Key("last_exception"); write_json_text(w, item.last_exception);
    w.Key("last_exception_time"); write_json_text(w, item.last_exception_time);
    w.EndObject();
  }
  w.EndArray();

  w.Key("replication_queue"); w.StartArray();
  for (const auto& item : detail.replication_queue) {
    w.StartObject();
    w.Key("type"); write_json_text(w, item.type);
    w.Key("create_time"); write_json_text(w, item.create_time);
    w.Key("source_replica"); write_json_text(w, item.source_replica);
    w.Key("new_part_name"); write_json_text(w, item.new_part_name);
    w.Key("num_tries"); w.Uint64(item.num_tries);
    w.Key("last_attempt_time"); write_json_text(w, item.last_attempt_time);
    w.Key("last_exception"); write_json_text(w, item.last_exception);
    w.EndObject();
  }
  w.EndArray();

  w.Key("dependencies"); w.StartArray();
  for (const auto& item : detail.dependencies) {
    w.StartObject();
    w.Key("database"); write_json_text(w, item.database);
    w.Key("table"); write_json_text(w, item.table);
    w.Key("relation"); write_json_text(w, item.relation);
    w.Key("kind"); write_json_text(w, item.kind);
    w.Key("engine"); write_json_text(w, item.engine);
    w.EndObject();
  }
  w.EndArray();

  w.Key("ddl"); write_json_text(w, detail.create_table_query);
  w.Key("table_ttl"); write_json_text(w, detail.table_ttl);
  if (!detail.distributed_cluster.empty()) {
    w.Key("distributed"); w.StartObject();
    w.Key("cluster"); write_json_text(w, detail.distributed_cluster);
    w.Key("database"); write_json_text(w, detail.distributed_database);
    w.Key("table"); write_json_text(w, detail.distributed_table);
    w.EndObject();
  }
  write_unavailable(w, detail.unavailable_sections, detail.unavailable_issues);
  w.EndObject();
  return sb.GetString();
}

std::string functions_json(const std::string& host_id, const ExplorerFunctionsCatalog& functions, bool stale, bool markdown_links_enabled) {
  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("stale"); w.Bool(stale);
  w.Key("documentation_available"); w.Bool(functions.documentation_available);
  w.Key("markdown_links_enabled"); w.Bool(markdown_links_enabled);
  w.Key("functions"); w.StartArray();
  for (const auto& function : functions.functions) {
    w.StartObject();
    w.Key("name"); write_json_text(w, function.name);
    w.Key("kind"); write_json_text(w, function.kind);
    w.Key("category"); write_json_text(w, function.category);
    w.Key("description"); write_json_text(w, function.description);
    w.Key("syntax"); write_json_text(w, function.syntax);
    w.Key("arguments"); write_json_text(w, function.arguments);
    w.Key("parameters"); write_json_text(w, function.parameters);
    w.Key("returned_value"); write_json_text(w, function.returned_value);
    w.Key("examples"); write_json_text(w, function.examples);
    w.Key("introduced_in"); write_json_text(w, function.introduced_in);
    w.Key("source"); write_json_text(w, function.source);
    w.Key("origin"); write_json_text(w, function.origin);
    w.Key("alias_documents"); w.StartArray();
    for (const auto& alias : function.alias_documents) {
      w.StartObject();
      w.Key("name"); write_json_text(w, alias.name);
      w.Key("description"); write_json_text(w, alias.description);
      w.Key("syntax"); write_json_text(w, alias.syntax);
      w.Key("arguments"); write_json_text(w, alias.arguments);
      w.Key("parameters"); write_json_text(w, alias.parameters);
      w.Key("returned_value"); write_json_text(w, alias.returned_value);
      w.Key("examples"); write_json_text(w, alias.examples);
      w.Key("introduced_in"); write_json_text(w, alias.introduced_in);
      w.EndObject();
    }
    w.EndArray();
    w.Key("user_defined"); w.Bool(function.user_defined);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return sb.GetString();
}

std::optional<std::string> preview_json(const std::string& host_id, const std::string& database, const std::string& table, const ExplorerPreview& preview) {
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("database"); write_json_text(w, database);
  w.Key("table"); write_json_text(w, table);
  w.Key("limit"); w.Uint64(preview.limit);
  w.Key("columns"); w.StartArray();
  for (const auto& column : preview.columns) {
    w.StartObject();
    w.Key("name"); write_json_text(w, column.name);
    w.Key("type"); write_json_text(w, column.type);
    w.Key("finalized_for_preview"); w.Bool(column.finalized_for_preview);
    w.EndObject();
  }
  w.EndArray();
  w.Key("rows"); w.StartArray();
  for (const auto& row : preview.rows) {
    w.StartArray();
    for (const auto& value_json : row) {
      rapidjson::Document value;
      parse_json_bounded(value, value_json);
      if (value.HasParseError()) {
        return std::nullopt;
      }
      value.Accept(w);
    }
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString());
}

std::string graph_json(const std::string& host_id, const ExplorerGraph& graph, const ExplorerGraph& scoped, const GraphScopeRequest& scope,
                       bool scope_has_more, const std::unordered_set<std::string>& storage_available, bool stale, int live_refresh_ms) {
  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("generated_at_ms"); w.Uint64(scoped.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  w.Key("metric_scope"); write_json_text(w, graph.metric_scope);
  w.Key("refreshable_views_available"); w.Bool(scoped.refreshable_views_available);
  // A bound of the graph left out the topology of some Distributed tables (kMaxGraphNodes, kMaxGraphEdges).
  w.Key("truncated"); w.Bool(graph.truncated);
  write_unavailable(w, scoped.unavailable_sections, scoped.unavailable_issues);
  w.Key("live_refresh_ms"); w.Int(live_refresh_ms);
  w.Key("scope_mode"); w.String(scope.physical ? "physical" : "logical");
  w.Key("scope_database"); write_json_text(w, scope.database);
  w.Key("scope_focus_id"); write_json_text(w, scope.focus_id);
  w.Key("scope_depth"); w.Int(scope.depth);
  w.Key("scope_has_more"); w.Bool(scope_has_more);
  w.Key("nodes"); w.StartArray();
  for (const auto& node : scoped.nodes) {
    w.StartObject();
    w.Key("id"); write_json_text(w, node.id);
    w.Key("layer"); write_json_text(w, node.layer);
    w.Key("parent_id"); write_json_text(w, node.parent_id);
    w.Key("kind"); write_json_text(w, node.kind);
    w.Key("database"); write_json_text(w, node.database);
    w.Key("name"); write_json_text(w, node.name);
    w.Key("engine"); write_json_text(w, node.engine);
    w.Key("label"); write_json_text(w, node.label);
    w.Key("health"); write_json_text(w, node.health);
    if (node.layer == "logical") {
      w.Key("storage_available"); w.Bool(storage_available.count(node.id) != 0);
      w.Key("hidden_upstream"); w.Uint64(node.hidden_upstream);
      w.Key("hidden_downstream"); w.Uint64(node.hidden_downstream);
    }
    w.Key("topology_badge"); write_json_text(w, node.topology_badge);
    w.Key("rows"); write_optional_u64(w, node.rows);
    w.Key("logical_bytes"); write_optional_u64(w, node.logical_bytes);
    w.Key("physical_bytes"); write_optional_u64(w, node.physical_bytes);
    w.Key("resident_bytes"); write_optional_u64(w, node.resident_bytes);
    w.Key("active_parts"); w.Uint64(node.active_parts);
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    w.Key("host_name"); write_json_text(w, node.host_name);
    w.Key("disk_name"); write_json_text(w, node.disk_name);
    w.Key("disk_path"); write_json_text(w, node.disk_path);
    w.Key("disk_type"); write_json_text(w, node.disk_type);
    w.Key("storage_policy"); write_json_text(w, node.storage_policy);
    w.Key("volume_name"); write_json_text(w, node.volume_name);
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
      w.Key("expression"); write_json_text(w, rule.expression);
      w.Key("base_expression"); write_json_text(w, rule.base_expression);
      w.Key("offset_label"); write_json_text(w, rule.offset_label);
      w.Key("action"); write_json_text(w, rule.action);
      w.Key("target_kind"); write_json_text(w, rule.target_kind);
      w.Key("target"); write_json_text(w, rule.target);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("edges"); w.StartArray();
  for (const auto& edge : scoped.edges) {
    w.StartObject();
    w.Key("id"); write_json_text(w, edge.id);
    w.Key("from"); write_json_text(w, edge.from);
    w.Key("to"); write_json_text(w, edge.to);
    w.Key("kind"); write_json_text(w, edge.kind);
    w.Key("label"); write_json_text(w, edge.label);
    w.Key("can_animate"); w.Bool(edge.can_animate);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return sb.GetString();
}

std::string definition_json(const std::string& host_id, const ExplorerGraphNode& node_ref, const ExplorerGraphDefinition& definition, bool stale) {
  const ExplorerGraphNode* node = &node_ref;
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("stale"); w.Bool(stale);
  w.Key("id"); write_json_text(w, node->id);
  w.Key("database"); write_json_text(w, node->database);
  w.Key("name"); write_json_text(w, node->name);
  w.Key("kind"); write_json_text(w, node->kind);
  w.Key("engine"); write_json_text(w, node->engine);
  w.Key("select_sql");
  if (definition.select_sql.empty()) w.Null(); else write_json_text(w, definition.select_sql);
  w.Key("select_sql_truncated"); w.Bool(definition.select_sql_truncated);
  w.Key("target_visible"); w.Bool(definition.target_visible);
  w.Key("target");
  if (definition.target_visible && !definition.target_table.empty()) {
    w.StartObject();
    w.Key("database"); write_json_text(w, definition.target_database);
    w.Key("table"); write_json_text(w, definition.target_table);
    w.EndObject();
  } else {
    w.Null();
  }
  w.Key("dictionary");
  if (node->kind == "dictionary") {
    w.StartObject();
    w.Key("source_kind"); write_json_text(w, definition.dictionary_source_kind);
    w.Key("layout"); write_json_text(w, definition.dictionary_layout);
    w.Key("lifetime"); write_json_text(w, definition.dictionary_lifetime);
    w.EndObject();
  } else {
    w.Null();
  }
  w.Key("distributed");
  if (node->kind == "distributed") {
    w.StartObject();
    w.Key("cluster"); write_json_text(w, definition.distributed_cluster);
    w.Key("sharding_key"); write_json_text(w, definition.distributed_sharding_key);
    w.Key("shards"); w.Uint64(definition.distributed_shards);
    w.Key("replicas_per_shard"); w.Uint64(definition.distributed_replicas);
    w.EndObject();
  } else {
    w.Null();
  }
  w.EndObject();
  return sb.GetString();
}

}  // namespace explorer
}  // namespace chdash
