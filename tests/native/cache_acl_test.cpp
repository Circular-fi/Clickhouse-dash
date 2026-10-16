// This file has unit tests of the server caches and of the ACL discovery. It uses a fake clock and a fake ClickHouse identity:
//   - TtlCache (src/ttl_cache.hpp). It checks the TTL on a monotonic clock, the single-flight, stale-while-revalidate, refresh and
//     invalidate that keep the single-flight. It checks that failures are never stored as values, the LRU bounds in entries and bytes, and purge.
//   - the ACL discovery and AclService (src/allowed_objects.cpp, src/acl_service.cpp). ACCESS_DENIED is the only "no",
//     a transport error is not an answer and is not kept. An object in error is left out alone. Budgets say truncated.
//   - DdlTextCache (src/ddl_text_cache.hpp). One identity never gets the texts of another identity. It checks bounded reads and memory.
//   - FormatCache (src/format_cache.cpp). A hit needs the same text.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_CACHE_TESTS=ON
//        cmake --build build --target chdash_cache_acl_test
// Run:   ./build/chdash_cache_acl_test   (exit code 0 = every check passed)

#include "acl_service.hpp"
#include "allowed_objects.hpp"
#include "ddl_text_cache.hpp"
#include "format_cache.hpp"
#include "ttl_cache.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <iostream>
#include <algorithm>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
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

// This is a monotonic clock. The test moves it by hand.
struct FakeClock {
  using duration = std::chrono::steady_clock::duration;
  using rep = duration::rep;
  using period = duration::period;
  using time_point = std::chrono::time_point<FakeClock, duration>;
  [[maybe_unused]] static constexpr bool is_steady = true;
  static time_point now() { return time_point(duration(ticks.load())); }
  static void advance(std::chrono::milliseconds by) { ticks += std::chrono::duration_cast<duration>(by).count(); }
  static inline std::atomic<rep> ticks{std::chrono::duration_cast<duration>(std::chrono::hours(1)).count()};
};

using Cache = TtlCache<std::string, std::string, FakeClock>;
using ms = std::chrono::milliseconds;

// This holds the background refreshes that the cache queues. The test runs them when it says so.
struct ManualRefresher {
  std::mutex mu;
  std::vector<std::function<void()>> tasks;
  bool accept = true;
  std::function<bool(std::function<void()>)> submit() {
    return [this](std::function<void()> task) {
      std::lock_guard<std::mutex> lk(mu);
      if (!accept) return false;
      tasks.push_back(std::move(task));
      return true;
    };
  }
  size_t pending() {
    std::lock_guard<std::mutex> lk(mu);
    return tasks.size();
  }
  void run_all() {
    std::vector<std::function<void()>> now;
    {
      std::lock_guard<std::mutex> lk(mu);
      now.swap(tasks);
    }
    for (auto& task : now) task();
  }
};

Cache::Options options(ms ttl) {
  Cache::Options out;
  out.ttl = ttl;
  out.max_age = ms(60000);
  out.failure_backoff = ms(2000);
  out.wait = ms(5000);
  return out;
}

// This fetch counts its calls and answers "v<n>".
struct Counter {
  std::atomic<int> calls{0};
  Cache::Fetch fetch() {
    return [this](std::string& value, std::string&, std::string&) {
      value = "v" + std::to_string(++calls);
      return true;
    };
  }
};

// This is a latch. The fetch waits on it until the test opens it.
struct Gate {
  std::mutex mu;
  std::condition_variable cv;
  bool open = false;
  bool entered = false;
  void wait() {
    std::unique_lock<std::mutex> lk(mu);
    entered = true;
    cv.notify_all();
    cv.wait(lk, [this] { return open; });
  }
  void wait_entered() {
    std::unique_lock<std::mutex> lk(mu);
    cv.wait(lk, [this] { return entered; });
  }
  void release() {
    std::lock_guard<std::mutex> lk(mu);
    open = true;
    cv.notify_all();
  }
};

void ttl_cache_hit_then_expire_on_the_injected_clock() {
  Cache cache(options(ms(1000)));
  Counter counter;
  auto first = cache.get("k", counter.fetch());
  CHECK(first.has_value && *first.value == "v1" && first.fetched && !first.stale);
  auto second = cache.get("k", counter.fetch());
  CHECK(*second.value == "v1" && !second.fetched && counter.calls == 1);
  FakeClock::advance(ms(999));
  CHECK(*cache.get("k", counter.fetch()).value == "v1");
  FakeClock::advance(ms(2));
  auto third = cache.get("k", counter.fetch());
  CHECK(*third.value == "v2" && third.fetched && counter.calls == 2);
}

