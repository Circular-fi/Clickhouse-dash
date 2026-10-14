#pragma once

// What the library answers when it is read (docs/query-library.md, "REST API"): a bounded page of the tree with the minimal data of each
// item, the whole of one query, a search, and the export of a host (or of one folder). Pure functions over a QueryLibraryState: no file, no
// clock, no HTTP. The page is what the Query page loads: never more than kLibraryPageMax items, and no SQL.

#include "query_library_state.hpp"

#include <cstddef>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace qlib {

inline constexpr size_t kLibraryPageMax = 100;
inline constexpr size_t kLibrarySearchMax = 100;

// The children of one folder (or of the top level of a host), as many levels deep as fit in `limit` items:
// - the first level is the children of the parent (folders first, then queries, each by name);
// - a deeper level is added while the items stay within `limit` (a folder whose children came with it is `loaded`), so that a small library
//   comes whole in one answer and a large one comes as its upper levels;
// - a first level that alone is larger than `limit` comes in pages: `cursor` is the offset in it, `next_cursor` the offset of the next page.
struct LibraryPage {
  std::vector<const QueryLibraryFolder*> folders;
  std::vector<const QueryLibraryQuery*> queries;
  // The ids of the folders of the page whose children are in the page too.
  std::unordered_set<std::string> loaded;
  // For each folder of the page: the queries under it (subfolders included) and its direct children.
  std::unordered_map<std::string, size_t> query_count;
  std::unordered_map<std::string, size_t> child_count;
  // ... and the folders directly under it (what makes a folder one that can be opened to more folders).
  std::unordered_map<std::string, size_t> subfolder_count;
  int depth = 0;  // levels below the first one that came with it
  size_t level_total = 0;  // the children of the parent
  std::optional<size_t> next_cursor;
  // Nothing is left to load: every folder of the page is loaded and the first level is whole.
  bool complete = false;
  // The host's whole library, for the count shown by the page.
  size_t host_folders = 0;
  size_t host_queries = 0;
  // The queries under the parent (or under the top level): the whole library for the top level.
  size_t parent_queries = 0;
};

LibraryPage library_page(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& parent, size_t cursor,
                         size_t limit);

// The queries of `host` whose name, description, SQL or folder path holds every term (lower case), by name. `total` counts them all.
struct LibraryHit {
  const QueryLibraryQuery* query = nullptr;
  std::string path;  // "/Operations/Merges"; "/" for the top level
};
std::vector<LibraryHit> library_search(const QueryLibraryState& s, const std::string& host, const std::vector<std::string>& terms, size_t limit,
                                       size_t* total);

// The path of folder ids from the top level to `folder` (excluded), for a query that has to be shown in its place.
std::vector<std::string> folder_ancestors(const QueryLibraryState& s, const std::optional<std::string>& folder);
std::string folder_path_text(const QueryLibraryState& s, const std::optional<std::string>& folder);

}  // namespace qlib
}  // namespace chdash
