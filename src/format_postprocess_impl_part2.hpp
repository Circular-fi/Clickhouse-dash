#pragma once

namespace chdash {

static std::string reindent_function_args(std::string s, size_t threshold);

static std::string normalize_create_table_column_list_indent(std::string s) {
  if (s.find("CREATE TABLE") == std::string::npos) return s;

  auto starts_with_kw = [](std::string_view t, std::string_view kw) -> bool {
    return t.size() >= kw.size() && t.substr(0, kw.size()) == kw;
  };

  bool in_str = false;
  bool esc = false;
  bool in_lc = false;
  bool in_bc = false;

  size_t create_pos = std::string::npos;
  for (size_t i = 0; i + 12 <= s.size(); ++i) {
    const char c = s[i];
    if (in_lc) {
      if (c == '\n') in_lc = false;
      continue;
    }
    if (in_bc) {
      if (c == '*' && i + 1 < s.size() && s[i + 1] == '/') {
        in_bc = false;
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
    if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
      in_lc = true;
      ++i;
      continue;
    }
    if (c == '#') {
      in_lc = true;
      continue;
    }
    if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
      in_bc = true;
      ++i;
      continue;
    }

    if (i + 12 <= s.size() && s.compare(i, 12, "CREATE TABLE") == 0) {
      create_pos = i;
      break;
    }
  }

  if (create_pos == std::string::npos) return s;

  size_t open = std::string::npos;
  {
    bool in_s = false;
    bool e = false;
    bool lc = false;
    bool bc = false;
    int par = 0;
    for (size_t i = create_pos; i < s.size(); ++i) {
      const char c = s[i];
      if (lc) {
        if (c == '\n') lc = false;
        continue;
      }
      if (bc) {
        if (c == '*' && i + 1 < s.size() && s[i + 1] == '/') {
          bc = false;
          ++i;
        }
        continue;
      }
      if (in_s) {
        if (e) {
          e = false;
          continue;
        }
        if (c == '\\') {
          e = true;
          continue;
        }
        if (c == '\'') in_s = false;
        continue;
      }
      if (c == '\'') {
        in_s = true;
        e = false;
        continue;
      }
      if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
        lc = true;
        ++i;
        continue;
      }
      if (c == '#') {
        lc = true;
        continue;
      }
      if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
        bc = true;
        ++i;
        continue;
      }

      if (c == '(') {
        if (par == 0) {
          open = i;
          break;
        }
        ++par;
      } else if (c == ')') {
        if (par > 0) --par;
      }

      if (par == 0 && i + 6 <= s.size() && s.compare(i, 6, "ENGINE") == 0) break;
    }
  }

  if (open == std::string::npos) return s;

  size_t close = std::string::npos;
  {
    bool in_s = false;
    bool e = false;
    bool lc = false;
    bool bc = false;
    int par = 1;
    for (size_t i = open + 1; i < s.size(); ++i) {
      const char c = s[i];
      if (lc) {
        if (c == '\n') lc = false;
        continue;
      }
      if (bc) {
        if (c == '*' && i + 1 < s.size() && s[i + 1] == '/') {
          bc = false;
          ++i;
        }
        continue;
      }
      if (in_s) {
        if (e) {
          e = false;
          continue;
        }
        if (c == '\\') {
          e = true;
          continue;
        }
        if (c == '\'') in_s = false;
        continue;
      }
      if (c == '\'') {
        in_s = true;
        e = false;
        continue;
      }
      if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
        lc = true;
        ++i;
        continue;
      }
      if (c == '#') {
        lc = true;
        continue;
      }
      if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
        bc = true;
        ++i;
        continue;
      }

      if (c == '(') ++par;
      else if (c == ')') {
        --par;
        if (par == 0) {
          close = i;
          break;
        }
      }
    }
  }

  if (close == std::string::npos) return s;

  size_t line_start = s.rfind('\n', open);
  line_start = (line_start == std::string::npos) ? 0 : (line_start + 1);
  std::string base_indent;
  {
    size_t p = line_start;
    while (p < s.size() && (s[p] == ' ' || s[p] == '\t')) {
      base_indent.push_back(s[p]);
      ++p;
    }
  }
  const std::string item_indent = base_indent + "    ";

  auto is_ident_start = [](char c) -> bool {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
  };
  auto is_ident_char = [](char c) -> bool {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
  };
  auto parse_name_token = [&](std::string_view trimmed) -> std::string_view {
    if (trimmed.empty()) return {};
    if (trimmed.front() == '`') {
      const size_t end = trimmed.find('`', 1);
      if (end == std::string::npos) return {};
      return trimmed.substr(0, end + 1);
    }
    if (!is_ident_start(trimmed.front())) return {};
    size_t end = 1;
    while (end < trimmed.size() && is_ident_char(trimmed[end])) ++end;
    return trimmed.substr(0, end);
  };

  size_t max_name_len = 0;
  {
    size_t q = open + 1;
    while (q < close) {
      size_t nl = s.find('\n', q);
      if (nl == std::string::npos || nl > close) nl = close;
      std::string_view line = std::string_view(s).substr(q, nl - q);

      size_t k = 0;
      while (k < line.size() && (line[k] == ' ' || line[k] == '\t')) ++k;
      std::string_view trimmed = line.substr(k);

      if (!trimmed.empty() && (trimmed.front() == '`' || is_ident_start(trimmed.front()))) {
        if (!(starts_with_kw(trimmed, "INDEX ") || starts_with_kw(trimmed, "CONSTRAINT ") ||
              starts_with_kw(trimmed, "PROJECTION ") || starts_with_kw(trimmed, "PRIMARY KEY") ||
              starts_with_kw(trimmed, "KEY ")))
        {
          const std::string_view name_tok = parse_name_token(trimmed);
          if (!name_tok.empty() && name_tok.size() > max_name_len) max_name_len = name_tok.size();
        }
      }

      q = (nl < close) ? (nl + 1) : close;
    }
  }

  std::string out;
  out.reserve(s.size() + 16);
  out.append(s.substr(0, open + 1));

  size_t p = open + 1;
  bool first_line = true;
  while (p < close) {
    size_t nl = s.find('\n', p);
    if (nl == std::string::npos || nl > close) nl = close;
    std::string_view line = std::string_view(s).substr(p, nl - p);

    size_t k = 0;
    while (k < line.size() && (line[k] == ' ' || line[k] == '\t')) ++k;
    std::string_view trimmed = line.substr(k);

    bool is_item = false;
    if (!trimmed.empty()) {
      if (trimmed.front() == '`') {
        is_item = true;
      } else if (starts_with_kw(trimmed, "INDEX ") || starts_with_kw(trimmed, "CONSTRAINT ") ||
                 starts_with_kw(trimmed, "PROJECTION ") || starts_with_kw(trimmed, "PRIMARY KEY") ||
                 starts_with_kw(trimmed, "KEY ")) {
        is_item = true;
      }
    }

    if (is_item) {
      out.push_back('\n');
      out.append(item_indent);
      if (!trimmed.empty() && (trimmed.front() == '`' || is_ident_start(trimmed.front())) &&
          !(starts_with_kw(trimmed, "INDEX ") || starts_with_kw(trimmed, "CONSTRAINT ") ||
            starts_with_kw(trimmed, "PROJECTION ") || starts_with_kw(trimmed, "PRIMARY KEY") ||
            starts_with_kw(trimmed, "KEY ")))
      {
        const std::string_view name_tok = parse_name_token(trimmed);
        if (!name_tok.empty() && max_name_len > 0) {
          out.append(name_tok);
          const size_t pad = (max_name_len > name_tok.size()) ? (max_name_len - name_tok.size()) : 0;
          out.append(pad + 1, ' ');
          std::string_view rest = trimmed.substr(name_tok.size());
          while (!rest.empty() && (rest.front() == ' ' || rest.front() == '\t')) rest.remove_prefix(1);
          out.append(rest);
        } else {
          out.append(trimmed);
        }
      } else {
        out.append(trimmed);
      }
    } else {
      if (!first_line) out.push_back('\n');
      out.append(std::string(line));
    }
    first_line = false;
    p = (nl < close) ? (nl + 1) : close;
  }

  if (!out.empty() && out.back() != '\n') {
    out.push_back('\n');
    out.append(base_indent);
  }

  out.append(s.substr(close));
  return out;
}

