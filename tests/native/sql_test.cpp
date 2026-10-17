// Unit tests of the SQL text of ChDash. They check what is written into a statement (src/sql_literal.hpp).
// They check how a statement is read (src/sql_lexer.hpp, the one lexer).
// They check what is read from it (src/sql_structure.hpp, src/user_sql_policy.cpp, src/mcp_sql.cpp, src/sql_scan.hpp).
// No ClickHouse is needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_SQL_TESTS=ON
//        cmake --build build --target chdash_sql_test
// Run:   ./build/chdash_sql_test   (exit code 0 = every check passed)

#include "format_service.hpp"
#include "mcp_sql.hpp"
#include "sql_lexer.hpp"
#include "sql_literal.hpp"
#include "sql_params.hpp"
#include "sql_scan.hpp"
#include "sql_structure.hpp"
#include "user_sql_policy.hpp"

#include <rapidjson/document.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

using namespace chdash;

// The kernels of the page that read SQL. The test builds them natively (tests/native/wasm_kernel_*.c).
extern "C" int chdash_wasm_highlight(const unsigned short* text, int len, signed char* kinds);
extern "C" int chdash_wasm_split(const unsigned short* text, int len, int* out, int max);
extern "C" int chdash_wasm_statement(const unsigned short* text, int len, int cursor, int* out);

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
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK_EQ failed: " #a " == " #b << "\n  left:  "    \
                << ::dump(va) << "\n  right: " << ::dump(vb) << std::endl;                               \
    }                                                                                                    \
  } while (0)

// The text with each byte that is not printable as \xHH. A failure shows what the text holds.
std::string dump(const std::string& s) {
  std::string out = "\"";
  for (const char c : s) {
    const auto u = static_cast<unsigned char>(c);
    if (u < 0x20 || u >= 0x7f) {
      char buf[8];
      std::snprintf(buf, sizeof(buf), "\\x%02X", static_cast<unsigned>(u));
      out += buf;
    } else {
      out.push_back(c);
    }
  }
  return out + "\"";
}
std::string dump(size_t n) { return std::to_string(n); }
std::string dump(const std::vector<std::string>& items) {
  std::string out = "[";
  for (const auto& item : items) out += (out.size() > 1 ? ", " : "") + dump(item);
  return out + "]";
}

// ---- sql_params.hpp ----

void test_params() {
  SqlParams params;
  CHECK(params.list().empty());
  CHECK_EQ(params.key(), std::string());
  // The value stays out of the text. Only the placeholder is written. The code keeps the value as it is.
  CHECK_EQ(params.text("o'rei\\lly"), std::string("{p1:String}"));
  CHECK_EQ(params.texts({"a", "b'c"}), std::string("{p2:String}, {p3:String}"));
  CHECK_EQ(params.texts({}), std::string("''"));
  CHECK_EQ(params.list().size(), static_cast<size_t>(3));
  CHECK_EQ(params.list()[0].first, std::string("p1"));
  CHECK_EQ(params.list()[0].second, std::string("o'rei\\lly"));
  CHECK_EQ(params.list()[1].second, std::string("a"));
  CHECK_EQ(params.list()[2].second, std::string("b'c"));
  // A copy continues from the same number. A route can then add to the parameters of its filters.
  SqlParams copy = params;
  CHECK_EQ(copy.text("x"), std::string("{p4:String}"));
  CHECK_EQ(params.list().size(), static_cast<size_t>(3));
  // The key separates two requests that have the same text and other values.
  SqlParams one, two;
  one.text("a");
  two.text("b");
  CHECK(one.key() != two.key());
  SqlParams again;
  again.text("a");
  CHECK_EQ(one.key(), again.key());
  // A value with a separator cannot make two lists look the same.
  SqlParams joined, split;
  joined.text(std::string("a\0p2\0b", 6));
  split.text("a");
  split.text("b");
  CHECK(joined.key() != split.key());
}

// ---- sql_literal.hpp ----

void test_literals() {
  CHECK_EQ(sql::quote_string("abc"), std::string("'abc'"));
  CHECK_EQ(sql::quote_string(""), std::string("''"));
  CHECK_EQ(sql::quote_string("o'rei\\lly"), std::string("'o\\'rei\\\\lly'"));
  CHECK_EQ(sql::quote_string("a\nb\tc\rd"), std::string("'a\\nb\\tc\\rd'"));
  CHECK_EQ(sql::quote_string(std::string("a\0b", 3)), std::string("'a\\0b'"));
  CHECK_EQ(sql::quote_string("a\x01" "b"), std::string("'a\\x01b'"));
  CHECK_EQ(sql::quote_string("' OR 1=1 --"), std::string("'\\' OR 1=1 --'"));
  // A text that ends with a backslash does not escape the quote mark that closes it.
  CHECK_EQ(sql::quote_string("abc\\"), std::string("'abc\\\\'"));
  CHECK_EQ(sql::quote_string("caf\xc3\xa9"), std::string("'caf\xc3\xa9'"));

  CHECK_EQ(sql::quote_ident("a"), std::string("`a`"));
  CHECK_EQ(sql::quote_ident("a`b"), std::string("`a\\`b`"));
  CHECK_EQ(sql::quote_ident("a\\b"), std::string("`a\\\\b`"));
  // SEC-014: a name made of a backslash and a backtick stays one name.
  CHECK_EQ(sql::quote_ident("x\\` UNION SELECT 1 --"), std::string("`x\\\\\\` UNION SELECT 1 --`"));
  CHECK_EQ(sql::quote_ident(""), std::string("``"));
  CHECK_EQ(sql::quote_qualified("db", "t"), std::string("`db`.`t`"));
  CHECK_EQ(sql::hex_id_array({}), std::string("[]"));
  CHECK_EQ(sql::hex_id_array({"ab", "b'c", "0F", "x", "", "a\\b"}), std::string("['ab', '0F']"));
  CHECK(sql::is_hex_trace_id("3bf7651916cd43dd8448eb211c80319c") && !sql::is_hex_trace_id("3bf7651916cd43dd8448eb211c80319g"));
  CHECK(!sql::is_hex_trace_id(std::string(65, 'a')) && sql::is_hex_trace_id(std::string(64, 'a')));
  CHECK_EQ(sql::quote_list({}), std::string("''"));
  CHECK_EQ(sql::quote_list({"a", "b"}), std::string("'a', 'b'"));
  CHECK_EQ(sql::like_escape("50%_off\\"), std::string("50\\%\\_off\\\\"));

  // The lexer returns one token, whatever the text holds.
  for (const std::string& text : {std::string("a'b"), std::string("\\"), std::string("\\'"), std::string("x\\\\'y"),
                                  std::string("--"), std::string("/*"), std::string("`"), std::string("\"")}) {
    const std::string quoted = sql::quote_string(text);
    const auto tokens = sql::lex(quoted);
    CHECK_EQ(tokens.size(), size_t(1));
    CHECK(tokens[0].kind == sql::TokenKind::String && tokens[0].closed);
    const std::string name = sql::quote_ident(text);
    const auto name_tokens = sql::lex(name);
    CHECK_EQ(name_tokens.size(), size_t(1));
    CHECK(name_tokens[0].kind == sql::TokenKind::QuotedIdent && name_tokens[0].closed);
  }
}

