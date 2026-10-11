#include "system_queries.hpp"

#include "ch_block_numeric.hpp"
#include "ch_executor.hpp"
#include "system_monitor_internal.hpp"

#include <clickhouse/exceptions.h>

#include <algorithm>
#include <cmath>
#include <functional>
#include <unordered_map>

namespace chdash {

using namespace monitor_internal;

// ---------------------------------------------------------------------------
// Queries: top query shapes and one shape's drill-down, read from
// system.query_log with the runner account.

namespace {

// Time budgets (proposal step 6, 3.3): phase 1 groups the whole window.
constexpr int kQueriesAggregateSeconds = 15;
constexpr int kQueriesTextSeconds = 10;
constexpr int kQueriesDrillSeconds = 10;
// The window-too-large estimate reads the key columns of the last hour only.
constexpr int kQueriesEstimateSeconds = 5;
constexpr uint64_t kQueriesEstimateRowsCap = 10'000'000;
// Phase 1 keeps at most this many distinct shapes (memory bound); past it a
// new shape is not counted, and the answer says so (totals.shapes_capped).
constexpr uint64_t kQueriesMaxShapes = 1000000;
const char* const kQueriesGroupBySettings =
    ", max_rows_to_group_by = 1000000, group_by_overflow_mode = 'any', max_bytes_before_external_group_by = 0";

// Finished or failed initial queries: every query also logs a QueryStart
// row, and a distributed query's sub-queries are not counted twice.
const char* const kQueryLogRows =
    " AND type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart') AND is_initial_query";

// The ORDER BY of each allowlisted sort (always descending).
const std::vector<std::pair<std::string, std::string>>& queries_sort_expressions() {
  static const std::vector<std::pair<std::string, std::string>> sorts{
    {"total_time", "sum(query_duration_ms)"},
    {"calls", "count()"},
    {"avg", "avg(query_duration_ms)"},
    {"p95", "quantileTDigest(0.95)(query_duration_ms)"},
    {"max", "max(query_duration_ms)"},
    {"errors", "countIf(type != 'QueryFinish')"},
    {"read_rows", "sum(read_rows)"},
    {"read_bytes", "sum(read_bytes)"},
    {"max_memory", "max(memory_usage)"},
  };
  return sorts;
}

const std::string& expression_of(const std::vector<std::pair<std::string, std::string>>& table, const std::string& id) {
  for (const auto& [key, expression] : table) {
    if (key == id) return expression;
  }
  return table.front().second;
}

// The HAVING of each allowlisted error filter: a shape is kept or dropped as
// a whole (its calls and error share stay whole).
const std::vector<std::pair<std::string, std::string>>& queries_error_expressions() {
  static const std::vector<std::pair<std::string, std::string>> filters{
    {"all", ""},
    {"with", " HAVING countIf(type != 'QueryFinish') > 0"},
    {"without", " HAVING countIf(type != 'QueryFinish') = 0"},
  };
  return filters;
}

// The user, database and table filters' query parameters: bound by
// ClickHouse, never spliced.
const char* const kQueriesUserParam = "chdash_user";
const char* const kQueriesDatabaseParam = "chdash_database";
const char* const kQueriesTableParam = "chdash_table";

// The HAVING of the list: the error filter and the database / table a
// shape involves (one of its runs did: the shape is kept whole).
std::string queries_having_sql(const MonitorQueriesRequest& r, bool with_errors) {
  std::vector<std::string> conditions;
  if (with_errors) {
    const std::string& errors = expression_of(queries_error_expressions(), r.errors);
    if (!errors.empty()) conditions.push_back(errors.substr(std::string(" HAVING ").size()));
  }
  if (!r.database.empty()) conditions.push_back(std::string("countIf(has(databases, {") + kQueriesDatabaseParam + ":String})) > 0");
  if (!r.table.empty()) conditions.push_back(std::string("countIf(has(tables, {") + kQueriesTableParam + ":String})) > 0");
  std::string sql;
  for (const std::string& condition : conditions) sql += (sql.empty() ? " HAVING " : " AND ") + condition;
  return sql;
}

// A window list of query_log's array column `column` (databases, tables):
// the names and how many runs involved each, the most involved first,
// kMonitorQueryObjectCandidates at most, one "name\tcount" per line.
std::string queries_object_list_sql(const std::string& column, const std::string& alias) {
  return "sumMap(sumMap(arrayMap(x -> toString(x), " + column + "), arrayMap(x -> toUInt64(1), " + column + "))) OVER () AS " + alias + ", "
         "arrayStringConcat(arrayMap(x -> concat(replaceAll(replaceAll(x.1, '\\t', ' '), '\\n', ' '), '\\t', toString(x.2)), "
         "arraySlice(arrayReverseSort(x -> x.2, arrayZip(" + alias + ".1, " + alias + ".2)), 1, " +
         std::to_string(kMonitorQueryObjectCandidates) + ")), '\\n')";
}

const std::vector<std::pair<std::string, std::string>>& query_run_order_expressions() {
  static const std::vector<std::pair<std::string, std::string>> orders{
    {"duration", "query_duration_ms"},
    {"latest", "event_time_microseconds"},
    {"memory", "memory_usage"},
  };
  return orders;
}

std::string queries_time_predicate(const MonitorQueriesRequest& r) {
  const std::string from = "toDateTime(" + std::to_string(r.from_s) + ")";
  const std::string to = "toDateTime(" + std::to_string(r.to_s) + ")";
  return "event_date BETWEEN toDate(" + from + ") AND toDate(" + to + ") AND event_time >= " + from + " AND event_time < " + to;
}

// The rows a shape counts: the window's finished or failed initial queries,
// never the System page's own reads; with hide_chdash not the system
// account's either, nor the other reads that ChDash writes itself (their
// log_comment starts with 'chdash:', ch_query.hpp); the kind when the list is
// filtered by one.
// with_list_filters: the list's own filters too (the kind and the user; a
// shape's page shows every run of the shape).
std::string queries_filter_sql(const MonitorQueriesRequest& r, bool with_list_filters) {
  std::string sql = queries_time_predicate(r) + kQueryLogRows + " AND log_comment != 'chdash-system'";
  if (r.hide_chdash) {
    sql += " AND NOT startsWith(log_comment, 'chdash:')";
    if (!r.system_user.empty()) sql += " AND user != " + quote_string(r.system_user);
  }
  if (with_list_filters) {
    if (r.kind == "Select") sql += " AND query_kind = 'Select'";
    else if (r.kind == "Insert") sql += " AND query_kind = 'Insert'";
    else if (r.kind == "other") sql += " AND query_kind NOT IN ('Select', 'Insert')";
    if (!r.user.empty()) sql += std::string(" AND user = {") + kQueriesUserParam + ":String}";
  }
  return sql;
}

double f64(const std::string& value) {
  const auto parsed = finite(value);
  return parsed ? *parsed : 0.0;
}

int64_t i64(const std::string& value) {
  try {
    size_t pos = 0;
    const long long parsed = std::stoll(value, &pos, 10);
    return pos == value.size() ? static_cast<int64_t>(parsed) : 0;
  } catch (...) {
    return 0;
  }
}

// Runs one Queries SELECT, its rows read, bytes and time kept in `read`.
void read_query_log(ChExecutor& runner, const std::string& sql, MonitorQueryRead& read,
                    const std::function<void(const clickhouse::Block&)>& on_block,
                    const std::vector<std::pair<std::string, std::string>>& params = {}) {
  const auto started = std::chrono::steady_clock::now();
  try {
    const BoundedRead result = runner.bounded_select(sql, on_block, params);
    read.rows_read = result.read_rows;
    read.bytes_read = result.read_bytes;
    read.elapsed_ms = result.elapsed_ms;
  } catch (...) {
    read.elapsed_ms = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count());
    throw;
  }
}

// Why a Queries SELECT failed, in the answer's terms; for a read past the
// cap, the span that would fit (estimated from the last hour's rows).
template <typename Answer>
void queries_failed(ChExecutor& runner, const MonitorQueriesRequest& r, const clickhouse::ServerException& error,
                    Answer& out, MonitorQueryRead& read) {
  out.status = monitor_reason_of(error);
  out.message = error.what();
  read.status = out.status;
  read.message = out.message;
  if (out.status == "not_granted") out.hint = monitor_grant_hint("query_log", r.runner_user, "runner user");
  if (out.status != "window_too_large") return;
  uint64_t rows = 0;
  try {
    const uint64_t since = r.now_s > 3600 ? r.now_s - 3600 : 0;
    const std::string sql = "SELECT toString(count()) FROM system.query_log WHERE event_date >= toDate(toDateTime(" +
                            std::to_string(since) + ")) AND event_time >= toDateTime(" + std::to_string(since) + ")" +
                            monitor_settings_sql(kQueriesEstimateSeconds, std::max(r.max_rows, kQueriesEstimateRowsCap), 1);
    runner.select(sql, [&](const clickhouse::Block& block) {
      if (block.GetRowCount() > 0) rows = u64(text(block, 0, 0));
    });
  } catch (const clickhouse::ServerException&) {
    rows = 0;
  }
  out.suggested_span_s = monitor_queries_suggested_span(r.to_s > r.from_s ? r.to_s - r.from_s : 0, rows, r.max_rows);
}

} // namespace

