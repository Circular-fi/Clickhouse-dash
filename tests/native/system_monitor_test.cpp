// Unit tests of the System page below its routes (no ClickHouse needed): the SQL builders and the disk forecast of every section
// (src/system_overview.cpp, system_series.cpp, system_queries.cpp, system_disks.cpp), the Activity and the Keeper status
// (src/system_activity.cpp), the parsing of a request (src/system_request.cpp), the JSON (src/system_json.cpp), and the service on a fake
// executor with a fake ACL source (src/system_service.cpp).
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF
//          -DCHDASH_BUILD_SYSTEM_TESTS=ON
//        cmake --build build --target chdash_system_monitor_test
// Run:   ./build/chdash_system_monitor_test   (exit code 0 = every check passed)
//        ./build/chdash_system_monitor_test --print-growth-sql
//          prints the growth SQL of both metric forms (to try them on a server)
// The Python harness runs it when SYSTEM_MONITOR_TEST_BINARY points at it.

#include "acl_service.hpp"
#include "fake_executor.hpp"
#include "native_check.hpp"
#include "system_activity.hpp"
#include "system_disks.hpp"
#include "system_json.hpp"
#include "system_monitor.hpp"
#include "system_overview.hpp"
#include "system_queries.hpp"
#include "system_request.hpp"
#include "system_series.hpp"
#include "system_service.hpp"

#include <httplib.h>
#include <rapidjson/document.h>

#include <clickhouse/exceptions.h>

#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using namespace chdash;

namespace {

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
  const std::vector<std::string> names = {"chdash_ui", "o'brien", "back\\slash"};
  const std::string list = monitor_databases_list(names);
  CHECK(list == "{p1:String}, {p2:String}, {p3:String}");
  const std::string usage = monitor_disk_usage_sql(list);
  CHECK(contains(usage, "FROM system.parts WHERE active AND database IN ({p1:String}, {p2:String}, {p3:String}) GROUP BY disk_name, database"));
  // The names are one String parameter each, never SQL text, and a quote mark or a backslash stays as it is.
  const ChParams params = monitor_databases_params(names);
  CHECK(params.size() == 3);
  CHECK(params[0].first == "p1" && params[0].second == "chdash_ui");
  CHECK(params[1].first == "p2" && params[1].second == "o'brien");
  CHECK(params[2].first == "p3" && params[2].second == "back\\slash");
  CHECK(!contains(usage, "o'brien") && !contains(usage, "slash"));
  CHECK(contains(usage, "sum(sum(bytes_on_disk)) OVER (PARTITION BY disk_name)"));
  CHECK(contains(usage, "LIMIT 1001"));
  const std::string written = monitor_disk_written_sql(week(), list);
  CHECK(contains(written, "FROM system.part_log WHERE event_date BETWEEN"));
  CHECK(contains(written, "AND database IN ({p1:String}, {p2:String}, {p3:String}) AND event_type IN ('NewPart', 'MovePart') GROUP BY t ORDER BY t"));
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

// ---------------------------------------------------------------------------
// The service, the Activity, the request and the JSON on fakes.

using nt::FakeDb;
using nt::ForwardDb;
using nt::Rows;
using nt::server_error;
using namespace chdash::system_page;

// A fake identity of the runner: databases and their tables, each readable ("all") or not ("none"). `down` makes every statement fail as a lost
// connection does.
struct FakeAcl : AclSource {
  std::map<std::string, std::map<std::string, std::string>> objects;
  bool down = false;

  void check() const {
    if (down) throw std::runtime_error("connection reset by peer");
  }
  std::vector<std::string> show_databases() override {
    check();
    std::vector<std::string> out;
    for (const auto& item : objects) out.push_back(item.first);
    return out;
  }
  std::vector<std::string> show_objects(const std::string& database) override {
    check();
    std::vector<std::string> out;
    for (const auto& item : objects[database]) out.push_back(item.first);
    return out;
  }
  std::optional<bool> check_grant(const std::string& expression) override {
    check();
    const auto on = expression.find(" ON `");
    const std::string target = expression.substr(on + 4);
    const auto end = target.find('`', 1);
    const std::string database = target.substr(1, end - 1);
    if (target.compare(end + 1, 2, ".*") == 0) return false;
    const auto table_end = target.find('`', end + 3);
    const std::string table = target.substr(end + 3, table_end - end - 3);
    const auto db = objects.find(database);
    if (db == objects.end()) return false;
    const auto it = db->second.find(table);
    return it != db->second.end() && it->second == "all";
  }
  // A zero-row SELECT of one object: refused when the runner reads none of it.
  void probe(const std::string& sql) override {
    check();
    const auto from = sql.find(" FROM `");
    const std::string target = sql.substr(from + 6);
    const auto end = target.find('`', 1);
    const std::string database = target.substr(1, end - 1);
    const auto table_end = target.find('`', end + 3);
    const std::string table = target.substr(end + 3, table_end - end - 3);
    const auto db = objects.find(database);
    if (db == objects.end() || db->second.find(table) == db->second.end() || db->second.at(table) != "all") throw AclDenied("Not enough privileges");
  }
  std::vector<std::string> describe_columns(const std::string&, const std::string&) override {
    check();
    return {"a"};
  }
};

struct FakeSystem {
  std::shared_ptr<FakeAcl> acl = std::make_shared<FakeAcl>();
  AclService::Options options = [] {
    AclService::Options o;
    o.stale_for = std::chrono::milliseconds(0);
    return o;
  }();
  AclService service{options};
  AclAccess access = [this] {
    AclAccess a;
    a.key = acl_identity_key("clickhouse://runner@h:9000");
    a.connect = [this](std::string*) -> std::unique_ptr<AclSource> { return std::make_unique<FakeAcl>(*acl); };
    return a;
  }();
};

HostSpec system_host() {
  HostSpec host;
  host.id = "local";
  host.runner_uri = "clickhouse://runner_account@clickhouse:9000";
  host.system_uri = "clickhouse://system_account@clickhouse:9000";
  return host;
}

// The caches of a service, with the options of the tests (no background refresh: a stale answer is read again).
struct SystemTestCaches {
  TtlCache<std::string, MonitorCapabilities> capabilities{TtlCache<std::string, MonitorCapabilities>::Options{}};
  TtlCache<std::string, SystemMonitorOverview> overview{TtlCache<std::string, SystemMonitorOverview>::Options{}};
  TtlCache<std::string, SystemMonitorSeries> series{TtlCache<std::string, SystemMonitorSeries>::Options{}};
  TtlCache<std::string, SystemMonitorQueries> queries{TtlCache<std::string, SystemMonitorQueries>::Options{}};
  TtlCache<std::string, SystemMonitorQuery> query{TtlCache<std::string, SystemMonitorQuery>::Options{}};
  TtlCache<std::string, SystemMonitorDisks> disks{TtlCache<std::string, SystemMonitorDisks>::Options{}};
  TtlCache<std::string, SystemMonitorDiskGrowth> growth{TtlCache<std::string, SystemMonitorDiskGrowth>::Options{}};
  TtlCache<std::string, SystemActivity> activity{TtlCache<std::string, SystemActivity>::Options{}};
  TtlCache<std::string, SystemKeeperStatus> keeper{TtlCache<std::string, SystemKeeperStatus>::Options{}};
  SystemCaches refs() { return SystemCaches{capabilities, overview, series, queries, query, disks, growth, activity, keeper}; }
};

struct ServiceRig {
  FakeDb system, runner;
  FakeSystem acl;
  SystemTestCaches caches;
  SystemSettings settings;
  bool system_up = true, runner_up = true;
  int counts_asked = 0;
  std::vector<std::pair<std::string, std::string>> counted_tables;
  std::unique_ptr<SystemService> service;

