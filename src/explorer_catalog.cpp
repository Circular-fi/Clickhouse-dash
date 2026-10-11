// The catalog of the graph: every object that the runner reads, with its engine, keys, sizes, ingress and replica health, read as the
// system account (what the runner may see is the AllowedObjectSet) and, where the system account fails, as the runner. The sidebar, the
// table card, the storage map, the functions and the preview have their own readers (explorer_index.cpp, explorer_table.cpp,
// explorer_storage.cpp, explorer_functions.cpp, explorer_preview.cpp); the rules that they share are in explorer_rules.hpp, and every
// statement is in explorer_sql.hpp.
#include "explorer_catalog.hpp"

#include "explorer_rules.hpp"
#include "explorer_sql.hpp"
#include "explorer_values.hpp"
#include "time_util.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace chdash {

using namespace explorer;

namespace {

bool load_base_summaries(
    ChExecutor& system,
    ChExecutor& runner,
    ExplorerCaches& caches,
    const ExplorerIdentities& identities,
    const AllowedObjectSet& allowed,
    std::vector<ExplorerTableSummary>& summaries,
    std::string* error) {
  std::unordered_map<std::string, size_t> by_key;
  std::vector<DdlObjectVersion> ddl_versions;
  std::vector<DdlObjectVersion> runner_ddl_versions;
  bool consuming_runner_fill = false;
  auto consume_tables = [&](const clickhouse::Block& block, bool has_storage_policy) {
    constexpr size_t kExpectedColumns = 15;
    if (block.GetRowCount() > 0 && block.GetColumnCount() < kExpectedColumns) {
      throw std::runtime_error(
          "system.tables metadata block has " + std::to_string(block.GetColumnCount()) +
          " columns; expected at least " + std::to_string(kExpectedColumns) + ".");
    }
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const std::string database = block_string_at(block, 0, row);
      const std::string table = block_string_at(block, 1, row);
      if (!allowed.allows_table(database, table)) continue;
      const std::string key = table_key(database, table);
      if (by_key.count(key)) continue;

      ExplorerTableSummary summary;
      summary.database = database;
      summary.name = table;
      summary.engine = block_string_at(block, 2, row);
      summary.engine_full = block_string_at(block, 3, row);
      summary.sorting_key = block_string_at(block, 4, row);
      summary.primary_key = block_string_at(block, 5, row);
      summary.partition_key = block_string_at(block, 6, row);
      summary.sampling_key = block_string_at(block, 7, row);
      if (has_storage_policy) summary.storage_policy = block_string_at(block, 8, row);
      // system.tables is the authoritative lightweight source for engines that do not create MergeTree parts (Memory, TinyLog/Log/StripeLog,
      // Buffer, dictionaries, etc.). MergeTree values are later replaced by the richer system.parts aggregation, so this is a safe baseline
      // rather than a competing metric source.
      summary.rows = parse_u64(block_string_at(block, 9, row));
      const auto total_bytes = parse_u64(block_string_at(block, 10, row));
      const auto total_uncompressed_bytes = parse_u64(block_string_at(block, 11, row));
      summary.data_paths = split_unit_separator(block_string_at(block, 12, row));
      summary.metadata_modification_time = block_string_at(block, 13, row);
      (consuming_runner_fill ? runner_ddl_versions : ddl_versions)
          .push_back(DdlObjectVersion{database, table, summary.metadata_modification_time,
                                      block_string_at(block, 14, row) == "1"});
      // system.tables.total_bytes is a resident-memory estimate for in-memory engines. Keep Buffer/Memory/Dictionary bytes in resident_bytes
      // so Browse never presents RAM as database/ClickHouse on-disk footprint. Dictionary bytes are replaced by
      // system.dictionaries.bytes_allocated when loaded.
      if (is_resident_memory_engine(summary.engine)) {
        summary.resident_bytes = total_bytes;
        summary.logical_bytes.reset();
        summary.compressed_bytes.reset();
        summary.uncompressed_bytes.reset();
      } else {
        summary.logical_bytes = total_bytes;
        summary.compressed_bytes = total_bytes;
        summary.uncompressed_bytes = total_uncompressed_bytes;
        if (is_log_family(summary.engine)) summary.physical_bytes = total_bytes;
      }
      by_key.emplace(key, summaries.size());
      summaries.push_back(std::move(summary));
    }
  };

