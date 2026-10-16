#pragma once

// SQL helpers of the MCP tools (docs/mcp.md). These helpers have a lexer-level statement splitter
// and checker for run_query and explain_query. They also have the builder that turns the
// query_table arguments into one SELECT. This is pure code. It needs no ClickHouse.
//
// The splitter is a guard rail, not the security boundary. The boundary is readonly=1 on every query
// and the grants of the ClickHouse MCP user.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

// ---- single-statement scan ---------------------------------------------------

struct McpSqlScan {
  bool ok = false;
  // empty_sql, invalid_sql, multiple_statements, statement_not_allowed, clause_not_allowed, function_not_allowed
  std::string error;
  std::string message;
  // The statement without its closing `;`. Comments before and inside it stay.
  std::string statement;
  // The first word in upper case ("SELECT"). It is empty when there is none.
  std::string first_keyword;
};

// Splits `sql` the way ClickHouse reads it. A `;` inside a single-quoted string does not end the statement.
// The same applies to a quoted identifier, a heredoc ($tag$ ... $tag$), a `--` or `#` line comment, and a block comment.
// Accepts exactly one statement. One closing `;` is fine.
//
// The first word must be in `allowed_first_words` (upper case).
// Rejects INTO OUTFILE, and a SETTINGS clause, which would change the limits of the key.
// Rejects the table functions that read files, URLs, remote servers and other databases.
McpSqlScan mcp_scan_single_statement(std::string_view sql, const std::vector<std::string>& allowed_first_words);

// ---- query_table ---------------------------------------------------------------

enum class McpTypeClass { Integer, UnsignedInteger, Float, Decimal, Bool, Text, Enum, Temporal, Unsupported };

struct McpTypeInfo {
  McpTypeClass cls = McpTypeClass::Unsupported;
  bool nullable = false;
  // String and FixedString types support LIKE.
  bool like_ok = false;
  // AggregateFunction(...) has a binary state. This state is no use as a value.
  bool aggregate_state = false;
};
McpTypeInfo mcp_classify_type(std::string_view clickhouse_type);

struct McpColumn {
  std::string name;
  std::string type;
  // Average uncompressed bytes per row, when the table reports it. Otherwise 0.
  uint64_t avg_row_bytes = 0;
};

// One JSON scalar of a filter value.
struct McpScalar {
  enum class Kind { Null, Bool, Integer, Float, String };
  Kind kind = Kind::Null;
  bool boolean = false;
  // Integer and Float: the number as text. String: the string.
  std::string text;
};

struct McpFilter {
  std::string column;
  std::string op;  // = != < <= > >= like not_like ilike in not_in is_null is_not_null
  std::vector<McpScalar> values;  // one for the comparisons and LIKE, several for in / not_in
  bool value_is_array = false;
};

struct McpOrderBy {
  std::string column;
  bool descending = false;
};

struct McpTableQuery {
  std::string database;
  std::string table;
  // Empty: every column, minus the omitted ones.
  std::vector<std::string> columns;
  std::vector<McpFilter> filters;
  std::vector<McpOrderBy> order_by;
  int64_t limit = 100;
};

struct McpOmittedColumn {
  std::string name;
  std::string type;
  std::string reason;  // wide, aggregate_state
};

struct McpBuiltQuery {
  bool ok = false;
  std::string error;  // invalid_argument, unknown_column, unsupported_column_type
  std::string message;
  std::string argument;  // the argument at fault
  std::string sql;
  std::vector<std::string> selected;
  std::vector<McpOmittedColumn> omitted;
};

inline constexpr uint64_t kMcpWideColumnBytes = 2048;
inline constexpr size_t kMcpMaxFilters = 20;
inline constexpr size_t kMcpMaxInValues = 100;
inline constexpr size_t kMcpMaxOrderBy = 8;
inline constexpr size_t kMcpMaxColumns = 500;

// `query.limit` is written as is. The caller clamps it and adds the probe row.
McpBuiltQuery mcp_build_table_query(const McpTableQuery& query, const std::vector<McpColumn>& real_columns);

} // namespace chdash