const std::vector<std::string>& monitor_queries_sorts() {
  static const std::vector<std::string> names = [] {
    std::vector<std::string> out;
    for (const auto& item : queries_sort_expressions()) out.push_back(item.first);
    return out;
  }();
  return names;
}

const std::vector<std::string>& monitor_queries_kinds() {
  static const std::vector<std::string> names{"all", "Select", "Insert", "other"};
  return names;
}

const std::vector<std::string>& monitor_queries_error_filters() {
  static const std::vector<std::string> names = [] {
    std::vector<std::string> out;
    for (const auto& item : queries_error_expressions()) out.push_back(item.first);
    return out;
  }();
  return names;
}

namespace {

bool plain_text(const std::string& value, size_t max_bytes) {
  if (value.empty() || value.size() > max_bytes) return false;
  for (const char ch : value) {
    const auto c = static_cast<unsigned char>(ch);
    if (c < 0x20 || c == 0x7f) return false;
  }
  return true;
}

// The (name, count) lines of a window list.
std::vector<std::pair<std::string, uint64_t>> counted_lines(const std::string& value) {
  std::vector<std::pair<std::string, uint64_t>> out;
  for (const std::string& line : split_lines(value)) {
    const size_t tab = line.rfind('\t');
    if (tab == std::string::npos || tab == 0) continue;
    out.emplace_back(line.substr(0, tab), u64(line.substr(tab + 1)));
  }
  return out;
}

} // namespace

