#pragma once

// The structure of a statement that ClickHouse wrote (the CREATE of a view, the engine of a table, the TTL
// of a table): the words at the top level, the names, the arguments, the sources of a SELECT. Everything is read from the
// tokens of the one lexer (sql_lexer.hpp), so a keyword in a text, a comment or a quoted name is never found, and
// the brackets nest the way the server counts them. The Explorer catalog and the Explorer graph both read through this
// file.

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace sql {

struct QualifiedName {
  std::string database;
  std::string table;
};

// The position of `keyword` (one word, or several: "TO VOLUME") in `text` from `start`, case blind, outside every
// bracket, comment, text and quoted name; nullopt when it is not there.
std::optional<size_t> find_keyword(std::string_view text, std::string_view keyword, size_t start = 0);

// The parts of `text` between the delimiters that stand outside every bracket, comment, text and quoted name. A part is
// trimmed; an empty one is dropped.
std::vector<std::string> split_top_level(std::string_view text, char delimiter = ',');

// The position of the last `mark` before `before` that stands outside every bracket and text.
std::optional<size_t> find_last_top_level(std::string_view text, char mark, size_t before);

// `text` with every run of blanks outside a text and a quoted name written as one space, and trimmed.
std::string compact_spaces(std::string_view text);

// A name (bare or quoted, decoded) at `pos` after the blanks; `pos` moves after it.
std::optional<std::string> parse_identifier(std::string_view text, size_t& pos);

// `name` or `database.name` at `pos`; the first form takes `default_database`.
std::optional<QualifiedName> parse_qualified_name(std::string_view text, size_t& pos, const std::string& default_database);

// The arguments of `engine_name(a, b, ...)` at the start of `engine_full` (the engine_full of system.tables), as
// text: the quote marks of a text or a name are cut ('db' is db), the rest is as written. Empty when the engine is
// another one.
std::vector<std::string> engine_arguments(std::string_view engine_full, std::string_view engine_name);

// The tables that a SELECT reads: the names after FROM and JOIN, at every depth (a subquery, an IN (SELECT ...)). A table
// function (`numbers(10)`), `ARRAY JOIN`, the name of a CTE and a subquery are not tables. Each table is once, in
// the order of the text.
std::vector<QualifiedName> relation_sources(std::string_view select_sql, const std::string& default_database);

// The `TO [db.]table` of `CREATE MATERIALIZED VIEW name [ON CLUSTER c] [REFRESH ...] TO target AS SELECT`. A view
// with its own ENGINE has no TO target; a `TO VOLUME 'x'` / `TO DISK 'x'` of its TTL is not one, nor a `WITH FILL ... TO n`.
std::optional<QualifiedName> materialized_view_target(std::string_view create_sql, const std::string& default_database);

// The TTL clause of a CREATE TABLE: the text between the TTL that follows ENGINE and the next SETTINGS or COMMENT. A TTL
// of a column is inside the brackets and is not read.
std::string table_ttl_clause(std::string_view create_sql);

// The text inside the brackets that follow the keyword `keyword` at the top level (`LIFETIME(MIN 0 MAX 300)` gives
// `MIN 0 MAX 300`), compacted; nullopt when there are none or the bracket is not closed.
std::optional<std::string> clause_arguments(std::string_view text, std::string_view keyword);

} // namespace sql
} // namespace chdash
