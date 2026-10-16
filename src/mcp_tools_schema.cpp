#include "mcp_tools_units.hpp"

#include "mcp_scope.hpp"
#include "sql_literal.hpp"

#include <algorithm>

namespace chdash {
namespace mcp_tools {

// ---- the tools ---------------------------------------------------------------------------------------

std::string tool_list_hosts(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {});
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("hosts");
  w.StartArray();
  const auto names = key_hosts(ctx.key, ctx.config);
  for (const auto& name : names) {
    std::string label = name;
    for (const auto& host : ctx.config.hosts) {
      if (host.name == name) label = host.label;
    }
    w.StartObject();
    w.Key("name"); put(w, name);
    w.Key("label"); put(w, label);
    w.Key("healthy");
    const auto healthy = ctx.db.host_healthy(name);
    if (healthy) w.Bool(*healthy);
    else w.Null();
    w.EndObject();
  }
  w.EndArray();
  w.Key("count"); w.Uint64(names.size());
  w.EndObject();
  return finish(sb);
}

std::string tool_list_databases(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "filter"});
  resolve_host(ctx, args);
  const std::string filter = opt_string(args, "filter", 256).value_or("");
  std::string sql = "SELECT name, engine, comment FROM system.databases";
  if (!mcp_scope_all_data(ctx.key.databases)) {
    const auto conditions = glob_conditions("name", mcp_scope_database_globs(ctx.key.databases));
    sql += conditions.empty() ? " WHERE 0" : " WHERE " + conditions;
  }
  sql += " ORDER BY name";
  const McpDbResult res = run(ctx, sql, ctx.schema_limits);

  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("host"); put(w, ctx.host);
  w.Key("databases");
  w.StartArray();
  uint64_t count = 0;
  for (const auto& row : res.rows) {
    if (row.size() < 3) continue;
    const std::string name = cell_text(row[0]);
    if (!mcp_scope_database_visible(ctx.key.databases, name)) continue;
    if (!filter.empty() && !mcp_glob_match(filter, name)) continue;
    w.StartObject();
    w.Key("name"); put(w, name);
    w.Key("engine"); put(w, cell_text(row[1]));
    // A comment is text of the users of the database (contract 5.2).
    w.Key("untrusted");
    w.StartObject();
    w.Key("comment"); put(w, cell_text(row[2]));
    w.EndObject();
    w.EndObject();
    ++count;
  }
  w.EndArray();
  w.Key("count"); w.Uint64(count);
  w.Key("truncated"); w.Bool(res.truncated);
  w.EndObject();
  ctx.rows_out = count;
  return finish(sb);
}

std::string tool_list_tables(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "database", "filter"});
  resolve_host(ctx, args);
  const auto database = opt_string(args, "database", 256);
  const std::string filter = opt_string(args, "filter", 256).value_or("");
  // A database out of the scope of the key looks like a database that does not exist: an empty list (contract 3.7).
  const bool out_of_scope = database && !database->empty() && !mcp_scope_database_visible(ctx.key.databases, *database);
  std::string sql = "SELECT database, name, engine, total_rows, total_bytes, comment FROM system.tables WHERE NOT is_temporary";
  if (database && !database->empty()) {
    sql += " AND database = " + sql::quote_string(*database);
  } else if (!mcp_scope_all_data(ctx.key.databases)) {
    const auto conditions = glob_conditions("database", mcp_scope_database_globs(ctx.key.databases));
    sql += conditions.empty() ? " AND 0" : " AND (" + conditions + ")";
  }
  if (!filter.empty()) sql += " AND name LIKE " + sql::quote_string(mcp_glob_to_like(filter));
  sql += " ORDER BY database, name";
  const McpDbResult res = out_of_scope ? McpDbResult{} : run(ctx, sql, ctx.schema_limits);

  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("host"); put(w, ctx.host);
  w.Key("tables");
  w.StartArray();
  uint64_t count = 0;
  bool cut = res.truncated;
  for (const auto& row : res.rows) {
    if (row.size() < 6) continue;
    const std::string db_name = cell_text(row[0]);
    const std::string table = cell_text(row[1]);
    if (!mcp_scope_table_allowed(ctx.key.databases, db_name, table)) continue;
    if (!filter.empty() && !mcp_glob_match(filter, table)) continue;
    if (count >= kMcpSchemaOutputRows) {
      cut = true;
      break;
    }
    w.StartObject();
    w.Key("database"); put(w, db_name);
    w.Key("name"); put(w, table);
    w.Key("engine"); put(w, cell_text(row[2]));
    w.Key("total_rows"); put_cell(w, row[3]);
    w.Key("total_bytes"); put_cell(w, row[4]);
    w.Key("untrusted");
    w.StartObject();
    w.Key("comment"); put(w, cell_text(row[5]));
    w.EndObject();
    w.EndObject();
    ++count;
  }
  w.EndArray();
  w.Key("count"); w.Uint64(count);
  w.Key("truncated"); w.Bool(cut);
  if (cut) {
    w.Key("hint");
    w.String("narrow the list with database or filter");
  }
  w.EndObject();
  ctx.rows_out = count;
  return finish(sb);
}

