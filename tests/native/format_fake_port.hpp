#pragma once

// A fake ClickHouse for the formatter (src/format_service.hpp). formatQuery returns the text that it gets.
// EXPLAIN AST returns the tokens of the text. The tokens have no comment, no parenthesis, no case and no backtick.
// So two layouts of one statement have one tree. A corrupted statement has another tree.
// The file tests/native/format_test.cpp and the fuzz target tests/fuzz/fuzz_format.cpp share this file.

#include "format_service.hpp"
#include "sql_lexer.hpp"

#include <cctype>
#include <string>
#include <vector>

namespace chdash {

// The fake takes these tokens from a text as its meaning: no blank, no comment, and words in lower case.
// A name between backticks is taken as the name.
// The fake takes no parenthesis. The formatQuery of ClickHouse prints the parentheses of the text, but EXPLAIN AST does not show them.
inline std::string fake_tree(const std::string& sql) {
  std::string out;
  const auto tokens = sql::lex(sql);
  for (size_t i = 0; i < tokens.size(); ++i) {
    const sql::Token& token = tokens[i];
    if (sql::is_trivia(token.kind)) continue;
    std::string text(token.text(sql));
    if (text == "(" || text == ")") continue;
    // A comma before the closing parenthesis of a list is not an element. ClickHouse reads `(a UInt8,)` as `(a UInt8)`.
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
  // The answer of each call is nothing when no answer is set, the text (formatQuery), or the tokens (EXPLAIN AST).
  FormatQueryFailureKind format_fails = FormatQueryFailureKind::none;
  std::string format_error = "Syntax error";
  FormatQueryFailureKind ast_fails = FormatQueryFailureKind::none;
  // EXPLAIN AST fails with a syntax error for a text that holds this word.
  std::string ast_refuses;
  // ClickHouse gives an error at the first place of the sent text where this marker is. The formatQuery text fails with this error.
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
