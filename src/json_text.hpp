#pragma once

// Text in JSON. A ClickHouse String holds bytes: a NUL byte, or bytes that are not UTF-8. JSON text is
// UTF-8, and rapidjson's String(const char*) stops at the first NUL byte. write_json_text() writes the
// whole length of the text and replaces each byte that does not start a valid UTF-8 sequence with U+FFFD,
// so every JSON document of the API is valid UTF-8 and a value is never cut short.

#include <rapidjson/rapidjson.h>

#include <cstddef>
#include <string>
#include <string_view>

namespace chdash {

// The length (1 to 4) of the valid UTF-8 sequence that starts at s[i], or 0 when s[i] does not start one
// (a continuation byte, an overlong form, a surrogate, a code point above U+10FFFF, a cut sequence).
inline size_t utf8_sequence_length(std::string_view s, size_t i) {
  const auto at = [&](size_t k) { return static_cast<unsigned char>(s[k]); };
  const unsigned char c = at(i);
  if (c <= 0x7F) return 1;
  const auto cont = [&](size_t k) { return k < s.size() && (at(k) & 0xC0) == 0x80; };
  if (c >= 0xC2 && c <= 0xDF) return cont(i + 1) ? 2 : 0;
  if (c >= 0xE0 && c <= 0xEF) {
    if (!cont(i + 1) || !cont(i + 2)) return 0;
    if (c == 0xE0 && at(i + 1) < 0xA0) return 0;
    if (c == 0xED && at(i + 1) >= 0xA0) return 0;
    return 3;
  }
  if (c >= 0xF0 && c <= 0xF4) {
    if (!cont(i + 1) || !cont(i + 2) || !cont(i + 3)) return 0;
    if (c == 0xF0 && at(i + 1) < 0x90) return 0;
    if (c == 0xF4 && at(i + 1) >= 0x90) return 0;
    return 4;
  }
  return 0;
}

inline bool is_valid_utf8(std::string_view s) {
  for (size_t i = 0; i < s.size();) {
    const size_t n = utf8_sequence_length(s, i);
    if (n == 0) return false;
    i += n;
  }
  return true;
}

// `s` with each byte that does not start a valid UTF-8 sequence replaced by U+FFFD.
inline std::string utf8_with_replacement(std::string_view s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (size_t i = 0; i < s.size();) {
    const size_t n = utf8_sequence_length(s, i);
    if (n == 0) {
      out += "\xEF\xBF\xBD";
      ++i;
    } else {
      out.append(s.data() + i, n);
      i += n;
    }
  }
  return out;
}

// `s` without the UTF-8 sequence that a cut by bytes left incomplete at its end (the text of a
// byte-bounded substring of ClickHouse, for example).
inline std::string_view utf8_without_cut_tail(std::string_view s) {
  size_t lead = s.size();
  for (size_t k = 0; k < 4 && lead > 0; ++k) {
    const unsigned char c = static_cast<unsigned char>(s[--lead]);
    if ((c & 0xC0) == 0x80) continue;
    const size_t need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
    return lead + need > s.size() ? s.substr(0, lead) : s;
  }
  return s;
}

// The longest prefix of `s` of at most `max_bytes` bytes that does not end inside a UTF-8 sequence.
inline std::string_view utf8_prefix(std::string_view s, size_t max_bytes) {
  return s.size() <= max_bytes ? s : utf8_without_cut_tail(s.substr(0, max_bytes));
}

template <typename Writer>
inline void write_json_text(Writer& w, std::string_view s) {
  if (is_valid_utf8(s)) {
    w.String(s.data(), static_cast<rapidjson::SizeType>(s.size()));
    return;
  }
  const std::string fixed = utf8_with_replacement(s);
  w.String(fixed.data(), static_cast<rapidjson::SizeType>(fixed.size()), true);
}

// The same for the name of a member (a name can come from the data: the key of an attribute, the name of a column).
template <typename Writer>
inline void write_json_key(Writer& w, std::string_view s) {
  if (is_valid_utf8(s)) {
    w.Key(s.data(), static_cast<rapidjson::SizeType>(s.size()));
    return;
  }
  const std::string fixed = utf8_with_replacement(s);
  w.Key(fixed.data(), static_cast<rapidjson::SizeType>(fixed.size()), true);
}

} // namespace chdash
