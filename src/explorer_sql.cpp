#include "explorer_sql.hpp"

#include "ddl_text_cache.hpp"
#include "explorer_values.hpp"
#include "sql_literal.hpp"

#include <utility>

namespace chdash {
namespace explorer {

using sql::quote_ident;

namespace {

SqlStatement statement(std::string text) {
  SqlStatement out;
  out.sql = std::move(text);
  return out;
}

// "database = {p1:String} AND `table` = {p2:String}"
std::string scope_of(SqlParams& params, const char* table_column, const std::string& database, const std::string& table) {
  const std::string db = params.text(database);
  const std::string tbl = params.text(table);
  return "database = " + db + " AND `" + table_column + "` = " + tbl;
}

// The columns of the ingress rates. They hold the rows and the bytes of the last minute, of the last five minutes and of the last hour. They also hold the totals.
const char* const kQueryIngressColumns =
    "toString(sumIf(written_rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(written_rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(written_rows) / 3600.0), "
    "toString(sumIf(written_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
    "toString(sumIf(written_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
    "toString(sum(written_bytes) / 3600.0), ";

const char* const kBaseTables =
    // engine_full (column 3) is filled later from DdlTextCache.
    // The formatting for every object dominates this scan on large catalogs.
    "SELECT toString(database), toString(name), toString(engine), '', toString(sorting_key), toString(primary_key), toString(partition_key), toString(sampling_key), toString(storage_policy), "
    "toString(total_rows), toString(total_bytes), toString(total_bytes_uncompressed), arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time), "
    "toString(toUInt8(metadata_modification_time >= now() - 2)) "
    "FROM system.tables "
    "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') ";

}  // namespace

// ---- the catalog of the graph ----

SqlStatement base_tables_sql() { return statement(kBaseTables); }

SqlStatement base_tables_ordered_sql() { return statement(std::string(kBaseTables) + "ORDER BY database, name"); }

SqlStatement base_table_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string db = out.params.text(database);
  const std::string tbl = out.params.text(table);
  out.sql = std::string(kBaseTables) + "AND database = " + db + " AND name = " + tbl + " LIMIT 1";
  return out;
}

SqlStatement dictionaries_sql() {
  return statement("SELECT toString(database), toString(name), toString(element_count), toString(bytes_allocated) FROM system.dictionaries");
}

SqlStatement table_row_count_sql(const std::string& database, const std::string& table) {
  return statement("SELECT toString(count()) FROM " + qualified_ident(database, table));
}

SqlStatement parts_summary_sql() {
  return statement(
      "SELECT toString(database), toString(`table`), toString(sum(rows)), toString(sum(bytes_on_disk)), "
      "toString(sum(data_compressed_bytes)), toString(sum(data_uncompressed_bytes)), "
      "toString(count()), toString(uniqExact(partition_id)), "
      "arrayStringConcat(arraySort(groupUniqArray(disk_name)), ','), "
      "toString(max(modification_time)), toString(sum(secondary_indices_compressed_bytes)) "
      "FROM system.parts WHERE active GROUP BY database, `table`");
}

SqlStatement index_bytes_sql() {
  return statement(
      "SELECT toString(database), toString(`table`), toString(sum(secondary_indices_compressed_bytes)) "
      "FROM system.parts WHERE active GROUP BY database, `table`");
}

SqlStatement projection_bytes_sql() {
  return statement(
      "SELECT toString(database), toString(`table`), toString(sum(data_compressed_bytes)) "
      "FROM system.projection_parts WHERE active GROUP BY database, `table`");
}

SqlStatement query_ingress_sql() {
  return statement(
      "SELECT toString(arrayJoin(tables)) AS object, " + std::string(kQueryIngressColumns) +
      "toString(sum(written_rows)), toString(sum(written_bytes)), "
      "toString(max(event_time)) "
      "FROM system.query_log "
      "WHERE event_date >= toDate(now() - INTERVAL 1 HOUR) AND event_time >= now() - INTERVAL 1 HOUR AND type = 'QueryFinish' AND written_rows > 0 "
      "GROUP BY object");
}

SqlStatement part_ingress_sql() {
  return statement(
      "SELECT toString(database), toString(`table`), "
      "toString(sumIf(rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
      "toString(sumIf(rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
      "toString(sum(rows) / 3600.0), "
      "toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
      "toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
      "toString(sum(size_in_bytes) / 3600.0), "
      "toString(sum(rows)), toString(sum(size_in_bytes)), "
      "toString(countIf(event_time >= now() - INTERVAL 1 MINUTE)), "
      "toString(max(event_time)) "
      "FROM system.part_log "
      "WHERE event_date >= toDate(now() - INTERVAL 1 HOUR) AND event_time >= now() - INTERVAL 1 HOUR AND event_type = 'NewPart' "
      "GROUP BY database, `table`");
}

SqlStatement replicas_sql() {
  return statement(
      "SELECT toString(database), toString(`table`), "
      "toString(queue_size), toString(absolute_delay), toString(is_readonly), "
      "toString(is_session_expired), toString(replica_name), toString(zookeeper_path) "
      "FROM system.replicas");
}

SqlStatement replica_counts_sql(const std::vector<std::string>& databases, const std::vector<std::string>& tables) {
  SqlStatement out;
  // Apply the database and table predicates before the per-table status is collected. The status includes its Keeper requests.
  const std::string database_list = out.params.texts(databases);
  const std::string table_list = out.params.texts(tables);
  out.sql = "SELECT toString(database), toString(`table`), toString(total_replicas), toString(active_replicas) "
            "FROM system.replicas WHERE database IN (" + database_list + ") AND `table` IN (" + table_list + ")";
  return out;
}

SqlStatement disks_with_host_sql() {
  return statement(
      "SELECT toString(hostName()), toString(name), toString(path), toString(type), toString(free_space), toString(total_space) FROM system.disks");
}

SqlStatement parts_by_disk_sql() {
  return statement("SELECT toString(database), toString(disk_name), toString(sum(bytes_on_disk)) FROM system.parts WHERE active GROUP BY database, disk_name");
}

// ---- the sidebar ----

namespace {

SqlStatement index_tables(const std::vector<std::string>& databases, bool ordered) {
  SqlStatement out;
  std::string filter = " WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') ";
  if (databases.size() == 1) filter += "AND database = " + out.params.text(databases.front()) + " ";
  out.sql = "SELECT toString(database), toString(name), toString(engine), "
            "toString(total_rows), toString(total_bytes), toString(metadata_modification_time) FROM system.tables" + filter;
  if (ordered) out.sql += "ORDER BY database, name";
  return out;
}

}  // namespace

SqlStatement index_tables_sql(const std::vector<std::string>& databases) { return index_tables(databases, false); }

SqlStatement index_tables_ordered_sql(const std::vector<std::string>& databases) { return index_tables(databases, true); }

SqlStatement index_table_sql(const std::vector<std::string>& databases, const std::string& database, const std::string& table) {
  SqlStatement out = index_tables(databases, false);
  const std::string db = out.params.text(database);
  const std::string tbl = out.params.text(table);
  out.sql += "AND database = " + db + " AND name = " + tbl + " LIMIT 1";
  return out;
}

SqlStatement database_parts_sql(const std::string& database) {
  SqlStatement out;
  out.sql = "SELECT toString(`table`), toString(sum(rows)), toString(sum(bytes_on_disk)), "
            "toString(sum(data_compressed_bytes)), toString(sum(data_uncompressed_bytes)), "
            "toString(count()), toString(max(modification_time)) "
            "FROM system.parts WHERE active AND database = " + out.params.text(database) + " GROUP BY `table`";
  return out;
}

SqlStatement database_disk_bytes_sql(const std::string& database) {
  SqlStatement out;
  out.sql = "SELECT toString(disk_name), toString(sum(bytes_on_disk)) FROM system.parts WHERE active AND database = " +
            out.params.text(database) + " GROUP BY disk_name ORDER BY disk_name";
  return out;
}

SqlStatement database_replicas_sql(const std::string& database) {
  SqlStatement out;
  // Select only the columns that system.replicas serves from memory. total/active_replicas cost one Keeper read per table.
  out.sql = "SELECT toString(`table`), toString(is_readonly), toString(is_session_expired), "
            "toString(queue_size), toString(absolute_delay) FROM system.replicas WHERE database = " + out.params.text(database);
  return out;
}

SqlStatement database_totals_sql() {
  return statement(
      "SELECT toString(database), toString(count()), "
      "toString(sum(if(engine IN ('Buffer','Memory','Dictionary'), toUInt64(0), ifNull(total_rows, toUInt64(0))))), "
      "toString(sum(if(engine IN ('Buffer','Memory','Dictionary'), toUInt64(0), ifNull(total_bytes, toUInt64(0))))) "
      "FROM system.tables "
      "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') "
      "GROUP BY database ORDER BY database");
}

// ---- the storage map ----

SqlStatement storage_parts_sql(const std::vector<std::string>& databases) {
  SqlStatement out;
  const std::string filter = "database IN (" + out.params.texts(databases) + ")";
  out.sql = "SELECT toString(database), toString(`table`), toString(sum(rows)), "
            "toString(sum(bytes_on_disk)), toString(count()) "
            "FROM system.parts WHERE active AND " + filter + " GROUP BY database, `table`";
  return out;
}

SqlStatement storage_tables_sql(const std::vector<std::string>& databases) {
  SqlStatement out;
  const std::string filter = "database IN (" + out.params.texts(databases) + ")";
  out.sql = "SELECT toString(database), toString(name), toString(engine), "
            "toString(total_rows), toString(total_bytes) FROM system.tables WHERE " + filter;
  return out;
}

// ---- the card of a table ----

SqlStatement table_summary_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string db = out.params.text(database);
  const std::string tbl = out.params.text(table);
  out.sql = "SELECT toString(database), toString(name), toString(engine), toString(engine_full), "
            "toString(sorting_key), toString(primary_key), toString(partition_key), toString(sampling_key), "
            "toString(storage_policy), toString(total_rows), toString(total_bytes), "
            "toString(total_bytes_uncompressed), arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time) "
            "FROM system.tables WHERE database = " + db + " AND name = " + tbl + " LIMIT 1";
  return out;
}

