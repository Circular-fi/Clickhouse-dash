#include "mcp_tools.hpp"

#include "mcp_api_tools.hpp"
#include "mcp_scope.hpp"
#include "mcp_sql.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <initializer_list>

namespace chdash {

std::vector<std::string> mcp_data_tables(const McpObservabilityConfig& config, unsigned reads) {
  std::vector<std::string> out;
  const auto add = [&](const std::string& database, const std::string& table) {
    if (!database.empty() && !table.empty()) out.push_back(database + "." + table);
  };
  if ((reads & kMcpReadsTraces) && config.traces) add(config.traces_database, config.traces_table);
  if ((reads & kMcpReadsLogs) && config.logs) add(config.logs_database, config.logs_table);
  if ((reads & kMcpReadsMetrics) && config.metrics) {
    for (const char* kind : {"gauge", "sum", "histogram"}) add(config.metrics_database, config.metrics_prefix + "_" + kind);
  }
  return out;
}

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
  McpApiClient* api = nullptr;
  std::string host;
  int64_t max_rows = 0;
  McpDbLimits user_limits;
  McpDbLimits schema_limits;
  // The same limits, for the OpenTelemetry tools: they run with the system user of the host, as the pages do.
  McpDbLimits system_limits;
  McpDbLimits system_schema_limits;
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
  Ctx ctx{key, config, db, nullptr, "", 0, {}, {}, {}, {}, 0};
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
  ctx.system_limits = ctx.user_limits;
  ctx.system_limits.as_system = true;
  ctx.system_schema_limits = ctx.schema_limits;
  ctx.system_schema_limits.as_system = true;
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

// ---- observability --------------------------------------------------------------------------------------
//
// Six simple tools on the OpenTelemetry tables of the ClickHouse exporter (traces, logs, metrics). ChDash
// writes the SQL, so the client needs none; every statement is bounded by a time window and a row limit, and
// reads only the tables that the key's data scope allows.

int64_t opt_int(const rapidjson::Value& args, const char* name, int64_t lo, int64_t hi, int64_t fallback) {
  const auto it = args.FindMember(name);
  if (it == args.MemberEnd() || it->value.IsNull()) return fallback;
  if (!it->value.IsInt64()) fail("invalid_argument", std::string(name) + " must be a whole number");
  const int64_t value = it->value.GetInt64();
  if (value < lo || value > hi) {
    fail("invalid_argument", std::string(name) + " must be between " + std::to_string(lo) + " and " + std::to_string(hi));
  }
  return value;
}

std::string qualified(const std::string& database, const std::string& table) {
  return mcp_quote_identifier(database) + "." + mcp_quote_identifier(table);
}

const McpObservabilityConfig& obs(const Ctx& ctx) { return ctx.config.observability; }

void need_traces(const Ctx& ctx) {
  if (!obs(ctx).traces) fail("not_enabled", "traces are not enabled in the ChDash configuration (traces { enabled = true })");
}

void need_logs(const Ctx& ctx) {
  if (!obs(ctx).logs) fail("not_enabled", "logs are not enabled in the ChDash configuration (logs { enabled = true })");
}

const char* const kMetricKinds[] = {"gauge", "sum", "histogram"};

std::string metric_table(const Ctx& ctx, const std::string& kind) { return obs(ctx).metrics_prefix + "_" + kind; }

void need_metrics(const Ctx& ctx) {
  if (!obs(ctx).metrics) fail("not_enabled", "metrics are not enabled in the ChDash configuration (metrics { enabled = true })");
}

// Minutes back from now, within what the configuration allows.
int64_t since_minutes(const Ctx& ctx, const rapidjson::Value& args) {
  return opt_int(args, "since_minutes", 1, std::max<int64_t>(1, obs(ctx).max_lookback_minutes), 60);
}

std::string window(const char* column, int64_t minutes) {
  return std::string(column) + " >= now() - INTERVAL " + std::to_string(minutes) + " MINUTE";
}

// Rows the client asked for (default `fallback`), never above the cap of the key.
int64_t wanted_rows(const Ctx& ctx, const rapidjson::Value& args, int64_t fallback) {
  return std::min(opt_int(args, "limit", 1, 1000000, fallback), ctx.max_rows);
}

bool hex_id(const std::string& text) {
  return text.size() == 32 && std::all_of(text.begin(), text.end(), [](char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  });
}

// An object for each row, its fields named by `names` (the SQL columns come in the same order).
void write_records(Writer& w, const char* key, const McpDbResult& res, const std::vector<const char*>& names, size_t keep) {
  w.Key(key);
  w.StartArray();
  size_t written = 0;
  for (const auto& row : res.rows) {
    if (written++ >= keep) break;
    w.StartObject();
    for (size_t i = 0; i < names.size() && i < row.size(); ++i) {
      w.Key(names[i]);
      put_cell(w, row[i]);
    }
    w.EndObject();
  }
  w.EndArray();
}

// The answer of a list: the rows kept, how many, and whether more existed than the limit.
std::string finish_records(Ctx& ctx, const McpDbResult& res, const char* key, const std::vector<const char*>& names, int64_t limit,
                           const std::function<void(Writer&)>& extra = nullptr) {
  const size_t keep = static_cast<size_t>(limit);
  const bool more = res.rows.size() > keep || res.truncated;
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("host"); put(w, ctx.host);
  if (extra) extra(w);
  write_records(w, key, res, names, keep);
  w.Key("count"); w.Uint64(std::min(res.rows.size(), keep));
  w.Key("truncated"); w.Bool(more);
  w.Key("elapsed_ms"); w.Int64(res.elapsed_ms);
  w.EndObject();
  ctx.rows_out = std::min(res.rows.size(), keep);
  return finish(sb);
}

std::string tool_list_services(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "since_minutes", "signal"});
  resolve_host(ctx, args);
  const std::string signal = opt_string(args, "signal", 16).value_or("traces");
  const int64_t minutes = since_minutes(ctx, args);
  std::string sql;
  std::vector<const char*> names;
  if (signal == "traces") {
    need_traces(ctx);
    sql = "SELECT ServiceName, count() AS spans, countIf(StatusCode = 'Error') AS errors, round(avg(Duration) / 1000000, 3) AS avg_ms FROM " +
          qualified(obs(ctx).traces_database, obs(ctx).traces_table) + " WHERE " + window("Timestamp", minutes) +
          " GROUP BY ServiceName ORDER BY spans DESC";
    names = {"service", "spans", "errors", "avg_ms"};
  } else if (signal == "logs") {
    need_logs(ctx);
    sql = "SELECT ServiceName, count() AS records, countIf(SeverityNumber >= 17) AS errors FROM " +
          qualified(obs(ctx).logs_database, obs(ctx).logs_table) + " WHERE " + window("Timestamp", minutes) +
          " GROUP BY ServiceName ORDER BY records DESC";
    names = {"service", "records", "errors"};
  } else {
    fail("invalid_argument", "signal must be traces or logs");
  }
  const int64_t limit = ctx.max_rows;
  const McpDbResult res = run(ctx, sql + " LIMIT " + std::to_string(limit + 1), ctx.system_limits);
  return finish_records(ctx, res, "services", names, limit, [&](Writer& w) {
    w.Key("signal"); put(w, signal);
    w.Key("since_minutes"); w.Int64(minutes);
  });
}

