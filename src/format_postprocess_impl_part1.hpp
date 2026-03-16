#pragma once

#include <limits>

namespace chdash {

static bool is_ascii_space(char c) {
  return c == ' ' || c == '\n' || c == '\r' || c == '\t';
}

static std::string trim_ascii_spaces(std::string_view in) {
  size_t b = 0;
  while (b < in.size() && is_ascii_space(in[b])) ++b;
  size_t e = in.size();
  while (e > b && is_ascii_space(in[e - 1])) --e;
  return std::string(in.substr(b, e - b));
}
static bool is_ident_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

static std::vector<std::string> split_top_level(std::string_view s, char sep) {
  std::vector<std::string> out;
  size_t last = 0;
  bool in_str = false;
  bool esc = false;
  int par = 0, br = 0, cr = 0;

  auto flush = [&](size_t pos) {
    out.push_back(std::string(s.substr(last, pos - last)));
    last = pos + 1;
  };

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
      if (c == '\'') {
        in_str = false;
      }
      continue;
    }

    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }

    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++cr;
    else if (c == '}' && cr > 0) --cr;

    if (c == sep && par == 0 && br == 0 && cr == 0) {
      flush(i);
    }
  }

  out.push_back(std::string(s.substr(last)));
  return out;
}

static bool contains_token_outside_strings(std::string_view s, std::string_view tok) {
  bool in_str = false;
  bool esc = false;
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
    if (i + tok.size() <= s.size() && s.substr(i, tok.size()) == tok) return true;
  }
  return false;
}

static std::string pretty_array_arg(std::string_view arr_expr, const std::string& base_indent);

static bool looks_like_tuple_item(std::string_view s) {
  const std::string t = trim_ascii_spaces(s);
  if (t.size() < 2 || t.front() != '(' || t.back() != ')') return false;

  bool in_str = false;
  bool esc = false;
  int par = 0;
  bool has_top_level_comma = false;
  for (size_t i = 0; i < t.size(); ++i) {
    const char c = t[i];
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
    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == ',' && par == 1) has_top_level_comma = true;
  }

  return has_top_level_comma;
}

static std::string reindent_multiline_item(std::string_view block, const std::string& indent) {
  size_t min_ws = std::numeric_limits<size_t>::max();
  size_t p = 0;
  while (p < block.size()) {
    size_t nl = block.find('\n', p);
    if (nl == std::string_view::npos) nl = block.size();
    std::string_view line = block.substr(p, nl - p);
    size_t k = 0;
    while (k < line.size() && (line[k] == ' ' || line[k] == '\t')) ++k;
    if (k < line.size()) min_ws = std::min(min_ws, k);
    p = (nl < block.size()) ? (nl + 1) : block.size();
  }
  if (min_ws == std::numeric_limits<size_t>::max()) min_ws = 0;

  std::string out;
  out.reserve(block.size() + indent.size() * 8 + 16);
  p = 0;
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
}

static std::string format_tuple_item(std::string_view tuple_expr, const std::string& base_indent) {
  std::string t = trim_ascii_spaces(tuple_expr);
  if (!looks_like_tuple_item(t)) return t;

  const std::string_view inner(t.data() + 1, t.size() - 2);
  auto items = split_top_level(inner, ',');
  if (items.size() <= 1) return t;

  bool simple_inline = (t.size() <= 56);
  for (const auto& raw_item : items) {
    const std::string it = trim_ascii_spaces(raw_item);
    if (it.find('\n') != std::string::npos ||
        (it.size() >= 2 && it.front() == '[' && it.back() == ']') ||
        looks_like_tuple_item(it) || contains_token_outside_strings(it, "tuple(") ||
        contains_token_outside_strings(it, "Tuple(")) {
      simple_inline = false;
      break;
    }
  }
  if (simple_inline) return t;

  const std::string item_indent = base_indent + "    ";
  std::ostringstream oss;
  oss << base_indent << "(\n";
  for (size_t i = 0; i < items.size(); ++i) {
    std::string it = trim_ascii_spaces(items[i]);
    if (it.size() >= 2 && it.front() == '[' && it.back() == ']') {
      oss << pretty_array_arg(it, item_indent);
    } else if (it.find('\n') != std::string::npos) {
      oss << reindent_multiline_item(it, item_indent);
    } else {
      oss << item_indent << it;
    }
    if (i + 1 < items.size()) oss << ",";
    oss << "\n";
  }
  oss << base_indent << ")";
  return oss.str();
}

