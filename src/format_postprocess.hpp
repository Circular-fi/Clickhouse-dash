#pragma once

#include <cstddef>
#include <string>

namespace chdash {

std::string postprocess_format_query(const std::string& s, size_t threshold);

// ClickHouse's formatQuery writes every command of an ALTER TABLE as a parenthesized group
// ("ALTER TABLE t\n(\n    MODIFY COLUMN ...\n)", "ALTER TABLE t\n    (ADD COLUMN ...),\n    (DROP COLUMN ...)"):
// The grouped form is valid, but nobody writes it that way.
// unwrap_alter_table_commands returns the statement with its commands written plainly.
// It puts one command on each line, at the left edge (like the clauses of a SELECT). It separates the commands by commas.
// A statement that does not have exactly that shape is returned unchanged.
std::string unwrap_alter_table_commands(std::string formatted);

} // namespace chdash
