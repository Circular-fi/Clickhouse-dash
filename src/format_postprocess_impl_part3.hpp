#pragma once

#include <limits>
#include <optional>

namespace chdash {

static std::string format_bool_in_parentheses(std::string s, size_t threshold) {
  size_t i = 0;

  auto line_indent_at = [&](size_t pos) -> std::string {
    size_t line_start = s.rfind("\n", pos);
    line_start = (line_start == std::string::npos) ? 0 : (line_start + 1);
    std::string ind;
    ind.reserve(32);
    for (size_t j = line_start; j < s.size(); ++j) {
      const char c = s[j];
      if (c == ' ' || c == '\t') ind.push_back(c);
      else break;
    }
    return ind;
  };


  auto last_ident_before_paren = [&](std::string_view t) -> std::string {
    while (!t.empty() && is_ascii_space(t.back())) t.remove_suffix(1);
    size_t e = t.size();
    size_t b = e;
    while (b > 0) {
      const char c = t[b - 1];
      const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
      if (!ok) break;
      --b;
    }
    if (b >= e) return {};
    return std::string(t.substr(b, e - b));
  };

  auto reindent_multiline = [&](std::string_view block, const std::string& indent) -> std::string {
    size_t min_ws = std::numeric_limits<size_t>::max();
    {
      size_t p = 0;
      while (p < block.size()) {
        size_t nl = block.find('\n', p);
        if (nl == std::string_view::npos) nl = block.size();
        std::string_view line = block.substr(p, nl - p);
        size_t k = 0;
        while (k < line.size() && (line[k] == ' ' || line[k] == '\t')) ++k;
        if (k < line.size()) {
          const char t0 = line[k];
          if (!(k == 0 && (t0 == '(' || t0 == '[' || t0 == '{'))) {
            min_ws = std::min(min_ws, k);
          }
        }
        p = (nl < block.size()) ? (nl + 1) : block.size();
      }
      if (min_ws == std::numeric_limits<size_t>::max()) min_ws = 0;
    }

    std::string out;
    out.reserve(block.size() + indent.size() * 8 + 16);
    size_t p = 0;
    while (p < block.size()) {
      size_t nl = block.find('\n', p);
      if (nl == std::string_view::npos) nl = block.size();
      std::string_view line = block.substr(p, nl - p);
      size_t k = 0;
      while (k < line.size() && (line[k] == ' ' || line[k] == '\t')) ++k;
      line = line.substr(std::min(k, min_ws));
      out.append(indent);
      out.append(line);
      if (nl < block.size()) out.push_back('\n');
      p = (nl < block.size()) ? (nl + 1) : block.size();
    }
    return out;
  };

  auto reindent_multiline_rebase = [&](std::string_view block, const std::string& from, const std::string& to) -> std::string {
    std::string out;
    out.reserve(block.size() + to.size() * 8 + 16);
    size_t p = 0;
    while (p < block.size()) {
      size_t nl = block.find('\n', p);
      if (nl == std::string_view::npos) nl = block.size();
      std::string_view line = block.substr(p, nl - p);
      if (!from.empty() && line.size() >= from.size() && line.substr(0, from.size()) == from) {
        line.remove_prefix(from.size());
      }
      out.append(to);
      out.append(line);
      if (nl < block.size()) out.push_back('\n');
      p = (nl < block.size()) ? (nl + 1) : block.size();
    }
    return out;
  };

  auto fix_query_select_lists = [&](std::string block) -> std::string {
    std::vector<std::string> ls;
    ls.reserve(64);

    size_t p = 0;
    while (true) {
      const size_t nl = block.find('\n', p);
      if (nl == std::string::npos) {
        ls.push_back(block.substr(p));
        break;
      }
      ls.push_back(block.substr(p, nl - p));
      p = nl + 1;
      if (p > block.size()) break;
      if (p == block.size()) {
        ls.push_back(std::string());
        break;
      }
    }

    for (size_t i = 0; i < ls.size(); ++i) {
      const std::string& line = ls[i];
      size_t ind_len = 0;
      while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
      std::string_view trimmed(line.data() + ind_len, line.size() - ind_len);
      if (trimmed != "SELECT") continue;

      const std::string sel_indent = line.substr(0, ind_len);
      const std::string item_indent = sel_indent + "    ";

      size_t j = i + 1;
      for (; j < ls.size(); ++j) {
        const std::string& l2 = ls[j];
        size_t ind2 = 0;
        while (ind2 < l2.size() && (l2[ind2] == ' ' || l2[ind2] == '\t')) ++ind2;
        std::string_view t2(l2.data() + ind2, l2.size() - ind2);

        if (t2.rfind("FROM", 0) == 0 && ind2 == ind_len) break;
        if (t2.empty()) continue;
        if (ind2 <= ind_len) ls[j] = item_indent + std::string(t2);
      }

      i = j;
    }

    std::string out;
    out.reserve(block.size() + 64);
    for (size_t k = 0; k < ls.size(); ++k) {
      out.append(ls[k]);
      if (k + 1 < ls.size()) out.push_back('\n');
    }
    return out;
  };

  auto parse = [&](auto&& self, char stop) -> std::string {
    std::string out;
    out.reserve(256);

    bool in_str = false;
    bool esc = false;
    bool in_line_comment = false;
    bool in_block_comment = false;

    while (i < s.size()) {
      const char c = s[i];

      if (!in_str && !in_line_comment && !in_block_comment && stop != 0 && c == stop) {
        ++i;
        break;
      }

      if (in_line_comment) {
        out.push_back(c);
        ++i;
        if (c == '\n') in_line_comment = false;
        continue;
      }

      if (in_block_comment) {
        out.push_back(c);
        ++i;
        if (c == '*' && i < s.size() && s[i] == '/') {
          out.push_back('/');
          ++i;
          in_block_comment = false;
        }
        continue;
      }

      if (in_str) {
        out.push_back(c);
        ++i;
        if (esc) {
          esc = false;
          continue;
        }
        if (c == '\\') {
          esc = true;
          continue;
        }
        if (c == '\'') in_str = false;
        continue;
      }

      if (c == '\'') {
        in_str = true;
        esc = false;
        out.push_back(c);
        ++i;
        continue;
      }

      if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
        in_line_comment = true;
        out.push_back('-');
        out.push_back('-');
        i += 2;
        continue;
      }

      if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
        in_block_comment = true;
        out.push_back('/');
        out.push_back('*');
        i += 2;
        continue;
      }

      if (c == '(') {
        const size_t paren_pos = i;
        const bool is_call = (paren_pos > 0 && is_ident_char(s[paren_pos - 1]));
        const std::string indent = line_indent_at(i);
        out.push_back('(');
        ++i;

        std::string inner = self(self, ')');
        const std::string_view inner_trim = trim_view_ascii_spaces(std::string_view(inner));
        const bool looks_query = looks_like_query_block(inner_trim);
        const auto inner_parts = looks_query ? std::vector<BoolPart>() : split_bool_ops_top_level(inner_trim);

        if (!looks_query && !is_call && inner_parts.size() > 1) {
          const std::string inner_indent = indent + "    ";
          out.push_back('\n');
          out.append(format_bool_expr(inner_trim, inner_indent));
          out.push_back('\n');
          out.append(indent);
        } else if (!looks_query && !is_call && !inner_trim.empty() && inner_trim.size() > threshold) {
          const std::string inner_indent = indent + "    ";
          out.push_back('\n');
          if (inner_trim.find('\n') != std::string_view::npos) {
            out.append(reindent_multiline_rebase(inner_trim, indent, inner_indent));
          } else {
            out.append(inner_indent);
            out.append(inner_trim);
          }
          out.push_back('\n');
          out.append(indent);
        } else if (looks_query) {
          const std::string prev = last_ident_before_paren(std::string_view(out).substr(0, out.size() - 1));
          if (iequals_ascii(prev, "IN")) {
            const std::string inner_indent = indent + "    ";
            out.push_back('\n');
            if (inner_trim.find('\n') != std::string_view::npos) {
              std::string q = reindent_multiline(inner_trim, inner_indent);
              q = fix_query_select_lists(std::move(q));
              out.append(q);
            } else {
              out.append(inner_indent);
              out.append(inner_trim);
            }
            out.push_back('\n');
            out.append(indent);
          } else {
            out.append(inner);
          }
        } else {
          out.append(inner);
        }

        out.push_back(')');
        continue;
      }

      out.push_back(c);
      ++i;
    }