  std::string metadata_error;
  bool ok = try_select(system, base_tables_ordered_sql(),
    [&](const clickhouse::Block& block) { consume_tables(block, true); }, &metadata_error);

  // The technical account is an enrichment source, not the ACL authority. A transient/native-protocol issue on its bulk system.tables
  // stream must not make every runner-readable object disappear. Retry the same backend-built metadata query through the runner, whose
  // AllowedObjectSet already defines the exact visibility boundary.
  bool metadata_from_runner = false;
  if (!ok) {
    summaries.clear();
    by_key.clear();
    ddl_versions.clear();
    metadata_from_runner = true;
    std::string runner_error;
    ok = try_select(runner, base_tables_ordered_sql(),
      [&](const clickhouse::Block& block) { consume_tables(block, true); }, &runner_error);
    if (!ok) {
      if (error) {
        *error = "system.tables failed: " + metadata_error +
            "; runner metadata fallback failed: " + runner_error;
      }
      return false;
    }
  }

  // system.tables visibility can lag or differ for a narrowly privileged technical account, especially for objects created after the
  // process/test stack started. Fill only the missing runner-authorized objects with a targeted runner query. If an object disappeared
  // between ACL discovery and this lookup, simply omit that stale entry; never turn it into a global 503.
  for (const auto& entry : allowed.tables()) {
    const auto key = table_key(entry.database, entry.table);
    if (by_key.count(key)) continue;

    std::string runner_error;
    consuming_runner_fill = true;
    (void)try_select(runner, base_table_sql(entry.database, entry.table),
      [&](const clickhouse::Block& block) { consume_tables(block, true); }, &runner_error);
    consuming_runner_fill = false;
  }

  // engine_full for every summary (the runner-filled entries above included).
  try {
    auto& ddl_client = metadata_from_runner ? runner : system;
    auto texts = caches.ddl_texts.get(ddl_client, metadata_from_runner ? identities.runner : identities.system, ddl_versions);
    if (!runner_ddl_versions.empty()) {
      for (auto& [key, value] : caches.ddl_texts.get(runner, identities.runner, runner_ddl_versions)) {
        texts[key] = std::move(value);
      }
    }
    for (auto& summary : summaries) {
      const auto it = texts.find(DdlTextCache::object_key(summary.database, summary.name));
      if (it != texts.end()) summary.engine_full = it->second.engine_full;
    }
  } catch (const std::exception& e) {
    if (error) *error = std::string("system.tables engine_full lookup failed: ") + e.what();
    return false;
  }

  std::sort(summaries.begin(), summaries.end(), [](const auto& a, const auto& b) {
    if (a.database != b.database) return a.database < b.database;
    return a.name < b.name;
  });
  return true;
}

bool load_non_part_row_counts(
    ChExecutor& system,
    ChExecutor& runner,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  // Dictionaries do not expose row counts through system.parts. When loaded, system.dictionaries.element_count is the authoritative
  // metadata value.
  std::string dictionary_error;
  const bool dictionaries_loaded = try_select(system, dictionaries_sql(),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& target = *it->second;
        if (target.engine.find("Dictionary") == std::string::npos) continue;
        target.rows = parse_u64(block_string_at(block, 2, row));
        target.resident_bytes = parse_u64(block_string_at(block, 3, row));
        // Dictionary storage is an in-memory allocation. Its backing source is a separate object and must not make the dictionary itself
        // contribute to database/ClickHouse disk totals.
        target.logical_bytes.reset();
        target.physical_bytes.reset();
        target.compressed_bytes.reset();
        target.uncompressed_bytes.reset();
      }
    }, &dictionary_error);
  if (!dictionaries_loaded && error && error->empty()) {
    *error = "Dictionary row metadata unavailable: " + dictionary_error;
  }

  // TinyLog/Log/StripeLog may legitimately report total_rows=0 in system.tables on supported ClickHouse versions. Query the readable
  // object through runner_uri only in that ambiguous case. This is exact and never crosses the established runner ACL boundary.
  for (auto& [key, target] : map) {
    if (!target) continue;
    if (!is_log_family(target->engine) || (target->rows && *target->rows > 0)) continue;
    std::string count_error;
    std::optional<uint64_t> exact;
    const bool counted = try_select(runner, table_row_count_sql(target->database, target->name), [&](const clickhouse::Block& block) {
      if (block.GetRowCount()) exact = parse_u64(block_string_at(block, 0, 0));
    }, &count_error);
    if (counted && exact) target->rows = exact;
    else if (!counted && error && error->empty()) *error = "Log-engine row count unavailable: " + count_error;
  }
  return true;
}

