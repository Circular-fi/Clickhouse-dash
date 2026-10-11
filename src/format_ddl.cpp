// The DDL of the formatter: CREATE TABLE, VIEW and DICTIONARY, ALTER TABLE, TTL, the access control statements.
// The declarations that the units share are in format_internal.hpp.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

namespace {
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
    if (idx + 1 < items.size()) append_item_comma(out);
    if (idx + 1 < items.size()) out += '\n';
  }
  return "\n" + out;
}
}  // namespace

namespace {
// One TTL element (`expr [action] [WHERE cond]`). A conditional element that
// does not fit is split like a WHERE clause, one condition per line, so a long
// retention rule reads the same way as the filters used everywhere else.
string format_ttl_element(string_view raw, size_t width) {
  string element = normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(raw)));
  // `expr GROUP BY keys SET a = f(a), ...` that does not fit: the keys and
  // the assignments start their own lines, the assignments one per line.
  if (const int group_pos = find_top_level_keyword(element, "GROUP BY");
      group_pos > 0 && utf8_width(element) > width && find_top_level_keyword(element, "WHERE") < 0) {
    const int set_pos = find_top_level_keyword(element, "SET", static_cast<size_t>(group_pos));
    const size_t keys_end = set_pos > group_pos ? static_cast<size_t>(set_pos) : element.size();
    string out = rtrim_spaces(element.substr(0, static_cast<size_t>(group_pos))) + "\n" +
                 trim_ascii_spaces(string_view(element).substr(static_cast<size_t>(group_pos), keys_end - static_cast<size_t>(group_pos)));
    if (set_pos > group_pos) {
      const auto assignments = split_top_level(string_view(element).substr(static_cast<size_t>(set_pos) + 3), ',');
      if (assignments.size() == 1) {
        out += "\nSET " + trim_ascii_spaces(assignments.front());
      } else {
        out += "\nSET";
        for (size_t i = 0; i < assignments.size(); ++i) {
          out += "\n    " + trim_ascii_spaces(assignments[i]) + (i + 1 < assignments.size() ? "," : "");
        }
      }
    }
    return out;
  }
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
}  // namespace

namespace {
// TTL lists: one element per line when there are several, or when the single
// element does not fit on the `TTL` line (DDL lines follow the line width like
// every other statement).
string format_ttl_list(string_view head_kw, string_view body, size_t threshold) {
  vector<string> elements;
  // `expr GROUP BY k1, k2 SET a = f(a), b = g(b)` is one element although its
  // keys and assignments are comma lists: after GROUP BY every piece is a key
  // until SET, after SET every `name = expr` piece is an assignment.
  auto is_assignment = [](const string& piece) {
    size_t i = 0;
    while (i < piece.size() && (is_ident_char(piece[i]) || piece[i] == '`' || piece[i] == '.')) ++i;
    while (i < piece.size() && piece[i] == ' ') ++i;
    return i > 0 && i + 1 < piece.size() && piece[i] == '=' && piece[i + 1] != '=';
  };
  bool in_keys = false;
  bool in_set = false;
  for (const auto& raw : split_top_level(body, ',')) {
    const string element = trim_ascii_spaces(raw);
    if (element.empty()) continue;
    if (!elements.empty() && (in_keys || (in_set && is_assignment(element)))) {
      elements.back() += ", " + element;
    } else {
      elements.push_back(element);
    }
    const bool has_set = find_top_level_keyword(elements.back(), "SET") >= 0;
    in_keys = find_top_level_keyword(elements.back(), "GROUP BY") >= 0 && !has_set;
    in_set = has_set;
  }
  if (elements.empty()) return string(head_kw);
  string compact = string(head_kw) + " " + normalize_code_spacing(collapse_whitespace(elements.front()));
  if (elements.size() == 1 && utf8_width(compact) <= threshold) return compact;
  string out(head_kw);
  for (size_t i = 0; i < elements.size(); ++i) {
    out += "\n" + indent_block(format_ttl_element(elements[i], threshold > 4 ? threshold - 4 : threshold), 4);
    if (i + 1 < elements.size()) append_item_comma(out);
  }
  return out;
}
}  // namespace

namespace {
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
}  // namespace

