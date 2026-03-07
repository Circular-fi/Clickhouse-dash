#include "format_clickhouse.hpp"

#include "ch_uri.hpp"
#include "sql_util.hpp"
#include "server.hpp"

#include <chrono>

namespace chdash {

std::optional<std::string> try_format_query(
    const HostSpec& host,
    const std::string& sql,
    size_t max_bytes,
    std::string* err_log
) {
  if (sql.size() > max_bytes) {
    if (err_log) *err_log = "sql too large";
    return std::nullopt;
  }

  const std::string escaped = escape_for_clickhouse_string(sql);
  const std::string fmt_sql = "SELECT formatQuery('" + escaped + "') AS query";

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

  std::optional<std::string> formatted;

  try {
    client->Select(fmt_sql, [&](const clickhouse::Block& b) {
      if (b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;

      clickhouse::ColumnRef col = b[0];
      if (!col) return;

      if (auto nullable = col->As<clickhouse::ColumnNullable>()) {
        if (nullable->IsNull(0)) return;
        col = nullable->Nested();
      }

      if (auto s = col->As<clickhouse::ColumnString>()) {
        formatted = std::string(s->At(0));
      }
    });
  } catch (const std::exception& e) {
    if (err_log) *err_log = std::string(e.what());
    return std::nullopt;
  }

  if (!formatted) {
    if (err_log) *err_log = "no formatted result returned";
  }

  return formatted;
}

} // namespace chdash
