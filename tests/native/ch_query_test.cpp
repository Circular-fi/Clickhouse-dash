// Unit tests of the statements and the connections of ChDash (src/ch_query.hpp, src/ch_client_pool.hpp).
//
// Without a server: the settings that a statement gets from its scope and the settings profile of the
// user, the scopes, the cancel check.
// With a server (CHDASH_TEST_CLICKHOUSE_URI=clickhouse://user:password@host:9000, the test stack has one):
// a statement that a callback interrupts never leaves its packets to the next statement (the lease is
// closed, or reopened when the caller goes on with it); a callback that stops reading keeps the
// connection; the scope's settings reach ClickHouse; the deadline and the cancel stop a statement before
// it is sent; the pool bounds its leases.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_CH_QUERY_TESTS=ON
//        cmake --build build --target chdash_ch_query_test
// Run:   ./build/chdash_ch_query_test   (exit code 0 = every check passed)

#include "ch_client_pool.hpp"
#include "ch_query.hpp"
#include "sql_params.hpp"

#include <clickhouse/columns/numeric.h>
#include <clickhouse/columns/string.h>
#include <clickhouse/exceptions.h>

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
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

using Settings = std::vector<std::pair<std::string, std::string>>;

std::string setting(const Settings& settings, const std::string& name) {
  for (const auto& [key, value] : settings) {
    if (key == name) return value;
  }
  return "<unset>";
}

ChSettingsProfile open_profile() {
  ChSettingsProfile profile;
  profile.known = true;
  return profile;
}

void test_settings_follow_the_scope_and_never_loosen_the_profile() {
  const auto now = std::chrono::steady_clock::now();
  ChQueryLimits limits;
  limits.log_comment = "chdash:/api/test";
  limits.max_memory_usage = 4'000'000'000ULL;
  limits.max_execution_time_s = 10;

  Settings out = ch_query_settings(limits, open_profile(), now);
  CHECK(setting(out, "log_comment") == "chdash:/api/test");
  CHECK(setting(out, "max_memory_usage") == "4000000000");
  CHECK(setting(out, "max_execution_time") == "10");
  CHECK(setting(out, "max_rows_to_read") == "<unset>");

  // A stricter profile wins: the setting is not sent (the profile's value stays).
  ChSettingsProfile strict = open_profile();
  strict.max_memory_usage = 1'000'000'000ULL;
  strict.max_execution_time = 5;
  out = ch_query_settings(limits, strict, now);
  CHECK(setting(out, "max_memory_usage") == "<unset>");
  CHECK(setting(out, "max_execution_time") == "<unset>");

  // A looser profile is tightened.
  ChSettingsProfile loose = open_profile();
  loose.max_memory_usage = 8'000'000'000ULL;
  loose.max_execution_time = 600;
  out = ch_query_settings(limits, loose, now);
  CHECK(setting(out, "max_memory_usage") == "4000000000");
  CHECK(setting(out, "max_execution_time") == "10");

  // The deadline: what remains, rounded up, and the smaller of it and the cap.
  limits.deadline = now + std::chrono::milliseconds(3200);
  out = ch_query_settings(limits, open_profile(), now);
  CHECK(setting(out, "max_execution_time") == "4");
  limits.deadline = now - std::chrono::seconds(5);
  out = ch_query_settings(limits, open_profile(), now);
  CHECK(setting(out, "max_execution_time") == "1");

  // A read cap carries its overflow mode; so does a result cap.
  ChQueryLimits reads;
  reads.max_rows_to_read = 1000;
  reads.read_overflow_mode = "break";
  reads.max_result_bytes = 2048;
  reads.result_overflow_mode = "break";
  out = ch_query_settings(reads, open_profile(), now);
  CHECK(setting(out, "max_rows_to_read") == "1000");
  CHECK(setting(out, "read_overflow_mode") == "break");
  CHECK(setting(out, "max_result_bytes") == "2048");
  CHECK(setting(out, "result_overflow_mode") == "break");
  CHECK(setting(out, "log_comment") == "<unset>");
}

void test_readonly_or_unknown_profile_gets_no_setting() {
  const auto now = std::chrono::steady_clock::now();
  ChQueryLimits limits;
  limits.log_comment = "chdash:/api/test";
  limits.max_memory_usage = 1;
  ChSettingsProfile readonly = open_profile();
  readonly.readonly = 1;
  CHECK(ch_query_settings(limits, readonly, now).empty());
  CHECK(ch_query_settings(limits, ChSettingsProfile{}, now).empty());
  // readonly = 2 may change settings.
  ChSettingsProfile readonly2 = open_profile();
  readonly2.readonly = 2;
  CHECK(!ch_query_settings(limits, readonly2, now).empty());
}

