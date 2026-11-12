#include "mcp_approval.hpp"

#include "access_resource.hpp"
#include "approval_effect.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "mcp_sql.hpp"
#include "sql_lexer.hpp"
#include "user_sql_policy.hpp"

#include <rapidjson/pointer.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <utility>

namespace chdash {
namespace {

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

constexpr size_t kControlMaxBytes = 512;
constexpr size_t kRequestIdMaxBytes = 256;

// The longest wait of one call, in seconds: the cap of the argument wait_s (binding 5.7 lets the service bound it).
constexpr const char* kControlNames[] = {"approval_ref", "wait_s", "supersedes", "lease_s", "until"};

std::string text_of(const rapidjson::Value& value) { return std::string(value.GetString(), value.GetStringLength()); }

const rapidjson::Value* member(const rapidjson::Value& object, const char* name) {
  if (!object.IsObject()) return nullptr;
  const auto it = object.FindMember(name);
  return it == object.MemberEnd() ? nullptr : &it->value;
}

// The value with the members of its objects in sorted order, as compact JSON text. The same call always gives the same text, whatever order the
// agent wrote the members in.
void write_sorted(Writer& w, const rapidjson::Value& value) {
  if (value.IsObject()) {
    std::vector<const rapidjson::Value::Member*> members;
    for (const auto& m : value.GetObject()) members.push_back(&m);
    std::sort(members.begin(), members.end(), [](const auto* a, const auto* b) { return text_of(a->name) < text_of(b->name); });
    w.StartObject();
    for (const auto* m : members) {
      write_json_key(w, std::string_view(m->name.GetString(), m->name.GetStringLength()));
      write_sorted(w, m->value);
    }
    w.EndObject();
  } else if (value.IsArray()) {
    w.StartArray();
    for (const auto& item : value.GetArray()) write_sorted(w, item);
    w.EndArray();
  } else if (value.IsString()) {
    write_json_text(w, std::string_view(value.GetString(), value.GetStringLength()));
  } else {
    value.Accept(w);
  }
}

std::string sorted_text(const rapidjson::Value& value) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  write_sorted(w, value);
  return std::string(sb.GetString(), sb.GetSize());
}

void put_text(Writer& w, const char* key, std::string_view text) {
  w.Key(key);
  write_json_text(w, text);
}

std::string view_text(std::string_view title, bool host, bool user, bool options, const char* body, const char* body_label,
                      bool tool_field) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  put_text(w, "title", title);
  w.Key("fields");
  w.StartArray();
  const auto field = [&](const char* label, const char* pointer) {
    w.StartArray();
    w.String(label);
    w.String(pointer);
    w.EndArray();
  };
  if (tool_field) field("Tool", "/tool");
  if (host) field("Host", "/host");
  if (user) field("Runs as", "/ch_user");
  if (options) field("Options", "/options");
  w.EndArray();
  w.Key("body");
  w.String(body);
  w.Key("body_label");
  w.String(body_label);
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

McpToolOutcome tool_json(bool is_error, const std::string& code, std::string json) {
  McpToolOutcome out;
  out.is_error = is_error;
  out.error_code = code;
  out.json = std::move(json);
  return out;
}

bool word_is(std::string_view sql, const sql::Token& token, std::string_view upper) {
  if (token.kind != sql::TokenKind::Word || token.end - token.begin != upper.size()) return false;
  for (size_t i = 0; i < upper.size(); ++i) {
    char c = sql[token.begin + i];
    if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    if (c != upper[i]) return false;
  }
  return true;
}

} // namespace

// ---- the tools -------------------------------------------------------------------------------------------------------------------------

const std::vector<McpToolInfo>& mcp_approval_tools() {
  static const std::vector<McpToolInfo> tools = {
      {kMcpWriteTool, "sql", "Run a write SQL statement",
       "Run exactly one SQL statement that changes data or the schema (INSERT, CREATE, ALTER, DROP, TRUNCATE, OPTIMIZE, RENAME, EXCHANGE, "
       "ATTACH, DETACH, UNDROP, DELETE, UPDATE, or WITH ... INSERT) on one host, with the write account of the host. Give exactly one of "
       "approval_ref, lease_s and until when the tool asks for an approval. A statement that only reads is refused: use run_query.",
       true},
      {kMcpExportTool, "sql", "Export a query",
       "Run exactly one read-only SQL statement (SELECT, WITH, SHOW, DESCRIBE, EXISTS or EXPLAIN) and return its rows as the text of an export: "
       "`format` is csv (the default, with a header line) or json (an array of objects). The statement runs with readonly=1, a row cap, a byte "
       "cap and a time limit; `truncated` is true when rows or bytes were cut. The tool needs the actions query.export and query.run.read.",
       true},
      {kMcpLibraryWriteTool, "query", "Change the query library",
       "Change the saved queries of the server query library of one host with one `operation`: folder_create, folder_update, folder_delete, "
       "query_create, query_update, query_delete or import. `body` is the JSON body of the route of the Query page (folder_create: name, "
       "parent_id; query_create: name, description, sql, folder_id; the update operations take the fields to change; import: folders, queries, copy). `id` names "
       "the folder or the query of an update or a delete. `recursive` deletes a folder with its content. `library` names one of several "
       "libraries. Answers `not_enabled` when the configuration has no writable query_library. Give exactly one of approval_ref, lease_s and until "
       "when the tool asks for an approval.",
       false},
      {kMcpStatusTool, "sql", "Action status",
       "Read the verdict of an action that waits for the approval of its owner: pending, approved, denied or void. Give the id that the action "
       "gave. The read keeps the request alive. The tool runs nothing.",
       false},
  };
  return tools;
}

