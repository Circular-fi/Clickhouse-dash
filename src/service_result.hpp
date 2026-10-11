#pragma once

// What a read of a service returns: a value, or the error that the route sends (error_envelope.hpp). A failure of a ClickHouse statement is
// not in here: it is thrown, and the service turns it into the error of its route (error_from_clickhouse). The Traces, Metrics and
// Explorer services all answer with it.

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

// A missing grant, written as ClickHouse writes it: `what` says what could not be done, then the user and the grant that is missing
// (error_json adds reason "not_granted", user, grant and hint from this message).
inline ApiError not_granted_error(int status, std::string code, const std::string& user, const std::string& grant, const std::string& what) {
  return make_error(status, std::move(code),
                    what + ": DB::Exception: " + user + ": Not enough privileges. To execute this query, it's necessary to have the grant " + grant);
}

}  // namespace chdash