void test_read_only_and_the_overflow_modes() {
  const auto now = std::chrono::steady_clock::now();
  ChQueryLimits limits;
  limits.read_only = true;
  limits.max_execution_time_s = 30;
  limits.timeout_overflow_mode = "throw";
  limits.max_result_rows = 1000;
  limits.result_overflow_mode = "throw";
  Settings out = ch_query_settings(limits, open_profile(), now);
  CHECK(setting(out, "readonly") == "2");
  CHECK(setting(out, "timeout_overflow_mode") == "throw");
  CHECK(setting(out, "max_result_rows") == "1000");
  CHECK(setting(out, "result_overflow_mode") == "throw");
  // A profile that is already read only keeps its value; a stricter time limit keeps its own mode.
  ChSettingsProfile strict = open_profile();
  strict.readonly = 2;
  strict.max_execution_time = 10;
  strict.max_result_rows = 10;
  out = ch_query_settings(limits, strict, now);
  CHECK(setting(out, "readonly") == "<unset>");
  CHECK(setting(out, "timeout_overflow_mode") == "<unset>");
  CHECK(setting(out, "max_result_rows") == "<unset>");
  CHECK(setting(out, "result_overflow_mode") == "<unset>");
}

void test_scopes_nest_and_the_cancel_check_throws() {
  CHECK(ChQueryScope::current() == nullptr);
  {
    ChQueryLimits outer;
    outer.log_comment = "outer";
    ChQueryScope a(std::move(outer));
    CHECK(ChQueryScope::current() && ChQueryScope::current()->log_comment == "outer");
    {
      ChQueryLimits inner = ChQueryScope::current_copy();
      inner.log_comment = "inner";
      int asked = 0;
      inner.canceled = [&asked] {
        ++asked;
        return true;
      };
      ChQueryScope b(std::move(inner));
      CHECK(ChQueryScope::current()->log_comment == "inner");
      bool thrown = false;
      try {
        ch_check_canceled();
      } catch (const ChQueryCanceled&) {
        thrown = true;
      }
      CHECK(thrown);
      // Once canceled, the scope stays canceled without asking again.
      thrown = false;
      try {
        ch_check_canceled();
      } catch (const ChQueryCanceled&) {
        thrown = true;
      }
      CHECK(thrown);
      CHECK(asked == 1);
    }
    CHECK(ChQueryScope::current()->log_comment == "outer");
    ch_check_canceled();  // no predicate: never throws
  }
  CHECK(ChQueryScope::current() == nullptr);
}

// ---- with a server ----------------------------------------------------------------------------

struct Stop : std::runtime_error {
  Stop() : std::runtime_error("stop") {}
};

const char* kWide = "SELECT number FROM system.numbers LIMIT 5000000 SETTINGS max_block_size = 1000";

uint64_t select_u64(clickhouse::Client& client, const std::string& sql) {
  std::vector<std::string> values;
  ch_select(client, sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      values.push_back(std::string(block[0]->As<clickhouse::ColumnString>()->At(row)));
    }
  });
  if (values.size() != 1) throw std::runtime_error("expected one row from " + sql + ", got " + std::to_string(values.size()));
  return std::strtoull(values[0].c_str(), nullptr, 10);
}

std::string select_text(clickhouse::Client& client, const std::string& sql) {
  std::string value;
  size_t rows = 0;
  ch_select(client, sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      value = std::string(block[0]->As<clickhouse::ColumnString>()->At(row));
      ++rows;
    }
  });
  if (rows != 1) throw std::runtime_error("expected one row from " + sql);
  return value;
}

std::shared_ptr<clickhouse::Client> lease(const std::shared_ptr<ClickHouseClientPool>& pool, const std::string& uri) {
  std::string error;
  auto client = pool->acquire(uri, std::chrono::seconds(5), std::chrono::seconds(30), std::chrono::seconds(30), &error);
  if (!client) throw std::runtime_error("cannot connect: " + error);
  return client;
}

void test_an_interrupted_statement_never_reaches_the_next_lease(const std::string& uri) {
  auto pool = std::make_shared<ClickHouseClientPool>(4);
  {
    auto client = lease(pool, uri);
    bool stopped = false;
    try {
      ch_select(*client, kWide, [](const clickhouse::Block&) { throw Stop(); });
    } catch (const Stop&) {
      stopped = true;
    }
    CHECK(stopped);
    // The rest of the stream is still in the socket: the connection is marked.
    CHECK(ch_connection_dirty(*client));
  }
  // The pool closed it: the next lease answers its own statement, not the packets of the previous one.
  for (int i = 0; i < 3; ++i) {
    auto client = lease(pool, uri);
    CHECK(!ch_connection_dirty(*client));
    CHECK(select_u64(*client, "SELECT toString(42)") == 42);
  }
}