static std::string reindent_where_and_join(std::string s) {
  std::string out;
  out.reserve(s.size() + 256);

  bool in_clause = false;
  int clause_depth = 0;
  std::string clause_kw;
  std::string clause_indent;
  std::string clause_expr;

  auto flush_clause = [&]() {
    const std::string_view expr = trim_view_ascii_spaces(std::string_view(clause_expr));
    const auto parts = split_bool_ops_top_level(expr);
    const bool multiline = (expr.find('\n') != std::string_view::npos);

    auto starts_with_call = [](std::string_view t) {
      t = trim_view_ascii_spaces(t);
      if (t.empty()) return false;
      if ((t.front() >= 'A' && t.front() <= 'Z') || (t.front() >= 'a' && t.front() <= 'z') || t.front() == '_') {
        size_t p = 1;
        while (p < t.size() && is_ident_char(t[p])) ++p;
        while (p < t.size() && (t[p] == ' ' || t[p] == '\t')) ++p;
        return p < t.size() && t[p] == '(';
      }
      return false;
    };

    auto emit_multiline_preserved = [&](std::string_view block) {
      size_t p = 0;
      bool first = true;
      while (p <= block.size()) {
        const size_t nl = block.find('\n', p);
        const bool has_nl = (nl != std::string_view::npos);
        const size_t end = has_nl ? nl : block.size();
        const std::string_view raw_line = block.substr(p, end - p);
        const std::string_view t = trim_view_ascii_spaces(raw_line);
        if (!t.empty()) {
          if (first) {
            out.append(clause_indent);
            out.append(clause_kw);
            out.push_back(' ');
            out.append(t);
            out.push_back('\n');
            first = false;
          } else {
            const bool is_close = (t == ")" || t == "]" || t == "}");
            out.append(clause_indent);
            out.append(is_close ? "    " : "        ");
            out.append(t);
            out.push_back('\n');
          }
        }
        if (!has_nl) break;
        p = nl + 1;
      }
    };

    if (parts.size() <= 1 && !multiline) {
      out.append(clause_indent);
      out.append(clause_kw);
      out.push_back(' ');
      out.append(expr);
      out.push_back('\n');
    } else if (parts.size() <= 1 && multiline && (starts_with_call(expr) || find_token_outside_strings(expr, " IN (") != std::string_view::npos)) {
      emit_multiline_preserved(expr);
    } else {
      out.append(clause_indent);
      out.append(clause_kw);
      out.push_back('\n');
      out.append(format_bool_expr(expr, clause_indent + "    "));
      out.push_back('\n');
    }

    in_clause = false;
    clause_depth = 0;
    clause_kw.clear();
    clause_indent.clear();
    clause_expr.clear();
  };

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

    if (in_clause && clause_depth == 0 && (is_where_terminator(trimmed) || (!trimmed.empty() && trimmed.front() == ')'))) {
      flush_clause();
    }

    if (!in_clause) {
      std::string_view kw, rest;
      if (is_bool_clause_start(trimmed, kw, rest)) {
        in_clause = true;
        clause_depth = 0;
        clause_kw = std::string(kw);
        clause_indent = std::string(indent);
        clause_expr = std::string(rest);
        clause_depth += paren_delta_outside_strings(trimmed);
      } else {
        const size_t join_pos = find_token_outside_strings(trimmed, " JOIN ");
        const size_t on_pos = find_token_outside_strings(trimmed, " ON ");
        if (join_pos != std::string::npos && on_pos != std::string::npos && join_pos < on_pos) {
          std::string left = std::string(trimmed.substr(0, on_pos));
          while (!left.empty() && (left.back() == ' ' || left.back() == '\t')) left.pop_back();
          std::string right = std::string(trimmed.substr(on_pos + 1));
          while (!right.empty() && (right.front() == ' ' || right.front() == '\t')) right.erase(right.begin());

          out.append(indent);
          out.append(left);
          out.push_back('\n');

          std::string_view rtrim = trim_view_ascii_spaces(right);
          if (rtrim.rfind("ON ", 0) == 0) {
            const std::string_view expr = rtrim.substr(3);
            out.append(indent);
            out.append("    ON");
            out.push_back('\n');
            out.append(format_bool_expr(expr, std::string(indent) + "        "));
          } else {
            out.append(indent);
            out.append("    ");
            out.append(right);
          }

          if (has_nl) out.push_back('\n');
          pos = has_nl ? (nl + 1) : (s.size() + 1);
          continue;
        }

        out.append(line);
        if (has_nl) out.push_back('\n');
      }
    } else {
      if (!clause_expr.empty()) clause_expr.push_back('\n');
      clause_expr.append(trimmed);
      clause_depth += paren_delta_outside_strings(trimmed);
    }

    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }

  if (in_clause) flush_clause();

  return out;
}

