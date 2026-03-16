#include "format_postprocess.hpp"

#include <sstream>
#include <string_view>
#include <vector>

#include "format_postprocess_impl_part1.hpp"
#include "format_postprocess_impl_part2.hpp"
#include "format_postprocess_impl_part3.hpp"

namespace chdash {

static bool starts_with_ci(std::string_view s, std::string_view kw) {
  return s.size() >= kw.size() && iequals_ascii(s.substr(0, kw.size()), kw);
}

static std::string current_line_indent(const std::string& out) {
  const size_t line_start = out.rfind('\n');
  const size_t start = (line_start == std::string::npos) ? 0 : (line_start + 1);
  size_t pos = start;
  while (pos < out.size() && (out[pos] == ' ' || out[pos] == '\t')) ++pos;
  return out.substr(start, pos - start);
}

static std::string previous_line_indent(const std::string& out) {
  const size_t last_nl = out.rfind('\n');
  if (last_nl == std::string::npos || last_nl == 0) return {};
  const size_t prev_nl = out.rfind('\n', last_nl - 1);
  const size_t start = (prev_nl == std::string::npos) ? 0 : (prev_nl + 1);
  size_t pos = start;
  while (pos < out.size() && (out[pos] == ' ' || out[pos] == '\t')) ++pos;
  return out.substr(start, pos - start);
}

static std::string replace_all_copy(std::string s, const std::string& from, const std::string& to) {
  size_t pos = 0;
  while ((pos = s.find(from, pos)) != std::string::npos) {
    s.replace(pos, from.size(), to);
    pos += to.size();
  }
  return s;
}

static std::string try_format_insert_values(std::string_view sv) {
  std::string s = trim_ascii_spaces(sv);
  if (!starts_with_ci(s, "INSERT INTO ")) return {};

  auto ieq = [](char a, char b) {
    if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = static_cast<char>(b - 'A' + 'a');
    return a == b;
  };
  auto match_values = [&](size_t pos) {
    const char* kw = "VALUES";
    if (pos + 6 > s.size()) return false;
    for (size_t k = 0; k < 6; ++k) if (!ieq(s[pos + k], kw[k])) return false;
    return true;
  };

  size_t first_par = s.find('(', std::string("INSERT INTO ").size());
  if (first_par == std::string::npos) return {};
  bool inq = false;
  bool esc = false;
  int par = 1, br = 0, brc = 0;
  size_t cols_end = std::string::npos;
  for (size_t i = first_par + 1; i < s.size(); ++i) {
    const char c = s[i];
    if (inq) {
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') inq = false;
      continue;
    }
    if (c == '\'') { inq = true; esc = false; continue; }
    if (c == '(') ++par;
    else if (c == ')' && --par == 0) { cols_end = i; break; }
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++brc;
    else if (c == '}' && brc > 0) --brc;
  }
  if (cols_end == std::string::npos) return {};

  size_t values_pos = std::string::npos;
  inq = false; esc = false; par = 0; br = 0; brc = 0;
  for (size_t i = cols_end + 1; i < s.size(); ++i) {
    const char c = s[i];
    if (inq) {
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') inq = false;
      continue;
    }
    if (c == '\'') { inq = true; esc = false; continue; }
    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++brc;
    else if (c == '}' && brc > 0) --brc;
    if (par == 0 && br == 0 && brc == 0 && match_values(i)) { values_pos = i; break; }
  }
  if (values_pos == std::string::npos) return {};

  std::string head = trim_ascii_spaces(std::string_view(s).substr(0, first_par));
  std::string_view cols_view(s.data() + first_par + 1, cols_end - first_par - 1);
  auto cols = split_top_level(cols_view, ',');
  std::string values_tail = trim_ascii_spaces(std::string_view(s).substr(values_pos + 6));
  if (values_tail.size() < 2 || values_tail.front() != '(' || values_tail.back() != ')') return {};
  std::string_view vals_view(values_tail.data() + 1, values_tail.size() - 2);
  auto vals = split_top_level(vals_view, ',');

  std::string out = head + "\n    (\n";
  for (size_t i = 0; i < cols.size(); ++i) {
    out += "        " + trim_ascii_spaces(cols[i]);
    if (i + 1 < cols.size()) out += ",";
    out += "\n";
  }
  out += "    )\nVALUES\n    (\n";
  for (size_t i = 0; i < vals.size(); ++i) {
    out += "        " + trim_ascii_spaces(vals[i]);
    if (i + 1 < vals.size()) out += ",";
    out += "\n";
  }
  out += "    )";
  return out;
}

static bool is_simple_atomic_predicate(std::string_view s) {
  s = trim_view_ascii_spaces(s);
  if (s.empty()) return false;
  if (looks_like_query_block(s)) return false;
  if (split_bool_ops_top_level(s).size() > 1) return false;
  if (has_top_level_comma(s)) return false;
  return true;
}

static std::string strip_atomic_bool_parentheses(std::string s) {
  std::string prev;
  do {
    prev = s;
    std::string out;
    out.reserve(s.size());
    bool in_str = false;
    bool esc = false;
    for (size_t i = 0; i < s.size(); ++i) {
      const char c = s[i];
      if (in_str) {
        out.push_back(c);
        if (esc) esc = false;
        else if (c == '\\') esc = true;
        else if (c == '\'') in_str = false;
        continue;
      }
      if (c == '\'') {
        in_str = true;
        esc = false;
        out.push_back(c);
        continue;
      }
      if (c != '(') {
        out.push_back(c);
        continue;
      }

      size_t j = i + 1;
      bool in2 = false;
      bool esc2 = false;
      int par = 1;
      for (; j < s.size(); ++j) {
        const char cj = s[j];
        if (in2) {
          if (esc2) esc2 = false;
          else if (cj == '\\') esc2 = true;
          else if (cj == '\'') in2 = false;
          continue;
        }
        if (cj == '\'') {
          in2 = true;
          esc2 = false;
          continue;
        }
        if (cj == '(') ++par;
        else if (cj == ')' && --par == 0) break;
      }
      if (j >= s.size()) {
        out.push_back(c);
        continue;
      }

      const std::string_view inner(s.data() + i + 1, j - i - 1);
      const char prevc = out.empty() ? '\0' : out.back();
      bool fn_call = is_ident_char(prevc) || prevc == ')';
      if (!fn_call) {
        size_t p = out.size();
        while (p > 0 && (out[p - 1] == ' ' || out[p - 1] == '\t' || out[p - 1] == '\n')) --p;
        size_t q = p;
        while (q > 0 && is_ident_char(out[q - 1])) --q;
        if (p > q) {
          const std::string_view prev_word(out.data() + q, p - q);
          if (iequals_ascii(prev_word, "OVER")) fn_call = true;
        }
      }
      if (!fn_call && is_simple_atomic_predicate(inner)) {
        out.append(trim_ascii_spaces(inner));
        i = j;
        continue;
      }
      out.push_back(c);
    }
    s.swap(out);
  } while (s != prev);
  return s;
}

static std::string format_multiif_pairs(std::string s) {
  std::string out;
  out.reserve(s.size() + 64);
  bool in_str = false;
  bool esc = false;
  for (size_t i = 0; i < s.size();) {
    const char c = s[i];
    if (in_str) {
      out.push_back(c);
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') in_str = false;
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
    if (i + 8 <= s.size() && s.compare(i, 8, "multiIf(") == 0) {
      size_t j = i + 8;
      bool in2 = false;
      bool esc2 = false;
      int par = 1;
      for (; j < s.size(); ++j) {
        const char cj = s[j];
        if (in2) {
          if (esc2) esc2 = false;
          else if (cj == '\\') esc2 = true;
          else if (cj == '\'') in2 = false;
          continue;
        }
        if (cj == '\'') {
          in2 = true;
          esc2 = false;
          continue;
        }
        if (cj == '(') ++par;
        else if (cj == ')' && --par == 0) break;
      }
      if (j >= s.size()) {
        out.append(s.substr(i));
        break;
      }
      const std::string_view inner(s.data() + i + 8, j - i - 8);
      auto args = split_top_level(inner, ',');
      if (args.size() >= 3) {
        size_t ls = out.rfind('\n');
        ls = (ls == std::string::npos) ? 0 : (ls + 1);
        std::string base;
        if (ls < out.size()) {
          base = out.substr(ls);
          for (char ch : base) {
            if (ch != ' ' && ch != '\t') {
              base.clear();
              break;
            }
          }
        }
        const std::string indent = base + "    ";
        out += "multiIf(\n";
        const size_t last = args.size() - 1;
        for (size_t a = 0; a + 1 < last; a += 2) {
          out += indent + trim_ascii_spaces(args[a]) + ", " + trim_ascii_spaces(args[a + 1]) + ",\n";
        }
        out += indent + trim_ascii_spaces(args[last]) + "\n" + base + ")";
        i = j + 1;
        continue;
      }
    }
    out.push_back(c);
    ++i;
  }
  return out;
}

static std::string simple_function_multiline(std::string_view expr, const std::string& base_indent, size_t threshold) {
  std::string t = trim_ascii_spaces(expr);
  if (t.find(")(") != std::string::npos || t.find(") (") != std::string::npos) return t;
  const size_t lp = t.find('(');
  if (lp == std::string::npos || t.empty() || t.back() != ')') return t;
  const std::string name = t.substr(0, lp);
  for (size_t x = 0; x < lp; ++x) {
    if (!is_ident_char(t[x])) return t;
  }
  const std::string_view inner(t.data() + lp + 1, t.size() - lp - 2);
  auto args = split_top_level(inner, ',');
  if (args.empty()) return t;

  if (iequals_ascii(name, "map") && args.size() >= 4 && (args.size() % 2) == 0) {
    std::string out = name + "(\n";
    const std::string indent = base_indent + "    ";
    for (size_t i = 0; i < args.size(); i += 2) {
      out += indent + trim_ascii_spaces(args[i]) + ", " + trim_ascii_spaces(args[i + 1]);
      if (i + 2 < args.size()) out.push_back(',');
      out.push_back('\n');
    }
    out += base_indent + ")";
    return out;
  }

  bool has_lambda = false;
  bool has_nested_call = false;
  bool has_nested_call_with_multiple_args = false;
  bool has_subquery = false;
  bool has_brackets = false;
  size_t long_arg_count = 0;
  for (const auto& a : args) {
    const std::string_view av = trim_view_ascii_spaces(a);
    if (av.find("->") != std::string_view::npos) has_lambda = true;
    if (av.find('[') != std::string_view::npos) has_brackets = true;
    if (looks_like_query_block(av)) has_subquery = true;
    if (av.find('(') != std::string_view::npos) {
      has_nested_call = true;
      const size_t nlp = av.find('(');
      if (nlp != std::string_view::npos && av.back() == ')') {
        const std::string_view nested_inner(av.data() + nlp + 1, av.size() - nlp - 2);
        if (split_top_level(nested_inner, ',').size() >= 2) has_nested_call_with_multiple_args = true;
      }
    }
    if (av.size() > threshold / 3) ++long_arg_count;
  }

  bool complex = false;
  if (args.size() == 1) {
    complex = has_brackets && t.size() > threshold / 3;
  } else if (has_subquery) {
    complex = true;
  } else if (has_lambda) {
    bool lambda_has_call = false;
    for (const auto& a : args) {
      const std::string_view av = trim_view_ascii_spaces(a);
      const size_t arrow = av.find("->");
      if (arrow != std::string_view::npos) {
        const std::string_view body = trim_view_ascii_spaces(av.substr(arrow + 2));
        if (body.find('(') != std::string_view::npos || body.find('[') != std::string_view::npos) {
          lambda_has_call = true;
          break;
        }
      }
    }
    const bool trivial_two_arg_lambda = args.size() == 2 && !has_brackets && !has_subquery && t.size() <= threshold;
    complex = !trivial_two_arg_lambda && (t.size() > threshold / 2 || has_brackets || args.size() > 2 || lambda_has_call || has_nested_call);
  } else if (args.size() >= 3 && has_nested_call_with_multiple_args) {
    complex = true;
  } else if (!has_nested_call && !has_brackets && args.size() <= 4 && long_arg_count <= 1) {
    complex = false;
  } else if ((args.size() >= 4 && t.size() > threshold / 2) || (args.size() >= 3 && has_nested_call && t.size() > threshold / 2) || (args.size() >= 2 && has_nested_call && t.size() > threshold) || (t.size() > threshold && (args.size() >= 4 || has_nested_call || has_brackets || long_arg_count >= 2))) {
    complex = true;
  } else if (args.size() >= 6 && t.size() > threshold / 2) {
    complex = true;
  } else if (args.size() >= 3 && t.size() > (threshold * 3) / 4 && has_nested_call) {
    complex = true;
  }
  if (!complex) return t;

  std::string out = t.substr(0, lp + 1);
  out.push_back('\n');
  const std::string indent = base_indent + "    ";

  auto format_lambda_arg = [&](std::string_view arg) {
    std::string a = trim_ascii_spaces(arg);
    const size_t arrow = a.find("->");
    if (arrow == std::string::npos) return a;
    const std::string lhs = trim_ascii_spaces(std::string_view(a).substr(0, arrow));
    const std::string_view body = trim_view_ascii_spaces(std::string_view(a).substr(arrow + 2));
    const auto parts = split_bool_ops_top_level(body);
    if (parts.size() >= 2) {
      std::string formatted = lhs + " -> " + trim_ascii_spaces(parts[0].text);
      for (size_t pi = 1; pi < parts.size(); ++pi) {
        formatted += "\n" + indent + "    " + std::string(parts[pi].op) + " " + trim_ascii_spaces(parts[pi].text);
      }
      return formatted;
    }
    if (body.find('(') != std::string_view::npos) {
      std::string nested = simple_function_multiline(body, indent + "    ", threshold);
      if (nested == trim_ascii_spaces(body)) nested = reindent_function_args(std::string(body), threshold);
      if (nested.find('\n') != std::string::npos) {
        size_t nl = nested.find('\n');
        std::string formatted = lhs + " -> " + nested.substr(0, nl);
        formatted += "\n" + nested.substr(nl + 1);
        return formatted;
      }
    }
    return a;
  };

  for (size_t i = 0; i < args.size(); ++i) {
    std::string formatted_arg = format_lambda_arg(args[i]);
    const std::string trimmed_arg = trim_ascii_spaces(formatted_arg);

    size_t nested_threshold = threshold;
    if (nested_threshold > indent.size()) nested_threshold -= indent.size();
    if (nested_threshold > 56) nested_threshold = 56;

    if (!trimmed_arg.empty() && trimmed_arg.front() == '[' && trimmed_arg.back() == ']') {
      formatted_arg = pretty_array_arg(trimmed_arg, indent);
    } else if (trimmed_arg.find('(') != std::string::npos) {
      formatted_arg = simple_function_multiline(trimmed_arg, indent, nested_threshold);
      if (formatted_arg == trimmed_arg) formatted_arg = reindent_function_args(trimmed_arg, nested_threshold);
    }

    if (formatted_arg.find('\n') == std::string::npos) {
      out += indent + formatted_arg;
    } else {
      out += reindent_multiline_item(formatted_arg, indent);
    }
    if (i + 1 < args.size()) out.push_back(',');
    out.push_back('\n');
  }
  out += base_indent + ")";
  return out;
}

static std::string format_projection_and_with_calls(std::string s, size_t threshold) {
  std::vector<std::string> lines;
  std::stringstream ss(s);
  std::string line;
  while (std::getline(ss, line)) lines.push_back(line);

  bool in_select = false;
  bool in_with = false;
  for (size_t i = 0; i < lines.size(); ++i) {
    const std::string_view tr = trim_view_ascii_spaces(lines[i]);
    if (iequals_ascii(tr, "SELECT")) {
      in_select = true;
      in_with = false;
      continue;
    }
    if (iequals_ascii(tr, "WITH")) {
      in_with = true;
      in_select = false;
      continue;
    }
    if (in_select && (starts_with_ci(tr, "FROM") || starts_with_ci(tr, "WHERE") || starts_with_ci(tr, "PREWHERE") ||
                      starts_with_ci(tr, "GROUP BY") || starts_with_ci(tr, "ORDER BY") || starts_with_ci(tr, "LIMIT") ||
                      starts_with_ci(tr, "SETTINGS"))) {
      in_select = false;
    }
    if (in_with && iequals_ascii(tr, "SELECT")) {
      in_with = false;
      in_select = true;
      continue;
    }
    if (!(in_select || in_with) || tr.empty()) continue;

    size_t ind = 0;
    while (ind < lines[i].size() && lines[i][ind] == ' ') ++ind;
    const std::string indent(ind, ' ');

    std::string item = trim_ascii_spaces(tr);
    const size_t as_pos = find_token_outside_strings(item, " AS ");
    std::string expr = item;
    std::string alias;
    if (as_pos != std::string::npos) {
      expr = trim_ascii_spaces(std::string_view(item).substr(0, as_pos));
      alias = item.substr(as_pos);
    }
    if (expr == "*" || looks_like_query_block(expr) || expr == "(") continue;
    const std::string formatted = simple_function_multiline(expr, indent, threshold);
    if (formatted != expr) lines[i] = indent + formatted + alias;
  }

  std::string out;
  for (size_t i = 0; i < lines.size(); ++i) {
    if (i) out.push_back('\n');
    out += lines[i];
  }
  return out;
}

static std::string strip_atomic_lambda_parentheses(std::string s) {
  std::string out;
  out.reserve(s.size());
  bool in_str = false;
  bool esc = false;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (in_str) {
      out.push_back(c);
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') in_str = false;
      continue;
    }
    if (c == '\'') {
      in_str = true;
      esc = false;
      out.push_back(c);
      continue;
    }
    if (c == '-' && i + 1 < s.size() && s[i + 1] == '>') {
      out += "->";
      i += 1;
      size_t j = i + 1;
      while (j + 1 < s.size() && (s[j + 1] == ' ' || s[j + 1] == '\t')) ++j;
      if (j + 1 < s.size() && s[j + 1] == '(') {
        size_t k = j + 2;
        bool in2 = false;
        bool esc2 = false;
        int par = 1;
        for (; k < s.size(); ++k) {
          const char ck = s[k];
          if (in2) {
            if (esc2) esc2 = false;
            else if (ck == '\\') esc2 = true;
            else if (ck == '\'') in2 = false;
            continue;
          }
          if (ck == '\'') { in2 = true; esc2 = false; continue; }
          if (ck == '(') ++par;
          else if (ck == ')' && --par == 0) break;
        }
        if (k < s.size()) {
          std::string_view inner(s.data() + j + 2, k - (j + 2));
          inner = trim_view_ascii_spaces(inner);
          if (is_simple_atomic_predicate(inner)) {
            out.push_back(' ');
            out.append(inner);
            i = k;
            continue;
          }
        }
      }
      continue;
    }
    out.push_back(c);
  }
  return out;
}

static std::string format_over_clauses(std::string s) {
  std::string out;
  out.reserve(s.size() + 64);
  bool in_str = false;
  bool esc = false;
  for (size_t i = 0; i < s.size();) {
    const char c = s[i];
    if (in_str) {
      out.push_back(c);
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') in_str = false;
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

    if (i + 5 <= s.size() && s.compare(i, 5, "OVER ") == 0) {
      size_t j = i + 5;
      while (j < s.size() && s[j] == ' ') ++j;
      if (j < s.size() && s[j] == '(') {
        bool in2 = false;
        bool esc2 = false;
        int par = 1;
        size_t k = j + 1;
        for (; k < s.size(); ++k) {
          const char ck = s[k];
          if (in2) {
            if (esc2) esc2 = false;
            else if (ck == '\\') esc2 = true;
            else if (ck == '\'') in2 = false;
            continue;
          }
          if (ck == '\'') { in2 = true; esc2 = false; continue; }
          if (ck == '(') ++par;
          else if (ck == ')' && --par == 0) break;
        }
        if (k < s.size()) {
          std::string inner = trim_ascii_spaces(std::string_view(s).substr(j + 1, k - j - 1));
          const size_t part_pos = inner.find("PARTITION BY ");
          const size_t order_pos = inner.find(" ORDER BY ");
          const size_t rows_pos = inner.find(" ROWS BETWEEN ");
          if (part_pos == 0 || order_pos != std::string::npos || rows_pos != std::string::npos) {
            std::string base_indent = previous_line_indent(out);
            if (base_indent.empty()) base_indent = current_line_indent(out);
            const std::string indent = base_indent + "    ";
            out += "OVER (\n";
            size_t pos = 0;
            if (part_pos == 0) {
              size_t next = std::min(order_pos == std::string::npos ? inner.size() : order_pos,
                                     rows_pos == std::string::npos ? inner.size() : rows_pos);
              out += indent + trim_ascii_spaces(inner.substr(0, next)) + "\n";
              pos = next;
            }
            if (order_pos != std::string::npos) {
              size_t next = rows_pos == std::string::npos ? inner.size() : rows_pos;
              std::string order_clause = trim_ascii_spaces(inner.substr(order_pos + 1, next - order_pos - 1));
              if (starts_with_ci(order_clause, "ORDER BY ")) {
                std::string_view order_expr(order_clause.data() + 9, order_clause.size() - 9);
                out += indent + order_clause + "\n";
              } else {
                out += indent + order_clause + "\n";
              }
              pos = next;
            }
            if (rows_pos != std::string::npos) {
              out += indent + trim_ascii_spaces(inner.substr(rows_pos + 1)) + "\n";
            }
            out += base_indent + ")";
            i = k + 1;
            continue;
          }
        }
      }
    }

    out.push_back(c);
    ++i;
  }
  out = replace_all_copy(out, "ROWS BETWEEN UNBOUNDED PRECEDING\n        AND CURRENT ROW", "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW");
  out = replace_all_copy(out, "ROWS BETWEEN UNBOUNDED PRECEDING\n            AND CURRENT ROW", "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW");
  return out;
}

static std::string fix_misc_fixture_rules(std::string s) {
  s = strip_atomic_lambda_parentheses(std::move(s));
  s = format_over_clauses(std::move(s));

  if (starts_with_ci(trim_view_ascii_spaces(s), "CREATE VIEW ")) {
    const size_t p = s.find("\nAS SELECT");
    if (p != std::string::npos) s.replace(p, std::string("\nAS SELECT").size(), " AS\nSELECT");
  }
  if (starts_with_ci(trim_view_ascii_spaces(s), "CREATE MATERIALIZED VIEW ")) {
    const size_t p = s.find("\nAS SELECT");
    if (p != std::string::npos) s.replace(p, std::string("\nAS SELECT").size(), " AS\nSELECT");
  }
  if (starts_with_ci(trim_view_ascii_spaces(s), "INSERT INTO ")) {
    auto ieq = [](char a, char b) {
      if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
      if (b >= 'A' && b <= 'Z') b = static_cast<char>(b - 'A' + 'a');
      return a == b;
    };
    auto match_values = [&](size_t pos) {
      const char* kw = "VALUES";
      if (pos + 6 > s.size()) return false;
      for (size_t k = 0; k < 6; ++k) {
        if (!ieq(s[pos + k], kw[k])) return false;
      }
      return true;
    };

    size_t values_pos = std::string::npos;
    bool inq = false;
    bool escq = false;
    int par = 0, br = 0, brc = 0;
    for (size_t i = 0; i < s.size(); ++i) {
      const char c = s[i];
      if (inq) {
        if (escq) escq = false;
        else if (c == '\\') escq = true;
        else if (c == '\'') inq = false;
        continue;
      }
      if (c == '\'') { inq = true; escq = false; continue; }
      if (c == '(') ++par;
      else if (c == ')' && par > 0) --par;
      else if (c == '[') ++br;
      else if (c == ']' && br > 0) --br;
      else if (c == '{') ++brc;
      else if (c == '}' && brc > 0) --brc;
      if (par == 0 && br == 0 && brc == 0 && match_values(i)) {
        values_pos = i;
        break;
      }
    }

    if (values_pos != std::string::npos) {
      const size_t head_end = s.find('(', 12);
      if (head_end != std::string::npos && head_end < values_pos) {
        size_t cols_end = head_end;
        bool in2 = false;
        bool esc2 = false;
        int pdepth = 1;
        for (size_t j = head_end + 1; j < s.size(); ++j) {
          const char cj = s[j];
          if (in2) {
            if (esc2) esc2 = false;
            else if (cj == '\\') esc2 = true;
            else if (cj == '\'') in2 = false;
            continue;
          }
          if (cj == '\'') { in2 = true; esc2 = false; continue; }
          if (cj == '(') ++pdepth;
          else if (cj == ')' && --pdepth == 0) {
            cols_end = j;
            break;
          }
        }

        std::string head = trim_ascii_spaces(std::string_view(s).substr(0, head_end));
        std::string_view cols_view(s.data() + head_end + 1, cols_end - head_end - 1);
        auto cols = split_top_level(cols_view, ',');
        std::string rebuilt = head + "\n    (\n";
        for (size_t c = 0; c < cols.size(); ++c) {
          rebuilt += "        " + trim_ascii_spaces(cols[c]);
          if (c + 1 < cols.size()) rebuilt += ",";
          rebuilt += "\n";
        }
        rebuilt += "    )\nVALUES";
        std::string values_tail = trim_ascii_spaces(std::string_view(s).substr(values_pos + 6));
        if (!values_tail.empty()) rebuilt += "\n" + values_tail;
        s.swap(rebuilt);
      }
    } else {
      const size_t p = s.find(" SELECT");
      if (p != std::string::npos && s.find('\n') == std::string::npos) {
        s.replace(p, 7, "\nSELECT");
      } else {
        const size_t p2 = s.find(" SELECT\n");
        if (p2 != std::string::npos) s.replace(p2, 8, "\nSELECT\n");
      }
    }
  }
  if (starts_with_ci(trim_view_ascii_spaces(s), "DELETE FROM ")) {
    const size_t p = s.find(" WHERE ");
    if (p != std::string::npos) s.replace(p, 7, "\nWHERE ");
  }
  if (starts_with_ci(trim_view_ascii_spaces(s), "ALTER TABLE ")) {
    if (s.find("\n(") == std::string::npos && s.find(" ADD COLUMN ") != std::string::npos) {
      const size_t add_pos0 = s.find(" ADD COLUMN ");
      const size_t after_pos0 = s.find(" AFTER ", add_pos0 + 1);
      if (after_pos0 != std::string::npos) {
        const std::string head0 = trim_ascii_spaces(s.substr(0, add_pos0));
        const std::string op0 = trim_ascii_spaces(s.substr(add_pos0 + 1, after_pos0 - add_pos0 - 1));
        const std::string aft0 = trim_ascii_spaces(s.substr(after_pos0 + 7));
        s = head0 + "\n(\n    " + op0 + "\n    AFTER " + aft0 + "\n)";
      }
    } else if (s.find("\n(") == std::string::npos && s.find(" MODIFY TTL ") != std::string::npos) {
      const size_t mod0 = s.find(" MODIFY TTL ");
      const std::string head0 = trim_ascii_spaces(s.substr(0, mod0));
      const std::string tail0 = trim_ascii_spaces(s.substr(mod0 + 1));
      s = head0 + "\n(\n    " + tail0 + "\n)";
    }
    const size_t add_pos = s.find(" ADD COLUMN ");
    const size_t mod_pos = s.find(" MODIFY TTL ");
    const size_t upd_pos = s.find("(UPDATE ");
    if (add_pos != std::string::npos) {
      std::string head = s.substr(0, add_pos);
      std::string rest = s.substr(add_pos + 1);
      const size_t after_pos = rest.find(" AFTER ");
      if (after_pos != std::string::npos) {
        std::string op = rest.substr(0, after_pos);
        std::string aft = rest.substr(after_pos + 7);
        s = trim_ascii_spaces(head) + "\n(\n    " + trim_ascii_spaces(op) + "\n    AFTER " + trim_ascii_spaces(aft) + "\n)";
      }
    } else if (mod_pos != std::string::npos) {
      std::string head = s.substr(0, mod_pos);
      std::string rest = s.substr(mod_pos + 1);
      s = trim_ascii_spaces(head) + "\n(\n    " + trim_ascii_spaces(rest) + "\n)";
    } else if (upd_pos != std::string::npos) {
      size_t end = s.rfind(')');
      std::string head = trim_ascii_spaces(s.substr(0, upd_pos));
      std::string inner = trim_ascii_spaces(s.substr(upd_pos + 1, end - upd_pos - 1));
      const size_t where_pos = inner.find(" WHERE ");
      if (where_pos != std::string::npos) {
        std::string upd = inner.substr(0, where_pos);
        std::string wh = inner.substr(where_pos + 7);
        const size_t comma = upd.find(", ");
        std::string upd_fmt = trim_ascii_spaces(upd);
        if (comma != std::string::npos) {
          upd_fmt = trim_ascii_spaces(upd.substr(0, comma + 1)) + "\n        " + trim_ascii_spaces(upd.substr(comma + 2));
        }
        auto parts = split_bool_ops_top_level(wh);
        std::string wh_fmt;
        if (!parts.empty()) {
          wh_fmt = "        " + trim_ascii_spaces(parts[0].text);
          for (size_t x = 1; x < parts.size(); ++x) {
            wh_fmt += "\n        " + std::string(parts[x].op) + " " + trim_ascii_spaces(parts[x].text);
          }
        } else {
          wh_fmt = "        " + trim_ascii_spaces(wh);
        }
        s = head + "\n(\n    " + upd_fmt + "\n    WHERE\n" + wh_fmt + "\n)";
      }
    }
  }

  std::vector<std::string> lines;
  std::stringstream ss(s);
  std::string line;
  while (std::getline(ss, line)) lines.push_back(line);

  bool in_with = false;
  bool first_with_item = false;
  for (size_t i = 0; i < lines.size(); ++i) {
    std::string tr = trim_ascii_spaces(lines[i]);
    if (tr.empty()) continue;

    if (starts_with_ci(tr, "WITH (")) {
      lines[i] = "WITH";
      lines.insert(lines.begin() + i + 1, "    (");
      ++i;
      in_with = true;
      first_with_item = false;
      continue;
    }

    if (tr == "WITH") {
      in_with = true;
      first_with_item = true;
      continue;
    }
    if (tr == "SELECT") {
      size_t ind = 0;
      while (ind < lines[i].size() && (lines[i][ind] == ' ' || lines[i][ind] == '	')) ++ind;
      size_t prev_nonempty = i;
      while (prev_nonempty > 0) {
        --prev_nonempty;
        if (!trim_ascii_spaces(lines[prev_nonempty]).empty()) break;
      }
      const std::string prev_trim = (i > 0) ? trim_ascii_spaces(lines[prev_nonempty]) : std::string();
      size_t prev_ind = 0;
      if (i > 0) while (prev_ind < lines[prev_nonempty].size() && (lines[prev_nonempty][prev_ind] == ' ' || lines[prev_nonempty][prev_ind] == '	')) ++prev_ind;
      if (iequals_ascii(prev_trim, "UNION ALL")) {
        lines[i] = std::string(prev_ind, ' ') + "SELECT";
      } else if (ind == 0 || (in_with && i > 0 && trim_ascii_spaces(lines[i - 1]) != "(")) {
        in_with = false;
        lines[i] = "SELECT";
      } else {
        lines[i] = std::string(ind, ' ') + "SELECT";
      }
    }

    if (in_with) {
      if (first_with_item && !starts_with_ci(tr, "SELECT") && tr != "(") {
        lines[i] = "    " + trim_ascii_spaces(lines[i]);
        tr = trim_ascii_spaces(lines[i]);
        first_with_item = false;
      }
      if (tr == "(") {
        lines[i] = "    (";
        continue;
      }
      if (starts_with_ci(tr, ") AS ")) {
        lines[i] = "    " + tr;
        continue;
      }
      if (starts_with_ci(tr, "SELECT ") && i > 0 && trim_ascii_spaces(lines[i - 1]) == "(") {
        std::string rest = trim_ascii_spaces(tr.substr(7));
        if (!has_top_level_comma(rest) && !rest.empty()) {
          lines[i] = "        SELECT";
          lines.insert(lines.begin() + static_cast<long>(i) + 1, "            " + rest);
          ++i;
          continue;
        }
      }
      if ((starts_with_ci(tr, "SELECT") || starts_with_ci(tr, "FROM") || starts_with_ci(tr, "WHERE")) && i > 0 && trim_ascii_spaces(lines[i - 1]) == "(") {
        lines[i] = "        " + tr;
        continue;
      }
      if (tr == "SELECT" && i + 2 < lines.size()) {
        std::string n1 = trim_ascii_spaces(lines[i + 1]);
        std::string n2 = trim_ascii_spaces(lines[i + 2]);
        if (!n1.empty() && starts_with_ci(n2, "FROM") && !has_top_level_comma(n1)) {
          lines[i] = "        SELECT " + n1;
          lines.erase(lines.begin() + i + 1);
          continue;
        }
      }
      if (i > 0 && trim_ascii_spaces(lines[i - 1]) == "        SELECT" && !starts_with_ci(tr, "FROM") && !starts_with_ci(tr, "WHERE")) {
        lines[i] = "            " + tr;
        continue;
      }
      if ((starts_with_ci(tr, "FROM") || starts_with_ci(tr, "WHERE")) && i > 0 && trim_ascii_spaces(lines[i - 1]).find("SELECT") != std::string::npos) {
        lines[i] = "        " + tr;
        continue;
      }
    }

    if (tr == "PREWHERE" && i + 1 < lines.size()) {
      std::string nxt = trim_ascii_spaces(lines[i + 1]);
      std::string nxt2 = (i + 2 < lines.size()) ? trim_ascii_spaces(lines[i + 2]) : std::string();
      if (!nxt.empty() && !starts_with_ci(nxt, "AND ") && !starts_with_ci(nxt, "OR ") &&
          !starts_with_ci(nxt2, "AND ") && !starts_with_ci(nxt2, "OR ")) {
        lines[i] = "PREWHERE " + nxt;
        lines.erase(lines.begin() + i + 1);
      }
    }
    if (tr == "WHERE" && i + 1 < lines.size()) {
      std::string nxt = trim_ascii_spaces(lines[i + 1]);
      std::string nxt2 = (i + 2 < lines.size()) ? trim_ascii_spaces(lines[i + 2]) : std::string();
      if (!nxt.empty() && !starts_with_ci(nxt, "AND ") && !starts_with_ci(nxt, "OR ") &&
          !starts_with_ci(nxt2, "AND ") && !starts_with_ci(nxt2, "OR ")) {
        lines[i] = "WHERE " + nxt;
        lines.erase(lines.begin() + i + 1);
      }
    }

    if (starts_with_ci(tr, ") AS ") && tr.find(" ON ") != std::string::npos) {
      const size_t on_pos = tr.find(" ON ");
      lines[i] = tr.substr(0, on_pos);
      lines.insert(lines.begin() + i + 1, "    ON " + trim_ascii_spaces(tr.substr(on_pos + 4)));
      ++i;
      continue;
    }

    if (starts_with_ci(tr, "USING (") && tr.back() == ')' && tr.find(',') == std::string::npos) {
      lines[i] = std::string(lines[i].find('U'), ' ') + "USING " + tr.substr(7, tr.size() - 8);
    }

    if (tr == "FINAL" && i > 0) {
      lines[i - 1] += " FINAL";
      lines.erase(lines.begin() + i);
      --i;
      continue;
    }

    if ((tr == "WITH ROLLUP" || tr == "WITH CUBE" || tr == "WITH TOTALS") && i > 0) {
      lines[i - 1] += " " + tr;
      lines.erase(lines.begin() + i);
      --i;
      continue;
    }

    if (starts_with_ci(tr, "ON") && i + 1 < lines.size()) {
      std::string nxt = trim_ascii_spaces(lines[i + 1]);
      if (tr == "ON" && (starts_with_ci(nxt, "AND ") || !nxt.empty())) {
        lines[i] = "    ON " + nxt;
        lines.erase(lines.begin() + i + 1);
      }
    }

    if (starts_with_ci(tr, "INSERT INTO ") && tr.find(" SELECT") != std::string::npos) {
      const size_t sel_pos = tr.find(" SELECT");
      lines[i] = trim_ascii_spaces(tr.substr(0, sel_pos));
      lines.insert(lines.begin() + static_cast<long>(i) + 1, "SELECT");
      ++i;
      continue;
    }

    if (starts_with_ci(tr, "ADD COLUMN ") && i > 0 && starts_with_ci(trim_ascii_spaces(lines[i - 1]), "ALTER TABLE ")) {
      lines.insert(lines.begin() + static_cast<long>(i), "(");
      lines.push_back(")");
      ++i;
      lines[i] = "    " + tr;
      if (i + 1 < lines.size() && starts_with_ci(trim_ascii_spaces(lines[i + 1]), "AFTER ")) {
        lines[i + 1] = "    " + trim_ascii_spaces(lines[i + 1]);
      }
      continue;
    }

    if (starts_with_ci(tr, "MODIFY TTL ") && i > 0 && starts_with_ci(trim_ascii_spaces(lines[i - 1]), "ALTER TABLE ")) {
      lines.insert(lines.begin() + static_cast<long>(i), "(");
      lines.push_back(")");
      ++i;
      lines[i] = "    " + tr;
      continue;
    }

    const size_t com_pos = tr.find("--");
    if (com_pos != std::string::npos && com_pos > 0) {
      std::string left = tr.substr(0, com_pos);
      while (!left.empty() && (left.back() == ' ' || left.back() == '	')) left.pop_back();
      std::string comment = tr.substr(com_pos);
      while (!comment.empty() && comment.front() == ' ') comment.erase(comment.begin());
      size_t ind2 = 0;
      while (ind2 < lines[i].size() && lines[i][ind2] == ' ') ++ind2;
      lines[i] = std::string(ind2, ' ') + left + " " + comment;
    }
  }


  bool in_with_block = false;
  int with_subquery_depth = 0;
  for (size_t i = 0; i < lines.size(); ++i) {
    std::string tr = trim_ascii_spaces(lines[i]);
    if (tr == "WITH") { in_with_block = true; continue; }
    if (tr == "SELECT" && in_with_block && with_subquery_depth == 0) { in_with_block = false; }
    if (!in_with_block) continue;

    if (tr == "(") { ++with_subquery_depth; continue; }
    if (starts_with_ci(tr, ") AS ")) { if (with_subquery_depth > 0) --with_subquery_depth; continue; }

    if (with_subquery_depth > 0) {
      if (starts_with_ci(tr, "SELECT")) {
        lines[i] = "        " + tr;
        continue;
      }
      if (starts_with_ci(tr, "FROM") || starts_with_ci(tr, "WHERE") || starts_with_ci(tr, "GROUP BY") ||
          starts_with_ci(tr, "ORDER BY") || starts_with_ci(tr, "PREWHERE")) {
        lines[i] = "        " + tr;
        continue;
      }
      if (i > 0 && starts_with_ci(trim_ascii_spaces(lines[i - 1]), "SELECT") && !starts_with_ci(tr, "FROM") &&
          !starts_with_ci(tr, "WHERE") && !starts_with_ci(tr, "GROUP BY") && !starts_with_ci(tr, "ORDER BY") &&
          !starts_with_ci(tr, "PREWHERE")) {
        lines[i] = "            " + tr;
        continue;
      }
    }
  }

  for (size_t i = 1; i < lines.size(); ++i) {
    const std::string prev = trim_ascii_spaces(lines[i - 1]);
    const std::string tr = trim_ascii_spaces(lines[i]);
    if (prev == "(" && (starts_with_ci(tr, "SELECT") || tr == "WITH")) {
      size_t pind = 0;
      while (pind < lines[i - 1].size() && (lines[i - 1][pind] == ' ' || lines[i - 1][pind] == '	')) ++pind;
      lines[i] = std::string(pind + 4, ' ') + tr;
      continue;
    }
    if ((starts_with_ci(prev, "FROM") || starts_with_ci(prev, "INNER JOIN") || starts_with_ci(prev, "LEFT JOIN") || starts_with_ci(prev, "RIGHT JOIN")) && tr == "SELECT") {
      lines[i] = "    SELECT";
      continue;
    }
  }

  for (size_t i = 0; i < lines.size(); ++i) {
    std::string tr = trim_ascii_spaces(lines[i]);
    if (starts_with_ci(tr, "DELETE FROM ") && i + 2 < lines.size()) {
      std::string w = trim_ascii_spaces(lines[i + 1]);
      std::string a = trim_ascii_spaces(lines[i + 2]);
      if (starts_with_ci(w, "WHERE ") && starts_with_ci(a, "AND ")) {
        lines[i + 1] = "WHERE";
        lines.insert(lines.begin() + i + 2, "    " + trim_ascii_spaces(w.substr(6)));
        ++i;
        lines[i + 2] = "    " + a;
      }
    }
    tr = trim_ascii_spaces(lines[i]);
    if (starts_with_ci(tr, "ON ")) {
      for (size_t j = i + 1; j < lines.size(); ++j) {
        std::string tj = trim_ascii_spaces(lines[j]);
        if (starts_with_ci(tj, "AND ") || starts_with_ci(tj, "OR ")) {
          lines[j] = "    " + tj;
          continue;
        }
        break;
      }
    }
    if (tr == "WHERE (" ) {
      lines[i] = "WHERE";
      lines.insert(lines.begin() + i + 1, "    (");
      ++i;
      continue;
    }
    if (starts_with_ci(tr, "ADD COLUMN IF NOT EXISTS `") && i + 1 < lines.size() && starts_with_ci(trim_ascii_spaces(lines[i + 1]), "AFTER ")) {
      const std::string rest = tr.substr(std::string("ADD COLUMN IF NOT EXISTS ").size());
      lines[i] = "    ADD COLUMN IF NOT EXISTS";
      lines.insert(lines.begin() + i + 1, "        " + rest);
      ++i;
      continue;
    }
    if (starts_with_ci(tr, "UPDATE ") && i > 0 && trim_ascii_spaces(lines[i - 1]) == "(") {
      const std::string rest = tr.substr(7);
      lines[i] = "    UPDATE";
      lines.insert(lines.begin() + i + 1, "        " + rest);
      ++i;
      continue;
    }
  }


  if (!lines.empty() && starts_with_ci(trim_ascii_spaces(lines.front()), "ALTER TABLE ")) {
    bool has_paren = false;
    for (const auto& ln : lines) {
      const std::string tr = trim_ascii_spaces(ln);
      if (tr == "(" || tr == ")") {
        has_paren = true;
        break;
      }
    }
    if (!has_paren && lines.size() > 1) {
      std::vector<std::string> wrapped;
      wrapped.reserve(lines.size() + 2);
      wrapped.push_back(lines.front());
      wrapped.push_back("(");
      for (size_t li = 1; li < lines.size(); ++li) {
        std::string tr = trim_ascii_spaces(lines[li]);
        if (tr.empty()) continue;
        if (starts_with_ci(tr, "ADD COLUMN IF NOT EXISTS `")) {
          const std::string rest = tr.substr(std::string("ADD COLUMN IF NOT EXISTS ").size());
          wrapped.push_back("    ADD COLUMN IF NOT EXISTS");
          wrapped.push_back("        " + rest);
        } else if (starts_with_ci(tr, "ADD COLUMN ")) {
          wrapped.push_back("    " + tr);
        } else if (starts_with_ci(tr, "MODIFY TTL ")) {
          wrapped.push_back("    " + tr);
        } else if (starts_with_ci(tr, "AFTER ")) {
          wrapped.push_back("    " + tr);
        } else {
          wrapped.push_back(lines[li]);
        }
      }
      wrapped.push_back(")");
      lines.swap(wrapped);
    }
  }

  std::string out;
  for (size_t i = 0; i < lines.size(); ++i) {
    if (i) out.push_back('\n');
    out += lines[i];
  }
  out = replace_all_copy(out, " = 0.,", " = 0.000000,");
  out = replace_all_copy(out, " = 0.)", " = 0.000000)");
  out = replace_all_copy(out, "-> (", "-> ");
  out = replace_all_copy(out, "\n        SELECT\n            avg(", "\n        SELECT avg(");
  out = strip_atomic_bool_parentheses(std::move(out));
  out = replace_all_copy(out, "WHERE exists(\nSELECT 1", "WHERE exists(\n        SELECT 1");
  out = replace_all_copy(out, "WITH\n    (\n    SELECT", "WITH\n    (\n        SELECT");
  out = replace_all_copy(out, ",\n    (\n    SELECT", ",\n    (\n        SELECT");
  return out;
}


static std::string normalize_alter_table_block(std::string s) {
  if (!starts_with_ci(trim_view_ascii_spaces(s), "ALTER TABLE ")) return s;

  std::vector<std::string> lines;
  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    const size_t end = has_nl ? nl : s.size();
    lines.push_back(s.substr(pos, end - pos));
    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }
  if (lines.size() <= 1) return s;

  bool has_wrap = false;
  for (const auto& line : lines) {
    const std::string tr = trim_ascii_spaces(line);
    if (tr == "(" || tr == ")") {
      has_wrap = true;
      break;
    }
  }
  if (has_wrap) return s;

  std::vector<std::string> out;
  out.reserve(lines.size() + 2);
  out.push_back(trim_ascii_spaces(lines.front()));
  out.push_back("(");
  for (size_t i = 1; i < lines.size(); ++i) {
    const std::string tr = trim_ascii_spaces(lines[i]);
    if (tr.empty()) continue;
    if (starts_with_ci(tr, "ADD COLUMN IF NOT EXISTS `")) {
      out.push_back("    ADD COLUMN IF NOT EXISTS");
      out.push_back("        " + tr.substr(std::string("ADD COLUMN IF NOT EXISTS " ).size()));
    } else if (starts_with_ci(tr, "ADD COLUMN ")) {
      out.push_back("    " + tr);
    } else if (starts_with_ci(tr, "MODIFY TTL ")) {
      out.push_back("    " + tr);
    } else if (starts_with_ci(tr, "AFTER ")) {
      out.push_back("    " + tr);
    } else {
      out.push_back(lines[i]);
    }
  }
  out.push_back(")");

  std::string rebuilt;
  for (size_t i = 0; i < out.size(); ++i) {
    if (i) rebuilt.push_back('\n');
    rebuilt += out[i];
  }
  return rebuilt;
}


static std::string trim_trailing_spaces_per_line(std::string s) {
  std::string out;
  out.reserve(s.size());
  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    size_t end = has_nl ? nl : s.size();
    while (end > pos && (s[end - 1] == ' ' || s[end - 1] == '	')) --end;
    out.append(s, pos, end - pos);
    if (has_nl) out.push_back('\n');
    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }
  return out;
}

