#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "format_clickhouse.hpp"
#include "format_postprocess.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "sql_scan.hpp"
#include "sql_util.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace chdash {

namespace {

constexpr size_t kMaxFormatSqlBytes = 500 * 1024;
constexpr rapidjson::SizeType kMaxBatchItems = 1024;

bool has_top_level_values_insert(std::string_view sql) {
  const auto masked = mask_sql_surface(sql);
  const std::string_view s(masked.code_lower);

  auto match_keyword = [&](size_t pos, std::string_view keyword) {
    if (pos + keyword.size() > s.size() || s.substr(pos, keyword.size()) != keyword) return false;
    const char prev = (pos == 0) ? '\0' : s[pos - 1];
    const char next = (pos + keyword.size() < s.size()) ? s[pos + keyword.size()] : '\0';
    return !sql_is_ident_continue(prev) && !sql_is_ident_continue(next);
  };

  int parentheses = 0;
  int brackets = 0;
  int braces = 0;
  bool seen_insert = false;

  for (size_t i = 0; i < s.size(); ++i) {
    switch (s[i]) {
      case '(': ++parentheses; break;
      case ')': if (parentheses > 0) --parentheses; break;
      case '[': ++brackets; break;
      case ']': if (brackets > 0) --brackets; break;
      case '{': ++braces; break;
      case '}': if (braces > 0) --braces; break;
      default: break;
    }

    if (parentheses != 0 || brackets != 0 || braces != 0 || !sql_is_ident_start(s[i])) continue;

    if (!seen_insert && match_keyword(i, "insert")) {
      seen_insert = true;
      i += 5;
    } else if (seen_insert && match_keyword(i, "values")) {
      return true;
    } else if (seen_insert && (match_keyword(i, "select") || match_keyword(i, "format"))) {
      return false;
    }
  }

  return false;
}

int requested_line_width(const rapidjson::Document& doc) {
  int width = 80;
  if (doc.HasMember("line_width") && doc["line_width"].IsInt()) width = doc["line_width"].GetInt();
  return std::max(40, std::min(200, width));
}

uint64_t fnv1a64(std::string_view value, uint64_t seed) {
  uint64_t hash = seed;
  for (const unsigned char ch : value) {
    hash ^= ch;
    hash *= UINT64_C(1099511628211);
  }
  return hash;
}

std::string format_cache_key(
    std::string_view host_id,
    int line_width,
    std::string_view sql
) {
  const uint64_t hash_a = fnv1a64(sql, UINT64_C(14695981039346656037));
  const uint64_t hash_b = fnv1a64(sql, UINT64_C(7809847782465536322));
  std::string key;
  key.reserve(host_id.size() + 72);
  key.append(host_id.data(), host_id.size());
  key.push_back('\x1f');
  key += std::to_string(line_width);
  key.push_back('\x1f');
  key += std::to_string(sql.size());
  key.push_back(':');
  key += std::to_string(hash_a);
  key.push_back(':');
  key += std::to_string(hash_b);
  return key;
}

void set_format_cache_header(httplib::Response& res, size_t hits, size_t misses) {
  const char* value = "miss";
  if (hits > 0 && misses == 0) value = "hit";
  else if (hits > 0) value = "partial";
  res.set_header("X-Chdash-Format-Cache", value);
}

std::string quote_reserved_aliases_for_format_query(std::string_view sql) {
  static const std::unordered_set<std::string> reserved_aliases = {
      "all", "alter", "and", "array", "as", "asc", "by", "case",
      "cross", "desc", "distinct", "else", "end", "except", "exists",
      "final", "format", "from", "full", "global", "group", "having",
      "inner", "intersect", "into", "join", "left", "limit", "not",
      "null", "offset", "on", "or", "order", "outer", "prewhere",
      "qualify", "right", "sample", "select", "semi", "settings",
      "then", "union", "using", "when", "where", "window", "with"};

  const auto masked = mask_sql_surface(sql);
  const std::string_view code(masked.code_lower);
  struct Range { size_t begin; size_t end; };
  std::vector<Range> ranges;

  for (size_t i = 0; i + 2 <= code.size(); ++i) {
    if (code.substr(i, 2) != "as") continue;
    const char previous = i == 0 ? '\0' : code[i - 1];
    const char next = i + 2 < code.size() ? code[i + 2] : '\0';
    if (sql_is_ident_continue(previous) || sql_is_ident_continue(next)) continue;

    size_t begin = i + 2;
    while (begin < code.size() && std::isspace(static_cast<unsigned char>(code[begin]))) ++begin;
    if (begin >= code.size() || !sql_is_ident_start(code[begin])) continue;
    size_t end = begin + 1;
    while (end < code.size() && sql_is_ident_continue(code[end])) ++end;
    const std::string candidate(code.substr(begin, end - begin));
    if (reserved_aliases.find(candidate) == reserved_aliases.end()) continue;
    ranges.push_back({begin, end});
    i = end - 1;
  }

  if (ranges.empty()) return std::string(sql);
  std::string out;
  out.reserve(sql.size() + ranges.size() * 2);
  size_t cursor = 0;
  for (const auto& range : ranges) {
    out.append(sql.substr(cursor, range.begin - cursor));
    out.push_back('`');
    out.append(sql.substr(range.begin, range.end - range.begin));
    out.push_back('`');
    cursor = range.end;
  }
  out.append(sql.substr(cursor));
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

  const int line_width = requested_line_width(doc);
  size_t cache_hits = 0;
  size_t cache_misses = 0;
  size_t request_deduplicated = 0;

  std::shared_ptr<clickhouse::Client> format_client;
  std::string format_client_error;
  bool format_client_attempted = false;
  auto get_format_client = [&]() -> std::shared_ptr<clickhouse::Client> {
    if (format_client) return format_client;
    if (format_client_attempted) return {};
    format_client_attempted = true;
    if (!is_host_healthy(health_.get(), host_id)) {
      format_client_error = "Selected host is down.";
      return {};
    }
    format_client = client_pool_ ? client_pool_->acquire(
      host->runner_uri,
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      &format_client_error
    ) : make_client_from_uri(
      host->runner_uri,
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      &format_client_error
    );
    return format_client;
  };

  // A batch can contain duplicate editor buffers. Avoid repeated cache lookups,
  // ClickHouse calls and post-processing within the same request.
  using FormatValue = FormatCache::ValuePtr;
  std::unordered_map<std::string, FormatValue> request_results;

  auto format_one = [&](std::string sql_raw, FormatValue* out_pretty, std::string* err) -> bool {
    std::string sql = trim_sql(std::move(sql_raw));
    if (sql.empty()) {
      if (err) *err = "Missing SQL text.";
      return false;
    }
    if (sql.size() > kMaxFormatSqlBytes) {
      if (err) *err = "SQL text is too large to format.";
      return false;
    }

    const std::string key = format_cache_key(host_id, line_width, sql);
    if (auto local = request_results.find(key); local != request_results.end()) {
      ++request_deduplicated;
      if (out_pretty) *out_pretty = local->second;
      return true;
    }
    if (format_cache_) {
      if (auto cached = format_cache_->get(key)) {
        ++cache_hits;
        request_results.emplace(key, cached);
        if (out_pretty) *out_pretty = std::move(cached);
        return true;
      }
    }
    ++cache_misses;

    std::string pretty;
    const auto masked = mask_sql_surface(sql);
    if (masked.has_comments || has_top_level_values_insert(sql)) {
      // ClickHouse formatQuery removes or restructures these surfaces. The local
      // post-processor preserves comments and VALUES payloads byte-for-byte.
      pretty = postprocess_format_query(sql, line_width);
    } else {
      auto client = get_format_client();
      if (!client) {
        if (err) {
          *err = format_client_error.empty()
            ? "Failed to connect to ClickHouse for formatQuery."
            : format_client_error;
        }
        return false;
      }

      std::string fmt_err;
      const std::string parseable_sql = quote_reserved_aliases_for_format_query(sql);
      const auto formatted = try_format_query_with_client(*client, parseable_sql, kMaxFormatSqlBytes, &fmt_err);
      if (!formatted.has_value()) {
        if (err) *err = fmt_err.empty() ? "Failed to format query." : fmt_err;
        return false;
      }

      // formatQuery may normalize literal escaping. Restore the user's exact
      // literal spelling, including doubled SQL quotes, before line wrapping.
      pretty = postprocess_format_query(
          restore_sql_single_quoted_literals(*formatted, sql),
          line_width);
    }

    // formatQuery and the local post-processor intentionally normalize many
    // identifiers to backticks. Keep formatting deterministic while restoring
    // the exact spelling of identifiers that the user explicitly quoted, as
    // well as the original spelling of string literals.
    pretty = restore_sql_quoted_identifiers(std::move(pretty), sql);
    pretty = restore_sql_single_quoted_literals(std::move(pretty), sql);

    auto value = std::make_shared<const std::string>(std::move(pretty));
    request_results.emplace(key, value);
    if (format_cache_) format_cache_->put(key, value);
    if (out_pretty) *out_pretty = std::move(value);
    return true;
  };

  auto write_cache_meta = [&](rapidjson::Writer<rapidjson::StringBuffer>& w) {
    w.Key("cache");
    w.StartObject();
    w.Key("hits"); w.Uint64(cache_hits);
    w.Key("misses"); w.Uint64(cache_misses);
    w.Key("deduplicated"); w.Uint64(request_deduplicated);
    w.EndObject();
    w.Key("line_width"); w.Int(line_width);
  };

  if (doc.HasMember("sqls") && doc["sqls"].IsArray()) {
    const auto& arr = doc["sqls"];
    if (arr.Size() > kMaxBatchItems) {
      return json_error(res, 413, "too_many_sqls", "Too many SQL statements in one format request.");
    }
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      if (!arr[i].IsString()) {
        return json_error(res, 400, "invalid_sqls", "sqls must be an array of strings.");
      }
    }

    std::vector<FormatValue> formatted_sqls;
    formatted_sqls.reserve(arr.Size());
    for (rapidjson::SizeType i = 0; i < arr.Size(); ++i) {
      FormatValue pretty;
      std::string err;
      if (!format_one(std::string(arr[i].GetString(), arr[i].GetStringLength()), &pretty, &err)) {
        const std::string sql_trimmed = trim_sql(arr[i].GetString());
        const auto loc = parse_clickhouse_error_location(err, sql_trimmed);
        const ClickHouseErrorLocation* locp =
          (loc.has_code || loc.has_position || loc.has_line_col || loc.has_near) ? &loc : nullptr;
        const int idx = static_cast<int>(i);
        return json_error_with_payload(res, 422, "format_failed", err, locp, nullptr, &idx);
      }
      formatted_sqls.push_back(std::move(pretty));
    }

    rapidjson::StringBuffer sb(nullptr, 4096);
    rapidjson::Writer<rapidjson::StringBuffer> w(sb);
    w.StartObject();
    w.Key("formatted_sqls");
    w.StartArray();
    for (const auto& pretty : formatted_sqls) {
      w.String(pretty->data(), static_cast<rapidjson::SizeType>(pretty->size()));
    }
    w.EndArray();
    write_cache_meta(w);
    w.EndObject();

    set_format_cache_header(res, cache_hits + request_deduplicated, cache_misses);
    res.status = 200;
    res.set_content(sb.GetString(), sb.GetSize(), "application/json");
    return;
  }

  if (!doc.HasMember("sql") || !doc["sql"].IsString()) {
    return json_error(res, 400, "missing_sql", "Missing SQL text.");
  }

  FormatValue pretty;
  std::string err;
  if (!format_one(std::string(doc["sql"].GetString(), doc["sql"].GetStringLength()), &pretty, &err)) {
    const std::string sql_trimmed = trim_sql(doc["sql"].GetString());
    const auto loc = parse_clickhouse_error_location(err, sql_trimmed);
    const ClickHouseErrorLocation* locp =
      (loc.has_code || loc.has_position || loc.has_line_col || loc.has_near) ? &loc : nullptr;
    return json_error_with_payload(res, 422, "format_failed", err, locp, nullptr, nullptr);
  }

  rapidjson::StringBuffer sb(nullptr, std::max<size_t>(1024, pretty->size() + 128));
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("formatted_sql");
  w.String(pretty->data(), static_cast<rapidjson::SizeType>(pretty->size()));
  write_cache_meta(w);
  w.EndObject();

  set_format_cache_header(res, cache_hits + request_deduplicated, cache_misses);
  res.status = 200;
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

} // namespace chdash
