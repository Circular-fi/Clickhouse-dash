// Text helpers of the formatter: characters, whitespace, the work budget, the spacing of code, comments, indentation and the width of a line.
// The declarations that the units share are in format_internal.hpp.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

thread_local FormatBudget* t_format_budget = nullptr;

namespace {
char lower_ascii(char ch) {
  if (ch >= 'A' && ch <= 'Z') return static_cast<char>(ch - 'A' + 'a');
  return ch;
}
}  // namespace

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

// Collapse runs of whitespace to one space in code only. Quoted literals and
// identifiers keep their exact bytes (collapsing `'a  b'` changed the value,
// and the literal restorer, which matches decoded values, could not undo it),
// and a `--` comment keeps the newline that ends it (joining the next line
// would comment it out).
string collapse_whitespace(string_view sv) {
  string out;
  bool pending = false;
  char quote = '\0';
  bool line_comment = false;
  for (size_t i = 0; i < sv.size(); ++i) {
    const char ch = sv[i];
    if (quote) {
      out.push_back(ch);
      if (ch == '\\' && quote != '`' && i + 1 < sv.size()) {
        out.push_back(sv[++i]);
      } else if (ch == quote) {
        if (i + 1 < sv.size() && sv[i + 1] == quote) out.push_back(sv[++i]);
        else quote = '\0';
      }
      continue;
    }
    if (line_comment) {
      if (ch == '\n' || ch == '\r') {
        line_comment = false;
        out.push_back('\n');
        pending = false;
        continue;
      }
      out.push_back(ch);
      continue;
    }
    if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
      pending = !out.empty() && out.back() != '\n';
      continue;
    }
    if (pending) out.push_back(' ');
    pending = false;
    if (ch == '\'' || ch == '"' || ch == '`') quote = ch;
    else if (ch == '-' && i + 1 < sv.size() && sv[i + 1] == '-') line_comment = true;
    out.push_back(ch);
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

bool ci_match_at(string_view s, size_t pos, string_view word) {
  if (pos + word.size() > s.size()) return false;
  for (size_t i = 0; i < word.size(); ++i) {
    if (lower_ascii(s[pos + i]) != lower_ascii(word[i])) return false;
  }
  return true;
}

void step_scan(ScanState& st, string_view s, size_t& i) {
  spend_format_budget();
  st.step(s, i);
}

string repair_split_clause_keywords(string_view s) {
  string out;
  out.reserve(s.size());
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (st.in_code() && ci_match_at(s, i, "ARRAY")) {
      size_t j = i + 5;
      size_t k = j;
      while (k < s.size() && (s[k] == ' ' || s[k] == '\t' || s[k] == '\n' || s[k] == '\r')) ++k;
      if (k > j && ci_match_at(s, k, "JOIN") && (k + 4 == s.size() || !is_ident_char(s[k + 4]))) {
        out += "ARRAY JOIN";
        i = k + 3;
        continue;
      }
    }
    const size_t from = i;
    step_scan(st, s, i);
    out.append(s.substr(from, i - from + 1));
  }
  return out;
}

