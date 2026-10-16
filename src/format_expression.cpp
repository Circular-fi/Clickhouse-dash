// This unit formats the expressions: calls, windows, arrays, arithmetic, CASE, IN, EXISTS, and the boolean conditions.
// format_internal.hpp contains the declarations that the units share.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

namespace {
// A comma list has items with `--` comments. Each whole-line comment before an item belongs after the previous item. That comment was written after the comma of that item.
// Comments before the first item stay above it. The function returns false when a comment is inside an item, such as a block comment or a comment within a value. The caller then does not change the list.
struct CommentedItems {
  vector<string> items;
  vector<string> after;
  string before_first;
};
}  // namespace

namespace {
bool split_commented_items(string_view inner, CommentedItems* out) {
  for (const auto& raw : split_top_level(inner, ',')) {
    string value = trim_ascii_spaces(raw);
    while (starts_with_ci(value, "--") || starts_with_ci(value, "#")) {
      auto [lead, rest] = split_leading_line_comment(value);
      if (out->items.empty()) out->before_first += (out->before_first.empty() ? "" : "\n") + lead;
      else out->after.back() += (out->after.back().empty() ? "" : " ") + lead;
      value = rest;
    }
    // An empty item is a trailing comma. `('a',)` is a one-element tuple, not a parenthesized string. Keep such a list as written.
    if (value.empty()) return false;
    auto [code, trailing] = split_inline_comment(value);
    // The item's own formatter formats the comments nested in brackets. A block comment at the top level of the item has no place here.
    if (contains_top_level_comment(code)) return false;
    out->items.push_back(trim_ascii_spaces(code));
    out->after.push_back(trailing);
  }
  return !out->items.empty();
}
}  // namespace

string Formatter::format_over_clause(string_view expr) {
  const FormatDepthGuard guard(depth);
  const string s = trim_ascii_spaces(expr);
  const int pos = find_top_level_keyword(s, "OVER");
  if (pos < 0) return {};
  const string head = rtrim_spaces(s.substr(0, static_cast<size_t>(pos)));
  const string inner = unwrap_outer_parens(trim_ascii_spaces(s.substr(static_cast<size_t>(pos) + 4)));
  if (inner.empty()) return {};
  bool multiline = false;
  const vector<string> lines = window_spec_lines(inner, head.size(), &multiline);
  if (lines.empty() || !multiline) return {};
  return head + " OVER (\n" + indent_block(join_lines(lines), 4) + "\n)";
}

