#include "system_query_format.hpp"

#include <algorithm>

namespace chdash {
namespace system_page {

namespace {

bool is_word(char c) { return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_'; }
bool is_digit(char c) { return c >= '0' && c <= '9'; }
bool is_blank(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }

// The end of the quoted text that starts at `start` (a ', a " or a `): a backslash escapes the next character, a doubled quote mark is one.
size_t skip_quoted(std::string_view sql, size_t start) {
  const char quote = sql[start];
  size_t i = start + 1;
  while (i < sql.size()) {
    if (sql[i] == '\\') {
      i += 2;
      continue;
    }
    if (sql[i] == quote) {
      if (i + 1 < sql.size() && sql[i + 1] == quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    ++i;
  }
  return sql.size();
}

// The number of a stand-in that starts at `at` in `text`: five digits that start with 9, not part of a longer word or number, a decimal or
// a name (`x90900`, `1.90900`, `$90900`, `90900.5`, `90900a` are not).
std::optional<int> stand_in_at(std::string_view text, size_t at) {
  if (at + 5 > text.size() || text[at] != '9') return std::nullopt;
  for (size_t k = 1; k < 5; ++k) {
    if (!is_digit(text[at + k])) return std::nullopt;
  }
  if (at > 0 && (is_word(text[at - 1]) || text[at - 1] == '.' || text[at - 1] == '$')) return std::nullopt;
  if (at + 5 < text.size() && (is_word(text[at + 5]) || text[at + 5] == '.')) return std::nullopt;
  return std::stoi(std::string(text.substr(at, 5)));
}

bool holds_stand_in(std::string_view text) {
  for (size_t i = 0; i < text.size(); ++i) {
    if (stand_in_at(text, i)) return true;
  }
  return false;
}

// The padding of the expressions before their AS (one column, two spaces or more) takes back the width that `removed` placeholders gave up.
// Only the first AS of the line has such a padding.
std::string repad_alias(std::string line, size_t removed) {
  for (size_t p = 0; p + 1 < line.size(); ++p) {
    if (is_blank(line[p])) continue;
    size_t end = p + 1;
    while (end < line.size() && line[end] == ' ') ++end;
    if (end - (p + 1) < 2 || line.compare(end, 3, "AS ") != 0) continue;
    line.insert(end, removed, ' ');
    return line;
  }
  return line;
}

}  // namespace

std::optional<ShapeMask> mask_shape_placeholders(std::string_view text) {
  ShapeMask out;
  out.sql.reserve(text.size() + 16);
  size_t i = 0;
  while (i < text.size()) {
    const char c = text[i];
    size_t end = i;
    if (c == '\'' || c == '"' || c == '`') {
      end = skip_quoted(text, i);
    } else if (c == '-' && i + 1 < text.size() && text[i + 1] == '-') {
      const size_t newline = text.find('\n', i);
      end = newline == std::string_view::npos ? text.size() : newline;
    } else if (c == '/' && i + 1 < text.size() && text[i + 1] == '*') {
      const size_t close = text.find("*/", i + 2);
      end = close == std::string_view::npos ? text.size() : close + 2;
    }
    if (end > i) {
      out.sql.append(text.substr(i, end - i));
      i = end;
      continue;
    }
    if (c == '?') {
      const bool list = text.compare(i, 3, "?..") == 0;
      if (out.marks.size() >= kShapeMaskMax) return std::nullopt;
      out.sql += std::to_string(kShapeMaskBase + static_cast<int>(out.marks.size()));
      out.marks.push_back(list ? "?.." : "?");
      i += list ? 3 : 1;
      continue;
    }
    out.sql.push_back(c);
    ++i;
  }
  // Whatever the text holds, even in a string or a comment: a number of the range is the sign of a text that was not normalized.
  if (holds_stand_in(text)) return std::nullopt;
  return out;
}

std::optional<std::string> restore_shape_placeholders(std::string_view formatted, const std::vector<std::string>& marks) {
  std::vector<int> seen(marks.size(), 0);
  std::string out;
  out.reserve(formatted.size());
  size_t line_start = 0;
  while (line_start <= formatted.size()) {
    size_t line_end = formatted.find('\n', line_start);
    if (line_end == std::string_view::npos) line_end = formatted.size();
    const std::string_view line = formatted.substr(line_start, line_end - line_start);
    std::string restored;
    restored.reserve(line.size());
    size_t removed = 0;
    for (size_t i = 0; i < line.size();) {
      const auto number = stand_in_at(line, i);
      const long k = number ? static_cast<long>(*number) - kShapeMaskBase : -1;
      if (number && k >= 0 && static_cast<size_t>(k) < marks.size()) {
        ++seen[static_cast<size_t>(k)];
        removed += 5 - marks[static_cast<size_t>(k)].size();
        restored += marks[static_cast<size_t>(k)];
        i += 5;
      } else if (number) {
        restored.append(line.substr(i, 5));
        i += 5;
      } else {
        restored.push_back(line[i]);
        ++i;
      }
    }
    out += removed > 0 ? repad_alias(std::move(restored), removed) : restored;
    if (line_end >= formatted.size()) break;
    out.push_back('\n');
    line_start = line_end + 1;
  }
  if (std::any_of(seen.begin(), seen.end(), [](int count) { return count != 1; })) return std::nullopt;
  return out;
}

ShapeFormat format_shape_text(std::string_view normalized, const ShapeFormatFn& format) {
  ShapeFormat out;
  const auto masked = mask_shape_placeholders(normalized);
  if (!masked || masked->sql.find_first_not_of(" \t\r\n") == std::string::npos) return out;
  const ShapeFormatReply reply = format(masked->sql);
  if (!reply.text) {
    if (reply.transient) out.status = ShapeFormatStatus::Transient;
    return out;
  }
  size_t begin = 0, end = reply.text->size();
  while (begin < end && is_blank((*reply.text)[begin])) ++begin;
  while (end > begin && is_blank((*reply.text)[end - 1])) --end;
  if (begin == end) return out;
  auto restored = restore_shape_placeholders(std::string_view(*reply.text).substr(begin, end - begin), masked->marks);
  if (!restored) return out;
  out.status = ShapeFormatStatus::Formatted;
  out.text = std::move(*restored);
  return out;
}

}  // namespace system_page
}  // namespace chdash
