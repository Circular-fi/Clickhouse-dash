// The sidebar of the Explorer: the databases with their sizes, and the objects of one database that is opened. A database is read when it is
// opened, never all of them at once: the first paint is the names of the databases and their totals; the objects of a database come from the
// runner's own privileges (AclService), and only their names are looked up in system.tables.
#include "explorer_catalog.hpp"

#include "explorer_rules.hpp"
#include "explorer_sql.hpp"
#include "explorer_values.hpp"
#include "time_util.hpp"

#include <algorithm>
#include <map>
#include <unordered_map>
#include <unordered_set>

namespace chdash {

using namespace explorer;

bool load_explorer_catalog_index(
    ChExecutor& system,
    ChExecutor& runner,
    const AllowedObjectSet& allowed,
    ExplorerCatalog& out,
    std::string* error) {
  out = ExplorerCatalog{};
  out.generated_at_ms = static_cast<uint64_t>(now_ms());
  out.databases = allowed.databases();
  std::sort(out.databases.begin(), out.databases.end());

  std::unordered_set<std::string> seen;
  auto consume = [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const std::string database = block_string_at(block, 0, row);
      const std::string table = block_string_at(block, 1, row);
      if (!allowed.allows_table(database, table)) continue;
      const std::string key = table_key(database, table);
      if (!seen.insert(key).second) continue;
      ExplorerTableSummary item;
      item.database = database;
      item.name = table;
      item.engine = block_string_at(block, 2, row);
      item.rows = parse_u64(block_string_at(block, 3, row));
      const auto total_bytes = parse_u64(block_string_at(block, 4, row));
      item.metadata_modification_time = block_string_at(block, 5, row);
      if (is_resident_memory_engine(item.engine)) {
        item.resident_bytes = total_bytes;
      } else {
        item.logical_bytes = total_bytes;
        item.compressed_bytes = total_bytes;
      }
      out.tables.push_back(std::move(item));
    }
  };

  std::string system_error;
  bool loaded = try_select(system, index_tables_ordered_sql(out.databases), consume, &system_error);
  if (!loaded) {
    out.tables.clear();
    seen.clear();
    std::string runner_error;
    loaded = try_select(runner, index_tables_ordered_sql(out.databases), consume, &runner_error);
    if (!loaded) {
      if (error) {
        *error = "Lightweight system.tables catalog failed: " + system_error +
            "; runner fallback failed: " + runner_error;
      }
      return false;
    }
  }