void ttl_cache_serves_stale_and_refreshes_once_in_the_background() {
  ManualRefresher refresher;
  auto opts = options(ms(1000));
  opts.stale_for = ms(5000);
  opts.submit = refresher.submit();
  Cache cache(opts);
  Counter counter;
  cache.get_revalidating("k", counter.fetch());
  FakeClock::advance(ms(1500));
  auto stale = cache.get_revalidating("k", counter.fetch());
  CHECK(stale.has_value && *stale.value == "v1" && stale.stale && !stale.fetched);
  CHECK(refresher.pending() == 1);
  // A second request, made while the refresh is queued, gets the stale value again. It starts no second refresh.
  auto again = cache.get_revalidating("k", counter.fetch());
  CHECK(*again.value == "v1" && again.stale && refresher.pending() == 1);
  refresher.run_all();
  CHECK(counter.calls == 2);
  auto fresh = cache.get_revalidating("k", counter.fetch());
  CHECK(*fresh.value == "v2" && !fresh.stale);
  // get() never serves a value past its TTL. It reads the value.
  FakeClock::advance(ms(1500));
  auto sync = cache.get("k", counter.fetch());
  CHECK(*sync.value == "v3" && sync.fetched && refresher.pending() == 0);
  // Past the stale window, the request reads the value itself.
  FakeClock::advance(ms(7000));
  auto late = cache.get_revalidating("k", counter.fetch());
  CHECK(*late.value == "v4" && late.fetched && refresher.pending() == 0);
}

void ttl_cache_a_full_refresher_serves_stale_without_reading() {
  ManualRefresher refresher;
  refresher.accept = false;
  auto opts = options(ms(1000));
  opts.stale_for = ms(5000);
  opts.submit = refresher.submit();
  Cache cache(opts);
  Counter counter;
  cache.get_revalidating("k", counter.fetch());
  FakeClock::advance(ms(1500));
  auto stale = cache.get_revalidating("k", counter.fetch());
  CHECK(*stale.value == "v1" && stale.stale && counter.calls == 1);
  // The refresh did not start. The next request asks again.
  refresher.accept = true;
  cache.get_revalidating("k", counter.fetch());
  CHECK(refresher.pending() == 1);
  refresher.run_all();
}

void ttl_cache_a_request_runs_a_queued_refresh_itself() {
  ManualRefresher refresher;
  auto opts = options(ms(1000));
  opts.stale_for = ms(1000);
  opts.submit = refresher.submit();
  Cache cache(opts);
  Counter counter;
  cache.get_revalidating("k", counter.fetch());
  FakeClock::advance(ms(1500));
  CHECK(cache.get_revalidating("k", counter.fetch()).stale && refresher.pending() == 1);
  // The refresh did not start because the refresher is busy. The value is now past its stale window. The request does
  // not wait for the queue. It reads.
  FakeClock::advance(ms(1000));
  auto result = cache.get_revalidating("k", counter.fetch());
  CHECK(result.has_value && *result.value == "v2" && result.fetched && !result.stale && counter.calls == 2);
  // The queued task finds that its refresh is done. It reads nothing.
  refresher.run_all();
  CHECK(counter.calls == 2);
  CHECK(*cache.get_revalidating("k", counter.fetch()).value == "v2");
  // With refresh=1 while a refresh is queued, the request runs it once. It starts after the request.
  FakeClock::advance(ms(1500));
  CHECK(cache.get_revalidating("k", counter.fetch()).stale && refresher.pending() == 1);
  auto forced = cache.get_revalidating("k", counter.fetch(), true);
  CHECK(*forced.value == "v3" && forced.fetched && counter.calls == 3);
  CHECK(*cache.get_revalidating("k", counter.fetch()).value == "v3" && counter.calls == 3);
  refresher.run_all();
  CHECK(counter.calls == 3);
}

void ttl_cache_single_flight_and_no_503_for_the_second_request() {
  Cache cache(options(ms(1000)));
  Gate gate;
  std::atomic<int> calls{0};
  Cache::Fetch slow = [&](std::string& value, std::string&, std::string&) {
    ++calls;
    gate.wait();
    value = "slow";
    return true;
  };
  Cache::Result first, second;
  std::thread a([&] { first = cache.get("k", slow); });
  gate.wait_entered();
  std::thread b([&] { second = cache.get("k", slow); });
  std::this_thread::sleep_for(ms(50));
  gate.release();
  a.join();
  b.join();
  CHECK(calls == 1);
  CHECK(first.has_value && *first.value == "slow" && first.fetched);
  CHECK(second.has_value && *second.value == "slow" && !second.fetched && !second.had_error);
}

