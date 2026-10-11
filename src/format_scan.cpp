// What the formatter reads in a text without laying it out: the matching bracket, the top level of a text, its keywords, operators and clauses.
// The declarations that the units share are in format_internal.hpp.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

size_t find_matching_paren(string_view s, size_t open_pos) {
  if (open_pos >= s.size() || s[open_pos] != '(') return string::npos;
  ScanState st;
  st.par = 1;
  for (size_t i = open_pos + 1; i < s.size(); ++i) {
    if (st.in_code()) {
      if (s[i] == '(') ++st.par;
      else if (s[i] == ')') {
        --st.par;
        if (st.par == 0) return i;
      }
    }
    step_scan(st, s, i);
  }
  return string::npos;
}

namespace {
// `AND` / `OR` inside `CASE ... END` and the `AND` of `BETWEEN a AND b` are
// not boolean connectives of the enclosing expression: splitting a condition
// chain there turned `x BETWEEN a AND b` into two conditions on the page.
struct BoolWordTracker {
  int case_depth = 0;
  bool between_pending = false;

  // Called at every top-level position; returns true when a top-level `kw`
  // starting at `i` must not be treated as a boolean connective.
  bool skip(string_view s, size_t i, string_view kw) {
    const bool bool_kw = iequals_ascii(kw, "AND") || iequals_ascii(kw, "OR");
    if (!bool_kw || (i > 0 && is_ident_char(s[i - 1])) || !is_ident_char(s[i])) return false;
    size_t end = i;
    while (end < s.size() && is_ident_char(s[end])) ++end;
    const string_view word = s.substr(i, end - i);
    if (iequals_ascii(word, "CASE")) ++case_depth;
    else if (iequals_ascii(word, "END") && case_depth > 0) --case_depth;
    else if (iequals_ascii(word, "BETWEEN") && case_depth == 0) between_pending = true;
    else if (iequals_ascii(word, kw)) {
      if (case_depth > 0) return true;
      if (iequals_ascii(kw, "AND") && between_pending) {
        between_pending = false;
        return true;
      }
    }
    return false;
  }
};
}  // namespace

int find_top_level_keyword(string_view s, string_view kw, size_t start) {
  ScanState st;
  BoolWordTracker words;
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st) && words.skip(s, i, kw)) {
      step_scan(st, s, i);
      continue;
    }
    if (i >= start && is_top_level(st) && i + kw.size() <= s.size() && iequals_ascii(s.substr(i, kw.size()), kw)) {
      const char prev = (i == 0) ? '\0' : s[i - 1];
      const char next = (i + kw.size() < s.size()) ? s[i + kw.size()] : '\0';
      if ((prev == '\0' || !is_ident_char(prev)) && (next == '\0' || !is_ident_char(next))) return static_cast<int>(i);
    }
    step_scan(st, s, i);
  }
  return -1;
}

bool is_create_function(string_view text) {
  return starts_with_ci(text, "CREATE FUNCTION ") || starts_with_ci(text, "CREATE OR REPLACE FUNCTION ");
}

// Top-level INTERSECT / EXCEPT set operators, with or without DISTINCT / ALL.
// Only an operator followed by a query counts: `* EXCEPT (col)` is the
// column modifier. parts[i].second is the operator before part i.
vector<std::pair<string, string>> split_intersect_except(string_view s) {
  static const char* ops[] = {"INTERSECT DISTINCT", "INTERSECT ALL", "EXCEPT DISTINCT", "EXCEPT ALL", "INTERSECT", "EXCEPT"};
  auto starts_word = [&](size_t at, string_view word) {
    return at + word.size() <= s.size() && iequals_ascii(s.substr(at, word.size()), word) &&
           (at + word.size() == s.size() || !is_ident_char(s[at + word.size()]));
  };
  vector<std::pair<string, string>> parts;
  size_t start = 0;
  string last_op;
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    bool matched = false;
    if (is_top_level(st) && (i == 0 || !is_ident_char(s[i - 1]))) {
      for (const char* raw : ops) {
        const string_view op(raw);
        if (!starts_word(i, op)) continue;
        size_t next = i + op.size();
        while (next < s.size() && (s[next] == '(' || std::isspace(static_cast<unsigned char>(s[next])))) ++next;
        if (!starts_word(next, "SELECT") && !starts_word(next, "WITH")) continue;
        parts.push_back({trim_ascii_spaces(s.substr(start, i - start)), last_op});
        last_op = string(op);
        start = i + op.size();
        i = start - 1;
        matched = true;
        break;
      }
    }
    if (!matched) step_scan(st, s, i);
  }
  if (parts.empty()) return {};
  parts.push_back({trim_ascii_spaces(s.substr(start)), last_op});
  return parts;
}

