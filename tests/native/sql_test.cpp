// Unit tests of the SQL text of ChDash: what is written into a statement (src/sql_literal.hpp), how a statement is read
// (src/sql_lexer.hpp, the one lexer), and what is read from it (src/sql_structure.hpp, src/user_sql_policy.cpp,
// src/mcp_sql.cpp, src/sql_scan.hpp). No ClickHouse is needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_SQL_TESTS=ON
//        cmake --build build --target chdash_sql_test
// Run:   ./build/chdash_sql_test   (exit code 0 = every check passed)

#include "mcp_sql.hpp"
#include "sql_lexer.hpp"
#include "sql_literal.hpp"
#include "sql_scan.hpp"
#include "sql_structure.hpp"
#include "user_sql_policy.hpp"

#include <cstdint>
#include <cstdio>
#include <iostream>
#include <optional>
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

// The text with the bytes that are not printable written as \xHH, so a failure shows what the text holds.
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

// ---- sql_literal.hpp ----

void test_literals() {
  CHECK_EQ(sql::quote_string("abc"), std::string("'abc'"));
  CHECK_EQ(sql::quote_string(""), std::string("''"));
  CHECK_EQ(sql::quote_string("o'rei\\lly"), std::string("'o\\'rei\\\\lly'"));
  CHECK_EQ(sql::quote_string("a\nb\tc\rd"), std::string("'a\\nb\\tc\\rd'"));
  CHECK_EQ(sql::quote_string(std::string("a\0b", 3)), std::string("'a\\0b'"));
  CHECK_EQ(sql::quote_string("a\x01" "b"), std::string("'a\\x01b'"));
  CHECK_EQ(sql::quote_string("' OR 1=1 --"), std::string("'\\' OR 1=1 --'"));
  // A text that ends with a backslash does not escape the closing quote mark.
  CHECK_EQ(sql::quote_string("abc\\"), std::string("'abc\\\\'"));
  CHECK_EQ(sql::quote_string("caf\xc3\xa9"), std::string("'caf\xc3\xa9'"));

  CHECK_EQ(sql::quote_ident("a"), std::string("`a`"));
  CHECK_EQ(sql::quote_ident("a`b"), std::string("`a\\`b`"));
  CHECK_EQ(sql::quote_ident("a\\b"), std::string("`a\\\\b`"));
  // SEC-014: a name made of a backslash and a backtick stays one name.
  CHECK_EQ(sql::quote_ident("x\\` UNION SELECT 1 --"), std::string("`x\\\\\\` UNION SELECT 1 --`"));
  CHECK_EQ(sql::quote_ident(""), std::string("``"));
  CHECK_EQ(sql::quote_qualified("db", "t"), std::string("`db`.`t`"));
  CHECK_EQ(sql::quote_array({}), std::string("[]"));
  CHECK_EQ(sql::quote_array({"a", "b'c"}), std::string("['a', 'b\\'c']"));
  CHECK_EQ(sql::quote_list({}), std::string("''"));
  CHECK_EQ(sql::quote_list({"a", "b"}), std::string("'a', 'b'"));
  CHECK_EQ(sql::like_escape("50%_off\\"), std::string("50\\%\\_off\\\\"));

  // What the lexer reads back is one token, whatever the text holds.
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

  // The tokens put back to back are the text, with no gap.
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

// A small generator of hostile statements: the pieces that the rules above are about.
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

// sql::Scan and sql::lex read the same text the same way: a byte is code for the Scan when no quote, comment or heredoc is
// open before and after it, and for the lexer when it is in a blank, a word, a number or a punctuation.
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

} // namespace

int main() {
  test_literals();
  test_lexer_rules();
  test_scan_follows_the_lexer();
  test_kill_policy();
  test_mask();
  test_mcp_scan();
  test_structure();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
