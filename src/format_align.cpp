// The formatter passes that work on the lines of a finished layout.
// They align aliases, columns and index definitions. They also format enum types and the final layout.
// The declarations that the units share are in format_internal.hpp.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

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

namespace {
int find_alias_marker_for_alignment(string_view line) {
  ScanState st;
  int last = -1;
  for (size_t i = 0; i + 4 <= line.size(); ++i) {
    if (st.in_code() && line.substr(i, 4) == " AS ") {
      last = static_cast<int>(i);
    }
    step_scan(st, line, i);
  }
  return last;
}
}  // namespace

namespace {
string align_alias_line(string_view line, size_t target_as) {
  const int as_pos = find_alias_marker_for_alignment(line);
  if (as_pos < 0) return string(line);
  string lhs = rtrim_spaces(line.substr(0, static_cast<size_t>(as_pos)));
  string rhs = trim_ascii_spaces(line.substr(static_cast<size_t>(as_pos) + 4));
  const size_t lhs_width = utf8_width(lhs);
  if (lhs_width >= target_as) return lhs + " AS " + rhs;
  return lhs + string(target_as - lhs_width, ' ') + "AS " + rhs;
}
}  // namespace

namespace {
bool line_is_alignable_alias(string_view line) {
  const string t = trim_ascii_spaces(line);
  // A line that closes a multi-line item, such as `) AS x`, `] AS x` or a CASE's
  // `END AS x`. Such a line keeps one space.
  if (t.empty() || starts_with_ci(t, ")") || starts_with_ci(t, "]") || starts_with_ci(t, "END AS ") || starts_with_ci(t, "FROM ") ||
      starts_with_ci(t, "JOIN ") || starts_with_ci(t, "ARRAY JOIN ") ||
      starts_with_ci(t, "GLOBAL ARRAY JOIN ")) return false;
  const int as_pos = find_alias_marker_for_alignment(line);
  if (as_pos < 0) return false;
  const string rhs = trim_ascii_spaces(line.substr(static_cast<size_t>(as_pos) + 4));
  return starts_with_ci(rhs, "`");
}
}  // namespace

namespace {
void align_alias_groups(vector<string>& lines, size_t max_width) {
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
      previous_multiline_alias = starts_with_ci(prev, ") AS `") || starts_with_ci(prev, "END AS `");
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
        if (utf8_width(line) > max_width) ok = false;
        rendered.push_back(std::move(line));
      }
      if (ok) {
        for (size_t k = i; k < j; ++k) lines[k] = std::move(rendered[k - i]);
      }
    }
    i = j;
  }
}
}  // namespace

namespace {
bool looks_like_create_column_line(string_view line) {
  const string t = trim_ascii_spaces(line);
  if (t.size() <= 2 || t.front() != '`') return false;
  // `name` Type ...: a type follows the quoted name.
  // A projection that is only a quoted name with a space in it (`entity key`,) is not a column.
  const size_t close = t.find('`', 1);
  if (close == string::npos || close + 1 >= t.size() || t[close + 1] != ' ') return false;
  string rest = trim_ascii_spaces(string_view(t).substr(close + 1));
  if (!rest.empty() && rest.back() == ',') rest.pop_back();
  return !trim_ascii_spaces(rest).empty();
}
}  // namespace

namespace {
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
}  // namespace

size_t column_name_align_width(const vector<size_t>& name_widths) {
  size_t widest = 0, widest_within_cap = 0;
  for (const size_t w : name_widths) {
    widest = std::max(widest, w);
    if (w <= kColumnNameAlignCap) widest_within_cap = std::max(widest_within_cap, w);
  }
  return widest_within_cap ? widest_within_cap : widest;
}