const char* mcp_approval_description_suffix() {
  return " The owner of the key can need to approve this call: the policy decision point decides. Then the tool does not run. It gives an action "
         "with the status awaiting_approval and executed false. After the approval, call the tool again with the same arguments. Read the "
         "verdict with the tool get_action_status.";
}

const McpToolInfo* mcp_find_approval_tool(std::string_view name) {
  for (const auto& tool : mcp_approval_tools()) {
    if (name == tool.name) return &tool;
  }
  return nullptr;
}

const char* mcp_approval_tool_schema(std::string_view tool) {
  static const std::string write =
      "{\"type\":\"object\",\"properties\":{\"host\":{\"type\":\"string\",\"description\":\"Required: the name of one host; see list_hosts.\"},"
      "\"sql\":{\"type\":\"string\",\"description\":\"One statement that changes data or the schema. No ; between statements.\"}},"
      "\"required\":[\"host\",\"sql\"],\"additionalProperties\":false}";
  static const std::string exporter =
      "{\"type\":\"object\",\"properties\":{\"host\":{\"type\":\"string\",\"description\":\"Required: the name of one host; see list_hosts.\"},"
      "\"sql\":{\"type\":\"string\",\"description\":\"One read-only statement.\"},"
      "\"format\":{\"type\":\"string\",\"enum\":[\"csv\",\"json\"],\"default\":\"csv\"}},"
      "\"required\":[\"host\",\"sql\"],\"additionalProperties\":false}";
  static const std::string status =
      "{\"type\":\"object\",\"properties\":{\"request_id\":{\"type\":\"string\",\"description\":\"The id of the action that waits.\"}},"
      "\"required\":[\"request_id\"],\"additionalProperties\":false}";
  static const std::string library =
      "{\"type\":\"object\",\"properties\":{\"host\":{\"type\":\"string\",\"description\":\"Required: the name of one host; see list_hosts.\"},"
      "\"operation\":{\"type\":\"string\",\"enum\":[\"folder_create\",\"folder_update\",\"folder_delete\",\"query_create\",\"query_update\",\"query_delete\",\"import\"],"
      "\"description\":\"What to change.\"},"
      "\"id\":{\"type\":\"string\",\"description\":\"The id of the folder or of the query that an update or a delete names.\"},"
      "\"library\":{\"type\":\"string\",\"description\":\"The name of one of several libraries; the first one is the default.\"},"
      "\"recursive\":{\"type\":\"boolean\",\"description\":\"folder_delete: delete the content of the folder too.\"},"
      "\"body\":{\"type\":\"object\",\"description\":\"The JSON body of the route of the Query page for this operation.\"}},"
      "\"required\":[\"host\",\"operation\"],\"additionalProperties\":false}";
  if (tool == kMcpExportTool) return exporter.c_str();
  if (tool == kMcpLibraryWriteTool) return library.c_str();
  return tool == kMcpWriteTool ? write.c_str() : status.c_str();
}

