#pragma once

// The persisted file of the query library (docs/query-library.md, "File format"). It has the JSON document, its migration from version 1,
// and the atomic replacement of the file. The header has no state. The store (query_library.hpp) owns the file.

#include "query_library_state.hpp"

#include <string>
#include <string_view>

namespace chdash {

// Parse and validate the persisted JSON document (version 1 or 2). This function applies
// the migration (QueryLibraryMigration). It throws std::runtime_error. Its message never
// contains file content.
QueryLibraryState parse_query_library_file(std::string_view text, QueryLibraryMigration* migration = nullptr);

// Serialize the persisted JSON document (version 2).
std::string serialize_query_library_file(const QueryLibraryState& state);

// Atomic replacement. It writes a temporary file in the directory of the target, with
// mode 0600 (O_EXCL, no symlink follow). It runs fsync on the file, and it renames the file over `path`.
// Then it runs fsync on the directory. It removes the temporary file on failure.
bool atomic_write_file(const std::string& path, std::string_view data, std::string* error);

} // namespace chdash
