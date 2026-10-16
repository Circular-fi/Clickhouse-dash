// Arithmetic of the formatter. It handles the redundant parentheses that formatQuery writes, and the chain of operators of an expression.
// The declarations that the units share are in format_internal.hpp.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

namespace {
struct ArithToken {
  ArithTokenKind kind;
  size_t begin;
  size_t end;
};
}  // namespace

namespace {
vector<ArithToken> lex_arith_tokens(string_view s) {
  vector<ArithToken> tokens;
  size_t i = 0;
  auto push = [&](ArithTokenKind kind, size_t begin, size_t end) { tokens.push_back({kind, begin, end}); };
  while (i < s.size()) {
    const char c = s[i];
    const char n = i + 1 < s.size() ? s[i + 1] : '\0';
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { ++i; continue; }
    const size_t b = i;
    if ((c == '-' && n == '-') || c == '#') {
      while (i < s.size() && s[i] != '\n') ++i;
      push(ArithTokenKind::Comment, b, i);
      continue;
    }
    if (c == '/' && n == '*') {
      const size_t e = s.find("*/", i + 2);
      i = e == string_view::npos ? s.size() : e + 2;
      push(ArithTokenKind::Comment, b, i);
      continue;
    }
    if (c == '\'' || c == '"' || c == '`') {
      ++i;
      while (i < s.size()) {
        if (c != '`' && s[i] == '\\') { i += 2; continue; }
        if (s[i] == c) {
          if (i + 1 < s.size() && s[i + 1] == c) { i += 2; continue; }
          ++i;
          break;
        }
        ++i;
      }
      push(ArithTokenKind::Literal, b, std::min(i, s.size()));
      continue;
    }
    if (std::isdigit(static_cast<unsigned char>(c))) {
      const bool hex = c == '0' && (n == 'x' || n == 'X');
      while (i < s.size() && (is_ident_char(s[i]) || s[i] == '.')) {
        const char d = s[i++];
        // Exponent sign: `1e-5` is a single literal token.
        if (!hex && (d == 'e' || d == 'E') && i + 1 < s.size() && (s[i] == '-' || s[i] == '+') &&
            std::isdigit(static_cast<unsigned char>(s[i + 1]))) ++i;
      }
      push(ArithTokenKind::Number, b, i);
      continue;
    }
    if (is_ident_char(c)) {
      while (i < s.size() && is_ident_char(s[i])) ++i;
      push(ArithTokenKind::Word, b, i);
      continue;
    }
    if (c == '(' || c == '[' || c == '{') { push(ArithTokenKind::Open, b, ++i); continue; }
    if (c == ')' || c == ']' || c == '}') { push(ArithTokenKind::Close, b, ++i); continue; }
    if (c == ',') { push(ArithTokenKind::Comma, b, ++i); continue; }
    static const char* const two_char_ops[] = {"->", "::", "||", "<=", ">=", "!=", "<>", "=="};
    bool matched = false;
    for (const char* op : two_char_ops) {
      if (c == op[0] && n == op[1]) {
        i += 2;
        push(ArithTokenKind::Op, b, i);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (string_view("+-*/%=<>?:.!").find(c) != string_view::npos) { push(ArithTokenKind::Op, b, ++i); continue; }
    push(ArithTokenKind::Other, b, ++i);
  }
  return tokens;
}
}  // namespace

namespace {
constexpr int kArithBoundary = -1;  // clause keyword, separator or bracket
constexpr int kArithCompare = 9;
}  // namespace

namespace {
constexpr int kArithAdditive = 11;
}  // namespace

namespace {
constexpr int kArithUnary = 13;
}  // namespace

namespace {
constexpr int kArithUnknown = -100;
}  // namespace

namespace {
// Precedence of a binary operator token. kArithUnknown is the result for anything else.
// `||` is unknown on purpose. The parser flattens `a || b || c` into one concat() call.
// So its parentheses are not transparent.
int arith_binary_precedence(string_view op) {
  if (op == "+" || op == "-") return kArithAdditive;
  if (op == "*" || op == "/" || op == "%") return kArithMultiplicative;
  if (op == "=" || op == "==" || op == "!=" || op == "<>" || op == "<" || op == ">" || op == "<=" || op == ">=") {
    return kArithCompare;
  }
  return kArithUnknown;
}
}  // namespace

namespace {
bool arith_word_is(string_view word, std::initializer_list<const char*> words) {
  for (const char* w : words) if (iequals_ascii(word, w)) return true;
  return false;
}
}  // namespace

string strip_redundant_arith_parentheses(string_view s) {
  vector<ArithToken> t = lex_arith_tokens(s);
  // The parser treats comments as whitespace. The neighbours of a group are the code tokens around it.
  // If a `-- c` is seen as a token before `-(1)`, the minus looks binary.
  // Then `-(1)` (negate(1)) becomes the literal `-1`.
  t.erase(std::remove_if(t.begin(), t.end(), [](const ArithToken& tok) { return tok.kind == ArithTokenKind::Comment; }), t.end());
  if (t.empty()) return string(s);
  auto text = [&](size_t k) { return s.substr(t[k].begin, t[k].end - t[k].begin); };
  vector<size_t> match(t.size(), string::npos);
  vector<size_t> parent(t.size(), string::npos);  // innermost enclosing open bracket
  vector<size_t> stack;
  for (size_t k = 0; k < t.size(); ++k) {
    if (!stack.empty()) parent[k] = stack.back();
    if (t[k].kind == ArithTokenKind::Open) stack.push_back(k);
    else if (t[k].kind == ArithTokenKind::Close) {
      if (stack.empty()) return string(s);
      match[stack.back()] = k;
      match[k] = stack.back();
      parent[k] = parent[stack.back()];
      stack.pop_back();
    }
  }
  if (!stack.empty()) return string(s);

  // True when the token at k (an operator) is used as a prefix sign.
  auto starts_operand = [&](size_t k) {
    if (k == 0) return true;
    const ArithToken& p = t[k - 1];
    if (p.kind == ArithTokenKind::Open || p.kind == ArithTokenKind::Comma || p.kind == ArithTokenKind::Op) return true;
    return p.kind == ArithTokenKind::Word &&
           arith_word_is(text(k - 1), {"SELECT", "WHERE", "PREWHERE", "HAVING", "BY", "AND", "OR", "NOT",
                                       "THEN", "ELSE", "WHEN", "CASE", "IN", "BETWEEN", "LIMIT", "OFFSET"});
  };

  // Lowest operator precedence directly inside the group (open, close).
  // The result is kArithUnknown when the content is not a plain operator chain.
  auto inner_precedence = [&](size_t open, size_t close, bool beside_operator) {
    int lowest = std::numeric_limits<int>::max();
    bool expect_operand = true;
    bool signed_operand = false;
    size_t operands = 0;
    for (size_t k = open + 1; k < close; ++k) {
      const ArithToken& tok = t[k];
      const string_view tx = text(k);
      if (expect_operand) {
        if (tok.kind == ArithTokenKind::Op && (tx == "-" || tx == "+")) { signed_operand = true; continue; }
        if (tok.kind == ArithTokenKind::Word || tok.kind == ArithTokenKind::Number || tok.kind == ArithTokenKind::Literal) {
          ++operands;
          expect_operand = false;
          continue;
        }
        if (tok.kind == ArithTokenKind::Open) {
          // `((a + b))`: the outer group is kept. The inner group is decided alone, inside the outer one.
          // Dropping both groups turned `((a + b)) * c` into `a + b * c`. Each group was judged by its original neighbours.
          if (k == open + 1 && match[k] == close - 1) return kArithUnknown;
          ++operands;
          expect_operand = false;
          k = match[k];
          continue;
        }
        return kArithUnknown;
      }
      // Postfix forms bind tighter than any operator.
      // These forms are calls, parametric calls, subscripts and tuple or member access.
      if (tok.kind == ArithTokenKind::Open && (text(k) == "(" || text(k) == "[") &&
          (t[k - 1].kind == ArithTokenKind::Word || t[k - 1].kind == ArithTokenKind::Close || text(k) == "[")) {
        k = match[k];
        continue;
      }
      if (tok.kind == ArithTokenKind::Op && tx == "." && k + 1 < close &&
          (t[k + 1].kind == ArithTokenKind::Word || t[k + 1].kind == ArithTokenKind::Number)) {
        ++k;
        continue;
      }
      if (tok.kind != ArithTokenKind::Op) return kArithUnknown;
      const int prec = arith_binary_precedence(tx);
      if (prec == kArithUnknown) return kArithUnknown;
      lowest = std::min(lowest, prec);
      expect_operand = true;
    }
    if (expect_operand || operands == 0) return kArithUnknown;
    if (lowest != std::numeric_limits<int>::max()) return lowest;
    // `(-b)`: a lone signed operand binds tighter than every binary operator.
    // A bare `(x)` keeps its parentheses: after IN or in DDL keys they can matter.
    if (signed_operand && operands == 1) return kArithUnary;
    // `(intDiv(a, b)) * c`, `(0.5) * x`: an atom next to an arithmetic
    // operator binds tighter than it anyway.
    if (operands == 1 && beside_operator) return kArithUnary;
    // `concat((concat(a, b)), c)`: a lone operand wrapped as a whole function argument is transparent.
    // Keyword lists are not transparent. `GROUPING SETS ((a), ())` and `IN ((1), (2))` give their groups meaning.
    const size_t owner = parent[open];
    const bool call_argument = owner != string::npos && owner > 0 && text(owner) == "(" &&
        t[owner - 1].kind == ArithTokenKind::Word &&
        !arith_word_is(text(owner - 1), {"SETS", "IN", "USING", "VALUES", "AS", "BY", "ON", "JOIN", "FROM",
                                         "OVER", "WITH", "AND", "OR", "NOT", "EXISTS", "ANY", "ALL",
                                         "SELECT", "WHERE", "INTERPOLATE", "EXCEPT", "REPLACE", "APPLY"});
    const bool arg_start = call_argument && (t[open - 1].kind == ArithTokenKind::Comma || open - 1 == owner);
    const bool arg_end = close + 1 < t.size() &&
        (t[close + 1].kind == ArithTokenKind::Comma || text(close + 1) == ")");
    return operands == 1 && call_argument && arg_start && arg_end ? kArithUnary : kArithUnknown;
  };

  vector<bool> drop(t.size(), false);
  for (size_t open = 0; open < t.size(); ++open) {
    if (t[open].kind != ArithTokenKind::Open || text(open) != "(") continue;
    const size_t close = match[open];
    int left = kArithUnknown;
    if (open == 0) left = kArithBoundary;
    else {
      const ArithToken& p = t[open - 1];
      const string_view px = text(open - 1);
      if ((p.kind == ArithTokenKind::Open && px != "{") || p.kind == ArithTokenKind::Comma) left = kArithBoundary;
      else if (p.kind == ArithTokenKind::Word &&
               arith_word_is(px, {"SELECT", "WHERE", "PREWHERE", "HAVING", "BY", "THEN", "ELSE", "WHEN"})) {
        left = kArithBoundary;
      } else if (p.kind == ArithTokenKind::Op && !starts_operand(open - 1)) {
        left = arith_binary_precedence(px);
      }
    }
    if (left == kArithUnknown) continue;
    int right = kArithUnknown;
    if (close + 1 == t.size()) right = kArithBoundary;
    else {
      const ArithToken& n = t[close + 1];
      const string_view nx = text(close + 1);
      if ((n.kind == ArithTokenKind::Close && nx != "}") || n.kind == ArithTokenKind::Comma) right = kArithBoundary;
      else if (n.kind == ArithTokenKind::Word &&
               arith_word_is(nx, {"AS", "AND", "OR", "FROM", "WHERE", "PREWHERE", "GROUP", "ORDER", "LIMIT",
                                  "HAVING", "THEN", "ELSE", "END", "WHEN", "ASC", "DESC", "SETTINGS",
                                  "FORMAT", "UNION", "WINDOW", "QUALIFY"})) {
        right = kArithBoundary;
      } else if (n.kind == ArithTokenKind::Op) {
        right = arith_binary_precedence(nx);
      }
    }
    if (right == kArithUnknown) continue;
    const int inner = inner_precedence(open, close, left >= kArithAdditive || right >= kArithAdditive);
    if (inner == kArithUnknown) continue;
    // Binary operators are left-associative: `(a - b) - c` equals
    // `a - b - c`, but `a - (b - c)` and `a + (b + c)` are different trees.
    // Comparisons do not chain. So equal precedence keeps the group.
    const bool right_ok = inner > right || (inner == right && inner >= kArithAdditive);
    if (inner > left && right_ok) {
      drop[open] = true;
      drop[close] = true;
    }
  }

  string out;
  out.reserve(s.size());
  size_t cursor = 0;
  for (size_t k = 0; k < t.size(); ++k) {
    if (!drop[k]) continue;
    out.append(s.substr(cursor, t[k].begin - cursor));
    cursor = t[k].end;
    // `x - (-y)` must not become the comment opener `x --y`.
    if (t[k].kind == ArithTokenKind::Open && !out.empty() && (out.back() == '-' || out.back() == '+') &&
        k + 1 < t.size() && (text(k + 1) == "-" || text(k + 1) == "+")) {
      out.push_back(' ');
    }
    // Keep one space where `(` or `)` was between tokens.
    if (t[k].kind == ArithTokenKind::Open) {
      while (cursor < s.size() && s[cursor] == ' ' && !out.empty() && (out.back() == ' ' || out.back() == '(' || out.back() == '[')) ++cursor;
    } else {
      while (!out.empty() && out.back() == ' ' && cursor < s.size() && s[cursor] == ' ') out.pop_back();
    }
  }
  out.append(s.substr(cursor));
  return out;
}

bool split_arith_chain(string_view s, vector<ArithChainOperator>* ops) {
  const vector<ArithToken> t = lex_arith_tokens(s);
  vector<size_t> match(t.size(), string::npos);
  vector<size_t> stack;
  for (size_t k = 0; k < t.size(); ++k) {
    if (t[k].kind == ArithTokenKind::Open) stack.push_back(k);
    else if (t[k].kind == ArithTokenKind::Close) {
      if (stack.empty()) return false;
      match[stack.back()] = k;
      stack.pop_back();
    }
  }
  if (!stack.empty()) return false;
  auto text = [&](size_t k) { return s.substr(t[k].begin, t[k].end - t[k].begin); };
  bool expect_operand = true;
  size_t operands = 0;
  for (size_t k = 0; k < t.size(); ++k) {
    const ArithToken& tok = t[k];
    const string_view tx = text(k);
    if (tok.kind == ArithTokenKind::Comment) return false;
    if (expect_operand) {
      if (tok.kind == ArithTokenKind::Op && (tx == "-" || tx == "+")) continue;
      if (tok.kind == ArithTokenKind::Word || tok.kind == ArithTokenKind::Number || tok.kind == ArithTokenKind::Literal) {
        ++operands;
        expect_operand = false;
        continue;
      }
      if (tok.kind == ArithTokenKind::Open) {
        ++operands;
        expect_operand = false;
        k = match[k];
        continue;
      }
      return false;
    }
    if (tok.kind == ArithTokenKind::Open && (tx == "(" || tx == "[") &&
        (t[k - 1].kind == ArithTokenKind::Word || t[k - 1].kind == ArithTokenKind::Close || tx == "[")) {
      k = match[k];
      continue;
    }
    if (tok.kind == ArithTokenKind::Op && tx == "." && k + 1 < t.size() &&
        (t[k + 1].kind == ArithTokenKind::Word || t[k + 1].kind == ArithTokenKind::Number)) {
      ++k;
      continue;
    }
    if (tok.kind != ArithTokenKind::Op) return false;
    const int prec = arith_binary_precedence(tx);
    if (prec != kArithAdditive && prec != kArithMultiplicative) return false;
    if (ops) ops->push_back({tok.begin, tok.end, prec});
    expect_operand = true;
  }
  return !expect_operand && operands >= 2;
}

// Re-indent the continuation lines of an operator chain that sit at bracket depth 0 (`\n/ rhs`, `\n- rhs`).
// Such lines hang one level under the first operand.
// `logical` also hangs `AND` / `OR` continuations. Inside an argument list, a wrapped condition must not start its lines where the next argument starts.
string hang_operator_continuations(const string& value, bool logical) {
  const string masked = mask_sql_surface(value).code_lower;
  vector<int> line_depths{0};
  int depth = 0;
  for (char ch : masked) {
    if (ch == '(' || ch == '[' || ch == '{') ++depth;
    else if ((ch == ')' || ch == ']' || ch == '}') && depth > 0) --depth;
    if (ch == '\n') line_depths.push_back(depth);
  }
  auto lines = split_lines_keep(value);
  for (size_t i = 1; i < lines.size() && i < line_depths.size(); ++i) {
    if (line_depths[i] != 0) continue;
    size_t content = 0;
    while (content < lines[i].size() && (lines[i][content] == ' ' || lines[i][content] == '\t')) ++content;
    const bool binary_continuation = content + 1 < lines[i].size() &&
        (lines[i][content] == '-' || lines[i][content] == '/' || lines[i][content] == '%' ||
         lines[i][content] == '+' || lines[i][content] == '*') &&
        lines[i][content + 1] == ' ';
    const string_view rest = string_view(lines[i]).substr(content);
    const bool logical_continuation = logical && (starts_with_ci(rest, "AND ") || starts_with_ci(rest, "OR "));
    if (binary_continuation || logical_continuation) lines[i].replace(0, content, 4, ' ');
  }
  return join_lines(lines);
}

}  // namespace fmt
}  // namespace chdash
