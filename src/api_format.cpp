#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "sql_util.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <chrono>
#include <optional>
#include <string>
#include <string_view>

namespace chdash {

namespace {

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

static std::optional<std::string> try_format_query(
    const HostSpec& host,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
) {
  if (sql.size() > max_bytes) {
    if (err_log) *err_log = "sql too large";
    return std::nullopt;
  }

  const std::string escaped = escape_for_clickhouse_string(sql);
  const std::string fmt_sql = "SELECT formatQuery('" + escaped + "') AS query";

  std::string err;
  auto client = make_client_from_uri(
      host.runner_uri,
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      &err
  );

  if (!client) {
    if (err_log) *err_log = "make_client failed: " + err;
    return std::nullopt;
  }

  std::optional<std::string> formatted;

  try {
    client->Select(fmt_sql, [&](const clickhouse::Block& b) {
      if (b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;

      clickhouse::ColumnRef col = b[0];
      if (!col) return;

      if (auto nullable = col->As<clickhouse::ColumnNullable>()) {
        if (nullable->IsNull(0)) return;
        col = nullable->Nested();
      }

      if (auto s = col->As<clickhouse::ColumnString>()) {
        formatted = std::string(s->At(0));
      }
    });
  } catch (const std::exception& e) {
    if (err_log) *err_log = std::string(e.what());
    return std::nullopt;
  }

  if (!formatted) {
    if (err_log) *err_log = "no formatted result returned";
  }

  return formatted;
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

static std::string pretty_array_arg(std::string_view arr_expr, const std::string& base_indent) {
  // Only rewrite when it clearly looks like a "complex" array (outer arrays of tuples, etc.).
  // Simple arrays like ['a','b'] are intentionally kept inline.
  std::string t = trim_ascii_spaces(arr_expr);
  if (t.size() < 2 || t.front() != '[' || t.back() != ']') return t;

  // Heuristic: array contains tuple(...) outside strings.
  const bool has_tuple =
      contains_token_outside_strings(t, "tuple(") || contains_token_outside_strings(t, "Tuple(");
  if (!has_tuple) return t;

  const std::string_view inner(t.data() + 1, t.size() - 2);
  auto items = split_top_level(inner, ',');
  if (items.size() <= 1) return t;

  const std::string item_indent = base_indent + "    ";
  std::ostringstream oss;
  oss << base_indent << "[\n";
  for (size_t i = 0; i < items.size(); ++i) {
    std::string it = trim_ascii_spaces(items[i]);
    oss << item_indent << it;
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

    out.append(clause_indent);
    out.append(clause_kw);
    if (parts.size() <= 1 && !multiline) {
      out.push_back(' ');
      out.append(expr);
      out.push_back('\n');
    } else {
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

  bool in_select = false;
  std::vector<Group> groups;
  groups.reserve(8);

  auto add = [&](size_t idx, size_t ind_len, size_t expr_end_col) {
    const size_t target = expr_end_col + 2;
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

        const size_t cap = g.ind_len + 80;
        const size_t target_col = (g.target_as_col > cap) ? cap : g.target_as_col;

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

    if (!in_select && (trimmed == "SELECT" || trimmed.rfind("SELECT ", 0) == 0)) {
      flush();
      in_select = true;
      continue;
    }
    if (in_select && trimmed.rfind("FROM", 0) == 0) {
      flush();
      in_select = false;
      continue;
    }
    if (!in_select) {
      flush();
      continue;
    }

    size_t ind_len2 = 0;
    size_t as_pos = 0;
    if (is_alias_as(line, ind_len2, as_pos)) {
      size_t ws_start = ind_len2 + as_pos;
      while (ws_start > 0 && (line[ws_start - 1] == ' ' || line[ws_start - 1] == '\t')) --ws_start;
      add(i, ind_len2, ws_start);
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

static std::string postprocess_format_query(std::string s, size_t threshold) {
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
  return out;
}

} // namespace

void Server::handle_api_format(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString()) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }

  const std::string host_id = doc["host_id"].GetString();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) {
    return json_error(res, 404, "unknown_host", "Unknown host_id.");
  }

  if (health_) {
    HostsSnapshot hs = health_->snapshot();
    for (const auto& h : hs.hosts) {
      if (h.id == host_id && !h.healthy) {
        return json_error(res, 503, "host_down", "Selected host is down.");
      }
    }
  }

  auto format_one = [&](std::string sql_raw, std::string* out_pretty, std::string* err) -> bool {
    std::string sql = trim_sql(std::move(sql_raw));
    if (sql.empty()) {
      if (err) *err = "Missing SQL text.";
      return false;
    }
    std::string fmt_err;
    const auto formatted = try_format_query(*host, sql, 500 * 1024, &fmt_err);
    if (!formatted.has_value()) {
      if (err) *err = fmt_err.empty() ? "Failed to format query." : fmt_err;
      return false;
    }
    if (out_pretty) *out_pretty = postprocess_format_query(*formatted, 80);
    return true;
  };

  if (doc.HasMember("sqls") && doc["sqls"].IsArray()) {
    const auto& arr = doc["sqls"];
    rapidjson::StringBuffer sb;
    rapidjson::Writer<rapidjson::StringBuffer> w(sb);
    w.StartObject();
    w.Key("formatted_sqls");
    w.StartArray();
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      if (!arr[i].IsString()) {
        return json_error(res, 400, "invalid_sqls", "sqls must be an array of strings.");
      }
      std::string pretty;
      std::string err;
      if (!format_one(arr[i].GetString(), &pretty, &err)) {
        const std::string sql_trimmed = trim_sql(arr[i].GetString());
        const auto loc = parse_clickhouse_error_location(err, sql_trimmed);
        const ClickHouseErrorLocation* locp = (loc.has_code || loc.has_position || loc.has_line_col || loc.has_near) ? &loc : nullptr;
        const int idx = static_cast<int>(i);
        return json_error_with_payload(res, 422, "format_failed", err, locp, nullptr, &idx);
      }
      w.String(pretty.c_str());
    }
    w.EndArray();
    w.EndObject();

    res.status = 200;
    res.set_content(sb.GetString(), "application/json");
    return;
  }

  if (!doc.HasMember("sql") || !doc["sql"].IsString()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }

  std::string pretty;
  std::string err;
  if (!format_one(doc["sql"].GetString(), &pretty, &err)) {
    const std::string sql_trimmed = trim_sql(doc["sql"].GetString());
    const auto loc = parse_clickhouse_error_location(err, sql_trimmed);
    const ClickHouseErrorLocation* locp = (loc.has_code || loc.has_position || loc.has_line_col || loc.has_near) ? &loc : nullptr;
    return json_error_with_payload(res, 422, "format_failed", err, locp, nullptr, nullptr);
  }

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("formatted_sql");
  w.String(pretty.c_str());
  w.EndObject();

  res.status = 200;
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
