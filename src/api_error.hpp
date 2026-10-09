#pragma once

#include <httplib.h>

#include <optional>
#include <string>
#include <string_view>

namespace chdash {

struct ClickHouseErrorLocation {
  bool has_code = false;
  int code = 0;

  bool has_position = false;
  int position = 0;

  bool has_line_col = false;
  int line = 0;
  int col = 0;

  bool has_near = false;
  std::string near;
};

// What a ClickHouse "Not enough privileges" message says: the user and the grant that is missing.
struct AccessDenied {
  std::string user;
  std::string grant;  // for example "SELECT ON system.parts"; empty when the text has none
};
std::optional<AccessDenied> parse_access_denied(std::string_view message);

// {"error_code", "message"}; when the message is a ClickHouse "Not enough privileges", also "reason":
// "not_granted", "user", "grant" and "hint" (the GRANT statement).
void json_error(httplib::Response& res, int status, std::string_view code, std::string_view message);

// An error that is a missing grant, written as the ClickHouse one is: reason "not_granted", user, grant, hint.
// `what` says what could not be done ("Logs table otel.otel_logs is not readable").
void json_not_granted(httplib::Response& res, int status, std::string_view code, std::string_view user, std::string_view grant,
                      std::string_view what);

ClickHouseErrorLocation parse_clickhouse_error_location(std::string_view msg, std::string_view original_sql = {});

std::string build_error_payload_json(
    std::string_view code,
    std::string_view message,
    const ClickHouseErrorLocation* loc,
    const std::string* query_id,
    const int* index
);

void json_error_with_payload(
    httplib::Response& res,
    int status,
    std::string_view code,
    std::string_view message,
    const ClickHouseErrorLocation* loc,
    const std::string* query_id,
    const int* index
);

std::optional<std::string> maybe_rewrite_error_sse_chunk(std::string_view chunk, std::string_view original_sql);

} // namespace chdash
