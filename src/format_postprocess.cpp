#include "format_postprocess.hpp"

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {
namespace {

using std::size_t;
using std::string;
using std::string_view;
using std::vector;

char lower_ascii(char ch) {
  if (ch >= 'A' && ch <= 'Z') return static_cast<char>(ch - 'A' + 'a');
  return ch;
}

bool iequals_ascii(string_view a, string_view b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    if (lower_ascii(a[i]) != lower_ascii(b[i])) return false;
  }
  return true;
}

bool starts_with_ci(string_view s, string_view prefix) {
  return s.size() >= prefix.size() && iequals_ascii(s.substr(0, prefix.size()), prefix);
}

bool ends_with_ci(string_view s, string_view suffix) {
  return s.size() >= suffix.size() && iequals_ascii(s.substr(s.size() - suffix.size()), suffix);
}

bool is_ident_char(char ch) {
  return std::isalnum(static_cast<unsigned char>(ch)) || ch == '_' || ch == '$';
}

string trim_ascii_spaces(string_view sv) {
  size_t a = 0;
  size_t b = sv.size();
  while (a < b && (sv[a] == ' ' || sv[a] == '\t' || sv[a] == '\n' || sv[a] == '\r')) ++a;
  while (b > a && (sv[b - 1] == ' ' || sv[b - 1] == '\t' || sv[b - 1] == '\n' || sv[b - 1] == '\r')) --b;
  return string(sv.substr(a, b - a));
}

string rtrim_spaces(string_view sv) {
  size_t b = sv.size();
  while (b > 0 && (sv[b - 1] == ' ' || sv[b - 1] == '\t' || sv[b - 1] == '\r')) --b;
  return string(sv.substr(0, b));
}

string collapse_whitespace(string_view sv) {
  string out;
  bool pending = false;
  for (char ch : sv) {
    if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
      pending = !out.empty();
      continue;
    }
    if (pending) out.push_back(' ');
    out.push_back(ch);
    pending = false;
  }
  return out;
}

string normalize_newlines(string_view s) {
  string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '\r') {
      if (i + 1 < s.size() && s[i + 1] == '\n') ++i;
      out.push_back('\n');
      continue;
    }
    out.push_back(s[i]);
  }
  return out;
}



string indent_block(string_view s, int spaces) {
  const string pad(static_cast<size_t>(spaces), ' ');
  string out;
  bool line_start = true;
  for (char ch : s) {
    if (line_start && ch != '\n') out += pad;
    out.push_back(ch);
    line_start = (ch == '\n');
  }
  return out;
}

string join_lines(const vector<string>& lines) {
  string out;
  for (size_t i = 0; i < lines.size(); ++i) {
    if (i) out.push_back('\n');
    out += lines[i];
  }
  return out;
}

size_t last_line_length(string_view s) {
  const size_t pos = s.rfind('\n');
  return (pos == string_view::npos) ? s.size() : (s.size() - pos - 1);
}

string prefix_first_line(string s, string_view prefix) {
  const size_t pos = s.find('\n');
  if (pos == string::npos) return string(prefix) + s;
  return string(prefix) + s.substr(0, pos) + s.substr(pos);
}

string indent_after_first_line(string_view s, size_t spaces) {
  const size_t pos = s.find('\n');
  if (pos == string_view::npos) return string(s);
  return string(s.substr(0, pos + 1)) + indent_block(s.substr(pos + 1), spaces);
}

string dedent_multiline_item(string_view s) {
  if (s.find('\n') == string_view::npos) return string(s);

  vector<string> lines;
  size_t start = 0;
  while (start <= s.size()) {
    const size_t nl = s.find('\n', start);
    const size_t end = (nl == string::npos) ? s.size() : nl;
    lines.push_back(string(s.substr(start, end - start)));
    if (nl == string::npos) break;
    start = nl + 1;
  }

  size_t min_indent = static_cast<size_t>(-1);
  for (size_t i = 1; i < lines.size(); ++i) {
    const string& line = lines[i];
    if (trim_ascii_spaces(line).empty()) continue;
    size_t indent = 0;
    while (indent < line.size() && line[indent] == ' ') ++indent;
    min_indent = std::min(min_indent, indent);
  }

  if (min_indent == static_cast<size_t>(-1) || min_indent == 0) return join_lines(lines);

  for (size_t i = 1; i < lines.size(); ++i) {
    size_t cut = 0;
    while (cut < min_indent && cut < lines[i].size() && lines[i][cut] == ' ') ++cut;
    lines[i].erase(0, cut);
  }

  return join_lines(lines);
}

struct ScanState {
  bool in_str = false;
  bool in_backtick = false;
  bool in_line_comment = false;
  bool in_block_comment = false;
  bool esc = false;
  int par = 0;
  int br = 0;
  int brc = 0;
};

bool is_top_level(const ScanState& st) {
  return !st.in_str && !st.in_backtick && !st.in_line_comment && !st.in_block_comment && st.par == 0 && st.br == 0 && st.brc == 0;
}

void step_scan(ScanState& st, string_view s, size_t& i) {
  const char c = s[i];
  const char n = (i + 1 < s.size()) ? s[i + 1] : '\0';
  if (st.in_str) {
    if (st.esc) st.esc = false;
    else if (c == '\\') st.esc = true;
    else if (c == '\'') st.in_str = false;
    return;
  }
  if (st.in_backtick) {
    if (c == '`') st.in_backtick = false;
    return;
  }
  if (st.in_line_comment) {
    if (c == '\n') st.in_line_comment = false;
    return;
  }
  if (st.in_block_comment) {
    if (c == '*' && n == '/') {
      st.in_block_comment = false;
      ++i;
    }
    return;
  }

  if (c == '\'') {
    st.in_str = true;
    st.esc = false;
    return;
  }
  if (c == '`') {
    st.in_backtick = true;
    return;
  }
  if (c == '-' && n == '-') {
    st.in_line_comment = true;
    ++i;
    return;
  }
  if (c == '#') {
    st.in_line_comment = true;
    return;
  }
  if (c == '/' && n == '*') {
    st.in_block_comment = true;
    ++i;
    return;
  }

  if (c == '(') ++st.par;
  else if (c == ')' && st.par > 0) --st.par;
  else if (c == '[') ++st.br;
  else if (c == ']' && st.br > 0) --st.br;
  else if (c == '{') ++st.brc;
  else if (c == '}' && st.brc > 0) --st.brc;
}

