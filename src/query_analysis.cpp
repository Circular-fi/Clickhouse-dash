#include "query_analysis.hpp"
#include "ch_block_value.hpp"
#include "ch_block_numeric.hpp"

#include "ch_client_pool.hpp"
#include "ch_uri.hpp"

#include <clickhouse/client.h>
#include <clickhouse/columns/numeric.h>
#include <clickhouse/columns/string.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <limits>
#include <sstream>
#include <string_view>
#include <thread>
#include <unordered_set>

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

std::vector<std::string> analysis_query_ids(const QueryRegistryRecord& record) {
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

uint64_t wall_epoch_us(std::chrono::system_clock::time_point value) {
  if (value.time_since_epoch().count() <= 0) return 0;
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(value.time_since_epoch()).count());
}

std::pair<uint64_t, uint64_t> analysis_wall_bounds_us(const QueryRegistryRecord& record) {
  constexpr uint64_t margin_us = 5ULL * 1000ULL * 1000ULL;
  const uint64_t created = wall_epoch_us(record.created_at_wall);
  const uint64_t updated = wall_epoch_us(record.updated_at_wall);
  const uint64_t lo = created > margin_us ? created - margin_us : 0;
  const uint64_t hi_base = std::max(created, updated);
  return {lo, hi_base + margin_us};
}

std::pair<uint64_t, uint64_t> clickhouse_query_extent_us(
    const std::vector<QueryLogAnalysisRow>& rows) {
  uint64_t earliest = 0;
  uint64_t latest = 0;
  for (const auto& row : rows) {
    if (row.event_time_us == 0) continue;
    const uint64_t max_u64 = std::numeric_limits<uint64_t>::max();
    const uint64_t duration_us = row.duration_ms > (max_u64 / 1000ULL)
        ? max_u64
        : row.duration_ms * 1000ULL;
    const uint64_t start_us = row.event_time_us > duration_us ? row.event_time_us - duration_us : 0;
    if (earliest == 0 || start_us < earliest) earliest = start_us;
    latest = std::max(latest, row.event_time_us);
  }
  return {earliest, latest};
}

std::pair<uint64_t, uint64_t> clickhouse_query_bounds_us(
    const QueryRegistryRecord& record,
    const std::vector<QueryLogAnalysisRow>& rows) {
  // OpenTelemetry and query_log are written by ClickHouse. Deriving the trace
  // window from query_log therefore avoids host/container wall-clock skew while
  // still letting finish_date/finish_time_us prune opentelemetry_span_log.
  constexpr uint64_t margin_us = 10ULL * 1000ULL * 1000ULL;
  const auto [earliest, latest] = clickhouse_query_extent_us(rows);
  if (earliest == 0 || latest == 0) return analysis_wall_bounds_us(record);
  const uint64_t lo = earliest > margin_us ? earliest - margin_us : 0;
  const uint64_t max_u64 = std::numeric_limits<uint64_t>::max();
  const uint64_t hi = latest > max_u64 - margin_us ? max_u64 : latest + margin_us;
  return {lo, hi};
}

uint64_t processor_trace_bucket_us(
    const std::vector<QueryLogAnalysisRow>& rows,
    uint64_t trace_lo_us,
    uint64_t trace_hi_us,
    size_t processor_count) {
  // Preserve gaps without sending every OTel processor call to the browser.
  // Aim for ~32K summary rows before the independent 65K hard cap. Typical
  // pipelines therefore get hundreds of temporal buckets per processor, while
  // very large pipelines automatically trade temporal resolution for bounded
  // response size.
  constexpr uint64_t target_rows = 32768;
  constexpr uint64_t min_buckets_per_processor = 4;
  constexpr uint64_t max_buckets_per_processor = 512;
  const uint64_t estimated_processors = std::max<uint64_t>(1, static_cast<uint64_t>(processor_count));
  const uint64_t desired_buckets = std::clamp(
      target_rows / estimated_processors,
      min_buckets_per_processor,
      max_buckets_per_processor);

  const auto [query_start_us, query_finish_us] = clickhouse_query_extent_us(rows);
  uint64_t window_us = query_finish_us > query_start_us ? query_finish_us - query_start_us : 0;
  if (window_us == 0 && trace_hi_us > trace_lo_us) window_us = trace_hi_us - trace_lo_us;
  window_us = std::max<uint64_t>(1, window_us);
  return 1 + (window_us - 1) / desired_buckets;
}

