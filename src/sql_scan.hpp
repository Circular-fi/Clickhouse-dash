#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

struct SqlMaskResult {
  // Same byte length as the input. String/identifier/comment contents are
  // replaced with spaces while newlines are preserved. ASCII code outside
  // those regions is lower-cased to make cheap token scans deterministic.
  std::string code_lower;
  bool has_comments = false;
};

inline bool sql_is_ident_start(char ch) {
  const unsigned char c = static_cast<unsigned char>(ch);
  return std::isalpha(c) != 0 || ch == '_';
}

inline bool sql_is_ident_continue(char ch) {
  const unsigned char c = static_cast<unsigned char>(ch);
  return std::isalnum(c) != 0 || ch == '_';
}

inline char sql_ascii_lower(char ch) {
  if (ch >= 'A' && ch <= 'Z') return static_cast<char>(ch - 'A' + 'a');
  return ch;
}

inline SqlMaskResult mask_sql_surface(std::string_view sql) {
  SqlMaskResult result;
  result.code_lower.assign(sql.size(), ' ');

  enum class State {
    Code,
    SingleQuote,
    DoubleQuote,
    Backtick,
    LineComment,
    BlockComment,
  };

  State state = State::Code;
  bool escaped = false;

  for (size_t i = 0; i < sql.size(); ++i) {
    const char ch = sql[i];
    const char next = (i + 1 < sql.size()) ? sql[i + 1] : '\0';

    if (state == State::LineComment) {
      if (ch == '\n' || ch == '\r') {
        result.code_lower[i] = ch;
        state = State::Code;
      }
      continue;
    }

    if (state == State::BlockComment) {
      if (ch == '\n' || ch == '\r') result.code_lower[i] = ch;
      if (ch == '*' && next == '/') {
        ++i;
      }
      if (ch == '*' && next == '/') state = State::Code;
      continue;
    }

    if (state == State::SingleQuote) {
      if (ch == '\n' || ch == '\r') result.code_lower[i] = ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = true;
        continue;
      }
      if (ch == '\'' && next == '\'') {
        ++i; // SQL doubled quote inside a literal.
        continue;
      }
      if (ch == '\'') state = State::Code;
      continue;
    }

    if (state == State::DoubleQuote) {
      if (ch == '\n' || ch == '\r') result.code_lower[i] = ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = true;
        continue;
      }
      if (ch == '"' && next == '"') {
        ++i;
        continue;
      }
      if (ch == '"') state = State::Code;
      continue;
    }

    if (state == State::Backtick) {
      if (ch == '\n' || ch == '\r') result.code_lower[i] = ch;
      if (ch == '`' && next == '`') {
        ++i;
        continue;
      }
      if (ch == '`') state = State::Code;
      continue;
    }

    // Code state.
    if (ch == '\'') {
      state = State::SingleQuote;
      escaped = false;
      continue;
    }
    if (ch == '"') {
      state = State::DoubleQuote;
      escaped = false;
      continue;
    }
    if (ch == '`') {
      state = State::Backtick;
      continue;
    }
    if (ch == '-' && next == '-') {
      result.has_comments = true;
      state = State::LineComment;
      ++i;
      continue;
    }
    if (ch == '#') {
      result.has_comments = true;
      state = State::LineComment;
      continue;
    }
    if (ch == '/' && next == '*') {
      result.has_comments = true;
      state = State::BlockComment;
      ++i;
      continue;
    }

    result.code_lower[i] = sql_ascii_lower(ch);
  }

  return result;
}

// Return the first SQL keyword outside comments and quoted regions. The result
// is ASCII-lowercase and empty for a comment/whitespace-only buffer. This keeps
// statement classification correct for editor queries beginning with comments.
inline std::string sql_first_keyword_lower(std::string_view sql) {
  const auto masked = mask_sql_surface(sql);
  const std::string_view code(masked.code_lower);
  for (size_t i = 0; i < code.size();) {
    if (!sql_is_ident_start(code[i])) {
      ++i;
      continue;
    }
    const size_t start = i++;
    while (i < code.size() && sql_is_ident_continue(code[i])) ++i;
    return std::string(code.substr(start, i - start));
  }
  return {};
}