std::string tool_search_traces(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "service", "operation", "status", "min_duration_ms", "order", "since_minutes", "limit"});
  resolve_host(ctx, args);
  need_traces(ctx);
  const int64_t minutes = since_minutes(ctx, args);
  const int64_t limit = wanted_rows(ctx, args, 20);
  std::string where = window("Timestamp", minutes) + " AND ParentSpanId = ''";
  if (const auto service = opt_string(args, "service", 256); service && !service->empty()) {
    where += " AND ServiceName = " + mcp_quote_string(*service);
  }
  if (const auto operation = opt_string(args, "operation", 256); operation && !operation->empty()) {
    where += " AND positionCaseInsensitive(SpanName, " + mcp_quote_string(*operation) + ") > 0";
  }
  if (const auto status = opt_string(args, "status", 16); status && !status->empty()) {
    if (*status != "Error" && *status != "Ok" && *status != "Unset") fail("invalid_argument", "status must be Error, Ok or Unset");
    where += " AND StatusCode = " + mcp_quote_string(*status);
  }
  if (const auto it = args.FindMember("min_duration_ms"); it != args.MemberEnd() && !it->value.IsNull()) {
    if (!it->value.IsNumber() || it->value.GetDouble() < 0 || !std::isfinite(it->value.GetDouble())) {
      fail("invalid_argument", "min_duration_ms must be a number of 0 or more");
    }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.0f", it->value.GetDouble() * 1000000.0);
    where += std::string(" AND Duration >= ") + buf;
  }
  const std::string order = opt_string(args, "order", 16).value_or("recent");
  if (order != "recent" && order != "slowest") fail("invalid_argument", "order must be recent or slowest");
  const McpDbResult res = run(ctx,
      "SELECT TraceId, ServiceName, SpanName, toString(Timestamp) AS started, round(Duration / 1000000, 3) AS duration_ms, StatusCode FROM " +
          qualified(obs(ctx).traces_database, obs(ctx).traces_table) + " WHERE " + where + " ORDER BY " +
          (order == "slowest" ? "Duration DESC" : "Timestamp DESC") + " LIMIT " + std::to_string(limit + 1),
      ctx.system_limits);
  return finish_records(ctx, res, "traces", {"trace_id", "service", "operation", "started", "duration_ms", "status"}, limit,
                        [&](Writer& w) {
                          w.Key("since_minutes"); w.Int64(minutes);
                          w.Key("order"); put(w, order);
                        });
}

