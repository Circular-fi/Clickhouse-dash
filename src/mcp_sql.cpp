#include "mcp_sql.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <unordered_set>

namespace chdash {

// ---- quoting ---------------------------------------------------------------------

std::string mcp_quote_identifier(std::string_view name) {
  std::string out = "`";
  for (const char c : name) {
    if (c == '`' || c == '\\') out.push_back('\\');
    out.push_back(c);
  }
  out.push_back('`');
  return out;
}

std::string mcp_quote_string(std::string_view text) {
  std::string out = "'";
  for (const char c : text) {
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '\'': out += "\\'"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\0': out += "\\0"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20 || c == 0x7f) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\x%02X", static_cast<unsigned>(static_cast<unsigned char>(c)));
          out += buf;
        } else {
          out.push_back(c);
        }
    }
  }
  out.push_back('\'');
  return out;
}

// ---- lexer ---------------------------------------------------------------------------

namespace {

enum class Tok { Word, Quoted, String, Number, Punct };

struct Token {
  Tok kind;
  std::string text;  // Word and Punct: the text; the others: empty
  size_t begin = 0;
  size_t end = 0;
};

bool word_start(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; }
bool word_char(char c) { return word_start(c) || (c >= '0' && c <= '9'); }
bool is_digit(char c) { return c >= '0' && c <= '9'; }

std::string upper(std::string_view s) {
  std::string out(s);
  for (auto& c : out) {
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
  }
  return out;
}

// Returns false (with `error`) on an unterminated string, identifier, comment or heredoc.
bool tokenize(std::string_view s, std::vector<Token>* out, std::string* error) {
  size_t i = 0;
  const size_t n = s.size();
  while (i < n) {
    const char c = s[i];
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
      ++i;
      continue;
    }
    if (c == '-' && i + 1 < n && s[i + 1] == '-') {
      while (i < n && s[i] != '\n') ++i;
      continue;
    }
    if (c == '#' && (i + 1 >= n || s[i + 1] == ' ' || s[i + 1] == '!' || s[i + 1] == '\n' || s[i + 1] == '\r')) {
      while (i < n && s[i] != '\n') ++i;
      continue;
    }
    if (c == '/' && i + 1 < n && s[i + 1] == '*') {
      const auto close = s.find("*/", i + 2);
      if (close == std::string_view::npos) {
        *error = "a block comment is not closed";
        return false;
      }
      i = close + 2;
      continue;
    }
    if (c == '\'' || c == '"' || c == '`') {
      const size_t begin = i++;
      bool closed = false;
      while (i < n) {
        if (s[i] == '\\') {
          i += 2;
          continue;
        }
        if (s[i] == c) {
          if (i + 1 < n && s[i + 1] == c) {
            i += 2;
            continue;
          }
          ++i;
          closed = true;
          break;
        }
        ++i;
      }
      if (!closed) {
        *error = c == '\'' ? "a string literal is not closed" : "a quoted identifier is not closed";
        return false;
      }
      out->push_back({c == '\'' ? Tok::String : Tok::Quoted, "", begin, i});
      continue;
    }
    if (c == '$' && (i == 0 || !(word_char(s[i - 1]) || s[i - 1] == '$'))) {
      size_t j = i + 1;
      if (j < n && word_start(s[j])) {
        while (j < n && word_char(s[j])) ++j;
      }
      if (j < n && s[j] == '$') {
        const std::string delimiter(s.substr(i, j - i + 1));
        const auto close = s.find(delimiter, j + 1);
        if (close == std::string_view::npos) {
          *error = "a $$ string is not closed";
          return false;
        }
        const size_t begin = i;
        i = close + delimiter.size();
        out->push_back({Tok::String, "", begin, i});
        continue;
      }
    }
    if (word_start(c)) {
      const size_t begin = i;
      while (i < n && (word_char(s[i]) || s[i] == '$')) ++i;
      out->push_back({Tok::Word, std::string(s.substr(begin, i - begin)), begin, i});
      continue;
    }
    if (is_digit(c)) {
      const size_t begin = i;
      while (i < n && (word_char(s[i]) || s[i] == '.')) ++i;
      out->push_back({Tok::Number, "", begin, i});
      continue;
    }
    out->push_back({Tok::Punct, std::string(1, c), i, i + 1});
    ++i;
  }
  return true;
}