std::string mcp_approval_tool_annotations(const McpToolInfo& tool) {
  // A tool with an effect has readOnlyHint false and openWorldHint true (contract 4.3).
  const bool write = std::string_view(tool.name) == kMcpWriteTool || std::string_view(tool.name) == kMcpLibraryWriteTool;
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  put_text(w, "title", tool.title);
  w.Key("readOnlyHint"); w.Bool(!write);
  if (write) {
    w.Key("destructiveHint"); w.Bool(true);
  }
  w.Key("idempotentHint"); w.Bool(!write);
  w.Key("openWorldHint"); w.Bool(write);
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

// ---- the output schemas ----------------------------------------------------------------------------------------------------------------

namespace {

// The members that every result can have (contract 4.5, 9.4; binding 5.3, 5.7): the action of a call that waits and the error object.
const char* kActionMembers =
    "\"action\":{\"type\":\"object\",\"description\":\"The call did not run: it waits for the approval of its owner (contract 9.4).\","
    "\"properties\":{\"id\":{\"type\":\"string\"},\"status\":{\"type\":\"string\",\"enum\":[\"awaiting_approval\"]},"
    "\"code\":{\"type\":\"string\"},\"executed\":{\"type\":\"boolean\",\"enum\":[false]}},"
    "\"required\":[\"id\",\"status\",\"code\",\"executed\"]},"
    "\"error\":{\"type\":\"object\",\"description\":\"The call failed (contract 6.1).\","
    "\"properties\":{\"code\":{\"type\":\"string\"},\"message\":{\"type\":\"string\"},\"retryable\":{\"type\":\"boolean\"},"
    "\"retry_after\":{\"type\":\"integer\"},\"untrusted\":{\"type\":\"object\"}},\"required\":[\"code\",\"message\",\"retryable\"]}";

}  // namespace

const char* mcp_output_schema(std::string_view kind) {
  static const std::string generic = std::string("{\"type\":\"object\",\"properties\":{") + kActionMembers +
                                     ",\"untrusted\":{\"type\":\"object\",\"description\":\"The data of the answer: text that ChDash did not write.\"},"
                                     "\"result\":{\"description\":\"The answer of a route that is not an object.\"}},"
                                     "\"additionalProperties\":true}";
  static const std::string sql = std::string("{\"type\":\"object\",\"properties\":{") + kActionMembers +
                                 ",\"host\":{\"type\":\"string\"},\"columns\":{\"type\":\"array\"},"
                                 "\"row_count\":{\"type\":\"integer\"},\"truncated\":{\"type\":\"boolean\"},\"elapsed_ms\":{\"type\":\"integer\"},"
                                 "\"untrusted\":{\"type\":\"object\"}},\"additionalProperties\":true}";
  static const std::string status = std::string("{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\","
                                                "\"enum\":[\"pending\",\"approved\",\"denied\",\"void\"]},") + kActionMembers + "},\"additionalProperties\":false}";
  if (kind == "status") return status.c_str();
  if (kind == "sql") return sql.c_str();
  return generic.c_str();
}

const char* mcp_output_schema_kind(const McpToolInfo& tool) {
  const std::string_view name = tool.name;
  if (name == kMcpStatusTool) return "status";
  if (name == "run_query" || name == "explain_query" || name == "query_table" || name == "export_query" || name == kMcpWriteTool) return "sql";
  return "generic";
}

// ---- the control arguments -------------------------------------------------------------------------------------------------------------

bool mcp_is_approval_control(std::string_view name) {
  return std::any_of(std::begin(kControlNames), std::end(kControlNames), [&](const char* control) { return name == control; });
}

bool mcp_split_approval_controls(const rapidjson::Value& arguments, McpApprovalControls* out) {
  *out = McpApprovalControls{};
  if (!arguments.IsObject()) return true;
  const auto text = [&](const char* name, std::string* value) -> int {  // 1 present and valid, 0 absent, -1 bad
    const rapidjson::Value* v = member(arguments, name);
    if (!v) return 0;
    if (!v->IsString() || v->GetStringLength() == 0 || v->GetStringLength() > kControlMaxBytes) return -1;
    *value = text_of(*v);
    return 1;
  };
  const auto whole = [&](const char* name, uint64_t min, uint64_t* value) -> int {
    const rapidjson::Value* v = member(arguments, name);
    if (!v) return 0;
    if (!v->IsUint64() || v->GetUint64() < min) return -1;
    *value = v->GetUint64();
    return 1;
  };
  std::string reference;
  std::string until;
  uint64_t lease = 0;
  uint64_t wait = 0;
  const int r = text("approval_ref", &reference);
  const int u = text("until", &until);
  const int l = whole("lease_s", 1, &lease);
  const int w = whole("wait_s", 0, &wait);
  const int s = text("supersedes", &out->supersedes);
  if (r < 0 || u < 0 || l < 0 || w < 0 || s < 0) return false;
  if (r + u + l > 1) return false;
  if (r == 1) {
    out->present = true;
    out->control = PdpApprovalRequest::Control::ApprovalRef;
    out->text = reference;
  } else if (u == 1) {
    out->present = true;
    out->control = PdpApprovalRequest::Control::Until;
    out->text = until;
  } else if (l == 1) {
    out->present = true;
    out->control = PdpApprovalRequest::Control::LeaseSeconds;
    out->lease_seconds = lease;
  }
  if (w == 1) out->wait_seconds = wait;
  return true;
}

std::string mcp_arguments_without_controls(const rapidjson::Value& arguments) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  if (arguments.IsObject()) {
    for (const auto& m : arguments.GetObject()) {
      const std::string name = text_of(m.name);
      if (mcp_is_approval_control(name)) continue;
      write_json_key(w, name);
      m.value.Accept(w);
    }
  }
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string mcp_with_approval_properties(const std::string& schema_json, const McpApprovalBounds& bounds) {
  rapidjson::Document doc;
  doc.Parse(schema_json.c_str(), schema_json.size());
  if (doc.HasParseError() || !doc.IsObject()) return schema_json;
  auto& alloc = doc.GetAllocator();
  const auto props = doc.FindMember("properties");
  if (props == doc.MemberEnd() || !props->value.IsObject()) return schema_json;
  const auto add = [&](const char* name, const char* type, const std::string& description, int64_t minimum, int64_t maximum = -1) {
    rapidjson::Value property(rapidjson::kObjectType);
    property.AddMember("type", rapidjson::Value(type, alloc), alloc);
    if (minimum >= 0) property.AddMember("minimum", minimum, alloc);
    if (maximum >= 0) property.AddMember("maximum", maximum, alloc);
    property.AddMember("description", rapidjson::Value(description.c_str(), static_cast<rapidjson::SizeType>(description.size()), alloc), alloc);
    props->value.AddMember(rapidjson::Value(name, alloc), property, alloc);
  };
  // The bounds that the PDP publishes (ProcurAuth 17.5): the agent reads them, so that the PDP never refuses a lease of a plain value.
  const int64_t lease_min = bounds.lease_min_seconds ? static_cast<int64_t>(std::min<uint64_t>(*bounds.lease_min_seconds, INT64_MAX)) : 1;
  const int64_t lease_max = bounds.lease_max_seconds ? static_cast<int64_t>(std::min<uint64_t>(*bounds.lease_max_seconds, INT64_MAX)) : -1;
  const int64_t wait_max = bounds.wait_max_seconds ? static_cast<int64_t>(std::min<uint64_t>(*bounds.wait_max_seconds, INT64_MAX)) : -1;
  add("approval_ref", "string",
      "Approval control: the reference that the owner gave with the intent of the agent. Give at most one of approval_ref, lease_s and until, and only when the tool asks for an approval.", -1);
  add("lease_s", "integer",
      "Approval control: how many seconds you wait for the approval, a whole number from " + std::to_string(lease_min) +
          (lease_max >= 0 ? " to " + std::to_string(lease_max) : std::string()) + ".",
      lease_min, lease_max);
  add("until", "string", "Approval control: the time until which you wait for the approval, as RFC 3339.", -1);
  add("wait_s", "integer", "The most seconds that this call waits for the verdict after it submitted the request. The server bounds it.", 0, wait_max);
  add("supersedes", "string", "The id of an earlier request of yours that this call replaces.", -1);
  rapidjson::StringBuffer sb;
  Writer w(sb);
  doc.Accept(w);
  return std::string(sb.GetString(), sb.GetSize());
}

// ---- the op and the view ---------------------------------------------------------------------------------------------------------------

McpOpView mcp_op_view(const McpToolInfo& tool, const McpApprovalHost* host, const rapidjson::Value& args, std::string_view write_sql,
                      const McpOpCaps& caps) {
  McpOpView out;
  const std::string_view name = tool.name;
  const rapidjson::Value* host_arg = member(args, "host");
  const std::string host_text = host_arg && host_arg->IsString() ? text_of(*host_arg) : std::string();
  const rapidjson::Value* sql_arg = member(args, "sql");
  const bool sql_tool = name == kMcpWriteTool || ((name == "run_query" || name == "explain_query" || name == kMcpExportTool) && sql_arg && sql_arg->IsString());
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  put_text(w, "tool", name);
  if (!host_text.empty()) put_text(w, "host", host_text);
  bool options = false;
  if (sql_tool) {
    const std::string sql = name == kMcpWriteTool ? std::string(write_sql) : text_of(*sql_arg);
    if (!is_valid_utf8(sql)) return out;
    put_text(w, "sql", sql);
    const std::string& user = name == kMcpWriteTool ? (host ? host->write_user : std::string()) : (host ? host->read_user : std::string());
    put_text(w, "ch_user", user);
    // 17.3a: the caps that the PEP applies by default decide what the call returns and how long it runs. They are in the op, so that an approval
    // never covers a call that runs with other caps. A ceiling of the grant is not here: the effect comes before the answer that holds it.
    if (name != kMcpWriteTool && caps.max_rows > 0) { w.Key("max_rows"); w.Int64(caps.max_rows); }
    if (name != kMcpWriteTool && caps.max_result_bytes > 0) { w.Key("max_result_bytes"); w.Int64(caps.max_result_bytes); }
    if (caps.timeout_seconds > 0) { w.Key("timeout_seconds"); w.Int64(caps.timeout_seconds); }
    // The other arguments (the type of an explain): the owner reads them too.
    rapidjson::Document rest(rapidjson::kObjectType);
    for (const auto& m : args.GetObject()) {
      const std::string key = text_of(m.name);
      if (key == "host" || key == "sql") continue;
      rest.AddMember(rapidjson::Value(m.name, rest.GetAllocator()), rapidjson::Value(m.value, rest.GetAllocator()), rest.GetAllocator());
    }
    if (name == kMcpExportTool && !rest.HasMember("format")) rest.AddMember("format", rapidjson::Value("csv", rest.GetAllocator()), rest.GetAllocator());
    if (name == "explain_query") {
      // 17.3a: the defaults of the tool are in the op.
      auto& alloc = rest.GetAllocator();
      if (!rest.HasMember("type")) rest.AddMember("type", rapidjson::Value("plan", alloc), alloc);
      if (!rest.HasMember("indexes")) rest.AddMember("indexes", rapidjson::Value(false), alloc);
      if (!rest.HasMember("actions")) rest.AddMember("actions", rapidjson::Value(false), alloc);
    }
    if (!rest.ObjectEmpty()) {
      put_text(w, "options", sorted_text(rest));
      options = true;
    }
  } else {
    // 17.3a: a value that the PEP sets by default is in the op, so that an approval for one call never covers a call with another default.
    rapidjson::Document with_defaults;
    with_defaults.CopyFrom(args, with_defaults.GetAllocator());
    const auto default_text = [&](const char* key, const char* value) {
      if (!with_defaults.HasMember(key)) with_defaults.AddMember(rapidjson::Value(key, with_defaults.GetAllocator()), rapidjson::Value(value, with_defaults.GetAllocator()), with_defaults.GetAllocator());
    };
    const auto default_int = [&](const char* key, int value) {
      if (!with_defaults.HasMember(key)) with_defaults.AddMember(rapidjson::Value(key, with_defaults.GetAllocator()), rapidjson::Value(value), with_defaults.GetAllocator());
    };
    const auto default_bool = [&](const char* key, bool value) {
      if (!with_defaults.HasMember(key)) with_defaults.AddMember(rapidjson::Value(key, with_defaults.GetAllocator()), rapidjson::Value(value), with_defaults.GetAllocator());
    };
    if (with_defaults.IsObject()) {
      if (name == "query_table") default_int("limit", 100);
      else if (name == "list_services") { default_int("since_minutes", 60); default_text("signal", "traces"); }
      else if (name == "search_traces") { default_int("since_minutes", 60); default_int("limit", 20); default_text("order", "recent"); }
      else if (name == "search_logs") { default_int("since_minutes", 60); default_int("limit", 20); }
      else if (name == "list_metrics") default_int("since_minutes", 60);
      else if (name == "query_metric") { default_int("since_minutes", 60); default_text("aggregation", "avg"); }
      else if (name == "explain_query") { default_text("type", "plan"); default_bool("indexes", false); default_bool("actions", false); }
      else if (name == "mcp_analysis_my_usage") { default_text("window", "24h"); default_bool("series", false); default_bool("include_cost", false); }
      else if (name == "mcp_analysis_all_usage") { default_text("window", "24h"); default_text("group", "key"); default_text("order", "requests"); default_int("limit", 20); default_bool("series", false); }
    }
    put_text(w, "arguments", sorted_text(with_defaults));
    // 17.3a: the caps of the tool. A tool that reads no ClickHouse and calls no route (the library, the usage and the session) has none.
    const bool no_caps = name == "list_hosts" || name == "mcp_analysis_my_limits" || name == "mcp_analysis_my_usage" || name == "mcp_analysis_all_usage" ||
                         name == "query_library" || name == kMcpLibraryWriteTool || name == kMcpStatusTool;
    if (!no_caps) {
      if (!tool.api && caps.max_rows > 0) { w.Key("max_rows"); w.Int64(caps.max_rows); }
      if (caps.max_result_bytes > 0) { w.Key("max_result_bytes"); w.Int64(caps.max_result_bytes); }
      if (caps.timeout_seconds > 0) { w.Key("timeout_seconds"); w.Int64(caps.timeout_seconds); }
    }
  }
  w.EndObject();
  out.op_json = std::string(sb.GetString(), sb.GetSize());
  if (name == kMcpWriteTool) out.view_json = view_text("ClickHouse write", true, true, options, "/sql", "SQL", false);
  else if (sql_tool) out.view_json = view_text(name == "run_query" ? "ClickHouse read" : name == kMcpExportTool ? "ClickHouse export" : "ClickHouse explain", true, true, options, "/sql", "SQL", false);
  else out.view_json = view_text(tool.title, !host_text.empty(), false, false, "/arguments", "Arguments", true);
  out.ok = true;
  return out;
}

namespace {

// The characters of a UTF-8 text (the bytes that are not continuation bytes).
size_t utf8_characters(std::string_view text) {
  return static_cast<size_t>(std::count_if(text.begin(), text.end(), [](char c) { return (static_cast<unsigned char>(c) & 0xC0) != 0x80; }));
}

constexpr size_t kViewTitleMaxCharacters = 128;
constexpr size_t kViewFieldMaxCharacters = 256;
constexpr size_t kViewBodyMaxBytes = 16 * 1024;

}  // namespace

std::string mcp_view_limit_error(const std::string& op_json, const std::string& view_json) {
  rapidjson::Document op;
  rapidjson::Document view;
  op.Parse(op_json.c_str(), op_json.size());
  view.Parse(view_json.c_str(), view_json.size());
  if (op.HasParseError() || view.HasParseError() || !view.IsObject()) return {};
  if (const auto title = view.FindMember("title"); title != view.MemberEnd() && title->value.IsString() &&
                                                    utf8_characters(std::string_view(title->value.GetString(), title->value.GetStringLength())) > kViewTitleMaxCharacters) {
    return "the title of the command is longer than 128 characters";
  }
  const auto text_at = [&](const std::string& pointer) -> std::string {
    const rapidjson::Value* value = rapidjson::Pointer(pointer.c_str()).Get(op);
    if (!value) return {};
    if (value->IsString()) return std::string(value->GetString(), value->GetStringLength());
    rapidjson::StringBuffer sb;
    Writer w(sb);
    value->Accept(w);
    return std::string(sb.GetString(), sb.GetSize());
  };
  if (const auto fields = view.FindMember("fields"); fields != view.MemberEnd() && fields->value.IsArray()) {
    for (const auto& pair : fields->value.GetArray()) {
      if (!pair.IsArray() || pair.Size() != 2 || !pair[1].IsString()) continue;
      if (utf8_characters(text_at(text_of(pair[1]))) > kViewFieldMaxCharacters) return "a value that the command shows in a field is longer than 256 characters";
    }
  }
  if (const auto body = view.FindMember("body"); body != view.MemberEnd() && body->value.IsString()) {
    if (text_at(text_of(body->value)).size() > kViewBodyMaxBytes) return "the text that the command shows as its body is larger than 16 KiB";
  }
  return {};
}

// ---- the results -----------------------------------------------------------------------------------------------------------------------

McpToolOutcome mcp_approval_error(const std::string& code, uint64_t retry_after, const std::string& message_in) {
  std::string message;
  bool retryable = false;
  if (!message_in.empty()) message = message_in;
  else if (code == "approval_denied") message = "The owner declined the action.";
  else if (code == "approval_expired") message = "The approval is not valid. Call the tool again.";
  else if (code == "approval_unavailable") {
    message = "The owner has no way to receive the approval request.";
    retryable = true;
  } else if (code == "approval_rate_limited") {
    message = "The approval requests of the owner are limited.";
    retryable = true;
  } else {
    message = "An argument of the approval is not valid.";
  }
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("error");
  w.StartObject();
  put_text(w, "code", code);
  put_text(w, "message", message);
  w.Key("retryable"); w.Bool(retryable);
  if (code == "approval_rate_limited") {
    w.Key("retry_after"); w.Uint64(std::max<uint64_t>(1, retry_after));
  }
  w.EndObject();
  w.EndObject();
  return tool_json(true, code, std::string(sb.GetString(), sb.GetSize()));
}

McpToolOutcome mcp_approval_awaiting(const std::string& request_id, const std::string& code) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("action");
  w.StartObject();
  put_text(w, "id", request_id);
  w.Key("status"); w.String("awaiting_approval");
  put_text(w, "code", code);
  w.Key("executed"); w.Bool(false);
  w.EndObject();
  w.EndObject();
  McpToolOutcome out = tool_json(false, "", std::string(sb.GetString(), sb.GetSize()));
  out.extra_text =
      "NOT EXECUTED. The action waits for the approval of its owner. Read the verdict with the tool get_action_status and the id of the "
      "action. After the approval, call this tool again with the same arguments.";
  return out;
}