std::string standard_log_prewhere(const QueryRegistryRecord& record) {
  const auto [lo_us, hi_us] = analysis_wall_bounds_us(record);
  const uint64_t lo_s = lo_us / 1000000ULL;
  const uint64_t hi_s = (hi_us + 999999ULL) / 1000000ULL;
  return "event_date BETWEEN toDate(toDateTime(" + std::to_string(lo_s) + ")) AND toDate(toDateTime(" + std::to_string(hi_s) + ")) "
      "AND event_time BETWEEN toDateTime(" + std::to_string(lo_s) + ") AND toDateTime(" + std::to_string(hi_s) + ")";
}

std::string otel_log_prewhere(uint64_t lo_us, uint64_t hi_us) {
  const uint64_t lo_s = lo_us / 1000000ULL;
  const uint64_t hi_s = (hi_us + 999999ULL) / 1000000ULL;
  // system.opentelemetry_span_log stores finish_time_us as epoch
  // microseconds (UInt64) and is ordered by (finish_date, finish_time_us,
  // trace_id). Keep both predicates in their native types so the ORDER BY
  // prefix prunes correctly and the numeric timestamp comparison cannot turn
  // into an empty DateTime64 range.
  return "finish_date BETWEEN toDate(toDateTime(" + std::to_string(lo_s) + ")) "
      "AND toDate(toDateTime(" + std::to_string(hi_s) + ")) "
      "AND finish_time_us BETWEEN " + std::to_string(lo_us) + " AND " + std::to_string(hi_us);
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

std::vector<uint64_t> split_u64_csv(const std::string& value) {
  std::vector<uint64_t> out;
  std::stringstream stream(value);
  std::string item;
  while (std::getline(stream, item, ',')) {
    if (item.empty()) continue;
    size_t parsed = 0;
    const unsigned long long value = std::stoull(item, &parsed, 10);
    if (parsed != item.size()) {
      throw std::runtime_error("Invalid processor parent id returned by ClickHouse: " + item);
    }
    out.push_back(static_cast<uint64_t>(value));
  }
  return out;
}

std::shared_ptr<clickhouse::Client> acquire_analysis_client(
    const std::shared_ptr<ClickHouseClientPool>& pool,
    const std::string& uri,
    int timeout_ms,
    std::string* error) {
  const auto timeout = std::chrono::milliseconds(std::max(250, std::min(30000, timeout_ms)));
  return pool ? pool->acquire(uri, timeout, timeout, timeout, error)
              : make_client_from_uri(uri, timeout, timeout, timeout, error);
}

std::vector<QueryLogAnalysisRow> load_query_log_rows(
    clickhouse::Client& client,
    const QueryRegistryRecord& record,
    const std::vector<std::string>& ids,
    bool children_only) {
  const std::string id_array = sql_string_list(ids);
  const std::string predicate = children_only
      ? "initial_query_id IN " + id_array + " AND query_id NOT IN " + id_array
      : "query_id IN " + id_array;
  const std::string query =
      "SELECT toString(hostname()), toString(query_id), toString(initial_query_id), toString(type), "
      "toString(event_time_microseconds), toUInt64(toUnixTimestamp64Micro(event_time_microseconds)), toUInt64(query_duration_ms), "
      "toUInt64(read_rows), toUInt64(read_bytes), toUInt64(written_rows), "
      "toUInt64(written_bytes), toUInt64(result_rows), toUInt64(result_bytes), "
      "toInt64(memory_usage), toUInt64(peak_threads_usage), "
      "toUInt64(ProfileEvents['UserTimeMicroseconds']), "
      "toUInt64(ProfileEvents['SystemTimeMicroseconds']), "
      "arrayStringConcat(databases, char(31)), arrayStringConcat(tables, char(31)), "
      "arrayStringConcat(projections, char(31)), toInt32(exception_code), toString(exception), toString(query), "
      "toUInt8(is_initial_query) "
      "FROM system.query_log PREWHERE " + standard_log_prewhere(record) + " "
      "WHERE type != 'QueryStart' AND " + predicate + " "
      "ORDER BY event_time_microseconds DESC LIMIT 512";

  std::vector<QueryLogAnalysisRow> rows;
  client.Select(query, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      QueryLogAnalysisRow value;
      value.hostname = block_string(block, 0, row);
      value.query_id = block_string(block, 1, row);
      value.initial_query_id = block_string(block, 2, row);
      value.status = block_string(block, 3, row);
      value.event_time = block_string(block, 4, row);
      value.event_time_us = block_u64(block, 5, row);
      value.duration_ms = block_u64(block, 6, row);
      value.read_rows = block_u64(block, 7, row);
      value.read_bytes = block_u64(block, 8, row);
      value.written_rows = block_u64(block, 9, row);
      value.written_bytes = block_u64(block, 10, row);
      value.result_rows = block_u64(block, 11, row);
      value.result_bytes = block_u64(block, 12, row);
      value.memory_usage = block_i64(block, 13, row);
      value.peak_threads_usage = block_u64(block, 14, row);
      value.user_time_us = block_u64(block, 15, row);
      value.system_time_us = block_u64(block, 16, row);
      value.databases = split_unit_separator(block_string(block, 17, row));
      value.tables = split_unit_separator(block_string(block, 18, row));
      value.projections = split_unit_separator(block_string(block, 19, row));
      value.exception_code = block_i32(block, 20, row);
      value.exception = block_string(block, 21, row);
      value.query = block_string(block, 22, row);
      value.is_initial_query = block_u64(block, 23, row) != 0;
      rows.push_back(std::move(value));
    }
  });
  return rows;
}

