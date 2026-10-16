#pragma once

#include "error_envelope.hpp"

#include <httplib.h>

#include <cstdint>
#include <exception>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

ClickHouseErrorLocation parse_clickhouse_error_location(std::string_view msg, std::string_view original_sql = {});

// The answer has the status, the JSON and no-store. An error is never kept by a cache.
void send_error(httplib::Response& res, const ApiError& error);

// {"error_code", "message", "retryable"} with a status and a code.
void json_error(httplib::Response& res, int status, std::string_view code, std::string_view message);

// An error for a missing grant. It is written in the same form as a ClickHouse error. It has reason "not_granted", user, grant and hint.
// `what` says what could not be done (for example: "Logs table otel.otel_logs is not readable").
void json_not_granted(httplib::Response& res, int status, std::string_view code, std::string_view user, std::string_view grant,
                      std::string_view what);

// The answer for a failure of a ClickHouse statement depends on the failure class (ch_error.hpp). It is the same on every route:
//   timeout              504 <area>_timeout      retryable
//   too many rows/bytes  422 <area>_scan_limit
//   memory limit         422 <area>_memory_limit
//   access denied        403 <area>_not_granted  with reason, user, grant, hint
//   canceled             499 canceled
//   connection failed    503 host_unavailable    retryable
//   anything else        503 `failed_code`       (500 when the failure is not one of ClickHouse)
// `area` is the word of the page. It appears in the codes and in the advice ("logs", "trace", "metrics").
ApiError error_from_clickhouse(const std::exception& error, std::string_view area, std::string_view failed_code);

// An error in the text of a statement that ClickHouse refused. This is the SQL error of a run or a format.
// It gives the place of the mistake when ClickHouse gave one.
void json_error_with_payload(
    httplib::Response& res,
    int status,
    std::string_view code,
    std::string_view message,
    const ClickHouseErrorLocation* loc,
    const std::string* query_id,
    const int* index
);

// The JSON of such an error, for a stream event.
std::string build_error_payload_json(
    std::string_view code,
    std::string_view message,
    const ClickHouseErrorLocation* loc,
    const std::string* query_id,
    const int* index
);

} // namespace chdash