inline std::vector<std::pair<size_t, size_t>> sql_single_quoted_literal_ranges(
    std::string_view sql
) {
  std::vector<std::pair<size_t, size_t>> ranges;

  enum class State {
    Code,
    SingleQuote,
    DoubleQuote,
    Backtick,
    LineComment,
    BlockComment,
  };

  State state = State::Code;
  bool escaped = false;
  size_t literal_start = 0;

  for (size_t i = 0; i < sql.size(); ++i) {
    const char ch = sql[i];
    const char next = (i + 1 < sql.size()) ? sql[i + 1] : '\0';

    switch (state) {
      case State::LineComment:
        if (ch == '\n' || ch == '\r') state = State::Code;
        continue;
      case State::BlockComment:
        if (ch == '*' && next == '/') {
          ++i;
          state = State::Code;
        }
        continue;
      case State::DoubleQuote:
        if (escaped) {
          escaped = false;
        } else if (ch == '\\') {
          escaped = true;
        } else if (ch == '"' && next == '"') {
          ++i;
        } else if (ch == '"') {
          state = State::Code;
        }
        continue;
      case State::Backtick:
        if (ch == '`' && next == '`') {
          ++i;
        } else if (ch == '`') {
          state = State::Code;
        }
        continue;
      case State::SingleQuote:
        if (escaped) {
          escaped = false;
        } else if (ch == '\\') {
          escaped = true;
        } else if (ch == '\'' && next == '\'') {
          ++i;
        } else if (ch == '\'') {
          ranges.emplace_back(literal_start, i + 1);
          state = State::Code;
        }
        continue;
      case State::Code:
        break;
    }

    if (ch == '-' && next == '-') {
      state = State::LineComment;
      ++i;
    } else if (ch == '#') {
      state = State::LineComment;
    } else if (ch == '/' && next == '*') {
      state = State::BlockComment;
      ++i;
    } else if (ch == '"') {
      state = State::DoubleQuote;
      escaped = false;
    } else if (ch == '`') {
      state = State::Backtick;
    } else if (ch == '\'') {
      state = State::SingleQuote;
      escaped = false;
      literal_start = i;
    }
  }

  return ranges;
}

inline std::vector<std::string> extract_sql_single_quoted_literals(std::string_view sql) {
  const auto ranges = sql_single_quoted_literal_ranges(sql);
  std::vector<std::string> out;
  out.reserve(ranges.size());
  for (const auto& range : ranges) {
    out.emplace_back(sql.substr(range.first, range.second - range.first));
  }
  return out;
}

// Decode a single-quoted SQL literal (including its quotes) to the value the
// ClickHouse parser produces. Two spellings are interchangeable only when they
// decode to the same bytes, e.g. 'it''s' and 'it\'s'. Unknown escapes keep
// their backslash, matching ClickHouse's parseComplexEscapeSequence.
inline std::string decode_sql_single_quoted_literal(std::string_view literal) {
  std::string out;
  if (literal.size() < 2) return std::string(literal);
  const std::string_view body = literal.substr(1, literal.size() - 2);
  out.reserve(body.size());
  auto hex_value = [](char ch) -> int {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
  };
  for (size_t i = 0; i < body.size(); ++i) {
    const char ch = body[i];
    if (ch == '\'' && i + 1 < body.size() && body[i + 1] == '\'') {
      out.push_back('\'');
      ++i;
      continue;
    }
    if (ch != '\\' || i + 1 >= body.size()) {
      out.push_back(ch);
      continue;
    }
    const char esc = body[++i];
    switch (esc) {
      case 'b': out.push_back('\b'); break;
      case 'f': out.push_back('\f'); break;
      case 'n': out.push_back('\n'); break;
      case 'r': out.push_back('\r'); break;
      case 't': out.push_back('\t'); break;
      case '0': out.push_back('\0'); break;
      case 'a': out.push_back('\a'); break;
      case 'v': out.push_back('\v'); break;
      case '\\': case '\'': case '"': case '`': case '/': out.push_back(esc); break;
      case 'x':
        if (i + 2 < body.size() && hex_value(body[i + 1]) >= 0 && hex_value(body[i + 2]) >= 0) {
          out.push_back(static_cast<char>(hex_value(body[i + 1]) * 16 + hex_value(body[i + 2])));
          i += 2;
          break;
        }
        [[fallthrough]];
      default:
        out.push_back('\\');
        out.push_back(esc);
        break;
    }
  }
  return out;
}

