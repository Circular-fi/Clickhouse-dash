#pragma once

#include <cstdint>
#include <initializer_list>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace chdash {

enum class LogLevel { Info, Warn, Error };

// One field of a log line: a key and a string, integer, floating-point or boolean value.
class LogField {
public:
  enum class Kind { String, Int, Uint, Double, Bool };

  LogField(std::string_view key, std::string_view value) : key_(key), kind_(Kind::String), text_(value) {}
  LogField(std::string_view key, const char* value) : key_(key), kind_(Kind::String), text_(value ? value : "") {}
  LogField(std::string_view key, const std::string& value) : key_(key), kind_(Kind::String), text_(value) {}
  LogField(std::string_view key, bool value) : key_(key), kind_(Kind::Bool), int_(value ? 1 : 0) {}
  LogField(std::string_view key, double value) : key_(key), kind_(Kind::Double), double_(value) {}
  template <typename T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T, bool>, int> = 0>
  LogField(std::string_view key, T value)
      : key_(key),
        kind_(std::is_signed_v<T> ? Kind::Int : Kind::Uint),
        int_(static_cast<int64_t>(value)),
        uint_(static_cast<uint64_t>(value)) {}

  std::string_view key() const { return key_; }
  Kind kind() const { return kind_; }
  std::string_view text() const { return text_; }
  int64_t int_value() const { return int_; }
  uint64_t uint_value() const { return uint_; }
  double double_value() const { return double_; }

private:
  std::string_view key_;
  Kind kind_;
  std::string_view text_;
  int64_t int_ = 0;
  uint64_t uint_ = 0;
  double double_ = 0.0;
};

// The log of the server (docs/operations.md, "Logs"). It writes one JSON object per line on stderr, for example:
//   {"ts":"2026-10-10T12:00:00.123Z","level":"info","event":"http.request", <fields>}
// Each line is written whole under a lock, so lines of two threads never mix. `event` names what happened
// (area.what). The fields never carry row data, secrets or capabilities (query_id, tokens). The text of an unexpected exception (it may quote SQL) is truncated to 300 bytes.
void log_event(LogLevel level, std::string_view event, std::initializer_list<LogField> fields = {});

// The same, with the fields in a vector (a line whose fields are not known when the code is written).
void log_event(LogLevel level, std::string_view event, const std::vector<LogField>& fields);

// The same line, as text (for the tests).
std::string format_log_line(LogLevel level, std::string_view event, std::initializer_list<LogField> fields, int64_t unix_ms);

} // namespace chdash
