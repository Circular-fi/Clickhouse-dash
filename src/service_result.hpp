#pragma once

// The result of a read of a service. It holds a value, or the error that the route sends (error_envelope.hpp).
// A failure of a ClickHouse statement is not in this result.
// The statement throws that failure. The service changes it to the error of its route (error_from_clickhouse).
// The Traces, Metrics and Explorer services all return this result.

#include "error_envelope.hpp"

#include <optional>
#include <string>
#include <utility>

namespace chdash {

template <typename T>
struct Result {
  std::optional<T> value;
  ApiError error;

  explicit operator bool() const { return value.has_value(); }
  static Result ok(T v) {
    Result r;
    r.value = std::move(v);
    return r;
  }
  static Result fail(ApiError e) {
    Result r;
    r.error = std::move(e);
    return r;
  }
};

inline ApiError make_error(int status, std::string code, std::string message) {
  ApiError error;
  error.status = status;
  error.code = std::move(code);
  error.message = std::move(message);
  return error;
}

// A missing grant, written as ClickHouse writes it.
// The text `what` says what could not be done.
// Then the message names the user and the missing grant.
// error_json adds reason "not_granted", user, grant and hint from this message.
inline ApiError not_granted_error(int status, std::string code, const std::string& user, const std::string& grant, const std::string& what) {
  return make_error(status, std::move(code),
                    what + ": DB::Exception: " + user + ": Not enough privileges. To execute this query, it's necessary to have the grant " + grant);
}

}  // namespace chdash