// formatQuery re-escapes string literals; restore the user's exact spelling.
// Literals are matched by *decoded value*, in order, never by position alone:
// formatQuery also adds literals (CAST(x AS T) -> CAST(x, 'T'), x::T) and
// removes others (INTERVAL '2 hours' -> toIntervalHour(2)), so a positional
// swap would silently change query semantics. A formatted literal without an
// equal-valued source literal ahead of the cursor keeps its formatted spelling.
inline std::string restore_sql_single_quoted_literals(
    std::string formatted,
    std::string_view original
) {
  const auto source_ranges = sql_single_quoted_literal_ranges(original);
  if (source_ranges.empty()) return formatted;

  const auto formatted_ranges = sql_single_quoted_literal_ranges(formatted);
  if (formatted_ranges.empty()) return formatted;

  std::vector<std::string> source_values;
  source_values.reserve(source_ranges.size());
  for (const auto& [begin, end] : source_ranges) {
    source_values.push_back(decode_sql_single_quoted_literal(original.substr(begin, end - begin)));
  }

  std::string out;
  out.reserve(std::max(formatted.size(), original.size()));
  size_t cursor = 0;
  size_t source_cursor = 0;
  for (const auto& [begin, end] : formatted_ranges) {
    out.append(formatted, cursor, begin - cursor);
    const std::string_view current = std::string_view(formatted).substr(begin, end - begin);
    const std::string value = decode_sql_single_quoted_literal(current);
    size_t match = source_cursor;
    while (match < source_values.size() && source_values[match] != value) ++match;
    if (match < source_values.size()) {
      const auto [source_begin, source_end] = source_ranges[match];
      out.append(original.substr(source_begin, source_end - source_begin));
      source_cursor = match + 1;
    } else {
      out.append(current);
    }
    cursor = end;
  }
  out.append(formatted, cursor, formatted.size() - cursor);
  return out;
}


// Monospace display columns of one code point, as editors and terminals render
// it: East Asian Wide/Fullwidth characters and emoji take two columns, while
// combining marks, zero-width joiners/spaces, variation selectors and emoji
// skin-tone modifiers take none. Alignment that counts bytes or code points
// shifts the `AS` column as soon as a literal or identifier contains CJK or
// emoji. The tables cover the common blocks rather than all of Unicode's
// EastAsianWidth.txt; unlisted code points count as one column.
inline size_t sql_codepoint_display_width(char32_t cp) {
  struct Range { char32_t first; char32_t last; };
  static constexpr Range kZeroWidth[] = {
      {0x0300, 0x036F}, {0x0483, 0x0489}, {0x0591, 0x05BD}, {0x05BF, 0x05BF},
      {0x05C1, 0x05C2}, {0x05C4, 0x05C5}, {0x05C7, 0x05C7}, {0x0610, 0x061A},
      {0x064B, 0x065F}, {0x0670, 0x0670}, {0x06D6, 0x06DC}, {0x06DF, 0x06E4},
      {0x06E7, 0x06E8}, {0x06EA, 0x06ED}, {0x0E31, 0x0E31}, {0x0E34, 0x0E3A},
      {0x0E47, 0x0E4E}, {0x1AB0, 0x1AFF}, {0x1DC0, 0x1DFF}, {0x200B, 0x200F},
      {0x2060, 0x2064}, {0x20D0, 0x20FF}, {0x302A, 0x302D}, {0x3099, 0x309A},
      {0xFE00, 0xFE0F}, {0xFE20, 0xFE2F}, {0xFEFF, 0xFEFF}, {0x1F3FB, 0x1F3FF},
      {0xE0000, 0xE007F}, {0xE0100, 0xE01EF},
  };
  static constexpr Range kWide[] = {
      {0x1100, 0x115F}, {0x231A, 0x231B}, {0x2329, 0x232A}, {0x23E9, 0x23EC},
      {0x23F0, 0x23F0}, {0x23F3, 0x23F3}, {0x25FD, 0x25FE}, {0x2614, 0x2615},
      {0x2648, 0x2653}, {0x267F, 0x267F}, {0x2693, 0x2693}, {0x26A1, 0x26A1},
      {0x26AA, 0x26AB}, {0x26BD, 0x26BE}, {0x26C4, 0x26C5}, {0x26CE, 0x26CE},
      {0x26D4, 0x26D4}, {0x26EA, 0x26EA}, {0x26F2, 0x26F3}, {0x26F5, 0x26F5},
      {0x26FA, 0x26FA}, {0x26FD, 0x26FD}, {0x2705, 0x2705}, {0x270A, 0x270B},
      {0x2728, 0x2728}, {0x274C, 0x274C}, {0x274E, 0x274E}, {0x2753, 0x2755},
      {0x2757, 0x2757}, {0x2795, 0x2797}, {0x27B0, 0x27B0}, {0x27BF, 0x27BF},
      {0x2B1B, 0x2B1C}, {0x2B50, 0x2B50}, {0x2B55, 0x2B55}, {0x2E80, 0x303E},
      {0x3041, 0x33FF}, {0x3400, 0x4DBF}, {0x4E00, 0x9FFF}, {0xA000, 0xA4CF},
      {0xA960, 0xA97F}, {0xAC00, 0xD7A3}, {0xF900, 0xFAFF}, {0xFE10, 0xFE19},
      {0xFE30, 0xFE6F}, {0xFF00, 0xFF60}, {0xFFE0, 0xFFE6}, {0x16FE0, 0x16FE4},
      {0x17000, 0x18CFF}, {0x1B000, 0x1B2FF}, {0x1F004, 0x1F004}, {0x1F0CF, 0x1F0CF},
      {0x1F18E, 0x1F18E}, {0x1F191, 0x1F19A}, {0x1F200, 0x1F202}, {0x1F210, 0x1F23B},
      {0x1F240, 0x1F248}, {0x1F250, 0x1F251}, {0x1F260, 0x1F265}, {0x1F300, 0x1F64F},
      {0x1F680, 0x1F6FF}, {0x1F7E0, 0x1F7EB}, {0x1F7F0, 0x1F7F0}, {0x1F900, 0x1F9FF},
      {0x1FA70, 0x1FAFF}, {0x20000, 0x2FFFD}, {0x30000, 0x3FFFD},
  };
  auto in = [cp](const auto& table) {
    for (const auto& range : table) {
      if (cp < range.first) return false;
      if (cp <= range.last) return true;
    }
    return false;
  };
  if (in(kZeroWidth)) return 0;
  return in(kWide) ? 2 : 1;
}