string normalize_code_spacing(string_view s) {
  const string trimmed_for_comment = trim_ascii_spaces(s);
  if (starts_with_ci(trimmed_for_comment, "/*") || trimmed_for_comment == "*/") return string(s);

  string out;
  out.reserve(s.size() + 16);
  // End of the last unary sign written to `out`: `-(a + b)` stays glued.
  size_t unary_sign_end = string::npos;

  auto rstrip_out = [&]() {
    while (!out.empty() && (out.back() == ' ' || out.back() == '\t')) out.pop_back();
  };
  auto append_space = [&]() {
    if (!out.empty() && out.back() != ' ' && out.back() != '\n') out.push_back(' ');
  };
  auto next_non_space_pos = [&](size_t pos) {
    while (pos < s.size() && (s[pos] == ' ' || s[pos] == '\t')) ++pos;
    return pos;
  };
  auto prev_non_space = [&]() -> char {
    for (size_t i = out.size(); i > 0; --i) {
      char c = out[i - 1];
      if (c != ' ' && c != '\t' && c != '\n') return c;
    }
    return '\0';
  };
  auto out_word_before = [&](string_view word) {
    if (out.size() < word.size()) return false;
    const size_t b = out.size() - word.size();
    if (b > 0 && is_ident_char(out[b - 1])) return false;
    for (size_t j = 0; j < word.size(); ++j) {
      if (lower_ascii(out[b + j]) != lower_ascii(word[j])) return false;
    }
    return true;
  };
  // `INDEX name (expr)`: the expression of a skip index is not a call of its
  // name; a space written there stays (the stacked index layout prints one).
  auto index_name_before = [&]() {
    size_t e = out.size();
    size_t b = e;
    while (b > 0 && is_ident_char(out[b - 1])) --b;
    if (b == e) return false;
    size_t w = b;
    while (w > 0 && out[w - 1] == ' ') --w;
    if (w == b || w < 5) return false;
    return (w == 5 || !is_ident_char(out[w - 6])) && iequals_ascii(string_view(out).substr(w - 5, 5), "INDEX");
  };

  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    char n = (i + 1 < s.size()) ? s[i + 1] : '\0';

    // A comment, a text and a quoted name are copied whole: nothing in them is code to space.
    if (sql::starts_block_comment(s, i)) {
      const size_t end = sql::block_comment_end(s, i);
      out.append(s.substr(i, end - i));
      i = end - 1;
      continue;
    }
    // A line comment is copied verbatim to the end of its line. Spacing
    // it as two minus operators produced `- -comment`, turning the comment
    // into code (a trailing comment after CREATE TABLE no longer parsed).
    if (sql::starts_line_comment(s, i)) {
      const size_t end = sql::line_comment_end(s, i);
      if (!out.empty() && out.back() != ' ' && out.back() != '\n') out.push_back(' ');
      out.append(s.substr(i, end - i));
      i = end - 1;
      continue;
    }
    if (c == '\'' || c == '"' || c == '`') {
      const size_t end = sql::quoted_end(s, i);
      out.append(s.substr(i, end - i));
      i = end - 1;
      continue;
    }
    if (c == '$') {
      if (const size_t end = sql::heredoc_end(s, i)) {
        out.append(s.substr(i, end - i));
        i = end - 1;
        continue;
      }
    }

    if (c == ',') {
      rstrip_out();
      out.push_back(',');
      size_t j = next_non_space_pos(i + 1);
      if (j < s.size() && s[j] != '\n' && s[j] != '\r' && s[j] != ')' && s[j] != ']') out.push_back(' ');
      i = j - 1;
      continue;
    }

    if (c == '(' || c == '[') {
      rstrip_out();
      const bool needs_space = out_word_before("IN") || out_word_before("GLOBAL IN") ||
                               out_word_before("OVER") || out_word_before("AND") ||
                               out_word_before("OR") || out_word_before("BY") ||
                               out_word_before("USING") || out_word_before("JOIN") ||
                               out_word_before("AS") || out_word_before("NOT") ||
                               out_word_before("THEN") || out_word_before("ELSE") ||
                               out_word_before("WHEN") || out_word_before("ON") ||
                               out_word_before("INTERPOLATE") || out_word_before("PRIMARY KEY") ||
                               // `GRANT SELECT(col)` is a privilege column list, not a projection.
                               (out_word_before("SELECT") && !out_word_before("GRANT SELECT") &&
                                !out_word_before("REVOKE SELECT")) ||
                               out_word_before("WHERE") || out_word_before("PREWHERE") ||
                               out_word_before("HAVING") || out_word_before("DISTINCT") ||
                               out_word_before("BETWEEN") || out_word_before("CASE") ||
                               out_word_before("LIKE") || out_word_before("ILIKE") ||
                               out_word_before("DEFAULT") || out_word_before("MATERIALIZED") ||
                               out_word_before("ALIAS") || out_word_before("EPHEMERAL") ||
                               prev_non_space() == ',' || prev_non_space() == '+' ||
                               prev_non_space() == '-' || prev_non_space() == '*' ||
                               prev_non_space() == '/' || prev_non_space() == '%' ||
                               prev_non_space() == '=' ||
                               prev_non_space() == '>' || prev_non_space() == '<' ||
                               (i > 0 && s[i - 1] == ' ' && index_name_before());
      if (needs_space && out.size() != unary_sign_end) append_space();
      out.push_back(c);
      while (i + 1 < s.size() && (s[i + 1] == ' ' || s[i + 1] == '\t')) ++i;
      continue;
    }

    if (c == ')') {
      rstrip_out();
      out.push_back(')');
      size_t j = next_non_space_pos(i + 1);
      if (j + 2 <= s.size() && iequals_ascii(s.substr(j, 2), "AS") &&
          (j + 2 == s.size() || !is_ident_char(s[j + 2]))) out.push_back(' ');
      continue;
    }
    if (c == ']') {
      rstrip_out();
      out.push_back(']');
      continue;
    }

    string op;
    if ((c == '>' || c == '<' || c == '!' || c == '=') && n == '=') op = string() + c + n;
    else if (c == '<' && n == '>') op = "<>";
    else if (c == '-' && n == '>') op = "->";
    else if (c == '=' || c == '>' || c == '<') op = string(1, c);
    else if (c == '+' || c == '-' || c == '*' || c == '/') {
      const char p = prev_non_space();
      const size_t qpos = next_non_space_pos(i + 1);
      const char q = qpos < s.size() ? s[qpos] : '\0';
      // A sign is unary where an operand is expected: after an opening
      // bracket, a separator, another operator or an expression keyword.
      static const char* const operand_keywords[] = {
          "SELECT", "WHERE", "PREWHERE", "HAVING", "AND", "OR", "NOT", "WHEN", "THEN",
          "ELSE", "CASE", "BY", "ON", "LIMIT", "OFFSET", "BETWEEN", "DISTINCT", "IN", "QUALIFY"};
      bool after_keyword = false;
      if (p != '\0' && is_ident_char(p)) {
        size_t end = out.size();
        while (end > 0 && (out[end - 1] == ' ' || out[end - 1] == '\t')) --end;
        size_t begin = end;
        while (begin > 0 && (is_ident_char(out[begin - 1]) || out[begin - 1] == '.')) --begin;
        const string_view word = string_view(out).substr(begin, end - begin);
        // The exponent sign of a float literal (`1e-5`) is not an operator.
        if ((c == '-' || c == '+') && end == out.size() && !word.empty() &&
            std::isdigit(static_cast<unsigned char>(word.front())) &&
            !(word.size() > 1 && (word[1] == 'x' || word[1] == 'X')) &&
            (word.back() == 'e' || word.back() == 'E') &&
            std::isdigit(static_cast<unsigned char>(q)) && qpos == i + 1) {
          out.push_back(c);
          continue;
        }
        for (const char* kw : operand_keywords) after_keyword = after_keyword || iequals_ascii(word, kw);
      }
      const bool operand_position =
          p == '(' || p == '[' || p == ',' || p == '=' || p == '>' || p == '<' || p == '+' ||
          p == '-' || p == '*' || p == '/' || p == '%' || p == '?' || p == ':' || after_keyword;
      // At the start of a line a sign followed by a space is the binary
      // continuation the formatter itself emits (`\n- rhs`); formatQuery prints
      // unary minus glued to its operand (`-x`, `-(a + b)`).
      const bool line_start_unary = p == '\0' && i + 1 < s.size() && s[i + 1] != ' ' && s[i + 1] != '\t';
      // `*` where an operand is expected is the asterisk (`count(*)`,
      // `max(*)`, `t.*`), not a multiplication: no spaces inside its brackets.
      if (c == '*' && (operand_position || p == '.')) {
        if (p == '(' || p == '[' || p == '.') rstrip_out();
        else append_space();
        out.push_back(c);
        continue;
      }
      const bool unary = (c == '-' || c == '+') && (operand_position || line_start_unary);
      if (unary) {
        // Print the sign glued to its operand (`-x`, not `- x`). `- -x` keeps
        // its separating space: `--` would start a comment.
        rstrip_out();
        if (p != '(' && p != '[' && p != '\0') append_space();
        out.push_back(c);
        unary_sign_end = out.size();
        while (i + 1 < s.size() && (s[i + 1] == ' ' || s[i + 1] == '\t')) ++i;
        if (i + 1 < s.size() && (s[i + 1] == '-' || s[i + 1] == '+')) out.push_back(' ');
        continue;
      }
      op = string(1, c);
    }
    if (!op.empty()) {
      if (op == "->") {
        rstrip_out();
        append_space();
        out += "->";
        out.push_back(' ');
        ++i;
      } else {
        rstrip_out();
        append_space();
        out += op;
        out.push_back(' ');
        if (op.size() == 2) ++i;
      }
      while (i + 1 < s.size() && (s[i + 1] == ' ' || s[i + 1] == '\t')) ++i;
      continue;
    }

    if (c == ' ' || c == '\t') {
      append_space();
      while (i + 1 < s.size() && (s[i + 1] == ' ' || s[i + 1] == '\t')) ++i;
      continue;
    }

    out.push_back(c);
  }

  return rtrim_spaces(out);
}

