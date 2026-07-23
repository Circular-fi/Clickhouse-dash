#pragma once

#include <cstddef>
#include <optional>
#include <string>

namespace clickhouse { class Client; }

namespace chdash {

struct HostSpec;

enum class FormatQueryFailureKind {
  none,
  input,
  transport,
  server,
  protocol,
  client,
  empty_result,
};

struct FormatQueryResult {
  std::optional<std::string> formatted_sql;
  FormatQueryFailureKind failure = FormatQueryFailureKind::none;
  std::string message;
  bool reconnect_attempted = false;
  bool connection_reusable = true;

  explicit operator bool() const noexcept {
    return formatted_sql.has_value();
  }
};

// formatQuery is read-only, so one reconnect-and-retry is safe when the native
// TCP connection was closed while idle or failed during protocol I/O.
FormatQueryResult format_query_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes
);

// Compatibility wrapper used by callers that only need the formatted string.
std::optional<std::string> try_format_query_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
);

std::optional<std::string> try_format_query(
    const HostSpec& host,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
);

bool is_format_transport_failure(FormatQueryFailureKind kind) noexcept;

} // namespace chdash