bool previous_word_is_as(string_view s, size_t pos) {
  size_t end = pos;
  while (end > 0 && std::isspace(static_cast<unsigned char>(s[end - 1]))) --end;
  size_t begin = end;
  while (begin > 0 && is_ident_char(s[begin - 1])) --begin;
  return begin < end && iequals_ascii(s.substr(begin, end - begin), "AS");
}

vector<std::pair<int, string>> find_select_clauses(
    string_view text,
    size_t start,
    const vector<string_view>& clauses
) {
  vector<std::pair<int, string>> positions;
  ScanState state;
  for (size_t i = 0; i < text.size(); ++i) {
    if (i >= start && is_top_level(state)) {
      string_view matched;
      for (const string_view clause : clauses) {
        if (i + clause.size() > text.size() || !iequals_ascii(text.substr(i, clause.size()), clause)) continue;
        const char previous = i == 0 ? '\0' : text[i - 1];
        const char next = i + clause.size() < text.size() ? text[i + clause.size()] : '\0';
        if ((previous != '\0' && is_ident_char(previous)) ||
            (next != '\0' && is_ident_char(next))) {
          continue;
        }
        // `AS FROM`, `AS WHERE`, and similar constructs are aliases. Treating
        // the alias token as a clause truncates the SELECT projection before
        // the formatter gets a chance to quote the reserved identifier.
        if (previous_word_is_as(text, i)) continue;
        // `format('{} {}', a, b)` is the string function, not the FORMAT
        // clause: a FORMAT clause is followed by a format name, never `(`.
        if (iequals_ascii(clause, "FORMAT")) {
          size_t after = i + clause.size();
          while (after < text.size() && (text[after] == ' ' || text[after] == '\n' || text[after] == '\t')) ++after;
          if (after < text.size() && text[after] == '(') continue;
        }
        if (matched.empty() || clause.size() > matched.size()) matched = clause;
      }
      if (!matched.empty()) {
        positions.emplace_back(static_cast<int>(i), string(matched));
        i += matched.size() - 1;
        continue;
      }
    }
    step_scan(state, text, i);
  }
  return positions;
}

vector<string> split_top_level(string_view s, char delim) {
  vector<string> out;
  size_t start = 0;
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st) && s[i] == delim) {
      out.emplace_back(s.substr(start, i - start));
      start = i + 1;
    }
    step_scan(st, s, i);
  }
  out.emplace_back(s.substr(start));
  return out;
}

vector<string> split_top_level_keyword(string_view s, string_view kw) {
  vector<string> out;
  size_t start = 0;
  bool found = false;
  ScanState st;
  BoolWordTracker words;
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st) && words.skip(s, i, kw)) {
      step_scan(st, s, i);
      continue;
    }
    if (is_top_level(st) && i + kw.size() <= s.size() && iequals_ascii(s.substr(i, kw.size()), kw)) {
      const char prev = (i == 0) ? '\0' : s[i - 1];
      const char next = (i + kw.size() < s.size()) ? s[i + kw.size()] : '\0';
      if ((prev == '\0' || !is_ident_char(prev)) && (next == '\0' || !is_ident_char(next))) {
        out.emplace_back(s.substr(start, i - start));
        start = i + kw.size();
        i += kw.size() - 1;
        found = true;
        continue;
      }
    }
    step_scan(st, s, i);
  }
  if (!found) return {};
  out.emplace_back(s.substr(start));
  return out;
}

