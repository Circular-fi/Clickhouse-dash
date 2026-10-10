#include "user_sql_policy.hpp"

#include <cctype>
#include <string>

namespace chdash {
namespace {

bool is_ident_start(unsigned char c) {
  return std::isalpha(c) || c == '_';
}

bool is_ident_continue(unsigned char c) {
  return std::isalnum(c) || c == '_';
}

// The UTF-8 length of the Unicode space at `pos`, or 0. The ClickHouse lexer separates tokens with these
// too (checked on 26.7: U+0085, U+00A0, U+180E, U+2000..U+200D, U+2028, U+2029, U+202F, U+205F, U+2060,
// U+3000, U+FEFF), so "KILL" U+00A0 "QUERY" is a KILL QUERY for the server.
size_t unicode_space_length(std::string_view sql, size_t pos) {
  const auto at = [&](size_t i) { return pos + i < sql.size() ? static_cast<unsigned char>(sql[pos + i]) : 0u; };
  const unsigned c0 = at(0), c1 = at(1), c2 = at(2);
  if (c0 == 0xC2 && (c1 == 0x85 || c1 == 0xA0)) return 2;
  if (c0 == 0xE1 && c1 == 0xA0 && c2 == 0x8E) return 3;
  if (c0 == 0xE2 && c1 == 0x80 && ((c2 >= 0x80 && c2 <= 0x8D) || c2 == 0xA8 || c2 == 0xA9 || c2 == 0xAF)) return 3;
  if (c0 == 0xE2 && c1 == 0x81 && (c2 == 0x9F || c2 == 0xA0)) return 3;
  if (c0 == 0xE3 && c1 == 0x80 && c2 == 0x80) return 3;
  if (c0 == 0xEF && c1 == 0xBB && c2 == 0xBF) return 3;
  return 0;
}

void skip_space_and_comments(std::string_view sql, size_t& pos) {
  for (;;) {
    while (pos < sql.size()) {
      if (std::isspace(static_cast<unsigned char>(sql[pos]))) {
        ++pos;
      } else if (const size_t length = unicode_space_length(sql, pos)) {
        pos += length;
      } else {
        break;
      }
    }

    if (pos + 1 < sql.size() && sql[pos] == '-' && sql[pos + 1] == '-') {
      pos += 2;
      while (pos < sql.size() && sql[pos] != '\n' && sql[pos] != '\r') ++pos;
      continue;
    }
    if (pos < sql.size() && sql[pos] == '#') {
      ++pos;
      while (pos < sql.size() && sql[pos] != '\n' && sql[pos] != '\r') ++pos;
      continue;
    }
    if (pos + 1 < sql.size() && sql[pos] == '/' && sql[pos + 1] == '*') {
      pos += 2;
      while (pos + 1 < sql.size() && !(sql[pos] == '*' && sql[pos + 1] == '/')) ++pos;
      if (pos + 1 < sql.size()) pos += 2;
      continue;
    }
    return;
  }
}

std::string next_keyword(std::string_view sql, size_t& pos) {
  skip_space_and_comments(sql, pos);
  if (pos >= sql.size() || !is_ident_start(static_cast<unsigned char>(sql[pos]))) return {};
  const size_t start = pos++;
  while (pos < sql.size() && is_ident_continue(static_cast<unsigned char>(sql[pos]))) ++pos;

  std::string token;
  token.reserve(pos - start);
  for (size_t i = start; i < pos; ++i) {
    token.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(sql[i]))));
  }
  return token;
}

// Move to the next top-level semicolon while respecting SQL strings,
// quoted identifiers and comments. This also protects against a future client
// configuration that accepts multiple statements in one request.
void skip_statement(std::string_view sql, size_t& pos) {
  enum class Quote { None, Single, Double, Backtick };
  Quote quote = Quote::None;

  while (pos < sql.size()) {
    const char c = sql[pos];
    if (quote == Quote::None) {
      if (c == '\'') { quote = Quote::Single; ++pos; continue; }
      if (c == '"') { quote = Quote::Double; ++pos; continue; }
      if (c == '`') { quote = Quote::Backtick; ++pos; continue; }
      if (c == ';') { ++pos; return; }
      if (c == '-' && pos + 1 < sql.size() && sql[pos + 1] == '-') {
        pos += 2;
        while (pos < sql.size() && sql[pos] != '\n' && sql[pos] != '\r') ++pos;
        continue;
      }
      if (c == '#') {
        ++pos;
        while (pos < sql.size() && sql[pos] != '\n' && sql[pos] != '\r') ++pos;
        continue;
      }
      if (c == '/' && pos + 1 < sql.size() && sql[pos + 1] == '*') {
        pos += 2;
        while (pos + 1 < sql.size() && !(sql[pos] == '*' && sql[pos + 1] == '/')) ++pos;
        if (pos + 1 < sql.size()) pos += 2;
        continue;
      }
      ++pos;
      continue;
    }

    const char delimiter = quote == Quote::Single ? '\'' : (quote == Quote::Double ? '"' : '`');
    if (c == '\\' && pos + 1 < sql.size()) {
      pos += 2;
      continue;
    }
    if (c == delimiter) {
      // ClickHouse accepts doubled quote characters inside quoted strings and
      // identifiers. Keep scanning rather than treating the second quote as a
      // new quoted segment.
      if (pos + 1 < sql.size() && sql[pos + 1] == delimiter) {
        pos += 2;
        continue;
      }
      quote = Quote::None;
    }
    ++pos;
  }
}

} // namespace

bool user_sql_is_forbidden(std::string_view sql) {
  size_t pos = 0;
  // Ignore an optional UTF-8 BOM.
  if (sql.size() >= 3 && static_cast<unsigned char>(sql[0]) == 0xEF &&
static_cast<unsigned char>(sql[1]) == 0xBB && static_cast<unsigned char>(sql[2]) == 0xBF) {
    pos = 3;
  }

  while (pos < sql.size()) {
    skip_space_and_comments(sql, pos);
    while (pos < sql.size() && sql[pos] == ';') {
      ++pos;
      skip_space_and_comments(sql, pos);
    }
    if (pos >= sql.size()) return false;

    const size_t statement_start = pos;
    const std::string first = next_keyword(sql, pos);
    if (first == "KILL") {
      const std::string second = next_keyword(sql, pos);
      if (second == "QUERY") return true;
    }

    pos = statement_start;
    skip_statement(sql, pos);
  }
  return false;
}

} // namespace chdash
