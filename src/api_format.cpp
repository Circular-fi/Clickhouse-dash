#include "server.hpp"

#include "api_error.hpp"
#include "format_clickhouse.hpp"
#include "format_postprocess.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "sql_util.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <string>
#include <utility>
#include <vector>

namespace chdash {

namespace {

bool contains_sql_comments(std::string_view s) {
  bool in_str = false;
  bool esc = false;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    const char n = (i + 1 < s.size()) ? s[i + 1] : '\0';
    if (in_str) {
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') in_str = false;
      continue;
    }
    if (c == '\'') {
      in_str = true;
      esc = false;
      continue;
    }
    if ((c == '-' && n == '-') || (c == '/' && n == '*') || c == '#') return true;
  }
  return false;
}

bool has_top_level_values_insert(std::string_view s) {
  auto is_ident = [](char ch) {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_';
  };
  auto ieq = [](char a, char b) {
    if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = static_cast<char>(b - 'A' + 'a');
    return a == b;
  };
  auto match_kw = [&](size_t pos, std::string_view kw) {
    if (pos + kw.size() > s.size()) return false;
    for (size_t i = 0; i < kw.size(); ++i) {
      if (!ieq(s[pos + i], kw[i])) return false;
    }
    const char prev = (pos == 0) ? '\0' : s[pos - 1];
    const char next = (pos + kw.size() < s.size()) ? s[pos + kw.size()] : '\0';
    if (prev && is_ident(prev)) return false;
    if (next && is_ident(next)) return false;
    return true;
  };

  bool in_str = false;
  bool esc = false;
  int par = 0;
  int br = 0;
  int brc = 0;
  bool seen_insert = false;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (in_str) {
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') in_str = false;
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
    else if (c == '{') ++brc;
    else if (c == '}' && brc > 0) --brc;

    if (par == 0 && br == 0 && brc == 0) {
      if (!seen_insert && match_kw(i, "INSERT")) seen_insert = true;
      else if (seen_insert && match_kw(i, "VALUES")) return true;
      else if (seen_insert && match_kw(i, "SELECT")) return false;
      else if (seen_insert && match_kw(i, "FORMAT")) return false;
    }
  }
  return false;
}

bool has_single_quoted_literal_with_whitespace(std::string_view s) {
  bool in_str = false;
  bool esc = false;
  bool has_ws = false;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (!in_str) {
      if (c == '\'') {
        in_str = true;
        esc = false;
        has_ws = false;
      }
      continue;
    }
    if (esc) {
      esc = false;
      continue;
    }
    if (c == '\\') {
      esc = true;
      continue;
    }
    if (c == '\'') {
      if (has_ws) return true;
      in_str = false;
      continue;
    }
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') has_ws = true;
  }
  return false;
}

bool has_complex_sql_surface(std::string_view s) {
  bool in_str = false;
  bool in_backtick = false;
  bool in_line_comment = false;
  bool in_block_comment = false;
  bool esc = false;
  std::string token;
  token.reserve(s.size());

  auto is_ident = [](char ch) {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
           (ch >= '0' && ch <= '9') || ch == '_';
  };
  auto lower = [](char ch) {
    if (ch >= 'A' && ch <= 'Z') return static_cast<char>(ch - 'A' + 'a');
    return ch;
  };

  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    const char n = (i + 1 < s.size()) ? s[i + 1] : '\0';

    if (in_str) {
      if (esc) esc = false;
      else if (c == '\\') esc = true;
      else if (c == '\'') in_str = false;
      continue;
    }
    if (in_backtick) {
      if (c == '`') in_backtick = false;
      continue;
    }
    if (in_line_comment) {
      if (c == '\n') in_line_comment = false;
      continue;
    }
    if (in_block_comment) {
      if (c == '*' && n == '/') {
        in_block_comment = false;
        ++i;
      }
      continue;
    }

    if (c == '\'') {
      in_str = true;
      esc = false;
      token.push_back(' ');
      continue;
    }
    if (c == '`') {
      in_backtick = true;
      token.push_back(' ');
      continue;
    }
    if (c == '-' && n == '-') {
      in_line_comment = true;
      token.push_back(' ');
      ++i;
      continue;
    }
    if (c == '#') {
      in_line_comment = true;
      token.push_back(' ');
      continue;
    }
    if (c == '/' && n == '*') {
      in_block_comment = true;
      token.push_back(' ');
      ++i;
      continue;
    }

    token.push_back(is_ident(c) ? lower(c) : c);
  }

  auto has = [&](std::string_view needle) { return token.find(needle) != std::string::npos; };

  if (has("->") || has(" over ") || has(" over(") || has(" over (")) return true;
  if (has("multiif(") || has("arraymap(") || has("arrayfilter(") || has("arrayexists(") ||
      has("arrayall(") || has("arraycount(") || has("arrayjoin(") || has("arrayzip(") ||
      has("arrayreduce(") || has("arrayavg(") || has("arraysum(")) return true;
  if (has("jsonextract") || has("dictget(") || has("dictgetordefault(") || has("map(")) return true;
  if (has(" in [") || has("deduplicate by")) return true;
  return false;
}