std::vector<ProcessorAnalysisRow> load_processors(
    clickhouse::Client& client,
    const QueryRegistryRecord& record,
    const std::vector<std::string>& ids,
    bool* truncated) {
  constexpr size_t kMaxProcessors = 10000;
  *truncated = false;
  const std::string id_array = sql_string_list(ids);
  const std::string query =
      "SELECT toString(hostname), toString(initial_query_id), toString(query_id), toUInt64(id), "
      "arrayStringConcat(arrayMap(x -> toString(x), parent_ids), ','), "
      "toUInt64(plan_step), toString(plan_step_name), toString(plan_step_description), toUInt64(plan_group), toString(name), "
      "toUInt64(elapsed_us), toUInt64(input_wait_elapsed_us), toUInt64(output_wait_elapsed_us), "
      "toUInt64(input_rows), toUInt64(input_bytes), toUInt64(output_rows), toUInt64(output_bytes) "
      "FROM system.processors_profile_log PREWHERE " + standard_log_prewhere(record) + " "
      "WHERE query_id IN " + id_array + " "
      "ORDER BY query_id, plan_step, plan_group, id LIMIT " + std::to_string(kMaxProcessors + 1);

  std::vector<ProcessorAnalysisRow> rows;
  client.Select(query, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      ProcessorAnalysisRow value;
      value.hostname = block_string(block, 0, row);
      value.initial_query_id = block_string(block, 1, row);
      value.query_id = block_string(block, 2, row);
      value.id = block_u64(block, 3, row);
      value.parent_ids = split_u64_csv(block_string(block, 4, row));
      value.plan_step = block_u64(block, 5, row);
      value.plan_step_name = block_string(block, 6, row);
      value.plan_step_description = block_string(block, 7, row);
      value.plan_group = block_u64(block, 8, row);
      value.name = block_string(block, 9, row);
      value.elapsed_us = block_u64(block, 10, row);
      value.input_wait_elapsed_us = block_u64(block, 11, row);
      value.output_wait_elapsed_us = block_u64(block, 12, row);
      value.input_rows = block_u64(block, 13, row);
      value.input_bytes = block_u64(block, 14, row);
      value.output_rows = block_u64(block, 15, row);
      value.output_bytes = block_u64(block, 16, row);
      rows.push_back(std::move(value));
    }
  });
  if (rows.size() > kMaxProcessors) {
    *truncated = true;
    rows.resize(kMaxProcessors);
  }
  return rows;
}

