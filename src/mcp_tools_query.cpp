#include "mcp_tools_units.hpp"

#include "mcp_scope.hpp"
#include "mcp_sql.hpp"
#include "sql_literal.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace chdash {
namespace mcp_tools {

// ---- query_table ---------------------------------------------------------------------------------------

namespace {

McpScalar scalar_of(const rapidjson::Value& v, const std::string& where) {
  McpScalar out;
  if (v.IsNull()) {
    out.kind = McpScalar::Kind::Null;
  } else if (v.IsBool()) {
    out.kind = McpScalar::Kind::Bool;
    out.boolean = v.GetBool();
    out.text = v.GetBool() ? "1" : "0";
  } else if (v.IsInt64()) {
    out.kind = McpScalar::Kind::Integer;
    out.text = std::to_string(v.GetInt64());
  } else if (v.IsUint64()) {
    out.kind = McpScalar::Kind::Integer;
    out.text = std::to_string(v.GetUint64());
  } else if (v.IsDouble()) {
    const double d = v.GetDouble();
    if (!std::isfinite(d)) fail("invalid_argument", where + " must be a finite number");
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.17g", d);
    out.kind = McpScalar::Kind::Float;
    out.text = buf;
  } else if (v.IsString()) {
    out.kind = McpScalar::Kind::String;
    out.text.assign(v.GetString(), v.GetStringLength());
  } else {
    fail("invalid_argument", where + " must be a string, a number or a boolean");
  }
  return out;
}

McpFilter filter_of(const rapidjson::Value& item, size_t index) {
  const std::string at = "filters[" + std::to_string(index) + "]";
  if (!item.IsObject()) fail("invalid_argument", at + " must be an object {column, op, value}");
  McpFilter filter;
  for (const auto& member : item.GetObject()) {
    const std::string_view name(member.name.GetString(), member.name.GetStringLength());
    if (name == "column") {
      if (!member.value.IsString()) fail("invalid_argument", at + ".column must be a string");
      filter.column.assign(member.value.GetString(), member.value.GetStringLength());
    } else if (name == "op") {
      if (!member.value.IsString()) fail("invalid_argument", at + ".op must be a string");
      filter.op.assign(member.value.GetString(), member.value.GetStringLength());
      for (auto& c : filter.op) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
      }
    } else if (name == "value") {
      if (member.value.IsArray()) {
        filter.value_is_array = true;
        if (member.value.Size() > kMcpMaxInValues) fail("invalid_argument", at + ".value has too many values");
        for (const auto& element : member.value.GetArray()) filter.values.push_back(scalar_of(element, at + ".value"));
      } else {
        filter.values.push_back(scalar_of(member.value, at + ".value"));
      }
    } else {
      fail("invalid_argument", at + " has the unknown field " + std::string(name));
    }
  }
  if (filter.column.empty()) fail("invalid_argument", at + ".column is required");
  if (filter.op.empty()) fail("invalid_argument", at + ".op is required");
  return filter;
}

}  // namespace