// ---- sql_lexer.hpp ----

std::string kinds(const std::string& sql) {
  std::string out;
  for (const auto& token : sql::lex(sql)) {
    switch (token.kind) {
      case sql::TokenKind::Blank: out += "_"; break;
      case sql::TokenKind::LineComment: out += "L"; break;
      case sql::TokenKind::BlockComment: out += token.closed ? "B" : "b"; break;
      case sql::TokenKind::Word: out += "W"; break;
      case sql::TokenKind::QuotedIdent: out += token.closed ? "Q" : "q"; break;
      case sql::TokenKind::String: out += token.closed ? "S" : "s"; break;
      case sql::TokenKind::HereDoc: out += token.closed ? "H" : "h"; break;
      case sql::TokenKind::Number: out += "N"; break;
      case sql::TokenKind::Punct: out += "P"; break;
      case sql::TokenKind::Unknown: out += "U"; break;
    }
  }
  return out;
}

void test_lexer_rules() {
  CHECK_EQ(kinds("SELECT 1"), std::string("W_N"));
  CHECK_EQ(kinds("a.b"), std::string("WPW"));
  CHECK_EQ(kinds("f(x, 'y')"), std::string("WPWP_S" "P"));
  // Comments. "--" is always one; "#" only before a blank or "!"; a block comment nests.
  CHECK_EQ(kinds("1--2"), std::string("NL"));
  CHECK_EQ(kinds("1 -- x\n2"), std::string("N_L_N"));
  CHECK_EQ(kinds("1 # x\n2"), std::string("N_L_N"));
  CHECK_EQ(kinds("1 #! x"), std::string("N_L"));
  CHECK_EQ(kinds("1 #x"), std::string("N_UW"));
  CHECK_EQ(kinds("1 /* a /* b */ c */ 2"), std::string("N_B_N"));
  CHECK_EQ(kinds("1 /* a /* b */"), std::string("N_b"));
  CHECK_EQ(kinds("/**/"), std::string("B"));
  // Texts and names: an escape, a doubled mark, an unclosed one.
  CHECK_EQ(kinds("'a\\'b'"), std::string("S"));
  CHECK_EQ(kinds("'a''b'"), std::string("S"));
  CHECK_EQ(kinds("'abc"), std::string("s"));
  CHECK_EQ(kinds("`a\\`b`"), std::string("Q"));
  CHECK_EQ(kinds("\"a\"\"b\""), std::string("Q"));
  CHECK_EQ(kinds("`a"), std::string("q"));
  CHECK_EQ(kinds("'a\\"), std::string("s"));
  // Heredocs.
  CHECK_EQ(kinds("$$a'b$$"), std::string("H"));
  CHECK_EQ(kinds("$tag$a$$b$tag$"), std::string("H"));
  CHECK_EQ(kinds("$$abc"), std::string("h"));
  CHECK_EQ(kinds("a$b"), std::string("W"));
  CHECK_EQ(kinds("$1"), std::string("W"));
  // Numbers.
  CHECK_EQ(kinds("0x1F 1e3 1_000 .5 1.e3 0b101 1e-5 0x1p-3"), std::string("N_N_N_N_N_N_N_N"));
  CHECK_EQ(kinds("1-2"), std::string("NPN"));
  // The Unicode spaces of the ClickHouse lexer are blanks.
  CHECK_EQ(kinds("KILL\xc2\xa0QUERY"), std::string("W_W"));
  CHECK_EQ(kinds("KILL\xe2\x80\x8b" "QUERY"), std::string("W_W"));
  CHECK_EQ(kinds("KILL\xef\xbb\xbfQUERY"), std::string("W_W"));
  CHECK_EQ(kinds("KILL\xe3\x80\x80QUERY"), std::string("W_W"));
  CHECK_EQ(kinds("\xef\xbb\xbfSELECT"), std::string("_W"));

  // Joined in order, the tokens are the text, with no gap.
  for (const std::string& sql : {std::string("SELECT 'a' /* c */ FROM `t` -- x\nWHERE a = $$b$$ #! y"), std::string("'"),
                                std::string("\\"), std::string("/*"), std::string("$"), std::string("\xff\xfe")}) {
    std::string joined;
    size_t at = 0;
    bool contiguous = true;
    for (const auto& token : sql::lex(sql)) {
      contiguous = contiguous && token.begin == at && token.end > token.begin;
      joined += std::string(token.text(sql));
      at = token.end;
    }
    CHECK(contiguous);
    CHECK_EQ(joined, sql);
  }

  CHECK_EQ(sql::utf16_offset("abc", 2), size_t(2));
  CHECK_EQ(sql::utf16_offset("a\xc3\xa9" "b", 3), size_t(2));        // a, e acute | b
  CHECK_EQ(sql::utf16_offset("a\xf0\x9f\x98\x80" "b", 5), size_t(3));  // a, a surrogate pair | b
}

// A small generator of hostile statements. It makes the pieces that the rules above describe.
std::string random_sql(uint64_t& seed, size_t length) {
  static const char* const kPieces[] = {"'", "\"", "`", "\\", "-", "--", "#", "# ", "#!", "/", "*", "/*", "*/", "$", "$$", "$a$",
                                        " ", "\n", "a", "KILL", "QUERY", "1", ".", "(", ")", ";", "\xc2\xa0", ",", "\r", "e", "x"};
  std::string out;
  for (size_t i = 0; i < length; ++i) {
    seed = seed * 6364136223846793005ULL + 1442695040888963407ULL;
    out += kPieces[(seed >> 33) % (sizeof(kPieces) / sizeof(kPieces[0]))];
  }
  return out;
}