static std::string pretty_array_arg(std::string_view arr_expr, const std::string& base_indent) {
  std::string t = trim_ascii_spaces(arr_expr);
  if (t.size() < 2 || t.front() != '[' || t.back() != ']') return t;

  const std::string_view inner(t.data() + 1, t.size() - 2);
  auto items = split_top_level(inner, ',');
  if (items.empty()) return t;

  bool has_complex_item = false;
  for (const auto& raw_item : items) {
    const std::string item = trim_ascii_spaces(raw_item);
    if (item.find('\n') != std::string::npos || looks_like_tuple_item(item) ||
        (item.size() >= 2 && item.front() == '[' && item.back() == ']') ||
        contains_token_outside_strings(item, "tuple(") || contains_token_outside_strings(item, "Tuple(")) {
      has_complex_item = true;
      break;
    }
  }
  if (!has_complex_item) return t;

  const std::string item_indent = base_indent + "    ";
  std::ostringstream oss;
  oss << base_indent << "[\n";
  for (size_t i = 0; i < items.size(); ++i) {
    std::string it = trim_ascii_spaces(items[i]);
    if (looks_like_tuple_item(it)) {
      std::string formatted = format_tuple_item(it, item_indent);
      if (formatted.find('\n') == std::string::npos) oss << item_indent << formatted;
      else oss << formatted;
    } else if (it.find('\n') != std::string::npos) {
      oss << reindent_multiline_item(it, item_indent);
    } else {
      oss << item_indent << it;
    }
    if (i + 1 < items.size()) oss << ",";
    oss << "\n";
  }
  oss << base_indent << "]";
  return oss.str();
}

static size_t find_from_keyword_top_level(const std::string& s) {
  // Find " FROM " at top-level (not inside (), [] or strings).
  const std::string needle = " FROM ";
  bool in_str = false;
  bool esc = false;
  int par = 0, br = 0, cr = 0;
  for (size_t i = 0; i + needle.size() <= s.size(); ++i) {
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
    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++cr;
    else if (c == '}' && cr > 0) --cr;

    if (par == 0 && br == 0 && cr == 0 && s.compare(i, needle.size(), needle) == 0) return i;
  }
  return std::string::npos;
}

static bool has_top_level_comma(std::string_view s) {
  bool in_str = false;
  bool esc = false;
  int par = 0, br = 0, cr = 0;
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
    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++cr;
    else if (c == '}' && cr > 0) --cr;
    if (c == ',' && par == 0 && br == 0 && cr == 0) return true;
  }
  return false;
}


static size_t find_token_outside_strings(std::string_view s, std::string_view tok) {
  bool in_str = false;
  bool esc = false;
  if (tok.empty()) return std::string::npos;
  for (size_t i = 0; i + tok.size() <= s.size(); ++i) {
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
    if (s.substr(i, tok.size()) == tok) return i;
  }
  return std::string::npos;
}

static int paren_delta_outside_strings(std::string_view s) {
  bool in_str = false;
  bool esc = false;
  bool in_line_comment = false;
  bool in_block_comment = false;
  int delta = 0;

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];

    if (in_line_comment) {
      if (c == '\n') in_line_comment = false;
      continue;
    }

    if (in_block_comment) {
      if (c == '*' && i + 1 < s.size() && s[i + 1] == '/') {
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

    if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
      in_line_comment = true;
      ++i;
      continue;
    }

    if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
      in_block_comment = true;
      ++i;
      continue;
    }

    if (c == '(') ++delta;
    else if (c == ')') --delta;
  }

  return delta;
}

struct BoolPart {
  std::string op;
  std::string text;
};

static bool is_word_char(char c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '`';
}