McpToolOutcome mcp_approval_status(PdpVerdict verdict) {
  return tool_json(false, "", std::string("{\"status\":\"") + pdp_verdict_name(verdict) + "\"}");
}

// ---- the statement of a write ----------------------------------------------------------------------------------------------------------

McpWriteScan mcp_scan_write_statement(std::string_view sql) {
  McpWriteScan out;
  const McpSqlScan scan = mcp_scan_single_statement(
      sql, {"INSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "OPTIMIZE", "RENAME", "EXCHANGE", "ATTACH", "DETACH", "UNDROP", "DELETE", "UPDATE", "WITH"});
  if (!scan.ok) {
    out.error = scan.error;
    out.message = scan.message;
    return out;
  }
  if (sql_statement_class(scan.statement) != SqlStatementClass::Write) {
    out.error = "not_a_write";
    out.message = "this statement only reads, or ChDash cannot tell that it changes data: use run_query for a read";
    return out;
  }
  // The access control and the named collections: the write account must never be the way to change who can do what.
  const std::vector<sql::Token> tokens = sql::lex(scan.statement);
  std::vector<const sql::Token*> words;
  for (const auto& token : tokens) {
    if (sql::is_trivia(token.kind)) continue;
    words.push_back(&token);
    if (words.size() == 2) break;
  }
  if (words.size() == 2 && (word_is(scan.statement, *words[0], "CREATE") || word_is(scan.statement, *words[0], "ALTER") ||
                            word_is(scan.statement, *words[0], "DROP"))) {
    for (const char* forbidden : {"USER", "ROLE", "QUOTA", "ROW", "POLICY", "SETTINGS", "PROFILE", "NAMED"}) {
      if (word_is(scan.statement, *words[1], forbidden)) {
        out.error = "statement_not_allowed";
        out.message = "a statement that changes users, roles, quotas, policies, profiles or named collections is not allowed";
        return out;
      }
    }
  }
  out.ok = true;
  out.statement = scan.statement;
  return out;
}

// ---- the gate --------------------------------------------------------------------------------------------------------------------------

McpApprovalGate::McpApprovalGate(McpApprovalConfig config, McpApprovalPorts ports) : config_(std::move(config)), ports_(std::move(ports)) {}

const McpApprovalHost* McpApprovalGate::host_of(std::string_view id) const {
  for (const auto& host : config_.hosts) {
    if (host.id == id) return &host;
  }
  return nullptr;
}

std::vector<std::string> McpApprovalGate::tool_names() const {
  std::vector<std::string> out;
  if (std::any_of(config_.hosts.begin(), config_.hosts.end(), [](const McpApprovalHost& host) { return mcp_host_can_write(host); })) {
    out.push_back(kMcpWriteTool);
  }
  // export_query is the tool of the action query.export. It needs a host that MCP reaches.
  if (!config_.hosts.empty()) out.push_back(kMcpExportTool);
  // library_write is the tool of the action library.write. It needs a library that a person can change.
  if (config_.library_writable) out.push_back(kMcpLibraryWriteTool);
  out.push_back(kMcpStatusTool);
  return out;
}

int64_t McpApprovalGate::max_command_bytes() const {
  int64_t bound = config_.max_command_bytes;
  if (ports_.limits) {
    const PdpApprovalLimits published = ports_.limits();
    // The lower value wins: the PDP refuses a command above its own bound with a 413 (17.4), and the configuration can be lower.
    if (published.max_command_bytes) bound = std::min<int64_t>(bound, static_cast<int64_t>(std::min<uint64_t>(*published.max_command_bytes, INT64_MAX)));
  }
  return bound;
}

McpApprovalBounds McpApprovalGate::bounds() const {
  McpApprovalBounds out;
  uint64_t wait_cap = static_cast<uint64_t>(std::max<int64_t>(0, config_.wait_cap_seconds));
  if (ports_.limits) {
    const PdpApprovalLimits published = ports_.limits();
    out.lease_min_seconds = published.lease_min_seconds;
    out.lease_max_seconds = published.lease_max_seconds;
    if (published.wait_max_seconds) wait_cap = std::min(wait_cap, *published.wait_max_seconds);
  }
  out.wait_max_seconds = wait_cap;
  return out;
}

McpGateResult McpApprovalGate::call(const std::string& subject, const McpToolInfo& tool, const AccessQuestion& question, bool budget,
                                    const rapidjson::Value& arguments, McpCallInfo* info, const std::function<AccessDecision()>& first) {
  McpGateResult result;
  const std::string effect_unknown;
  const auto answer = [&](McpToolOutcome outcome, const std::string& effect, const char* word) {
    outcome.effect = effect;
    outcome.approval = word;
    info->answered = std::move(outcome);
    result.access = McpAccess::Allowed;
    result.run = false;
    return result;
  };
  const auto refuse = [&](McpAccess access) {
    result.access = access;
    result.run = false;
    return result;
  };

  McpApprovalControls controls;
  if (!mcp_split_approval_controls(arguments, &controls)) return answer(mcp_approval_error("invalid_argument"), effect_unknown, "invalid_argument");
  if (arguments.IsObject()) {
    for (const auto& m : arguments.GetObject()) info->controls_present = info->controls_present || mcp_is_approval_control(text_of(m.name));
  }
  // The arguments that the call will run: without the control arguments (ProcurAuth 17.9a).
  rapidjson::Document stripped;
  stripped.Parse(mcp_arguments_without_controls(arguments).c_str());
  const bool write_tool = std::string_view(tool.name) == kMcpWriteTool;
  // A call that leaves the host out (a key of the page that has one host) runs on the host of the question. The op names this host, so that the
  // same call always gives the same effect and the person reads the host (17.3a).
  if (!write_tool && stripped.IsObject() && !stripped.HasMember("host")) {
    const std::string question_host = access_resource_host(question.resource);
    if (!question_host.empty()) {
      stripped.AddMember("host", rapidjson::Value(question_host.c_str(), static_cast<rapidjson::SizeType>(question_host.size()), stripped.GetAllocator()),
                         stripped.GetAllocator());
    }
  }
  const rapidjson::Value* host_arg = member(stripped, "host");
  const McpApprovalHost* host = host_arg && host_arg->IsString() ? host_of(text_of(*host_arg)) : nullptr;
  std::string write_sql;
  if (write_tool) {
    // A host that has no write account, or that MCP does not reach, gets the answer of a tool that the person does not have.
    if (!host || !mcp_host_can_write(*host)) return refuse(McpAccess::Denied);
    for (const auto& m : stripped.GetObject()) {
      const std::string key = text_of(m.name);
      if (key != "host" && key != "sql") return answer(mcp_tool_error("invalid_argument", "the tool has no argument " + std::string(key.size() <= 64 ? key : key.substr(0, 64))), effect_unknown, "invalid_argument");
    }
    const rapidjson::Value* sql = member(stripped, "sql");
    if (!sql || !sql->IsString()) return answer(mcp_tool_error("invalid_argument", "sql is required and must be a string"), effect_unknown, "invalid_argument");
    if (static_cast<int64_t>(sql->GetStringLength()) > config_.max_sql_bytes) {
      return answer(mcp_tool_error("sql_too_large", "the SQL is longer than " + std::to_string(config_.max_sql_bytes) + " bytes"), effect_unknown, "invalid_argument");
    }
    const McpWriteScan scan = mcp_scan_write_statement(text_of(*sql));
    if (!scan.ok) return answer(mcp_tool_error(scan.error, scan.message), effect_unknown, "invalid_argument");
    write_sql = scan.statement;
  }

  // The first question is the question of ProcurAuth 10.1, with no effect (17.7, step 1). Most calls end here: `true` runs the tool, and a
  // reason other than the reasons of 17.1 is the answer of 10.3. The caller applies both.
  const AccessDecision first_answer = first();
  if (first_answer.failed || first_answer.allowed || !pdp_reason_is_approval(first_answer.reason)) {
    if (first_answer.allowed) info->approved_sql = write_sql;
    result.pass = true;
    result.decision = first_answer;
    return result;
  }

  // The PDP asks for an approval. A tools/call can wait (17.7a). The call needs one of the controls to submit a request (binding 5.7).
  if (!controls.present) {
    return answer(mcp_tool_error("invalid_argument", "this call needs an approval: give exactly one of approval_ref, lease_s and until"), effect_unknown,
                  "invalid_argument");
  }
  const McpOpView opview = mcp_op_view(tool, host, stripped, write_sql, config_.caps);
  std::string effect;
  std::string canonical_op;
  std::string error;
  if (!opview.ok ||
      !approval_effect(config_.service_id, question.action, approval_resource_text(access_resource_path(question.resource)), opview.op_json, &effect,
                       &canonical_op, &error)) {
    return answer(mcp_approval_error("invalid_argument"), effect_unknown, "invalid_argument");
  }
  // 17.3a and contract 9.5: the command is never cut or hidden. A command that does not fit is refused, and nothing goes to the approval API.
  // The bound is the lower of access.approval.max_command_bytes and the bound that the PDP publishes. Each part of the view has its own limit.
  const int64_t command_bound = max_command_bytes();
  if (static_cast<int64_t>(canonical_op.size() + opview.view_json.size()) > command_bound) {
    return answer(mcp_tool_error("invalid_argument", "the command is larger than " + std::to_string(command_bound) +
                                                       " bytes, the limit of an approval request (access.approval.max_command_bytes, or the limit that the PDP publishes)"),
                  effect, "invalid_argument");
  }
  if (const std::string part = mcp_view_limit_error(canonical_op, opview.view_json); !part.empty()) {
    return answer(mcp_tool_error("invalid_argument", part), effect, "invalid_argument");
  }
  AccessQuestion asked = question;
  asked.approval_effect = effect;

  const McpApprovalBounds advertised = bounds();
  const uint64_t wait_cap = advertised.wait_max_seconds.value_or(0);
  // A lease outside the bounds of the PDP: the PDP refuses it and never changes it (17.5), so the call says so before it submits.
  if (controls.present && controls.control == PdpApprovalRequest::Control::LeaseSeconds &&
      ((advertised.lease_min_seconds && controls.lease_seconds < *advertised.lease_min_seconds) ||
       (advertised.lease_max_seconds && controls.lease_seconds > *advertised.lease_max_seconds))) {
    return answer(mcp_approval_error("invalid_argument", 0,
                                     "lease_s is outside the bounds of the approval service: it must be from " +
                                         std::to_string(advertised.lease_min_seconds.value_or(1)) +
                                         (advertised.lease_max_seconds ? " to " + std::to_string(*advertised.lease_max_seconds) : std::string()) + " seconds"),
                  effect, "invalid_argument");
  }
  // At most two rounds: after a wait that ends with `approved`, or after a late evaluation_id, the call asks again (17.7).
  for (int round = 0; round < 2; ++round) {
    // Step 3: the question without usage and with the effect. On `true`, step 6: the question with usage and the effect.
    AccessDecision decision = ports_.ask(subject, asked, false, false);
    if (!decision.failed && decision.allowed) {
      // An action that lists no budget gets units 0 or no member (the PDP counted nothing for it).
      decision = ports_.ask(subject, asked, true, !budget);
      if (!decision.failed && decision.allowed) {
        info->approved_effect = effect;
        info->approved_sql = write_sql;
        result.access = McpAccess::Allowed;
        result.run = true;
        result.decision = decision;
        return result;
      }
    }
    if (decision.failed) return refuse(McpAccess::Failed);
    if (decision.allowed) return refuse(McpAccess::Denied);
    if (decision.reason == PdpReason::ApprovalDenied) return answer(mcp_approval_error("approval_denied"), effect, "approval_denied");
    if (decision.reason == PdpReason::ApprovalExpired) return answer(mcp_approval_error("approval_expired"), effect, "approval_expired");
    if (decision.reason == PdpReason::BudgetExceeded && decision.retry_after) {
      info->retry_after = decision.retry_after;
      return refuse(McpAccess::BudgetExceeded);
    }
    if (decision.reason != PdpReason::ApprovalRequired && decision.reason != PdpReason::ApprovalPending) return refuse(McpAccess::Denied);

    // The PEP sends the evaluation_id back as it came, and never reads it. Without it the PEP cannot submit: it fails closed.
    if (decision.evaluation_id.empty()) return refuse(McpAccess::Denied);
    PdpApprovalRequest request;
    request.evaluation_id = decision.evaluation_id;
    request.effect = effect;
    request.op_json = canonical_op;
    request.view_json = opview.view_json;
    request.control = controls.control;
    request.control_text = controls.text;
    request.lease_seconds = controls.lease_seconds;
    request.supersedes = controls.supersedes;
    const PdpApprovalReply submitted = ports_.submit(request);
    switch (submitted.status) {
      case PdpApprovalReply::Status::Ok: break;
      case PdpApprovalReply::Status::NoDevice: return answer(mcp_approval_error("approval_unavailable"), effect, "approval_unavailable");
      case PdpApprovalReply::Status::RateLimited:
        return answer(mcp_approval_error("approval_rate_limited", submitted.retry_after), effect, "approval_rate_limited");
      case PdpApprovalReply::Status::InvalidArgument: return answer(mcp_approval_error("invalid_argument"), effect, "invalid_argument");
      // A fault of the agent, not of the service: a tool error, never an HTTP 503 (spec question 47, portal approval API).
      case PdpApprovalReply::Status::ExplanationRequired:
        return answer(mcp_approval_error("invalid_argument", 0,
                                         "The owner asks for the intent of the agent with each request: give approval_ref in place of lease_s and until."),
                      effect, "invalid_argument");
      case PdpApprovalReply::Status::CannotSupersede:
        return answer(mcp_approval_error("invalid_argument", 0, "The request that supersedes names was already used. Call the tool without supersedes."),
                      effect, "invalid_argument");
      case PdpApprovalReply::Status::InvalidEvaluation:
        // The evaluation_id is late or not valid. One more question gives a new one; a second refusal means that the approval is not valid.
        if (round == 0) continue;
        return answer(mcp_approval_error("approval_expired"), effect, "approval_expired");
      case PdpApprovalReply::Status::Unavailable: return refuse(McpAccess::Failed);
    }
    const uint64_t wait = std::min<uint64_t>(controls.wait_seconds.value_or(0), wait_cap);
    if (round == 0 && wait > 0) {
      // A wait is only a help: a failed read leaves the call with the result "it waits". The wait never renews the request.
      const PdpApprovalReply verdict = ports_.verdict(submitted.request_id, subject, wait, false);
      if (verdict.status == PdpApprovalReply::Status::Ok) {
        if (verdict.verdict == PdpVerdict::Approved) continue;
        if (verdict.verdict == PdpVerdict::Denied) return answer(mcp_approval_error("approval_denied"), effect, "approval_denied");
        if (verdict.verdict == PdpVerdict::Void) return answer(mcp_approval_error("approval_expired"), effect, "approval_expired");
      }
    }
    return answer(mcp_approval_awaiting(submitted.request_id, submitted.code), effect, "awaiting");
  }
  return refuse(McpAccess::Denied);
}

McpAccess McpApprovalGate::status(const std::string& subject, const rapidjson::Value& arguments, McpCallInfo* info) {
  const auto answer = [&](McpToolOutcome outcome, const char* word) {
    outcome.approval = word;
    info->answered = std::move(outcome);
    return McpAccess::Allowed;
  };
  const rapidjson::Value* id = member(arguments, "request_id");
  bool only_id = arguments.IsObject() && arguments.MemberCount() == 1;
  const bool valid = id && id->IsString() && id->GetStringLength() >= 1 && id->GetStringLength() <= kRequestIdMaxBytes &&
                     std::all_of(id->GetString(), id->GetString() + id->GetStringLength(), [](unsigned char c) { return c > 0x20 && c < 0x7f; });
  if (!valid || !only_id) return answer(mcp_approval_error("invalid_argument"), "invalid_argument");
  const PdpApprovalReply reply = ports_.verdict(text_of(*id), subject, 0, true);
  switch (reply.status) {
    case PdpApprovalReply::Status::Ok: return answer(mcp_approval_status(reply.verdict), pdp_verdict_name(reply.verdict));
    case PdpApprovalReply::Status::NoDevice: return answer(mcp_approval_error("approval_unavailable"), "approval_unavailable");
    case PdpApprovalReply::Status::RateLimited: return answer(mcp_approval_error("approval_rate_limited", reply.retry_after), "approval_rate_limited");
    case PdpApprovalReply::Status::InvalidArgument:
    case PdpApprovalReply::Status::ExplanationRequired:
    case PdpApprovalReply::Status::CannotSupersede:
    case PdpApprovalReply::Status::InvalidEvaluation: return answer(mcp_approval_error("invalid_argument"), "invalid_argument");
    case PdpApprovalReply::Status::Unavailable: return McpAccess::Failed;
  }
  return McpAccess::Failed;
}

} // namespace chdash
