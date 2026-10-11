#pragma once

// The import of the query library (docs/query-library.md, "Import"): the payload of the browser's own library, or a copy of one folder,
// merged into the library of one host. The rules are the ones of the tree (query_library_rules.hpp); the function changes the candidate
// state that it is given and writes nothing else, so the store commits it or drops it as a whole.
//
// Every imported folder and query belongs to the host of the request, whatever the payload says. Folders are merged by name under the same
// parent; queries are de-duplicated by name + SQL against the host's library and within the payload; a remaining name clash in the target
// folder gets a " (n)" suffix. "copy": true is a copy, not an import (the browser moving a folder from its own storage into the server
// library): nothing is merged, skipped or renamed; a folder whose name its target parent already holds is a 400 duplicate and nothing is
// written.

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
  // The id that the payload gave to a folder and the id that it has in the library, in the order of the payload (a folder that the
  // payload gave no id is not listed).
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
