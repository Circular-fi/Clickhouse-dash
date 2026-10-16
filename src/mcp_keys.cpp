#include "mcp_keys.hpp"
#include "json_parse.hpp"

#include "jwt.hpp"
#include "mcp_scope.hpp"
#include "query_library.hpp"
#include "secure_random.hpp"
#include "json_text.hpp"

#include <rapidjson/document.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <system_error>

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace chdash {
namespace {

constexpr size_t kMaxFileBytes = 4 * 1024 * 1024;
constexpr size_t kMaxListEntries = 256;
constexpr size_t kMaxEntryBytes = 256;

McpValidationError verr(const char* field, const char* reason, std::string message) {
  return McpValidationError{field, reason, std::move(message)};
}

bool all_digits(std::string_view s) {
  return !s.empty() && std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; });
}

bool valid_ui_id(std::string_view id) {
  if (id.size() != 15 || id.substr(0, 3) != "ui_") return false;
  return std::all_of(id.begin() + 3, id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

bool has_duplicates(const std::vector<std::string>& values) {
  for (size_t i = 0; i < values.size(); ++i) {
    for (size_t j = 0; j < i; ++j) {
      if (values[i] == values[j]) return true;
    }
  }
  return false;
}

// Return the list of strings from the request body, or the error to answer.
std::optional<McpValidationError> read_string_list(const rapidjson::Value& value, const char* field,
                                                   std::vector<std::string>* out) {
  if (!value.IsArray()) return verr(field, "type", std::string(field) + " must be an array of strings");
  if (value.Size() > kMaxListEntries) return verr(field, "too_long", std::string(field) + " has too many entries");
  out->clear();
  for (const auto& item : value.GetArray()) {
    if (!item.IsString()) return verr(field, "type", std::string(field) + " must be an array of strings");
    if (item.GetStringLength() > kMaxEntryBytes) return verr(field, "too_long", "an entry of " + std::string(field) + " is too long");
    out->emplace_back(item.GetString(), item.GetStringLength());
  }
  return std::nullopt;
}

std::optional<McpValidationError> read_optional_int(const rapidjson::Value& value, const char* field,
                                                    std::optional<int64_t>* out) {
  if (value.IsNull()) {
    out->reset();
    return std::nullopt;
  }
  if (!value.IsInt64()) return verr(field, "type", std::string(field) + " must be an integer or null");
  *out = value.GetInt64();
  return std::nullopt;
}

} // namespace

// ---- time ------------------------------------------------------------------

std::string mcp_iso_utc(int64_t seconds) {
  const time_t t = static_cast<time_t>(seconds);
  struct tm tm_utc;
  gmtime_r(&t, &tm_utc);
  char buf[96];
  std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ", tm_utc.tm_year + 1900, tm_utc.tm_mon + 1,
                tm_utc.tm_mday, tm_utc.tm_hour, tm_utc.tm_min, tm_utc.tm_sec);
  return buf;
}

bool mcp_parse_iso_utc(std::string_view text, int64_t* seconds) {
  const auto num = [&](size_t at, size_t len, int* out) {
    if (at + len > text.size() || !all_digits(text.substr(at, len))) return false;
    int v = 0;
    for (size_t i = 0; i < len; ++i) v = v * 10 + (text[at + i] - '0');
    *out = v;
    return true;
  };
  int year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
  if (text.size() < 10 || !num(0, 4, &year) || text[4] != '-' || !num(5, 2, &month) || text[7] != '-' ||
      !num(8, 2, &day)) {
    return false;
  }
  if (text.size() > 10) {
    if (text[10] != 'T' || text.size() < 20 || !num(11, 2, &hour) || text[13] != ':' || !num(14, 2, &minute) ||
        text[16] != ':' || !num(17, 2, &second)) {
      return false;
    }
    size_t at = 19;
    if (at < text.size() && text[at] == '.') {
      ++at;
      const size_t start = at;
      while (at < text.size() && text[at] >= '0' && text[at] <= '9') ++at;
      if (at == start || at - start > 9) return false;
    }
    if (at + 1 != text.size() || text[at] != 'Z') return false;
  }
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 ||
      second > 59) {
    return false;
  }
  struct tm tm_utc;
  std::memset(&tm_utc, 0, sizeof(tm_utc));
  tm_utc.tm_year = year - 1900;
  tm_utc.tm_mon = month - 1;
  tm_utc.tm_mday = day;
  tm_utc.tm_hour = hour;
  tm_utc.tm_min = minute;
  tm_utc.tm_sec = second;
  const time_t t = timegm(&tm_utc);
  // timegm normalizes 31 February to 3 March. Reject any date that it moved.
  if (tm_utc.tm_mon != month - 1 || tm_utc.tm_mday != day) return false;
  *seconds = static_cast<int64_t>(t);
  return true;
}

