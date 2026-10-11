#pragma once

// The query parameters of one statement: a value that the user wrote (a service, an attribute value, a search term) goes to ClickHouse
// apart from the SQL text, as {pN:String} (ch_query.hpp, ChParams). It is never parsed as SQL, and the text of the
// statement does not change with it. A name is used once, so the filters of a request and the parts that a route adds share one object.
//
// A String takes the text as it is, with its quote marks, backslashes, tabs and new lines (clickhouse-cpp quotes it for the protocol). An
// identifier (a column name) cannot be a parameter: it goes through sql::quote_ident.

#include "sql_literal.hpp"

#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

class SqlParams {
 public:
  using List = std::vector<std::pair<std::string, std::string>>;

  // "{p1:String}": the placeholder of a new parameter that holds `value`.
  std::string text(std::string_view value) {
    const std::string name = next_name();
    list_.emplace_back(name, std::string(value));
    return "{" + name + ":String}";
  }

  // "{p2:String}, {p3:String}": one parameter for each value, for the inside of IN (...). An Array(String) parameter is not used for
  // what a user writes: its text has the quoting rules of ClickHouse (a quote mark is written twice, a backslash stays as it is),
  // which differ between versions, and a String takes its value as it is. A list that is empty gives "''", which matches no row.
  std::string texts(const std::vector<std::string>& values) {
    if (values.empty()) return "''";
    std::string out;
    for (size_t i = 0; i < values.size(); ++i) out += (i ? ", " : "") + text(values[i]);
    return out;
  }

  // The parameters to send with the statement (the argument `params` of ch_select and bounded_select).
  const List& list() const { return list_; }

  // The values as text, for the key of a cache: two requests with the same SQL text and other values must not share an entry. The length of each value keeps a value
  // that holds the separators from passing for two parameters.
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

// A statement and the parameters that it needs (the arguments of ChExecutor::select).
struct SqlStatement {
  std::string sql;
  SqlParams params;
};

}  // namespace chdash
