#include "mcp_tools_units.hpp"

#include "mcp_api_tools.hpp"
#include "mcp_scope.hpp"
#include "json_parse.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace chdash {
namespace mcp_tools {

// ---- API tools -----------------------------------------------------------------------------------------
//
// One wrapper serves every tool of mcp_api_tools.cpp. The wrapper checks the arguments, calls the route of ChDash,
// and returns the answer. A tool that is added to that table needs nothing here.

namespace {

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

// The data scope of the key applies to an API tool that reads one table (Table) or lists them (Catalog).
// The call names `database` (and `table`) in its params or its body. A name that is not a plain string is refused.
// It is never skipped. Otherwise, the API could read another value of a list than the one that was checked.
// The database and the table that the call names (empty when it names none), for the answer of an object that is not there.
struct ScopedObject {
  std::string database;
  std::string table;
};

ScopedObject check_api_scope(Ctx& ctx, const McpApiTool& api, const rapidjson::Value& args) {
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
      fail("not_found", "the database " + database + " does not exist or is not visible");
    }
    return ScopedObject{has_database ? database : std::string(), std::string()};
  }
  if (!has_database || !has_table || database.empty() || table.empty()) {
    fail("invalid_argument", std::string(post ? "body" : "params") + ".database and " + (post ? "body" : "params") + ".table are required");
  }
  if (!mcp_scope_table_allowed(ctx.key.databases, database, table)) {
    fail("not_found", "the table " + database + "." + table + " does not exist or is not visible");
  }
  return ScopedObject{database, table};
}

// The catalog of the Explorer, cut to what the key shows. It has the databases that a pattern names.
// It has the summary of a database only when the key reads all of it, because a summary counts every table.
// It has the tables that a pattern allows.
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

// The answer of a route of ChDash mixes the figures of the server with the text of the data.
// Examples of the text are names, rows, log lines, span attributes and query texts.
// The tool gives the whole answer in `untrusted` (contract 5.2). See docs/mcp.md, "Untrusted text".
std::string in_untrusted(const std::string& answer) { return "{\"untrusted\":" + answer + "}"; }

}  // namespace

std::string tool_api(Ctx& ctx, const McpToolInfo& info, const rapidjson::Value& args) {
  const McpApiTool& api = *info.api;
  const bool post = std::string(api.method) == "POST";
  reject_unknown(args, post ? std::initializer_list<const char*>{"host", "body"} : std::initializer_list<const char*>{"host", "params"});
  resolve_host(ctx, args);
  ScopedObject named;
  if (api.scope == McpApiScope::Table || api.scope == McpApiScope::Catalog) named = check_api_scope(ctx, api, args);
  if (!ctx.api) fail("api_unavailable", "this server cannot call its own API");

  // The API serves the tool as the MCP user (mcp_identity.hpp). The host that it names is the identity of the family of the tool.
  const std::string api_host = mcp_api_host(ctx.host, mcp_api_identity(api));
  McpApiRequest request;
  request.method = api.method;
  request.path = api.path;
  request.timeout_seconds = ctx.user_limits.timeout_seconds;
  request.max_bytes = ctx.config.max_result_bytes;
  request.key_id = ctx.key.id;
  request.tool = info.name;
  request.agent_caller = ctx.user_limits.agent_caller;

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
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc, response.body);
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
    // The MCP user lacks a grant. This case has the same code as the SQL tools, and the same statement that gives the grant.
    if (not_granted) {
      code = "permission_denied";
      if (!hint.empty()) message += " Give it to the MCP user: " + hint;
    }
    // The message of a route can quote ClickHouse, and so the data of a table: it goes to untrusted.detail.
    const bool from_route = !message.empty();
    // A route is not there (the router's own JSON 404, or none). The part of ChDash is off in its configuration.
    if (response.status == 404 && (code.empty() || (code == "not_found" && message == "Not Found"))) {
      fail("not_enabled", std::string("this part of ChDash is not enabled in its configuration (") + api.name + ")");
    }
    // An object that the MCP user cannot see, or that does not exist, gets the answer of an object out of scope.
    // The code and the message are the same (contract 3.7).
    if (response.status == 404 && code == "object_not_found" && !named.database.empty()) {
      fail("not_found", named.table.empty() ? "the database " + named.database + " does not exist or is not visible"
                                            : "the table " + named.database + "." + named.table + " does not exist or is not visible");
    }
    if (code.empty()) code = "api_error";
    if (code.size() > 64) code.resize(64);
    const std::string summary = not_granted ? std::string("the ClickHouse user of MCP lacks a grant for this tool; the statement that gives it is in "
                                                          "error.untrusted.detail")
                                            : "the API answered " + std::to_string(response.status) +
                                                  (from_route ? std::string("; its message is in error.untrusted.detail") : std::string());
    if (!from_route) fail(code, summary);
    fail_untrusted(code, summary, message);
  }
  if (json && doc.IsObject() && api.scope == McpApiScope::Catalog) {
    cut_catalog(ctx.key, &doc);
    rapidjson::StringBuffer cut_sb;
    Writer cut_w(cut_sb);
    doc.Accept(cut_w);
    return in_untrusted(finish(cut_sb));
  }
  if (json && doc.IsObject()) return in_untrusted(response.body);
  if (!json) fail("api_error", "the API did not answer JSON");
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("result");
  doc.Accept(w);
  w.EndObject();
  return in_untrusted(finish(sb));
}

}  // namespace mcp_tools
}  // namespace chdash