// Table functions that read files, URLs, remote servers or other databases. The grants of the
// ClickHouse MCP user are the boundary; this list only gives a clear message first.
bool denied_function(const std::string& upper_name) {
  static const std::unordered_set<std::string> denied = {
      "FILE", "FILECLUSTER", "URL", "URLCLUSTER", "REMOTE", "REMOTESECURE", "S3", "S3CLUSTER", "HDFS", "HDFSCLUSTER",
      "MYSQL", "POSTGRESQL", "MONGODB", "REDIS", "JDBC", "ODBC", "SQLITE", "EXECUTABLE", "INPUT",
      "AZUREBLOBSTORAGE", "AZUREBLOBSTORAGECLUSTER", "ICEBERG", "ICEBERGCLUSTER", "DELTALAKE", "DELTALAKECLUSTER",
      "HUDI", "HUDICLUSTER", "GCS", "OSS", "COSN", "ARROWFLIGHT", "YTSAURUS"};
  return denied.count(upper_name) != 0;
}

std::string join(const std::vector<std::string>& items) {
  std::string out;
  for (const auto& item : items) {
    if (!out.empty()) out += ", ";
    out += item;
  }
  return out;
}

McpSqlScan scan_fail(const char* error, std::string message) {
  McpSqlScan scan;
  scan.error = error;
  scan.message = std::move(message);
  return scan;
}

} // namespace

McpSqlScan mcp_scan_single_statement(std::string_view sql, const std::vector<std::string>& allowed_first_words) {
  if (sql.find('\0') != std::string_view::npos) return scan_fail("invalid_sql", "the SQL has a NUL character");
  std::vector<Token> tokens;
  std::string error;
  if (!tokenize(sql, &tokens, &error)) return scan_fail("invalid_sql", error);
  if (tokens.empty()) return scan_fail("empty_sql", "the SQL is empty");

  size_t semicolon = tokens.size();
  for (size_t i = 0; i < tokens.size(); ++i) {
    if (tokens[i].kind == Tok::Punct && tokens[i].text == ";") {
      semicolon = i;
      break;
    }
  }
  if (semicolon == 0) return scan_fail("empty_sql", "the SQL is empty");
  if (semicolon + 1 < tokens.size()) {
    return scan_fail("multiple_statements", "send exactly one statement; a second statement follows the first ;");
  }
  const size_t count = semicolon;  // the tokens of the statement

  size_t first = 0;
  while (first < count && tokens[first].kind == Tok::Punct && tokens[first].text == "(") ++first;
  if (first >= count || tokens[first].kind != Tok::Word) {
    return scan_fail("statement_not_allowed", "the statement must start with " + join(allowed_first_words));
  }
  McpSqlScan scan;
  scan.first_keyword = upper(tokens[first].text);
  if (std::find(allowed_first_words.begin(), allowed_first_words.end(), scan.first_keyword) == allowed_first_words.end()) {
    return scan_fail("statement_not_allowed",
                     scan.first_keyword + " is not allowed here; the statement must start with " + join(allowed_first_words));
  }

  for (size_t i = 0; i < count; ++i) {
    if (tokens[i].kind != Tok::Word) continue;
    const std::string word = upper(tokens[i].text);
    if (word == "INTO" && i + 1 < count && tokens[i + 1].kind == Tok::Word && upper(tokens[i + 1].text) == "OUTFILE") {
      return scan_fail("clause_not_allowed", "INTO OUTFILE is not allowed");
    }
    if (i + 1 < count && tokens[i + 1].kind == Tok::Punct && tokens[i + 1].text == "(" && denied_function(word)) {
      return scan_fail("function_not_allowed", "the table function " + tokens[i].text + " is not allowed through MCP");
    }
  }

  const size_t end = semicolon < tokens.size() ? tokens[semicolon].begin : sql.size();
  size_t begin = 0;
  std::string_view statement = sql.substr(begin, end - begin);
  while (!statement.empty() && (statement.back() == ' ' || statement.back() == '\n' || statement.back() == '\t' || statement.back() == '\r')) {
    statement.remove_suffix(1);
  }
  while (!statement.empty() && (statement.front() == ' ' || statement.front() == '\n' || statement.front() == '\t' || statement.front() == '\r')) {
    statement.remove_prefix(1);
  }
  scan.ok = true;
  scan.statement = std::string(statement);
  return scan;
}

// ---- column types ----------------------------------------------------------------------