bool mcp_parse_rfc3339(std::string_view text, int64_t* seconds) {
  // The date comes first, then the time, then the zone.
  // The zone is Z, or +HH:MM or -HH:MM.
  // A fraction of a second is accepted and ignored.
  if (text.size() < 20 || text[10] != 'T') return false;
  size_t at = 19;
  if (at < text.size() && text[at] == '.') {
    ++at;
    const size_t start = at;
    while (at < text.size() && text[at] >= '0' && text[at] <= '9') ++at;
    if (at == start || at - start > 9) return false;
  }
  const std::string_view zone = text.substr(at);
  int64_t offset = 0;
  if (zone != "Z") {
    if (zone.size() != 6 || (zone[0] != '+' && zone[0] != '-') || zone[3] != ':' || !all_digits(zone.substr(1, 2)) || !all_digits(zone.substr(4, 2))) {
      return false;
    }
    const int hours = (zone[1] - '0') * 10 + (zone[2] - '0');
    const int minutes = (zone[4] - '0') * 10 + (zone[5] - '0');
    if (hours > 23 || minutes > 59) return false;
    offset = (hours * 60 + minutes) * 60;
    if (zone[0] == '-') offset = -offset;
  }
  int64_t local = 0;
  if (!mcp_parse_iso_utc(std::string(text.substr(0, 19)) + "Z", &local)) return false;
  *seconds = local - offset;
  return true;
}

// ---- secrets ------------------------------------------------------------------

std::string mcp_generate_secret() {
  // secure_random.hpp uses the system CSPRNG: getrandom, or /dev/urandom as the fallback.
  // 32 bytes give 43 base64url characters.
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  uint8_t bytes[32];
  secure_random_bytes(bytes, sizeof(bytes));
  std::string out = "mcp_";
  uint32_t buffer = 0;
  int bits = 0;
  for (const uint8_t b : bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out.push_back(alphabet[(buffer >> bits) & 63]);
    }
  }
  if (bits > 0) out.push_back(alphabet[(buffer << (6 - bits)) & 63]);
  return out;
}

bool mcp_valid_token(std::string_view token) {
  if (token.size() != kMcpTokenBytes || token.substr(0, 4) != "mcp_") return false;
  return std::all_of(token.begin() + 4, token.end(), [](char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
  });
}

bool mcp_valid_secret(std::string_view secret) { return mcp_valid_token(secret) || mcp_legacy_secret(secret); }

bool mcp_legacy_secret(std::string_view secret) {
  if (secret.size() != kMcpSecretBytes) return false;
  const auto hex = [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); };
  for (size_t i = 0; i < secret.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (secret[i] != '-') return false;
    } else if (!hex(secret[i])) {
      return false;
    }
  }
  if (secret[14] != '4') return false;
  const char variant = secret[19];
  return variant == '8' || variant == '9' || variant == 'a' || variant == 'b' || variant == 'A' || variant == 'B';
}

McpHash mcp_hash_secret(std::string_view secret) {
  return sha256_digest(reinterpret_cast<const uint8_t*>(secret.data()), secret.size());
}

std::string mcp_hash_hex(const McpHash& hash) {
  static const char hex[] = "0123456789abcdef";
  std::string out;
  out.reserve(64);
  for (const uint8_t b : hash) {
    out.push_back(hex[b >> 4]);
    out.push_back(hex[b & 15]);
  }
  return out;
}

bool mcp_parse_hash_hex(std::string_view text, McpHash* hash) {
  if (text.size() != 64) return false;
  const auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  McpHash out{};
  for (size_t i = 0; i < 32; ++i) {
    const int hi = nibble(text[i * 2]);
    const int lo = nibble(text[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  *hash = out;
  return true;
}

std::string mcp_secret_hint(std::string_view secret) {
  const bool token = secret.substr(0, 4) == "mcp_";
  return std::string(secret.substr(0, token ? kMcpTokenHintChars : kMcpSecretHintChars));
}

std::string mcp_secret_mask(std::string_view hint) {
  // The hint of an mcp_ token is `mcp_` and 8 characters.
  // Then comes a bullet for each of the 35 other characters.
  if (hint.size() == kMcpTokenHintChars && mcp_valid_token(std::string(hint) + std::string(kMcpTokenBytes - kMcpTokenHintChars, 'A'))) {
    std::string out(hint);
    for (size_t i = kMcpTokenHintChars; i < kMcpTokenBytes; ++i) out.append("\xE2\x80\xA2");
    return out;
  }
  // The hint of an older key is its first characters, and they are all hexadecimal.
  // Anything else, such as an empty hint, is not shown.
  const bool shown = hint.size() == kMcpSecretHintChars &&
                     std::all_of(hint.begin(), hint.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); });
  std::string out;
  for (size_t i = 0; i < kMcpSecretBytes; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) out.push_back('-');
    else if (shown && i < kMcpSecretHintChars) out.push_back(hint[i]);
    else out.append("\xE2\x80\xA2");
  }
  return out;
}