bool should_preserve_sql_surface(std::string_view sql) {
  return contains_sql_comments(sql) || has_top_level_values_insert(sql) ||
         has_single_quoted_literal_with_whitespace(sql) || has_complex_sql_surface(sql);
}


std::vector<std::string> extract_single_quoted_literals(std::string_view s) {
  std::vector<std::string> out;
  bool in_str = false;
  bool esc = false;
  size_t start = 0;
  for (size_t i = 0; i < s.size(); ++i) {
    const char c = s[i];
    if (!in_str) {
      if (c == '\'') {
        in_str = true;
        esc = false;
        start = i;
      }
      continue;
    }
    if (esc) {
      esc = false;
      continue;
    }
    if (c == '\\') {
      esc = true;
      continue;
    }
    if (c == '\'') {
      out.emplace_back(s.substr(start, i + 1 - start).data(), s.substr(start, i + 1 - start).size());
      in_str = false;
    }
  }
  return out;
}

std::string restore_single_quoted_literals(std::string formatted, std::string_view original) {
  const auto source_literals = extract_single_quoted_literals(original);
  if (source_literals.empty()) return formatted;
  size_t literal_index = 0;
  bool in_str = false;
  bool esc = false;
  size_t start = 0;
  std::string out;
  out.reserve(formatted.size());
  for (size_t i = 0; i < formatted.size(); ++i) {
    const char c = formatted[i];
    if (!in_str) {
      if (c == '\'') {
        out.append(formatted.substr(start, i - start));
        in_str = true;
        esc = false;
        start = i;
      }
      continue;
    }
    if (esc) {
      esc = false;
      continue;
    }
    if (c == '\\') {
      esc = true;
      continue;
    }
    if (c == '\'') {
      if (literal_index < source_literals.size()) out += source_literals[literal_index++];
      else out.append(formatted.substr(start, i + 1 - start));
      start = i + 1;
      in_str = false;
    }
  }
  out.append(formatted.substr(start));
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

  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_down", "Selected host is down.");
  }

  auto format_one = [&](std::string sql_raw, std::string* out_pretty, std::string* err) -> bool {
    std::string sql = trim_sql(std::move(sql_raw));
    if (sql.empty()) {
      if (err) *err = "Missing SQL text.";
      return false;
    }
    if (contains_sql_comments(sql) || has_top_level_values_insert(sql)) {
      if (out_pretty) *out_pretty = postprocess_format_query(sql, 80);
      return true;
    }

    std::string fmt_err;
    const auto formatted = try_format_query(*host, sql, 500 * 1024, &fmt_err);
    if (!formatted.has_value()) {
      if (err) *err = fmt_err.empty() ? "Failed to format query." : fmt_err;
      return false;
    }
    std::string formatted_text = restore_single_quoted_literals(*formatted, sql);
    if (out_pretty) *out_pretty = postprocess_format_query(formatted_text, 80);
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