int find_top_level_arrow(string_view s) {
  ScanState st;
  for (size_t i = 0; i + 1 < s.size(); ++i) {
    if (is_top_level(st) && s[i] == '-' && s[i + 1] == '>') return static_cast<int>(i);
    step_scan(st, s, i);
  }
  return -1;
}

string expand_nested_select_head(string rendered) {
  if (!starts_with_ci(rendered, "SELECT ")) return rendered;
  const size_t nl = rendered.find('\n');
  if (nl == string::npos) return rendered;
  return string("SELECT\n    ") + rendered.substr(7, nl - 7) + rendered.substr(nl);
}

string unwrap_outer_parens(string_view s) {
  const string text = trim_ascii_spaces(s);
  if (text.size() < 2 || text.front() != '(' || text.back() != ')') return {};
  int depth = 0;
  ScanState st;
  for (size_t i = 0; i < text.size(); ++i) {
    const char c = text[i];
    if (st.in_code()) {
      if (c == '(') ++depth;
      else if (c == ')') {
        --depth;
        if (depth == 0 && i + 1 != text.size()) return {};
      }
    }
    step_scan(st, text, i);
  }
  return depth == 0 ? text.substr(1, text.size() - 2) : string();
}

bool looks_like_query(string_view s) {
  string text = trim_ascii_spaces(s);
  while (!text.empty()) {
    if (starts_with_ci(text, "/*")) {
      const size_t end = text.find("*/", 2);
      if (end == string::npos) break;
      text = trim_ascii_spaces(text.substr(end + 2));
      continue;
    }
    if (starts_with_ci(text, "--") || starts_with_ci(text, "#")) {
      const size_t end = text.find('\n');
      if (end == string::npos) return false;
      text = trim_ascii_spaces(text.substr(end + 1));
      continue;
    }
    break;
  }
  static const char* kws[] = {"SELECT", "WITH", "INSERT", "CREATE", "ALTER", "DELETE", "EXPLAIN"};
  for (const char* kw : kws) {
    if (starts_with_ci(text, kw)) return true;
  }
  return false;
}

bool contains_top_level_comment(string_view s) {
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st)) {
      const char c = s[i];
      const char n = (i + 1 < s.size()) ? s[i + 1] : '\0';
      if (c == '#' || (c == '-' && n == '-') || (c == '/' && n == '*')) return true;
    }
    step_scan(st, s, i);
  }
  return false;
}

// A subquery anywhere in the expression (`SELECT` as a keyword, not
// `selected_rows`, and not inside literals or comments).
bool contains_select_keyword(string_view s) {
  const string text = trim_ascii_spaces(s);
  if (looks_like_query(text)) return true;
  const string code = mask_sql_surface(text).code_lower;
  for (size_t at = code.find("select"); at != string::npos; at = code.find("select", at + 1)) {
    const bool left = at == 0 || !is_ident_char(code[at - 1]);
    const bool right = at + 6 >= code.size() || !is_ident_char(code[at + 6]);
    if (left && right) return true;
  }
  return false;
}

bool contains_heavy_structure(string_view s) {
  const string text = trim_ascii_spaces(s);
  if (looks_like_query(text)) return true;
  // Layout decisions must not depend on literal or comment contents: a format
  // string such as '{} {}', a '[...]' in text or '-> SELECT' inside a string is
  // not structure. Search the lower-cased code surface (literals and comments
  // blanked) with lower-cased needles.
  const string code = mask_sql_surface(text).code_lower;
  static const char* needles[] = {
      "->", "exists(", "over (", "arrayzip(", "map(", "dictget(",
      "dictgetordefault(", "jsonextract", "multiif(", "arraymap(", "arrayfilter(", "arrayexists(",
      "arrayall(", "arraycount("};
  for (const char* needle : needles) {
    if (code.find(needle) != string::npos) return true;
  }
  // SELECT as a keyword only (not `selected_rows`).
  for (size_t at = code.find("select"); at != string::npos; at = code.find("select", at + 1)) {
    const bool left = at == 0 || !is_ident_char(code[at - 1]);
    const bool right = at + 6 >= code.size() || !is_ident_char(code[at + 6]);
    if (left && right) return true;
  }
  return code.find('[') != string::npos || code.find('{') != string::npos;
}