SqlStatement buffer_target_rows_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string db = out.params.text(database);
  const std::string tbl = out.params.text(table);
  out.sql = "SELECT toString(total_rows) FROM system.tables WHERE database = " + db + " AND name = " + tbl + " LIMIT 1";
  return out;
}

SqlStatement dictionary_size_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string db = out.params.text(database);
  const std::string tbl = out.params.text(table);
  out.sql = "SELECT toString(element_count), toString(bytes_allocated) FROM system.dictionaries "
            "WHERE database = " + db + " AND name = " + tbl + " LIMIT 1";
  return out;
}

SqlStatement table_parts_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(sum(rows)), toString(sum(bytes_on_disk)), toString(sum(data_compressed_bytes)), "
            "toString(sum(data_uncompressed_bytes)), toString(count()), toString(uniqExact(partition_id)), "
            "arrayStringConcat(arraySort(groupUniqArray(disk_name)), ','), toString(max(modification_time)) "
            "FROM system.parts WHERE active AND " + scope;
  return out;
}

SqlStatement table_index_bytes_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(sum(secondary_indices_compressed_bytes)) FROM system.parts WHERE active AND " + scope;
  return out;
}

SqlStatement table_projection_bytes_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(sum(data_compressed_bytes)) FROM system.projection_parts WHERE active AND " + scope;
  return out;
}