std::vector<ProcessorTraceSummaryRow> load_processor_trace_summary(
    clickhouse::Client& client,
    const std::vector<std::string>& ids,
    uint64_t trace_lo_us,
    uint64_t trace_hi_us,
    uint64_t activity_bucket_us,
    bool* truncated) {
  constexpr size_t kMaxProcessorTraceSummaries = 65536;
  *truncated = false;
  const std::string id_array = sql_string_list(ids);
  const std::string time_scope = otel_log_prewhere(trace_lo_us, trace_hi_us);
  const std::string trace_scope =
      "trace_id IN (SELECT DISTINCT trace_id FROM system.opentelemetry_span_log PREWHERE " + time_scope + " "
      "WHERE attribute['clickhouse.query_id'] IN " + id_array + ")";
  const std::string query =
      "SELECT toString(hostName()), toString(trace_id), toString(parent_span_id), "
      "replaceRegexpOne(toString(operation_name), '(_[0-9]+)+$', '') AS normalized_operation_name, "
      "toUInt64(min(start_time_us)), toUInt64(max(finish_time_us)), "
      "toUInt64(sum(finish_time_us - start_time_us)), toUInt64(count()), "
      "anyIf(attribute['clickhouse.query_id'], attribute['clickhouse.query_id'] IN " + id_array + ") "
      "FROM system.opentelemetry_span_log PREWHERE " + time_scope + " WHERE " + trace_scope + " "
      "GROUP BY trace_id, parent_span_id, normalized_operation_name, intDiv(start_time_us, " +
      std::to_string(std::max<uint64_t>(1, activity_bucket_us)) + ") "
      "ORDER BY min(start_time_us), normalized_operation_name, trace_id, parent_span_id LIMIT " +
      std::to_string(kMaxProcessorTraceSummaries + 1);

  std::vector<ProcessorTraceSummaryRow> rows;
  client.Select(query, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      ProcessorTraceSummaryRow value;
      value.hostname = block_string(block, 0, row);
      value.trace_id = block_string(block, 1, row);
      value.parent_span_id = block_string(block, 2, row);
      value.operation_name = block_string(block, 3, row);
      value.first_start_time_us = block_u64(block, 4, row);
      value.last_finish_time_us = block_u64(block, 5, row);
      value.active_time_us = block_u64(block, 6, row);
      value.event_count = block_u64(block, 7, row);
      value.query_id = block_string(block, 8, row);
      rows.push_back(std::move(value));
    }
  });
  if (rows.size() > kMaxProcessorTraceSummaries) {
    *truncated = true;
    rows.resize(kMaxProcessorTraceSummaries);
  }
  return rows;
}

std::vector<OpenTelemetrySpanAnalysisRow> load_otel_spans(
    clickhouse::Client& client,
    const std::vector<std::string>& ids,
    uint64_t trace_lo_us,
    uint64_t trace_hi_us,
    bool include_original_fields,
    bool* truncated) {
  const std::string id_array = sql_string_list(ids);
  constexpr size_t kMaxTraceSpans = 10000;
  if (truncated) *truncated = false;

  const std::string time_scope = otel_log_prewhere(trace_lo_us, trace_hi_us);
  const std::string trace_scope =
      "trace_id IN (SELECT DISTINCT trace_id FROM system.opentelemetry_span_log PREWHERE " + time_scope + " "
      "WHERE attribute['clickhouse.query_id'] IN " + id_array + ")";

  auto load_rows = [&](const std::string& predicate, size_t limit) {
    const std::string original_fields = include_original_fields
        ? ", toString(attribute['clickhouse.query_id']), toString(attribute['clickhouse.thread_id']), toString(attribute['thread_number'])"
        : std::string{};
    const std::string query =
        "SELECT toString(hostName()), toString(trace_id), toString(span_id), toString(parent_span_id), "
        "toString(operation_name), toUInt64(start_time_us), toUInt64(finish_time_us)" + original_fields +
        " FROM system.opentelemetry_span_log PREWHERE " + time_scope + " WHERE " + trace_scope +
        (predicate.empty() ? std::string{} : " AND (" + predicate + ")") +
        " ORDER BY start_time_us, finish_time_us, span_id LIMIT " + std::to_string(limit);

    std::vector<OpenTelemetrySpanAnalysisRow> out;
    client.Select(query, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        OpenTelemetrySpanAnalysisRow value;
        value.hostname = block_string(block, 0, row);
        value.trace_id = block_string(block, 1, row);
        value.span_id = block_string(block, 2, row);
        value.parent_span_id = block_string(block, 3, row);
        value.operation_name = block_string(block, 4, row);
        value.start_time_us = block_u64(block, 5, row);
        value.finish_time_us = block_u64(block, 6, row);
        if (include_original_fields) {
          value.query_id = block_string(block, 7, row);
          value.thread_id = block_string(block, 8, row);
          value.thread_number = block_string(block, 9, row);
        }
        out.push_back(std::move(value));
      }
    });
    return out;
  };

  // The overwhelmingly common case is below the configured cap. Keep it to one
  // span fetch; only use breadth-first retrieval when truncation is necessary.
  uint64_t total = 0;
  client.Select(
      "SELECT toUInt64(count()) FROM system.opentelemetry_span_log PREWHERE " + time_scope + " WHERE " + trace_scope,
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount()) total = block_u64(block, 0, 0);
      });
  if (total <= kMaxTraceSpans) return load_rows("", kMaxTraceSpans);

  // When a trace is larger than the cap, chronological LIMIT can retain a deep
  // branch while dropping shallower siblings/parents. Retrieve breadth-first
  // instead: every span at depth N-1 is retained before depth N is considered.
  // A parent that is not present in the retained trace is treated as a root.
  const std::string root_predicate =
      "parent_span_id = 0 OR tuple(trace_id, parent_span_id) NOT IN ("
      "SELECT tuple(trace_id, span_id) FROM system.opentelemetry_span_log PREWHERE " + time_scope + " WHERE " + trace_scope + ")";

  std::vector<OpenTelemetrySpanAnalysisRow> rows;
  auto level = load_rows(root_predicate, kMaxTraceSpans + 1);
  if (level.size() > kMaxTraceSpans) {
    level.resize(kMaxTraceSpans);
    if (truncated) *truncated = true;
    return level;
  }
  rows.insert(rows.end(), level.begin(), level.end());

  while (!level.empty() && rows.size() < kMaxTraceSpans) {
    std::string parents = "[";
    for (size_t i = 0; i < level.size(); ++i) {
      if (i) parents += ',';
      parents += "(" + sql_quote(level[i].trace_id) + "," + sql_quote(level[i].span_id) + ")";
    }
    parents += "]";

    const size_t remaining = kMaxTraceSpans - rows.size();
    auto next = load_rows(
        "tuple(toString(trace_id), toString(parent_span_id)) IN " + parents,
        remaining + 1);
    if (next.size() > remaining) {
      next.resize(remaining);
      rows.insert(rows.end(), next.begin(), next.end());
      if (truncated) *truncated = true;
      return rows;
    }
    rows.insert(rows.end(), next.begin(), next.end());
    level = std::move(next);
  }

  if (rows.size() < total && truncated) *truncated = true;
  return rows;
}