// sql::Scan and sql::lex read the same text in the same way. For the Scan, a byte is code when no quote, comment or heredoc is open before it and after it.
// For the lexer, a byte is code when it is in a blank, a word, a number or punctuation.
void test_scan_follows_the_lexer() {
  uint64_t seed = 12345;
  for (int round = 0; round < 4000; ++round) {
    const std::string sql = random_sql(seed, 1 + round % 24);
    std::vector<bool> lexer_code(sql.size(), false);
    for (const auto& token : sql::lex(sql)) {
      const bool code = token.kind == sql::TokenKind::Blank || token.kind == sql::TokenKind::Word ||
                        token.kind == sql::TokenKind::Number || token.kind == sql::TokenKind::Punct ||
                        token.kind == sql::TokenKind::Unknown;
      for (size_t i = token.begin; i < token.end; ++i) lexer_code[i] = code;
    }
    sql::Scan scan;
    bool same = true;
    for (size_t i = 0; i < sql.size(); ++i) {
      const bool before = scan.in_code();
      const size_t from = i;
      scan.step(sql, i);
      const bool code = before && scan.in_code();
      for (size_t k = from; k <= i; ++k) {
        // The line break that ends a line comment is a blank for the lexer and part of the comment for the Scan.
        if (sql[k] == '\n' || sql[k] == '\r') continue;
        if (lexer_code[k] != code) same = false;
      }
    }
    if (!same) std::cerr << "scan and lexer differ on: " << dump(sql) << std::endl;
    CHECK(same);
  }
}

// ---- the policy of the user SQL (SEC-011) ----

