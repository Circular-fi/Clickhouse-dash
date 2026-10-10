#pragma once

#include <rapidjson/document.h>

#include <cstddef>
#include <string_view>

namespace chdash {

// The deepest nesting of arrays and objects that a JSON text may have to be parsed. The parse
// itself does not recurse (kParseIterativeFlag), but walking a document (Accept, the readers of
// the handlers) recurses once per level: a request body of a few kilobytes of "[" would otherwise
// overflow the stack of a worker thread and stop the whole process.
inline constexpr size_t kJsonMaxDepth = 256;

// True when the arrays and objects of `text` nest deeper than `limit`. Brackets inside strings do
// not count; the scan stops at the first level past the limit.
inline bool json_nests_deeper_than(std::string_view text, size_t limit) {
  size_t depth = 0;
  bool in_string = false;
  bool escaped = false;
  for (const char c : text) {
    if (in_string) {
      if (escaped) escaped = false;
      else if (c == '\\') escaped = true;
      else if (c == '"') in_string = false;
      continue;
    }
    if (c == '"') {
      in_string = true;
    } else if (c == '[' || c == '{') {
      if (++depth > limit) return true;
    } else if ((c == ']' || c == '}') && depth > 0) {
      --depth;
    }
  }
  return false;
}

// Parses `text` into `doc` without recursion. A text that nests deeper than kJsonMaxDepth is
// refused like an invalid one: `doc` then holds a parse error (an empty document), so a caller that
// tests doc.HasParseError() sees it too. True when `doc` holds the parsed value.
template <unsigned ParseFlags = rapidjson::kParseDefaultFlags, typename Document>
bool parse_json_bounded(Document& doc, std::string_view text) {
  if (json_nests_deeper_than(text, kJsonMaxDepth)) {
    doc.template Parse<ParseFlags | rapidjson::kParseIterativeFlag>(text.data(), 0);
    return false;
  }
  doc.template Parse<ParseFlags | rapidjson::kParseIterativeFlag>(text.data(), text.size());
  return !doc.HasParseError();
}

} // namespace chdash