// The clauses of a window specification, one per line. The specification is the body of `OVER (...)` or of `WINDOW name AS (...)`.
// `forced` is set when the specification always has one clause per line (PARTITION BY or a frame). An empty result means that the text is not a clause list.
vector<string> Formatter::window_spec_lines(string_view inner_view, size_t head_size, bool* forced) {
  const FormatDepthGuard guard(depth);
  const string inner(inner_view);
  const int part_pos = find_top_level_keyword(inner, "PARTITION BY");
  const int order_pos = find_top_level_keyword(inner, "ORDER BY");
  // Window frame: ROWS or RANGE. formatQuery always prints the BETWEEN form.
  string frame_kw = "ROWS BETWEEN";
  int rows_pos = find_top_level_keyword(inner, frame_kw);
  if (const int range_pos = find_top_level_keyword(inner, "RANGE BETWEEN");
      range_pos >= 0 && (rows_pos < 0 || range_pos < rows_pos)) {
    rows_pos = range_pos;
    frame_kw = "RANGE BETWEEN";
  }
  if (part_pos < 0 && order_pos < 0 && rows_pos < 0) return {};

  vector<string> lines;
  *forced = inner.find('\n') != string::npos || part_pos >= 0 || rows_pos >= 0;

  // `OVER (base_window ROWS BETWEEN ...)` extends a named window. The name before the first clause is part of the definition. EXPLAIN AST does not show this name.
  // Such a removal goes unnoticed. The name stays the first line.
  size_t first_clause = inner.size();
  for (const int clause_pos : {part_pos, order_pos, rows_pos}) {
    if (clause_pos >= 0) first_clause = std::min(first_clause, static_cast<size_t>(clause_pos));
  }
  if (const string parent = trim_ascii_spaces(inner.substr(0, first_clause)); !parent.empty()) lines.push_back(parent);

  if (part_pos >= 0) {
    const size_t end = (order_pos >= 0) ? static_cast<size_t>(order_pos) : ((rows_pos >= 0) ? static_cast<size_t>(rows_pos) : inner.size());
    const string body = trim_ascii_spaces(inner.substr(static_cast<size_t>(part_pos) + 12, end - static_cast<size_t>(part_pos) - 12));
    // A partition list with comments after its commas has one key on each line. Each comment follows its key.
    // If kept as written, the layout drifted on every pass.
    CommentedItems keys;
    if (mask_sql_surface(body).has_comments && split_commented_items(body, &keys)) {
      string block = keys.before_first.empty() ? string() : keys.before_first + "\n";
      for (size_t j = 0; j < keys.items.size(); ++j) {
        block += format_expression(keys.items[j]) + (j + 1 < keys.items.size() ? "," : "");
        if (!keys.after[j].empty()) block += " " + keys.after[j];
        if (j + 1 < keys.items.size()) block += "\n";
      }
      lines.push_back("PARTITION BY\n" + indent_block(block, 4));
    } else {
      lines.push_back("PARTITION BY " + format_expression(body));
    }
  }

  if (order_pos >= 0) {
    const size_t end = (rows_pos >= 0) ? static_cast<size_t>(rows_pos) : inner.size();
    const string body = trim_ascii_spaces(inner.substr(static_cast<size_t>(order_pos) + 8, end - static_cast<size_t>(order_pos) - 8));
    const auto items = split_top_level(body, ',');
    const bool multiline_order = body.find('\n') != string::npos || items.size() > 2 ||
                                 (part_pos >= 0 && items.size() > 1) ||
                                 (items.size() > 1 && body.size() > threshold / 2) ||
                                 (items.size() > 1 && head_size > 20 && body.size() > 35);
    if (multiline_order) lines.push_back("ORDER BY\n" + indent_block(format_simple_item_block(items), 4));
    else lines.push_back("ORDER BY " + cleanup_surface(body));
  }

  if (rows_pos >= 0) {
    const string body = trim_ascii_spaces(inner.substr(static_cast<size_t>(rows_pos) + frame_kw.size()));
    lines.push_back(frame_kw + " " + cleanup_surface(body));
  }
  return lines;
}

// `WINDOW name AS (spec), ...`. A definition that fits stays on one line. A longer definition formats its specification like `OVER (...)`, with one clause per line.
string Formatter::format_window_clause(string_view body) {
  const FormatDepthGuard guard(depth);
  const string text = trim_ascii_spaces(body);
  const bool commented = mask_sql_surface(text).has_comments;
  // Without comments, line breaks are only an earlier layout of this clause. The comment-preserving path keeps them.
  // Each definition is judged on one line. So a second pass gives the same result.
  const auto items = split_top_level(commented ? text : collapse_whitespace(text), ',');
  const bool single = items.size() == 1 && (!commented || text.find('\n') == string::npos);
  const size_t indent = single ? 0 : 4;
  vector<string> rendered;
  for (size_t i = 0; i < items.size(); ++i) {
    const string item = trim_ascii_spaces(items[i]);
    const string comma = i + 1 < items.size() ? "," : "";
    string line = format_expression(item);
    const size_t prefix = single ? string_view("WINDOW ").size() : indent;
    const int as_pos = find_top_level_keyword(item, "AS");
    if (!commented && line.find('\n') == string::npos && utf8_width(line) + prefix + comma.size() > threshold && as_pos > 0) {
      const string name = trim_ascii_spaces(item.substr(0, static_cast<size_t>(as_pos)));
      const string spec = trim_ascii_spaces(item.substr(static_cast<size_t>(as_pos) + 2));
      const string inner = unwrap_outer_parens(spec);
      bool forced = false;
      const vector<string> lines = inner.empty() ? vector<string>{} : window_spec_lines(inner, name.size(), &forced);
      if (!lines.empty()) line = name + " AS (\n" + indent_block(join_lines(lines), 4) + "\n)";
    }
    rendered.push_back(line + comma);
  }
  if (single) return "WINDOW " + rendered.front();
  return "WINDOW\n" + indent_block(join_lines(rendered), 4);
}

