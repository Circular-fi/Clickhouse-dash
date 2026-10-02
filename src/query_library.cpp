#include "query_library.hpp"

#include <rapidjson/document.h>
#include <rapidjson/error/en.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace chdash {
namespace {

using JsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

// An API error. The message never contains saved SQL.
struct ApiError {
  int status = 400;
  std::string code;
  std::string message;
  std::string field;
  std::string reason;
  std::optional<int64_t> revision;
  std::optional<size_t> folders;
  std::optional<size_t> queries;
  std::string load_error;
};

ApiError validation(std::string field, std::string reason, std::string message) {
  ApiError e;
  e.status = 400;
  e.code = "validation";
  e.field = std::move(field);
  e.reason = std::move(reason);
  e.message = std::move(message);
  return e;
}

ApiError too_large(std::string field, std::string message) {
  ApiError e;
  e.status = 413;
  e.code = "too_large";
  e.field = std::move(field);
  e.message = std::move(message);
  return e;
}

ApiError not_found(std::string message) {
  ApiError e;
  e.status = 404;
  e.code = "not_found";
  e.message = std::move(message);
  return e;
}

void write_string(JsonWriter& w, std::string_view s) {
  w.String(s.data(), static_cast<rapidjson::SizeType>(s.size()));
}

QueryLibraryStore::Response render_error(const ApiError& e) {
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("error"); write_string(w, e.code);
  w.Key("error_code"); write_string(w, e.code);
  w.Key("message"); write_string(w, e.message);
  if (!e.field.empty()) { w.Key("field"); write_string(w, e.field); }
  if (!e.reason.empty()) { w.Key("reason"); write_string(w, e.reason); }
  if (e.revision) { w.Key("revision"); w.Int64(*e.revision); }
  if (e.folders) { w.Key("folders"); w.Uint64(*e.folders); }
  if (e.queries) { w.Key("queries"); w.Uint64(*e.queries); }
  if (!e.load_error.empty()) { w.Key("load_error"); write_string(w, e.load_error); }
  w.EndObject();
  return {e.status, sb.GetString()};
}

// --- text helpers -----------------------------------------------------------

bool is_ascii_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }

std::string trim_ascii(std::string_view s) {
  size_t b = 0;
  size_t e = s.size();
  while (b < e && is_ascii_space(s[b])) ++b;
  while (e > b && is_ascii_space(s[e - 1])) --e;
  return std::string(s.substr(b, e - b));
}

std::string fold_ascii(std::string_view s) {
  std::string out(s);
  for (auto& c : out) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return out;
}

bool has_control(std::string_view s, bool allow_whitespace) {
  for (const unsigned char c : s) {
    if (allow_whitespace && (c == '\n' || c == '\r' || c == '\t')) continue;
    if (c < 0x20 || c == 0x7f) return true;
  }
  return false;
}

std::string truncate_utf8(std::string s, size_t max_bytes) {
  if (s.size() <= max_bytes) return s;
  size_t cut = max_bytes;
  while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xC0) == 0x80) --cut;
  s.resize(cut);
  return s;
}

std::string json_text(const rapidjson::Value& v) {
  return std::string(v.GetString(), v.GetStringLength());
}

const rapidjson::Value* member(const rapidjson::Value& obj, const char* key) {
  const auto it = obj.FindMember(key);
  return it == obj.MemberEnd() ? nullptr : &it->value;
}

// --- request field readers --------------------------------------------------

std::string read_name(const rapidjson::Value* v, const std::string& field) {
  if (!v || v->IsNull()) throw validation(field, "required", field + " is required");
  if (!v->IsString()) throw validation(field, "type", field + " must be a string");
  std::string s = trim_ascii(json_text(*v));
  if (s.empty()) throw validation(field, "required", field + " cannot be empty");
  if (s.size() > kQueryLibraryMaxNameBytes) {
    throw validation(field, "too_long", field + " must be at most " + std::to_string(kQueryLibraryMaxNameBytes) + " bytes");
  }
  if (has_control(s, false)) throw validation(field, "invalid", field + " cannot contain control characters");
  return s;
}

std::string read_description(const rapidjson::Value* v, const std::string& field) {
  if (!v || v->IsNull()) return {};
  if (!v->IsString()) throw validation(field, "type", field + " must be a string");
  std::string s = json_text(*v);
  if (s.size() > kQueryLibraryMaxDescriptionBytes) {
    throw validation(field, "too_long", field + " must be at most " + std::to_string(kQueryLibraryMaxDescriptionBytes) + " bytes");
  }
  if (s.find('\0') != std::string::npos) throw validation(field, "invalid", field + " cannot contain NUL");
  return s;
}

// null -> root; string -> id (existence checked by the caller).
std::optional<std::string> read_ref(const rapidjson::Value* v, const std::string& field) {
  if (!v || v->IsNull()) return std::nullopt;
  if (!v->IsString()) throw validation(field, "type", field + " must be a string or null");
  std::string s = json_text(*v);
  if (s.empty()) return std::nullopt;
  if (s.size() > kQueryLibraryMaxIdBytes) throw validation(field, "not_found", field + " does not name an existing folder");
  return s;
}

std::string read_sql(const rapidjson::Value* v, const std::string& field, size_t max_bytes) {
  if (!v || v->IsNull()) throw validation(field, "required", field + " is required");
  if (!v->IsString()) throw validation(field, "type", field + " must be a string");
  std::string s = json_text(*v);
  if (s.size() > max_bytes) {
    throw too_large(field, field + " exceeds query_library.max_query_bytes (" + std::to_string(max_bytes) + " bytes)");
  }
  if (trim_ascii(s).empty()) throw validation(field, "required", field + " cannot be empty");
  return s;
}

// A body field holding a host id: absent / null -> nullopt (the store then
// answers "required"); anything but a string is a type error.
std::optional<std::string> read_host_field(const rapidjson::Value* v, const std::string& field) {
  if (!v || v->IsNull()) return std::nullopt;
  if (!v->IsString()) throw validation(field, "type", field + " must be a string");
  return json_text(*v);
}

std::vector<std::string> read_tags(const rapidjson::Value* v, const std::string& field) {
  std::vector<std::string> out;
  if (!v || v->IsNull()) return out;
  if (!v->IsArray()) throw validation(field, "type", field + " must be an array of strings");
  if (v->Size() > kQueryLibraryMaxTags) {
    throw validation(field, "too_many", field + " accepts at most " + std::to_string(kQueryLibraryMaxTags) + " tags");
  }
  std::unordered_set<std::string> seen;
  for (rapidjson::SizeType i = 0; i < v->Size(); ++i) {
    const auto& item = (*v)[i];
    const std::string item_field = field + "[" + std::to_string(i) + "]";
    if (!item.IsString()) throw validation(item_field, "type", item_field + " must be a string");
    std::string tag = trim_ascii(json_text(item));
    if (tag.empty()) throw validation(item_field, "required", item_field + " cannot be empty");
    if (tag.size() > kQueryLibraryMaxTagBytes) throw validation(item_field, "too_long", item_field + " is too long");
    if (has_control(tag, false)) throw validation(item_field, "invalid", item_field + " cannot contain control characters");
    if (seen.insert(fold_ascii(tag)).second) out.push_back(std::move(tag));
  }
  return out;
}

std::optional<int64_t> read_opt_int(const rapidjson::Value* v, const std::string& field) {
  if (!v || v->IsNull()) return std::nullopt;
  if (v->IsInt64()) {
    if (v->GetInt64() < 0) throw validation(field, "range", field + " cannot be negative");
    return v->GetInt64();
  }
  if (v->IsNumber()) {
    const double d = v->GetDouble();
    if (!std::isfinite(d) || d < 0 || d > 9.0e15) throw validation(field, "range", field + " is out of range");
    return static_cast<int64_t>(std::llround(d));
  }
  throw validation(field, "type", field + " must be a number");
}

rapidjson::Document parse_body(std::string_view body) {
  rapidjson::Document doc;
  doc.Parse<rapidjson::kParseValidateEncodingFlag>(body.data(), body.size());
  if (doc.HasParseError() || !doc.IsObject()) {
    throw validation("body", "invalid_json", "request body must be a JSON object");
  }
  return doc;
}