std::string tool_query_table(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "database", "table", "columns", "filters", "order_by", "limit"});
  resolve_host(ctx, args);
  McpTableQuery query;
  query.database = req_string(args, "database", 256);
  query.table = req_string(args, "table", 256);
  check_table_scope(ctx, query.database, query.table);

  if (const auto it = args.FindMember("columns"); it != args.MemberEnd() && !it->value.IsNull()) {
    if (!it->value.IsArray()) fail("invalid_argument", "columns must be an array of column names");
    for (const auto& item : it->value.GetArray()) {
      if (!item.IsString()) fail("invalid_argument", "columns must be an array of column names");
      query.columns.emplace_back(item.GetString(), item.GetStringLength());
    }
  }
  if (const auto it = args.FindMember("filters"); it != args.MemberEnd() && !it->value.IsNull()) {
    if (!it->value.IsArray()) fail("invalid_argument", "filters must be an array");
    size_t index = 0;
    for (const auto& item : it->value.GetArray()) query.filters.push_back(filter_of(item, index++));
  }
  if (const auto it = args.FindMember("order_by"); it != args.MemberEnd() && !it->value.IsNull()) {
    if (!it->value.IsArray()) fail("invalid_argument", "order_by must be an array");
    for (const auto& item : it->value.GetArray()) {
      McpOrderBy order;
      if (item.IsString()) {
        order.column.assign(item.GetString(), item.GetStringLength());
      } else if (item.IsObject()) {
        for (const auto& member : item.GetObject()) {
          const std::string_view name(member.name.GetString(), member.name.GetStringLength());
          if (name == "column" && member.value.IsString()) {
            order.column.assign(member.value.GetString(), member.value.GetStringLength());
          } else if (name == "direction" && member.value.IsString()) {
            std::string direction(member.value.GetString(), member.value.GetStringLength());
            for (auto& c : direction) {
              if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
            }
            if (direction != "asc" && direction != "desc") fail("invalid_argument", "order_by direction must be asc or desc");
            order.descending = direction == "desc";
          } else {
            fail("invalid_argument", "order_by entries are {column, direction}");
          }
        }
      } else {
        fail("invalid_argument", "order_by entries are {column, direction}");
      }
      if (order.column.empty()) fail("invalid_argument", "order_by.column is required");
      query.order_by.push_back(std::move(order));
    }
  }
  int64_t limit = 100;
  if (const auto it = args.FindMember("limit"); it != args.MemberEnd() && !it->value.IsNull()) {
    if (!it->value.IsInt64() || it->value.GetInt64() < 1) fail("invalid_argument", "limit must be a whole number of 1 or more");
    limit = it->value.GetInt64();
  }
  // Read one more row, above the cap. The answer can then say that rows were cut.
  const bool clamped = limit > ctx.max_rows;
  query.limit = clamped ? ctx.max_rows + 1 : limit;

  // The real columns of the table (and how wide they are on average).
  const McpDbResult described = run(ctx,
      "SELECT name, type, data_uncompressed_bytes, (SELECT total_rows FROM system.tables WHERE " +
          describe_table_filter(query.database, query.table, "name") + " AND NOT is_temporary LIMIT 1) AS rows_in_table "
      "FROM system.columns WHERE " + describe_table_filter(query.database, query.table, "table") + " ORDER BY position",
      ctx.schema_limits);
  if (described.rows.empty()) fail("not_found", "the table " + query.database + "." + query.table + " does not exist or is not visible");
  std::vector<McpColumn> real;
  for (const auto& row : described.rows) {
    if (row.size() < 4) continue;
    McpColumn column;
    column.name = cell_text(row[0]);
    column.type = cell_text(row[1]);
    const uint64_t bytes = cell_u64(row[2]);
    const uint64_t total = cell_u64(row[3]);
    column.avg_row_bytes = total > 0 ? bytes / total : 0;
    real.push_back(std::move(column));
  }

  const McpBuiltQuery built = mcp_build_table_query(query, real);
  if (!built.ok) fail(built.error, built.argument.empty() ? built.message : built.argument + ": " + built.message);
  McpDbResult res = run(ctx, built.sql, ctx.user_limits);
  // A Bool column travels as UInt8 on the native wire. Return it as true / false.
  for (size_t i = 0; i < res.columns.size() && i < built.selected.size(); ++i) {
    for (const auto& column : real) {
      if (column.name != built.selected[i] || mcp_classify_type(column.type).cls != McpTypeClass::Bool) continue;
      res.columns[i].type = column.type;
      for (auto& row : res.rows) {
        if (i < row.size() && (row[i] == "0" || row[i] == "1")) row[i] = row[i] == "1" ? "true" : "false";
      }
    }
  }

  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("host"); put(w, ctx.host);
  w.Key("database"); put(w, query.database);
  w.Key("table"); put(w, query.table);
  write_columns(w, res);
  write_rows(w, res);
  w.Key("limit"); w.Int64(std::min(limit, ctx.max_rows));
  w.Key("truncated"); w.Bool(res.truncated);
  if (!built.omitted.empty()) {
    w.Key("omitted_columns");
    w.StartArray();
    for (const auto& column : built.omitted) {
      w.StartObject();
      w.Key("name"); put(w, column.name);
      w.Key("type"); put(w, column.type);
      w.Key("reason"); put(w, column.reason);
      w.EndObject();
    }
    w.EndArray();
  }
  w.Key("elapsed_ms"); w.Int64(res.elapsed_ms);
  w.EndObject();
  ctx.rows_out = res.rows.size();
  return finish(sb);
}