string Formatter::format_array_literal(string_view expr) {
  const FormatDepthGuard guard(depth);
  const string s = trim_ascii_spaces(expr);
  if (s.size() < 2 || s.front() != '[' || s.back() != ']') return {};
  const string inner = trim_ascii_spaces(s.substr(1, s.size() - 2));
  if (mask_sql_surface(inner).has_comments) {
    CommentedItems list;
    if (!split_commented_items(inner, &list)) return {};
    string out = "[\n";
    if (!list.before_first.empty()) out += indent_block(list.before_first, 4) + "\n";
    for (size_t i = 0; i < list.items.size(); ++i) {
      out += indent_block(format_expression(list.items[i]), 4);
      if (i + 1 < list.items.size()) append_item_comma(out);
      if (!list.after[i].empty()) out += " " + list.after[i];
      out += '\n';
    }
    return out + "]";
  }
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
        if (j + 1 < tuple_items.size()) append_item_comma(tuple);
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
    if (i + 1 < rendered.size()) append_item_comma(out);
    out += '\n';
  }
  out += ']';
  return out;
}

string Formatter::format_function_call(string_view expr, bool force) {
  const FormatDepthGuard guard(depth);
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
    // A comment before the first argument has no argument to follow. It stays on its own line above that argument. The expression formatter keeps a comment line at the start.
    if (!leading_comment.empty() && args.empty()) current = leading_comment + "\n" + current;
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

  // The compact forms below join the source arguments. They never join arguments that have a comment between or inside them.
  bool arg_comments = false;
  for (size_t i = 0; i < args.size(); ++i) {
    arg_comments = arg_comments || !comments_after[i].empty() || mask_sql_surface(args[i]).has_comments;
  }
  if (!force && !arg_comments && iequals_ascii(name, "arrayFilter") && args.size() >= 2) {
    string compact = compact_source_args();
    const int arrow = find_top_level_arrow(args.front());
    string rhs = arrow > 0 ? trim_ascii_spaces(string_view(args.front()).substr(static_cast<size_t>(arrow) + 2)) : string();
    if (const string inner_rhs = unwrap_outer_parens(rhs); !inner_rhs.empty()) rhs = inner_rhs;
    if (compact.size() <= wrap_threshold && !rhs.empty() && rhs.find('(') == string::npos &&
        find_top_level_keyword(rhs, "AND") < 0 && find_top_level_keyword(rhs, "OR") < 0) {
      return compact;
    }
  }

  if (!force && !arg_comments && s.find('\n') == string::npos) {
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
    // A condition argument (`if(c, ...)`, `sumIf(x, c)`, `countIf(a AND b)`) uses the layout of a WHERE condition. That layout also removes the parentheses that formatQuery puts around each operand.
    // The argument stays wrapped here. The width pass joins it onto one line when it fits at its final position.
    const bool condition = (iequals_ascii(name, "if") && i == 0) ||
        (find_top_level_arrow(args[i]) < 0 && !looks_like_query(args[i]) && !contains_top_level_comment(args[i]) &&
         (find_top_level_keyword(args[i], "AND") >= 0 || find_top_level_keyword(args[i], "OR") >= 0));
    rendered.push_back(condition ? format_bool_expr(args[i]) : format_expression(args[i]));
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
    // An inline call still has its formatted arguments. So a condition nested in it (`nullIf(countIf((a = 1) AND (b = 2)), 0)`) loses the operand parentheses that formatQuery added.
    // The same happens in a split call.
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
  // Pair layouts keep a comment that follows a pair's second element at the end of the pair line.
  // A comment after the first element of a pair, or after a multi-line element, has no place there. The call then uses one argument on each line.
  auto comment_after = [&](size_t i) { return i < comments_after.size() ? comments_after[i] : string(); };
  auto with_comment = [&](size_t i) { const string c = comment_after(i); return c.empty() ? string() : " " + c; };
  auto pairs_fit_comments = [&](size_t first) {
    for (size_t i = first; i < rendered.size(); ++i) {
      const bool second = (i - first) % 2 == 1 || i + 1 == rendered.size();
      if (!comment_after(i).empty() && (!second || rendered[i].find('\n') != string::npos)) return false;
    }
    return true;
  };
  if (iequals_ascii(name, "multiIf") && rendered.size() >= 3 && pairs_fit_comments(0)) {
    for (size_t i = 0; i + 1 < rendered.size(); i += 2) {
      if (i + 1 == rendered.size() - 1) break;
      out += "    " + rendered[i] + ", " + rendered[i + 1] + "," + with_comment(i + 1) + "\n";
    }
    out += "    " + rendered.back() + with_comment(rendered.size() - 1) + "\n)";
    return out;
  }
  // `CASE x WHEN ... END` reaches this code as caseWithExpression(x, w1, t1, ..., else). The operand keeps its own line.
  // Then each `when, then` pair is on its own line.
  if (iequals_ascii(name, "caseWithExpression") && rendered.size() >= 4 && rendered.size() % 2 == 0 &&
      comment_after(0).empty() && pairs_fit_comments(1)) {
    out += "    " + rendered.front() + ",\n";
    for (size_t i = 1; i + 1 < rendered.size(); i += 2) out += "    " + rendered[i] + ", " + rendered[i + 1] + "," + with_comment(i + 1) + "\n";
    out += "    " + rendered.back() + with_comment(rendered.size() - 1) + "\n)";
    return out;
  }
  if (iequals_ascii(name, "map") && rendered.size() >= 2 && pairs_fit_comments(0)) {
    for (size_t i = 0; i < rendered.size(); i += 2) {
      out += "    " + rendered[i];
      if (i + 1 < rendered.size()) out += ", " + rendered[i + 1];
      if (i + 2 < rendered.size()) append_item_comma(out);
      out += with_comment(std::min(i + 1, rendered.size() - 1)) + '\n';
    }
    out += ')';
    return out;
  }
  for (size_t i = 0; i < rendered.size(); ++i) {
    // Among several arguments, an unindented `/ rhs` line reads as the next argument. A sole argument keeps its operators aligned.
    out += indent_block(rendered.size() > 1 ? hang_operator_continuations(rendered[i], true) : rendered[i], 4);
    if (i + 1 < rendered.size()) append_item_comma(out);
    if (i < comments_after.size() && !comments_after[i].empty()) out += " " + comments_after[i];
    out += '\n';
  }
  out += ')';
  return out;
}

// Parametric aggregates `name(params)(args)` (windowFunnel(3600)(...), quantiles(0.5, 0.9)(x), sequenceMatch('(?1)(?2)')(t, c1, c2)). Both lists follow the ordinary function-call rules.
// The argument list uses the layout of a call. The head of that call is the whole `name(params)` prefix. So the list wraps when a plain call of the same length wraps.
// The parameter list goes vertical only when the head alone does not fit.
string Formatter::format_parametric_call(const string& name, string_view params_src, string_view args_part, bool force) {
  const FormatDepthGuard guard(depth);
  const size_t wrap_threshold = std::min<size_t>(threshold, 80);
  const auto params = split_top_level(params_src, ',');
  string head = name + "(";
  for (size_t i = 0; i < params.size(); ++i) {
    if (i) head += ", ";
    head += cleanup_surface(trim_ascii_spaces(params[i]));
  }
  head += ")";
  const bool multiline_params = head.size() + 1 > wrap_threshold || params_src.find('\n') != string_view::npos;
  // Use a stand-in of the same width for the head. format_function_call accepts only an identifier before the argument list.
  string stand_in(head.size(), 'P');
  if (multiline_params) {
    string block;
    for (size_t i = 0; i < params.size(); ++i) {
      block += indent_block(format_expression(params[i]), 4);
      if (i + 1 < params.size()) append_item_comma(block);
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

// Long arithmetic wraps at the operators of its lowest precedence level. Each line holds one operand, and the operator leads the line (`a * w\n+ b * w\n+ c * w`). The layout then shows the grouping that the parser applies.
// Operands keep their own structure. A parenthesized operand that is too long opens a block.
// The function returns the continuation lines unindented. The enclosing context (SELECT item, WHERE term, or function argument) decides how far they hang.
string Formatter::format_arith_chain(string_view expr, bool force) {
  const FormatDepthGuard guard(depth);
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
    // Short chains stay inline. This is true even when one operand alone expands, such as a three-argument call. Heavy operands, such as lambdas and subqueries, never expand.
    if (operand.find('\n') != string::npos || contains_heavy_structure(operand)) multiline = true;
  }
  if (!multiline) return {};
  // Sibling groups read alike. When one operand opens a block, other long parenthesized chains open a block too. Example: `(\n...\n) / (\n...\n)`.
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
  // A block operand (a scalar subquery, or a long parenthesized chain) opens on the line of the operator. formatQuery prints it this way, for example `a / (\n    SELECT ...\n)`.
  // If the operator leads its own line, it hangs one level deeper than the block that it opens and closes.
  vector<bool> query_blocks(operands.size(), false);
  for (size_t i = 0; i < operands.size(); ++i) {
    const string inner = unwrap_outer_parens(operands[i]);
    query_blocks[i] = !inner.empty() && looks_like_query(inner) && starts_with_ci(rendered[i], "(\n");
  }
  string out = rendered.front();
  for (size_t i = 0; i < operators.size(); ++i) {
    // After a closing block, the operator continues on the `)` line. This is the same as `) AS` for a multiline call. Otherwise, the operator leads the next line.
    const size_t nl = out.rfind('\n');
    const string last_line = out.substr(nl == string::npos ? 0 : nl + 1);
    const bool opens_block = (query_blocks[i + 1] || blocks[i + 1]) && starts_with_ci(rendered[i + 1], "(\n");
    const bool open_on_line = opens_block && utf8_width(last_line) + operators[i].size() + 3 <= threshold;
    out += (blocks[i] || query_blocks[i] || open_on_line ? " " : "\n") + operators[i] + " " + rendered[i + 1];
  }
  return out;
}

string Formatter::format_arith_operand(string_view operand, size_t block_width, bool* block) {
  const FormatDepthGuard guard(depth);
  const string s = trim_ascii_spaces(operand);
  // If `(a * w + b * w + ...)` is too long for one line, open a block. Wrap the chain inside it by the same rules.
  if (const string inner = unwrap_outer_parens(s); !inner.empty() && s.find('\n') == string::npos &&
      utf8_width(s) + 8 > block_width) {
    if (const string chain = format_arith_chain(inner, true); !chain.empty()) {
      if (block) *block = true;
      return "(\n" + indent_block(chain, 4) + "\n)";
    }
  }
  return format_expression(s);
}

// A CASE expression with `--` comments after its branches uses the comment path. formatQuery changes it into multiIf and removes the comments. The CASE layout is used instead: `CASE [operand]`, then one branch per line, one level deeper. Each comment follows its branch, and `END` is at the indentation of the expression.
// If kept as written, the continuation lines were indented again on every pass. The function returns {} for any other shape, such as a comment inside a branch or before the first WHEN.
string Formatter::format_commented_case(string_view expr) {
  const FormatDepthGuard guard(depth);
  const string s = trim_ascii_spaces(expr);
  auto word_at = [&](size_t i, string_view w) {
    return i + w.size() <= s.size() && iequals_ascii(string_view(s).substr(i, w.size()), w) &&
           (i == 0 || !is_ident_char(s[i - 1])) && (i + w.size() == s.size() || !is_ident_char(s[i + w.size()]));
  };
  if (!word_at(0, "CASE")) return {};
  vector<size_t> marks;
  size_t end_pos = string::npos;
  int nested = 0;
  ScanState st;
  for (size_t i = 4; i < s.size(); ++i) {
    if (is_top_level(st)) {
      if (word_at(i, "CASE")) ++nested;
      else if (word_at(i, "END")) {
        if (nested == 0) { end_pos = i; break; }
        --nested;
      } else if (nested == 0 && (word_at(i, "WHEN") || word_at(i, "ELSE"))) marks.push_back(i);
    }
    step_scan(st, s, i);
  }
  if (end_pos == string::npos || marks.empty() || !word_at(marks.front(), "WHEN")) return {};
  if (!trim_ascii_spaces(string_view(s).substr(end_pos + 3)).empty()) return {};
  const string head = trim_ascii_spaces(string_view(s).substr(0, marks.front()));
  if (contains_top_level_comment(head)) return {};
  string out = collapse_whitespace(cleanup_surface(head));
  for (size_t m = 0; m < marks.size(); ++m) {
    const size_t next = m + 1 < marks.size() ? marks[m + 1] : end_pos;
    const string branch = trim_ascii_spaces(string_view(s).substr(marks[m], next - marks[m]));
    // The comments of a branch must all follow its code. Use only `-- ...` lines.
    size_t comment_at = string::npos;
    ScanState bs;
    for (size_t i = 0; i < branch.size() && comment_at == string::npos; ++i) {
      if (is_top_level(bs) && (branch[i] == '#' || (branch[i] == '-' && i + 1 < branch.size() && branch[i + 1] == '-') ||
                               (branch[i] == '/' && i + 1 < branch.size() && branch[i + 1] == '*'))) comment_at = i;
      else step_scan(bs, branch, i);
    }
    const string code = collapse_whitespace(cleanup_surface(trim_ascii_spaces(string_view(branch).substr(0, std::min(comment_at, branch.size())))));
    vector<string> comments;
    if (comment_at != string::npos) {
      for (const string& raw : split_lines_keep(string_view(branch).substr(comment_at))) {
        const string line = trim_ascii_spaces(raw);
        if (line.empty()) continue;
        if (!starts_with_ci(line, "--")) return {};
        comments.push_back(line);
      }
    }
    out += "\n    " + code;
    for (size_t c = 0; c < comments.size(); ++c) out += (c == 0 ? " " : "\n    ") + comments[c];
  }
  return out + "\nEND";
}

string Formatter::format_expression(string_view expr) {
  const FormatDepthGuard guard(depth);
  string s = trim_ascii_spaces(expr);
  if (s.empty()) return s;
  if (contains_top_level_comment(s)) {
    if (string commented_case = format_commented_case(s); !commented_case.empty()) return commented_case;
    // A comment that follows the previous list item arrives at the head of this item (`-- note\n    f(\n        x\n    )`). The code after the comment is formatted normally.
    // If kept verbatim, its input indentation is indented again on every pass.
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
    // Whole-line comments after the code (`a\n-- note`, before FROM). The code is formatted. Each comment line returns to the indentation of the item.
    // If kept verbatim, its input indentation is indented again on every pass.
    if (lead.empty()) {
      const vector<string> lines = split_lines_keep(s);
      size_t code_lines = lines.size();
      while (code_lines > 1) {
        const string line = trim_ascii_spaces(lines[code_lines - 1]);
        if (!starts_with_ci(line, "--") && !starts_with_ci(line, "#")) break;
        --code_lines;
      }
      if (code_lines < lines.size()) {
        string code;
        for (size_t i = 0; i < code_lines; ++i) code += (i ? "\n" : "") + lines[i];
        ScanState st;
        for (size_t i = 0; i < code.size(); ++i) step_scan(st, code, i);
        if (is_top_level(st) && !mask_sql_surface(code).has_comments) {
          string out = format_expression(code);
          for (size_t i = code_lines; i < lines.size(); ++i) out += "\n" + trim_ascii_spaces(lines[i]);
          return out;
        }
      }
    }
    return cleanup_surface(s);
  }
  // On the local path, the line breaks of the user reach this point. formatQuery joins them. Without comments, the line breaks have no meaning.
  // An expression that the formatter does not render again (`f(\n    x\n).1`) keeps its input indentation. It is then indented again on every pass.
  if (s.find('\n') != string::npos && !mask_sql_surface(s).has_comments) s = collapse_whitespace(s);
  // A tuple literal with comments between its items has one item on each line, as an array literal does. The formatter does not use the input lines.
  // Those lines kept their input indentation and drifted on every pass.
  if (s.size() > 2 && s.front() == '(' && find_matching_paren(s, 0) == s.size() - 1) {
    const string inner = trim_ascii_spaces(s.substr(1, s.size() - 2));
    CommentedItems list;
    if (mask_sql_surface(inner).has_comments && !looks_like_query(inner) && split_top_level(inner, ',').size() > 1 &&
        split_commented_items(inner, &list)) {
      string out = "(\n";
      if (!list.before_first.empty()) out += indent_block(list.before_first, 4) + "\n";
      for (size_t i = 0; i < list.items.size(); ++i) {
        out += indent_block(format_expression(list.items[i]), 4);
        if (i + 1 < list.items.size()) append_item_comma(out);
        if (!list.after[i].empty()) out += " " + list.after[i];
        out += '\n';
      }
      return out + ")";
    }
  }
  if (!s.empty() && s.front() == '(') {
    const size_t close = find_matching_paren(s, 0);
    if (close != string::npos && close + 1 < s.size() && s[close + 1] == '.') {
      const string inner = trim_ascii_spaces(s.substr(1, close - 1));
      // Only an atom can lose its parentheses before `.`. `(x + 1).1` is tupleElement(x + 1, 1), but `x + 1.1` adds a float.
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
    string lhs = cleanup_surface(trim_ascii_spaces(s.substr(0, static_cast<size_t>(arrow))));
    // Parameters with comments between them (`(k, -- key` …) use the layout of a commented tuple, with one parameter per line.
    if (lhs.find('\n') != string::npos && mask_sql_surface(lhs).has_comments) lhs = format_expression(lhs);
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
            if (j + 1 < rhs_rendered.size()) append_item_comma(rhs);
            rhs += '\n';
          }
          rhs += ')';
        }
      }
    }
    // `x -> (a, b)` returns a tuple. Its parentheses are the tuple, not a grouping. Without them, `b` becomes the next function argument.
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
      // `(a > b) = (c > d)`. Comparisons chain from left to right. So a parenthesized comparison next to another comparator is required.
      if (find_top_level_comparator(inner, nullptr) >= 0) return side;
      string collapsed = collapse_whitespace(inner);
      if (starts_with_ci(collapsed, "now() - toInterval") || starts_with_ci(collapsed, "now() + toInterval")) return collapsed;
      if (inner.find('/') != string::npos || inner.find('*') != string::npos || inner.find('+') != string::npos || inner.find('-') != string::npos) return side;
      return trim_ascii_spaces(inner);
    };
    string lhs = strip_side(trim_ascii_spaces(s.substr(0, static_cast<size_t>(cmp))));
    string rhs = strip_side(trim_ascii_spaces(s.substr(static_cast<size_t>(cmp) + op.size())));
    // A comparison that is too long for one line wraps the arithmetic on either side. The left side is wrapped first. The continuation hangs under the comparison.
    if (s.find('\n') == string::npos && utf8_width(lhs) + utf8_width(rhs) + op.size() + 2 > threshold) {
      if (string chain = format_arith_chain(lhs, true); !chain.empty()) lhs = std::move(chain);
      else if (string rchain = format_arith_chain(rhs, true); !rchain.empty()) rhs = std::move(rchain);
      else if (string call = format_function_call(lhs); !call.empty()) lhs = std::move(call);
    }
    // A scalar subquery next to a comparator is a block. Its `(` is on the comparison line: `x > (\n    SELECT ...\n)`, as in formatQuery.
    for (string* side : {&lhs, &rhs}) {
      if (const string inner = unwrap_outer_parens(*side); !inner.empty() && looks_like_query(inner)) {
        *side = "(\n" + indent_block(format_statement(inner), 4) + "\n)";
      }
    }
    s = lhs + " " + op + " " + rhs;
  }
  s = strip_lambda_parentheses(s);
  // Kept as written. With a comment inside a line (`f(a, -- c` ...), the text keeps its line breaks. Its continuation lines carry the absolute indentation of the input, and the caller indents them again on every pass.
  // So hang them one level under the first line instead. This is stable, because the result is its own input. A shape that is already split (first line ends with its opener) keeps its own relative layout.
  const string first_code = rtrim_spaces(split_inline_comment(s.substr(0, s.find('\n'))).first);
  const bool opener_line = !first_code.empty() && (first_code.back() == '(' || first_code.back() == '[');
  if (s.find('\n') != string::npos && !opener_line && mask_sql_surface(s).has_comments) {
    vector<string> lines = split_lines_keep(cleanup_surface(s));
    for (size_t k = 1; k < lines.size(); ++k) lines[k] = "    " + trim_ascii_spaces(lines[k]);
    return join_lines(lines);
  }
  return cleanup_surface(s);
}