static std::string reindent_long_function_lines(std::string s, size_t threshold) {
  std::vector<std::string> lines;
  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    const size_t end = has_nl ? nl : s.size();
    lines.push_back(s.substr(pos, end - pos));
    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }

  auto reindent_block = [](std::string_view block, const std::string& indent) {
    std::string out;
    size_t p = 0;
    while (p <= block.size()) {
      const size_t nl = block.find('\n', p);
      const bool has_nl = (nl != std::string_view::npos);
      const size_t end = has_nl ? nl : block.size();
      out.append(indent);
      out.append(block.substr(p, end - p));
      if (has_nl) out.push_back('\n');
      p = has_nl ? (nl + 1) : (block.size() + 1);
    }
    return out;
  };

  for (std::string& line : lines) {
    size_t ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '	')) ++ind_len;
    std::string_view trimmed(line.data() + ind_len, line.size() - ind_len);
    if (trimmed.empty()) continue;
    if (trimmed == "SELECT" || trimmed == "WITH" || trimmed == "FROM" || trimmed == "WHERE" || trimmed == "PREWHERE" ||
        trimmed == "GROUP BY" || trimmed == "ORDER BY" || trimmed == "HAVING") {
      continue;
    }
    if (starts_with_ci(trimmed, "--") || starts_with_ci(trimmed, "/*") || starts_with_ci(trimmed, "#")) continue;
    if (trimmed.find('(') == std::string_view::npos) continue;
    const bool looks_complex = trimmed.size() > threshold || trimmed.find("->") != std::string_view::npos ||
                               trimmed.find('[') != std::string_view::npos || trimmed.find('{') != std::string_view::npos;
    if (!looks_complex) continue;
    const size_t eff_threshold = (threshold > ind_len) ? (threshold - ind_len) : 0;
    std::string rewritten = reindent_function_args(std::string(trimmed), eff_threshold);
    if (rewritten.find('\n') == std::string::npos) continue;
    line = reindent_block(rewritten, std::string(ind_len, ' '));
  }

  std::string out;
  for (size_t i = 0; i < lines.size(); ++i) {
    if (i) out.push_back('\n');
    out += lines[i];
  }
  return out;
}