std::vector<QueryViewAnalysisRow> load_views(
    clickhouse::Client& client,
    const QueryRegistryRecord& record,
    const std::vector<std::string>& ids) {
  const std::string id_array = sql_string_list(ids);
  const std::string query =
      "SELECT toString(hostname), toString(event_time_microseconds), toUInt64(view_duration_ms), "
      "toString(initial_query_id), toString(view_name), toString(view_type), toString(view_target), "
      "toUInt64(read_rows), toUInt64(read_bytes), toUInt64(written_rows), toUInt64(written_bytes), "
      "toUInt64(peak_memory_usage), toString(status), toInt32(exception_code), toString(exception) "
      "FROM system.query_views_log PREWHERE " + standard_log_prewhere(record) + " WHERE initial_query_id IN " + id_array + " "
      "ORDER BY event_time_microseconds, view_name LIMIT 2048";

  std::vector<QueryViewAnalysisRow> rows;
  client.Select(query, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      QueryViewAnalysisRow value;
      value.hostname = block_string(block, 0, row);
      value.event_time = block_string(block, 1, row);
      value.duration_ms = block_u64(block, 2, row);
      value.initial_query_id = block_string(block, 3, row);
      value.view_name = block_string(block, 4, row);
      value.view_type = block_string(block, 5, row);
      value.view_target = block_string(block, 6, row);
      value.read_rows = block_u64(block, 7, row);
      value.read_bytes = block_u64(block, 8, row);
      value.written_rows = block_u64(block, 9, row);
      value.written_bytes = block_u64(block, 10, row);
      value.peak_memory_usage = block_u64(block, 11, row);
      value.status = block_string(block, 12, row);
      value.exception_code = block_i32(block, 13, row);
      value.exception = block_string(block, 14, row);
      rows.push_back(std::move(value));
    }
  });
  return rows;
}

} // namespace

