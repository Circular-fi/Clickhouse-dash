// Unit tests of the way a request is served: the admission of the heavy work (src/admission.hpp), the context of a request
// (src/request_context.cpp), the routes that are also callable in the process (src/routed_server.hpp), and the jobs of Deep
// Analyze (src/deep_analysis_jobs.hpp). No ClickHouse is needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_REQUEST_TESTS=ON
//        cmake --build build --target chdash_request_test
// Run:   ./build/chdash_request_test   (exit code 0 = every check passed)

#include "admission.hpp"
#include "deep_analysis_jobs.hpp"
#include "export_job.hpp"
#include "request_context.hpp"
#include "routed_server.hpp"

#include <atomic>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

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

// ---- the jobs of Deep Analyze (src/deep_analysis_jobs.hpp) ----

void test_deep_jobs_run_end_and_are_read_by_their_host() {
  DeepAnalysisJobs jobs(4, 1024, std::chrono::minutes(10));
  const auto a = jobs.start("h1", "q1", "job-a");
  CHECK(a.created && a.control);
  // The same query while its job runs is the same job: nothing new starts.
  const auto again = jobs.start("h1", "q1", "job-other");
  CHECK(!again.created && again.job_id == "job-a" && !again.control);
  CHECK(jobs.start("h2", "q1", "job-b").created);  // another host: another job

  DeepJobSnapshot job;
  CHECK(jobs.snapshot("job-a", "h1", &job));
  CHECK(job.state == DeepJobState::Running && job.query_id == "q1" && !job.result_json);
  CHECK(!jobs.snapshot("job-a", "h2", &job));  // a job of another host is not found
  CHECK(!jobs.snapshot("nope", "h1", &job));

  jobs.finish("job-a", "{\"plan\":1}");
  CHECK(jobs.snapshot("job-a", "h1", &job));
  CHECK(job.state == DeepJobState::Finished && job.result_json && *job.result_json == "{\"plan\":1}");
  CHECK_EQ(jobs.retained_bytes(), size_t(10));
  // A job that ended is not a running job any more: the query can start another one.
  CHECK(jobs.start("h1", "q1", "job-c").created);
  jobs.fail("job-c", "deep_analysis_failed", "boom", 502);
  CHECK(jobs.snapshot("job-c", "h1", &job));
  CHECK(job.state == DeepJobState::Failed && job.error_code == "deep_analysis_failed" && job.error_status == 502 && !job.result_json);
  // A job ends once: a second end does not change it.
  jobs.finish("job-c", "{}");
  CHECK(jobs.snapshot("job-c", "h1", &job) && job.state == DeepJobState::Failed);
}

void test_deep_jobs_cancel() {
  DeepAnalysisJobs jobs(4, 1024, std::chrono::minutes(10));
  const auto started = jobs.start("h1", "q1", "job-a");
  started.control->add_statement("stmt-1");
  CHECK(!started.control->cancel_requested());
  std::shared_ptr<DeepJobControl> control;
  CHECK(jobs.request_cancel("job-a", "h1", &control));
  CHECK(control && control->cancel_requested() && started.control->cancel_requested());
  CHECK_EQ(control->statements().size(), size_t(1));
  CHECK(!jobs.request_cancel("job-a", "h2", nullptr));  // not the host of the job
  CHECK(!jobs.request_cancel("nope", "h1", nullptr));
  CHECK_EQ(jobs.running_controls().size(), size_t(1));
  jobs.cancel_done("job-a");
  DeepJobSnapshot job;
  CHECK(jobs.snapshot("job-a", "h1", &job) && job.state == DeepJobState::Canceled);
  CHECK(jobs.running_controls().empty());
  // Canceling a job that ended is accepted and does nothing.
  std::shared_ptr<DeepJobControl> none;
  CHECK(jobs.request_cancel("job-a", "h1", &none) && !none);
  // A job that never started leaves no trace.
  CHECK(jobs.start("h1", "q2", "job-d").created);
  jobs.discard("job-d");
  CHECK(!jobs.snapshot("job-d", "h1", &job));
}

