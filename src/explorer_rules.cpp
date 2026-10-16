#include "explorer_rules.hpp"

#include "explorer_values.hpp"
#include "sql_structure.hpp"

#include <algorithm>
#include <cctype>
#include <set>
#include <unordered_set>
#include <utility>

namespace chdash {
namespace explorer {

bool is_log_family(const std::string& engine) { return engine == "TinyLog" || engine == "Log" || engine == "StripeLog"; }

bool is_resident_memory_engine(const std::string& engine) { return engine == "Buffer" || engine == "Memory" || engine == "Dictionary"; }

void classify_health(ExplorerTableSummary& table) {
  table.health = "healthy";
  table.warnings.clear();

  if (table.replication.available) {
    if (table.replication.readonly || table.replication.session_expired) {
      table.health = "error";
      table.warnings.push_back("Replica is read-only or its coordination session expired.");
    } else if (table.replication.absolute_delay_seconds > 60 || table.replication.queue_size > 1000) {
      table.health = "warning";
      table.warnings.push_back("Replication queue or delay is elevated.");
    } else if (table.replication.total_replicas > 0 && table.replication.active_replicas < table.replication.total_replicas) {
      table.health = "warning";
      table.warnings.push_back("Not all replicas are currently active.");
    }
  }

  if (table.active_parts > 5000) {
    if (table.health == "healthy") table.health = "warning";
    table.warnings.push_back("Large number of active parts.");
  }
}

std::string resolve_buffer_database_arg(const std::string& arg, const std::string& source_database) {
  std::string compact;
  compact.reserve(arg.size());
  for (char ch : arg) {
    if (!std::isspace(static_cast<unsigned char>(ch))) compact.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  }
  if (compact == "currentdatabase()") return source_database;
  return arg;
}

void normalize_buffer_runtime_rows(std::vector<ExplorerTableSummary>& summaries) {
  // The readable surface of a Buffer is system.tables.total_rows. It is the resident rows plus the destination table.
  // Snapshot those exact system.tables values before system.parts replaces the MergeTree row counts.
  // Do not mix a Buffer total from T1 with a destination parts count from T2.
// A flush race then looks like resident rows that appear or disappear.
  // The raw snapshot also makes Buffer -> Buffer chains order-independent.
  std::unordered_map<std::string, std::optional<uint64_t>> raw_rows;
  raw_rows.reserve(summaries.size());
  for (const auto& table : summaries) {
    raw_rows.emplace(table_key(table.database, table.name), table.rows);
  }

  for (auto& table : summaries) {
    if (table.engine != "Buffer") continue;
    const auto own = raw_rows.find(table_key(table.database, table.name));
    const std::optional<uint64_t>* const own_rows = own == raw_rows.end() ? nullptr : &own->second;
    const auto args = sql::engine_arguments(table.engine_full, "Buffer");
    if (!own_rows || !*own_rows || args.size() < 2 || args[0].empty() || args[1].empty()) {
      table.rows.reset();
      continue;
    }

    const std::string target_database = resolve_buffer_database_arg(args[0], table.database);
    const auto target = raw_rows.find(table_key(target_database, args[1]));
    const std::optional<uint64_t>* const target_rows = target == raw_rows.end() ? nullptr : &target->second;
    if (!target_rows || !*target_rows) {
      // The target may be hidden by the runner ACL. It may also be unable to expose an exact lightweight row count.
      // In either case, the resident Buffer rows are unknown.
      table.rows.reset();
      continue;
    }

    const uint64_t readable_rows = **own_rows;
    const uint64_t target_readable_rows = **target_rows;
    if (readable_rows < target_readable_rows) {
      // Never clamp an inconsistent cross-object snapshot to zero. Zero is a fabricated resident-row count.
      // A later refresh can resolve the race.
      table.rows.reset();
      continue;
    }
    table.rows = readable_rows - target_readable_rows;
  }
}

ExplorerStorageDatabase storage_of_database(const std::string& database, const std::vector<std::string>& objects,
                                            const std::unordered_map<std::string, StoragePartTotals>& parts_by_table,
                                            const std::unordered_map<std::string, StorageTableMeta>& meta_by_table) {
  ExplorerStorageDatabase entry;
  entry.name = database;
  std::vector<ExplorerStorageTable> storing;
  entry.objects = objects.size();
  for (const auto& table : objects) {
    const std::string key = table_key(database, table);
    const auto meta_it = meta_by_table.find(key);
    const auto parts_it = parts_by_table.find(key);
    ExplorerStorageTable item;
    item.name = table;
    if (meta_it != meta_by_table.end()) item.engine = meta_it->second.engine;
    if (parts_it != parts_by_table.end()) {
      item.bytes = parts_it->second.bytes;
      item.rows = parts_it->second.rows;
      item.parts = parts_it->second.parts;
    } else if (meta_it != meta_by_table.end()) {
      if (is_resident_memory_engine(item.engine)) {
        // RAM allocation. It is reported, but never drawn as a disk area.
        entry.resident_bytes += meta_it->second.bytes.value_or(0);
        continue;
      }
      item.bytes = meta_it->second.bytes.value_or(0);
      item.rows = meta_it->second.rows;
    }
    if (item.bytes == 0) continue;
    entry.bytes += item.bytes;
    entry.rows += item.rows.value_or(0);
    storing.push_back(std::move(item));
  }
  std::sort(storing.begin(), storing.end(), [](const auto& a, const auto& b) {
    if (a.bytes != b.bytes) return a.bytes > b.bytes;
    return a.name < b.name;
  });
  entry.storing_tables = storing.size();
  for (size_t index = kStorageTablesPerDatabase; index < storing.size(); ++index) {
    entry.omitted_tables += 1;
    entry.omitted_bytes += storing[index].bytes;
    entry.omitted_rows += storing[index].rows.value_or(0);
  }
  if (storing.size() > kStorageTablesPerDatabase) storing.resize(kStorageTablesPerDatabase);
  entry.tables = std::move(storing);
  return entry;
}

std::vector<ExplorerDatabaseSummary> database_summaries_of(const std::vector<ExplorerTableSummary>& tables,
                                                           const std::map<std::string, DiskCapacity>& capacity,
                                                           std::map<std::pair<std::string, std::string>, uint64_t> bytes_by_disk) {
  std::map<std::string, ExplorerDatabaseSummary> by_database;
  for (const auto& table : tables) {
    auto& db = by_database[table.database];
    db.name = table.database;
    ++db.tables;
    db.rows += table.rows.value_or(0);
    // The Database and ClickHouse footprint is disk-backed storage.
    // Resident Memory, Buffer and dictionary allocations are not mixed into it on purpose.
    db.bytes += table.logical_bytes.value_or(0);
  }

  // system.parts has no rows for the Log-family engines. Their table-level total_bytes is still disk-backed.
  // If system.tables.data_paths resolves to exactly one configured disk, add these bytes to the database disk distribution.
  // This keeps the database total and its disk breakdown in the same physical unit.
  for (const auto& table : tables) {
    if (!is_log_family(table.engine) || !table.logical_bytes || table.data_paths.empty()) continue;
    std::set<std::string> matched_disks;
    for (const auto& data_path : table.data_paths) {
      const std::string best = disk_of_path(data_path, [&](auto&& visit) {
        for (const auto& [name, info] : capacity) visit(name, info.path);
      });
      if (!best.empty()) matched_disks.insert(best);
    }
    if (matched_disks.size() == 1) bytes_by_disk[{table.database, *matched_disks.begin()}] += *table.logical_bytes;
  }

  std::vector<ExplorerDatabaseSummary> out;
  for (auto& [name, db] : by_database) {
    std::set<std::string> disk_names;
    for (const auto& table : tables) if (table.database == name) disk_names.insert(table.disks.begin(), table.disks.end());
    // Log-family tables do not fill summary.disks through system.parts.
    // Include the disk that the data_paths above resolved to. Then the database breakdown shows the same disk bytes that are already counted here.
    for (const auto& [key, _] : bytes_by_disk) {
      if (key.first == name) disk_names.insert(key.second);
    }
    for (const auto& disk_name : disk_names) {
      ExplorerDatabaseDisk disk;
      disk.name = disk_name;
      disk.bytes = bytes_by_disk[{name, disk_name}];
      if (auto it = capacity.find(disk_name); it != capacity.end()) {
        disk.host_name = it->second.host;
        disk.path = it->second.path;
        disk.type = it->second.type;
        disk.free_space = it->second.free;
        disk.total_space = it->second.total;
      }
      db.disks.push_back(std::move(disk));
    }
    out.push_back(std::move(db));
  }
  return out;
}

void resolve_function_aliases(ExplorerFunctionsCatalog& catalog) {
  // Resolve the documented aliases before the catalog is sent to the browser. ClickHouse commonly documents aliases as `Alias of `target`.`.
  // Keep the chain bounded and cycle-safe. Malformed or custom documentation can then never cause unbounded recursion in the UI.
  auto lower = [](std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    return value;
  };
  auto alias_target = [](const std::string& description) -> std::string {
    const std::string marker = "Alias of `";
    const size_t begin = description.find(marker);
    if (begin == std::string::npos) return {};
    const size_t value_begin = begin + marker.size();
    const size_t value_end = description.find('`', value_begin);
    if (value_end == std::string::npos || value_end <= value_begin) return {};
    return description.substr(value_begin, value_end - value_begin);
  };
  auto& functions = catalog.functions;
  std::unordered_map<std::string, size_t> function_by_name;
  for (size_t i = 0; i < functions.size(); ++i) {
    const std::string key = lower(functions[i].name);
    // On a rare name collision, prefer scalar and aggregate functions over table functions.
    // Aliases in function documentation target callable names.
    if (!function_by_name.count(key) || functions[i].kind != "Table Function") function_by_name[key] = i;
  }
  constexpr size_t kMaxAliasDepth = 8;
  for (auto& item : functions) {
    std::unordered_set<std::string> visited;
    visited.insert(lower(item.name));
    std::string target = alias_target(item.description);
    for (size_t depth = 0; depth < kMaxAliasDepth && !target.empty(); ++depth) {
      const std::string key = lower(target);
      if (!visited.insert(key).second) break;
      const auto found = function_by_name.find(key);
      if (found == function_by_name.end()) break;
      const auto& aliased = functions[found->second];
      ExplorerFunctionAliasDocument resolved;
      resolved.name = aliased.name;
      resolved.description = aliased.description;
      resolved.syntax = aliased.syntax;
      resolved.arguments = aliased.arguments;
      resolved.parameters = aliased.parameters;
      resolved.returned_value = aliased.returned_value;
      resolved.examples = aliased.examples;
      resolved.introduced_in = aliased.introduced_in;
      item.alias_documents.push_back(std::move(resolved));
      target = alias_target(aliased.description);
    }
  }

  std::sort(functions.begin(), functions.end(), [](const auto& a, const auto& b) {
    if (a.kind != b.kind) return a.kind < b.kind;
    return a.name < b.name;
  });
}

}  // namespace explorer
}  // namespace chdash