bool monitor_queries_database_valid(const std::string& database) {
  return plain_text(database, kMonitorQueryObjectMaxBytes);
}

bool monitor_queries_table_valid(const std::string& table) {
  if (!plain_text(table, kMonitorQueryObjectMaxBytes)) return false;
  const size_t dot = table.find('.');
  return dot != std::string::npos && dot > 0 && dot + 1 < table.size();
}

bool monitor_queries_user_valid(const std::string& user) {
  if (user.empty() || user.size() > kMonitorQueryUserMaxBytes) return false;
  for (const char ch : user) {
    const auto c = static_cast<unsigned char>(ch);
    if (c < 0x20 || c == 0x7f) return false;
  }
  return true;
}

std::vector<std::pair<std::string, std::string>> monitor_queries_params(const MonitorQueriesRequest& r) {
  std::vector<std::pair<std::string, std::string>> params;
  if (!r.user.empty()) params.emplace_back(kQueriesUserParam, r.user);
  if (!r.database.empty()) params.emplace_back(kQueriesDatabaseParam, r.database);
  if (!r.table.empty()) params.emplace_back(kQueriesTableParam, r.table);
  return params;
}

const std::vector<std::string>& monitor_query_run_orders() {
  static const std::vector<std::string> names = [] {
    std::vector<std::string> out;
    for (const auto& item : query_run_order_expressions()) out.push_back(item.first);
    return out;
  }();
  return names;
}

uint64_t monitor_queries_suggested_span(uint64_t span_s, uint64_t rows_last_hour, uint64_t max_rows) {
  static const uint64_t spans[] = {60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 3 * 86400};
  uint64_t fit = span_s / 2;
  if (rows_last_hour > 0 && max_rows > 0) {
    // Four fifths of the cap, at the last hour's rate.
    const double seconds = static_cast<double>(max_rows) * 0.8 / (static_cast<double>(rows_last_hour) / 3600.0);
    fit = std::min<uint64_t>(fit, seconds >= 1e12 ? fit : static_cast<uint64_t>(seconds));
  }
  uint64_t best = spans[0];
  for (const uint64_t span : spans) {
    if (span <= fit) best = span;
  }
  return best;
}

