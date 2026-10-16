#pragma once

// The readers of the Explorer share these helpers when they read a row of ClickHouse.
// The readers are the catalog, the table card, the storage map and the graph.
// The helpers read the text of a column, and the numbers and flags that it holds.
// They also give the key of a table, and a SELECT that reports its failure without a throw.
// Every column is read as text (`toString(...)` in the statement). So one decoder serves every version of the server.

#include "ch_block_numeric.hpp"
#include "ch_block_value.hpp"
#include "ch_executor.hpp"
#include "sql_literal.hpp"
#include "sql_params.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <exception>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {
namespace explorer {

inline std::string block_string_at(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_text_at(block, column, row);
}

inline std::optional<uint64_t> parse_u64(const std::string& value) {
  if (value.empty()) return std::nullopt;
  try {
    size_t pos = 0;
    const unsigned long long parsed = std::stoull(value, &pos, 10);
    if (pos != value.size()) return std::nullopt;
    return static_cast<uint64_t>(parsed);
  } catch (...) {
    return std::nullopt;
  }
}

inline std::optional<double> parse_double(const std::string& value) {
  if (value.empty()) return std::nullopt;
  try {
    size_t pos = 0;
    const double parsed = std::stod(value, &pos);
    if (pos != value.size() || !std::isfinite(parsed)) return std::nullopt;
    return parsed;
  } catch (...) {
    return std::nullopt;
  }
}

inline bool truthy(const std::string& value) { return value == "1" || value == "true" || value == "TRUE"; }

inline bool block_bool_at(const clickhouse::Block& block, size_t column, size_t row) {
  // On current ClickHouse releases, DESCRIBE returns is_subcolumn as a native UInt8.
  // Do not pass it through the textual metadata decoder. That decoder is strict on purpose.
  // It rejects a valid native boolean column. Keep a textual fallback for older server and client variants.
  try {
    return ch_block_u64_at(block, column, row) != 0;
  } catch (const std::exception&) {
    return truthy(block_string_at(block, column, row));
  }
}

// The values of a column that ClickHouse joined with the unit separator (char(31)). An empty value is dropped.
inline std::vector<std::string> split_unit_separator(std::string_view value) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= value.size(); ++i) {
    if (i != value.size() && value[i] != '\x1f') continue;
    if (i > start) out.emplace_back(value.substr(start, i - start));
    start = i + 1;
  }
  return out;
}

// ClickHouse can expose an internal `row`/`_row` pseudo dependency for view-like objects.
// It is implementation metadata, not a navigable object.
inline bool is_row_pseudo_object(std::string_view table) {
  std::string normalized;
  normalized.reserve(table.size());
  for (const char ch : table) normalized.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(ch))));
  return normalized == "row" || normalized == "_row";
}

// Whether `needle` is in `haystack`, in any case.
inline bool contains_ci(std::string_view haystack, std::string_view needle) {
  if (needle.empty() || haystack.size() < needle.size()) return false;
  for (size_t i = 0; i + needle.size() <= haystack.size(); ++i) {
    bool match = true;
    for (size_t j = 0; j < needle.size(); ++j) {
      if (std::tolower(static_cast<unsigned char>(haystack[i + j])) != std::tolower(static_cast<unsigned char>(needle[j]))) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// The key of a table in the maps of a read. It holds the database, a NUL byte and the table. A name can hold any other byte.
inline std::string table_key(std::string_view database, std::string_view table) {
  std::string key;
  key.reserve(database.size() + table.size() + 1);
  key.append(database.data(), database.size());
  key.push_back('\0');
  key.append(table.data(), table.size());
  return key;
}

inline std::string qualified_ident(std::string_view database, std::string_view table) {
  return sql::quote_ident(database) + "." + sql::quote_ident(table);
}

// A SELECT that reports its failure in *error and returns false. It does not throw.
// A section of an answer that cannot be read leaves its figures out. The answer says so.
template <typename Fn>
bool try_select(ChExecutor& db, const std::string& sql, Fn&& fn, std::string* error = nullptr) {
  try {
    db.select(sql, std::forward<Fn>(fn));
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
}

template <typename Fn>
bool try_select(ChExecutor& db, const SqlStatement& statement, Fn&& fn, std::string* error = nullptr) {
  try {
    db.select(statement.sql, statement.params.list(), std::forward<Fn>(fn));
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
}

}  // namespace explorer
}  // namespace chdash
