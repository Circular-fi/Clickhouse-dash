#include "user_sql_policy.hpp"

#include "sql_lexer.hpp"

#include <initializer_list>
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

std::string upper_word(std::string_view sql, const sql::Token& token) {
  std::string out(sql.substr(token.begin, token.end - token.begin));
  for (char& c : out) {
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  }
  return out;
}

bool one_of(const std::string& word, std::initializer_list<const char*> list) {
  for (const char* item : list) {
    if (word == item) return true;
  }
  return false;
}

// The class of one statement: `first` and `last` bound its tokens (the end is not included).
SqlStatementClass class_of_statement(std::string_view sql, const std::vector<sql::Token>& tokens, size_t first, size_t last) {
  // Open parentheses can start a statement: (SELECT 1) UNION ALL (SELECT 2).
  size_t at = first;
  while (at < last && (sql::is_trivia(tokens[at].kind) || (tokens[at].kind == sql::TokenKind::Punct && sql[tokens[at].begin] == '('))) ++at;
  if (at >= last || tokens[at].kind != sql::TokenKind::Word) return SqlStatementClass::Unsure;
  const std::string word = upper_word(sql, tokens[at]);
  if (one_of(word, {"SELECT", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN", "CHECK"})) return SqlStatementClass::Read;
  if (one_of(word, {"INSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME", "OPTIMIZE", "SYSTEM", "KILL", "GRANT", "REVOKE", "ATTACH", "DETACH",
                    "SET", "USE", "BACKUP", "RESTORE", "EXCHANGE", "UNDROP", "MOVE", "DELETE", "UPDATE", "REPLACE", "LOAD", "UNLOAD", "COMMIT",
                    "ROLLBACK", "BEGIN", "WAIT"})) {
    return SqlStatementClass::Write;
  }
  if (word == "WITH") {
    // WITH ... SELECT reads. WITH ... INSERT writes. Only the words outside every parenthesis are the words of the statement.
    int depth = 0;
    bool select = false;
    for (size_t i = at + 1; i < last; ++i) {
      const sql::Token& token = tokens[i];
      if (token.kind == sql::TokenKind::Punct) {
        const char c = sql[token.begin];
        if (c == '(') ++depth;
        else if (c == ')' && depth > 0) --depth;
        continue;
      }
      if (depth != 0 || token.kind != sql::TokenKind::Word) continue;
      const std::string inner = upper_word(sql, token);
      if (inner == "INSERT") return SqlStatementClass::Write;
      if (inner == "SELECT") select = true;
    }
    return select ? SqlStatementClass::Read : SqlStatementClass::Unsure;
  }
  return SqlStatementClass::Unsure;
}

} // namespace

SqlStatementClass sql_statement_class(std::string_view sql) {
  const std::vector<sql::Token> tokens = sql::lex(sql);
  bool any = false;
  bool unsure = false;
  size_t first = 0;
  const auto flush = [&](size_t last) {
    bool has_code = false;
    for (size_t i = first; i < last; ++i) has_code = has_code || !sql::is_trivia(tokens[i].kind);
    if (!has_code) return SqlStatementClass::Read;  // an empty statement between two semicolons: nothing runs
    any = true;
    return class_of_statement(sql, tokens, first, last);
  };
  for (size_t i = 0; i < tokens.size(); ++i) {
    if (tokens[i].kind != sql::TokenKind::Punct || sql[tokens[i].begin] != ';') continue;
    const SqlStatementClass found = flush(i);
    if (found == SqlStatementClass::Write) return SqlStatementClass::Write;
    unsure = unsure || found == SqlStatementClass::Unsure;
    first = i + 1;
  }
  const SqlStatementClass found = flush(tokens.size());
  if (found == SqlStatementClass::Write) return SqlStatementClass::Write;
  unsure = unsure || found == SqlStatementClass::Unsure;
  return any && !unsure ? SqlStatementClass::Read : SqlStatementClass::Unsure;
}

SqlStatementClass sql_statements_class(const std::vector<std::string>& texts) {
  bool unsure = texts.empty();
  for (const std::string& text : texts) {
    const SqlStatementClass found = sql_statement_class(text);
    if (found == SqlStatementClass::Write) return SqlStatementClass::Write;
    unsure = unsure || found == SqlStatementClass::Unsure;
  }
  return unsure ? SqlStatementClass::Unsure : SqlStatementClass::Read;
}

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
