#include "error_envelope.hpp"

#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

std::optional<AccessDenied> parse_access_denied(std::string_view message) {
  constexpr std::string_view kDenied = "Not enough privileges";
  const size_t denied = message.find(kDenied);
  if (denied == std::string_view::npos) return std::nullopt;
  AccessDenied out;
  // "DB::Exception: <user>: Not enough privileges. To execute this query, it's necessary to have the grant <grant>"
  constexpr std::string_view kPrefix = "DB::Exception: ";
  const size_t prefix = message.substr(0, denied).rfind(kPrefix);
  if (prefix != std::string_view::npos) {
    std::string_view user = message.substr(prefix + kPrefix.size(), denied - (prefix + kPrefix.size()));
    while (!user.empty() && (user.back() == ':' || user.back() == ' ')) user.remove_suffix(1);
    out.user = std::string(user);
  }
  constexpr std::string_view kGrant = "have the grant ";
  const size_t grant = message.find(kGrant, denied);
  if (grant != std::string_view::npos) {
    std::string_view text = message.substr(grant + kGrant.size());
    // The grant ends at ". (ACCESS_DENIED)", a ", or" alternative, or the end of the text.
    for (const std::string_view stop : {std::string_view(". ("), std::string_view(", or "), std::string_view(" (ACCESS_DENIED")}) {
      if (const size_t at = text.find(stop); at != std::string_view::npos) text = text.substr(0, at);
    }
    while (!text.empty() && (text.back() == '.' || text.back() == ' ' || text.back() == '\n')) text.remove_suffix(1);
    out.grant = std::string(text);
  }
  return out;
}

namespace {

// A ClickHouse "Not enough privileges" says so in a field of its own, with the grant that is missing and
// the statement that gives it, so that every route names the same cause the same way.
void write_access_denied(rapidjson::Writer<rapidjson::StringBuffer>& w, std::string_view message) {
  const auto denied = parse_access_denied(message);
  if (!denied) return;
  w.Key("reason");
  w.String("not_granted");
  if (!denied->user.empty()) {
    w.Key("user");
    write_json_text(w, denied->user);
  }
  if (!denied->grant.empty()) {
    w.Key("grant");
    write_json_text(w, denied->grant);
    const std::string hint = "GRANT " + denied->grant + (denied->user.empty() ? std::string() : " TO " + denied->user) + ";";
    w.Key("hint");
    write_json_text(w, hint);
  }
}

} // namespace

bool status_is_retryable(int status) { return status == 429 || status == 503 || status == 504; }

std::string error_json(const ApiError& error) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  if (error.query_id && !error.query_id->empty()) {
    w.Key("query_id");
    write_json_text(w, *error.query_id);
  }
  w.Key("error_code");
  write_json_text(w, error.code);
  w.Key("message");
  write_json_text(w, error.message);
  w.Key("retryable");
  w.Bool(error.retryable.value_or(status_is_retryable(error.status)));
  for (const auto& [key, value] : error.text) {
    write_json_key(w, key);
    write_json_text(w, value);
  }
  for (const auto& [key, value] : error.numbers) {
    write_json_key(w, key);
    w.Int64(value);
  }
  write_access_denied(w, error.message);
  if (error.index) {
    w.Key("index");
    w.Int(*error.index);
  }
  if (error.clickhouse) {
    const ClickHouseErrorLocation& loc = *error.clickhouse;
    w.Key("clickhouse");
    w.StartObject();
    if (loc.has_code) {
      w.Key("code");
      w.Int(loc.code);
    }
    if (loc.has_position) {
      w.Key("position");
      w.Int(loc.position);
    }
    if (loc.has_line_col) {
      w.Key("line");
      w.Int(loc.line);
      w.Key("col");
      w.Int(loc.col);
    }
    if (loc.has_near) {
      w.Key("near");
      write_json_text(w, loc.near);
    }
    w.EndObject();
  }
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

} // namespace chdash
