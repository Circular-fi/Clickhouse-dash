#include "api_error.hpp"
#include "ch_error.hpp"
#include "json_parse.hpp"
#include "json_text.hpp"
#include "sql_lexer.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <cctype>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {


void send_error(httplib::Response& res, const ApiError& error) {
  const std::string body = error_json(error);
  res.status = error.status;
  res.headers.erase("Cache-Control");
  res.set_header("Cache-Control", "no-store");
  res.set_content(body, "application/json");
}

void json_error(httplib::Response& res, int status, std::string_view code, std::string_view message) {
  ApiError error;
  error.status = status;
  error.code = std::string(code);
  error.message = std::string(message);
  send_error(res, error);
}

void json_not_granted(httplib::Response& res, int status, std::string_view code, std::string_view user, std::string_view grant,
                      std::string_view what) {
  std::string message(what);
  message += ": DB::Exception: ";
  message += user;
  message += ": Not enough privileges. To execute this query, it's necessary to have the grant ";
  message += grant;
  json_error(res, status, code, message);
}

ApiError error_from_clickhouse(const std::exception& error, std::string_view area, std::string_view failed_code) {
  const ChError failure = classify_clickhouse_error(error);
  const std::string name(area);
  // What a person reads: the page that failed, and what to do about it.
  const std::string page = name == "trace" ? "traces" : name;
  ApiError out;
  out.message = error.what();
  switch (failure.kind) {
    case ChErrorKind::Timeout:
      out.status = 504;
      out.code = name + "_timeout";
      out.message = "The " + page + " query exceeded its time limit. Narrow the time range or add filters.";
      break;
    case ChErrorKind::ScanLimit:
      out.status = 422;
      out.code = name + "_scan_limit";
      out.message = "The " + page + " query would read or return too much. Narrow the time range or add a service filter.";
      break;
    case ChErrorKind::MemoryLimit:
      out.status = 422;
      out.code = name + "_memory_limit";
      out.message = "The " + page + " query needs more memory than it may use. Narrow the time range or add filters.";
      break;
    case ChErrorKind::AccessDenied:
      out.status = 503;
      out.code = name + "_not_granted";
      break;
    case ChErrorKind::Canceled:
      out.status = 499;
      out.code = "canceled";
      out.message = "The request was canceled.";
      break;
    case ChErrorKind::Unavailable:
      out.status = 503;
      out.code = "host_unavailable";
      out.retryable = true;
      break;
    case ChErrorKind::ReadOnly:
    case ChErrorKind::NotFound:
    case ChErrorKind::BadQuery:
    case ChErrorKind::Other:
      // A refusal of ClickHouse that ChDash has no word for, or a fault of ChDash itself.
      out.status = failure.code != 0 ? 503 : 500;
      out.code = std::string(failed_code);
      out.retryable = false;
      break;
  }
  return out;
}

namespace {

static bool is_sql_word_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

// The first place where `ident` stands in the code of `sql`: not in a text, a heredoc or a comment, and not as a
// part of a longer word. (A quoted name is code: `a b` is found by its text.)
static std::optional<size_t> find_ident_outside_strings_comments(std::string_view sql, std::string_view ident) {
  if (ident.empty() || sql.empty()) return std::nullopt;
  std::vector<bool> skipped(sql.size(), false);
  for (const sql::Token& token : sql::lex(sql)) {
    if (!sql::is_comment(token.kind) && token.kind != sql::TokenKind::String && token.kind != sql::TokenKind::HereDoc) continue;
    for (size_t i = token.begin; i < token.end; ++i) skipped[i] = true;
  }
  for (size_t at = sql.find(ident); at != std::string_view::npos; at = sql.find(ident, at + 1)) {
    if (skipped[at]) continue;
    const char prev = at == 0 ? ' ' : sql[at - 1];
    const char next = at + ident.size() < sql.size() ? sql[at + ident.size()] : ' ';
    if (!is_sql_word_char(prev) && !is_sql_word_char(next)) return at;
  }
  return std::nullopt;
}

// The line and the column (1-based) of the byte `idx`. The column counts UTF-16 units, as the editor of the page does.
static void compute_line_col_from_index(std::string_view sql, size_t idx, int& line, int& col) {
  if (idx > sql.size()) idx = sql.size();
  line = 1;
  col = 1;
  for (size_t i = 0; i < idx; ++i) {
    const char c = sql[i];
    if (c == '\r') {
      if (i + 1 < sql.size() && sql[i + 1] == '\n') ++i;
      ++line;
      col = 1;
      continue;
    }
    if (c == '\n') {
      ++line;
      col = 1;
      continue;
    }
    const auto u = static_cast<unsigned char>(c);
    if ((u & 0xC0) == 0x80) continue;  // the rest of a character
    col += u >= 0xF0 ? 2 : 1;          // a character above U+FFFF is two UTF-16 units
  }
}

}

