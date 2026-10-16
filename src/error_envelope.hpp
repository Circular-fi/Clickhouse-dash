#pragma once

// The one error answer of the API, as data, and its JSON. This file does not use HTTP.
// The routes (api_error.hpp), the query library and MCP write their errors with this file. The native tests read it.

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

// The data of a ClickHouse "Not enough privileges" message: the user and the missing grant.
struct AccessDenied {
  std::string user;
  std::string grant;  // for example "SELECT ON system.parts"; empty when the text has none
};
std::optional<AccessDenied> parse_access_denied(std::string_view message);

// ---- The one error answer of the API ----
//
// Every error of ChDash that a client reads is this JSON object. This applies to every route.
// It also applies to every transport of the error: the body of a response, or an `error` event of a stream.
//
//   {"error_code": "logs_timeout", "message": "...", "retryable": true, ...}
//
// `error_code` says what happened. It is a word of the route, such as trace_not_found or logs_timeout.
// `message` describes the error to a person.
// `retryable` says whether the same request may work later. It is true when the server stops or is busy, when a host is down, or when a time limit expires.
// The other members appear when the case needs them. `field` and `reason` describe a refused value. `user`, `grant` and `hint` describe a missing grant.
// `query_id` and `index` describe a run. `clickhouse` (code, position, line, col, near) describes an error in the SQL.
// docs/operations.md, "Errors", lists the statuses.
struct ApiError {
  int status = 500;
  std::string code;
  std::string message;
  // Advises whether to retry. When unset, the status decides. Statuses 429, 503 and 504 are retryable.
  std::optional<bool> retryable;
  std::vector<std::pair<std::string, std::string>> text;     // more members, as text: field, reason, ...
  std::vector<std::pair<std::string, int64_t>> numbers;      // more members, as numbers: revision, folders, ...
  std::optional<std::string> query_id;
  std::optional<int> index;
  std::optional<ClickHouseErrorLocation> clickhouse;
};

// True for a status after which the same request may work: 429, 503, 504.
bool status_is_retryable(int status);

// Builds the JSON of the error. If `message` holds a ClickHouse "Not enough privileges" text, the JSON also has reason "not_granted", user, grant and hint.
std::string error_json(const ApiError& error);

} // namespace chdash
