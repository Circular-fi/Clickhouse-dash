#include "telemetry_settings.hpp"

#include <algorithm>

namespace chdash {

std::optional<int64_t> parse_duration_ms(std::string_view text) {
  size_t digits = 0;
  while (digits < text.size() && text[digits] >= '0' && text[digits] <= '9') ++digits;
  if (digits == 0 || digits > 12) return std::nullopt;
  int64_t value = 0;
  for (size_t i = 0; i < digits; ++i) value = value * 10 + (text[i] - '0');
  const std::string_view unit = text.substr(digits);
  if (unit == "ms") return value;
  if (unit == "s") return value * 1000;
  if (unit == "m") return value * 60 * 1000;
  if (unit == "h") return value * 3600 * 1000;
  return std::nullopt;
}

std::string duration_text(int64_t ms) {
  if (ms != 0 && ms % (3600 * 1000) == 0) return std::to_string(ms / (3600 * 1000)) + "h";
  if (ms != 0 && ms % (60 * 1000) == 0) return std::to_string(ms / (60 * 1000)) + "m";
  if (ms != 0 && ms % 1000 == 0) return std::to_string(ms / 1000) + "s";
  return std::to_string(ms) + "ms";
}

std::optional<OtlpEndpoint> otlp_parse_endpoint(std::string_view text, std::string* error) {
  const auto fail = [&](const std::string& why) -> std::optional<OtlpEndpoint> {
    if (error) *error = why;
    return std::nullopt;
  };
  if (text.rfind("https://", 0) == 0) {
    return fail("https is not available: ChDash has no TLS client. Send to a collector over http (a sidecar or a local agent)");
  }
  if (text.rfind("http://", 0) != 0) return fail("must start with http://");
  std::string_view rest = text.substr(7);
  for (const char c : rest) {
    if (static_cast<unsigned char>(c) <= 0x20 || c == 0x7f) return fail("must not hold a space or a control character");
  }
  if (rest.find_first_of("?#") != std::string_view::npos) return fail("must not have a query or a fragment");
  const size_t slash = rest.find('/');
  const std::string_view authority = rest.substr(0, slash);
  std::string_view path = slash == std::string_view::npos ? std::string_view() : rest.substr(slash);
  if (authority.find('@') != std::string_view::npos) return fail("must not hold a user or a password");
  if (authority.empty()) return fail("has no host");
  OtlpEndpoint out;
  std::string_view host = authority;
  std::string_view port;
  if (authority.front() == '[') {
    const size_t close = authority.find(']');
    if (close == std::string_view::npos) return fail("has a [ without ]");
    host = authority.substr(1, close - 1);
    const std::string_view after = authority.substr(close + 1);
    if (!after.empty()) {
      if (after.front() != ':') return fail("has text after ]");
      port = after.substr(1);
    }
  } else if (const size_t colon = authority.rfind(':'); colon != std::string_view::npos) {
    host = authority.substr(0, colon);
    port = authority.substr(colon + 1);
  }
  if (host.empty()) return fail("has no host");
  if (authority.front() == '[' || authority.find(':') != std::string_view::npos) {
    if (port.empty() || port.size() > 5 || !std::all_of(port.begin(), port.end(), [](char c) { return c >= '0' && c <= '9'; })) {
      return fail("has a port that is not a number from 1 to 65535");
    }
    const int value = std::stoi(std::string(port));
    if (value < 1 || value > 65535) return fail("has a port that is not a number from 1 to 65535");
    out.port = value;
  }
  out.host = std::string(host);
  while (!path.empty() && path.back() == '/') path.remove_suffix(1);
  out.base_path = std::string(path);
  return out;
}

} // namespace chdash
