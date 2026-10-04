// Unit tests of the System page SQL builders and the disk forecast
// (src/system_monitor.cpp): no ClickHouse needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF
//          -DCHDASH_BUILD_SYSTEM_TESTS=ON
//        cmake --build build --target chdash_system_monitor_test
// Run:   ./build/chdash_system_monitor_test   (exit code 0 = every check passed)
//        ./build/chdash_system_monitor_test --print-growth-sql
//          prints the growth SQL of both metric forms (to try them on a server)
// The Python harness runs it when SYSTEM_MONITOR_TEST_BINARY points at it.

#include "system_monitor.hpp"

#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

using namespace chdash;

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                                        \
  do {                                                                                     \
    ++g_checks;                                                                            \
    if (!(cond)) {                                                                         \
      ++g_failures;                                                                        \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: " #cond << std::endl;   \
    }                                                                                      \
  } while (0)

bool contains(const std::string& text, const std::string& part) {
  return text.find(part) != std::string::npos;
}

MonitorSeriesWindow week() {
  MonitorSeriesWindow w;
  w.step_s = 3600;
  w.from_s = 1'790'000'000ULL / 3600 * 3600;
  w.to_s = w.from_s + 7 * 86400;
  w.now_s = w.to_s;
  w.span_s = 7 * 86400;
  return w;
}

const double kNaN = std::numeric_limits<double>::quiet_NaN();
const uint64_t kTiB = 1ULL << 40;
const uint64_t kGiB = 1ULL << 30;

// Hourly samples of a disk growing `per_day` bytes a day from `start`.
void hourly(size_t hours, double start, double per_day, std::vector<uint64_t>& times, std::vector<double>& used) {
  times.clear();
  used.clear();
  for (size_t i = 0; i < hours; ++i) {
    times.push_back(1'790'000'000ULL + i * 3600);
    used.push_back(start + per_day * static_cast<double>(i) / 24.0);
  }
}

void growth_sql_reads_the_legacy_names() {
  const std::string sql = monitor_disk_growth_sql(week(), {"default", "fixture_hot"}, false);
  CHECK(contains(sql, "FROM system.asynchronous_metric_log WHERE metric IN ('DiskUsed_default', 'DiskUsed_fixture_hot', 'TotalBytesOfMergeTreeTables')"));
  CHECK(contains(sql, "if(metric = 'TotalBytesOfMergeTreeTables', '', substring(toString(metric), 10)) AS disk"));
  CHECK(!contains(sql, "key"));
  CHECK(contains(sql, "GROUP BY t, disk, merge_tree ORDER BY t"));
  CHECK(contains(sql, "event_date BETWEEN toDate(toDateTime("));
  CHECK(contains(sql, "readonly = 2") && contains(sql, "read_overflow_mode = 'throw'") && contains(sql, "log_comment = 'chdash-system'"));
  // Result cap: (168 buckets + 2) x (2 disks + 1).
  CHECK(contains(sql, "max_result_rows = 510,"));
}

void growth_sql_reads_the_26_8_key_form_and_the_legacy_names() {
  const std::string sql = monitor_disk_growth_sql(week(), {"default", "fixture_hot"}, true);
  CHECK(contains(sql, "WHERE (metric = 'TotalBytesOfMergeTreeTables' OR metric IN ('DiskUsed_default', 'DiskUsed_fixture_hot') "
                      "OR (metric = 'DiskUsed' AND key IN ('default', 'fixture_hot')))"));
  CHECK(contains(sql, "if(metric = 'TotalBytesOfMergeTreeTables', '', if(metric = 'DiskUsed', toString(key), substring(toString(metric), 10))) AS disk"));
  CHECK(contains(sql, "toFloat64(max(value)) AS v"));
  // No disk listed (system.disks unreadable): the MergeTree bytes only.
  const std::string bare = monitor_disk_growth_sql(week(), {}, true);
  CHECK(contains(bare, "WHERE (metric = 'TotalBytesOfMergeTreeTables') AND"));
  CHECK(!contains(bare, "DiskUsed_") && !contains(bare, "key IN"));
}

void growth_sql_quotes_disk_names() {
  const std::string sql = monitor_disk_growth_sql(week(), {"it's", "back\\slash"}, true);
  CHECK(contains(sql, "'DiskUsed_it\\'s'"));
  CHECK(contains(sql, "key IN ('it\\'s', 'back\\\\slash')"));
  CHECK(!contains(sql, "'it's'"));
}

void usage_and_written_sql_name_the_visible_databases_only() {
  const std::string usage = monitor_disk_usage_sql({"chdash_ui", "o'brien"});
  CHECK(contains(usage, "FROM system.parts WHERE active AND database IN ('chdash_ui', 'o\\'brien') GROUP BY disk_name, database"));
  CHECK(contains(usage, "sum(sum(bytes_on_disk)) OVER (PARTITION BY disk_name)"));
  CHECK(contains(usage, "LIMIT 1001"));
  const std::string written = monitor_disk_written_sql(week(), {"chdash_ui"});
  CHECK(contains(written, "FROM system.part_log WHERE event_date BETWEEN"));
  CHECK(contains(written, "AND database IN ('chdash_ui') AND event_type IN ('NewPart', 'MovePart') GROUP BY t ORDER BY t"));
}

void disks_sql_keeps_its_columns_on_older_servers() {
  MonitorCapabilities none;
  none.detected = true;
  const std::string bare = monitor_disks_sql(none);
  CHECK(contains(bare, "SELECT toString(name), toString(path), toString(free_space), toString(total_space), '', '', '', '', '', '', '', '', '' FROM system.disks"));
  MonitorCapabilities all = none;
  for (const char* column : {"unreserved_space", "keep_free_space", "type", "object_storage_type", "cache_path", "is_read_only", "is_broken", "is_encrypted", "is_remote"}) {
    all.columns.insert(std::string("disks.") + column);
  }
  const std::string full = monitor_disks_sql(all);
  CHECK(contains(full, "toString(`unreserved_space`), toString(`keep_free_space`), toString(`type`)"));
  CHECK(contains(full, "ORDER BY name LIMIT 201"));
  const std::string policies = monitor_storage_policies_sql(none);
  CHECK(contains(policies, "FROM system.storage_policies ORDER BY policy_name, volume_priority LIMIT 501"));
}

void trend_needs_enough_history() {
  std::vector<uint64_t> times;
  std::vector<double> used;
  // Five hourly points: too few.
  hourly(5, 100.0 * kGiB, 10.0 * kGiB, times, used);
  CHECK(monitor_disk_trend(times, used, kTiB, 2 * kTiB).status == "not_enough_history");
  // Many points over 15 minutes (a fresh server): too short.
  times.clear();
  used.clear();
  for (size_t i = 0; i < 90; ++i) {
    times.push_back(1'790'000'000ULL + i * 10);
    used.push_back(100.0 * kGiB + static_cast<double>(i) * kGiB);
  }
  const auto fresh = monitor_disk_trend(times, used, kTiB, 2 * kTiB);
  CHECK(fresh.status == "not_enough_history");
  CHECK(!fresh.days_until_full);
  // Missing buckets do not count.
  hourly(48, 100.0 * kGiB, 10.0 * kGiB, times, used);
  for (size_t i = 0; i < 44; ++i) used[i] = kNaN;
  const auto sparse = monitor_disk_trend(times, used, kTiB, 2 * kTiB);
  CHECK(sparse.status == "not_enough_history" && sparse.points == 4);
}

void trend_forecasts_a_growing_disk() {
  std::vector<uint64_t> times;
  std::vector<double> used;
  // 10 GiB a day for a week, 100 GiB free: 10 days.
  hourly(168, 500.0 * kGiB, 10.0 * kGiB, times, used);
  const auto trend = monitor_disk_trend(times, used, 100 * kGiB, 2 * kTiB);
  CHECK(trend.status == "growing");
  CHECK(trend.points == 168 && trend.span_s == 167 * 3600);
  CHECK(std::fabs(trend.slope_bytes_per_day - 10.0 * kGiB) < 1e-6 * kGiB);
  CHECK(trend.days_until_full && std::fabs(*trend.days_until_full - 10.0) < 1e-6);
}

void trend_does_not_extrapolate_a_flat_or_falling_disk() {
  std::vector<uint64_t> times;
  std::vector<double> used;
  hourly(168, 500.0 * kGiB, 0.0, times, used);
  const auto flat = monitor_disk_trend(times, used, 100 * kGiB, 2 * kTiB);
  CHECK(flat.status == "not_growing" && !flat.days_until_full);
  hourly(168, 500.0 * kGiB, -5.0 * kGiB, times, used);
  const auto falling = monitor_disk_trend(times, used, 100 * kGiB, 2 * kTiB);
  CHECK(falling.status == "not_growing" && !falling.days_until_full && falling.slope_bytes_per_day < 0);
  // Noise of a few KiB on a 2 TiB disk: flat.
  hourly(168, 500.0 * kGiB, 1024.0, times, used);
  CHECK(monitor_disk_trend(times, used, 100 * kGiB, 2 * kTiB).status == "not_growing");
}

void trend_without_capacity_says_so() {
  std::vector<uint64_t> times;
  std::vector<double> used;
  hourly(168, 500.0 * kGiB, 10.0 * kGiB, times, used);
  const auto trend = monitor_disk_trend(times, used, 0, 0);
  CHECK(trend.status == "no_capacity" && !trend.days_until_full);
}

MonitorQueriesRequest queries_request() {
  MonitorQueriesRequest r;
  r.from_s = 1'790'000'000ULL / 60 * 60;
  r.to_s = r.from_s + 3600;
  r.now_s = r.to_s;
  r.system_user = "chdash_system";
  r.max_rows = 50'000'000;
  return r;
}

// System > Queries: the user filter is a bound parameter, never SQL text;
// sorts and error filters are fixed clauses; the caps stay.
void queries_user_filter_is_a_bound_parameter() {
  for (const std::string& user : {std::string("o'brien"), std::string("back\\slash"), std::string("x' OR '1'='1"),
                                 std::string("\\' OR 1 --"), std::string("{chdash_user:String}")}) {
    MonitorQueriesRequest r = queries_request();
    r.user = user;
    for (const std::string& sql : {monitor_queries_top_sql(r), monitor_queries_text_sql(r, {42, 7})}) {
      CHECK(contains(sql, " AND user = {chdash_user:String}"));
      // The value never reaches the text (the last case is the placeholder itself).
      if (user != "{chdash_user:String}") CHECK(!contains(sql, user));
      CHECK(!contains(sql, "brien") && !contains(sql, "slash") && !contains(sql, "OR '1'"));
      CHECK(contains(sql, "readonly = 2") && contains(sql, "timeout_overflow_mode = 'throw'") &&
            contains(sql, "read_overflow_mode = 'throw'") && contains(sql, "result_overflow_mode = 'throw'") &&
            contains(sql, "log_comment = 'chdash-system'") && contains(sql, "max_rows_to_read = 50000000"));
    }
    const auto params = monitor_queries_params(r);
    CHECK(params.size() == 1 && params[0].first == "chdash_user" && params[0].second == user);
    CHECK(monitor_queries_user_valid(user));
  }
  MonitorQueriesRequest all = queries_request();
  CHECK(!contains(monitor_queries_top_sql(all), "chdash_user") && monitor_queries_params(all).empty());
  // The shape's own reads show every run: no user filter there.
  MonitorQueriesRequest drill = queries_request();
  drill.user = "o'brien";
  drill.hash = 42;
  drill.step_s = 60;
  for (const std::string& sql : {monitor_query_timeline_sql(drill), monitor_query_runs_sql(drill), monitor_query_example_sql(drill)}) {
    CHECK(!contains(sql, "chdash_user") && !contains(sql, "brien"));
  }
  CHECK(!monitor_queries_user_valid(""));
  CHECK(!monitor_queries_user_valid("a\nb") && !monitor_queries_user_valid(std::string("a\0b", 3)) && !monitor_queries_user_valid("tab\there"));
  CHECK(monitor_queries_user_valid(std::string(256, 'u')) && !monitor_queries_user_valid(std::string(257, 'u')));
}

// System > Queries: the database and table filters are bound parameters
// in a HAVING (a shape is kept whole when one of its runs involved them),
// never SQL text; the window lists name the databases and tables.
void queries_database_and_table_filters_are_bound_parameters() {
  for (const std::string& value : {std::string("o'brien"), std::string("back\\slash"), std::string("x' OR '1'='1"),
                                  std::string("{chdash_table:String}")}) {
    MonitorQueriesRequest r = queries_request();
    r.database = value;
    r.table = value + ".my.table";
    r.errors = "with";
    for (const std::string& sql : {monitor_queries_top_sql(r), monitor_queries_text_sql(r, {42, 7})}) {
      CHECK(contains(sql, "countIf(has(databases, {chdash_database:String})) > 0"));
      CHECK(contains(sql, "countIf(has(tables, {chdash_table:String})) > 0"));
      if (value.find('{') == std::string::npos) CHECK(!contains(sql, value));
      CHECK(!contains(sql, "brien") && !contains(sql, "slash") && !contains(sql, "OR '1'") && !contains(sql, "my.table"));
    }
    // The error filter joins the same HAVING (the list only).
    CHECK(contains(monitor_queries_top_sql(r), " HAVING countIf(type != 'QueryFinish') > 0 AND countIf(has(databases, "));
    CHECK(contains(monitor_queries_text_sql(r, {42}), " GROUP BY normalized_query_hash HAVING countIf(has(databases, "));
    const auto params = monitor_queries_params(r);
    CHECK(params.size() == 2 && params[0].first == "chdash_database" && params[0].second == value &&
          params[1].first == "chdash_table" && params[1].second == value + ".my.table");
    CHECK(monitor_queries_database_valid(value) && monitor_queries_table_valid(value + ".my.table"));
  }
  MonitorQueriesRequest all = queries_request();
  const std::string top = monitor_queries_top_sql(all);
  CHECK(!contains(top, "chdash_database") && !contains(top, "chdash_table") && monitor_queries_params(all).empty());
  CHECK(contains(top, "AS window_databases") && contains(top, "AS window_tables"));
  // The shape's own reads show every run: no database or table filter there.
  MonitorQueriesRequest drill = queries_request();
  drill.database = "chdash_ui";
  drill.table = "chdash_ui.weather_observations";
  drill.hash = 42;
  drill.step_s = 60;
  for (const std::string& sql : {monitor_query_timeline_sql(drill), monitor_query_runs_sql(drill), monitor_query_example_sql(drill)}) {
    CHECK(!contains(sql, "chdash_database") && !contains(sql, "chdash_table"));
  }
  CHECK(!monitor_queries_database_valid("") && !monitor_queries_database_valid("a\nb") && !monitor_queries_database_valid(std::string(513, 'd')));
  CHECK(monitor_queries_database_valid(std::string(512, 'd')) && monitor_queries_database_valid("with.dot"));
  CHECK(!monitor_queries_table_valid("nodot") && !monitor_queries_table_valid(".t") && !monitor_queries_table_valid("db.") &&
        !monitor_queries_table_valid("db.t\x01") && monitor_queries_table_valid("db.t") && monitor_queries_table_valid("db.a.b"));
}

void queries_order_and_error_filters_are_fixed_clauses() {
  const std::vector<std::pair<std::string, std::string>> sorts{
    {"calls", "count()"}, {"total_time", "sum(query_duration_ms)"}, {"avg", "avg(query_duration_ms)"},
    {"p95", "quantileTDigest(0.95)(query_duration_ms)"}, {"max", "max(query_duration_ms)"},
    {"errors", "countIf(type != 'QueryFinish')"}, {"read_rows", "sum(read_rows)"}, {"read_bytes", "sum(read_bytes)"},
    {"max_memory", "max(memory_usage)"}};
  CHECK(monitor_queries_sorts().size() == sorts.size());
  for (const auto& [sort, expression] : sorts) {
    MonitorQueriesRequest r = queries_request();
    r.sort = sort;
    CHECK(contains(monitor_queries_top_sql(r), " ORDER BY " + expression + " DESC, normalized_query_hash LIMIT 50"));
  }
  const std::vector<std::string> filters{"all", "with", "without"};
  CHECK(monitor_queries_error_filters() == filters);
  MonitorQueriesRequest r = queries_request();
  CHECK(contains(monitor_queries_top_sql(r), "GROUP BY normalized_query_hash ORDER BY "));
  r.errors = "with";
  CHECK(contains(monitor_queries_top_sql(r), "GROUP BY normalized_query_hash HAVING countIf(type != 'QueryFinish') > 0 ORDER BY "));
  r.errors = "without";
  CHECK(contains(monitor_queries_top_sql(r), "GROUP BY normalized_query_hash HAVING countIf(type != 'QueryFinish') = 0 ORDER BY "));
  // The users of the window: one window function over the same read.
  CHECK(contains(monitor_queries_top_sql(r), "sumMap(sumMap([toString(user)], [toUInt64(1)])) OVER () AS window_users"));
  CHECK(contains(monitor_queries_top_sql(r), "arrayZip(window_users.1, window_users.2)), 1, 50)"));
}

} // namespace

int main(int argc, char** argv) {
  if (argc > 1 && std::strcmp(argv[1], "--print-growth-sql") == 0) {
    std::cout << monitor_disk_growth_sql(week(), {"default", "fixture_hot"}, false) << "\n";
    std::cout << monitor_disk_growth_sql(week(), {"default", "fixture_hot"}, true) << "\n";
    return 0;
  }
  growth_sql_reads_the_legacy_names();
  growth_sql_reads_the_26_8_key_form_and_the_legacy_names();
  growth_sql_quotes_disk_names();
  usage_and_written_sql_name_the_visible_databases_only();
  disks_sql_keeps_its_columns_on_older_servers();
  trend_needs_enough_history();
  trend_forecasts_a_growing_disk();
  trend_does_not_extrapolate_a_flat_or_falling_disk();
  trend_without_capacity_says_so();
  queries_user_filter_is_a_bound_parameter();
  queries_database_and_table_filters_are_bound_parameters();
  queries_order_and_error_filters_are_fixed_clauses();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