McpTypeInfo mcp_classify_type(std::string_view type) {
  McpTypeInfo info;
  const auto strip = [&](std::string_view wrapper) {
    if (type.size() > wrapper.size() + 1 && type.substr(0, wrapper.size()) == wrapper && type.back() == ')') {
      type = type.substr(wrapper.size(), type.size() - wrapper.size() - 1);
      return true;
    }
    return false;
  };
  for (int guard = 0; guard < 8; ++guard) {
    if (strip("Nullable(")) {
      info.nullable = true;
      continue;
    }
    if (strip("LowCardinality(")) continue;
    if (type.substr(0, 24) == "SimpleAggregateFunction(" && type.back() == ')') {
      // SimpleAggregateFunction(func, T): the value is a T.
      int depth = 0;
      size_t comma = std::string_view::npos;
      for (size_t i = 24; i < type.size(); ++i) {
        if (type[i] == '(') ++depth;
        else if (type[i] == ')') --depth;
        else if (type[i] == ',' && depth == 0) {
          comma = i;
          break;
        }
      }
      if (comma == std::string_view::npos) return info;
      type = type.substr(comma + 1, type.size() - comma - 2);
      while (!type.empty() && type.front() == ' ') type.remove_prefix(1);
      continue;
    }
    break;
  }
  const auto paren = type.find('(');
  const std::string_view base = type.substr(0, paren);
  if (base == "AggregateFunction") {
    info.aggregate_state = true;
    return info;
  }
  if (base.size() >= 3 && base.substr(0, 3) == "Int" && base.size() <= 6) {
    info.cls = McpTypeClass::Integer;
  } else if (base.size() >= 4 && base.substr(0, 4) == "UInt" && base.size() <= 7) {
    info.cls = McpTypeClass::UnsignedInteger;
  } else if (base == "Float32" || base == "Float64" || base == "BFloat16") {
    info.cls = McpTypeClass::Float;
  } else if (base.substr(0, 7) == "Decimal") {
    info.cls = McpTypeClass::Decimal;
  } else if (base == "Bool") {
    info.cls = McpTypeClass::Bool;
  } else if (base == "String" || base == "FixedString") {
    info.cls = McpTypeClass::Text;
    info.like_ok = true;
  } else if (base == "UUID" || base == "IPv4" || base == "IPv6") {
    info.cls = McpTypeClass::Text;
  } else if (base == "Enum8" || base == "Enum16" || base == "Enum") {
    info.cls = McpTypeClass::Enum;
  } else if (base == "Date" || base == "Date32" || base == "DateTime" || base == "DateTime64") {
    info.cls = McpTypeClass::Temporal;
  }
  return info;
}

// ---- query_table ---------------------------------------------------------------------------