// ---- validation -----------------------------------------------------------------

bool mcp_valid_key_name(std::string_view name) {
  if (name.empty() || name.size() > kMcpNameMaxBytes) return false;
  if (name.substr(0, 3) == "ui_") return false;
  const auto first = name.front();
  if (!((first >= 'a' && first <= 'z') || (first >= '0' && first <= '9'))) return false;
  return std::all_of(name.begin(), name.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
  });
}

std::optional<McpValidationError> mcp_validate_key(const McpKey& key, const McpKeyContext& context) {
  if (key.name.empty()) return verr("name", "required", "name is required");
  if (key.name.size() > kMcpNameMaxBytes) return verr("name", "too_long", "name is longer than 32 bytes");
  if (!mcp_valid_key_name(key.name)) {
    return verr("name", "invalid",
                "name must use a-z, 0-9, - and _, start with a letter or digit, and not start with ui_");
  }

  // A key reads one host at most, and it names that host.
  // A key cannot use a list or a wildcard.
  // Without this rule, a client that asks for another host must guess which host the key reads.
  //
  // The client must also guess which MCP user answers for it.
  // A key must read a host. Without a host, the key does nothing.
  // The page cannot say which MCP user answers for the key.
  if (key.hosts.empty()) return verr("hosts", "required", "a key needs a host: name one that has an mcp_uri");
  if (has_duplicates(key.hosts)) return verr("hosts", "duplicate", "hosts lists a name twice");
  if (key.hosts.size() > 1) return verr("hosts", "too_many", "a key reads one host at most: create one key for each host");
  for (const auto& host : key.hosts) {
    if (host.empty()) return verr("hosts", "invalid", "hosts has an empty name");
    if (host == "*") return verr("hosts", "invalid", "a key names its host: \"*\" is not allowed");
    if (std::find(context.hosts.begin(), context.hosts.end(), host) == context.hosts.end()) {
      return verr("hosts", "unknown_host", "host " + host + " is not configured or has no mcp_uri");
    }
  }

  // The tools of the analysis of the keys (mcp_analysis_*) are names like the others.
  // They read no table, so any data scope is valid.
  // A key can name a tool that every key has. This is harmless.
  // A key can also name a tool that the configuration does not offer yet.
  // tools/list and tools/call decide at run time.
  if (has_duplicates(key.tools)) return verr("tools", "duplicate", "tools lists a name twice");
  const bool all_data = mcp_scope_all_data(key.databases);
  for (const auto& tool : key.tools) {
    if (tool == "*") continue;
    const McpToolInfo* info = mcp_find_tool(tool);
    if (!info) return verr("tools", "unknown_tool", "unknown tool " + tool);
    if (info->needs_all_data && !all_data) {
      return verr("tools", "needs_all_data",
                  "tool " + tool + " runs free SQL and needs databases = [\"*\"] (all the data)");
    }
  }

  if (has_duplicates(key.databases)) return verr("databases", "duplicate", "databases lists a pattern twice");
  for (const auto& pattern : key.databases) {
    std::string why;
    if (!mcp_valid_database_pattern(pattern, &why)) {
      return verr("databases", "invalid", "pattern \"" + pattern + "\" " + why);
    }
  }

  if (key.max_rows && (*key.max_rows < 1 || *key.max_rows > context.max_rows_cap)) {
    return verr("max_rows", "range", "max_rows must be between 1 and " + std::to_string(context.max_rows_cap));
  }
  if (key.timeout_seconds && (*key.timeout_seconds < 1 || *key.timeout_seconds > context.timeout_cap)) {
    return verr("timeout_seconds", "range", "timeout_seconds must be between 1 and " + std::to_string(context.timeout_cap));
  }
  // A key can only decrease the global rate limit. With no global limit (0), a key can set any limit.
  const int64_t rate_cap = context.rate_limit_cap > 0 ? context.rate_limit_cap : 1000000;
  if (key.rate_limit_per_minute && (*key.rate_limit_per_minute < 1 || *key.rate_limit_per_minute > rate_cap)) {
    return verr("rate_limit_per_minute", "range", "rate_limit_per_minute must be between 1 and " + std::to_string(rate_cap));
  }
  return std::nullopt;
}