// --- JSON writers -----------------------------------------------------------

template <typename W>
void write_str(W& w, std::string_view s) {
  w.String(s.data(), static_cast<rapidjson::SizeType>(s.size()));
}

template <typename W>
void write_opt(W& w, const std::optional<std::string>& s) {
  if (s) write_str(w, *s);
  else w.Null();
}

template <typename W>
void write_number(W& w, double d) {
  if (std::isfinite(d) && std::floor(d) == d && std::fabs(d) < 9.0e15) w.Int64(static_cast<int64_t>(d));
  else if (std::isfinite(d)) w.Double(d);
  else w.Int64(0);
}

template <typename W>
void write_folder_fields(W& w, const QueryLibraryFolder& f) {
  w.Key("id"); write_str(w, f.id);
  w.Key("host_id"); write_str(w, f.host_id);
  w.Key("parent_id"); write_opt(w, f.parent_id);
  w.Key("name"); write_str(w, f.name);
  w.Key("description"); write_str(w, f.description);
  w.Key("created_at_ms"); w.Int64(f.created_at_ms);
  w.Key("updated_at_ms"); w.Int64(f.updated_at_ms);
}

template <typename W>
void write_query_fields(W& w, const QueryLibraryQuery& q) {
  w.Key("id"); write_str(w, q.id);
  w.Key("folder_id"); write_opt(w, q.folder_id);
  w.Key("name"); write_str(w, q.name);
  w.Key("description"); write_str(w, q.description);
  w.Key("sql"); write_str(w, q.sql);
  w.Key("host_id"); write_str(w, q.host_id);
  w.Key("tags");
  w.StartArray();
  for (const auto& t : q.tags) write_str(w, t);
  w.EndArray();
  w.Key("created_at_ms"); w.Int64(q.created_at_ms);
  w.Key("updated_at_ms"); w.Int64(q.updated_at_ms);
}

template <typename W>
void write_history_fields(W& w, const QueryLibraryHistoryEntry& h) {
  w.Key("id"); write_str(w, h.id);
  w.Key("sql"); write_str(w, h.sql);
  w.Key("host_id"); write_str(w, h.host_id);
  w.Key("ran_at_ms"); w.Int64(h.ran_at_ms);
  w.Key("elapsed_ms"); write_number(w, h.elapsed_ms);
  w.Key("rows");
  if (h.rows) w.Int64(*h.rows);
  else w.Null();
  w.Key("status"); write_str(w, h.status);
  w.Key("error");
  if (h.error.empty()) w.Null();
  else write_str(w, h.error);
}

// --- persisted file parsing -------------------------------------------------

[[noreturn]] void file_error(const std::string& message) { throw std::runtime_error(message); }

std::string file_string(const rapidjson::Value& obj, const char* key, const std::string& ctx, bool required) {
  const auto* v = member(obj, key);
  if (!v || v->IsNull()) {
    if (required) file_error(ctx + "." + key + " is required");
    return {};
  }
  if (!v->IsString()) file_error(ctx + "." + key + " must be a string");
  return json_text(*v);
}

std::optional<std::string> file_opt_string(const rapidjson::Value& obj, const char* key, const std::string& ctx) {
  const auto* v = member(obj, key);
  if (!v || v->IsNull()) return std::nullopt;
  if (!v->IsString()) file_error(ctx + "." + key + " must be a string or null");
  if (v->GetStringLength() == 0) return std::nullopt;
  return json_text(*v);
}

int64_t file_int(const rapidjson::Value& obj, const char* key, const std::string& ctx, int64_t fallback) {
  const auto* v = member(obj, key);
  if (!v || v->IsNull()) return fallback;
  if (v->IsInt64()) return v->GetInt64();
  if (v->IsNumber() && std::isfinite(v->GetDouble()) && std::fabs(v->GetDouble()) < 9.0e15) {
    return static_cast<int64_t>(std::llround(v->GetDouble()));
  }
  file_error(ctx + "." + key + " must be an integer");
}

std::string file_id(const rapidjson::Value& obj, const std::string& ctx) {
  std::string id = file_string(obj, "id", ctx, true);
  if (id.empty() || id.size() > kQueryLibraryMaxIdBytes) file_error(ctx + ".id must be 1 to 128 bytes");
  return id;
}

const rapidjson::Value* file_array(const rapidjson::Value& root, const char* key) {
  const auto* v = member(root, key);
  if (!v || v->IsNull()) return nullptr;
  if (!v->IsArray()) file_error(std::string(key) + " must be an array");
  return v;
}

bool valid_history_status(const std::string& s) { return s == "ok" || s == "error" || s == "cancelled"; }

// --- tree helpers -----------------------------------------------------------

const QueryLibraryFolder* find_folder(const QueryLibraryState& s, const std::string& id) {
  for (const auto& f : s.folders) if (f.id == id) return &f;
  return nullptr;
}

QueryLibraryFolder* find_folder(QueryLibraryState& s, const std::string& id) {
  for (auto& f : s.folders) if (f.id == id) return &f;
  return nullptr;
}

QueryLibraryQuery* find_query(QueryLibraryState& s, const std::string& id) {
  for (auto& q : s.queries) if (q.id == id) return &q;
  return nullptr;
}

// Folders on the path from `id` up to the root, `id` included (0 for root).
int folder_depth(const QueryLibraryState& s, const std::optional<std::string>& id) {
  int depth = 0;
  std::optional<std::string> cur = id;
  while (cur) {
    const auto* f = find_folder(s, *cur);
    if (!f) break;
    ++depth;
    if (depth > static_cast<int>(s.folders.size())) break;  // defensive; cycles are rejected on load
    cur = f->parent_id;
  }
  return depth;
}

// `id` and every folder below it, breadth first, with their level (1 = id).
std::vector<std::pair<std::string, int>> folder_subtree(const QueryLibraryState& s, const std::string& id) {
  std::unordered_map<std::string, std::vector<std::string>> children;
  for (const auto& f : s.folders) {
    if (f.parent_id) children[*f.parent_id].push_back(f.id);
  }
  std::vector<std::pair<std::string, int>> out{{id, 1}};
  std::unordered_set<std::string> seen{id};
  for (size_t i = 0; i < out.size(); ++i) {
    const auto it = children.find(out[i].first);
    if (it == children.end()) continue;
    for (const auto& child : it->second) {
      if (seen.insert(child).second) out.emplace_back(child, out[i].second + 1);
    }
  }
  return out;
}

// Sibling names are unique per host: the top level of each host is its own.
bool folder_name_taken(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& parent,
                       const std::string& name, const std::string* except_id) {
  const std::string folded = fold_ascii(name);
  for (const auto& f : s.folders) {
    if (except_id && f.id == *except_id) continue;
    if (f.host_id == host && f.parent_id == parent && fold_ascii(f.name) == folded) return true;
  }
  return false;
}

bool query_name_taken(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& folder,
                      const std::string& name, const std::string* except_id) {
  const std::string folded = fold_ascii(name);
  for (const auto& q : s.queries) {
    if (except_id && q.id == *except_id) continue;
    if (q.host_id == host && q.folder_id == folder && fold_ascii(q.name) == folded) return true;
  }
  return false;
}

ApiError host_mismatch(const std::string& field, const std::string& message) {
  return validation(field, "host_mismatch", message);
}

// A folder reference of an item of `host`: null (the top level) or a folder
// of the same host (400 host_mismatch for a folder of another host).
std::optional<std::string> existing_folder_ref(const QueryLibraryState& s, const rapidjson::Value* v,
                                               const std::string& field, const std::string& host) {
  auto ref = read_ref(v, field);
  if (!ref) return ref;
  const auto* folder = find_folder(s, *ref);
  if (!folder) throw validation(field, "not_found", field + " does not name an existing folder");
  if (folder->host_id != host) throw host_mismatch(field, field + " names a folder of another host");
  return ref;
}