int find_top_level_comparator(string_view s, string* op) {
  // Longest spellings first: `<=>` and `==` are single operators.
  static const char* ops[] = {"<=>", "==", ">=", "<=", "!=", "<>", "=", ">", "<"};
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st)) {
      for (const char* raw : ops) {
        const string_view candidate(raw);
        if (i + candidate.size() > s.size()) continue;
        if (!iequals_ascii(s.substr(i, candidate.size()), candidate)) continue;
        if (candidate == ">" && i + 1 < s.size() && s[i + 1] == '=') continue;
        if (candidate == "<" && i + 1 < s.size() && (s[i + 1] == '=' || s[i + 1] == '>')) continue;
        if (candidate == "=" && i > 0 && (s[i - 1] == '>' || s[i - 1] == '<' || s[i - 1] == '!' || s[i - 1] == '-')) continue;
        if (candidate == "=" && i + 1 < s.size() && s[i + 1] == '>') continue;
        if (op) *op = string(candidate);
        return static_cast<int>(i);
      }
    }
    step_scan(st, s, i);
  }
  return -1;
}

std::pair<string, string> split_inline_comment(string_view s) {
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st)) {
      const char c = s[i];
      const char n = (i + 1 < s.size()) ? s[i + 1] : '\0';
      if (c == '-' && n == '-') return {rtrim_spaces(s.substr(0, i)), string("-- ") + trim_ascii_spaces(s.substr(i + 2))};
      if (c == '#') return {rtrim_spaces(s.substr(0, i)), string("# ") + trim_ascii_spaces(s.substr(i + 1))};
    }
    step_scan(st, s, i);
  }
  return {rtrim_spaces(s), {}};
}

// Appends the comma that separates a rendered item from the next one. A `--` or `#` comment runs
// to the end of its line, so the comma goes after the code of the last line that has code, before
// its comment ("a, -- note"), never into the comment ("a -- note,": `a b`, an alias, to the parser).
void append_item_comma(string& item) {
  size_t end = item.size();
  while (true) {
    const size_t nl = end == 0 ? string::npos : item.rfind('\n', end - 1);
    const size_t start = nl == string::npos ? 0 : nl + 1;
    const string_view line = string_view(item).substr(start, end - start);
    auto [code, comment] = split_inline_comment(line);
    if (comment.empty()) {
      if (end == item.size()) item += ',';
      else item.insert(start + rtrim_spaces(line).size(), 1, ',');
      return;
    }
    if (!trim_ascii_spaces(code).empty()) {
      item.replace(start, end - start, code + ", " + comment);
      return;
    }
    // A line that is only a comment: the comma goes on the code line above it.
    if (nl == string::npos) {
      item += ',';
      return;
    }
    end = nl;
  }
}

// The text of every `--` and `#` comment of `s`, in order, its spaces collapsed. Formatting may move
// a comment and respace it, but must keep each one whole: a comma pulled into a comment, or comment
// text pulled out into code, changes the query.
vector<string> line_comment_texts(string_view s) {
  vector<string> out;
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st)) {
      const char c = s[i];
      const char n = (i + 1 < s.size()) ? s[i + 1] : '\0';
      if ((c == '-' && n == '-') || c == '#') {
        const size_t body = i + (c == '#' ? 1 : 2);
        size_t end = s.find('\n', body);
        if (end == string_view::npos) end = s.size();
        string text;
        for (const char ch : s.substr(body, end - body)) {
          if (ch == ' ' || ch == '\t' || ch == '\r') {
            if (!text.empty() && text.back() != ' ') text += ' ';
          } else {
            text += ch;
          }
        }
        while (!text.empty() && text.back() == ' ') text.pop_back();
        out.push_back(std::move(text));
        i = end == 0 ? 0 : end - 1;
        continue;
      }
    }
    step_scan(st, s, i);
  }
  return out;
}

int find_top_level_operator(string_view s, char op) {
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st) && s[i] == op) return static_cast<int>(i);
    step_scan(st, s, i);
  }
  return -1;
}