// ---- request bodies ---------------------------------------------------------------

std::optional<McpValidationError> mcp_parse_key_input(std::string_view body, McpKeyInput* out) {
  rapidjson::Document doc;
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc, body);
  if (doc.HasParseError() || !doc.IsObject()) return verr("", "invalid_json", "the body must be a JSON object");
  static constexpr const char* kFields[] = {"name", "hosts", "tools", "databases", "max_rows", "timeout_seconds"};
  for (const auto& m : doc.GetObject()) {
    const std::string_view name(m.name.GetString(), m.name.GetStringLength());
    if (std::none_of(std::begin(kFields), std::end(kFields), [&](const char* field) { return name == field; })) {
      // The field name names the member.
      // The name is cut to a length that an error message can carry.
      const std::string shown(name.substr(0, 64));
      return McpValidationError{shown, "unknown_field", "unknown field " + shown + ": a key has name, hosts, tools, databases, max_rows and timeout_seconds"};
    }
  }

  const auto member = [&](const char* name) -> const rapidjson::Value* {
    const auto it = doc.FindMember(name);
    return it == doc.MemberEnd() ? nullptr : &it->value;
  };

  if (const auto* v = member("name")) {
    if (!v->IsString()) return verr("name", "type", "name must be a string");
    out->name = std::string(v->GetString(), v->GetStringLength());
  }
  for (const char* field : {"hosts", "tools", "databases"}) {
    const auto* v = member(field);
    if (!v) continue;
    std::vector<std::string> list;
    if (auto err = read_string_list(*v, field, &list)) return err;
    if (std::strcmp(field, "hosts") == 0) out->hosts = std::move(list);
    else if (std::strcmp(field, "tools") == 0) out->tools = std::move(list);
    else out->databases = std::move(list);
  }
  if (const auto* v = member("max_rows")) {
    if (auto err = read_optional_int(*v, "max_rows", &out->max_rows)) return err;
  }
  if (const auto* v = member("timeout_seconds")) {
    if (auto err = read_optional_int(*v, "timeout_seconds", &out->timeout_seconds)) return err;
  }

  if (!out->name) return verr("name", "required", "name is required");
  if (!out->hosts) return verr("hosts", "required", "hosts is required");
  if (!out->tools) return verr("tools", "required", "tools is required");
  if (!out->databases) return verr("databases", "required", "databases is required");
  return std::nullopt;
}

// ---- JSON ----------------------------------------------------------------------------

namespace {

void write_string(McpJsonWriter& w, std::string_view s) { write_json_text(w, s); }

void write_string_list(McpJsonWriter& w, const char* name, const std::vector<std::string>& values) {
  w.Key(name);
  w.StartArray();
  for (const auto& v : values) write_string(w, v);
  w.EndArray();
}

void write_optional_int(McpJsonWriter& w, const char* name, const std::optional<int64_t>& value) {
  w.Key(name);
  if (value) w.Int64(*value);
  else w.Null();
}

void write_optional_time(McpJsonWriter& w, const char* name, const std::optional<int64_t>& value) {
  w.Key(name);
  if (value) write_string(w, mcp_iso_utc(*value));
  else w.Null();
}

} // namespace

void mcp_write_key(McpJsonWriter& w, const McpKey& key, std::optional<int64_t> last_used) {
  w.StartObject();
  w.Key("id"); write_string(w, key.id);
  w.Key("name"); write_string(w, key.name);
  w.Key("source"); write_string(w, key.source);
  w.Key("secret_hint"); write_string(w, key.secret_hint);
  // The secret as the page shows it: the shape of a UUID, and the hint in clear (mcp_secret_mask).
  // The secret itself is never here. The store does not have it.
  w.Key("secret_mask"); write_string(w, mcp_secret_mask(key.secret_hint));
  write_string_list(w, "hosts", key.hosts);
  write_string_list(w, "tools", key.tools);
  write_string_list(w, "databases", key.databases);
  write_optional_int(w, "max_rows", key.max_rows);
  write_optional_int(w, "timeout_seconds", key.timeout_seconds);
  // The subject and the expiry of a key of the configuration (mcp_key).
  // The value is null for a key without them.
  w.Key("subject");
  if (key.subject.empty()) w.Null();
  else write_string(w, key.subject);
  write_optional_time(w, "expires_at", key.expires_at);
  write_optional_time(w, "created_at", key.created_at);
  write_optional_time(w, "last_used_at", last_used);
  w.EndObject();
}

// ---- the UI key file --------------------------------------------------------------------