namespace {
// `CREATE MATERIALIZED VIEW name REFRESH ... DEPENDS ON ... APPEND TO target`
// easily exceeds the line width on one line. When it does, every head clause
// starts its own line, like the clauses of the query that follows.
string split_view_head_clauses(string_view raw, size_t threshold) {
  string head = normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(raw)));
  if (utf8_width(head) + 3 <= threshold) return head;
  vector<int> starts;
  for (const char* kw : {"REFRESH", "DEPENDS ON", "SETTINGS", "APPEND", "TO", "DEFINER", "SQL SECURITY"}) {
    int pos = find_top_level_keyword(head, kw);
    // `APPEND TO target` is one clause: the TO belongs to APPEND.
    if (pos > 0 && string_view(kw) == "TO") {
      const string before = rtrim_spaces(head.substr(0, static_cast<size_t>(pos)));
      if (ends_with_ci(before, " APPEND")) pos = -1;
    }
    // `DEFINER = user` heads a clause; the DEFINER of `SQL SECURITY DEFINER`
    // is that clause's value.
    if (pos > 0 && string_view(kw) == "DEFINER") {
      size_t next = static_cast<size_t>(pos) + 7;
      while (next < head.size() && head[next] == ' ') ++next;
      if (next >= head.size() || head[next] != '=') pos = -1;
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
}  // namespace

namespace {
// A multi-line view head ends with `AS` on its own line, like CREATE TABLE AS.
string attach_view_as(const string& head) {
  return head + (head.find('\n') == string::npos ? " AS" : "\nAS");
}
}  // namespace

namespace {
string normalize_create_head(const string& head);
}  // namespace

namespace {
string format_create_view_head_clauses(string_view raw_head, size_t threshold) {
  string head = normalize_create_head(normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(raw_head))));
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
          if (i + 1 < parsed.size()) append_item_comma(out);
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
}  // namespace

namespace {
// `name` -> `` `name` `` for a plain identifier column name; structural heads
// (INDEX, PROJECTION, CONSTRAINT, PRIMARY KEY), quoted and non-plain names
// are returned unchanged.
string backquote_plain_column_name(const string& name) {
  if (name.empty() || name.front() == '`' || name.front() == '"') return name;
  for (const char* kw : {"INDEX", "PROJECTION", "CONSTRAINT", "PRIMARY", "TTL"}) {
    if (iequals_ascii(name, kw)) return name;
  }
  bool plain = !std::isdigit(static_cast<unsigned char>(name.front()));
  for (const char ch : name) plain = plain && is_ident_char(ch);
  return plain ? "`" + name + "`" : name;
}
}  // namespace

namespace {
// `String default 'x'` → `String DEFAULT 'x'`: the column clause keyword
// right after the type, as formatQuery prints it. Only that position: these
// words are also common column names inside the clause expressions.
string uppercase_column_clause_keyword(string rhs) {
  const CallScan scan = scan_call_brackets(rhs);
  int depth = 0;
  size_t i = 0;
  for (; i < rhs.size(); ++i) {
    if (scan.kind[i] != kCallCode) continue;
    if (rhs[i] == '(' || rhs[i] == '[') ++depth;
    else if ((rhs[i] == ')' || rhs[i] == ']') && depth > 0) --depth;
    else if (depth == 0 && rhs[i] == ' ') break;
  }
  while (i < rhs.size() && rhs[i] == ' ') ++i;
  size_t e = i;
  while (e < rhs.size() && is_ident_char(rhs[e])) ++e;
  const string_view word = string_view(rhs).substr(i, e - i);
  for (const char* kw : {"DEFAULT", "MATERIALIZED", "ALIAS", "EPHEMERAL", "CODEC", "TTL", "COMMENT", "EXPRESSION"}) {
    if (!iequals_ascii(word, kw)) continue;
    for (size_t k = i; k < e; ++k) rhs[k] = static_cast<char>(std::toupper(static_cast<unsigned char>(rhs[k])));
    break;
  }
  // Dictionary attribute flags are not expressions: upper-case them where
  // they stand at the top level of the definition.
  const SqlMaskResult masked = mask_sql_surface(rhs);
  int level = 0;
  string_view previous_word;
  for (size_t k = 0; k < rhs.size(); ++k) {
    const char c = masked.code_lower[k];
    if (c == '(' || c == '[') ++level;
    else if ((c == ')' || c == ']') && level > 0) --level;
    if (level != 0 || !is_ident_char(c) || (k > 0 && is_ident_char(masked.code_lower[k - 1]))) continue;
    size_t w = k;
    while (w < rhs.size() && is_ident_char(masked.code_lower[w])) ++w;
    const string_view flag = string_view(masked.code_lower).substr(k, w - k);
    // `DEFAULT 0 EXPRESSION expr`: EXPRESSION after a value, never as one.
    const bool value_position = previous_word == "default" || previous_word == "expression";
    if (flag == "hierarchical" || flag == "injective" || flag == "is_object_id" || flag == "bidirectional" ||
        (flag == "expression" && !value_position)) {
      for (size_t q = k; q < w; ++q) rhs[q] = static_cast<char>(std::toupper(static_cast<unsigned char>(rhs[q])));
    }
    previous_word = flag;
    k = w - 1;
  }
  return rhs;
}
}  // namespace

