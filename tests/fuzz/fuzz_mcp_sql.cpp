// libFuzzer target: the SQL guard rails of the MCP tools (src/mcp_sql.cpp).
//
//   - mcp_scan_single_statement on any text, with the word lists of run_query and explain_query. A statement
//     it accepts is accepted again, alone, with the same first word (it has no second statement in it).
//   - mcp_quote_string / mcp_quote_identifier: a quoted value never ends the statement or opens a second one.
//   - mcp_build_table_query on fuzzed arguments and columns: the SELECT it builds passes the scan.
#include "mcp_sql.hpp"

#include <fuzzer/FuzzedDataProvider.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

const std::vector<std::string> kRunQuery = {"SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN"};
const std::vector<std::string> kSelect = {"SELECT"};

const char* const kTypes[] = {
    "UInt64", "Int32", "Float64", "Decimal(18, 4)", "Bool", "String", "FixedString(8)", "Nullable(String)",
    "LowCardinality(Nullable(String))", "Enum8('a' = 1, 'b' = 2)", "DateTime64(3, 'UTC')", "Date", "UUID",
    "Array(String)", "Map(String, UInt64)", "AggregateFunction(uniq, UInt64)", "Tuple(a UInt8, b String)", "IPv4",
};
const char* const kOps[] = {"=", "!=", "<", "<=", ">", ">=", "like", "not_like", "ilike", "in", "not_in", "is_null",
                            "is_not_null", "~", ""};

chdash::McpScalar scalar(FuzzedDataProvider& in) {
  chdash::McpScalar value;
  switch (in.ConsumeIntegralInRange<int>(0, 4)) {
    case 0: value.kind = chdash::McpScalar::Kind::Null; break;
    case 1:
      value.kind = chdash::McpScalar::Kind::Bool;
      value.boolean = in.ConsumeBool();
      value.text = value.boolean ? "1" : "0";
      break;
    case 2:
      value.kind = chdash::McpScalar::Kind::Integer;
      value.text = in.ConsumeBool() ? std::to_string(in.ConsumeIntegral<int64_t>()) : std::to_string(in.ConsumeIntegral<uint64_t>());
      break;
    case 3: {
      // A JSON number: finite, written the way the tool writes it.
      value.kind = chdash::McpScalar::Kind::Float;
      const double d = static_cast<double>(in.ConsumeIntegral<int32_t>()) / 1024.0;
      char buf[64];
      std::snprintf(buf, sizeof buf, "%.17g", d);
      value.text = buf;
      break;
    }
    default:
      value.kind = chdash::McpScalar::Kind::String;
      value.text = in.ConsumeRandomLengthString(64);
      break;
  }
  return value;
}

void check_scan(const std::string& sql, const std::vector<std::string>& words) {
  const chdash::McpSqlScan scan = chdash::mcp_scan_single_statement(sql, words);
  if (!scan.ok) return;
  const chdash::McpSqlScan again = chdash::mcp_scan_single_statement(scan.statement, words);
  if (!again.ok || again.first_keyword != scan.first_keyword || again.statement != scan.statement) std::abort();
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  FuzzedDataProvider in(data, size);
  const int mode = in.ConsumeIntegralInRange<int>(0, 3);

  if (mode == 0) {
    const std::string sql = in.ConsumeRemainingBytesAsString();
    check_scan(sql, kRunQuery);
    check_scan(sql, {"EXPLAIN"});
    (void)chdash::mcp_classify_type(sql);
    return 0;
  }

  if (mode == 1) {
    const std::string text = in.ConsumeRemainingBytesAsString();
    const std::string literal = "SELECT " + chdash::mcp_quote_string(text) + " AS v";
    const chdash::McpSqlScan scan = chdash::mcp_scan_single_statement(literal, kSelect);
    if (!scan.ok || scan.statement != literal) std::abort();
    if (text.find('\0') == std::string::npos) {
      const std::string name = "SELECT 1 AS " + chdash::mcp_quote_identifier(text);
      const chdash::McpSqlScan named = chdash::mcp_scan_single_statement(name, kSelect);
      if (!named.ok || named.statement != name) std::abort();
    }
    return 0;
  }

  // query_table: up to 6 columns of the table, then the arguments.
  std::vector<chdash::McpColumn> columns;
  const size_t column_count = in.ConsumeIntegralInRange<size_t>(1, 6);
  for (size_t i = 0; i < column_count; ++i) {
    chdash::McpColumn column;
    column.name = in.ConsumeRandomLengthString(16);
    if (column.name.find('\0') != std::string::npos) column.name = "c" + std::to_string(i);
    column.type = kTypes[in.ConsumeIntegralInRange<size_t>(0, sizeof kTypes / sizeof kTypes[0] - 1)];
    column.avg_row_bytes = in.ConsumeIntegralInRange<uint64_t>(0, 4096);
    columns.push_back(column);
  }
  const auto some_column = [&]() -> std::string {
    if (in.ConsumeIntegralInRange<int>(0, 7) == 0) return in.ConsumeRandomLengthString(8);
    return columns[in.ConsumeIntegralInRange<size_t>(0, columns.size() - 1)].name;
  };
  chdash::McpTableQuery query;
  query.database = in.ConsumeRandomLengthString(16);
  query.table = in.ConsumeRandomLengthString(16);
  if (query.database.find('\0') != std::string::npos || query.table.find('\0') != std::string::npos) return 0;
  const size_t selected = in.ConsumeIntegralInRange<size_t>(0, 4);
  for (size_t i = 0; i < selected; ++i) query.columns.push_back(some_column());
  const size_t filters = in.ConsumeIntegralInRange<size_t>(0, 4);
  for (size_t i = 0; i < filters; ++i) {
    chdash::McpFilter filter;
    filter.column = some_column();
    filter.op = kOps[in.ConsumeIntegralInRange<size_t>(0, sizeof kOps / sizeof kOps[0] - 1)];
    filter.value_is_array = in.ConsumeBool();
    const size_t values = in.ConsumeIntegralInRange<size_t>(0, 4);
    for (size_t k = 0; k < values; ++k) filter.values.push_back(scalar(in));
    query.filters.push_back(filter);
  }
  const size_t orders = in.ConsumeIntegralInRange<size_t>(0, 3);
  for (size_t i = 0; i < orders; ++i) query.order_by.push_back({some_column(), in.ConsumeBool()});
  query.limit = in.ConsumeIntegralInRange<int64_t>(0, 1000001);

  const chdash::McpBuiltQuery built = chdash::mcp_build_table_query(query, columns);
  if (!built.ok) return 0;
  const chdash::McpSqlScan scan = chdash::mcp_scan_single_statement(built.sql, kSelect);
  if (!scan.ok || scan.statement != built.sql) std::abort();
  return 0;
}
