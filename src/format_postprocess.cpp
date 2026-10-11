#include "format_postprocess.hpp"
#include "format_internal.hpp"

namespace chdash {

using namespace fmt;

string postprocess_format_query(const std::string& s, size_t threshold) {
  FormatBudget budget{std::chrono::steady_clock::now() + kFormatTimeBudget};
  FormatBudget* const outer = t_format_budget;
  t_format_budget = &budget;
  struct Restore {
    FormatBudget* outer;
    ~Restore() { t_format_budget = outer; }
  } restore{outer};
  try {
    string out = Formatter(threshold).format(s);
    // Every comment comes out whole, or the statement comes back as written.
    if (line_comment_texts(out) != line_comment_texts(s)) return s;
    return out;
  } catch (const FormatGivesUp&) {
    // Too deep, or too long, to lay out: the statement as it was written, which keeps its meaning.
    return s;
  }
}

string unwrap_alter_table_commands(std::string formatted) {
  const string_view s(formatted);
  // Comments before the statement stay where they are (a statement that was laid out locally has them).
  size_t begin = 0;
  for (const sql::Token& token : sql::lex(s)) {
    if (!sql::is_trivia(token.kind)) break;
    begin = token.end;
  }
  auto word_at = [&](size_t pos, string_view word) {
    return ci_match_at(s, pos, word) && (pos + word.size() >= s.size() || !is_ident_char(s[pos + word.size()]));
  };
  if (!word_at(begin, "ALTER")) return formatted;
  size_t pos = begin + 5;
  while (pos < s.size() && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\n' || s[pos] == '\r')) ++pos;
  if (!word_at(pos, "TABLE")) return formatted;

  // The command list starts at the first parenthesis that is not inside a literal, identifier or comment.
  ScanState st;
  size_t open = string::npos;
  for (size_t i = pos; i < s.size(); ++i) {
    if (is_top_level(st) && s[i] == '(') {
      open = i;
      break;
    }
    step_scan(st, s, i);
  }
  if (open == string::npos) return formatted;
  const string prefix(s.substr(0, begin));
  const string header = trim_ascii_spaces(s.substr(begin, open - begin));
  if (header.empty()) return formatted;

  // From there to the end: groups separated by commas, and comments after the last one.
  vector<string_view> groups;
  string suffix;
  size_t cursor = open;
  for (;;) {
    const size_t close = find_matching_paren(s, cursor);
    if (close == string::npos) return formatted;
    groups.push_back(s.substr(cursor + 1, close - cursor - 1));
    cursor = close + 1;
    while (cursor < s.size() && (s[cursor] == ' ' || s[cursor] == '\t' || s[cursor] == '\n' || s[cursor] == '\r')) ++cursor;
    if (cursor >= s.size()) break;
    // After the last group: comments only (the ones that end the statement), kept after the commands.
    if (s[cursor] != ',') {
      const string_view rest = s.substr(cursor);
      for (const sql::Token& token : sql::lex(rest)) {
        if (!sql::is_trivia(token.kind)) return formatted;
      }
      suffix = trim_ascii_spaces(rest);
      break;
    }
    ++cursor;
    while (cursor < s.size() && (s[cursor] == ' ' || s[cursor] == '\t' || s[cursor] == '\n' || s[cursor] == '\r')) ++cursor;
    if (cursor >= s.size() || s[cursor] != '(') return formatted;
  }

  string out = prefix + header;
  for (size_t g = 0; g < groups.size(); ++g) {
    string_view inner = groups[g];
    size_t first = 0;
    while (first < inner.size() && (inner[first] == ' ' || inner[first] == '\t')) ++first;
    const bool block = first < inner.size() && (inner[first] == '\n' || inner[first] == '\r');
    string command;
    if (block) {
      // "(\n    COMMAND\n)": the command's own lines, back at the left edge (like the clauses of a SELECT).
      vector<string> lines = split_lines_keep(inner);
      while (!lines.empty() && trim_ascii_spaces(lines.front()).empty()) lines.erase(lines.begin());
      while (!lines.empty() && trim_ascii_spaces(lines.back()).empty()) lines.pop_back();
      size_t common = string::npos;
      for (const string& line : lines) {
        if (trim_ascii_spaces(line).empty()) continue;
        common = std::min(common, leading_space_count(line));
      }
      if (common == string::npos) return formatted;
      for (size_t i = 0; i < lines.size(); ++i) {
        string line = lines[i];
        while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
        command += (i ? "\n" : "");
        if (!trim_ascii_spaces(line).empty()) command += line.substr(std::min(common, line.size()));
      }
    } else {
      // "(COMMAND)" at four spaces: the command at the left edge, the rest of its lines moved with it.
      const string trimmed = trim_ascii_spaces(inner.substr(first));
      if (trimmed.empty()) return formatted;
      vector<string> lines = split_lines_keep(trimmed);
      for (size_t i = 0; i < lines.size(); ++i) {
        string line = lines[i];
        if (i > 0) line.erase(0, std::min<size_t>(4, leading_space_count(line)));
        command += (i ? "\n" : "") + line;
      }
    }
    // The comma goes before a comment that ends the command's last line.
    if (g + 1 < groups.size()) append_item_comma(command);
    out += "\n" + command;
  }
  if (!suffix.empty()) out += "\n" + suffix;
  return out;
}

} // namespace chdash