namespace {
// formatQuery prints a column type's Tuple with two or more elements one
// element per line (4 spaces per Tuple level below the column) and its closer
// hugging the last element; the schema pass after it puts each Tuple closer on
// its own line. A one-line type from the local (comment-preserving) path gets
// the same text so both paths agree.
string explode_tuple_types_like_format_query(const string& rhs, size_t column_indent) {
  if (rhs.find('\n') != string::npos || rhs.find("Tuple(") == string::npos) return rhs;
  const CallScan scan = scan_call_brackets(rhs);
  // Tuple openers with at least two top-level elements.
  vector<bool> explode(rhs.size(), false);
  for (size_t i = 0; i < rhs.size(); ++i) {
    if (scan.kind[i] != kCallCode || rhs[i] != '(' || scan.match[i] == string::npos || i < 5) continue;
    if (rhs.compare(i - 5, 5, "Tuple") != 0 || (i > 5 && is_ident_char(rhs[i - 6]))) continue;
    explode[i] = count_call_arguments(rhs, scan, i, scan.match[i]) >= 2;
  }
  string out;
  vector<size_t> tuple_levels;  // per open bracket: exploded Tuple depth, or npos
  size_t depth = 0;
  for (size_t i = 0; i < rhs.size(); ++i) {
    const char c = rhs[i];
    if (scan.kind[i] != kCallCode) { out += c; continue; }
    if (c == '(' || c == '[') {
      out += c;
      if (c == '(' && explode[i]) {
        ++depth;
        tuple_levels.push_back(depth);
        out += "\n" + string(column_indent + 4 * depth, ' ');
        while (i + 1 < rhs.size() && rhs[i + 1] == ' ') ++i;
      } else {
        tuple_levels.push_back(string::npos);
      }
      continue;
    }
    if (c == ')' || c == ']') {
      if (!tuple_levels.empty()) {
        if (tuple_levels.back() != string::npos) --depth;
        tuple_levels.pop_back();
      }
      out += c;
      continue;
    }
    if (c == ',' && !tuple_levels.empty() && tuple_levels.back() != string::npos) {
      out += ",\n" + string(column_indent + 4 * depth, ' ');
      while (i + 1 < rhs.size() && rhs[i + 1] == ' ') ++i;
      continue;
    }
    out += c;
  }
  return out;
}
}  // namespace