std::string monitor_queries_top_sql(const MonitorQueriesRequest& r) {
  return "SELECT toString(normalized_query_hash), toString(any(query_kind)), toString(count()), "
         "toString(countIf(type != 'QueryFinish')), toString(sum(query_duration_ms)), toString(avg(query_duration_ms)), "
         "toString(quantileTDigest(0.95)(query_duration_ms)), toString(max(query_duration_ms)), "
         "toString(sum(read_rows)), toString(sum(read_bytes)), toString(sum(written_rows)), toString(sum(result_rows)), "
         "toString(avg(memory_usage)), toString(max(memory_usage)), "
         "arrayStringConcat(arrayMap(x -> replaceAll(toString(x), '\\n', ' '), groupUniqArray(5)(user)), '\\n'), "
         "arrayStringConcat(arrayMap(x -> replaceAll(toString(x), '\\n', ' '), groupUniqArrayArray(8)(tables)), '\\n'), "
         "toString(toUnixTimestamp(min(event_time))), toString(toUnixTimestamp(max(event_time))), "
         // The window's totals over every shape: window functions run after
         // the GROUP BY and before the LIMIT.
         "toString(sum(count()) OVER ()), toString(sum(countIf(type != 'QueryFinish')) OVER ()), "
         "toString(sum(sum(query_duration_ms)) OVER ()), toString(sum(sum(read_bytes)) OVER ()), toString(count() OVER ()), "
         // The window's users and their query counts (the user filter's
         // choices), the most active first: one more window function over
         // the same rows, no second read.
         "sumMap(sumMap([toString(user)], [toUInt64(1)])) OVER () AS window_users, "
         "arrayStringConcat(arrayMap(x -> concat(replaceAll(replaceAll(x.1, '\\t', ' '), '\\n', ' '), '\\t', toString(x.2)), "
         "arraySlice(arrayReverseSort(x -> x.2, arrayZip(window_users.1, window_users.2)), 1, " + std::to_string(kMonitorQueryUsers) +
         ")), '\\n'), "
         // The databases and tables the window's rows involved (their
         // filters' choices), the same way.
         + queries_object_list_sql("databases", "window_databases") + ", " + queries_object_list_sql("tables", "window_tables") +
         " FROM system.query_log WHERE " + queries_filter_sql(r, true) +
         " GROUP BY normalized_query_hash" + queries_having_sql(r, true) +
         " ORDER BY " + expression_of(queries_sort_expressions(), r.sort) +
         " DESC, normalized_query_hash LIMIT " + std::to_string(kMonitorTopQueries) +
         monitor_settings_sql(kQueriesAggregateSeconds, r.max_rows, kMonitorTopQueries + 1) + kQueriesGroupBySettings;
}

std::string monitor_queries_text_sql(const MonitorQueriesRequest& r, const std::vector<uint64_t>& hashes) {
  std::string list;
  for (const uint64_t hash : hashes) {
    if (!list.empty()) list += ", ";
    list += std::to_string(hash);
  }
  const std::string chars = std::to_string(kMonitorQueryTextChars);
  // The key column first (PREWHERE): the text is read only for the granules
  // of the listed shapes.
  return "SELECT toString(normalized_query_hash), substringUTF8(argMax(query, event_time), 1, " + chars + ") AS example, "
         "normalizeQuery(example), toString(lengthUTF8(argMax(query, event_time)) > " + chars + "), "
         "toString(argMax(query_id, event_time)) FROM system.query_log PREWHERE normalized_query_hash IN (" + list + ") WHERE " +
         queries_filter_sql(r, true) + " GROUP BY normalized_query_hash" + queries_having_sql(r, false) +
         monitor_settings_sql(kQueriesTextSeconds, r.max_rows, kMonitorTopQueries + 1);
}