static std::vector<BoolPart> split_bool_ops_top_level(std::string_view s) {
  std::vector<BoolPart> out;
  size_t last = 0;

  bool in_str = false;
  bool esc = false;
  bool in_line_comment = false;
  bool in_block_comment = false;

  int par = 0, br = 0, cr = 0;
  bool in_lambda = false;
  std::string next_op;

  auto flush = [&](size_t pos) {
    BoolPart p;
    p.op = next_op;
    p.text = std::string(s.substr(last, pos - last));
    out.push_back(std::move(p));
    next_op.clear();
  };

  auto skip_ws = [&](size_t& i) {
    while (i < s.size() && is_ascii_space(s[i])) ++i;
  };

  skip_ws(last);

  for (size_t i = last; i < s.size(); ++i) {
    const char c = s[i];

    if (in_line_comment) {
      if (c == '\n') in_line_comment = false;
      continue;
    }

    if (in_block_comment) {
      if (c == '*' && i + 1 < s.size() && s[i + 1] == '/') {
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

    if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
      in_line_comment = true;
      ++i;
      continue;
    }

    if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
      in_block_comment = true;
      ++i;
      continue;
    }

    if (c == '(') ++par;
    else if (c == ')' && par > 0) --par;
    else if (c == '[') ++br;
    else if (c == ']' && br > 0) --br;
    else if (c == '{') ++cr;
    else if (c == '}' && cr > 0) --cr;

    if (!in_lambda && par == 0 && br == 0 && cr == 0 && c == '-' && i + 1 < s.size() && s[i + 1] == '>') {
      in_lambda = true;
      ++i;
      continue;
    }

    if (in_lambda) {
      if (par == 0 && br == 0 && cr == 0 && c == ',') in_lambda = false;
      continue;
    }

    if (par != 0 || br != 0 || cr != 0) continue;

    auto match_kw = [&](std::string_view kw) -> bool {
      if (i + kw.size() > s.size()) return false;
      for (size_t k = 0; k < kw.size(); ++k) {
        const char a = s[i + k];
        const char b = kw[k];
        if (a != b && a != char(b + 32)) return false;
      }
      const char prev = (i == 0) ? ' ' : s[i - 1];
      const char next = (i + kw.size() < s.size()) ? s[i + kw.size()] : ' ';
      if (is_word_char(prev) || is_word_char(next)) return false;
      return true;
    };

    if (match_kw("AND")) {
      flush(i);
      next_op = std::string(s.substr(i, 3));
      size_t j = i + 3;
      skip_ws(j);
      last = j;
      i = j ? (j - 1) : i;
      continue;
    }

    if (match_kw("OR")) {
      flush(i);
      next_op = std::string(s.substr(i, 2));
      size_t j = i + 2;
      skip_ws(j);
      last = j;
      i = j ? (j - 1) : i;
      continue;
    }
  }

  BoolPart p;
  p.op = next_op;
  p.text = std::string(s.substr(last));
  out.push_back(std::move(p));
  return out;
}



static bool iequals_ascii(std::string_view a, std::string_view b) {
  if (a.size() != b.size()) return false;
  for (size_t i = 0; i < a.size(); ++i) {
    unsigned char ca = static_cast<unsigned char>(a[i]);
    unsigned char cb = static_cast<unsigned char>(b[i]);
    if (ca >= 'A' && ca <= 'Z') ca = static_cast<unsigned char>(ca + 32);
    if (cb >= 'A' && cb <= 'Z') cb = static_cast<unsigned char>(cb + 32);
    if (ca != cb) return false;
  }
  return true;
}

