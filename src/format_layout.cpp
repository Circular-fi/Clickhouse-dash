// The layout of the lines that are too long. The unit splits CASE expressions, binary operators and calls.
// The declarations that the units share are in format_internal.hpp.

#include "format_internal.hpp"

namespace chdash {
namespace fmt {

namespace {
// `CASE [operand] WHEN c THEN v ... [ELSE e] END` written on one line (the
// local path; formatQuery turns CASE into multiIf).
// Like multiIf, the CASE goes on several lines when it has two or more WHEN branches, or when the line is too long.
// The function puts each branch on its own line, one level deeper.
// It puts END back at the indentation of the line, followed by the rest of the line (`END AS kind,`, `END = 1`).
// Returns {} when the line has no complete top-level CASE to lay out.
vector<string> explode_case_expression(const string& line, size_t threshold) {
  const CallScan scan = scan_call_brackets(line);
  for (const unsigned char k : scan.kind) if (k == kCallComment) return {};
  struct Word { size_t begin; size_t end; int depth; };
  vector<Word> words;
  int depth = 0;
  for (size_t i = 0; i < line.size(); ++i) {
    if (scan.kind[i] != kCallCode) continue;
    const char c = line[i];
    if (c == '(' || c == '[') { ++depth; continue; }
    if (c == ')' || c == ']') { if (depth > 0) --depth; continue; }
    if (!is_ident_char(c) || (i > 0 && is_ident_char(line[i - 1]))) continue;
    size_t e = i;
    while (e < line.size() && is_ident_char(line[e])) ++e;
    words.push_back({i, e, depth});
    i = e - 1;
  }
  auto is = [&](size_t k, const char* kw) {
    return iequals_ascii(string_view(line).substr(words[k].begin, words[k].end - words[k].begin), kw);
  };
  size_t case_k = string::npos;
  for (size_t k = 0; k < words.size(); ++k) {
    if (words[k].depth == 0 && is(k, "CASE")) { case_k = k; break; }
  }
  if (case_k == string::npos) return {};
  // Find the branch keywords of this CASE. Skip the nested CASE ... END blocks.
  vector<size_t> marks;
  size_t end_k = string::npos;
  int nested = 0;
  for (size_t k = case_k + 1; k < words.size(); ++k) {
    if (words[k].depth != 0) continue;
    if (is(k, "CASE")) { ++nested; continue; }
    if (is(k, "END")) {
      if (nested > 0) { --nested; continue; }
      end_k = k;
      break;
    }
    if (nested == 0 && (is(k, "WHEN") || is(k, "THEN") || is(k, "ELSE"))) marks.push_back(k);
  }
  if (end_k == string::npos || marks.empty() || !is(marks.front(), "WHEN")) return {};
  size_t whens = 0;
  for (const size_t m : marks) whens += is(m, "WHEN") ? 1 : 0;
  if (whens < 2 && utf8_width(line) <= threshold) return {};

  const size_t indent = leading_space_count(line);
  auto piece = [&](size_t from, size_t to) { return trim_ascii_spaces(string_view(line).substr(from, to - from)); };
  vector<string> out;
  const string operand = piece(words[case_k].end, words[marks.front()].begin);
  out.push_back(line.substr(0, words[case_k].end) + (operand.empty() ? "" : " " + operand));
  for (size_t m = 0; m < marks.size(); ++m) {
    const size_t next = m + 1 < marks.size() ? words[marks[m + 1]].begin : words[end_k].begin;
    const string body = piece(words[marks[m]].begin, next);
    if (is(marks[m], "THEN")) {
      out.back() += " " + body;
    } else {
      out.push_back(string(indent + 4, ' ') + body);
    }
  }
  out.push_back(string(indent, ' ') + line.substr(words[end_k].begin));
  return out;
}
}  // namespace

// Apply the width rule to the final text (see collapse_fitting_calls). Join the calls that fit.
// Then split the one-line calls that overflow, but only in query statements.
// DDL keeps its column, index, and type lines.
string Formatter::layout_calls_by_width(string_view text, bool allow_explode) {
  const FormatDepthGuard guard(depth);
  vector<size_t> joined_rows;
  string out = collapse_fitting_calls(text, threshold, &joined_rows);
  out = join_fitting_arguments(merge_joined_single_select_items(out, joined_rows, threshold), threshold);
  if (!allow_explode) return attach_operators_to_closers(out, threshold);
  vector<string> result;
  bool exploded = false;
  // Split the CASE branches first, because they may nest. Then split the calls on the resulting lines.
  vector<string> pending = split_lines_keep(out);
  std::reverse(pending.begin(), pending.end());
  while (!pending.empty()) {
    string line = std::move(pending.back());
    pending.pop_back();
    if (vector<string> branches = explode_case_expression(line, threshold); !branches.empty()) {
      for (auto it = branches.rbegin(); it != branches.rend(); ++it) pending.push_back(std::move(*it));
      exploded = true;
      continue;
    }
    vector<string> pieces = explode_overlong_line(line, 0);
    exploded = exploded || pieces.size() > 1;
    for (string& piece : pieces) result.push_back(std::move(piece));
  }
  // A split can leave the rest of a call on later lines, with room
  // to join them (`name(\n    params\n)(` followed by the argument lines).
  const string settled = exploded ? join_fitting_arguments(collapse_fitting_calls(join_lines(result), threshold), threshold) : join_lines(result);
  return attach_operators_to_closers(settled, threshold);
}

namespace {
// This function handles an item line that has only operands, joined by binary operators.
// The line has a call or a bracket before the first break, for example `hmac(...) = HMAC(...) AS same,`.
// The line breaks before its lowest-precedence operators first.
// Each operator leads its own line at the item's indentation, as in an arithmetic chain.
// The operands are then decided like any other line.
// A split of the first operand's call instead left `) = HMAC(...)` lines that the next pass laid out differently.
// Returns {} when the line is anything else (keywords, lambdas, CASE, IN, BETWEEN, a clause head, ...).
vector<string> split_item_at_binary_operators(const string& line, const CallScan& scan) {
  auto equals_ci = [](string_view a, string_view b) { return a.size() == b.size() && starts_with_ci(a, b); };
  const size_t indent = leading_space_count(line);
  // The tokens are separated by single spaces that lie outside brackets, quotes and comments.
  vector<std::pair<size_t, size_t>> tokens;
  int depth = 0;
  size_t start = indent;
  for (size_t i = indent; i < line.size(); ++i) {
    if (scan.kind[i] != kCallCode) continue;
    const char c = line[i];
    if (c == '(' || c == '[') ++depth;
    else if ((c == ')' || c == ']') && depth > 0) --depth;
    else if (depth == 0 && (c == '{' || c == '}' || c == '\t')) return {};
    else if (depth == 0 && c == ' ') {
      if (i == start) return {};
      tokens.emplace_back(start, i);
      start = i + 1;
    }
  }
  if (start >= line.size()) return {};
  tokens.emplace_back(start, line.size());

  auto text = [&](size_t k) { return string_view(line).substr(tokens[k].first, tokens[k].second - tokens[k].first); };
  auto tier = [](string_view t) {
    for (const char* op : {"=", "==", "!=", "<>", "<", ">", "<=", ">="}) if (t == op) return 1;
    for (const char* op : {"+", "-", "||"}) if (t == op) return 2;
    for (const char* op : {"*", "/", "%"}) if (t == op) return 3;
    return 0;
  };
  auto operand = [&](size_t k) {
    const string_view t = text(k);
    if (tier(t) != 0 || equals_ci(t, "AS")) return false;
    // A bare word operand must not be a keyword, for example `NOT`, `CASE` or `INTERVAL`.
    bool word = true;
    for (const char ch : t) word = word && sql_is_ident_continue(ch);
    if (!word) return true;
    for (const char* kw : {"NOT", "CASE", "WHEN", "THEN", "ELSE", "END", "INTERVAL", "AND", "OR", "IN", "IS",
                           "BETWEEN", "LIKE", "ILIKE", "GLOBAL", "EXISTS", "DISTINCT", "ASC", "DESC", "SELECT",
                           "WHERE", "PREWHERE", "HAVING", "QUALIFY", "FROM", "ON", "USING", "WITH", "LIMIT", "OFFSET",
                           "ORDER", "GROUP", "BY", "SETTINGS", "FORMAT", "JOIN", "ARRAY", "TTL", "DEFAULT"}) {
      if (equals_ci(t, kw)) return false;
    }
    return true;
  };
  size_t k = 0;
  if (!operand(k)) return {};
  vector<size_t> ops;
  while (k + 2 < tokens.size() && tier(text(k + 1)) != 0 && operand(k + 2)) {
    ops.push_back(k + 1);
    k += 2;
  }
  if (ops.empty()) return {};
  if (k + 1 < tokens.size()) {
    // Only ` AS alias` (and its comma) can follow the last operand.
    if (k + 3 != tokens.size() || !equals_ci(text(k + 1), "AS")) return {};
  }
  int lowest = 3;
  for (const size_t op : ops) lowest = std::min(lowest, tier(text(op)));
  // A bare first operand (`timestamp >= toStartOfInterval(...)`) reads better with the call split after it.
  // Do not leave the operand alone on its line.
  size_t first_cut = 0;
  for (const size_t op : ops) if (tier(text(op)) == lowest) { first_cut = tokens[op].first; break; }
  if (line.find_first_of("([", indent) >= first_cut) return {};
  vector<string> out;
  size_t from = 0;
  for (const size_t op : ops) {
    if (tier(text(op)) != lowest) continue;
    const size_t cut = tokens[op].first - 1;
    out.push_back(from == 0 ? line.substr(0, cut) : string(indent + 4, ' ') + line.substr(from, cut - from));
    from = tokens[op].first;
  }
  out.push_back(string(indent + 4, ' ') + line.substr(from));
  return out;
}
}  // namespace

// Split the widest call, array or IN list that starts on a line that is too long.
// The `name(` part stays on the line. Each argument gets its own line, one level deeper.
// The `)` goes back to the indentation of the line, followed by the rest of the line (`) AS alias,`).
//
// A single condition on the WHERE line is indented one more level, like the other single multi-line conditions.
// The new lines get the same treatment until they fit, or until nothing is left to split.
vector<string> Formatter::explode_overlong_line(const string& line, int depth) {
  const FormatDepthGuard guard(this->depth);
  if (depth > 16 || utf8_width(line) <= threshold) return {line};
  const CallScan scan = scan_call_brackets(line);
  for (const unsigned char k : scan.kind) if (k == kCallComment) return {line};
  const size_t indent = leading_space_count(line);
  const string trimmed = line.substr(indent);
  if (starts_with_ci(trimmed, "CREATE ") && !is_create_function(trimmed)) return {line};
  if (const int fill = find_top_level_keyword(trimmed, "WITH FILL"); fill >= 0) {
    // In `x WITH FILL FROM a TO b STEP s STALENESS t`, the line breaks before each modifier.
    // Each modifier goes one level deeper. The calls inside the modifiers are not split.
    const string tail = trimmed.substr(static_cast<size_t>(fill));
    vector<size_t> cuts;
    for (const char* kw : {"FROM", "TO", "STEP", "STALENESS"}) {
      if (const int at = find_top_level_keyword(tail, kw); at > 0) cuts.push_back(static_cast<size_t>(fill + at));
    }
    if (cuts.empty()) return {line};
    std::sort(cuts.begin(), cuts.end());
    vector<string> out{string(indent, ' ') + rtrim_spaces(trimmed.substr(0, cuts.front()))};
    for (size_t i = 0; i < cuts.size(); ++i) {
      const size_t end = i + 1 < cuts.size() ? cuts[i + 1] : trimmed.size();
      out.push_back(string(indent + 4, ' ') + trim_ascii_spaces(trimmed.substr(cuts[i], end - cuts[i])));
    }
    return out;
  }
  for (const char* kw : {"SELECT DISTINCT ", "SELECT ALL ", "SELECT ", "ORDER BY ", "GROUP BY "}) {
    if (!starts_with_ci(trimmed, kw) || starts_with_ci(trimmed, "SELECT DISTINCT ON")) continue;
    if (string_view(kw) == "SELECT " && (starts_with_ci(trimmed, "SELECT DISTINCT ") || starts_with_ci(trimmed, "SELECT ALL "))) continue;
    // A single item that is too long for the clause line goes into the block.
    vector<string> out{string(indent, ' ') + rtrim_spaces(kw)};
    for (string& piece : explode_overlong_line(string(indent + 4, ' ') + trimmed.substr(std::char_traits<char>::length(kw)), depth + 1)) {
      out.push_back(std::move(piece));
    }
    return out;
  }
  // A long `x BETWEEN a AND b` condition breaks before BETWEEN, one level deeper.
  // The line does not break inside one of its bounds.
  if (!starts_with_ci(trimmed, "WHERE ") && !starts_with_ci(trimmed, "PREWHERE ") && !starts_with_ci(trimmed, "HAVING ")) {
    int at = find_top_level_keyword(trimmed, "NOT BETWEEN");
    if (at < 0) at = find_top_level_keyword(trimmed, "BETWEEN");
    size_t lead = 0;
    for (const char* kw : {"AND ", "OR "}) if (starts_with_ci(trimmed, kw)) lead = std::char_traits<char>::length(kw);
    if (at > static_cast<int>(lead) && scan.kind[indent + static_cast<size_t>(at)] == kCallCode) {
      vector<string> out;
      vector<string> pieces{rtrim_spaces(line.substr(0, indent + static_cast<size_t>(at))),
                            string(indent + 4, ' ') + trimmed.substr(static_cast<size_t>(at))};
      // The line is still too long. The upper bound goes on its own `AND` line under BETWEEN.
      if (utf8_width(pieces.back()) > threshold) {
        const string range = pieces.back().substr(indent + 4);
        const size_t skip = starts_with_ci(range, "NOT BETWEEN") ? 11 : 7;
        // Search after the BETWEEN word. The AND of BETWEEN is skipped.
        if (const int and_at = find_top_level_keyword(string_view(range).substr(skip), "AND"); and_at > 0) {
          const size_t cut = skip + static_cast<size_t>(and_at);
          pieces.back() = rtrim_spaces(string(indent + 4, ' ') + range.substr(0, cut));
          pieces.push_back(string(indent + 4, ' ') + range.substr(cut));
        }
      }
      for (const string& piece_line : pieces) {
        for (string& piece : explode_overlong_line(piece_line, depth + 1)) out.push_back(std::move(piece));
      }
      return out;
    }
  }
  if (const vector<string> operands = split_item_at_binary_operators(line, scan); !operands.empty()) {
    vector<string> out;
    for (const string& piece_line : operands) {
      for (string& piece : explode_overlong_line(piece_line, depth + 1)) out.push_back(std::move(piece));
    }
    return out;
  }
  // Find the widest candidate at the shallowest nesting level.
  // The candidate is the outermost call on an item line, or the call inside a tuple row `('k', encrypt(...)),`.
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
    // Arrays, IN lists, and calls that the expression formatter does not take, for example a quoted name,
    // get one item per line.
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
  const string settled = join_fitting_arguments(collapse_fitting_calls(join_lines(produced), threshold), threshold);
  vector<string> out;
  for (const string& piece_line : split_lines_keep(settled)) {
    if (piece_line == line) return {line};
    for (string& piece : explode_overlong_line(piece_line, depth + 1)) out.push_back(std::move(piece));
  }
  return out;
}

}  // namespace fmt
}  // namespace chdash
