#pragma once

#include "sql_lexer.hpp"

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chdash {

struct SqlMaskResult {
  // The result has the same byte length as the input.
  // The function replaces the contents of strings, identifiers and comments with spaces. It keeps every newline.
  // It makes the ASCII code outside these regions lower case. Each token scan then gives a fixed result.
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
  for (const sql::Token& token : sql::lex(sql)) {
    if (sql::is_comment(token.kind)) result.has_comments = true;
    const bool opaque = sql::is_comment(token.kind) || token.kind == sql::TokenKind::String ||
                        token.kind == sql::TokenKind::QuotedIdent || token.kind == sql::TokenKind::HereDoc;
    for (size_t i = token.begin; i < token.end; ++i) {
      const char ch = sql[i];
      if (opaque) {
        if (ch == '\n' || ch == '\r') result.code_lower[i] = ch;
      } else {
        result.code_lower[i] = sql_ascii_lower(ch);
      }
    }
  }
  return result;
}

// The function gives the first SQL keyword outside comments and quoted regions.
// The result is in ASCII lower case. It is empty for a buffer that has only comments or only blanks.
// This keeps the statement classification correct for editor queries that begin with comments.
inline std::string sql_first_keyword_lower(std::string_view sql) {
  for (const sql::Token& token : sql::lex(sql)) {
    if (token.kind != sql::TokenKind::Word || !sql_is_ident_start(sql[token.begin])) continue;
    std::string word;
    for (const char ch : token.text(sql)) word.push_back(sql_ascii_lower(ch));
    return word;
  }
  return {};
}

// The [begin, end) of each closed 'literal' of the text.
inline std::vector<std::pair<size_t, size_t>> sql_single_quoted_literal_ranges(
    std::string_view sql
) {
  std::vector<std::pair<size_t, size_t>> ranges;
  for (const sql::Token& token : sql::lex(sql)) {
    if (token.kind == sql::TokenKind::String && token.closed) ranges.emplace_back(token.begin, token.end);
  }
  return ranges;
}

// The function decodes a single-quoted SQL literal, with its quotes, to the value that the ClickHouse parser produces.
// Two spellings are interchangeable only when they decode to the same bytes. For example, 'it''s' and 'it\'s'.
// An unknown escape keeps its backslash. This matches ClickHouse's parseComplexEscapeSequence.
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

// formatQuery re-escapes string literals. Restore the exact spelling that the user wrote.
// Match the literals by their *decoded value*, in order. Never match by position alone.
// formatQuery also adds literals (CAST(x AS T) -> CAST(x, 'T'), x::T) and removes others (INTERVAL '2 hours' -> toIntervalHour(2)).
// A positional swap would change the query semantics without a warning.
// A formatted literal that has no equal-valued source literal ahead of the cursor keeps its formatted spelling.
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

  // The function keeps the places of each value in the source, in order.
  // It finds the next literal of a value after the cursor by a search in its list. It does not walk the rest of the source.
  // A walk would reach the end each time for a literal that formatQuery added, because that literal has no equal.
  std::unordered_map<std::string, std::vector<size_t>> places;
  for (size_t i = 0; i < source_values.size(); ++i) places[source_values[i]].push_back(i);

  std::string out;
  out.reserve(std::max(formatted.size(), original.size()));
  size_t cursor = 0;
  size_t source_cursor = 0;
  for (const auto& [begin, end] : formatted_ranges) {
    out.append(formatted, cursor, begin - cursor);
    const std::string_view current = std::string_view(formatted).substr(begin, end - begin);
    const std::string value = decode_sql_single_quoted_literal(current);
    size_t match = source_values.size();
    if (const auto found = places.find(value); found != places.end()) {
      const auto next = std::lower_bound(found->second.begin(), found->second.end(), source_cursor);
      if (next != found->second.end()) match = *next;
    }
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


// The function gives the monospace display columns of one code point, as editors and terminals render it.
// East Asian Wide/Fullwidth characters and emoji take two columns. Combining marks, zero-width joiners/spaces, variation selectors and emoji skin-tone modifiers take none.
// Alignment that counts bytes or code points moves the AS column when a literal or identifier contains CJK or emoji.
// The tables cover the common blocks. They do not cover all of Unicode's EastAsianWidth.txt. A code point that is not listed counts as one column.
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

// The function gives the display width of UTF-8 text. It uses sql_codepoint_display_width.
// Each invalid byte counts as one column.
// An emoji that is joined by U+200D, such as a family emoji, renders as one glyph. Its joined parts add no width.
// U+FE0F asks for emoji presentation. It widens a preceding narrow symbol (❤️).
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

// ClickHouse heredoc literals have the form `$$body$$` or `$tag$body$tag$`. formatQuery prints them as ordinary quoted strings.
// The local post-processor scanners know only quotes, backticks and comments. A heredoc body with a quote, `--`, `/*` or an operator would be misread as SQL there.
// The code therefore masks the heredocs before formatting. It restores them byte-for-byte afterwards.
inline std::vector<std::pair<size_t, size_t>> sql_heredoc_ranges(std::string_view sql) {
  std::vector<std::pair<size_t, size_t>> ranges;
  for (const sql::Token& token : sql::lex(sql)) {
    if (token.kind == sql::TokenKind::HereDoc && token.closed) ranges.emplace_back(token.begin, token.end);
  }
  return ranges;
}

struct SqlHeredocMask {
  std::string sql;
  // The map gives the exact heredoc spelling for each placeholder literal.
  std::vector<std::pair<std::string, std::string>> heredocs;
};

// The function replaces each heredoc by a single-quoted placeholder literal with the same display width.
// Alignment and wrapping decisions on the masked text stay correct after the heredoc is put back.
// The placeholder body starts with a private-use code point (U+E000 + index, one column) that user SQL never contains. It is padded with `_`.
// A heredoc is at least four columns wide (`$$$$`).
inline SqlHeredocMask mask_sql_heredocs(std::string_view sql) {
  SqlHeredocMask mask;
  const auto ranges = sql_heredoc_ranges(sql);
  if (ranges.empty() || sql.find('\xEE') != std::string_view::npos) {
    mask.sql.assign(sql);
    return mask;
  }
  size_t cursor = 0;
  for (const auto& [begin, end] : ranges) {
    const std::string_view spelling = sql.substr(begin, end - begin);
    const size_t index = mask.heredocs.size();
    const size_t width = sql_display_width(spelling);
    // A multiline heredoc also keeps its exact bytes. Only the alignment of the text after it can be off, as for any multiline literal.
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

// The code masks multi-line single-quoted literals in the same way as heredocs.
// The line-based post-processor re-indents and re-spaces every line that it reads. It rewrote the body of a literal that spans several lines (HTTP headers, HTML, JSON documents...) as if it were SQL.
// For example, `Content-Type` -> `Content - Type` changed the value, and the indentation was injected into the string.
// The placeholder is one line, as wide as the widest line of the literal. The function restores the exact bytes at the end.
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

// The function tokenizes identifiers. It ignores strings and comments.
// It decodes a quoted identifier only for alignment. The exact source spelling stays in the original SQL.
// The function can restore that spelling later. This is needed after ClickHouse formatQuery changes double quotes to backticks.
inline std::vector<SqlIdentifierToken> sql_identifier_tokens(std::string_view sql) {
  std::vector<SqlIdentifierToken> tokens;
  for (const sql::Token& token : sql::lex(sql)) {
    if (token.kind == sql::TokenKind::QuotedIdent && token.closed) {
      // Read the name between the quote marks. A doubled quote mark and an escaped byte are one byte.
      const char quote = sql[token.begin];
      std::string decoded;
      for (size_t i = token.begin + 1; i + 1 < token.end;) {
        if (sql[i] == quote && sql[i + 1] == quote) {
          decoded.push_back(quote);
          i += 2;
        } else if (sql[i] == '\\' && i + 2 < token.end) {
          decoded.push_back(sql[i + 1]);
          i += 2;
        } else {
          decoded.push_back(sql[i++]);
        }
      }
      tokens.push_back({token.begin, token.end, std::move(decoded), true});
    } else if (token.kind == sql::TokenKind::Word && sql_is_ident_start(sql[token.begin])) {
      tokens.push_back({token.begin, token.end, std::string(token.text(sql)), false});
    }
  }
  return tokens;
}

// formatQuery adds backquotes to the callables whose names are keywords. For example, `FROM VALUES(…)` becomes FROM `VALUES`(…).
// When the user wrote that name unquoted as a call, the input already parsed to the same AST. Give the call its original spelling back.
// Only the call sites of the form `` `name`( `` are changed. Quoted aliases and column identifiers keep their quotes.
inline std::string unquote_call_identifiers_written_unquoted(std::string formatted, std::string_view source) {
  if (formatted.find('`') == std::string::npos) return formatted;
  // The map holds the unquoted names that the user wrote as calls (`name(`), in lower case.
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

  // The local formatter can change only the outer quote character. It does not rewrite the doubled quote escapes inside the identifier.
  // In that case the decoded values differ, although the identifier has the same token slot.
  // Prefer positional alignment when the complete token structure is unchanged.
  // All unquoted tokens must still match. Quoted source tokens must still be quoted in the formatted output.
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
    // Align the complete identifier stream, not only the quoted tokens.
    // This stops a quoted alias from matching an earlier unquoted alias. formatQuery had wrapped that unquoted alias in backticks.
    // The function searches the places of each name (in lower case) in the formatted text. It does not walk them.
    // A name that is not there is skipped. The names after it are still restored.
    // formatQuery drops some names: `x::T` has one name less than `CAST(x, 'T')`.
    std::unordered_map<std::string, std::vector<size_t>> places;
    for (size_t i = 0; i < formatted_tokens.size(); ++i) {
      std::string lower;
      for (const char ch : formatted_tokens[i].decoded) lower.push_back(sql_ascii_lower(ch));
      places[lower].push_back(i);
    }
    size_t formatted_index = 0;
    for (const auto& source : source_tokens) {
      std::string lower;
      for (const char ch : source.decoded) lower.push_back(sql_ascii_lower(ch));
      const auto found = places.find(lower);
      if (found == places.end()) continue;
      const auto next = std::lower_bound(found->second.begin(), found->second.end(), formatted_index);
      if (next == found->second.end()) continue;
      add_replacement(source, formatted_tokens[*next]);
      formatted_index = *next + 1;
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

// The function detects result types that clickhouse-cpp v2.6 cannot decode reliably through the native protocol.
// The detection is lexical and conservative by design. A false positive costs one cached DESCRIBE.
// A false negative can corrupt a streamed result before the driver reports its decode error.
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

    // Aggregate combinators whose names end in State return AggregateFunction(...). Examples are argMaxState, uniqState and quantilesMergeState.
    // Merge and finalizer functions can expose the scalar type of the AggregateFunction argument. For example, sumMerge(AggregateFunction(sum, Int256)) -> Int256.
    // The SELECT text does not show this type lexically. Describe those calls in advance too.
    if (is_call && (sql_identifier_ends_with(ident, "state") ||
                    sql_identifier_ends_with(ident, "merge"))) return true;

    // Explicit conversion helpers expose 256-bit values. The type name can be absent from the query text.
    if (is_call && (ident == "touint256" || ident == "toint256" || ident == "todecimal256")) {
      return true;
    }
  }

  return false;
}

} // namespace chdash