string Formatter::format_exists_subquery(string_view expr) {
  const FormatDepthGuard guard(depth);
  // `NOT exists(...)` (formatQuery prints `NOT exists((SELECT ...))`) and the
  // comment path's `EXISTS (SELECT ...)` get the same block as `exists(`.
  string_view rest = expr;
  string prefix;
  if (starts_with_ci(rest, "NOT ")) {
    prefix = "NOT ";
    rest.remove_prefix(4);
    while (!rest.empty() && std::isspace(static_cast<unsigned char>(rest.front()))) rest.remove_prefix(1);
  }
  if (!starts_with_ci(rest, "exists") || (rest.size() > 6 && is_ident_char(rest[6]))) return {};
  rest.remove_prefix(6);
  while (!rest.empty() && std::isspace(static_cast<unsigned char>(rest.front()))) rest.remove_prefix(1);
  if (rest.empty() || rest.front() != '(') return {};
  string inner = unwrap_outer_parens(rest);
  if (inner.empty()) return {};
  if (auto nested = unwrap_outer_parens(inner); !nested.empty() && looks_like_query(nested)) inner = nested;
  if (!looks_like_query(inner)) return {};
  return prefix + "exists(\n" + indent_block(format_statement(inner), 4) + "\n)";
}

// The left operand of IN. A tuple that is written with comments between its items (`(a, -- c\n b) NOT IN ...`) uses the layout of a commented tuple, with one item per line.
// If kept as written, the tuple carried its input indentation into every pass.
string Formatter::commented_operand(string_view s) {
  const FormatDepthGuard guard(depth);
  string left = trim_ascii_spaces(s);
  if (!mask_sql_surface(left).has_comments) return left;
  string suffix;
  for (bool stripped = true; stripped;) {
    stripped = false;
    for (const char* word : {" NOT", " GLOBAL"}) {
      if (ends_with_ci(left, word)) {
        suffix = string(word) + suffix;
        left = rtrim_spaces(left.substr(0, left.size() - std::char_traits<char>::length(word)));
        stripped = true;
      }
    }
  }
  if (left.empty() || left.front() != '(' || find_matching_paren(left, 0) != left.size() - 1) return trim_ascii_spaces(s);
  return format_expression(left) + suffix;
}

