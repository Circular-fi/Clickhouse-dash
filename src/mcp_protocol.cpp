#include "mcp_protocol.hpp"

#include "mcp_scope.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <exception>

namespace chdash {
namespace {

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

void put(Writer& w, std::string_view s) { w.String(s.data(), static_cast<rapidjson::SizeType>(s.size())); }

const char* const kInstructions =
    "Read-only access to ClickHouse through ChDash. Start with list_databases and list_tables, call "
    "describe_table to learn the column names, then use query_table to read rows. "
    "run_query and explain_query exist only when your key allows free SQL. "
    "Every result has caps on rows and bytes; `truncated` is true when something was cut. "
    "A tool failure comes back with isError true and {\"error\": code, \"message\": text}.";

void write_id(Writer& w, const rapidjson::Value* id) {
  w.Key("id");
  if (id) id->Accept(w);
  else w.Null();
}

std::string rpc_error_body(const rapidjson::Value* id, int code, const std::string& message) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("jsonrpc"); w.String("2.0");
  write_id(w, id);
  w.Key("error");
  w.StartObject();
  w.Key("code"); w.Int(code);
  w.Key("message"); put(w, message);
  w.EndObject();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

McpRpcResult rpc_error(const rapidjson::Value* id, int code, const std::string& message, int http_status = 200) {
  McpRpcResult result;
  result.http_status = http_status;
  result.body = rpc_error_body(id, code, message);
  result.rpc_error = code;
  return result;
}

std::string result_body(const rapidjson::Value& id, const std::string& result_json) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("jsonrpc"); w.String("2.0");
  write_id(w, &id);
  w.Key("result");
  w.RawValue(result_json.data(), result_json.size(), rapidjson::kObjectType);
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string initialize_result(const std::string& version, const McpServerInfo& info) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("protocolVersion"); put(w, version);
  w.Key("capabilities");
  w.StartObject();
  w.Key("tools");
  w.StartObject();
  w.Key("listChanged"); w.Bool(false);
  w.EndObject();
  w.EndObject();
  w.Key("serverInfo");
  w.StartObject();
  w.Key("name"); put(w, info.name);
  w.Key("title"); put(w, info.title);
  w.Key("version"); put(w, info.version);
  w.EndObject();
  w.Key("instructions"); w.String(kInstructions);
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string tools_list_result(const McpKey& key) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("tools");
  w.StartArray();
  for (const auto& name : mcp_effective_tools(key.tools, key.databases)) {
    const McpToolInfo* info = mcp_find_tool(name);
    if (!info) continue;
    const char* schema = mcp_tool_input_schema(name);
    w.StartObject();
    w.Key("name"); put(w, info->name);
    w.Key("title"); put(w, info->title);
    w.Key("description"); put(w, info->description);
    w.Key("inputSchema");
    w.RawValue(schema, std::char_traits<char>::length(schema), rapidjson::kObjectType);
    w.Key("annotations");
    w.StartObject();
    w.Key("title"); put(w, info->title);
    w.Key("readOnlyHint"); w.Bool(true);
    w.Key("destructiveHint"); w.Bool(false);
    w.Key("idempotentHint"); w.Bool(true);
    w.Key("openWorldHint"); w.Bool(false);
    w.EndObject();
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string tool_result(const McpToolOutcome& outcome) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("content");
  w.StartArray();
  w.StartObject();
  w.Key("type"); w.String("text");
  w.Key("text"); put(w, outcome.json);
  w.EndObject();
  w.EndArray();
  w.Key("structuredContent");
  w.RawValue(outcome.json.data(), outcome.json.size(), rapidjson::kObjectType);
  w.Key("isError"); w.Bool(outcome.is_error);
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

} // namespace

const std::vector<std::string>& mcp_protocol_versions() {
  static const std::vector<std::string> versions = {"2025-06-18", "2025-03-26", "2024-11-05"};
  return versions;
}

McpToolOutcome mcp_tool_error(const std::string& code, const std::string& message) {
  McpToolOutcome out;
  out.is_error = true;
  out.error_code = code;
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("error"); put(w, code);
  w.Key("message"); put(w, message);
  w.EndObject();
  out.json.assign(sb.GetString(), sb.GetSize());
  return out;
}

const char* mcp_tool_input_schema(std::string_view tool) {
  static const char* const host =
      "\"host\":{\"type\":\"string\",\"description\":\"ClickHouse host name. Optional when the key has one host; "
      "see list_hosts.\"}";
  static const std::string list_hosts = R"({"type":"object","properties":{},"additionalProperties":false})";
  static const std::string list_databases = std::string("{\"type\":\"object\",\"properties\":{") + host +
      ",\"filter\":{\"type\":\"string\",\"description\":\"Glob on the database name; * matches any text.\"}},"
      "\"additionalProperties\":false}";
  static const std::string list_tables = std::string("{\"type\":\"object\",\"properties\":{") + host +
      ",\"database\":{\"type\":\"string\",\"description\":\"List this database only. Omit to list every database the key can see.\"}"
      ",\"filter\":{\"type\":\"string\",\"description\":\"Glob on the table name, for example events_*; * matches any text.\"}},"
      "\"additionalProperties\":false}";
  static const std::string describe_table = std::string("{\"type\":\"object\",\"properties\":{") + host +
      ",\"database\":{\"type\":\"string\"},\"table\":{\"type\":\"string\"}},"
      "\"required\":[\"database\",\"table\"],\"additionalProperties\":false}";
  static const std::string query_table = std::string("{\"type\":\"object\",\"properties\":{") + host +
      ",\"database\":{\"type\":\"string\"},\"table\":{\"type\":\"string\"}"
      ",\"columns\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"description\":\"Columns to return. Omit for every column except wide ones (named in omitted_columns).\"}"
      ",\"filters\":{\"type\":\"array\",\"description\":\"Conditions that must all match.\",\"items\":{\"type\":\"object\",\"properties\":{"
      "\"column\":{\"type\":\"string\"},"
      "\"op\":{\"type\":\"string\",\"enum\":[\"=\",\"!=\",\"<\",\"<=\",\">\",\">=\",\"like\",\"not_like\",\"ilike\",\"in\",\"not_in\",\"is_null\",\"is_not_null\"]},"
      "\"value\":{\"description\":\"A string, number or boolean; a list for in and not_in; none for is_null and is_not_null. Match the column type.\","
      "\"anyOf\":[{\"type\":\"string\"},{\"type\":\"number\"},{\"type\":\"boolean\"},{\"type\":\"array\",\"items\":{\"type\":[\"string\",\"number\",\"boolean\"]}}]}},"
      "\"required\":[\"column\",\"op\"],\"additionalProperties\":false}}"
      ",\"order_by\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"column\":{\"type\":\"string\"},"
      "\"direction\":{\"type\":\"string\",\"enum\":[\"asc\",\"desc\"],\"default\":\"asc\"}},\"required\":[\"column\"],\"additionalProperties\":false}}"
      ",\"limit\":{\"type\":\"integer\",\"minimum\":1,\"default\":100,\"description\":\"Rows to return. The key and the server cap it.\"}},"
      "\"required\":[\"database\",\"table\"],\"additionalProperties\":false}";
  static const std::string run_query = std::string("{\"type\":\"object\",\"properties\":{") + host +
      ",\"sql\":{\"type\":\"string\",\"description\":\"One ClickHouse statement: SELECT, WITH, SHOW, DESCRIBE, EXISTS or EXPLAIN. No ; between statements.\"}},"
      "\"required\":[\"sql\"],\"additionalProperties\":false}";
  static const std::string explain_query = std::string("{\"type\":\"object\",\"properties\":{") + host +
      ",\"sql\":{\"type\":\"string\",\"description\":\"One SELECT statement to explain.\"}"
      ",\"type\":{\"type\":\"string\",\"enum\":[\"plan\",\"pipeline\",\"ast\",\"syntax\",\"estimate\"],\"default\":\"plan\"}"
      ",\"indexes\":{\"type\":\"boolean\",\"description\":\"plan only: show the indexes the query uses.\"}"
      ",\"actions\":{\"type\":\"boolean\",\"description\":\"plan only: show the expression actions.\"}},"
      "\"required\":[\"sql\"],\"additionalProperties\":false}";
  static const std::string since = "\"since_minutes\":{\"type\":\"integer\",\"minimum\":1,\"default\":60,\"description\":\"How far back to look, in minutes.\"}";
  static const std::string limit = "\"limit\":{\"type\":\"integer\",\"minimum\":1,\"default\":20,\"description\":\"Rows to return. The key and the server cap it.\"}";
  static const std::string service = "\"service\":{\"type\":\"string\",\"description\":\"Exact service name; see list_services.\"}";
  static const std::string list_services = std::string("{\"type\":\"object\",\"properties\":{") + host + "," + since +
      ",\"signal\":{\"type\":\"string\",\"enum\":[\"traces\",\"logs\"],\"default\":\"traces\"}},\"additionalProperties\":false}";
  static const std::string search_traces = std::string("{\"type\":\"object\",\"properties\":{") + host + "," + service + "," + since + "," + limit +
      ",\"operation\":{\"type\":\"string\",\"description\":\"A part of the span name, not case sensitive.\"}"
      ",\"status\":{\"type\":\"string\",\"enum\":[\"Error\",\"Ok\",\"Unset\"]}"
      ",\"min_duration_ms\":{\"type\":\"number\",\"minimum\":0}"
      ",\"order\":{\"type\":\"string\",\"enum\":[\"recent\",\"slowest\"],\"default\":\"recent\"}},\"additionalProperties\":false}";
  static const std::string get_trace = std::string("{\"type\":\"object\",\"properties\":{") + host +
      ",\"trace_id\":{\"type\":\"string\",\"description\":\"32 hexadecimal characters.\"}},\"required\":[\"trace_id\"],\"additionalProperties\":false}";
  static const std::string search_logs = std::string("{\"type\":\"object\",\"properties\":{") + host + "," + service + "," + since + "," + limit +
      ",\"severity\":{\"type\":\"string\",\"enum\":[\"trace\",\"debug\",\"info\",\"warn\",\"error\"],\"description\":\"The lowest level to return.\"}"
      ",\"contains\":{\"type\":\"string\",\"description\":\"A text in the message, not case sensitive.\"}"
      ",\"trace_id\":{\"type\":\"string\",\"description\":\"Only the records of this trace.\"}},\"additionalProperties\":false}";
  static const std::string list_metrics = std::string("{\"type\":\"object\",\"properties\":{") + host + "," + service + "," + since +
      ",\"filter\":{\"type\":\"string\",\"description\":\"Glob on the metric name; * matches any text.\"}},\"additionalProperties\":false}";
  static const std::string query_metric = std::string("{\"type\":\"object\",\"properties\":{") + host + "," + service + "," + since +
      ",\"metric\":{\"type\":\"string\",\"description\":\"The metric name; see list_metrics.\"}"
      ",\"kind\":{\"type\":\"string\",\"enum\":[\"gauge\",\"sum\",\"histogram\"]}"
      ",\"aggregation\":{\"type\":\"string\",\"enum\":[\"avg\",\"min\",\"max\",\"sum\",\"last\",\"count\"],\"default\":\"avg\"}"
      ",\"step_seconds\":{\"type\":\"integer\",\"minimum\":1,\"description\":\"The width of a point. Default: the window divided by 100, at least 10 s.\"}},"
      "\"required\":[\"metric\"],\"additionalProperties\":false}";
  if (tool == "list_services") return list_services.c_str();
  if (tool == "search_traces") return search_traces.c_str();
  if (tool == "get_trace") return get_trace.c_str();
  if (tool == "search_logs") return search_logs.c_str();
  if (tool == "list_metrics") return list_metrics.c_str();
  if (tool == "query_metric") return query_metric.c_str();
  if (tool == "list_hosts") return list_hosts.c_str();
  if (tool == "list_databases") return list_databases.c_str();
  if (tool == "list_tables") return list_tables.c_str();
  if (tool == "describe_table") return describe_table.c_str();
  if (tool == "query_table") return query_table.c_str();
  if (tool == "run_query") return run_query.c_str();
  if (tool == "explain_query") return explain_query.c_str();
  return R"({"type":"object","properties":{}})";
}

McpRpcResult mcp_handle_message(std::string_view body, const McpKey& key, McpToolBackend& backend,
                                const McpServerInfo& info, int64_t now) {
  rapidjson::Document doc;
  doc.Parse<rapidjson::kParseValidateEncodingFlag>(body.data(), body.size());
  if (doc.HasParseError()) return rpc_error(nullptr, kRpcParseError, "the body is not valid JSON", 400);
  if (doc.IsArray()) {
    return rpc_error(nullptr, kRpcInvalidRequest, "batch requests are not supported: send one message per request", 400);
  }
  if (!doc.IsObject()) return rpc_error(nullptr, kRpcInvalidRequest, "the body must be a JSON-RPC object", 400);

  const auto member = [&](const char* name) -> const rapidjson::Value* {
    const auto it = doc.FindMember(name);
    return it == doc.MemberEnd() ? nullptr : &it->value;
  };
  const rapidjson::Value* version = member("jsonrpc");
  if (!version || !version->IsString() || std::string_view(version->GetString(), version->GetStringLength()) != "2.0") {
    return rpc_error(nullptr, kRpcInvalidRequest, "jsonrpc must be \"2.0\"", 400);
  }
  const rapidjson::Value* id = member("id");
  const rapidjson::Value* method = member("method");

  if (!method) {
    // A response of the client (to a request that the server never sends): accept and ignore.
    if (member("result") || member("error")) {
      McpRpcResult accepted;
      accepted.http_status = 202;
      accepted.method = "response";
      return accepted;
    }
    return rpc_error(nullptr, kRpcInvalidRequest, "the message has no method", 400);
  }
  if (!method->IsString()) return rpc_error(nullptr, kRpcInvalidRequest, "method must be a string", 400);
  const std::string name(method->GetString(), method->GetStringLength());

  if (!id) {
    McpRpcResult accepted;  // a notification
    accepted.http_status = 202;
    accepted.method = name;
    return accepted;
  }
  if (!(id->IsString() || id->IsInt64() || id->IsUint64())) {
    return rpc_error(nullptr, kRpcInvalidRequest, "id must be a string or an integer", 400);
  }

  McpRpcResult result;
  result.method = name;
  const rapidjson::Value* params = member("params");
  if (params && !params->IsObject()) return rpc_error(id, kRpcInvalidParams, "params must be an object");

  if (name == "ping") {
    result.body = result_body(*id, "{}");
    return result;
  }
  if (name == "initialize") {
    if (!params) return rpc_error(id, kRpcInvalidParams, "initialize needs params.protocolVersion");
    const auto requested = params->FindMember("protocolVersion");
    if (requested == params->MemberEnd() || !requested->value.IsString()) {
      return rpc_error(id, kRpcInvalidParams, "initialize needs params.protocolVersion");
    }
    const std::string asked(requested->value.GetString(), requested->value.GetStringLength());
    const auto& supported = mcp_protocol_versions();
    const std::string chosen =
        std::find(supported.begin(), supported.end(), asked) != supported.end() ? asked : std::string(kMcpLatestProtocolVersion);
    result.body = result_body(*id, initialize_result(chosen, info));
    return result;
  }
  if (name == "tools/list") {
    result.body = result_body(*id, tools_list_result(key));
    return result;
  }
  if (name == "tools/call") {
    if (!params) return rpc_error(id, kRpcInvalidParams, "tools/call needs params.name");
    const auto tool = params->FindMember("name");
    if (tool == params->MemberEnd() || !tool->value.IsString()) return rpc_error(id, kRpcInvalidParams, "tools/call needs params.name");
    const std::string tool_name(tool->value.GetString(), tool->value.GetStringLength());
    if (!mcp_find_tool(tool_name)) return rpc_error(id, kRpcInvalidParams, "Unknown tool: " + tool_name);

    static const rapidjson::Value no_arguments(rapidjson::kObjectType);
    const rapidjson::Value* arguments = &no_arguments;
    if (const auto it = params->FindMember("arguments"); it != params->MemberEnd() && !it->value.IsNull()) {
      if (!it->value.IsObject()) return rpc_error(id, kRpcInvalidParams, "arguments must be an object");
      arguments = &it->value;
    }
    result.tool = tool_name;
    result.tool_called = true;
    if (!mcp_scope_tool_allowed(key.tools, key.databases, tool_name)) {
      result.outcome = mcp_tool_error("tool_not_allowed", "this key cannot use the tool " + tool_name);
    } else {
      try {
        result.outcome = backend.call_tool(key, tool_name, *arguments, now);
      } catch (const std::exception&) {
        result.outcome = mcp_tool_error("internal_error", "the tool failed; see the ChDash log");
      }
    }
    result.body = result_body(*id, tool_result(result.outcome));
    return result;
  }
  return rpc_error(id, kRpcMethodNotFound, "method not found: " + name);
}

} // namespace chdash
