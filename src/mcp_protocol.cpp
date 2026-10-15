#include "mcp_protocol.hpp"

#include "log.hpp"
#include "json_parse.hpp"

#include "mcp_api_tools.hpp"
#include "mcp_scope.hpp"
#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <exception>
#include <mutex>
#include <unordered_map>

namespace chdash {
namespace {

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

void put(Writer& w, std::string_view s) { write_json_text(w, s); }

const char* const kInstructions =
    "Read-only access to ClickHouse through ChDash. Start with list_databases and list_tables, call "
    "describe_table to learn the column names, then use query_table to read rows. "
    "run_query and explain_query exist only when your key allows free SQL. "
    "The tools of the other groups (explorer_*, system_*, traces_*, logs_*, metrics_*) call the same functions as "
    "the ChDash pages: pass the query parameters in `params`. "
    "mcp_analysis_my_limits tells the limits of your own key, and mcp_analysis_my_usage (while ChDash counts the usage) what it did. "
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

// The longest method that the audit line and the usage show: the client chooses it.
constexpr size_t kMaxMethodShownBytes = 128;

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

std::string tools_list_result(const McpKey& key, const McpToolAvailability& availability) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("tools");
  w.StartArray();
  // What the key holds and the configuration offers: the tools of the analysis of the usage are left out while the usage is off.
  for (const auto& name : mcp_effective_tools(key.tools, key.databases, availability)) {
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

// An output stream of rapidjson that writes into a std::string, so that a response is built in place and moved to the answer: no
// StringBuffer, no copy of it. A tool result can be as large as max_result_bytes (up to 256 MiB), and a copy is that much memory
// for each call that runs at once.
class StringStream {
public:
  using Ch = char;
  void Put(char c) { text_.push_back(c); }
  void Flush() {}
  void reserve(size_t bytes) { text_.reserve(bytes); }
  std::string take() { return std::move(text_); }

private:
  std::string text_;
};
// The Writer asks for room for each string before it writes it, for the worst case (six bytes for each byte): the caller reserves
// once, for the likely size, so this does nothing.
inline void PutReserve(StringStream&, size_t) {}

using StreamWriter = rapidjson::Writer<StringStream>;

// The protocol version after which a tool result has structuredContent (the 2025-06-18 specification, "Tools", "Structured
// Content"). A client of an older version does not read it: it reads content[].text.
bool protocol_has_structured_content(std::string_view version) {
  // Dates in the form YYYY-MM-DD compare as text. No header: the latest version (the stateless endpoint has no initialize
  // to remember; the clients of 2025-06-18 send the header, and a script that sends none reads either field).
  return version.empty() || version >= std::string_view("2025-06-18");
}

// The whole JSON-RPC response of tools/call, written once. `text` carries the JSON of the result as text for every client (the
// specification asks a tool that returns structured content to also return it as text, and most clients show the model the text,
// not structuredContent); `structuredContent` is the same JSON for the clients that read it, so only for a protocol that has it.
std::string tool_call_body(const rapidjson::Value& id, const McpToolOutcome& outcome, bool structured) {
  StringStream out;
  // The text copy escapes its quotes (about 15 % more than the JSON); the room is reserved once, as untouched memory that the writes fill.
  out.reserve(outcome.json.size() * (structured ? 23 : 13) / 10 + 1024);
  StreamWriter w(out);
  w.StartObject();
  w.Key("jsonrpc"); w.String("2.0");
  w.Key("id");
  id.Accept(w);
  w.Key("result");
  w.StartObject();
  w.Key("content");
  w.StartArray();
  w.StartObject();
  w.Key("type"); w.String("text");
  w.Key("text"); write_json_text(w, outcome.json);
  w.EndObject();
  w.EndArray();
  if (structured) {
    w.Key("structuredContent");
    w.RawValue(outcome.json.data(), outcome.json.size(), rapidjson::kObjectType);
  }
  w.Key("isError"); w.Bool(outcome.is_error);
  w.EndObject();
  w.EndObject();
  return out.take();
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

// The schema of an API tool, from its row of mcp_api_tools.cpp: the host, the parameters of the route as an
// object (a list repeats the parameter), and for a POST the JSON body.
static std::string api_tool_schema(const McpApiTool& api) {
  const bool post = std::string(api.method) == "POST";
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("type"); w.String("object");
  w.Key("properties");
  w.StartObject();
  w.Key("host");
  w.StartObject();
  w.Key("type"); w.String("string");
  w.Key("description"); w.String("ClickHouse host name. Optional when the key has one host; see list_hosts.");
  w.EndObject();
  if (post) {
    w.Key("body");
    w.StartObject();
    w.Key("type"); w.String("object");
    w.Key("description"); w.String("The JSON body of the call; the description of the tool names its fields.");
    w.EndObject();
  } else {
    w.Key("params");
    w.StartObject();
    w.Key("type"); w.String("object");
    w.Key("description");
    put(w, std::string("The query parameters of GET ") + api.path + ", as an object; a list repeats the parameter. The description of the tool names the ones that matter.");
    w.Key("additionalProperties");
    w.StartObject();
    w.Key("anyOf");
    w.StartArray();
    w.StartObject(); w.Key("type"); w.StartArray(); w.String("string"); w.String("number"); w.String("boolean"); w.EndArray(); w.EndObject();
    w.StartObject(); w.Key("type"); w.String("array");
    w.Key("items"); w.StartObject(); w.Key("type"); w.StartArray(); w.String("string"); w.String("number"); w.String("boolean"); w.EndArray(); w.EndObject();
    w.EndObject();
    w.EndArray();
    w.EndObject();
    w.EndObject();
  }
  w.EndObject();
  w.Key("additionalProperties"); w.Bool(false);
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

const char* mcp_tool_input_schema(std::string_view tool) {
  if (const McpToolInfo* info = mcp_find_tool(tool); info && info->api) {
    static std::mutex mu;
    static std::unordered_map<std::string, std::string> cache;
    const std::lock_guard<std::mutex> lock(mu);
    auto it = cache.find(info->name);
    if (it == cache.end()) it = cache.emplace(info->name, api_tool_schema(*info->api)).first;
    return it->second.c_str();
  }
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
  // The analysis of the keys (mcp_tools_analysis.cpp). The window is one that the retention of the usage keeps: the others are `invalid_argument`.
  static const std::string usage_window =
      "\"window\":{\"type\":\"string\",\"enum\":[\"1h\",\"6h\",\"24h\",\"7d\",\"30d\",\"90d\",\"365d\"],\"default\":\"24h\","
      "\"description\":\"The period to sum, ending now. 7d and longer need mcp.usage.retention_days of that many days.\"}";
  static const std::string usage_series =
      "\"series\":{\"type\":\"boolean\",\"default\":false,\"description\":\"Add one point for each step of the window (the answer is larger).\"}";
  static const auto names_of = [](const char* name, const char* what) {
    return std::string("\"") + name + "\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"maxItems\":20,\"description\":\"" + what + "\"}";
  };
  static const std::string usage_instances = names_of("instance", "Only these ChDash instances (their names). Omit for all of them.");
  static const std::string my_usage = "{\"type\":\"object\",\"properties\":{" + usage_window + "," + usage_series +
      ",\"include_cost\":{\"type\":\"boolean\",\"default\":false,\"description\":\"Add what the statements of your key cost ClickHouse. It reads system.query_log, so it takes longer.\"}," +
      usage_instances + "},\"additionalProperties\":false}";
  static const std::string all_usage = "{\"type\":\"object\",\"properties\":{" + usage_window +
      ",\"group\":{\"type\":\"string\",\"enum\":[\"key\",\"method\",\"client\",\"instance\"],\"default\":\"key\",\"description\":\"What the series is grouped by.\"}," +
      names_of("key", "Only these keys (their ids).") + "," +
      names_of("method", "Only these methods: a tool, or a method of the protocol such as tools/list.") + "," +
      names_of("client", "Only these clients (the names that they gave).") + "," + usage_instances + "," + usage_series +
      ",\"limit\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":200,\"default\":20,\"description\":\"Rows of each list.\"}},\"additionalProperties\":false}";
  static const std::string my_limits = R"({"type":"object","properties":{},"additionalProperties":false})";
  if (tool == "mcp_analysis_my_limits") return my_limits.c_str();
  if (tool == "mcp_analysis_my_usage") return my_usage.c_str();
  if (tool == "mcp_analysis_all_usage") return all_usage.c_str();
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
                                const McpServerInfo& info, int64_t now, std::string_view protocol_version) {
  rapidjson::Document doc;
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc, body);
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
  // From here the method is read: the audit line and the usage name it, also when the message fails. A client chooses it and a
  // notification takes any name, so it is cut.
  const std::string shown = name.substr(0, kMaxMethodShownBytes);
  const auto fail = [&](const rapidjson::Value* error_id, int code, const std::string& message, int http_status = 200) {
    McpRpcResult error = rpc_error(error_id, code, message, http_status);
    error.method = shown;
    return error;
  };

  if (!id) {
    McpRpcResult accepted;  // a notification
    accepted.http_status = 202;
    accepted.method = shown;
    return accepted;
  }
  if (!(id->IsString() || id->IsInt64() || id->IsUint64())) {
    return fail(nullptr, kRpcInvalidRequest, "id must be a string or an integer", 400);
  }

  McpRpcResult result;
  result.method = shown;
  const rapidjson::Value* params = member("params");
  if (params && !params->IsObject()) return fail(id, kRpcInvalidParams, "params must be an object");

  if (name == "ping") {
    result.body = result_body(*id, "{}");
    return result;
  }
  if (name == "initialize") {
    if (!params) return fail(id, kRpcInvalidParams, "initialize needs params.protocolVersion");
    const auto requested = params->FindMember("protocolVersion");
    if (requested == params->MemberEnd() || !requested->value.IsString()) {
      return fail(id, kRpcInvalidParams, "initialize needs params.protocolVersion");
    }
    const std::string asked(requested->value.GetString(), requested->value.GetStringLength());
    const auto& supported = mcp_protocol_versions();
    const std::string chosen =
        std::find(supported.begin(), supported.end(), asked) != supported.end() ? asked : std::string(kMcpLatestProtocolVersion);
    // Who the client is (optional): the usage of the key keeps it.
    if (const auto client = params->FindMember("clientInfo"); client != params->MemberEnd() && client->value.IsObject()) {
      const auto text = [&](const char* field) -> std::string {
        const auto it = client->value.FindMember(field);
        if (it == client->value.MemberEnd() || !it->value.IsString()) return {};
        return std::string(it->value.GetString(), std::min<size_t>(it->value.GetStringLength(), 256));
      };
      result.client_name = text("name");
      result.client_version = text("version");
    }
    result.body = result_body(*id, initialize_result(chosen, info));
    return result;
  }
  if (name == "tools/list") {
    result.body = result_body(*id, tools_list_result(key, backend.availability()));
    return result;
  }
  if (name == "tools/call") {
    if (!params) return fail(id, kRpcInvalidParams, "tools/call needs params.name");
    const auto tool = params->FindMember("name");
    if (tool == params->MemberEnd() || !tool->value.IsString()) return fail(id, kRpcInvalidParams, "tools/call needs params.name");
    const std::string tool_name(tool->value.GetString(), tool->value.GetStringLength());
    const McpToolInfo* tool_info = mcp_find_tool(tool_name);
    if (!tool_info) return fail(id, kRpcInvalidParams, "Unknown tool: " + tool_name);

    static const rapidjson::Value no_arguments(rapidjson::kObjectType);
    const rapidjson::Value* arguments = &no_arguments;
    if (const auto it = params->FindMember("arguments"); it != params->MemberEnd() && !it->value.IsNull()) {
      if (!it->value.IsObject()) return fail(id, kRpcInvalidParams, "arguments must be an object");
      arguments = &it->value;
    }
    result.tool = tool_name;
    result.tool_called = true;
    // The key is entitled to the tool (its list, its data), then the configuration must offer it: a tool that the usage needs, while the usage is
    // off, is `not_enabled` for the key that holds it (and `tool_not_allowed` for the key that does not).
    if (!mcp_scope_tool_allowed(key.tools, key.databases, tool_name)) {
      result.outcome = mcp_tool_error("tool_not_allowed", "this key cannot use the tool " + tool_name);
    } else if (const std::string off = mcp_tool_unavailable_reason(*tool_info, backend.availability()); !off.empty()) {
      result.outcome = mcp_tool_error("not_enabled", off);
    } else {
      try {
        result.outcome = backend.call_tool(key, tool_name, *arguments, now);
      } catch (const std::exception& error) {
        // The client gets a sentence; the log gets the tool, the key and what was thrown (never the arguments or the data).
        log_event(LogLevel::Error, "mcp.tool_failed", {{"tool", tool_name}, {"key", key.id}, {"error", error.what()}});
        result.outcome = mcp_tool_error("internal_error", "the tool failed; see the ChDash log");
      }
    }
    result.body = tool_call_body(*id, result.outcome, protocol_has_structured_content(protocol_version));
    return result;
  }
  return fail(id, kRpcMethodNotFound, "method not found: " + name);
}

} // namespace chdash