void ensure_depth(const QueryLibraryState& s, const std::optional<std::string>& parent, int subtree_height,
                  const std::string& field) {
  if (folder_depth(s, parent) + subtree_height > kQueryLibraryMaxFolderDepth) {
    throw validation(field, "depth", "folders can be nested at most " + std::to_string(kQueryLibraryMaxFolderDepth) + " levels deep");
  }
}

std::string unique_query_name(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& folder,
                              const std::string& name) {
  if (!query_name_taken(s, host, folder, name, nullptr)) return name;
  for (int n = 2; n < 100000; ++n) {
    const std::string suffix = " (" + std::to_string(n) + ")";
    std::string base = truncate_utf8(name, kQueryLibraryMaxNameBytes - suffix.size());
    std::string candidate = base + suffix;
    if (!query_name_taken(s, host, folder, candidate, nullptr)) return candidate;
  }
  throw validation("name", "duplicate", "no free name for an imported query");
}

// De-duplication key of an imported query: name + SQL, ignoring a " (n)"
// suffix added by an earlier import's rename, so re-importing is a no-op.
std::string import_key(const std::string& name, const std::string& sql) {
  std::string base = name;
  if (base.size() > 4 && base.back() == ')') {
    const auto open = base.rfind(" (");
    if (open != std::string::npos && open + 3 < base.size() &&
        std::all_of(base.begin() + static_cast<std::ptrdiff_t>(open) + 2, base.end() - 1,
                    [](char c) { return c >= '0' && c <= '9'; })) {
      base.resize(open);
    }
  }
  return base + std::string(1, '\0') + sql;
}

std::optional<int64_t> parse_if_match_revision(const std::string& raw) {
  std::string v = trim_ascii(raw);
  if (v == "*") return std::nullopt;
  if (v.rfind("W/", 0) == 0) v = v.substr(2);
  if (v.size() >= 2 && v.front() == '"' && v.back() == '"') v = v.substr(1, v.size() - 2);
  if (v.empty() || v.size() > 18 || !std::all_of(v.begin(), v.end(), [](char c) { return c >= '0' && c <= '9'; })) {
    throw validation("If-Match", "invalid", "If-Match must be a library revision number");
  }
  return std::stoll(v);
}

std::optional<int64_t> parse_query_int(const std::string* raw, const char* field, int64_t min_value, int64_t max_value) {
  if (!raw || raw->empty()) return std::nullopt;
  const std::string& v = *raw;
  if (v.size() > 18 || !std::all_of(v.begin(), v.end(), [](char c) { return c >= '0' && c <= '9'; })) {
    throw validation(field, "invalid", std::string(field) + " must be a non-negative integer");
  }
  const int64_t n = std::stoll(v);
  if (n < min_value || n > max_value) throw validation(field, "range", std::string(field) + " is out of range");
  return n;
}

std::string hex64(uint64_t v) {
  char buf[17];
  std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(v));
  return buf;
}

void log_line(const std::string& message) {
  std::cerr << "[query_library] " << message << std::endl;
}

} // namespace

// --- file format ------------------------------------------------------------

QueryLibraryState parse_query_library_file(std::string_view text, QueryLibraryMigration* migration) {
  rapidjson::Document doc;
  doc.Parse<rapidjson::kParseValidateEncodingFlag>(text.data(), text.size());
  if (doc.HasParseError()) {
    file_error(std::string("invalid JSON at offset ") + std::to_string(doc.GetErrorOffset()) + ": " +
               rapidjson::GetParseError_En(doc.GetParseError()));
  }
  if (!doc.IsObject()) file_error("the top-level value must be an object");
  const auto* version = member(doc, "version");
  if (!version || !version->IsInt64()) file_error("version is required");
  if (version->GetInt64() != 1 && version->GetInt64() != kQueryLibraryFileVersion) {
    file_error("unsupported version " + std::to_string(version->GetInt64()) + " (expected 1 or 2)");
  }
  QueryLibraryMigration local;
  QueryLibraryMigration& mig = migration ? *migration : local;
  mig = QueryLibraryMigration{};
  mig.from_version = static_cast<int>(version->GetInt64());

  QueryLibraryState state;
  state.revision = file_int(doc, "revision", "file", 0);
  if (state.revision < 0) file_error("revision cannot be negative");
  state.updated_at_ms = file_int(doc, "updated_at_ms", "file", 0);

  // Every entry belongs to one host. Entries without a host_id (every folder
  // of a version-1 file) are dropped; a folder or query left in a dropped
  // folder moves to the top level of its host. The structure is checked on
  // the whole file first, so a broken file is a load error either way.
  std::vector<QueryLibraryFolder> all_folders;
  std::unordered_set<std::string> folder_ids;
  if (const auto* folders = file_array(doc, "folders")) {
    if (folders->Size() > kQueryLibraryMaxFolders) file_error("too many folders");
    for (rapidjson::SizeType i = 0; i < folders->Size(); ++i) {
      const std::string ctx = "folders[" + std::to_string(i) + "]";
      const auto& item = (*folders)[i];
      if (!item.IsObject()) file_error(ctx + " must be an object");
      QueryLibraryFolder f;
      f.id = file_id(item, ctx);
      f.host_id = file_opt_string(item, "host_id", ctx).value_or("");
      f.parent_id = file_opt_string(item, "parent_id", ctx);
      f.name = file_string(item, "name", ctx, true);
      f.description = file_string(item, "description", ctx, false);
      f.created_at_ms = file_int(item, "created_at_ms", ctx, 0);
      f.updated_at_ms = file_int(item, "updated_at_ms", ctx, f.created_at_ms);
      if (!folder_ids.insert(f.id).second) file_error(ctx + ".id is a duplicate");
      all_folders.push_back(std::move(f));
    }
  }
  std::unordered_map<std::string, const QueryLibraryFolder*> folder_by_id;
  for (const auto& f : all_folders) folder_by_id[f.id] = &f;
  for (const auto& f : all_folders) {
    if (f.parent_id && folder_ids.count(*f.parent_id) == 0) file_error("folder " + f.id + " has an unknown parent_id");
  }
  for (const auto& f : all_folders) {
    size_t steps = 0;
    std::optional<std::string> cur = f.parent_id;
    while (cur) {
      if (*cur == f.id || ++steps > all_folders.size()) file_error("folder " + f.id + " is part of a parent_id cycle");
      cur = folder_by_id[*cur]->parent_id;
    }
  }
  std::unordered_set<std::string> dropped;
  for (const auto& f : all_folders) {
    if (f.host_id.empty()) dropped.insert(f.id);
  }
  for (const auto& f : all_folders) {
    if (f.host_id.empty()) continue;
    QueryLibraryFolder kept = f;
    if (kept.parent_id) {
      if (dropped.count(*kept.parent_id)) {
        kept.parent_id.reset();
        ++mig.rerooted;
      } else if (folder_by_id[*kept.parent_id]->host_id != kept.host_id) {
        file_error("folder " + kept.id + " and its parent belong to different hosts");
      }
    }
    state.folders.push_back(std::move(kept));
  }
  mig.dropped_folders = dropped.size();

  std::unordered_set<std::string> query_ids;
  if (const auto* queries = file_array(doc, "queries")) {
    if (queries->Size() > kQueryLibraryMaxQueries) file_error("too many queries");
    for (rapidjson::SizeType i = 0; i < queries->Size(); ++i) {
      const std::string ctx = "queries[" + std::to_string(i) + "]";
      const auto& item = (*queries)[i];
      if (!item.IsObject()) file_error(ctx + " must be an object");
      QueryLibraryQuery q;
      q.id = file_id(item, ctx);
      q.folder_id = file_opt_string(item, "folder_id", ctx);
      if (q.folder_id && folder_ids.count(*q.folder_id) == 0) file_error(ctx + ".folder_id names an unknown folder");
      q.name = file_string(item, "name", ctx, true);
      q.description = file_string(item, "description", ctx, false);
      q.sql = file_string(item, "sql", ctx, true);
      q.host_id = file_opt_string(item, "host_id", ctx).value_or("");
      if (const auto* tags = member(item, "tags"); tags && !tags->IsNull()) {
        if (!tags->IsArray()) file_error(ctx + ".tags must be an array");
        for (const auto& t : tags->GetArray()) {
          if (!t.IsString()) file_error(ctx + ".tags must contain strings");
          q.tags.push_back(json_text(t));
        }
      }
      q.created_at_ms = file_int(item, "created_at_ms", ctx, 0);
      q.updated_at_ms = file_int(item, "updated_at_ms", ctx, q.created_at_ms);
      if (!query_ids.insert(q.id).second) file_error(ctx + ".id is a duplicate");
      if (q.host_id.empty()) {
        ++mig.dropped_queries;
        continue;
      }
      if (q.folder_id) {
        if (dropped.count(*q.folder_id)) {
          q.folder_id.reset();
          ++mig.rerooted;
        } else if (folder_by_id[*q.folder_id]->host_id != q.host_id) {
          file_error(ctx + " and its folder belong to different hosts");
        }
      }
      state.queries.push_back(std::move(q));
    }
  }

  std::unordered_set<std::string> history_ids;
  if (const auto* history = file_array(doc, "history")) {
    for (rapidjson::SizeType i = 0; i < history->Size(); ++i) {
      const std::string ctx = "history[" + std::to_string(i) + "]";
      const auto& item = (*history)[i];
      if (!item.IsObject()) file_error(ctx + " must be an object");
      QueryLibraryHistoryEntry h;
      h.id = file_id(item, ctx);
      h.sql = file_string(item, "sql", ctx, true);
      h.host_id = file_opt_string(item, "host_id", ctx).value_or("");
      h.ran_at_ms = file_int(item, "ran_at_ms", ctx, 0);
      if (const auto* e = member(item, "elapsed_ms"); e && !e->IsNull()) {
        if (!e->IsNumber()) file_error(ctx + ".elapsed_ms must be a number");
        h.elapsed_ms = e->GetDouble();
      }
      if (const auto* r = member(item, "rows"); r && !r->IsNull()) h.rows = file_int(item, "rows", ctx, 0);
      h.status = file_string(item, "status", ctx, false);
      if (h.status.empty()) h.status = "ok";
      if (!valid_history_status(h.status)) file_error(ctx + ".status must be ok, error or cancelled");
      h.error = file_string(item, "error", ctx, false);
      if (!history_ids.insert(h.id).second) file_error(ctx + ".id is a duplicate");
      if (h.host_id.empty()) {
        ++mig.dropped_history;
        continue;
      }
      h.seq = state.next_seq++;
      state.history.push_back(std::move(h));
    }
  }
  return state;
}

