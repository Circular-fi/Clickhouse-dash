#include "api_error.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <cctype>
#include <optional>
#include <string>
#include <string_view>

namespace chdash {

void json_error(httplib::Response& res, int status, std::string_view code, std::string_view message) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("error_code");
  w.String(code.data(), static_cast<rapidjson::SizeType>(code.size()));
  w.Key("message");
  w.String(message.data(), static_cast<rapidjson::SizeType>(message.size()));
  w.EndObject();
  res.status = status;
  res.set_header("Content-Type", "application/json");
  res.set_content(sb.GetString(), "application/json");
}

namespace {

static bool is_sql_word_char(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

static std::optional<size_t> find_ident_outside_strings_comments(std::string_view sql, std::string_view ident) {
  if (ident.empty() || sql.empty()) return std::nullopt;

  bool in_str = false;
  bool esc = false;
  bool in_line_comment = false;
  bool in_block_comment = false;

  for (size_t i = 0; i + ident.size() <= sql.size(); ++i) {
    char c = sql[i];

    if (in_line_comment) {
      if (c == '\n') in_line_comment = false;
      continue;
    }
    if (in_block_comment) {
      if (c == '*' && i + 1 < sql.size() && sql[i + 1] == '/') {
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

    if (c == '-' && i + 1 < sql.size() && sql[i + 1] == '-') {
      in_line_comment = true;
      ++i;
      continue;
    }
    if (c == '/' && i + 1 < sql.size() && sql[i + 1] == '*') {
      in_block_comment = true;
      ++i;
      continue;
    }

    if (sql.substr(i, ident.size()) == ident) {
      const char prev = (i == 0) ? ' ' : sql[i - 1];
      const char next = (i + ident.size() < sql.size()) ? sql[i + ident.size()] : ' ';
      if (!is_sql_word_char(prev) && !is_sql_word_char(next)) return i;
    }
  }
  return std::nullopt;
}

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
    ++col;
  }
}

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
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();

  if (query_id && !query_id->empty()) {
    w.Key("query_id");
    w.String(query_id->c_str(), static_cast<rapidjson::SizeType>(query_id->size()));
  }

  w.Key("error_code");
  w.String(code.data(), static_cast<rapidjson::SizeType>(code.size()));

  w.Key("message");
  w.String(message.data(), static_cast<rapidjson::SizeType>(message.size()));

  if (index) {
    w.Key("index");
    w.Int(*index);
  }

  if (loc) {
    w.Key("clickhouse");
    w.StartObject();
    if (loc->has_code) {
      w.Key("code");
      w.Int(loc->code);
    }
    if (loc->has_position) {
      w.Key("position");
      w.Int(loc->position);
    }
    if (loc->has_line_col) {
      w.Key("line");
      w.Int(loc->line);
      w.Key("col");
      w.Int(loc->col);
    }
    if (loc->has_near) {
      w.Key("near");
      w.String(loc->near.c_str(), static_cast<rapidjson::SizeType>(loc->near.size()));
    }
    w.EndObject();
  }

  w.EndObject();
  return sb.GetString();
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
  const std::string payload = build_error_payload_json(code, message, loc, query_id, index);
  res.status = status;
  res.set_header("Content-Type", "application/json");
  res.set_content(payload, "application/json");
}

std::optional<std::string> maybe_rewrite_error_sse_chunk(std::string_view chunk, std::string_view original_sql) {
  if (chunk.rfind("event: error\n", 0) != 0) return std::nullopt;

  const size_t data_pos = chunk.find("data:");
  if (data_pos == std::string_view::npos) return std::nullopt;

  size_t json_beg = data_pos + std::string_view("data:").size();
  if (json_beg < chunk.size() && chunk[json_beg] == ' ') ++json_beg;

  const size_t json_end = chunk.find('\n', json_beg);
  if (json_end == std::string_view::npos || json_end <= json_beg) return std::nullopt;

  const std::string json = trim_ascii_spaces(chunk.substr(json_beg, json_end - json_beg));

  rapidjson::Document doc;
  doc.Parse(json.c_str());
  if (doc.HasParseError() || !doc.IsObject()) return std::nullopt;

  if (!doc.HasMember("message") || !doc["message"].IsString()) return std::nullopt;
  const std::string msg = doc["message"].GetString();

  std::string qid;
  if (doc.HasMember("query_id") && doc["query_id"].IsString()) {
    qid = doc["query_id"].GetString();
  }

  const auto loc = parse_clickhouse_error_location(msg, original_sql);
  const ClickHouseErrorLocation* locp =
      (loc.has_code || loc.has_position || loc.has_line_col || loc.has_near) ? &loc : nullptr;

  const std::string err_code =
      (doc.HasMember("error_code") && doc["error_code"].IsString())
          ? std::string(doc["error_code"].GetString())
          : std::string("query_failed");

  const std::string payload = build_error_payload_json(err_code, msg, locp, qid.empty() ? nullptr : &qid, nullptr);

  std::string out;
  out.reserve(chunk.size() + 128);
  out.append("event: error\n");
  out.append("data: ");
  out.append(payload);
  out.append("\n\n");
  return out;
}

} // namespace chdash
