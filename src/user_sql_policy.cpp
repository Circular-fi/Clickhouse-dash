#include "user_sql_policy.hpp"

#include "sql_lexer.hpp"

#include <string>

namespace chdash {
namespace {

bool word_is(std::string_view sql, const sql::Token& token, std::string_view upper) {
  if (token.kind != sql::TokenKind::Word || token.end - token.begin != upper.size()) return false;
  for (size_t i = 0; i < upper.size(); ++i) {
    char c = sql[token.begin + i];
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    if (c != upper[i]) return false;
  }
  return true;
}

} // namespace

// The statements are cut at the semicolons of the code (a semicolon in a text, a name or a comment does not count),
// and the first two words of each one are compared. The lexer is the one of ClickHouse (sql_lexer.hpp): the blanks
// between the words may be Unicode spaces, comments, and nested block comments.
bool user_sql_is_forbidden(std::string_view sql) {
  const std::vector<sql::Token> tokens = sql::lex(sql);
  bool statement_start = true;
  for (size_t i = 0; i < tokens.size(); ++i) {
    const sql::Token& token = tokens[i];
    if (sql::is_trivia(token.kind)) continue;
    if (token.kind == sql::TokenKind::Punct && sql[token.begin] == ';') {
      statement_start = true;
      continue;
    }
    if (!statement_start) continue;
    statement_start = false;
    if (!word_is(sql, token, "KILL")) continue;
    size_t next = i + 1;
    while (next < tokens.size() && sql::is_trivia(tokens[next].kind)) ++next;
    if (next < tokens.size() && word_is(sql, tokens[next], "QUERY")) return true;
  }
  return false;
}

} // namespace chdash
