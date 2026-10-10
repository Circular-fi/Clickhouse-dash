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

// Parse clickhouse://user:pass@host:port?secure=1&ca=/path&verify=1&compression=lz4.
// compression is lz4 (default), zstd or none. The port is 9000, or 9440 when secure=1 and the URI names none.
// client_options_from_uri also accepts password_file=/path as a native secret
// source; it is mutually exclusive with a password embedded in userinfo.
// Only the subset we need.
std::optional<ParsedUri> parse_clickhouse_uri(const std::string& uri, std::string* err);

// "" when the URI is good to connect with; otherwise what is wrong with it (the text of an error). The checks of a
// connection, without a connection: the scheme and the address, a parameter that is not known (a typing mistake), a
// password that is given twice, a password_file that cannot be read, a compression that does not exist. The
// configuration calls it at the start, so a bad URI stops the process there and not at the first request.
std::string validate_clickhouse_uri(const std::string& uri);

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