namespace {

McpBuiltQuery build_fail(const char* error, std::string argument, std::string message) {
  McpBuiltQuery out;
  out.error = error;
  out.argument = std::move(argument);
  out.message = std::move(message);
  return out;
}

bool plain_integer(std::string_view s, bool allow_sign) {
  if (s.empty()) return false;
  size_t i = 0;
  if (s[0] == '-') {
    if (!allow_sign) return false;
    i = 1;
  }
  if (i >= s.size() || s.size() - i > 77) return false;
  for (; i < s.size(); ++i) {
    if (!is_digit(s[i])) return false;
  }
  return true;
}

// -?digits[.digits][e[+-]digits]
bool plain_number(std::string_view s, bool allow_exponent) {
  size_t i = 0;
  if (i < s.size() && s[i] == '-') ++i;
  const size_t int_start = i;
  while (i < s.size() && is_digit(s[i])) ++i;
  if (i == int_start) return false;
  if (i < s.size() && s[i] == '.') {
    ++i;
    const size_t frac = i;
    while (i < s.size() && is_digit(s[i])) ++i;
    if (i == frac) return false;
  }
  if (allow_exponent && i < s.size() && (s[i] == 'e' || s[i] == 'E')) {
    ++i;
    if (i < s.size() && (s[i] == '+' || s[i] == '-')) ++i;
    const size_t exp = i;
    while (i < s.size() && is_digit(s[i])) ++i;
    if (i == exp) return false;
  }
  return i == s.size() && s.size() <= 80;
}

// The SQL literal of `value` for a column of type `info`, or false with `why`.
bool literal_for(const McpTypeInfo& info, const McpScalar& value, std::string* out, std::string* why) {
  using Kind = McpScalar::Kind;
  if (value.kind == Kind::Null) {
    *why = "a value cannot be null; use the is_null or is_not_null operator";
    return false;
  }
  switch (info.cls) {
    case McpTypeClass::Integer:
    case McpTypeClass::UnsignedInteger: {
      const bool signed_ok = info.cls == McpTypeClass::Integer;
      if ((value.kind == Kind::Integer || value.kind == Kind::String) && plain_integer(value.text, signed_ok)) {
        *out = value.text;
        return true;
      }
      *why = signed_ok ? "this column is an integer: send a whole number" : "this column is unsigned: send a whole number, not negative";
      return false;
    }
    case McpTypeClass::Float:
      if ((value.kind == Kind::Integer || value.kind == Kind::Float || value.kind == Kind::String) && plain_number(value.text, true)) {
        *out = value.text;
        return true;
      }
      *why = "this column is a number: send a number";
      return false;
    case McpTypeClass::Decimal:
      if ((value.kind == Kind::Integer || value.kind == Kind::Float || value.kind == Kind::String) && plain_number(value.text, false)) {
        *out = value.text;
        return true;
      }
      *why = "this column is a decimal: send a number";
      return false;
    case McpTypeClass::Bool: {
      if (value.kind == Kind::Bool) {
        *out = value.boolean ? "true" : "false";
        return true;
      }
      const std::string text = upper(value.text);
      if ((value.kind == Kind::String && (text == "TRUE" || text == "FALSE")) || (value.kind == Kind::Integer && (text == "0" || text == "1"))) {
        *out = (text == "TRUE" || text == "1") ? "true" : "false";
        return true;
      }
      *why = "this column is a boolean: send true or false";
      return false;
    }
    case McpTypeClass::Text:
    case McpTypeClass::Enum:
      if (value.kind == Kind::Bool) {
        *out = mcp_quote_string(value.boolean ? "true" : "false");
        return true;
      }
      *out = mcp_quote_string(value.text);
      return true;
    case McpTypeClass::Temporal:
      if (value.kind == Kind::Integer && plain_integer(value.text, true)) {
        *out = value.text;
        return true;
      }
      if (value.kind == Kind::String) {
        *out = mcp_quote_string(value.text);
        return true;
      }
      *why = "this column is a date or time: send a string such as 2026-10-08 12:00:00, or a Unix time";
      return false;
    case McpTypeClass::Unsupported:
      break;
  }
  *why = "filters do not work on this column type";
  return false;
}

} // namespace