std::string mcp_serialize_key_file(const std::vector<McpKey>& ui_keys) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Int(kMcpKeyFileVersion);
  w.Key("keys");
  w.StartArray();
  for (const auto& key : ui_keys) {
    w.StartObject();
    w.Key("id"); write_string(w, key.id);
    w.Key("name"); write_string(w, key.name);
    w.Key("secret_sha256"); write_string(w, mcp_hash_hex(key.secret_hash));
    w.Key("secret_hint"); write_string(w, key.secret_hint);
    write_string_list(w, "hosts", key.hosts);
    write_string_list(w, "tools", key.tools);
    write_string_list(w, "databases", key.databases);
    write_optional_int(w, "max_rows", key.max_rows);
    write_optional_int(w, "timeout_seconds", key.timeout_seconds);
    write_optional_time(w, "created_at", key.created_at);
    write_optional_time(w, "updated_at", key.updated_at);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  std::string text(sb.GetString(), sb.GetSize());
  text.push_back('\n');
  return text;
}

namespace {

[[noreturn]] void file_error(const std::string& what) { throw std::runtime_error(what); }

std::vector<std::string> file_string_list(const rapidjson::Value& obj, const char* name, size_t index) {
  const auto it = obj.FindMember(name);
  const std::string where = "keys[" + std::to_string(index) + "]." + name;
  if (it == obj.MemberEnd() || !it->value.IsArray()) file_error(where + " must be an array of strings");
  std::vector<std::string> out;
  for (const auto& item : it->value.GetArray()) {
    if (!item.IsString()) file_error(where + " must be an array of strings");
    out.emplace_back(item.GetString(), item.GetStringLength());
  }
  return out;
}

std::optional<int64_t> file_optional_int(const rapidjson::Value& obj, const char* name, size_t index) {
  const auto it = obj.FindMember(name);
  if (it == obj.MemberEnd() || it->value.IsNull()) return std::nullopt;
  if (!it->value.IsInt64()) file_error("keys[" + std::to_string(index) + "]." + name + " must be an integer or null");
  return it->value.GetInt64();
}

std::optional<int64_t> file_optional_time(const rapidjson::Value& obj, const char* name, size_t index) {
  const auto it = obj.FindMember(name);
  if (it == obj.MemberEnd() || it->value.IsNull()) return std::nullopt;
  int64_t seconds = 0;
  if (!it->value.IsString() ||
      !mcp_parse_iso_utc(std::string_view(it->value.GetString(), it->value.GetStringLength()), &seconds)) {
    file_error("keys[" + std::to_string(index) + "]." + name + " must be an ISO 8601 UTC time or null");
  }
  return seconds;
}

std::string file_string(const rapidjson::Value& obj, const char* name, size_t index, bool required) {
  const auto it = obj.FindMember(name);
  if (it == obj.MemberEnd()) {
    if (required) file_error("keys[" + std::to_string(index) + "]." + name + " is missing");
    return {};
  }
  if (!it->value.IsString()) file_error("keys[" + std::to_string(index) + "]." + name + " must be a string");
  return std::string(it->value.GetString(), it->value.GetStringLength());
}

} // namespace

