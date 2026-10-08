#pragma once

// SQL helpers of the MCP tools (docs/mcp.md): a lexer-level statement splitter
// and checker for run_query / explain_query, and the builder that turns the
// query_table arguments into one SELECT. Pure code, no ClickHouse needed.
//
// The splitter is a guard rail, not the security boundary: the boundary is
// readonly=1 on every query and the grants of the ClickHouse MCP user.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

// ---- quoting --------------------------------------------------------------

// `name` with backslash and backtick escaped.
std::string mcp_quote_identifier(std::string_view name);
// 'text' with backslash, quote, control characters and NUL escaped.
std::string mcp_quote_string(std::string_view text);

// ---- single-statement scan ---------------------------------------------------

struct McpSqlScan {
  bool ok = false;
  // empty_sql, invalid_sql, multiple_statements, statement_not_allowed, clause_not_allowed, function_not_allowed
  std::string error;
  std::string message;
  // The statement without its closing `;` (comments before and inside stay).
  std::string statement;
  // First word, upper case ("SELECT"); empty when there is none.
  std::string first_keyword;
};

// Splits `sql` the way ClickHouse reads it: single-quoted strings, quoted
// identifiers, heredocs ($tag$ ... $tag$), `--` / `#` line comments and block
// comments hide their `;`. Accepts exactly one statement (one closing `;` is
// fine). The first word must be in `allowed_first_words` (upper case). Rejects
// INTO OUTFILE and the table functions that read files, URLs, remote servers
// and other databases.
McpSqlScan mcp_scan_single_statement(std::string_view sql, const std::vector<std::string>& allowed_first_words);

// ---- query_table ---------------------------------------------------------------

enum class McpTypeClass { Integer, UnsignedInteger, Float, Decimal, Bool, Text, Enum, Temporal, Unsupported };

struct McpTypeInfo {
  McpTypeClass cls = McpTypeClass::Unsupported;
  bool nullable = false;
  // String and FixedString: LIKE works.
  bool like_ok = false;
  // AggregateFunction(...): a binary state that is no use as a value.
  bool aggregate_state = false;
};
McpTypeInfo mcp_classify_type(std::string_view clickhouse_type);

struct McpColumn {
  std::string name;
  std::string type;
  // Average uncompressed bytes per row when the table reports it, or 0.
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

// `query.limit` is written as is (the caller clamps it and adds the probe row).
McpBuiltQuery mcp_build_table_query(const McpTableQuery& query, const std::vector<McpColumn>& real_columns);

} // namespace chdash