SqlStatement table_query_ingress_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string object = out.params.text(database + "." + table);
  out.sql = "SELECT " + std::string(kQueryIngressColumns) +
            "toString(sum(written_rows)), toString(sum(written_bytes)), "
            "toString(max(event_time)) FROM system.query_log "
            "WHERE event_date >= toDate(now() - INTERVAL 1 HOUR) AND event_time >= now() - INTERVAL 1 HOUR AND type = 'QueryFinish' AND written_rows > 0 "
            "AND has(tables, " + object + ")";
  return out;
}

SqlStatement table_part_ingress_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(sumIf(rows, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
            "toString(sumIf(rows, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
            "toString(sum(rows) / 3600.0), "
            "toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 1 MINUTE) / 60.0), "
            "toString(sumIf(size_in_bytes, event_time >= now() - INTERVAL 5 MINUTE) / 300.0), "
            "toString(sum(size_in_bytes) / 3600.0), toString(sum(rows)), toString(sum(size_in_bytes)), "
            "toString(countIf(event_time >= now() - INTERVAL 1 MINUTE)), toString(max(event_time)) "
            "FROM system.part_log WHERE event_date >= toDate(now() - INTERVAL 1 HOUR) AND event_time >= now() - INTERVAL 1 HOUR AND event_type = 'NewPart' "
            "AND " + scope;
  return out;
}

namespace {

const char* const kReplicaBaseColumns =
    "toString(total_replicas), toString(active_replicas), toString(queue_size), "
    "toString(absolute_delay), toString(is_readonly), toString(is_session_expired), "
    "toString(replica_name), toString(zookeeper_path)";

}  // namespace

SqlStatement table_replica_detail_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  // The replica set (replica_is_active) costs the same Keeper reads as total/active_replicas. The opened table already pays for these reads.
  const std::string where = " FROM system.replicas WHERE " + scope_of(out.params, "table", database, table) + " LIMIT 1";
  out.sql = "SELECT " + std::string(kReplicaBaseColumns) + ", toString(is_leader), toString(inserts_in_queue), "
            "toString(merges_in_queue), toString(log_max_index - least(log_pointer, log_max_index)), toString(last_queue_update), "
            "arrayStringConcat(arrayMap((name, active) -> concat(toString(active), name), "
            "mapKeys(replica_is_active), mapValues(replica_is_active)), char(31))" + where;
  return out;
}

