#include "format_clickhouse.hpp"

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

FormatQueryResult format_query_once(
    clickhouse::Client& client,
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
    clickhouse::Query query("SELECT formatQuery({sql:String}) AS query");
    query.SetParam("sql", sql);
    query.OnData([&](const clickhouse::Block& block) {
      if (block.GetRowCount() == 0 || block.GetColumnCount() == 0) return;

      clickhouse::ColumnRef col = block[0];
      if (!col) return;

      if (auto nullable = col->As<clickhouse::ColumnNullable>()) {
        if (nullable->IsNull(0)) return;
        col = nullable->Nested();
      }

      if (auto strings = col->As<clickhouse::ColumnString>()) {
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
    client.Select(query);
  } catch (const std::system_error& e) {
    result.failure = FormatQueryFailureKind::transport;
    result.message = e.what();
    result.connection_reusable = false;
    return result;
  } catch (const clickhouse::ServerException& e) {
    result.failure = FormatQueryFailureKind::server;
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
      result.message = "ClickHouse returned no formatted SQL.";
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

FormatQueryResult format_query_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes
) {
  FormatQueryResult first = format_query_once(client, sql, max_bytes);
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

  FormatQueryResult second = format_query_once(client, sql, max_bytes);
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

std::optional<std::string> try_format_query_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
) {
  FormatQueryResult result = format_query_with_client(client, sql, max_bytes);
  if (!result && err_log) *err_log = result.message;
  return std::move(result.formatted_sql);
}

std::optional<std::string> try_format_query(
    const HostSpec& host,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
) {
  std::string err;
  auto client = make_client_from_uri(
      host.runner_uri,
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      std::chrono::seconds(5),
      &err
  );

  if (!client) {
    if (err_log) *err_log = "make_client failed: " + err;
    return std::nullopt;
  }

  return try_format_query_with_client(*client, sql, max_bytes, err_log);
}

} // namespace chdash
