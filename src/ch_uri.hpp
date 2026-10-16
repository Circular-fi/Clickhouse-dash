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

// The parser reads this format: clickhouse://user:pass@host:port?secure=1&ca=/path&verify=1&compression=lz4.
// compression is lz4 (default), zstd or none. The port is 9000. It is 9440 when secure=1 and the URI names no port.
// The password of a connection is the one in the userinfo.
//
// At start, the configuration puts the password there. It reads the file or the environment variable that the host names (config.cpp).
// A URI in the file never holds a password.
// The implementation supports only the subset that the code needs.
std::optional<ParsedUri> parse_clickhouse_uri(const std::string& uri, std::string* err);

// Returns "" when the URI is valid for a connection. Otherwise it returns the error text.
// The checks run without a connection. They check the scheme and the address.
// They also reject a parameter that is not known (a typing mistake) and a compression that does not exist.
// The configuration calls this check at start.
//
// A bad URI stops the process at start, and not at the first request.
std::string validate_clickhouse_uri(const std::string& uri);

// Returns the URI with `password` as the password of its userinfo.
// The password is percent-encoded. The user stays as it is. A URI with no user gets an empty user.
// The configuration uses this function once for each URI, at start.
std::string clickhouse_uri_with_password(const std::string& uri, const std::string& password);

// Returns a log-safe representation of a ClickHouse URI.
// Passwords and common secret query parameters are replaced. The endpoint shape does not change.
std::string redact_clickhouse_uri(const std::string& uri);

// Builds clickhouse::ClientOptions from a clickhouse:// URI.
// The timeouts can be overridden. Aggressive health checks use this override.
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
