#pragma once

// The query library holds these items in memory (docs/query-library.md): the folders and the saved queries of every host, and their limits.
// It also holds the migration that the load of an older file reports. This header has no behavior.
// The file format is in query_library_file.hpp. The rules are in query_library_rules.hpp. The store is query_library.hpp.

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

// Limits that are not configurable.
inline constexpr int kQueryLibraryMaxFolderDepth = 8;
inline constexpr size_t kQueryLibraryMaxFolders = 10000;
inline constexpr size_t kQueryLibraryMaxQueries = 100000;
inline constexpr size_t kQueryLibraryMaxNameBytes = 256;
inline constexpr size_t kQueryLibraryMaxDescriptionBytes = 16 * 1024;
inline constexpr size_t kQueryLibraryMaxHostIdBytes = 256;
inline constexpr size_t kQueryLibraryMaxIdBytes = 128;
// Version of the persisted file. Version 1 has no host on folders. It is migrated
// on load. See parse_query_library_file.
inline constexpr int kQueryLibraryFileVersion = 2;

struct QueryLibraryFolder {
  std::string id;
  std::string host_id;
  std::optional<std::string> parent_id;
  std::string name;
  int64_t created_at_ms = 0;
  int64_t updated_at_ms = 0;
};

struct QueryLibraryQuery {
  std::string id;
  std::optional<std::string> folder_id;
  std::string name;
  std::string description;
  std::string sql;
  std::string host_id;
  int64_t created_at_ms = 0;
  int64_t updated_at_ms = 0;
};

struct QueryLibraryState {
  // Library revision. Each folder or query change increments it.
  // An external edit of the file increments it too.
  int64_t revision = 0;
  int64_t updated_at_ms = 0;
  std::vector<QueryLibraryFolder> folders;
  std::vector<QueryLibraryQuery> queries;
};

// What the file load changed. A version-1 file has entries without a host (folders, queries). Those entries are dropped.
// The history of a file from an earlier release is no longer kept. dropped_history counts its entries.
// A query or folder whose folder was dropped moves to the top level of its host.
struct QueryLibraryMigration {
  int from_version = kQueryLibraryFileVersion;
  size_t dropped_folders = 0;
  size_t dropped_queries = 0;
  size_t dropped_history = 0;
  size_t rerooted = 0;
  bool changed() const {
    return from_version != kQueryLibraryFileVersion || dropped_folders || dropped_queries || dropped_history || rerooted;
  }
};

} // namespace chdash
