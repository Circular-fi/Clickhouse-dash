#include "hcl.hpp"

#include <sstream>

namespace chdash {

namespace {

enum class TokKind {
  Ident,
  String,
  Number,
  LBrace,
  RBrace,
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
      break;
    }
  }

  [[noreturn]] void fail(const std::string& msg) const {
    std::ostringstream oss;
    oss << "HCL parse error: " << msg << " at offset " << i;
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

    // String literal (double quoted)
    if (c == '"') {
      ++i;
      std::string out;
      out.reserve(64);
      while (i < s.size()) {
        char ch = s[i++];
        if (ch == '"') {
          return Tok{TokKind::String, out};
        }
        if (ch == '\\') {
          if (i >= s.size()) fail("unterminated string escape");
          char esc = s[i++];
          switch (esc) {
            case '"': out.push_back('"'); break;
            case '\\': out.push_back('\\'); break;
            case 'n': out.push_back('\n'); break;
            case 'r': out.push_back('\r'); break;
            case 't': out.push_back('\t'); break;
            default:
              // Keep unknown escapes literally.
              out.push_back(esc);
              break;
          }
          continue;
        }
        out.push_back(ch);
      }
      fail("unterminated string");
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

  void parse_stmt_into(HclObject& out) {
    if (cur.kind != TokKind::Ident) {
      lex.fail("expected identifier");
    }
    std::string name = cur.text;
    cur = lex.next();
    if (accept(TokKind::LBrace)) {
      HclObject child;
      while (cur.kind != TokKind::RBrace) {
        if (cur.kind == TokKind::End) lex.fail("unexpected EOF in block");
        parse_stmt_into(child);
      }
      consume(TokKind::RBrace, "'}'");
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

std::optional<std::string> hcl_get_string(const HclObject& o, const std::string& key) {
  auto it = o.attrs.find(key);
  if (it == o.attrs.end()) return std::nullopt;
  if (!it->second.is_string()) return std::nullopt;
  return it->second.as_string();
}

std::optional<int64_t> hcl_get_int(const HclObject& o, const std::string& key) {
  auto it = o.attrs.find(key);
  if (it == o.attrs.end()) return std::nullopt;
  if (!it->second.is_int()) return std::nullopt;
  return it->second.as_int();
}

std::optional<bool> hcl_get_bool(const HclObject& o, const std::string& key) {
  auto it = o.attrs.find(key);
  if (it == o.attrs.end()) return std::nullopt;
  if (!it->second.is_bool()) return std::nullopt;
  return it->second.as_bool();
}

} // namespace chdash