  ServiceRig() {
    SystemService::Ports ports;
    ports.system = [this](const HostSpec&, std::string* error) -> std::unique_ptr<ChExecutor> {
      if (!system_up) {
        if (error) *error = "";
        return nullptr;
      }
      return std::make_unique<ForwardDb>(system);
    };
    ports.runner = [this](const HostSpec&, std::string* error) -> std::unique_ptr<ChExecutor> {
      if (!runner_up) {
        if (error) *error = "runner cannot connect";
        return nullptr;
      }
      return std::make_unique<ForwardDb>(runner);
    };
    ports.runner_access = [this](const HostSpec&) { return acl.access; };
    ports.replica_counts = [this](ChExecutor&, const std::vector<std::pair<std::string, std::string>>& tables) {
      ++counts_asked;
      counted_tables = tables;
      std::unordered_map<std::string, SystemReplicaCounts> out;
      for (const auto& [database, table] : tables) out[database + std::string(1, '\0') + table] = SystemReplicaCounts{3, 2};
      return out;
    };
    service = std::make_unique<SystemService>(std::move(ports), caches.refs(), acl.service);
  }

  // The capability detection: the system account is `system_account`, every optional log exists, no versioned column.
  void with_capabilities() {
    system.on("SELECT toString(currentUser())", {{"system_account"}});
    system.on("FROM system.tables WHERE database = 'system'",
              {{"query_log"}, {"metric_log"}, {"asynchronous_metric_log"}, {"part_log"}, {"zookeeper_connection"}, {"clusters"}});
    system.on("FROM system.columns WHERE database = 'system'", {{"metric_log", "ProfileEvent_Query"}, {"metric_log", "ProfileEvent_QueryTimeMicroseconds"},
                                                                  {"metric_log", "CurrentMetric_Query"}});
    system.on("toString(count() > 0) FROM system.replicas", {{"0"}});
  }
};

rapidjson::Document parse_json(const std::string& text) {
  rapidjson::Document doc;
  doc.Parse(text.c_str());
  CHECK(!doc.HasParseError());
  return doc;
}

httplib::Request make_request(std::initializer_list<std::pair<const char*, const char*>> params) {
  httplib::Request req;
  req.method = "GET";
  for (const auto& [name, value] : params) req.params.emplace(name, value);
  return req;
}

// ---- the request ----

const uint64_t kNow = 1'791'700'000'000ULL;

void a_request_that_names_the_host_only() {
  HostRequest host;
  ApiError error;
  CHECK(parse_host_request(make_request({{"host_id", "local"}, {"refresh", "1"}}), &host, &error));
  CHECK_EQ(host.host_id, std::string("local"));
  CHECK(host.refresh);
  CHECK(parse_host_request(make_request({{"host_id", "local"}, {"refresh", "yes"}}), &host, &error) && !host.refresh);
  CHECK(!parse_host_request(make_request({}), &host, &error));
  CHECK_EQ(error.status, 400);
  CHECK_EQ(error.code, std::string("missing_host_id"));
  CHECK(!parse_host_request(make_request({{"host_id", "local"}, {"x", "1"}}), &host, &error));
  CHECK_EQ(error.code, std::string("unknown_parameter"));
  CHECK_EQ(error.message, std::string("Unknown parameter: x."));
  // The unknown parameter is refused before the host is looked at.
  CHECK(!parse_host_request(make_request({{"x", "1"}}), &host, &error));
  CHECK_EQ(error.code, std::string("unknown_parameter"));
}

void the_window_of_the_series() {
  SystemSettings settings;
  SeriesRequest series;
  ApiError error;
  const std::string to = std::to_string(kNow - 600'000), from = std::to_string(kNow - 600'000 - 3'600'000);
  CHECK(parse_series_request(make_request({{"host_id", "local"}, {"from_ms", from.c_str()}, {"to_ms", to.c_str()}}), settings, kNow, &series, &error));
  CHECK(!series.growth);
  CHECK_EQ(series.window.step_s, 30u);
  // The window is aligned to the step, outward.
  CHECK_EQ(series.window.from_s % 30, uint64_t(0));
  CHECK(series.window.from_s * 1000 <= series.from_ms && series.window.to_s * 1000 >= series.to_ms);
  CHECK_EQ(series.window.span_s, uint64_t(3600));
  CHECK_EQ(series.window.now_s, kNow / 1000);
  CHECK_EQ(series.window.query_log_max_span_s, uint64_t(7 * 24 * 3600));
  CHECK_EQ(series.window.query_log_max_rows, uint64_t(50'000'000));
  // No window: the last default_lookback_minutes, or system.disk_growth_days for the growth.
  CHECK(parse_series_request(make_request({{"host_id", "local"}}), settings, kNow, &series, &error));
  CHECK_EQ(series.to_ms, kNow);
  CHECK_EQ(series.from_ms, kNow - 60 * 60'000ULL);
  CHECK(parse_series_request(make_request({{"host_id", "local"}, {"panel", "disk_growth"}}), settings, kNow, &series, &error));
  CHECK(series.growth);
  CHECK_EQ(series.from_ms, kNow - 7 * 86'400'000ULL);
  // A window that ends in the future ends now.
  const std::string future = std::to_string(kNow + 5'000'000);
  const std::string before_future = std::to_string(kNow - 7'200'000);
  CHECK(parse_series_request(make_request({{"host_id", "local"}, {"from_ms", before_future.c_str()}, {"to_ms", future.c_str()}}), settings, kNow, &series, &error));
  CHECK_EQ(series.to_ms, kNow);
  // The default window of a window that ends in the future is before it, so it is empty and refused.
  CHECK(!parse_series_request(make_request({{"host_id", "local"}, {"to_ms", future.c_str()}}), settings, kNow, &series, &error));
  CHECK_EQ(error.code, std::string("invalid_range"));
  // What a window must be.
  const auto refused = [&](std::initializer_list<std::pair<const char*, const char*>> params) {
    ApiError e;
    CHECK(!parse_series_request(make_request(params), settings, kNow, &series, &e));
    return e;
  };
  CHECK_EQ(refused({{"host_id", "local"}, {"panel", "x"}}).code, std::string("invalid_panel"));
  CHECK_EQ(refused({{"host_id", "local"}, {"scope", "x"}}).code, std::string("invalid_scope"));
  CHECK_EQ(refused({{"host_id", "local"}, {"scope", "cluster"}}).code, std::string("cluster_fanout_disabled"));
  settings.cluster_fanout = true;
  const ApiError unsupported = refused({{"host_id", "local"}, {"scope", "cluster"}});
  CHECK_EQ(unsupported.status, 501);
  CHECK_EQ(unsupported.code, std::string("cluster_scope_unsupported"));
  settings.cluster_fanout = false;
  CHECK_EQ(refused({{"host_id", "local"}, {"from_ms", "x"}}).code, std::string("invalid_range"));
  CHECK_EQ(refused({{"host_id", "local"}, {"to_ms", "-5"}}).code, std::string("invalid_range"));
  CHECK_EQ(refused({{"host_id", "local"}, {"from_ms", "1e3"}}).message, std::string("from_ms must be a whole number of milliseconds."));
  CHECK_EQ(refused({{"host_id", "local"}, {"from_ms", to.c_str()}, {"to_ms", from.c_str()}}).message, std::string("from_ms must be before to_ms (and before now)."));
  const ApiError huge = refused({{"host_id", "local"}, {"from_ms", "1000"}, {"to_ms", to.c_str()}});
  CHECK_EQ(huge.code, std::string("range_too_large"));
  CHECK_EQ(huge.message, std::string("The window is wider than 30 days (system.max_lookback_days)."));
}

void the_filters_of_the_queries() {
  SystemSettings settings;
  QueriesRequest queries;
  ApiError error;
  const std::string to = std::to_string(kNow - 600'000), from = std::to_string(kNow - 600'000 - 3'600'000);
  CHECK(parse_queries_request(make_request({{"host_id", "local"}, {"from_ms", from.c_str()}, {"to_ms", to.c_str()}, {"sort", "calls"}, {"kind", "Select"},
                                           {"errors", "with"}, {"user", "o'brien"}, {"database", "system"}, {"table", "system.query_log"},
                                           {"hide_chdash", "0"}}), settings, kNow, &queries, &error));
  const MonitorQueriesRequest& q = queries.query;
  CHECK_EQ(q.sort, std::string("calls"));
  CHECK_EQ(q.kind, std::string("Select"));
  CHECK_EQ(q.errors, std::string("with"));
  CHECK_EQ(q.user, std::string("o'brien"));
  CHECK_EQ(q.table, std::string("system.query_log"));
  CHECK(!q.hide_chdash);
  // Aligned to the minute, outward.
  CHECK_EQ(q.from_s % 60, uint64_t(0));
  CHECK_EQ(q.to_s % 60, uint64_t(0));
  CHECK(q.from_s * 1000 <= queries.from_ms && q.to_s * 1000 >= queries.to_ms);
  CHECK_EQ(q.max_rows, uint64_t(50'000'000));
  // The defaults.
  CHECK(parse_queries_request(make_request({{"host_id", "local"}}), settings, kNow, &queries, &error));
  CHECK_EQ(queries.query.sort, std::string("total_time"));
  CHECK(queries.query.hide_chdash);
  const auto refused = [&](std::initializer_list<std::pair<const char*, const char*>> params) {
    ApiError e;
    CHECK(!parse_queries_request(make_request(params), settings, kNow, &queries, &e));
    return e;
  };
  CHECK_EQ(refused({{"host_id", "local"}, {"sort", "x"}}).message,
           std::string("sort must be one of total_time, calls, avg, p95, max, errors, read_rows, read_bytes, max_memory."));
  CHECK_EQ(refused({{"host_id", "local"}, {"kind", "x"}}).code, std::string("invalid_kind"));
  CHECK_EQ(refused({{"host_id", "local"}, {"errors", "x"}}).code, std::string("invalid_errors"));
  CHECK_EQ(refused({{"host_id", "local"}, {"user", "a\nb"}}).code, std::string("invalid_user"));
  CHECK_EQ(refused({{"host_id", "local"}, {"database", "a\tb"}}).code, std::string("invalid_database"));
  CHECK_EQ(refused({{"host_id", "local"}, {"table", "nodot"}}).code, std::string("invalid_table"));
  CHECK_EQ(refused({{"host_id", "local"}, {"hide_chdash", "2"}}).code, std::string("invalid_hide_chdash"));
  CHECK_EQ(refused({{"host_id", "local"}, {"q", "1"}}).code, std::string("unknown_parameter"));
  CHECK_EQ(refused({{"host_id", "local"}, {"from_ms", "1000"}}).code, std::string("range_too_large"));
  settings.query_log_max_lookback_hours = 1;
  CHECK_EQ(refused({{"host_id", "local"}, {"from_ms", std::to_string(kNow - 7'200'000).c_str()}}).message,
           std::string("The window is wider than 1 hours (system.query_log_max_lookback_hours)."));

  // One shape.
  QueryRequest query;
  settings = SystemSettings{};
  CHECK(parse_query_request(make_request({{"host_id", "local"}, {"order", "memory"}, {"hide_chdash", "0"}}), "18446744073709551615", settings, kNow, &query, &error));
  CHECK_EQ(query.query.hash, uint64_t(18446744073709551615ULL));
  CHECK_EQ(query.query.order, std::string("memory"));
  CHECK(!query.query.hide_chdash);
  CHECK_EQ(query.query.step_s, 30u);
  CHECK(query.query.step_s > 0 && query.query.from_s % query.query.step_s == 0);
  CHECK(!parse_query_request(make_request({{"host_id", "local"}}), "18446744073709551616", settings, kNow, &query, &error));
  CHECK_EQ(error.code, std::string("invalid_hash"));
  CHECK(!parse_query_request(make_request({{"host_id", "local"}}), "abc", settings, kNow, &query, &error));
  CHECK(!parse_query_request(make_request({{"host_id", "local"}}), "", settings, kNow, &query, &error));
  CHECK(!parse_query_request(make_request({{"host_id", "local"}, {"order", "x"}}), "5", settings, kNow, &query, &error));
  CHECK_EQ(error.message, std::string("order must be one of duration, latest, memory."));
  CHECK(!parse_query_request(make_request({{"host_id", "local"}, {"sort", "calls"}}), "5", settings, kNow, &query, &error));
  CHECK_EQ(error.code, std::string("unknown_parameter"));
  uint64_t value = 0;
  CHECK(parse_ms("0", value) && value == 0);
  CHECK(!parse_ms("", value) && !parse_ms("12 ", value) && !parse_ms("12345678901234567", value));
  CHECK(parse_hash("0", value) && value == 0);
}

// ---- the JSON ----

void a_series_is_written_to_six_digits_and_a_size_keeps_all_of_them() {
  CHECK_EQ(series_number(0.1234567), std::string("0.123457"));
  CHECK_EQ(series_number(12345.6789), std::string("12345.7"));
  CHECK_EQ(series_number(0), std::string("0"));
  CHECK_EQ(series_number(-0.5), std::string("-0.5"));
  CHECK_EQ(series_number(999999.4), std::string("999999"));
  // From a million up, the whole number: a size in bytes is not rounded.
  CHECK_EQ(series_number(1000000), std::string("1000000"));
  CHECK_EQ(series_number(123456789012.0), std::string("123456789012"));
  CHECK_EQ(series_number(123456789012.5), std::string("123456789013"));
  CHECK_EQ(series_number(-2500000000.0), std::string("-2500000000"));
  CHECK_EQ(series_number(1099511627776.0 + 4096), std::string("1099511631872"));
  CHECK_EQ(series_number(NAN), std::string("null"));
  CHECK_EQ(series_number(INFINITY), std::string("null"));
  // Past what a double keeps whole, the six digits.
  CHECK_EQ(series_number(1e300), std::string("1e+300"));
  // A series of the answer: the numbers parse back to the value.
  SystemMonitorSeries series;
  series.window.from_s = 1000;
  series.window.to_s = 1090;
  series.window.step_s = 30;
  series.buckets = {1000, 1030, 1060};
  series.series["memory_resident"] = {123456789012.0, NAN, 0.000123456789};
  series.sources["metric_log"].table = "metric_log";
  SeriesRequest request;
  request.from_ms = 1'000'000;
  request.to_ms = 1'090'000;
  const rapidjson::Document doc = parse_json(series_json("local", request, series, false, SystemSettings{}));
  CHECK_EQ(doc["series"]["memory_resident"][0].GetInt64(), int64_t{123456789012});
  CHECK(doc["series"]["memory_resident"][1].IsNull());
  CHECK_EQ(doc["series"]["memory_resident"][2].GetDouble(), 0.000123457);
  CHECK_EQ(std::string(doc["panel"].GetString()), std::string("performance"));
  CHECK_EQ(doc["limits"]["max_points"].GetUint64(), kMonitorSeriesMaxPoints);
  CHECK_EQ(doc["timestamps"][1].GetUint64(), uint64_t{1030000});
  CHECK_EQ(doc["requested"]["to_ms"].GetUint64(), uint64_t{1090000});
}

// ---- the statements ----

void the_average_query_time_counts_the_queries_that_ended() {
  MonitorCapabilities caps;
  caps.detected = true;
  for (const char* column : {"ProfileEvent_Query", "ProfileEvent_QueryTimeMicroseconds", "CurrentMetric_Query"}) caps.columns.insert(std::string("metric_log.") + column);
  MonitorSeriesWindow window = week();
  window.step_s = 60;
  std::vector<std::string> names, missing;
  const std::string sql = monitor_series_metric_log_sql(caps, window, &names, &missing);
  // The time is added when a query ends: the queries of the bucket are the ones that started in it, less the growth of the running ones.
  CHECK(contains(sql, "toFloat64(sum(ProfileEvent_QueryTimeMicroseconds) / greatest(sum(ProfileEvent_Query) + "
                      "lagInFrame(argMax(CurrentMetric_Query, event_time), 1, argMax(CurrentMetric_Query, event_time)) OVER (ORDER BY t) - "
                      "argMax(CurrentMetric_Query, event_time), 1) / 1000) AS avg_query_ms"));
  CHECK(std::find(names.begin(), names.end(), "avg_query_ms") != names.end());
  CHECK(missing.size() == 26);
  // A server that does not log the running queries cannot give it.
  MonitorCapabilities no_gauge = caps;
  no_gauge.columns.erase("metric_log.CurrentMetric_Query");
  names.clear();
  missing.clear();
  monitor_series_metric_log_sql(no_gauge, window, &names, &missing);
  CHECK(std::find(missing.begin(), missing.end(), "avg_query_ms") != missing.end());
}

void the_hint_names_the_account_that_did_the_read() {
  CHECK_EQ(monitor_grant_hint("query_log", "runner"), std::string("GRANT SELECT ON system.query_log TO runner"));
  CHECK_EQ(monitor_grant_hint("query_log", "o'k r"), std::string("GRANT SELECT ON system.query_log TO `o'k r`"));
  CHECK_EQ(monitor_grant_hint("query_log", ""), std::string("GRANT SELECT ON system.query_log TO <system user>"));
  CHECK_EQ(monitor_grant_hint("query_log", "", "runner user"), std::string("GRANT SELECT ON system.query_log TO <runner user>"));
  CHECK_EQ(monitor_grant_hint("query_log", "a`b"), std::string("GRANT SELECT ON system.query_log TO `a\\`b`"));

  // The Queries read as the runner: the hint names it, not the system account that the capability detection found.
  FakeDb db;
  FakeSystem acl;
  acl.acl->objects["app"] = {{"t", "all"}};
  db.fail_on("FROM system.query_log", [] { throw server_error(497, "Not enough privileges"); });
  MonitorCapabilities caps;
  caps.detected = true;
  caps.tables.insert("query_log");
  caps.system_user = "system_account";
  MonitorQueriesRequest request;
  request.from_s = 1000;
  request.to_s = 2000;
  request.now_s = 3000;
  request.runner_user = "runner_account";
  SystemMonitorQueries queries;
  AclView view(acl.service, acl.access);
  std::string error;
  CHECK(load_system_monitor_queries(db, view, caps, request, queries, &error));
  CHECK_EQ(queries.status, std::string("not_granted"));
  CHECK_EQ(queries.hint, std::string("GRANT SELECT ON system.query_log TO runner_account"));
  CHECK_EQ(queries.aggregate.status, std::string("not_granted"));
  request.runner_user = "";
  CHECK(load_system_monitor_queries(db, view, caps, request, queries, &error));
  CHECK_EQ(queries.hint, std::string("GRANT SELECT ON system.query_log TO <runner user>"));
  SystemMonitorQuery one;
  request.hash = 5;
  request.runner_user = "runner_account";
  CHECK(load_system_monitor_query(db, caps, request, one, &error));
  CHECK_EQ(one.hint, std::string("GRANT SELECT ON system.query_log TO runner_account"));

  // The other panels read as the system account.
  FakeDb system;
  system.fail_on("FROM system.clusters", [] { throw server_error(497, "Not enough privileges"); });
  SystemMonitorOverview overview;
  CHECK(load_system_monitor_overview(system, view, caps, overview, &error));
  CHECK(!overview.unavailable_panels.empty());
  CHECK_EQ(overview.unavailable_panels[0].panel, std::string("topology"));
  CHECK_EQ(overview.unavailable_panels[0].hint, std::string("GRANT SELECT ON system.clusters TO system_account"));
}

// ---- the Activity ----

// A row of a section, read by the columns that its SELECT names: the database and the table, then `cells` empty ones.
Rows activity_rows(const std::string& database, const std::string& table, size_t count, size_t columns) {
  Rows rows;
  for (size_t i = 0; i < count; ++i) {
    nt::Row row(columns, "0");
    row[0] = database;
    row[1] = table + std::to_string(i);
    rows.push_back(std::move(row));
  }
  return rows;
}

void a_full_read_is_cut_even_when_the_runner_sees_few_of_its_rows() {
  FakeDb db;
  FakeSystem acl;
  // The runner reads two tables of `app`; the rest of the rows of the server are tables that it cannot see.
  acl.acl->objects["app"] = {{"seen0", "all"}, {"seen1", "all"}, {"hidden", "none"}};
  for (int i = 0; i < 201; ++i) acl.acl->objects["big"]["t" + std::to_string(i)] = "all";
  Rows merges = activity_rows("app", "seen", 2, 13);
  for (size_t i = 0; i < 199; ++i) {
    nt::Row row(13, "0");
    row[0] = "app";
    row[1] = "hidden";
    merges.push_back(std::move(row));
  }
  CHECK_EQ(merges.size(), size_t(201));
  db.on("FROM system.merges", merges);
  // Fewer rows than the limit: nothing is cut, and the hidden one is not listed.
  Rows mutations = activity_rows("app", "seen", 1, 12);
  nt::Row hidden_mutation(12, "0");
  hidden_mutation[0] = "app";
  hidden_mutation[1] = "hidden";
  mutations.push_back(hidden_mutation);
  db.on("FROM system.mutations", mutations);
  // 201 visible rows: the old rule of the visible ones and the new one agree.
  db.on("FROM system.replicas WHERE", activity_rows("big", "t", 201, 13));
  db.fail_on("FROM system.distribution_queue", [] { throw server_error(60, "Table system.distribution_queue does not exist"); });
  db.on("FROM system.replication_queue", {});
  AclView view(acl.service, acl.access);
  int counted = 0;
  const ReplicaCountsFn counts = [&](ChExecutor&, const std::vector<std::pair<std::string, std::string>>& tables) {
    counted = static_cast<int>(tables.size());
    return std::unordered_map<std::string, SystemReplicaCounts>{};
  };
  SystemActivity activity;
  std::string error;
  CHECK(load_system_activity(db, counts, view, 200, activity, &error));
  // The merges: the 201 rows that were read were all that there was to look at, and the runner sees two of them.
  CHECK_EQ(activity.merges.size(), size_t(2));
  CHECK(std::find(activity.truncated_sections.begin(), activity.truncated_sections.end(), "merges") != activity.truncated_sections.end());
  // The mutations: the read was not full.
  CHECK_EQ(activity.mutations.size(), size_t(1));
  CHECK(std::find(activity.truncated_sections.begin(), activity.truncated_sections.end(), "mutations") == activity.truncated_sections.end());
  CHECK(std::find(activity.truncated_sections.begin(), activity.truncated_sections.end(), "replicas") != activity.truncated_sections.end());
  CHECK_EQ(activity.replicas.size(), size_t(200));
  CHECK_EQ(counted, 200);
  CHECK_EQ(activity.unavailable_sections.size(), size_t(1));
  CHECK_EQ(activity.unavailable_sections[0], std::string("distribution_queue"));
  CHECK(!activity.unavailable_detail.empty());
  // The limit of rows is in the statements: one more than the rows kept.
  CHECK_EQ(db.count("LIMIT 201"), size_t(5));
  // The names of the databases of the runner are parameters, never SQL text.
  CHECK(!db.params.empty() && !db.params[0].empty() && db.params[0][0].second == "app");

  const rapidjson::Document doc = parse_json(activity_json("local", activity, false));
  CHECK_EQ(doc["merges"].Size(), 2u);
  CHECK_EQ(doc["row_limit"].GetUint64(), uint64_t(200));
  bool found = false;
  for (const auto& section : doc["truncated_sections"].GetArray()) found = found || std::string(section.GetString()) == "merges";
  CHECK(found);
  CHECK_EQ(std::string(doc["unavailable_sections"][0].GetString()), std::string("distribution_queue"));
}

void the_activity_needs_a_readable_runner() {
  FakeDb db;
  FakeSystem acl;
  acl.acl->objects["secret"] = {{"t", "none"}};
  AclView view(acl.service, acl.access);
  SystemActivity activity;
  std::string error;
  // The runner reads nothing: no statement is sent and nothing is listed.
  CHECK(load_system_activity(db, [](ChExecutor&, const std::vector<std::pair<std::string, std::string>>&) {
    return std::unordered_map<std::string, SystemReplicaCounts>{};
  }, view, 200, activity, &error));
  CHECK(db.sqls.empty());
  CHECK(activity.merges.empty() && activity.truncated_sections.empty());
}

void the_keeper_status_reads_its_three_tables() {
  FakeDb db;
  db.on("FROM system.zookeeper_connection ORDER BY name LIMIT 16", {{"default", "zk", "2181", "0", "2026-10-11 07:00:00", "120", "0", "3", "30000"}});
  db.on("FROM system.metrics WHERE metric IN", {{"ZooKeeperSession", "1"}, {"KeeperAliveConnections", "2"}});
  db.on("FROM system.events WHERE event IN", {{"ZooKeeperTransactions", "10"}, {"ZooKeeperWaitMicroseconds", "5000"}});
  SystemKeeperStatus keeper;
  std::string error;
  CHECK(load_system_keeper_status(db, keeper, &error));
  CHECK(keeper.configured);
  CHECK_EQ(keeper.connections.size(), size_t(1));
  CHECK(keeper.connections[0].session_timeout_ms && *keeper.connections[0].session_timeout_ms == 30000);
  const rapidjson::Document doc = parse_json(keeper_json("local", keeper, true));
  CHECK(doc["stale"].GetBool() && doc["configured"].GetBool());
  CHECK_EQ(doc["average_wait_ms"].GetDouble(), 0.5);
  CHECK_EQ(doc["metrics"]["ZooKeeperSession"].GetInt64(), int64_t{1});
  // An older server has no session_timeout_ms: the rest is read.
  FakeDb older;
  older.on_fn("session_timeout_ms FROM system.zookeeper_connection", [](const std::string&) -> Rows { throw server_error(47, "Unknown identifier"); });
  older.on("FROM system.zookeeper_connection ORDER BY name LIMIT 16", {{"default", "zk", "2181", "0", "2026-10-11 07:00:00", "120", "0", "3"}});
  older.on("FROM system.metrics", {});
  older.on("FROM system.events", {});
  SystemKeeperStatus old_keeper;
  CHECK(load_system_keeper_status(older, old_keeper, &error));
  CHECK_EQ(old_keeper.connections.size(), size_t(1));
  CHECK(!old_keeper.connections[0].session_timeout_ms);
  // Nothing readable: false, with the reason.
  FakeDb none;
  none.fail_on("system.", [] { throw server_error(60, "Table does not exist"); });
  SystemKeeperStatus empty;
  CHECK(!load_system_keeper_status(none, empty, &error));
  CHECK(error.find("Keeper status is unavailable") == 0);
}

// ---- the service ----

void the_overview_is_read_once_and_again_when_asked() {
  ServiceRig rig;
  rig.with_capabilities();
  rig.acl.acl->objects["app"] = {{"t", "all"}};
  rig.system.on("toString(hostName())", {{"ch-1", "26.7.5", "UTC", "86400"}});
  rig.system.on("FROM system.asynchronous_metrics", {{"MemoryResident", "1048576"}});
  rig.system.on("FROM system.metrics WHERE metric IN", {{"Query", "3"}});
  rig.system.on("FROM system.clusters", {{"c", "1", "1", "1", "ch-1", "10.0.0.1", "9000", "1", "", "", ""}});
  rig.system.on("FROM system.replicas WHERE database IN", {{"app", "t", "0", "0", "2", "5", "1", "1", "0", "0"}});
  RequestContext context;
  HostRequest request;
  request.host_id = "local";
  const auto first = rig.service->overview(context, system_host(), request);
  CHECK(first);
  CHECK(!first.value->stale);
  CHECK_EQ(first.value->value->hostname, std::string("ch-1"));
  CHECK_EQ(first.value->value->metrics.at("Query"), 3.0);
  CHECK(first.value->value->replication && first.value->value->replication->tables == 1);
  CHECK_EQ(first.value->value->replication->queue_size, uint64_t(5));
  CHECK(first.value->value->logs.at("query_log"));
  // The capabilities are detected once, and so is the overview.
  CHECK(rig.service->overview(context, system_host(), request));
  CHECK_EQ(rig.system.count("toString(hostName())"), size_t(1));
  CHECK_EQ(rig.system.count("toString(currentUser())"), size_t(1));
  // The runner account is not used by the Overview.
  CHECK(rig.runner.sqls.empty());
  // refresh=1 reads again.
  request.refresh = true;
  CHECK(rig.service->overview(context, system_host(), request));
  CHECK_EQ(rig.system.count("toString(hostName())"), size_t(2));
  const rapidjson::Document doc = parse_json(overview_json("local", *first.value->value, first.value->stale));
  CHECK_EQ(std::string(doc["server"]["hostname"].GetString()), std::string("ch-1"));
  CHECK_EQ(doc["server"]["uptime_seconds"].GetUint64(), uint64_t(86400));
  CHECK_EQ(doc["topology"]["nodes"].Size(), 1u);
  CHECK_EQ(doc["replication"]["queue_size"].GetUint64(), uint64_t(5));
  CHECK(!doc["stale"].GetBool());
}

void a_read_without_a_connection_is_an_error_of_the_route() {
  ServiceRig rig;
  rig.system_up = false;
  RequestContext context;
  HostRequest request;
  request.host_id = "local";
  const auto overview = rig.service->overview(context, system_host(), request);
  CHECK(!overview);
  CHECK_EQ(overview.error.status, 503);
  CHECK_EQ(overview.error.code, std::string("system_context_unavailable"));
  CHECK_EQ(overview.error.message, std::string("Cannot connect to the system context."));
  CHECK_EQ(rig.service->disks(context, system_host(), request).error.code, std::string("system_context_unavailable"));
  CHECK_EQ(rig.service->activity(context, system_host(), request).error.code, std::string("system_context_unavailable"));
  CHECK_EQ(rig.service->keeper(context, system_host(), request).error.code, std::string("system_context_unavailable"));
  // The capabilities could not be detected: the panels read their base columns, and nothing is kept.
  CHECK(!rig.service->capabilities(system_host())->detected);

  ServiceRig no_runner;
  no_runner.with_capabilities();
  no_runner.runner_up = false;
  QueriesRequest queries;
  queries.host_id = "local";
  queries.query.from_s = 1000;
  queries.query.to_s = 2000;
  const auto answer = no_runner.service->queries(context, system_host(), queries);
  CHECK_EQ(answer.error.code, std::string("runner_unavailable"));
  CHECK_EQ(answer.error.message, std::string("runner cannot connect"));
  QueryRequest one;
  one.host_id = "local";
  CHECK_EQ(no_runner.service->query(context, system_host(), one).error.code, std::string("runner_unavailable"));
}

void a_failed_overview_says_why() {
  ServiceRig rig;
  rig.with_capabilities();
  rig.acl.acl->objects["app"] = {{"t", "all"}};
  // Every read of the Overview fails: nothing is readable.
  rig.system.fail_on("toString(hostName())", [] { throw server_error(497, "Not enough privileges"); });
  rig.system.fail_on("FROM system.asynchronous_metrics", [] { throw server_error(497, "Not enough privileges"); });
  rig.system.fail_on("FROM system.metrics", [] { throw server_error(497, "Not enough privileges"); });
  rig.system.fail_on("FROM system.clusters", [] { throw server_error(497, "Not enough privileges"); });
  rig.system.fail_on("FROM system.replicas WHERE", [] { throw server_error(497, "Not enough privileges"); });
  RequestContext context;
  HostRequest request;
  request.host_id = "local";
  const auto answer = rig.service->overview(context, system_host(), request);
  CHECK(!answer);
  CHECK_EQ(answer.error.status, 503);
  CHECK_EQ(answer.error.code, std::string("system_monitor_failed"));
  CHECK(answer.error.message.find("Not enough privileges") != std::string::npos);

}

void the_series_drop_a_connection_that_broke_and_keep_the_rest() {
  ServiceRig rig;
  rig.with_capabilities();
  rig.system.on("FROM system.metric_log", {});
  rig.system.on_fn("FROM system.asynchronous_metric_log", [](const std::string&) -> Rows { throw std::runtime_error("connection reset"); });
  rig.system.on("FROM system.query_log", {});
  SeriesRequest request;
  request.host_id = "local";
  request.window = week();
  request.window.step_s = 3600;
  request.window.span_s = 3600;
  request.window.query_log_max_span_s = 7 * 86400;
  request.from_ms = request.window.from_s * 1000;
  request.to_ms = request.window.to_s * 1000;
  RequestContext context;
  const auto answer = rig.service->series(context, system_host(), request);
  CHECK(answer);
  const SystemMonitorSeries& series = *answer.value->value;
  CHECK_EQ(series.sources.at("metric_log").status, std::string("ok"));
  CHECK_EQ(series.sources.at("asynchronous_metric_log").status, std::string("failed"));
  CHECK_EQ(series.buckets.size(), size_t(168));
  // The connection that broke is not lent again; the sources that read are kept.
  CHECK_EQ(rig.system.invalidated, 1);
  const rapidjson::Document doc = parse_json(series_json("local", request, series, false, rig.settings));
  CHECK_EQ(doc["sources"]["asynchronous_metric_log"]["status"].GetString(), std::string("failed"));
  CHECK_EQ(doc["unavailable_panels"].Size(), 1u);
  CHECK_EQ(std::string(doc["unavailable_panels"][0]["panel"].GetString()), std::string("asynchronous_metric_log"));
  // The same aligned window is one read.
  CHECK(rig.service->series(context, system_host(), request));
  CHECK_EQ(rig.system.count("FROM system.metric_log"), size_t(1));
  // A window wider than the lookback of query_log leaves it out, and is another key.
  request.window.span_s = 8 * 86400;
  const auto wide = rig.service->series(context, system_host(), request);
  CHECK(wide && wide.value->value->sources.at("query_log").status == "out_of_range");
}

void the_queries_are_read_as_the_runner_and_keyed_by_their_filters() {
  ServiceRig rig;
  rig.with_capabilities();
  rig.acl.acl->objects["app"] = {{"t", "all"}};
  rig.runner.fail_on("FROM system.query_log", [] { throw server_error(497, "Not enough privileges"); });
  RequestContext context;
  QueriesRequest request;
  request.host_id = "local";
  request.query.from_s = 1000;
  request.query.to_s = 2000;
  request.query.now_s = 3000;
  request.query.max_rows = 1000000;
  const auto first = rig.service->queries(context, system_host(), request);
  CHECK(first);
  // The runner account read it, and the hint names the runner: the system account is another one.
  CHECK(rig.system.count("FROM system.query_log") == 0);
  CHECK_EQ(first.value->value->status, std::string("not_granted"));
  CHECK_EQ(first.value->value->hint, std::string("GRANT SELECT ON system.query_log TO runner_account"));
  CHECK_EQ(first.value->value->request.system_user, std::string("system_account"));
  CHECK_EQ(first.value->value->request.runner_user, std::string("runner_account"));
  // The system account of the detection is kept out of the list when the chdash reads are hidden.
  CHECK(rig.runner.sqls[0].find("user != 'system_account'") != std::string::npos);
  // The same filters are one read; another user is another one.
  CHECK(rig.service->queries(context, system_host(), request));
  CHECK_EQ(rig.runner.count("FROM system.query_log"), size_t(1));
  request.query.user = "alice";
  CHECK(rig.service->queries(context, system_host(), request));
  CHECK_EQ(rig.runner.count("FROM system.query_log"), size_t(2));
  CHECK_EQ(rig.runner.params.back().back().second, std::string("alice"));
  // A user that holds the separator of the key is not another user's key.
  QueriesRequest a = request, b = request;
  a.query.user = "x";
  a.query.database = "1:y";
  b.query.user = "x1:y";
  b.query.database = "";
  CHECK(rig.service->queries(context, system_host(), a));
  CHECK(rig.service->queries(context, system_host(), b));
  CHECK_EQ(rig.runner.count("FROM system.query_log"), size_t(4));
  const rapidjson::Document doc = parse_json(queries_json("local", 1000000, 2000000, *first.value->value, false, rig.settings));
  CHECK_EQ(std::string(doc["status"].GetString()), std::string("not_granted"));
  CHECK_EQ(std::string(doc["hint"].GetString()), std::string("GRANT SELECT ON system.query_log TO runner_account"));
  CHECK_EQ(std::string(doc["unavailable_panels"][0]["table"].GetString()), std::string("query_log"));
  CHECK(doc["suggested_span_ms"].IsNull());
  CHECK_EQ(doc["limits"]["row_limit"].GetUint64(), kMonitorTopQueries);
}

void the_activity_is_the_error_of_the_acl_when_it_cannot_be_read() {
  ServiceRig rig;
  rig.acl.acl->down = true;
  RequestContext context;
  HostRequest request;
  request.host_id = "local";
  const auto answer = rig.service->activity(context, system_host(), request);
  CHECK(!answer);
  CHECK_EQ(answer.error.status, 503);
  // The ACL of the runner could not be read: its own code, and the connection is fine.
  CHECK(!answer.error.code.empty() && answer.error.code != "system_activity_failed");
  CHECK_EQ(rig.system.invalidated, 0);

  ServiceRig ok;
  ok.acl.acl->objects["app"] = {{"t", "all"}};
  ok.system.on("FROM system.merges", {});
  ok.system.on("FROM system.mutations", {});
  ok.system.on("FROM system.replication_queue", {});
  ok.system.on("FROM system.replicas", {});
  ok.system.on("FROM system.distribution_queue", {});
  const auto read = ok.service->activity(context, system_host(), request);
  CHECK(read);
  CHECK_EQ(read.value->value->row_limit, kSystemActivityRowLimit);
  // Every system table is unreadable: the route says so.
  ServiceRig none;
  none.acl.acl->objects["app"] = {{"t", "all"}};
  none.system.fail_on("system.", [] { throw server_error(60, "Table does not exist"); });
  const auto failed = none.service->activity(context, system_host(), request);
  CHECK_EQ(failed.error.code, std::string("system_activity_failed"));
  CHECK(failed.error.message.find("None of system.merges") == 0);
}

void the_disk_growth_reads_the_disks_the_series_and_the_parts() {
  ServiceRig rig;
  rig.with_capabilities();
  rig.acl.acl->objects["app"] = {{"t", "all"}};
  rig.system.on("FROM system.disks ORDER BY name LIMIT 200", {{"default", "1000", "5000"}});
  rig.system.on("FROM system.asynchronous_metric_log", {});
  rig.system.on("FROM system.part_log", {});
  SeriesRequest request;
  request.host_id = "local";
  request.growth = true;
  request.window = week();
  request.from_ms = request.window.from_s * 1000;
  request.to_ms = request.window.to_s * 1000;
  RequestContext context;
  const auto answer = rig.service->disk_growth(context, system_host(), request);
  CHECK(answer);
  CHECK_EQ(answer.value->value->disks.size(), size_t(1));
  CHECK_EQ(answer.value->value->disks[0].trend.status, std::string("not_enough_history"));
  // The part log is read for the databases of the runner, as parameters.
  CHECK(rig.system.params.back().size() == 1 && rig.system.params.back()[0].second == "app");
  const rapidjson::Document doc = parse_json(growth_json("local", request, *answer.value->value, false, rig.settings));
  CHECK_EQ(std::string(doc["panel"].GetString()), std::string("disk_growth"));
  CHECK_EQ(std::string(doc["disk_metric_form"].GetString()), std::string("names"));
  CHECK_EQ(std::string(doc["disks"][0]["trend"]["status"].GetString()), std::string("not_enough_history"));
  CHECK(doc["disks"][0]["trend"]["slope_bytes_per_day"].IsNull());
  CHECK_EQ(doc["limits"]["trend_min_points"].GetUint64(), kMonitorDiskTrendMinPoints);
  // The growth is kept per aligned window.
  CHECK(rig.service->disk_growth(context, system_host(), request));
  CHECK_EQ(rig.system.count("FROM system.disks ORDER BY name LIMIT 200"), size_t(1));
}

void the_disks_and_their_json() {
  ServiceRig rig;
  rig.with_capabilities();
  rig.acl.acl->objects["app"] = {{"t", "all"}};
  // name, path, free, total, then the optional columns that this server does not have
  rig.system.on("FROM system.disks ORDER BY name LIMIT 201", {{"default", "/var/lib/clickhouse", "1000", "5000", "", "", "local", "", "", "", "", "", ""}});
  rig.system.on("FROM system.storage_policies", {{"default", "main", "1", "default", "", "", "", "", "", ""}});
  rig.system.on("FROM system.parts WHERE active", {{"default", "app", "4000", "10", "2", "1", "4000", "2", "1"}});
  HostRequest request;
  request.host_id = "local";
  RequestContext context;
  const auto answer = rig.service->disks(context, system_host(), request);
  CHECK(answer);
  const rapidjson::Document doc = parse_json(disks_json("local", *answer.value->value, false, rig.settings));
  CHECK_EQ(doc["disks"].Size(), 1u);
  CHECK_EQ(doc["disks"][0]["used_space"].GetUint64(), uint64_t(4000));
  CHECK_EQ(std::string(doc["disks"][0]["policies"][0]["policy"].GetString()), std::string("default"));
  CHECK_EQ(doc["usage"]["rows"].Size(), 1u);
  CHECK_EQ(doc["usage"]["disks"]["default"]["bytes"].GetUint64(), uint64_t(4000));
  CHECK_EQ(doc["limits"]["disk_row_limit"].GetUint64(), kMonitorDiskRowLimit);
}

void one_shape_reads_the_runner_and_is_keyed_by_its_hash() {
  ServiceRig rig;
  rig.with_capabilities();
  rig.runner.on("FROM system.query_log PREWHERE normalized_query_hash = 77 WHERE", {});
  QueryRequest request;
  request.host_id = "local";
  request.query.hash = 77;
  request.query.step_s = 60;
  request.query.from_s = 1020;
  request.query.to_s = 1200;
  request.query.now_s = 3000;
  request.query.order = "latest";
  request.query.max_rows = 100000;
  RequestContext context;
  const auto answer = rig.service->query(context, system_host(), request);
  CHECK(answer);
  CHECK_EQ(answer.value->value->buckets.size(), size_t(3));
  CHECK(rig.runner.count("PREWHERE normalized_query_hash = 77") == 3);
  CHECK(rig.system.count("normalized_query_hash") == 0);
  CHECK(rig.service->query(context, system_host(), request));
  CHECK_EQ(rig.runner.count("PREWHERE normalized_query_hash = 77"), size_t(3));
  request.query.order = "memory";
  CHECK(rig.service->query(context, system_host(), request));
  CHECK_EQ(rig.runner.count("PREWHERE normalized_query_hash = 77"), size_t(6));
  const rapidjson::Document doc = parse_json(query_json("local", 1020000, 1200000, *answer.value->value, false, rig.settings));
  CHECK_EQ(std::string(doc["hash"].GetString()), std::string("77"));
  CHECK_EQ(doc["step_seconds"].GetUint64(), uint64_t(60));
  CHECK_EQ(doc["timestamps"].Size(), 3u);
}

} // namespace

std::string reason_of_code(int code) {
  auto exception = std::make_shared<clickhouse::Exception>();
  exception->code = code;
  exception->name = "DB::Exception";
  return monitor_reason_of(clickhouse::ServerException(exception));
}

// ARCH-B-087: the limits of memory (241) and of rows or bytes (396) are a window that is too large, as the limits of rows (158) and of time (159).
void reasons_follow_the_error_code() {
  CHECK(reason_of_code(60) == "disabled");
  CHECK(reason_of_code(497) == "not_granted");
  CHECK(reason_of_code(158) == "window_too_large");
  CHECK(reason_of_code(159) == "window_too_large");
  CHECK(reason_of_code(241) == "window_too_large");
  CHECK(reason_of_code(396) == "window_too_large");
  CHECK(reason_of_code(164) == "readonly_account");
  CHECK(reason_of_code(1) == "failed");
  CHECK(monitor_reason_of(std::runtime_error("x")) == "failed");
}

// The longest lookback (365 days) fits in the points that the page draws.
void series_steps_keep_the_longest_window_within_the_points() {
  for (const uint64_t days : {1, 7, 30, 90, 365}) {
    const uint32_t step = monitor_series_step_seconds(days * 86400);
    CHECK((days * 86400 + step - 1) / step <= kMonitorSeriesMaxPoints);
  }
  CHECK(monitor_series_step_seconds(365 * 86400) == 2 * 86400);
  CHECK(monitor_series_step_seconds(3600) == 30);
}

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
  reasons_follow_the_error_code();
  series_steps_keep_the_longest_window_within_the_points();
  RUN(a_request_that_names_the_host_only);
  RUN(the_window_of_the_series);
  RUN(the_filters_of_the_queries);
  RUN(a_series_is_written_to_six_digits_and_a_size_keeps_all_of_them);
  RUN(the_average_query_time_counts_the_queries_that_ended);
  RUN(the_hint_names_the_account_that_did_the_read);
  RUN(a_full_read_is_cut_even_when_the_runner_sees_few_of_its_rows);
  RUN(the_activity_needs_a_readable_runner);
  RUN(the_keeper_status_reads_its_three_tables);
  RUN(the_overview_is_read_once_and_again_when_asked);
  RUN(a_read_without_a_connection_is_an_error_of_the_route);
  RUN(a_failed_overview_says_why);
  RUN(the_series_drop_a_connection_that_broke_and_keep_the_rest);
  RUN(the_queries_are_read_as_the_runner_and_keyed_by_their_filters);
  RUN(the_activity_is_the_error_of_the_acl_when_it_cannot_be_read);
  RUN(the_disk_growth_reads_the_disks_the_series_and_the_parts);
  RUN(the_disks_and_their_json);
  RUN(one_shape_reads_the_runner_and_is_keyed_by_its_hash);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
