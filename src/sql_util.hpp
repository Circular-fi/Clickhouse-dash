#pragma once

#include <cstddef>
#include <string>
#include <string_view>

namespace chdash {

inline std::string trim_sql(std::string sql) {
  size_t i = 0;
  while (i < sql.size() && (sql[i] == ' ' || sql[i] == '\n' || sql[i] == '\r' || sql[i] == '\t')) ++i;
  if (i > 0) sql.erase(0, i);
  while (!sql.empty()) {
    char c = sql.back();
    if (c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == ';') {
      sql.pop_back();
      continue;
    }
    break;
  }
  return sql;
}

// The line and the column (both from 1) of the byte `idx` of a text. The column counts UTF-16 units, as the editor of the page does.
inline void sql_line_col(std::string_view sql, size_t idx, int& line, int& col) {
  if (idx > sql.size()) idx = sql.size();
  line = 1;
  col = 1;
  for (size_t i = 0; i < idx; ++i) {
    const char c = sql[i];
    if (c == '\r') {
      if (i + 1 < sql.size() && sql[i + 1] == '\n') ++i;
      ++line;
      col = 1;
      continue;
    }
    if (c == '\n') {
      ++line;
      col = 1;
      continue;
    }
    const auto u = static_cast<unsigned char>(c);
    if ((u & 0xC0) == 0x80) continue;  // the rest of a character
    col += u >= 0xF0 ? 2 : 1;          // a character above U+FFFF is two UTF-16 units
  }
}

} // namespace chdash