// ---- run_query and explain_query -----------------------------------------------------------------------------

namespace {

McpSqlScan scan_or_fail(Ctx& ctx, const std::string& sql, const std::vector<std::string>& allowed) {
  if (static_cast<int64_t>(sql.size()) > ctx.config.max_sql_bytes) {
    fail("sql_too_large", "the SQL is longer than " + std::to_string(ctx.config.max_sql_bytes) + " bytes");
  }
  McpSqlScan scan = mcp_scan_single_statement(sql, allowed);
  if (!scan.ok) fail(scan.error, scan.message);
  return scan;
}

}  // namespace

std::string tool_run_query(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "sql"});
  resolve_host(ctx, args);
  const std::string sql = req_string(args, "sql", 4 * 1024 * 1024);
  const McpSqlScan scan = scan_or_fail(ctx, sql, {"SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN"});
  const McpDbResult res = run(ctx, scan.statement, ctx.user_limits);

  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("host"); put(w, ctx.host);
  write_columns(w, res);
  write_rows(w, res);
  w.Key("truncated"); w.Bool(res.truncated);
  w.Key("elapsed_ms"); w.Int64(res.elapsed_ms);
  w.EndObject();
  ctx.rows_out = res.rows.size();
  return finish(sb);
}

std::string tool_explain_query(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "sql", "type", "indexes", "actions"});
  resolve_host(ctx, args);
  const std::string sql = req_string(args, "sql", 4 * 1024 * 1024);
  std::string type = opt_string(args, "type", 32).value_or("plan");
  for (auto& c : type) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  if (type.empty()) type = "plan";
  static const std::vector<std::string> kinds = {"plan", "pipeline", "ast", "syntax", "estimate"};
  if (std::find(kinds.begin(), kinds.end(), type) == kinds.end()) {
    fail("invalid_argument", "type must be plan, pipeline, ast, syntax or estimate");
  }
  const bool indexes = opt_bool(args, "indexes").value_or(false);
  const bool actions = opt_bool(args, "actions").value_or(false);
  const McpSqlScan scan = scan_or_fail(ctx, sql, {"SELECT", "WITH"});

  std::string explain = "EXPLAIN ";
  for (const char c : type) explain.push_back(static_cast<char>(c - 'a' + 'A'));
  if (type == "plan" && (indexes || actions)) {
    explain += std::string(" ") + (indexes ? "indexes = 1" : "") + (indexes && actions ? ", " : "") + (actions ? "actions = 1" : "");
  }
  explain += " " + scan.statement;
  const McpDbResult res = run(ctx, explain, ctx.user_limits);

  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("host"); put(w, ctx.host);
  w.Key("type"); put(w, type);
  if (res.columns.size() == 1) {
    // ClickHouse writes the plan partly from the definitions of views and columns (third-party text): the lines are untrusted.
    w.Key("untrusted");
    w.StartObject();
    w.Key("lines");
    w.StartArray();
    for (const auto& row : res.rows) put(w, row.empty() ? std::string() : cell_text(row[0]));
    w.EndArray();
    w.EndObject();
    w.Key("row_count"); w.Uint64(res.rows.size());
  } else {
    write_columns(w, res);
    write_rows(w, res);
  }
  w.Key("truncated"); w.Bool(res.truncated);
  w.Key("elapsed_ms"); w.Int64(res.elapsed_ms);
  w.EndObject();
  ctx.rows_out = res.rows.size();
  return finish(sb);
}

}  // namespace mcp_tools
}  // namespace chdash