std::string serialize_query_library_file(const QueryLibraryState& state) {
  rapidjson::StringBuffer sb;
  rapidjson::PrettyWriter<rapidjson::StringBuffer> w(sb);
  w.SetIndent(' ', 2);
  w.StartObject();
  w.Key("version"); w.Int(kQueryLibraryFileVersion);
  w.Key("revision"); w.Int64(state.revision);
  w.Key("updated_at_ms"); w.Int64(state.updated_at_ms);
  w.Key("folders");
  w.StartArray();
  for (const auto& f : state.folders) { w.StartObject(); write_folder_fields(w, f); w.EndObject(); }
  w.EndArray();
  w.Key("queries");
  w.StartArray();
  for (const auto& q : state.queries) { w.StartObject(); write_query_fields(w, q); w.EndObject(); }
  w.EndArray();
  w.Key("history");
  w.StartArray();
  for (const auto& h : state.history) { w.StartObject(); write_history_fields(w, h); w.EndObject(); }
  w.EndArray();
  w.EndObject();
  std::string out(sb.GetString(), sb.GetSize());
  out.push_back('\n');
  return out;
}

// --- atomic write -----------------------------------------------------------

bool atomic_write_file(const std::string& path, std::string_view data, std::string* error) {
  namespace fs = std::filesystem;
  const fs::path target(path);
  const std::string base = target.filename().string();
  if (base.empty() || base == "." || base == "..") {
    if (error) *error = "the configured path has no file name";
    return false;
  }
  fs::path dir = target.parent_path();
  if (dir.empty()) dir = ".";

  static std::atomic<uint64_t> counter{0};
  std::random_device rd;
  const uint64_t nonce = (static_cast<uint64_t>(rd()) << 32) ^ static_cast<uint64_t>(rd()) ^
                         counter.fetch_add(1, std::memory_order_relaxed);
  const fs::path tmp = dir / ("." + base + ".tmp-" + std::to_string(static_cast<long>(::getpid())) + "-" + hex64(nonce));

  int flags = O_WRONLY | O_CREAT | O_EXCL;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
#ifdef O_NOFOLLOW
  flags |= O_NOFOLLOW;
#endif
  const int fd = ::open(tmp.c_str(), flags, S_IRUSR | S_IWUSR);
  if (fd < 0) {
    if (error) *error = std::string("cannot create the temporary file: ") + std::strerror(errno);
    return false;
  }

  std::string failure;
  if (::fchmod(fd, S_IRUSR | S_IWUSR) != 0) failure = std::string("fchmod: ") + std::strerror(errno);
  size_t written = 0;
  while (failure.empty() && written < data.size()) {
    const ssize_t n = ::write(fd, data.data() + written, data.size() - written);
    if (n < 0) {
      if (errno == EINTR) continue;
      failure = std::string("write: ") + std::strerror(errno);
      break;
    }
    written += static_cast<size_t>(n);
  }
  if (failure.empty() && ::fsync(fd) != 0) failure = std::string("fsync: ") + std::strerror(errno);
  if (::close(fd) != 0 && failure.empty()) failure = std::string("close: ") + std::strerror(errno);
  if (failure.empty() && ::rename(tmp.c_str(), target.c_str()) != 0) {
    failure = std::string("rename: ") + std::strerror(errno);
  }
  if (!failure.empty()) {
    ::unlink(tmp.c_str());
    if (error) *error = failure;
    return false;
  }

  // Make the rename itself durable. Best effort: the data is already in place.
  int dir_flags = O_RDONLY;
#ifdef O_DIRECTORY
  dir_flags |= O_DIRECTORY;
#endif
#ifdef O_CLOEXEC
  dir_flags |= O_CLOEXEC;
#endif
  const int dfd = ::open(dir.c_str(), dir_flags);
  if (dfd >= 0) {
    (void)::fsync(dfd);
    ::close(dfd);
  }
  return true;
}

// --- store ------------------------------------------------------------------

QueryLibraryStore::QueryLibraryStore(QueryLibraryOptions options) : options_(std::move(options)) {
  std::random_device rd;
  std::seed_seq seed{rd(), rd(), rd(), rd(), static_cast<unsigned>(now_ms() & 0xffffffff)};
  rng_.seed(seed);
  std::lock_guard<std::mutex> lk(mu_);
  refresh_locked();
  std::error_code ec;
  const auto parent = std::filesystem::path(options_.file).parent_path();
  if (!parent.empty() && !std::filesystem::is_directory(parent, ec)) {
    log_line("warning: the directory of " + options_.file + " does not exist; writes will fail until it is created");
  }
}

QueryLibraryStore::FileStamp QueryLibraryStore::stat_file() const {
  FileStamp s;
  struct stat st {};
  if (::stat(options_.file.c_str(), &st) != 0) {
    s.stat_errno = errno == 0 ? ENOENT : errno;
    return s;
  }
  s.exists = true;
  s.dev = static_cast<uint64_t>(st.st_dev);
  s.ino = static_cast<uint64_t>(st.st_ino);
  s.size = static_cast<uint64_t>(st.st_size);
#if defined(__APPLE__)
  s.mtime_ns = static_cast<int64_t>(st.st_mtimespec.tv_sec) * 1000000000LL + st.st_mtimespec.tv_nsec;
#else
  s.mtime_ns = static_cast<int64_t>(st.st_mtim.tv_sec) * 1000000000LL + st.st_mtim.tv_nsec;
#endif
  return s;
}