std::string tool_get_trace(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "trace_id"});
  resolve_host(ctx, args);
  need_traces(ctx);
  const std::string trace_id = req_string(args, "trace_id", 64);
  if (!hex_id(trace_id)) fail("invalid_argument", "trace_id must be 32 hexadecimal characters");
  const std::string table = qualified(obs(ctx).traces_database, obs(ctx).traces_table);

  // The window of the trace: from its index when the configuration has one, else the whole lookback.
  std::string range = window("Timestamp", std::max<int64_t>(1, obs(ctx).max_lookback_minutes));
  if (!obs(ctx).traces_index_table.empty()) {
    try {
      const McpDbResult bounds = run(ctx,
          "SELECT toString(min(Start)), toString(max(End)), count() FROM " + qualified(obs(ctx).traces_database, obs(ctx).traces_index_table) +
              " WHERE TraceId = " + mcp_quote_string(trace_id),
          ctx.system_schema_limits);
      if (!bounds.rows.empty() && bounds.rows[0].size() >= 3 && cell_u64(bounds.rows[0][2]) > 0) {
        range = "Timestamp >= parseDateTime64BestEffort(" + mcp_quote_string(cell_text(bounds.rows[0][0])) + ", 9) - INTERVAL 1 MINUTE AND " +
                "Timestamp <= parseDateTime64BestEffort(" + mcp_quote_string(cell_text(bounds.rows[0][1])) + ", 9) + INTERVAL 1 MINUTE";
      }
    } catch (const ToolFailure&) {
      // No usable index: the lookback window still bounds the read.
    }
  }
  const int64_t limit = ctx.max_rows;
  const McpDbResult res = run(ctx,
      "SELECT SpanId, ParentSpanId, ServiceName, SpanName, SpanKind, toString(Timestamp) AS started, round(Duration / 1000000, 3) AS duration_ms, "
      "StatusCode, StatusMessage FROM " + table + " WHERE TraceId = " + mcp_quote_string(trace_id) + " AND " + range +
          " ORDER BY Timestamp LIMIT " + std::to_string(limit + 1),
      ctx.system_limits);
  if (res.rows.empty()) fail("trace_not_found", "no span of the trace " + trace_id + " in the last " + std::to_string(obs(ctx).max_lookback_minutes) + " minutes");
  return finish_records(ctx, res, "spans", {"span_id", "parent_span_id", "service", "operation", "kind", "started", "duration_ms", "status", "status_message"}, limit,
                        [&](Writer& w) { w.Key("trace_id"); put(w, trace_id); });
}

