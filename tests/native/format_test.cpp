// Unit tests of the SQL formatter as a service (src/format_service.cpp) with the layout units under it (src/format_*.cpp), on a fake
// ClickHouse: no server. The fake answers formatQuery with the text it got and EXPLAIN AST with the tokens of the text (no comment, no
// parenthesis, no case, no backtick), so two layouts of one statement have one tree and a statement that was corrupted has another.
//
// What is checked: a text with comments never reaches formatQuery and is laid out locally; the check of the meaning (ARCH-B-120) returns the
// text as written, with a warning, when the layout reads as another statement, and stays out of the way when ClickHouse cannot judge; an
// error of ClickHouse is placed in the text that the user wrote, not in the text that was sent (ARCH-B-125); the size limits; and, for
// every fixture of tests/api/format/input and a list of statements with comments, the properties of the layout: no crash, the same text
// again gives itself (idempotence), the tokens do not change, the comments do not change.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_FORMAT_TESTS=ON
//        cmake --build build --target chdash_format_test
// Run:   ./build/chdash_format_test [fixtures directory]   (exit code 0 = every check passed)

#include "format_cache.hpp"
#include "format_fake_port.hpp"
#include "format_service.hpp"
#include "native_check.hpp"
#include "sql_lexer.hpp"
#include "sql_scan.hpp"
#include "sql_util.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

using namespace chdash;