void QueryLibraryStore::refresh_locked() {
  const FileStamp now = stat_file();
  if (loaded_once_ && now == stamp_) return;
  const bool had = loaded_once_;
  const int64_t previous_revision = state_.revision;
  loaded_once_ = true;
  stamp_ = now;

  const auto fail = [&](const std::string& message) {
    if (load_error_ != message) {
      log_line("cannot load " + options_.file + ": " + message +
               "; the library is served read-only and the file is not modified");
    }
    load_error_ = message;
  };

  if (!now.exists) {
    if (now.stat_errno != ENOENT) {
      fail(std::string("cannot stat the file: ") + std::strerror(now.stat_errno));
      return;
    }
    QueryLibraryState empty;
    empty.revision = had ? previous_revision + 1 : 0;
    empty.next_seq = state_.next_seq;
    state_ = std::move(empty);
    load_error_.clear();
    return;
  }
  if (now.size > options_.max_file_bytes) {
    fail("the file is larger than query_library.max_file_bytes");
    return;
  }
  std::ifstream in(options_.file, std::ios::binary);
  if (!in) {
    fail(std::string("cannot open the file: ") + std::strerror(errno));
    return;
  }
  std::string text{std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
  if (in.bad()) {
    fail("cannot read the file");
    return;
  }
  QueryLibraryMigration migration;
  try {
    QueryLibraryState parsed = parse_query_library_file(text, &migration);
    while (parsed.history.size() > options_.history_max_entries) parsed.history.pop_front();
    if (had) parsed.revision = std::max(parsed.revision, previous_revision + 1);
    if (!load_error_.empty()) log_line("reloaded " + options_.file + "; the load error is cleared");
    state_ = std::move(parsed);
    load_error_.clear();
  } catch (const std::exception& e) {
    fail(e.what());
    return;
  }
  if (!migration.changed()) return;
  // A version-1 file, or entries without a host: they are dropped in memory;
  // a writable library also rewrites the file (atomically, as version 2). A
  // read-only library never touches the file.
  const std::string counts = "from version " + std::to_string(migration.from_version) + ", dropped " +
                             std::to_string(migration.dropped_folders) + " folders, " +
                             std::to_string(migration.dropped_queries) + " queries and " +
                             std::to_string(migration.dropped_history) + " history entries without a host_id, moved " +
                             std::to_string(migration.rerooted) + " items to the top level of their host";
  if (!options_.writable) {
    log_line("migrated " + options_.file + " in memory (" + counts + "); the library is read-only, the file is not modified");
    return;
  }
  try {
    commit_locked(state_);
    log_line("migrated " + options_.file + " to version " + std::to_string(kQueryLibraryFileVersion) + " (" + counts + ")");
  } catch (const ApiError& e) {
    log_line("migrated " + options_.file + " in memory (" + counts + "); rewriting it failed: " + e.message);
  }
}

bool QueryLibraryStore::writable() {
  std::lock_guard<std::mutex> lk(mu_);
  refresh_locked();
  return options_.writable && load_error_.empty();
}

std::string QueryLibraryStore::load_error() {
  std::lock_guard<std::mutex> lk(mu_);
  refresh_locked();
  return load_error_;
}

void QueryLibraryStore::require_editable_locked() const {
  if (options_.writable && load_error_.empty()) return;
  ApiError e;
  e.status = 403;
  e.code = "read_only";
  if (!load_error_.empty()) {
    e.message = "the library file could not be loaded; the library is read-only until the file is fixed";
    e.load_error = load_error_;
  } else {
    e.message = "the query library is read-only (query_library.writable = false)";
  }
  throw e;
}

void QueryLibraryStore::require_history_writable_locked() const {
  if (!options_.history_on_server) throw not_found("query history is stored in the browser");
  if (load_error_.empty()) return;
  ApiError e;
  e.status = 403;
  e.code = "read_only";
  e.message = "the library file could not be loaded; history cannot be recorded until the file is fixed";
  e.load_error = load_error_;
  throw e;
}

void QueryLibraryStore::check_if_match_locked(const std::string* if_match) const {
  if (!if_match) return;
  const auto expected = parse_if_match_revision(*if_match);
  if (!expected || *expected == state_.revision) return;
  ApiError e;
  e.status = 409;
  e.code = "conflict";
  e.message = "the library changed; reload it and retry";
  e.revision = state_.revision;
  throw e;
}

// The host of a request: required, and one of the configured hosts.
std::string QueryLibraryStore::require_host_locked(const std::string* raw, const std::string& field) const {
  if (!raw || raw->empty()) throw validation(field, "required", field + " is required");
  if (raw->size() > kQueryLibraryMaxHostIdBytes || has_control(*raw, false) ||
      std::find(options_.host_ids.begin(), options_.host_ids.end(), *raw) == options_.host_ids.end()) {
    throw validation(field, "unknown_host", field + " does not name a configured host");
  }
  return *raw;
}

std::string QueryLibraryStore::new_id_locked(char prefix, const QueryLibraryState& state) {
  for (;;) {
    std::string id = std::string(1, prefix) + "_" + hex64(rng_());
    bool used = false;
    if (prefix == 'f') used = find_folder(state, id) != nullptr;
    else if (prefix == 'q') used = std::any_of(state.queries.begin(), state.queries.end(), [&](const auto& q) { return q.id == id; });
    else used = std::any_of(state.history.begin(), state.history.end(), [&](const auto& h) { return h.id == id; });
    if (!used) return id;
  }
}

// Serialize, trimming the oldest history entries while the document is over
// max_file_bytes (history is the first thing to go; the newest `keep_history`
// entries are never dropped), then replace the file atomically.
void QueryLibraryStore::commit_locked(QueryLibraryState candidate) {
  candidate.updated_at_ms = now_ms();
  std::string text = serialize_query_library_file(candidate);
  while (text.size() > options_.max_file_bytes) {
    if (candidate.history.empty()) {
      throw too_large("file", "the library would exceed query_library.max_file_bytes (" +
                                  std::to_string(options_.max_file_bytes) + " bytes)");
    }
    const size_t excess = text.size() - options_.max_file_bytes;
    size_t freed = 0;
    while (!candidate.history.empty() && freed < excess) {
      const auto& oldest = candidate.history.front();
      freed += oldest.sql.size() + oldest.error.size() + 256;
      candidate.history.pop_front();
    }
    text = serialize_query_library_file(candidate);
  }
  std::string error;
  if (!atomic_write_file(options_.file, text, &error)) {
    log_line("cannot write " + options_.file + ": " + error);
    ApiError e;
    e.status = 500;
    e.code = "storage_error";
    e.message = "the library file could not be written";
    throw e;
  }
  state_ = std::move(candidate);
  stamp_ = stat_file();
}

template <typename Fn>
QueryLibraryStore::Response QueryLibraryStore::guarded(Fn&& fn) {
  std::lock_guard<std::mutex> lk(mu_);
  try {
    refresh_locked();
    return fn();
  } catch (const ApiError& e) {
    return render_error(e);
  } catch (const std::exception& e) {
    log_line(std::string("internal error: ") + e.what());
    ApiError err;
    err.status = 500;
    err.code = "internal_error";
    err.message = "query library internal error";
    return render_error(err);
  }
}

namespace {

template <typename Entity, typename WriteFields>
QueryLibraryStore::Response entity_response(int status, const Entity& entity, int64_t revision, WriteFields&& write_fields) {
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  write_fields(w, entity);
  w.Key("revision"); w.Int64(revision);
  w.EndObject();
  return {status, sb.GetString()};
}

QueryLibraryStore::Response folder_response(int status, const QueryLibraryFolder& f, int64_t revision) {
  return entity_response(status, f, revision, [](JsonWriter& w, const QueryLibraryFolder& x) { write_folder_fields(w, x); });
}

QueryLibraryStore::Response query_response(int status, const QueryLibraryQuery& q, int64_t revision) {
  return entity_response(status, q, revision, [](JsonWriter& w, const QueryLibraryQuery& x) { write_query_fields(w, x); });
}

} // namespace

QueryLibraryStore::Response QueryLibraryStore::get_library(const std::string* host_raw) {
  return guarded([&]() -> Response {
    const std::string host = require_host_locked(host_raw, "host_id");
    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("host_id"); write_string(w, host);
    w.Key("revision"); w.Int64(state_.revision);
    w.Key("updated_at_ms"); w.Int64(state_.updated_at_ms);
    w.Key("writable"); w.Bool(options_.writable && load_error_.empty());
    w.Key("history_store"); w.String(options_.history_on_server ? "server" : "browser");
    w.Key("load_error");
    if (load_error_.empty()) w.Null();
    else write_string(w, load_error_);
    w.Key("limits");
    w.StartObject();
    w.Key("max_query_bytes"); w.Uint64(options_.max_query_bytes);
    w.Key("max_file_bytes"); w.Uint64(options_.max_file_bytes);
    w.Key("history_max_entries"); w.Uint64(options_.history_max_entries);
    w.Key("max_folder_depth"); w.Int(kQueryLibraryMaxFolderDepth);
    w.Key("max_name_bytes"); w.Uint64(kQueryLibraryMaxNameBytes);
    w.Key("max_description_bytes"); w.Uint64(kQueryLibraryMaxDescriptionBytes);
    w.EndObject();
    w.Key("folders");
    w.StartArray();
    for (const auto& f : state_.folders) {
      if (f.host_id != host) continue;
      w.StartObject(); write_folder_fields(w, f); w.EndObject();
    }
    w.EndArray();
    w.Key("queries");
    w.StartArray();
    for (const auto& q : state_.queries) {
      if (q.host_id != host) continue;
      w.StartObject(); write_query_fields(w, q); w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    return {200, sb.GetString()};
  });
}

QueryLibraryStore::Response QueryLibraryStore::list_history(const std::string* host_raw, const std::string* limit_raw,
                                                            const std::string* before_ms_raw, const std::string* before_id,
                                                            const std::string* q_raw) {
  return guarded([&]() -> Response {
    if (!options_.history_on_server) throw not_found("query history is stored in the browser");
    const std::string host = require_host_locked(host_raw, "host_id");
    const size_t limit = static_cast<size_t>(
        parse_query_int(limit_raw, "limit", 1, kQueryLibraryMaxHistoryPage).value_or(kQueryLibraryDefaultHistoryPage));
    const auto before_ms = parse_query_int(before_ms_raw, "before_ms", 0, INT64_MAX / 2);
    std::string needle;
    if (q_raw) {
      if (q_raw->size() > 4096) throw validation("q", "too_long", "q is too long");
      needle = fold_ascii(*q_raw);
    }

    std::vector<const QueryLibraryHistoryEntry*> rows;
    rows.reserve(state_.history.size());
    for (const auto& h : state_.history) {
      if (h.host_id == host) rows.push_back(&h);
    }
    std::sort(rows.begin(), rows.end(), [](const auto* a, const auto* b) {
      if (a->ran_at_ms != b->ran_at_ms) return a->ran_at_ms > b->ran_at_ms;
      return a->seq > b->seq;
    });

    // Cursor: entries strictly older than (before_ms, before_id).
    std::optional<uint64_t> cursor_seq;
    if (before_ms && before_id && !before_id->empty()) {
      for (const auto& h : state_.history) {
        if (h.id == *before_id && h.ran_at_ms == *before_ms) cursor_seq = h.seq;
      }
    }

    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("entries");
    w.StartArray();
    size_t emitted = 0;
    bool has_more = false;
    for (const auto* h : rows) {
      if (before_ms) {
        const bool older = h->ran_at_ms < *before_ms ||
                           (cursor_seq && h->ran_at_ms == *before_ms && h->seq < *cursor_seq);
        if (!older) continue;
      }
      if (!needle.empty() && fold_ascii(h->sql).find(needle) == std::string::npos) continue;
      if (emitted == limit) {
        has_more = true;
        break;
      }
      w.StartObject();
      write_history_fields(w, *h);
      w.EndObject();
      ++emitted;
    }
    w.EndArray();
    w.Key("has_more"); w.Bool(has_more);
    w.EndObject();
    return {200, sb.GetString()};
  });
}

QueryLibraryStore::Response QueryLibraryStore::append_history(std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_history_writable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    QueryLibraryHistoryEntry h;
    h.sql = read_sql(member(doc, "sql"), "sql", options_.max_query_bytes);
    const auto host = read_host_field(member(doc, "host_id"), "host_id");
    h.host_id = require_host_locked(host ? &*host : nullptr, "host_id");
    h.ran_at_ms = read_opt_int(member(doc, "ran_at_ms"), "ran_at_ms").value_or(now_ms());
    if (const auto* e = member(doc, "elapsed_ms"); e && !e->IsNull()) {
      if (!e->IsNumber() || !std::isfinite(e->GetDouble()) || e->GetDouble() < 0) {
        throw validation("elapsed_ms", "range", "elapsed_ms must be a non-negative number");
      }
      h.elapsed_ms = e->GetDouble();
    }
    h.rows = read_opt_int(member(doc, "rows"), "rows");
    if (const auto* s = member(doc, "status"); s && !s->IsNull()) {
      if (!s->IsString()) throw validation("status", "type", "status must be a string");
      h.status = json_text(*s);
      if (h.status == "canceled") h.status = "cancelled";
      if (!valid_history_status(h.status)) throw validation("status", "invalid", "status must be ok, error or cancelled");
    }
    if (const auto* e = member(doc, "error"); e && !e->IsNull()) {
      if (!e->IsString()) throw validation("error", "type", "error must be a string");
      h.error = truncate_utf8(json_text(*e), kQueryLibraryMaxHistoryErrorBytes);
    }

    QueryLibraryState candidate = state_;
    h.id = new_id_locked('h', candidate);
    h.seq = candidate.next_seq++;
    const std::string id = h.id;
    candidate.history.push_back(std::move(h));
    while (candidate.history.size() > options_.history_max_entries) candidate.history.pop_front();
    // The new entry must survive the max_file_bytes trimming.
    {
      QueryLibraryState probe;
      probe.revision = candidate.revision;
      probe.folders = candidate.folders;
      probe.queries = candidate.queries;
      probe.history.push_back(candidate.history.back());
      if (serialize_query_library_file(probe).size() > options_.max_file_bytes) {
        throw too_large("sql", "the history entry does not fit in query_library.max_file_bytes");
      }
    }
    commit_locked(std::move(candidate));

    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("id"); write_string(w, id);
    w.Key("revision"); w.Int64(state_.revision);
    w.EndObject();
    return {201, sb.GetString()};
  });
}

