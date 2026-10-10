#include "hcl.hpp"

#include <cstdint>
#include <sstream>
#include <utility>

namespace chdash {

namespace {

enum class TokKind {
  Ident,
  String,
  Number,
  LBrace,
  RBrace,
  LBracket,
  RBracket,
  Comma,
  Equal,
  End,
};

struct Tok {
  TokKind kind{TokKind::End};
  std::string text;
  int64_t number{0};
};

struct Lexer {
  std::string_view s;
  size_t i{0};

  explicit Lexer(std::string_view sv) : s(sv) {}

  static void append_utf8(std::string& out, uint32_t code) {
    if (code < 0x80) {
      out.push_back(static_cast<char>(code));
    } else if (code < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (code >> 6)));
      out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else if (code < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (code >> 12)));
      out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (code >> 18)));
      out.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
  }

  static bool is_ident_start(char c) {
    return (c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
  }
  static bool is_ident(char c) {
    return is_ident_start(c) || (c >= '0' && c <= '9') || c == '-';
  }

  void skip_ws_and_comments() {
    while (i < s.size()) {
      char c = s[i];
      // whitespace
      if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
        ++i;
        continue;
      }
      // # comment
      if (c == '#') {
        while (i < s.size() && s[i] != '\n') ++i;
        continue;
      }
      // // comment
      if (c == '/' && i + 1 < s.size() && s[i + 1] == '/') {
        i += 2;
        while (i < s.size() && s[i] != '\n') ++i;
        continue;
      }
      // /* comment */
      if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
        const size_t begin = i;
        const size_t close = s.find("*/", i + 2);
        if (close == std::string_view::npos) fail_at("unterminated /* comment", begin);
        i = close + 2;
        continue;
      }
      break;
    }
  }

  // The line and the column (1-based, in bytes) of the byte `at`.
  std::pair<size_t, size_t> line_column(size_t at) const {
    size_t line = 1;
    size_t column = 1;
    for (size_t k = 0; k < at && k < s.size(); ++k) {
      if (s[k] == '\n') {
        ++line;
        column = 1;
      } else {
        ++column;
      }
    }
    return {line, column};
  }

  [[noreturn]] void fail(const std::string& msg) const { fail_at(msg, i); }

  [[noreturn]] void fail_at(const std::string& msg, size_t at) const {
    const auto [line, column] = line_column(at);
    std::ostringstream oss;
    oss << "HCL parse error: " << msg << " at line " << line << ", column " << column;
    throw HclParseError(oss.str());
  }

  Tok next() {
    skip_ws_and_comments();
    if (i >= s.size()) return Tok{TokKind::End, ""};
    char c = s[i];
    if (c == '{') {
      ++i;
      return Tok{TokKind::LBrace, "{"};
    }
    if (c == '}') {
      ++i;
      return Tok{TokKind::RBrace, "}"};
    }
    if (c == '=') {
      ++i;
      return Tok{TokKind::Equal, "="};
    }
    if (c == '[') {
      ++i;
      return Tok{TokKind::LBracket, "["};
    }
    if (c == ']') {
      ++i;
      return Tok{TokKind::RBracket, "]"};
    }
    if (c == ',') {
      ++i;
      return Tok{TokKind::Comma, ","};
    }

    // String literal (double quoted)
    if (c == '"') {
      const size_t begin = i;
      ++i;
      std::string out;
      out.reserve(64);
      while (i < s.size()) {
        char ch = s[i++];
        if (ch == '"') {
          return Tok{TokKind::String, out};
        }
        if (ch == '\n') fail_at("a string cannot hold a line break (write \\n)", begin);
        if (ch == '\\') {
          if (i >= s.size()) fail("unterminated string escape");
          const size_t escape_at = i - 1;
          char esc = s[i++];
          switch (esc) {
            case '"': out.push_back('"'); break;
            case '\\': out.push_back('\\'); break;
            case 'n': out.push_back('\n'); break;
            case 'r': out.push_back('\r'); break;
            case 't': out.push_back('\t'); break;
            case 'u':
            case 'U': {
              // \uXXXX and \UXXXXXXXX: a code point, written as UTF-8.
              const size_t digits = esc == 'u' ? 4 : 8;
              if (i + digits > s.size()) fail_at("a unicode escape needs " + std::to_string(digits) + " hexadecimal digits", escape_at);
              uint32_t code = 0;
              for (size_t k = 0; k < digits; ++k) {
                const char h = s[i + k];
                const int digit = h >= '0' && h <= '9' ? h - '0' : h >= 'a' && h <= 'f' ? h - 'a' + 10 : h >= 'A' && h <= 'F' ? h - 'A' + 10 : -1;
                if (digit < 0) fail_at("a unicode escape needs " + std::to_string(digits) + " hexadecimal digits", escape_at);
                code = code * 16 + static_cast<uint32_t>(digit);
              }
              i += digits;
              if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) fail_at("a unicode escape names no character", escape_at);
              append_utf8(out, code);
              break;
            }
            default:
              fail_at(std::string("unknown escape \\") + esc + " (use \\\", \\\\, \\n, \\r, \\t, \\uXXXX or \\UXXXXXXXX)", escape_at);
          }
          continue;
        }
        out.push_back(ch);
      }
      fail_at("unterminated string", begin);
    }

    // Number (int64)
    if ((c >= '0' && c <= '9') || c == '-') {
      size_t start = i;
      if (c == '-') ++i;
      bool any = false;
      while (i < s.size() && (s[i] >= '0' && s[i] <= '9')) {
        any = true;
        ++i;
      }
      if (!any) fail("invalid number");
      if (i < s.size() && (s[i] == '.' || s[i] == '_' || s[i] == 'e' || s[i] == 'E' || std::isalpha(static_cast<unsigned char>(s[i])))) {
        fail("only whole decimal numbers are supported (no fraction, exponent, digit separator or suffix)");
      }
      std::string_view num = s.substr(start, i - start);
      try {
        int64_t v = std::stoll(std::string(num));
        Tok t;
        t.kind = TokKind::Number;
        t.text = std::string(num);
        t.number = v;
        return t;
      } catch (...) {
        fail("invalid int64");
      }
    }

    // Identifier or boolean
    if (is_ident_start(c)) {
      size_t start = i;
      ++i;
      while (i < s.size() && is_ident(s[i])) ++i;
      std::string ident(s.substr(start, i - start));
      return Tok{TokKind::Ident, ident};
    }

    if (c == '<' && i + 1 < s.size() && s[i + 1] == '<') fail("heredoc strings are not supported: write the text in a quoted string");
    fail(std::string("unexpected char '") + c + "'");
  }
};