void test_a_caller_that_goes_on_gets_a_new_socket(const std::string& uri) {
  auto pool = std::make_shared<ClickHouseClientPool>(4);
  auto client = lease(pool, uri);
  try {
    ch_select(*client, kWide, [](const clickhouse::Block&) { throw Stop(); });
  } catch (const Stop&) {
  }
  CHECK(ch_connection_dirty(*client));
  // The same lease, the next statement (the catch-and-continue sites): a new socket first.
  CHECK(select_u64(*client, "SELECT toString(7)") == 7);
  CHECK(!ch_connection_dirty(*client));
}

void test_a_server_error_keeps_the_connection(const std::string& uri) {
  auto pool = std::make_shared<ClickHouseClientPool>(4);
  clickhouse::Client* first = nullptr;
  {
    auto client = lease(pool, uri);
    first = client.get();
    bool server_error = false;
    try {
      ch_select(*client, "SELECT throwIf(1, 'chdash test')", [](const clickhouse::Block&) {});
    } catch (const clickhouse::ServerError&) {
      server_error = true;
    }
    CHECK(server_error);
    CHECK(!ch_connection_dirty(*client));
  }
  auto again = lease(pool, uri);
  CHECK(again.get() == first);  // back in the idle pool, lent again
  CHECK(select_u64(*again, "SELECT toString(3)") == 3);
}

void test_a_callback_that_stops_reading_keeps_the_connection(const std::string& uri) {
  auto pool = std::make_shared<ClickHouseClientPool>(4);
  clickhouse::Client* first = nullptr;
  {
    auto client = lease(pool, uri);
    first = client.get();
    uint64_t rows = 0;
    int calls = 0;
    ch_select_cancelable(*client, kWide, [&](const clickhouse::Block& block) {
      ++calls;
      rows += block.GetRowCount();
      return rows < 3000;
    });
    CHECK(rows >= 3000 && rows < 5000000);
    CHECK(!ch_connection_dirty(*client));
    CHECK(select_u64(*client, "SELECT toString(5)") == 5);
  }
  auto again = lease(pool, uri);
  CHECK(again.get() == first);
  CHECK(select_u64(*again, "SELECT toString(6)") == 6);
}

void test_the_scope_settings_reach_clickhouse(const std::string& uri) {
  auto pool = std::make_shared<ClickHouseClientPool>(4);
  auto client = lease(pool, uri);
  ChQueryLimits limits;
  limits.log_comment = "chdash:/native/test";
  limits.max_memory_usage = 123456789;
  limits.max_execution_time_s = 17;
  ChQueryScope scope(std::move(limits));
  CHECK(select_text(*client, "SELECT toString(getSetting('log_comment'))") == "chdash:/native/test");
  CHECK(select_u64(*client, "SELECT toString(getSetting('max_memory_usage'))") == 123456789);
  CHECK(select_u64(*client, "SELECT toString(toUInt64(getSetting('max_execution_time')))") == 17);
  // A SETTINGS clause of the SQL wins.
  CHECK(select_u64(*client, "SELECT toString(getSetting('max_memory_usage')) SETTINGS max_memory_usage = 99999") == 99999);
  {
    ChQueryLimits read_only = ChQueryScope::current_copy();
    read_only.read_only = true;
    ChQueryScope inner(std::move(read_only));
    CHECK(select_u64(*client, "SELECT toString(getSetting('readonly'))") == 2);
    int code = 0;
    try {
      ch_execute(*client, "CREATE DATABASE chdash_ch_query_test_db");
    } catch (const clickhouse::ServerError& error) {
      code = error.GetCode();
    }
    CHECK(code == 164);
    CHECK(!ch_connection_dirty(*client));
  }
}