// Column lists written with comments (usually one per column) take the local
// formatter path, where formatQuery neither quotes nor aligns the columns and
// the comments must survive. A comment right after a column's comma belongs
// to that column (kept at the end of its line); a comment on its own line
// stays on its own line before the next column. Column names are back-quoted
// and aligned like formatQuery output. A comment inside a definition falls
// back to the generic rendering.
string Formatter::format_commented_column_list(const string& head, const string& cols, const string& tail) {
  const FormatDepthGuard guard(depth);
  struct Column {
    vector<string> leading;
    string code;
    string trailing;
  };
  vector<Column> columns;
  const auto raw = split_top_level(cols, ',');
  for (size_t k = 0; k < raw.size(); ++k) {
    const string& item = raw[k];
    Column column;
    size_t i = 0;
    bool same_line = k > 0;
    while (i < item.size()) {
      const char c = item[i];
      if (c == ' ' || c == '\t' || c == '\r') { ++i; continue; }
      if (c == '\n') { same_line = false; ++i; continue; }
      string comment;
      if (c == '-' && i + 1 < item.size() && item[i + 1] == '-') {
        const size_t e = item.find('\n', i);
        comment = trim_ascii_spaces(item.substr(i, e == string::npos ? string::npos : e - i));
        i = e == string::npos ? item.size() : e;
      } else if (c == '/' && i + 1 < item.size() && item[i + 1] == '*') {
        const size_t e = item.find("*/", i + 2);
        if (e == string::npos) return {};
        comment = item.substr(i, e + 2 - i);
        if (comment.find('\n') != string::npos) return {};
        i = e + 2;
      } else {
        break;
      }
      if (same_line && !columns.empty()) {
        string& trailing = columns.back().trailing;
        trailing += (trailing.empty() ? "" : " ") + comment;
      } else {
        column.leading.push_back(comment);
      }
    }
    string code = item.substr(i);
    // Only the last column can carry a comment after its code (others have
    // theirs after the comma, i.e. in the next item).
    {
      const size_t last_nl = code.rfind('\n');
      const size_t line_start = last_nl == string::npos ? 0 : last_nl + 1;
      auto [line_code, line_comment] = split_inline_comment(string_view(code).substr(line_start));
      if (!line_comment.empty()) {
        column.trailing = line_comment;
        code = code.substr(0, line_start) + line_code;
      }
    }
    code = trim_ascii_spaces(code);
    if (code.empty()) return {};
    // A `--` comment inside a definition (`Map(String, -- note\n String)`)
    // keeps its line break; the continuation lines are re-indented below.
    // Block comments and comments elsewhere fall back to the generic layout.
    if (const auto masked = mask_sql_surface(code); masked.has_comments &&
        (code.find("/*") != string::npos || code.find('#') != string::npos)) return {};
    column.code = std::move(code);
    columns.push_back(std::move(column));
  }

  auto render_name = [](const string& name) { return backquote_plain_column_name(name); };
  static const char* kNonColumnHeads[] = {"INDEX", "PROJECTION", "CONSTRAINT", "PRIMARY"};
  vector<std::pair<string, string>> parsed;
  size_t width = 0;
  for (const auto& column : columns) {
    const string col = collapse_whitespace(column.code);
    const size_t sp = col.find_first_of(" \t\n");
    string lhs = sp == string::npos ? col : col.substr(0, sp);
    const string rhs = sp == string::npos ? string() : trim_ascii_spaces(col.substr(sp + 1));
    bool structural = false;
    for (const char* kw : kNonColumnHeads) structural = structural || iequals_ascii(lhs, kw);
    if (!structural) {
      lhs = render_name(lhs);
      width = std::max(width, utf8_width(lhs));
    }
    // A definition with a comment inside keeps its words: the comment text is
    // the author's, never upper-cased.
    const bool commented = mask_sql_surface(rhs).has_comments;
    parsed.emplace_back(structural ? "" : lhs,
                        structural || commented ? (structural ? col : rhs) : explode_tuple_types_like_format_query(uppercase_column_clause_keyword(rhs), 4));
  }
  string out = head + "\n(\n";
  for (size_t i = 0; i < parsed.size(); ++i) {
    for (const auto& comment : columns[i].leading) out += "    " + comment + "\n";
    string line = "    ";
    if (parsed[i].first.empty()) line += parsed[i].second;
    else line += parsed[i].first + string(width - utf8_width(parsed[i].first) + 1, ' ') + parsed[i].second;
    if (i + 1 < parsed.size()) append_item_comma(line);
    if (!columns[i].trailing.empty()) line += " " + columns[i].trailing;
    // Continuation lines of a definition with a comment inside: one level
    // under the column, whatever their input indentation.
    if (line.find('\n') != string::npos) {
      vector<string> parts = split_lines_keep(line);
      for (size_t k = 1; k < parts.size(); ++k) parts[k] = "        " + trim_ascii_spaces(parts[k]);
      line = join_lines(parts);
    }
    out += rtrim_spaces(line) + "\n";
  }
  out += ")";
  if (!tail.empty()) out += tail == ";" ? ";" : "\n" + format_table_tail_clauses(tail, threshold);
  return out;
}