void test_kill_policy() {
  CHECK(user_sql_is_forbidden("KILL QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("  kill   query where 1"));
  CHECK(user_sql_is_forbidden("/* a */ KILL /* b */ QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("-- x\nKILL QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("# x\nKILL QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("/* /* nested */ */ KILL QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("SELECT 1; KILL QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("SELECT 'a;b'; KILL QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden(";;; KILL QUERY WHERE 1"));
  // The Unicode spaces that ClickHouse accepts between the tokens.
  CHECK(user_sql_is_forbidden("KILL\xc2\xa0QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("KILL\xe2\x80\x8b" "QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("\xe3\x80\x80KILL\xe3\x80\x80QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("\xef\xbb\xbfKILL QUERY WHERE 1"));
  CHECK(user_sql_is_forbidden("KILL\xe2\x80\xa8QUERY WHERE 1"));
  // Not a statement that starts with it.
  CHECK(!user_sql_is_forbidden("SELECT 1"));
  CHECK(!user_sql_is_forbidden("SELECT 'KILL QUERY'"));
  CHECK(!user_sql_is_forbidden("SELECT 1 -- KILL QUERY"));
  CHECK(!user_sql_is_forbidden("SELECT 1 /* KILL QUERY */"));
  CHECK(!user_sql_is_forbidden("SELECT $$; KILL QUERY$$"));
  CHECK(!user_sql_is_forbidden("SELECT `a;` FROM t WHERE x = 'KILL'; SELECT 2"));
  CHECK(!user_sql_is_forbidden("KILL MUTATION WHERE 1"));
  CHECK(!user_sql_is_forbidden("KILLQUERY"));
  CHECK(!user_sql_is_forbidden("KILL$QUERY"));
  CHECK(!user_sql_is_forbidden("SYSTEM KILL QUERY"));
  CHECK(!user_sql_is_forbidden(""));
  CHECK(!user_sql_is_forbidden("   "));
  // An unclosed text swallows the rest: there is no second statement in it.
  CHECK(!user_sql_is_forbidden("SELECT 'a; KILL QUERY WHERE 1"));
  // Every hostile text is read to its end without a crash.
  uint64_t seed = 99;
  for (int round = 0; round < 3000; ++round) (void)user_sql_is_forbidden(random_sql(seed, 1 + round % 30));
}

// ---- sql_scan.hpp ----

void test_mask() {
  const auto masked = mask_sql_surface("SELECT 'A--b' /* C */, \"D\", `E`, $$F$$ -- G\nFROM t");
  CHECK_EQ(masked.code_lower.size(), std::string("SELECT 'A--b' /* C */, \"D\", `E`, $$F$$ -- G\nFROM t").size());
  CHECK(masked.has_comments);
  CHECK_EQ(masked.code_lower.find('a'), std::string::npos);
  CHECK_EQ(masked.code_lower.find('d'), std::string::npos);
  CHECK_EQ(masked.code_lower.find('f'), masked.code_lower.find("from"));
  CHECK_EQ(masked.code_lower.find('g'), std::string::npos);
  CHECK(masked.code_lower.find("select") == 0);
  CHECK(masked.code_lower.find("from t") != std::string::npos);
  CHECK(!mask_sql_surface("SELECT 'a'").has_comments);
  CHECK(mask_sql_surface("SELECT 1 # x").has_comments);
  CHECK(!mask_sql_surface("SELECT 1 #x").has_comments);

  CHECK_EQ(sql_first_keyword_lower("-- c\n  /* d */ Select 1"), std::string("select"));
  CHECK_EQ(sql_first_keyword_lower("   "), std::string(""));
  CHECK_EQ(sql_first_keyword_lower("'x' with"), std::string("with"));

  const auto ranges = sql_single_quoted_literal_ranges("a 'b' \"c\" 'd''e' $$'f'$$ /* 'g' */ 'h");
  CHECK_EQ(ranges.size(), size_t(2));

  // The tokens of the names: a doubled mark, an escape and a Unicode space are read as ClickHouse reads them.
  const auto idents = sql_identifier_tokens("SELECT `a``b`, \"c\\\"d\", e");
  CHECK_EQ(idents.size(), size_t(4));
  CHECK_EQ(idents[1].decoded, std::string("a`b"));
  CHECK_EQ(idents[2].decoded, std::string("c\"d"));
}

// ---- mcp_sql.cpp ----

void test_mcp_scan() {
  const std::vector<std::string> allowed = {"SELECT", "WITH"};
  CHECK(mcp_scan_single_statement("SELECT 1", allowed).ok);
  CHECK(!mcp_scan_single_statement("SELECT 1; SELECT 2", allowed).ok);
  CHECK_EQ(mcp_scan_single_statement("SELECT * FROM file('x')", allowed).error, std::string("function_not_allowed"));
  // A Unicode space between the name and the bracket is no way around the list of table functions.
  CHECK_EQ(mcp_scan_single_statement("SELECT * FROM file\xc2\xa0('x')", allowed).error, std::string("function_not_allowed"));
  CHECK_EQ(mcp_scan_single_statement("SELECT * FROM file/* c */('x')", allowed).error, std::string("function_not_allowed"));
  CHECK_EQ(mcp_scan_single_statement("SELECT 1 INTO\xe2\x80\x8b" "OUTFILE 'x'", allowed).error, std::string("clause_not_allowed"));
  CHECK_EQ(mcp_scan_single_statement("SELECT 'a", allowed).error, std::string("invalid_sql"));
  CHECK_EQ(mcp_scan_single_statement("SELECT 1 /* a /* b */", allowed).error, std::string("invalid_sql"));
  CHECK(mcp_scan_single_statement("SELECT 1 /* a /* b */ c */", allowed).ok);
  CHECK(mcp_scan_single_statement("SELECT $$a;b$$", allowed).ok);
}

// ---- sql_structure.hpp ----

std::string names(const std::vector<sql::QualifiedName>& list) {
  std::string out;
  for (const auto& n : list) out += (out.empty() ? "" : " ") + n.database + "." + n.table;
  return out;
}

void test_structure() {
  CHECK_EQ(sql::engine_arguments("Buffer('db', 'tbl', 16, 10, 100)", "Buffer"),
           (std::vector<std::string>{"db", "tbl", "16", "10", "100"}));
  CHECK_EQ(sql::engine_arguments("Distributed('c', currentDatabase(), 'tbl', sipHash64(id, 'x,y'))", "Distributed"),
           (std::vector<std::string>{"c", "currentDatabase()", "tbl", "sipHash64(id, x,y)"}));
  CHECK_EQ(sql::engine_arguments("Distributed(`c`, `d b`, t)", "Distributed"), (std::vector<std::string>{"c", "d b", "t"}));
  CHECK_EQ(sql::engine_arguments("MergeTree ORDER BY x", "Buffer"), std::vector<std::string>{});
  CHECK_EQ(sql::engine_arguments("Buffer()", "Buffer"), (std::vector<std::string>{""}));
  CHECK_EQ(sql::engine_arguments("Buffer('a\\'b', 'c')", "Buffer"), (std::vector<std::string>{"a'b", "c"}));

  CHECK_EQ(names(sql::relation_sources("SELECT a FROM t1 JOIN db2.t2 ON t1.k = t2.k", "d")), std::string("d.t1 db2.t2"));
  CHECK_EQ(names(sql::relation_sources("SELECT * FROM `a b`.`c-d`", "d")), std::string("a b.c-d"));
  // A subquery and an IN (SELECT ...) are followed; a CTE is not a table.
  CHECK_EQ(names(sql::relation_sources("SELECT * FROM (SELECT * FROM inner_t) AS s", "d")), std::string("d.inner_t"));
  CHECK_EQ(names(sql::relation_sources("SELECT * FROM t WHERE k IN (SELECT k FROM other)", "d")), std::string("d.t d.other"));
  CHECK_EQ(names(sql::relation_sources("WITH c AS (SELECT * FROM base) SELECT * FROM c JOIN t ON 1", "d")), std::string("d.base d.t"));
  // Not tables: an ARRAY JOIN, a table function, FROM inside EXTRACT and IS DISTINCT FROM.
  CHECK_EQ(names(sql::relation_sources("SELECT x FROM t ARRAY JOIN arr AS x", "d")), std::string("d.t"));
  CHECK_EQ(names(sql::relation_sources("SELECT * FROM numbers(10) AS n JOIN remote('h', db, t) USING x", "d")), std::string(""));
  CHECK_EQ(names(sql::relation_sources("SELECT EXTRACT(YEAR FROM ts), a IS NOT DISTINCT FROM b FROM t", "d")), std::string("d.t"));
  CHECK_EQ(names(sql::relation_sources("SELECT 'FROM nope' /* FROM nope2 */ FROM t -- FROM nope3", "d")), std::string("d.t"));
  // A comma join, an alias, FINAL.
  CHECK_EQ(names(sql::relation_sources("SELECT * FROM a AS x, b y, c FINAL WHERE 1", "d")), std::string("d.a d.b d.c"));
  CHECK_EQ(names(sql::relation_sources("SELECT * FROM a UNION ALL SELECT * FROM a", "d")), std::string("d.a"));

  const auto target = sql::materialized_view_target("CREATE MATERIALIZED VIEW v TO db.dst AS SELECT 1", "d");
  CHECK(target && target->database == "db" && target->table == "dst");
  const auto bare = sql::materialized_view_target("CREATE MATERIALIZED VIEW v TO dst (x Int8) AS SELECT 1", "d");
  CHECK(bare && bare->database == "d" && bare->table == "dst");
  CHECK(!sql::materialized_view_target("CREATE MATERIALIZED VIEW v ENGINE = MergeTree ORDER BY x TTL t TO VOLUME 'cold' AS SELECT 1", "d"));
  CHECK(!sql::materialized_view_target("CREATE MATERIALIZED VIEW v AS SELECT * FROM t WITH FILL TO 10", "d"));
  CHECK(!sql::materialized_view_target("CREATE VIEW v AS SELECT 1", "d"));

  CHECK_EQ(sql::table_ttl_clause("CREATE TABLE t (a Int8 TTL x + 1) ENGINE = MergeTree ORDER BY a TTL d + INTERVAL 1 DAY SETTINGS x = 1"),
           std::string("d + INTERVAL 1 DAY"));
  CHECK_EQ(sql::table_ttl_clause("CREATE TABLE t (a Int8 TTL x + 1) ENGINE = MergeTree ORDER BY a"), std::string(""));

  CHECK(sql::find_keyword("a (b TO c) TO d", "TO") == std::optional<size_t>(11));
  CHECK(sql::find_keyword("x 'TO' /* TO */ `TO` y", "TO") == std::nullopt);
  CHECK(sql::find_keyword("a  to   volume 'x'", "TO VOLUME") == std::optional<size_t>(3));
  CHECK(sql::find_keyword("a TO DISK 'x'", "TO VOLUME") == std::nullopt);
  CHECK_EQ(sql::split_top_level("a, f(b, c), 'd,e', [1, 2], g"), (std::vector<std::string>{"a", "f(b, c)", "'d,e'", "[1, 2]", "g"}));
  CHECK_EQ(sql::split_top_level(" , a,, "), (std::vector<std::string>{"a"}));
  CHECK(sql::find_last_top_level("a + f(b + c) + d", '+', 100) == std::optional<size_t>(13));
  CHECK(sql::find_last_top_level("a + f(b + c) + d", '+', 5) == std::optional<size_t>(2));
  CHECK_EQ(sql::compact_spaces("  a   b\n  'c   d'  e  "), std::string("a b 'c   d' e"));
  CHECK_EQ(sql::clause_arguments("x LIFETIME(MIN 0   MAX 300) y", "LIFETIME").value_or("-"), std::string("MIN 0 MAX 300"));
  CHECK(!sql::clause_arguments("x LIFETIME(MIN 0", "LIFETIME"));
  CHECK(!sql::clause_arguments("x (LIFETIME(1))", "LIFETIME"));

  size_t pos = 0;
  const auto name = sql::parse_qualified_name(" `a``b` . c$d rest", pos, "d");
  CHECK(name && name->database == "a`b" && name->table == "c$d");
  pos = 0;
  CHECK(!sql::parse_identifier("`abc", pos));
}

// ---- format_service.cpp ----

// formatQuery, faked. It returns the text, or it fails as the test sets.
class FakePort final : public FormatQueryPort {
public:
  std::vector<std::string> calls;
  FormatQueryFailureKind fail_with = FormatQueryFailureKind::none;
  std::string fail_text = "Syntax error";

  FormatQueryResult format_query(const std::string& sql, size_t) override {
    calls.push_back(sql);
    FormatQueryResult result;
    if (fail_with != FormatQueryFailureKind::none) {
      result.failure = fail_with;
      result.message = fail_text;
      return result;
    }
    result.formatted_sql = sql;
    return result;
  }
  // No tree: this test does not judge a statement that the local layout formats (tests/native/format_test.cpp judges it).
  FormatQueryResult explain_ast(const std::string&, size_t) override {
    FormatQueryResult result;
    result.failure = FormatQueryFailureKind::server;
    result.message = "no syntax tree in this fake";
    return result;
  }
};

void test_format_service() {
  FormatCache cache(16, 1 << 20, std::chrono::minutes(1));
  FormatSettings settings;
  settings.cache_scope = "h\x1f" "26.7";

  // A statement without comments goes to ClickHouse once; the same text again is a hit of the cache.
  {
    FakePort port;
    FormatBatch batch(&cache, settings, port);
    const FormatOutcome first = batch.format("select a,b from t where x=1");
    CHECK(first.ok());
    CHECK_EQ(port.calls.size(), size_t(1));
    CHECK_EQ(batch.stats().cache_misses, size_t(1));
    // The same text in the same request is not formatted again (one miss, one duplicate).
    const FormatOutcome again = batch.format("  select a,b from t where x=1;  ");
    CHECK(again.ok());
    CHECK_EQ(port.calls.size(), size_t(1));
    CHECK_EQ(batch.stats().deduplicated, size_t(1));
    CHECK(again.formatted == first.formatted);
  }
  {
    FakePort port;
    FormatBatch batch(&cache, settings, port);
    CHECK(batch.format("select a,b from t where x=1").ok());
    CHECK_EQ(port.calls.size(), size_t(0));  // the cache of an earlier request
    CHECK_EQ(batch.stats().cache_hits, size_t(1));
  }
  // When `use_cache` is false, the code formats from scratch. A host or version that differs gives another key.
  {
    FakePort port;
    FormatSettings scratch = settings;
    scratch.use_cache = false;
    FormatBatch batch(&cache, scratch, port);
    CHECK(batch.format("select a,b from t where x=1").ok());
    CHECK_EQ(port.calls.size(), size_t(1));
    FormatSettings other = settings;
    other.cache_scope = "h\x1f" "27.1";
    FakePort port2;
    FormatBatch batch2(&cache, other, port2);
    CHECK(batch2.format("select a,b from t where x=1").ok());
    CHECK_EQ(port2.calls.size(), size_t(1));
  }
  // A comment keeps the statement away from ClickHouse (formatQuery would drop the comment): the local layout keeps it.
  {
    FakePort port;
    FormatBatch batch(nullptr, settings, port);
    const FormatOutcome out = batch.format("SELECT a -- keep me\nFROM t");
    CHECK(out.ok());
    CHECK_EQ(port.calls.size(), size_t(0));
    CHECK(out.formatted->find("-- keep me") != std::string::npos);
  }
  // An INSERT with a payload. The code keeps the payload apart, and it restores the payload byte for byte after the formatted statement.
  {
    FakePort port;
    FormatBatch batch(nullptr, settings, port);
    const FormatOutcome out = batch.format("insert into t (a, b) format CSV\n1,'x y'\n2,\"it's\"");
    CHECK(out.ok());
    CHECK_EQ(port.calls.size(), size_t(1));
    CHECK(port.calls[0].find("1,'x y'") == std::string::npos);
    CHECK(out.formatted->find("1,'x y'\n2,\"it's\"") != std::string::npos);
  }
  // A heredoc reaches ClickHouse as a placeholder. The code restores the heredoc as it was written.
  {
    FakePort port;
    FormatBatch batch(nullptr, settings, port);
    const FormatOutcome out = batch.format("select $$a 'b' -- c$$ as x");
    CHECK(out.ok());
    CHECK(port.calls.size() == 1 && port.calls[0].find("$$") == std::string::npos);
    CHECK(out.formatted->find("$$a 'b' -- c$$") != std::string::npos);
  }
  // The failures say what they are.
  {
    FakePort port;
    port.fail_with = FormatQueryFailureKind::server;
    FormatBatch batch(nullptr, settings, port);
    const FormatOutcome out = batch.format("select (");
    CHECK(!out.ok());
    CHECK(out.failure == FormatQueryFailureKind::server);
    CHECK_EQ(out.error, std::string("Syntax error"));
    port.fail_with = FormatQueryFailureKind::timeout;
    CHECK(batch.format("select 2 from t").failure == FormatQueryFailureKind::timeout);
    CHECK(FormatBatch(nullptr, settings, port).format("   ").failure == FormatQueryFailureKind::input);
    FormatSettings small = settings;
    small.max_sql_bytes = 10;
    FakePort fresh;
    CHECK(FormatBatch(nullptr, small, fresh).format("select 1, 2, 3, 4, 5").failure == FormatQueryFailureKind::input);
    CHECK_EQ(fresh.calls.size(), size_t(0));
  }
  // A batch answers one status for each text (ARCH-B-124): a text that fails does not fail the others.
  {
    // formatQuery refuses the text that holds "bad", and answers the others.
    class PickyPort final : public FormatQueryPort {
    public:
      FormatQueryResult format_query(const std::string& sql, size_t) override {
        ++calls;
        FormatQueryResult result;
        if (sql.find("bad") != std::string::npos) {
          result.failure = FormatQueryFailureKind::server;
          result.message = "Syntax error near bad";
        } else {
          result.formatted_sql = sql;
        }
        return result;
      }
      FormatQueryResult explain_ast(const std::string&, size_t) override {
        FormatQueryResult result;
        result.failure = FormatQueryFailureKind::server;
        return result;
      }
      int calls = 0;
    };
    PickyPort port;
    FormatBatch batch(nullptr, settings, port);
    FormatBatchLimits limits;
    limits.deadline = std::chrono::steady_clock::now() + std::chrono::minutes(1);
    const std::vector<FormatItem> items = format_texts(batch, {"select 1 from t", "select bad from t", "select 3 from t", "  "}, limits);
    CHECK_EQ(items.size(), size_t(4));
    CHECK(items[0].status == FormatItemStatus::Formatted && items[0].outcome.ok());
    CHECK(items[1].status == FormatItemStatus::Error);
    CHECK(items[1].outcome.failure == FormatQueryFailureKind::server);
    CHECK_EQ(items[1].outcome.error, std::string("Syntax error near bad"));
    CHECK(items[2].status == FormatItemStatus::Formatted);  // after the failure: still formatted
    CHECK(items[3].status == FormatItemStatus::Error && items[3].outcome.failure == FormatQueryFailureKind::input);
    CHECK_EQ(port.calls, 3);  // the empty text never reached ClickHouse
    // A text that starts after the time of the batch is skipped, and asks nothing of ClickHouse.
    PickyPort late_port;
    FormatBatch late(nullptr, settings, late_port);
    FormatBatchLimits expired;
    expired.deadline = std::chrono::steady_clock::now() - std::chrono::seconds(1);
    for (const FormatItem& item : format_texts(late, {"select 1 from t", "select 2 from t"}, expired)) {
      CHECK(item.status == FormatItemStatus::Skipped && !item.skipped_for_stop);
    }
    CHECK_EQ(late_port.calls, 0);
    // The caller leaves after the first text. The rest is skipped for that reason.
    PickyPort stop_port;
    FormatBatch stopped(nullptr, settings, stop_port);
    FormatBatchLimits leaving = limits;
    leaving.stop = [&] { return stop_port.calls >= 1; };
    const auto left = format_texts(stopped, {"select 1 from t", "select 2 from t", "select 3 from t"}, leaving);
    CHECK(left[0].status == FormatItemStatus::Formatted);
    CHECK(left[1].status == FormatItemStatus::Skipped && left[1].skipped_for_stop);
    CHECK(left[2].status == FormatItemStatus::Skipped && left[2].skipped_for_stop);
    CHECK_EQ(stop_port.calls, 1);
  }
  // The scans that need no ClickHouse.
  CHECK(has_top_level_values_insert("INSERT INTO t VALUES (1), (2)"));
  CHECK(!has_top_level_values_insert("INSERT INTO t SELECT * FROM (VALUES (1))"));
  CHECK(!has_top_level_values_insert("SELECT 'INSERT VALUES'"));
  CHECK(!has_top_level_values_insert("-- INSERT INTO t VALUES\nSELECT 1"));
  CHECK_EQ(insert_format_name_end("INSERT INTO t FORMAT CSV 1,2"), size_t(24));
  CHECK_EQ(insert_format_name_end("INSERT INTO t VALUES (1)"), std::string::npos);
  CHECK_EQ(insert_format_name_end("SELECT 1"), std::string::npos);
  CHECK_EQ(insert_format_name_end("INSERT INTO t SELECT 1 FORMAT CSV"), std::string::npos);
  CHECK_EQ(quote_reserved_aliases_for_format_query("SELECT 1 AS from, 2 AS x FROM t"), std::string("SELECT 1 AS `from`, 2 AS x FROM t"));
  CHECK_EQ(quote_reserved_aliases_for_format_query("SELECT 1 AS `from` -- AS where\n, 'AS order' AS y"), std::string("SELECT 1 AS `from` -- AS where\n, 'AS order' AS y"));
  CHECK_EQ(quote_reserved_aliases_for_format_query("CREATE VIEW v AS SELECT 1 AS limit"), std::string("CREATE VIEW v AS SELECT 1 AS `limit`"));
}

// ---- the lexer and the kernels of the page ----
//
// src/wasm/highlight.c and src/wasm/sqlscan.c follow the JavaScript of the page. src/sql_lexer.hpp follows ClickHouse.
// Both must treat the same text as a string and a comment. Both must cut a script at the same ";".
// The test test_the_kernels_differ_where_known lists the known cases where they differ. The page unifies them with the lexer later.

std::vector<unsigned short> utf16_of(const std::string& s) {
  std::vector<unsigned short> out;
  for (size_t i = 0; i < s.size();) {
    const auto c = static_cast<unsigned char>(s[i]);
    uint32_t cp = c;
    size_t n = 1;
    if (c >= 0xF0) { cp = c & 0x07; n = 4; }
    else if (c >= 0xE0) { cp = c & 0x0F; n = 3; }
    else if (c >= 0xC0) { cp = c & 0x1F; n = 2; }
    for (size_t k = 1; k < n && i + k < s.size(); ++k) cp = (cp << 6) | (static_cast<unsigned char>(s[i + k]) & 0x3F);
    i += n;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out.push_back(static_cast<unsigned short>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<unsigned short>(0xDC00 + (cp & 0x3FF)));
    } else {
      out.push_back(static_cast<unsigned short>(cp));
    }
  }
  return out;
}

// One character for each UTF-16 unit. 'S' marks a string or a "name". 'C' marks a comment. '?' marks a line break.
// The kernel puts the '?' in the comment that the line break ends, and the lexer does not. '.' marks the rest.
std::string classes_of_lexer(const std::string& s, size_t units) {
  std::string out(units, '.');
  for (const sql::Token& token : sql::lex(s)) {
    char kind = '.';
    if (token.kind == sql::TokenKind::String || (token.kind == sql::TokenKind::QuotedIdent && s[token.begin] == '"')) kind = 'S';
    if (sql::is_comment(token.kind)) kind = 'C';
    if (kind == '.') continue;
    for (size_t i = sql::utf16_offset(s, token.begin); i < sql::utf16_offset(s, token.end); ++i) out[i] = kind;
  }
  return out;
}

// -1 when the kernel cannot answer.
int classes_of_kernel(const std::vector<unsigned short>& text, std::string& out) {
  std::vector<signed char> kinds(text.size() + 1, 0);
  const int count = chdash_wasm_highlight(text.data(), static_cast<int>(text.size()), kinds.data());
  if (count < 0) return -1;
  out.assign(text.size(), '.');
  for (size_t i = 0; i < text.size(); ++i) out[i] = kinds[i] == 6 ? 'S' : kinds[i] == 7 ? 'C' : '.';
  return count;
}

// The pieces of a script between its ";" as UTF-16 [start, end) pairs, by the lexer.
std::vector<int> split_of_lexer(const std::string& s, size_t units) {
  std::vector<int> out;
  size_t start = 0;
  for (const sql::Token& token : sql::lex(s)) {
    if (token.kind != sql::TokenKind::Punct || s[token.begin] != ';') continue;
    const size_t at = sql::utf16_offset(s, token.begin);
    out.push_back(static_cast<int>(start));
    out.push_back(static_cast<int>(at));
    start = at + 1;
  }
  out.push_back(static_cast<int>(start));
  out.push_back(static_cast<int>(units));
  return out;
}

std::vector<int> split_of_kernel(const std::vector<unsigned short>& text) {
  std::vector<int> out(2 * text.size() + 4);
  const int n = chdash_wasm_split(text.data(), static_cast<int>(text.size()), out.data(), static_cast<int>(out.size()));
  if (n < 0 || static_cast<size_t>(n) > out.size()) return {-1};
  out.resize(static_cast<size_t>(n));
  return out;
}

// True when the text holds one of the constructs on which the two differ by design (see the test below).
bool has_known_difference(const std::string& s) {
  for (const sql::Token& token : sql::lex(s)) {
    if (token.kind == sql::TokenKind::Unknown || token.kind == sql::TokenKind::HereDoc) return true;
    if (token.kind == sql::TokenKind::BlockComment && token.text(s).find("/*", 2) != std::string_view::npos) return true;
    // A backslash in a name in backticks: ClickHouse escapes with it, the page does not.
    if (token.kind == sql::TokenKind::QuotedIdent && s[token.begin] == '`' && token.text(s).find('\\') != std::string_view::npos) return true;
    // "\r" ends a line comment for the lexer only.
    if (token.kind == sql::TokenKind::LineComment && token.end < s.size() && s[token.end] == '\r') return true;
    if (token.kind == sql::TokenKind::Blank && token.text(s).find('\r') != std::string_view::npos) return true;
  }
  return false;
}

void compare_with_the_kernels(const std::string& s, int& compared) {
  if (has_known_difference(s)) return;
  const std::vector<unsigned short> text = utf16_of(s);
  std::string lexer = classes_of_lexer(s, text.size());
  std::string kernel;
  const int count = classes_of_kernel(text, kernel);
  if (count >= 0) {
    for (size_t i = 0; i < text.size(); ++i) {
      if (text[i] == '\n') lexer[i] = kernel[i] = '?';
    }
    ++compared;
    if (lexer != kernel) std::cerr << "highlight differs on " << dump(s) << "\n  lexer:  " << lexer << "\n  kernel: " << kernel << std::endl;
    CHECK(lexer == kernel);
  }
  const std::vector<int> pieces = split_of_kernel(text);
  const std::vector<int> expected = split_of_lexer(s, text.size());
  if (pieces != expected) std::cerr << "split differs on " << dump(s) << std::endl;
  CHECK(pieces == expected);
}

void test_the_kernels_and_the_lexer_agree() {
  const std::vector<std::string> fixed = {
      "", "select 1", "select 'a;b'; select 2", "select 'it''s'; select 3", "select 'a\\'b'; select 4", "select \"a;b\"; select 5",
      "select `a;b`; select 6", "select 1 -- a; b\n; select 2", "select 1 /* a; b */; select 2", "select 1 # a; b\n; select 2",
      "select '", "select \"", "select `", "select /* open", "select 1 -- open", "select 'é;😀'; select \"é😀\"; -- é😀\nselect 1",
      ";;", " ; ", "select 1;", ";select 1", "select '\\\\'; select 'x'", "select 'a\nb'; select 2", "select 1 /* a\nb */ ; select 2",
      "select 1 --", "select '' ; select \"\" ; select ``", "select 'a' 'b'", "select 1/*a*//*b*/;select 2"};
  int compared = 0;
  for (const std::string& s : fixed) compare_with_the_kernels(s, compared);

  // Texts made of pieces. The quotes and the comments open and close in every order (a fixed seed).
  const std::vector<std::string> pieces = {
      "select ", "1", " ", "\n", "'a'", "'it''s'", "'\\''", "'x\\\\'", "\"q\"", "`n`", "-- c\n", "-- c", "/* c */", "/* c\n */", ";", " ; ",
      "'", "\"", "`", "/*", "*/", "(", ")", ",", "\xC3\xA9", "\xF0\x9F\x98\x80", "'\xC3\xA9;'", "x", "0x1F", "-", "--", "*", "/", "\\", "\t"};
  uint64_t seed = 88172645463325252ull;
  for (int round = 0; round < 6000; ++round) {
    std::string s;
    seed ^= seed << 13;
    seed ^= seed >> 7;
    seed ^= seed << 17;
    const size_t count = 1 + seed % 12;
    for (size_t k = 0; k < count; ++k) {
      seed ^= seed << 13;
      seed ^= seed >> 7;
      seed ^= seed << 17;
      s += pieces[seed % pieces.size()];
    }
    compare_with_the_kernels(s, compared);
  }
  CHECK(compared > 5000);  // most texts hold no construct of the list of differences
}

// The constructs on which the kernels of the page and the lexer differ. The lexer follows ClickHouse.
// The kernels follow the JavaScript of the page. The page takes every "#" for a comment.
// The page does not nest "/* */", and it has no $$ text. It reads a backslash in a name in backticks as a character.
//
// When the page reads SQL as the lexer does, these checks change with it.
void test_the_kernels_differ_where_known() {
  const auto differs = [](const std::string& s) {
    const std::vector<unsigned short> text = utf16_of(s);
    std::string kernel;
    classes_of_kernel(text, kernel);
    std::string lexer = classes_of_lexer(s, text.size());
    for (size_t i = 0; i < text.size(); ++i) {
      if (text[i] == '\n') lexer[i] = kernel[i] = '?';
    }
    return lexer != kernel || split_of_kernel(text) != split_of_lexer(s, text.size());
  };
  CHECK(differs("select 1 #a; b\n; select 2"));            // "#" is a comment only before a blank or "!"
  CHECK(differs("/* a /* b */ ; c */ select 1"));          // the comment nests for ClickHouse
  CHECK(differs("select $$a;'b$$; select 2"));             // $$ ... $$ is a text
  CHECK(differs("select `a\\`; select 2"));                // a backslash escapes in a name in backticks
  CHECK(!differs("select 1 # a; b\n; select 2"));          // a "#" and a blank: a comment for both
}

// ---- the vectors of the page: tests/frontend/model/sql-lex-vectors.json ----
//
// The file holds the answers of the one SQL lexer of the page (src/static/app_sql_lex.js) for a list of texts.
// The answers are the strings and the comments, the pieces of a script between its ";", and the statement around a cursor.
// The Node test of that module and the browser test of the kernels read the same file.
// Here the kernels run on the file, and so does the lexer of the backend.
// The lexer gives the same answer on every text, except on the texts that the file marks "differs".
// Those are the four differences from ClickHouse that are on purpose. They are listed in app_sql_lex.js and src/sql_lexer.hpp.
//
// The test takes the file from CHDASH_SQL_VECTORS, or from tests/frontend/model/ under the working directory.

std::string expected_classes(const rapidjson::Value& vector, size_t units, const std::vector<unsigned short>& text) {
  std::string out(units, '.');
  for (const auto& span : vector["spans"].GetArray()) {
    const std::string kind = span[2].GetString();
    const char c = kind == "string" || kind == "dquote" ? 'S' : kind == "line" || kind == "block" ? 'C' : '.';
    if (c == '.') continue;
    for (int i = span[0].GetInt(); i < span[1].GetInt(); ++i) out[static_cast<size_t>(i)] = c;
  }
  for (size_t i = 0; i < units; ++i) {
    if (text[i] == '\n') out[i] = '?';
  }
  return out;
}

std::vector<int> expected_split(const rapidjson::Value& vector) {
  std::vector<int> out;
  for (const auto& piece : vector["split"].GetArray()) {
    out.push_back(piece[0].GetInt());
    out.push_back(piece[1].GetInt());
  }
  return out;
}

void test_the_vectors_of_the_page() {
  const char* env = std::getenv("CHDASH_SQL_VECTORS");
  const std::string path = env ? env : "tests/frontend/model/sql-lex-vectors.json";
  std::ifstream in(path);
  if (!in) {
    std::cerr << "no vectors at " << path << std::endl;
    CHECK(false);
    return;
  }
  std::stringstream buffer;
  buffer << in.rdbuf();
  const std::string json = buffer.str();
  rapidjson::Document doc;
  doc.Parse(json.c_str());
  CHECK(!doc.HasParseError() && doc.IsArray());
  if (doc.HasParseError() || !doc.IsArray()) return;
  CHECK(doc.Size() >= 35);
  int agreeing = 0;
  int differing = 0;
  for (const auto& vector : doc.GetArray()) {
    const std::string s = vector["sql"].GetString();
    const std::vector<unsigned short> text = utf16_of(s);
    const std::string want = expected_classes(vector, text.size(), text);
    const std::vector<int> pieces = expected_split(vector);
    // The kernels give what the page gives.
    std::string kernel;
    if (classes_of_kernel(text, kernel) >= 0) {
      for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '\n') kernel[i] = '?';
      }
      if (kernel != want) std::cerr << "highlight differs on " << dump(s) << "\n  vector: " << want << "\n  kernel: " << kernel << std::endl;
      CHECK(kernel == want);
    }
    const std::vector<int> split = split_of_kernel(text);
    if (split != pieces) std::cerr << "split differs on " << dump(s) << std::endl;
    CHECK(split == pieces);
    for (const auto& at : vector["statements"].GetArray()) {
      int out[2] = {-1, -1};
      CHECK_EQ(chdash_wasm_statement(text.data(), static_cast<int>(text.size()), at[0].GetInt(), out), 0);
      if (out[0] != at[1].GetInt() || out[1] != at[2].GetInt()) std::cerr << "statement differs on " << dump(s) << " at " << at[0].GetInt() << std::endl;
      CHECK(out[0] == at[1].GetInt() && out[1] == at[2].GetInt());
    }
    // The lexer of the backend gives it too, except where the file says that ClickHouse reads the text differently.
    std::string lexer = classes_of_lexer(s, text.size());
    for (size_t i = 0; i < text.size(); ++i) {
      if (text[i] == '\n') lexer[i] = '?';
    }
    const bool same = lexer == want && split_of_lexer(s, text.size()) == pieces;
    const bool differs = vector.HasMember("differs") && vector["differs"].GetBool();
    if (same == differs) std::cerr << "the lexer of the backend " << (differs ? "agrees" : "differs") << " on " << dump(s) << std::endl;
    CHECK(same != differs);
    (differs ? differing : agreeing) += 1;
  }
  CHECK(agreeing >= 25 && differing >= 4);
}

} // namespace

int main() {
  test_literals();
  test_params();
  test_lexer_rules();
  test_scan_follows_the_lexer();
  test_kill_policy();
  test_mask();
  test_mcp_scan();
  test_structure();
  test_format_service();
  test_the_kernels_and_the_lexer_agree();
  test_the_kernels_differ_where_known();
  test_the_vectors_of_the_page();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
