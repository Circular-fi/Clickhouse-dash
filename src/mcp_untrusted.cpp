#include "mcp_untrusted.hpp"

#include <cstdint>

namespace chdash {
namespace {

int hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// A control character of Unicode (category Cc): U+0000 to U+001F, U+007F to U+009F. The line feed and the tab stay.
bool replaced(uint32_t code) {
  if (code == 0x0a || code == 0x09) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

constexpr std::string_view kReplacement = "\\ufffd";

struct Scan {
  bool untrusted_key = false;
  bool changed = false;
};

// One pass over the JSON text. When `out` is not null, it receives the text with the control characters replaced. The
// scanner knows only where a string starts and ends: the text is the output of a JSON writer, so it is valid.
Scan scan(std::string_view json, std::string* out) {
  Scan result;
  bool in_string = false;
  size_t string_start = 0;
  size_t copied = 0;  // the bytes of `json` before this index are in `out`
  const auto replace = [&](size_t from, size_t to) {
    result.changed = true;
    if (!out) return;
    out->append(json.substr(copied, from - copied));
    out->append(kReplacement);
    copied = to;
  };
  for (size_t i = 0; i < json.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(json[i]);
    if (!in_string) {
      if (c == '"') {
        in_string = true;
        string_start = i + 1;
      }
      continue;
    }
    if (c == '"') {
      in_string = false;
      // A member name: the string and then a colon.
      if (json.substr(string_start, i - string_start) == "untrusted") {
        size_t next = i + 1;
        while (next < json.size() && (json[next] == ' ' || json[next] == '\n' || json[next] == '\t' || json[next] == '\r')) ++next;
        if (next < json.size() && json[next] == ':') result.untrusted_key = true;
      }
      continue;
    }
    if (c == '\\' && i + 1 < json.size()) {
      const char e = json[i + 1];
      if (e == 'b' || e == 'f' || e == 'r') {
        replace(i, i + 2);
        ++i;
      } else if (e == 'u' && i + 5 < json.size()) {
        uint32_t code = 0;
        bool hex = true;
        for (size_t k = 2; k < 6; ++k) {
          const int v = hex_value(json[i + k]);
          if (v < 0) hex = false;
          code = code * 16 + static_cast<uint32_t>(v < 0 ? 0 : v);
        }
        if (hex && replaced(code)) replace(i, i + 6);
        i += 5;
      } else {
        ++i;  // \" \\ \/ \n \t
      }
      continue;
    }
    if (c < 0x20 || c == 0x7f) {
      // A raw control byte: a line feed and a tab become their escapes (a raw one would end the JSON string).
      result.changed = true;
      if (out) {
        out->append(json.substr(copied, i - copied));
        out->append(c == '\n' ? std::string_view("\\n") : c == '\t' ? std::string_view("\\t") : kReplacement);
        copied = i + 1;
      }
      continue;
    }
    if (c == 0xc2 && i + 1 < json.size()) {
      const unsigned char next = static_cast<unsigned char>(json[i + 1]);
      if (next >= 0x80 && next <= 0x9f) {  // U+0080 to U+009F in UTF-8
        replace(i, i + 2);
        ++i;
      }
    }
  }
  if (out && result.changed) out->append(json.substr(copied));
  return result;
}

} // namespace

bool mcp_has_untrusted(std::string_view json) { return scan(json, nullptr).untrusted_key; }

void mcp_frame_untrusted(std::string& json) {
  const Scan first = scan(json, nullptr);
  if (first.changed) {
    std::string fixed;
    fixed.reserve(json.size() + 64);
    scan(json, &fixed);
    json = std::move(fixed);
  }
  if (!first.untrusted_key) return;
  static const std::string member = [] {
    std::string text = "\"data_notice\":\"";
    for (const char* p = kMcpDataNotice; *p; ++p) {
      if (*p == '"' || *p == '\\') text.push_back('\\');
      text.push_back(*p);
    }
    return text + "\",";
  }();
  if (json.empty() || json.front() != '{' || json.compare(1, member.size() - 1, member, 0, member.size() - 1) == 0) return;
  json.insert(1, member);
}

} // namespace chdash
