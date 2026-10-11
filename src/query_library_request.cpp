#include "query_library_request.hpp"

#include "error_envelope.hpp"
#include "json_parse.hpp"
#include "query_library_json.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace chdash {
namespace qlib {

int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

LibraryError validation(std::string field, std::string reason, std::string message) {
  LibraryError e;
  e.status = 400;
  e.code = "validation";
  e.field = std::move(field);
  e.reason = std::move(reason);
  e.message = std::move(message);
  return e;
}

LibraryError too_large(std::string field, std::string message) {
  LibraryError e;
  e.status = 413;
  e.code = "too_large";
  e.field = std::move(field);
  e.message = std::move(message);
  return e;
}

LibraryError not_found(std::string message) {
  LibraryError e;
  e.status = 404;
  e.code = "not_found";
  e.message = std::move(message);
  return e;
}

LibraryError host_mismatch(const std::string& field, const std::string& message) {
  return validation(field, "host_mismatch", message);
}

QueryLibraryStore::Response render_error(const LibraryError& e) {
  // The one error answer of the API (error_envelope.hpp). The library adds what a client reads to fix the call.
  ApiError out;
  out.status = e.status;
  out.code = e.code;
  out.message = e.message;
  if (!e.field.empty()) out.text.emplace_back("field", e.field);
  if (!e.reason.empty()) out.text.emplace_back("reason", e.reason);
  if (!e.load_error.empty()) out.text.emplace_back("load_error", e.load_error);
  if (e.revision) out.numbers.emplace_back("revision", *e.revision);
  if (e.folders) out.numbers.emplace_back("folders", static_cast<int64_t>(*e.folders));
  if (e.queries) out.numbers.emplace_back("queries", static_cast<int64_t>(*e.queries));
  return {out.status, error_json(out)};
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
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc, body);
  if (doc.HasParseError() || !doc.IsObject()) {
    throw validation("body", "invalid_json", "request body must be a JSON object");
  }
  return doc;
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

}  // namespace qlib
}  // namespace chdash
