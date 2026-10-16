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

// formatQuery is read-only. A single reconnect-and-retry is safe when the native
// TCP connection was closed while idle, or failed during protocol I/O.
FormatQueryResult format_query_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes
);

// EXPLAIN AST of a text gives the tree that ClickHouse reads from it. The tree is the same for two layouts of one statement, and for a text with and without its comments.
// The answer is the text of the tree, in `formatted_sql`. ClickHouse parses the text. It does not run the text.
// The reconnect rule is the same as for formatQuery.
FormatQueryResult explain_ast_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes
);

bool is_format_transport_failure(FormatQueryFailureKind kind) noexcept;

} // namespace chdash