  // Keep sidebar row/size statistics useful without loading the rich table detail payload. For a single lazily-expanded database, one
  // bounded parts aggregation gives exact MergeTree rows/bytes for every visible table. The same GROUP BY also feeds the database detail
  // object table (compressed / uncompressed data bytes, active part count, newest part time): extra sums over the already-scanned
  // system.parts rows, no per-table query.
  if (out.databases.size() == 1) {
    const std::string& database = out.databases.front();
    std::unordered_map<std::string, ExplorerTableSummary*> by_name;
    for (auto& item : out.tables) by_name.emplace(item.name, &item);
    std::string ignored;
    (void)try_select(system, database_parts_sql(database),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const auto it = by_name.find(block_string_at(block, 0, row));
          if (it == by_name.end() || !it->second) continue;
          it->second->rows = parse_u64(block_string_at(block, 1, row));
          const auto bytes = parse_u64(block_string_at(block, 2, row));
          it->second->logical_bytes = bytes;
          it->second->physical_bytes = bytes;
          it->second->compressed_bytes = parse_u64(block_string_at(block, 3, row));
          it->second->uncompressed_bytes = parse_u64(block_string_at(block, 4, row));
          it->second->active_parts = parse_u64(block_string_at(block, 5, row)).value_or(0);
          it->second->last_part_time = block_string_at(block, 6, row);
        }
      }, &ignored);

    // The disks of this database's active parts, with their capacity: one GROUP BY over the same system.parts rows and the small
    // system.disks.
    ignored.clear();
    std::map<std::string, uint64_t> disk_bytes;
    (void)try_select(system, database_disk_bytes_sql(database),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          disk_bytes[block_string_at(block, 0, row)] = parse_u64(block_string_at(block, 1, row)).value_or(0);
        }
      }, &ignored);
    if (!disk_bytes.empty()) {
      std::map<std::string, ExplorerDatabaseDisk> disks;
      for (const auto& [name, bytes] : disk_bytes) {
        ExplorerDatabaseDisk disk;
        disk.name = name;
        disk.bytes = bytes;
        disks.emplace(name, std::move(disk));
      }
      ignored.clear();
      (void)try_select(system, disks_with_host_sql(),
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            const auto it = disks.find(block_string_at(block, 1, row));
            if (it == disks.end()) continue;
            it->second.host_name = block_string_at(block, 0, row);
            it->second.path = block_string_at(block, 2, row);
            it->second.type = block_string_at(block, 3, row);
            it->second.free_space = parse_u64(block_string_at(block, 4, row));
            it->second.total_space = parse_u64(block_string_at(block, 5, row));
          }
        }, &ignored);
      for (auto& [name, disk] : disks) out.database_disks.push_back(std::move(disk));
    }

    // Replica health for the tree dot. Only the columns system.replicas serves from memory: total/active_replicas would cost one Keeper
    // read per table on every 5 s navigation refresh (the table detail reads them fresh).
    ignored.clear();
    (void)try_select(system, database_replicas_sql(database),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const auto it = by_name.find(block_string_at(block, 0, row));
          if (it == by_name.end() || !it->second) continue;
          auto& replica = it->second->replication;
          replica.available = true;
          replica.readonly = truthy(block_string_at(block, 1, row));
          replica.session_expired = truthy(block_string_at(block, 2, row));
          replica.queue_size = parse_u64(block_string_at(block, 3, row)).value_or(0);
          replica.absolute_delay_seconds = parse_u64(block_string_at(block, 4, row)).value_or(0);
          classify_health(*it->second);
        }
      }, &ignored);
  }

  // The lightweight catalog intentionally asks only for identity + small sidebar statistics. Fill newly created runner-visible objects one
  // by one if the technical system.tables snapshot lags behind ACL discovery.
  for (const auto& entry : allowed.tables()) {
    const std::string key = table_key(entry.database, entry.table);
    if (seen.count(key)) continue;
    std::string ignored;
    (void)try_select(runner, index_table_sql(out.databases, entry.database, entry.table), consume, &ignored);
  }

  std::sort(out.tables.begin(), out.tables.end(), [](const auto& a, const auto& b) {
    if (a.database != b.database) return a.database < b.database;
    return a.name < b.name;
  });
  return true;
}

bool load_explorer_database_summaries(
    ChExecutor& runner,
    const std::vector<std::string>& databases,
    std::vector<ExplorerDatabaseSummary>& out,
    std::string* error) {
  out.clear();
  if (databases.empty()) return true;

  std::unordered_set<std::string> visible(databases.begin(), databases.end());
  std::string section_error;
  const bool loaded = try_select(runner, database_totals_sql(), [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const std::string database = block_string_at(block, 0, row);
      if (!visible.count(database)) continue;
      ExplorerDatabaseSummary summary;
      summary.name = database;
      summary.tables = parse_u64(block_string_at(block, 1, row)).value_or(0);
      summary.rows = parse_u64(block_string_at(block, 2, row)).value_or(0);
      summary.bytes = parse_u64(block_string_at(block, 3, row)).value_or(0);
      out.push_back(std::move(summary));
    }
  }, &section_error);
  if (!loaded) {
    if (error) *error = section_error;
    out.clear();
    return false;
  }

  std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) {
    return a.name < b.name;
  });
  return true;
}

}  // namespace chdash
