#pragma once

#include <cstddef>
#include <string>

namespace chdash {

std::string postprocess_format_query(std::string s, size_t threshold);

// ClickHouse's formatQuery writes every command of an ALTER TABLE as a parenthesised group
// ("ALTER TABLE t\n(\n    MODIFY COLUMN ...\n)", "ALTER TABLE t\n    (ADD COLUMN ...),\n    (DROP COLUMN ...)"):
// valid, but not how anyone writes one. Returns the statement with its commands written plainly, one
// per line at the left edge (like the clauses of a SELECT), separated by commas; anything that is not exactly that shape comes back
// unchanged.
std::string unwrap_alter_table_commands(std::string formatted);

} // namespace chdash