static bool is_where_terminator(std::string_view t) {
  static const std::string_view kws[] = {
      "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "UNION", "WINDOW", "PREWHERE", "SETTINGS", "FORMAT"};
  for (auto kw : kws) {
    if (t.size() >= kw.size() && t.substr(0, kw.size()) == kw) return true;
  }
  return false;
}


static std::string_view trim_view_ascii_spaces(std::string_view in) {
  size_t b = 0;
  while (b < in.size() && is_ascii_space(in[b])) ++b;
  size_t e = in.size();
  while (e > b && is_ascii_space(in[e - 1])) --e;
  return in.substr(b, e - b);
}



static bool looks_like_query_block(std::string_view s) {
  s = trim_view_ascii_spaces(s);
  static const std::string_view kws[] = {"SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP"};
  for (auto kw : kws) {
    if (s.size() >= kw.size() && iequals_ascii(s.substr(0, kw.size()), kw)) return true;
  }
  return false;
}

static bool peel_one_outer_paren(std::string_view s, std::string_view& inner) {
  s = trim_view_ascii_spaces(s);
  if (s.size() < 2 || s.front() != '(' || s.back() != ')') return false;

  bool in_str = false;
  bool esc = false;
  bool in_line_comment = false;
  bool in_block_comment = false;
  int par = 0;

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];

    if (in_line_comment) {
      if (c == '\n') in_line_comment = false;
      continue;
    }

    if (in_block_comment) {
      if (c == '*' && i + 1 < s.size() && s[i + 1] == '/') {
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

    if (c == '-' && i + 1 < s.size() && s[i + 1] == '-') {
      in_line_comment = true;
      ++i;
      continue;
    }

    if (c == '/' && i + 1 < s.size() && s[i + 1] == '*') {
      in_block_comment = true;
      ++i;
      continue;
    }

    if (c == '(') ++par;
    else if (c == ')') {
      --par;
      if (par == 0 && i != s.size() - 1) return false;
    }
  }

  if (par != 0) return false;
  inner = s.substr(1, s.size() - 2);
  return true;
}

static std::string format_bool_expr(std::string_view expr, const std::string& base_indent);

static bool peel_and_has_bool_ops(std::string_view expr, std::string_view& inner) {
  if (!peel_one_outer_paren(expr, inner)) return false;
  const auto parts = split_bool_ops_top_level(inner);
  return parts.size() > 1;
}

static std::string format_bool_chain(std::string_view expr, const std::string& base_indent, std::string_view op) {
  const auto parts = split_bool_ops_top_level(expr);
  if (parts.size() < 2) return {};

  for (size_t i = 1; i < parts.size(); ++i) {
    if (!iequals_ascii(parts[i].op, op)) return {};
  }

  struct Operand {
    std::string_view raw;
    std::string_view inner;
    bool multiline;
  };

  std::vector<Operand> ops;
  ops.reserve(parts.size());
  for (const auto& p : parts) {
    std::string_view inner;
    if (!peel_one_outer_paren(p.text, inner)) return {};
    Operand o;
    o.raw = trim_view_ascii_spaces(p.text);
    o.inner = inner;
    o.multiline = (inner.find('\n') != std::string_view::npos) || (split_bool_ops_top_level(inner).size() > 1);
    ops.push_back(o);
  }

  auto emit_operand = [&](std::string& out, const Operand& o, const std::string& indent) {
    if (!o.multiline) {
      out.append(o.raw);
      return;
    }
    out.push_back('(');
    out.push_back('\n');
    out.append(format_bool_expr(o.inner, indent + "    "));
    out.push_back('\n');
    out.append(indent);
    out.push_back(')');
  };

  std::string out;
  out.reserve(expr.size() + base_indent.size() * parts.size() + 64);

  out.append(base_indent);
  emit_operand(out, ops[0], base_indent);

  for (size_t i = 1; i < ops.size(); ++i) {
    out.push_back('\n');
    out.append(base_indent);
    out.append(parts[i].op);
    out.push_back(' ');
    if (!ops[i].multiline) {
      out.append(ops[i].raw);
      continue;
    }
    emit_operand(out, ops[i], base_indent);
  }

  return out;
}

static std::string format_bool_expr(std::string_view expr, const std::string& base_indent) {
  expr = trim_view_ascii_spaces(expr);
  if (expr.empty()) return base_indent;

  if (auto f = format_bool_chain(expr, base_indent, "OR"); !f.empty()) return f;
  if (auto f = format_bool_chain(expr, base_indent, "AND"); !f.empty()) return f;

  std::string_view inner;
  if (peel_one_outer_paren(expr, inner)) {
    const auto inner_parts = split_bool_ops_top_level(inner);
    if (inner_parts.size() > 1) {
      std::string out;
      out.reserve(base_indent.size() * 4 + expr.size() + 16);
      out.append(base_indent);
      out.push_back('(');
      out.push_back('\n');
      out.append(format_bool_expr(inner, base_indent + "    "));
      out.push_back('\n');
      out.append(base_indent);
      out.push_back(')');
      return out;
    }
  }

  const auto parts = split_bool_ops_top_level(expr);
  if (parts.empty()) {
    std::string out;
    out.reserve(base_indent.size() + expr.size());
    out.append(base_indent);
    out.append(expr);
    return out;
  }

  std::string out;
  out.reserve(base_indent.size() * parts.size() + expr.size() + 64);

  {
    std::string_view inner;
    const std::string_view t0 = trim_view_ascii_spaces(parts[0].text);
    if (peel_and_has_bool_ops(t0, inner)) {
      out.append(base_indent);
      out.push_back('(');
      out.push_back('\n');
      out.append(format_bool_expr(inner, base_indent + "    "));
      out.push_back('\n');
      out.append(base_indent);
      out.push_back(')');
    } else {
      out.append(base_indent);
      out.append(trim_ascii_spaces(parts[0].text));
    }
  }

  for (size_t i = 1; i < parts.size(); ++i) {
    std::string_view inner;
    const std::string_view ti = trim_view_ascii_spaces(parts[i].text);
    if (peel_and_has_bool_ops(ti, inner)) {
      out.push_back('\n');
      out.append(base_indent);
      out.append(parts[i].op);
      out.push_back(' ');
      out.push_back('(');
      out.push_back('\n');
      out.append(format_bool_expr(inner, base_indent + "    "));
      out.push_back('\n');
      out.append(base_indent);
      out.push_back(')');
      continue;
    }
    out.push_back('\n');
    out.append(base_indent);
    out.append(parts[i].op);
    out.push_back(' ');
    out.append(trim_ascii_spaces(parts[i].text));
  }
  return out;
}

static bool is_bool_clause_start(std::string_view t, std::string_view& kw, std::string_view& rest) {
  static const std::string_view kws[] = {"WHERE ", "HAVING ", "PREWHERE "};
  for (auto k : kws) {
    if (t.rfind(k, 0) == 0) {
      kw = k.substr(0, k.size() - 1);
      rest = t.substr(k.size());
      return true;
    }
  }
  return false;
}


} // namespace chdash
