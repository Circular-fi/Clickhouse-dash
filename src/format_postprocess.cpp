#include "format_postprocess.hpp"
#include "sql_scan.hpp"

#include <algorithm>
#include <cctype>
#include <initializer_list>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

namespace chdash {
namespace {

using std::optional;
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


bool ci_match_at(string_view s, size_t pos, string_view word) {
  if (pos + word.size() > s.size()) return false;
  for (size_t i = 0; i < word.size(); ++i) {
    if (lower_ascii(s[pos + i]) != lower_ascii(word[i])) return false;
  }
  return true;
}

string repair_split_clause_keywords(string_view s) {
  string out;
  out.reserve(s.size());
  bool in_str = false;
  bool in_backtick = false;
  bool in_line_comment = false;
  bool in_block_comment = false;
  bool esc = false;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    const char n = (i + 1 < s.size()) ? s[i + 1] : '\0';
    if (in_line_comment) { out.push_back(c); if (c == '\n') in_line_comment = false; continue; }
    if (in_block_comment) { out.push_back(c); if (c == '*' && n == '/') { out.push_back(n); ++i; in_block_comment = false; } continue; }
    if (in_str) { out.push_back(c); if (esc) esc = false; else if (c == '\\') esc = true; else if (c == '\'') in_str = false; continue; }
    if (in_backtick) { out.push_back(c); if (c == '`') in_backtick = false; continue; }
    if (c == '\'') { out.push_back(c); in_str = true; esc = false; continue; }
    if (c == '`') { out.push_back(c); in_backtick = true; continue; }
    if (c == '-' && n == '-') { out += "--"; ++i; in_line_comment = true; continue; }
    if (c == '#') { out.push_back(c); in_line_comment = true; continue; }
    if (c == '/' && n == '*') { out += "/*"; ++i; in_block_comment = true; continue; }

    if (ci_match_at(s, i, "ARRAY")) {
      size_t j = i + 5;
      size_t k = j;
      while (k < s.size() && (s[k] == ' ' || s[k] == '\t' || s[k] == '\n' || s[k] == '\r')) ++k;
      if (k > j && ci_match_at(s, k, "JOIN") && (k + 4 == s.size() || !is_ident_char(s[k + 4]))) {
        out += "ARRAY JOIN";
        i = k + 3;
        continue;
      }
    }
    out.push_back(c);
  }
  return out;
}



string normalize_code_spacing(string_view s) {
  const string trimmed_for_comment = trim_ascii_spaces(s);
  if (starts_with_ci(trimmed_for_comment, "/*") || trimmed_for_comment == "*/") return string(s);

  string out;
  out.reserve(s.size() + 16);
  bool in_str = false;
  bool in_backtick = false;
  bool esc = false;
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

  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    char n = (i + 1 < s.size()) ? s[i + 1] : '\0';

    if (in_str) {
      out.push_back(c);
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') in_str = false;
      continue;
    }
    if (in_backtick) {
      out.push_back(c);
      if (c == '`') in_backtick = false;
      continue;
    }
    if (c == '/' && n == '*') {
      const size_t end = s.find("*/", i + 2);
      if (end == string_view::npos) {
        out.append(s.substr(i));
        break;
      }
      out.append(s.substr(i, end + 2 - i));
      i = end + 1;
      continue;
    }
    if (c == '\'') {
      in_str = true;
      esc = false;
      out.push_back(c);
      continue;
    }
    if (c == '`') {
      in_backtick = true;
      out.push_back(c);
      continue;
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
                               out_word_before("INTERPOLATE") ||
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
                               prev_non_space() == '>' || prev_non_space() == '<';
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

size_t find_comment_continuation(string_view body) {
  const string hay = string(" ") + string(body);
  size_t best = string::npos;
  static const char* markers[] = {
      " FROM ", " WHERE ", " PREWHERE ", " GROUP BY ", " ORDER BY ", " HAVING ",
      " LIMIT ", " SETTINGS ", " FORMAT ", " AND ", " OR ", " UNION ALL ", " NULL", " SELECT "};
  for (const char* marker : markers) {
    const string_view m(marker);
    for (size_t i = 0; i + m.size() <= hay.size(); ++i) {
      bool ok = true;
      for (size_t j = 0; j < m.size(); ++j) {
        if (lower_ascii(hay[i + j]) != lower_ascii(m[j])) { ok = false; break; }
      }
      if (ok) {
        const size_t pos = i == 0 ? 0 : i - 1;
        if (pos > 0) best = std::min(best, pos);
      }
    }
  }

  bool in_str = false;
  bool in_backtick = false;
  bool esc = false;
  for (size_t i = 0; i < body.size(); ++i) {
    const char c = body[i];
    if (in_str) {
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') in_str = false;
      continue;
    }
    if (in_backtick) {
      if (c == '`') in_backtick = false;
      continue;
    }
    if (c == '\'') { in_str = true; esc = false; continue; }
    if (c == '`') { in_backtick = true; continue; }
    if (std::isalpha(static_cast<unsigned char>(c)) || c == '_') {
      size_t j = i;
      while (j < body.size() && (is_ident_char(body[j]) || body[j] == '.')) ++j;
      size_t k = j;
      while (k < body.size() && (body[k] == ' ' || body[k] == '\t')) ++k;
      if (k < body.size() && body[k] == ',') {
        best = std::min(best, i);
        break;
      }
    }
  }
  return best;
}

string repair_line_comments(string_view s) {
  string out;
  out.reserve(s.size() + 32);
  bool in_str = false;
  bool in_backtick = false;
  bool in_block = false;
  bool esc = false;

  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    char n = (i + 1 < s.size()) ? s[i + 1] : '\0';
    if (in_str) {
      out.push_back(c);
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') in_str = false;
      continue;
    }
    if (in_backtick) {
      out.push_back(c);
      if (c == '`') in_backtick = false;
      continue;
    }
    if (in_block) {
      out.push_back(c);
      if (c == '*' && n == '/') {
        out.push_back('/');
        ++i;
        in_block = false;
      }
      continue;
    }
    if (c == '\'') { in_str = true; esc = false; out.push_back(c); continue; }
    if (c == '`') { in_backtick = true; out.push_back(c); continue; }
    if (c == '/' && n == '*') { in_block = true; out += "/*"; ++i; continue; }

    if ((c == '-' && n == '-') || c == '#') {
      const bool hash = c == '#';
      const size_t marker_len = hash ? 1 : 2;
      const size_t body_start = i + marker_len;
      size_t line_end = s.find('\n', body_start);
      if (line_end == string_view::npos) line_end = s.size();
      string body = string(s.substr(body_start, line_end - body_start));
      const size_t cont = find_comment_continuation(body);
      if (cont != string::npos) {
        const string comment = trim_ascii_spaces(body.substr(0, cont));
        const string rest = trim_ascii_spaces(body.substr(cont));
        out += hash ? "#" : "--";
        if (!comment.empty()) out += " " + comment;
        out += "\n";
        out += repair_line_comments(rest);
        i = line_end == 0 ? 0 : line_end - 1;
        continue;
      }
      out += hash ? "#" : "--";
      const string comment = trim_ascii_spaces(body);
      if (!comment.empty()) out += " " + comment;
      i = line_end == 0 ? 0 : line_end - 1;
      continue;
    }

    out.push_back(c);
  }
  return out;
}

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

struct ScanState {
  bool in_str = false;
  bool in_double_quote = false;
  bool in_backtick = false;
  bool in_line_comment = false;
  bool in_block_comment = false;
  bool esc = false;
  int par = 0;
  int br = 0;
  int brc = 0;
};

bool is_top_level(const ScanState& st) {
  return !st.in_str && !st.in_double_quote && !st.in_backtick &&
         !st.in_line_comment && !st.in_block_comment &&
         st.par == 0 && st.br == 0 && st.brc == 0;
}

void step_scan(ScanState& st, string_view s, size_t& i) {
  const char c = s[i];
  const char n = (i + 1 < s.size()) ? s[i + 1] : '\0';
  if (st.in_str) {
    if (st.esc) st.esc = false;
    else if (c == '\\') st.esc = true;
    else if (c == '\'' && n == '\'') ++i;
    else if (c == '\'') st.in_str = false;
    return;
  }
  if (st.in_double_quote) {
    if (st.esc) st.esc = false;
    else if (c == '\\') st.esc = true;
    else if (c == '"' && n == '"') ++i;
    else if (c == '"') st.in_double_quote = false;
    return;
  }
  if (st.in_backtick) {
    if (c == '`' && n == '`') ++i;
    else if (c == '`') st.in_backtick = false;
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
  if (c == '"') {
    st.in_double_quote = true;
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
      if (st.in_str || st.in_double_quote || st.in_backtick || st.in_block_comment) return string(s);
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

size_t find_matching_paren(string_view s, size_t open_pos) {
  if (open_pos >= s.size() || s[open_pos] != '(') return string::npos;
  ScanState st;
  st.par = 1;
  for (size_t i = open_pos + 1; i < s.size(); ++i) {
    if (!st.in_str && !st.in_double_quote && !st.in_backtick && !st.in_line_comment && !st.in_block_comment) {
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
    if (!st.in_str && !st.in_double_quote && !st.in_backtick && !st.in_line_comment && !st.in_block_comment) {
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

static string format_alias_identifier(string_view alias) {
  const string trimmed = trim_ascii_spaces(alias);
  if (trimmed.empty()) return {};
  // `AS z -- note` at the end of a projection: the comment follows the alias,
  // it must never be quoted into the identifier.
  if (auto [code, comment] = split_inline_comment(trimmed); !comment.empty() && !trim_ascii_spaces(code).empty()) {
    return format_alias_identifier(code) + " " + comment;
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
  int from_pos = find_top_level_keyword(text, "FROM", static_cast<size_t>(select_pos + 6));
  if (from_pos < 0) return false;
  string select_body = trim_ascii_spaces(text.substr(static_cast<size_t>(select_pos + 6), static_cast<size_t>(from_pos - select_pos - 6)));
  return split_top_level(select_body, ',').size() > 1;
}

vector<string> split_lines_keep(string_view s) {
  vector<string> lines;
  size_t start = 0;
  while (start <= s.size()) {
    const size_t nl = s.find('\n', start);
    const size_t end = (nl == string_view::npos) ? s.size() : nl;
    lines.emplace_back(s.substr(start, end - start));
    if (nl == string_view::npos) break;
    start = nl + 1;
  }
  return lines;
}

size_t leading_space_count(string_view s) {
  size_t i = 0;
  while (i < s.size() && s[i] == ' ') ++i;
  return i;
}

int find_alias_marker_for_alignment(string_view line) {
  ScanState st;
  int last = -1;
  for (size_t i = 0; i + 4 <= line.size(); ++i) {
    if (!st.in_str && !st.in_double_quote && !st.in_backtick && !st.in_line_comment && !st.in_block_comment && line.substr(i, 4) == " AS ") {
      last = static_cast<int>(i);
    }
    step_scan(st, line, i);
  }
  return last;
}

string align_alias_line(string_view line, size_t target_as) {
  const int as_pos = find_alias_marker_for_alignment(line);
  if (as_pos < 0) return string(line);
  string lhs = rtrim_spaces(line.substr(0, static_cast<size_t>(as_pos)));
  string rhs = trim_ascii_spaces(line.substr(static_cast<size_t>(as_pos) + 4));
  const size_t lhs_width = utf8_width(lhs);
  if (lhs_width >= target_as) return lhs + " AS " + rhs;
  return lhs + string(target_as - lhs_width, ' ') + "AS " + rhs;
}

bool line_is_alignable_alias(string_view line) {
  const string t = trim_ascii_spaces(line);
  if (t.empty() || starts_with_ci(t, ")") || starts_with_ci(t, "FROM ") ||
      starts_with_ci(t, "JOIN ") || starts_with_ci(t, "ARRAY JOIN ") ||
      starts_with_ci(t, "GLOBAL ARRAY JOIN ")) return false;
  const int as_pos = find_alias_marker_for_alignment(line);
  if (as_pos < 0) return false;
  const string rhs = trim_ascii_spaces(line.substr(static_cast<size_t>(as_pos) + 4));
  return starts_with_ci(rhs, "`");
}

void align_alias_groups(vector<string>& lines) {
  for (size_t i = 0; i < lines.size();) {
    if (!line_is_alignable_alias(lines[i])) { ++i; continue; }
    const size_t indent = leading_space_count(lines[i]);
    size_t j = i;
    size_t max_as = 0;
    size_t min_as = static_cast<size_t>(-1);
    while (j < lines.size() && line_is_alignable_alias(lines[j]) && leading_space_count(lines[j]) == indent) {
      const int as_pos = find_alias_marker_for_alignment(lines[j]);
      const size_t as_col = utf8_width(string_view(lines[j]).substr(0, static_cast<size_t>(as_pos)));
      max_as = std::max(max_as, as_col);
      min_as = std::min(min_as, as_col);
      ++j;
    }
    bool previous_multiline_alias = false;
    if (i > 0) {
      const string prev = trim_ascii_spaces(lines[i - 1]);
      previous_multiline_alias = starts_with_ci(prev, ") AS `");
    }
    bool followed_by_table_cte = false;
    if (j < lines.size()) {
      const string next = trim_ascii_spaces(lines[j]);
      followed_by_table_cte = next == "(";
    }
    if (j - i >= 2 && max_as > min_as && !previous_multiline_alias && !followed_by_table_cte) {
      bool in_with_block = false;
      for (size_t b = i; b > 0; --b) {
        const string prev = trim_ascii_spaces(lines[b - 1]);
        if (prev.empty()) continue;
        if (iequals_ascii(prev, "WITH")) { in_with_block = true; break; }
        if (iequals_ascii(prev, "SELECT") || starts_with_ci(prev, "FROM ") || starts_with_ci(prev, "WHERE ")) break;
      }
      const size_t target = max_as + (in_with_block ? 4 : 2);
      bool ok = true;
      vector<string> rendered;
      for (size_t k = i; k < j; ++k) {
        string line = align_alias_line(lines[k], target);
        if (utf8_width(line) > 80) ok = false;
        rendered.push_back(std::move(line));
      }
      if (ok) {
        for (size_t k = i; k < j; ++k) lines[k] = std::move(rendered[k - i]);
      }
    }
    i = j;
  }
}

bool looks_like_create_column_line(string_view line) {
  const string t = trim_ascii_spaces(line);
  return t.size() > 2 && t.front() == '`' && t.find('`', 1) != string::npos && t.find(' ') != string::npos;
}

bool in_create_schema_block(const vector<string>& lines, size_t line_index, size_t indent) {
  if (line_index == 0) return false;
  for (size_t b = line_index; b > 0; --b) {
    const string prev = trim_ascii_spaces(lines[b - 1]);
    if (prev.empty()) continue;
    const size_t prev_indent = leading_space_count(lines[b - 1]);
    if (prev == "(" && prev_indent < indent) {
      for (size_t h = b - 1; h > 0; --h) {
        const string head = trim_ascii_spaces(lines[h - 1]);
        if (head.empty()) continue;
        return starts_with_ci(head, "CREATE TABLE ") || starts_with_ci(head, "CREATE VIEW ") ||
               starts_with_ci(head, "CREATE MATERIALIZED VIEW ");
      }
      return false;
    }
    if (prev_indent < indent && prev != "(") return false;
  }
  return false;
}

void align_create_columns(vector<string>& lines) {
  for (size_t i = 0; i < lines.size();) {
    if (!looks_like_create_column_line(lines[i])) { ++i; continue; }
    const size_t indent = leading_space_count(lines[i]);

    // In CREATE TABLE / VIEW schemas, a multiline Tuple may place several
    // deeper lines between top-level column declarations. Treat the whole
    // schema column run as one alignment group rather than resetting after
    // every nested type block.
    if (in_create_schema_block(lines, i, indent)) {
      vector<size_t> indexes;
      size_t j = i;
      while (j < lines.size()) {
        const string t = trim_ascii_spaces(lines[j]);
        if (t.empty()) { ++j; continue; }
        const size_t current_indent = leading_space_count(lines[j]);
        if (current_indent < indent) break;
        if (current_indent == indent) {
          if (looks_like_create_column_line(lines[j])) indexes.push_back(j);
          else if (starts_with_ci(t, "INDEX ") || starts_with_ci(t, "PROJECTION ") ||
                   starts_with_ci(t, "CONSTRAINT ") || starts_with_ci(t, "PRIMARY KEY ") ||
                   starts_with_ci(t, "TTL ")) break;
        }
        ++j;
      }

      if (indexes.size() >= 2) {
        size_t width = 0;
        struct ColLine { string lhs; string rhs; bool comma; };
        vector<ColLine> cols;
        cols.reserve(indexes.size());
        for (const size_t index : indexes) {
          string t = trim_ascii_spaces(lines[index]);
          bool comma = false;
          if (!t.empty() && t.back() == ',') { comma = true; t.pop_back(); t = rtrim_spaces(t); }
          const size_t close = t.find('`', 1);
          const string lhs = t.substr(0, close + 1);
          const string rhs = trim_ascii_spaces(t.substr(close + 1));
          width = std::max(width, utf8_width(lhs));
          cols.push_back({lhs, rhs, comma});
        }
        for (size_t k = 0; k < indexes.size(); ++k) {
          string rendered(indent, ' ');
          rendered += cols[k].lhs;
          rendered += string(width - utf8_width(cols[k].lhs) + 1, ' ');
          rendered += cols[k].rhs;
          if (cols[k].comma) rendered += ',';
          lines[indexes[k]] = std::move(rendered);
        }
      }
      i = std::max(i + 1, j);
      continue;
    }

    // Fallback for short standalone runs outside a CREATE schema.
    size_t j = i;
    size_t width = 0;
    struct ColLine { string lhs; string rhs; bool comma; };
    vector<ColLine> cols;
    while (j < lines.size() && looks_like_create_column_line(lines[j]) && leading_space_count(lines[j]) == indent) {
      string t = trim_ascii_spaces(lines[j]);
      bool comma = false;
      if (!t.empty() && t.back() == ',') { comma = true; t.pop_back(); t = rtrim_spaces(t); }
      const size_t close = t.find('`', 1);
      string lhs = t.substr(0, close + 1);
      string rhs = trim_ascii_spaces(t.substr(close + 1));
      width = std::max(width, utf8_width(lhs));
      cols.push_back({lhs, rhs, comma});
      ++j;
    }
    if (cols.size() >= 2) {
      bool ok = true;
      vector<string> rendered;
      for (const auto& col : cols) {
        string line(indent, ' ');
        line += col.lhs;
        line += string(width - utf8_width(col.lhs) + 1, ' ');
        line += col.rhs;
        if (col.comma) line += ',';
        if (utf8_width(line) > 80) ok = false;
        rendered.push_back(std::move(line));
      }
      if (ok) {
        for (size_t k = i; k < j; ++k) lines[k] = std::move(rendered[k - i]);
      }
    }
    i = j;
  }
}

struct IndexAlignmentLine {
  string name;
  string expression;
  string type;
  string granularity;
  bool comma = false;
};

optional<IndexAlignmentLine> parse_index_alignment_line(string_view line) {
  string t = trim_ascii_spaces(line);
  bool comma = false;
  if (!t.empty() && t.back() == ',') {
    comma = true;
    t.pop_back();
    t = rtrim_spaces(t);
  }
  if (!starts_with_ci(t, "INDEX ")) return std::nullopt;
  string rest = trim_ascii_spaces(t.substr(6));
  const int type_pos = find_top_level_keyword(rest, "TYPE");
  if (type_pos <= 0) return std::nullopt;
  const int granularity_pos = find_top_level_keyword(rest, "GRANULARITY", static_cast<size_t>(type_pos + 4));
  if (granularity_pos <= type_pos) return std::nullopt;

  const string left = trim_ascii_spaces(rest.substr(0, static_cast<size_t>(type_pos)));
  const size_t name_end = left.find_first_of(" \t\n");
  if (name_end == string::npos) return std::nullopt;
  IndexAlignmentLine out;
  out.name = trim_ascii_spaces(left.substr(0, name_end));
  out.expression = trim_ascii_spaces(left.substr(name_end + 1));
  out.type = trim_ascii_spaces(rest.substr(static_cast<size_t>(type_pos) + 4,
      static_cast<size_t>(granularity_pos - type_pos - 4)));
  out.granularity = trim_ascii_spaces(rest.substr(static_cast<size_t>(granularity_pos) + 11));
  out.comma = comma;
  if (out.name.empty() || out.expression.empty() || out.type.empty() || out.granularity.empty()) return std::nullopt;
  return out;
}

void align_create_index_groups(vector<string>& lines) {
  for (size_t i = 0; i < lines.size();) {
    auto first = parse_index_alignment_line(lines[i]);
    if (!first) { ++i; continue; }
    const size_t indent = leading_space_count(lines[i]);
    vector<IndexAlignmentLine> group;
    size_t j = i;
    while (j < lines.size() && leading_space_count(lines[j]) == indent) {
      auto parsed = parse_index_alignment_line(lines[j]);
      if (!parsed) break;
      group.push_back(std::move(*parsed));
      ++j;
    }
    if (group.size() >= 2) {
      size_t name_width = 0;
      size_t expression_width = 0;
      size_t type_width = 0;
      for (const auto& row : group) {
        name_width = std::max(name_width, utf8_width(row.name));
        expression_width = std::max(expression_width, utf8_width(row.expression));
        type_width = std::max(type_width, utf8_width(row.type));
      }
      for (size_t k = 0; k < group.size(); ++k) {
        const auto& row = group[k];
        string rendered(indent, ' ');
        rendered += "INDEX " + row.name;
        rendered += string(name_width - utf8_width(row.name) + 1, ' ');
        rendered += row.expression;
        rendered += string(expression_width - utf8_width(row.expression) + 1, ' ');
        rendered += "TYPE " + row.type;
        rendered += string(type_width - utf8_width(row.type) + 1, ' ');
        rendered += "GRANULARITY " + row.granularity;
        if (row.comma) rendered += ',';
        lines[i + k] = std::move(rendered);
      }
    }
    i = j;
  }
}

string align_multiline_tuple_closers(string_view source) {
  struct ParenFrame {
    bool tuple = false;
    size_t indent = 0;
    size_t opened_line = 0;
  };
  vector<ParenFrame> stack;
  string out;
  out.reserve(source.size() + 64);
  size_t line = 0;
  size_t source_line_start = 0;
  size_t output_line_start = 0;
  bool in_single = false;
  bool in_double = false;
  bool in_backtick = false;
  bool in_line_comment = false;
  bool in_block_comment = false;

  auto current_indent = [&](size_t pos) {
    size_t n = 0;
    for (size_t k = source_line_start; k < pos && source[k] == ' '; ++k) ++n;
    return n;
  };
  auto current_output_line_is_blank = [&]() {
    for (size_t k = output_line_start; k < out.size(); ++k) {
      if (out[k] != ' ' && out[k] != '\t' && out[k] != '\r') return false;
    }
    return true;
  };
  auto preceding_identifier = [&](size_t pos) {
    size_t end = pos;
    while (end > source_line_start && (source[end - 1] == ' ' || source[end - 1] == '\t')) --end;
    size_t begin = end;
    while (begin > source_line_start) {
      const char ch = source[begin - 1];
      if (!(std::isalnum(static_cast<unsigned char>(ch)) || ch == '_')) break;
      --begin;
    }
    return string(source.substr(begin, end - begin));
  };

  for (size_t i = 0; i < source.size(); ++i) {
    const char c = source[i];
    const char n = i + 1 < source.size() ? source[i + 1] : '\0';

    if (in_line_comment) {
      out.push_back(c);
      if (c == '\n') {
        in_line_comment = false;
        ++line;
        source_line_start = i + 1;
        output_line_start = out.size();
      }
      continue;
    }
    if (in_block_comment) {
      out.push_back(c);
      if (c == '*' && n == '/') {
        out.push_back(n);
        ++i;
        in_block_comment = false;
      } else if (c == '\n') {
        ++line;
        source_line_start = i + 1;
        output_line_start = out.size();
      }
      continue;
    }
    if (!in_single && !in_double && !in_backtick && c == '-' && n == '-') {
      out.push_back(c); out.push_back(n); ++i; in_line_comment = true; continue;
    }
    if (!in_single && !in_double && !in_backtick && c == '/' && n == '*') {
      out.push_back(c); out.push_back(n); ++i; in_block_comment = true; continue;
    }

    if (!in_double && !in_backtick && c == '\'' && (i == 0 || source[i - 1] != '\\')) in_single = !in_single;
    else if (!in_single && !in_backtick && c == '"' && (i == 0 || source[i - 1] != '\\')) in_double = !in_double;
    else if (!in_single && !in_double && c == '`') in_backtick = !in_backtick;

    if (!in_single && !in_double && !in_backtick && c == '(') {
      const string ident = preceding_identifier(i);
      stack.push_back({iequals_ascii(ident, "Tuple"), current_indent(i), line});
      out.push_back(c);
      continue;
    }

    if (!in_single && !in_double && !in_backtick && c == ')' && !stack.empty()) {
      const ParenFrame frame = stack.back();
      stack.pop_back();
      if (frame.tuple && line > frame.opened_line) {
        if (current_output_line_is_blank()) {
          out.resize(output_line_start);
          out.append(frame.indent, ' ');
        } else {
          out.push_back('\n');
          ++line;
          output_line_start = out.size();
          out.append(frame.indent, ' ');
        }
      }
      out.push_back(c);
      continue;
    }

    out.push_back(c);
    if (c == '\n') {
      ++line;
      source_line_start = i + 1;
      output_line_start = out.size();
    }
  }
  return out;
}

void split_long_string_alias_lines(vector<string>& lines) {
  for (size_t i = 0; i < lines.size(); ++i) {
    if (lines[i].size() <= 80) continue;
    const int as_pos = find_alias_marker_for_alignment(lines[i]);
    if (as_pos < 0) continue;
    string lhs = rtrim_spaces(lines[i].substr(0, static_cast<size_t>(as_pos)));
    string rhs = trim_ascii_spaces(lines[i].substr(static_cast<size_t>(as_pos) + 4));
    const string trimmed_lhs = trim_ascii_spaces(lhs);
    if (trimmed_lhs.empty() || trimmed_lhs.front() != '\'') continue;
    const size_t indent = leading_space_count(lines[i]);
    lines[i] = lhs;
    lines.insert(lines.begin() + static_cast<long>(i + 1), string(indent + 4, ' ') + "AS " + rhs);
    ++i;
  }
}

void split_combined_limit_lines(vector<string>& lines) {
  for (size_t i = 0; i < lines.size(); ++i) {
    string t = trim_ascii_spaces(lines[i]);
    if (!starts_with_ci(t, "LIMIT ")) continue;
    const size_t pos = t.find(" LIMIT ");
    if (pos == string::npos) continue;
    const size_t indent = leading_space_count(lines[i]);
    lines[i] = string(indent, ' ') + t.substr(0, pos);
    lines.insert(lines.begin() + static_cast<long>(i + 1), string(indent, ' ') + t.substr(pos + 1));
    ++i;
  }
}


string format_long_enum_type_lines(string_view source) {
  const vector<string> lines = split_lines_keep(source);
  vector<string> rendered;
  rendered.reserve(lines.size() + 32);

  const auto enum_at = [](string_view line, size_t start = 0) -> size_t {
    ScanState st;
    for (size_t i = 0; i < line.size(); ++i) {
      const bool lexical = !st.in_str && !st.in_double_quote && !st.in_backtick && !st.in_line_comment && !st.in_block_comment;
      if (i >= start && lexical) {
        const bool e8 = i + 6 <= line.size() && line.substr(i, 6) == "Enum8(";
        const bool e16 = i + 7 <= line.size() && line.substr(i, 7) == "Enum16(";
        if (e8 || e16) {
          const char prev = i == 0 ? '\0' : line[i - 1];
          if (prev == '\0' || !is_ident_char(prev)) return i;
        }
      }
      step_scan(st, line, i);
    }
    return string::npos;
  };

  for (const string& line : lines) {
    const size_t enum_pos = enum_at(line);
    if (enum_pos == string::npos) {
      rendered.push_back(line);
      continue;
    }
    const size_t enum_open = line.find('(', enum_pos);
    if (enum_open == string::npos) {
      rendered.push_back(line);
      continue;
    }
    const size_t enum_close = find_matching_paren(line, enum_open);
    if (enum_close == string::npos) {
      rendered.push_back(line);
      continue;
    }
    const auto enum_items = split_top_level(line.substr(enum_open + 1, enum_close - enum_open - 1), ',');
    // Short enums are more readable inline. Long ClickHouse system enums can
    // contain dozens of values and must be one value per line.
    if (enum_items.size() < 5 && line.size() <= 100) {
      rendered.push_back(line);
      continue;
    }

    const size_t indent = leading_space_count(line);
    const string enum_name = string(line.substr(enum_pos, enum_open - enum_pos));

    // Special-case Map(Enum*, ValueType): once the enum becomes multiline the
    // containing Map must also become a structured block. Otherwise the output
    // degenerates into `Map(Enum8( ... ), UInt32)` with mismatched closers.
    size_t map_pos = string::npos;
    for (size_t search = 0;;) {
      const size_t candidate = line.find("Map(", search);
      if (candidate == string::npos || candidate >= enum_pos) break;
      map_pos = candidate;
      search = candidate + 1;
    }
    if (map_pos != string::npos) {
      const size_t map_open = line.find('(', map_pos);
      const size_t map_close = map_open == string::npos ? string::npos : find_matching_paren(line, map_open);
      if (map_close != string::npos && map_close >= enum_close) {
        const auto map_items = split_top_level(line.substr(map_open + 1, map_close - map_open - 1), ',');
        if (map_items.size() == 2) {
          int enum_arg = -1;
          for (size_t i = 0; i < map_items.size(); ++i) {
            const string item = trim_ascii_spaces(map_items[i]);
            if (starts_with_ci(item, "Enum8(") || starts_with_ci(item, "Enum16(")) {
              enum_arg = static_cast<int>(i);
              break;
            }
          }
          if (enum_arg >= 0) {
            rendered.push_back(line.substr(0, map_open + 1));
            for (size_t arg = 0; arg < map_items.size(); ++arg) {
              if (static_cast<int>(arg) == enum_arg) {
                rendered.push_back(string(indent + 4, ' ') + enum_name + "(");
                for (size_t i = 0; i < enum_items.size(); ++i) {
                  string value(indent + 8, ' ');
                  value += trim_ascii_spaces(enum_items[i]);
                  if (i + 1 < enum_items.size()) value += ',';
                  rendered.push_back(std::move(value));
                }
                string close(indent + 4, ' ');
                close += ')';
                if (arg + 1 < map_items.size()) close += ',';
                rendered.push_back(std::move(close));
              } else {
                string value(indent + 4, ' ');
                value += trim_ascii_spaces(map_items[arg]);
                if (arg + 1 < map_items.size()) value += ',';
                rendered.push_back(std::move(value));
              }
            }
            rendered.push_back(string(indent, ' ') + ")" + string(line.substr(map_close + 1)));
            continue;
          }
        }
      }
    }

    rendered.push_back(line.substr(0, enum_open + 1));
    for (size_t i = 0; i < enum_items.size(); ++i) {
      string value(indent + 4, ' ');
      value += trim_ascii_spaces(enum_items[i]);
      if (i + 1 < enum_items.size()) value += ',';
      rendered.push_back(std::move(value));
    }
    rendered.push_back(string(indent, ' ') + ")" + string(line.substr(enum_close + 1)));
  }
  return join_lines(rendered);
}

string normalize_final_layout(string_view s) {
  const string enum_formatted = format_long_enum_type_lines(s);
  vector<string> lines = split_lines_keep(align_multiline_tuple_closers(enum_formatted));
  split_long_string_alias_lines(lines);
  align_create_columns(lines);
  align_create_index_groups(lines);
  align_alias_groups(lines);
  split_combined_limit_lines(lines);
  return join_lines(lines);
}
// ---------------------------------------------------------------------------
// Redundant arithmetic parentheses.
//
// formatQuery parenthesizes every nested binary operator:
// `(a*w1 + b*w2) / (w1 + w2)` comes back as
// `((a * w1) + (b * w2)) / (w1 + w2)`. Parentheses never appear in the parsed
// AST, so a group can be dropped whenever operator precedence already implies
// the same tree. The decision uses only the tokens around the group and the
// operators directly inside it; anything unfamiliar keeps its parentheses.

enum class ArithTokenKind { Word, Number, Literal, Op, Open, Close, Comma, Comment, Other };

struct ArithToken {
  ArithTokenKind kind;
  size_t begin;
  size_t end;
};

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

constexpr int kArithBoundary = -1;  // clause keyword, separator or bracket
constexpr int kArithCompare = 9;
constexpr int kArithAdditive = 11;
constexpr int kArithMultiplicative = 12;
constexpr int kArithUnary = 13;
constexpr int kArithUnknown = -100;

// Precedence of a binary operator token; kArithUnknown for anything else.
// `||` is deliberately unknown: the parser flattens `a || b || c` into one
// concat() call, so its parentheses are not transparent.
int arith_binary_precedence(string_view op) {
  if (op == "+" || op == "-") return kArithAdditive;
  if (op == "*" || op == "/" || op == "%") return kArithMultiplicative;
  if (op == "=" || op == "==" || op == "!=" || op == "<>" || op == "<" || op == ">" || op == "<=" || op == ">=") {
    return kArithCompare;
  }
  return kArithUnknown;
}

bool arith_word_is(string_view word, std::initializer_list<const char*> words) {
  for (const char* w : words) if (iequals_ascii(word, w)) return true;
  return false;
}

string strip_redundant_arith_parentheses(string_view s) {
  const vector<ArithToken> t = lex_arith_tokens(s);
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

  // Lowest operator precedence directly inside the group (open, close);
  // kArithUnknown when the content is not a plain operator chain.
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
          ++operands;
          expect_operand = false;
          k = match[k];
          continue;
        }
        return kArithUnknown;
      }
      // Postfix forms bind tighter than any operator: calls, parametric
      // calls, subscripts and tuple/member access.
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
    // `concat((concat(a, b)), c)`: a lone operand wrapped as a whole function
    // argument is transparent. Keyword lists are not: `GROUPING SETS ((a), ())`
    // and `IN ((1), (2))` give their groups meaning.
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
    // Comparisons do not chain, so equal precedence keeps the group.
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
    // Keep a single separating space where `(` or `)` sat between tokens.
    if (t[k].kind == ArithTokenKind::Open) {
      while (cursor < s.size() && s[cursor] == ' ' && !out.empty() && (out.back() == ' ' || out.back() == '(' || out.back() == '[')) ++cursor;
    } else {
      while (!out.empty() && out.back() == ' ' && cursor < s.size() && s[cursor] == ' ') out.pop_back();
    }
  }
  out.append(s.substr(cursor));
  return out;
}

// Top-level binary operators of `s` when it is a plain operator chain
// (`a * w + b / c - f(x)`): byte ranges and precedence of each operator.
// Returns false for anything else (keywords, lambdas, `||`, `?:`, casts...).
struct ArithChainOperator {
  size_t begin;
  size_t end;
  int precedence;
};

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

// Re-indent continuation lines of an operator chain (`\n/ rhs`, `\n- rhs`)
// that sit at bracket depth 0 so they hang one level under the first operand.
// `logical` also hangs `AND` / `OR` continuations: inside an argument list a
// wrapped condition must not start its lines where the next argument starts.
string hang_operator_continuations(string value, bool logical = false) {
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

// ---------------------------------------------------------------------------
// Function-call layout by line width.
//
// The expression formatter above decides call layout without knowing the
// column its text will land on, so it explodes calls by shape (nested calls,
// lambdas, several arguments). This pass applies the width rule on the final
// text, where columns are known: a call (or array / IN list) whose one-line
// form fits on its line is joined back onto one line, outermost first, and a
// one-line call that overflows the line is exploded one argument per line.
// Both directions only move whitespace between tokens, so the parsed query is
// unchanged.

enum : unsigned char { kCallCode = 0, kCallLiteral = 1, kCallComment = 2 };

struct CallScan {
  vector<unsigned char> kind;  // per byte: code, literal/quoted name, comment
  vector<size_t> match;        // `(` / `[` in code: position of its closer
  vector<size_t> parent;       // `(` / `[` in code: innermost enclosing opener
};

CallScan scan_call_brackets(string_view s) {
  CallScan out;
  out.kind.assign(s.size(), kCallCode);
  out.match.assign(s.size(), string::npos);
  out.parent.assign(s.size(), string::npos);
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
        stack.pop_back();
      }
    }
  }
  return out;
}

// Joins a multi-line expression onto one line (one space between lines, none
// after an opener or before a closer). Empty when a line break sits inside a
// literal or a comment, where joining would change the text.
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

bool is_call_ident_char(char ch) {
  return std::isalnum(static_cast<unsigned char>(ch)) != 0 || ch == '_';
}

// Identifiers before `(` that are type constructors or keywords, not calls:
// DDL types keep their own layout, and `GROUPING SETS(`, `CODEC(` or
// `SELECT(` in a GRANT are clause syntax.
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

// What the bracket at `pos` opens, for the width pass: a call's argument
// list (`name(` or the `(args)` of a parametric `name(params)(`), an array
// literal, a tuple list after `IN`, or a tuple element of an array literal.
// `name_begin` receives where the call's name starts.
enum class CallOpener { None, Call, Array, InList, ArrayTuple };

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
    if (!is_layout_call_name(s.substr(b, pos - b))) return CallOpener::None;
    if (name_begin) *name_begin = b;
    return CallOpener::Call;
  }
  if (prev == '`' && scan.kind[pos - 1] == kCallLiteral && pos >= 2) {
    // A quoted function name, as formatQuery prints the VALUES table
    // function: `VALUES`('k String', ('a', 1), ...).
    const size_t b = s.rfind('`', pos - 2);
    if (b == string_view::npos || (b > 0 && (scan.kind[b - 1] != kCallCode || s[b - 1] == '.'))) return CallOpener::None;
    if (name_begin) *name_begin = b;
    return CallOpener::Call;
  }
  if (prev == ')' && scan.kind[pos - 1] == kCallCode) {
    // Parametric aggregate: `name(params)(` — find `name(` of the params.
    size_t open = string::npos;
    for (size_t k = pos - 1; k-- > 0;) {
      if (scan.match[k] == pos - 1) { open = k; break; }
    }
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

// `[1, 2]::Array(UInt8)` casts the literal's source text: the bytes between
// the brackets end up in the AST, so their whitespace must stay as written.
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

bool call_name_is(string_view s, size_t name_begin, size_t open, const char* name) {
  return s.substr(name_begin, open - name_begin) == name;
}

// multiIf and CASE with two or more branches read as a decision table and
// stay one branch per line whatever their width.
bool is_vertical_branch_call(string_view s, const CallScan& scan, size_t name_begin, size_t open) {
  const size_t close = scan.match[open];
  if (close == string::npos) return false;
  if (call_name_is(s, name_begin, open, "multiIf")) return count_call_arguments(s, scan, open, close) >= 5;
  if (call_name_is(s, name_begin, open, "caseWithExpression")) return count_call_arguments(s, scan, open, close) >= 6;
  return false;
}

// Joins exploded calls whose one-line form fits in `width`, outermost first.
// Regions holding comments, subqueries, window specifications or a line break
// inside a literal keep their lines. `joined_rows` (when given) receives the
// output line numbers produced by a join.
string collapse_fitting_calls(string_view text, size_t width, vector<size_t>* joined_rows = nullptr) {
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
    // Lines strictly inside a joined region are gone; the closing line of a
    // joined region lives on as the tail of its owner row and may itself end
    // with an opener (`) AND has(`).
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
    for (size_t i = starts[o]; i < line_end(k) && !blocked; ++i) {
      if (scan.kind[i] == kCallComment) blocked = true;
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

// After a join, a single projection that became one line moves back onto the
// SELECT line when it fits there, as it would have if the expression
// formatter had kept it inline: `SELECT greatest(least(x, hi), lo) AS v`.
string merge_joined_single_select_items(string_view text, const vector<size_t>& joined_rows, size_t width) {
  if (joined_rows.empty()) return string(text);
  vector<string> lines = split_lines_keep(text);
  vector<bool> drop(lines.size(), false);
  for (const size_t r : joined_rows) {
    if (r == 0 || r >= lines.size()) continue;
    const size_t head_indent = leading_space_count(lines[r - 1]);
    if (trim_ascii_spaces(lines[r - 1]) != "SELECT" || leading_space_count(lines[r]) != head_indent + 4) continue;
    if (r + 1 < lines.size() && leading_space_count(lines[r + 1]) > head_indent) continue;
    const string item = trim_ascii_spaces(lines[r]);
    if (item.empty() || item.back() == ',' || contains_top_level_comment(item) || contains_heavy_structure(item)) continue;
    string merged = rtrim_spaces(lines[r - 1]) + " " + item;
    if (utf8_width(merged) > width) continue;
    lines[r - 1] = std::move(merged);
    drop[r] = true;
  }
  vector<string> kept;
  for (size_t i = 0; i < lines.size(); ++i) if (!drop[i]) kept.push_back(std::move(lines[i]));
  return join_lines(kept);
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
  string format_function_call(string_view expr, bool force = false);
  string format_parametric_call(const string& name, string_view params_src, string_view args_part, bool force = false);
  string layout_calls_by_width(string_view text, bool allow_explode);
  vector<string> explode_overlong_line(const string& line, int depth);
  string format_arith_chain(string_view expr, bool force);
  string format_arith_operand(string_view operand, size_t block_width, bool* block);
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
  string format_optimize_table(string_view s);
  string format_row_policy(string_view s);
  string format_settings_profile(string_view s);
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
    size_t lead = 0;
    while (lead < code.size() && (code[lead] == ' ' || code[lead] == '\t')) ++lead;
    string prefix = code.substr(0, lead);
    code = prefix + normalize_code_spacing(string_view(code).substr(lead));
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
      block = reflow_block_comment(block);
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

string align_multiline_settings(string text) {
  vector<string> lines;
  size_t start = 0;
  while (start <= text.size()) {
    const size_t nl = text.find('\n', start);
    const size_t end = nl == string::npos ? text.size() : nl;
    lines.push_back(text.substr(start, end - start));
    if (nl == string::npos) break;
    start = nl + 1;
  }
  for (size_t i = 0; i < lines.size(); ++i) {
    if (!iequals_ascii(trim_ascii_spaces(lines[i]), "SETTINGS")) continue;
    size_t end = i + 1;
    size_t max_lhs = 0;
    vector<std::pair<size_t, size_t>> positions;
    while (end < lines.size() && lines[end].rfind("    ", 0) == 0) {
      string body = trim_ascii_spaces(lines[end]);
      const size_t eq = body.find('=');
      if (eq != string::npos) {
        const string lhs = rtrim_spaces(body.substr(0, eq));
        max_lhs = std::max(max_lhs, lhs.size());
        positions.push_back({end, lhs.size()});
      }
      ++end;
    }
    for (const auto& [line_index, lhs_len] : positions) {
      string body = trim_ascii_spaces(lines[line_index]);
      const size_t eq = body.find('=');
      const string lhs = rtrim_spaces(body.substr(0, eq));
      const string rhs = trim_ascii_spaces(body.substr(eq + 1));
      lines[line_index] = "    " + lhs + string(max_lhs > lhs_len ? max_lhs - lhs_len : 0, ' ') + " = " + rhs;
    }
    i = end > 0 ? end - 1 : i;
  }
  return join_lines(lines);
}

string Formatter::format(string_view s) {
  // One-line comment recovery only applies to a buffer pasted as a single
  // line, where a `--` comment visibly swallows the clauses after it. In a
  // multi-line buffer every comment ends at its newline, so comment prose such
  // as `-- rows, even when AND is set` must stay a comment: re-splitting it
  // would turn a valid query into different (or unparseable) SQL.
  const string normalized = trim_ascii_spaces(normalize_newlines(s));
  const bool one_line = normalized.find('\n') == string::npos;
  string text = trim_ascii_spaces(repair_split_clause_keywords(one_line ? repair_line_comments(normalized) : normalized));
  if (text.empty()) return text;
  if (auto values = try_format_insert_values(text); !values.empty()) return values;
  text = strip_redundant_arith_parentheses(text);
  string leading;
  text = take_leading_comments(text, &leading);
  // Calls are exploded by width only inside queries; DDL lines (columns,
  // indexes, types, grants) keep the layout of their own formatters.
  bool query = false;
  for (const char* head : {"SELECT", "WITH", "INSERT", "EXPLAIN", "CREATE VIEW", "CREATE MATERIALIZED VIEW", "CREATE OR REPLACE VIEW"}) {
    if (starts_with_ci(text, head)) query = true;
  }
  string out = format_statement(text);
  if (!leading.empty()) out = leading + "\n" + out;
  return align_multiline_settings(normalize_final_layout(layout_calls_by_width(cleanup_surface(out), query)));
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
  else if (starts_with_ci(text, "OPTIMIZE TABLE")) out = format_optimize_table(text);
  else if (starts_with_ci(text, "CREATE ROW POLICY") || starts_with_ci(text, "ALTER ROW POLICY")) out = format_row_policy(text);
  // ALTER SETTINGS PROFILE is excluded: its ADD/MODIFY/DROP SETTINGS list
  // grammar is not a plain `name = value` list and keeps the formatQuery line.
  else if (starts_with_ci(text, "CREATE SETTINGS PROFILE")) out = format_settings_profile(text);
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
  for (const char* set_operator : {"UNION ALL", "UNION DISTINCT"}) {
    if (auto parts = split_top_level_keyword(text, set_operator); !parts.empty()) {
      vector<string> rendered;
      for (const auto& part : parts) rendered.push_back(format_select_like(part));
      return join_with_keyword(rendered, set_operator);
    }
  }

  string out;
  if (starts_with_ci(text, "WITH")) {
    const int pos = find_top_level_keyword(text, "SELECT", 4);
    if (pos > 0) {
      string with_body = trim_ascii_spaces(text.substr(4, static_cast<size_t>(pos) - 4));
      string with_head = "WITH";
      if (starts_with_ci(with_body, "RECURSIVE") &&
          (with_body.size() == 9 || !is_ident_char(with_body[9]))) {
        with_head = "WITH RECURSIVE";
        with_body = trim_ascii_spaces(with_body.substr(9));
      }
      out += with_head + "\n" + indent_block(format_with_item_block(split_top_level(with_body, ',')), 4) + "\n";
      text = trim_ascii_spaces(text.substr(static_cast<size_t>(pos)));
    }
  }

  static const vector<string_view> clauses = {
      "GLOBAL ARRAY JOIN",
      "LEFT ARRAY JOIN",
      "ARRAY JOIN",
      "GROUP BY",
      "ORDER BY",
      "LIMIT BY",
      "FROM",
      "SAMPLE",
      "PREWHERE",
      "WHERE",
      "HAVING",
      "WINDOW",
      "QUALIFY",
      "LIMIT",
      "OFFSET",
      "SETTINGS",
      "INTERPOLATE",
      "INTO OUTFILE",
      "FORMAT",
  };
  // Find every top-level occurrence. Repeated ARRAY JOIN clauses are legal and
  // must remain distinct instead of being absorbed into the first clause body.
  vector<std::pair<int, string>> poses = find_select_clauses(text, 6, clauses);
  // Keywords that are clause heads elsewhere are ordinary tokens inside some
  // clauses: `ORDER BY x WITH FILL FROM a TO b`, `SAMPLE 1/10 OFFSET 1/2`.
  for (size_t i = 1; i < poses.size();) {
    const string& previous = poses[i - 1].second;
    const string& current = poses[i].second;
    if ((iequals_ascii(current, "FROM") && iequals_ascii(previous, "ORDER BY")) ||
        (iequals_ascii(current, "OFFSET") && iequals_ascii(previous, "SAMPLE"))) {
      poses.erase(poses.begin() + static_cast<long>(i));
      continue;
    }
    ++i;
  }

  const size_t select_end = poses.empty() ? text.size() : static_cast<size_t>(poses.front().first);
  const string select_body = trim_ascii_spaces(text.substr(6, select_end - 6));
  const auto items = split_top_level(select_body, ',');
  auto [single_expr_for_alias, single_alias_for_alias] = items.size() == 1 ? split_top_level_as(items.front()) : std::pair<string,string>{string(), string()};
  const bool single_simple_alias = items.size() == 1 && !single_alias_for_alias.empty() &&
                                   single_expr_for_alias.find('\n') == string::npos &&
                                   single_expr_for_alias.size() + single_alias_for_alias.size() + 8 <= threshold &&
                                   !contains_heavy_structure(single_expr_for_alias);
  if (items.size() == 1 && select_body.find('\n') == string::npos && select_body.size() <= threshold &&
      (!contains_heavy_structure(items.front()) || single_simple_alias)) {
    string single = single_simple_alias
      ? format_expression(single_expr_for_alias) + " AS " + format_alias_identifier(single_alias_for_alias)
      : format_expression(items.front());
    // Only a one-line item shares the SELECT line; a call that needs several
    // lines goes into the indented block like any projection list, instead of
    // hanging its arguments and `)` under `SELECT`.
    if (single.find('\n') == string::npos) out += "SELECT " + single;
    else out += "SELECT\n" + indent_block(format_item_block(items, true), 4);
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
    const size_t indent = leading_space_count(s.substr(start, end - start));
    auto [code, comment] = split_inline_comment(line);
    string prefix;
    string rest = code;
    if (starts_with_ci(rest, "AND ") || starts_with_ci(rest, "OR ")) {
      const size_t cut = starts_with_ci(rest, "AND ") ? 4 : 3;
      prefix = rest.substr(0, cut);
      rest = trim_ascii_spaces(rest.substr(cut));
    }
    if (const string inner = unwrap_outer_parens(rest); !inner.empty() && find_top_level_keyword(inner, "AND") < 0 && find_top_level_keyword(inner, "OR") < 0) rest = trim_ascii_spaces(inner);
    line = string(indent, ' ') + trim_ascii_spaces(prefix + rest);
    if (!comment.empty()) line += " " + comment;
    lines.push_back(line);
    if (nl == string::npos) break;
    start = nl + 1;
  }
  return join_lines(lines);
}

string Formatter::format_clause(string_view kw, string_view body) {
  if (iequals_ascii(kw, "FROM")) return format_from_clause(body);
  if (iequals_ascii(kw, "ARRAY JOIN") || iequals_ascii(kw, "GLOBAL ARRAY JOIN") || iequals_ascii(kw, "LEFT ARRAY JOIN")) {
    const auto items = split_top_level(body, ',');
    if (items.size() == 1 && trim_ascii_spaces(body).find('\n') == string::npos) {
      auto [expr, alias] = split_top_level_as(items.front());
      if (!alias.empty()) return string(kw) + " " + format_expression(expr) + " AS " + format_alias_identifier(alias);
      return string(kw) + " " + format_expression(items.front());
    }
    return string(kw) + "\n" + indent_block(format_simple_item_block(items), 4);
  }
  if (iequals_ascii(kw, "WHERE") || iequals_ascii(kw, "PREWHERE") || iequals_ascii(kw, "HAVING") || iequals_ascii(kw, "QUALIFY")) {
    const string cond = format_bool_expr(body);
    const bool has_bool_ops = find_top_level_keyword(body, "AND") >= 0 || find_top_level_keyword(body, "OR") >= 0;
    if (!has_bool_ops) {
      if (cond.find('\n') == string::npos) return string(kw) + " " + cond;
      if (cond.find(" IN (\n") != string::npos || cond.find(" GLOBAL IN (\n") != string::npos) return string(kw) + " " + cond;
      if (starts_with_ci(cond, "exists(\n")) return string(kw) + " " + indent_after_first_line(cond, 4);
      if (starts_with_ci(cond, "--")) return string(kw) + " " + indent_after_first_line(dedent_after_first_line(cond), 4);
      return string(kw) + " " + indent_after_first_line(cond, 4);
    }
    string rendered = cond;
    if (body.find("--") != string::npos || body.find('#') != string::npos) {
      const string inner = unwrap_outer_parens(rendered);
      if (!inner.empty() && inner.find('\n') != string::npos) rendered = "(\n" + indent_block(normalize_boolean_lines(inner), 4) + "\n)";
    }
    // A wrapped arithmetic term hangs under its own condition line.
    return string(kw) + "\n" + indent_block(hang_operator_continuations(rendered), 4);
  }
  if (iequals_ascii(kw, "LIMIT") || iequals_ascii(kw, "OFFSET") || iequals_ascii(kw, "SAMPLE")) {
    // formatQuery prints `LIMIT n\n WITH TIES`; keep these clauses on one line.
    return string(kw) + " " + collapse_whitespace(cleanup_surface(body));
  }
  if (iequals_ascii(kw, "GROUP BY") || iequals_ascii(kw, "ORDER BY") || iequals_ascii(kw, "WINDOW")) {
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
    if (iequals_ascii(kw, "GROUP BY") && starts_with_ci(base, "GROUPING SETS")) {
      const size_t open = base.find('(');
      const size_t close = open == string::npos ? string::npos : find_matching_paren(base, open);
      if (close != string::npos && trim_ascii_spaces(base.substr(close + 1)).empty()) {
        const auto sets = split_top_level(base.substr(open + 1, close - open - 1), ',');
        string block;
        for (size_t i = 0; i < sets.size(); ++i) {
          block += "        " + collapse_whitespace(cleanup_surface(trim_ascii_spaces(sets[i])));
          block += i + 1 < sets.size() ? ",\n" : "\n";
        }
        string out = string(kw) + "\n    GROUPING SETS (\n" + block + "    )";
        if (!suffix.empty()) out += " " + suffix;
        return out;
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
  if (iequals_ascii(kw, "SETTINGS")) {
    const auto items = split_top_level(body, ',');
    if (items.size() == 1 && trim_ascii_spaces(body).find('\n') == string::npos) return string(kw) + " " + cleanup_surface(body);
    return string(kw) + "\n" + indent_block(format_simple_item_block(items), 4);
  }
  if (iequals_ascii(kw, "FORMAT")) {
    return string(kw) + " " + collapse_whitespace(cleanup_surface(body));
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
            // formatQuery prints locality/strictness/kind modifiers before the
            // matched keyword (`GLOBAL ANY LEFT JOIN`, `SEMI LEFT JOIN`,
            // `ASOF LEFT JOIN`, `FULL OUTER JOIN`, `PASTE JOIN`). They belong
            // to the join keyword, not to the preceding table expression.
            size_t kw_begin = i;
            for (;;) {
              size_t end = kw_begin;
              while (end > start && std::isspace(static_cast<unsigned char>(s[end - 1]))) --end;
              size_t begin = end;
              while (begin > start && is_ident_char(s[begin - 1])) --begin;
              if (begin == end || (begin > start && !std::isspace(static_cast<unsigned char>(s[begin - 1])))) break;
              static const char* modifiers[] = {"GLOBAL", "LOCAL", "ANY", "ALL", "ASOF", "SEMI", "ANTI",
                                                "OUTER", "LEFT", "RIGHT", "FULL", "INNER", "PASTE"};
              const string_view word = s.substr(begin, end - begin);
              bool modifier = false;
              for (const char* m : modifiers) modifier = modifier || iequals_ascii(word, m);
              if (!modifier || previous_word_is_as(s, begin)) break;
              kw_begin = begin;
            }
            parts.push_back({trim_ascii_spaces(s.substr(start, kw_begin - start)), last_kw});
            last_kw = collapse_whitespace(s.substr(kw_begin, i + kw.size() - kw_begin));
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
    // Same layout as a join-free FROM: a multiline (subquery) source opens on
    // its own line, `FROM\n(`.
    const string first_source = format_table_source(joins.front().first);
    string out = first_source.find('\n') == string::npos ? "FROM " + first_source : "FROM\n" + first_source;
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
  auto [base_part, alias_part] = split_top_level_as(text);
  const string base = alias_part.empty() ? text : base_part;
  const string alias = alias_part;
  const string inner = unwrap_outer_parens(base);
  if (inner.empty() || !looks_like_query(inner)) return {};
  string out = "(\n" + indent_block(format_statement(inner), 4) + "\n)";
  if (!alias.empty()) out += " AS " + trim_ascii_spaces(alias);
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
      const bool table_like = query_returns_table_like_cte(lhs_inner);
      parsed.push_back({{}, rhs_trim, lhs_inner, !table_like, table_like});
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
      if (parsed[i].expr.empty()) item = "(\n" + indent_block(format_statement(parsed[i].query), 4) + "\n) AS " + trim_ascii_spaces(parsed[i].alias);
      else item = parsed[i].expr + " AS\n(\n" + indent_block(format_statement(parsed[i].query), 4) + "\n)";
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

string normalize_aliased_operator_continuations(string value) {
  const string masked = mask_sql_surface(value).code_lower;
  vector<int> line_depths{0};
  int paren = 0;
  int bracket = 0;
  int brace = 0;
  for (char ch : masked) {
    if (ch == '(') ++paren;
    else if (ch == ')' && paren > 0) --paren;
    else if (ch == '[') ++bracket;
    else if (ch == ']' && bracket > 0) --bracket;
    else if (ch == '{') ++brace;
    else if (ch == '}' && brace > 0) --brace;
    if (ch == '\n') line_depths.push_back(paren + bracket + brace);
  }

  auto lines = split_lines_keep(value);
  for (size_t i = 1; i < lines.size() && i < line_depths.size(); ++i) {
    if (line_depths[i] != 0) continue;
    size_t content = 0;
    while (content < lines[i].size() && (lines[i][content] == ' ' || lines[i][content] == '\t')) ++content;
    const bool binary_continuation = content + 1 < lines[i].size() &&
        (lines[i][content] == '-' || lines[i][content] == '/' ||
         lines[i][content] == '+' || lines[i][content] == '*') &&
        lines[i][content + 1] == ' ';
    if (binary_continuation) lines[i].replace(0, content, 4, ' ');
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
      expr = normalize_aliased_operator_continuations(std::move(expr));
      ++aliased_count;
      const size_t line_width = last_line_length(expr);
      width = std::max(width, line_width);
      min_width = std::min(min_width, line_width);
      if (expr.find('\n') != string::npos) can_align = false;
    }
    parsed.push_back({std::move(expr), std::move(alias)});
  }
  can_align = can_align && aliased_count >= 2 && width > min_width;
  vector<string> lines;
  for (size_t i = 0; i < parsed.size(); ++i) {
    string item = parsed[i].first;
    if (!parsed[i].second.empty()) {
      const string alias = format_alias_identifier(parsed[i].second);
      // The alias itself can push an arithmetic item over the width.
      if (item.find('\n') == string::npos && utf8_width(item) + utf8_width(alias) + 4 > threshold) {
        if (string chain = format_arith_chain(item, true); !chain.empty()) {
          item = normalize_aliased_operator_continuations(std::move(chain));
        }
      }
      if (can_align) item += string((width > last_line_length(item) ? width - last_line_length(item) : 0) + 2, ' ') + "AS " + alias;
      else {
        item += " AS " + alias;
      }
    }
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
          if (!inner.empty() && !looks_like_query(inner) && split_top_level(inner, ',').size() == 1) {
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
  // Window frame: ROWS or RANGE (formatQuery always prints the BETWEEN form).
  string frame_kw = "ROWS BETWEEN";
  int rows_pos = find_top_level_keyword(inner, frame_kw);
  if (const int range_pos = find_top_level_keyword(inner, "RANGE BETWEEN");
      range_pos >= 0 && (rows_pos < 0 || range_pos < rows_pos)) {
    rows_pos = range_pos;
    frame_kw = "RANGE BETWEEN";
  }
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
    const string body = trim_ascii_spaces(inner.substr(static_cast<size_t>(rows_pos) + frame_kw.size()));
    lines.push_back(frame_kw + " " + cleanup_surface(body));
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

string Formatter::format_function_call(string_view expr, bool force) {
  const string s = trim_ascii_spaces(expr);
  const size_t par = s.find('(');
  if (par == string::npos || !ends_with_ci(s, ")")) return {};
  const string name = trim_ascii_spaces(s.substr(0, par));
  if (name.empty()) return {};
  for (char ch : name) if (!is_ident_char(ch)) return {};
  if (const size_t params_close = find_matching_paren(s, par);
      params_close != string::npos && params_close + 1 < s.size() && s[params_close + 1] == '(' &&
      find_matching_paren(s, params_close + 1) == s.size() - 1) {
    return format_parametric_call(name, s.substr(par + 1, params_close - par - 1), s.substr(params_close + 1), force);
  }
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
  auto compact_source_args = [&]() {
    string compact = name + "(";
    for (size_t i = 0; i < args.size(); ++i) {
      if (i) compact += ", ";
      compact += cleanup_surface(args[i]);
    }
    compact += ")";
    return compact;
  };

  if (!force && iequals_ascii(name, "arrayFilter") && args.size() >= 2) {
    string compact = compact_source_args();
    const int arrow = find_top_level_arrow(args.front());
    string rhs = arrow > 0 ? trim_ascii_spaces(string_view(args.front()).substr(static_cast<size_t>(arrow) + 2)) : string();
    if (const string inner_rhs = unwrap_outer_parens(rhs); !inner_rhs.empty()) rhs = inner_rhs;
    if (compact.size() <= wrap_threshold && !rhs.empty() && rhs.find('(') == string::npos &&
        find_top_level_keyword(rhs, "AND") < 0 && find_top_level_keyword(rhs, "OR") < 0) {
      return compact;
    }
  }

  if (!force && s.find('\n') == string::npos) {
    string compact = compact_source_args();
    const bool compact_fits = compact.size() <= wrap_threshold;
    if (compact_fits && (iequals_ascii(name, "CAST") || iequals_ascii(name, "roundBankers") ||
        iequals_ascii(name, "toString") || iequals_ascii(name, "concat") ||
        (iequals_ascii(name, "coalesce") && raw_args.size() <= 2) ||
        (starts_with_ci(name, "JSONExtract") && raw_args.size() <= 3) ||
        iequals_ascii(name, "arrayCount"))) {
      return {};
    }
    if (compact_fits && iequals_ascii(name, "arrayFilter") && args.size() >= 2) {
      const int arrow = find_top_level_arrow(args.front());
      string rhs = arrow > 0 ? trim_ascii_spaces(string_view(args.front()).substr(static_cast<size_t>(arrow) + 2)) : string();
      if (!rhs.empty() && rhs.find('(') == string::npos && find_top_level_keyword(rhs, "AND") < 0 && find_top_level_keyword(rhs, "OR") < 0) return {};
    }
  }

  bool multiline = force || s.find('\n') != string::npos || iequals_ascii(name, "multiIf") || iequals_ascii(name, "map") ||
                   iequals_ascii(name, "dictGet") || iequals_ascii(name, "dictGetOrDefault") ||
                   iequals_ascii(name, "arrayZip") || looks_like_query(inner) || s.size() > wrap_threshold;
  if (!multiline && raw_args.size() >= 3 &&
      !iequals_ascii(name, "tuple") && !iequals_ascii(name, "tupleElement") &&
      !iequals_ascii(name, "toDate") && !iequals_ascii(name, "toDateTime") &&
      !iequals_ascii(name, "toDateTime64") && !iequals_ascii(name, "DateTime64") &&
      !iequals_ascii(name, "Decimal")) multiline = true;
  if (!multiline && raw_args.size() >= 2) {
    for (const auto& raw_arg : raw_args) {
      const string a = trim_ascii_spaces(raw_arg);
      if (a.find("->") != string::npos || a.find('\n') != string::npos || a.find('(') != string::npos ||
          a.find('[') != string::npos || find_top_level_keyword(a, "AND") >= 0 || find_top_level_keyword(a, "OR") >= 0) {
        if (!iequals_ascii(name, "arrayMap") || s.size() > wrap_threshold || a.find("array") != string::npos || a.find('\n') != string::npos) multiline = true;
      }
    }
  }
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
    // A condition argument (`if(c, ...)`, `sumIf(x, c)`, `countIf(a AND b)`)
    // is laid out like a WHERE condition, which also drops the parentheses
    // formatQuery puts around each operand, and joined back onto one line
    // when that line is short enough.
    const bool condition = (iequals_ascii(name, "if") && i == 0) ||
        (find_top_level_arrow(args[i]) < 0 && !looks_like_query(args[i]) && !contains_top_level_comment(args[i]) &&
         (find_top_level_keyword(args[i], "AND") >= 0 || find_top_level_keyword(args[i], "OR") >= 0));
    if (condition) {
      string cond = format_bool_expr(args[i]);
      if (cond.find('\n') != string::npos) {
        const string compact = join_code_lines(cond);
        if (!compact.empty() && utf8_width(compact) + 8 <= wrap_threshold) cond = compact;
      }
      rendered.push_back(cond);
    } else rendered.push_back(format_expression(args[i]));
  }

  if (iequals_ascii(name, "arrayMin") && args.size() == 1 && trim_ascii_spaces(args.front()).find("arrayMap(") != string::npos && trim_ascii_spaces(args.front()).find("tupleElement") != string::npos) {
    multiline = true;
  }

  if (args.size() == 1) {
    const int slash = find_top_level_operator(args.front(), '/');
    const string compact = name + "(" + rendered.front() + ")";
    const bool heavy_one = contains_heavy_structure(args.front()) || slash >= 0;
    if (slash > 0 && (multiline || compact.size() + 8 > wrap_threshold || args.front().find('\n') != string::npos || rendered.front().find('\n') != string::npos)) {
      if (string chain = format_arith_chain(args.front(), true); !chain.empty()) rendered.front() = std::move(chain);
    }
    if (!multiline) multiline = rendered.front().find('\n') != string::npos || (compact.size() + 8 > wrap_threshold && heavy_one);
  }

  if (!multiline) {
    // An inline call still carries its formatted arguments, so a condition
    // nested in it (`nullIf(countIf((a = 1) AND (b = 2)), 0)`) loses the
    // operand parentheses formatQuery added, as it would in an exploded call.
    string inline_call = name + "(";
    for (size_t i = 0; i < rendered.size(); ++i) {
      if (rendered[i].find('\n') != string::npos || (i < comments_after.size() && !comments_after[i].empty())) return {};
      if (i) inline_call += ", ";
      inline_call += rendered[i];
    }
    inline_call += ")";
    return inline_call == s ? string() : inline_call;
  }

  string out = name + "(\n";
  if (iequals_ascii(name, "multiIf") && rendered.size() >= 3) {
    for (size_t i = 0; i + 1 < rendered.size(); i += 2) {
      if (i + 1 == rendered.size() - 1) break;
      out += "    " + rendered[i] + ", " + rendered[i + 1] + ",\n";
    }
    out += "    " + rendered.back() + "\n)";
    return out;
  }
  // `CASE x WHEN ... END` reaches us as caseWithExpression(x, w1, t1, ..., else):
  // the operand keeps its own line, then one `when, then` pair per line.
  if (iequals_ascii(name, "caseWithExpression") && rendered.size() >= 4 && rendered.size() % 2 == 0) {
    out += "    " + rendered.front() + ",\n";
    for (size_t i = 1; i + 1 < rendered.size(); i += 2) out += "    " + rendered[i] + ", " + rendered[i + 1] + ",\n";
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
    // Among several arguments an unindented `/ rhs` line would read as the
    // next argument; a sole argument keeps its operators aligned.
    out += indent_block(rendered.size() > 1 ? hang_operator_continuations(rendered[i], true) : rendered[i], 4);
    if (i + 1 < rendered.size()) out += ',';
    if (i < comments_after.size() && !comments_after[i].empty()) out += " " + comments_after[i];
    out += '\n';
  }
  out += ')';
  return out;
}

// Parametric aggregates `name(params)(args)` (windowFunnel(3600)(...),
// quantiles(0.5, 0.9)(x), sequenceMatch('(?1)(?2)')(t, c1, c2)): both lists
// follow the ordinary function-call rules. The argument list is laid out as a
// call whose head is the whole `name(params)` prefix, so it wraps exactly when
// a plain call of the same length would; the parameter list goes vertical only
// when the head alone does not fit.
string Formatter::format_parametric_call(const string& name, string_view params_src, string_view args_part, bool force) {
  const size_t wrap_threshold = std::min<size_t>(threshold, 80);
  const auto params = split_top_level(params_src, ',');
  string head = name + "(";
  for (size_t i = 0; i < params.size(); ++i) {
    if (i) head += ", ";
    head += cleanup_surface(trim_ascii_spaces(params[i]));
  }
  head += ")";
  const bool multiline_params = head.size() + 1 > wrap_threshold || params_src.find('\n') != string_view::npos;
  // Same-width stand-in for the head: format_function_call only accepts an
  // identifier before the argument list.
  string stand_in(head.size(), 'P');
  if (multiline_params) {
    string block;
    for (size_t i = 0; i < params.size(); ++i) {
      block += indent_block(format_expression(params[i]), 4);
      if (i + 1 < params.size()) block += ',';
      block += '\n';
    }
    head = name + "(\n" + block + ")";
    stand_in = "P";
  }
  const string args_rendered = format_function_call(stand_in + string(args_part), force);
  if (args_rendered.empty()) {
    if (!multiline_params) return {};
    return head + cleanup_surface(args_part);
  }
  return head + args_rendered.substr(stand_in.size());
}

// Long arithmetic wraps at the operators of its lowest precedence level, one
// operand per line with the operator leading (`a * w\n+ b * w\n+ c * w`), so
// the grouping the parser applies is visible from the layout. Operands keep
// their own structure: a parenthesized operand that is itself too long opens
// a block. Continuation lines are returned unindented; the enclosing context
// (SELECT item, WHERE term, function argument) decides how far they hang.
string Formatter::format_arith_chain(string_view expr, bool force) {
  const string s = trim_ascii_spaces(expr);
  vector<ArithChainOperator> ops;
  if (!split_arith_chain(s, &ops)) return {};
  int lowest = kArithMultiplicative;
  for (const auto& op : ops) lowest = std::min(lowest, op.precedence);
  vector<string> operands;
  vector<string> operators;
  size_t start = 0;
  for (const auto& op : ops) {
    if (op.precedence != lowest) continue;
    operands.push_back(trim_ascii_spaces(string_view(s).substr(start, op.begin - start)));
    operators.push_back(s.substr(op.begin, op.end - op.begin));
    start = op.end;
  }
  operands.push_back(trim_ascii_spaces(string_view(s).substr(start)));
  vector<string> rendered;
  vector<bool> blocks;
  bool multiline = force || s.find('\n') != string::npos || utf8_width(s) > threshold;
  bool any_block = false;
  for (const auto& operand : operands) {
    bool block = false;
    rendered.push_back(format_arith_operand(operand, threshold, &block));
    blocks.push_back(block);
    any_block = any_block || block;
    // Short chains stay inline even when an operand alone would expand (a
    // three-argument call); heavy operands (lambdas, subqueries) never do.
    if (operand.find('\n') != string::npos || contains_heavy_structure(operand)) multiline = true;
  }
  if (!multiline) return {};
  // Sibling groups read alike: once one operand opened a block, other long
  // parenthesized chains open theirs too (`(\n...\n) / (\n...\n)`).
  if (any_block) {
    for (size_t i = 0; i < operands.size(); ++i) {
      if (blocks[i]) continue;
      bool block = false;
      string again = format_arith_operand(operands[i], threshold / 2, &block);
      if (block) {
        rendered[i] = std::move(again);
        blocks[i] = true;
      }
    }
  }
  string out = rendered.front();
  for (size_t i = 0; i < operators.size(); ++i) {
    // After a closing block the operator continues on the `)` line, as `) AS`
    // does for a multiline call; otherwise it leads the next line.
    out += (blocks[i] ? " " : "\n") + operators[i] + " " + rendered[i + 1];
  }
  return out;
}

string Formatter::format_arith_operand(string_view operand, size_t block_width, bool* block) {
  const string s = trim_ascii_spaces(operand);
  // `(a * w + b * w + ...)` too long for one line: open a block and wrap the
  // chain inside it at the same rules.
  if (const string inner = unwrap_outer_parens(s); !inner.empty() && s.find('\n') == string::npos &&
      utf8_width(s) + 8 > block_width) {
    if (const string chain = format_arith_chain(inner, true); !chain.empty()) {
      if (block) *block = true;
      return "(\n" + indent_block(chain, 4) + "\n)";
    }
  }
  return format_expression(s);
}

string Formatter::format_expression(string_view expr) {
  string s = trim_ascii_spaces(expr);
  if (s.empty()) return s;
  if (contains_top_level_comment(s)) {
    // A comment that trails the previous list item arrives at the head of
    // this one (`-- note\n    f(\n        x\n    )`). The code after it is
    // formatted normally: kept verbatim, its input indentation would be
    // indented again on every pass.
    string lead;
    string rest;
    if (starts_with_ci(s, "/*")) {
      if (const size_t end = s.find("*/"); end != string::npos && s.find('\n', end) != string::npos &&
          trim_ascii_spaces(string_view(s).substr(end + 2, s.find('\n', end) - end - 2)).empty()) {
        lead = s.substr(0, end + 2);
        rest = trim_ascii_spaces(string_view(s).substr(end + 2));
      }
    } else {
      std::tie(lead, rest) = split_leading_line_comment(s);
    }
    if (!lead.empty() && !rest.empty()) return lead + "\n" + format_expression(rest);
    return cleanup_surface(s);
  }
  if (!s.empty() && s.front() == '(') {
    const size_t close = find_matching_paren(s, 0);
    if (close != string::npos && close + 1 < s.size() && s[close + 1] == '.') {
      const string inner = trim_ascii_spaces(s.substr(1, close - 1));
      // Only an atom may lose its parentheses before `.`: `(x + 1).1` is
      // tupleElement(x + 1, 1), while `x + 1.1` adds a float.
      bool atom = !inner.empty();
      ScanState st;
      for (size_t k = 0; atom && k < inner.size(); ++k) {
        if (is_top_level(st) && (inner[k] == ' ' || inner[k] == '\n')) atom = false;
        step_scan(st, inner, k);
      }
      if (atom && !looks_like_query(inner)) {
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
      if (grouped_rhs) {
        rhs = "(\n" + indent_block(rhs, 4) + "\n)";
      } else {
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
    // `x -> (a, b)` returns a tuple: its parentheses are the tuple, not a
    // grouping, and dropping them would make `b` the next function argument.
    if (const string inner = unwrap_outer_parens(rhs); !inner.empty() && !looks_like_query(inner) && find_top_level_keyword(inner, "AND") < 0 &&
        find_top_level_keyword(inner, "OR") < 0 && split_top_level(inner, ',').size() == 1) rhs = trim_ascii_spaces(inner);
    return lhs + " -> " + rhs;
  }
  if (auto over = format_over_clause(s); !over.empty()) s = over;
  if (auto arr = format_array_literal(s); !arr.empty()) s = arr;
  if (auto fn = format_function_call(s); !fn.empty()) s = fn;

  if (auto chain = format_arith_chain(s, false); !chain.empty()) return chain;

  if (auto in_literal = format_in_literal(s); !in_literal.empty()) s = in_literal;
  s = strip_atomic_parentheses(s);
  string op;
  if (const int cmp = find_top_level_comparator(s, &op); cmp > 0) {
    auto strip_side = [this](string side) {
      const string inner = unwrap_outer_parens(side);
      if (inner.empty()) return strip_atomic_parentheses(side);
      if (find_top_level_keyword(inner, "AND") >= 0 || find_top_level_keyword(inner, "OR") >= 0 || split_top_level(inner, ',').size() > 1) return side;
      if (find_top_level_keyword(inner, "SELECT") >= 0 || find_top_level_keyword(inner, "IN") >= 0) return side;
      // `(a > b) = (c > d)`: comparisons chain left to right, so a
      // parenthesized comparison beside another comparator is load-bearing.
      if (find_top_level_comparator(inner, nullptr) >= 0) return side;
      const string collapsed = collapse_whitespace(inner);
      if (starts_with_ci(collapsed, "now() - toInterval") || starts_with_ci(collapsed, "now() + toInterval")) return collapsed;
      if (inner.find('/') != string::npos || inner.find('*') != string::npos || inner.find('+') != string::npos || inner.find('-') != string::npos) return side;
      return trim_ascii_spaces(inner);
    };
    string lhs = strip_side(trim_ascii_spaces(s.substr(0, static_cast<size_t>(cmp))));
    string rhs = strip_side(trim_ascii_spaces(s.substr(static_cast<size_t>(cmp) + op.size())));
    // A comparison too long for one line wraps the arithmetic on either side
    // (left side first); the continuation hangs under the comparison.
    if (s.find('\n') == string::npos && utf8_width(lhs) + utf8_width(rhs) + op.size() + 2 > threshold) {
      if (string chain = format_arith_chain(lhs, true); !chain.empty()) lhs = std::move(chain);
      else if (string rchain = format_arith_chain(rhs, true); !rchain.empty()) rhs = std::move(rchain);
      else if (string call = format_function_call(lhs); !call.empty()) lhs = std::move(call);
    }
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
        // A long value list on the right is split by the width pass, one
        // value per line; the tuple on the left stays whole.
        if (right.size() > left.size() && left.find('\n') == string::npos) return {};
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
        // Keep the relative indentation of deeper groups: `(a OR (b AND c))`.
        const size_t nested_indent = leading_space_count(line);
        auto [code, inline_comment] = split_inline_comment(trim_ascii_spaces(line));
        string prefix;
        string rest = code;
        if (starts_with_ci(rest, "AND ") || starts_with_ci(rest, "OR ")) {
          const size_t cut = starts_with_ci(rest, "AND ") ? 4 : 3;
          prefix = rest.substr(0, cut);
          rest = trim_ascii_spaces(rest.substr(cut));
        }
        rest = strip_atomic_parentheses(rest);
        line = string(nested_indent, ' ') + trim_ascii_spaces(prefix + trim_ascii_spaces(rest));
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

string format_comma_clause_body(string_view body, bool align_equals) {
  auto parts = split_top_level(body, ',');
  vector<string> items;
  for (const auto& raw : parts) {
    const string item = normalize_code_spacing(trim_ascii_spaces(raw));
    if (!item.empty()) items.push_back(item);
  }
  if (items.size() <= 1) return items.empty() ? string{} : items.front();

  vector<size_t> eq_positions(items.size(), string::npos);
  size_t max_lhs = 0;
  if (align_equals) {
    for (size_t idx = 0; idx < items.size(); ++idx) {
      ScanState st;
      for (size_t i = 0; i < items[idx].size(); ++i) {
        if (is_top_level(st) && items[idx][i] == '=') { eq_positions[idx] = i; break; }
        step_scan(st, items[idx], i);
      }
      if (eq_positions[idx] != string::npos) {
        const string lhs = rtrim_spaces(items[idx].substr(0, eq_positions[idx]));
        max_lhs = std::max(max_lhs, lhs.size());
      }
    }
  }

  string out;
  for (size_t idx = 0; idx < items.size(); ++idx) {
    string rendered = items[idx];
    if (align_equals && eq_positions[idx] != string::npos) {
      const string lhs = rtrim_spaces(items[idx].substr(0, eq_positions[idx]));
      const string rhs = trim_ascii_spaces(items[idx].substr(eq_positions[idx] + 1));
      rendered = lhs + string(max_lhs > lhs.size() ? max_lhs - lhs.size() : 0, ' ') + " = " + rhs;
    }
    out += "    " + rendered;
    if (idx + 1 < items.size()) out += ',';
    if (idx + 1 < items.size()) out += '\n';
  }
  return "\n" + out;
}

// One TTL element (`expr [action] [WHERE cond]`). A conditional element that
// does not fit is split like a WHERE clause, one condition per line, so a long
// retention rule reads the same way as the filters used everywhere else.
string format_ttl_element(string_view raw, size_t width) {
  const string element = normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(raw)));
  const int where_pos = find_top_level_keyword(element, "WHERE");
  if (where_pos <= 0 || utf8_width(element) <= width) return element;
  const string head = rtrim_spaces(element.substr(0, static_cast<size_t>(where_pos)));
  const string cond = trim_ascii_spaces(element.substr(static_cast<size_t>(where_pos) + 5));
  string kw = "AND";
  auto parts = split_top_level_keyword(cond, kw);
  if (parts.empty()) {
    kw = "OR";
    parts = split_top_level_keyword(cond, kw);
  }
  if (parts.empty()) return head + "\nWHERE " + cond;
  string out = head + "\nWHERE";
  for (size_t i = 0; i < parts.size(); ++i) {
    string part = trim_ascii_spaces(parts[i]);
    // formatQuery wraps every AND operand in parentheses; they are redundant
    // unless the operand is itself a boolean chain.
    if (const string inner = unwrap_outer_parens(part); !inner.empty() &&
        find_top_level_keyword(inner, "AND") < 0 && find_top_level_keyword(inner, "OR") < 0) {
      part = trim_ascii_spaces(inner);
    }
    out += "\n    " + (i ? kw + " " : string()) + part;
  }
  return out;
}

// TTL lists: one element per line when there are several, or when the single
// element does not fit on the `TTL` line (DDL lines follow the line width like
// every other statement).
string format_ttl_list(string_view head_kw, string_view body, size_t threshold) {
  vector<string> elements;
  for (const auto& raw : split_top_level(body, ',')) {
    const string element = trim_ascii_spaces(raw);
    if (!element.empty()) elements.push_back(element);
  }
  if (elements.empty()) return string(head_kw);
  const string compact = string(head_kw) + " " + normalize_code_spacing(collapse_whitespace(elements.front()));
  if (elements.size() == 1 && utf8_width(compact) <= threshold) return compact;
  string out(head_kw);
  for (size_t i = 0; i < elements.size(); ++i) {
    out += "\n" + indent_block(format_ttl_element(elements[i], threshold > 4 ? threshold - 4 : threshold), 4);
    if (i + 1 < elements.size()) out += ',';
  }
  return out;
}

string format_table_tail_clauses(string_view tail, size_t threshold) {
  string text = normalize_code_spacing(trim_ascii_spaces(tail));
  if (text.empty()) return {};
  static const char* clauses[] = {"ENGINE", "PARTITION BY", "ORDER BY", "TTL", "SETTINGS"};
  vector<std::pair<int, string>> poses;
  for (const char* kw : clauses) {
    const int pos = find_top_level_keyword(text, kw);
    if (pos >= 0) poses.push_back({pos, kw});
  }
  if (poses.empty()) return collapse_whitespace(text);
  std::sort(poses.begin(), poses.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
  string out;
  for (size_t i = 0; i < poses.size(); ++i) {
    const size_t start = static_cast<size_t>(poses[i].first);
    const size_t body_start = start + poses[i].second.size();
    const size_t end = (i + 1 < poses.size()) ? static_cast<size_t>(poses[i + 1].first) : text.size();
    string body = trim_ascii_spaces(text.substr(body_start, end - body_start));
    if (!out.empty()) out += '\n';
    if (poses[i].second == "ENGINE") {
      if (!body.empty() && body.front() == '=') body = trim_ascii_spaces(body.substr(1));
      out += "ENGINE = " + body;
    } else if (poses[i].second == "SETTINGS") {
      const string formatted = format_comma_clause_body(body, true);
      out += "SETTINGS";
      if (!formatted.empty()) out += formatted.front() == '\n' ? formatted : " " + formatted;
    } else if (poses[i].second == "TTL") {
      out += format_ttl_list("TTL", body, threshold);
    } else {
      out += poses[i].second;
      if (!body.empty()) out += " " + body;
    }
  }
  return out;
}

// `CREATE MATERIALIZED VIEW name REFRESH ... DEPENDS ON ... APPEND TO target`
// easily exceeds the line width on one line. When it does, every head clause
// starts its own line, like the clauses of the query that follows.
string split_view_head_clauses(string_view raw, size_t threshold) {
  const string head = normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(raw)));
  if (utf8_width(head) + 3 <= threshold) return head;
  vector<int> starts;
  for (const char* kw : {"REFRESH", "DEPENDS ON", "SETTINGS", "APPEND", "TO"}) {
    int pos = find_top_level_keyword(head, kw);
    // `APPEND TO target` is one clause: the TO belongs to APPEND.
    if (pos > 0 && string_view(kw) == "TO") {
      const string before = rtrim_spaces(head.substr(0, static_cast<size_t>(pos)));
      if (ends_with_ci(before, " APPEND")) pos = -1;
    }
    if (pos > 0) starts.push_back(pos);
  }
  if (starts.empty()) return head;
  std::sort(starts.begin(), starts.end());
  string out = rtrim_spaces(head.substr(0, static_cast<size_t>(starts.front())));
  for (size_t i = 0; i < starts.size(); ++i) {
    const size_t begin = static_cast<size_t>(starts[i]);
    const size_t end = i + 1 < starts.size() ? static_cast<size_t>(starts[i + 1]) : head.size();
    out += "\n" + trim_ascii_spaces(head.substr(begin, end - begin));
  }
  return out;
}

// A multi-line view head ends with `AS` on its own line, like CREATE TABLE AS.
string attach_view_as(const string& head) {
  return head + (head.find('\n') == string::npos ? " AS" : "\nAS");
}

string format_create_view_head_clauses(string_view raw_head, size_t threshold) {
  string head = normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(raw_head)));
  if (ends_with_ci(head, " AS")) {
    head = rtrim_spaces(head.substr(0, head.size() - 3));
  } else if (ends_with_ci(head, "AS")) {
    head = rtrim_spaces(head.substr(0, head.size() - 2));
  }

  // CREATE VIEW/MATERIALIZED VIEW may contain an explicit result schema before
  // AS SELECT. Format it with the same readable one-column-per-line layout used
  // for CREATE TABLE instead of collapsing the complete declaration on one line.
  const size_t par = head.find('(');
  const int engine_pos = find_top_level_keyword(head, "ENGINE");
  if (par != string::npos && (engine_pos < 0 || par < static_cast<size_t>(engine_pos))) {
    const size_t close = find_matching_paren(head, par);
    if (close != string::npos) {
      const string prefix = split_view_head_clauses(head.substr(0, par), threshold);
      const string cols = trim_ascii_spaces(head.substr(par + 1, close - par - 1));
      const auto items = split_top_level(cols, ',');
      vector<std::pair<string, string>> parsed;
      size_t width = 0;
      for (const auto& item : items) {
        const string col = trim_ascii_spaces(item);
        if (col.empty()) continue;
        size_t split = 0;
        if (col.front() == '`') {
          split = col.find('`', 1);
          if (split != string::npos) ++split;
        } else {
          split = col.find_first_of(" \t\n");
        }
        const string lhs = split == string::npos ? col : trim_ascii_spaces(col.substr(0, split));
        const string rhs = split == string::npos ? string() : trim_ascii_spaces(col.substr(split));
        width = std::max(width, lhs.size());
        parsed.push_back({lhs, rhs});
      }
      if (!parsed.empty()) {
        string out = prefix + "\n(\n";
        for (size_t i = 0; i < parsed.size(); ++i) {
          out += "    " + parsed[i].first;
          if (!parsed[i].second.empty()) {
            out += string(width - parsed[i].first.size() + 1, ' ') + parsed[i].second;
          }
          if (i + 1 < parsed.size()) out += ',';
          out += '\n';
        }
        out += ")";
        const string remainder = trim_ascii_spaces(head.substr(close + 1));
        if (!remainder.empty()) {
          const int remainder_engine = find_top_level_keyword(remainder, "ENGINE");
          if (remainder_engine == 0) out += "\n" + format_table_tail_clauses(remainder, threshold);
          else out += "\n" + normalize_code_spacing(collapse_whitespace(remainder));
        }
        return out + " AS";
      }
    }
  }

  if (engine_pos < 0) return attach_view_as(split_view_head_clauses(head, threshold));
  string prefix = split_view_head_clauses(head.substr(0, static_cast<size_t>(engine_pos)), threshold);
  string tail = format_table_tail_clauses(head.substr(static_cast<size_t>(engine_pos)), threshold);
  return prefix + "\n" + tail + " AS";
}


string Formatter::format_create_table(string_view s) {
  const string text = trim_ascii_spaces(s);
  // CREATE TABLE ... [ENGINE ...] AS SELECT: the stored query is a statement of
  // its own. Without this split, the first `(` of the query (e.g. `sum(`) is
  // mistaken for the column list.
  for (int as_pos = find_top_level_keyword(text, "AS"); as_pos >= 0;
       as_pos = find_top_level_keyword(text, "AS", static_cast<size_t>(as_pos) + 2)) {
    const string query = trim_ascii_spaces(text.substr(static_cast<size_t>(as_pos) + 2));
    const string inner = unwrap_outer_parens(query);
    const string& candidate = inner.empty() ? query : inner;
    if (!(starts_with_ci(candidate, "SELECT") || starts_with_ci(candidate, "WITH")) ||
        (candidate.size() > 6 && is_ident_char(candidate[starts_with_ci(candidate, "WITH") ? 4 : 6]))) {
      continue;
    }
    const string ddl = trim_ascii_spaces(text.substr(0, static_cast<size_t>(as_pos)));
    string body = format_statement(candidate);
    if (starts_with_ci(body, "SELECT ") && body.find('\n') != string::npos) body = expand_nested_select_head(std::move(body));
    return format_create_table(ddl) + "\nAS\n" + body;
  }
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
      if (!tail.empty()) out += tail == ";" ? ";" : "\n" + format_table_tail_clauses(tail, threshold);
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
  if (!tail.empty()) out += tail == ";" ? ";" : "\n" + format_table_tail_clauses(tail, threshold);
  return out;
}

string Formatter::format_create_view(string_view s, bool) {
  const string text = trim_ascii_spaces(s);
  const int pos = find_top_level_keyword(text, "SELECT");
  if (pos < 0) return cleanup_surface(text);
  string head = format_create_view_head_clauses(text.substr(0, static_cast<size_t>(pos)), threshold);
  string body = format_statement(text.substr(static_cast<size_t>(pos)));
  // CREATE VIEW/MV DDL is easier to scan when the projection is visually
  // separated from SELECT, even for a single `*`. Force the same representation
  // on every pass so formatter output is idempotent.
  if (starts_with_ci(body, "SELECT ") && body.find('\n') != string::npos) body = expand_nested_select_head(std::move(body));
  return head + "\n" + body;
}

string Formatter::format_alter_table(string_view s) {
  const string text = trim_ascii_spaces(s);
  const size_t par = text.find('(');
  if (par == string::npos) return cleanup_surface(text);
  const size_t close = find_matching_paren(text, par);
  if (close == string::npos) return cleanup_surface(text);
  const string head = trim_ascii_spaces(text.substr(0, par));
  string inner = trim_ascii_spaces(text.substr(par + 1, close - par - 1));
  // formatQuery prints every command as `(command)`, comma-separated, followed
  // by an optional statement-level SETTINGS. The block layouts below describe a
  // single command; a multi-command ALTER keeps the formatQuery layout, and the
  // SETTINGS tail must always survive (dropping it changes the statement).
  string tail = trim_ascii_spaces(text.substr(close + 1));
  if (!tail.empty() && tail.front() == ',') return cleanup_surface(text);
  if (!tail.empty() && !starts_with_ci(tail, "SETTINGS")) return cleanup_surface(text);
  if (!tail.empty()) tail = "\n" + format_clause("SETTINGS", trim_ascii_spaces(tail.substr(8)));
  if (starts_with_ci(inner, "MODIFY TTL")) {
    const string ttl = format_ttl_list("MODIFY TTL", inner.substr(10), threshold > 4 ? threshold - 4 : threshold);
    return head + "\n(\n" + indent_block(ttl, 4) + "\n)" + tail;
  }
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
    out += "\n)" + tail;
    return out;
  }
  if (starts_with_ci(inner, "UPDATE")) {
    const int where_pos = find_top_level_keyword(inner, "WHERE");
    if (where_pos > 0) {
      const string assigns = trim_ascii_spaces(inner.substr(6, static_cast<size_t>(where_pos) - 6));
      const string cond = trim_ascii_spaces(inner.substr(static_cast<size_t>(where_pos) + 5));
      return head + "\n(\n    UPDATE\n" + indent_block(format_simple_item_block(split_top_level(assigns, ',')), 8) + "\n    WHERE\n" + indent_block(indent_block(format_bool_expr(cond), 4), 4) + "\n)" + tail;
    }
  }
  if (starts_with_ci(inner, "DELETE WHERE")) {
    const string cond = trim_ascii_spaces(inner.substr(12));
    const string rendered = format_bool_expr(cond);
    if (rendered.find('\n') == string::npos) return head + "\n(\n    DELETE WHERE " + rendered + "\n)" + tail;
    return head + "\n(\n    DELETE\n    WHERE\n" + indent_block(rendered, 8) + "\n)" + tail;
  }
  // Any other single command uses the same block layout. formatQuery already
  // indents continuation lines by 4 relative to the command start.
  return head + "\n(\n    " + cleanup_surface(inner) + "\n)" + tail;
}

// Top-level `TO` of an access-control statement (the role list), searched after
// `from` so that `RENAME TO new_name` of an ALTER is never taken for it.
int find_access_to_clause(string_view text, size_t from) {
  int found = -1;
  for (int pos = find_top_level_keyword(text, "TO", from); pos >= 0;
       pos = find_top_level_keyword(text, "TO", static_cast<size_t>(pos) + 2)) {
    if (!ends_with_ci(rtrim_spaces(text.substr(0, static_cast<size_t>(pos))), " RENAME")) found = pos;
  }
  return found;
}

// formatQuery prints access-control DDL on one line. A statement that fits
// stays compact; a longer one puts every clause on its own line and formats
// USING like a WHERE clause, so a row filter reads like any other filter.
string Formatter::format_row_policy(string_view s) {
  if (contains_top_level_comment(s)) return cleanup_surface(s);
  const string text = normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(s)));
  if (utf8_width(text) <= threshold) return text;
  const int using_pos = find_top_level_keyword(text, "USING");
  const size_t head_limit = using_pos >= 0 ? static_cast<size_t>(using_pos) : text.size();
  vector<std::pair<int, string>> poses;
  // `RENAME TO`, `AS PERMISSIVE|RESTRICTIVE` and `FOR SELECT` precede USING.
  for (const char* kw : {"RENAME", "AS", "FOR"}) {
    const int pos = find_top_level_keyword(text, kw);
    if (pos > 0 && static_cast<size_t>(pos) < head_limit) poses.push_back({pos, kw});
  }
  if (using_pos > 0) poses.push_back({using_pos, "USING"});
  size_t to_from = 0;
  for (const auto& entry : poses) to_from = std::max(to_from, static_cast<size_t>(entry.first) + entry.second.size());
  if (const int to_pos = find_access_to_clause(text, to_from); to_pos > 0) poses.push_back({to_pos, "TO"});
  if (poses.empty()) return text;
  std::sort(poses.begin(), poses.end());
  string out = rtrim_spaces(text.substr(0, static_cast<size_t>(poses.front().first)));
  for (size_t i = 0; i < poses.size(); ++i) {
    const size_t body_start = static_cast<size_t>(poses[i].first) + poses[i].second.size();
    const size_t end = i + 1 < poses.size() ? static_cast<size_t>(poses[i + 1].first) : text.size();
    const string body = trim_ascii_spaces(text.substr(body_start, end - body_start));
    if (poses[i].second == "USING") {
      out += "\nUSING" + format_clause("WHERE", body).substr(5);
    } else {
      out += "\n" + poses[i].second + (body.empty() ? string() : " " + body);
    }
  }
  return out;
}

// Same layout for settings profiles: the SETTINGS list is formatted like the
// statement-level SETTINGS clause, one setting per line with aligned `=`.
string Formatter::format_settings_profile(string_view s) {
  if (contains_top_level_comment(s)) return cleanup_surface(s);
  const string text = normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(s)));
  if (utf8_width(text) <= threshold) return text;
  // Skip the `SETTINGS` of the statement name itself (`CREATE SETTINGS PROFILE`).
  const size_t name_start = text.find(' ', text.find(' ') + 1) + 1;
  const int settings_pos = find_top_level_keyword(text, "SETTINGS", name_start);
  const int to_pos = find_access_to_clause(text, settings_pos >= 0 ? static_cast<size_t>(settings_pos) : 0);
  if (settings_pos <= 0 && to_pos <= 0) return text;
  const size_t head_end = static_cast<size_t>(settings_pos > 0 ? settings_pos : to_pos);
  string out = rtrim_spaces(text.substr(0, head_end));
  if (settings_pos > 0) {
    const size_t body_start = static_cast<size_t>(settings_pos) + 8;
    const size_t end = to_pos > settings_pos ? static_cast<size_t>(to_pos) : text.size();
    string block;
    const auto items = split_top_level(text.substr(body_start, end - body_start), ',');
    for (size_t i = 0; i < items.size(); ++i) {
      block += "    " + trim_ascii_spaces(items[i]);
      if (i + 1 < items.size()) block += ",\n";
    }
    out += "\nSETTINGS\n" + block;
  }
  if (to_pos > 0) out += "\nTO " + trim_ascii_spaces(text.substr(static_cast<size_t>(to_pos) + 2));
  return out;
}

string Formatter::format_insert_select_like(string_view s) {
  const string text = trim_ascii_spaces(s);
  const int pos = find_top_level_keyword(text, "SELECT");
  if (pos < 0) return cleanup_surface(text);
  const string before = text.substr(11, static_cast<size_t>(pos) - 11);
  const size_t nl = before.find('\n');
  string target;
  string between;
  if (nl == string::npos) {
    const size_t block = before.find("/*");
    if (block != string::npos) {
      target = trim_ascii_spaces(before.substr(0, block));
      between = trim_ascii_spaces(before.substr(block));
    } else {
      target = trim_ascii_spaces(before);
    }
  } else {
    target = trim_ascii_spaces(before.substr(0, nl));
    between = trim_ascii_spaces(before.substr(nl + 1));
  }
  if (starts_with_ci(trim_ascii_spaces(between), "/*")) between = reflow_block_comment(between);
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


string Formatter::format_optimize_table(string_view s) {
  const string text = trim_ascii_spaces(s);
  const int final_pos = find_top_level_keyword(text, "FINAL");
  const int dedup_pos = find_top_level_keyword(text, "DEDUPLICATE BY");
  if (final_pos < 0 && dedup_pos < 0) return cleanup_surface(text);

  const size_t head_end = final_pos >= 0 ? static_cast<size_t>(final_pos) : static_cast<size_t>(dedup_pos);
  string out = cleanup_surface(trim_ascii_spaces(text.substr(0, head_end)));

  if (final_pos >= 0) {
    out += "\nFINAL";
  }

  if (dedup_pos >= 0) {
    const string cols = trim_ascii_spaces(text.substr(static_cast<size_t>(dedup_pos) + string_view("DEDUPLICATE BY").size()));
    const auto items = split_top_level(cols, ',');
    out += "\nDEDUPLICATE BY";
    if (items.size() == 1 && cols.find('\n') == string::npos && cols.size() <= threshold) {
      out += " " + format_expression(items.front());
    } else {
      out += "\n" + indent_block(format_simple_item_block(items), 4);
    }
  }
  return out;
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


// Width rule on the final text (see collapse_fitting_calls): join what fits,
// then explode one-line calls that overflow. Exploding is limited to query
// statements; DDL keeps its column, index and type lines.
string Formatter::layout_calls_by_width(string_view text, bool allow_explode) {
  vector<size_t> joined_rows;
  string out = collapse_fitting_calls(text, threshold, &joined_rows);
  out = merge_joined_single_select_items(out, joined_rows, threshold);
  if (!allow_explode) return out;
  vector<string> result;
  bool exploded = false;
  for (const string& line : split_lines_keep(out)) {
    vector<string> pieces = explode_overlong_line(line, 0);
    exploded = exploded || pieces.size() > 1;
    for (string& piece : pieces) result.push_back(std::move(piece));
  }
  // Splitting a line can leave the rest of its call on later lines with room
  // to join (`name(\n    params\n)(` followed by the argument lines).
  return exploded ? collapse_fitting_calls(join_lines(result), threshold) : join_lines(result);
}

// Explodes the widest call, array or IN list that starts on an overflowing
// line: `name(` stays on the line, one argument per line one level deeper,
// `)` back at the line's indentation followed by the rest of the line
// (`) AS alias,`). A single condition on the WHERE line hangs one more level,
// like the other single multi-line conditions. The new lines get the same
// treatment until they fit or nothing is left to split.
vector<string> Formatter::explode_overlong_line(const string& line, int depth) {
  if (depth > 16 || utf8_width(line) <= threshold) return {line};
  const CallScan scan = scan_call_brackets(line);
  for (const unsigned char k : scan.kind) if (k == kCallComment) return {line};
  const size_t indent = leading_space_count(line);
  const string trimmed = line.substr(indent);
  if (starts_with_ci(trimmed, "CREATE ") || find_top_level_keyword(trimmed, "WITH FILL") >= 0) return {line};
  for (const char* kw : {"SELECT ", "ORDER BY ", "GROUP BY "}) {
    if (!starts_with_ci(trimmed, kw) || starts_with_ci(trimmed, "SELECT DISTINCT")) continue;
    // A single item too long for the clause line goes into the block.
    vector<string> out{string(indent, ' ') + rtrim_spaces(kw)};
    for (string& piece : explode_overlong_line(string(indent + 4, ' ') + trimmed.substr(std::char_traits<char>::length(kw)), depth + 1)) {
      out.push_back(std::move(piece));
    }
    return out;
  }
  // The widest candidate at the shallowest nesting level: the outermost call
  // on an item line, or the call inside a tuple row `('k', encrypt(...)),`.
  size_t best_begin = string::npos;
  size_t best_open = string::npos;
  size_t best_end = string::npos;
  int best_level = 0;
  CallOpener best_kind = CallOpener::None;
  int level = 0;
  for (size_t i = 0; i < line.size(); ++i) {
    if (scan.kind[i] != kCallCode) continue;
    const char c = line[i];
    if (c == ')' || c == ']') { if (level > 0) --level; continue; }
    if (c != '(' && c != '[') continue;
    const int here = level++;
    if (scan.match[i] == string::npos || (best_begin != string::npos && here > best_level)) continue;
    size_t begin = i;
    const CallOpener kind = classify_call_opener(line, scan, i, &begin);
    if (kind != CallOpener::Call && kind != CallOpener::Array && kind != CallOpener::InList) continue;
    if (count_call_arguments(line, scan, i, scan.match[i]) == 0 || closer_starts_text_cast(line, scan.match[i])) continue;
    size_t end = scan.match[i];
    if (kind == CallOpener::Call && end + 1 < line.size() && line[end + 1] == '(' && scan.match[end + 1] != string::npos) {
      end = scan.match[end + 1];
    }
    if (utf8_width(string_view(line).substr(0, i + 1)) > threshold) continue;
    if (best_begin == string::npos || here < best_level || end - begin > best_end - best_begin) {
      best_begin = begin;
      best_open = i;
      best_end = end;
      best_level = here;
      best_kind = kind;
    }
  }
  if (best_begin == string::npos) return {line};
  const string call = line.substr(best_begin, best_end + 1 - best_begin);
  string rendered;
  if (best_kind == CallOpener::Call) rendered = format_function_call(call, true);
  if (rendered.empty()) {
    // Arrays, IN lists and calls the expression formatter does not take
    // (a quoted name): one item per line.
    const size_t open_rel = best_open - best_begin;
    const size_t close_rel = best_kind == CallOpener::Call ? scan.match[best_open] - best_begin : call.size() - 1;
    const auto items = split_top_level(string_view(call).substr(open_rel + 1, close_rel - open_rel - 1), ',');
    rendered = call.substr(0, open_rel + 1) + "\n";
    for (size_t i = 0; i < items.size(); ++i) {
      rendered += indent_block(hang_operator_continuations(format_expression(items[i])), 4);
      rendered += i + 1 < items.size() ? ",\n" : "\n";
    }
    rendered += call.substr(close_rel);
  }
  if (rendered.find('\n') == string::npos) return {line};
  size_t base = indent;
  for (const char* kw : {"WHERE ", "PREWHERE ", "HAVING ", "QUALIFY "}) {
    if (starts_with_ci(trimmed, kw)) base = indent + 4;
  }
  const vector<string> parts = split_lines_keep(rendered);
  vector<string> produced;
  produced.push_back(line.substr(0, best_begin) + parts.front());
  for (size_t i = 1; i + 1 < parts.size(); ++i) produced.push_back(string(base, ' ') + parts[i]);
  produced.push_back(string(base, ' ') + parts.back() + line.substr(best_end + 1));
  const string settled = collapse_fitting_calls(join_lines(produced), threshold);
  vector<string> out;
  for (const string& piece_line : split_lines_keep(settled)) {
    if (piece_line == line) return {line};
    for (string& piece : explode_overlong_line(piece_line, depth + 1)) out.push_back(std::move(piece));
  }
  return out;
}

} // namespace

string postprocess_format_query(std::string s, size_t threshold) {
  return Formatter(threshold).format(s);
}

} // namespace chdash