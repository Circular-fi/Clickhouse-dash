#pragma once

// The TTL clause of a table, read for the Explorer graph.
// There is one rule for each top-level comma. Each rule has an action (delete, move, recompress, group by), a target, and the interval that it adds to its base expression.
// The words are found in the tokens of the one SQL lexer (sql_structure.hpp). So a TTL in a comment or in a text is never read.

#include <string>
#include <string_view>
#include <vector>

namespace chdash {

struct ExplorerGraphTtlRule {
  std::string expression;
  std::string base_expression;
  std::string offset_label;
  std::string action;      // recompress | move | delete | group_by | ttl
  std::string target_kind; // codec | volume | disk | expression
  std::string target;
};

// The rules of the table-level TTL of a CREATE TABLE. The TTL of a column is inside the brackets and is not read.
// A bare expression is a DELETE. The texts are cut at a character boundary (180, 96 and 128 bytes).
std::vector<ExplorerGraphTtlRule> parse_table_ttl_rules(std::string_view ddl);

}  // namespace chdash