void ttl_cache_wait_is_bounded() {
  auto opts = options(ms(1000));
  opts.wait = ms(50);
  Cache cache(opts);
  Gate gate;
  Cache::Fetch slow = [&](std::string& value, std::string&, std::string&) {
    gate.wait();
    value = "slow";
    return true;
  };
  Cache::Result second;
  std::thread a([&] { cache.get("k", slow); });
  gate.wait_entered();
  second = cache.get("k", slow);
  CHECK(!second.has_value && second.had_error && second.error_code == "refresh_timeout");
  gate.release();
  a.join();
}

void ttl_cache_force_keeps_single_flight_and_reads_after_the_request() {
  Cache cache(options(ms(60000)));
  Gate gate;
  std::atomic<int> calls{0};
  Cache::Fetch fetch = [&](std::string& value, std::string&, std::string&) {
    const int n = ++calls;
    if (n == 1) gate.wait();
    value = "v" + std::to_string(n);
    return true;
  };
  Cache::Result first;
  std::thread a([&] { first = cache.get("k", fetch); });
  gate.wait_entered();
  // Three refresh=1 requests arrive while the first read runs. They wait for it. Then they share ONE read that starts after them.
  std::vector<Cache::Result> forced(3);
  std::vector<std::thread> threads;
  for (size_t i = 0; i < forced.size(); ++i) threads.emplace_back([&, i] { forced[i] = cache.get("k", fetch, true); });
  std::this_thread::sleep_for(ms(50));
  CHECK(calls == 1);
  gate.release();
  a.join();
  for (auto& thread : threads) thread.join();
  CHECK(calls == 2);
  CHECK(*first.value == "v1");
  for (const auto& result : forced) CHECK(result.has_value && *result.value == "v2");
  // invalidate() keeps the entry. The next request reads again, once.
  cache.invalidate("k");
  CHECK(*cache.get("k", fetch).value == "v3");
  CHECK(*cache.get("k", fetch).value == "v3" && calls == 3);
}

void ttl_cache_invalidate_prefix_and_all() {
  Cache cache(options(ms(60000)));
  Counter counter;
  cache.get("a\0x", counter.fetch());
  cache.get(std::string("a\0x", 3), counter.fetch());
  cache.get(std::string("b\0x", 3), counter.fetch());
  const int before = counter.calls;
  cache.invalidate_prefix(std::string("a\0", 2));
  cache.get(std::string("a\0x", 3), counter.fetch());
  cache.get(std::string("b\0x", 3), counter.fetch());
  CHECK(counter.calls == before + 1);
  cache.invalidate_all();
  cache.get(std::string("b\0x", 3), counter.fetch());
  CHECK(counter.calls == before + 2);
}

void ttl_cache_failures_are_not_values() {
  auto opts = options(ms(1000));
  Cache cache(opts);
  std::atomic<int> calls{0};
  bool fail = false;
  Cache::Fetch fetch = [&](std::string& value, std::string& code, std::string& message) {
    ++calls;
    if (fail) {
      code = "boom";
      message = "the server is down";
      return false;
    }
    value = "v" + std::to_string(calls.load());
    return true;
  };
  // There is no value yet. The error is kept for the back-off only.
  fail = true;
  auto error = cache.get("k", fetch);
  CHECK(!error.has_value && error.had_error && error.error_code == "boom");
  CHECK(cache.get("k", fetch).error_code == "boom" && calls == 1);
  FakeClock::advance(ms(2001));
  fail = false;
  auto ok = cache.get("k", fetch);
  CHECK(ok.has_value && !ok.had_error && calls == 2);
  // A value is followed by a failure. The result is the previous value, marked stale, with the error.
  FakeClock::advance(ms(1500));
  fail = true;
  auto stale = cache.get("k", fetch);
  CHECK(stale.has_value && *stale.value == "v2" && stale.stale && stale.had_error && calls == 3);
  CHECK(cache.get("k", fetch).stale && calls == 3);
  // refresh=1 skips the back-off. An invalidated value is not served when the read fails.
  auto forced = cache.get("k", fetch, true);
  CHECK(calls == 4 && !forced.has_value && forced.had_error);
}

