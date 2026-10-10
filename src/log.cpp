#include "log.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <iostream>
#include <mutex>


namespace chdash {

namespace {

const char* level_name(LogLevel level) {
  switch (level) {
    case LogLevel::Info: return "info";
    case LogLevel::Warn: return "warn";
    case LogLevel::Error: return "error";
  }
  return "info";
}

// 2026-10-10T12:00:00.123Z
std::string iso_utc_ms(int64_t unix_ms) {
  const time_t seconds = static_cast<time_t>(unix_ms / 1000);
  std::tm tm_utc{};
  gmtime_r(&seconds, &tm_utc);
  char text[32];
  std::snprintf(text, sizeof(text), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm_utc.tm_year + 1900, tm_utc.tm_mon + 1,
                tm_utc.tm_mday, tm_utc.tm_hour, tm_utc.tm_min, tm_utc.tm_sec, static_cast<int>(unix_ms % 1000));
  return text;
}

void put(rapidjson::Writer<rapidjson::StringBuffer>& w, std::string_view text) {
  w.String(text.data(), static_cast<rapidjson::SizeType>(text.size()));
}

} // namespace

std::string format_log_line(LogLevel level, std::string_view event, std::initializer_list<LogField> fields, int64_t unix_ms) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("ts"); put(w, iso_utc_ms(unix_ms));
  w.Key("level"); w.String(level_name(level));
  w.Key("event"); put(w, event);
  for (const auto& field : fields) {
    w.Key(field.key().data(), static_cast<rapidjson::SizeType>(field.key().size()));
    switch (field.kind()) {
      case LogField::Kind::String: put(w, field.text()); break;
      case LogField::Kind::Int: w.Int64(field.int_value()); break;
      case LogField::Kind::Uint: w.Uint64(field.uint_value()); break;
      case LogField::Kind::Bool: w.Bool(field.int_value() != 0); break;
      case LogField::Kind::Double:
        // JSON has no NaN nor infinity.
        if (std::isfinite(field.double_value())) w.Double(field.double_value());
        else w.Null();
        break;
    }
  }
  w.EndObject();
  std::string line(sb.GetString(), sb.GetSize());
  line.push_back('\n');
  return line;
}

void log_event(LogLevel level, std::string_view event, std::initializer_list<LogField> fields) {
  try {
    const int64_t now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    const std::string line = format_log_line(level, event, fields, now_ms);
    static std::mutex mu;
    std::lock_guard<std::mutex> lock(mu);
    // One write of the whole line (std::cerr is unbuffered and goes to stderr through stdio in one call).
    std::cerr.write(line.data(), static_cast<std::streamsize>(line.size()));
    std::cerr.flush();
  } catch (...) {
    // A log line never fails the work that it describes.
  }
}

} // namespace chdash