std::string tool_search_logs(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "service", "severity", "contains", "trace_id", "since_minutes", "limit"});
  resolve_host(ctx, args);
  need_logs(ctx);
  const int64_t minutes = since_minutes(ctx, args);
  const int64_t limit = wanted_rows(ctx, args, 20);
  std::string where = window("Timestamp", minutes);
  if (const auto service = opt_string(args, "service", 256); service && !service->empty()) {
    where += " AND ServiceName = " + mcp_quote_string(*service);
  }
  if (const auto severity = opt_string(args, "severity", 16); severity && !severity->empty()) {
    static const std::pair<const char*, int> levels[] = {{"trace", 1}, {"debug", 5}, {"info", 9}, {"warn", 13}, {"error", 17}};
    int number = 0;
    for (const auto& level : levels) {
      if (*severity == level.first) number = level.second;
    }
    if (number == 0) fail("invalid_argument", "severity must be trace, debug, info, warn or error");
    where += " AND SeverityNumber >= " + std::to_string(number);
  }
  if (const auto text = opt_string(args, "contains", 512); text && !text->empty()) {
    where += " AND positionCaseInsensitive(Body, " + mcp_quote_string(*text) + ") > 0";
  }
  if (const auto trace = opt_string(args, "trace_id", 64); trace && !trace->empty()) {
    if (!hex_id(*trace)) fail("invalid_argument", "trace_id must be 32 hexadecimal characters");
    where += " AND TraceId = " + mcp_quote_string(*trace);
  }
  const McpDbResult res = run(ctx,
      "SELECT toString(Timestamp) AS time, ServiceName, SeverityText, SeverityNumber, TraceId, SpanId, substringUTF8(Body, 1, 2000) AS message FROM " +
          qualified(obs(ctx).logs_database, obs(ctx).logs_table) + " WHERE " + where + " ORDER BY Timestamp DESC LIMIT " + std::to_string(limit + 1),
      ctx.system_limits);
  return finish_records(ctx, res, "records", {"time", "service", "severity", "severity_number", "trace_id", "span_id", "message"}, limit,
                        [&](Writer& w) { w.Key("since_minutes"); w.Int64(minutes); });
}

std::string tool_list_metrics(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "service", "filter", "since_minutes"});
  resolve_host(ctx, args);
  need_metrics(ctx);
  const int64_t minutes = since_minutes(ctx, args);
  std::string where = window("TimeUnix", minutes);
  if (const auto service = opt_string(args, "service", 256); service && !service->empty()) {
    where += " AND ServiceName = " + mcp_quote_string(*service);
  }
  if (const auto filter = opt_string(args, "filter", 256); filter && !filter->empty()) {
    where += " AND MetricName LIKE " + mcp_quote_string(mcp_glob_to_like(*filter));
  }
  std::string sql;
  for (const char* kind : kMetricKinds) {
    if (!sql.empty()) sql += " UNION ALL ";
    sql += std::string("SELECT '") + kind + "' AS kind, MetricName, any(MetricUnit) AS unit, any(MetricDescription) AS description FROM " +
           qualified(obs(ctx).metrics_database, metric_table(ctx, kind)) + " WHERE " + where + " GROUP BY MetricName";
  }
  const int64_t limit = ctx.max_rows;
  const McpDbResult res = run(ctx, "SELECT * FROM (" + sql + ") ORDER BY MetricName, kind LIMIT " + std::to_string(limit + 1), ctx.system_limits);
  return finish_records(ctx, res, "metrics", {"kind", "name", "unit", "description"}, limit,
                        [&](Writer& w) { w.Key("since_minutes"); w.Int64(minutes); });
}