// Display width of UTF-8 text (see sql_codepoint_display_width). Invalid bytes
// count one column each. An emoji joined by U+200D (ZWJ sequence such as a
// family emoji) renders as one glyph, so joined components add no width; U+FE0F
// requests emoji presentation, which widens a preceding narrow symbol (❤️).
inline size_t sql_display_width(std::string_view s) {
  size_t width = 0;
  size_t previous = 0;
  bool after_zwj = false;
  for (size_t i = 0; i < s.size();) {
    const unsigned char lead = static_cast<unsigned char>(s[i]);
    size_t len = 1;
    char32_t cp = lead;
    if (lead >= 0xF0 && lead <= 0xF4) { len = 4; cp = lead & 0x07; }
    else if (lead >= 0xE0) { len = 3; cp = lead & 0x0F; }
    else if (lead >= 0xC2 && lead < 0xE0) { len = 2; cp = lead & 0x1F; }
    else if (lead >= 0x80) len = 0;
    if (len > 1) {
      if (i + len > s.size()) len = 0;
      for (size_t k = 1; len && k < len; ++k) {
        const unsigned char cont = static_cast<unsigned char>(s[i + k]);
        if ((cont & 0xC0) != 0x80) { len = 0; break; }
        cp = (cp << 6) | (cont & 0x3F);
      }
    }
    if (len == 0) {
      ++width;
      previous = 1;
      after_zwj = false;
      ++i;
      continue;
    }
    i += len;
    if (cp == 0x200D) { after_zwj = true; continue; }
    if (cp == 0xFE0F && previous == 1) { ++width; previous = 2; continue; }
    const size_t w = sql_codepoint_display_width(cp);
    if (after_zwj && w > 0) { after_zwj = false; continue; }
    after_zwj = false;
    width += w;
    if (w > 0) previous = w;
  }
  return width;
}

