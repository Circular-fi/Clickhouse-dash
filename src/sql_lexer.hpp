#pragma once

// This is the one SQL lexer of the backend.
// Every file that must tell the code of a statement from its comments, its strings and its names reads the statement through this file.
// Examples are the KILL QUERY policy, the position of an error, the check of the MCP SQL, the lineage of a view and the SQL formatter.
// The rules are the rules of the lexer of ClickHouse (checked on 26.7):
//
//  - A blank is a space, a tab, a newline, a form feed or a vertical tab.
//    A blank also includes one of the Unicode spaces below.
//    For example, a statement with U+00A0 between KILL and QUERY is a KILL QUERY for the server.
//  - A line comment starts with "--". It also starts with "#" followed by a blank or "!".
//    It ends before the line break.
//    A "#" followed by anything else is not a token of the language. The server refuses the statement.
//  - A block comment starts with "/*" and ends with "*/".
//    It nests: "/* a /* b */ c */" is one comment.
//  - 'text', "name" and `name` end at the same quote mark.
//    A backslash escapes the next byte. A doubled quote mark is one quote mark of the text.
//  - $tag$ ... $tag$ is a text without escapes. $$ ... $$ is a text without escapes with an empty tag.
//    The tag is made of letters, digits and underscores. It does not start with a digit.
//  - A word is made of letters, digits, "_" and "$".
//    A word can start with "$" when no heredoc starts there.
//    The server refuses a non-ASCII letter in a bare name.
//    The lexer keeps such bytes in the word. So a position stays where the user wrote it.
//
// Positions are byte offsets in the text.
// utf16_offset() converts one to a UTF-16 unit, which is what the editor of the page counts.
//
// The same rules are in src/wasm/highlight.c and src/wasm/sqlscan.c.
// These files read UTF-16 and follow the JavaScript of the page.
// tests/native/sql_test.cpp runs the highlighter kernel and this lexer on one corpus.
// The test compares what they call a string, a comment and a number.

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace sql {

enum class TokenKind : uint8_t {
  Blank,         // a run of blanks
  LineComment,   // up to the line break (not included)
  BlockComment,  // /* ... */, nested; `closed` is false when the text ends first
  Word,          // a keyword, a function, a bare name
  QuotedIdent,   // `name` or "name"
  String,        // 'text'
  HereDoc,       // $tag$text$tag$
  Number,
  Punct,         // one other byte: ( ) [ ] { } , ; . : + - * / % = < > ! ? | & ^ ~ @ and the rest
  Unknown,       // a "#" that starts no comment
};

struct Token {
  TokenKind kind = TokenKind::Unknown;
  size_t begin = 0;
  size_t end = 0;
  // This value is false when the text ends before a comment, a quoted name, a string or a heredoc closes.
  bool closed = true;
  std::string_view text(std::string_view source) const { return source.substr(begin, end - begin); }
};

// ---- The pieces. Each piece takes the position of its first byte and returns the position after it. ----

// Return the length in bytes of the Unicode space at `pos`, or 0.
// The Unicode spaces are U+0085, U+00A0, U+180E, U+2000..U+200D, U+2028, U+2029, U+202F, U+205F, U+2060, U+3000 and U+FEFF.
inline size_t unicode_space_length(std::string_view s, size_t pos) {
  const auto at = [&](size_t i) { return pos + i < s.size() ? static_cast<unsigned char>(s[pos + i]) : 0u; };
  const unsigned c0 = at(0), c1 = at(1), c2 = at(2);
  if (c0 == 0xC2 && (c1 == 0x85 || c1 == 0xA0)) return 2;
  if (c0 == 0xE1 && c1 == 0xA0 && c2 == 0x8E) return 3;
  if (c0 == 0xE2 && c1 == 0x80 && ((c2 >= 0x80 && c2 <= 0x8D) || c2 == 0xA8 || c2 == 0xA9 || c2 == 0xAF)) return 3;
  if (c0 == 0xE2 && c1 == 0x81 && (c2 == 0x9F || c2 == 0xA0)) return 3;
  if (c0 == 0xE3 && c1 == 0x80 && c2 == 0x80) return 3;
  if (c0 == 0xEF && c1 == 0xBB && c2 == 0xBF) return 3;
  return 0;
}

// Return 1 for an ASCII blank at `pos`, or the length of a Unicode space there.
// Otherwise return 0.
inline size_t blank_length(std::string_view s, size_t pos) {
  const char c = s[pos];
  if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') return 1;
  return static_cast<unsigned char>(c) >= 0x80 ? unicode_space_length(s, pos) : 0;
}

// Return true when a line comment starts at `pos`.
inline bool starts_line_comment(std::string_view s, size_t pos) {
  if (pos >= s.size()) return false;
  if (s[pos] == '-') return pos + 1 < s.size() && s[pos + 1] == '-';
  if (s[pos] != '#') return false;
  return pos + 1 < s.size() && (s[pos + 1] == ' ' || s[pos + 1] == '!');
}

inline bool starts_block_comment(std::string_view s, size_t pos) {
  return pos + 1 < s.size() && s[pos] == '/' && s[pos + 1] == '*';
}

// Return the end of the line comment at `pos`.
// This is the position of the line break, or the end of the text.
inline size_t line_comment_end(std::string_view s, size_t pos) {
  while (pos < s.size() && s[pos] != '\n' && s[pos] != '\r') ++pos;
  return pos;
}

// Return the end of the block comment at `pos`. The comment can nest.
// Set `*closed` to tell whether the last "*/" was found.
inline size_t block_comment_end(std::string_view s, size_t pos, bool* closed = nullptr) {
  size_t depth = 0;
  while (pos < s.size()) {
    if (starts_block_comment(s, pos)) {
      ++depth;
      pos += 2;
    } else if (s[pos] == '*' && pos + 1 < s.size() && s[pos + 1] == '/') {
      pos += 2;
      if (--depth == 0) {
        if (closed) *closed = true;
        return pos;
      }
    } else {
      ++pos;
    }
  }
  if (closed) *closed = false;
  return s.size();
}

// Return the end of the quoted text at `pos`.
// The text at `pos` starts with the opening quote mark: ', " or `.
inline size_t quoted_end(std::string_view s, size_t pos, bool* closed = nullptr) {
  const char quote = s[pos++];
  while (pos < s.size()) {
    if (s[pos] == '\\') {
      pos += 2;
    } else if (s[pos] == quote) {
      if (pos + 1 < s.size() && s[pos + 1] == quote) {
        pos += 2;
      } else {
        if (closed) *closed = true;
        return pos + 1;
      }
    } else {
      ++pos;
    }
  }
  if (closed) *closed = false;
  return s.size();
}

inline bool is_word_start(char c) {
  const auto u = static_cast<unsigned char>(c);
  return (u >= 'a' && u <= 'z') || (u >= 'A' && u <= 'Z') || u == '_' || u >= 0x80;
}

inline bool is_word_char(char c) { return is_word_start(c) || (c >= '0' && c <= '9') || c == '$'; }

inline bool is_digit(char c) { return c >= '0' && c <= '9'; }

// Return the length of the heredoc tag ($$ or $tag$) that starts at `pos`, or 0.
inline size_t heredoc_tag_length(std::string_view s, size_t pos) {
  if (pos >= s.size() || s[pos] != '$') return 0;
  size_t i = pos + 1;
  if (i < s.size() && is_digit(s[i])) return 0;
  while (i < s.size() && (is_word_char(s[i]) && s[i] != '$') && static_cast<unsigned char>(s[i]) < 0x80) ++i;
  return i < s.size() && s[i] == '$' ? i - pos + 1 : 0;
}

// Return the end of the heredoc at `pos`. Return 0 when no heredoc starts there.
// Otherwise return the position after the closing tag.
// When the closing tag is missing, return the end of the text.
// Set `*closed` to tell which case applies.
inline size_t heredoc_end(std::string_view s, size_t pos, bool* closed = nullptr) {
  const size_t tag = heredoc_tag_length(s, pos);
  if (tag == 0) return 0;
  const size_t found = s.find(s.substr(pos, tag), pos + tag);
  if (found == std::string_view::npos) {
    if (closed) *closed = false;
    return s.size();
  }
  if (closed) *closed = true;
  return found + tag;
}

// Return the end of the number at `pos`.
// A number is a run of letters, digits, "_" and ".".
// A sign belongs to the number after an exponent mark (1e-5).
// A hexadecimal number does not have this exponent mark.
inline size_t number_end(std::string_view s, size_t pos) {
  const bool hex = pos + 1 < s.size() && s[pos] == '0' && (s[pos + 1] == 'x' || s[pos + 1] == 'X');
  while (pos < s.size()) {
    const char c = s[pos];
    if (is_digit(c) || c == '_' || c == '.' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      const bool exponent = hex ? (c == 'p' || c == 'P') : (c == 'e' || c == 'E');
      ++pos;
      if (exponent && pos < s.size() && (s[pos] == '+' || s[pos] == '-')) ++pos;
    } else {
      break;
    }
  }
  return pos;
}

// Return the end of the word at `pos`.
// A Unicode space ends the word. ClickHouse uses it to separate tokens.
inline size_t word_end(std::string_view s, size_t pos) {
  while (pos < s.size() && is_word_char(s[pos])) {
    if (static_cast<unsigned char>(s[pos]) >= 0x80 && unicode_space_length(s, pos)) break;
    ++pos;
  }
  return pos;
}

// ---- The tokens ----

// Return the token that starts at `pos`. The position `pos` must be less than s.size().
inline Token next_token(std::string_view s, size_t pos) {
  Token t;
  t.begin = pos;
  const char c = s[pos];
  if (const size_t blank = blank_length(s, pos)) {
    size_t i = pos + blank;
    while (i < s.size()) {
      const size_t more = blank_length(s, i);
      if (!more) break;
      i += more;
    }
    t.kind = TokenKind::Blank;
    t.end = i;
  } else if (starts_line_comment(s, pos)) {
    t.kind = TokenKind::LineComment;
    t.end = line_comment_end(s, pos);
  } else if (starts_block_comment(s, pos)) {
    t.kind = TokenKind::BlockComment;
    t.end = block_comment_end(s, pos, &t.closed);
  } else if (c == '\'') {
    t.kind = TokenKind::String;
    t.end = quoted_end(s, pos, &t.closed);
  } else if (c == '"' || c == '`') {
    t.kind = TokenKind::QuotedIdent;
    t.end = quoted_end(s, pos, &t.closed);
  } else if (c == '$' && heredoc_tag_length(s, pos)) {
    t.kind = TokenKind::HereDoc;
    t.end = heredoc_end(s, pos, &t.closed);
  } else if (is_digit(c) || (c == '.' && pos + 1 < s.size() && is_digit(s[pos + 1]))) {
    t.kind = TokenKind::Number;
    t.end = number_end(s, pos);
  } else if (is_word_start(c)) {
    t.kind = TokenKind::Word;
    t.end = word_end(s, pos);
  } else if (c == '$') {
    t.kind = TokenKind::Word;  // $1, $name: a word that starts with a dollar sign
    t.end = word_end(s, pos);
  } else if (c == '#') {
    t.kind = TokenKind::Unknown;
    t.end = pos + 1;
  } else {
    t.kind = TokenKind::Punct;
    t.end = pos + 1;
  }
  if (t.end <= pos) t.end = pos + 1;
  return t;
}

// Return every token of `s`, in order and without a gap.
// Put the tokens back to back to get the text.
inline std::vector<Token> lex(std::string_view s) {
  std::vector<Token> out;
  for (size_t pos = 0; pos < s.size();) {
    out.push_back(next_token(s, pos));
    pos = out.back().end;
  }
  return out;
}

inline bool is_comment(TokenKind kind) { return kind == TokenKind::LineComment || kind == TokenKind::BlockComment; }

// Return true for a token with no meaning of its own: a blank or a comment.
inline bool is_trivia(TokenKind kind) { return kind == TokenKind::Blank || is_comment(kind); }

// Return the UTF-16 unit of the byte offset `byte` in the UTF-8 text `s`.
// A UTF-16 unit is a JavaScript string index.
inline size_t utf16_offset(std::string_view s, size_t byte) {
  size_t units = 0;
  for (size_t i = 0; i < byte && i < s.size(); ++i) {
    const auto c = static_cast<unsigned char>(s[i]);
    if ((c & 0xC0) == 0x80) continue;  // a continuation byte
    units += c >= 0xF0 ? 2 : 1;        // a character above U+FFFF is a surrogate pair
  }
  return units;
}

// ---- The same rules, one byte at a time ----
//
// Use this scan in a pass that walks the text byte by byte. The SQL formatter is one such pass.
// The pass needs to know whether it is in code, and how deep it is in brackets.
// The method step() reads s[i]. It moves `i` to the last byte of what it read, so the loop's ++i goes on.
// The state holds what a token carries across bytes: the open quote, the depth of a comment and the tag of a heredoc.
struct Scan {
  enum class Region : uint8_t { Code, String, DoubleQuoted, Backtick, LineComment, BlockComment, HereDoc };
  Region region = Region::Code;
  bool escaped = false;
  int comment_depth = 0;
  std::string heredoc_tag;
  int par = 0;   // ( )
  int br = 0;    // [ ]
  int brc = 0;   // { }
  // The end of the word or the number that the scan is in.
  // The bytes before this end start nothing. For example, a "$" inside a word opens no heredoc.
  size_t token_end = 0;

  bool in_code() const { return region == Region::Code; }
  // Return true inside a 'text', a "name", a `name` or a heredoc.
  bool in_quoted() const {
    return region == Region::String || region == Region::DoubleQuoted || region == Region::Backtick || region == Region::HereDoc;
  }
  bool in_comment() const { return region == Region::LineComment || region == Region::BlockComment; }
  bool top_level() const { return in_code() && par == 0 && br == 0 && brc == 0; }

  void step(std::string_view s, size_t& i) {
    const char c = s[i];
    const char n = i + 1 < s.size() ? s[i + 1] : '\0';
    switch (region) {
      case Region::String:
      case Region::DoubleQuoted:
      case Region::Backtick: {
        const char quote = region == Region::String ? '\'' : region == Region::DoubleQuoted ? '"' : '`';
        if (escaped) escaped = false;
        else if (c == '\\') escaped = true;
        else if (c == quote && n == quote) ++i;
        else if (c == quote) region = Region::Code;
        return;
      }
      case Region::LineComment:
        if (c == '\n' || c == '\r') region = Region::Code;
        return;
      case Region::BlockComment:
        if (c == '/' && n == '*') {
          ++comment_depth;
          ++i;
        } else if (c == '*' && n == '/') {
          ++i;
          if (--comment_depth == 0) region = Region::Code;
        }
        return;
      case Region::HereDoc:
        if (c == '$' && s.compare(i, heredoc_tag.size(), heredoc_tag) == 0) {
          i += heredoc_tag.size() - 1;
          region = Region::Code;
        }
        return;
      case Region::Code:
        break;
    }
    if (i < token_end) return;
    if (const size_t blank = blank_length(s, i)) {
      i += blank - 1;  // a Unicode space is more than one byte
      return;
    }
    if (c == '\'') {
      region = Region::String;
      escaped = false;
    } else if (c == '"') {
      region = Region::DoubleQuoted;
      escaped = false;
    } else if (c == '`') {
      region = Region::Backtick;
      escaped = false;
    } else if (starts_line_comment(s, i)) {
      region = Region::LineComment;
      if (c == '-') ++i;
    } else if (starts_block_comment(s, i)) {
      region = Region::BlockComment;
      comment_depth = 1;
      ++i;
    } else if (c == '$' && heredoc_tag_length(s, i)) {
      const size_t tag = heredoc_tag_length(s, i);
      heredoc_tag.assign(s.substr(i, tag));
      region = Region::HereDoc;
      i += tag - 1;
    } else if (is_digit(c) || (c == '.' && i + 1 < s.size() && is_digit(s[i + 1]))) {
      token_end = number_end(s, i);
    } else if (is_word_start(c) || c == '$') {
      token_end = word_end(s, i);
    } else if (c == '(') {
      ++par;
    } else if (c == ')') {
      if (par > 0) --par;
    } else if (c == '[') {
      ++br;
    } else if (c == ']') {
      if (br > 0) --br;
    } else if (c == '{') {
      ++brc;
    } else if (c == '}') {
      if (brc > 0) --brc;
    }
  }
};

} // namespace sql
} // namespace chdash
