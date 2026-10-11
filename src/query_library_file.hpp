#pragma once

// The persisted file of the query library (docs/query-library.md, "File format"): the JSON document, its migration from version 1, and the
// atomic replacement of the file. No state: the store (query_library.hpp) owns it.

#include "query_library_state.hpp"

#include <string>
#include <string_view>

namespace chdash {

// Parse and validate the persisted JSON document (version 1 or 2), applying
// the migration (QueryLibraryMigration). Throws std::runtime_error with a message that never
// contains file content.
QueryLibraryState parse_query_library_file(std::string_view text, QueryLibraryMigration* migration = nullptr);

// Serialize the persisted JSON document (version 2).
std::string serialize_query_library_file(const QueryLibraryState& state);

// Atomic replacement: write a temporary file in the target's directory with
// mode 0600 (O_EXCL, no symlink follow), fsync it, rename it over `path`,
// then fsync the directory. The temporary file is removed on failure.
bool atomic_write_file(const std::string& path, std::string_view data, std::string* error);

} // namespace chdash
