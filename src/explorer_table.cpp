// The summary of one table of the Explorer: its identity, keys, sizes, ingress and replica state, for the header of its card.
// The detail (columns, parts, lineage, ...) is in explorer_detail.cpp. Every read is restricted to the selected object.
#include "explorer_catalog.hpp"

#include "explorer_rules.hpp"
#include "explorer_sql.hpp"
#include "explorer_values.hpp"
#include "sql_structure.hpp"

#include <algorithm>
#include <sstream>

namespace chdash {

using namespace explorer;

namespace {

// The ingress rates of one table. They hold the rows and the bytes of the last minute, the last five minutes and the last hour. They also hold the totals.
void read_rate(const clickhouse::Block& block, ExplorerRate& rate) {
  rate.rows_per_second_1m = parse_double(block_string_at(block, 0, 0));
  rate.rows_per_second_5m = parse_double(block_string_at(block, 1, 0));
  rate.rows_per_second_1h = parse_double(block_string_at(block, 2, 0));
  rate.bytes_per_second_1m = parse_double(block_string_at(block, 3, 0));
  rate.bytes_per_second_5m = parse_double(block_string_at(block, 4, 0));
  rate.bytes_per_second_1h = parse_double(block_string_at(block, 5, 0));
  rate.rows_total_1h = parse_u64(block_string_at(block, 6, 0));
  rate.bytes_total_1h = parse_u64(block_string_at(block, 7, 0));
}

// The row of system.replicas for the table. It holds the base columns. It also holds the replica set when the server has it.
void read_replica(const clickhouse::Block& block, ExplorerReplication& replica) {
  if (!block.GetRowCount()) return;
  replica = ExplorerReplication{};
  replica.available = true;
  replica.total_replicas = parse_u64(block_string_at(block, 0, 0)).value_or(0);
  replica.active_replicas = parse_u64(block_string_at(block, 1, 0)).value_or(0);
  replica.queue_size = parse_u64(block_string_at(block, 2, 0)).value_or(0);
  replica.absolute_delay_seconds = parse_u64(block_string_at(block, 3, 0)).value_or(0);
  replica.readonly = truthy(block_string_at(block, 4, 0));
  replica.session_expired = truthy(block_string_at(block, 5, 0));
  replica.replica_name = block_string_at(block, 6, 0);
  replica.zookeeper_path = block_string_at(block, 7, 0);
  if (block.GetColumnCount() < 14) return;
  replica.is_leader = truthy(block_string_at(block, 8, 0));
  replica.inserts_in_queue = parse_u64(block_string_at(block, 9, 0)).value_or(0);
  replica.merges_in_queue = parse_u64(block_string_at(block, 10, 0)).value_or(0);
  replica.log_lag = parse_u64(block_string_at(block, 11, 0)).value_or(0);
  replica.last_queue_update = block_string_at(block, 12, 0);
  // One entry for each registered replica, in the form "<0|1><replica name>". The Keeper order is arbitrary.
  for (const auto& entry : split_unit_separator(block_string_at(block, 13, 0))) {
    if (entry.size() < 2) continue;
    replica.replicas.emplace_back(entry.substr(1), entry[0] == '1');
  }
  std::sort(replica.replicas.begin(), replica.replicas.end());
}

}  // namespace

bool load_explorer_table_summary(
    ChExecutor& system,
    ChExecutor& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    ExplorerTableSummary& out,
    std::string* error) {
  if (!allowed.allows_table(database, table)) {
    if (error) *error = "object not found";
    return false;
  }

  out = ExplorerTableSummary{};
  const SqlStatement base_sql = table_summary_sql(database, table);

  auto consume_base = [&](const clickhouse::Block& block) {
    if (!block.GetRowCount()) return;
    out.database = block_string_at(block, 0, 0);
    out.name = block_string_at(block, 1, 0);
    out.engine = block_string_at(block, 2, 0);
    out.engine_full = block_string_at(block, 3, 0);
    out.sorting_key = block_string_at(block, 4, 0);
    out.primary_key = block_string_at(block, 5, 0);
    out.partition_key = block_string_at(block, 6, 0);
    out.sampling_key = block_string_at(block, 7, 0);
    out.storage_policy = block_string_at(block, 8, 0);
    out.rows = parse_u64(block_string_at(block, 9, 0));
    const auto total_bytes = parse_u64(block_string_at(block, 10, 0));
    const auto total_uncompressed_bytes = parse_u64(block_string_at(block, 11, 0));
    out.data_paths = split_unit_separator(block_string_at(block, 12, 0));
    out.metadata_modification_time = block_string_at(block, 13, 0);
    if (is_resident_memory_engine(out.engine)) {
      out.resident_bytes = total_bytes;
    } else {
      out.logical_bytes = total_bytes;
      out.compressed_bytes = total_bytes;
      out.uncompressed_bytes = total_uncompressed_bytes;
      if (is_log_family(out.engine)) out.physical_bytes = total_bytes;
    }
  };

  std::string base_error;
  bool loaded = try_select(system, base_sql, consume_base, &base_error);
  bool base_from_runner = false;
  if (!loaded || out.database.empty()) {
    out = ExplorerTableSummary{};
    std::string runner_error;
    loaded = try_select(runner, base_sql, consume_base, &runner_error);
    if (!loaded || out.database.empty()) {
      if (error) {
        *error = "Table summary metadata failed for " + database + "." + table +
            (runner_error.empty() ? std::string{} : ": " + runner_error);
      }
      return false;
    }
    base_from_runner = true;
  }

  // ClickHouse masks the secrets of engine_full for each user. The system account can hold the privilege displaySecretsInShowAndSelect
  // that the runner does not hold. So the text of the system account is never kept: take engine_full as the runner, the identity that
  // bounds the caller. The system account gives the numbers and the structure only (docs/explorer.md).
  if (!base_from_runner) {
    out.engine_full.clear();
    std::string engine_error;
    if (!try_select(runner, table_engine_full_sql(database, table),
          [&](const clickhouse::Block& block) {
            if (block.GetRowCount()) out.engine_full = block_string_at(block, 0, 0);
          }, &engine_error)) {
      if (error) *error = "Table engine metadata failed for " + database + "." + table + ": " + engine_error;
      return false;
    }
  }

  // Resolve exact rows / resident allocation for engines that do not own MergeTree parts. All queries are restricted to the selected object.
  //
  // For Buffer, system.tables.total_rows is the readable Buffer surface. It can include the destination table.
  // Explorer must show the resident buffered rows. It must not show "buffer + destination".
  // Subtract the lightweight row count of the destination, taken from the same system.tables source.
  // Leave the value unknown if the two snapshots cannot be reconciled safely.
  if (out.engine == "Buffer") {
    const auto args = sql::engine_arguments(out.engine_full, "Buffer");
    if (out.rows && args.size() >= 2 && !args[1].empty()) {
      const std::string target_database = resolve_buffer_database_arg(args[0], database);
      const std::string& target_table = args[1];
      std::optional<uint64_t> target_rows;
      const SqlStatement target_sql = buffer_target_rows_sql(target_database, target_table);
      std::string target_error;
      bool target_loaded = try_select(system, target_sql,
        [&](const clickhouse::Block& block) {
          if (block.GetRowCount()) target_rows = parse_u64(block_string_at(block, 0, 0));
        }, &target_error);
      if (!target_loaded || !target_rows) {
        target_rows.reset();
        std::string runner_error;
        (void)try_select(runner, target_sql,
          [&](const clickhouse::Block& block) {
            if (block.GetRowCount()) target_rows = parse_u64(block_string_at(block, 0, 0));
          }, &runner_error);
      }
      if (target_rows && *out.rows >= *target_rows) out.rows = *out.rows - *target_rows;
      else out.rows.reset();
    }
  } else if (out.engine == "Dictionary") {
    std::string ignored;
    (void)try_select(system, dictionary_size_sql(database, table),
      [&](const clickhouse::Block& block) {
        if (!block.GetRowCount()) return;
        out.rows = parse_u64(block_string_at(block, 0, 0));
        out.resident_bytes = parse_u64(block_string_at(block, 1, 0));
      }, &ignored);
  } else if (is_log_family(out.engine) && (!out.rows || *out.rows == 0)) {
    std::string ignored;
    (void)try_select(runner, table_row_count_sql(database, table),
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount()) out.rows = parse_u64(block_string_at(block, 0, 0));
      }, &ignored);
  }

  if (out.engine.find("MergeTree") != std::string::npos) {
    std::string section_error;
    (void)try_select(system, table_parts_sql(database, table),
      [&](const clickhouse::Block& block) {
        if (!block.GetRowCount()) return;
        out.rows = parse_u64(block_string_at(block, 0, 0));
        out.resident_bytes = parse_u64(block_string_at(block, 1, 0));
        out.logical_bytes = parse_u64(block_string_at(block, 1, 0));
        out.compressed_bytes = parse_u64(block_string_at(block, 2, 0));
        out.uncompressed_bytes = parse_u64(block_string_at(block, 3, 0));
        out.active_parts = parse_u64(block_string_at(block, 4, 0)).value_or(0);
        out.partitions = parse_u64(block_string_at(block, 5, 0)).value_or(0);
        const std::string disks = block_string_at(block, 6, 0);
        std::stringstream input(disks);
        for (std::string disk; std::getline(input, disk, ',');) if (!disk.empty()) out.disks.push_back(std::move(disk));
        out.last_part_time = block_string_at(block, 7, 0);
        if (out.engine.find("Replicated") == std::string::npos && out.engine != "Distributed") {
          out.physical_bytes = out.logical_bytes;
        }
      }, &section_error);

    section_error.clear();
    (void)try_select(system, table_index_bytes_sql(database, table),
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount()) out.secondary_indices_bytes = parse_u64(block_string_at(block, 0, 0)).value_or(0);
      }, &section_error);

    section_error.clear();
    (void)try_select(system, table_projection_bytes_sql(database, table),
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount()) out.projection_bytes = parse_u64(block_string_at(block, 0, 0)).value_or(0);
      }, &section_error);
  }

  // Ingress and replication are detail-only metrics. Keep them lazy.
  // Scope every system-log query to this exact table. Do not scan the server catalog each time Explorer opens.
  std::string ignored;
  (void)try_select(system, table_query_ingress_sql(database, table),
    [&](const clickhouse::Block& block) {
      if (!block.GetRowCount()) return;
      read_rate(block, out.client_ingress);
      out.client_ingress.last_event_time = block_string_at(block, 8, 0);
    }, &ignored);

  ignored.clear();
  (void)try_select(system, table_part_ingress_sql(database, table),
    [&](const clickhouse::Block& block) {
      if (!block.GetRowCount()) return;
      read_rate(block, out.physical_ingress);
      out.physical_ingress.new_parts_per_minute = parse_u64(block_string_at(block, 8, 0));
      out.physical_ingress.last_event_time = block_string_at(block, 9, 0);
    }, &ignored);

  // The replica set (replica_is_active) costs the same Keeper reads as total/active_replicas. The opened table already pays for these reads.
  // Builds without one of the extra columns use the base row.
  ignored.clear();
  const bool replica_detail_loaded = try_select(system, table_replica_detail_sql(database, table),
    [&](const clickhouse::Block& block) { read_replica(block, out.replication); }, &ignored);
  if (!replica_detail_loaded) {
    ignored.clear();
    (void)try_select(system, table_replica_base_sql(database, table),
      [&](const clickhouse::Block& block) { read_replica(block, out.replication); }, &ignored);
  }

  classify_health(out);
  return true;
}

}  // namespace chdash
