// Unit tests of the bounds. The bounds keep one small request from crashing the process.
// The bounds are the bounded JSON parse (src/json_parse.hpp), the depth guard of the SQL formatter
// (src/format_postprocess.cpp), and the rule that the formatter never changes comment text to code.
//
// Every case runs on a thread with a 128 KiB stack. This is the default thread stack of musl (the release
// binaries and the test image). What passes here cannot overflow a worker thread there.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF
//          -DCHDASH_BUILD_FORMAT_TESTS=ON
//        cmake --build build --target chdash_format_depth_test
// Run:   ./build/chdash_format_depth_test   (exit code 0 means that every check passed)

#include "format_postprocess.hpp"
#include "json_parse.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <pthread.h>

#include <chrono>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <string>
#include <vector>

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

#if defined(__SANITIZE_ADDRESS__)
#define CHDASH_TEST_ASAN 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define CHDASH_TEST_ASAN 1
#endif
#endif
#ifndef CHDASH_TEST_ASAN
#define CHDASH_TEST_ASAN 0
#endif

// AddressSanitizer adds padding to every frame and slows every call. With it, the same depth gets a larger stack and more time.
// The sanitized run looks for memory errors. The plain build proves the stack.
constexpr size_t kSmallStack = CHDASH_TEST_ASAN ? 8 * 1024 * 1024 : 128 * 1024;
// The formatter stops after 2 s (kFormatTimeBudget). The check itself gets a little more time.
constexpr double kMaxSeconds = CHDASH_TEST_ASAN ? 10.0 : 3.0;
constexpr size_t kWidth = 100;

// Runs `fn` on a thread with a stack of `stack_bytes`. It waits for the thread to finish.
void on_small_stack(const std::function<void()>& fn, size_t stack_bytes = kSmallStack) {
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, stack_bytes);
  auto* task = new std::function<void()>(fn);
  pthread_t thread;
  const int rc = pthread_create(
      &thread, &attr,
      [](void* arg) -> void* {
        auto* f = static_cast<std::function<void()>*>(arg);
        (*f)();
        delete f;
        return nullptr;
      },
      task);
  pthread_attr_destroy(&attr);
  if (rc != 0) {
    delete task;
    std::cerr << "pthread_create failed: " << rc << std::endl;
    std::exit(2);
  }
  pthread_join(thread, nullptr);
}

std::string repeat(const std::string& s, size_t n) {
  std::string out;
  out.reserve(s.size() * n);
  for (size_t i = 0; i < n; ++i) out += s;
  return out;
}

// ---- JSON --------------------------------------------------------------------------------------

void test_json_depth() {
  on_small_stack([] {
    // Thousands of levels are refused without recursion, as an invalid text.
    for (const size_t depth : {300, 2000, 100000}) {
      const std::string arrays = repeat("[", depth) + repeat("]", depth);
      rapidjson::Document doc;
      CHECK(!chdash::parse_json_bounded(doc, arrays));
      CHECK(doc.HasParseError());

      const std::string objects = repeat("{\"a\":", depth) + "1" + repeat("}", depth);
      rapidjson::Document doc2;
      CHECK(!chdash::parse_json_bounded(doc2, objects));
      CHECK(doc2.HasParseError());

      // An unclosed text is also refused.
      rapidjson::Document doc3;
      CHECK(!chdash::parse_json_bounded(doc3, repeat("[", depth)));
    }

    // At the limit, the text is parsed and written again. Accept recurses once for each level.
    {
      const size_t depth = chdash::kJsonMaxDepth;
      const std::string text = repeat("[", depth) + repeat("]", depth);
      rapidjson::Document doc;
      CHECK(chdash::parse_json_bounded(doc, text));
      rapidjson::StringBuffer sb;
      rapidjson::Writer<rapidjson::StringBuffer> w(sb);
      doc.Accept(w);
      CHECK(std::string(sb.GetString()) == text);
    }

    // Brackets in strings do not count. This includes escaped quotes.
    {
      const std::string text = "{\"sql\":\"" + repeat("((([[[{{{", 1000) + "\\\"" + repeat("[", 500) + "\"}";
      rapidjson::Document doc;
      CHECK(chdash::parse_json_bounded(doc, text));
      CHECK(doc.IsObject() && doc["sql"].IsString());
    }

    // An ordinary body is parsed. The flags of the caller still apply. Invalid UTF-8 is refused.
    {
      rapidjson::Document doc;
      CHECK(chdash::parse_json_bounded(doc, std::string("{\"host_id\":\"local\",\"sql\":\"SELECT 1\"}")));
      CHECK(doc["host_id"].GetString() == std::string("local"));
      rapidjson::Document bad;
      CHECK(!chdash::parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(bad, std::string("\"\xff\"")));
    }

    CHECK(!chdash::json_nests_deeper_than("[[[]]]", 3));
    CHECK(chdash::json_nests_deeper_than("[[[[]]]]", 3));
    CHECK(!chdash::json_nests_deeper_than("[\"[[[[\"]", 3));
  });
}