std::vector<McpKey> mcp_parse_key_file(std::string_view text) {
  rapidjson::Document doc;
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc, text);
  if (doc.HasParseError()) file_error("not valid JSON");
  if (!doc.IsObject()) file_error("the top level must be a JSON object");
  const auto version = doc.FindMember("version");
  if (version == doc.MemberEnd() || !version->value.IsInt() || version->value.GetInt() != kMcpKeyFileVersion) {
    file_error("version must be 1");
  }
  const auto keys = doc.FindMember("keys");
  if (keys == doc.MemberEnd() || !keys->value.IsArray()) file_error("keys must be an array");
  if (keys->value.Size() > kMcpMaxUiKeys) file_error("too many keys");

  std::vector<McpKey> out;
  size_t index = 0;
  for (const auto& item : keys->value.GetArray()) {
    if (!item.IsObject()) file_error("keys[" + std::to_string(index) + "] must be an object");
    McpKey key;
    key.source = "ui";
    key.id = file_string(item, "id", index, true);
    key.name = file_string(item, "name", index, true);
    // The store keeps only the hash and the hint. ChDash does not write a file with a key that has its secret in clear.
    if (item.HasMember("secret")) {
      file_error("keys[" + std::to_string(index) + "] holds a secret in clear: ChDash stores only its hash. Delete the file and make the keys again");
    }
    key.secret_hint = file_string(item, "secret_hint", index, false);
    if (!valid_ui_id(key.id)) file_error("keys[" + std::to_string(index) + "].id must look like ui_0a1b2c3d4e5f");
    if (!mcp_valid_key_name(key.name)) file_error("keys[" + std::to_string(index) + "].name is not a valid key name");
    if (key.secret_hint.size() > 32) {
      file_error("keys[" + std::to_string(index) + "] has a field that is too long");
    }
    if (!mcp_parse_hash_hex(file_string(item, "secret_sha256", index, true), &key.secret_hash)) {
      file_error("keys[" + std::to_string(index) + "].secret_sha256 must be 64 hex characters");
    }
    // The hint of an mcp_ token has 12 characters.
    // The hint of an older key has 8 characters.
    const size_t hint_chars = key.secret_hint.substr(0, 4) == "mcp_" ? kMcpTokenHintChars : kMcpSecretHintChars;
    if (key.secret_hint.size() > hint_chars) key.secret_hint.resize(hint_chars);
    key.legacy_token = key.secret_hint.substr(0, 4) != "mcp_";
    key.hosts = file_string_list(item, "hosts", index);
    key.tools = file_string_list(item, "tools", index);
    key.databases = file_string_list(item, "databases", index);
    for (const auto& pattern : key.databases) {
      if (!mcp_valid_database_pattern(pattern)) file_error("keys[" + std::to_string(index) + "].databases has an invalid pattern");
    }
    key.max_rows = file_optional_int(item, "max_rows", index);
    key.timeout_seconds = file_optional_int(item, "timeout_seconds", index);
    key.created_at = file_optional_time(item, "created_at", index);
    key.updated_at = file_optional_time(item, "updated_at", index);
    // A key that an older ChDash had switched off is not loaded.
    // Nobody wants such a key.
    // Because it is not loaded, the removal of the switch cannot make it active.
    const auto enabled = item.FindMember("enabled");
    if (enabled != item.MemberEnd() && enabled->value.IsBool() && !enabled->value.GetBool()) {
      ++index;
      continue;
    }
    for (const auto& other : out) {
      if (other.id == key.id) file_error("two keys have the id " + key.id);
      if (other.name == key.name) file_error("two keys have the name " + key.name);
      if (other.secret_hash == key.secret_hash) file_error("two keys have the same secret");
    }
    out.push_back(std::move(key));
    ++index;
  }
  return out;
}

std::vector<McpKey> mcp_load_key_file(const std::string& path) {
  namespace fs = std::filesystem;
  std::error_code ec;
  const fs::path target(path);
  if (!fs::exists(target, ec)) {
    fs::path dir = target.parent_path();
    if (dir.empty()) dir = ".";
    if (!fs::is_directory(dir, ec)) file_error("the directory " + dir.string() + " does not exist");
    return {};
  }
  if (!fs::is_regular_file(target, ec)) file_error("not a regular file");
  const auto size = fs::file_size(target, ec);
  if (ec) file_error(std::string("cannot read the file: ") + ec.message());
  if (size > kMaxFileBytes) file_error("the file is larger than 4 MiB");
  std::ifstream input(path, std::ios::binary);
  if (!input) file_error(std::string("cannot open the file: ") + std::generic_category().message(errno));
  std::ostringstream content;
  content << input.rdbuf();
  if (input.bad()) file_error("cannot read the file");
  return mcp_parse_key_file(content.str());
}

// ---- the store -----------------------------------------------------------------------------

McpKeyStore::McpKeyStore(McpStoreOptions options) : options_(std::move(options)) {
  for (auto key : options_.config_keys) {
    key.source = "config";
    key.id = key.name;
    keys_.push_back(std::move(key));
  }
  // In the static mode, the keys of the file do not apply.
  // config.cpp writes a warning when the file has keys.
  if (!options_.storage_file.empty() && options_.mode != McpKeysMode::Static) {
    for (auto& key : mcp_load_key_file(options_.storage_file)) keys_.push_back(std::move(key));
  }
  for (size_t i = 0; i < keys_.size(); ++i) {
    for (size_t j = 0; j < i; ++j) {
      if (keys_[i].name == keys_[j].name) throw std::runtime_error("two keys have the name " + keys_[i].name);
      if (keys_[i].secret_hash == keys_[j].secret_hash) {
        throw std::runtime_error("keys " + keys_[j].name + " and " + keys_[i].name + " have the same secret");
      }
    }
  }
}

McpKeyStore::Result McpKeyStore::fail(int status, const char* error, const std::string& message) const {
  Result r;
  r.status = status;
  r.error = error;
  r.message = message;
  return r;
}

McpKeyStore::Result McpKeyStore::invalid(const McpValidationError& error) const {
  Result r;
  r.status = 400;
  r.error = "validation";
  r.field = error.field;
  r.reason = error.reason;
  r.message = error.message;
  return r;
}

bool McpKeyStore::name_taken_locked(const std::string& name, const std::string& except_id) const {
  for (const auto& key : keys_) {
    if (key.name == name && key.id != except_id) return true;
  }
  return false;
}

