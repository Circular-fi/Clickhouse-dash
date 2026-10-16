#pragma once

// This file is the only place that writes a value or a name into SQL text.
// Every other file calls these functions.
// No other file in src/ escapes a quote.
//
// The rules are the rules of the ClickHouse lexer.
// In a 'string', a `name` and a "name", a backslash starts an escape sequence.
// The function therefore escapes the backslash itself.
// Doubling a quote is not enough.
// For example, the name `a\` followed by a doubled backtick ends the name early, and the rest of the text becomes SQL.
// A control character is written as an escape sequence.
// A value therefore cannot break the line of a statement.
// A NUL byte reaches the server whole.
//
// Use a bound parameter for a value that a user chooses, where ClickHouse takes one.
// A bound parameter uses {name:Type} and Query::SetParam (docs/configuration.md, "Bound parameters").
// Use these functions for the names of objects, because a name is not a parameter.
// Use them also for the few places where a parameter cannot stand.

#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace sql {

namespace detail {

// Return `text` between `quote` marks, with the escapes listed above.
inline std::string quoted(std::string_view text, char quote) {
  std::string out;
  out.reserve(text.size() + 2);
  out.push_back(quote);
  for (const char c : text) {
    const auto u = static_cast<unsigned char>(c);
    if (c == '\\' || c == quote) {
      out.push_back('\\');
      out.push_back(c);
    } else if (c == '\n') {
      out += "\\n";
    } else if (c == '\r') {
      out += "\\r";
    } else if (c == '\t') {
      out += "\\t";
    } else if (c == '\0') {
      out += "\\0";
    } else if (u < 0x20 || u == 0x7f) {
      char buf[8];
      std::snprintf(buf, sizeof(buf), "\\x%02X", static_cast<unsigned>(u));
      out += buf;
    } else {
      out.push_back(c);
    }
  }
  out.push_back(quote);
  return out;
}

} // namespace detail

// `name`: a database, a table, a column, or another name of an object.
inline std::string quote_ident(std::string_view name) { return detail::quoted(name, '`'); }

// 'text': a string literal.
inline std::string quote_string(std::string_view text) { return detail::quoted(text, '\''); }

// `database`.`table`
inline std::string quote_qualified(std::string_view database, std::string_view table) {
  return quote_ident(database) + "." + quote_ident(table);
}

// ['a', 'b']: an Array(String) literal ([] when empty).
// For a list that IN takes, use quote_list.
// Use this text as an Array(String) query parameter only for values without a quote mark or a backslash (the hexadecimal trace ids).
// ClickHouse reads the text of such a parameter with its own rules for these values, which differ from this quoting.
// For other values, use SqlParams (sql_params.hpp).
inline std::string quote_array(const std::vector<std::string>& values) {
  std::string out = "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out += ", ";
    out += quote_string(values[i]);
  }
  return out + "]";
}

// 'a', 'b': the inside of an IN (...) list ("''" when empty, which matches no row).
inline std::string quote_list(const std::vector<std::string>& values) {
  if (values.empty()) return "''";
  std::string out;
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out += ", ";
    out += quote_string(values[i]);
  }
  return out;
}

// Escape `text` for the pattern of LIKE and ILIKE, so that % and _ match themselves.
// Pass the result to quote_string.
inline std::string like_escape(std::string_view text) {
  std::string out;
  out.reserve(text.size() + 4);
  for (const char c : text) {
    if (c == '\\' || c == '%' || c == '_') out.push_back('\\');
    out.push_back(c);
  }
  return out;
}

} // namespace sql
} // namespace chdash
