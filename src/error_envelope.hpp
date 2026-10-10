#pragma once

// The one error answer of the API as data, and its JSON. No HTTP in this file: the routes (api_error.hpp), the query library
// and MCP all write their errors through it, and the native tests read it.

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

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

// ---- The one error answer of the API ----
//
// Every error of ChDash that a client reads is this JSON object, whatever the route and whatever the way it is sent (the body of
// a response, an `error` event of a stream):
//
//   {"error_code": "logs_timeout", "message": "...", "retryable": true, ...}
//
// `error_code` says what happened (a word of the route: trace_not_found, logs_timeout), `message` says it to a person,
// `retryable` says whether the same request may work later (the server is stopping or busy, a host is down, a time ran
// out). The other members are the ones that the case needs: `field` and `reason` of a refused value, `user`, `grant` and
// `hint` of a missing grant, `query_id` and `index` of a run, `clickhouse` (code, position, line, col, near) of an error in the SQL.
// docs/operations.md, "Errors", lists the statuses.
struct ApiError {
  int status = 500;
  std::string code;
  std::string message;
  // The advice to retry. Unset: it follows the status (429, 503 and 504 are retryable).
  std::optional<bool> retryable;
  std::vector<std::pair<std::string, std::string>> text;     // more members, as text: field, reason, ...
  std::vector<std::pair<std::string, int64_t>> numbers;      // more members, as numbers: revision, folders, ...
  std::optional<std::string> query_id;
  std::optional<int> index;
  std::optional<ClickHouseErrorLocation> clickhouse;
};

// True for a status after which the same request may work: 429, 503, 504.
bool status_is_retryable(int status);

// The JSON of the error; a ClickHouse "Not enough privileges" in `message` adds reason "not_granted", user, grant and hint.
std::string error_json(const ApiError& error);

} // namespace chdash