std::string monitor_query_timeline_sql(const MonitorQueriesRequest& r) {
  const std::string step = std::to_string(std::max<uint32_t>(1, r.step_s));
  const uint64_t buckets = r.step_s ? (r.to_s - r.from_s) / r.step_s + 2 : 2;
  return "SELECT toUInt64(toUnixTimestamp(toStartOfInterval(event_time, INTERVAL " + step + " SECOND))) AS t, "
         "toString(count()), toString(countIf(type != 'QueryFinish')), "
         "quantilesTDigest(0.5, 0.95)(query_duration_ms) AS latency_ms, toString(latency_ms[1]), toString(latency_ms[2]), "
         "toString(sum(read_rows)), toString(max(memory_usage)), "
         "toString(sum(ProfileEvents['OSCPUVirtualTimeMicroseconds']) / 1e6), "
         // The whole window (window functions over the buckets; the p95
         // merges the buckets' digests).
         "toString(sum(count()) OVER ()), toString(sum(countIf(type != 'QueryFinish')) OVER ()), "
         "toString(sum(sum(query_duration_ms)) OVER ()), "
         "toString(quantileTDigestMerge(0.95)(quantileTDigestState(query_duration_ms)) OVER ()), "
         "toString(max(max(query_duration_ms)) OVER ()), toString(sum(sum(read_rows)) OVER ()), "
         "toString(sum(sum(read_bytes)) OVER ()), toString(max(max(memory_usage)) OVER ()), "
         "toString(sum(sum(ProfileEvents['OSCPUVirtualTimeMicroseconds'])) OVER () / 1e6) "
         "FROM system.query_log PREWHERE normalized_query_hash = " + std::to_string(r.hash) + " WHERE " +
         queries_filter_sql(r, false) + " GROUP BY t ORDER BY t" +
         monitor_settings_sql(kQueriesDrillSeconds, r.max_rows, buckets);
}

std::string monitor_query_runs_sql(const MonitorQueriesRequest& r) {
  return "SELECT toString(toUnixTimestamp64Milli(event_time_microseconds)), toString(query_id), toString(user), toString(type), "
         "toString(query_duration_ms), toString(read_rows), toString(read_bytes), toString(result_rows), toString(written_rows), "
         "toString(memory_usage), toString(ProfileEvents['OSCPUVirtualTimeMicroseconds']), toString(exception_code), "
         "substringUTF8(exception, 1, 512) "
         "FROM system.query_log PREWHERE normalized_query_hash = " + std::to_string(r.hash) + " WHERE " +
         queries_filter_sql(r, false) + " ORDER BY " + expression_of(query_run_order_expressions(), r.order) +
         " DESC, event_time_microseconds DESC LIMIT " + std::to_string(kMonitorQueryRuns) +
         monitor_settings_sql(kQueriesDrillSeconds, r.max_rows, kMonitorQueryRuns + 1);
}

std::string monitor_query_example_sql(const MonitorQueriesRequest& r) {
  const std::string chars = std::to_string(kMonitorQueryExampleChars);
  return "SELECT substringUTF8(query, 1, " + chars + ") AS example, toString(lengthUTF8(query) > " + chars + "), "
         "toString(query_id), normalizeQuery(example), toString(query_kind) "
         "FROM system.query_log PREWHERE normalized_query_hash = " + std::to_string(r.hash) + " WHERE " +
         queries_filter_sql(r, false) + " ORDER BY event_time_microseconds DESC LIMIT 1" +
         monitor_settings_sql(kQueriesDrillSeconds, r.max_rows, 2);
}

