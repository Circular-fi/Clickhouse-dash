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
    const bool preserve_original_surface = contains_sql_comments(sql) || has_top_level_values_insert(sql);
    if (preserve_original_surface) {
      if (out_pretty) *out_pretty = postprocess_format_query(sql, 80);
      return true;
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

