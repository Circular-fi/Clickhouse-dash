#pragma once

// The rules of the library tree. They cover where a folder or a query is, and the depth of a folder.
// They also cover the names that are free in a folder. The top level of each host is its own.
// A name is compared without the case of ASCII letters.
//
// The rules also cover the reference of a body to a folder of the same host, and the key that an import compares.
// These are pure functions over a QueryLibraryState, with no file, no clock and no HTTP.

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

// Folders on the path from `id` up to the root, with `id` included. The id 0 means the root.
int folder_depth(const QueryLibraryState& s, const std::optional<std::string>& id);
// `id` and every folder below it, in breadth-first order, with their level. The level of `id` is 1.
std::vector<std::pair<std::string, int>> folder_subtree(const QueryLibraryState& s, const std::string& id);

// Sibling names are unique per host: the top level of each host is its own.
bool folder_name_taken(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& parent,
                       const std::string& name, const std::string* except_id);
bool query_name_taken(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& folder,
                      const std::string& name, const std::string* except_id);

// A folder reference of an item of `host` is null, for the top level, or a folder of the same host.
// It throws a LibraryError: 400 not_found, or 400 host_mismatch for a folder of another host.
std::optional<std::string> existing_folder_ref(const QueryLibraryState& s, const rapidjson::Value* v, const std::string& field,
                                               const std::string& host);
// Throws a LibraryError (400 depth) when `subtree_height` levels under `parent` are too deep.
void ensure_depth(const QueryLibraryState& s, const std::optional<std::string>& parent, int subtree_height, const std::string& field);

// The result is `name`, or `name (n)` for the first n that is free in the folder.
std::string unique_query_name(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& folder,
                              const std::string& name);
// The de-duplication key of an imported query is name and SQL. It ignores a " (n)" suffix that an earlier import added by a rename. So a re-import is a no-op.
std::string import_key(const std::string& name, const std::string& sql);

}  // namespace qlib
}  // namespace chdash