void test_deep_jobs_are_bounded() {
  // At most 3 jobs: the oldest that ended goes first, a job that runs never goes.
  DeepAnalysisJobs jobs(3, 1 << 20, std::chrono::minutes(10));
  jobs.start("h", "q0", "running");
  for (int i = 1; i <= 5; ++i) {
    const std::string id = "done-" + std::to_string(i);
    jobs.start("h", "q" + std::to_string(i), id);
    jobs.finish(id, "{}");
    std::this_thread::sleep_for(2ms);
  }
  DeepJobSnapshot job;
  CHECK(jobs.snapshot("running", "h", &job) && job.state == DeepJobState::Running);
  CHECK(!jobs.snapshot("done-1", "h", &job) && !jobs.snapshot("done-2", "h", &job) && !jobs.snapshot("done-3", "h", &job));
  CHECK(jobs.snapshot("done-4", "h", &job) && jobs.snapshot("done-5", "h", &job));
  CHECK_EQ(jobs.size(), size_t(3));

  // The bytes of the results are bounded too.
  DeepAnalysisJobs bytes(10, 100, std::chrono::minutes(10));
  for (int i = 0; i < 4; ++i) {
    const std::string id = "r" + std::to_string(i);
    bytes.start("h", id, id);
    bytes.finish(id, std::string(40, 'x'));
    std::this_thread::sleep_for(2ms);
  }
  CHECK(bytes.retained_bytes() <= 100);
  CHECK(!bytes.snapshot("r0", "h", &job) && !bytes.snapshot("r1", "h", &job));
  CHECK(bytes.snapshot("r3", "h", &job));

  // A result is kept for the retention, then it is gone.
  DeepAnalysisJobs brief(10, 1 << 20, 20ms);
  brief.start("h", "q", "j");
  brief.finish("j", "{}");
  CHECK(brief.snapshot("j", "h", &job));
  std::this_thread::sleep_for(60ms);
  CHECK(!brief.snapshot("j", "h", &job));
  CHECK_EQ(brief.retained_bytes(), size_t(0));
  // A job that runs is not dropped by the retention.
  brief.start("h", "q2", "j2");
  std::this_thread::sleep_for(60ms);
  CHECK(brief.snapshot("j2", "h", &job) && job.state == DeepJobState::Running);
}

void test_deep_jobs_many_threads() {
  DeepAnalysisJobs jobs(8, 1 << 16, std::chrono::minutes(1));
  std::vector<std::thread> threads;
  std::atomic<int> created{0};
  for (int t = 0; t < 6; ++t) {
    threads.emplace_back([&, t] {
      for (int i = 0; i < 200; ++i) {
        const std::string query = "q" + std::to_string(i % 10);
        const auto started = jobs.start("h", query, "job-" + std::to_string(t) + "-" + std::to_string(i));
        DeepJobSnapshot job;
        jobs.snapshot(started.job_id, "h", &job);
        if (started.created) {
          ++created;
          if (i % 3 == 0) jobs.fail(started.job_id, "c", "m", 500);
          else if (i % 3 == 1) jobs.finish(started.job_id, "{}");
          else jobs.cancel_done(started.job_id);
        }
        jobs.running_controls();
      }
    });
  }
  for (auto& thread : threads) thread.join();
  CHECK(created.load() > 0);
  CHECK(jobs.size() <= 8);
}

// ---- the pending exports (src/export_job.hpp) ----

void test_export_store_counts_the_bytes_of_the_entries_it_holds() {
  ExportJobStore store(std::chrono::minutes(1), 4, 1024);
  const auto job = [](const std::string& id, const std::string& sql) {
    ExportJob out;
    out.export_id = id;
    out.host_id = "h";
    out.queries = {sql};
    return out;
  };
  CHECK(store.put(job("a", std::string(100, 'x'))));
  CHECK_EQ(store.retained_sql_bytes(), size_t(100));
  // An id that is already pending is refused, and its bytes are not counted (the counter followed the emplace before).
  std::string error;
  CHECK(!store.put(job("a", std::string(50, 'y')), &error));
  CHECK(!error.empty());
  CHECK_EQ(store.retained_sql_bytes(), size_t(100));
  CHECK_EQ(store.size(), size_t(1));
  // The one-time capability: a second consume finds nothing, and the bytes go with the job.
  CHECK(store.consume("a", "h").has_value());
  CHECK(!store.consume("a", "h").has_value());
  CHECK_EQ(store.retained_sql_bytes(), size_t(0));
  // Another host cannot consume it.
  CHECK(store.put(job("b", "select 1")));
  CHECK(!store.consume("b", "other").has_value());
  CHECK(store.consume("b", "h").has_value());
}

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
  test_export_store_counts_the_bytes_of_the_entries_it_holds();
  test_deep_jobs_run_end_and_are_read_by_their_host();
  test_deep_jobs_cancel();
  test_deep_jobs_are_bounded();
  test_deep_jobs_many_threads();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