    return out;
  };

  i = 0;
  std::string out = parse(parse, 0);
  return out;
}

static std::string reindent_bool_expressions(std::string s) {
  std::string out;
  out.reserve(s.size() + 256);

  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    const size_t end = has_nl ? nl : s.size();
    const std::string_view line = std::string_view(s).substr(pos, end - pos);

    size_t ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
    const std::string_view indent = line.substr(0, ind_len);
    const std::string_view trimmed = line.substr(ind_len);

    const bool skip = trimmed.empty() ||
                      trimmed.rfind("WHERE", 0) == 0 ||
                      trimmed.rfind("HAVING", 0) == 0 ||
                      trimmed.rfind("PREWHERE", 0) == 0 ||
                      trimmed.rfind("AND ", 0) == 0 ||
                      trimmed.rfind("OR ", 0) == 0 ||
                      trimmed.front() == ')' ||
                      trimmed.front() == ',';

    if (skip) {
      out.append(line);
    } else {
      const auto parts = split_bool_ops_top_level(trimmed);
      if (parts.size() > 1) {
        out.append(format_bool_expr(trimmed, std::string(indent)));
      } else {
        out.append(line);
      }
    }

    if (has_nl) out.push_back('\n');
    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }

  return out;
}

static std::string reindent_function_args(std::string s, size_t threshold) {
  auto is_ident_start = [](char c) -> bool {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
  };

  auto count_top_level_newlines = [&](std::string_view in) -> size_t {
    bool in_str = false;
    bool esc = false;
    bool in_line_comment = false;
    bool in_block_comment = false;
    int par = 0, br = 0, brc = 0;
    size_t n = 0;

    for (size_t i = 0; i < in.size(); ++i) {
      const char c = in[i];
      if (in_line_comment) {
        if (c == '\n') in_line_comment = false;
        continue;
      }
      if (in_block_comment) {
        if (c == '*' && i + 1 < in.size() && in[i + 1] == '/') {
          in_block_comment = false;
          ++i;
        }
        continue;
      }
      if (in_str) {
        if (esc) {
          esc = false;
          continue;
        }
        if (c == '\\') {
          esc = true;
          continue;
        }
        if (c == '\'') in_str = false;
        continue;
      }

      if (c == '\'') {
        in_str = true;
        esc = false;
        continue;
      }

      if (c == '-' && i + 1 < in.size() && in[i + 1] == '-') {
        in_line_comment = true;
        ++i;
        continue;
      }
      if (c == '#') {
        in_line_comment = true;
        continue;
      }
      if (c == '/' && i + 1 < in.size() && in[i + 1] == '*') {
        in_block_comment = true;
        ++i;
        continue;
      }

      if (c == '(') ++par;
      else if (c == ')' && par > 0) --par;
      else if (c == '[') ++br;
      else if (c == ']' && br > 0) --br;
      else if (c == '{') ++brc;
      else if (c == '}' && brc > 0) --brc;

      if (c == '\n' && par == 0 && br == 0 && brc == 0) ++n;
    }

    return n;
  };

  auto reindent_multiline = [&](std::string_view block, const std::string& indent) -> std::string {
    size_t min_ws = std::numeric_limits<size_t>::max();
    {
      size_t p = 0;
      while (p < block.size()) {
        size_t nl = block.find('\n', p);
        if (nl == std::string_view::npos) nl = block.size();
        std::string_view line = block.substr(p, nl - p);
        size_t k = 0;
        while (k < line.size() && (line[k] == ' ' || line[k] == '\t')) ++k;
        if (k < line.size()) {
          std::string_view rest = line.substr(k);
          if (!(rest.size() == 1 && (rest[0] == '(' || rest[0] == '[' || rest[0] == '{'))) {
            min_ws = std::min(min_ws, k);
          }
        }
        p = (nl < block.size()) ? (nl + 1) : block.size();
      }
      if (min_ws == std::numeric_limits<size_t>::max()) min_ws = 0;
    }

    std::string out;
    out.reserve(block.size() + indent.size() * 8 + 16);
    size_t p = 0;
    while (p < block.size()) {
      size_t nl = block.find('\n', p);
      if (nl == std::string_view::npos) nl = block.size();
      std::string_view line = block.substr(p, nl - p);
      size_t k = 0;
      while (k < line.size() && (line[k] == ' ' || line[k] == '\t')) ++k;
      line = line.substr(std::min(k, min_ws));
      out.append(indent);
      out.append(line);
      if (nl < block.size()) out.push_back('\n');
      p = (nl < block.size()) ? (nl + 1) : block.size();
    }
    return out;
  };

  std::string out;
  out.reserve(s.size() + 256);

  bool in_str = false;
  bool esc = false;
  bool in_line_comment = false;
  bool in_block_comment = false;

  for (size_t i = 0; i < s.size();) {
    const char c = s[i];

    if (in_line_comment) {
      out.push_back(c);
      ++i;
      if (c == '\n') in_line_comment = false;
      continue;
    }

    if (in_block_comment) {
      out.push_back(c);
      ++i;
      if (c == '*' && i < s.size() && s[i] == '/') {
        out.push_back('/');
        ++i;
        in_block_comment = false;
      }
      continue;
    }

    if (in_str) {
      out.push_back(c);
      ++i;
      if (esc) {
        esc = false;
        continue;
      }
      if (c == '\\') {
        esc = true;
        continue;
      }
      if (c == '\'') in_str = false;
      continue;
    }

    if (c == '\'') {
      in_str = true;
      esc = false;
      out.push_back(c);
      ++i;
      continue;
    }

    if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
      in_line_comment = true;
      out.push_back('-');
      out.push_back('-');
      i += 2;
      continue;
    }

    if (c == '#') {
      in_line_comment = true;
      out.push_back('#');
      ++i;
      continue;
    }

    if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
      in_block_comment = true;
      out.push_back('/');
      out.push_back('*');
      i += 2;
      continue;
    }

    if (!is_ident_start(c)) {
      out.push_back(c);
      ++i;
      continue;
    }

    const size_t name_beg = i;
    size_t name_end = i + 1;
    while (name_end < s.size() && is_ident_char(s[name_end])) ++name_end;
    std::string_view name = std::string_view(s).substr(name_beg, name_end - name_beg);

    if (name_end >= s.size() || s[name_end] != '(') {
      out.append(s.substr(name_beg, name_end - name_beg));
      i = name_end;
      continue;
    }

    const bool is_cast = (name.size() == 4) && (name[0] == 'C' || name[0] == 'c') && (name[1] == 'A' || name[1] == 'a') &&
                         (name[2] == 'S' || name[2] == 's') && (name[3] == 'T' || name[3] == 't');
    if (is_cast) {
      out.append(s.substr(name_beg, name_end - name_beg + 1));
      i = name_end + 1;
      continue;
    }

    size_t j = name_end + 1;
    bool in2 = false;
    bool esc2 = false;
    bool lc2 = false;
    bool bc2 = false;
    int par = 1;
    int br = 0;
    int brc = 0;
    for (; j < s.size(); ++j) {
      const char cj = s[j];
      if (lc2) {
        if (cj == '\n') lc2 = false;
        continue;
      }
      if (bc2) {
        if (cj == '*' && j + 1 < s.size() && s[j + 1] == '/') {
          bc2 = false;
          ++j;
        }
        continue;
      }
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
      if (cj == '-' && j + 1 < s.size() && s[j + 1] == '-') {
        lc2 = true;
        ++j;
        continue;
      }
      if (cj == '#') {
        lc2 = true;
        continue;
      }
      if (cj == '/' && j + 1 < s.size() && s[j + 1] == '*') {
        bc2 = true;
        ++j;
        continue;
      }

      if (cj == '(') ++par;
      else if (cj == ')') {
        --par;
        if (par == 0) break;
      } else if (cj == '[') ++br;
      else if (cj == ']' && br > 0) --br;
      else if (cj == '{') ++brc;
      else if (cj == '}' && brc > 0) --brc;
    }

    if (j >= s.size() || s[j] != ')') {
      out.append(s.substr(name_beg, name_end - name_beg));
      i = name_end;
      continue;
    }

    const size_t call_end = j + 1;
    const size_t call_len = call_end - name_beg;
    std::string_view inner = std::string_view(s).substr(name_end + 1, j - (name_end + 1));
    auto args = split_top_level(inner, ',');
    const bool long_call = (call_len > threshold);
    const bool multi_arg = (args.size() >= 2);
    const bool single_arg = (args.size() == 1);

    if (!long_call) {
      out.append(s.substr(name_beg, name_end - name_beg + 1));
      i = name_end + 1;
      continue;
    }

    const size_t nl_count = count_top_level_newlines(inner);
    const bool already_one_per_line = multi_arg && (nl_count >= args.size() - 1);
    if (already_one_per_line) {
      out.append(s.substr(name_beg, name_end - name_beg + 1));
      i = name_end + 1;
      continue;
    }

    std::string_view inner_trim = trim_view_ascii_spaces(inner);
    bool starts_with_ident_call = false;
    if (!inner_trim.empty() && is_ident_start(inner_trim.front())) {
      size_t p = 1;
      while (p < inner_trim.size() && is_ident_char(inner_trim[p])) ++p;
      while (p < inner_trim.size() && (inner_trim[p] == ' ' || inner_trim[p] == '\t')) ++p;
      if (p < inner_trim.size() && inner_trim[p] == '(') starts_with_ident_call = true;
    }

    const bool should_format = (multi_arg) || (single_arg && starts_with_ident_call);
    if (!should_format) {
      out.append(s.substr(name_beg, name_end - name_beg + 1));
      i = name_end + 1;
      continue;
    }

    size_t line_start = out.rfind('\n');
    line_start = (line_start == std::string::npos) ? 0 : (line_start + 1);
    std::string base_indent;
    if (line_start < out.size()) {
      base_indent = out.substr(line_start);
      for (char ic : base_indent) {
        if (ic != ' ' && ic != '\t') {
          base_indent.clear();
          break;
        }
      }
    }
    const std::string arg_indent = base_indent + "    ";

    auto format_paren_list_arg = [&](const std::string& a, const std::string& indent) -> std::optional<std::string> {
    if (a.size() < 2 || a.front() != '(' || a.back() != ')') return std::nullopt;
    if (a.find('\n') == std::string::npos && a.size() <= threshold) return std::nullopt;
    std::string_view inner = std::string_view(a).substr(1, a.size() - 2);
    const std::string_view inner_trim = trim_view_ascii_spaces(inner);
    if (inner_trim.empty() || looks_like_query_block(inner_trim)) return std::nullopt;
    auto items = split_top_level(inner_trim, ',');
    if (items.size() < 2) return std::nullopt;
    const std::string item_indent = indent + "    ";
    std::string out;
    out.reserve(a.size() + indent.size() * 8 + 16);
    out.append(indent);
    out.push_back('(');
    out.push_back('\n');
    for (size_t ii = 0; ii < items.size(); ++ii) {
      std::string it = trim_ascii_spaces(items[ii]);
      if (it.find('\n') != std::string::npos) {
        out.append(reindent_multiline(it, item_indent));
      } else {
        out.append(item_indent);
        out.append(it);
      }
      if (ii + 1 < items.size()) out.push_back(',');
      out.push_back('\n');
    }
    out.append(indent);
    out.push_back(')');
    return out;
  };

    out.append(std::string(name));
    out.push_back('(');
    out.push_back('\n');
    for (size_t k = 0; k < args.size(); ++k) {
      std::string a = trim_ascii_spaces(args[k]);
      a = reindent_function_args(std::move(a), threshold);
      if (auto formatted = format_paren_list_arg(a, arg_indent)) {
        out.append(*formatted);
      } else if (a.find('\n') != std::string::npos) {
        out.append(reindent_multiline(a, arg_indent));
      } else {
        out.append(arg_indent);
        out.append(a);
      }
      if (k + 1 < args.size()) out.push_back(',');
      out.push_back('\n');
    }
    out.append(base_indent);
    out.push_back(')');

    i = call_end;
  }

  return out;
}

} // namespace chdash