void ttl_cache_without_stale_on_error_answers_the_error() {
  auto opts = options(ms(1000));
  opts.serve_stale_on_error = false;
  Cache cache(opts);
  bool fail = false;
  Cache::Fetch fetch = [&](std::string& value, std::string& code, std::string&) {
    if (fail) {
      code = "boom";
      return false;
    }
    value = "v";
    return true;
  };
  cache.get("k", fetch);
  FakeClock::advance(ms(1500));
  fail = true;
  auto result = cache.get("k", fetch);
  CHECK(!result.has_value && result.had_error && result.error_code == "boom");
}

void ttl_cache_exception_is_kept_for_the_caller() {
  Cache cache(options(ms(1000)));
  Cache::Fetch fetch = [](std::string&, std::string&, std::string&) -> bool { throw std::invalid_argument("typed"); };
  auto result = cache.get("k", fetch);
  CHECK(result.had_error && result.error_code == "refresh_exception" && result.error_message == "typed");
  bool typed = false;
  try {
    if (result.exception) std::rethrow_exception(result.exception);
  } catch (const std::invalid_argument&) {
    typed = true;
  }
  CHECK(typed);
}

void ttl_cache_lru_bounds_in_entries_and_bytes() {
  auto opts = options(ms(60000));
  opts.max_entries = 3;
  Cache by_count(opts);
  Counter counter;
  for (const char* key : {"a", "b", "c"}) by_count.get(key, counter.fetch());
  by_count.get("a", counter.fetch());  // "a" is now the most recent: "b" goes first
  by_count.get("d", counter.fetch());
  CHECK(by_count.stats().entries == 3 && by_count.stats().evictions == 1);
  const int calls = counter.calls;
  by_count.get("a", counter.fetch());
  CHECK(counter.calls == calls);
  by_count.get("b", counter.fetch());
  CHECK(counter.calls == calls + 1);

  auto bytes = options(ms(60000));
  bytes.max_bytes = 3 * 1024;
  bytes.value_bytes = [](const std::string& value) { return value.size(); };
  Cache by_bytes(bytes);
  Cache::Fetch big = [](std::string& value, std::string&, std::string&) {
    value.assign(1000, 'x');
    return true;
  };
  for (int i = 0; i < 10; ++i) by_bytes.get("key" + std::to_string(i), big);
  const auto stats = by_bytes.stats();
  CHECK(stats.bytes <= 3 * 1024 && stats.entries <= 3 && stats.evictions >= 7);
}

void ttl_cache_purges_old_entries() {
  auto opts = options(ms(1000));
  opts.max_age = ms(5000);
  Cache cache(opts);
  Counter counter;
  for (int i = 0; i < 20; ++i) cache.get("old" + std::to_string(i), counter.fetch());
  CHECK(cache.stats().entries == 20);
  FakeClock::advance(ms(40000));
  cache.get("new", counter.fetch());
  CHECK(cache.stats().entries == 1);
}

void ttl_cache_value_ttl_can_be_shorter() {
  auto opts = options(ms(10000));
  opts.ttl_of = [](const std::string& value) { return value == "partial" ? ms(100) : ms(10000); };
  Cache cache(opts);
  int calls = 0;
  Cache::Fetch fetch = [&](std::string& value, std::string&, std::string&) {
    value = ++calls == 1 ? "partial" : "complete";
    return true;
  };
  cache.get("k", fetch);
  FakeClock::advance(ms(200));
  CHECK(*cache.get("k", fetch).value == "complete");
  FakeClock::advance(ms(200));
  CHECK(*cache.get("k", fetch).value == "complete" && calls == 2);
}

void cache_refresher_runs_and_stops() {
  std::atomic<int> runs{0};
  {
    CacheRefresher refresher(2, 4);
    for (int i = 0; i < 4; ++i) CHECK(refresher.submit([&] { ++runs; }));
    for (int i = 0; i < 100 && runs < 4; ++i) std::this_thread::sleep_for(ms(5));
    CHECK(runs == 4);
    refresher.stop();
    CHECK(!refresher.submit([&] { ++runs; }));
  }
  CHECK(runs == 4);
}

// ---- the ACL discovery ----------------------------------------------------------------------------------------------

// This is a fake identity. Each object is "db.table", with an access of "all", "some", "none" or "error". Databases granted whole are listed in
// `whole`. The `down` flag makes every statement fail like a lost connection.
struct FakeSource : AclSource {
  std::map<std::string, std::map<std::string, std::string>> objects;
  std::set<std::string> whole;
  bool check_grant_readable = true;
  bool down = false;
  std::atomic<int>* statements = nullptr;