McpBuiltQuery mcp_build_table_query(const McpTableQuery& query, const std::vector<McpColumn>& real_columns) {
  const auto find_column = [&](const std::string& name) -> const McpColumn* {
    for (const auto& column : real_columns) {
      if (column.name == name) return &column;
    }
    return nullptr;
  };

  McpBuiltQuery built;
  // Columns.
  if (query.columns.size() > kMcpMaxColumns) return build_fail("invalid_argument", "columns", "too many columns");
  if (!query.columns.empty()) {
    for (size_t i = 0; i < query.columns.size(); ++i) {
      const auto& name = query.columns[i];
      if (!find_column(name)) {
        return build_fail("unknown_column", "columns[" + std::to_string(i) + "]",
                          "the table has no column " + name + "; call describe_table for the column names");
      }
      if (std::find(built.selected.begin(), built.selected.end(), name) != built.selected.end()) {
        return build_fail("invalid_argument", "columns[" + std::to_string(i) + "]", "the column " + name + " is listed twice");
      }
      built.selected.push_back(name);
    }
  } else {
    for (const auto& column : real_columns) {
      const McpTypeInfo info = mcp_classify_type(column.type);
      if (info.aggregate_state) {
        built.omitted.push_back({column.name, column.type, "aggregate_state"});
      } else if (column.avg_row_bytes > kMcpWideColumnBytes) {
        built.omitted.push_back({column.name, column.type, "wide"});
      } else {
        built.selected.push_back(column.name);
      }
    }
    if (built.selected.empty()) {
      // Every column is omitted: send them all rather than an empty SELECT.
      built.omitted.clear();
      for (const auto& column : real_columns) built.selected.push_back(column.name);
    }
    if (built.selected.size() > kMcpMaxColumns) built.selected.resize(kMcpMaxColumns);
  }
  if (built.selected.empty()) return build_fail("invalid_argument", "table", "the table has no readable column");

  // Filters.
  if (query.filters.size() > kMcpMaxFilters) return build_fail("invalid_argument", "filters", "at most 20 filters");
  std::string where;
  for (size_t i = 0; i < query.filters.size(); ++i) {
    const auto& filter = query.filters[i];
    const std::string at = "filters[" + std::to_string(i) + "]";
    const McpColumn* column = find_column(filter.column);
    if (!column) {
      return build_fail("unknown_column", at + ".column", "the table has no column " + filter.column + "; call describe_table for the column names");
    }
    const McpTypeInfo info = mcp_classify_type(column->type);
    const std::string ident = mcp_quote_identifier(filter.column);
    std::string condition;
    const std::string& op = filter.op;
    if (op == "is_null" || op == "is_not_null") {
      condition = ident + (op == "is_null" ? " IS NULL" : " IS NOT NULL");
    } else if (op == "in" || op == "not_in") {
      if (!filter.value_is_array || filter.values.empty() || filter.values.size() > kMcpMaxInValues) {
        return build_fail("invalid_argument", at + ".value", "the " + op + " operator needs a list of 1 to 100 values");
      }
      std::string list;
      for (const auto& value : filter.values) {
        std::string literal, why;
        if (!literal_for(info, value, &literal, &why)) {
          return build_fail(info.cls == McpTypeClass::Unsupported ? "unsupported_column_type" : "invalid_argument", at + ".value", why);
        }
        if (!list.empty()) list += ", ";
        list += literal;
      }
      condition = ident + (op == "in" ? " IN (" : " NOT IN (") + list + ")";
    } else if (op == "=" || op == "!=" || op == "<" || op == "<=" || op == ">" || op == ">=") {
      if (filter.value_is_array || filter.values.size() != 1) {
        return build_fail("invalid_argument", at + ".value", "the " + op + " operator needs one value");
      }
      std::string literal, why;
      if (!literal_for(info, filter.values[0], &literal, &why)) {
        return build_fail(info.cls == McpTypeClass::Unsupported ? "unsupported_column_type" : "invalid_argument", at + ".value", why);
      }
      condition = ident + " " + op + " " + literal;
    } else if (op == "like" || op == "not_like" || op == "ilike") {
      if (!info.like_ok) {
        return build_fail("unsupported_column_type", at + ".op", "the " + op + " operator works on String columns only");
      }
      if (filter.value_is_array || filter.values.size() != 1 || filter.values[0].kind != McpScalar::Kind::String) {
        return build_fail("invalid_argument", at + ".value", "the " + op + " operator needs one string, for example \"error%\"");
      }
      const char* sql_op = op == "like" ? " LIKE " : (op == "not_like" ? " NOT LIKE " : " ILIKE ");
      condition = ident + sql_op + mcp_quote_string(filter.values[0].text);
    } else {
      return build_fail("invalid_argument", at + ".op",
                        "unknown operator " + op + "; use = != < <= > >= like not_like ilike in not_in is_null is_not_null");
    }
    if (!where.empty()) where += " AND ";
    where += condition;
  }

  // Order.
  if (query.order_by.size() > kMcpMaxOrderBy) return build_fail("invalid_argument", "order_by", "at most 8 order_by entries");
  std::string order;
  for (size_t i = 0; i < query.order_by.size(); ++i) {
    const auto& item = query.order_by[i];
    if (!find_column(item.column)) {
      return build_fail("unknown_column", "order_by[" + std::to_string(i) + "].column",
                        "the table has no column " + item.column + "; call describe_table for the column names");
    }
    if (!order.empty()) order += ", ";
    order += mcp_quote_identifier(item.column) + (item.descending ? " DESC" : " ASC");
  }

  std::string sql = "SELECT ";
  for (size_t i = 0; i < built.selected.size(); ++i) {
    if (i) sql += ", ";
    sql += mcp_quote_identifier(built.selected[i]);
  }
  sql += " FROM " + mcp_quote_identifier(query.database) + "." + mcp_quote_identifier(query.table);
  if (!where.empty()) sql += " WHERE " + where;
  if (!order.empty()) sql += " ORDER BY " + order;
  sql += " LIMIT " + std::to_string(query.limit);
  built.sql = std::move(sql);
  built.ok = true;
  return built;
}

} // namespace chdash
