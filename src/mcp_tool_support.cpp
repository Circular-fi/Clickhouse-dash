#include "mcp_tool_support.hpp"

#include "json_parse.hpp"
#include "mcp_sql.hpp"
#include "sql_literal.hpp"

#include <algorithm>

namespace chdash {
namespace mcp_tools {

void fail(const std::string& code, const std::string& message) { throw ToolFailure{code, message}; }

// ---- arguments ----------------------------------------------------------------------------

void reject_unknown(const rapidjson::Value& args, std::initializer_list<const char*> allowed) {
  for (const auto& member : args.GetObject()) {
    const std::string_view name(member.name.GetString(), member.name.GetStringLength());
    const bool known = std::any_of(allowed.begin(), allowed.end(), [&](const char* a) { return name == a; });
    if (!known) fail("invalid_argument", "unknown argument " + std::string(name));
  }
}

std::optional<std::string> opt_string(const rapidjson::Value& args, const char* name, size_t max_bytes) {
  const auto it = args.FindMember(name);
  if (it == args.MemberEnd() || it->value.IsNull()) return std::nullopt;
  if (!it->value.IsString()) fail("invalid_argument", std::string(name) + " must be a string");
  if (it->value.GetStringLength() > max_bytes) fail("invalid_argument", std::string(name) + " is too long");
  return std::string(it->value.GetString(), it->value.GetStringLength());
}

std::string req_string(const rapidjson::Value& args, const char* name, size_t max_bytes) {
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

// ---- the call context ------------------------------------------------------------------------

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
      // A host out of the scope of the key looks like a host that does not exist (contract 3.7).
      fail("not_found", "the host " + *asked + " does not exist or is not visible; call list_hosts");
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

Ctx make_ctx(const McpKey& key, const McpToolsConfig& config, McpDatabase& db, const std::string& tool) {
  Ctx ctx{key, config, db, nullptr, nullptr, 0, "", 0, {}, {}, {}, {}, 0};
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
  ctx.user_limits.tool = tool;
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
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc, cell);
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
  // The rows are data of the users of the database: in untrusted.rows; the columns and the counts stay out (contract 5.2, rule 8).
  w.Key("untrusted");
  w.StartObject();
  w.Key("rows");
  w.StartArray();
  for (const auto& row : res.rows) {
    w.StartArray();
    for (const auto& cell : row) put_cell(w, cell);
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  w.Key("row_count"); w.Uint64(res.rows.size());
}

std::string glob_conditions(const char* column, const std::vector<std::string>& globs) {
  std::string out;
  for (const auto& glob : globs) {
    if (!out.empty()) out += " OR ";
    out += std::string(column) + " LIKE " + sql::quote_string(mcp_glob_to_like(glob));
  }
  return out;
}

void check_table_scope(const Ctx& ctx, const std::string& database, const std::string& table) {
  if (!mcp_scope_table_allowed(ctx.key.databases, database, table)) {
    // A table out of the scope of the key looks like a table that does not exist (contract 3.7).
    fail("not_found", "the table " + database + "." + table + " does not exist or is not visible");
  }
}

std::string describe_table_filter(const std::string& database, const std::string& table, const char* table_column) {
  return "database = " + sql::quote_string(database) + " AND " + table_column + " = " + sql::quote_string(table);
}

}  // namespace mcp_tools
}  // namespace chdash
