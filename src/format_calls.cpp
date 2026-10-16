// This unit sets the layout of calls for the line width. It scans the brackets, joins the calls that fit, and attaches the operators.
// format_internal.hpp contains the declarations that the units share.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

CallScan scan_call_brackets(string_view s) {
  spend_format_budget(s.size());
  CallScan out;
  out.kind.assign(s.size(), kCallCode);
  out.match.assign(s.size(), string::npos);
  out.parent.assign(s.size(), string::npos);
  out.opener.assign(s.size(), string::npos);
  enum class State { Code, Single, Double, Back, Line, Block };
  State state = State::Code;
  vector<size_t> stack;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    const char n = i + 1 < s.size() ? s[i + 1] : '\0';
    auto mark_next = [&](unsigned char k) { if (i + 1 < s.size()) out.kind[i + 1] = k; };
    switch (state) {
      case State::Line:
        if (c == '\n') state = State::Code;
        else out.kind[i] = kCallComment;
        continue;
      case State::Block:
        out.kind[i] = kCallComment;
        if (c == '*' && n == '/') { mark_next(kCallComment); ++i; state = State::Code; }
        continue;
      case State::Single:
      case State::Double: {
        out.kind[i] = kCallLiteral;
        const char quote = state == State::Single ? '\'' : '"';
        if (c == '\\') { mark_next(kCallLiteral); ++i; }
        else if (c == quote && n == quote) { mark_next(kCallLiteral); ++i; }
        else if (c == quote) state = State::Code;
        continue;
      }
      case State::Back:
        out.kind[i] = kCallLiteral;
        if (c == '`' && n == '`') { mark_next(kCallLiteral); ++i; }
        else if (c == '`') state = State::Code;
        continue;
      case State::Code:
        break;
    }
    if (c == '\'' || c == '"' || c == '`') {
      out.kind[i] = kCallLiteral;
      state = c == '\'' ? State::Single : (c == '"' ? State::Double : State::Back);
    } else if ((c == '-' && n == '-') || c == '#') {
      out.kind[i] = kCallComment;
      state = State::Line;
    } else if (c == '/' && n == '*') {
      out.kind[i] = kCallComment;
      mark_next(kCallComment);
      ++i;
      state = State::Block;
    } else if (c == '(' || c == '[') {
      out.parent[i] = stack.empty() ? string::npos : stack.back();
      stack.push_back(i);
    } else if (c == ')' || c == ']') {
      if (!stack.empty() && s[stack.back()] == (c == ')' ? '(' : '[')) {
        out.match[stack.back()] = i;
        out.opener[i] = stack.back();
        stack.pop_back();
      }
    }
  }
  return out;
}

namespace {
// Joins a multi-line expression onto one line. Use one space between lines, and no space after an opener or before a closer.
// The result is empty when a line break is inside a literal or a comment. A join there changes the text.
string join_code_lines(string_view s) {
  const CallScan scan = scan_call_brackets(s);
  string out;
  size_t start = 0;
  while (start <= s.size()) {
    size_t nl = s.find('\n', start);
    if (nl != string_view::npos && scan.kind[nl] != kCallCode) return {};
    if (nl != string_view::npos && nl > 0 && scan.kind[nl - 1] == kCallComment) return {};
    const string t = trim_ascii_spaces(s.substr(start, (nl == string_view::npos ? s.size() : nl) - start));
    if (!t.empty()) {
      if (out.empty() || out.back() == '(' || out.back() == '[' || t.front() == ')' || t.front() == ']') out += t;
      else out += " " + t;
    }
    if (nl == string_view::npos) break;
    start = nl + 1;
  }
  return out;
}
}  // namespace

namespace {
bool is_call_ident_char(char ch) {
  return std::isalnum(static_cast<unsigned char>(ch)) != 0 || ch == '_';
}
}  // namespace

