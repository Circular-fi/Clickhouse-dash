#pragma once

// The query parameters of one statement.
// A value that the user writes goes to ClickHouse apart from the SQL text, as {pN:String} (ch_query.hpp, ChParams).
// Examples of such values are a service, an attribute value and a search term.
// ClickHouse never parses the value as SQL.
// The text of the statement does not change with the value.
// A name is used once, so the filters of a request and the parts that a route adds share one object.
//
// A String takes the text as it is.
// This includes its quote marks, backslashes, tabs and new lines.
// clickhouse-cpp quotes the text for the protocol.
// An identifier (a column name) cannot be a parameter.
// Use sql::quote_ident for an identifier.

#include "sql_literal.hpp"

#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

class SqlParams {
 public:
  using List = std::vector<std::pair<std::string, std::string>>;

  // Return the placeholder of a new parameter that holds `value`, for example "{p1:String}".
  std::string text(std::string_view value) {
    const std::string name = next_name();
    list_.emplace_back(name, std::string(value));
    return "{" + name + ":String}";
  }

  // Return one placeholder for each value, for the inside of IN (...).
  // For example, "{p2:String}, {p3:String}".
  // An empty list gives "''", which matches no row.
  //
  // Do not use an Array(String) parameter for what a user writes.
  // Its text has the quoting rules of ClickHouse: a quote mark is written twice, and a backslash stays as it is.
  // These rules differ between versions.
  // A String takes its value as it is.
  std::string texts(const std::vector<std::string>& values) {
    if (values.empty()) return "''";
    std::string out;
    for (size_t i = 0; i < values.size(); ++i) out += (i ? ", " : "") + text(values[i]);
    return out;
  }

  // Return the parameters to send with the statement.
  // This is the argument `params` of ch_select and bounded_select.
  const List& list() const { return list_; }

  // Return the values as text, for the key of a cache.
  // Two requests with the same SQL text and other values must not share an entry.
  // The length of each value keeps a value that holds the separators from being taken for two parameters.
  std::string key() const {
    std::string out;
    for (const auto& [name, value] : list_) {
      out += name;
      out += ':';
      out += std::to_string(value.size());
      out += ':';
      out += value;
      out += ';';
    }
    return out;
  }

 private:
  std::string next_name() const { return "p" + std::to_string(list_.size() + 1); }

  List list_;
};

// A statement with the parameters that it needs.
// These are the arguments of ChExecutor::select.
struct SqlStatement {
  std::string sql;
  SqlParams params;
};

}  // namespace chdash
