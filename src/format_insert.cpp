// INSERT, DELETE, KILL and OPTIMIZE. This unit covers the head of an INSERT, its VALUES rows and its SELECT.
// format_internal.hpp contains the declarations that the units share.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

// `INSERT INTO target (cols)` is formatted for the line width. It stays unchanged when it fits. Otherwise, the table is on its own line, and the column list is on one indented line.
// When that does not fit either, each column is on its own line (the layout of INSERT ... VALUES). A target that is a table function, or has no column list, stays unchanged.
string Formatter::layout_insert_head(string_view target_view) {
  const FormatDepthGuard guard(depth);
  const string target = trim_ascii_spaces(target_view);
  string plain = "INSERT INTO " + target;
  if (utf8_width(plain) <= threshold || target.find('\n') != string::npos) return plain;
  if (starts_with_ci(target, "FUNCTION ") || starts_with_ci(target, "TABLE FUNCTION ")) return plain;
  string name;
  string cols;
  {
    ScanState st;
    for (size_t i = 0; i < target.size(); ++i) {
      if (is_top_level(st) && target[i] == '(') {
        cols = unwrap_outer_parens(target.substr(i));
        name = trim_ascii_spaces(target.substr(0, i));
        break;
      }
      step_scan(st, target, i);
    }
  }
  if (cols.empty() || name.empty() || name.find_first_of(" \t\n") != string::npos) return plain;
  vector<string> items;
  for (auto& item : split_top_level(cols, ',')) items.push_back(trim_ascii_spaces(item));
  string joined;
  for (size_t i = 0; i < items.size(); ++i) joined += (i ? ", " : "") + items[i];
  string out = "INSERT INTO " + name;
  const string line = "    (" + joined + ")";
  if (utf8_width(line) <= threshold) return out + "\n" + line;
  out += "\n    (\n";
  for (size_t i = 0; i < items.size(); ++i) out += "        " + items[i] + (i + 1 < items.size() ? ",\n" : "\n");
  return out + "    )";
}

// `INSERT INTO t (cols) FORMAT name` has no SELECT and no VALUES. An inline payload is removed before this point.
// When the statement is too wide, the column list breaks like the list of INSERT ... VALUES, and FORMAT starts its own line.
// Any other statement (SETTINGS, comments) keeps the one-line form.
string Formatter::format_insert_format_clause(string_view s) {
  const FormatDepthGuard guard(depth);
  const string text = trim_ascii_spaces(s);
  if (contains_top_level_comment(text) || find_top_level_keyword(text, "SETTINGS") > 0) return cleanup_surface(text);
  const int fmt_pos = find_top_level_keyword(text, "FORMAT");
  const string head_text = trim_ascii_spaces(fmt_pos > 0 ? text.substr(11, static_cast<size_t>(fmt_pos) - 11) : text.substr(11));
  const string tail = fmt_pos > 0 ? collapse_whitespace(trim_ascii_spaces(text.substr(static_cast<size_t>(fmt_pos)))) : string();
  string head = layout_insert_head(head_text);
  if (tail.empty()) return head;
  if (head.find('\n') == string::npos && utf8_width(head + " " + tail) <= threshold) return head + " " + tail;
  return head + "\n" + tail;
}

string Formatter::format_insert_select_like(string_view s) {
  const FormatDepthGuard guard(depth);
  const string text = trim_ascii_spaces(s);
  int pos = find_top_level_keyword(text, "SELECT");
  if (pos < 0) return format_insert_format_clause(text);
  // `INSERT INTO t (cols) WITH cte AS (...) SELECT ...`. The query starts at its WITH. The WITH is not part of the target.
  if (const int with_pos = find_top_level_keyword(text, "WITH"); with_pos > 11 && with_pos < pos) pos = with_pos;
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
    // A target that spans lines (`FUNCTION s3(`, split by an earlier pass, which the comment path keeps) ends on the line of its closing bracket.
    size_t cut = nl;
    if (const size_t open = before.find('('); open != string::npos && open < nl) {
      if (const size_t close = find_matching_paren(before, open); close != string::npos && close > nl) {
        cut = before.find('\n', close);
      }
    }
    target = collapse_whitespace(trim_ascii_spaces(string_view(before).substr(0, cut)));
    between = cut == string::npos ? string() : trim_ascii_spaces(string_view(before).substr(cut + 1));
  }
  if (starts_with_ci(trim_ascii_spaces(between), "/*")) between = reflow_block_comment(between);
  string out = layout_insert_head(target);
  if (!between.empty()) out += "\n" + between;
  out += "\n" + format_statement(text.substr(static_cast<size_t>(pos)));
  return out;
}