namespace {
// The padding between a name and its type. The column of names is `width` wide. A name wider than the column gets one space.
size_t column_name_padding(size_t width, size_t name_width) { return name_width >= width ? 1 : width - name_width + 1; }

// The column lines of a CREATE schema that one alignment covers.
// Start at line `first`. Take the lines at `indent` that look like a column.
// Stop at the first INDEX / PROJECTION / CONSTRAINT / PRIMARY KEY / TTL line, or at a line less indented. `end` is where it stops.
struct SchemaGroup {
  vector<size_t> indexes;
  size_t end = 0;
};

SchemaGroup collect_schema_group(const vector<string>& lines, size_t first, size_t indent) {
  SchemaGroup group;
  size_t j = first;
  while (j < lines.size()) {
    const string t = trim_ascii_spaces(lines[j]);
    if (t.empty()) { ++j; continue; }
    const size_t current_indent = leading_space_count(lines[j]);
    if (current_indent < indent) break;
    if (current_indent == indent) {
      if (looks_like_create_column_line(lines[j])) group.indexes.push_back(j);
      else if (starts_with_ci(t, "INDEX ") || starts_with_ci(t, "PROJECTION ") ||
               starts_with_ci(t, "CONSTRAINT ") || starts_with_ci(t, "PRIMARY KEY ") ||
               starts_with_ci(t, "TTL ")) break;
    }
    ++j;
  }
  group.end = j;
  return group;
}

// The width of a `name` in a column line (before its type), and the type with its comma.
size_t column_line_name_width(const string& line) {
  const string t = trim_ascii_spaces(split_inline_comment(line).first);
  const size_t close = t.find('`', 1);
  return close == string::npos ? 0 : utf8_width(t.substr(0, close + 1));
}

// Join a `Tuple(` that formatQuery spread over lines back onto one line when it fits.
// A column of the schema is joined when the whole column fits the line width beside its aligned name.
// So a short `Tuple(code UInt16, name String)` stays on one line and is not four lines.
//
// A Tuple inside an exploded block is joined when its own line fits. A longer one stays as it is.
// A comment after the line that closes the block stays at the end of the joined line.
// A comment inside the block keeps the block as it is.
//
// Only a block that ends its first line with `Tuple(` is joined. An Enum is split by its own rule.
// Try the inner blocks before the block around them.
void join_short_nested_types(vector<string>& lines, size_t first, size_t indent, size_t max_width) {
  const SchemaGroup group = collect_schema_group(lines, first, indent);
  if (group.indexes.empty()) return;
  vector<size_t> widths;
  for (const size_t index : group.indexes) widths.push_back(column_line_name_width(lines[index]));
  const size_t width = column_name_align_width(widths);
  vector<bool> is_column(lines.size(), false);
  for (const size_t index : group.indexes) is_column[index] = true;
  for (size_t at = group.end; at-- > first;) {
    if (at >= lines.size()) continue;
    const auto [code, comment] = split_inline_comment(lines[at]);
    const string head = rtrim_spaces(code);
    if (!comment.empty() || head.size() < 6 || head.compare(head.size() - 6, 6, "Tuple(") != 0) continue;
    string joined = head;
    int depth = 0;
    ScanState st;
    auto scan_depth = [&](const string& line) {
      for (size_t c = 0; c < line.size(); ++c) {
        const char ch = line[c];
        if (st.in_code() && ch == '(') ++depth;
        else if (st.in_code() && ch == ')') --depth;
        step_scan(st, line, c);
      }
    };
    scan_depth(head);
    size_t last = at;
    string closing_comment;
    bool ok = true;
    while (depth > 0) {
      if (++last >= lines.size() || last - at > 64) { ok = false; break; }
      const auto [next_code, next_comment] = split_inline_comment(lines[last]);
      const string part = trim_ascii_spaces(next_code);
      if (part.empty()) { if (!next_comment.empty()) { ok = false; break; } continue; }
      scan_depth(part);
      // A comment can close the block (`), -- note`). A comment inside the block keeps the block as it is.
      if (!next_comment.empty()) {
        if (depth != 0) { ok = false; break; }
        closing_comment = next_comment;
      }
      joined += (joined.back() == '(' || part.front() == ')') ? part : " " + part;
    }
    if (!ok || depth != 0 || last == at) continue;
    const string t = trim_ascii_spaces(joined);
    bool fits;
    if (is_column[at]) {
      const size_t close = t.find('`', 1);
      const size_t name_width = utf8_width(t.substr(0, close + 1));
      const size_t type_width = utf8_width(trim_ascii_spaces(t.substr(close + 1)));
      fits = indent + std::max(width, name_width) + 1 + type_width <= max_width;
    } else {
      fits = leading_space_count(lines[at]) + utf8_width(t) <= max_width;
    }
    if (!fits) continue;
    if (!closing_comment.empty()) joined += " " + closing_comment;
    lines[at] = std::move(joined);
    lines.erase(lines.begin() + static_cast<std::ptrdiff_t>(at + 1), lines.begin() + static_cast<std::ptrdiff_t>(last + 1));
    is_column.erase(is_column.begin() + static_cast<std::ptrdiff_t>(at + 1), is_column.begin() + static_cast<std::ptrdiff_t>(last + 1));
  }
}
}  // namespace