  void count() {
    if (statements) ++*statements;
    if (down) throw std::runtime_error("connection reset by peer");
  }
  std::vector<std::string> show_databases() override {
    count();
    std::vector<std::string> out;
    for (const auto& item : objects) out.push_back(item.first);
    return out;
  }
  std::vector<std::string> show_objects(const std::string& database) override {
    count();
    const auto it = objects.find(database);
    if (it == objects.end()) throw AclObjectError(81, "Database " + database + " does not exist");
    std::vector<std::string> out;
    for (const auto& item : it->second) out.push_back(item.first);
    return out;
  }
  // The grant has the form "<privilege> ON `db`.*" or "<privilege> ON `db`.`table`". The privilege is SELECT or SELECT(`col`, ...).
  // A table with "some" access reads its column `a` only.
  std::optional<bool> check_grant(const std::string& expression) override {
    count();
    if (!check_grant_readable) return std::nullopt;
    const auto on = expression.find(" ON `");
    const std::string target = expression.substr(on + 4);
    const auto [database, table] = split(target);
    if (whole.count(database)) return true;
    if (table == "*") return false;
    const std::string level = access(database, table);
    if (level == "all") return true;
    if (level == "some" && expression.compare(0, 7, "SELECT(") == 0) return expression.compare(0, on, "SELECT(`a`)") == 0;
    return false;
  }
  void probe(const std::string& sql) override {
    count();
    const auto from = sql.find(" FROM `");
    const auto [database, table] = split(sql.substr(from + 6));
    const std::string level = whole.count(database) ? "all" : access(database, table);
    if (level == "error") throw AclObjectError(36, "parameterized view needs its parameters");
    if (level == "none") throw AclDenied("Not enough privileges");
    if (level == "some" && sql.compare(0, 14, "SELECT ignore(") == 0 && sql.compare(0, 18, "SELECT ignore(`a`)") != 0) {
      throw AclDenied("Not enough privileges");
    }
  }
  // "`db`.`table`..." or "`db`.*".
  static std::pair<std::string, std::string> split(const std::string& text) {
    const auto end = text.find('`', 1);
    const std::string database = text.substr(1, end - 1);
    if (text.compare(end + 1, 2, ".*") == 0) return {database, "*"};
    const auto table_end = text.find('`', end + 3);
    return {database, text.substr(end + 3, table_end - end - 3)};
  }
  std::vector<std::string> describe_columns(const std::string&, const std::string&) override {
    count();
    return {"a", "b"};
  }
  std::string access(const std::string& database, const std::string& table) const {
    const auto db = objects.find(database);
    if (db == objects.end()) return "none";
    const auto it = db->second.find(table);
    return it == db->second.end() ? "none" : it->second;
  }
};

AclBudget unlimited() { return AclBudget{}; }

void acl_databases_follow_select_not_show() {
  FakeSource source;
  source.objects["analytics"] = {{"events", "all"}};
  source.objects["mixed"] = {{"a_hidden", "none"}, {"b_cols", "some"}};
  source.objects["secret"] = {{"x", "none"}, {"y", "none"}};
  source.objects["INFORMATION_SCHEMA"] = {{"tables", "all"}};
  source.whole = {"analytics"};
  AclBudget budget = unlimited();
  const auto listed = discover_databases(source, budget);
  CHECK((listed.databases == std::vector<std::string>{"analytics", "mixed"}));
  CHECK(listed.unverified.empty() && !listed.truncated);
}

void acl_objects_are_table_level_with_partial_flag() {
  FakeSource source;
  source.objects["mixed"] = {{"all_t", "all"}, {"cols_t", "some"}, {"none_t", "none"}};
  AclBudget budget = unlimited();
  const auto objects = discover_objects(source, "mixed", budget);
  CHECK(objects.objects.size() == 2);
  CHECK(objects.contains("all_t") && objects.contains("cols_t") && !objects.contains("none_t"));
  CHECK(objects.objects[0].all_columns && !objects.objects[0].partial);
  CHECK(!objects.objects[1].all_columns && objects.objects[1].partial);
  AllowedObjectSet set;
  for (const auto& object : objects.objects) set.add_table(object);
  CHECK(set.allows_table("mixed", "cols_t") && !set.allows_column("mixed", "cols_t", "a"));
  CHECK(set.allows_column("mixed", "all_t", "a"));
}

