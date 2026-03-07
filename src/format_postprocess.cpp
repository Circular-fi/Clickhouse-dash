#include "format_postprocess.hpp"

#include <sstream>
#include <string_view>
#include <vector>

#include "format_postprocess_impl_part1.hpp"
#include "format_postprocess_impl_part2.hpp"
#include "format_postprocess_impl_part3.hpp"

namespace chdash {

std::string postprocess_format_query(std::string s, size_t threshold) {
  // Rule 2: If SELECT has a single (long) expression, put it on the next line.
  if (s.rfind("SELECT ", 0) == 0 && s.find('\n') == std::string::npos) {
    const size_t from_pos = find_from_keyword_top_level(s);
    const size_t expr_beg = std::string("SELECT ").size();
    const size_t expr_end = (from_pos == std::string::npos) ? s.size() : from_pos;
    if (expr_end > expr_beg) {
      const std::string_view expr = std::string_view(s).substr(expr_beg, expr_end - expr_beg);
      if (!has_top_level_comma(expr) && (expr_end - expr_beg) > threshold) {
        std::string out;
        out.reserve(s.size() + 8);
        out.append("SELECT\n    ");
        out.append(trim_ascii_spaces(expr));
        out.append(s.substr(expr_end));
        s.swap(out);
      }
    }
  }

  // Rule 4 (+ Rule 3): Multiline CAST(...) args; pretty outer arrays of tuples.
  std::string out;
  out.reserve(s.size() + 64);
  bool in_str = false;
  bool esc = false;
  for (size_t i = 0; i < s.size();) {
    const char c = s[i];
    if (in_str) {
      out.push_back(c);
      if (esc) {
        esc = false;
      } else if (c == '\\') {
        esc = true;
      } else if (c == '\'') {
        in_str = false;
      }
      ++i;
      continue;
    }

    if (c == '\'') {
      in_str = true;
      esc = false;
      out.push_back(c);
      ++i;
      continue;
    }

    const bool is_cast =
        (i + 5 <= s.size() && s.compare(i, 5, "CAST(") == 0 && (i == 0 || !is_ident_char(s[i - 1])));
    if (!is_cast) {
      out.push_back(c);
      ++i;
      continue;
    }

    // Find matching ')'
    size_t j = i + 5;
    bool in2 = false;
    bool esc2 = false;
    int par = 1;
    for (; j < s.size(); ++j) {
      char cj = s[j];
      if (in2) {
        if (esc2) {
          esc2 = false;
          continue;
        }
        if (cj == '\\') {
          esc2 = true;
          continue;
        }
        if (cj == '\'') in2 = false;
        continue;
      }
      if (cj == '\'') {
        in2 = true;
        esc2 = false;
        continue;
      }
      if (cj == '(') ++par;
      else if (cj == ')') {
        --par;
        if (par == 0) break;
      }
    }
    if (j >= s.size()) {
      // malformed; passthrough
      out.append(s.substr(i));
      break;
    }

    const size_t call_len = (j + 1) - i;
    const std::string_view inner = std::string_view(s).substr(i + 5, (j - (i + 5)));
    auto args = split_top_level(inner, ',');
    if (args.size() < 2 || call_len <= threshold) {
      out.append(s.substr(i, call_len));
      i = j + 1;
      continue;
    }

    // Determine indentation at the call site.
    size_t line_start = out.rfind('\n');
    line_start = (line_start == std::string::npos) ? 0 : (line_start + 1);
    std::string base_indent;
    if (line_start < out.size()) {
      base_indent = out.substr(line_start);
      for (char ic : base_indent) {
        if (ic != ' ' && ic != '\t') { base_indent.clear(); break; }
      }
    }
    const std::string arg_indent = base_indent + "    ";

    out.append("CAST(\n");
    for (size_t k = 0; k < args.size(); ++k) {
      std::string a = trim_ascii_spaces(args[k]);
      std::string rendered;
      if (!a.empty() && a.front() == '[' && a.back() == ']') {
        rendered = pretty_array_arg(a, arg_indent);
      } else {
        rendered = arg_indent + a;
      }
      out.append(rendered);
      if (k + 1 < args.size()) out.push_back(',');
      out.push_back('\n');
    }
    out.append(base_indent);
    out.push_back(')');

    i = j + 1;
  }

  out = reindent_where_and_join(std::move(out));
  out = cascade_select_lists(std::move(out), threshold);
  out = format_bool_in_parentheses(std::move(out), threshold);
  out = reindent_function_args(std::move(out), threshold);
  out = reindent_bool_expressions(std::move(out));
  out = align_simple_as_in_select(std::move(out));
  out = normalize_create_table_column_list_indent(std::move(out));
  return out;
}

} // namespace chdash