QueryLibraryStore::Response QueryLibraryStore::clear_history(const std::string* host_raw, const std::string* if_match) {
  return guarded([&]() -> Response {
    if (!options_.history_on_server) throw not_found("query history is stored in the browser");
    require_editable_locked();
    check_if_match_locked(if_match);
    const std::string host = require_host_locked(host_raw, "host_id");
    QueryLibraryState candidate = state_;
    const size_t before = candidate.history.size();
    candidate.history.erase(std::remove_if(candidate.history.begin(), candidate.history.end(),
                                           [&](const auto& h) { return h.host_id == host; }),
                            candidate.history.end());
    const size_t deleted = before - candidate.history.size();
    if (deleted > 0) commit_locked(std::move(candidate));
    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("ok"); w.Bool(true);
    w.Key("deleted"); w.Uint64(deleted);
    w.Key("revision"); w.Int64(state_.revision);
    w.EndObject();
    return {200, sb.GetString()};
  });
}

QueryLibraryStore::Response QueryLibraryStore::delete_history_entry(const std::string& id, const std::string* if_match) {
  return guarded([&]() -> Response {
    if (!options_.history_on_server) throw not_found("query history is stored in the browser");
    require_editable_locked();
    check_if_match_locked(if_match);
    QueryLibraryState candidate = state_;
    const auto it = std::find_if(candidate.history.begin(), candidate.history.end(), [&](const auto& h) { return h.id == id; });
    if (it == candidate.history.end()) throw not_found("history entry not found");
    candidate.history.erase(it);
    commit_locked(std::move(candidate));
    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("ok"); w.Bool(true);
    w.Key("id"); write_string(w, id);
    w.Key("revision"); w.Int64(state_.revision);
    w.EndObject();
    return {200, sb.GetString()};
  });
}