std::string tool_query_metric(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "metric", "service", "kind", "aggregation", "step_seconds", "since_minutes"});
  resolve_host(ctx, args);
  need_metrics(ctx);
  const std::string metric = req_string(args, "metric", 512);
  const int64_t minutes = since_minutes(ctx, args);
  std::string base = window("TimeUnix", minutes) + " AND MetricName = " + mcp_quote_string(metric);
  if (const auto service = opt_string(args, "service", 256); service && !service->empty()) {
    base += " AND ServiceName = " + mcp_quote_string(*service);
  }

  std::string kind = opt_string(args, "kind", 16).value_or("");
  if (!kind.empty() && kind != "gauge" && kind != "sum" && kind != "histogram") fail("invalid_argument", "kind must be gauge, sum or histogram");
  if (kind.empty()) {
    // The kind of the metric: the first table that has it in the window.
    for (const char* candidate : kMetricKinds) {
      const McpDbResult found = run(ctx,
          "SELECT 1 FROM " + qualified(obs(ctx).metrics_database, metric_table(ctx, candidate)) + " WHERE " + base + " LIMIT 1", ctx.system_schema_limits);
      if (!found.rows.empty()) {
        kind = candidate;
        break;
      }
    }
    if (kind.empty()) fail("metric_not_found", "no point of the metric " + metric + " in the last " + std::to_string(minutes) + " minutes; call list_metrics");
  }

  const std::string aggregation = opt_string(args, "aggregation", 16).value_or("avg");
  std::string value;
  if (kind == "histogram") {
    if (aggregation == "avg") value = "sum(Sum) / greatest(sum(Count), 1)";
    else if (aggregation == "sum") value = "sum(Sum)";
    else if (aggregation == "count") value = "sum(Count)";
    else fail("invalid_argument", "a histogram has the aggregations avg, sum and count");
  } else {
    if (aggregation == "avg") value = "avg(Value)";
    else if (aggregation == "min") value = "min(Value)";
    else if (aggregation == "max") value = "max(Value)";
    else if (aggregation == "sum") value = "sum(Value)";
    else if (aggregation == "last") value = "argMax(Value, TimeUnix)";
    else fail("invalid_argument", "a " + kind + " has the aggregations avg, min, max, sum and last");
  }
  const int64_t step = opt_int(args, "step_seconds", 1, minutes * 60, std::max<int64_t>(10, minutes * 60 / 100));
  const int64_t limit = ctx.max_rows;
  const McpDbResult res = run(ctx,
      "SELECT toString(toStartOfInterval(TimeUnix, INTERVAL " + std::to_string(step) + " SECOND)) AS time, round(" + value + ", 6) AS value, count() AS points FROM " +
          qualified(obs(ctx).metrics_database, metric_table(ctx, kind)) + " WHERE " + base + " GROUP BY time ORDER BY time LIMIT " + std::to_string(limit + 1),
      ctx.system_limits);
  return finish_records(ctx, res, "series", {"time", "value", "points"}, limit, [&](Writer& w) {
    w.Key("metric"); put(w, metric);
    w.Key("kind"); put(w, kind);
    w.Key("aggregation"); put(w, aggregation);
    w.Key("step_seconds"); w.Int64(step);
    w.Key("since_minutes"); w.Int64(minutes);
  });
}

// ---- API tools -----------------------------------------------------------------------------------------
//
// One wrapper for every tool of mcp_api_tools.cpp: it checks the arguments, calls the route of ChDash and hands
// the answer back. A tool that is added to that table needs nothing here.

bool plain_name(const std::string& name, size_t max) {
  return !name.empty() && name.size() <= max && std::all_of(name.begin(), name.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.';
  });
}

// A parameter value as the text of the query string: a string, a number or a boolean.
std::string param_text(const rapidjson::Value& v, const std::string& name) {
  if (v.IsString()) return std::string(v.GetString(), v.GetStringLength());
  if (v.IsBool()) return v.GetBool() ? "true" : "false";
  if (v.IsInt64()) return std::to_string(v.GetInt64());
  if (v.IsUint64()) return std::to_string(v.GetUint64());
  if (v.IsDouble() && std::isfinite(v.GetDouble())) {
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.15g", v.GetDouble());
    return buf;
  }
  fail("invalid_argument", "params." + name + " must be a string, a number, a boolean or a list of them");
}

// The data scope of the key for an API tool that reads one table (Table) or lists them (Catalog): the call names
// `database` (and `table`) in its params or its body. A name that is not a plain string is refused, never skipped:
// the API could read another value of a list than the one that was checked.
void check_api_scope(Ctx& ctx, const McpApiTool& api, const rapidjson::Value& args) {
  const bool post = std::string(api.method) == "POST";
  const auto holder = args.FindMember(post ? "body" : "params");
  const rapidjson::Value* object = holder != args.MemberEnd() && holder->value.IsObject() ? &holder->value : nullptr;
  const auto text = [&](const char* name, std::string* out) {
    out->clear();
    if (!object) return false;
    const auto it = object->FindMember(name);
    if (it == object->MemberEnd() || it->value.IsNull()) return false;
    if (!it->value.IsString()) fail("invalid_argument", std::string(name) + " must be a string");
    out->assign(it->value.GetString(), it->value.GetStringLength());
    return true;
  };
  std::string database;
  std::string table;
  const bool has_database = text("database", &database);
  const bool has_table = text("table", &table);
  if (api.scope == McpApiScope::Catalog) {
    if (has_database && !mcp_scope_database_visible(ctx.key.databases, database)) {
      fail("database_not_allowed", "this key cannot see the database " + database);
    }
    return;
  }
  if (!has_database || !has_table || database.empty() || table.empty()) {
    fail("invalid_argument", std::string(post ? "body" : "params") + ".database and " + (post ? "body" : "params") + ".table are required");
  }
  if (!mcp_scope_table_allowed(ctx.key.databases, database, table)) {
    fail("table_not_allowed", "this key cannot read " + database + "." + table);
  }
}

