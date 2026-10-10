#pragma once

// What a read of the Traces page returns: a value, or the error that the route sends (error_envelope.hpp). A failure of a
// ClickHouse statement is not in here: it is thrown, and the service turns it into the error of its route (error_from_clickhouse).

#include "error_envelope.hpp"

#include <optional>
#include <string>
#include <utility>

namespace chdash {
namespace trace {

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

}  // namespace trace
}  // namespace chdash
