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

inline std::string escape_for_clickhouse_string(std::string_view in) {
  std::string out;
  out.reserve(in.size() + 16);
  for (size_t i = 0; i < in.size(); ++i) {
    char c = in[i];
    if (c == '\r') {
      if (i + 1 < in.size() && in[i + 1] == '\n') {
        ++i;
      }
      out.push_back('\n');
      continue;
    }
    if (c == '\\') {
      out.push_back('\\');
      out.push_back('\\');
      continue;
    }
    if (c == '\'') {
      out.push_back('\\');
      out.push_back('\'');
      continue;
    }
    out.push_back(c);
  }
  return out;
}

inline std::string escape_single_quotes(std::string_view in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (char c : in) {
    if (c == '\\') {
      out.push_back('\\');
      out.push_back('\\');
    } else if (c == '\'') {
      out.push_back('\\');
      out.push_back('\'');
    } else {
      out.push_back(c);
    }
  }
  return out;
}

} // namespace chdash
