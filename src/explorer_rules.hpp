#pragma once

// What the Explorer decides about the rows that it read, as pure functions: the health of a table, the resident rows of a Buffer, the disk of
// a data path, the storage map of a database, the sizes of a database and its disks, and the documented aliases of the functions. The readers
// (explorer_catalog.cpp, explorer_index.cpp, explorer_storage.cpp, explorer_functions.cpp) fetch the rows and call these; the native tests
// run them on rows that a test writes.

#include "explorer_catalog.hpp"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {
namespace explorer {

bool is_log_family(const std::string& engine);
// Engines whose bytes are in memory: Buffer, Memory, Dictionary. Their size is resident, never disk.
bool is_resident_memory_engine(const std::string& engine);

// "healthy", "warning" or "error", and the warnings that say why: a read-only replica, a long queue or delay, a replica that is not active,
// and a large number of active parts.
void classify_health(ExplorerTableSummary& table);

// `currentDatabase()` (in any case and spacing) is the database of the Buffer table itself; any other text is the database.
std::string resolve_buffer_database_arg(const std::string& arg, const std::string& source_database);

// The rows of a Buffer table that are resident, from the rows that system.tables reports for it and for its destination: the readable rows
// are the resident rows plus the rows of the destination. Both come from the same snapshot, so a flush race is never read as rows that appear
// or disappear. A Buffer whose figures cannot be reconciled has no rows (unknown, never zero).
void normalize_buffer_runtime_rows(std::vector<ExplorerTableSummary>& summaries);

// The disk that holds a data path: the one whose path is the longest prefix of it (a path that no disk holds gives ""). `each(f)` calls
// f(disk name, disk path) for every disk.
template <typename Each>
std::string disk_of_path(const std::string& data_path, Each&& each) {
  std::string best;
  size_t best_prefix = 0;
  each([&](const std::string& name, const std::string& path) {
    if (path.empty() || data_path.rfind(path, 0) != 0 || path.size() <= best_prefix) return;
    best = name;
    best_prefix = path.size();
  });
  return best;
}

// ---- the storage map ----

struct StoragePartTotals {
  uint64_t rows = 0, bytes = 0, parts = 0;
};
struct StorageTableMeta {
  std::string engine;
  std::optional<uint64_t> rows, bytes;
};

// At most this many tables of a database are listed (the largest storing ones). At most 100 siblings can each hold >= 1% of their parent,
// and the treemap groups everything below 1% of the displayed root into "Others": the 128 largest are lossless for every treemap that the
// page can draw, and the rest is reported as exact aggregate counters.
constexpr size_t kStorageTablesPerDatabase = 128;

// The storage of one database from what the parts and the tables report for each object of the runner's list. A table with no parts takes
// the size that system.tables reports (its engine keeps no MergeTree parts); a resident table adds to resident_bytes and is not drawn; a table
// with no bytes is not listed.
ExplorerStorageDatabase storage_of_database(const std::string& database, const std::vector<std::string>& objects,
                                            const std::unordered_map<std::string, StoragePartTotals>& parts_by_table,
                                            const std::unordered_map<std::string, StorageTableMeta>& meta_by_table);

// ---- the sizes of the databases ----

struct DiskCapacity {
  std::string host, path, type;
  std::optional<uint64_t> free, total;
};

// The databases of the tables with their object counts, rows, disk-backed bytes, and the disks that their tables are on. Log-family tables
// have no parts: their size is added to the disk that their data path is on, when one disk holds all of it.
std::vector<ExplorerDatabaseSummary> database_summaries_of(const std::vector<ExplorerTableSummary>& tables,
                                                           const std::map<std::string, DiskCapacity>& capacity,
                                                           std::map<std::pair<std::string, std::string>, uint64_t> bytes_by_disk);

// ---- the functions ----

// Resolves the aliases that the documentation names ("Alias of `target`.") into alias_documents, along a chain of at most 8 that never
// follows a cycle, and sorts the functions by kind and name.
void resolve_function_aliases(ExplorerFunctionsCatalog& catalog);

}  // namespace explorer
}  // namespace chdash