// `KILL QUERY | MUTATION [ON CLUSTER c] WHERE cond [SYNC | ASYNC | TEST]`. The condition uses the format of a WHERE clause. formatQuery puts parentheses around every comparison.
// The statement stays on one line when it fits with one condition. Otherwise, WHERE and the mode each start their own line.
string Formatter::format_kill(string_view s) {
  const FormatDepthGuard guard(depth);
  if (contains_top_level_comment(s)) return cleanup_surface(s);
  const string text = collapse_whitespace(trim_ascii_spaces(s));
  const int where_pos = find_top_level_keyword(text, "WHERE");
  if (where_pos <= 0) return cleanup_surface(text);
  string cond = trim_ascii_spaces(text.substr(static_cast<size_t>(where_pos) + 5));
  string mode;
  for (const char* kw : {"SYNC", "ASYNC", "TEST"}) {
    const string suffix = string(" ") + kw;
    if (ends_with_ci(cond, suffix)) {
      mode = kw;
      cond = rtrim_spaces(cond.substr(0, cond.size() - suffix.size()));
      break;
    }
  }
  const string head = cleanup_surface(trim_ascii_spaces(text.substr(0, static_cast<size_t>(where_pos))));
  const string where = format_clause("WHERE", cond);
  string one_line = head + " " + where + (mode.empty() ? "" : " " + mode);
  if (where.find('\n') == string::npos && utf8_width(one_line) <= threshold) return one_line;
  return head + "\n" + where + (mode.empty() ? "" : "\n" + mode);
}

string Formatter::format_delete(string_view s) {
  const FormatDepthGuard guard(depth);
  const string text = trim_ascii_spaces(s);
  const int pos = find_top_level_keyword(text, "WHERE");
  if (pos < 0) return cleanup_surface(text);
  return trim_ascii_spaces(text.substr(0, static_cast<size_t>(pos))) + "\nWHERE\n" + indent_block(format_bool_expr(text.substr(static_cast<size_t>(pos) + 5)), 4);
}

