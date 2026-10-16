#pragma once

#include <rapidjson/document.h>

#include <cstddef>
#include <string_view>

namespace chdash {

// The deepest nesting of arrays and objects that a JSON text may have. The parse
// itself does not recurse (kParseIterativeFlag). The walk through a document recurses once for each level. This is true for Accept and for the readers of the handlers.
// A request body of a few kilobytes of "[" would otherwise overflow the stack of a worker thread and stop the whole process.
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

// Parses `text` into `doc` without recursion. A text that nests deeper than kJsonMaxDepth is refused like an invalid text.
// `doc` then holds a parse error (an empty document). A caller that tests doc.HasParseError() sees the error too.
// This function returns true when `doc` holds the parsed value.
template <unsigned ParseFlags = rapidjson::kParseDefaultFlags, typename Document>
bool parse_json_bounded(Document& doc, std::string_view text) {
  if (json_nests_deeper_than(text, kJsonMaxDepth)) {
    doc.template Parse<ParseFlags | rapidjson::kParseIterativeFlag>("", 0);
    return false;
  }
  doc.template Parse<ParseFlags | rapidjson::kParseIterativeFlag>(text.data(), text.size());
  return !doc.HasParseError();
}

} // namespace chdash