std::string tool_describe_table(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "database", "table"});
  resolve_host(ctx, args);
  const std::string database = req_string(args, "database", 256);
  const std::string table = req_string(args, "table", 256);
  check_table_scope(ctx, database, table);

  const McpDbResult info = run(ctx,
      "SELECT engine, create_table_query, partition_key, sorting_key, primary_key, sampling_key, total_rows, total_bytes, comment "
      "FROM system.tables WHERE " + describe_table_filter(database, table, "name") + " AND NOT is_temporary LIMIT 1",
      ctx.schema_limits);
  if (info.rows.empty() || info.rows[0].size() < 9) fail("not_found", "the table " + database + "." + table + " does not exist or is not visible");
  const McpDbResult columns = run(ctx,
      "SELECT name, type, default_kind, default_expression, comment, is_in_partition_key, is_in_sorting_key, "
      "is_in_primary_key, is_in_sampling_key FROM system.columns WHERE " + describe_table_filter(database, table, "table") +
      " ORDER BY position",
      ctx.schema_limits);

  const auto& row = info.rows[0];
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("host"); put(w, ctx.host);
  w.Key("database"); put(w, database);
  w.Key("table"); put(w, table);
  w.Key("engine"); put(w, cell_text(row[0]));
  std::string create = cell_text(row[1]);
  const bool create_cut = create.size() > kMcpCreateQueryMaxBytes;
  if (create_cut) create.resize(kMcpCreateQueryMaxBytes);
  if (create_cut) {
    w.Key("create_table_query_truncated"); w.Bool(true);
  }
  // The CREATE statement and the comment hold text of the users of the database (contract 5.2).
  w.Key("untrusted");
  w.StartObject();
  w.Key("create_table_query"); put(w, create);
  w.Key("comment"); put(w, cell_text(row[8]));
  w.EndObject();
  w.Key("partition_key"); put(w, cell_text(row[2]));
  w.Key("sorting_key"); put(w, cell_text(row[3]));
  w.Key("primary_key"); put(w, cell_text(row[4]));
  w.Key("sampling_key"); put(w, cell_text(row[5]));
  w.Key("total_rows"); put_cell(w, row[6]);
  w.Key("total_bytes"); put_cell(w, row[7]);
  w.Key("columns");
  w.StartArray();
  for (const auto& column : columns.rows) {
    if (column.size() < 9) continue;
    w.StartObject();
    w.Key("name"); put(w, cell_text(column[0]));
    w.Key("type"); put(w, cell_text(column[1]));
    w.Key("default_kind"); put(w, cell_text(column[2]));
    w.Key("untrusted");
    w.StartObject();
    w.Key("default_expression"); put(w, cell_text(column[3]));
    w.Key("comment"); put(w, cell_text(column[4]));
    w.EndObject();
    w.Key("in_partition_key"); w.Bool(cell_u64(column[5]) != 0);
    w.Key("in_sorting_key"); w.Bool(cell_u64(column[6]) != 0);
    w.Key("in_primary_key"); w.Bool(cell_u64(column[7]) != 0);
    w.Key("in_sampling_key"); w.Bool(cell_u64(column[8]) != 0);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  ctx.rows_out = columns.rows.size();
  return finish(sb);
}

}  // namespace mcp_tools
}  // namespace chdash