namespace {
string wrap_comment_text(string_view body) {
  vector<string> lines;
  vector<string> chunks;
  size_t start = 0;
  for (size_t i = 0; i < body.size(); ++i) {
    if (body[i] == '.' && i + 1 < body.size() && std::isspace(static_cast<unsigned char>(body[i + 1]))) {
      chunks.push_back(trim_ascii_spaces(body.substr(start, i + 1 - start)));
      start = i + 1;
    }
  }
  string tail = trim_ascii_spaces(body.substr(start));
  if (!tail.empty()) chunks.push_back(tail);
  if (chunks.empty()) chunks.push_back(trim_ascii_spaces(body));

  for (const auto& chunk : chunks) {
    string line;
    size_t pos = 0;
    while (pos < chunk.size()) {
      while (pos < chunk.size() && std::isspace(static_cast<unsigned char>(chunk[pos]))) ++pos;
      size_t end = pos;
      while (end < chunk.size() && !std::isspace(static_cast<unsigned char>(chunk[end]))) ++end;
      string word = string(chunk.substr(pos, end - pos));
      if (!word.empty()) {
        if (line.empty()) line = word;
        else if (line.size() + 1 + word.size() <= 76) line += " " + word;
        else { lines.push_back(line); line = word; }
      }
      pos = end;
    }
    if (!line.empty()) lines.push_back(line);
  }
  string out;
  for (size_t i = 0; i < lines.size(); ++i) {
    if (i) out += '\n';
    out += "    " + lines[i];
  }
  return out;
}
}  // namespace

