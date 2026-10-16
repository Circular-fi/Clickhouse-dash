#pragma once

// The library answers these reads (docs/query-library.md, "REST API"): a bounded page of the tree, the minimal data of each item,
// the whole of one query, a search, and the export of a host or of one folder. These are pure functions over a QueryLibraryState.
// They use no file, no clock and no HTTP. The page is what the Query page loads. It holds at most kLibraryPageMax items and no SQL.

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

// The children of one folder, or of the top level of a host. The result has as many levels as fit in `limit` items:
// - the first level is the children of the parent (folders first, then queries, each by name);
// - a deeper level is added while the items stay within `limit`. A folder whose children came with it is `loaded`. So a small library
//   comes whole in one answer. A large library comes as its upper levels;
// - a first level that alone is larger than `limit` comes in pages. `cursor` is the offset in it. `next_cursor` is the offset of the next page.
struct LibraryPage {
  std::vector<const QueryLibraryFolder*> folders;
  std::vector<const QueryLibraryQuery*> queries;
  // The ids of the folders of the page whose children are also in the page.
  std::unordered_set<std::string> loaded;
  // For each folder of the page: the queries under it, subfolders included, and its direct children.
  std::unordered_map<std::string, size_t> query_count;
  std::unordered_map<std::string, size_t> child_count;
  // ... and the folders directly under it. A folder with subfolders can be opened to more folders.
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

// The queries of `host` whose name, description, SQL or folder path hold every term. The terms are in lower case. The result is ordered by name. `total` counts them all.
struct LibraryHit {
  const QueryLibraryQuery* query = nullptr;
  std::string path;  // "/Operations/Merges"; "/" for the top level
};
std::vector<LibraryHit> library_search(const QueryLibraryState& s, const std::string& host, const std::vector<std::string>& terms, size_t limit,
                                       size_t* total);

// The path of folder ids from the top level down to `folder`, which is not in the path. The path is used to show a query in its place.
std::vector<std::string> folder_ancestors(const QueryLibraryState& s, const std::optional<std::string>& folder);
std::string folder_path_text(const QueryLibraryState& s, const std::optional<std::string>& folder);

}  // namespace qlib
}  // namespace chdash
