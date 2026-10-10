#pragma once

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

} // namespace chdash