// ClickHouse heredoc literals: `$$body$$` or `$tag$body$tag$`. formatQuery
// prints them as ordinary quoted strings, and the local post-processor's
// scanners only know quotes, backticks and comments, so a heredoc body with a
// quote, `--`, `/*` or an operator would be misread as SQL there. Heredocs are
// therefore masked before formatting and restored byte-for-byte afterwards.
inline std::vector<std::pair<size_t, size_t>> sql_heredoc_ranges(std::string_view sql) {
  std::vector<std::pair<size_t, size_t>> ranges;
  for (size_t i = 0; i < sql.size();) {
    const char ch = sql[i];
    const char next = (i + 1 < sql.size()) ? sql[i + 1] : '\0';
    if (ch == '-' && next == '-') {
      while (i < sql.size() && sql[i] != '\n') ++i;
      continue;
    }
    if (ch == '#') {
      while (i < sql.size() && sql[i] != '\n') ++i;
      continue;
    }
    if (ch == '/' && next == '*') {
      const size_t end = sql.find("*/", i + 2);
      i = end == std::string_view::npos ? sql.size() : end + 2;
      continue;
    }
    if (ch == '\'' || ch == '"' || ch == '`') {
      ++i;
      while (i < sql.size()) {
        if (sql[i] == '\\' && ch != '`') { i += 2; continue; }
        if (sql[i] == ch && i + 1 < sql.size() && sql[i + 1] == ch) { i += 2; continue; }
        if (sql[i] == ch) { ++i; break; }
        ++i;
      }
      continue;
    }
    if (sql_is_ident_continue(ch) || ch == '$') {
      // `$` inside an identifier (a$b) never opens a heredoc.
      const bool dollar = ch == '$';
      if (!dollar) {
        while (i < sql.size() && (sql_is_ident_continue(sql[i]) || sql[i] == '$')) ++i;
        continue;
      }
      size_t tag_end = i + 1;
      while (tag_end < sql.size() && sql_is_ident_continue(sql[tag_end])) ++tag_end;
      if (tag_end < sql.size() && sql[tag_end] == '$') {
        const std::string_view tag = sql.substr(i, tag_end + 1 - i);
        const size_t close = sql.find(tag, tag_end + 1);
        if (close != std::string_view::npos) {
          ranges.emplace_back(i, close + tag.size());
          i = close + tag.size();
          continue;
        }
      }
      ++i;
      continue;
    }
    ++i;
  }
  return ranges;
}

struct SqlHeredocMask {
  std::string sql;
  // Placeholder literal -> exact heredoc spelling.
  std::vector<std::pair<std::string, std::string>> heredocs;
};

// Replace each heredoc by a single-quoted placeholder literal with the same
// display width, so alignment and wrapping decisions made on the masked text
// stay right once the heredoc is put back. The placeholder body starts with a
// private-use code point (U+E000 + index, one column) that user SQL never
// contains, padded with `_`; heredocs are at least four columns wide (`$$$$`).
inline SqlHeredocMask mask_sql_heredocs(std::string_view sql) {
  SqlHeredocMask mask;
  const auto ranges = sql_heredoc_ranges(sql);
  if (ranges.empty() || sql.find("\xEE") != std::string_view::npos) {
    mask.sql.assign(sql);
    return mask;
  }
  size_t cursor = 0;
  for (const auto& [begin, end] : ranges) {
    const std::string_view spelling = sql.substr(begin, end - begin);
    const size_t index = mask.heredocs.size();
    const size_t width = sql_display_width(spelling);
    // A multiline heredoc keeps its exact bytes too; only the alignment of
    // text after it can be off, as for any multiline literal.
    if (index >= 0x1000 || width < 4) continue;
    const char32_t marker = 0xE000 + static_cast<char32_t>(index);
    std::string placeholder = "'";
    placeholder.push_back(static_cast<char>(0xE0 | (marker >> 12)));
    placeholder.push_back(static_cast<char>(0x80 | ((marker >> 6) & 0x3F)));
    placeholder.push_back(static_cast<char>(0x80 | (marker & 0x3F)));
    placeholder.append(width - 3, '_');
    placeholder.push_back('\'');
    mask.sql.append(sql.substr(cursor, begin - cursor));
    mask.sql += placeholder;
    mask.heredocs.emplace_back(std::move(placeholder), std::string(spelling));
    cursor = end;
  }
  mask.sql.append(sql.substr(cursor));
  return mask;
}