// Also collects secondary-index bytes (the same GROUP BY over system.parts), so load_structure_bytes does not scan every active part a second
// time.
bool load_parts_summary(
    ChExecutor& system,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::unordered_set<std::string>* index_seen,
    std::string* error) {
  return try_select(system, parts_summary_sql(),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& target = *it->second;
        target.rows = parse_u64(block_string_at(block, 2, row));
        target.resident_bytes = parse_u64(block_string_at(block, 3, row));
        target.logical_bytes = parse_u64(block_string_at(block, 3, row));
        target.compressed_bytes = parse_u64(block_string_at(block, 4, row));
        target.uncompressed_bytes = parse_u64(block_string_at(block, 5, row));
        target.active_parts = parse_u64(block_string_at(block, 6, row)).value_or(0);
        target.partitions = parse_u64(block_string_at(block, 7, row)).value_or(0);
        const std::string disks = block_string_at(block, 8, row);
        std::stringstream input(disks);
        for (std::string disk; std::getline(input, disk, ',');) {
          if (!disk.empty()) target.disks.push_back(std::move(disk));
        }
        target.last_part_time = block_string_at(block, 9, row);
        target.secondary_indices_bytes = parse_u64(block_string_at(block, 10, row));
        if (index_seen) index_seen->insert(it->first);

        // A local non-replicated table's local footprint is its physical footprint. Replicated/Distributed physical totals require a
        // cluster-wide mapping and are deliberately left unknown here.
        if (target.engine.find("Replicated") == std::string::npos && target.engine != "Distributed") {
          target.physical_bytes = target.logical_bytes;
        }
      }
    }, error);
}

void load_structure_bytes(
    ChExecutor& system,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    const std::unordered_set<std::string>* index_seen_from_parts,
    std::string* error) {
  std::string section_error;
  std::unordered_set<std::string> index_seen;
  if (index_seen_from_parts) index_seen = *index_seen_from_parts;
  const bool indexes_loaded = index_seen_from_parts != nullptr || try_select(system, index_bytes_sql(),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto key = table_key(database, table);
        const auto it = map.find(key);
        if (it == map.end()) continue;
        it->second->secondary_indices_bytes = parse_u64(block_string_at(block, 2, row));
        index_seen.insert(key);
      }
    }, &section_error);
  if (indexes_loaded) {
    // A successful system.parts query makes the absence of active parts a known zero for on-disk index bytes. Keep unknown exclusively for
    // failed metadata reads instead of rendering a misleading 0% on errors.
    for (auto& [key, table] : map) {
      if (table && table->engine.find("MergeTree") != std::string::npos && !index_seen.count(key)) {
        table->secondary_indices_bytes = 0;
      }
    }
  } else {
    for (auto& [_, table] : map) if (table) table->secondary_indices_bytes.reset();
    if (error && error->empty() && !section_error.empty()) *error = "Skipping-index size query failed: " + section_error;
  }

  section_error.clear();
  std::unordered_set<std::string> projection_seen;
  const bool projections_loaded = try_select(system, projection_bytes_sql(),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        it->second->projection_bytes = parse_u64(block_string_at(block, 2, row));
        projection_seen.insert(table_key(database, table));
      }
    }, &section_error);
  if (projections_loaded) {
    // projection_parts has no row for tables with zero materialized projection bytes (including empty MergeTrees). A successful query
    // makes that absence a known zero independently of the skipping-index query above.
    for (auto& [key, table] : map) {
      if (table && table->engine.find("MergeTree") != std::string::npos && !projection_seen.count(key)) {
        table->projection_bytes = 0;
      }
    }
  } else {
    for (auto& [_, table] : map) if (table) table->projection_bytes.reset();
    if (error && error->empty() && !section_error.empty()) *error = "Projection size query failed: " + section_error;
  }
}