namespace {
void align_create_columns(vector<string>& lines, size_t max_width) {
  for (size_t i = 0; i < lines.size();) {
    if (!looks_like_create_column_line(lines[i])) { ++i; continue; }
    const size_t indent = leading_space_count(lines[i]);

    // In CREATE TABLE and VIEW schemas, a multiline Tuple can place several deeper lines between top-level column declarations.
    // Treat the whole schema column run as one alignment group.
    // Do not reset the alignment after every nested type block.
    if (in_create_schema_block(lines, i, indent)) {
      join_short_nested_types(lines, i, indent, max_width);
      const SchemaGroup group = collect_schema_group(lines, i, indent);
      const vector<size_t>& indexes = group.indexes;
      const size_t j = group.end;

      if (indexes.size() >= 2) {
        struct ColLine { string lhs; string rhs; bool comma; string comment; };
        vector<ColLine> cols;
        vector<size_t> name_widths;
        cols.reserve(indexes.size());
        for (const size_t index : indexes) {
          auto [code_part, comment] = split_inline_comment(lines[index]);
          string t = trim_ascii_spaces(code_part);
          bool comma = false;
          if (!t.empty() && t.back() == ',') { comma = true; t.pop_back(); t = rtrim_spaces(t); }
          const size_t close = t.find('`', 1);
          const string lhs = t.substr(0, close + 1);
          const string rhs = trim_ascii_spaces(t.substr(close + 1));
          name_widths.push_back(utf8_width(lhs));
          cols.push_back({lhs, rhs, comma, comment});
        }
        const size_t width = column_name_align_width(name_widths);
        for (size_t k = 0; k < indexes.size(); ++k) {
          string rendered(indent, ' ');
          rendered += cols[k].lhs;
          rendered += string(column_name_padding(width, utf8_width(cols[k].lhs)), ' ');
          rendered += cols[k].rhs;
          if (cols[k].comma) append_item_comma(rendered);
          if (!cols[k].comment.empty()) rendered += " " + cols[k].comment;
          lines[indexes[k]] = std::move(rendered);
        }
      }
      i = std::max(i + 1, j);
      continue;
    }

    // Fallback for short standalone runs outside a CREATE schema.
    size_t j = i;
    vector<size_t> name_widths;
    struct ColLine { string lhs; string rhs; bool comma; };
    vector<ColLine> cols;
    while (j < lines.size() && looks_like_create_column_line(lines[j]) && leading_space_count(lines[j]) == indent) {
      string t = trim_ascii_spaces(lines[j]);
      bool comma = false;
      if (!t.empty() && t.back() == ',') { comma = true; t.pop_back(); t = rtrim_spaces(t); }
      const size_t close = t.find('`', 1);
      string lhs = t.substr(0, close + 1);
      string rhs = trim_ascii_spaces(t.substr(close + 1));
      name_widths.push_back(utf8_width(lhs));
      cols.push_back({lhs, rhs, comma});
      ++j;
    }
    const size_t width = column_name_align_width(name_widths);
    if (cols.size() >= 2) {
      bool ok = true;
      vector<string> rendered;
      for (const auto& col : cols) {
        string line(indent, ' ');
        line += col.lhs;
        line += string(column_name_padding(width, utf8_width(col.lhs)), ' ');
        line += col.rhs;
        if (col.comma) append_item_comma(line);
        if (utf8_width(line) > max_width) ok = false;
        rendered.push_back(std::move(line));
      }
      if (ok) {
        for (size_t k = i; k < j; ++k) lines[k] = std::move(rendered[k - i]);
      }
    }
    i = j;
  }
}
}  // namespace

namespace {
struct IndexAlignmentLine {
  string head = "INDEX";  // or `ADD INDEX [IF NOT EXISTS]` (ALTER TABLE)
  string name;
  string expression;
  string type;
  string granularity;
  bool comma = false;
};
}  // namespace