namespace {
// Identifiers before `(` that are type constructors or keywords are not calls. DDL types keep their own layout.
// `GROUPING SETS(`, `CODEC(` or `SELECT(` in a GRANT are clause syntax.
bool is_layout_call_name(string_view name) {
  static const char* excluded[] = {
      "Array", "Tuple", "Map", "Nullable", "LowCardinality", "Nested", "Enum", "Enum8", "Enum16",
      "Decimal", "Decimal32", "Decimal64", "Decimal128", "Decimal256", "DateTime", "DateTime64",
      "FixedString", "Variant", "Dynamic", "JSON", "Object", "AggregateFunction",
      "SimpleAggregateFunction", "SETS", "IN", "VALUES", "USING", "CODEC", "TTL", "INDEX",
      "ON", "AND", "OR", "NOT", "AS", "BY", "OVER", "SELECT", "FROM", "WHERE", "JOIN", "FILTER"};
  if (name.empty() || std::isdigit(static_cast<unsigned char>(name.front()))) return false;
  for (const char* word : excluded) {
    if (name == word) return false;
  }
  return true;
}
}  // namespace

namespace {
// `FROM VALUES(...)` written without quotes is the VALUES table function. The INSERT ... VALUES payload never reaches the width pass.
bool is_values_table_function(string_view s, size_t name_begin, size_t open) {
  if (!iequals_ascii(s.substr(name_begin, open - name_begin), "VALUES")) return false;
  size_t e = name_begin;
  while (e > 0 && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\n')) --e;
  size_t b = e;
  while (b > 0 && is_ident_char(s[b - 1])) --b;
  const string_view prev = s.substr(b, e - b);
  return iequals_ascii(prev, "FROM") || iequals_ascii(prev, "JOIN");
}
}  // namespace

CallOpener classify_call_opener(string_view s, const CallScan& scan, size_t pos, size_t* name_begin) {
  if (name_begin) *name_begin = pos;
  if (s[pos] == '[') {
    // `arr[` is subscript syntax, not a literal.
    if (pos > 0 && (is_call_ident_char(s[pos - 1]) || s[pos - 1] == ')' || s[pos - 1] == ']' || s[pos - 1] == '`')) return CallOpener::None;
    return CallOpener::Array;
  }
  if (pos == 0) return CallOpener::None;
  const char prev = s[pos - 1];
  if (is_call_ident_char(prev) && scan.kind[pos - 1] == kCallCode) {
    size_t b = pos - 1;
    while (b > 0 && is_call_ident_char(s[b - 1]) && scan.kind[b - 1] == kCallCode) --b;
    if (b > 0 && (s[b - 1] == '.' || s[b - 1] == '`')) return CallOpener::None;
    if (!is_layout_call_name(s.substr(b, pos - b)) && !is_values_table_function(s, b, pos)) return CallOpener::None;
    if (name_begin) *name_begin = b;
    return CallOpener::Call;
  }
  if (prev == '`' && scan.kind[pos - 1] == kCallLiteral && pos >= 2) {
    // A quoted function name is the form that formatQuery prints for the VALUES table function: `VALUES`('k String', ('a', 1), ...).
    const size_t b = s.rfind('`', pos - 2);
    if (b == string_view::npos || (b > 0 && (scan.kind[b - 1] != kCallCode || s[b - 1] == '.'))) return CallOpener::None;
    if (name_begin) *name_begin = b;
    return CallOpener::Call;
  }
  if (prev == ')' && scan.kind[pos - 1] == kCallCode) {
    // Parametric aggregate `name(params)(`. Find the `name(` of the params.
    const size_t open = scan.opener[pos - 1];
    if (open == string::npos) return CallOpener::None;
    size_t begin = open;
    if (classify_call_opener(s, scan, open, &begin) != CallOpener::Call) return CallOpener::None;
    if (name_begin) *name_begin = begin;
    return CallOpener::Call;
  }
  size_t k = pos;
  while (k > 0 && (s[k - 1] == ' ' || s[k - 1] == '\t')) --k;
  if (k >= 2 && (s[k - 1] == 'N' || s[k - 1] == 'n') && (s[k - 2] == 'I' || s[k - 2] == 'i') &&
      (k == 2 || !is_call_ident_char(s[k - 3])) && k < pos) {
    return CallOpener::InList;
  }
  if (k > 0 && s[k - 1] != '\n') return CallOpener::None;
  const size_t parent = scan.parent[pos];
  if (parent != string::npos && s[parent] == '[') return CallOpener::ArrayTuple;
  return CallOpener::None;
}

// `[1, 2]::Array(UInt8)` casts the source text of the literal. The bytes between the brackets end up in the AST. Their whitespace must stay as written.
bool closer_starts_text_cast(string_view s, size_t close) {
  return close + 2 < s.size() && s[close + 1] == ':' && s[close + 2] == ':';
}

// Number of top-level arguments between an opener and its closer.
size_t count_call_arguments(string_view s, const CallScan& scan, size_t open, size_t close) {
  size_t count = 1;
  int depth = 0;
  bool any = false;
  for (size_t i = open + 1; i < close; ++i) {
    if (scan.kind[i] != kCallCode) { any = true; continue; }
    const char c = s[i];
    if (c == '(' || c == '[' || c == '{') ++depth;
    else if (c == ')' || c == ']' || c == '}') --depth;
    else if (c == ',' && depth == 0) ++count;
    else if (c != ' ' && c != '\n') any = true;
  }
  return any ? count : 0;
}

namespace {
bool call_name_is(string_view s, size_t name_begin, size_t open, const char* name) {
  return s.substr(name_begin, open - name_begin) == name;
}
}  // namespace

namespace {
// multiIf and CASE with two or more branches read as a decision table. They stay one branch per line, whatever their width.
bool is_vertical_branch_call(string_view s, const CallScan& scan, size_t name_begin, size_t open) {
  const size_t close = scan.match[open];
  if (close == string::npos) return false;
  if (call_name_is(s, name_begin, open, "multiIf")) return count_call_arguments(s, scan, open, close) >= 5;
  if (call_name_is(s, name_begin, open, "caseWithExpression")) return count_call_arguments(s, scan, open, close) >= 6;
  return false;
}
}  // namespace

// Joins split calls whose one-line form fits in `width`, outermost call first.
// Regions that hold comments, subqueries, window specifications, or a line break inside a literal keep their lines.
// `joined_rows`, when given, receives the output line numbers that a join produces.
string collapse_fitting_calls(string_view text, size_t width, vector<size_t>* joined_rows) {
  const CallScan scan = scan_call_brackets(text);
  vector<size_t> starts{0};
  for (size_t i = 0; i < text.size(); ++i) if (text[i] == '\n') starts.push_back(i + 1);
  const size_t line_count = starts.size();
  auto line_end = [&](size_t l) { return l + 1 < line_count ? starts[l + 1] - 1 : text.size(); };
  auto line_of = [&](size_t pos) {
    return static_cast<size_t>(std::upper_bound(starts.begin(), starts.end(), pos) - starts.begin()) - 1;
  };
  vector<string> rows;
  rows.reserve(line_count);
  for (size_t l = 0; l < line_count; ++l) rows.emplace_back(text.substr(starts[l], line_end(l) - starts[l]));
  vector<size_t> owner(line_count);
  for (size_t l = 0; l < line_count; ++l) owner[l] = l;
  vector<bool> removed(line_count, false);
  vector<bool> joined(line_count, false);
  vector<bool> join_tail(line_count, false);

  for (size_t o = 0; o < line_count; ++o) {
    // Lines inside a joined region are removed. The closing line of a joined region stays as the tail of its owner row.
    // That tail can end with an opener, such as `) AND has(`.
    if (removed[o] && !join_tail[o]) continue;
    size_t p = line_end(o);
    while (p > starts[o] && (text[p - 1] == ' ' || text[p - 1] == '\t')) --p;
    if (p == starts[o]) continue;
    const size_t open = p - 1;
    if (scan.kind[open] != kCallCode || (text[open] != '(' && text[open] != '[')) continue;
    size_t name_begin = open;
    const CallOpener kind = classify_call_opener(text, scan, open, &name_begin);
    if (kind == CallOpener::None) continue;
    const size_t close = scan.match[open];
    if (close == string::npos) continue;
    const size_t k = line_of(close);
    if (k <= o || closer_starts_text_cast(text, close)) continue;
    size_t first = starts[k];
    while (first < close && (text[first] == ' ' || text[first] == '\t')) ++first;
    if (first != close) continue;
    if (kind == CallOpener::Call && is_vertical_branch_call(text, scan, name_begin, open)) continue;
    bool blocked = false;
    // A decision table nested anywhere inside keeps the enclosing call open.
    for (size_t i = open + 1; i < close && !blocked; ++i) {
      if (text[i] != '(' || scan.kind[i] != kCallCode) continue;
      for (const string_view branch_name : {string_view("multiIf"), string_view("caseWithExpression")}) {
        if (i >= branch_name.size() && text.substr(i - branch_name.size(), branch_name.size()) == branch_name &&
            is_vertical_branch_call(text, scan, i - branch_name.size(), i)) blocked = true;
      }
    }
    // A comment inside the call keeps the call open. A comment after its closing parenthesis (`), -- note`) is at the end of the line. It stays there.
    for (size_t i = starts[o]; i < line_end(k) && !blocked; ++i) {
      if (scan.kind[i] == kCallComment && i < close) blocked = true;
      else if (text[i] == '\n' && scan.kind[i] == kCallLiteral) blocked = true;
    }
    if (blocked) continue;
    {
      const auto masked = mask_sql_surface(text.substr(open, close - open));
      const string& code = masked.code_lower;
      for (size_t i = 0; i + 6 <= code.size() && !blocked; ++i) {
        if (code.compare(i, 6, "select") == 0 && (i == 0 || !is_call_ident_char(code[i - 1])) &&
            (i + 6 == code.size() || !is_call_ident_char(code[i + 6]))) blocked = true;
      }
      for (size_t l = o + 1; l < k && !blocked; ++l) {
        const string row = rtrim_spaces(string_view(code).substr(starts[l] - open, line_end(l) - starts[l]));
        if (ends_with_ci(row, "over (")) blocked = true;
      }
    }
    if (blocked) continue;
    const size_t r = owner[o];
    string line = rows[r];
    for (size_t l = o + 1; l <= k; ++l) {
      const string t = trim_ascii_spaces(rows[l]);
      if (t.empty()) continue;
      const char last = line.empty() ? ' ' : line.back();
      if (last == '(' || last == '[' || t.front() == ')' || t.front() == ']') line += t;
      else line += " " + t;
    }
    if (utf8_width(line) > width) continue;
    rows[r] = std::move(line);
    joined[r] = true;
    for (size_t l = o + 1; l <= k; ++l) {
      owner[l] = r;
      removed[l] = true;
      join_tail[l] = l == k;
    }
    join_tail[o] = false;
  }
  string out;
  size_t out_line = 0;
  for (size_t l = 0; l < line_count; ++l) {
    if (removed[l]) continue;
    if (out_line) out.push_back('\n');
    if (joined_rows && joined[l]) joined_rows->push_back(out_line);
    out += rows[l];
    ++out_line;
  }
  return out;
}

namespace {
// One pass of join_fitting_arguments, described below.
string join_fitting_arguments_once(const string& text, size_t width, bool* changed) {
  const CallScan scan = scan_call_brackets(text);
  vector<size_t> starts{0};
  for (size_t i = 0; i < text.size(); ++i) if (text[i] == '\n') starts.push_back(i + 1);
  const size_t line_count = starts.size();
  auto line_of = [&](size_t pos) {
    return static_cast<size_t>(std::upper_bound(starts.begin(), starts.end(), pos) - starts.begin()) - 1;
  };
  auto line_end = [&](size_t l) { return l + 1 < line_count ? starts[l + 1] - 1 : text.size(); };
  vector<string> rows;
  rows.reserve(line_count);
  for (size_t l = 0; l < line_count; ++l) rows.emplace_back(text.substr(starts[l], line_end(l) - starts[l]));
  vector<bool> removed(line_count, false);
  vector<bool> touched(line_count, false);
  // One pass runs in text order. The arguments of an outer list come before the lists nested in them.
  // A joined argument takes its nested lists with it.
  size_t joined_until = 0;
  for (size_t open = 0; open < text.size(); ++open) {
    if (scan.kind[open] != kCallCode || (text[open] != '(' && text[open] != '[')) continue;
    const size_t close = scan.match[open];
    if (close == string::npos || open < joined_until || line_of(close) == line_of(open)) continue;
    size_t name_begin = open;
    const CallOpener kind = classify_call_opener(text, scan, open, &name_begin);
    if (kind == CallOpener::None) continue;
    if (kind == CallOpener::Call && is_vertical_branch_call(text, scan, name_begin, open)) continue;
    vector<std::pair<size_t, size_t>> args;
    size_t arg_start = open + 1;
    int depth = 0;
    // `IN (SELECT a, b FROM t)`. A bracket that holds a query directly is not an argument list. Its commas separate projection items.
    // A join of the last "argument" moves `FROM t` onto the line of the last item.
    bool subquery = false;
    for (size_t i = open + 1; i <= close; ++i) {
      if (scan.kind[i] != kCallCode) continue;
      const char c = text[i];
      if (depth == 0 && i + 6 <= close && (c == 's' || c == 'S') && iequals_ascii(string_view(text).substr(i, 6), "SELECT") &&
          !is_call_ident_char(text[i - 1]) && !is_call_ident_char(text[i + 6])) subquery = true;
      if (i < close && (c == '(' || c == '[' || c == '{')) ++depth;
      else if (i < close && (c == ')' || c == ']' || c == '}')) --depth;
      else if ((c == ',' && depth == 0) || i == close) {
        args.push_back({arg_start, i});
        arg_start = i + 1;
      }
    }
    if (subquery) continue;
    for (const auto& [begin, end] : args) {
      size_t fa = begin;
      while (fa < end && std::isspace(static_cast<unsigned char>(text[fa]))) ++fa;
      size_t la = end;
      while (la > fa && std::isspace(static_cast<unsigned char>(text[la - 1]))) --la;
      if (fa >= la || fa < joined_until) continue;
      const size_t first_line = line_of(fa);
      const size_t last_line = line_of(la - 1);
      if (first_line == last_line || touched[first_line] || touched[last_line]) continue;
      bool blocked = false;
      for (size_t i = starts[first_line]; i < line_end(last_line) && !blocked; ++i) {
        if (scan.kind[i] == kCallComment) blocked = true;
      }
      const string_view arg = string_view(text).substr(fa, la - fa);
      if (blocked || arg.find("::") != string_view::npos) continue;
      const auto masked = mask_sql_surface(arg);
      const string& code = masked.code_lower;
      for (size_t i = 0; i + 6 <= code.size() && !blocked; ++i) {
        if (code.compare(i, 6, "select") == 0 && (i == 0 || !is_call_ident_char(code[i - 1])) &&
            (i + 6 == code.size() || !is_call_ident_char(code[i + 6]))) blocked = true;
      }
      if (blocked || code.find("over (\n") != string::npos) continue;
      for (size_t i = fa; i < la && !blocked; ++i) {
        if (text[i] != '(' || scan.kind[i] != kCallCode) continue;
        for (const string_view branch_name : {string_view("multiIf"), string_view("caseWithExpression")}) {
          if (i >= branch_name.size() && string_view(text).substr(i - branch_name.size(), branch_name.size()) == branch_name &&
              is_vertical_branch_call(text, scan, i - branch_name.size(), i)) blocked = true;
        }
      }
      if (blocked) continue;
      const string joined_arg = join_code_lines(arg);
      if (joined_arg.empty()) continue;
      string line = text.substr(starts[first_line], fa - starts[first_line]) + joined_arg +
                    text.substr(la, line_end(last_line) - la);
      if (utf8_width(line) > width) continue;
      rows[first_line] = std::move(line);
      for (size_t l = first_line; l <= last_line; ++l) {
        touched[l] = true;
        removed[l] = l != first_line;
      }
      joined_until = std::max(joined_until, la);
      *changed = true;
    }
  }
  string out;
  bool first = true;
  for (size_t l = 0; l < line_count; ++l) {
    if (removed[l]) continue;
    if (!first) out.push_back('\n');
    first = false;
    out += rows[l];
  }
  return out;
}
}  // namespace

// An argument of a split list that still spans several lines is joined onto its own line when it fits there.
// Examples are a wrapped arithmetic or boolean chain, and a lambda whose body wrapped.
// Every argument is formatted again at the position that the split gave it.
// An argument that shares a line with a joined argument waits for the next pass.
string join_fitting_arguments(string text, size_t width) {
  for (int pass = 0; pass < 4; ++pass) {
    bool changed = false;
    text = join_fitting_arguments_once(text, width, &changed);
    if (!changed) break;
  }
  return text;
}

// After a split call closes, the next arithmetic operator continues on the `)` line when it fits.
// The same applies after a parenthesized block, and as `) AS alias` does.
// Example: `) / nullIf(sum(duration_ms), 0),`.
string attach_operators_to_closers(string_view text, size_t width) {
  vector<string> lines = split_lines_keep(text);
  vector<string> out;
  out.reserve(lines.size());
  for (string& line : lines) {
    if (!out.empty()) {
      const string prev = trim_ascii_spaces(out.back());
      const string cur = trim_ascii_spaces(line);
      bool op = false;
      for (const char* lead : {"+ ", "- ", "* ", "/ ", "% "}) op = op || starts_with_ci(cur, lead);
      if (op && (prev == ")" || prev == "]") && !contains_top_level_comment(cur)) {
        string merged = rtrim_spaces(out.back()) + " " + cur;
        if (utf8_width(merged) <= width) {
          out.back() = std::move(merged);
          continue;
        }
      }
    }
    out.push_back(std::move(line));
  }
  return join_lines(out);
}

// After a join, a single projection (or GROUP BY / ORDER BY item) that became one line moves to the keyword line when it fits there.
// The expression formatter does the same when it keeps the expression inline.
// Example: `SELECT greatest(least(x, hi), lo) AS v`.
string merge_joined_single_select_items(string_view text, const vector<size_t>& joined_rows, size_t width) {
  if (joined_rows.empty()) return string(text);
  vector<string> lines = split_lines_keep(text);
  vector<bool> drop(lines.size(), false);
  for (const size_t r : joined_rows) {
    if (r == 0 || r >= lines.size()) continue;
    const size_t head_indent = leading_space_count(lines[r - 1]);
    const string head = trim_ascii_spaces(lines[r - 1]);
    const bool select = head == "SELECT" || head == "SELECT DISTINCT" || head == "SELECT ALL";
    if ((!select && head != "GROUP BY" && head != "ORDER BY") || leading_space_count(lines[r]) != head_indent + 4) continue;
    if (r + 1 < lines.size() && leading_space_count(lines[r + 1]) > head_indent) continue;
    const string item = trim_ascii_spaces(lines[r]);
    if (item.empty() || item.back() == ',' || contains_top_level_comment(item) || (select && contains_select_keyword(item))) continue;
    string merged = rtrim_spaces(lines[r - 1]) + " " + item;
    if (utf8_width(merged) > width) continue;
    lines[r - 1] = std::move(merged);
    drop[r] = true;
  }
  vector<string> kept;
  for (size_t i = 0; i < lines.size(); ++i) if (!drop[i]) kept.push_back(std::move(lines[i]));
  return join_lines(kept);
}

}  // namespace fmt
}  // namespace chdash