SqlStatement table_replica_base_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string where = " FROM system.replicas WHERE " + scope_of(out.params, "table", database, table) + " LIMIT 1";
  out.sql = "SELECT " + std::string(kReplicaBaseColumns) + where;
  return out;
}

SqlStatement table_ddl_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string db = out.params.text(database);
  const std::string tbl = out.params.text(table);
  out.sql = "SELECT toString(create_table_query) FROM system.tables WHERE database = " + db + " AND name = " + tbl + " LIMIT 1";
  return out;
}

SqlStatement columns_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  // system.columns does not expose ttl_expression on every supported ClickHouse release, for example 26.7.
  // The column TTLs come from DESCRIBE TABLE.
  out.sql = "SELECT toString(name), toString(type), toString(default_kind), toString(default_expression), toString(compression_codec), "
            "toString(data_compressed_bytes), toString(data_uncompressed_bytes), toString(comment), "
            "toString(is_in_partition_key), toString(is_in_sorting_key), toString(is_in_primary_key), toString(is_in_sampling_key) "
            "FROM system.columns WHERE " + scope + " ORDER BY position";
  return out;
}

SqlStatement describe_sql(const std::string& database, const std::string& table, bool with_subcolumns) {
  return statement("DESCRIBE TABLE " + qualified_ident(database, table) + " SETTINGS describe_include_subcolumns = " +
                   (with_subcolumns ? "1" : "0"));
}

SqlStatement default_codecs_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT arrayStringConcat(arraySort(groupUniqArray(default_compression_codec)), char(31)) "
            "FROM system.parts WHERE active AND " + scope;
  return out;
}

SqlStatement part_types_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT "
            "toString(countIf(part_type = 'Compact')), toString(countIf(part_type = 'Wide')), "
            "toString(sumIf(bytes_on_disk, part_type = 'Compact')), "
            "toString(sumIf(bytes_on_disk, part_type = 'Wide')), "
            "toString(sumIf(data_compressed_bytes, part_type = 'Compact')), "
            "toString(sumIf(data_uncompressed_bytes, part_type = 'Compact')), "
            "toString(sumIf(data_compressed_bytes, part_type = 'Wide')), "
            "toString(sumIf(data_uncompressed_bytes, part_type = 'Wide')) "
            "FROM system.parts WHERE active AND " + scope;
  return out;
}

SqlStatement wide_column_sizes_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(column), "
            "toString(sumIf(column_data_compressed_bytes, part_type = 'Wide')), "
            "toString(sumIf(column_data_uncompressed_bytes, part_type = 'Wide')) "
            "FROM system.parts_columns WHERE active AND " + scope + " GROUP BY column ORDER BY column";
  return out;
}

SqlStatement wide_subcolumn_sizes_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(column), toString(tupleElement(sc, 1)), "
            "toString(sum(tupleElement(sc, 2))), toString(sum(tupleElement(sc, 3))) "
            "FROM (SELECT column, arrayJoin(arrayZip(subcolumns.names, subcolumns.data_compressed_bytes, "
            "subcolumns.data_uncompressed_bytes)) AS sc FROM system.parts_columns "
            "WHERE active AND part_type = 'Wide' AND " + scope + ") "
            "GROUP BY column, tupleElement(sc, 1) ORDER BY column, tupleElement(sc, 1)";
  return out;
}

SqlStatement table_storage_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(disk_name), toString(sum(bytes_on_disk)), toString(sum(rows)), toString(count()) "
            "FROM system.parts WHERE active AND " + scope + " GROUP BY disk_name ORDER BY disk_name";
  return out;
}

SqlStatement disks_sql() {
  return statement("SELECT toString(name), toString(path), toString(free_space), toString(total_space) FROM system.disks");
}