namespace {
// `create or replace table if not exists db.t on cluster c` (or a VIEW /
// MATERIALIZED VIEW head) → keywords in
// upper case, as formatQuery prints them; names keep their spelling.
string normalize_create_head(const string& head) {
  vector<string> words;
  for (const auto& w : split_top_level(collapse_whitespace(head), ' ')) {
    if (!trim_ascii_spaces(w).empty()) words.push_back(trim_ascii_spaces(w));
  }
  auto upper = [](string w) {
    for (char& ch : w) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
    return w;
  };
  size_t i = 0;
  auto take = [&](std::initializer_list<const char*> kws) {
    size_t k = i;
    for (const char* kw : kws) {
      if (k >= words.size() || !iequals_ascii(words[k], kw)) return false;
      ++k;
    }
    for (; i < k; ++i) words[i] = upper(words[i]);
    return true;
  };
  if (!take({"CREATE"}) && !take({"ATTACH"}) && !take({"REPLACE"})) return head;
  take({"OR", "REPLACE"});
  take({"TEMPORARY"});
  if (!take({"TABLE"}) && !take({"MATERIALIZED", "VIEW"}) && !take({"VIEW"}) && !take({"DICTIONARY"})) return head;
  take({"IF", "NOT", "EXISTS"});
  if (i < words.size()) ++i;  // the table name
  if (take({"ON", "CLUSTER"}) && i < words.size()) ++i;
  take({"TO"});
  string out;
  for (size_t k = 0; k < words.size(); ++k) out += (k ? " " : "") + words[k];
  return out;
}
}  // namespace

string Formatter::format_create_table(string_view s) {
  const FormatDepthGuard guard(depth);
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
    string ddl = trim_ascii_spaces(text.substr(0, static_cast<size_t>(as_pos)));
    string body = format_statement(candidate);
    if (starts_with_ci(body, "SELECT ") && body.find('\n') != string::npos) body = expand_nested_select_head(std::move(body));
    // `... EMPTY AS SELECT`: EMPTY qualifies the AS, not the last DDL clause.
    string as_kw = "AS";
    if (ddl.size() > 6 && ends_with_ci(ddl, "EMPTY") && std::isspace(static_cast<unsigned char>(ddl[ddl.size() - 6]))) {
      ddl = trim_ascii_spaces(ddl.substr(0, ddl.size() - 5));
      as_kw = "EMPTY AS";
    }
    return format_create_table(ddl) + "\n" + as_kw + "\n" + body;
  }
  const size_t par = text.find('(');
  const int engine_pos = find_top_level_keyword(text, "ENGINE");
  // No column list (`CREATE TABLE t ENGINE = Memory`, the DDL part of
  // `CREATE TABLE t ENGINE = ... AS SELECT`): the engine clauses one per line,
  // also on the comment path, which does not get formatQuery's line breaks.
  if (par == string::npos && engine_pos > 0) {
    return cleanup_surface(trim_ascii_spaces(text.substr(0, static_cast<size_t>(engine_pos)))) + "\n" +
           format_table_tail_clauses(text.substr(static_cast<size_t>(engine_pos)), threshold);
  }
  if (par == string::npos) return cleanup_surface(text);
  const size_t close = find_matching_paren(text, par);
  if (close == string::npos) return cleanup_surface(text);

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
        if (i + 1 < items.size()) append_item_comma(out);
        out += '\n';
      }
      out += ")";
      if (!tail.empty()) out += tail == ";" ? ";" : "\n" + format_table_tail_clauses(tail, threshold);
      return out;
    }
    // `CREATE TABLE t AS source ENGINE = Distributed(...)`: no column list,
    // the first `(` opens the engine arguments, which stay on the ENGINE line.
    return before_engine + "\n" + format_table_tail_clauses(text.substr(static_cast<size_t>(engine_pos)), threshold);
  }

  const string head = normalize_create_head(trim_ascii_spaces(text.substr(0, par)));
  const string cols = trim_ascii_spaces(text.substr(par + 1, close - par - 1));
  const string tail = trim_ascii_spaces(text.substr(close + 1));
  if (mask_sql_surface(cols).has_comments) {
    if (auto commented = format_commented_column_list(head, cols, tail); !commented.empty()) return commented;
  }
  const auto items = split_top_level(cols, ',');
  size_t width = 0;
  vector<std::pair<string, string>> parsed;
  for (const auto& item : items) {
    const string col = trim_ascii_spaces(item);
    const size_t sp = col.find_first_of(" \t\n");
    string lhs = (sp == string::npos) ? col : trim_ascii_spaces(col.substr(0, sp));
    const string rhs = (sp == string::npos) ? string() : trim_ascii_spaces(col.substr(sp + 1));
    // Column names are back-quoted like formatQuery output, so a statement
    // that took the local (comment-preserving) path looks the same.
    lhs = backquote_plain_column_name(lhs);
    width = std::max(width, utf8_width(lhs));
    const bool structural = lhs.front() != '`' && lhs.front() != '"';
    parsed.push_back({lhs, structural ? rhs : explode_tuple_types_like_format_query(uppercase_column_clause_keyword(rhs), 4)});
  }
  string out = head + "\n(\n";
  for (size_t i = 0; i < parsed.size(); ++i) {
    out += "    " + parsed[i].first + string(width - utf8_width(parsed[i].first) + 1, ' ') + parsed[i].second;
    if (i + 1 < parsed.size()) append_item_comma(out);
    out += '\n';
  }
  out += ")";
  if (!tail.empty()) out += tail == ";" ? ";" : "\n" + format_table_tail_clauses(tail, threshold);
  return out;
}