std::vector<McpKey> McpKeyStore::ui_keys_locked() const {
  std::vector<McpKey> out;
  for (const auto& key : keys_) {
    if (key.source == "ui") out.push_back(key);
  }
  return out;
}

bool McpKeyStore::write_file(const std::vector<McpKey>& keys, std::string* error) const {
  std::vector<McpKey> ui;
  for (const auto& key : keys) {
    if (key.source == "ui") ui.push_back(key);
  }
  return atomic_write_file(options_.storage_file, mcp_serialize_key_file(ui), error);
}

std::string McpKeyStore::new_id_locked() const {
  static const char hex[] = "0123456789abcdef";
  for (int attempt = 0; attempt < 16; ++attempt) {
    uint8_t bytes[6];
    secure_random_bytes(bytes, sizeof(bytes));
    std::string id = "ui_";
    for (const uint8_t b : bytes) {
      id.push_back(hex[b >> 4]);
      id.push_back(hex[b & 15]);
    }
    const bool used = std::any_of(keys_.begin(), keys_.end(), [&](const McpKey& k) { return k.id == id; });
    if (!used) return id;
  }
  throw std::runtime_error("cannot find a free key id");
}

void McpKeyStore::apply_input(const McpKeyInput& input, McpKey* key) const {
  if (input.name) key->name = *input.name;
  if (input.hosts) key->hosts = *input.hosts;
  if (input.tools) key->tools = *input.tools;
  if (input.databases) key->databases = *input.databases;
  key->max_rows = input.max_rows;
  key->timeout_seconds = input.timeout_seconds;
}

std::vector<McpKey> McpKeyStore::list() {
  std::lock_guard<std::mutex> lock(mu_);
  std::vector<McpKey> out;
  for (const auto& key : keys_) {
    if (key.source == "config") out.push_back(key);
  }
  const size_t first_ui = out.size();
  for (const auto& key : keys_) {
    if (key.source == "ui") out.push_back(key);
  }
  std::stable_sort(out.begin() + static_cast<std::ptrdiff_t>(first_ui), out.end(), [](const McpKey& a, const McpKey& b) {
    return a.created_at.value_or(0) < b.created_at.value_or(0);
  });
  return out;
}

McpKeyStore::Result McpKeyStore::create(const McpKeyInput& input, int64_t now) {
  std::lock_guard<std::mutex> writing(write_mu_);
  std::unique_lock<std::mutex> lock(mu_);
  if (!manage_from_ui()) return fail(403, "manage_disabled", "keys are managed in the configuration (mcp.keys.mode = \"static\")");
  if (options_.storage_file.empty()) return fail(409, "storage_not_configured", "mcp.storage_file is not set, so keys cannot be created here");
  if (ui_keys_locked().size() >= kMcpMaxUiKeys) return invalid(verr("name", "range", "too many keys"));

  McpKey key;
  key.source = "ui";
  apply_input(input, &key);
  if (auto err = mcp_validate_key(key, options_.context)) return invalid(*err);
  // Only the running server knows this.
  // It checks that the MCP user of the host is there, and that this MCP user can serve the tools.
  if (options_.context.live_check) {
    if (auto err = options_.context.live_check(key)) return invalid(*err);
  }
  if (name_taken_locked(key.name, "")) return fail(409, "name_taken", "a key named " + key.name + " exists");

  std::string secret;
  McpHash hash{};
  for (int attempt = 0;; ++attempt) {
    secret = mcp_generate_secret();
    hash = mcp_hash_secret(secret);
    const bool used = std::any_of(keys_.begin(), keys_.end(), [&](const McpKey& k) { return k.secret_hash == hash; });
    if (!used) break;
    if (attempt > 8) return fail(500, "internal_error", "cannot generate a unique secret");
  }
  key.id = new_id_locked();
  key.secret_hash = hash;
  key.secret_hint = mcp_secret_hint(secret);
  key.created_at = now;
  key.updated_at = now;

  // The file is written without mu_. authenticate() continues during the write.
  // write_mu_ keeps every other change out.
  // So keys_ is still the source of the candidate when the candidate replaces it.
  std::vector<McpKey> candidate = keys_;
  candidate.push_back(key);
  lock.unlock();
  std::string error;
  if (!write_file(candidate, &error)) return fail(500, "storage_error", "the key file could not be written: " + error);
  lock.lock();
  keys_ = std::move(candidate);
  Result r;
  r.status = 201;
  r.key = key;
  r.secret = std::move(secret);
  return r;
}

