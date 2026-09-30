// ServiceName visibility shared by every OpenTelemetry signal (traces, logs,
// metrics): traces.service_allowlist is the single allowlist, and each query
// on a signal table ANDs service_allowlist_predicate() into its WHERE clause.
//
// Patterns: "*" (everything), "name" (exact), "prefix*", "*suffix", or any
// other mix of literal text and "*" (an anchored regular expression).
#pragma once

#include "server.hpp"

#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace otel {

inline std::string allowlist_quote_string(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('\'');
  for (char ch : value) {
    if (ch == '\\') out += "\\\\";
    else if (ch == '\'') out += "\\'";
    else out.push_back(ch);
  }
  out.push_back('\'');
  return out;
}

inline std::string allowlist_regex_escape(std::string_view value) {
  std::string out;
  out.reserve(value.size() * 2);
  for (char ch : value) {
    switch (ch) {
      case '.': case '^': case '$': case '|': case '(': case ')':
      case '[': case ']': case '{': case '}': case '+': case '?': case '\\':
        out.push_back('\\');
        break;
      default:
        break;
    }
    out.push_back(ch);
  }
  return out;
}

inline std::string service_pattern_predicate(std::string_view pattern) {
  if (pattern == "*") return "1";
  const size_t first = pattern.find('*');
  if (first == std::string_view::npos) {
    return "ServiceName = " + allowlist_quote_string(pattern);
  }
  if (first == pattern.size() - 1 && pattern.find('*', first + 1) == std::string_view::npos) {
    return "startsWith(ServiceName, " + allowlist_quote_string(pattern.substr(0, pattern.size() - 1)) + ")";
  }
  if (first == 0 && pattern.find('*', 1) == std::string_view::npos) {
    return "endsWith(ServiceName, " + allowlist_quote_string(pattern.substr(1)) + ")";
  }

  std::string regex = "^";
  size_t start = 0;
  while (start <= pattern.size()) {
    const size_t star = pattern.find('*', start);
    const size_t end = star == std::string_view::npos ? pattern.size() : star;
    regex += allowlist_regex_escape(pattern.substr(start, end - start));
    if (star == std::string_view::npos) break;
    regex += ".*";
    start = star + 1;
  }
  regex += "$";
  return "match(ServiceName, " + allowlist_quote_string(regex) + ")";
}

// "1" when a pattern is "*", "0" for an empty list, else an OR of patterns.
inline std::string service_allowlist_predicate(const std::vector<std::string>& allowlist) {
  if (allowlist.empty()) return "0";
  for (const auto& pattern : allowlist) {
    if (pattern == "*") return "1";
  }
  std::string out = "(";
  bool first = true;
  for (const auto& pattern : allowlist) {
    if (!first) out += " OR ";
    first = false;
    out += service_pattern_predicate(pattern);
  }
  out += ")";
  return out;
}

inline std::string service_allowlist_predicate(const TraceSettings& cfg) {
  return service_allowlist_predicate(cfg.service_allowlist);
}

} // namespace otel

// Unqualified spelling used by the logs and metrics routes.
using otel::service_allowlist_predicate;
using otel::service_pattern_predicate;

} // namespace chdash