namespace {

FormatSettings scratch_settings() {
  FormatSettings settings;
  settings.use_cache = false;
  settings.cache_scope = "h\x1f" "26.7";
  return settings;
}

// One text through the service, from scratch.
FormatOutcome format_once(FakePort& port, const std::string& sql, FormatSettings settings = scratch_settings()) {
  FormatBatch batch(nullptr, settings, port);
  return batch.format(sql);
}

// The comments of a text, each one without its marks and its blanks: the layout may move the marks of a comment and re-wrap a block comment.
std::string line_comments(const std::string& sql) {
  std::string out;
  for (const sql::Token& token : sql::lex(sql)) {
    if (!sql::is_comment(token.kind)) continue;
    std::string body(token.text(sql));
    while (!body.empty() && (body.front() == '-' || body.front() == '#' || body.front() == '/' || body.front() == '*')) body.erase(0, 1);
    while (!body.empty() && (body.back() == '/' || body.back() == '*')) body.pop_back();
    // No blank at all: the layout writes `double-quoted` in a block comment as `double - quoted`.
    std::string words;
    for (const char c : body) {
      if (!std::isspace(static_cast<unsigned char>(c))) words.push_back(c);
    }
    out += words + "\n";
  }
  return out;
}

// ---- The crash of a column list that ends with a comma ----

void test_a_column_list_with_a_trailing_comma_is_laid_out() {
  FakePort port;
  const FormatOutcome out = format_once(port, "-- c\nCREATE TABLE t\n(\n    a UInt8,\n)\nENGINE = Log");
  CHECK(out.ok());
  CHECK(!out.warning);
  CHECK(out.formatted->find("`a` UInt8\n)") != std::string::npos);
  // With a comment inside the list, the same.
  const FormatOutcome inner = format_once(port, "CREATE TABLE t\n(\n    a UInt8, -- the key\n    b String,\n)\nENGINE = Log");
  CHECK(inner.ok());
  CHECK(inner.formatted->find("-- the key") != std::string::npos);
}

// ---- The check of the meaning (ARCH-B-120) ----

void test_a_layout_that_changes_the_statement_is_not_returned() {
  FakePort port;
  // The local layout reads `(SELECT 1) INSERT INTO t2` as the name of an alias: another statement.
  const std::string text = "WITH t AS (SELECT 1) INSERT INTO t2 SELECT * FROM t -- c";
  const FormatOutcome out = format_once(port, text);
  CHECK(out.ok());
  CHECK(out.warning.has_value());
  CHECK_EQ(*out.formatted, text);
  CHECK(out.warning && out.warning->code == "format_meaning_changed");
  CHECK_EQ(port.ast_calls.size(), size_t(2));
  CHECK_EQ(port.format_calls.size(), size_t(0));
  // A warning is not kept in the cache: the answer of the next request is checked again.
  FormatCache cache(16, 1 << 20, std::chrono::minutes(1));
  FormatSettings settings = scratch_settings();
  settings.use_cache = true;
  FormatBatch first(&cache, settings, port);
  CHECK(first.format(text).warning.has_value());
  FormatBatch second(&cache, settings, port);
  CHECK(second.format(text).warning.has_value());
  CHECK_EQ(second.stats().cache_hits, size_t(0));
  // The same text twice in a request: one check, and the second answer has the warning too.
  FakePort port2;
  FormatBatch batch(nullptr, settings, port2);
  CHECK(batch.format(text).warning.has_value());
  const FormatOutcome again = batch.format(text);
  CHECK(again.warning.has_value());
  CHECK_EQ(port2.ast_calls.size(), size_t(2));
}

void test_a_layout_that_keeps_the_statement_has_no_warning() {
  FakePort port;
  const FormatOutcome out = format_once(port, "select a,b -- keep me\nfrom t where x=1 and y=2");
  CHECK(out.ok());
  CHECK(!out.warning);
  CHECK(out.formatted->find("-- keep me") != std::string::npos);
  CHECK(out.formatted->find("\nFROM t\n") != std::string::npos);
  CHECK_EQ(port.ast_calls.size(), size_t(2));
  // A statement that does not go local is not checked: formatQuery is the layout.
  FakePort plain;
  CHECK(format_once(plain, "select a,b from t").ok());
  CHECK_EQ(plain.ast_calls.size(), size_t(0));
}

void test_a_statement_that_cannot_be_judged_keeps_its_layout() {
  const std::string text = "select a -- c\nfrom t";
  {  // ClickHouse cannot parse the statement that was written.
    FakePort port;
    port.ast_refuses = "from t";
    const FormatOutcome out = format_once(port, text);
    CHECK(out.ok() && !out.warning);
    CHECK(out.formatted->find("FROM t") != std::string::npos);
    CHECK_EQ(port.ast_calls.size(), size_t(1));
  }
  {  // ClickHouse cannot be reached.
    FakePort port;
    port.ast_fails = FormatQueryFailureKind::transport;
    const FormatOutcome out = format_once(port, text);
    CHECK(out.ok() && !out.warning);
    CHECK(out.formatted->find("FROM t") != std::string::npos);
  }
  {  // The text is longer than what ClickHouse reads: it is formatted and not checked.
    FakePort port;
    FormatSettings settings = scratch_settings();
    settings.clickhouse_max_query_size = 20;
    const FormatOutcome out = format_once(port, text + " where x = 1", settings);
    CHECK(out.ok() && !out.warning);
    CHECK_EQ(port.ast_calls.size(), size_t(0));
  }
  {  // The formatted text is refused because it is longer than ClickHouse reads: that is not a change of the statement.
    class LongPort final : public FakePort {
    public:
      FormatQueryResult explain_ast(const std::string& sql, size_t max) override {
        FormatQueryResult result = FakePort::explain_ast(sql, max);
        if (sql.find("FROM") != std::string::npos) {
          result = FormatQueryResult();
          result.failure = FormatQueryFailureKind::server;
          result.message = "Max query size exceeded (can be increased with the `max_query_size` setting)";
        }
        return result;
      }
    } port;
    const FormatOutcome out = format_once(port, text);
    CHECK(out.ok() && !out.warning);
    CHECK(out.formatted->find("FROM t") != std::string::npos);
  }
  {  // The formatted statement is refused and the written one is not: that is a change.
    FakePort port;
    port.ast_refuses = "FROM";
    const FormatOutcome out = format_once(port, text);
    CHECK(out.warning.has_value());
    CHECK_EQ(*out.formatted, text);
  }
}

void test_the_rows_of_an_insert_are_compared_as_tokens() {
  CHECK(values_rows_unchanged("INSERT INTO t VALUES (1, 'a b'), (2, 'c')", "INSERT INTO t\nVALUES\n    (1, 'a b'),\n    (2, 'c')"));
  // ClickHouse takes the rows with or without a comma between them.
  CHECK(values_rows_unchanged("INSERT INTO t VALUES (1,11)(2,12)(4,13)", "INSERT INTO t VALUES (1, 11), (2, 12), (4, 13)"));
  CHECK(!values_rows_unchanged("INSERT INTO t VALUES (1,11)(2,12)", "INSERT INTO t VALUES (1, 11, 2, 12)"));
  CHECK(values_rows_unchanged("insert into t values (1) -- c", "INSERT INTO t\nVALUES\n    (1) -- c"));
  CHECK(!values_rows_unchanged("INSERT INTO t VALUES (1, 2)", "INSERT INTO t VALUES (1, 3)"));
  CHECK(!values_rows_unchanged("INSERT INTO t VALUES (1), (2)", "INSERT INTO t VALUES (1)"));
  CHECK(!values_rows_unchanged("INSERT INTO t VALUES ('a')", "INSERT INTO t VALUES (\"a\")"));
  FakePort port;
  const FormatOutcome out = format_once(port, "insert into t (a, b) values (1, 'x'), (2, 'y') -- two rows");
  CHECK(out.ok() && !out.warning);
  CHECK(out.formatted->find("-- two rows") != std::string::npos);
  CHECK(out.formatted->find("(2, 'y')") != std::string::npos);
}

// ---- The place of an error (ARCH-B-125) ----

void test_an_error_is_placed_in_the_text_of_the_user() {
  // A reserved word used as an alias is written between backticks before ClickHouse reads it: two bytes more.
  FakePort port;
  port.error_marker = "@@";
  const std::string text = "select 1 as from, 2 as `to`, @@ from t";
  const FormatOutcome out = format_once(port, text);
  CHECK(!out.ok());
  CHECK(out.failure == FormatQueryFailureKind::server);
  CHECK(out.error_offset.has_value());
  CHECK_EQ(*out.error_offset, text.find("@@"));
  CHECK(port.format_calls.size() == 1 && port.format_calls[0].find("`from`") != std::string::npos);
  // The message says the place in the user's text, on its line.
  CHECK(out.error.find("position " + std::to_string(text.find("@@") + 1) + " ") != std::string::npos);
  CHECK(out.error.find("(line 1, col " + std::to_string(text.find("@@") + 1) + ")") != std::string::npos);

  // The blanks that the text starts with and a line break before the place.
  const std::string multi = "\n\n  select 1 as from,\n   @@";
  const FormatOutcome second = format_once(port, multi);
  CHECK(second.error_offset.has_value());
  CHECK_EQ(*second.error_offset, multi.find("@@"));
  CHECK(second.error.find("(line 4, col 4)") != std::string::npos);

  // A heredoc that holds more bytes than its placeholder, and a literal on many lines.
  const std::string heredoc = "select $$a long body of the heredoc 'x'$$ as h, 'one\ntwo' as m, @@";
  const FormatOutcome third = format_once(port, heredoc);
  CHECK(third.error_offset.has_value());
  CHECK_EQ(*third.error_offset, heredoc.find("@@"));
  CHECK(port.format_calls.back().find("$$") == std::string::npos);
}

void test_offsets_of_the_text_that_was_sent() {
  // Two aliases between backticks: 2 bytes each.
  const std::vector<std::pair<size_t, size_t>> quoted = {{5, 9}, {20, 22}};
  SqlHeredocMask none;
  CHECK_EQ(offset_in_user_text(3, quoted, none, ""), size_t(3));
  CHECK_EQ(offset_in_user_text(5, quoted, none, ""), size_t(5));   // the opening backtick
  CHECK_EQ(offset_in_user_text(7, quoted, none, ""), size_t(6));   // inside the word
  CHECK_EQ(offset_in_user_text(12, quoted, none, ""), size_t(10)); // after the word
  CHECK_EQ(offset_in_user_text(28, quoted, none, ""), size_t(24)); // after both
  CHECK_EQ(offset_in_user_text(500, {}, none, ""), size_t(500));
  // The message of ClickHouse is rewritten for the place in the user's text.
  const std::string text = "select 1,\n  2 @";
  CHECK_EQ(rebase_error_position("Syntax error: failed at position 99 ('@') (line 7, col 3): @.", text, text.find('@')),
           std::string("Syntax error: failed at position 15 ('@') (line 2, col 5): @."));
  CHECK_EQ(rebase_error_position("no place in this one", text, 3), std::string("no place in this one"));
}

// ---- The limits (ARCH-B-125) ----

void test_a_text_that_is_too_long_is_refused_with_its_limit() {
  FakePort port;
  FormatSettings settings = scratch_settings();
  settings.max_sql_bytes = 40;
  const FormatOutcome big = format_once(port, "select a, b, c, d, e, f, g, h, i, j, k, l, m from t", settings);
  CHECK(big.failure == FormatQueryFailureKind::input);
  CHECK(big.error.find("limit is 40 bytes") != std::string::npos);
  CHECK_EQ(port.format_calls.size(), size_t(0));

  // ClickHouse reads max_query_size bytes: the text counts with its quoted words, and the answer says it.
  FormatSettings server = scratch_settings();
  server.clickhouse_max_query_size = 30;
  const FormatOutcome refused = format_once(port, "select 1 as from, 2 as to, 3 as end, 4 from t", server);
  CHECK(refused.failure == FormatQueryFailureKind::input);
  CHECK(refused.error.find("max_query_size") != std::string::npos);
  CHECK(refused.error.find("once its reserved words are quoted") != std::string::npos);
  CHECK_EQ(port.format_calls.size(), size_t(0));
  // A text under the limit goes through. The words that are quoted do not make it too long for the first check of the service.
  FormatSettings wide = scratch_settings();
  wide.clickhouse_max_query_size = 1000;
  CHECK(format_once(port, "select 1 as from, 2 as end from t", wide).ok());
}

// ---- One layout for an ALTER with or without a comment (ARCH-B-121) ----

// The statement as it is laid out without a comment (the way of formatQuery, here faked by the identity) and with one at the end of its first
// line and one at the end: the lines are the same lines, and each comment is where it was written.
void test_an_alter_has_one_layout_with_and_without_comments() {
  const char* const kAlters[] = {
      "ALTER TABLE db.t ADD COLUMN a UInt8",
      "ALTER TABLE db.t ADD COLUMN IF NOT EXISTS a UInt8 AFTER b",
      "ALTER TABLE db.t DROP COLUMN b",
      "ALTER TABLE db.t ADD COLUMN a UInt8, DROP COLUMN b, MODIFY COLUMN c String",
      "ALTER TABLE db.t UPDATE a = 1, b = today() WHERE c = 3",
      "ALTER TABLE db.t DELETE WHERE d < toDate('2025-01-01')",
      "ALTER TABLE db.t MODIFY TTL d + INTERVAL 30 DAY",
      "ALTER TABLE db.t ADD INDEX i x TYPE minmax GRANULARITY 4, MATERIALIZE INDEX i",
      "ALTER TABLE db.t ON CLUSTER c DROP PARTITION 202512, MOVE PARTITION 202601 TO TABLE db.u",
      "ALTER TABLE db.t DELETE WHERE d < 1 SETTINGS mutations_sync = 2",
  };
  for (const char* alter : kAlters) {
    FakePort plain_port;
    const FormatOutcome plain = format_once(plain_port, alter);
    CHECK(plain.ok() && !plain.warning);
    // A comment at the end of the statement.
    FakePort port;
    const FormatOutcome commented = format_once(port, std::string(alter) + " -- note");
    CHECK(commented.ok() && !commented.warning);
    if (!plain.ok() || !commented.ok()) continue;
    CHECK_EQ(port.format_calls.size(), size_t(0));
    std::string without = *commented.formatted;
    const size_t note = without.find(" -- note");
    CHECK(note != std::string::npos);
    if (note != std::string::npos) without.erase(note, 8);
    // The text of the layout may have ended its last line with the comment: without it, the same lines.
    if (without != *plain.formatted) {
      std::cerr << alter << ": the layout changes with a comment\n--- without\n" << *plain.formatted << "\n--- with\n" << *commented.formatted << "\n";
      CHECK_EQ(without, *plain.formatted);
    }
    // A comment before the statement, and one after the first command.
    FakePort lead_port;
    const FormatOutcome lead = format_once(lead_port, std::string("-- lead\n") + alter);
    CHECK(lead.ok() && !lead.warning);
    CHECK_EQ(lead.formatted ? *lead.formatted : std::string(), "-- lead\n" + *plain.formatted);
  }
  // A comment after the comma between two commands stays on the line of the command before it.
  FakePort port;
  const FormatOutcome between = format_once(port, "ALTER TABLE db.t ADD COLUMN a UInt8, -- first\nDROP COLUMN b, -- second\nMODIFY COLUMN c String");
  CHECK(between.ok() && !between.warning);
  CHECK_EQ(*between.formatted, std::string("ALTER TABLE db.t\nADD COLUMN `a` UInt8, -- first\nDROP COLUMN b, -- second\nMODIFY COLUMN `c` String"));
  // A comma inside a command is not the end of it.
  const FormatOutcome update = format_once(port, "ALTER TABLE db.t UPDATE a = 1, b = today() WHERE c = 3 -- note");
  CHECK(update.formatted && update.formatted->find("b = today()") != std::string::npos);
  CHECK(update.formatted && update.formatted->find("today\n(") == std::string::npos);
}

// ---- The restoration of the spelling (ARCH-B-122) ----

void test_a_name_that_formatquery_drops_does_not_stop_the_restoration() {
  // formatQuery writes `x::T` as CAST(x, 'T'): the name T has no name of its own in its text. The names after it are still given back.
  const std::string original = "select \"a\", x::Foo, \"b\", \"c\" from t";
  const std::string formatted = "SELECT `a`, CAST(x, 'Foo'), `b`, `c` FROM t";
  CHECK_EQ(restore_sql_quoted_identifiers(formatted, original), std::string("SELECT \"a\", CAST(x, 'Foo'), \"b\", \"c\" FROM t"));
  // The same names in the same order: the same as before.
  CHECK_EQ(restore_sql_quoted_identifiers("SELECT `a`, `b` FROM t", "select \"a\", \"b\" from t"), std::string("SELECT \"a\", \"b\" FROM t"));
  // A quoted name is matched to a name of its value, not to an earlier one that is written without quotes.
  CHECK_EQ(restore_sql_quoted_identifiers("SELECT a AS `a`, `b`", "select a as a, \"b\""), std::string("SELECT a AS `a`, \"b\""));
}

void test_the_restoration_of_literals_is_not_quadratic() {
  const size_t count = 60000;
  std::string original = "SELECT ", formatted = "SELECT ";
  for (size_t i = 0; i < count; ++i) {
    original += (i ? ", 'a" : "'a") + std::to_string(i) + "'";
    // Literals that the source does not have, then the ones that it has.
    formatted += (i ? ", 'z" : "'z") + std::to_string(i) + "'";
  }
  const auto started = std::chrono::steady_clock::now();
  const std::string restored = restore_sql_single_quoted_literals(formatted, original);
  CHECK_EQ(restored, formatted);
  CHECK(std::chrono::steady_clock::now() - started < std::chrono::seconds(3));
  // The literals that are in the source come back with their own spelling, in order.
  CHECK_EQ(restore_sql_single_quoted_literals("SELECT 'it\\'s', 'x', 'y'", "select 'it''s', 'y'"), std::string("SELECT 'it''s', 'x', 'y'"));
}

// ---- The budget ----

// A statement that is quadratic in its nesting gives up after the budget of the formatter (2 s) and comes back as written: the call
// returns, and the text is the user's text (it keeps its meaning).
void test_a_statement_that_is_too_deep_comes_back_as_written() {
  std::string text = "SELECT ";
  const int depth = 3000;
  for (int i = 0; i < depth; ++i) text += "CASE WHEN a THEN ";
  text += "1";
  for (int i = 0; i < depth; ++i) text += " ELSE 0 END";
  text += " -- note";
  FakePort port;
  const auto started = std::chrono::steady_clock::now();
  const FormatOutcome out = format_once(port, text);
  CHECK(std::chrono::steady_clock::now() - started < std::chrono::seconds(20));
  CHECK(out.ok());
  CHECK(out.formatted && out.formatted->find("-- note") != std::string::npos);
  // Whatever the layout is, the tokens are the tokens of the text.
  CHECK(out.formatted && (out.warning || fake_tree(*out.formatted) == fake_tree(text)));
}

// ---- The properties of the layout ----

// The statements of the properties: comments in every place that the layout reads, and the shapes that broke the layout.
const char* const kStatements[] = {
    "-- a\nSELECT 1",
    "SELECT a, b -- x\nFROM t -- y\nWHERE a = 1 -- z\n  AND b = 2",
    "SELECT a, /* one */ b, c FROM t /* two */",
    "SELECT count() /* c */ FROM t GROUP BY a -- g\nHAVING count() > 1 -- h\nORDER BY a -- o\nLIMIT 5 -- l",
    "WITH x AS (SELECT 1 -- inner\n) SELECT * FROM x",
    "WITH 1 AS x -- c\nSELECT x",
    "SELECT * FROM (SELECT a -- c\nFROM t) AS s JOIN u ON s.a = u.a -- on\nWHERE u.b IN (1, 2, 3)",
    "SELECT if(a > 1, 'big', 'small') -- c\nAS size, multiIf(a = 1, 'x', a = 2, 'y', 'z') AS m FROM t",
    "SELECT arrayMap(x -> x + 1, [1, 2, 3]) -- c\n, map('a', 1) FROM t",
    "SELECT sum(x) OVER (PARTITION BY a ORDER BY b -- w\n) FROM t",
    "SELECT CASE WHEN a THEN 1 -- one\nELSE 2 END FROM t",
    "SELECT a FROM t WHERE x IN (SELECT y FROM u -- c\n)",
    "SELECT a FROM t UNION ALL -- u\nSELECT b FROM u",
    "INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y') -- rows",
    "INSERT INTO t SELECT a FROM u -- c",
    "CREATE TABLE t (a UInt8, -- key\n b String) ENGINE = MergeTree ORDER BY a -- sort",
    "CREATE TABLE t\n(\n    a UInt8,\n)\nENGINE = Log -- last",
    "CREATE VIEW v AS SELECT a FROM t -- c",
    "ALTER TABLE t ADD COLUMN a UInt8 -- c",
    "ALTER TABLE t ADD COLUMN a UInt8, -- first\nDROP COLUMN b -- second",
    "ALTER TABLE t UPDATE a = today(), b = 2 WHERE c = 3 -- c",
    "ALTER TABLE t DELETE WHERE d < toDate('2025-01-01') -- c",
    "SELECT 'it''s' -- quote\n, \"a b\" FROM `t x`",
    "SELECT $$raw 'text' -- not a comment$$ AS h -- real",
    "SELECT 1 AS from -- c",
    "SELECT a -- c\nFROM t LIMIT 1 OFFSET 2",
    "SELECT toDate('2025-01-01') + INTERVAL 1 DAY -- c",
    "SHOW TABLES FROM db -- c",
    "SET max_threads = 4 -- c",
    "OPTIMIZE TABLE t FINAL -- c",
    "KILL QUERY WHERE user = 'x' -- c",
    "DELETE FROM t WHERE id = 5 -- old version: or 1 = 1",
    "SELECT 1 -- columns: a, b",
};

// The tokens of a text that the layout must keep: the words, the numbers and the strings, in their order, in lower case, without the parentheses and the
// backticks. Redundant parentheses are the only thing that the layout removes from the code.
std::string kept_tokens(const std::string& sql) { return fake_tree(sql); }

// What the fake cannot tell: ClickHouse reads `(t.1).2` as `t.1.2`, and `LIFETIME(3600)` as `LIFETIME(MIN 0 MAX 3600)`. The meaning of these
// is checked by the AST suite on a real server (tests/api/format).
// The fixture 596 is a statement that the local layout would change: it must come back as written, with the warning.
bool fake_cannot_judge(const std::string& name) {
  return name.rfind("197_", 0) == 0 || name.rfind("424_", 0) == 0 || name.rfind("596_", 0) == 0;
}

// Known: a statement with a hundred levels of redundant parentheses is laid out on the width of its text with them, and the second pass, on the
// text without them, puts its only item on the SELECT line.
bool known_not_idempotent(const std::string& name) { return name.rfind("582_", 0) == 0; }

void check_properties(const std::string& name, const std::string& text, int* checked) {
  FakePort port;
  FormatSettings settings = scratch_settings();
  FormatOutcome first = format_once(port, text, settings);
  if (!first.ok()) {
    CHECK(first.ok());
    return;
  }
  ++*checked;
  // The meaning: the fake judges the tokens, so a layout that changed them came back as written with a warning.
  if (first.warning && fake_cannot_judge(name)) return;
  if (first.warning) {
    std::cerr << name << ": warning: " << first.warning->message << "\n";
    CHECK(!first.warning);
    return;
  }
  const std::string& once = *first.formatted;
  // The comments come out as they went in.
  CHECK_EQ(line_comments(once), line_comments(text));
  // The service takes the blanks and the `;` off the end of the text.
  const std::string written = trim_sql(text);
  if (kept_tokens(once) != kept_tokens(written)) {
    const std::string a = kept_tokens(once), b = kept_tokens(written);
    size_t at = 0;
    while (at < a.size() && at < b.size() && a[at] == b[at]) ++at;
    std::cerr << name << ": the tokens changed near: " << a.substr(at > 40 ? at - 40 : 0, 80) << "\n  was: " << b.substr(at > 40 ? at - 40 : 0, 80) << "\n";
    CHECK(false);
  }
  // Idempotence: the layout of a layout is the layout.
  FakePort again_port;
  const FormatOutcome again = format_once(again_port, once, settings);
  CHECK(again.ok());
  if (again.ok() && *again.formatted != once && !known_not_idempotent(name)) {
    std::cerr << name << ": not idempotent\n--- first\n" << once << "\n--- second\n" << *again.formatted << "\n";
    CHECK_EQ(*again.formatted, once);
  }
  // No trailing blank at the end of a line.
  for (size_t at = once.find(" \n"); at != std::string::npos; at = once.find(" \n", at + 1)) {
    const size_t line_start = once.rfind('\n', at) == std::string::npos ? 0 : once.rfind('\n', at) + 1;
    // A blank inside a line comment or a literal is the author's.
    if (line_comments(once.substr(line_start, at + 1 - line_start)).empty() && once.substr(line_start, at - line_start).find('\'') == std::string::npos) {
      std::cerr << name << ": a blank at the end of a line\n" << once << "\n";
      CHECK(false);
      break;
    }
  }
}

void test_properties_of_statements_with_comments() {
  int checked = 0;
  for (const char* statement : kStatements) check_properties(statement, statement, &checked);
  CHECK_EQ(checked, static_cast<int>(sizeof(kStatements) / sizeof(kStatements[0])));
  // At every width.
  for (int width : {40, 60, 100, 200}) {
    FakePort port;
    FormatSettings settings = scratch_settings();
    settings.line_width = width;
    for (const char* statement : kStatements) {
      const FormatOutcome out = format_once(port, statement, settings);
      CHECK(out.ok());
      CHECK(!out.warning);
    }
  }
}

// A comment that holds code never becomes code (ARCH-B-117): the comment keeps its text and its line.
void test_a_comment_stays_a_comment() {
  FakePort port;
  const FormatOutcome out = format_once(port, "DELETE FROM db.t WHERE id = 5 -- old version: or 1 = 1");
  CHECK(out.ok() && !out.warning);
  CHECK(out.formatted->find("id = 5 -- old version: or 1 = 1") != std::string::npos);
  CHECK(out.formatted->find("\nOR ") == std::string::npos);
  const FormatOutcome columns = format_once(port, "SELECT 1 -- columns: a, b");
  CHECK(columns.ok() && !columns.warning);
  CHECK_EQ(columns.formatted->find("\n"), std::string::npos);
}

// The `in` of a name is not the operator IN (ARCH-B-125): `admin(SELECT 1)` is a call and stays one.
void test_the_in_inside_a_name_is_not_an_operator() {
  FakePort port;
  const FormatOutcome out = format_once(port, "SELECT * FROM t WHERE x = admin(SELECT 1) AND y > 1 -- c");
  CHECK(out.ok() && !out.warning);
  CHECK(out.formatted->find("admin(SELECT 1)") != std::string::npos);
  CHECK(out.formatted->find(" IN ") == std::string::npos);
  const FormatOutcome real = format_once(port, "SELECT * FROM t WHERE x in (SELECT y FROM u) -- c");
  CHECK(real.ok() && !real.warning);
  CHECK(real.formatted->find("x IN (") != std::string::npos);
}

void test_properties_of_the_fixtures(const std::filesystem::path& dir) {
  if (!std::filesystem::is_directory(dir)) {
    std::cout << "no fixtures at " << dir << ": the properties of the fixtures are not checked\n";
    return;
  }
  std::vector<std::filesystem::path> files;
  for (const auto& entry : std::filesystem::directory_iterator(dir)) {
    if (entry.path().extension() == ".sql") files.push_back(entry.path());
  }
  std::sort(files.begin(), files.end());
  int checked = 0, skipped = 0;
  for (const auto& path : files) {
    std::ifstream in(path, std::ios::binary);
    const std::string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    // A comment on the first line sends the statement to the local layout, so the layout of every construct of the fixtures is run.
    check_properties(path.filename().string(), "-- fixture\n" + text, &checked);
    (void)skipped;
  }
  CHECK(checked >= static_cast<int>(files.size()) - 5);
  std::cout << checked << " fixtures laid out locally\n";
}

}  // namespace