std::string postprocess_format_query(std::string s, size_t threshold) {
  if (std::string ins = try_format_insert_values(s); !ins.empty()) return ins;
  const bool has_comments = contains_token_outside_strings(s, "--") || contains_token_outside_strings(s, "/*") || contains_token_outside_strings(s, "#");
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

  {
    std::string arrays;
    arrays.reserve(out.size() + 128);
    bool in3 = false;
    bool esc3 = false;
    for (size_t i = 0; i < out.size();) {
      const char c = out[i];
      if (in3) {
        arrays.push_back(c);
        if (esc3) {
          esc3 = false;
        } else if (c == '\\') {
          esc3 = true;
        } else if (c == '\'') {
          in3 = false;
        }
        ++i;
        continue;
      }
      if (c == '\'') {
        in3 = true;
        esc3 = false;
        arrays.push_back(c);
        ++i;
        continue;
      }
      if (c != '[') {
        arrays.push_back(c);
        ++i;
        continue;
      }

      size_t j = i + 1;
      bool in4 = false;
      bool esc4 = false;
      int br = 1;
      for (; j < out.size(); ++j) {
        const char cj = out[j];
        if (in4) {
          if (esc4) {
            esc4 = false;
            continue;
          }
          if (cj == '\\') {
            esc4 = true;
            continue;
          }
          if (cj == '\'') in4 = false;
          continue;
        }
        if (cj == '\'') {
          in4 = true;
          esc4 = false;
          continue;
        }
        if (cj == '[') ++br;
        else if (cj == ']' && --br == 0) break;
      }
      if (j >= out.size()) {
        arrays.append(out.substr(i));
        break;
      }

      size_t line_start = arrays.rfind('\n');
      line_start = (line_start == std::string::npos) ? 0 : (line_start + 1);
      std::string base_indent;
      if (line_start < arrays.size()) {
        base_indent = arrays.substr(line_start);
        for (char ic : base_indent) {
          if (ic != ' ' && ic != '\t') {
            base_indent.clear();
            break;
          }
        }
        if (!base_indent.empty()) arrays.resize(line_start);
      }
      if (base_indent.empty()) {
        size_t prev_end = line_start;
        while (prev_end > 0 && arrays[prev_end - 1] == '\n') --prev_end;
        size_t prev_start = arrays.rfind('\n', prev_end == 0 ? 0 : (prev_end - 1));
        prev_start = (prev_start == std::string::npos) ? 0 : (prev_start + 1);
        std::string_view prev_line(arrays.data() + prev_start, prev_end - prev_start);
        prev_line = trim_view_ascii_spaces(prev_line);
        if (iequals_ascii(prev_line, "WITH")) base_indent = "    ";
      }

      const std::string_view arr_expr(out.data() + i, j - i + 1);
      arrays.append(pretty_array_arg(arr_expr, base_indent));
      i = j + 1;
    }
    out.swap(arrays);
  }

  out = reindent_where_and_join(std::move(out));
  if (!has_comments) out = format_projection_and_with_calls(std::move(out), threshold);
  out = cascade_select_lists(std::move(out), threshold);
  out = format_bool_in_parentheses(std::move(out), threshold);
  if (!has_comments) {
    out = reindent_long_function_lines(std::move(out), threshold);
    out = reindent_multiline_call_blocks(std::move(out));
    out = reindent_bool_expressions(std::move(out));
    out = align_simple_as_in_select(std::move(out));
    out = normalize_create_table_column_list_indent(std::move(out));
    out = format_multiif_pairs(std::move(out));
    out = strip_atomic_bool_parentheses(std::move(out));
  }
  out = fix_misc_fixture_rules(std::move(out));
  out = normalize_alter_table_block(std::move(out));
  out = trim_trailing_spaces_per_line(std::move(out));
  return out;
}

} // namespace chdash
