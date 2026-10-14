#include "format_clickhouse.hpp"

#include "ch_error.hpp"
#include "ch_query.hpp"
#include "ch_uri.hpp"
#include "server.hpp"

#include <clickhouse/exceptions.h>
#include <clickhouse/query.h>

#include <chrono>
#include <exception>
#include <system_error>
#include <string_view>
#include <utility>

namespace chdash {
namespace {

// What a statement of the formatter asks of ClickHouse: formatQuery of a text (one row, one String), or EXPLAIN AST of it (one row for each
// line of the tree).
enum class TextQuery { format_query, explain_ast };

// The tree of a 256 KiB statement is a few megabytes: past this size the answer is not kept (the statement is not judged).
constexpr size_t kMaxAstBytes = 64u * 1024 * 1024;

FormatQueryResult run_text_query_once(
    clickhouse::Client& client,
    TextQuery kind,
    const std::string& sql,
    size_t max_bytes
) {
  FormatQueryResult result;
  if (sql.size() > max_bytes) {
    result.failure = FormatQueryFailureKind::input;
    result.message = "SQL text is too large to format.";
    return result;
  }

  try {
    // Query parameters avoid copying and escaping the complete editor buffer
    // into a second SQL string. They also keep quotes and backslashes exact.
    // EXPLAIN AST takes the text as the statement itself: ClickHouse parses it and does not run it.
    clickhouse::Query query(kind == TextQuery::format_query ? std::string("SELECT formatQuery({sql:String}) AS query") : "EXPLAIN AST " + sql,
                            ch_statement_query_id());
    if (kind == TextQuery::format_query) query.SetParam("sql", sql);
    std::string tree;
    query.OnData([&](const clickhouse::Block& block) {
      if (block.GetRowCount() == 0 || block.GetColumnCount() == 0) return;

      clickhouse::ColumnRef col = block[0];
      if (!col) return;

      if (auto nullable = col->As<clickhouse::ColumnNullable>()) {
        if (nullable->IsNull(0)) return;
        col = nullable->Nested();
      }

      if (auto strings = col->As<clickhouse::ColumnString>()) {
        if (kind == TextQuery::explain_ast) {
          for (size_t row = 0; row < strings->Size(); ++row) {
            if (tree.size() > kMaxAstBytes) return;
            tree.append(strings->At(row));
            tree.push_back('\n');
          }
          return;
        }
        const std::string_view value = strings->At(0);
        const size_t output_limit = max_bytes > (static_cast<size_t>(-1) - 64 * 1024) / 4
          ? static_cast<size_t>(-1)
          : max_bytes * 4 + 64 * 1024;
        if (value.size() > output_limit) {
          result.failure = FormatQueryFailureKind::client;
          result.message = "Formatted SQL is unexpectedly large.";
          return;
        }
        result.formatted_sql.emplace(value.data(), value.size());
      }
    });
    ch_execute(client, query);
    if (kind == TextQuery::explain_ast) {
      if (tree.size() > kMaxAstBytes) {
        result.failure = FormatQueryFailureKind::client;
        result.message = "The syntax tree of the statement is unexpectedly large.";
      } else if (!tree.empty()) {
        result.formatted_sql = std::move(tree);
      }
    }
  } catch (const std::system_error& e) {
    result.failure = FormatQueryFailureKind::transport;
    result.message = e.what();
    result.connection_reusable = false;
    return result;
  } catch (const clickhouse::ServerException& e) {
    // By the code that ClickHouse sends (ch_error.hpp), not by a word of its message.
    switch (classify_clickhouse_error(e).kind) {
      case ChErrorKind::Timeout: result.failure = FormatQueryFailureKind::timeout; break;
      case ChErrorKind::MemoryLimit:
      case ChErrorKind::AccessDenied:
      case ChErrorKind::Unavailable: result.failure = FormatQueryFailureKind::refused; break;
      default: result.failure = FormatQueryFailureKind::server; break;
    }
    result.message = e.what();
    return result;
  } catch (const clickhouse::ProtocolError& e) {
    result.failure = FormatQueryFailureKind::protocol;
    result.message = e.what();
    result.connection_reusable = false;
    return result;
  } catch (const clickhouse::Error& e) {
    result.failure = FormatQueryFailureKind::client;
    result.message = e.what();
    return result;
  } catch (const std::exception& e) {
    result.failure = FormatQueryFailureKind::client;
    result.message = e.what();
    return result;
  }

  if (!result.formatted_sql) {
    if (result.failure == FormatQueryFailureKind::none) {
      result.failure = FormatQueryFailureKind::empty_result;
      result.message = kind == TextQuery::explain_ast ? "ClickHouse returned no syntax tree." : "ClickHouse returned no formatted SQL.";
    }
    return result;
  }

  result.failure = FormatQueryFailureKind::none;
  result.message.clear();
  return result;
}

std::string reconnect_failure_message(
    const std::string& first_error,
    const std::string& reconnect_error
) {
  std::string message = "ClickHouse transport failed while formatting SQL";
  if (!first_error.empty()) {
    message += ": ";
    message += first_error;
  }
  message += "; reconnect failed";
  if (!reconnect_error.empty()) {
    message += ": ";
    message += reconnect_error;
  }
  return message;
}

} // namespace

bool is_format_transport_failure(FormatQueryFailureKind kind) noexcept {
  return kind == FormatQueryFailureKind::transport ||
         kind == FormatQueryFailureKind::protocol;
}

static FormatQueryResult run_text_query(
    clickhouse::Client& client,
    TextQuery kind,
    const std::string& sql,
    size_t max_bytes
) {
  FormatQueryResult first = run_text_query_once(client, kind, sql, max_bytes);
  if (first || !is_format_transport_failure(first.failure)) return first;

  const std::string first_error = first.message;
  first.reconnect_attempted = true;

  try {
    // ResetConnection replaces the socket and both buffered streams, removing
    // any bytes left behind by a failed write before the query is retried.
    client.ResetConnection();
  } catch (const std::exception& e) {
    first.connection_reusable = false;
    first.message = reconnect_failure_message(first_error, e.what());
    return first;
  } catch (...) {
    first.connection_reusable = false;
    first.message = reconnect_failure_message(first_error, "unknown error");
    return first;
  }

  FormatQueryResult second = run_text_query_once(client, kind, sql, max_bytes);
  second.reconnect_attempted = true;
  if (second) {
    second.connection_reusable = true;
    return second;
  }

  if (is_format_transport_failure(second.failure)) {
    second.connection_reusable = false;
  }
  if (!second.message.empty()) {
    second.message = "formatQuery retry failed after reconnect: " + second.message;
  } else {
    second.message = "formatQuery retry failed after reconnect.";
  }
  return second;
}

FormatQueryResult format_query_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes
) {
  return run_text_query(client, TextQuery::format_query, sql, max_bytes);
}

FormatQueryResult explain_ast_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes
) {
  return run_text_query(client, TextQuery::explain_ast, sql, max_bytes);
}

} // namespace chdash