static std::string cascade_format_line(std::string_view line, size_t threshold) {
  if (line.size() <= threshold) return std::string(line);

  size_t ind_len = 0;
  while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
  const std::string base_indent(line.substr(0, ind_len));
  const std::string_view s = line.substr(ind_len);

  bool in_str = false;
  bool esc = false;
  struct Group {
    size_t start;
    size_t commas;
    bool child_break;
  };
  std::vector<Group> st;
  std::vector<char> is_break_start(s.size(), 0);

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
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
    if (c == '(') {
      st.push_back(Group{i, 0, false});
      continue;
    }
    if (c == ',' && !st.empty()) {
      st.back().commas++;
      continue;
    }
    if (c == ')' && !st.empty()) {
      const Group g = st.back();
      st.pop_back();
      const size_t span = (i + 1) - g.start;
      const bool brk = (span > threshold) && (g.commas > 0 || g.child_break);
      if (brk) is_break_start[g.start] = 1;
      if (!st.empty()) st.back().child_break = st.back().child_break || brk;
      continue;
    }
  }

  if (!st.empty()) return std::string(line);

  auto is_clause = [&](std::string_view t) -> bool {
    static const std::string_view kws[] = {"SELECT", "FROM", "WHERE", "AND", "OR", "GROUP", "HAVING", "ORDER", "LIMIT",
                                           "INNER", "LEFT", "RIGHT", "FULL", "JOIN", "ON", "WITH"};
    for (auto kw : kws) {
      if (t.size() >= kw.size() && t.substr(0, kw.size()) == kw) return true;
    }
    return false;
  };

  const std::string_view t = trim_ascii_spaces(s);
  if (is_clause(t)) return std::string(line);

  std::string out;
  out.reserve(line.size() + 128);
  out.append(base_indent);

  bool in2 = false;
  bool esc2 = false;
  std::vector<bool> brk_stack;
  int depth = 0;

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (in2) {
      out.push_back(c);
      if (esc2) {
        esc2 = false;
      } else if (c == '\\') {
        esc2 = true;
      } else if (c == '\'') {
        in2 = false;
      }
      continue;
    }
    if (c == '\'') {
      in2 = true;
      esc2 = false;
      out.push_back(c);
      continue;
    }

    if (c == '(') {
      const bool brk = is_break_start[i];
      brk_stack.push_back(brk);
      ++depth;
      out.push_back('(');
      if (brk) {
        out.push_back('\n');
        out.append(base_indent);
        out.append(std::string(size_t(depth) * 4, ' '));
        while (i + 1 < s.size() && (s[i + 1] == ' ' || s[i + 1] == '\t')) ++i;
      }
      continue;
    }

    if (c == ',' && !brk_stack.empty() && brk_stack.back()) {
      out.push_back(',');
      out.push_back('\n');
      out.append(base_indent);
      out.append(std::string(size_t(depth) * 4, ' '));
      while (i + 1 < s.size() && (s[i + 1] == ' ' || s[i + 1] == '\t')) ++i;
      continue;
    }

    if (c == ')' && !brk_stack.empty()) {
      const bool brk = brk_stack.back();
      brk_stack.pop_back();
      if (brk) {
        if (!out.empty() && out.back() != '\n') {
          out.push_back('\n');
          out.append(base_indent);
          out.append(std::string(size_t(depth - 1) * 4, ' '));
        }
      }
      out.push_back(')');
      --depth;
      continue;
    }

    out.push_back(c);
  }

  return out;
}