// ---- formatter depth ---------------------------------------------------------------------------

struct DeepCase {
  const char* name;
  std::function<std::string(size_t)> build;
};

std::vector<DeepCase> deep_cases() {
  return {
      {"function calls", [](size_t n) { return "SELECT " + repeat("plus(1, ", n) + "1" + repeat(")", n); }},
      {"nested calls with names", [](size_t n) { return "SELECT " + repeat("coalesce(toString(", n) + "x" + repeat("), 'y')", n) + " AS v FROM t"; }},
      {"subqueries", [](size_t n) { return repeat("SELECT * FROM (", n) + "SELECT 1" + repeat(")", n); }},
      {"IN subqueries", [](size_t n) { return repeat("SELECT a FROM t WHERE a IN (", n) + "SELECT 1" + repeat(")", n); }},
      {"lambdas", [](size_t n) { return "SELECT " + repeat("arrayMap(x -> ", n) + "x" + repeat(", [1])", n); }},
      {"lambda chain", [](size_t n) { return "SELECT " + repeat("x -> ", n) + "x"; }},
      {"arrays", [](size_t n) { return "SELECT " + repeat("[", n) + "1" + repeat("]", n); }},
      {"tuples", [](size_t n) { return "SELECT " + repeat("(1, ", n) + "1" + repeat(")", n); }},
      {"parentheses", [](size_t n) { return "SELECT " + repeat("(", n) + "1" + repeat(")", n); }},
      {"boolean", [](size_t n) { return "SELECT 1 FROM t WHERE " + repeat("(a = 1 AND (b = 2 OR ", n) + "c = 3" + repeat("))", n); }},
      {"arithmetic", [](size_t n) { return "SELECT " + repeat("1 + (2 * (", n) + "3" + repeat("))", n); }},
      {"CASE", [](size_t n) { return "SELECT " + repeat("CASE WHEN a = 1 THEN ", n) + "1" + repeat(" ELSE 0 END", n); }},
      {"multiIf", [](size_t n) { return "SELECT " + repeat("multiIf(a = 1, ", n) + "1" + repeat(", 0)", n); }},
      {"NOT", [](size_t n) { return "SELECT 1 FROM t WHERE " + repeat("NOT ", n) + "a"; }},
      {"EXISTS", [](size_t n) { return repeat("SELECT 1 WHERE EXISTS (", n) + "SELECT 1" + repeat(")", n); }},
      {"CTE subqueries", [](size_t n) { return "WITH x AS (" + repeat("SELECT * FROM (", n) + "SELECT 1" + repeat(")", n) + ") SELECT * FROM x"; }},
      {"UNION in parentheses", [](size_t n) { return repeat("SELECT * FROM (SELECT 1 UNION ALL ", n) + "SELECT 2" + repeat(")", n); }},
      {"window", [](size_t n) { return "SELECT sum(" + repeat("plus(1, ", n) + "x" + repeat(")", n) + ") OVER (PARTITION BY a ORDER BY b) FROM t"; }},
      {"comments", [](size_t n) { return "SELECT\n    " + repeat("plus( -- c\n1, ", n) + "1" + repeat(")", n); }},
      {"CREATE TABLE default", [](size_t n) { return "CREATE TABLE t (a UInt8 DEFAULT " + repeat("plus(1, ", n) + "1" + repeat(")", n) + ") ENGINE = Memory"; }},
      {"INSERT SELECT", [](size_t n) { return "INSERT INTO t " + repeat("SELECT * FROM (", n) + "SELECT 1" + repeat(")", n); }},
  };
}

void test_formatter_depth() {
  for (const auto& c : deep_cases()) {
    for (const size_t n : {4, 30, 62, 100, 300, 2000}) {
      const std::string sql = c.build(n);
      std::string out;
      double seconds = 0;
      on_small_stack([&] {
        const auto start = std::chrono::steady_clock::now();
        out = chdash::postprocess_format_query(sql, kWidth);
        seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
      });
      ++g_checks;
      if (out.empty()) {
        ++g_failures;
        std::cerr << c.name << " depth " << n << ": empty output" << std::endl;
      }
      ++g_checks;
      // The guard also limits the time. A deep statement is returned as written. It is not laid out for seconds.
      if (seconds > kMaxSeconds) {
        ++g_failures;
        std::cerr << c.name << " depth " << n << ": took " << seconds << " s" << std::endl;
      }
    }
  }
}