// The catalog of the Explorer, cut to what the key shows: the databases that a pattern names, the summary of a
// database only when the key reads all of it (a summary counts every table), and the tables that a pattern allows.
void cut_catalog(const McpKey& key, rapidjson::Document* doc) {
  const auto cut = [&](const char* name, const auto& keep) {
    const auto it = doc->FindMember(name);
    if (it == doc->MemberEnd() || !it->value.IsArray()) return;
    auto& list = it->value;
    for (auto item = list.Begin(); item != list.End();) item = keep(*item) ? item + 1 : list.Erase(item);
  };
  const auto field = [](const rapidjson::Value& object, const char* name) -> std::string {
    if (!object.IsObject()) return "";
    const auto it = object.FindMember(name);
    return it != object.MemberEnd() && it->value.IsString() ? std::string(it->value.GetString(), it->value.GetStringLength()) : "";
  };
  cut("databases", [&](const rapidjson::Value& item) { return item.IsString() && mcp_scope_database_visible(key.databases, item.GetString()); });
  cut("database_summaries", [&](const rapidjson::Value& item) { return mcp_scope_database_whole(key.databases, field(item, "name")); });
  cut("tables", [&](const rapidjson::Value& item) { return mcp_scope_table_allowed(key.databases, field(item, "database"), field(item, "name")); });
}