// Multi-line single-quoted literals are masked like heredocs. The line-based
// post-processor re-indents and re-spaces every line it sees, so the body of a
// literal spanning several lines (HTTP headers, HTML, JSON documents...) was
// rewritten as if it were SQL (`Content-Type` -> `Content - Type`, indentation
// injected into the string), changing the value. The placeholder is one line
// as wide as the literal's widest line; the exact bytes are restored at the end.
inline void mask_sql_multiline_literals(SqlHeredocMask& mask) {
  const std::string source = mask.sql;
  if (source.find('\n') == std::string::npos) return;
  const auto ranges = sql_single_quoted_literal_ranges(source);
  std::string out;
  out.reserve(source.size());
  size_t cursor = 0;
  for (const auto& [begin, end] : ranges) {
    const std::string_view spelling = std::string_view(source).substr(begin, end - begin);
    if (spelling.find('\n') == std::string_view::npos) continue;
    const size_t index = mask.heredocs.size();
    if (index >= 0x1000) break;
    size_t width = 4;
    for (size_t line_start = 0; line_start <= spelling.size();) {
      const size_t nl = spelling.find('\n', line_start);
      const size_t line_end = nl == std::string_view::npos ? spelling.size() : nl;
      width = std::max(width, sql_display_width(spelling.substr(line_start, line_end - line_start)));
      if (nl == std::string_view::npos) break;
      line_start = nl + 1;
    }
    const char32_t marker = 0xE000 + static_cast<char32_t>(index);
    std::string placeholder = "'";
    placeholder.push_back(static_cast<char>(0xE0 | (marker >> 12)));
    placeholder.push_back(static_cast<char>(0x80 | ((marker >> 6) & 0x3F)));
    placeholder.push_back(static_cast<char>(0x80 | (marker & 0x3F)));
    placeholder.append(width - 3, '_');
    placeholder.push_back('\'');
    out.append(source, cursor, begin - cursor);
    out += placeholder;
    mask.heredocs.emplace_back(std::move(placeholder), std::string(spelling));
    cursor = end;
  }
  if (cursor == 0 && out.empty()) return;
  out.append(source, cursor, source.size() - cursor);
  mask.sql = std::move(out);
}

inline std::string restore_sql_heredocs(std::string formatted, const SqlHeredocMask& mask) {
  if (mask.heredocs.empty()) return formatted;
  std::string out;
  out.reserve(formatted.size() + 64);
  size_t cursor = 0;
  for (const auto& [begin, end] : sql_single_quoted_literal_ranges(formatted)) {
    const std::string_view literal = std::string_view(formatted).substr(begin, end - begin);
    for (const auto& [placeholder, spelling] : mask.heredocs) {
      if (literal != placeholder) continue;
      out.append(formatted, cursor, begin - cursor);
      out += spelling;
      cursor = end;
      break;
    }
  }
  out.append(formatted, cursor, formatted.size() - cursor);
  return out;
}

struct SqlIdentifierToken {
  size_t begin = 0;
  size_t end = 0;
  std::string decoded;
  bool quoted = false;
};

inline bool sql_identifier_value_equal(std::string_view lhs, std::string_view rhs) {
  if (lhs.size() != rhs.size()) return false;
  for (size_t i = 0; i < lhs.size(); ++i) {
    if (sql_ascii_lower(lhs[i]) != sql_ascii_lower(rhs[i])) return false;
  }
  return true;
}