ClickHouseErrorLocation parse_clickhouse_error_location(std::string_view msg, std::string_view original_sql) {
  ClickHouseErrorLocation out;

  auto ltrim = [](std::string_view s) {
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) ++i;
    return s.substr(i);
  };

  msg = ltrim(msg);
  if (msg.rfind("exception:", 0) == 0) {
    msg = msg.substr(std::string_view("exception:").size());
    msg = ltrim(msg);
  }

  const bool has_explicit_position_marker = (msg.find("position ") != std::string_view::npos);
  const bool has_explicit_linecol_marker = (msg.find("(line ") != std::string_view::npos);

  auto parse_int_at = [&](size_t pos, int& value) -> bool {
    if (pos >= msg.size() || !std::isdigit(static_cast<unsigned char>(msg[pos]))) return false;
    long v = 0;
    while (pos < msg.size() && std::isdigit(static_cast<unsigned char>(msg[pos]))) {
      v = v * 10 + (msg[pos] - '0');
      if (v > 1'000'000'000) break;
      ++pos;
    }
    value = static_cast<int>(v);
    return true;
  };

  if (auto p = msg.find("Code:"); p != std::string_view::npos) {
    size_t i = p + 5;
    while (i < msg.size() && (msg[i] == ' ' || msg[i] == '\t')) ++i;
    int v = 0;
    if (parse_int_at(i, v)) {
      out.has_code = true;
      out.code = v;
    }
  }

  if (auto p = msg.find("position "); p != std::string_view::npos) {
    size_t i = p + std::string_view("position ").size();
    int v = 0;
    if (parse_int_at(i, v)) {
      out.has_position = true;
      out.position = v;

      auto open = msg.find('(', i);
      if (open != std::string_view::npos) {
        auto close = msg.find(')', open + 1);
        if (close != std::string_view::npos && close > open + 1) {
          std::string_view inner = msg.substr(open + 1, close - (open + 1));
          inner = ltrim(inner);
          if (!inner.empty() && inner.rfind("line ", 0) != 0 && inner.find(' ') == std::string_view::npos && inner.size() <= 64) {
            out.has_near = true;
            out.near.assign(inner.data(), inner.size());
          }
        }
      }
    }
  }

  if (auto p = msg.find("(line "); p != std::string_view::npos) {
    size_t i = p + std::string_view("(line ").size();
    int line = 0;
    if (parse_int_at(i, line)) {
      auto colp = msg.find("col", i);
      if (colp != std::string_view::npos) {
        size_t j = colp + 3;
        while (j < msg.size() && (msg[j] == ' ' || msg[j] == '\t')) ++j;
        int col = 0;
        if (parse_int_at(j, col)) {
          out.has_line_col = true;
          out.line = line;
          out.col = col;
        }
      }
    }
  }

  if (!out.has_near) {
    if (auto p = msg.find("): "); p != std::string_view::npos) {
      size_t i = p + 3;
      size_t j = i;
      while (j < msg.size()) {
        char c = msg[j];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' || c == ')') break;
        ++j;
      }
      if (j > i) {
        std::string_view tok = msg.substr(i, j - i);
        if (tok.size() <= 64) {
          out.has_near = true;
          out.near.assign(tok.data(), tok.size());
        }
      }
    }
  }

  {
    auto grab_quoted_after = [&](std::string_view key) -> std::string_view {
      const size_t p = msg.find(key);
      if (p == std::string_view::npos) return {};
      size_t i = p + key.size();
      const size_t q = msg.find('\'', i);
      if (q == std::string_view::npos) return {};
      const size_t r = msg.find('\'', q + 1);
      if (r == std::string_view::npos || r <= q + 1) return {};
      return msg.substr(q + 1, r - (q + 1));
    };

    std::string_view ident = grab_quoted_after("identifier");
    if (ident.empty()) ident = grab_quoted_after("Identifier");
    if (!ident.empty() && ident.size() <= 128) {
      out.has_near = true;
      out.near.assign(ident.data(), ident.size());
    }
  }

  {
    auto find_backticked_after_key = [&](std::string_view key) -> std::string_view {
      const size_t p = msg.find(key);
      if (p == std::string_view::npos) return {};
      size_t i = p + key.size();
      while (i < msg.size() && (msg[i] == ' ' || msg[i] == '\t')) ++i;
      if (i >= msg.size() || msg[i] != '`') return {};
      const size_t r = msg.find('`', i + 1);
      if (r == std::string_view::npos || r <= i + 1) return {};
      return msg.substr(i + 1, r - (i + 1));
    };

    std::string_view tok = find_backticked_after_key("identifier");
    if (tok.empty()) tok = find_backticked_after_key("Identifier");
    if (!tok.empty() && tok.size() <= 128 && tok.find_first_of(" \t\r\n`") == std::string_view::npos) {
      out.has_near = true;
      out.near.assign(tok.data(), tok.size());
    } else if (!out.has_near) {
      size_t q = msg.find('`');
      while (q != std::string_view::npos) {
        const size_t r = msg.find('`', q + 1);
        if (r == std::string_view::npos) break;
        if (r > q + 1) {
          std::string_view t = msg.substr(q + 1, r - (q + 1));
          if (t.size() <= 128 && t.find_first_of(" \t\r\n`") == std::string_view::npos) {
            out.has_near = true;
            out.near.assign(t.data(), t.size());
            break;
          }
        }
        q = msg.find('`', q + 1);
      }
    }
  }

  if ((!has_explicit_position_marker || !has_explicit_linecol_marker)) {
    if (!original_sql.empty()) {
      if (out.has_position && !out.has_line_col) {
        const size_t idx0 = (out.position > 0) ? static_cast<size_t>(out.position - 1) : 0;
        int line = 1;
        int col = 1;
        compute_line_col_from_index(original_sql, idx0, line, col);
        out.has_line_col = true;
        out.line = line;
        out.col = col;
      }

      if (out.has_near && !out.has_position) {
        if (auto idx = find_ident_outside_strings_comments(original_sql, out.near)) {
          out.has_position = true;
          out.position = static_cast<int>(*idx) + 1;
          int line = 1;
          int col = 1;
          compute_line_col_from_index(original_sql, *idx, line, col);
          out.has_line_col = true;
          out.line = line;
          out.col = col;
        }
      }
    } else {
      if (out.has_near) {
        constexpr std::string_view scope_kw = "in scope ";
        if (auto p = msg.find(scope_kw); p != std::string_view::npos) {
          std::string_view scope = msg.substr(p + scope_kw.size());
          while (!scope.empty() && (scope.back() == ' ' || scope.back() == '\n' || scope.back() == '\r' || scope.back() == '\t' || scope.back() == '.')) {
            scope.remove_suffix(1);
          }

          size_t idx = scope.find(std::string_view(out.near));
          if (idx == std::string_view::npos) {
            const std::string q = "'" + out.near + "'";
            idx = scope.find(q);
            if (idx != std::string_view::npos) idx += 1;
          }

          if (idx != std::string_view::npos) {
            if (!has_explicit_position_marker) {
              out.has_position = true;
              out.position = static_cast<int>(idx) + 1;
            }
            if (!has_explicit_linecol_marker) {
              out.has_line_col = true;
              out.line = 1;
              out.col = static_cast<int>(idx) + 1;
            }
          }
        }
      }
    }
  }

  return out;
}

std::string build_error_payload_json(
    std::string_view code,
    std::string_view message,
    const ClickHouseErrorLocation* loc,
    const std::string* query_id,
    const int* index
) {
  ApiError error;
  error.status = 500;
  error.code = std::string(code);
  error.message = std::string(message);
  if (loc) error.clickhouse = *loc;
  if (query_id && !query_id->empty()) error.query_id = *query_id;
  if (index) error.index = *index;
  return error_json(error);
}

void json_error_with_payload(
    httplib::Response& res,
    int status,
    std::string_view code,
    std::string_view message,
    const ClickHouseErrorLocation* loc,
    const std::string* query_id,
    const int* index
) {
  ApiError error;
  error.status = status;
  error.code = std::string(code);
  error.message = std::string(message);
  if (loc) error.clickhouse = *loc;
  if (query_id && !query_id->empty()) error.query_id = *query_id;
  if (index) error.index = *index;
  send_error(res, error);
}

} // namespace chdash