bool load_system_monitor_queries(ChExecutor& runner, AclView& runner_acl, const MonitorCapabilities& caps,
                                   const MonitorQueriesRequest& request, SystemMonitorQueries& out, std::string* error) {
  out = SystemMonitorQueries{};
  out.generated_at_ms = monitor_now_ms();
  out.request = request;
  if (!caps.has_table("query_log")) {
    out.status = "disabled";
    out.message = "system.query_log does not exist on this server.";
    return true;
  }

  // Phase 1: the narrow numbers of every shape, the top ones kept.
  try {
    read_query_log(runner, monitor_queries_top_sql(request), out.aggregate, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        if (out.queries.size() >= kMonitorTopQueries) continue;
        if (out.queries.empty()) {
          out.users = counted_lines(text(block, 24, row));
          out.databases = counted_lines(text(block, 26, row));
          out.tables = counted_lines(text(block, 28, row));
        }
        MonitorQueryShape shape;
        shape.hash = u64(text(block, 0, row));
        shape.kind = text(block, 1, row);
        shape.calls = u64(text(block, 2, row));
        shape.errors = u64(text(block, 3, row));
        shape.total_ms = f64(text(block, 4, row));
        shape.avg_ms = f64(text(block, 5, row));
        shape.p95_ms = f64(text(block, 6, row));
        shape.max_ms = f64(text(block, 7, row));
        shape.read_rows = u64(text(block, 8, row));
        shape.read_bytes = u64(text(block, 9, row));
        shape.written_rows = u64(text(block, 10, row));
        shape.result_rows = u64(text(block, 11, row));
        shape.avg_memory = f64(text(block, 12, row));
        shape.max_memory = u64(text(block, 13, row));
        shape.users = split_lines(text(block, 14, row));
        shape.tables = split_lines(text(block, 15, row));
        shape.first_seen_s = u64(text(block, 16, row));
        shape.last_seen_s = u64(text(block, 17, row));
        out.totals.calls = u64(text(block, 18, row));
        out.totals.errors = u64(text(block, 19, row));
        out.totals.total_ms = f64(text(block, 20, row));
        out.totals.read_bytes = u64(text(block, 21, row));
        out.totals.shapes = u64(text(block, 22, row));
        out.totals.shapes_capped = out.totals.shapes >= kQueriesMaxShapes;
        out.queries.push_back(std::move(shape));
      }
    }, monitor_queries_params(request));
  } catch (const clickhouse::ServerException& e) {
    out.queries.clear();
    out.users.clear();
    out.databases.clear();
    out.tables.clear();
    out.totals = MonitorQueriesTotals{};
    queries_failed(runner, request, e, out, out.aggregate);
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
  // The database and table choices: those the runner can see (the System
  // pages' SHOW boundary), kMonitorQueryObjects at most each. A table is
  // "database.table", either name may hold dots: any split may match.
  if (!out.databases.empty() || !out.tables.empty()) {
    try {
      VisibleTables visible(runner_acl);
      const auto& databases = visible.databases();
      const auto database_visible = [&](const std::string& name) { return std::binary_search(databases.begin(), databases.end(), name); };
      std::vector<std::pair<std::string, uint64_t>> kept;
      for (auto& item : out.databases) {
        if (kept.size() < kMonitorQueryObjects && database_visible(item.first)) kept.push_back(std::move(item));
      }
      out.databases = std::move(kept);
      kept.clear();
      for (auto& item : out.tables) {
        if (kept.size() >= kMonitorQueryObjects) break;
        const std::string& name = item.first;
        bool shown = false;
        for (size_t dot = name.find('.'); dot != std::string::npos && !shown; dot = name.find('.', dot + 1)) {
          const std::string database = name.substr(0, dot);
          shown = dot > 0 && dot + 1 < name.size() && database_visible(database) && visible.visible(database, name.substr(dot + 1));
        }
        if (shown) kept.push_back(std::move(item));
      }
      out.tables = std::move(kept);
    } catch (const std::exception&) {
      // Without the runner's boundary, no choice is offered.
      out.databases.clear();
      out.tables.clear();
    }
  }
  if (out.queries.empty()) return true;

  // Phase 2: the text of those shapes only (the last run's, cut).
  std::vector<uint64_t> hashes;
  std::unordered_map<uint64_t, size_t> index;
  for (size_t i = 0; i < out.queries.size(); ++i) {
    hashes.push_back(out.queries[i].hash);
    index.emplace(out.queries[i].hash, i);
  }
  try {
    read_query_log(runner, monitor_queries_text_sql(request, hashes), out.text, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const auto it = index.find(u64(text(block, 0, row)));
        if (it == index.end()) continue;
        MonitorQueryShape& shape = out.queries[it->second];
        shape.has_text = true;
        shape.example = text(block, 1, row);
        shape.normalized = text(block, 2, row);
        shape.example_truncated = flag(text(block, 3, row));
        shape.last_query_id = text(block, 4, row);
      }
    }, monitor_queries_params(request));
  } catch (const clickhouse::ServerException& e) {
    // The numbers stand; the list names the shapes by hash.
    out.text.status = monitor_reason_of(e);
    out.text.message = e.what();
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
  return true;
}