bool load_query_ingress(
    ChExecutor& system,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  return try_select(system, query_ingress_sql(),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string object = block_string_at(block, 0, row);
        const size_t dot = object.find('.');
        if (dot == std::string::npos) continue;
        const std::string database = object.substr(0, dot);
        const std::string table = object.substr(dot + 1);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& rate = it->second->client_ingress;
        rate.rows_per_second_1m = parse_double(block_string_at(block, 1, row));
        rate.rows_per_second_5m = parse_double(block_string_at(block, 2, row));
        rate.rows_per_second_1h = parse_double(block_string_at(block, 3, row));
        rate.bytes_per_second_1m = parse_double(block_string_at(block, 4, row));
        rate.bytes_per_second_5m = parse_double(block_string_at(block, 5, row));
        rate.bytes_per_second_1h = parse_double(block_string_at(block, 6, row));
        rate.rows_total_1h = parse_u64(block_string_at(block, 7, row));
        rate.bytes_total_1h = parse_u64(block_string_at(block, 8, row));
        rate.last_event_time = block_string_at(block, 9, row);
      }
    }, error);
}

bool load_part_ingress(
    ChExecutor& system,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  return try_select(system, part_ingress_sql(),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& rate = it->second->physical_ingress;
        rate.rows_per_second_1m = parse_double(block_string_at(block, 2, row));
        rate.rows_per_second_5m = parse_double(block_string_at(block, 3, row));
        rate.rows_per_second_1h = parse_double(block_string_at(block, 4, row));
        rate.bytes_per_second_1m = parse_double(block_string_at(block, 5, row));
        rate.bytes_per_second_5m = parse_double(block_string_at(block, 6, row));
        rate.bytes_per_second_1h = parse_double(block_string_at(block, 7, row));
        rate.rows_total_1h = parse_u64(block_string_at(block, 8, row));
        rate.bytes_total_1h = parse_u64(block_string_at(block, 9, row));
        rate.new_parts_per_minute = parse_u64(block_string_at(block, 10, row));
        rate.last_event_time = block_string_at(block, 11, row);
      }
    }, error);
}

bool load_replication(
    ChExecutor& system,
    ExplorerCaches& caches,
    const AllowedObjectSet& allowed,
    std::unordered_map<std::string, ExplorerTableSummary*>& map,
    std::string* error) {
  std::vector<std::pair<std::string, std::string>> replicated;
  const bool ok = try_select(system, replicas_sql(),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string database = block_string_at(block, 0, row);
        const std::string table = block_string_at(block, 1, row);
        if (!allowed.allows_table(database, table)) continue;
        const auto it = map.find(table_key(database, table));
        if (it == map.end()) continue;
        auto& replica = it->second->replication;
        replica.available = true;
        replica.queue_size = parse_u64(block_string_at(block, 2, row)).value_or(0);
        replica.absolute_delay_seconds = parse_u64(block_string_at(block, 3, row)).value_or(0);
        replica.readonly = truthy(block_string_at(block, 4, row));
        replica.session_expired = truthy(block_string_at(block, 5, row));
        replica.replica_name = block_string_at(block, 6, row);
        replica.zookeeper_path = block_string_at(block, 7, row);
        replicated.emplace_back(database, table);
      }
    }, error);
  if (!ok || replicated.empty()) return ok;

  std::string counts_error;
  const auto counts = load_cached_replica_counts(system, caches, replicated, &counts_error);
  for (const auto& [database, table] : replicated) {
    const auto key = table_key(database, table);
    const auto it = counts.find(key);
    if (it == counts.end()) continue;
    auto& replica = map.at(key)->replication;
    replica.total_replicas = it->second.total;
    replica.active_replicas = it->second.active;
  }
  // Counts are an enrichment: a failed lookup leaves them unknown (0) rather than failing the whole catalog.
  if (!counts_error.empty() && error && error->empty()) *error = "Replica count lookup failed: " + counts_error;
  return true;
}