string Formatter::format_in_subquery(string_view expr, bool break_after_in) {
  const FormatDepthGuard guard(depth);
  ScanState st;
  for (size_t i = 0; i < expr.size(); ++i) {
    if (is_top_level(st)) {
      static const char* ops[] = {"GLOBAL IN", "IN"};
      for (const char* raw : ops) {
        const string_view op(raw);
        // The operator is a word of its own. The `in` of `admin(` or of `join` is part of a name.
        const bool word_start = i == 0 || !is_ident_char(expr[i - 1]);
        const bool word_end = i + op.size() >= expr.size() || !is_ident_char(expr[i + op.size()]);
        if (word_start && word_end && i + op.size() <= expr.size() && iequals_ascii(expr.substr(i, op.size()), op)) {
          const string left = commented_operand(expr.substr(0, i));
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
  const FormatDepthGuard guard(depth);
  ScanState st;
  for (size_t i = 0; i < expr.size(); ++i) {
    if (is_top_level(st)) {
      static const char* ops[] = {"GLOBAL IN", "IN"};
      for (const char* raw : ops) {
        const string_view op(raw);
        if (i + op.size() > expr.size() || !iequals_ascii(expr.substr(i, op.size()), op)) continue;
        // Match whole words only. The `in` of `argMin(` or `min_value` is not IN.
        if ((i > 0 && is_ident_char(expr[i - 1])) ||
            (i + op.size() < expr.size() && is_ident_char(expr[i + op.size()]))) continue;
        const string left = commented_operand(expr.substr(0, i));
        string right = trim_ascii_spaces(expr.substr(i + op.size()));
        if (left.empty() || right.empty()) continue;
        // `IN tuple(('a', -- c\n 1))`. A call with comments inside uses the layout of the call formatter. If kept as written, it drifted on every pass.
        if (right.front() != '(' && right.front() != '[' && mask_sql_surface(right).has_comments) right = format_expression(right);

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
              if (j + 1 < right_items.size()) append_item_comma(rendered_right);
              rendered_right += '\n';
            }
            rendered_right += ']';
            return left + " " + string(op) + " " + rendered_right;
          }
        }

        const string right_inner = unwrap_outer_parens(right);
        if (!right_inner.empty() && looks_like_query(right_inner)) continue;
        // A value list with comments has one value on each line. Each comment stays after the value that it follows.
        // The width pass never changes lines with comments. Otherwise, those lines keep their input indentation and drift on every pass.
        if (!right_inner.empty() && mask_sql_surface(right_inner).has_comments) {
          CommentedItems list;
          if (!split_commented_items(right_inner, &list)) return {};
          const vector<string>& values = list.items;
          const vector<string>& after = list.after;
          const string& before_first = list.before_first;
          string rendered = left + " " + string(op) + " (\n";
          if (!before_first.empty()) rendered += indent_block(before_first, 4) + "\n";
          for (size_t j = 0; j < values.size(); ++j) {
            rendered += indent_block(format_expression(values[j]), 4);
            if (j + 1 < values.size()) append_item_comma(rendered);
            if (!after[j].empty()) rendered += " " + after[j];
            rendered += '\n';
          }
          return rendered + ")";
        }
        // A commented tuple on the left is already formatted (commented_operand).
        if (mask_sql_surface(left).has_comments && left.find('\n') != string::npos) return left + " " + string(op) + " " + right;
        const string left_inner = unwrap_outer_parens(left);
        if (left_inner.empty() || split_top_level(left_inner, ',').size() <= 1) continue;
        if (compact.size() <= wrap_threshold && left.find('\n') == string::npos) return {};
        // The width pass splits a long value list on the right, with one value on each line. The tuple on the left stays whole.
        if (right.size() > left.size() && left.find('\n') == string::npos) return {};
        const auto left_items = split_top_level(left_inner, ',');
        string rendered_left = "(\n";
        for (size_t j = 0; j < left_items.size(); ++j) {
          rendered_left += "    " + format_expression(left_items[j]);
          if (j + 1 < left_items.size()) append_item_comma(rendered_left);
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
  const FormatDepthGuard guard(depth);
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
  const FormatDepthGuard guard(depth);
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

}  // namespace fmt
}  // namespace chdash