namespace {
// `name(KEY value KEY value ...)` as in dictionary SOURCE / LAYOUT / RANGE /
// LIFETIME: the name and keys in upper case, values kept. Returns the pairs
// (key, value) of the inner list, or {} when the list is not key/value pairs.
vector<std::pair<string, string>> dictionary_key_values(string_view inner) {
  vector<string> tokens;
  const CallScan scan = scan_call_brackets(inner);
  int depth = 0;
  size_t start = string::npos;
  for (size_t i = 0; i <= inner.size(); ++i) {
    const bool end = i == inner.size();
    const char c = end ? ' ' : inner[i];
    const bool code = end || scan.kind[i] == kCallCode;
    if (code && (c == '(' || c == '[')) ++depth;
    if (code && (c == ')' || c == ']') && depth > 0) --depth;
    const bool space = code && depth == 0 && (c == ' ' || c == '\n' || c == '\t');
    if (space) {
      if (start != string::npos) tokens.emplace_back(inner.substr(start, i - start));
      start = string::npos;
    } else if (start == string::npos) {
      start = i;
    }
  }
  vector<std::pair<string, string>> pairs;
  // `CLICKHOUSE(... STRUCTURE (a UInt8))`: a value may be separated from its
  // key by a space before `(`; keys are bare words.
  for (size_t i = 0; i < tokens.size();) {
    const string& key = tokens[i];
    bool word = !key.empty();
    for (const char ch : key) word = word && is_ident_char(ch);
    if (!word || i + 1 >= tokens.size()) return {};
    pairs.emplace_back(key, tokens[i + 1]);
    i += 2;
  }
  return pairs;
}
}  // namespace

namespace {
string upper_ascii(string s) {
  for (char& ch : s) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
  return s;
}
}  // namespace

namespace {
// `source(clickhouse(table 'x' db 'y'))` → `SOURCE(CLICKHOUSE(TABLE 'x' DB 'y'))`;
// `lifetime(300)` → `LIFETIME(MIN 0 MAX 300)` like formatQuery. A call that
// does not fit the width puts one `KEY value` pair per line.
string format_dictionary_clause(const string& clause, size_t threshold) {
  const size_t open = clause.find('(');
  const size_t close = open == string::npos ? string::npos : find_matching_paren(clause, open);
  if (open == string::npos || close == string::npos || !trim_ascii_spaces(string_view(clause).substr(close + 1)).empty()) {
    return collapse_whitespace(clause);
  }
  const string name = upper_ascii(trim_ascii_spaces(clause.substr(0, open)));
  const string inner = trim_ascii_spaces(clause.substr(open + 1, close - open - 1));
  if (name == "LIFETIME") {
    bool digits = !inner.empty();
    for (const char ch : inner) digits = digits && std::isdigit(static_cast<unsigned char>(ch));
    if (digits) return "LIFETIME(MIN 0 MAX " + inner + ")";
  }
  if (name == "SETTINGS") return name + "(" + collapse_whitespace(inner) + ")";
  auto render_pairs = [](const vector<std::pair<string, string>>& pairs, const string& sep) {
    string out;
    for (size_t i = 0; i < pairs.size(); ++i) out += (i ? sep : "") + upper_ascii(pairs[i].first) + " " + collapse_whitespace(pairs[i].second);
    return out;
  };
  // SOURCE(TYPE(pairs)) / LAYOUT(TYPE(pairs)): one nested call.
  const size_t inner_open = inner.find('(');
  if (inner_open != string::npos && find_matching_paren(inner, inner_open) == inner.size() - 1) {
    string type = trim_ascii_spaces(inner.substr(0, inner_open));
    bool word = !type.empty();
    for (const char ch : type) word = word && is_ident_char(ch);
    if (word) {
      type = upper_ascii(type);
      const string args = trim_ascii_spaces(inner.substr(inner_open + 1, inner.size() - inner_open - 2));
      if (args.empty()) return name + "(" + type + "())";
      const auto pairs = dictionary_key_values(args);
      if (pairs.empty()) return name + "(" + type + "(" + collapse_whitespace(args) + "))";
      string one_line = name + "(" + type + "(" + render_pairs(pairs, " ") + "))";
      if (utf8_width(one_line) <= threshold) return one_line;
      return name + "(" + type + "(\n    " + render_pairs(pairs, "\n    ") + "\n))";
    }
  }
  if (const auto pairs = dictionary_key_values(inner); !pairs.empty()) return name + "(" + render_pairs(pairs, " ") + ")";
  return name + "(" + collapse_whitespace(inner) + ")";
}
}  // namespace