string Formatter::format_optimize_table(string_view s) {
  const FormatDepthGuard guard(depth);
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

// INSERT ... VALUES keeps every value exactly as written. VALUES payloads are data, not expressions. The formatter changes only the separators and the line breaks around the values:
//   * the whole statement on one line when it fits the width;
//   * otherwise `INSERT INTO target`, then the column list on one indented line
//     (or one column per line when that does not fit), then `VALUES`, then one row
//     per line (or one value per line for a row that does not fit).
string Formatter::try_format_insert_values(string_view s) {
  const FormatDepthGuard guard(depth);
  const string text = trim_ascii_spaces(s);
  if (!starts_with_ci(text, "INSERT INTO ")) return {};
  const int values_pos = find_top_level_keyword(text, "VALUES");
  if (values_pos < 0) return {};
  const string head = trim_ascii_spaces(text.substr(0, static_cast<size_t>(values_pos)));
  const string tail = trim_ascii_spaces(text.substr(static_cast<size_t>(values_pos) + 6));
  if (tail.empty() || tail.front() != '(') return {};
  // `INSERT INTO VALUES (...)` has no target. The generic path keeps the statement as written.
  if (head.size() <= 12) return {};

  // Head: `INSERT INTO target`, with an optional column list. Outside `INSERT INTO FUNCTION …` (the generic path handles that form), the target cannot be a call.
  // Its first top-level `(` opens the column list.
  string target = trim_ascii_spaces(head.substr(12));
  if (starts_with_ci(target, "FUNCTION ") || starts_with_ci(target, "TABLE FUNCTION ")) return {};
  // `INSERT INTO t [(cols)] SETTINGS k = v, … VALUES …`. Separate the settings first. The formatter writes them between the column list and VALUES.
  string settings;
  if (const int settings_pos = find_top_level_keyword(target, "SETTINGS"); settings_pos > 0) {
    settings = collapse_whitespace(trim_ascii_spaces(target.substr(static_cast<size_t>(settings_pos) + 8)));
    target = trim_ascii_spaces(target.substr(0, static_cast<size_t>(settings_pos)));
    if (settings.empty()) return {};
  }
  string cols;
  {
    ScanState st;
    for (size_t i = 0; i < target.size(); ++i) {
      if (is_top_level(st) && target[i] == '(') {
        const string inner = unwrap_outer_parens(target.substr(i));
        if (inner.empty()) return {};
        cols = inner;
        target = trim_ascii_spaces(target.substr(0, i));
        break;
      }
      step_scan(st, target, i);
    }
  }
  if (target.empty() || target.find_first_of(" \t\n") != string::npos) return {};

  // Rows: `(…), (…), …` at the top level. The generic path handles all other clauses, such as trailing clauses.
  vector<vector<string>> rows;
  {
    size_t i = 0;
    while (i < tail.size()) {
      while (i < tail.size() && (tail[i] == ' ' || tail[i] == '\n' || tail[i] == '\t' || tail[i] == ',')) ++i;
      if (i >= tail.size()) break;
      if (tail[i] != '(') return {};
      const size_t start = i;
      // ScanState tracks parentheses and quotes. The row ends at the `)` that returns the scan to the top level.
      ScanState row_state;
      size_t end = string::npos;
      for (size_t j = i; j < tail.size(); ++j) {
        step_scan(row_state, tail, j);
        if (tail[j] == ')' && is_top_level(row_state)) { end = j; break; }
      }
      if (end == string::npos) return {};
      vector<string> items;
      for (auto& item : split_top_level(tail.substr(start + 1, end - start - 1), ',')) items.push_back(trim_ascii_spaces(item));
      rows.push_back(std::move(items));
      i = end + 1;
    }
  }
  if (rows.empty()) return {};

  auto join = [](const vector<string>& items) {
    string out;
    for (size_t i = 0; i < items.size(); ++i) {
      if (i) out += ", ";
      out += items[i];
    }
    return out;
  };
  const vector<string> col_items = cols.empty() ? vector<string>{} : [&] {
    vector<string> v;
    for (auto& c : split_top_level(cols, ',')) v.push_back(trim_ascii_spaces(c));
    return v;
  }();
  const bool multiline_value = [&] {
    for (const auto& row : rows) for (const auto& v : row) if (v.find('\n') != string::npos) return true;
    return false;
  }();

  string compact = "INSERT INTO " + target;
  if (!col_items.empty()) compact += " (" + join(col_items) + ")";
  if (!settings.empty()) compact += " SETTINGS " + settings;
  compact += " VALUES ";
  for (size_t r = 0; r < rows.size(); ++r) {
    if (r) compact += ", ";
    compact += "(" + join(rows[r]) + ")";
  }
  if (!multiline_value && utf8_width(compact) <= threshold) return compact;

  string out = "INSERT INTO " + target;
  if (!col_items.empty()) {
    const string line = "    (" + join(col_items) + ")";
    if (utf8_width(line) <= threshold) {
      out += "\n" + line;
    } else {
      out += "\n    (\n";
      for (size_t i = 0; i < col_items.size(); ++i) {
        out += "        " + col_items[i];
        if (i + 1 < col_items.size()) append_item_comma(out);
        out += '\n';
      }
      out += "    )";
    }
  }
  if (!settings.empty()) out += "\nSETTINGS " + settings;
  out += "\nVALUES";
  for (size_t r = 0; r < rows.size(); ++r) {
    const string suffix = r + 1 < rows.size() ? "," : "";
    const string line = "    (" + join(rows[r]) + ")" + suffix;
    if (line.find('\n') == string::npos && utf8_width(line) <= threshold) {
      out += "\n" + line;
      continue;
    }
    out += "\n    (\n";
    for (size_t i = 0; i < rows[r].size(); ++i) {
      string value = "        " + rows[r][i] + (i + 1 < rows[r].size() ? "," : "");
      // A value that is still too long on its own line (a call such as `encrypt(...)`) is split by the width rule, as a query argument is.
      if (utf8_width(value) > threshold && value.find('\n') == string::npos) value = join_lines(explode_overlong_line(value, 0));
      out += value + '\n';
    }
    out += "    )" + suffix;
  }
  return out;
}

}  // namespace fmt
}  // namespace chdash