int main(int argc, char** argv) {
  RUN(test_a_column_list_with_a_trailing_comma_is_laid_out);
  RUN(test_a_layout_that_changes_the_statement_is_not_returned);
  RUN(test_a_layout_that_keeps_the_statement_has_no_warning);
  RUN(test_a_statement_that_cannot_be_judged_keeps_its_layout);
  RUN(test_the_rows_of_an_insert_are_compared_as_tokens);
  RUN(test_an_error_is_placed_in_the_text_of_the_user);
  RUN(test_offsets_of_the_text_that_was_sent);
  RUN(test_a_text_that_is_too_long_is_refused_with_its_limit);
  RUN(test_an_alter_has_one_layout_with_and_without_comments);
  RUN(test_a_name_that_formatquery_drops_does_not_stop_the_restoration);
  RUN(test_the_restoration_of_literals_is_not_quadratic);
  RUN(test_a_statement_that_is_too_deep_comes_back_as_written);
  RUN(test_properties_of_statements_with_comments);
  RUN(test_a_comment_stays_a_comment);
  RUN(test_the_in_inside_a_name_is_not_an_operator);
  const std::filesystem::path fixtures = argc > 1 ? argv[1] : "tests/api/format/input";
  RUN([&] { test_properties_of_the_fixtures(fixtures); });
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