string Formatter::format_create_dictionary(string_view s) {
  const FormatDepthGuard guard(depth);
  const string text = trim_ascii_spaces(s);
  const size_t par = text.find('(');
  const size_t close = par == string::npos ? string::npos : find_matching_paren(text, par);
  if (close == string::npos) return cleanup_surface(text);
  // The attribute list is laid out like table columns.
  string out = format_create_table(text.substr(0, close + 1));
  const string tail = trim_ascii_spaces(text.substr(close + 1));
  static const vector<string_view> clauses = {"PRIMARY KEY", "SOURCE", "LIFETIME", "LAYOUT", "RANGE", "SETTINGS", "COMMENT"};
  vector<std::pair<int, string>> poses = find_select_clauses(tail, 0, clauses);
  if (poses.empty() || poses.front().first != 0) return tail.empty() ? out : out + "\n" + cleanup_surface(tail);
  for (size_t i = 0; i < poses.size(); ++i) {
    const size_t from = static_cast<size_t>(poses[i].first);
    const size_t to = i + 1 < poses.size() ? static_cast<size_t>(poses[i + 1].first) : tail.size();
    const string kw = upper_ascii(string(poses[i].second));
    const string body = trim_ascii_spaces(tail.substr(from + poses[i].second.size(), to - from - poses[i].second.size()));
    if (kw == "PRIMARY KEY" || kw == "COMMENT") {
      out += "\n" + kw + " " + collapse_whitespace(normalize_code_spacing(body));
    } else {
      out += "\n" + format_dictionary_clause(kw + body, threshold);
    }
  }
  return out;
}

string Formatter::format_create_view(string_view s, bool) {
  const FormatDepthGuard guard(depth);
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
  const FormatDepthGuard guard(depth);
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
      string assigns = trim_ascii_spaces(inner.substr(6, static_cast<size_t>(where_pos) - 6));
      const string cond = trim_ascii_spaces(inner.substr(static_cast<size_t>(where_pos) + 5));
      // `UPDATE a = x IN PARTITION p WHERE ...`: the partition qualifies the
      // command, not the last assignment (`'ms' IN PARTITION` read as IN).
      string partition;
      if (const int part_pos = find_top_level_keyword(assigns, "IN PARTITION"); part_pos > 0) {
        partition = "\n    " + collapse_whitespace(trim_ascii_spaces(assigns.substr(static_cast<size_t>(part_pos))));
        assigns = rtrim_spaces(assigns.substr(0, static_cast<size_t>(part_pos)));
      }
      return head + "\n(\n    UPDATE\n" + indent_block(format_simple_item_block(split_top_level(assigns, ',')), 8) + partition + "\n    WHERE\n" + indent_block(indent_block(format_bool_expr(cond), 4), 4) + "\n)" + tail;
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

namespace {
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
}  // namespace

// formatQuery prints access-control DDL on one line. A statement that fits
// stays compact; a longer one puts every clause on its own line and formats
// USING like a WHERE clause, so a row filter reads like any other filter.
string Formatter::format_row_policy(string_view s) {
  const FormatDepthGuard guard(depth);
  if (contains_top_level_comment(s)) return cleanup_surface(s);
  string text = normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(s)));
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
  const FormatDepthGuard guard(depth);
  if (contains_top_level_comment(s)) return cleanup_surface(s);
  string text = normalize_code_spacing(collapse_whitespace(trim_ascii_spaces(s)));
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

}  // namespace fmt
}  // namespace chdash