// Tokenize identifiers while ignoring strings and comments. Quoted identifiers
// are decoded only for alignment; their exact source spelling is kept in the
// original SQL and can later be restored after ClickHouse formatQuery has
// normalized double quotes to backticks.
inline std::vector<SqlIdentifierToken> sql_identifier_tokens(std::string_view sql) {
  std::vector<SqlIdentifierToken> tokens;

  for (size_t i = 0; i < sql.size();) {
    const char ch = sql[i];
    const char next = (i + 1 < sql.size()) ? sql[i + 1] : '\0';

    if (ch == '-' && next == '-') {
      i += 2;
      while (i < sql.size() && sql[i] != '\n' && sql[i] != '\r') ++i;
      continue;
    }
    if (ch == '#') {
      ++i;
      while (i < sql.size() && sql[i] != '\n' && sql[i] != '\r') ++i;
      continue;
    }
    if (ch == '/' && next == '*') {
      i += 2;
      while (i + 1 < sql.size() && !(sql[i] == '*' && sql[i + 1] == '/')) ++i;
      i = std::min(sql.size(), i + 2);
      continue;
    }

    if (ch == '\'') {
      ++i;
      bool escaped = false;
      while (i < sql.size()) {
        const char current = sql[i];
        const char following = (i + 1 < sql.size()) ? sql[i + 1] : '\0';
        if (escaped) {
          escaped = false;
          ++i;
        } else if (current == '\\') {
          escaped = true;
          ++i;
        } else if (current == '\'' && following == '\'') {
          i += 2;
        } else if (current == '\'') {
          ++i;
          break;
        } else {
          ++i;
        }
      }
      continue;
    }

    if (ch == '"' || ch == '`') {
      const char quote = ch;
      const size_t begin = i++;
      std::string decoded;
      bool closed = false;
      while (i < sql.size()) {
        const char current = sql[i];
        const char following = (i + 1 < sql.size()) ? sql[i + 1] : '\0';
        if (current == quote && following == quote) {
          decoded.push_back(quote);
          i += 2;
        } else if (current == '\\' && i + 1 < sql.size()) {
          decoded.push_back(sql[i + 1]);
          i += 2;
        } else if (current == quote) {
          ++i;
          closed = true;
          break;
        } else {
          decoded.push_back(current);
          ++i;
        }
      }
      if (closed) tokens.push_back({begin, i, std::move(decoded), true});
      continue;
    }

    if (sql_is_ident_start(ch)) {
      const size_t begin = i++;
      while (i < sql.size() && sql_is_ident_continue(sql[i])) ++i;
      tokens.push_back({begin, i, std::string(sql.substr(begin, i - begin)), false});
      continue;
    }

    ++i;
  }

  return tokens;
}

// formatQuery back-quotes keyword-named callables (`FROM VALUES(…)` becomes
// FROM `VALUES`(…)). When the user wrote that name unquoted as a call, the
// input already parsed to the same AST, so give the call its original
// spelling back. Only `` `name`( `` call sites are touched; quoted aliases and
// column identifiers keep their quotes.
inline std::string unquote_call_identifiers_written_unquoted(std::string formatted, std::string_view source) {
  if (formatted.find('`') == std::string::npos) return formatted;
  // Unquoted names the user wrote as calls (`name(`), lower-cased.
  std::vector<std::string> unquoted_calls;
  for (const auto& token : sql_identifier_tokens(source)) {
    if (token.quoted) continue;
    size_t after = token.end;
    while (after < source.size() && (source[after] == ' ' || source[after] == '\n' || source[after] == '\t')) ++after;
    if (after >= source.size() || source[after] != '(') continue;
    std::string lower;
    for (const char ch : token.decoded) lower.push_back(sql_ascii_lower(ch));
    unquoted_calls.push_back(std::move(lower));
  }
  if (unquoted_calls.empty()) return formatted;
  std::string out;
  out.reserve(formatted.size());
  size_t cursor = 0;
  for (const auto& token : sql_identifier_tokens(formatted)) {
    if (!token.quoted || token.end >= formatted.size() || formatted[token.end] != '(') continue;
    const std::string& name = token.decoded;
    bool plain = !name.empty() && sql_is_ident_start(name[0]);
    for (const char ch : name) plain = plain && sql_is_ident_continue(ch);
    if (!plain) continue;
    std::string lower;
    for (const char ch : name) lower.push_back(sql_ascii_lower(ch));
    if (std::find(unquoted_calls.begin(), unquoted_calls.end(), lower) == unquoted_calls.end()) continue;
    out.append(formatted, cursor, token.begin - cursor);
    out += name;
    cursor = token.end;
  }
  out.append(formatted, cursor, formatted.size() - cursor);
  return out;
}

