// The storage distribution of the Explorer: the bytes of every object that the runner reads, for the treemap of the System section.
#include "explorer_catalog.hpp"

#include "acl_service.hpp"
#include "explorer_rules.hpp"
#include "explorer_sql.hpp"
#include "explorer_values.hpp"
#include "time_util.hpp"

#include <algorithm>
#include <unordered_map>

namespace chdash {

using namespace explorer;

bool load_explorer_storage_map(
    ChExecutor& system,
    ChExecutor& runner,
    AclView& acl,
    ExplorerStorageMap& out,
    std::string* error) {
  out = ExplorerStorageMap{};
  out.generated_at_ms = static_cast<uint64_t>(now_ms());
  out.table_limit_per_database = kStorageTablesPerDatabase;

  // Visibility boundary: exactly the lazy sidebar discovery (the runner's ACL). No name reaches the response unless the runner reads it.
  const auto databases = acl.databases();
  if (databases.empty()) return true;
  for (const auto& database : databases) acl.objects(database);
  const auto is_visible = [&](const std::string& database, const std::string& table) {
    return acl.visible(database, table);
  };

  // One aggregated active-parts read for every visible database. This is pure part metadata: huge tables cost the same as small ones and no
  // data is read.
  std::unordered_map<std::string, StoragePartTotals> parts_by_table;
  auto consume_parts = [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const std::string database = block_string_at(block, 0, row);
      const std::string table = block_string_at(block, 1, row);
      if (!is_visible(database, table)) continue;
      StoragePartTotals totals;
      totals.rows = parse_u64(block_string_at(block, 2, row)).value_or(0);
      totals.bytes = parse_u64(block_string_at(block, 3, row)).value_or(0);
      totals.parts = parse_u64(block_string_at(block, 4, row)).value_or(0);
      parts_by_table[table_key(database, table)] = totals;
    }
  };
  std::string system_error;
  if (!try_select(system, storage_parts_sql(databases), consume_parts, &system_error)) {
    parts_by_table.clear();
    std::string runner_error;
    if (!try_select(runner, storage_parts_sql(databases), consume_parts, &runner_error)) {
      if (error) {
        *error = "system.parts storage aggregation failed: " + system_error +
            "; runner fallback failed: " + runner_error;
      }
      return false;
    }
  }

  // Engine identity for every visible object plus lightweight totals for engines that do not own MergeTree parts (Log family, Join/Set,
  // ...).
  std::unordered_map<std::string, StorageTableMeta> meta_by_table;
  auto consume_tables = [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const std::string database = block_string_at(block, 0, row);
      const std::string table = block_string_at(block, 1, row);
      if (!is_visible(database, table)) continue;
      StorageTableMeta meta;
      meta.engine = block_string_at(block, 2, row);
      meta.rows = parse_u64(block_string_at(block, 3, row));
      meta.bytes = parse_u64(block_string_at(block, 4, row));
      meta_by_table[table_key(database, table)] = std::move(meta);
    }
  };
  system_error.clear();
  if (!try_select(system, storage_tables_sql(databases), consume_tables, &system_error)) {
    meta_by_table.clear();
    std::string runner_error;
    if (!try_select(runner, storage_tables_sql(databases), consume_tables, &runner_error)) {
      if (error) {
        *error = "system.tables storage metadata failed: " + system_error +
            "; runner fallback failed: " + runner_error;
      }
      return false;
    }
  }

  for (const auto& database : databases) {
    std::vector<std::string> objects;
    for (const auto& object : acl.objects(database).objects) objects.push_back(object.table);
    out.databases.push_back(storage_of_database(database, objects, parts_by_table, meta_by_table));
  }
  std::sort(out.databases.begin(), out.databases.end(), [](const auto& a, const auto& b) {
    return a.name < b.name;
  });
  return true;
}

}  // namespace chdash