size_t find_matching_paren(string_view s, size_t open_pos) {
  if (open_pos >= s.size() || s[open_pos] != '(') return string::npos;
  ScanState st;
  st.par = 1;
  for (size_t i = open_pos + 1; i < s.size(); ++i) {
    if (!st.in_str && !st.in_backtick && !st.in_line_comment && !st.in_block_comment) {
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

int find_top_level_keyword(string_view s, string_view kw, size_t start = 0) {
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (i >= start && is_top_level(st) && i + kw.size() <= s.size() && iequals_ascii(s.substr(i, kw.size()), kw)) {
      const char prev = (i == 0) ? '\0' : s[i - 1];
      const char next = (i + kw.size() < s.size()) ? s[i + kw.size()] : '\0';
      if ((prev == '\0' || !is_ident_char(prev)) && (next == '\0' || !is_ident_char(next))) return static_cast<int>(i);
    }
    step_scan(st, s, i);
  }
  return -1;
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
  for (size_t i = 0; i < s.size(); ++i) {
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
    if (!st.in_str && !st.in_backtick && !st.in_line_comment && !st.in_block_comment) {
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

bool contains_heavy_structure(string_view s) {
  const string text = trim_ascii_spaces(s);
  if (looks_like_query(text)) return true;
  static const char* needles[] = {
      "->", "SELECT", "exists(", "OVER (", "arrayZip(", "map(", "dictGet(",
      "dictGetOrDefault(", "JSONExtract", "multiIf(", "arrayMap(", "arrayFilter(", "arrayExists(",
      "arrayAll(", "arrayCount("};
  for (const char* needle : needles) {
    if (text.find(needle) != string::npos) return true;
  }
  return text.find('[') != string::npos || text.find('{') != string::npos;
}


int find_top_level_comparator(string_view s, string* op) {
  static const char* ops[] = {">=", "<=", "!=", "<>", "=", ">", "<"};
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
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st) && i + 2 <= s.size() && iequals_ascii(s.substr(i, 2), "AS")) {
      const char prev = (i == 0) ? '\0' : s[i - 1];
      const char next = (i + 2 < s.size()) ? s[i + 2] : '\0';
      if ((prev == '\0' || std::isspace(static_cast<unsigned char>(prev))) && (next == '\0' || std::isspace(static_cast<unsigned char>(next)))) last = static_cast<int>(i);
    }
    step_scan(st, s, i);
  }
  if (last < 0) return {trim_ascii_spaces(s), {}};
  return {trim_ascii_spaces(s.substr(0, static_cast<size_t>(last))), trim_ascii_spaces(s.substr(static_cast<size_t>(last) + 2))};
}

static string format_alias_identifier(string_view alias) {
  const string trimmed = trim_ascii_spaces(alias);
  if (trimmed.empty()) return {};
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

struct Formatter {
  explicit Formatter(size_t threshold_) : threshold(threshold_) {}

  size_t threshold;

  string format(string_view s);
  string format_statement(string_view s);
  string format_select_like(string_view s);
  string format_clause(string_view kw, string_view body);
  string format_from_clause(string_view body);
  string format_table_source(string_view s);
  string format_parenthesized_query(string_view s);
  string format_with_item_block(const vector<string>& items);
  string format_item_block(const vector<string>& items, bool align_alias);
  string format_simple_item_block(const vector<string>& items);
  string format_expression(string_view expr);
  string format_over_clause(string_view expr);
  string format_function_call(string_view expr);
  string format_array_literal(string_view expr);
  string format_bool_expr(string_view expr);
  string format_bool_term(string_view expr, bool in_and_chain);
  string format_exists_subquery(string_view expr);
  string format_in_subquery(string_view expr, bool break_after_in);
  string format_in_literal(string_view expr);
  string format_create_table(string_view s);
  string format_create_view(string_view s, bool materialized);
  string format_alter_table(string_view s);
  string format_insert_select_like(string_view s);
  string format_delete(string_view s);
  string try_format_insert_values(string_view s);
  string cleanup_surface(string_view s) const;
  string take_leading_comments(string_view s, string* leading) const;
  string join_with_keyword(const vector<string>& parts, string_view kw) const;
  string join_bool_parts(const vector<string>& parts, string_view kw) const;
  string strip_atomic_parentheses(string s) const;
  string strip_lambda_parentheses(string s) const;
  vector<std::pair<string, string>> split_joins(string_view s) const;
};

string Formatter::cleanup_surface(string_view s) const {
  vector<string> lines;
  size_t start = 0;
  while (start <= s.size()) {
    const size_t nl = s.find('\n', start);
    const size_t end = (nl == string_view::npos) ? s.size() : nl;
    auto [code, comment] = split_inline_comment(s.substr(start, end - start));
    lines.push_back(comment.empty() ? code : (code.empty() ? comment : code + ' ' + comment));
    if (nl == string_view::npos) break;
    start = nl + 1;
  }
  return join_lines(lines);
}

string Formatter::take_leading_comments(string_view s, string* leading) const {
  string out;
  size_t pos = 0;
  while (pos < s.size()) {
    while (pos < s.size() && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\n' || s[pos] == '\r')) ++pos;
    if (pos >= s.size()) break;
    if (pos + 1 < s.size() && s[pos] == '/' && s[pos + 1] == '*') {
      const size_t end = s.find("*/", pos + 2);
      if (end == string_view::npos) break;
      string block = string(s.substr(pos, end + 2 - pos));
      vector<string> lines;
      size_t start = 0;
      while (start <= block.size()) {
        const size_t nl = block.find('\n', start);
        const size_t stop = (nl == string::npos) ? block.size() : nl;
        lines.push_back(string(block.substr(start, stop - start)));
        if (nl == string::npos) break;
        start = nl + 1;
      }
      if (lines.size() >= 2) {
        const string tail_trim = trim_ascii_spaces(lines.back());
        if (tail_trim == "*/") {
          const size_t dedent = lines.back().size() - tail_trim.size();
          if (dedent > 0) {
            for (size_t i = 1; i < lines.size(); ++i) {
              size_t cut = 0;
              while (cut < dedent && cut < lines[i].size() && lines[i][cut] == ' ') ++cut;
              lines[i].erase(0, cut);
            }
          }
          for (size_t i = 1; i + 1 < lines.size(); ++i) {
            const string mid = trim_ascii_spaces(lines[i]);
            if (!mid.empty()) lines[i] = string(4, ' ') + mid;
          }
          lines.back() = tail_trim;
          block = join_lines(lines);
        }
      }
      if (!out.empty()) out += '\n';
      out += block;
      pos = end + 2;
      continue;
    }
    if ((pos + 1 < s.size() && s[pos] == '-' && s[pos + 1] == '-') || s[pos] == '#') {
      const size_t end = s.find('\n', pos);
      if (!out.empty()) out += '\n';
      out += string(s.substr(pos, end == string_view::npos ? s.size() - pos : end - pos));
      pos = (end == string_view::npos) ? s.size() : end + 1;
      continue;
    }
    break;
  }
  if (leading) *leading = out;
  return trim_ascii_spaces(s.substr(pos));
}

string Formatter::format(string_view s) {
  string text = trim_ascii_spaces(normalize_newlines(s));
  if (text.empty()) return text;
  if (auto values = try_format_insert_values(text); !values.empty()) return values;
  string leading;
  text = take_leading_comments(text, &leading);
  string out = format_statement(text);
  if (!leading.empty()) out = leading + "\n" + out;
  return cleanup_surface(out);
}

string Formatter::format_statement(string_view s) {
  string text = trim_ascii_spaces(s);
  if (text.empty()) return {};
  string leading;
  text = take_leading_comments(text, &leading);
  if (text.empty()) return leading;
  string out;
  if (starts_with_ci(text, "EXPLAIN SYNTAX")) {
    const int pos = find_top_level_keyword(text, "SELECT");
    out = pos < 0 ? cleanup_surface(text) : string("EXPLAIN SYNTAX\n") + format_statement(text.substr(static_cast<size_t>(pos)));
  } else if (starts_with_ci(text, "WITH") || starts_with_ci(text, "SELECT")) out = format_select_like(text);
  else if (starts_with_ci(text, "CREATE TABLE")) out = format_create_table(text);
  else if (starts_with_ci(text, "CREATE MATERIALIZED VIEW")) out = format_create_view(text, true);
  else if (starts_with_ci(text, "CREATE VIEW")) out = format_create_view(text, false);
  else if (starts_with_ci(text, "ALTER TABLE")) out = format_alter_table(text);
  else if (starts_with_ci(text, "INSERT INTO")) out = format_insert_select_like(text);
  else if (starts_with_ci(text, "DELETE FROM")) out = format_delete(text);
  else out = cleanup_surface(text);
  if (!leading.empty()) out = leading + "\n" + out;
  return out;
}

string Formatter::join_with_keyword(const vector<string>& parts, string_view kw) const {
  string out;
  for (size_t i = 0; i < parts.size(); ++i) {
    if (!i) {
      out += parts[i];
      continue;
    }
    out += "\n" + string(kw) + "\n" + parts[i];
  }
  return out;
}

string Formatter::join_bool_parts(const vector<string>& parts, string_view kw) const {
  string out;
  for (size_t i = 0; i < parts.size(); ++i) {
    if (!i) {
      out += parts[i];
      continue;
    }
    out += "\n" + prefix_first_line(parts[i], string(kw) + " ");
  }
  return out;
}

string Formatter::format_select_like(string_view s) {
  string text = trim_ascii_spaces(s);
  if (auto parts = split_top_level_keyword(text, "UNION ALL"); !parts.empty()) {
    vector<string> rendered;
    for (const auto& part : parts) rendered.push_back(format_select_like(part));
    return join_with_keyword(rendered, "UNION ALL");
  }

  string out;
  if (starts_with_ci(text, "WITH")) {
    const int pos = find_top_level_keyword(text, "SELECT", 4);
    if (pos > 0) {
      const string with_body = trim_ascii_spaces(text.substr(4, static_cast<size_t>(pos) - 4));
      out += "WITH\n" + indent_block(format_with_item_block(split_top_level(with_body, ',')), 4) + "\n";
      text = trim_ascii_spaces(text.substr(static_cast<size_t>(pos)));
    }
  }

  static const char* clauses[] = {"FROM", "SAMPLE", "PREWHERE", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT BY", "LIMIT", "SETTINGS"};
  vector<std::pair<int, string>> poses;
  for (const char* kw : clauses) {
    const int pos = find_top_level_keyword(text, kw, 6);
    if (pos >= 0) poses.push_back({pos, kw});
  }
  std::sort(poses.begin(), poses.end(), [](const auto& a, const auto& b) { return a.first < b.first; });

  const size_t select_end = poses.empty() ? text.size() : static_cast<size_t>(poses.front().first);
  const string select_body = trim_ascii_spaces(text.substr(6, select_end - 6));
  const auto items = split_top_level(select_body, ',');
  if (items.size() == 1 && select_body.find('\n') == string::npos && select_body.size() <= threshold && !contains_heavy_structure(items.front())) {
    out += "SELECT " + format_expression(items.front());
  } else {
    out += "SELECT\n" + indent_block(format_item_block(items, true), 4);
  }

  for (size_t i = 0; i < poses.size(); ++i) {
    const size_t start = static_cast<size_t>(poses[i].first);
    const string kw = poses[i].second;
    const size_t body_start = start + kw.size();
    const size_t end = (i + 1 < poses.size()) ? static_cast<size_t>(poses[i + 1].first) : text.size();
    out += "\n" + format_clause(kw, trim_ascii_spaces(text.substr(body_start, end - body_start)));
  }
  return out;
}

string normalize_boolean_lines(string_view s) {
  vector<string> lines;
  size_t start = 0;
  while (start <= s.size()) {
    const size_t nl = s.find('\n', start);
    const size_t end = (nl == string::npos) ? s.size() : nl;
    string line = trim_ascii_spaces(s.substr(start, end - start));
    auto [code, comment] = split_inline_comment(line);
    string prefix;
    string rest = code;
    if (starts_with_ci(rest, "AND ") || starts_with_ci(rest, "OR ")) {
      const size_t cut = starts_with_ci(rest, "AND ") ? 4 : 3;
      prefix = rest.substr(0, cut);
      rest = trim_ascii_spaces(rest.substr(cut));
    }
    if (const string inner = unwrap_outer_parens(rest); !inner.empty() && find_top_level_keyword(inner, "AND") < 0 && find_top_level_keyword(inner, "OR") < 0) rest = trim_ascii_spaces(inner);
    line = trim_ascii_spaces(prefix + rest);
    if (!comment.empty()) line += " " + comment;
    lines.push_back(line);
    if (nl == string::npos) break;
    start = nl + 1;
  }
  return join_lines(lines);
}

string Formatter::format_clause(string_view kw, string_view body) {
  if (iequals_ascii(kw, "FROM")) return format_from_clause(body);
  if (iequals_ascii(kw, "WHERE") || iequals_ascii(kw, "PREWHERE") || iequals_ascii(kw, "HAVING")) {
    const string cond = format_bool_expr(body);
    const bool has_bool_ops = find_top_level_keyword(body, "AND") >= 0 || find_top_level_keyword(body, "OR") >= 0;
    if (!has_bool_ops) {
      if (cond.find('\n') == string::npos) return string(kw) + " " + cond;
      if (cond.find(" IN (\n") != string::npos || cond.find(" GLOBAL IN (\n") != string::npos) return string(kw) + " " + cond;
      if (starts_with_ci(cond, "exists(\n")) return string(kw) + " " + indent_after_first_line(cond, 4);
      return string(kw) + " " + indent_after_first_line(cond, 4);
    }
    string rendered = cond;
    if (body.find("--") != string::npos || body.find('#') != string::npos) {
      const string inner = unwrap_outer_parens(rendered);
      if (!inner.empty() && inner.find('\n') != string::npos) rendered = "(\n" + indent_block(normalize_boolean_lines(inner), 4) + "\n)";
    }
    return string(kw) + "\n" + indent_block(rendered, 4);
  }
  if (iequals_ascii(kw, "GROUP BY") || iequals_ascii(kw, "ORDER BY")) {
    string base = trim_ascii_spaces(body);
    string suffix;
    if (iequals_ascii(kw, "GROUP BY")) {
      static const char* suffixes[] = {"WITH ROLLUP", "WITH CUBE", "WITH TOTALS"};
      for (const char* raw : suffixes) {
        const string_view suf(raw);
        if (ends_with_ci(base, suf)) {
          suffix = string(raw);
          base = rtrim_spaces(base.substr(0, base.size() - suf.size()));
          break;
        }
      }
    }
    const auto items = split_top_level(base, ',');
    if (items.size() == 1 && trim_ascii_spaces(base).find('\n') == string::npos) {
      string line = string(kw) + " " + format_expression(items.front());
      if (!suffix.empty()) line += " " + suffix;
      return line;
    }
    string block = format_simple_item_block(items);
    if (!suffix.empty()) block += " " + suffix;
    return string(kw) + "\n" + indent_block(block, 4);
  }
  return string(kw) + " " + cleanup_surface(body);
}

vector<std::pair<string, string>> Formatter::split_joins(string_view s) const {
  static const char* join_kws[] = {"LEFT ARRAY JOIN", "ARRAY JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "CROSS JOIN", "JOIN"};
  vector<std::pair<string, string>> parts;
  size_t start = 0;
  bool found = false;
  string last_kw;
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (is_top_level(st)) {
      for (const char* raw_kw : join_kws) {
        const string_view kw(raw_kw);
        if (i + kw.size() <= s.size() && iequals_ascii(s.substr(i, kw.size()), kw)) {
          const char prev = (i == 0) ? '\0' : s[i - 1];
          const char next = (i + kw.size() < s.size()) ? s[i + kw.size()] : '\0';
          if ((prev == '\0' || std::isspace(static_cast<unsigned char>(prev))) && (next == '\0' || std::isspace(static_cast<unsigned char>(next)))) {
            parts.push_back({trim_ascii_spaces(s.substr(start, i - start)), last_kw});
            last_kw = string(kw);
            start = i + kw.size();
            i += kw.size() - 1;
            found = true;
            goto matched;
          }
        }
      }
    }
    step_scan(st, s, i);
matched:
    continue;
  }
  if (!found) return {};
  parts.push_back({trim_ascii_spaces(s.substr(start)), last_kw});
  if (!parts.empty() && parts.front().second.empty()) return parts;
  return {};
}

string Formatter::format_from_clause(string_view body) {
  const string s = trim_ascii_spaces(body);
  if (auto joins = split_joins(s); !joins.empty()) {
    string out = "FROM " + format_table_source(joins.front().first);
    for (size_t i = 1; i < joins.size(); ++i) {
      const string& join_kw = joins[i].second;
      const string segment = joins[i].first;
      const int on_pos = find_top_level_keyword(segment, "ON");
      const int using_pos = find_top_level_keyword(segment, "USING");
      if (on_pos >= 0 && (using_pos < 0 || on_pos < using_pos)) {
        const string target = trim_ascii_spaces(segment.substr(0, static_cast<size_t>(on_pos)));
        const string cond = trim_ascii_spaces(segment.substr(static_cast<size_t>(on_pos) + 2));
        const string formatted_target = format_table_source(target);
        out += formatted_target.find('\n') == string::npos ? "\n" + join_kw + " " + formatted_target : "\n" + join_kw + "\n" + formatted_target;
        out += "\n" + indent_block(prefix_first_line(format_bool_expr(cond), "ON "), 4);
      } else if (using_pos >= 0) {
        const string target = trim_ascii_spaces(segment.substr(0, static_cast<size_t>(using_pos)));
        string using_body = trim_ascii_spaces(segment.substr(static_cast<size_t>(using_pos) + 5));
        if (const string inner = unwrap_outer_parens(using_body); !inner.empty() && split_top_level(inner, ',').size() == 1) using_body = trim_ascii_spaces(inner);
        const string formatted_target = format_table_source(target);
        out += formatted_target.find('\n') == string::npos ? "\n" + join_kw + " " + formatted_target : "\n" + join_kw + "\n" + formatted_target;
        out += " USING " + using_body;
      } else {
        const string formatted_target = format_table_source(segment);
        out += formatted_target.find('\n') == string::npos ? "\n" + join_kw + " " + formatted_target : "\n" + join_kw + "\n" + formatted_target;
      }
    }
    return out;
  }
  const string src = format_table_source(s);
  return src.find('\n') == string::npos ? string("FROM ") + src : string("FROM\n") + src;
}

string Formatter::format_table_source(string_view s) {
  const string text = trim_ascii_spaces(s);
  if (auto nested = format_parenthesized_query(text); !nested.empty()) return nested;
  return collapse_whitespace(cleanup_surface(text));
}

string Formatter::format_parenthesized_query(string_view s) {
  const string text = trim_ascii_spaces(s);
  const int as_pos = find_top_level_keyword(text, "AS");
  const string base = (as_pos > 0) ? trim_ascii_spaces(text.substr(0, static_cast<size_t>(as_pos))) : text;
  const string alias = (as_pos > 0) ? trim_ascii_spaces(text.substr(static_cast<size_t>(as_pos) + 2)) : string();
  const string inner = unwrap_outer_parens(base);
  if (inner.empty() || !looks_like_query(inner)) return {};
  string out = "(\n" + indent_block(format_statement(inner), 4) + "\n)";
  if (!alias.empty()) out += " AS " + format_alias_identifier(alias);
  return out;
}

string Formatter::format_with_item_block(const vector<string>& items) {
  struct WithItem {
    string expr;
    string alias;
    string query;
    bool scalar_query = false;
    bool named_query = false;
  };

  vector<WithItem> parsed;
  size_t width = 0;
  size_t min_width = static_cast<size_t>(-1);
  size_t aliased_count = 0;
  bool can_align = true;

  for (const auto& raw : items) {
    auto [lhs, rhs] = split_top_level_as(raw);
    const string lhs_trim = trim_ascii_spaces(lhs);
    const string rhs_trim = trim_ascii_spaces(rhs);
    const string lhs_inner = unwrap_outer_parens(lhs_trim);
    const string rhs_inner = unwrap_outer_parens(rhs_trim);

    if (!rhs_trim.empty() && !lhs_inner.empty() && looks_like_query(lhs_inner)) {
      parsed.push_back({{}, rhs_trim, lhs_inner, true, false});
      can_align = false;
      continue;
    }

    if (!rhs_trim.empty() && !rhs_inner.empty() && looks_like_query(rhs_inner)) {
      parsed.push_back({lhs_trim, {}, rhs_inner, false, true});
      can_align = false;
      continue;
    }

    string expr = format_expression(lhs);
    if (!rhs_trim.empty()) {
      ++aliased_count;
      const size_t line_width = last_line_length(expr);
      width = std::max(width, line_width);
      min_width = std::min(min_width, line_width);
      if (contains_top_level_comment(expr)) can_align = false;
      const string expr_trim = trim_ascii_spaces(expr);
      if (expr.find('\n') != string::npos && !expr_trim.empty() && expr_trim.front() == '(') can_align = false;
    }
    parsed.push_back({std::move(expr), rhs_trim, {}, false, false});
  }

  can_align = can_align && aliased_count >= 2 && width > min_width;

  vector<string> lines;
  for (size_t i = 0; i < parsed.size(); ++i) {
    string item;
    if (parsed[i].scalar_query) {
      string rendered = format_statement(parsed[i].query);
      if (items.size() == 1 && starts_with_ci(rendered, "SELECT ") && rendered.find('\n') != string::npos) {
        rendered = expand_nested_select_head(rendered);
      }
      const string scalar_alias = format_alias_identifier(parsed[i].alias);
      item = "(\n" + indent_block(rendered, 4) + "\n) AS " + scalar_alias;
    } else if (parsed[i].named_query) {
      item = parsed[i].expr + " AS\n(\n" + indent_block(format_statement(parsed[i].query), 4) + "\n)";
    } else {
      item = parsed[i].expr;
      if (!parsed[i].alias.empty()) {
        const string alias = format_alias_identifier(parsed[i].alias);
        if (can_align) {
          const size_t gap = (width > last_line_length(item) ? width - last_line_length(item) : 0);
          size_t extra = (width <= 40) ? 4 : 1;
          if (width > 80 && gap > 0) ++extra;
          item += string(gap + extra, ' ') + "AS " + alias;
        } else {
          item += " AS " + alias;
        }
      }
    }
    if (i + 1 < parsed.size()) item += ',';
    lines.push_back(item);
  }
  return join_lines(lines);
}

string Formatter::format_item_block(const vector<string>& items, bool align_alias) {
  vector<std::pair<string, string>> parsed;
  size_t width = 0;
  size_t min_width = static_cast<size_t>(-1);
  size_t aliased_count = 0;
  bool can_align = align_alias;
  for (const auto& raw : items) {
    auto [expr, alias] = split_top_level_as(raw);
    expr = format_expression(expr);
    if (!alias.empty()) {
      ++aliased_count;
      const size_t line_width = last_line_length(expr);
      width = std::max(width, line_width);
      min_width = std::min(min_width, line_width);
    }
    parsed.push_back({std::move(expr), std::move(alias)});
  }
  can_align = can_align && aliased_count >= 2 && width > min_width;
  vector<string> lines;
  for (size_t i = 0; i < parsed.size(); ++i) {
    string item = parsed[i].first;
    if (!parsed[i].second.empty()) {
      const string alias = format_alias_identifier(parsed[i].second);
      if (can_align) item += string((width > last_line_length(item) ? width - last_line_length(item) : 0) + 2, ' ') + "AS " + alias;
      else {
        item += " AS " + alias;
      }
    }
    item = dedent_multiline_item(item);
    if (i + 1 < parsed.size()) item += ',';
    const size_t nl = item.find('\n');
    if (!lines.empty() && starts_with_ci(trim_ascii_spaces(item), "--") && nl != string::npos && !lines.back().empty() && lines.back().back() == ',') {
      lines.back() += " " + trim_ascii_spaces(item.substr(0, nl));
      lines.push_back(trim_ascii_spaces(item.substr(nl + 1)));
      continue;
    }
    lines.push_back(item);
  }
  return join_lines(lines);
}

string Formatter::format_simple_item_block(const vector<string>& items) {
  vector<string> lines;
  for (size_t i = 0; i < items.size(); ++i) {
    string item = format_expression(items[i]);
    if (i + 1 < items.size()) item += ',';
    lines.push_back(item);
  }
  return join_lines(lines);
}

string Formatter::strip_atomic_parentheses(string s) const {
  while (true) {
    const string inner = unwrap_outer_parens(s);
    if (inner.empty() || looks_like_query(inner) || find_top_level_keyword(inner, "AND") >= 0 || find_top_level_keyword(inner, "OR") >= 0 || split_top_level(inner, ',').size() > 1) break;
    if (find_top_level_operator(inner, '+') >= 0 || find_top_level_operator(inner, '-') >= 0 ||
        find_top_level_operator(inner, '*') >= 0 || find_top_level_operator(inner, '/') >= 0) break;
    s = trim_ascii_spaces(inner);
  }
  return s;
}

string Formatter::strip_lambda_parentheses(string s) const {
  string out;
  for (size_t i = 0; i < s.size(); ++i) {
    if (i + 1 < s.size() && s[i] == '-' && s[i + 1] == '>') {
      out += "->";
      i += 2;
      while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) ++i;
      if (i < s.size() && s[i] == '(') {
        const size_t close = find_matching_paren(s, i);
        if (close != string::npos) {
          const string inner = trim_ascii_spaces(string_view(s).substr(i + 1, close - i - 1));
          if (!inner.empty() && !looks_like_query(inner) && find_top_level_keyword(inner, "AND") < 0 && find_top_level_keyword(inner, "OR") < 0) {
            out += " " + inner;
            i = close;
            continue;
          }
        }
      }
      out.push_back(' ');
      if (i < s.size()) out.push_back(s[i]);
      continue;
    }
    out.push_back(s[i]);
  }
  return out;
}

string Formatter::format_over_clause(string_view expr) {
  const string s = trim_ascii_spaces(expr);
  const int pos = find_top_level_keyword(s, "OVER");
  if (pos < 0) return {};
  const string head = rtrim_spaces(s.substr(0, static_cast<size_t>(pos)));
  const string inner = unwrap_outer_parens(trim_ascii_spaces(s.substr(static_cast<size_t>(pos) + 4)));
  if (inner.empty()) return {};

  const int part_pos = find_top_level_keyword(inner, "PARTITION BY");
  const int order_pos = find_top_level_keyword(inner, "ORDER BY");
  const int rows_pos = find_top_level_keyword(inner, "ROWS BETWEEN");
  if (part_pos < 0 && order_pos < 0 && rows_pos < 0) return {};

  vector<string> lines;
  bool multiline = inner.find('\n') != string::npos || part_pos >= 0 || rows_pos >= 0;

  if (part_pos >= 0) {
    const size_t end = (order_pos >= 0) ? static_cast<size_t>(order_pos) : ((rows_pos >= 0) ? static_cast<size_t>(rows_pos) : inner.size());
    const string body = trim_ascii_spaces(inner.substr(static_cast<size_t>(part_pos) + 12, end - static_cast<size_t>(part_pos) - 12));
    lines.push_back("PARTITION BY " + format_expression(body));
  }

  if (order_pos >= 0) {
    const size_t end = (rows_pos >= 0) ? static_cast<size_t>(rows_pos) : inner.size();
    const string body = trim_ascii_spaces(inner.substr(static_cast<size_t>(order_pos) + 8, end - static_cast<size_t>(order_pos) - 8));
    const auto items = split_top_level(body, ',');
    const bool multiline_order = body.find('\n') != string::npos || items.size() > 2 ||
                                 (part_pos >= 0 && items.size() > 1) ||
                                 (items.size() > 1 && body.size() > threshold / 2) ||
                                 (items.size() > 1 && head.size() > 20 && body.size() > 35);
    if (multiline_order) lines.push_back("ORDER BY\n" + indent_block(format_simple_item_block(items), 4));
    else lines.push_back("ORDER BY " + cleanup_surface(body));
  }

  if (rows_pos >= 0) {
    const string body = trim_ascii_spaces(inner.substr(static_cast<size_t>(rows_pos) + 12));
    lines.push_back("ROWS BETWEEN " + cleanup_surface(body));
  }

  if (!multiline) return {};
  return head + " OVER (\n" + indent_block(join_lines(lines), 4) + "\n)";
}

string Formatter::format_array_literal(string_view expr) {
  const string s = trim_ascii_spaces(expr);
  if (s.size() < 2 || s.front() != '[' || s.back() != ']') return {};
  const string inner = trim_ascii_spaces(s.substr(1, s.size() - 2));
  const auto items = split_top_level(inner, ',');
  const bool multiline = s.find('\n') != string::npos || s.size() > threshold || inner.find('(') != string::npos || inner.find('[') != string::npos || inner.find('{') != string::npos;
  if (items.size() <= 1 && !multiline) return {};
  if (!multiline) return {};
  vector<string> rendered;
  for (const auto& item : items) {
    const string trimmed = trim_ascii_spaces(item);
    const string tuple_inner = unwrap_outer_parens(trimmed);
    if (!tuple_inner.empty() && split_top_level(tuple_inner, ',').size() > 1 && (trimmed.find('\n') != string::npos || trimmed.size() > threshold / 2)) {
      const auto tuple_items = split_top_level(tuple_inner, ',');
      string tuple = "(\n";
      for (size_t j = 0; j < tuple_items.size(); ++j) {
        tuple += "    " + format_expression(tuple_items[j]);
        if (j + 1 < tuple_items.size()) tuple += ',';
        tuple += '\n';
      }
      tuple += ')';
      rendered.push_back(tuple);
      continue;
    }
    rendered.push_back(format_expression(item));
  }
  string out = "[\n";
  for (size_t i = 0; i < rendered.size(); ++i) {
    out += indent_block(rendered[i], 4);
    if (i + 1 < rendered.size()) out += ',';
    out += '\n';
  }
  out += ']';
  return out;
}

string Formatter::format_function_call(string_view expr) {
  const string s = trim_ascii_spaces(expr);
  const size_t par = s.find('(');
  if (par == string::npos || !ends_with_ci(s, ")")) return {};
  const string name = trim_ascii_spaces(s.substr(0, par));
  if (name.empty()) return {};
  for (char ch : name) if (!is_ident_char(ch)) return {};
  const string inner = unwrap_outer_parens(s.substr(par));
  if (inner.empty()) return {};
  const auto raw_args = split_top_level(inner, ',');
  const bool lambda_fn = iequals_ascii(name, "arrayMap") || iequals_ascii(name, "arrayFilter") || iequals_ascii(name, "arrayExists") ||
                         iequals_ascii(name, "arrayAll") || iequals_ascii(name, "arrayCount");

  vector<string> args;
  vector<string> comments_after;
  for (const auto& raw : raw_args) {
    auto [leading_comment, remainder] = split_leading_line_comment(raw);
    if (!leading_comment.empty() && remainder.empty()) {
      if (!comments_after.empty()) {
        if (!comments_after.back().empty()) comments_after.back() += " ";
        comments_after.back() += leading_comment;
      }
      continue;
    }
    if (!leading_comment.empty() && !comments_after.empty()) {
      if (!comments_after.back().empty()) comments_after.back() += " ";
      comments_after.back() += leading_comment;
    }
    string current = remainder.empty() ? trim_ascii_spaces(raw) : remainder;
    if (current.empty()) continue;
    args.push_back(current);
    comments_after.emplace_back();
  }
  if (args.empty()) return {};

  const size_t wrap_threshold = std::min<size_t>(threshold, 80);
  bool multiline = s.find('\n') != string::npos || iequals_ascii(name, "multiIf") || iequals_ascii(name, "map") ||
                   iequals_ascii(name, "dictGet") || iequals_ascii(name, "dictGetOrDefault") ||
                   iequals_ascii(name, "arrayZip") || looks_like_query(inner) || s.size() > wrap_threshold;
  if (!multiline && iequals_ascii(name, "arrayJoin") && !args.empty() && contains_heavy_structure(args.front())) multiline = true;
  if (!multiline && iequals_ascii(name, "mapContains") && !args.empty() && contains_heavy_structure(args.front())) multiline = true;
  if (!multiline && (iequals_ascii(name, "arrayMap") || iequals_ascii(name, "arrayFilter") || iequals_ascii(name, "arrayExists")) && args.size() >= 2 && contains_heavy_structure(args[1])) multiline = true;

  if (!multiline && lambda_fn && !args.empty()) {
    const int arrow = find_top_level_arrow(args.front());
    if (arrow > 0) {
      string rhs = trim_ascii_spaces(string_view(args.front()).substr(static_cast<size_t>(arrow) + 2));
      if (const string inner_rhs = unwrap_outer_parens(rhs); !inner_rhs.empty()) rhs = inner_rhs;
      if (rhs.find('\n') != string::npos || rhs.find('[') != string::npos || rhs.find('{') != string::npos ||
          rhs.find(" IN ") != string::npos || rhs.find("arrayMap(") != string::npos || rhs.find("arrayFilter(") != string::npos ||
          rhs.find("arrayExists(") != string::npos || rhs.find("arrayCount(") != string::npos ||
          rhs.find("arraySum(") != string::npos || rhs.find("JSONExtract") != string::npos ||
          find_top_level_keyword(rhs, "AND") >= 0 || find_top_level_keyword(rhs, "OR") >= 0) {
        multiline = true;
      }
    }
  }

  vector<string> rendered;
  rendered.reserve(args.size());
  for (size_t i = 0; i < args.size(); ++i) {
    if (iequals_ascii(name, "if") && i == 0) {
      string cond = format_bool_expr(args[i]);
      if (cond.find('\n') != string::npos) {
        string compact = collapse_whitespace(cond);
        if (compact.size() + 8 <= wrap_threshold) cond = compact;
      }
      rendered.push_back(cond);
    } else rendered.push_back(format_expression(args[i]));
  }

  if (args.size() == 1) {
    const int slash = find_top_level_operator(args.front(), '/');
    const string compact = name + "(" + rendered.front() + ")";
    const bool heavy_one = contains_heavy_structure(args.front()) || slash >= 0;
    if (slash > 0 && (multiline || compact.size() + 8 > wrap_threshold || args.front().find('\n') != string::npos || rendered.front().find('\n') != string::npos)) {
      const string lhs = trim_ascii_spaces(args.front().substr(0, static_cast<size_t>(slash)));
      const string rhs = trim_ascii_spaces(args.front().substr(static_cast<size_t>(slash) + 1));
      rendered.front() = format_expression(lhs) + "\n/ " + format_expression(rhs);
    }
    if (!multiline) multiline = rendered.front().find('\n') != string::npos || (compact.size() + 8 > wrap_threshold && heavy_one);
  }

  if (!multiline && args.size() <= 1 && !iequals_ascii(name, "arrayJoin")) return {};
  if (!multiline) return {};

  string out = name + "(\n";
  if (iequals_ascii(name, "multiIf") && rendered.size() >= 3) {
    for (size_t i = 0; i + 1 < rendered.size(); i += 2) {
      if (i + 1 == rendered.size() - 1) break;
      out += "    " + rendered[i] + ", " + rendered[i + 1] + ",\n";
    }
    out += "    " + rendered.back() + "\n)";
    return out;
  }
  if (iequals_ascii(name, "map") && rendered.size() >= 2) {
    for (size_t i = 0; i < rendered.size(); i += 2) {
      out += "    " + rendered[i];
      if (i + 1 < rendered.size()) out += ", " + rendered[i + 1];
      if (i + 2 < rendered.size()) out += ',';
      out += '\n';
    }
    out += ')';
    return out;
  }
  for (size_t i = 0; i < rendered.size(); ++i) {
    out += indent_block(rendered[i], 4);
    if (i + 1 < rendered.size()) out += ',';
    if (i < comments_after.size() && !comments_after[i].empty()) out += " " + comments_after[i];
    out += '\n';
  }
  out += ')';
  return out;
}

string Formatter::format_expression(string_view expr) {
  string s = trim_ascii_spaces(expr);
  if (s.empty()) return s;
  if (contains_top_level_comment(s)) return cleanup_surface(s);
  if (!s.empty() && s.front() == '(') {
    const size_t close = find_matching_paren(s, 0);
    if (close != string::npos && close + 1 < s.size() && s[close + 1] == '.') {
      const string inner = trim_ascii_spaces(s.substr(1, close - 1));
      if (!inner.empty() && !looks_like_query(inner) && find_top_level_keyword(inner, "AND") < 0 && find_top_level_keyword(inner, "OR") < 0) {
        return format_expression(inner) + trim_ascii_spaces(s.substr(close + 1));
      }
    }
  }
  if (auto q = format_parenthesized_query(s); !q.empty()) return q;
  if (const int arrow = find_top_level_arrow(s); arrow > 0) {
    const string lhs = cleanup_surface(trim_ascii_spaces(s.substr(0, static_cast<size_t>(arrow))));
    string rhs_src = trim_ascii_spaces(s.substr(static_cast<size_t>(arrow) + 2));
    const bool grouped_rhs = !unwrap_outer_parens(rhs_src).empty();
    if (const string inner_rhs = unwrap_outer_parens(rhs_src); !inner_rhs.empty() &&
        (find_top_level_keyword(inner_rhs, "AND") >= 0 || find_top_level_keyword(inner_rhs, "OR") >= 0)) {
      rhs_src = inner_rhs;
    }
    string rhs;
    if (find_top_level_keyword(rhs_src, "AND") >= 0 || find_top_level_keyword(rhs_src, "OR") >= 0) {
      rhs = format_bool_expr(rhs_src);
      if (grouped_rhs && rhs.find('\n') != string::npos) rhs = "(\n" + indent_block(rhs, 4) + "\n)";
      else {
        size_t pos = 0;
        while ((pos = rhs.find('\n', pos)) != string::npos) {
          rhs.insert(pos + 1, "    " );
          pos += 5;
        }
      }
    } else {
      rhs = format_expression(rhs_src);
      const size_t rhs_par = rhs_src.find('(');
      const string rhs_name = trim_ascii_spaces(rhs_src.substr(0, rhs_par));
      if (rhs.find('\n') == string::npos && rhs_par != string::npos &&
          (iequals_ascii(rhs_name, "arrayMap") || iequals_ascii(rhs_name, "arrayFilter") || iequals_ascii(rhs_name, "arrayExists") || iequals_ascii(rhs_name, "arrayCount"))) {
        const string rhs_inner = unwrap_outer_parens(rhs_src.substr(rhs_par));
        const auto rhs_args = split_top_level(rhs_inner, ',');
        if (rhs_args.size() > 1) {
          vector<string> rhs_rendered;
          for (const auto& rhs_arg : rhs_args) rhs_rendered.push_back(format_expression(rhs_arg));
          rhs = rhs_name + "(\n";
          for (size_t j = 0; j < rhs_rendered.size(); ++j) {
            rhs += indent_block(rhs_rendered[j], 4);
            if (j + 1 < rhs_rendered.size()) rhs += ',';
            rhs += '\n';
          }
          rhs += ')';
        }
      }
    }
    if (const string inner = unwrap_outer_parens(rhs); !inner.empty() && !looks_like_query(inner) && find_top_level_keyword(inner, "AND") < 0 && find_top_level_keyword(inner, "OR") < 0) rhs = trim_ascii_spaces(inner);
    return lhs + " -> " + rhs;
  }
  if (auto over = format_over_clause(s); !over.empty()) s = over;
  if (auto arr = format_array_literal(s); !arr.empty()) s = arr;
  if (auto fn = format_function_call(s); !fn.empty()) s = fn;

  const int slash = find_top_level_operator(s, '/');
  if (slash > 0) {
    const string lhs = trim_ascii_spaces(s.substr(0, static_cast<size_t>(slash)));
    const string rhs = trim_ascii_spaces(s.substr(static_cast<size_t>(slash) + 1));
    if ((s.find('\n') != string::npos || s.size() > threshold) && !lhs.empty() && !rhs.empty()) {
      return format_expression(lhs) + "\n/ " + format_expression(rhs);
    }
  }

  if (auto in_literal = format_in_literal(s); !in_literal.empty()) s = in_literal;
  s = strip_atomic_parentheses(s);
  string op;
  if (const int cmp = find_top_level_comparator(s, &op); cmp > 0) {
    auto strip_side = [this](string side) {
      const string inner = unwrap_outer_parens(side);
      if (inner.empty()) return strip_atomic_parentheses(side);
      if (find_top_level_keyword(inner, "AND") >= 0 || find_top_level_keyword(inner, "OR") >= 0 || split_top_level(inner, ',').size() > 1) return side;
      if (find_top_level_keyword(inner, "SELECT") >= 0 || find_top_level_keyword(inner, "IN") >= 0) return side;
      if (find_top_level_comparator(inner, nullptr) >= 0) return trim_ascii_spaces(inner);
      const string collapsed = collapse_whitespace(inner);
      if (starts_with_ci(collapsed, "now() - toInterval") || starts_with_ci(collapsed, "now() + toInterval")) return collapsed;
      if (inner.find('/') != string::npos || inner.find('*') != string::npos || inner.find('+') != string::npos || inner.find('-') != string::npos) return side;
      return trim_ascii_spaces(inner);
    };
    const string lhs = strip_side(trim_ascii_spaces(s.substr(0, static_cast<size_t>(cmp))));
    const string rhs = strip_side(trim_ascii_spaces(s.substr(static_cast<size_t>(cmp) + op.size())));
    s = lhs + " " + op + " " + rhs;
  }
  s = strip_lambda_parentheses(s);
  return cleanup_surface(s);
}

string Formatter::format_exists_subquery(string_view expr) {
  if (!starts_with_ci(expr, "exists(")) return {};
  string inner = unwrap_outer_parens(expr.substr(6));
  if (inner.empty()) return {};
  if (auto nested = unwrap_outer_parens(inner); !nested.empty() && looks_like_query(nested)) inner = nested;
  if (!looks_like_query(inner)) return {};
  return string("exists(\n") + indent_block(format_statement(inner), 4) + "\n)";
}

string Formatter::format_in_subquery(string_view expr, bool break_after_in) {
  ScanState st;
  for (size_t i = 0; i < expr.size(); ++i) {
    if (is_top_level(st)) {
      static const char* ops[] = {"GLOBAL IN", "IN"};
      for (const char* raw : ops) {
        const string_view op(raw);
        if (i + op.size() <= expr.size() && iequals_ascii(expr.substr(i, op.size()), op)) {
          const string left = trim_ascii_spaces(expr.substr(0, i));
          const string tail = trim_ascii_spaces(expr.substr(i + op.size()));
          const string inner = unwrap_outer_parens(tail);
          if (left.empty() || inner.empty() || !looks_like_query(inner)) continue;
          string rendered = format_statement(inner);
          if (break_after_in && starts_with_ci(rendered, "SELECT ") && rendered.find("\nWHERE\n") != string::npos) {
            rendered = expand_nested_select_head(rendered);
            return left + " " + string(op) + "\n(\n" + indent_block(rendered, 4) + "\n)";
          }
          return left + " " + string(op) + " (\n" + indent_block(rendered, 8) + "\n    )";
        }
      }
    }
    step_scan(st, expr, i);
  }
  return {};
}

string Formatter::format_in_literal(string_view expr) {
  ScanState st;
  for (size_t i = 0; i < expr.size(); ++i) {
    if (is_top_level(st)) {
      static const char* ops[] = {"GLOBAL IN", "IN"};
      for (const char* raw : ops) {
        const string_view op(raw);
        if (i + op.size() > expr.size() || !iequals_ascii(expr.substr(i, op.size()), op)) continue;
        const string left = trim_ascii_spaces(expr.substr(0, i));
        const string right = trim_ascii_spaces(expr.substr(i + op.size()));
        if (left.empty() || right.empty()) continue;

        const size_t wrap_threshold = std::min<size_t>(threshold, 80);
        const string compact = left + " " + string(op) + " " + right;

        if (right.size() >= 2 && right.front() == '[' && right.back() == ']') {
          const string right_body = trim_ascii_spaces(right.substr(1, right.size() - 2));
          const auto right_items = split_top_level(right_body, ',');
          const bool should_wrap_array = right.find('\n') != string::npos ||
                                        (right_items.size() > 1 && compact.size() > wrap_threshold);
          if (should_wrap_array) {
            string rendered_right = "[\n";
            for (size_t j = 0; j < right_items.size(); ++j) {
              rendered_right += "    " + format_expression(right_items[j]);
              if (j + 1 < right_items.size()) rendered_right += ',';
              rendered_right += '\n';
            }
            rendered_right += ']';
            return left + " " + string(op) + " " + rendered_right;
          }
        }

        const string right_inner = unwrap_outer_parens(right);
        if (!right_inner.empty() && looks_like_query(right_inner)) continue;
        const string left_inner = unwrap_outer_parens(left);
        if (left_inner.empty() || split_top_level(left_inner, ',').size() <= 1) continue;
        if (compact.size() <= wrap_threshold && left.find('\n') == string::npos) return {};
        const auto left_items = split_top_level(left_inner, ',');
        string rendered_left = "(\n";
        for (size_t j = 0; j < left_items.size(); ++j) {
          rendered_left += "    " + format_expression(left_items[j]);
          if (j + 1 < left_items.size()) rendered_left += ',';
          rendered_left += '\n';
        }
        rendered_left += ')';
        return rendered_left + " " + string(op) + " " + right;
      }
    }
    step_scan(st, expr, i);
  }
  return {};
}

string Formatter::format_bool_term(string_view expr, bool in_and_chain) {
  auto [code, comment] = split_inline_comment(expr);
  string s = trim_ascii_spaces(code);
  if (s.empty()) return comment;
  if (auto inner = unwrap_outer_parens(s); !inner.empty()) {
    if (find_top_level_keyword(inner, "AND") >= 0 || find_top_level_keyword(inner, "OR") >= 0) {
      string nested = format_bool_expr(inner);
      if (nested.find(" IN (\n") != string::npos || nested.find(" GLOBAL IN (\n") != string::npos) {
        string grouped = "(\n" + indent_block(nested, 4) + "\n)";
        if (!comment.empty()) grouped += " " + comment;
        return grouped;
      }
      vector<string> nested_lines;
      size_t nested_start = 0;
      while (nested_start <= nested.size()) {
        const size_t nested_nl = nested.find('\n', nested_start);
        const size_t nested_end = (nested_nl == string::npos) ? nested.size() : nested_nl;
        nested_lines.push_back(string(nested.substr(nested_start, nested_end - nested_start)));
        if (nested_nl == string::npos) break;
        nested_start = nested_nl + 1;
      }
      for (string& line : nested_lines) {
        auto [code, inline_comment] = split_inline_comment(trim_ascii_spaces(line));
        string prefix;
        string rest = code;
        if (starts_with_ci(rest, "AND ") || starts_with_ci(rest, "OR ")) {
          const size_t cut = starts_with_ci(rest, "AND ") ? 4 : 3;
          prefix = rest.substr(0, cut);
          rest = trim_ascii_spaces(rest.substr(cut));
        }
        rest = strip_atomic_parentheses(rest);
        line = trim_ascii_spaces(prefix + trim_ascii_spaces(rest));
        if (!inline_comment.empty()) line += " " + inline_comment;
      }
      string grouped = "(\n" + indent_block(normalize_boolean_lines(join_lines(nested_lines)), 4) + "\n)";
      if (!comment.empty()) grouped += " " + comment;
      return grouped;
    }
    s = trim_ascii_spaces(inner);
  }
  string out;
  if (auto v = format_exists_subquery(s); !v.empty()) out = v;
  else if (auto v = format_in_subquery(s, in_and_chain); !v.empty()) out = v;
  else out = format_expression(s);
  if (!comment.empty()) {
    if (const string inner = unwrap_outer_parens(out); !inner.empty() && !looks_like_query(inner) && find_top_level_keyword(inner, "AND") < 0 && find_top_level_keyword(inner, "OR") < 0 && inner.find('\n') == string::npos) {
      out = trim_ascii_spaces(inner);
    }
    out += " " + comment;
  }
  return out;
}

string Formatter::format_bool_expr(string_view expr) {
  if (auto parts = split_top_level_keyword(expr, "AND"); !parts.empty()) {
    vector<string> rendered;
    for (const auto& part : parts) rendered.push_back(format_bool_term(part, true));
    return join_bool_parts(rendered, "AND");
  }
  if (auto parts = split_top_level_keyword(expr, "OR"); !parts.empty()) {
    vector<string> rendered;
    for (const auto& part : parts) rendered.push_back(format_bool_term(part, false));
    return join_bool_parts(rendered, "OR");
  }
  return format_bool_term(expr, false);
}

string Formatter::format_create_table(string_view s) {
  const string text = trim_ascii_spaces(s);
  const size_t par = text.find('(');
  if (par == string::npos) return cleanup_surface(text);
  const size_t close = find_matching_paren(text, par);
  if (close == string::npos) return cleanup_surface(text);

  const int engine_pos = find_top_level_keyword(text, "ENGINE");
  if (engine_pos >= 0 && static_cast<size_t>(engine_pos) < par) {
    const string before_engine = cleanup_surface(trim_ascii_spaces(text.substr(0, static_cast<size_t>(engine_pos))));
    const string engine_head = cleanup_surface(trim_ascii_spaces(text.substr(static_cast<size_t>(engine_pos), par - static_cast<size_t>(engine_pos))));
    if (starts_with_ci(engine_head, "ENGINE = Buffer")) {
      const string inner = trim_ascii_spaces(text.substr(par + 1, close - par - 1));
      const string tail = trim_ascii_spaces(text.substr(close + 1));
      const auto items = split_top_level(inner, ',');
      string out = before_engine + "\n" + engine_head + "\n(\n";
      for (size_t i = 0; i < items.size(); ++i) {
        out += "    " + format_expression(items[i]);
        if (i + 1 < items.size()) out += ',';
        out += '\n';
      }
      out += ")";
      if (!tail.empty()) out += tail == ";" ? ";" : "\n" + cleanup_surface(tail);
      return out;
    }
  }

  const string head = trim_ascii_spaces(text.substr(0, par));
  const string cols = trim_ascii_spaces(text.substr(par + 1, close - par - 1));
  const string tail = trim_ascii_spaces(text.substr(close + 1));
  const auto items = split_top_level(cols, ',');
  size_t width = 0;
  vector<std::pair<string, string>> parsed;
  for (const auto& item : items) {
    const string col = trim_ascii_spaces(item);
    const size_t sp = col.find_first_of(" \t\n");
    const string lhs = (sp == string::npos) ? col : trim_ascii_spaces(col.substr(0, sp));
    const string rhs = (sp == string::npos) ? string() : trim_ascii_spaces(col.substr(sp + 1));
    width = std::max(width, lhs.size());
    parsed.push_back({lhs, rhs});
  }
  string out = head + "\n(\n";
  for (size_t i = 0; i < parsed.size(); ++i) {
    out += "    " + parsed[i].first + string(width - parsed[i].first.size() + 1, ' ') + parsed[i].second;
    if (i + 1 < parsed.size()) out += ',';
    out += '\n';
  }
  out += ")";
  if (!tail.empty()) out += tail == ";" ? ";" : "\n" + cleanup_surface(tail);
  return out;
}

string Formatter::format_create_view(string_view s, bool) {
  const string text = trim_ascii_spaces(s);
  const int pos = find_top_level_keyword(text, "SELECT");
  if (pos < 0) return cleanup_surface(text);
  string head = cleanup_surface(trim_ascii_spaces(text.substr(0, static_cast<size_t>(pos))));
  if (ends_with_ci(head, "\nAS")) head = rtrim_spaces(head.substr(0, head.size() - 3)) + " AS";
  else if (!ends_with_ci(head, "AS")) head += " AS";
  return head + "\n" + format_statement(text.substr(static_cast<size_t>(pos)));
}

string Formatter::format_alter_table(string_view s) {
  const string text = trim_ascii_spaces(s);
  const size_t par = text.find('(');
  if (par == string::npos) return cleanup_surface(text);
  const size_t close = find_matching_paren(text, par);
  if (close == string::npos) return cleanup_surface(text);
  const string head = trim_ascii_spaces(text.substr(0, par));
  string inner = trim_ascii_spaces(text.substr(par + 1, close - par - 1));
  if (starts_with_ci(inner, "MODIFY TTL")) return head + "\n(\n    " + cleanup_surface(inner) + "\n)";
  if (starts_with_ci(inner, "ADD COLUMN")) {
    const int after_pos = find_top_level_keyword(inner, "AFTER");
    const string before_after = after_pos > 0 ? trim_ascii_spaces(inner.substr(0, static_cast<size_t>(after_pos))) : inner;
    const string after = after_pos > 0 ? trim_ascii_spaces(inner.substr(static_cast<size_t>(after_pos) + 5)) : string();
    string prefix = "ADD COLUMN";
    string coldef = trim_ascii_spaces(before_after.substr(10));
    if (starts_with_ci(coldef, "IF NOT EXISTS")) {
      prefix += " IF NOT EXISTS";
      coldef = trim_ascii_spaces(coldef.substr(13));
    }
    string out = head + "\n(\n    " + prefix + "\n        " + coldef;
    if (!after.empty()) out += "\n    AFTER " + after;
    out += "\n)";
    return out;
  }
  if (starts_with_ci(inner, "UPDATE")) {
    const int where_pos = find_top_level_keyword(inner, "WHERE");
    if (where_pos > 0) {
      const string assigns = trim_ascii_spaces(inner.substr(6, static_cast<size_t>(where_pos) - 6));
      const string cond = trim_ascii_spaces(inner.substr(static_cast<size_t>(where_pos) + 5));
      return head + "\n(\n    UPDATE\n" + indent_block(format_simple_item_block(split_top_level(assigns, ',')), 8) + "\n    WHERE\n" + indent_block(indent_block(format_bool_expr(cond), 4), 4) + "\n)";
    }
  }
  return cleanup_surface(text);
}

string Formatter::format_insert_select_like(string_view s) {
  const string text = trim_ascii_spaces(s);
  const int pos = find_top_level_keyword(text, "SELECT");
  if (pos < 0) return cleanup_surface(text);
  const string before = text.substr(11, static_cast<size_t>(pos) - 11);
  const size_t nl = before.find('\n');
  const string target = trim_ascii_spaces(nl == string::npos ? before : before.substr(0, nl));
  const string between = trim_ascii_spaces(nl == string::npos ? string() : before.substr(nl + 1));
  string out = "INSERT INTO " + target;
  if (!between.empty()) out += "\n" + between;
  out += "\n" + format_statement(text.substr(static_cast<size_t>(pos)));
  return out;
}

string Formatter::format_delete(string_view s) {
  const string text = trim_ascii_spaces(s);
  const int pos = find_top_level_keyword(text, "WHERE");
  if (pos < 0) return cleanup_surface(text);
  return trim_ascii_spaces(text.substr(0, static_cast<size_t>(pos))) + "\nWHERE\n" + indent_block(format_bool_expr(text.substr(static_cast<size_t>(pos) + 5)), 4);
}

string Formatter::try_format_insert_values(string_view s) {
  const string text = trim_ascii_spaces(s);
  if (!starts_with_ci(text, "INSERT INTO ")) return {};
  const int values_pos = find_top_level_keyword(text, "VALUES");
  if (values_pos < 0) return {};
  const string head = trim_ascii_spaces(text.substr(0, static_cast<size_t>(values_pos)));
  const string tail = trim_ascii_spaces(text.substr(static_cast<size_t>(values_pos) + 6));
  const size_t par = head.find('(');
  if (par == string::npos) return {};
  const string cols = unwrap_outer_parens(head.substr(par));
  const string vals = unwrap_outer_parens(tail);
  if (cols.empty() || vals.empty()) return {};
  const auto col_items = split_top_level(cols, ',');
  const auto val_items = split_top_level(vals, ',');
  string out = trim_ascii_spaces(head.substr(0, par)) + "\n    (\n";
  for (size_t i = 0; i < col_items.size(); ++i) {
    out += "        " + trim_ascii_spaces(col_items[i]);
    if (i + 1 < col_items.size()) out += ',';
    out += '\n';
  }
  out += "    )\nVALUES\n    (\n";
  for (size_t i = 0; i < val_items.size(); ++i) {
    out += "        " + trim_ascii_spaces(val_items[i]);
    if (i + 1 < val_items.size()) out += ',';
    out += '\n';
  }
  out += "    )";
  return out;
}

} // namespace

string postprocess_format_query(std::string s, size_t threshold) {
  return Formatter(threshold).format(s);
}

} // namespace chdash