void test_a_passed_deadline_or_a_cancel_stops_before_sending(const std::string& uri) {
  auto pool = std::make_shared<ClickHouseClientPool>(4);
  auto client = lease(pool, uri);
  {
    ChQueryLimits limits;
    limits.deadline = std::chrono::steady_clock::now() - std::chrono::milliseconds(1);
    ChQueryScope scope(std::move(limits));
    int code = 0;
    try {
      ch_select(*client, "SELECT 1", [](const clickhouse::Block&) {});
    } catch (const clickhouse::ServerError& error) {
      code = error.GetCode();
    }
    CHECK(code == 159);
    CHECK(!ch_connection_dirty(*client));
  }
  {
    ChQueryLimits limits;
    limits.canceled = [] { return true; };
    ChQueryScope scope(std::move(limits));
    bool canceled = false;
    try {
      ch_select(*client, "SELECT 1", [](const clickhouse::Block&) {});
    } catch (const ChQueryCanceled&) {
      canceled = true;
    }
    CHECK(canceled);
    CHECK(!ch_connection_dirty(*client));
  }
  {
    // A caller that goes away while the statement streams: the statement stops, the connection is marked.
    ChQueryLimits limits;
    int asked = 0;
    limits.canceled = [&asked] { return ++asked > 1; };
    ChQueryScope scope(std::move(limits));
    bool canceled = false;
    try {
      ch_select(*client, "SELECT sleepEachRow(0.001) FROM numbers(3000) SETTINGS max_block_size = 1",
                [](const clickhouse::Block&) {});
    } catch (const ChQueryCanceled&) {
      canceled = true;
    }
    CHECK(canceled);
    CHECK(ch_connection_dirty(*client));
  }
  CHECK(select_u64(*client, "SELECT toString(9)") == 9);
}

// A name that a user chose (a database with a quote mark or a backslash) is a value of an IN list, one String parameter each.
void test_names_go_through_string_parameters_as_they_are(const std::string& uri) {
  auto pool = std::make_shared<ClickHouseClientPool>(4);
  auto client = lease(pool, uri);
  const std::vector<std::string> names = {"plain", "o'brien", "back\\slash", "tab\tx", "new\nline", "say \"hi\"", "100%"};
  const std::string all =
      "SELECT toString(count()) FROM (SELECT arrayJoin(['plain', 'o\\'brien', 'back\\\\slash', 'tab\\tx', 'new\\nline', 'say \"hi\"', '100%']) "
      "AS database) WHERE database IN (";
  const auto count = [&](const std::vector<std::string>& values) {
    SqlParams params;
    const std::string sql = all + params.texts(values) + ")";
    uint64_t found = 0;
    ch_select(*client, sql, params.list(), [&](const clickhouse::Block& block) {
      if (block.GetRowCount()) found = std::stoull(std::string((*block[0]->As<clickhouse::ColumnString>())[0]));
    });
    return found;
  };
  CHECK(count(names) == names.size());
  CHECK(count({"o'brien"}) == 1);
  CHECK(count({"back\\slash"}) == 1);
  CHECK(count({"tab\tx", "new\nline"}) == 2);
  CHECK(count({"o'brien' OR '1'='1"}) == 0);  // an SQL tail is one more value, not SQL
  CHECK(count({"back\\"}) == 0);
  CHECK(count({}) == 0);  // an empty list matches no row
}

void test_the_pool_bounds_its_leases(const std::string& uri) {
  auto pool = std::make_shared<ClickHouseClientPool>(4, std::chrono::seconds(60), std::chrono::seconds(15),
                                                     std::chrono::seconds(5), 1, std::chrono::milliseconds(200));
  auto first = lease(pool, uri);
  CHECK(pool->leased(uri) == 1);
  std::string error;
  const auto started = std::chrono::steady_clock::now();
  auto second = pool->acquire(uri, std::chrono::seconds(5), std::chrono::seconds(30), std::chrono::seconds(30), &error);
  CHECK(!second);
  CHECK(error.rfind("pool_exhausted", 0) == 0);
  CHECK(std::chrono::steady_clock::now() - started >= std::chrono::milliseconds(150));
  first.reset();
  CHECK(pool->leased(uri) == 0);
  auto third = lease(pool, uri);
  CHECK(third != nullptr);
}

}  // namespace

