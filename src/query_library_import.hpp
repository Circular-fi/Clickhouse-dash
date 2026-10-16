#pragma once

// The import of the query library (docs/query-library.md, "Import"). It merges the payload of the browser's own library, or a copy of one folder,
// into the library of one host. The rules are the rules of the tree (query_library_rules.hpp). The function changes only the candidate
// state that it is given. It writes nothing else, so the store commits the state as a whole or drops it.
//
// Every imported folder and query belongs to the host of the request. The payload cannot change this host.
// Folders are merged by name under the same parent. Queries are de-duplicated by name and SQL against the library of the host and within the payload.
// A name clash that remains in the target folder gets a " (n)" suffix.
//
// "copy": true makes a copy, not an import. The browser uses it to move a folder from its own storage into the server library.
// Nothing is merged, skipped or renamed. A folder whose name its target parent already holds is a 400 duplicate.
// Then nothing is written.

#include "query_library_state.hpp"

#include <rapidjson/document.h>

#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace chdash {
namespace qlib {

struct ImportOutcome {
  size_t imported_folders = 0;
  size_t merged_folders = 0;
  size_t imported_queries = 0;
  size_t skipped_queries = 0;
  // The id that the payload gave to a folder, and the id that the folder has in the library. The list follows the order of the payload.
  // A folder that the payload gave no id is not listed.
  std::vector<std::pair<std::string, std::string>> folder_ids;
  bool changed() const { return imported_folders > 0 || imported_queries > 0; }
};

// A new id for a folder ('f') or a query ('q') that no item of the state has.
using NewId = std::function<std::string(char prefix, const QueryLibraryState& state)>;

// Throws a LibraryError (query_library_request.hpp) for a payload that is refused.
ImportOutcome import_into(QueryLibraryState& candidate, const rapidjson::Document& doc, const std::string& host, size_t max_query_bytes,
                          const NewId& new_id, int64_t now);

}  // namespace qlib
}  // namespace chdash
