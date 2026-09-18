#include "query_execution.hpp"
#include "ch_block_value.hpp"
#include "ch_block_numeric.hpp"

#include "ch_client_pool.hpp"
#include "ch_uri.hpp"

#include <clickhouse/client.h>
#include <clickhouse/columns/numeric.h>
#include <clickhouse/columns/string.h>

#include <algorithm>
#include <chrono>
#include <sstream>
#include <string_view>
#include <thread>
#include <utility>

namespace chdash {
namespace {

std::string sql_quote(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('\'');
  for (char ch : value) {
    if (ch == '\\') out += "\\\\";
    else if (ch == '\'') out += "\\'";
    else out.push_back(ch);
  }
  out.push_back('\'');
  return out;
}

std::vector<std::string> query_ids(const QueryRegistryRecord& record) {
  std::vector<std::string> ids;
  ids.reserve(record.native_query_ids.size() + 1);
  ids.push_back(record.query_id);
  for (const auto& id : record.native_query_ids) {
    if (!id.empty() && std::find(ids.begin(), ids.end(), id) == ids.end()) ids.push_back(id);
  }
  return ids;
}

std::string sql_string_list(const std::vector<std::string>& values) {
  std::string out = "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out += ',';
    out += sql_quote(values[i]);
  }
  out += ']';
  return out;
}

std::string block_string(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_text_at(block, column, row);
}

uint64_t block_u64(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_u64_at(block, column, row);
}

int64_t block_i64(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_i64_at(block, column, row);
}

int32_t block_i32(const clickhouse::Block& block, size_t column, size_t row) {
  return ch_block_i32_at(block, column, row);
}

std::vector<std::string> split_unit_separator(const std::string& value) {
  std::vector<std::string> out;
  size_t begin = 0;
  while (begin <= value.size()) {
    const size_t end = value.find('\x1f', begin);
    const size_t length = end == std::string::npos ? value.size() - begin : end - begin;
    if (length > 0) out.push_back(value.substr(begin, length));
    if (end == std::string::npos) break;
    begin = end + 1;
  }
  return out;
}


std::pair<int64_t, int64_t> query_log_epoch_window(const QueryRegistryRecord& record) {
  using namespace std::chrono;
  constexpr auto kClockSkewGuard = seconds(5);
  auto begin = record.created_at_wall;
  auto end = record.updated_at_wall;
  if (begin.time_since_epoch().count() == 0) begin = system_clock::now();
  if (end.time_since_epoch().count() == 0 || end < begin) end = begin;
  const int64_t begin_epoch = duration_cast<seconds>((begin - kClockSkewGuard).time_since_epoch()).count();
  const int64_t end_epoch = duration_cast<seconds>((end + kClockSkewGuard).time_since_epoch()).count();
  return {begin_epoch, std::max(begin_epoch, end_epoch)};
}

std::shared_ptr<clickhouse::Client> acquire_client(
    const std::shared_ptr<ClickHouseClientPool>& pool,
    const std::string& uri,
    int timeout_ms,
    std::string* error) {
  const auto timeout = std::chrono::milliseconds(std::max(250, std::min(30000, timeout_ms)));
  return pool ? pool->acquire(uri, timeout, timeout, timeout, error)
              : make_client_from_uri(uri, timeout, timeout, timeout, error);
}

bool load_once(clickhouse::Client& client, const QueryRegistryRecord& record, QueryExecutionStats& out) {
  const std::string ids = sql_string_list(query_ids(record));
  const auto [window_begin, window_end] = query_log_epoch_window(record);
  const std::string time_scope =
      "event_date BETWEEN toDate(toDateTime(" + std::to_string(window_begin) + ")) "
      "AND toDate(toDateTime(" + std::to_string(window_end) + ")) "
      "AND event_time BETWEEN toDateTime(" + std::to_string(window_begin) + ") "
      "AND toDateTime(" + std::to_string(window_end) + ")";
  const std::string query =
      "SELECT query_id, toString(type), toString(event_time_microseconds), "
      "toUInt64(query_duration_ms), toUInt64(read_rows), toUInt64(read_bytes), "
      "toUInt64(written_rows), toUInt64(written_bytes), toUInt64(result_rows), "
      "toUInt64(result_bytes), toInt64(memory_usage), toUInt64(peak_threads_usage), "
      "arrayStringConcat(databases, char(31)), arrayStringConcat(tables, char(31)), "
      "arrayStringConcat(projections, char(31)), toInt32(exception_code), exception "
      "FROM system.query_log PREWHERE " + time_scope + " "
      "WHERE type != 'QueryStart' AND query_id IN " + ids + " "
      "ORDER BY event_time_microseconds DESC LIMIT 1";

  bool found = false;
  client.Select(query, [&](const clickhouse::Block& block) {
    if (found || block.GetRowCount() == 0) return;
    const size_t row = 0;
    out.native_query_id = block_string(block, 0, row);
    out.status = block_string(block, 1, row);
    out.event_time = block_string(block, 2, row);
    out.duration_ms = block_u64(block, 3, row);
    out.read_rows = block_u64(block, 4, row);
    out.read_bytes = block_u64(block, 5, row);
    out.written_rows = block_u64(block, 6, row);
    out.written_bytes = block_u64(block, 7, row);
    out.result_rows = block_u64(block, 8, row);
    out.result_bytes = block_u64(block, 9, row);
    out.memory_usage = block_i64(block, 10, row);
    out.peak_threads_usage = block_u64(block, 11, row);
    out.databases = split_unit_separator(block_string(block, 12, row));
    out.tables = split_unit_separator(block_string(block, 13, row));
    out.projections = split_unit_separator(block_string(block, 14, row));
    out.exception_code = block_i32(block, 15, row);
    out.exception = block_string(block, 16, row);
    found = true;
  });
  return found;
}

} // namespace

QueryExecutionStats collect_query_execution(
    const QueryRegistryRecord& record,
    const std::string& system_uri,
    const std::shared_ptr<ClickHouseClientPool>& client_pool,
    int lookup_timeout_ms,
    bool flush_logs) {
  QueryExecutionStats result;
  result.query_id = record.query_id;

  std::string error;
  auto client = acquire_client(client_pool, system_uri, lookup_timeout_ms, &error);
  if (!client) {
    result.error = error.empty() ? "Cannot connect to ClickHouse system context." : error;
    return result;
  }

  try {
    if (flush_logs) client->Execute("SYSTEM FLUSH LOGS query_log");

    const auto deadline = std::chrono::steady_clock::now() +
        std::chrono::milliseconds(std::max(0, lookup_timeout_ms));
    do {
      if (load_once(*client, record, result)) {
        result.available = true;
        result.logs_pending = false;
        return result;
      }
      if (std::chrono::steady_clock::now() >= deadline) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    } while (true);

    result.logs_pending = true;
    return result;
  } catch (const std::exception& e) {
    result.error = e.what();
    if (client_pool) client_pool->invalidate(client);
    return result;
  }
}

} // namespace chdash