bool load_database_summaries(
    ChExecutor& system,
    const AllowedObjectSet& allowed,
    const std::vector<ExplorerTableSummary>& tables,
    std::vector<ExplorerDatabaseSummary>& out,
    std::string* error) {
  std::map<std::string, DiskCapacity> capacity;
  std::string section_error;
  if (!try_select(system, disks_with_host_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          capacity[block_string_at(block, 1, row)] = {
            block_string_at(block, 0, row), block_string_at(block, 2, row), block_string_at(block, 3, row),
            parse_u64(block_string_at(block, 4, row)), parse_u64(block_string_at(block, 5, row))};
        }
      }, &section_error)) {
    if (error) *error = "Database disk capacity query failed: " + section_error;
    return false;
  }

  std::map<std::pair<std::string, std::string>, uint64_t> bytes_by_disk;
  section_error.clear();
  if (!try_select(system, parts_by_disk_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string database = block_string_at(block, 0, row);
          if (!allowed.allows_database(database)) continue;
          bytes_by_disk[{database, block_string_at(block, 1, row)}] = parse_u64(block_string_at(block, 2, row)).value_or(0);
        }
      }, &section_error)) {
    if (error) *error = "Database disk distribution query failed: " + section_error;
    return false;
  }

  out = database_summaries_of(tables, capacity, std::move(bytes_by_disk));
  return true;
}

}  // namespace

bool load_explorer_catalog(
    ChExecutor& system,
    ChExecutor& runner,
    ExplorerCaches& caches,
    const ExplorerIdentities& identities,
    const AllowedObjectSet& allowed,
    ExplorerCatalog& out,
    std::string* error) {
  out = ExplorerCatalog{};
  out.generated_at_ms = static_cast<uint64_t>(now_ms());
  out.databases = allowed.databases();
  std::sort(out.databases.begin(), out.databases.end());

  if (!load_base_summaries(system, runner, caches, identities, allowed, out.tables, error)) return false;

  std::unordered_map<std::string, ExplorerTableSummary*> map;
  map.reserve(out.tables.size());
  for (auto& table : out.tables) map.emplace(table_key(table.database, table.name), &table);

  std::string section_error;
  // Buffer total_rows and the destination total_rows must come from the same system.tables snapshot. Normalize before system.parts replaces
  // MergeTree counts with a later physical snapshot.
  normalize_buffer_runtime_rows(out.tables);

  // Populate engines that do not own MergeTree parts before database totals and graph nodes are derived from the catalog. Failures are
  // intentionally best-effort: metadata remains usable with an unknown row count.
  load_non_part_row_counts(system, runner, allowed, map, &section_error);
  section_error.clear();
  std::unordered_set<std::string> parts_index_seen;
  const bool parts_loaded = load_parts_summary(system, allowed, map, &parts_index_seen, &section_error);
  if (!parts_loaded) {
    if (!degrade_on_denied("parts_summary", section_error, out)) {
      if (error) *error = "Parts summary query failed: " + section_error;
      return false;
    }
  }
  section_error.clear();
  load_structure_bytes(system, allowed, map, parts_loaded ? &parts_index_seen : nullptr, &section_error);
  section_error.clear();
  if (!load_query_ingress(system, allowed, map, &section_error)) {
    if (!degrade_on_denied("query_ingress", section_error, out)) {
      if (error) *error = "Query ingress query failed: " + section_error;
      return false;
    }
  }
  if (!out.unavailable_sections.empty() && out.unavailable_sections.back() == "query_ingress") out.query_log_available = false;
  section_error.clear();
  if (!load_part_ingress(system, allowed, map, &section_error)) {
    if (!degrade_on_denied("part_ingress", section_error, out)) {
      if (error) *error = "Part ingress query failed: " + section_error;
      return false;
    }
  }
  if (!out.unavailable_sections.empty() && out.unavailable_sections.back() == "part_ingress") out.part_log_available = false;
  section_error.clear();
  if (!load_replication(system, caches, allowed, map, &section_error)) {
    if (!degrade_on_denied("replication", section_error, out)) {
      if (error) *error = "Replication metadata query failed: " + section_error;
      return false;
    }
  }
  if (!out.unavailable_sections.empty() && out.unavailable_sections.back() == "replication") out.replication_available = false;

  section_error.clear();
  if (!load_database_summaries(system, allowed, out.tables, out.database_summaries, &section_error)) {
    if (!degrade_on_denied("database_summaries", section_error, out)) {
      if (error) *error = section_error;
      return false;
    }
  }

  for (auto& table : out.tables) classify_health(table);
  return true;
}

}  // namespace chdash
