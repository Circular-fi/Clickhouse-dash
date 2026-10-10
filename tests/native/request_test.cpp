// Unit tests of the way a request is served: the admission of the heavy work (src/admission.hpp), the context of a request
// (src/request_context.cpp), and the routes that are also callable in the process (src/routed_server.hpp). No ClickHouse is needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_REQUEST_TESTS=ON
//        cmake --build build --target chdash_request_test
// Run:   ./build/chdash_request_test   (exit code 0 = every check passed)

#include "admission.hpp"
#include "request_context.hpp"
#include "routed_server.hpp"

#include <atomic>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>

using namespace chdash;
using namespace std::chrono_literals;

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

#define CHECK_EQ(a, b)                                                                                   \
  do {                                                                                                   \
    ++g_checks;                                                                                          \
    const auto va = (a);                                                                                 \
    const auto vb = (b);                                                                                 \
    if (!(va == vb)) {                                                                                   \
      ++g_failures;                                                                                      \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK_EQ failed: " #a " == " #b << "\n  left : " << va \
                << "\n  right: " << vb << std::endl;                                                     \
    }                                                                                                    \
  } while (0)

// ---- admission ----

Admission::Stat stat_of(const Admission& admission, const std::string& key) {
  for (const auto& stat : admission.stats()) {
    if (stat.key == key) return stat;
  }
  return {};
}

void test_admission_limits_each_key() {
  Admission admission;
  auto a = admission.acquire("heavy|a", 2, 0ms);
  auto b = admission.acquire("heavy|a", 2, 0ms);
  CHECK(a && b);
  // The third has to wait, and with no wait it is refused at once.
  CHECK(!admission.acquire("heavy|a", 2, 0ms));
  CHECK_EQ(stat_of(admission, "heavy|a").in_use, uint64_t(2));
  CHECK_EQ(stat_of(admission, "heavy|a").refused, uint64_t(1));
  CHECK_EQ(stat_of(admission, "heavy|a").admitted, uint64_t(2));
  // Another host and another class have their own places.
  CHECK(admission.acquire("heavy|b", 2, 0ms));
  CHECK(admission.acquire("analysis|a", 1, 0ms));
  // A place that is given back is free again.
  a.reset();
  CHECK_EQ(stat_of(admission, "heavy|a").in_use, uint64_t(1));
  CHECK(admission.acquire("heavy|a", 2, 0ms));
}

void test_admission_zero_is_no_limit() {
  Admission admission;
  std::vector<std::optional<Admission::Ticket>> held;
  for (int i = 0; i < 100; ++i) held.push_back(admission.acquire("heavy|a", 0, 0ms));
  for (const auto& ticket : held) CHECK(ticket.has_value());
  CHECK_EQ(stat_of(admission, "heavy|a").in_use, uint64_t(100));
}

void test_admission_a_waiter_gets_the_place_that_is_given_back() {
  Admission admission;
  auto first = admission.acquire("k", 1, 0ms);
  CHECK(first.has_value());
  std::atomic<bool> got{false};
  std::thread waiter([&] {
    auto second = admission.acquire("k", 1, 5000ms);
    got = second.has_value();
  });
  // The waiter is counted while it waits.
  for (int i = 0; i < 200 && stat_of(admission, "k").waiting == 0; ++i) std::this_thread::sleep_for(5ms);
  CHECK_EQ(stat_of(admission, "k").waiting, uint64_t(1));
  const auto given_back = std::chrono::steady_clock::now();
  first.reset();
  waiter.join();
  CHECK(got.load());
  // It did not wait for its whole time.
  CHECK(std::chrono::steady_clock::now() - given_back < 2000ms);
  CHECK_EQ(stat_of(admission, "k").waiting, uint64_t(0));
}

void test_admission_the_wait_ends_with_the_time_and_with_stop() {
  Admission admission;
  auto held = admission.acquire("k", 1, 0ms);
  const auto started = std::chrono::steady_clock::now();
  CHECK(!admission.acquire("k", 1, 120ms));
  CHECK(std::chrono::steady_clock::now() - started >= 100ms);
  // `stop` ends the wait long before its time.
  std::atomic<bool> stop{false};
  std::thread stopper([&] {
    std::this_thread::sleep_for(100ms);
    stop = true;
  });
  const auto stop_started = std::chrono::steady_clock::now();
  CHECK(!admission.acquire("k", 1, 10000ms, [&] { return stop.load(); }));
  CHECK(std::chrono::steady_clock::now() - stop_started < 3000ms);
  stopper.join();
  CHECK_EQ(stat_of(admission, "k").refused, uint64_t(2));
}

void test_admission_many_threads_never_pass_the_limit() {
  Admission admission;
  std::atomic<int> inside{0};
  std::atomic<int> most{0};
  std::vector<std::thread> threads;
  for (int t = 0; t < 12; ++t) {
    threads.emplace_back([&] {
      for (int i = 0; i < 20; ++i) {
        auto ticket = admission.acquire("k", 3, 10000ms);
        if (!ticket) continue;
        const int now = ++inside;
        int seen = most.load();
        while (now > seen && !most.compare_exchange_weak(seen, now)) {}
        std::this_thread::sleep_for(1ms);
        --inside;
      }
    });
  }
  for (auto& thread : threads) thread.join();
  CHECK(most.load() <= 3);
  CHECK(most.load() >= 1);
  CHECK_EQ(stat_of(admission, "k").in_use, uint64_t(0));
  CHECK_EQ(stat_of(admission, "k").admitted, uint64_t(240));
}

// ---- the context of a request ----

void test_the_context_of_a_thread() {
  // Outside of every scope: a browser, with no bounds.
  CHECK(!current_request_context().is_mcp());
  CHECK(current_request_context().route.empty());
  CHECK(ChQueryScope::current() == nullptr);
  {
    RequestContext browser;
    browser.route = "/api/logs/search";
    browser.limits.log_comment = "chdash-logs";
    RequestScope scope(browser);
    CHECK_EQ(current_request_context().route, std::string("/api/logs/search"));
    CHECK(!current_request_context().is_mcp());
    // The statements of the thread carry the limits of the context.
    CHECK(ChQueryScope::current() != nullptr);
    CHECK_EQ(ChQueryScope::current()->log_comment, std::string("chdash-logs"));
    {
      RequestContext tool;
      tool.caller = RequestContext::Caller::Mcp;
      tool.caller_id = "key-1";
      tool.route = "/api/metrics/series";
      tool.limits.log_comment = "chdash-mcp key=key-1";
      RequestScope inner(tool);
      CHECK(current_request_context().is_mcp());
      CHECK_EQ(current_request_context().caller_id, std::string("key-1"));
      CHECK_EQ(ChQueryScope::current()->log_comment, std::string("chdash-mcp key=key-1"));
    }
    // The inner scope ended: the outer one is back.
    CHECK(!current_request_context().is_mcp());
    CHECK_EQ(ChQueryScope::current()->log_comment, std::string("chdash-logs"));
  }
  CHECK(current_request_context().route.empty());
  CHECK(ChQueryScope::current() == nullptr);
}

void test_the_context_does_not_cross_threads() {
  RequestContext tool;
  tool.caller = RequestContext::Caller::Mcp;
  tool.caller_id = "key-1";
  RequestScope scope(tool);
  CHECK(current_request_context().is_mcp());
  bool other_thread_is_mcp = true;
  std::thread other([&] { other_thread_is_mcp = current_request_context().is_mcp(); });
  other.join();
  // A request of a browser that another worker serves never sees the context of a call of MCP.
  CHECK(!other_thread_is_mcp);
}

// ---- the routes in the process ----

void test_a_route_runs_in_the_process() {
  RoutedServer server;
  std::string seen_capture;
  int calls = 0;
  server.Get("/api/things", [&](const httplib::Request& req, httplib::Response& res) {
    ++calls;
    res.status = 200;
    res.set_content(req.has_param("x") ? req.get_param_value("x") : std::string("none"), "text/plain");
  });
  server.Get(R"(/api/things/([^/]+))", [&](const httplib::Request& req, httplib::Response& res) {
    seen_capture = req.matches[1];
    res.set_content("one", "text/plain");
  });
  server.Post("/api/things", [&](const httplib::Request& req, httplib::Response& res) {
    res.status = 201;
    res.set_content(req.body, "text/plain");
  });

  httplib::Request list;
  list.method = "GET";
  list.path = "/api/things";
  list.params.emplace("x", "42");
  httplib::Response answer;
  CHECK(server.dispatch(list, answer));
  CHECK_EQ(answer.status, 200);
  CHECK_EQ(answer.body, std::string("42"));

  httplib::Request one;
  one.method = "GET";
  one.path = "/api/things/abc";
  httplib::Response one_answer;
  CHECK(server.dispatch(one, one_answer));
  CHECK_EQ(seen_capture, std::string("abc"));

  // The method counts: the POST route is not the GET one.
  httplib::Request create;
  create.method = "POST";
  create.path = "/api/things";
  create.body = "{\"a\":1}";
  httplib::Response created;
  CHECK(server.dispatch(create, created));
  CHECK_EQ(created.status, 201);
  CHECK_EQ(created.body, std::string("{\"a\":1}"));
  CHECK_EQ(calls, 1);

  // A path that no route matches is not run, and the answer is not touched.
  httplib::Request missing;
  missing.method = "GET";
  missing.path = "/api/other";
  httplib::Response none;
  none.status = 777;
  CHECK(!server.dispatch(missing, none));
  CHECK_EQ(none.status, 777);
  httplib::Request wrong_method;
  wrong_method.method = "DELETE";
  wrong_method.path = "/api/things";
  CHECK(!server.dispatch(wrong_method, none));

  // A pattern matches the whole path: a longer path is another route.
  httplib::Request longer;
  longer.method = "GET";
  longer.path = "/api/things/a/b";
  CHECK(!server.dispatch(longer, none));
  CHECK(server.has_route("GET", "/api/things"));
  CHECK(!server.has_route("PUT", "/api/things"));
}

void test_the_handler_sees_the_context_of_the_caller() {
  RoutedServer server;
  bool mcp_in_handler = false;
  std::string comment;
  server.Get("/api/ctx", [&](const httplib::Request&, httplib::Response& res) {
    mcp_in_handler = current_request_context().is_mcp();
    comment = ChQueryScope::current() ? ChQueryScope::current()->log_comment : std::string("none");
    res.status = 200;
  });
  RequestContext tool;
  tool.caller = RequestContext::Caller::Mcp;
  tool.limits.log_comment = "chdash-mcp key=k /api/ctx";
  RequestScope scope(tool);
  httplib::Request req;
  req.method = "GET";
  req.path = "/api/ctx";
  httplib::Response res;
  CHECK(server.dispatch(req, res));
  CHECK(mcp_in_handler);
  CHECK_EQ(comment, std::string("chdash-mcp key=k /api/ctx"));
}

} // namespace

int main() {
  test_admission_limits_each_key();
  test_admission_zero_is_no_limit();
  test_admission_a_waiter_gets_the_place_that_is_given_back();
  test_admission_the_wait_ends_with_the_time_and_with_stop();
  test_admission_many_threads_never_pass_the_limit();
  test_the_context_of_a_thread();
  test_the_context_does_not_cross_threads();
  test_a_route_runs_in_the_process();
  test_the_handler_sees_the_context_of_the_caller();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