string reflow_block_comment(string_view block) {
  string text = trim_ascii_spaces(block);
  if (!starts_with_ci(text, "/*") || text.size() < 4) return string(block);
  if (text.find('\n') != string::npos) return string(block);
  if (text.size() < 4 || text.substr(text.size() - 2) != "*/") return string(block);
  string body = trim_ascii_spaces(text.substr(2, text.size() - 4));
  if (body.empty()) return "/*\n*/";
  return "/*\n" + wrap_comment_text(body) + "\n*/";
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

// Display width used for alignment: monospace columns, not bytes or code
// points, so CJK (two columns), emoji (two) and combining marks (none) in a
// literal or identifier do not shift the aligned `AS` column.
size_t utf8_width(string_view s) {
  return sql_display_width(s);
}

size_t last_line_length(string_view s) {
  const size_t pos = s.rfind('\n');
  return utf8_width(pos == string_view::npos ? s : s.substr(pos + 1));
}

string prefix_first_line(const string& s, string_view prefix) {
  const size_t pos = s.find('\n');
  if (pos == string::npos) return string(prefix) + s;
  return string(prefix) + s.substr(0, pos) + s.substr(pos);
}

string indent_after_first_line(string_view s, size_t spaces) {
  const size_t pos = s.find('\n');
  if (pos == string_view::npos) return string(s);
  return string(s.substr(0, pos + 1)) + indent_block(s.substr(pos + 1), static_cast<int>(spaces));
}

// Removes the indentation common to the lines after the first. A predicate
// that follows a leading `--` comment keeps the indentation it had in the
// input; without this, formatting the output again would indent it twice.
// Lines that start inside a quoted literal keep their spacing.
string dedent_after_first_line(string_view s) {
  const size_t first_nl = s.find('\n');
  if (first_nl == string_view::npos) return string(s);
  vector<size_t> starts;
  ScanState st;
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '\n' && i >= first_nl) {
      if (st.in_quoted() || st.region == ScanState::Region::BlockComment) return string(s);
      starts.push_back(i + 1);
    }
    step_scan(st, s, i);
  }
  size_t common = static_cast<size_t>(-1);
  for (const size_t start : starts) {
    size_t k = start;
    while (k < s.size() && s[k] == ' ') ++k;
    if (k < s.size() && s[k] != '\n') common = std::min(common, k - start);
  }
  if (common == 0 || common == static_cast<size_t>(-1)) return string(s);
  string out;
  size_t cursor = 0;
  for (const size_t start : starts) {
    out.append(s.substr(cursor, start - cursor));
    size_t k = start;
    while (k < s.size() && k - start < common && s[k] == ' ') ++k;
    cursor = k;
  }
  out.append(s.substr(cursor));
  return out;
}

}  // namespace fmt
}  // namespace chdash