bool load_system_monitor_query(ChExecutor& runner, const MonitorCapabilities& caps,
                                 const MonitorQueriesRequest& request, SystemMonitorQuery& out, std::string* error) {
  out = SystemMonitorQuery{};
  out.generated_at_ms = monitor_now_ms();
  out.request = request;
  if (!caps.has_table("query_log")) {
    out.status = "disabled";
    out.message = "system.query_log does not exist on this server.";
    return true;
  }
  const uint32_t step = std::max<uint32_t>(1, request.step_s);
  const size_t count = static_cast<size_t>((request.to_s - request.from_s) / step);
  out.buckets.reserve(count);
  for (size_t i = 0; i < count; ++i) out.buckets.push_back(request.from_s + i * step);
  static const char* const kSeries[] = {"calls", "errors", "p50_ms", "p95_ms", "read_rows", "max_memory", "cpu_seconds"};
  for (const char* name : kSeries) out.series[name].assign(count, std::nan(""));

  try {
    read_query_log(runner, monitor_query_timeline_sql(request), out.timeline_read, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const uint64_t t = ch_block_u64_at(block, 0, row);
        if (t < request.from_s || (t - request.from_s) % step != 0) continue;
        const size_t i = static_cast<size_t>((t - request.from_s) / step);
        if (i >= count) continue;
        // Columns: t, calls, errors, latency_ms (the array), p50, p95,
        // read_rows, max_memory, cpu_seconds.
        out.series["calls"][i] = f64(text(block, 1, row));
        out.series["errors"][i] = f64(text(block, 2, row));
        out.series["p50_ms"][i] = f64(text(block, 4, row));
        out.series["p95_ms"][i] = f64(text(block, 5, row));
        out.series["read_rows"][i] = f64(text(block, 6, row));
        out.series["max_memory"][i] = f64(text(block, 7, row));
        out.series["cpu_seconds"][i] = f64(text(block, 8, row));
        MonitorQuerySummary& s = out.summary;
        s.calls = u64(text(block, 9, row));
        s.errors = u64(text(block, 10, row));
        s.total_ms = f64(text(block, 11, row));
        s.p95_ms = f64(text(block, 12, row));
        s.max_ms = f64(text(block, 13, row));
        s.read_rows = u64(text(block, 14, row));
        s.read_bytes = u64(text(block, 15, row));
        s.max_memory = u64(text(block, 16, row));
        s.cpu_seconds = f64(text(block, 17, row));
      }
    });
  } catch (const clickhouse::ServerException& e) {
    out.series.clear();
    out.buckets.clear();
    queries_failed(runner, request, e, out, out.timeline_read);
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }

  try {
    read_query_log(runner, monitor_query_runs_sql(request), out.runs_read, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        if (out.runs.size() >= kMonitorQueryRuns) continue;
        MonitorQueryRun run;
        run.event_time_ms = u64(text(block, 0, row));
        run.query_id = text(block, 1, row);
        run.user = text(block, 2, row);
        run.type = text(block, 3, row);
        run.duration_ms = u64(text(block, 4, row));
        run.read_rows = u64(text(block, 5, row));
        run.read_bytes = u64(text(block, 6, row));
        run.result_rows = u64(text(block, 7, row));
        run.written_rows = u64(text(block, 8, row));
        run.memory_usage = u64(text(block, 9, row));
        run.cpu_us = u64(text(block, 10, row));
        run.exception_code = i64(text(block, 11, row));
        run.exception = text(block, 12, row);
        out.runs.push_back(std::move(run));
      }
    });
  } catch (const clickhouse::ServerException& e) {
    out.runs.clear();
    out.runs_read.status = monitor_reason_of(e);
    out.runs_read.message = e.what();
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }

  try {
    read_query_log(runner, monitor_query_example_sql(request), out.example_read, [&](const clickhouse::Block& block) {
      if (block.GetRowCount() == 0 || !out.example_query_id.empty()) return;
      out.example = text(block, 0, 0);
      out.example_truncated = flag(text(block, 1, 0));
      out.example_query_id = text(block, 2, 0);
      out.normalized = text(block, 3, 0);
      out.kind = text(block, 4, 0);
    });
  } catch (const clickhouse::ServerException& e) {
    out.example_read.status = monitor_reason_of(e);
    out.example_read.message = e.what();
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
  return true;
}

} // namespace chdash