struct Parser {
  Lexer lex;
  Tok cur;

  explicit Parser(std::string_view sv) : lex(sv) { cur = lex.next(); }

  void consume(TokKind k, const char* what) {
    if (cur.kind != k) {
      std::ostringstream oss;
      oss << "expected " << what;
      lex.fail(oss.str());
    }
    cur = lex.next();
  }

  bool accept(TokKind k) {
    if (cur.kind == k) {
      cur = lex.next();
      return true;
    }
    return false;
  }

  HclValue parse_value() {
    if (accept(TokKind::LBracket)) {
      std::vector<std::string> values;
      if (!accept(TokKind::RBracket)) {
        while (true) {
          if (cur.kind != TokKind::String) lex.fail("string lists may contain only quoted strings");
          values.push_back(cur.text);
          cur = lex.next();
          if (accept(TokKind::RBracket)) break;
          consume(TokKind::Comma, "',' or ']'");
          if (accept(TokKind::RBracket)) break;
        }
      }
      HclValue v{std::move(values)};
      return v;
    }
    if (cur.kind == TokKind::String) {
      HclValue v{cur.text};
      cur = lex.next();
      return v;
    }
    if (cur.kind == TokKind::Number) {
      HclValue v{cur.number};
      cur = lex.next();
      return v;
    }
    if (cur.kind == TokKind::Ident) {
      // bools
      std::string id = cur.text;
      for (auto& c : id) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      if (id == "true" || id == "false") {
        HclValue v{(id == "true")};
        cur = lex.next();
        return v;
      }
    }
    lex.fail("expected value");
  }

  // Blocks inside blocks: the file of the application nests 4 levels at most (observability, traces, features).
  static constexpr int kMaxDepth = 16;
  int depth = 0;

  void parse_stmt_into(HclObject& out) {
    if (cur.kind != TokKind::Ident) {
      lex.fail("expected identifier");
    }
    std::string name = cur.text;
    cur = lex.next();
    if (cur.kind == TokKind::String) {
      lex.fail("block labels are not supported: " + name + " \"" + cur.text + "\" { ... }; put the name in an attribute (name = \"" + cur.text + "\")");
    }
    if (accept(TokKind::LBrace)) {
      if (++depth > kMaxDepth) lex.fail("blocks are nested more than " + std::to_string(kMaxDepth) + " levels deep");
      HclObject child;
      while (cur.kind != TokKind::RBrace) {
        if (cur.kind == TokKind::End) lex.fail("unexpected EOF in block");
        parse_stmt_into(child);
      }
      consume(TokKind::RBrace, "'}'");
      --depth;
      out.blocks[name].push_back(std::move(child));
      return;
    }
    consume(TokKind::Equal, "'='");
    HclValue v = parse_value();
    if (!out.attrs.emplace(name, std::move(v)).second) {
      lex.fail("duplicate attribute '" + name + "'");
    }
  }

  HclObject parse_root() {
    HclObject root;
    while (cur.kind != TokKind::End) {
      parse_stmt_into(root);
    }
    return root;
  }
};

} // namespace

HclObject parse_hcl(std::string_view src) {
  Parser p(src);
  return p.parse_root();
}

} // namespace chdash
