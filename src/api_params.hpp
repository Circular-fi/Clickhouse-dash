#pragma once

// This file gives the query parameters of a route. It reads each number as a whole text value.
//
// A route that takes a short, fixed list of parameters refuses any other name. A typo is then an error, not a silent default.
// A number is the whole text of the value: "123abc", " 12" and "1e400" are not numbers.

#include "api_error.hpp"

#include <httplib.h>

#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>

namespace chdash {

// This gives the 400 `unknown_parameter` error. The request holds a parameter that is not in `allowed`.
inline std::optional<ApiError> unknown_param_error(const httplib::Request& req, std::initializer_list<const char*> allowed) {
  for (const auto& item : req.params) {
    bool known = false;
    for (const char* name : allowed) known = known || item.first == name;
    if (known) continue;
    ApiError error;
    error.status = 400;
    error.code = "unknown_parameter";
    error.message = "Unknown parameter: " + item.first + ".";
    return error;
  }
  return std::nullopt;
}

// This is true after it writes the 400 `unknown_parameter` answer. The request holds a parameter that is not in `allowed`.
inline bool refuse_unknown_params(const httplib::Request& req, httplib::Response& res, std::initializer_list<const char*> allowed) {
  const auto error = unknown_param_error(req, allowed);
  if (!error) return false;
  json_error(res, error->status, error->code, error->message);
  return true;
}

// This is a decimal integer with an optional sign. It has no other characters, and it fits in 64 bits.
inline std::optional<int64_t> parse_whole_i64(std::string_view text) {
  if (text.empty() || text.size() > 20) return std::nullopt;
  size_t i = text[0] == '-' || text[0] == '+' ? 1 : 0;
  if (i == text.size()) return std::nullopt;
  for (size_t k = i; k < text.size(); ++k) {
    if (text[k] < '0' || text[k] > '9') return std::nullopt;
  }
  errno = 0;
  const std::string owned(text);
  char* end = nullptr;
  const long long value = std::strtoll(owned.c_str(), &end, 10);
  if (errno == ERANGE || end != owned.c_str() + owned.size()) return std::nullopt;
  return static_cast<int64_t>(value);
}

// This is a finite number. It can have a decimal point or an exponent, and it has no other characters.
inline std::optional<double> parse_whole_double(std::string_view text) {
  if (text.empty() || text.size() > 64) return std::nullopt;
  const unsigned char first = static_cast<unsigned char>(text[0]);
  if (!(first == '-' || first == '+' || first == '.' || (first >= '0' && first <= '9'))) return std::nullopt;  // no " 1"
  for (const char c : text) {
    if (!((c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.' || c == 'e' || c == 'E')) return std::nullopt;  // no "inf", "0x1"
  }
  errno = 0;
  const std::string owned(text);
  char* end = nullptr;
  const double value = std::strtod(owned.c_str(), &end);
  if (end != owned.c_str() + owned.size() || !std::isfinite(value)) return std::nullopt;
  return value;
}

} // namespace chdash
