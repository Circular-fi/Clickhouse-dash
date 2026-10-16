// This unit lays out the statements and the clauses of a query: SELECT, WITH, FROM, JOIN, WHERE, and the lists of items.
// The declarations that the units share are in format_internal.hpp.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

string Formatter::cleanup_surface(string_view s) const {
  vector<string> lines;
  size_t start = 0;
  while (start <= s.size()) {
    const size_t nl = s.find('\n', start);
    const size_t end = (nl == string_view::npos) ? s.size() : nl;
    const string_view raw_line = s.substr(start, end - start);
    auto [code, comment] = split_inline_comment(raw_line);
    size_t lead = 0;
    while (lead < code.size() && (code[lead] == ' ' || code[lead] == '\t')) ++lead;
    string prefix = code.substr(0, lead);
    code = prefix + normalize_code_spacing(string_view(code).substr(lead));
    if (trim_ascii_spaces(code).empty() && !comment.empty()) {
      // A comment-only line keeps its indentation. Earlier, the indentation was lost, because the code part was empty.
      size_t indent = 0;
      while (indent < raw_line.size() && (raw_line[indent] == ' ' || raw_line[indent] == '\t')) ++indent;
      lines.push_back(string(raw_line.substr(0, indent)) + comment);
    } else {
      lines.push_back(comment.empty() ? code : (code.empty() ? comment : code + ' ' + comment));
    }
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

namespace {
string align_multiline_settings(const string& text) {
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
}  // namespace

namespace {
string take_trailing_line_comments(string* text);
}  // namespace

namespace {
// formatQuery prints operator keywords in upper case. On the local path, which keeps comments, the user's spelling reaches the output.
// (`x -> not isNull(x)`, `[1, null]`, `tuple(1 as a)`, `case when ... end`).
// This function changes only words that cannot be identifiers in their position.
// It never changes a word after `.` or `AS`, or a call name (`and(a, b)`). It changes CASE words only between CASE and its END.
// It changes nothing inside literals, quoted names, or comments. The length stays the same, so no layout decision depends on it.
string uppercase_expression_keywords(string s) {
  const SqlMaskResult masked = mask_sql_surface(s);
  const string& code = masked.code_lower;
  struct Word { size_t begin; size_t end; };
  vector<Word> words;
  for (size_t i = 0; i < code.size();) {
    if (!is_ident_char(code[i]) || (i > 0 && is_ident_char(code[i - 1]))) { ++i; continue; }
    size_t e = i;
    while (e < code.size() && is_ident_char(code[e])) ++e;
    words.push_back({i, e});
    i = e;
  }
  auto text = [&](size_t k) { return string_view(code).substr(words[k].begin, words[k].end - words[k].begin); };
  auto next_char = [&](size_t pos) {
    while (pos < code.size() && (code[pos] == ' ' || code[pos] == '\t' || code[pos] == '\n' || code[pos] == '\r')) ++pos;
    return pos < code.size() ? code[pos] : '\0';
  };
  auto prev_char = [&](size_t pos) {
    while (pos > 0 && (code[pos - 1] == ' ' || code[pos - 1] == '\t' || code[pos - 1] == '\n' || code[pos - 1] == '\r')) --pos;
    return pos > 0 ? code[pos - 1] : '\0';
  };
  static const char* operators[] = {"null", "not", "and", "or", "as", "is", "in", "like", "ilike", "between"};
  static const char* case_words[] = {"when", "then", "else"};
  int case_depth = 0;
  for (size_t k = 0; k < words.size(); ++k) {
    const string_view w = text(k);
    const size_t b = words[k].begin;
    const size_t e = words[k].end;
    const char before = prev_char(b);
    const char after = next_char(e);
    if (before == '.' || after == '.' || (b > 0 && (s[b - 1] == '`' || s[b - 1] == '"')) || std::isdigit(static_cast<unsigned char>(code[b]))) continue;
    // An alias name is not changed. Format and engine names are case-sensitive, for example `FORMAT Null` and `ENGINE =
    // Null`. They are not the NULL literal.
    if (k > 0 && (text(k - 1) == "as" || text(k - 1) == "format" || text(k - 1) == "engine")) continue;
    bool upper = false;
    auto next_word_is = [&](std::initializer_list<const char*> options) {
      if (k + 1 >= words.size() || next_char(e) != code[words[k + 1].begin]) return false;
      for (const char* o : options) if (text(k + 1) == o) return true;
      return false;
    };
    const bool after_expression = is_ident_char(before) || before == ')' || before == ']' || before == '\'' || before == '`';
    const bool prev_is_by = k > 0 && (text(k - 1) == "by" || text(k - 1) == "select");
    if ((w == "asc" || w == "desc") && after_expression && !prev_is_by) {
      // ORDER BY direction. The direction is followed by the end of the item, or by its modifiers.
      upper = after == '\0' || after == ',' || after == ')' || after == ';' ||
              next_word_is({"nulls", "limit", "offset", "settings", "format", "with", "collate", "union", "into"});
    } else if (w == "nulls" && after_expression && !prev_is_by && next_word_is({"first", "last"})) {
      upper = true;
    } else if ((w == "first" || w == "last") && k > 0 && text(k - 1) == "nulls") {
      upper = true;
    } else if (w == "case" && after != '(') {
      ++case_depth;
      upper = true;
    } else if (w == "end" && case_depth > 0) {
      --case_depth;
      upper = true;
    } else if (case_depth > 0 && std::any_of(std::begin(case_words), std::end(case_words), [&](const char* cw) { return w == cw; })) {
      upper = true;
    } else if (std::any_of(std::begin(operators), std::end(operators), [&](const char* op) { return w == op; })) {
      // An operator sits before an operand. A call name (`and(a, b)`), a list entry, or an assignment target is not changed.
      // `NOT (x)`, `IN (1, 2)`, and `AS (SELECT ...)` take a parenthesized operand.
      if (w == "null") upper = after != '(';
      else if (after == '(') upper = w == "not" || w == "in" || w == "as";
      else upper = after != '\0' && after != ',' && after != ')' && after != '=' && after != ']' && after != ';';
    }
    if (!upper) continue;
    for (size_t i = b; i < e; ++i) s[i] = static_cast<char>(std::toupper(static_cast<unsigned char>(s[i])));
  }
  return s;
}
}  // namespace

string Formatter::format(string_view s) {
  // ClickHouse reads a `--` or `#` comment to the end of its line. This is true even when the
  // whole query is one line, and the comment swallows the clauses after it. The formatter never turns
  // the text of a comment into code. For example, `WHERE id = 5 -- old: or 1 = 1` must not become a condition.
  string text = trim_ascii_spaces(repair_split_clause_keywords(trim_ascii_spaces(normalize_newlines(s))));
  if (text.empty()) return text;
  string leading;
  text = take_leading_comments(text, &leading);
  const string trailing = take_trailing_line_comments(&text);
  auto with_comments = [&](string body) {
    if (!leading.empty()) body = leading + "\n" + body;
    if (!trailing.empty()) body += "\n" + trailing;
    return body;
  };
  if (auto values = try_format_insert_values(text); !values.empty()) return with_comments(values);
  text = uppercase_expression_keywords(strip_redundant_arith_parentheses(text));
  // The width rule splits calls only inside queries. DDL lines (columns,
  // indexes, types, grants) keep the layout of their own formatters.
  bool query = false;
  for (const char* head : {"SELECT", "WITH", "INSERT", "EXPLAIN", "CREATE VIEW", "CREATE MATERIALIZED VIEW", "CREATE OR REPLACE VIEW",
                           "CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"}) {
    if (starts_with_ci(text, head)) query = true;
  }
  string out = format_statement(text);
  if (!leading.empty()) out = leading + "\n" + out;
  out = align_multiline_settings(normalize_final_layout(layout_calls_by_width(cleanup_surface(out), query), threshold));
  if (!trailing.empty()) out += "\n" + trailing;
  return out;
}

namespace {
// Whole-line `--` comments after the last statement line stay on their own lines, after the formatted statement.
// If they stayed inside the statement, the last clause body would absorb them and attach them to its line
// (`FROM t -- end of report`).
string take_trailing_line_comments(string* text) {
  const SqlMaskResult masked = mask_sql_surface(*text);
  vector<string> comments;
  size_t end = text->size();
  while (end > 0) {
    size_t line_end = end;
    while (line_end > 0 && ((*text)[line_end - 1] == '\n' || (*text)[line_end - 1] == '\r' ||
                            (*text)[line_end - 1] == ' ' || (*text)[line_end - 1] == '\t')) --line_end;
    if (line_end == 0) break;
    const size_t nl = text->rfind('\n', line_end - 1);
    const size_t line_start = nl == string::npos ? 0 : nl + 1;
    const string line = trim_ascii_spaces(string_view(*text).substr(line_start, line_end - line_start));
    const bool blank_code = masked.code_lower.find_first_not_of(" \t\r\n", line_start) >= line_end;
    if (line_start == 0 || !starts_with_ci(line, "--") || !blank_code) break;
    comments.insert(comments.begin(), line);
    end = line_start;
  }
  if (comments.empty()) return {};
  *text = trim_ascii_spaces(string_view(*text).substr(0, end));
  string out;
  for (size_t i = 0; i < comments.size(); ++i) {
    if (i) out += '\n';
    out += comments[i];
  }
  return out;
}
}  // namespace

string Formatter::format_statement(string_view s) {
  const FormatDepthGuard guard(depth);
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
  else if (starts_with_ci(text, "CREATE TABLE") || starts_with_ci(text, "CREATE OR REPLACE TABLE") ||
           starts_with_ci(text, "CREATE TEMPORARY TABLE") || starts_with_ci(text, "REPLACE TABLE")) out = format_create_table(text);
  else if (starts_with_ci(text, "CREATE DICTIONARY") || starts_with_ci(text, "CREATE OR REPLACE DICTIONARY")) out = format_create_dictionary(text);
  else if (starts_with_ci(text, "CREATE MATERIALIZED VIEW")) out = format_create_view(text, true);
  else if (starts_with_ci(text, "CREATE VIEW") || starts_with_ci(text, "CREATE OR REPLACE VIEW")) out = format_create_view(text, false);
  else if (starts_with_ci(text, "ALTER TABLE")) out = format_alter_table(text);
  else if (starts_with_ci(text, "INSERT INTO")) out = format_insert_select_like(text);
  else if (starts_with_ci(text, "DELETE FROM")) out = format_delete(text);
  else if (starts_with_ci(text, "OPTIMIZE TABLE")) out = format_optimize_table(text);
  else if (starts_with_ci(text, "CREATE ROW POLICY") || starts_with_ci(text, "ALTER ROW POLICY")) out = format_row_policy(text);
  // ALTER SETTINGS PROFILE is excluded. Its ADD, MODIFY, and DROP SETTINGS list
  // grammar is not a plain `name = value` list. That statement keeps the formatQuery line.
  else if (starts_with_ci(text, "CREATE SETTINGS PROFILE")) out = format_settings_profile(text);
  else if (starts_with_ci(text, "KILL QUERY") || starts_with_ci(text, "KILL MUTATION")) out = format_kill(text);
  else if (const int as_pos = is_create_function(text) ? find_top_level_keyword(text, "AS") : -1; as_pos > 0) {
    // In `CREATE FUNCTION name AS (x, y) -> body`, the lambda is an expression. It follows the lambda rules: no parentheses around a plain body, and the width rule.
    // A statement that is too long for one line puts the lambda on its own line, one level deeper. The width rule lays it out there.
    const string head = cleanup_surface(text.substr(0, static_cast<size_t>(as_pos) + 2));
    const string lambda = format_expression(text.substr(static_cast<size_t>(as_pos) + 2));
    if (utf8_width(head) + 1 + utf8_width(string_view(lambda).substr(0, lambda.find('\n'))) > threshold) {
      out = head + "\n" + indent_block(lambda, 4);
    } else {
      out = head + " " + lambda;
    }
  }
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
  const FormatDepthGuard guard(depth);
  string text = trim_ascii_spaces(s);
  for (const char* set_operator : {"UNION ALL", "UNION DISTINCT"}) {
    if (auto parts = split_top_level_keyword(text, set_operator); !parts.empty()) {
      vector<string> rendered;
      for (const auto& part : parts) rendered.push_back(format_select_like(part));
      return join_with_keyword(rendered, set_operator);
    }
  }
  // In `a INTERSECT DISTINCT (b) EXCEPT ALL (c)`, the operator is on its own line between the operands, as formatQuery lays them out.
  // A parenthesized operand is a block. formatQuery adds the parentheses to show precedence.
  // If the chain stayed in the FROM clause body, it was joined onto one overlong line.
  if (auto set_parts = split_intersect_except(text); !set_parts.empty()) {
    string out;
    for (size_t i = 0; i < set_parts.size(); ++i) {
      if (i) out += "\n" + set_parts[i].second + "\n";
      const string& part = set_parts[i].first;
      const string inner = unwrap_outer_parens(part);
      if (!inner.empty() && looks_like_query(inner)) out += "(\n" + indent_block(format_statement(inner), 4) + "\n)";
      else out += format_statement(part);
    }
    return out;
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
  // What is left must be a SELECT. A WITH without a SELECT ("WITH", "WITHIN x") keeps its words.
  // An operand of UNION that is not a SELECT ("SELECT 1 UNION ALL x") keeps its words too.
  // The clause scan below reads past the six letters of SELECT.
  if (!starts_with_ci(text, "SELECT") || (text.size() > 6 && is_ident_char(text[6]))) return out + cleanup_surface(text);

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
  // Find every top-level occurrence. Repeated ARRAY JOIN clauses are legal.
  // They must stay distinct, and must not be absorbed into the first clause body.
  vector<std::pair<int, string>> poses = find_select_clauses(text, 6, clauses);
  // Some keywords are clause heads in other places. Inside some clauses, they are ordinary tokens.
  // Examples are `ORDER BY x WITH FILL FROM a TO b` and `SAMPLE 1/10 OFFSET 1/2`.
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
  string select_body = trim_ascii_spaces(text.substr(6, select_end - 6));
  // `DISTINCT [ON (...)]` and `ALL` qualify the whole projection list.
  // They stay on the SELECT line, and do not head the first item.
  string select_head = "SELECT";
  auto take_word = [&](string_view word) {
    if (!starts_with_ci(select_body, word) ||
        (select_body.size() > word.size() && is_ident_char(select_body[word.size()]))) return false;
    select_head += " " + string(word);
    select_body = trim_ascii_spaces(select_body.substr(word.size()));
    return true;
  };
  if (take_word("DISTINCT")) {
    if (take_word("ON") && !select_body.empty() && select_body.front() == '(') {
      const size_t close = find_matching_paren(select_body, 0);
      if (close != string::npos) {
        select_head += " " + collapse_whitespace(select_body.substr(0, close + 1));
        select_body = trim_ascii_spaces(select_body.substr(close + 1));
      }
    }
  } else {
    take_word("ALL");
  }
  auto items = split_top_level(select_body, ',');
  // On the local path, which keeps comments, the user's own line breaks reach this point. formatQuery would have joined them.
  // A single projection that is written over several lines, without comments, is judged on one line.
  if (items.size() == 1 && select_body.find('\n') != string::npos && !mask_sql_surface(select_body).has_comments) {
    select_body = collapse_whitespace(select_body);
    items = split_top_level(select_body, ',');
  }
  auto [single_expr_for_alias, single_alias_for_alias] = items.size() == 1 ? split_top_level_as(items.front()) : std::pair<string,string>{string(), string()};
  const bool single_simple_alias = items.size() == 1 && !single_alias_for_alias.empty() &&
                                   single_expr_for_alias.find('\n') == string::npos &&
                                   single_expr_for_alias.size() + single_alias_for_alias.size() + 8 <= threshold;
  // The compact form is measured as the exact line that it produces: "SELECT ", the rendered expression, and the quoted alias.
  // The raw body is not measured. A body that fits the width on its own can still overflow after the prefix is added.
  string compact_select;
  // The width decides, as for calls. Only a subquery keeps the block form.
  if (items.size() == 1 && select_body.find('\n') == string::npos && select_body.size() <= threshold &&
      !contains_select_keyword(items.front())) {
    compact_select = single_simple_alias
        ? select_head + " " + format_expression(single_expr_for_alias) + " AS " + format_alias_identifier(single_alias_for_alias)
        : select_head + " " + format_expression(items.front());
    if (compact_select.find('\n') != string::npos || utf8_width(compact_select) > threshold) compact_select.clear();
  }
  if (!compact_select.empty()) {
    out += compact_select;
  } else {
    out += select_head + "\n" + indent_block(format_item_block(items, true), 4);
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
  const FormatDepthGuard guard(depth);
  if (iequals_ascii(kw, "FROM")) return format_from_clause(body);
  if (iequals_ascii(kw, "ARRAY JOIN") || iequals_ascii(kw, "GLOBAL ARRAY JOIN") || iequals_ascii(kw, "LEFT ARRAY JOIN")) {
    // A table join after ARRAY JOIN is not one of the array-join items. An example is `ARRAY JOIN arr AS x INNER JOIN d ON ...`.
    // The table join starts its own line, as it does after FROM.
    if (auto joins = split_joins(body); !joins.empty()) {
      return format_clause(kw, joins.front().first) + format_join_segments(joins);
    }
    const auto items = split_top_level(body, ',');
    // Without comments, the line breaks of a single item come from an earlier layout.
    // The comment path keeps these line breaks. The item is judged on one line again.
    if (items.size() == 1 && (trim_ascii_spaces(body).find('\n') == string::npos || !mask_sql_surface(body).has_comments)) {
      auto [expr, alias] = split_top_level_as(collapse_whitespace(items.front()));
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
    // A wrapped arithmetic term is indented under its own condition line.
    return string(kw) + "\n" + indent_block(hang_operator_continuations(rendered), 4);
  }
  if (iequals_ascii(kw, "LIMIT") || iequals_ascii(kw, "OFFSET") || iequals_ascii(kw, "SAMPLE")) {
    // formatQuery prints the LIMIT and WITH TIES words on two lines. Keep these clauses on one line.
    return string(kw) + " " + collapse_whitespace(cleanup_surface(body));
  }
  if (iequals_ascii(kw, "WINDOW")) return format_window_clause(body);
  if (iequals_ascii(kw, "GROUP BY") || iequals_ascii(kw, "ORDER BY")) {
    string base = trim_ascii_spaces(body);
    // An earlier pass can break `x WITH FILL FROM a TO b` over several lines. The comment-preserving path keeps these line breaks.
    // The clause is judged on one line again.
    if (base.find('\n') != string::npos && find_top_level_keyword(base, "WITH FILL") >= 0 &&
        !mask_sql_surface(base).has_comments) {
      base = collapse_whitespace(base);
    }
    string suffix;
    if (iequals_ascii(kw, "GROUP BY")) {
      // Modifiers can be combined, for example `WITH ROLLUP WITH TOTALS`. Strip them all.
      // formatQuery can print each modifier on its own line.
      static const char* suffixes[] = {"WITH ROLLUP", "WITH CUBE", "WITH TOTALS"};
      for (bool stripped = true; stripped;) {
        stripped = false;
        for (const char* raw : suffixes) {
          const string_view suf(raw);
          if (base.size() > suf.size() && ends_with_ci(base, suf) &&
              std::isspace(static_cast<unsigned char>(base[base.size() - suf.size() - 1]))) {
            suffix = suffix.empty() ? string(raw) : string(raw) + " " + suffix;
            base = trim_ascii_spaces(base.substr(0, base.size() - suf.size()));
            stripped = true;
            break;
          }
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
      const string item = format_expression(items.front());
      // As with a single projection, only a one-line item shares the keyword line.
      // A multi-line item goes into the block.
      if (item.find('\n') == string::npos) {
        string line = string(kw) + " " + item;
        if (!suffix.empty()) line += " " + suffix;
        return line;
      }
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
            // formatQuery prints locality, strictness, and kind modifiers before the matched keyword.
            // Examples are `GLOBAL ANY LEFT JOIN`, `SEMI LEFT JOIN`, `ASOF LEFT JOIN`, `FULL OUTER JOIN`, and `PASTE JOIN`.
            // These modifiers belong to the join keyword, not to the preceding table expression.
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
  const FormatDepthGuard guard(depth);
  const string s = trim_ascii_spaces(body);
  if (auto joins = split_joins(s); !joins.empty()) {
    // Same layout as a join-free FROM. A multiline (subquery) source opens on
    // its own line, `FROM\n(`.
    const string first_source = format_table_source(joins.front().first);
    string out = first_source.find('\n') == string::npos ? "FROM " + first_source : "FROM\n" + first_source;
    return out + format_join_segments(joins);
  }
  const string src = format_table_source(s);
  return src.find('\n') == string::npos ? string("FROM ") + src : string("FROM\n") + src;
}

// The joins after the first element of split_joins() each start on a new line.
// For example: `JOIN target`, then `ON` conditions or ` USING ...`.
string Formatter::format_join_segments(const vector<std::pair<string, string>>& joins) {
  const FormatDepthGuard guard(depth);
  string out;
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

string Formatter::format_table_source(string_view s) {
  const FormatDepthGuard guard(depth);
  const string text = trim_ascii_spaces(s);
  if (auto nested = format_parenthesized_query(text); !nested.empty()) return nested;
  return collapse_whitespace(cleanup_surface(text));
}

string Formatter::format_parenthesized_query(string_view s) {
  const FormatDepthGuard guard(depth);
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
  const FormatDepthGuard guard(depth);
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
  // `--` comments that head an item were written after the comma of the previous item.
  // They go back there, so they stay with the item. Otherwise they would take the input indentation and drift on every pass.
  vector<vector<string>> lead_comments;

  for (const auto& source_item : items) {
    string raw = trim_ascii_spaces(source_item);
    lead_comments.emplace_back();
    while (starts_with_ci(raw, "--")) {
      auto [comment, rest] = split_leading_line_comment(raw);
      if (rest.empty()) break;
      lead_comments.back().push_back(comment);
      raw = rest;
    }
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
    if (i + 1 < parsed.size()) append_item_comma(item);
    const vector<string>& comments = lead_comments[i];
    for (size_t c = 0; c < comments.size(); ++c) {
      if (c == 0 && !lines.empty() && !lines.back().empty() && lines.back().back() == ',') lines.back() += " " + comments[c];
      else lines.push_back(comments[c]);
    }
    lines.push_back(item);
  }
  return join_lines(lines);
}

namespace {
string normalize_aliased_operator_continuations(const string& value) {
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
}  // namespace

string Formatter::format_item_block(const vector<string>& items, bool align_alias) {
  const FormatDepthGuard guard(depth);
  vector<std::pair<string, string>> parsed;
  size_t width = 0;
  size_t min_width = static_cast<size_t>(-1);
  size_t aliased_count = 0;
  bool can_align = align_alias;
  for (const auto& raw : items) {
    auto [expr, alias] = split_top_level_as(raw);
    const string source = trim_ascii_spaces(expr);
    expr = format_expression(expr);
    // A boolean item that is too long for its line wraps before AND or OR, like a condition.
    // The continuation lines are one level deeper, as in a boolean argument or a lambda body.
    // Otherwise the call split would divide one operand's call, and the rest of the chain would stay over the width.
    if (expr.find('\n') == string::npos && !mask_sql_surface(source).has_comments &&
        utf8_width(expr) + (alias.empty() ? 0 : utf8_width(format_alias_identifier(alias)) + 4) + 5 > threshold &&
        (!split_top_level_keyword(source, "AND").empty() || !split_top_level_keyword(source, "OR").empty())) {
      expr = indent_after_first_line(format_bool_expr(source), 4);
    }
    if (!alias.empty()) {
      expr = normalize_aliased_operator_continuations(expr);
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
          item = normalize_aliased_operator_continuations(chain);
        }
      }
      if (can_align) item += string((width > last_line_length(item) ? width - last_line_length(item) : 0) + 2, ' ') + "AS " + alias;
      else {
        item += " AS " + alias;
      }
    }
    if (i + 1 < parsed.size()) append_item_comma(item);
    const size_t nl = item.find('\n');
    if (!lines.empty() && starts_with_ci(trim_ascii_spaces(item), "--") && !lines.back().empty() && lines.back().back() == ',') {
      if (nl == string::npos) {
        // A comment that ends the list, for example `a, -- note`, stays on the line of the comma.
        lines.back() += " " + trim_ascii_spaces(item);
        continue;
      }
      lines.back() += " " + trim_ascii_spaces(item.substr(0, nl));
      lines.push_back(trim_ascii_spaces(item.substr(nl + 1)));
      continue;
    }
    lines.push_back(item);
  }
  return join_lines(lines);
}

string Formatter::format_simple_item_block(const vector<string>& items) {
  const FormatDepthGuard guard(depth);
  vector<string> lines;
  for (size_t i = 0; i < items.size(); ++i) {
    string item = format_expression(items[i]);
    if (i + 1 < items.size()) append_item_comma(item);
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

}  // namespace fmt
}  // namespace chdash
