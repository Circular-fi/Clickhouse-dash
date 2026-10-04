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
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