// The settings of a MCP statement: readonly = 1 only when the profile leaves it at 0, the profile never contradicted.
void test_mcp_settings_follow_the_profile() {
  ChMcpLimits limits;
  limits.max_rows = 1000;
  limits.max_bytes = 1'048'576;
  limits.timeout_seconds = 30;
  limits.max_memory_bytes = 1'073'741'824;
  limits.sql_bytes = 100;
  limits.log_comment = "chdash-mcp key=k1";

  // A user without a profile: everything, readonly = 1 first.
  ChMcpSettings plan = ch_mcp_settings(limits, open_profile());
  CHECK(setting(plan.settings, "readonly") == "1");
  CHECK(setting(plan.settings, "max_execution_time") == "30");
  CHECK(setting(plan.settings, "max_result_rows") == "1001");
  CHECK(setting(plan.settings, "result_overflow_mode") == "break");
  CHECK(setting(plan.settings, "max_result_bytes") == "1048576");
  CHECK(setting(plan.settings, "max_memory_usage") == "1073741824");
  CHECK(setting(plan.settings, "max_query_size") == "262144");
  CHECK(setting(plan.settings, "max_rows_to_read") == "<unset>");
  CHECK(setting(plan.settings, "log_comment") == "chdash-mcp key=k1");
  CHECK(plan.max_rows == 1000 && !plan.rows_cut_by_profile && !plan.bytes_cut_by_profile);
  // An unreadable profile is a user without one.
  CHECK(setting(ch_mcp_settings(limits, ChSettingsProfile{}).settings, "readonly") == "1");

  // readonly = 2 in the profile: ClickHouse refuses to change readonly, even to 1; the limits are still sent.
  ChSettingsProfile two = open_profile();
  two.readonly = 2;
  plan = ch_mcp_settings(limits, two);
  CHECK(setting(plan.settings, "readonly") == "<unset>");
  CHECK(setting(plan.settings, "max_execution_time") == "30");
  CHECK(setting(plan.settings, "max_result_rows") == "1001");
  CHECK(setting(plan.settings, "log_comment") == "chdash-mcp key=k1");

  // readonly = 1 in the profile: ClickHouse refuses every setting, so none is sent.
  ChSettingsProfile one = open_profile();
  one.readonly = 1;
  CHECK(ch_mcp_settings(limits, one).settings.empty());

  // The profile wins. A limit that it sets and that is not larger than ours is not sent, and what the call returns follows it.
  ChSettingsProfile strict = two;
  strict.max_execution_time = 10;
  strict.max_result_rows = 200;
  strict.max_result_bytes = 4096;
  strict.max_memory_usage = 1'000'000;
  strict.max_rows_to_read = 5000;
  limits.max_rows_to_read = 100'000;
  plan = ch_mcp_settings(limits, strict);
  CHECK(setting(plan.settings, "max_execution_time") == "<unset>");
  CHECK(setting(plan.settings, "max_result_rows") == "<unset>");
  CHECK(setting(plan.settings, "max_result_bytes") == "<unset>");
  CHECK(setting(plan.settings, "max_memory_usage") == "<unset>");
  CHECK(setting(plan.settings, "max_rows_to_read") == "<unset>");
  CHECK(plan.max_rows == 200 && plan.rows_cut_by_profile);
  CHECK(plan.max_bytes == 4096 && plan.bytes_cut_by_profile);

  // A guard rail below the profile (the configuration or a key that is stricter) is kept: it can only lower.
  ChSettingsProfile loose = two;
  loose.max_execution_time = 600;
  loose.max_result_rows = 50'000;
  loose.max_result_bytes = 100'000'000;
  loose.max_memory_usage = 8'000'000'000ULL;
  loose.max_rows_to_read = 1'000'000;
  plan = ch_mcp_settings(limits, loose);
  CHECK(setting(plan.settings, "max_execution_time") == "30");
  CHECK(setting(plan.settings, "max_result_rows") == "1001");
  CHECK(setting(plan.settings, "max_result_bytes") == "1048576");
  CHECK(setting(plan.settings, "max_memory_usage") == "1073741824");
  CHECK(setting(plan.settings, "max_rows_to_read") == "100000");
  CHECK(plan.max_rows == 1000 && !plan.rows_cut_by_profile && plan.max_bytes == 1'048'576 && !plan.bytes_cut_by_profile);
}

int main() {
  test_settings_follow_the_scope_and_never_loosen_the_profile();
  test_readonly_or_unknown_profile_gets_no_setting();
  test_read_only_and_the_overflow_modes();
  test_mcp_settings_follow_the_profile();
  test_scopes_nest_and_the_cancel_check_throws();

  const char* uri = std::getenv("CHDASH_TEST_CLICKHOUSE_URI");
  if (uri && *uri) {
    try {
      test_an_interrupted_statement_never_reaches_the_next_lease(uri);
      test_a_caller_that_goes_on_gets_a_new_socket(uri);
      test_a_server_error_keeps_the_connection(uri);
      test_a_callback_that_stops_reading_keeps_the_connection(uri);
      test_the_scope_settings_reach_clickhouse(uri);
      test_a_passed_deadline_or_a_cancel_stops_before_sending(uri);
      test_the_pool_bounds_its_leases(uri);
      test_names_go_through_string_parameters_as_they_are(uri);
    } catch (const std::exception& e) {
      ++g_failures;
      std::cerr << "unexpected exception: " << e.what() << std::endl;
    }
  } else {
    std::cout << "CHDASH_TEST_CLICKHOUSE_URI is not set: the server cases are skipped" << std::endl;
  }
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