SqlStatement part_list_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(name), toString(partition), toString(disk_name), toString(rows), toString(bytes_on_disk), toString(marks), toString(files), "
            "toString(level), toString(dateDiff('second', modification_time, now())), toString(active) "
            "FROM system.parts WHERE " + scope + " "
            "ORDER BY active DESC, modification_time DESC LIMIT 1000";
  return out;
}

SqlStatement partition_list_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(partition), toString(sum(rows)), toString(sum(bytes_on_disk)), toString(count()) "
            "FROM system.parts WHERE active AND " + scope + " "
            "GROUP BY partition ORDER BY max(modification_time) DESC LIMIT 1000";
  return out;
}

SqlStatement skipping_indices_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(name), toString(type), toString(expr), toString(data_compressed_bytes), toString(data_uncompressed_bytes) "
            "FROM system.data_skipping_indices WHERE " + scope + " ORDER BY name";
  return out;
}

SqlStatement projections_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(name), toString(type), toString(sorting_key) FROM system.projections "
            "WHERE " + scope + " ORDER BY name";
  return out;
}

SqlStatement projection_sizes_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(name), toString(sum(data_compressed_bytes)), toString(sum(data_uncompressed_bytes)), "
            "toString(sum(bytes_on_disk)) FROM system.projection_parts "
            "WHERE active AND " + scope + " GROUP BY name ORDER BY name";
  return out;
}

SqlStatement mutations_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(mutation_id), toString(command), toString(create_time), toString(is_done), toString(parts_to_do), "
            "toString(latest_failed_part), toString(latest_fail_time), toString(latest_fail_reason) "
            "FROM system.mutations WHERE " + scope + " ORDER BY create_time DESC LIMIT 100";
  return out;
}

SqlStatement merges_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(partition_id), toString(result_part_name), toString(elapsed), toString(progress), toString(num_parts), "
            "toString(rows_read), toString(bytes_read_uncompressed), toString(memory_usage) "
            "FROM system.merges WHERE " + scope + " ORDER BY elapsed DESC";
  return out;
}

SqlStatement distribution_queue_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(data_path), toString(is_blocked), toString(error_count), toString(data_files), "
            "toString(data_compressed_bytes), toString(broken_data_files), "
            "toString(broken_data_compressed_bytes), toString(last_exception), toString(last_exception_time) "
            "FROM system.distribution_queue WHERE " + scope +
            " ORDER BY error_count DESC, data_compressed_bytes DESC LIMIT 100";
  return out;
}

SqlStatement cluster_topology_sql(const std::string& cluster) {
  SqlStatement out;
  out.sql = "SELECT toString(cluster), toString(shard_num), toString(replica_num), toString(host_name), toString(host_address), "
            "toString(port), toString(is_local), toString(errors_count), toString(slowdowns_count), "
            "toString(estimated_recovery_time) FROM system.clusters WHERE cluster = " + out.params.text(cluster) +
            " ORDER BY shard_num, replica_num";
  return out;
}

SqlStatement replication_queue_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string scope = scope_of(out.params, "table", database, table);
  out.sql = "SELECT toString(type), toString(create_time), toString(source_replica), toString(new_part_name), toString(num_tries), "
            "toString(last_attempt_time), toString(last_exception) FROM system.replication_queue WHERE " + scope +
            " ORDER BY create_time LIMIT 100";
  return out;
}

// ---- the lineage of a table ----

SqlStatement downstream_dependencies_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string db = out.params.text(database);
  const std::string tbl = out.params.text(table);
  out.sql = "SELECT toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) "
            "FROM (SELECT arrayJoin(arrayZip(dependencies_database, dependencies_table)) AS dep "
            "FROM system.tables WHERE database = " + db + " AND name = " + tbl + ")";
  return out;
}

SqlStatement reverse_lineage_sql() {
  // system.tables applies database, name and engine predicates before it materializes the expensive columns (engine_full, as_select).
  // So the engine-filtered scan and the dependency lookup are two cheap statements.
  return statement(
      "SELECT toString(database), toString(name), toString(engine), "
      "if(engine = 'Buffer', toString(engine_full), ''), toString(as_select) "
      "FROM system.tables "
      "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') "
      "AND engine IN ('Buffer', 'View', 'MaterializedView', 'LiveView', 'WindowView')");
}

SqlStatement upstream_dependencies_sql(const std::string& database, const std::string& table) {
  SqlStatement out;
  const std::string tbl = out.params.text(table);
  const std::string db = out.params.text(database);
  out.sql = "SELECT toString(database), toString(name) FROM system.tables "
            "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') "
            "AND has(dependencies_table, " + tbl + ") "
            "AND has(arrayZip(dependencies_database, dependencies_table), tuple(" + db + ", " + tbl + "))";
  return out;
}

