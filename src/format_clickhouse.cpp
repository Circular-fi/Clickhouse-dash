#include "format_clickhouse.hpp"

#include "ch_uri.hpp"
#include "server.hpp"

#include <clickhouse/query.h>

#include <chrono>
#include <exception>
#include <utility>

namespace chdash {

std::optional<std::string> try_format_query_with_client(
    clickhouse::Client& client,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
) {
  if (sql.size() > max_bytes) {
    if (err_log) *err_log = "sql too large";
    return std::nullopt;
  }

  std::optional<std::string> formatted;

  try {
    // Query parameters avoid copying/escaping the complete editor buffer into a
    // second SQL string. They also keep quotes and backslashes unambiguous.
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
          if (err_log) *err_log = "formatted SQL is unexpectedly large";
          return;
        }
        formatted.emplace(value.data(), value.size());
      }
    });
    client.Select(query);
  } catch (const std::exception& e) {
    if (err_log) *err_log = e.what();
    return std::nullopt;
  }

  if (!formatted && err_log) *err_log = "no formatted result returned";
  return formatted;
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