inline std::string restore_sql_quoted_identifiers(
    std::string formatted,
    std::string_view original
) {
  const auto source_tokens = sql_identifier_tokens(original);
  if (source_tokens.empty()) return formatted;

  bool has_quoted_source = false;
  for (const auto& token : source_tokens) {
    if (token.quoted) {
      has_quoted_source = true;
      break;
    }
  }
  if (!has_quoted_source) return formatted;

  const auto formatted_tokens = sql_identifier_tokens(formatted);
  if (formatted_tokens.empty()) return formatted;

  struct Replacement {
    size_t begin;
    size_t end;
    std::string text;
  };
  std::vector<Replacement> replacements;

  auto add_replacement = [&](const SqlIdentifierToken& source, const SqlIdentifierToken& target) {
    if (!source.quoted) return;
    const std::string_view wanted = original.substr(source.begin, source.end - source.begin);
    const std::string_view current = std::string_view(formatted).substr(target.begin, target.end - target.begin);
    if (wanted != current) {
      replacements.push_back({target.begin, target.end, std::string(wanted)});
    }
  };

  // The local formatter may change only the outer quote character without
  // rewriting doubled quote escapes inside the identifier. In that case the
  // decoded values differ even though the identifier occupies the same token
  // slot. Prefer positional alignment when the complete token structure is
  // unchanged; all unquoted tokens must still match and quoted source tokens
  // must still be quoted in the formatted output.
  bool structurally_aligned = source_tokens.size() == formatted_tokens.size();
  if (structurally_aligned) {
    for (size_t i = 0; i < source_tokens.size(); ++i) {
      const auto& source = source_tokens[i];
      const auto& target = formatted_tokens[i];
      if ((source.quoted && !target.quoted) ||
          (!source.quoted && !sql_identifier_value_equal(source.decoded, target.decoded))) {
        structurally_aligned = false;
        break;
      }
    }
  }

  if (structurally_aligned) {
    for (size_t i = 0; i < source_tokens.size(); ++i) {
      add_replacement(source_tokens[i], formatted_tokens[i]);
    }
  } else {
    size_t formatted_index = 0;

    // Align the complete identifier stream rather than only quoted tokens. This
    // prevents a quoted alias from being matched to an earlier unquoted alias
    // which formatQuery happened to wrap in backticks.
    for (const auto& source : source_tokens) {
      while (formatted_index < formatted_tokens.size() &&
             !sql_identifier_value_equal(source.decoded, formatted_tokens[formatted_index].decoded)) {
        ++formatted_index;
      }
      if (formatted_index >= formatted_tokens.size()) break;
      add_replacement(source, formatted_tokens[formatted_index++]);
    }
  }

  if (replacements.empty()) return formatted;

  std::string out;
  out.reserve(std::max(formatted.size(), original.size()));
  size_t cursor = 0;
  for (const auto& replacement : replacements) {
    if (replacement.begin < cursor || replacement.end < replacement.begin || replacement.end > formatted.size()) {
      continue;
    }
    out.append(formatted, cursor, replacement.begin - cursor);
    out += replacement.text;
    cursor = replacement.end;
  }
  out.append(formatted, cursor, formatted.size() - cursor);
  return out;
}

inline bool sql_identifier_ends_with(std::string_view ident, std::string_view suffix) {
  return ident.size() >= suffix.size() &&
         ident.substr(ident.size() - suffix.size()) == suffix;
}

// Detect result types which clickhouse-cpp v2.6 cannot reliably decode through
// the native protocol. This is deliberately lexical and conservative: a false
// positive costs one cached DESCRIBE, while a false negative can corrupt a
// streamed result before the driver reports its decode error.
inline bool sql_likely_requires_compat_describe(std::string_view sql) {
  const auto masked = mask_sql_surface(sql);
  const std::string_view code(masked.code_lower);

  for (size_t i = 0; i < code.size();) {
    if (!sql_is_ident_start(code[i])) {
      ++i;
      continue;
    }

    const size_t start = i++;
    while (i < code.size() && sql_is_ident_continue(code[i])) ++i;
    const std::string_view ident = code.substr(start, i - start);

    size_t next = i;
    while (next < code.size() && std::isspace(static_cast<unsigned char>(code[next]))) ++next;
    const bool is_call = next < code.size() && code[next] == '(';

    if (ident == "aggregatefunction" || ident == "json" || ident == "dynamic" ||
        ident == "uint256" || ident == "int256" || ident == "decimal256" ||
        ident == "finalizeaggregation") {
      return true;
    }

    if (ident == "object" && is_call) return true;

    // Aggregate combinators ending in State return AggregateFunction(...), for
    // example argMaxState, uniqState and quantilesMergeState. Merge/finalizer
    // functions can expose the AggregateFunction argument's scalar type (for
    // example sumMerge(AggregateFunction(sum, Int256)) -> Int256), which is not
    // visible lexically in the SELECT itself. Pre-describe those calls too.
    if (is_call && (sql_identifier_ends_with(ident, "state") ||
                    sql_identifier_ends_with(ident, "merge"))) return true;

    // Explicit conversion helpers expose 256-bit values even when their type
    // name does not otherwise occur in the query text.
    if (is_call && (ident == "touint256" || ident == "toint256" || ident == "todecimal256")) {
      return true;
    }
  }

  return false;
}

} // namespace chdash