static std::string cascade_select_lists(std::string s, size_t threshold) {
  std::string out;
  out.reserve(s.size() + 256);

  bool in_select = false;

  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    const size_t end = has_nl ? nl : s.size();
    const std::string_view line = std::string_view(s).substr(pos, end - pos);

    size_t ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
    const std::string_view trimmed = line.substr(ind_len);

    if (!in_select && (trimmed == "SELECT" || trimmed.rfind("SELECT ", 0) == 0)) {
      in_select = true;
      out.append(line);
    } else if (in_select && trimmed.rfind("FROM", 0) == 0) {
      in_select = false;
      out.append(line);
    } else if (in_select) {
      out.append(cascade_format_line(line, threshold));
    } else {
      out.append(line);
    }

    if (has_nl) out.push_back('\n');
    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }

  return out;
}


static std::string align_simple_as_in_select(std::string s) {
  std::vector<std::string> lines;
  lines.reserve(256);

  size_t pos = 0;
  while (pos <= s.size()) {
    const size_t nl = s.find('\n', pos);
    const bool has_nl = (nl != std::string::npos);
    const size_t end = has_nl ? nl : s.size();
    lines.push_back(std::string(s.substr(pos, end - pos)));
    pos = has_nl ? (nl + 1) : (s.size() + 1);
  }

  auto starts_with = [](std::string_view x, std::string_view pref) -> bool {
    return x.size() >= pref.size() && x.substr(0, pref.size()) == pref;
  };

  auto find_last_as_top_level = [&](std::string_view t) -> size_t {
    bool in_str = false;
    bool esc = false;
    bool in_line_comment = false;
    bool in_block_comment = false;
    int par = 0;
    int br = 0;
    int brc = 0;
    size_t last = std::string::npos;

    for (size_t i = 0; i < t.size();) {
      const char c = t[i];

      if (in_line_comment) break;

      if (in_block_comment) {
        if (c == '*' && i + 1 < t.size() && t[i + 1] == '/') {
          in_block_comment = false;
          i += 2;
          continue;
        }
        ++i;
        continue;
      }

      if (in_str) {
        if (esc) {
          esc = false;
          ++i;
          continue;
        }
        if (c == '\\') {
          esc = true;
          ++i;
          continue;
        }
        if (c == '\'') in_str = false;
        ++i;
        continue;
      }

      if (c == '\'') {
        in_str = true;
        esc = false;
        ++i;
        continue;
      }

      if (c == '-' && i + 1 < t.size() && t[i + 1] == '-') {
        in_line_comment = true;
        break;
      }

      if (c == '#') {
        in_line_comment = true;
        break;
      }

      if (c == '/' && i + 1 < t.size() && t[i + 1] == '*') {
        in_block_comment = true;
        i += 2;
        continue;
      }

      if (c == '(') ++par;
      else if (c == ')' && par > 0) --par;
      else if (c == '[') ++br;
      else if (c == ']' && br > 0) --br;
      else if (c == '{') ++brc;
      else if (c == '}' && brc > 0) --brc;

      if (par == 0 && br == 0 && brc == 0 && i + 4 <= t.size() && t.substr(i, 4) == " AS ") {
        last = i;
        i += 4;
        continue;
      }

      ++i;
    }

    return last;
  };

  auto is_alias_as = [&](const std::string& line, size_t& ind_len, size_t& as_pos) -> bool {
    ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
    std::string_view trimmed(line.data() + ind_len, line.size() - ind_len);

    const size_t pos_as = find_last_as_top_level(trimmed);
    if (pos_as == std::string::npos) return false;

    std::string_view lhs = trimmed.substr(0, pos_as);
    while (!lhs.empty() && (lhs.back() == ' ' || lhs.back() == '\t')) lhs.remove_suffix(1);
    if (lhs.empty()) return false;

    std::string_view tail = trimmed.substr(pos_as + 4);
    while (!tail.empty() && (tail.front() == ' ' || tail.front() == '\t')) tail.remove_prefix(1);
    if (tail.empty()) return false;

    size_t p = 0;
    const char q = tail[p];

    if (q == '`' || q == '"') {
      size_t j = p + 1;
      bool escq = false;
      for (; j < tail.size(); ++j) {
        const char cj = tail[j];
        if (escq) {
          escq = false;
          continue;
        }
        if (cj == '\\') {
          escq = true;
          continue;
        }
        if (cj == q) break;
      }
      if (j >= tail.size() || j == p + 1) return false;
      p = j + 1;
    } else {
      const char c0 = tail[p];
      const bool ok0 = (c0 >= 'A' && c0 <= 'Z') || (c0 >= 'a' && c0 <= 'z') || c0 == '_';
      if (!ok0) return false;
      ++p;
      while (p < tail.size() && is_ident_char(tail[p])) ++p;
    }

    std::string_view rest = tail.substr(p);
    while (!rest.empty() && (rest.front() == ' ' || rest.front() == '\t')) rest.remove_prefix(1);

    if (rest.empty()) {
      as_pos = pos_as;
      return true;
    }

    if (rest.front() == ',') {
      rest.remove_prefix(1);
      while (!rest.empty() && (rest.front() == ' ' || rest.front() == '\t')) rest.remove_prefix(1);
      if (rest.empty() || starts_with(rest, "--") || starts_with(rest, "/*") || rest.front() == '#') {
        as_pos = pos_as;
        return true;
      }
      return false;
    }

    if (starts_with(rest, "--") || starts_with(rest, "/*") || rest.front() == '#') {
      as_pos = pos_as;
      return true;
    }

    return false;
  };

  struct Group {
    size_t ind_len = 0;
    std::vector<size_t> idxs;
    size_t target_as_col = 0;
  };

  enum class BlockKind { None, Select, With };
  BlockKind block = BlockKind::None;
  std::vector<Group> groups;
  groups.reserve(8);

  auto split_long_alias_line = [&](size_t& i, size_t ind_len, size_t as_pos) {
    size_t ws_start = ind_len + as_pos;
    while (ws_start > 0 && (lines[i][ws_start - 1] == ' ' || lines[i][ws_start - 1] == '\t')) --ws_start;

    const size_t cap = ind_len + 80;
    if (ws_start <= cap) return;
    if (lines[i].find("if(") == std::string::npos && lines[i].find("multiIf(") == std::string::npos) return;

    const size_t forced_threshold = (cap > ind_len + 1) ? (cap - ind_len - 1) : 0;
    std::string rewritten = reindent_function_args(lines[i], forced_threshold);
    if (rewritten.find('\n') == std::string::npos) return;

    std::vector<std::string> parts;
    parts.reserve(8);
    size_t p = 0;
    while (p <= rewritten.size()) {
      const size_t nl = rewritten.find('\n', p);
      const bool has_nl = (nl != std::string::npos);
      const size_t end = has_nl ? nl : rewritten.size();
      parts.push_back(rewritten.substr(p, end - p));
      p = has_nl ? (nl + 1) : (rewritten.size() + 1);
    }

    const size_t base_i = i;

    lines[i] = std::move(parts[0]);
    if (parts.size() > 1) {
      lines.insert(lines.begin() + static_cast<long>(i) + 1, parts.begin() + 1, parts.end());
    }

    size_t start_idx = base_i;
    size_t end_idx = base_i + parts.size();

    for (int pass = 0; pass < 2; ++pass) {
      bool changed = false;
      for (size_t j = start_idx; j + 1 < end_idx; ++j) {
        std::string& ln = lines[j];
        if (ln.size() <= 80) continue;
        if (ln.find("if(") == std::string::npos && ln.find("multiIf(") == std::string::npos && ln.find("ifNull(") == std::string::npos) continue;

        size_t ln_ind = 0;
        while (ln_ind < ln.size() && (ln[ln_ind] == ' ' || ln[ln_ind] == '	')) ++ln_ind;
        const size_t thr = (80 > ln_ind + 1) ? (80 - ln_ind - 1) : 0;

        std::string_view t(ln.data() + ln_ind, ln.size() - ln_ind);
        std::string rw = reindent_function_args(std::string(t), thr);
        if (rw.find('\n') == std::string::npos) continue;

        std::vector<std::string> parts2;
        parts2.reserve(8);
        size_t p2 = 0;
        while (p2 <= rw.size()) {
          const size_t nl2 = rw.find('\n', p2);
          const bool has_nl2 = (nl2 != std::string::npos);
          const size_t end2 = has_nl2 ? nl2 : rw.size();
          parts2.push_back(rw.substr(p2, end2 - p2));
          p2 = has_nl2 ? (nl2 + 1) : (rw.size() + 1);
        }

        const std::string prefix = ln.substr(0, ln_ind);
        for (auto& x : parts2) x = prefix + x;

        ln = std::move(parts2[0]);
        if (parts2.size() > 1) {
          lines.insert(lines.begin() + static_cast<long>(j) + 1, parts2.begin() + 1, parts2.end());
          const size_t added = parts2.size() - 1;
          end_idx += added;
          j += added;
        }

        changed = true;
      }
      if (!changed) break;
    }

    i = end_idx - 1;
  };

  auto add = [&](size_t idx, size_t ind_len, size_t expr_end_col) {
    const size_t target = expr_end_col + (block == BlockKind::With ? 1 : 2);
    for (auto& g : groups) {
      if (g.ind_len != ind_len) continue;
      g.idxs.push_back(idx);
      g.target_as_col = std::max(g.target_as_col, target);
      return;
    }
    Group g;
    g.ind_len = ind_len;
    g.idxs.push_back(idx);
    g.target_as_col = target;
    groups.push_back(std::move(g));
  };

  auto flush = [&]() {
    for (auto& g : groups) {
      if (g.idxs.size() < 2) continue;
      for (size_t idx : g.idxs) {
        std::string& line = lines[idx];
        size_t ind_len = 0;
        size_t as_pos = 0;
        if (!is_alias_as(line, ind_len, as_pos)) continue;

        const size_t as_idx = ind_len + as_pos + 1;
        size_t ws_start = ind_len + as_pos;
        while (ws_start > 0 && (line[ws_start - 1] == ' ' || line[ws_start - 1] == '\t')) --ws_start;

        const size_t target_col = g.target_as_col;

        if (as_idx == target_col) continue;

        const size_t pad = (target_col > ws_start) ? (target_col - ws_start) : 1;
        line = line.substr(0, ws_start) + std::string(pad, ' ') + line.substr(as_idx);
      }
    }
    groups.clear();
  };

  for (size_t i = 0; i < lines.size(); ++i) {
    const std::string& line = lines[i];
    size_t ind_len = 0;
    while (ind_len < line.size() && (line[ind_len] == ' ' || line[ind_len] == '\t')) ++ind_len;
    std::string_view trimmed(line.data() + ind_len, line.size() - ind_len);

    if (trimmed == "WITH") {
      flush();
      block = BlockKind::With;
      continue;
    }
    if (block == BlockKind::With && (trimmed == "SELECT" || trimmed.rfind("SELECT ", 0) == 0)) {
      flush();
      block = BlockKind::Select;
      continue;
    }
    if (block == BlockKind::None && (trimmed == "SELECT" || trimmed.rfind("SELECT ", 0) == 0)) {
      flush();
      block = BlockKind::Select;
      continue;
    }
    if (block == BlockKind::Select && trimmed.rfind("FROM", 0) == 0) {
      flush();
      block = BlockKind::None;
      continue;
    }
    if (block == BlockKind::With && (trimmed == "(" || starts_with(trimmed, ") AS "))) {
      flush();
      continue;
    }
    if (block == BlockKind::None) {
      flush();
      continue;
    }

    size_t ind_len2 = 0;
    size_t as_pos = 0;
    if (is_alias_as(line, ind_len2, as_pos)) {
      split_long_alias_line(i, ind_len2, as_pos);
      const std::string& line2 = lines[i];
      size_t ind_len3 = 0;
      size_t as_pos2 = 0;
      if (!is_alias_as(line2, ind_len3, as_pos2)) continue;
      size_t ws_start = ind_len3 + as_pos2;
      while (ws_start > 0 && (line2[ws_start - 1] == ' ' || line2[ws_start - 1] == '\t')) --ws_start;
      add(i, ind_len3, ws_start);
    }
  }
  flush();

  std::string out;
  out.reserve(s.size() + 128);
  for (size_t i = 0; i < lines.size(); ++i) {
    out.append(lines[i]);
    if (i + 1 < lines.size()) out.push_back('\n');
  }
  return out;
}


} // namespace chdash