void acl_an_object_in_error_is_left_out_alone() {
  FakeSource source;
  source.objects["db"] = {{"a", "all"}, {"broken_view", "error"}, {"c", "some"}};
  AclBudget budget = unlimited();
  const auto objects = discover_objects(source, "db", budget);
  CHECK(objects.contains("a") && objects.contains("c") && !objects.contains("broken_view"));
  CHECK(objects.issues.size() == 1 && objects.issues[0].object == "broken_view" && objects.issues[0].code == 36);
}

void acl_a_transport_error_is_not_an_answer() {
  FakeSource source;
  source.objects["db"] = {{"a", "all"}};
  source.down = true;
  AclBudget budget = unlimited();
  bool thrown = false;
  try {
    discover_objects(source, "db", budget);
  } catch (const AclDenied&) {
  } catch (const AclObjectError&) {
  } catch (const std::exception&) {
    thrown = true;
  }
  CHECK(thrown);
}

void acl_budget_reports_truncated_and_never_hides_a_database() {
  FakeSource source;
  std::map<std::string, std::string> many;
  for (int i = 0; i < 500; ++i) many["t" + std::to_string(1000 + i)] = "none";
  many["t9999_last"] = "all";  // the only readable object, after 500 refused ones
  source.objects["big"] = many;
  source.objects["small"] = {{"x", "all"}};
  AclBudget budget = unlimited();
  budget.max_objects_per_database = 400;
  const auto listed = discover_databases(source, budget);
  CHECK(std::find(listed.databases.begin(), listed.databases.end(), "small") != listed.databases.end());
  CHECK((listed.unverified == std::vector<std::string>{"big"}) && listed.truncated);

  AclBudget objects_budget = unlimited();
  objects_budget.max_objects = 100;
  const auto objects = discover_objects(source, "big", objects_budget);
  CHECK(objects.truncated && objects.objects.empty());

  AclBudget late = unlimited();
  late.deadline = std::chrono::steady_clock::now() - ms(1);
  const auto none = discover_databases(source, late);
  CHECK(none.databases.empty() && none.unverified.size() == 2 && none.truncated);
}

void acl_unreadable_check_grant_falls_back_to_probes() {
  FakeSource source;
  source.check_grant_readable = false;
  source.objects["db"] = {{"all_t", "all"}, {"cols_t", "some"}, {"none_t", "none"}};
  AclBudget budget = unlimited();
  const auto objects = discover_objects(source, "db", budget);
  CHECK(objects.objects.size() == 2);
  CHECK(objects.objects[0].table == "all_t" && objects.objects[0].all_columns);
  CHECK(objects.objects[1].table == "cols_t" && objects.objects[1].partial);
}

void acl_allowed_table_is_column_level() {
  FakeSource source;
  source.objects["db"] = {{"t", "some"}};
  const auto entry = discover_allowed_table(source, "db", "t");
  CHECK(entry.has_value() && !entry->all_columns && entry->partial);
  CHECK(entry && entry->columns.count("a") == 1 && entry->columns.count("b") == 0);
  CHECK(!discover_allowed_table(source, "db", "missing").has_value());
  CHECK(!discover_allowed_table(source, "nodb", "t").has_value());
}

AclAccess fake_access(std::shared_ptr<FakeSource> source, const std::string& key, std::atomic<int>* connects,
                      ms delay = ms(0)) {
  AclAccess access;
  access.key = key;
  access.connect = [source, connects, delay](std::string*) -> std::unique_ptr<AclSource> {
    if (connects) ++*connects;
    std::this_thread::sleep_for(delay);
    auto copy = std::make_unique<FakeSource>(*source);
    copy->statements = source->statements;
    return copy;
  };
  return access;
}