std::pair<string, string> split_leading_line_comment(string_view s) {
  const string text = trim_ascii_spaces(s);
  if (!starts_with_ci(text, "--") && !starts_with_ci(text, "#")) return {{}, trim_ascii_spaces(s)};
  const size_t nl = text.find('\n');
  if (nl == string::npos) return {text, {}};
  return {trim_ascii_spaces(text.substr(0, nl)), trim_ascii_spaces(text.substr(nl + 1))};
}

std::pair<string, string> split_top_level_as(string_view s) {
  int last = -1;
  ScanState st;
  for (size_t i = 0; i + 2 <= s.size(); ++i) {
    if (is_top_level(st) && iequals_ascii(s.substr(i, 2), "AS")) {
      const char prev = (i == 0) ? '\0' : s[i - 1];
      const char next = (i + 2 < s.size()) ? s[i + 2] : '\0';
      const bool prev_ok = prev == '\0' || std::isspace(static_cast<unsigned char>(prev)) || prev == ')' || prev == ']' || prev == '`';
      // `AS` must be a whole word: the `as` prefix of an alias such as
      // `ascii_label` is not the keyword (it used to split `x AS ascii_label`
      // into `x AS` / `cii_label`).
      const bool next_ok = next == '\0' || std::isspace(static_cast<unsigned char>(next)) || next == '`' || next == '"';
      const bool prev_word = prev != '\0' && is_ident_char(prev);
      if (prev_ok && next_ok && !prev_word) last = static_cast<int>(i);
    }
    step_scan(st, s, i);
  }
  if (last < 0) return {trim_ascii_spaces(s), {}};
  return {trim_ascii_spaces(s.substr(0, static_cast<size_t>(last))), trim_ascii_spaces(s.substr(static_cast<size_t>(last) + 2))};
}

string format_alias_identifier(string_view alias) {
  const string trimmed = trim_ascii_spaces(alias);
  if (trimmed.empty()) return {};
  // `AS z -- note` at the end of a projection: the comment follows the alias,
  // it must never be quoted into the identifier.
  if (auto [code, comment] = split_inline_comment(trimmed); !comment.empty() && !trim_ascii_spaces(code).empty()) {
    return format_alias_identifier(code) + " " + comment;
  }
  // The same for a trailing block comment: `AS traces /* distinct */`.
  {
    ScanState st;
    for (size_t i = 0; i + 1 < trimmed.size(); ++i) {
      if (st.in_code() &&
          trimmed[i] == '/' && trimmed[i + 1] == '*') {
        const string code = trim_ascii_spaces(string_view(trimmed).substr(0, i));
        if (!code.empty()) return format_alias_identifier(code) + " " + trimmed.substr(i);
        break;
      }
      step_scan(st, trimmed, i);
    }
  }
  string normalized = trimmed;
  if (normalized.size() >= 2) {
    const char first = normalized.front();
    const char last = normalized.back();
    if ((first == '`' && last == '`') || (first == '"' && last == '"')) {
      normalized = normalized.substr(1, normalized.size() - 2);
    }
  }
  string quoted;
  quoted.reserve(normalized.size() + 2);
  quoted.push_back('`');
  for (char ch : normalized) {
    if (ch == '`') quoted += "``";
    else quoted.push_back(ch);
  }
  quoted.push_back('`');
  return quoted;
}

bool query_returns_table_like_cte(string_view query) {
  string text = trim_ascii_spaces(query);
  if (!looks_like_query(text)) return false;
  if (find_top_level_keyword(text, "GROUP BY") >= 0) return true;
  if (find_top_level_keyword(text, "UNION ALL") >= 0) return true;
  int select_pos = find_top_level_keyword(text, "SELECT");
  if (select_pos < 0) return false;
  int from_pos = find_top_level_keyword(text, "FROM", static_cast<size_t>(select_pos) + 6);
  if (from_pos < 0) return false;
  string select_body = trim_ascii_spaces(text.substr(static_cast<size_t>(select_pos) + 6, static_cast<size_t>(from_pos - select_pos) - 6));
  return split_top_level(select_body, ',').size() > 1;
}

}  // namespace fmt
}  // namespace chdash
