#pragma once

// This file reads the structure of a statement that ClickHouse wrote.
// Examples are the CREATE of a view, the engine of a table and the TTL of a table.
// The file reads these parts: the top-level words, the names, the arguments and the sources of a SELECT.
//
// It takes all data from the tokens of the one lexer (sql_lexer.hpp).
// So, a keyword in a text, a comment or a quoted name is never found.
// The brackets nest in the same way as the server counts them.
// The Explorer catalog and the Explorer graph both use this file.

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

// The function gives the position of `keyword` in `text`, from `start`.
// The keyword has one word or several words, for example "TO VOLUME".
// The search ignores upper and lower case.
// It skips every bracket, comment, text and quoted name.
// The result is nullopt when the keyword is not in the text.
std::optional<size_t> find_keyword(std::string_view text, std::string_view keyword, size_t start = 0);

// The function gives the parts of `text` between the delimiters.
// It takes only the delimiters that stand outside every bracket, comment, text and quoted name.
// The function trims each part.
// It drops each empty part.
std::vector<std::string> split_top_level(std::string_view text, char delimiter = ',');

// The function gives the position of the last `mark` before `before`.
// It takes only a mark that stands outside every bracket and text.
std::optional<size_t> find_last_top_level(std::string_view text, char mark, size_t before);

// The function gives `text` with each run of blanks written as one space.
// The blanks inside a text or a quoted name stay as they are.
// The function also trims the result.
std::string compact_spaces(std::string_view text);

// The function reads a name at `pos`, after the blanks.
// The name can be bare or quoted. The function decodes it.
// Then `pos` moves to the position after the name.
std::optional<std::string> parse_identifier(std::string_view text, size_t& pos);

// The function reads `name` or `database.name` at `pos`.
// For the first form, the database is `default_database`.
std::optional<QualifiedName> parse_qualified_name(std::string_view text, size_t& pos, const std::string& default_database);

// The function gives the arguments of `engine_name(a, b, ...)`, at the start of `engine_full`.
// The `engine_full` value comes from system.tables. The function returns the arguments as text.
// It cuts the quote marks of a text or a name: 'db' gives db.
// The rest of each argument stays as written.
// The result is empty when the engine is another one.
std::vector<std::string> engine_arguments(std::string_view engine_full, std::string_view engine_name);

// The function gives the tables that a SELECT reads.
// It takes the names after FROM and JOIN, at every depth, for example in a subquery or in an IN (SELECT ...).
// It does not count as tables: a table function (`numbers(10)`), `ARRAY JOIN`, the name of a CTE and a subquery.
// Each table appears once, in the order of the text.
std::vector<QualifiedName> relation_sources(std::string_view select_sql, const std::string& default_database);

// The function gives the `TO [db.]table` target of a materialized view.
// The statement form is `CREATE MATERIALIZED VIEW name [ON CLUSTER c] [REFRESH ...] TO target AS SELECT`.
// A view with its own ENGINE has no TO target.
// A `TO VOLUME 'x'` or `TO DISK 'x'` in its TTL is not a TO target.
// A `WITH FILL ... TO n` is not a TO target either.
std::optional<QualifiedName> materialized_view_target(std::string_view create_sql, const std::string& default_database);

// The function gives the TTL clause of a CREATE TABLE.
// The clause is the text between the TTL that follows ENGINE and the next SETTINGS or COMMENT.
// A TTL of a column stands inside the brackets. The function does not read it.
std::string table_ttl_clause(std::string_view create_sql);

// The function gives the text inside the brackets that follow `keyword` at the top level.
// For example, `LIFETIME(MIN 0 MAX 300)` gives `MIN 0 MAX 300`.
// The function compacts the text.
// The result is nullopt when there are no brackets or the bracket is not closed.
std::optional<std::string> clause_arguments(std::string_view text, std::string_view keyword);

} // namespace sql
} // namespace chdash