void acl_service_caches_per_identity_and_invalidates() {
  AclService::Options opts;
  opts.stale_for = ms(0);
  AclService service(opts);
  auto runner = std::make_shared<FakeSource>();
  runner->objects["db"] = {{"a", "all"}, {"b", "none"}};
  auto other = std::make_shared<FakeSource>();
  other->objects["db"] = {{"a", "none"}, {"b", "all"}};
  std::atomic<int> connects{0};
  const auto access = fake_access(runner, acl_identity_key("clickhouse://runner@h:9000"), &connects);
  const auto mcp = fake_access(other, acl_identity_key("clickhouse://mcp@h:9000"), &connects);
  CHECK(access.key != mcp.key && access.key.size() == 64);

  CHECK(service.objects(access, "db")->contains("a"));
  CHECK(!service.objects(mcp, "db")->contains("a"));
  CHECK(service.objects(mcp, "db")->contains("b"));
  const int after = connects;
  CHECK(service.objects(access, "db")->contains("a") && connects == after);

  CHECK(service.table_readable(access, "db", "a") && !service.table_readable(access, "db", "b"));
  const auto set = service.table_set(access);
  CHECK(set->allowed.allows_table("db", "a") && !set->allowed.allows_table("db", "b") && !set->truncated);

  // The grants change. refresh=1 invalidates the identity.
  runner->objects["db"]["b"] = "all";
  CHECK(!service.objects(access, "db")->contains("b"));
  service.invalidate(access);
  CHECK(service.objects(access, "db")->contains("b"));
  CHECK(service.table_set(access)->allowed.allows_table("db", "b"));
  // The other identity is untouched.
  CHECK(!service.objects(mcp, "db")->contains("a"));
}

void acl_service_failures_are_not_kept_as_answers() {
  AclService::Options opts;
  opts.stale_for = ms(0);
  opts.failure_backoff = ms(0);
  AclService service(opts);
  auto runner = std::make_shared<FakeSource>();
  runner->objects["db"] = {{"a", "all"}};
  runner->down = true;
  const auto access = fake_access(runner, acl_identity_key("clickhouse://runner@h:9000"), nullptr);
  bool unavailable = false;
  try {
    service.databases(access);
  } catch (const AclUnavailable& error) {
    unavailable = error.code == "acl_unavailable";
  }
  CHECK(unavailable);
  // The identity is back up. The next request reads again and gets an answer. No empty menu is kept.
  runner->down = false;
  const auto listed = service.databases(access);
  CHECK((listed->databases == std::vector<std::string>{"db"}));

  AclAccess no_connection;
  no_connection.key = "nobody";
  no_connection.connect = [](std::string* error) -> std::unique_ptr<AclSource> {
    *error = "connection refused";
    return nullptr;
  };
  std::string code;
  try {
    service.objects(no_connection, "db");
  } catch (const AclUnavailable& error) {
    code = error.code;
  }
  CHECK(code == "runner_unavailable");
}

void acl_service_single_flight_per_identity() {
  AclService::Options opts;
  opts.stale_for = ms(0);
  AclService service(opts);
  auto runner = std::make_shared<FakeSource>();
  std::map<std::string, std::string> tables;
  for (int i = 0; i < 50; ++i) tables["t" + std::to_string(i)] = "some";
  runner->objects["db"] = tables;
  std::atomic<int> statements{0};
  runner->statements = &statements;
  std::atomic<int> connects{0};
  // This is a slow connection. The eight requests overlap and share one discovery.
  const auto access = fake_access(runner, "k", &connects, ms(100));
  std::vector<std::thread> threads;
  for (int i = 0; i < 8; ++i) threads.emplace_back([&] { service.objects(access, "db"); });
  for (auto& thread : threads) thread.join();
  CHECK(connects == 1);
}

void acl_view_asks_each_database_once() {
  AclService::Options opts;
  opts.stale_for = ms(0);
  AclService service(opts);
  auto runner = std::make_shared<FakeSource>();
  runner->objects["db"] = {{"a", "all"}, {"b", "none"}};
  runner->objects["hidden"] = {{"x", "none"}};
  const auto access = fake_access(runner, "view", nullptr);
  AclView view(service, access);
  CHECK((view.databases() == std::vector<std::string>{"db"}));
  CHECK(view.visible("db", "a") && !view.visible("db", "b"));
  CHECK(!view.visible("hidden", "x") && view.objects("hidden").objects.empty());
  CHECK(!view.truncated());
}

std::vector<DdlObjectVersion> ddl_objects(const std::string& database, int count) {
  std::vector<DdlObjectVersion> out;
  for (int i = 0; i < count; ++i) out.push_back(DdlObjectVersion{database, "t" + std::to_string(i), "2026-01-01 00:00:00", false});
  return out;
}