SqlStatement dependency_engines_sql(const std::vector<std::string>& databases, const std::vector<std::string>& tables) {
  SqlStatement out;
  const std::string database_list = out.params.texts(databases);
  const std::string table_list = out.params.texts(tables);
  out.sql = "SELECT toString(database), toString(name), toString(engine) FROM system.tables "
            "WHERE database IN (" + database_list + ") AND name IN (" + table_list + ")";
  return out;
}

// ---- the functions and the preview ----

SqlStatement function_documentation_sql() {
  return statement(
      "SELECT toString(name), toString(type), toString(description), toString(source) "
      "FROM system.documentation "
      "WHERE type IN ('Function', 'Aggregate Function', 'Table Function') "
      "ORDER BY type, name LIMIT 10000");
}

SqlStatement function_list_sql() {
  return statement(
      "SELECT toString(name), toString(is_aggregate), toString(origin), toString(create_query), "
      "toString(description), toString(syntax), toString(arguments), toString(parameters), "
      "toString(returned_value), toString(examples), toString(introduced_in), toString(categories) "
      "FROM system.functions ORDER BY name LIMIT 10000");
}

SqlStatement preview_columns_sql(const std::string& database, const std::string& table) {
  return describe_sql(database, table, false);
}

SqlStatement preview_sql(const std::string& database, const std::string& table, const std::vector<std::string>& columns,
                         const std::vector<std::string>& types, size_t limit) {
  std::string text = "SELECT ";
  for (size_t i = 0; i < columns.size(); ++i) {
    if (i) text += ", ";
    // clickhouse-cpp cannot deserialize native AggregateFunction state columns.
    // Finalize only the rows that the bounded preview selects. Then stringify the result.
    // This keeps the preview cheap (LIMIT <= 500). It also keeps the declared type in the metadata that the page gets.
    if (i < types.size() && types[i].rfind("AggregateFunction(", 0) == 0) {
      text += "toString(finalizeAggregation(" + quote_ident(columns[i]) + ")) AS " + quote_ident(columns[i]);
    } else {
      text += quote_ident(columns[i]);
    }
  }
  text += " FROM " + qualified_ident(database, table) + " LIMIT " + std::to_string(limit);
  return statement(std::move(text));
}

// ---- what the graph reads about the topology ----

SqlStatement graph_disks_sql() {
  return statement(
      "SELECT toString(hostName()), toString(name), toString(path), toString(type), "
      "toString(free_space), toString(total_space) FROM system.disks ORDER BY name");
}

SqlStatement graph_storage_policies_sql() {
  return statement(
      "SELECT toString(policy_name), toString(volume_name), toString(volume_priority), "
      "arrayStringConcat(disks, char(31)), toString(volume_type), toString(max_data_part_size), toString(move_factor) "
      "FROM system.storage_policies ORDER BY policy_name, volume_priority, volume_name");
}

SqlStatement graph_tables_sql() {
  // Select identity and version columns only.
  // The formatted texts come from DdlTextCache. It re-reads them only for objects whose metadata_modification_time changed since the previous graph build.
  return statement(
      std::string("SELECT toString(database), toString(name), toString(engine), arrayStringConcat(data_paths, char(31)), ") +
      DdlTextCache::kVersionColumns + " FROM system.tables");
}

SqlStatement graph_dependencies_sql() {
  return statement(
      "SELECT toString(database), toString(name), toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) "
      "FROM (SELECT toString(database) AS database, toString(name) AS name, arrayJoin(arrayZip(dependencies_database, dependencies_table)) AS dep FROM system.tables)");
}

SqlStatement graph_dictionary_sources_sql() {
  return statement(
      "SELECT toString(database), toString(name), toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) "
      "FROM (SELECT database, name, arrayJoin(arrayZip(loading_dependencies_database, loading_dependencies_table)) AS dep "
      "FROM system.tables WHERE engine = 'Dictionary')");
}

SqlStatement graph_clusters_sql() {
  return statement("SELECT toString(cluster), toString(shard_num), toString(replica_num), toString(host_name) FROM system.clusters ORDER BY cluster, shard_num, replica_num");
}

SqlStatement graph_refresh_probe_sql() {
  return statement("SELECT toString(count() > 0) FROM system.tables WHERE database = 'system' AND name = 'view_refreshes'");
}

}  // namespace explorer
}  // namespace chdash