namespace {
optional<IndexAlignmentLine> parse_index_alignment_line(string_view line) {
  string t = trim_ascii_spaces(line);
  bool comma = false;
  if (!t.empty() && t.back() == ',') {
    comma = true;
    t.pop_back();
    t = rtrim_spaces(t);
  }
  // `ADD INDEX [IF NOT EXISTS] name expr TYPE ... GRANULARITY n [FIRST|AFTER c]`
  // of a one-command ALTER TABLE stacks like a CREATE TABLE index.
  string head = "INDEX";
  if (starts_with_ci(t, "INDEX ")) {
    t = trim_ascii_spaces(t.substr(6));
  } else if (starts_with_ci(t, "ADD INDEX ")) {
    head = "ADD INDEX";
    t = trim_ascii_spaces(t.substr(10));
    if (starts_with_ci(t, "IF NOT EXISTS ")) {
      head += " IF NOT EXISTS";
      t = trim_ascii_spaces(t.substr(14));
    }
  } else {
    return std::nullopt;
  }
  string rest = t;
  const int type_pos = find_top_level_keyword(rest, "TYPE");
  if (type_pos <= 0) return std::nullopt;
  const int granularity_pos = find_top_level_keyword(rest, "GRANULARITY", static_cast<size_t>(type_pos) + 4);
  if (granularity_pos <= type_pos) return std::nullopt;

  const string left = trim_ascii_spaces(rest.substr(0, static_cast<size_t>(type_pos)));
  // `INDEX name expr` or `INDEX name(expr)` (no space before the expression).
  const size_t name_end = left.find_first_of(" \t\n(");
  if (name_end == string::npos || name_end == 0) return std::nullopt;
  IndexAlignmentLine out;
  out.head = head;
  out.name = trim_ascii_spaces(left.substr(0, name_end));
  out.expression = trim_ascii_spaces(left.substr(left[name_end] == '(' ? name_end : name_end + 1));
  out.type = trim_ascii_spaces(rest.substr(static_cast<size_t>(type_pos) + 4,
      static_cast<size_t>(granularity_pos - type_pos - 4)));
  out.granularity = trim_ascii_spaces(rest.substr(static_cast<size_t>(granularity_pos) + 11));
  out.comma = comma;
  if (out.name.empty() || out.expression.empty() || out.type.empty() || out.granularity.empty()) return std::nullopt;
  return out;
}
}  // namespace

namespace {
void align_create_index_groups(vector<string>& lines, size_t width) {
  for (size_t i = 0; i < lines.size();) {
    auto first = parse_index_alignment_line(lines[i]);
    if (!first) { ++i; continue; }
    const size_t indent = leading_space_count(lines[i]);
    vector<IndexAlignmentLine> group;
    size_t j = i;
    while (j < lines.size() && leading_space_count(lines[j]) == indent) {
      auto parsed = parse_index_alignment_line(lines[j]);
      if (!parsed || parsed->head != first->head) break;
      group.push_back(std::move(*parsed));
      ++j;
    }
    // An index that does not fit the width, aligned or alone, is stacked.
    // The stacked form is `INDEX name expr`, then `TYPE …` and `GRANULARITY …` as continuation lines.
    // Alignment applies only when every aligned row fits.
    auto stacked = [&](const IndexAlignmentLine& row) {
      const string pad(indent, ' ');
      string rendered = pad + row.head + " " + row.name + " " + row.expression;
      rendered += "\n" + pad + "    TYPE " + row.type;
      rendered += "\n" + pad + "    GRANULARITY " + row.granularity;
      if (row.comma) append_item_comma(rendered);
      return rendered;
    };
    auto flat_width = [&](const IndexAlignmentLine& row) {
      return indent + utf8_width(row.head + " " + row.name + " " + row.expression + " TYPE " + row.type +
                                 " GRANULARITY " + row.granularity) + (row.comma ? 1 : 0);
    };
    bool stack_group = false;
    if (group.size() >= 2) {
      size_t n = 0, e = 0, t = 0;
      for (const auto& row : group) {
        n = std::max(n, utf8_width(row.name));
        e = std::max(e, utf8_width(row.expression));
        t = std::max(t, utf8_width(row.type));
      }
      for (const auto& row : group) {
        if (indent + row.head.size() + 1 + n + 1 + e + 1 + 5 + t + 1 + 12 + utf8_width(row.granularity) + 1 > width) stack_group = true;
      }
    } else if (flat_width(group.front()) > width) {
      stack_group = true;
    }
    if (stack_group) {
      for (size_t k = 0; k < group.size(); ++k) lines[i + k] = stacked(group[k]);
      i = j;
      continue;
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
        rendered += row.head + " " + row.name;
        rendered += string(name_width - utf8_width(row.name) + 1, ' ');
        rendered += row.expression;
        rendered += string(expression_width - utf8_width(row.expression) + 1, ' ');
        rendered += "TYPE " + row.type;
        rendered += string(type_width - utf8_width(row.type) + 1, ' ');
        rendered += "GRANULARITY " + row.granularity;
        if (row.comma) append_item_comma(rendered);
        lines[i + k] = std::move(rendered);
      }
    }
    i = j;
  }
}
}  // namespace