void ddl_text_cache_never_shares_texts_between_identities() {
  DdlTextCache cache;
  const auto objects = ddl_objects("db", 3);
  int reads = 0;
  auto fetch_as = [&reads](const std::string& who) {
    return [&reads, who](const std::string& database, const std::vector<std::string>& names) {
      ++reads;
      std::vector<std::pair<std::string, DdlTexts>> out;
      for (const auto& name : names) out.emplace_back(DdlTextCache::object_key(database, name), DdlTexts{"engine of " + who, "", ""});
      return out;
    };
  };
  const auto runner = cache.get("runner-identity", objects, fetch_as("runner"));
  const auto mcp = cache.get("mcp-identity", objects, fetch_as("mcp"));
  CHECK(reads == 2);
  CHECK(runner.at(DdlTextCache::object_key("db", "t0")).engine_full == "engine of runner");
  CHECK(mcp.at(DdlTextCache::object_key("db", "t0")).engine_full == "engine of mcp");
  // The two texts stay apart. No read is made, and each identity gets its own text.
  const auto again = cache.get("mcp-identity", objects, fetch_as("nobody"));
  CHECK(reads == 2 && again.at(DdlTextCache::object_key("db", "t1")).engine_full == "engine of mcp");
}

void ddl_text_cache_reads_names_in_batches_and_is_bounded() {
  DdlTextCache cache(1000, 1u << 30);
  std::vector<size_t> batches;
  auto fetch = [&batches](const std::string& database, const std::vector<std::string>& names) {
    batches.push_back(names.size());
    std::vector<std::pair<std::string, DdlTexts>> out;
    for (const auto& name : names) out.emplace_back(DdlTextCache::object_key(database, name), DdlTexts{"e", "c", "s"});
    return out;
  };
  const auto texts = cache.get("id", ddl_objects("db", 4500), fetch);
  CHECK(texts.size() == 4500);
  // Never read the whole database. Each query reads at most kMaxNamesPerQuery names.
  CHECK((batches == std::vector<size_t>{2000, 2000, 500}));
  CHECK(cache.size() == 1000);

  DdlTextCache by_bytes(100000, 64 * 1024);
  auto big = [](const std::string& database, const std::vector<std::string>& names) {
    std::vector<std::pair<std::string, DdlTexts>> out;
    for (const auto& name : names) out.emplace_back(DdlTextCache::object_key(database, name), DdlTexts{std::string(4096, 'x'), "", ""});
    return out;
  };
  by_bytes.get("id", ddl_objects("db", 100), big);
  CHECK(by_bytes.bytes() <= 64 * 1024 && by_bytes.size() < 100 && by_bytes.size() > 0);
}

void format_cache_compares_the_text() {
  FormatCache cache(16, 1 << 20, ms(60000));
  cache.put("key", "SELECT 1", std::make_shared<const std::string>("SELECT 1\n"));
  CHECK(cache.get("key", "SELECT 1") && *cache.get("key", "SELECT 1") == "SELECT 1\n");
  // The key is the same, but the text is another one (a collision). This is no hit.
  CHECK(!cache.get("key", "SELECT 2"));
}

} // namespace

int main() {
  ttl_cache_hit_then_expire_on_the_injected_clock();
  ttl_cache_serves_stale_and_refreshes_once_in_the_background();
  ttl_cache_a_full_refresher_serves_stale_without_reading();
  ttl_cache_a_request_runs_a_queued_refresh_itself();
  ttl_cache_single_flight_and_no_503_for_the_second_request();
  ttl_cache_wait_is_bounded();
  ttl_cache_force_keeps_single_flight_and_reads_after_the_request();
  ttl_cache_invalidate_prefix_and_all();
  ttl_cache_failures_are_not_values();
  ttl_cache_without_stale_on_error_answers_the_error();
  ttl_cache_exception_is_kept_for_the_caller();
  ttl_cache_lru_bounds_in_entries_and_bytes();
  ttl_cache_purges_old_entries();
  ttl_cache_value_ttl_can_be_shorter();
  cache_refresher_runs_and_stops();
  acl_databases_follow_select_not_show();
  acl_objects_are_table_level_with_partial_flag();
  acl_an_object_in_error_is_left_out_alone();
  acl_a_transport_error_is_not_an_answer();
  acl_budget_reports_truncated_and_never_hides_a_database();
  acl_unreadable_check_grant_falls_back_to_probes();
  acl_allowed_table_is_column_level();
  acl_service_caches_per_identity_and_invalidates();
  acl_service_failures_are_not_kept_as_answers();
  acl_service_single_flight_per_identity();
  acl_view_asks_each_database_once();
  ddl_text_cache_never_shares_texts_between_identities();
  ddl_text_cache_reads_names_in_batches_and_is_bounded();
  format_cache_compares_the_text();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
