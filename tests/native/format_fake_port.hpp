#pragma once

// A fake ClickHouse for the formatter (src/format_service.hpp): formatQuery answers the text that it got, and EXPLAIN AST the tokens of the
// text (no comment, no parenthesis, no case, no backtick), so two layouts of one statement have one tree and a statement that was corrupted
// has another. Shared by tests/native/format_test.cpp and the fuzz target tests/fuzz/fuzz_format.cpp.

#include "format_service.hpp"
#include "sql_lexer.hpp"

#include <cctype>
#include <string>
#include <vector>

namespace chdash {

// The tokens of a text that give its meaning in the fake: no blank, no comment, words in lower case, a name between backticks as the name,
// and no parenthesis (formatQuery of ClickHouse prints the parentheses of the text and EXPLAIN AST does not show them).
inline std::string fake_tree(const std::string& sql) {
  std::string out;
  const auto tokens = sql::lex(sql);
  for (size_t i = 0; i < tokens.size(); ++i) {
    const sql::Token& token = tokens[i];
    if (sql::is_trivia(token.kind)) continue;
    std::string text(token.text(sql));
    if (text == "(" || text == ")") continue;
    // A comma before the closing parenthesis of a list is no element: ClickHouse takes `(a UInt8,)` as `(a UInt8)`.
    if (text == ",") {
      size_t next = i + 1;
      while (next < tokens.size() && sql::is_trivia(tokens[next].kind)) ++next;
      if (next < tokens.size() && tokens[next].text(sql) == ")") continue;
    }
    if (text.size() >= 2 && text.front() == '`' && text.back() == '`') text = text.substr(1, text.size() - 2);
    for (char& c : text) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    out += text + "\n";
  }
  return out;
}

class FakePort : public FormatQueryPort {
public:
  std::vector<std::string> format_calls, ast_calls;
  // What each call answers: nothing set, the text (formatQuery) or its tokens (EXPLAIN AST).
  FormatQueryFailureKind format_fails = FormatQueryFailureKind::none;
  std::string format_error = "Syntax error";
  FormatQueryFailureKind ast_fails = FormatQueryFailureKind::none;
  // Fails (as a syntax error) the EXPLAIN AST of a text that holds this word.
  std::string ast_refuses;
  // An error of ClickHouse at the first place of the sent text where this marker is (the text of formatQuery fails with it).
  std::string error_marker;

  FormatQueryResult format_query(const std::string& sql, size_t) override {
    format_calls.push_back(sql);
    FormatQueryResult result;
    if (!error_marker.empty()) {
      if (const size_t at = sql.find(error_marker); at != std::string::npos) {
        result.failure = FormatQueryFailureKind::server;
        result.message = "Code: 62. DB::Exception: Syntax error: failed at position " + std::to_string(at + 1) + " ('" + error_marker +
                         "') (line 1, col " + std::to_string(at + 1) + "): " + error_marker + ". Expected one of: token";
        return result;
      }
    }
    if (format_fails != FormatQueryFailureKind::none) {
      result.failure = format_fails;
      result.message = format_error;
      return result;
    }
    result.formatted_sql = sql;
    return result;
  }

  FormatQueryResult explain_ast(const std::string& sql, size_t) override {
    ast_calls.push_back(sql);
    FormatQueryResult result;
    if (ast_fails != FormatQueryFailureKind::none || (!ast_refuses.empty() && sql.find(ast_refuses) != std::string::npos)) {
      result.failure = ast_fails != FormatQueryFailureKind::none ? ast_fails : FormatQueryFailureKind::server;
      result.message = "Syntax error";
      return result;
    }
    result.formatted_sql = fake_tree(sql);
    return result;
  }
};

}  // namespace chdash