McpKeyStore::Result McpKeyStore::remove(const std::string& id) {
  std::lock_guard<std::mutex> writing(write_mu_);
  std::unique_lock<std::mutex> lock(mu_);
  if (!manage_from_ui()) return fail(403, "manage_disabled", "keys are managed in the configuration (mcp.keys.mode = \"static\")");
  const auto it = std::find_if(keys_.begin(), keys_.end(), [&](const McpKey& k) { return k.id == id; });
  if (it == keys_.end()) return fail(404, "not_found", "no key has the id " + id);
  if (it->source == "config") return fail(409, "config_key", "a key of the configuration cannot be deleted here");

  // This is a copy on purpose.
  // keys_ is replaced below. That ends the life of *it.
  const McpKey removed = *it;  // NOLINT(performance-unnecessary-copy-initialization)
  std::vector<McpKey> candidate = keys_;
  candidate.erase(candidate.begin() + (it - keys_.begin()));
  lock.unlock();
  std::string error;
  if (!write_file(candidate, &error)) return fail(500, "storage_error", "the key file could not be written: " + error);
  lock.lock();
  keys_ = std::move(candidate);
  Result r;
  r.key = removed;
  return r;
}

const char* mcp_keys_mode_name(McpKeysMode mode) {
  switch (mode) {
    case McpKeysMode::Static: return "static";
    case McpKeysMode::Dynamic: return "dynamic";
    case McpKeysMode::Hybrid: return "hybrid";
  }
  return "hybrid";
}

McpKeyStore::AuthResult McpKeyStore::authenticate(std::string_view token, int64_t now) {
  AuthResult result;
  if (token.empty()) return result;
  result.status = AuthStatus::Unknown;
  if (token.size() > 512) return result;
  const McpHash hash = mcp_hash_secret(token);
  std::lock_guard<std::mutex> lock(mu_);
  // Compare against every key. Do not stop early.
  const McpKey* found = nullptr;
  for (const auto& key : keys_) {
    if (constant_time_equal(hash.data(), key.secret_hash.data(), hash.size())) found = &key;
  }
  if (!found) return result;
  // An expired key gets the same answer as an unknown key.
  // The caller cannot tell the two apart.
  if (found->expires_at && *found->expires_at <= now) {
    result.status = AuthStatus::Expired;
    return result;
  }
  result.key = *found;
  result.status = AuthStatus::Ok;
  return result;
}

// ---- the rate limit -------------------------------------------------------------------------

bool McpRateLimiter::allow(const std::string& key_id, int64_t now_ms, int64_t per_minute, int* retry_after_seconds) {
  if (per_minute <= 0) return true;
  std::lock_guard<std::mutex> lock(mu_);
  const double capacity = static_cast<double>(per_minute);
  const auto it = buckets_.try_emplace(key_id, Bucket{capacity, now_ms}).first;
  Bucket& bucket = it->second;
  const double rate = capacity / 60000.0;  // tokens per millisecond
  if (now_ms > bucket.at_ms) {
    bucket.tokens = std::min(capacity, bucket.tokens + static_cast<double>(now_ms - bucket.at_ms) * rate);
    bucket.at_ms = now_ms;
  }
  if (bucket.tokens >= 1.0) {
    bucket.tokens -= 1.0;
    return true;
  }
  if (retry_after_seconds) {
    const double wait_ms = (1.0 - bucket.tokens) / rate;
    *retry_after_seconds = std::max(1, static_cast<int>(wait_ms / 1000.0) + 1);
  }
  return false;
}

McpRateStatus McpRateLimiter::peek(const std::string& key_id, int64_t now_ms, int64_t per_minute) {
  McpRateStatus status;
  if (per_minute <= 0) return status;
  status.per_minute = per_minute;
  const double capacity = static_cast<double>(per_minute);
  const double rate = capacity / 60000.0;  // tokens per millisecond
  // The same arithmetic as allow() applies, on a copy.
  // A key that has no bucket yet has a full bucket.
  double tokens = capacity;
  {
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = buckets_.find(key_id);
    if (it != buckets_.end()) {
      tokens = std::min(capacity, it->second.tokens);
      if (now_ms > it->second.at_ms) tokens = std::min(capacity, tokens + static_cast<double>(now_ms - it->second.at_ms) * rate);
    }
  }
  status.remaining = static_cast<int64_t>(tokens);  // whole calls: the fraction of a token is not a call
  if (tokens < 1.0) status.next_call_in_seconds = std::max(1, static_cast<int>((1.0 - tokens) / rate / 1000.0) + 1);
  if (tokens < capacity) status.full_in_seconds = std::max<int64_t>(1, static_cast<int64_t>(std::ceil((capacity - tokens) / rate / 1000.0)));
  return status;
}

} // namespace chdash