QueryLibraryStore::Response QueryLibraryStore::create_folder(std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    QueryLibraryState candidate = state_;
    QueryLibraryFolder f;
    const auto host = read_host_field(member(doc, "host_id"), "host_id");
    f.host_id = require_host_locked(host ? &*host : nullptr, "host_id");
    f.parent_id = existing_folder_ref(candidate, member(doc, "parent_id"), "parent_id", f.host_id);
    f.name = read_name(member(doc, "name"), "name");
    f.description = read_description(member(doc, "description"), "description");
    if (candidate.folders.size() >= kQueryLibraryMaxFolders) throw too_large("folders", "too many folders");
    ensure_depth(candidate, f.parent_id, 1, "parent_id");
    if (folder_name_taken(candidate, f.host_id, f.parent_id, f.name, nullptr)) {
      throw validation("name", "duplicate", "a folder with this name already exists here");
    }
    f.id = new_id_locked('f', candidate);
    f.created_at_ms = f.updated_at_ms = now_ms();
    candidate.folders.push_back(f);
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    return folder_response(201, f, state_.revision);
  });
}

QueryLibraryStore::Response QueryLibraryStore::update_folder(const std::string& id, std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    QueryLibraryState candidate = state_;
    QueryLibraryFolder* f = find_folder(candidate, id);
    if (!f) throw not_found("folder not found");
    QueryLibraryFolder next = *f;
    bool changed = false;
    // A folder stays on its host.
    if (const auto host = read_host_field(member(doc, "host_id"), "host_id"); host && *host != next.host_id) {
      throw host_mismatch("host_id", "a folder cannot move to another host");
    }
    if (const auto* v = member(doc, "name")) {
      std::string name = read_name(v, "name");
      changed |= name != next.name;
      next.name = std::move(name);
    }
    if (const auto* v = member(doc, "description")) {
      std::string description = read_description(v, "description");
      changed |= description != next.description;
      next.description = std::move(description);
    }
    if (const auto* v = member(doc, "parent_id")) {
      auto parent = existing_folder_ref(candidate, v, "parent_id", next.host_id);
      if (parent != next.parent_id) {
        if (parent) {
          if (*parent == id) throw validation("parent_id", "cycle", "a folder cannot be moved into itself");
          std::optional<std::string> cur = parent;
          size_t steps = 0;
          while (cur) {
            if (*cur == id) throw validation("parent_id", "cycle", "a folder cannot be moved into one of its subfolders");
            const auto* up = find_folder(candidate, *cur);
            if (!up || ++steps > candidate.folders.size()) break;
            cur = up->parent_id;
          }
        }
        int height = 0;
        for (const auto& item : folder_subtree(candidate, id)) height = std::max(height, item.second);
        ensure_depth(candidate, parent, height, "parent_id");
        next.parent_id = parent;
        changed = true;
      }
    }
    if (!changed) return folder_response(200, *f, state_.revision);
    if (folder_name_taken(candidate, next.host_id, next.parent_id, next.name, &id)) {
      throw validation("name", "duplicate", "a folder with this name already exists here");
    }
    next.updated_at_ms = now_ms();
    *f = next;
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    return folder_response(200, next, state_.revision);
  });
}

QueryLibraryStore::Response QueryLibraryStore::delete_folder(const std::string& id, bool recursive, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    if (!find_folder(state_, id)) throw not_found("folder not found");
    const auto subtree = folder_subtree(state_, id);
    std::unordered_set<std::string> doomed;
    for (const auto& item : subtree) doomed.insert(item.first);
    size_t child_folders = subtree.size() - 1;
    size_t direct_queries = 0;
    for (const auto& q : state_.queries) {
      if (q.folder_id && *q.folder_id == id) ++direct_queries;
    }
    if (!recursive && (child_folders > 0 || direct_queries > 0)) {
      ApiError e;
      e.status = 409;
      e.code = "not_empty";
      e.message = "the folder is not empty; delete it with recursive=1";
      e.folders = child_folders;
      e.queries = direct_queries;
      e.revision = state_.revision;
      throw e;
    }
    QueryLibraryState candidate = state_;
    const size_t folders_before = candidate.folders.size();
    const size_t queries_before = candidate.queries.size();
    candidate.folders.erase(std::remove_if(candidate.folders.begin(), candidate.folders.end(),
                                           [&](const auto& f) { return doomed.count(f.id) != 0; }),
                            candidate.folders.end());
    candidate.queries.erase(std::remove_if(candidate.queries.begin(), candidate.queries.end(),
                                           [&](const auto& q) { return q.folder_id && doomed.count(*q.folder_id) != 0; }),
                            candidate.queries.end());
    const size_t deleted_folders = folders_before - candidate.folders.size();
    const size_t deleted_queries = queries_before - candidate.queries.size();
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("ok"); w.Bool(true);
    w.Key("id"); write_string(w, id);
    w.Key("deleted_folders"); w.Uint64(deleted_folders);
    w.Key("deleted_queries"); w.Uint64(deleted_queries);
    w.Key("revision"); w.Int64(state_.revision);
    w.EndObject();
    return {200, sb.GetString()};
  });
}

QueryLibraryStore::Response QueryLibraryStore::create_query(std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    QueryLibraryState candidate = state_;
    QueryLibraryQuery q;
    const auto host = read_host_field(member(doc, "host_id"), "host_id");
    q.host_id = require_host_locked(host ? &*host : nullptr, "host_id");
    q.folder_id = existing_folder_ref(candidate, member(doc, "folder_id"), "folder_id", q.host_id);
    q.name = read_name(member(doc, "name"), "name");
    q.description = read_description(member(doc, "description"), "description");
    q.sql = read_sql(member(doc, "sql"), "sql", options_.max_query_bytes);
    q.tags = read_tags(member(doc, "tags"), "tags");
    if (candidate.queries.size() >= kQueryLibraryMaxQueries) throw too_large("queries", "too many saved queries");
    if (query_name_taken(candidate, q.host_id, q.folder_id, q.name, nullptr)) {
      throw validation("name", "duplicate", "a query with this name already exists in this folder");
    }
    q.id = new_id_locked('q', candidate);
    q.created_at_ms = q.updated_at_ms = now_ms();
    candidate.queries.push_back(q);
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    return query_response(201, q, state_.revision);
  });
}

QueryLibraryStore::Response QueryLibraryStore::update_query(const std::string& id, std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    QueryLibraryState candidate = state_;
    QueryLibraryQuery* q = find_query(candidate, id);
    if (!q) throw not_found("query not found");
    QueryLibraryQuery next = *q;
    // A query stays on its host: a folder of another host is refused.
    if (const auto host = read_host_field(member(doc, "host_id"), "host_id"); host && *host != next.host_id) {
      throw host_mismatch("host_id", "a saved query cannot move to another host");
    }
    if (const auto* v = member(doc, "name")) next.name = read_name(v, "name");
    if (const auto* v = member(doc, "description")) next.description = read_description(v, "description");
    if (const auto* v = member(doc, "sql")) next.sql = read_sql(v, "sql", options_.max_query_bytes);
    if (const auto* v = member(doc, "folder_id")) next.folder_id = existing_folder_ref(candidate, v, "folder_id", next.host_id);
    if (const auto* v = member(doc, "tags")) next.tags = read_tags(v, "tags");
    const bool changed = next.name != q->name || next.description != q->description || next.sql != q->sql ||
                         next.folder_id != q->folder_id || next.tags != q->tags;
    if (!changed) return query_response(200, *q, state_.revision);
    if (query_name_taken(candidate, next.host_id, next.folder_id, next.name, &id)) {
      throw validation("name", "duplicate", "a query with this name already exists in this folder");
    }
    next.updated_at_ms = now_ms();
    *q = next;
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    return query_response(200, next, state_.revision);
  });
}

QueryLibraryStore::Response QueryLibraryStore::delete_query(const std::string& id, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    QueryLibraryState candidate = state_;
    const auto it = std::find_if(candidate.queries.begin(), candidate.queries.end(), [&](const auto& q) { return q.id == id; });
    if (it == candidate.queries.end()) throw not_found("query not found");
    candidate.queries.erase(it);
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("ok"); w.Bool(true);
    w.Key("id"); write_string(w, id);
    w.Key("revision"); w.Int64(state_.revision);
    w.EndObject();
    return {200, sb.GetString()};
  });
}