std::string tool_api(Ctx& ctx, const McpToolInfo& info, const rapidjson::Value& args) {
  const McpApiTool& api = *info.api;
  const bool post = std::string(api.method) == "POST";
  reject_unknown(args, post ? std::initializer_list<const char*>{"host", "body"} : std::initializer_list<const char*>{"host", "params"});
  resolve_host(ctx, args);
  if (api.scope == McpApiScope::Table || api.scope == McpApiScope::Catalog) check_api_scope(ctx, api, args);
  if (!ctx.api) fail("api_unavailable", "this server cannot call its own API");

  // The API serves the tool as the MCP user (mcp_identity.hpp): the host it names is the identity of the tool's family.
  const std::string api_host = mcp_api_host(ctx.host, mcp_api_identity(api));
  McpApiRequest request;
  request.method = api.method;
  request.path = api.path;
  request.timeout_seconds = ctx.user_limits.timeout_seconds;
  request.max_bytes = ctx.config.max_result_bytes;

  if (const auto it = args.FindMember("params"); it != args.MemberEnd() && !it->value.IsNull()) {
    if (!it->value.IsObject()) fail("invalid_argument", "params must be an object of query parameters");
    for (const auto& member : it->value.GetObject()) {
      const std::string name(member.name.GetString(), member.name.GetStringLength());
      if (!plain_name(name, 64)) fail("invalid_argument", "params has the name " + name + ", which is not a parameter name");
      if (name == "host_id") fail("invalid_argument", "do not pass host_id: use the host argument");
      std::vector<std::string> values;
      if (member.value.IsArray()) {
        if (member.value.Size() > 64) fail("invalid_argument", "params." + name + " has too many values");
        for (const auto& item : member.value.GetArray()) values.push_back(param_text(item, name));
      } else {
        values.push_back(param_text(member.value, name));
      }
      for (const auto& value : values) {
        if (value.size() > 8192) fail("invalid_argument", "a value of params." + name + " is too long");
      }
      // {name} of the path: the value goes in the address, never in the query string.
      const std::string slot = "{" + name + "}";
      if (const auto at = request.path.find(slot); at != std::string::npos) {
        if (values.size() != 1 || !plain_name(values[0], 128)) fail("invalid_argument", "params." + name + " must be one plain value");
        request.path.replace(at, slot.size(), values[0]);
        continue;
      }
      for (const auto& value : values) request.query.emplace_back(name, value);
    }
  }
  if (const auto open = request.path.find('{'); open != std::string::npos) {
    const auto close = request.path.find('}', open);
    fail("invalid_argument", "params." + request.path.substr(open + 1, close == std::string::npos ? 0 : close - open - 1) + " is required");
  }

  if (post) {
    rapidjson::Document body;
    body.SetObject();
    if (const auto it = args.FindMember("body"); it != args.MemberEnd() && !it->value.IsNull()) {
      if (!it->value.IsObject()) fail("invalid_argument", "body must be a JSON object");
      body.CopyFrom(it->value, body.GetAllocator());
    }
    body.RemoveMember("host_id");
    body.AddMember("host_id", rapidjson::Value(api_host.c_str(), static_cast<rapidjson::SizeType>(api_host.size()), body.GetAllocator()), body.GetAllocator());
    rapidjson::StringBuffer sb;
    Writer w(sb);
    body.Accept(w);
    request.body = finish(sb);
  } else {
    request.query.emplace_back("host_id", api_host);
  }

  McpApiResponse response = ctx.api->call(request);
  // The answer names the host that it served: the client sees its own host id.
  response.body = mcp_strip_identity(std::move(response.body));
  if (response.status == 0) fail("api_unavailable", response.error.empty() ? "the API of ChDash did not answer" : response.error);
  if (response.too_large) {
    fail("result_too_large", "the answer is larger than " + std::to_string(ctx.config.max_result_bytes) +
                                 " bytes: narrow it (a shorter window, a filter, a limit)");
  }

  // The JSON object of the answer; a list or a scalar goes under "result".
  rapidjson::Document doc;
  doc.Parse<rapidjson::kParseValidateEncodingFlag>(response.body.data(), response.body.size());
  const bool json = !doc.HasParseError();
  if (response.status < 200 || response.status >= 300) {
    std::string code;
    std::string message;
    std::string hint;
    bool not_granted = false;
    if (json && doc.IsObject()) {
      for (const char* key : {"error_code", "error"}) {
        if (const auto it = doc.FindMember(key); it != doc.MemberEnd() && it->value.IsString() && code.empty()) code = it->value.GetString();
      }
      if (const auto it = doc.FindMember("message"); it != doc.MemberEnd() && it->value.IsString()) message = it->value.GetString();
      if (const auto it = doc.FindMember("reason"); it != doc.MemberEnd() && it->value.IsString()) not_granted = std::string(it->value.GetString()) == "not_granted";
      if (const auto it = doc.FindMember("hint"); it != doc.MemberEnd() && it->value.IsString()) hint = it->value.GetString();
    }
    // The MCP user lacks a grant: the same code as the SQL tools, and the statement that gives it.
    if (not_granted) {
      code = "permission_denied";
      if (!hint.empty()) message += " Give it to the MCP user: " + hint;
    }
    // A route that is not there: the part of ChDash is off in its configuration.
    if (response.status == 404 && code.empty()) {
      fail("not_enabled", std::string("this part of ChDash is not enabled in its configuration (") + api.name + ")");
    }
    if (code.empty()) code = "api_error";
    if (message.empty()) message = "the API answered " + std::to_string(response.status);
    if (message.size() > 1500) message.resize(1500);
    fail(code, message);
  }
  if (json && doc.IsObject() && api.scope == McpApiScope::Catalog) {
    cut_catalog(ctx.key, &doc);
    rapidjson::StringBuffer cut_sb;
    Writer cut_w(cut_sb);
    doc.Accept(cut_w);
    return finish(cut_sb);
  }
  if (json && doc.IsObject()) return response.body;
  if (!json) fail("api_error", "the API did not answer JSON");
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("result");
  doc.Accept(w);
  w.EndObject();
  return finish(sb);
}

} // namespace

McpToolOutcome McpTools::call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments,
                                   int64_t) {
  Ctx ctx = make_ctx(key, config_, db_);
  ctx.api = api_;
  McpToolOutcome outcome;
  try {
    std::string json;
    const McpToolInfo* info = mcp_find_tool(tool);
    if (info && info->api) json = tool_api(ctx, *info, arguments);
    else if (tool == "list_hosts") json = tool_list_hosts(ctx, arguments);
    else if (tool == "list_databases") json = tool_list_databases(ctx, arguments);
    else if (tool == "list_tables") json = tool_list_tables(ctx, arguments);
    else if (tool == "describe_table") json = tool_describe_table(ctx, arguments);
    else if (tool == "query_table") json = tool_query_table(ctx, arguments);
    else if (tool == "list_services") json = tool_list_services(ctx, arguments);
    else if (tool == "search_traces") json = tool_search_traces(ctx, arguments);
    else if (tool == "get_trace") json = tool_get_trace(ctx, arguments);
    else if (tool == "search_logs") json = tool_search_logs(ctx, arguments);
    else if (tool == "list_metrics") json = tool_list_metrics(ctx, arguments);
    else if (tool == "query_metric") json = tool_query_metric(ctx, arguments);
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
