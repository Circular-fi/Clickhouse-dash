// Unit tests of the pure parts of the logs routes (src/logs_text.cpp, src/logs_drain.cpp): the text search and the patterns.
// The expected values were checked against the code that api_logs.cpp held before these units were split out: a differential run on 20,000
// generated messages gave the same tokens, terms, SQL, masks, templates and cluster ids.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_LOGS_TESTS=ON
//        cmake --build build --target chdash_logs_test
// Run:   ./build/chdash_logs_test   (exit code 0 = every check passed)
#include "logs_drain.hpp"
#include "logs_text.hpp"
#include "native_check.hpp"

#include <string>
#include <vector>

using namespace chdash;
using namespace chdash::logs;

namespace {

using Strings = std::vector<std::string>;

std::string join(const Strings& parts) {
  std::string out;
  for (const auto& p : parts) out += (out.empty() ? "" : "|") + p;
  return out;
}

void test_tokens() {
  CHECK_EQ(join(split_tokens("analytics.events_buffer")), "analytics|events|buffer");
  CHECK_EQ(join(split_tokens("key=user:12")), "key|user|12");
  CHECK_EQ(join(split_tokens("  ")), "");
  CHECK_EQ(join(split_tokens("")), "");
  // Bytes of UTF-8 belong to tokens, as in the tokenbf_v1 index.
  CHECK_EQ(join(split_tokens("caf\xC3\xA9 ok")), "caf\xC3\xA9|ok");
  CHECK(token_byte('a') && token_byte('Z') && token_byte('7') && token_byte(0x80));
  CHECK(!token_byte('_') && !token_byte('-') && !token_byte(' ') && !token_byte('.'));
  CHECK_EQ(to_lower_ascii("AbC-\xC3\x89"), "abc-\xC3\x89");
}

std::string terms_text(const std::string& q) {
  std::string out;
  for (const auto& t : parse_terms(q)) out += std::string(out.empty() ? "" : " ") + (t.negate ? "!" : "") + "[" + t.text + "]";
  return out;
}

void test_terms() {
  CHECK_EQ(terms_text("error timeout"), "[error] [timeout]");
  CHECK_EQ(terms_text("  error   timeout  "), "[error] [timeout]");
  CHECK_EQ(terms_text("\"connection reset\" peer"), "[connection reset] [peer]");
  CHECK_EQ(terms_text("-debug error"), "![debug] [error]");
  CHECK_EQ(terms_text("-\"a b\""), "![a b]");
  // A dash alone, or before a space, is a term of its own text.
  CHECK_EQ(terms_text("- x"), "[-] [x]");
  // A phrase without its closing quote runs to the end.
  CHECK_EQ(terms_text("\"open phrase"), "[open phrase]");
  CHECK_EQ(terms_text("\"\""), "");
  CHECK_EQ(terms_text(""), "");
}

void test_term_sql() {
  {
    SqlParams p;
    const std::string sql = token_term_sql({"timeout", false}, false, p);
    CHECK_EQ(sql, "(hasToken(Body, {p1:String}))");
    CHECK_EQ(p.list().size(), size_t(1));
    CHECK_EQ(p.list()[0].second, "timeout");
  }
  {
    // A term with separators must also appear verbatim.
    SqlParams p;
    const std::string sql = token_term_sql({"analytics.events_buffer", false}, false, p);
    CHECK_EQ(sql, "(hasToken(Body, {p1:String}) AND hasToken(Body, {p2:String}) AND hasToken(Body, {p3:String}) AND position(Body, {p4:String}) > 0)");
    CHECK_EQ(p.list()[3].second, "analytics.events_buffer");
  }
  {
    // A negated term, on a lowercased index: the tokens are lowercased and the verbatim check ignores case.
    SqlParams p;
    const std::string sql = token_term_sql({"Key=User", true}, true, p);
    CHECK_EQ(sql, "NOT (hasToken(lower(Body), {p1:String}) AND hasToken(lower(Body), {p2:String}) AND positionCaseInsensitive(Body, {p3:String}) > 0)");
    CHECK_EQ(p.list()[0].second, "key");
    CHECK_EQ(p.list()[1].second, "user");
    CHECK_EQ(p.list()[2].second, "Key=User");
  }
  {
    // The text of a user never reaches the statement.
    SqlParams p;
    const std::string sql = token_term_sql({"x') OR 1=1 --", false}, false, p);
    CHECK(sql.find("OR 1=1") == std::string::npos);
  }
  {
    SqlParams p;
    CHECK_EQ(substring_term_sql({"100%_ok", false}, p), "Body ILIKE {p1:String}");
    CHECK_EQ(p.list()[0].second, "%100\\%\\_ok%");
    SqlParams q;
    CHECK_EQ(substring_term_sql({"x", true}, q), "Body NOT ILIKE {p1:String}");
  }
}

void test_mask() {
  CHECK_EQ(mask_body("user 12345 logged in"), "user <*> logged in");
  CHECK_EQ(mask_body("v1 stays and 2 goes"), "v1 stays and <*> goes");
  CHECK_EQ(mask_body("took 12.5ms"), "took 12.5ms");
  CHECK_EQ(mask_body("took 12.5 ms"), "took <*> ms");
  CHECK_EQ(mask_body("from 10.0.0.12 port 80"), "from <*> port <*>");
  CHECK_EQ(mask_body("id 123e4567-e89b-12d3-a456-426614174000 done"), "id <*> done");
  CHECK_EQ(mask_body("trace 0af7651916cd43dd8448eb211c80319c end"), "trace <*> end");
  CHECK_EQ(mask_body("name \"alice\" and 'bob'"), "name <*> and <*>");
  // A quote glued to a word is not a string.
  CHECK_EQ(mask_body("don't panic"), "don't panic");
  // Two params in a row become one.
  CHECK_EQ(mask_body("1 2 3"), "<*> <*> <*>");
  CHECK_EQ(mask_body("\"a\"\"b\""), "<*>");
  // The text is cut at 2,048 bytes.
  CHECK_EQ(mask_body(std::string(5000, 'x')).size(), size_t(2048));
  CHECK_EQ(mask_body(""), "");
}

void test_tokens_of_a_message() {
  CHECK_EQ(join(whitespace_tokens("a  b\tc\nd")), "a|b|c|d");
  CHECK_EQ(whitespace_tokens(std::string(500, 'x') + " y").size(), size_t(2));
  std::string many;
  for (int i = 0; i < 100; ++i) many += "w" + std::to_string(i) + " ";
  CHECK_EQ(whitespace_tokens(many).size(), size_t(64));
}

void test_pattern_search_text() {
  CHECK_EQ(pattern_search_text({"user", kParam, "logged", "in"}), "user logged in");
  CHECK_EQ(pattern_search_text({"key=user:<*>"}), "key=user:");
  CHECK_EQ(pattern_search_text({kParam, kParam}), "");
  CHECK_EQ(pattern_search_text({"a<*>b"}), "a b");
  // A piece that starts with a dash would read as a negation: it is quoted.
  CHECK_EQ(pattern_search_text({"-flag"}), "\"-flag\"");
  Strings many;
  for (int i = 0; i < 40; ++i) many.push_back("w" + std::to_string(i));
  size_t spaces = 0;
  for (char c : pattern_search_text(many)) spaces += c == ' ';
  CHECK_EQ(spaces, kMaxTextTerms - 1);
}

void test_drain() {
  Drain drain;
  const auto add = [&](const std::string& message) { return drain.add(whitespace_tokens(mask_body(message))); };
  const size_t a = add("user 1 logged in from host-a");
  const size_t b = add("user 2 logged in from host-b");
  CHECK_EQ(a, b);
  CHECK_EQ(drain.clusters().size(), size_t(1));
  CHECK_EQ(join(drain.clusters()[a].tokens), "user|<*>|logged|in|from|<*>");
  CHECK_EQ(drain.clusters()[a].size, size_t(2));
  // Another length is another cluster, and so is a message with other words.
  const size_t c = add("disk full");
  CHECK(c != a);
  const size_t d = add("completely different words here and there");
  CHECK(d != a && d != c);
  CHECK_EQ(drain.clusters().size(), size_t(3));
  // The same message again joins its cluster.
  CHECK_EQ(add("disk full"), c);
  CHECK_EQ(drain.clusters()[c].size, size_t(2));
}

void test_drain_bounds() {
  // Messages of one length that start alike share a leaf: past 50 clusters a message joins the nearest one.
  Drain drain;
  for (int i = 0; i < 400; ++i) {
    Strings tokens = {"same", "start"};
    for (int k = 0; k < 6; ++k) tokens.push_back("w" + std::to_string((i * 7 + k * 13) % 97) + "x");
    drain.add(tokens);
  }
  CHECK(drain.clusters().size() <= 400);
  size_t total = 0;
  for (const auto& c : drain.clusters()) total += c.size;
  CHECK_EQ(total, size_t(400));
  // Many different first words: a node keeps 100 children at most (the rest go to the wildcard child).
  Drain wide;
  for (int i = 0; i < 300; ++i) wide.add({"first" + std::string(1, static_cast<char>('a' + i % 26)) + std::to_string(i / 26), "second", "third", "fourth"});
  size_t sum = 0;
  for (const auto& c : wide.clusters()) sum += c.size;
  CHECK_EQ(sum, size_t(300));
}

void test_severity() {
  CHECK_EQ(severity_index(0), 3);
  CHECK_EQ(severity_index(8), 3);
  CHECK_EQ(severity_index(9), 2);
  CHECK_EQ(severity_index(12), 2);
  CHECK_EQ(severity_index(13), 1);
  CHECK_EQ(severity_index(16), 1);
  CHECK_EQ(severity_index(17), 0);
  CHECK_EQ(severity_index(24), 0);
}

}  // namespace

int main() {
  RUN(test_tokens);
  RUN(test_terms);
  RUN(test_term_sql);
  RUN(test_mask);
  RUN(test_tokens_of_a_message);
  RUN(test_pattern_search_text);
  RUN(test_drain);
  RUN(test_drain_bounds);
  RUN(test_severity);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