// Import (typically the browser's localStorage library of one host, once)
// into the library of the request's host_id: every imported folder and query
// belongs to that host, whatever the payload says. Folders are merged by name
// under the same parent; queries are de-duplicated by name + SQL against the
// host's library and within the payload; a remaining name clash in the target
// folder gets a " (n)" suffix.
QueryLibraryStore::Response QueryLibraryStore::import_library(std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    const auto host_field = read_host_field(member(doc, "host_id"), "host_id");
    const std::string host = require_host_locked(host_field ? &*host_field : nullptr, "host_id");
    const auto* folders = member(doc, "folders");
    const auto* queries = member(doc, "queries");
    if (folders && !folders->IsNull() && !folders->IsArray()) throw validation("folders", "type", "folders must be an array");
    if (queries && !queries->IsNull() && !queries->IsArray()) throw validation("queries", "type", "queries must be an array");
    const rapidjson::SizeType folder_count = folders && folders->IsArray() ? folders->Size() : 0;
    const rapidjson::SizeType query_count = queries && queries->IsArray() ? queries->Size() : 0;
    if (folder_count > kQueryLibraryMaxFolders) throw too_large("folders", "too many folders in the import");
    if (query_count > kQueryLibraryMaxQueries) throw too_large("queries", "too many queries in the import");

    struct ImportFolder {
      std::string import_id;
      std::optional<std::string> parent;
      std::string name;
      std::string description;
      std::string field;
    };
    std::vector<ImportFolder> items;
    std::unordered_map<std::string, size_t> by_id;
    for (rapidjson::SizeType i = 0; i < folder_count; ++i) {
      const std::string field = "folders[" + std::to_string(i) + "]";
      const auto& item = (*folders)[i];
      if (!item.IsObject()) throw validation(field, "type", field + " must be an object");
      ImportFolder f;
      f.field = field;
      if (const auto* v = member(item, "id"); v && !v->IsNull()) {
        if (!v->IsString() || v->GetStringLength() == 0 || v->GetStringLength() > kQueryLibraryMaxIdBytes) {
          throw validation(field + ".id", "invalid", field + ".id must be a non-empty string");
        }
        f.import_id = json_text(*v);
      } else {
        f.import_id = "\x01import-" + std::to_string(i);
      }
      if (const auto* v = member(item, "parent_id"); v && v->IsString() && v->GetStringLength() > 0) f.parent = json_text(*v);
      f.name = read_name(member(item, "name"), field + ".name");
      f.description = read_description(member(item, "description"), field + ".description");
      if (!by_id.emplace(f.import_id, items.size()).second) {
        throw validation(field + ".id", "duplicate", field + ".id is a duplicate");
      }
      items.push_back(std::move(f));
    }

    // Parents first; a parent outside the payload means root.
    std::vector<size_t> order;
    std::vector<int> mark(items.size(), 0);  // 0 new, 1 visiting, 2 done
    for (size_t start = 0; start < items.size(); ++start) {
      std::vector<size_t> chain;
      size_t cur = start;
      for (;;) {
        if (mark[cur] == 2) break;
        if (mark[cur] == 1) throw validation("folders", "cycle", "the imported folders contain a parent_id cycle");
        mark[cur] = 1;
        chain.push_back(cur);
        if (!items[cur].parent) break;
        const auto it = by_id.find(*items[cur].parent);
        if (it == by_id.end()) break;
        cur = it->second;
      }
      for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
        mark[*it] = 2;
        order.push_back(*it);
      }
    }

    QueryLibraryState candidate = state_;
    const int64_t now = now_ms();
    std::unordered_map<std::string, std::string> folder_map;  // import id -> server id
    size_t imported_folders = 0;
    size_t merged_folders = 0;
    for (const size_t index : order) {
      const auto& item = items[index];
      std::optional<std::string> parent;
      if (item.parent) {
        const auto mapped = folder_map.find(*item.parent);
        if (mapped != folder_map.end()) parent = mapped->second;
        else if (const auto* known = find_folder(candidate, *item.parent); known && known->host_id == host) parent = *item.parent;
      }
      const std::string folded = fold_ascii(item.name);
      const QueryLibraryFolder* existing = nullptr;
      for (const auto& f : candidate.folders) {
        if (f.host_id == host && f.parent_id == parent && fold_ascii(f.name) == folded) { existing = &f; break; }
      }
      if (existing) {
        folder_map[item.import_id] = existing->id;
        ++merged_folders;
        continue;
      }
      if (candidate.folders.size() >= kQueryLibraryMaxFolders) throw too_large("folders", "too many folders");
      ensure_depth(candidate, parent, 1, item.field + ".parent_id");
      QueryLibraryFolder f;
      f.id = new_id_locked('f', candidate);
      f.host_id = host;
      f.parent_id = parent;
      f.name = item.name;
      f.description = item.description;
      f.created_at_ms = f.updated_at_ms = now;
      folder_map[item.import_id] = f.id;
      candidate.folders.push_back(std::move(f));
      ++imported_folders;
    }

    std::unordered_set<std::string> keys;
    for (const auto& q : candidate.queries) {
      if (q.host_id == host) keys.insert(import_key(q.name, q.sql));
    }
    size_t imported_queries = 0;
    size_t skipped_queries = 0;
    for (rapidjson::SizeType i = 0; i < query_count; ++i) {
      const std::string field = "queries[" + std::to_string(i) + "]";
      const auto& item = (*queries)[i];
      if (!item.IsObject()) throw validation(field, "type", field + " must be an object");
      QueryLibraryQuery q;
      q.name = read_name(member(item, "name"), field + ".name");
      q.description = read_description(member(item, "description"), field + ".description");
      q.sql = read_sql(member(item, "sql"), field + ".sql", options_.max_query_bytes);
      q.host_id = host;
      q.tags = read_tags(member(item, "tags"), field + ".tags");
      if (const auto* v = member(item, "folder_id"); v && v->IsString() && v->GetStringLength() > 0) {
        const std::string ref = json_text(*v);
        const auto mapped = folder_map.find(ref);
        if (mapped != folder_map.end()) q.folder_id = mapped->second;
        else if (const auto* known = find_folder(candidate, ref); known && known->host_id == host) q.folder_id = ref;
      }
      const std::string key = import_key(q.name, q.sql);
      if (!keys.insert(key).second) {
        ++skipped_queries;
        continue;
      }
      if (candidate.queries.size() >= kQueryLibraryMaxQueries) throw too_large("queries", "too many saved queries");
      q.name = unique_query_name(candidate, host, q.folder_id, q.name);
      q.id = new_id_locked('q', candidate);
      const auto created = read_opt_int(member(item, "created_at_ms"), field + ".created_at_ms");
      const auto updated = read_opt_int(member(item, "updated_at_ms"), field + ".updated_at_ms");
      q.created_at_ms = created.value_or(now);
      q.updated_at_ms = updated.value_or(q.created_at_ms);
      candidate.queries.push_back(std::move(q));
      ++imported_queries;
    }

    if (imported_folders > 0 || imported_queries > 0) {
      candidate.revision = state_.revision + 1;
      commit_locked(std::move(candidate));
    }

    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("ok"); w.Bool(true);
    w.Key("imported_folders"); w.Uint64(imported_folders);
    w.Key("merged_folders"); w.Uint64(merged_folders);
    w.Key("imported_queries"); w.Uint64(imported_queries);
    w.Key("skipped_queries"); w.Uint64(skipped_queries);
    w.Key("folder_ids");
    w.StartObject();
    for (const auto& item : items) {
      if (item.import_id.empty() || item.import_id[0] == '\x01') continue;
      const auto it = folder_map.find(item.import_id);
      if (it == folder_map.end()) continue;
      write_string(w, item.import_id);
      write_string(w, it->second);
    }
    w.EndObject();
    w.Key("revision"); w.Int64(state_.revision);
    w.EndObject();
    return {200, sb.GetString()};
  });
}

} // namespace chdash
