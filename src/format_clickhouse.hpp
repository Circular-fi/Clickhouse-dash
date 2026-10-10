#pragma once

#include <cstddef>
#include <optional>
#include <string>

namespace clickhouse { class Client; }

namespace chdash {

enum class FormatQueryFailureKind {
  none,
  input,
  transport,
  server,         // ClickHouse refused the text: a syntax error, a type error (the text of the user is the cause)
  timeout,        // formatQuery ran past its time
  refused,        // ClickHouse could not do it: no grant, no memory, too many queries (the text is not the cause)
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

bool is_format_transport_failure(FormatQueryFailureKind kind) noexcept;

} // namespace chdash