namespace {
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
  ScanState st;

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
    if (st.in_code() && c == '(') {
      const string ident = preceding_identifier(i);
      stack.push_back({iequals_ascii(ident, "Tuple"), current_indent(i), line});
      out.push_back(c);
      continue;
    }

    if (st.in_code() && c == ')' && !stack.empty()) {
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

    // Everything else is copied as it is. This includes a comment or a text. A line break moves the line counters.
    const size_t from = i;
    step_scan(st, source, i);
    for (size_t k = from; k <= i; ++k) {
      out.push_back(source[k]);
      if (source[k] == '\n') {
        ++line;
        source_line_start = k + 1;
        output_line_start = out.size();
      }
    }
  }
  return out;
}
}  // namespace

namespace {
void split_long_string_alias_lines(vector<string>& lines, size_t max_width) {
  for (size_t i = 0; i < lines.size(); ++i) {
    if (utf8_width(lines[i]) <= max_width) continue;
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
}  // namespace

namespace {
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
}  // namespace

namespace {
string format_long_enum_type_lines(string_view source) {
  const vector<string> lines = split_lines_keep(source);
  vector<string> rendered;
  rendered.reserve(lines.size() + 32);

  const auto enum_at = [](string_view line, size_t start = 0) -> size_t {
    ScanState st;
    for (size_t i = 0; i < line.size(); ++i) {
      const bool lexical = st.in_code();
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
    // Short enums are more readable inline.
    // Long ClickHouse system enums can contain dozens of values. Each value must be on its own line.
    if (enum_items.size() < 5 && line.size() <= 100) {
      rendered.push_back(line);
      continue;
    }

    const size_t indent = leading_space_count(line);
    const string enum_name = string(line.substr(enum_pos, enum_open - enum_pos));

    // Special-case Map(Enum*, ValueType).
    // When the enum becomes multiline, the enclosing Map must also become a structured block.
    // Otherwise the output degenerates into `Map(Enum8( ... ), UInt32)` with mismatched closers.
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
                  if (i + 1 < enum_items.size()) append_item_comma(value);
                  rendered.push_back(std::move(value));
                }
                string close(indent + 4, ' ');
                close += ')';
                if (arg + 1 < map_items.size()) append_item_comma(close);
                rendered.push_back(std::move(close));
              } else {
                string value(indent + 4, ' ');
                value += trim_ascii_spaces(map_items[arg]);
                if (arg + 1 < map_items.size()) append_item_comma(value);
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
      if (i + 1 < enum_items.size()) append_item_comma(value);
      rendered.push_back(std::move(value));
    }
    rendered.push_back(string(indent, ' ') + ")" + string(line.substr(enum_close + 1)));
  }
  return join_lines(rendered);
}
}  // namespace

string normalize_final_layout(string_view s, size_t width) {
  const string enum_formatted = format_long_enum_type_lines(s);
  vector<string> lines = split_lines_keep(align_multiline_tuple_closers(enum_formatted));
  split_long_string_alias_lines(lines, width);
  align_create_columns(lines, width);
  align_create_index_groups(lines, width);
  align_alias_groups(lines, width);
  split_combined_limit_lines(lines);
  return join_lines(lines);
}

}  // namespace fmt
}  // namespace chdash
