#pragma once

// The rules of the library tree: where a folder or a query is, the depth of a folder, the names that are free in a folder (the top level of
// each host is its own, and a name is compared without the case of ASCII letters), the reference of a body to a folder of the same host, and
// the key that an import compares. Pure functions over a QueryLibraryState: no file, no clock, no HTTP.

#include "query_library_state.hpp"

#include <rapidjson/document.h>

#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace chdash {
namespace qlib {

const QueryLibraryFolder* find_folder(const QueryLibraryState& s, const std::string& id);
QueryLibraryFolder* find_folder(QueryLibraryState& s, const std::string& id);
QueryLibraryQuery* find_query(QueryLibraryState& s, const std::string& id);

// Folders on the path from `id` up to the root, `id` included (0 for root).
int folder_depth(const QueryLibraryState& s, const std::optional<std::string>& id);
// `id` and every folder below it, breadth first, with their level (1 = id).
std::vector<std::pair<std::string, int>> folder_subtree(const QueryLibraryState& s, const std::string& id);

// Sibling names are unique per host: the top level of each host is its own.
bool folder_name_taken(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& parent,
                       const std::string& name, const std::string* except_id);
bool query_name_taken(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& folder,
                      const std::string& name, const std::string* except_id);

// A folder reference of an item of `host`: null (the top level) or a folder of the same host. Throws a LibraryError: 400 not_found, or
// 400 host_mismatch for a folder of another host.
std::optional<std::string> existing_folder_ref(const QueryLibraryState& s, const rapidjson::Value* v, const std::string& field,
                                               const std::string& host);
// Throws a LibraryError (400 depth) when `subtree_height` levels under `parent` are too deep.
void ensure_depth(const QueryLibraryState& s, const std::optional<std::string>& parent, int subtree_height, const std::string& field);

// `name`, or `name (n)` for the first n that is free in the folder.
std::string unique_query_name(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& folder,
                              const std::string& name);
// De-duplication key of an imported query: name + SQL, ignoring a " (n)" suffix added by an earlier import's rename, so re-importing is a no-op.
std::string import_key(const std::string& name, const std::string& sql);

}  // namespace qlib
}  // namespace chdash
