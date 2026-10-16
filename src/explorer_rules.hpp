#pragma once

// The decisions that the Explorer makes about the rows that it reads. They are pure functions.
// They decide the health of a table, the resident rows of a Buffer, and the disk of a data path.
// They also decide the storage map of a database, the sizes of a database and its disks, and the documented aliases of the functions.
// The readers (explorer_catalog.cpp, explorer_index.cpp, explorer_storage.cpp, explorer_functions.cpp) fetch the rows and call these.
// The native tests run them on rows that a test writes.

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
// These engines keep their bytes in memory: Buffer, Memory and Dictionary. Their size is resident, never disk.
bool is_resident_memory_engine(const std::string& engine);

// The result is "healthy", "warning" or "error". The warnings say why: a read-only replica, a long queue or delay, a replica that is not active,
// or a large number of active parts.
void classify_health(ExplorerTableSummary& table);

// `currentDatabase()` (in any case and spacing) names the database of the Buffer table itself. Any other text is the database name.
std::string resolve_buffer_database_arg(const std::string& arg, const std::string& source_database);

// The resident rows of a Buffer table. They come from the rows that system.tables reports for the Buffer and for its destination.
// The readable rows are the resident rows plus the rows of the destination. Both come from the same snapshot.
// So a flush race never looks like rows that appear or disappear. A Buffer whose figures cannot be reconciled has no rows. Its count is unknown, never zero.
void normalize_buffer_runtime_rows(std::vector<ExplorerTableSummary>& summaries);

// The disk that holds a data path: the one whose path is the longest prefix of it. A path that no disk holds gives "".
// `each(f)` calls f(disk name, disk path) for every disk.
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

// At most this many tables of a database are listed, the largest storing ones first.
// At most 100 siblings can each hold >= 1% of their parent. The treemap groups everything below 1% of the displayed root into "Others".
// The 128 largest are lossless for every treemap that the page can draw. The rest is reported as exact aggregate counters.
constexpr size_t kStorageTablesPerDatabase = 128;

// The storage of one database, from the parts and the tables that report each object of the runner's list.
// A table with no parts takes the size that system.tables reports. Its engine keeps no MergeTree parts.
// A resident table adds to resident_bytes and is not drawn. A table with no bytes is not listed.
ExplorerStorageDatabase storage_of_database(const std::string& database, const std::vector<std::string>& objects,
                                            const std::unordered_map<std::string, StoragePartTotals>& parts_by_table,
                                            const std::unordered_map<std::string, StorageTableMeta>& meta_by_table);

// ---- the sizes of the databases ----

struct DiskCapacity {
  std::string host, path, type;
  std::optional<uint64_t> free, total;
};

// The databases of the tables, with their object counts, rows, disk-backed bytes and the disks that their tables are on.
// Log-family tables have no parts. Their size adds to the disk that holds their data path, when one disk holds all of it.
std::vector<ExplorerDatabaseSummary> database_summaries_of(const std::vector<ExplorerTableSummary>& tables,
                                                           const std::map<std::string, DiskCapacity>& capacity,
                                                           std::map<std::pair<std::string, std::string>, uint64_t> bytes_by_disk);

// ---- the functions ----

// Resolves the aliases that the documentation names ("Alias of `target`.") into alias_documents.
// It follows a chain of at most 8 aliases and never follows a cycle. It then sorts the functions by kind and name.
void resolve_function_aliases(ExplorerFunctionsCatalog& catalog);

}  // namespace explorer
}  // namespace chdash
