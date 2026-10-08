#include "mcp_tools.hpp"

#include "mcp_scope.hpp"
#include "mcp_sql.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <initializer_list>

namespace chdash {
namespace {

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

struct ToolFailure {
  std::string code;
  std::string message;
};

[[noreturn]] void fail(const std::string& code, const std::string& message) { throw ToolFailure{code, message}; }

void put(Writer& w, std::string_view s) { w.String(s.data(), static_cast<rapidjson::SizeType>(s.size())); }

// ---- arguments ----------------------------------------------------------------------------

void reject_unknown(const rapidjson::Value& args, std::initializer_list<const char*> allowed) {
  for (const auto& member : args.GetObject()) {
    const std::string_view name(member.name.GetString(), member.name.GetStringLength());
    const bool known = std::any_of(allowed.begin(), allowed.end(), [&](const char* a) { return name == a; });
    if (!known) fail("invalid_argument", "unknown argument " + std::string(name));
  }
}

std::optional<std::string> opt_string(const rapidjson::Value& args, const char* name, size_t max_bytes = 4096) {
  const auto it = args.FindMember(name);
  if (it == args.MemberEnd() || it->value.IsNull()) return std::nullopt;
  if (!it->value.IsString()) fail("invalid_argument", std::string(name) + " must be a string");
  if (it->value.GetStringLength() > max_bytes) fail("invalid_argument", std::string(name) + " is too long");
  return std::string(it->value.GetString(), it->value.GetStringLength());
}

std::string req_string(const rapidjson::Value& args, const char* name, size_t max_bytes = 4096) {
  auto value = opt_string(args, name, max_bytes);
  if (!value || value->empty()) fail("invalid_argument", std::string(name) + " is required");
  return *value;
}

std::optional<bool> opt_bool(const rapidjson::Value& args, const char* name) {
  const auto it = args.FindMember(name);
  if (it == args.MemberEnd() || it->value.IsNull()) return std::nullopt;
  if (!it->value.IsBool()) fail("invalid_argument", std::string(name) + " must be true or false");
  return it->value.GetBool();
}

// ---- the call context ------------------------------------------------------------------------

struct Ctx {
  const McpKey& key;
  const McpToolsConfig& config;
  McpDatabase& db;
  std::string host;
  int64_t max_rows = 0;
  McpDbLimits user_limits;
  McpDbLimits schema_limits;
  uint64_t rows_out = 0;
};

std::vector<std::string> key_hosts(const McpKey& key, const McpToolsConfig& config) {
  std::vector<std::string> available;
  for (const auto& host : config.hosts) available.push_back(host.name);
  return mcp_scope_hosts(key.hosts, available);
}

void resolve_host(Ctx& ctx, const rapidjson::Value& args) {
  const auto names = key_hosts(ctx.key, ctx.config);
  const auto asked = opt_string(args, "host", 256);
  if (asked && !asked->empty()) {
    if (std::find(names.begin(), names.end(), *asked) == names.end()) {
      fail("host_not_allowed", "this key cannot use the host " + *asked + "; call list_hosts");
    }
    ctx.host = *asked;
    return;
  }
  if (names.size() == 1) {
    ctx.host = names.front();
    return;
  }
  if (names.empty()) fail("no_host", "this key has no host that MCP can reach");
  std::string list;
  for (const auto& name : names) list += (list.empty() ? "" : ", ") + name;
  fail("host_required", "this key has several hosts; pass host, one of: " + list);
}

Ctx make_ctx(const McpKey& key, const McpToolsConfig& config, McpDatabase& db) {
  Ctx ctx{key, config, db, "", 0, {}, {}, 0};
  ctx.max_rows = config.max_rows;
  if (key.max_rows) ctx.max_rows = std::min(ctx.max_rows, *key.max_rows);
  int64_t timeout = config.query_timeout_seconds;
  if (key.timeout_seconds) timeout = std::min(timeout, *key.timeout_seconds);
  ctx.user_limits.max_rows = ctx.max_rows;
  ctx.user_limits.max_bytes = config.max_result_bytes;
  ctx.user_limits.timeout_seconds = timeout;
  ctx.user_limits.max_memory_bytes = config.max_memory_bytes;
  ctx.user_limits.max_rows_to_read = config.max_rows_to_read;
  ctx.user_limits.key_id = key.id;
  // Schema tools: the key's row cap does not cut them (the scope filters after the read).
  ctx.schema_limits = ctx.user_limits;
  ctx.schema_limits.max_rows = kMcpSchemaReadRows;
  ctx.schema_limits.max_bytes = std::max<int64_t>(config.max_result_bytes, kMcpSchemaReadBytes);
  return ctx;
}

McpDbResult run(Ctx& ctx, const std::string& sql, const McpDbLimits& limits) {
  try {
    return ctx.db.run(ctx.host, sql, limits);
  } catch (const McpDbError& error) {
    std::string message = error.what();
    if (message.size() > 1500) message.resize(1500);
    fail(error.code(), message);
  }
}

// ---- cells ---------------------------------------------------------------------------------------

std::string cell_text(const std::string& cell) {
  if (cell.empty() || cell == "null") return {};
  if (cell.front() != '"') return cell;
  rapidjson::Document doc;
  doc.Parse<rapidjson::kParseValidateEncodingFlag>(cell.data(), cell.size());
  if (doc.HasParseError() || !doc.IsString()) return cell;
  return std::string(doc.GetString(), doc.GetStringLength());
}

uint64_t cell_u64(const std::string& cell) {
  const std::string text = cell_text(cell);
  if (text.empty() || text.size() > 19) return 0;
  uint64_t v = 0;
  for (const char c : text) {
    if (c < '0' || c > '9') return 0;
    v = v * 10 + static_cast<uint64_t>(c - '0');
  }
  return v;
}

void put_cell(Writer& w, const std::string& cell) {
  if (cell.empty()) w.Null();
  else w.RawValue(cell.data(), cell.size(), rapidjson::kObjectType);
}

void write_columns(Writer& w, const McpDbResult& res) {
  w.Key("columns");
  w.StartArray();
  for (const auto& column : res.columns) {
    w.StartObject();
    w.Key("name"); put(w, column.name);
    w.Key("type"); put(w, column.type);
    w.EndObject();
  }
  w.EndArray();
}

void write_rows(Writer& w, const McpDbResult& res) {
  w.Key("rows");
  w.StartArray();
  for (const auto& row : res.rows) {
    w.StartArray();
    for (const auto& cell : row) put_cell(w, cell);
    w.EndArray();
  }
  w.EndArray();
  w.Key("row_count"); w.Uint64(res.rows.size());
}

std::string finish(rapidjson::StringBuffer& sb) { return std::string(sb.GetString(), sb.GetSize()); }

std::string glob_conditions(const char* column, const std::vector<std::string>& globs) {
  std::string out;
  for (const auto& glob : globs) {
    if (!out.empty()) out += " OR ";
    out += std::string(column) + " LIKE " + mcp_quote_string(mcp_glob_to_like(glob));
  }
  return out;
}

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
    w.Key("comment"); put(w, cell_text(row[2]));
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
  if (database && !database->empty() && !mcp_scope_database_visible(ctx.key.databases, *database)) {
    fail("database_not_allowed", "this key cannot see the database " + *database);
  }
  std::string sql = "SELECT database, name, engine, total_rows, total_bytes, comment FROM system.tables WHERE NOT is_temporary";
  if (database && !database->empty()) {
    sql += " AND database = " + mcp_quote_string(*database);
  } else if (!mcp_scope_all_data(ctx.key.databases)) {
    const auto conditions = glob_conditions("database", mcp_scope_database_globs(ctx.key.databases));
    sql += conditions.empty() ? " AND 0" : " AND (" + conditions + ")";
  }
  if (!filter.empty()) sql += " AND name LIKE " + mcp_quote_string(mcp_glob_to_like(filter));
  sql += " ORDER BY database, name";
  const McpDbResult res = run(ctx, sql, ctx.schema_limits);

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
    w.Key("comment"); put(w, cell_text(row[5]));
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

void check_table_scope(const Ctx& ctx, const std::string& database, const std::string& table) {
  if (!mcp_scope_table_allowed(ctx.key.databases, database, table)) {
    fail("table_not_allowed", "this key cannot read " + database + "." + table);
  }
}

std::string describe_table_filter(const std::string& database, const std::string& table, const char* table_column) {
  return "database = " + mcp_quote_string(database) + " AND " + table_column + " = " + mcp_quote_string(table);
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
  if (info.rows.empty() || info.rows[0].size() < 9) fail("table_not_found", "the table " + database + "." + table + " does not exist or is not visible");
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
  w.Key("create_table_query"); put(w, create);
  if (create_cut) {
    w.Key("create_table_query_truncated"); w.Bool(true);
  }
  w.Key("partition_key"); put(w, cell_text(row[2]));
  w.Key("sorting_key"); put(w, cell_text(row[3]));
  w.Key("primary_key"); put(w, cell_text(row[4]));
  w.Key("sampling_key"); put(w, cell_text(row[5]));
  w.Key("total_rows"); put_cell(w, row[6]);
  w.Key("total_bytes"); put_cell(w, row[7]);
  w.Key("comment"); put(w, cell_text(row[8]));
  w.Key("columns");
  w.StartArray();
  for (const auto& column : columns.rows) {
    if (column.size() < 9) continue;
    w.StartObject();
    w.Key("name"); put(w, cell_text(column[0]));
    w.Key("type"); put(w, cell_text(column[1]));
    w.Key("default_kind"); put(w, cell_text(column[2]));
    w.Key("default_expression"); put(w, cell_text(column[3]));
    w.Key("comment"); put(w, cell_text(column[4]));
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

// ---- query_table ---------------------------------------------------------------------------------------

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
  // Above the cap: ask for one more row, so the answer can say that rows were cut.
  const bool clamped = limit > ctx.max_rows;
  query.limit = clamped ? ctx.max_rows + 1 : limit;

  // The real columns of the table (and how wide they are on average).
  const McpDbResult described = run(ctx,
      "SELECT name, type, data_uncompressed_bytes, (SELECT total_rows FROM system.tables WHERE " +
          describe_table_filter(query.database, query.table, "name") + " AND NOT is_temporary LIMIT 1) AS rows_in_table "
      "FROM system.columns WHERE " + describe_table_filter(query.database, query.table, "table") + " ORDER BY position",
      ctx.schema_limits);
  if (described.rows.empty()) fail("table_not_found", "the table " + query.database + "." + query.table + " does not exist or is not visible");
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
  // A Bool column travels as UInt8 on the native wire: give it back as true / false.
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

McpSqlScan scan_or_fail(Ctx& ctx, const std::string& sql, const std::vector<std::string>& allowed) {
  if (static_cast<int64_t>(sql.size()) > ctx.config.max_sql_bytes) {
    fail("sql_too_large", "the SQL is longer than " + std::to_string(ctx.config.max_sql_bytes) + " bytes");
  }
  McpSqlScan scan = mcp_scan_single_statement(sql, allowed);
  if (!scan.ok) fail(scan.error, scan.message);
  return scan;
}

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
    w.Key("lines");
    w.StartArray();
    for (const auto& row : res.rows) put(w, row.empty() ? std::string() : cell_text(row[0]));
    w.EndArray();
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

} // namespace

McpToolOutcome McpTools::call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments,
                                   int64_t) {
  Ctx ctx = make_ctx(key, config_, db_);
  McpToolOutcome outcome;
  try {
    std::string json;
    if (tool == "list_hosts") json = tool_list_hosts(ctx, arguments);
    else if (tool == "list_databases") json = tool_list_databases(ctx, arguments);
    else if (tool == "list_tables") json = tool_list_tables(ctx, arguments);
    else if (tool == "describe_table") json = tool_describe_table(ctx, arguments);
    else if (tool == "query_table") json = tool_query_table(ctx, arguments);
    else if (tool == "run_query") json = tool_run_query(ctx, arguments);
    else if (tool == "explain_query") json = tool_explain_query(ctx, arguments);
    else return mcp_tool_error("unknown_tool", "unknown tool " + tool);
    outcome.json = std::move(json);
  } catch (const ToolFailure& failure) {
    outcome = mcp_tool_error(failure.code, failure.message);
  }
  outcome.host = ctx.host;
  outcome.rows = ctx.rows_out;
  return outcome;
}

} // namespace chdash