QueryAnalysisResult collect_query_analysis(
    const QueryRegistryRecord& record,
    const std::string& system_uri,
    const std::shared_ptr<ClickHouseClientPool>& client_pool,
    const QueryAnalysisOptions& options) {
  QueryAnalysisResult result;
  result.record = record;
  const auto ids = analysis_query_ids(record);

  std::string error;
  auto client = acquire_analysis_client(client_pool, system_uri, options.log_lookup_timeout_ms, &error);
  if (!client) {
    result.fatal_error = error.empty() ? "Cannot connect to ClickHouse system context." : error;
    result.query_log_error = result.fatal_error;
    result.processors_profile_error = result.fatal_error;
    result.query_views_error = result.fatal_error;
    result.opentelemetry_span_log_error = result.fatal_error;
    return result;
  }

  if (options.flush_logs) {
    try {
      client->Execute("SYSTEM FLUSH LOGS query_log, processors_profile_log, query_views_log");
    } catch (const std::exception& e) {
      result.fatal_error = std::string("SYSTEM FLUSH LOGS failed: ") + e.what();
      result.query_log_error = result.fatal_error;
      result.processors_profile_error = result.fatal_error;
      result.query_views_error = result.fatal_error;
      return result;
    }
  }

  const auto deadline = std::chrono::steady_clock::now() +
      std::chrono::milliseconds(std::max(0, options.log_lookup_timeout_ms));
  do {
    try {
      result.query_log = load_query_log_rows(*client, record, ids, false);
      result.query_log_available = true;
      result.query_log_error.clear();
    } catch (const std::exception& e) {
      result.query_log_error = e.what();
      result.fatal_error = std::string("query_log lookup failed: ") + e.what();
      return result;
    }

    if (!result.query_log.empty() || std::chrono::steady_clock::now() >= deadline) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  } while (std::chrono::steady_clock::now() < deadline);

  result.logs_pending = result.query_log_available && result.query_log.empty();
  const auto [trace_lo_us, trace_hi_us] = clickhouse_query_bounds_us(record, result.query_log);

  if (result.query_log_available) {
    try {
      result.distributed_children = load_query_log_rows(*client, record, ids, true);
      result.distributed_error.clear();
    } catch (const std::exception& e) {
      // This lookup is optional for the rest of Analysis, but its failure is
      // still user-visible; an empty list must never masquerade as success.
      result.distributed_error = e.what();
    }
  }

  try {
    result.processors = load_processors(*client, record, ids, &result.processors_truncated);
    result.processors_profile_available = true;
  } catch (const std::exception& e) {
    result.processors_profile_error = e.what();
  }

  if (record.run_mode == QueryRunMode::Profiling) {
    // The OpenTelemetry span log is asynchronous and can lag query_log. Give
    // it its own bounded lookup window instead of reusing the query_log
    // deadline, otherwise a slow query_log flush can consume the entire trace
    // budget. Re-flush at a low cadence while the trace is still growing.
    const auto otel_deadline = std::chrono::steady_clock::now() +
        std::chrono::milliseconds(std::max(0, options.log_lookup_timeout_ms));
    auto next_otel_flush = std::chrono::steady_clock::now();
    size_t previous_count = static_cast<size_t>(-1);
    int stable_observations = 0;
    do {
      const auto now = std::chrono::steady_clock::now();
      if (now >= next_otel_flush) {
        try {
          client->Execute("SYSTEM FLUSH LOGS opentelemetry_span_log");
        } catch (const std::exception& e) {
          result.opentelemetry_span_log_error = e.what();
        }
        next_otel_flush = now + std::chrono::milliseconds(200);
      }

      try {
        bool truncated = false;
        auto spans = load_otel_spans(*client, ids, trace_lo_us, trace_hi_us, options.include_original_trace_fields, &truncated);
        result.opentelemetry_span_log_available = true;
        result.opentelemetry_span_log_error.clear();
        result.trace_truncated = truncated;
        result.trace_spans = std::move(spans);
        if (!result.trace_spans.empty() && result.trace_spans.size() == previous_count) {
          ++stable_observations;
        } else {
          stable_observations = 0;
        }
        previous_count = result.trace_spans.size();
      } catch (const std::exception& e) {
        result.opentelemetry_span_log_error = e.what();
        break;
      }
      if ((!result.trace_spans.empty() && stable_observations >= 1) ||
          std::chrono::steady_clock::now() >= otel_deadline) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    } while (std::chrono::steady_clock::now() < otel_deadline);

    // Pipeline collection is independent of detailed trace retrieval. A failed
    // breadth-first span fetch must not suppress the smaller timing summary.
    try {
      const uint64_t activity_bucket_us = processor_trace_bucket_us(
          result.query_log, trace_lo_us, trace_hi_us, result.processors.size());
      result.processor_trace_summary = load_processor_trace_summary(
          *client, ids, trace_lo_us, trace_hi_us, activity_bucket_us,
          &result.processor_trace_summary_truncated);
      result.processor_trace_bucket_us = activity_bucket_us;
      result.processor_trace_summary_available = true;
    } catch (const std::exception& e) {
      result.processor_trace_summary_error = e.what();
    }
  }

  try {
    result.views = load_views(*client, record, ids);
    result.query_views_available = true;
  } catch (const std::exception& e) {
    result.query_views_error = e.what();
  }

  return result;
}

} // namespace chdash
