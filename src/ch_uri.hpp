#pragma once

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include <clickhouse/client.h>

namespace chdash {

struct ParsedUri {
  std::string scheme;
  std::string user;
  std::string password;
  std::string host;
  uint16_t port = 9000;
  std::unordered_map<std::string, std::string> query;
};

// Parse clickhouse://user:pass@host:port?secure=1&ca=/path&verify=1
// Only the subset we need.
std::optional<ParsedUri> parse_clickhouse_uri(const std::string& uri, std::string* err);

// Return a log-safe representation of a ClickHouse URI. Passwords and common
// secret query parameters are replaced without changing the endpoint shape.
std::string redact_clickhouse_uri(const std::string& uri);

// Build clickhouse::ClientOptions from a clickhouse:// URI.
// Timeouts can be overridden (used for aggressive health checks).
std::optional<clickhouse::ClientOptions> client_options_from_uri(
  const std::string& uri,
  std::chrono::milliseconds connect_timeout,
  std::chrono::milliseconds recv_timeout,
  std::chrono::milliseconds send_timeout,
  std::string* err
);

std::shared_ptr<clickhouse::Client> make_client_from_uri(
  const std::string& uri,
  std::chrono::milliseconds connect_timeout,
  std::chrono::milliseconds recv_timeout,
  std::chrono::milliseconds send_timeout,
  std::string* err
);

// Helpers
bool query_param_truthy(const std::unordered_map<std::string, std::string>& q, const std::string& key, bool def);

} // namespace chdash