// Some layout passes are quadratic in the nesting. They do not recurse (a CASE in a CASE).
// The time budget returns the statement as written. It does not keep the thread for minutes.
void test_formatter_time_budget() {
  const std::string sql = "SELECT " + repeat("CASE WHEN a = 1 THEN ", 8000) + "1" + repeat(" ELSE 0 END", 8000) + " AS v FROM t";
  std::string out;
  double seconds = 0;
  on_small_stack([&] {
    const auto start = std::chrono::steady_clock::now();
    out = chdash::postprocess_format_query(sql, kWidth);
    seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  });
  CHECK(seconds < kMaxSeconds);
  CHECK(out == sql);
  // A later statement on the same thread has its own budget.
  std::string small;
  on_small_stack([&] { small = chdash::postprocess_format_query("select a, b from t where c = 1", kWidth); });
  CHECK(small.find("SELECT") != std::string::npos && small.find("FROM t") != std::string::npos);
}

// ---- comments stay comments --------------------------------------------------------------------

// The result is true when a line of `out` ends with the comment `--<body>`. Spaces after `--` and around the body are ignored.
// The comment is kept whole. None of its text changed to code.
bool comment_kept_whole(const std::string& out, const std::string& body) {
  size_t start = 0;
  while (start <= out.size()) {
    size_t end = out.find('\n', start);
    if (end == std::string::npos) end = out.size();
    const std::string line = out.substr(start, end - start);
    const size_t at = line.find("--");
    if (at != std::string::npos) {
      std::string tail = line.substr(at + 2);
      while (!tail.empty() && tail.front() == ' ') tail.erase(tail.begin());
      while (!tail.empty() && tail.back() == ' ') tail.pop_back();
      if (tail == body) return true;
    }
    start = end + 1;
  }
  return false;
}

void test_comments_stay_comments() {
  struct Case {
    std::string sql;
    std::string comment;  // the text after `--`, which must stay one comment
  };
  const std::vector<Case> cases = {
      {"DELETE FROM db.t WHERE id = 5 -- old version: or 1 = 1", "old version: or 1 = 1"},
      {"SELECT 1 -- columns: a, b", "columns: a, b"},
      {"SELECT dummy FROM system.one WHERE dummy = 0 -- disabled: or dummy = 1", "disabled: or dummy = 1"},
      {"SELECT a FROM t -- WHERE a > 0 AND b < 1", "WHERE a > 0 AND b < 1"},
      {"SELECT a, b FROM t -- ORDER BY a LIMIT 10", "ORDER BY a LIMIT 10"},
      {"SELECT a -- x, y FROM t", "x, y FROM t"},
      {"ALTER TABLE t DELETE WHERE id = 1 -- and later: OR id > 0", "and later: OR id > 0"},
      {"SELECT count() FROM t WHERE a = 1 -- was: AND b IS NULL", "was: AND b IS NULL"},
      {"SELECT a FROM t -- UNION ALL SELECT b FROM u", "UNION ALL SELECT b FROM u"},
      {"SELECT a FROM t WHERE x = 1 -- SETTINGS max_threads = 1", "SETTINGS max_threads = 1"},
      {"/* head */ SELECT a FROM t WHERE x = 1 -- FORMAT JSON", "FORMAT JSON"},
      // Leading commas: the comma of the next line must not be inside the comment.
      {"select a -- from the left table\n, b\nfrom t", "from the left table"},
      {"select a -- c\n, b -- d\n, c\nfrom t", "c"},
      {"select f(x -- first\n, y) from t", "first"},
      {"select [1 -- one\n, 2] as a", "one"},
      {"select a from t where b in (1 -- one\n, 2)", "one"},
      {"select a from t order by a -- first\n, b", "first"},
      {"select a, count() from t group by a -- key\n, b", "key"},
  };
  for (const auto& c : cases) {
    std::string out;
    on_small_stack([&] { out = chdash::postprocess_format_query(c.sql, kWidth); });
    ++g_checks;
    // The comment is whole. No comma was added to any comment.
    if (!comment_kept_whole(out, c.comment) || out.find(c.comment + ",") != std::string::npos) {
      ++g_failures;
      std::cerr << "comment split into code\n  in:  " << c.sql << "\n  out: " << out << std::endl;
    }
  }
}

} // namespace

int main() {
  test_json_depth();
  test_formatter_depth();
  test_formatter_time_budget();
  test_comments_stay_comments();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
