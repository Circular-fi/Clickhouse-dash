// Unit tests of the MCP server side: scopes, keys and their file, the rate limit, the SQL
// scanner and builder, the protocol (with a fake backend), the tools (with a fake database)
// and the startup errors of the mcp { } configuration block. Also the HTTP hardening of the
// server (http_guard.hpp), the random source, the log lines, the metrics text, the worker group
// and the stop of the health runner. No ClickHouse needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_MCP_TESTS=ON
//        cmake --build build --target chdash_mcp_test
// Run:   ./build/chdash_mcp_test   (exit code 0 = every check passed)
// The Python harness (test_native_unit_tests.py) runs it when MCP_TEST_BINARY points at it.

#include "config.hpp"
#include "health_runner.hpp"
#include "http_guard.hpp"
#include "log.hpp"
#include "mcp_api_tools.hpp"
#include "mcp_grants.hpp"
#include "mcp_identity.hpp"
#include "mcp_keys.hpp"
#include "mcp_protocol.hpp"
#include "mcp_scope.hpp"
#include "host_util.hpp"
#include "mcp_sql.hpp"
#include "request_context.hpp"
#include "sql_literal.hpp"
#include "mcp_tool_support.hpp"
#include "mcp_tools.hpp"
#include "mcp_usage.hpp"
#include "metrics.hpp"
#include "secure_random.hpp"
#include "worker_group.hpp"

#include <rapidjson/document.h>

#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <thread>
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
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK_EQ failed: " #a " == " #b << "\n  left : " << va \
                << "\n  right: " << vb << std::endl;                                                     \
    }                                                                                                    \
  } while (0)

bool contains(const std::string& text, const std::string& part) { return text.find(part) != std::string::npos; }

std::string read_file(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  return std::string{std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

void write_file(const std::string& path, const std::string& text) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out << text;
}

std::string make_temp_dir() {
  const char* base = std::getenv("TMPDIR");
  std::string templ = std::string(base && *base ? base : "/tmp") + "/chdash-mcp-XXXXXX";
  std::vector<char> buf(templ.begin(), templ.end());
  buf.push_back('\0');
  if (!::mkdtemp(buf.data())) {
    std::perror("mkdtemp");
    std::exit(2);
  }
  return buf.data();
}

rapidjson::Document parse(const std::string& text) {
  rapidjson::Document d;
  d.Parse(text.c_str());
  if (d.HasParseError()) {
    std::cerr << "not JSON: " << text << std::endl;
    std::exit(2);
  }
  return d;
}

// ---- scope ---------------------------------------------------------------------------------------

void test_scope() {
  CHECK(mcp_glob_match("*", ""));
  CHECK(mcp_glob_match("*", "anything"));
  CHECK(mcp_glob_match("a*", "abc"));
  CHECK(mcp_glob_match("*c", "abc"));
  CHECK(mcp_glob_match("a*c", "abc"));
  CHECK(mcp_glob_match("a*c", "ac"));
  CHECK(!mcp_glob_match("a*c", "ab"));
  CHECK(mcp_glob_match("", ""));
  CHECK(!mcp_glob_match("a", ""));
  CHECK(!mcp_glob_match("", "a"));
  CHECK(mcp_glob_match("**", ""));
  CHECK(mcp_glob_match("*a*b*", "xaxbx"));
  CHECK(!mcp_glob_match("*a*b*", "xbxax"));
  CHECK(!mcp_glob_match("a.b", "aXb"));  // no regular expression
  CHECK(mcp_glob_match("events_*", "events_2026"));
  CHECK(!mcp_glob_match("events_*", "event_2026"));
  CHECK_EQ(mcp_glob_to_like("a_b*"), std::string("a\\_b%"));
  CHECK_EQ(mcp_glob_to_like("100%"), std::string("100\\%"));
  CHECK_EQ(mcp_glob_to_like("a\\b"), std::string("a\\\\b"));

  for (const char* ok : {"*", "db", "db.table", "d*.t*", "a-b_c$", "*.events", "otel.*", "db.*"}) {
    CHECK(mcp_valid_database_pattern(ok));
  }
  for (const char* bad : {"", ".", "db.", ".t", "a.b.c", "a b", "a;b", "a'b", "db.ta`ble", "a\\b", "a/b"}) {
    CHECK(!mcp_valid_database_pattern(bad));
  }
  std::string why;
  CHECK(!mcp_valid_database_pattern("db.", &why) && !why.empty());

  const std::vector<std::string> narrow = {"otel", "chdash_ui.fixture_*", "analytics.events"};
  CHECK(mcp_scope_database_visible(narrow, "otel"));
  CHECK(mcp_scope_database_visible(narrow, "chdash_ui"));
  CHECK(mcp_scope_database_visible(narrow, "analytics"));
  CHECK(!mcp_scope_database_visible(narrow, "system"));
  CHECK(mcp_scope_table_allowed(narrow, "otel", "anything"));
  CHECK(mcp_scope_table_allowed(narrow, "chdash_ui", "fixture_weather"));
  CHECK(!mcp_scope_table_allowed(narrow, "chdash_ui", "other"));
  CHECK(mcp_scope_table_allowed(narrow, "analytics", "events"));
  CHECK(!mcp_scope_table_allowed(narrow, "analytics", "events2"));
  CHECK(!mcp_scope_table_allowed(narrow, "system", "tables"));
  CHECK(!mcp_scope_table_allowed({}, "otel", "x"));  // empty = nothing
  CHECK(mcp_scope_table_allowed({"*"}, "system", "tables"));
  CHECK(mcp_scope_all_data({"*"}));
  CHECK(mcp_scope_all_data({"otel", "*"}));
  CHECK(!mcp_scope_all_data({"*.*"}));
  CHECK(!mcp_scope_all_data({}));
  CHECK_EQ(mcp_scope_database_globs(narrow).size(), size_t(3));

  CHECK(mcp_scope_host_allowed({"prod"}, "prod"));
  CHECK(!mcp_scope_host_allowed({"prod"}, "stage"));
  CHECK(mcp_scope_host_allowed({"*"}, "stage"));
  CHECK(!mcp_scope_host_allowed({}, "prod"));
  const auto hosts = mcp_scope_hosts({"b", "a"}, {"a", "b", "c"});
  CHECK_EQ(hosts.size(), size_t(2));
  CHECK_EQ(hosts[0], std::string("a"));

  // SQL tools go only with all data, even when named; "*" never grants them without it.
  CHECK_EQ(mcp_effective_tools({"*"}, {"otel"}).size(), size_t(mcp_tool_catalog().size() - 2));  // all but the SQL tools
  CHECK_EQ(mcp_effective_tools({"*"}, {"*"}).size(), mcp_tool_catalog().size());
  CHECK_EQ(mcp_effective_tools({"run_query", "list_hosts"}, {"otel"}).size(), size_t(1));
  CHECK(mcp_scope_tool_allowed({"run_query"}, {"*"}, "run_query"));
  CHECK(!mcp_scope_tool_allowed({"run_query"}, {"otel"}, "run_query"));
  CHECK(!mcp_scope_tool_allowed({"list_hosts"}, {"*"}, "run_query"));
  CHECK(!mcp_scope_tool_allowed({"nope"}, {"*"}, "nope"));
  CHECK(mcp_find_tool("query_table") != nullptr);
  CHECK(mcp_find_tool("drop_everything") == nullptr);
  CHECK(mcp_find_tool("run_query")->needs_all_data);
  CHECK(!mcp_find_tool("query_table")->needs_all_data);
}

// ---- secrets, time, validation ---------------------------------------------------------------------

void test_secrets_time_validation() {
  CHECK_EQ(mcp_hash_hex(mcp_hash_secret("abc")), std::string("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  const std::string a = mcp_generate_secret();
  const std::string b = mcp_generate_secret();
  CHECK(a != b);
  // A version 4 UUID: 8-4-4-4-12 lower-case hex digits, version nibble 4, variant 8, 9, a or b.
  CHECK_EQ(a.size(), size_t(36));
  CHECK_EQ(a.size(), kMcpSecretBytes);
  for (size_t i = 0; i < a.size(); ++i) {
    const char c = a[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) CHECK_EQ(c, '-');
    else CHECK((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
  }
  CHECK_EQ(a[14], '4');
  CHECK(a[19] == '8' || a[19] == '9' || a[19] == 'a' || a[19] == 'b');
  // The bits of the random source show: a thousand secrets, no repeat, every hex digit seen at the first place.
  {
    std::set<std::string> seen;
    std::set<char> first;
    for (int i = 0; i < 1000; ++i) {
      const std::string one = mcp_generate_secret();
      CHECK(seen.insert(one).second);
      first.insert(one[0]);
    }
    CHECK_EQ(first.size(), size_t(16));
  }
  CHECK_EQ(mcp_secret_hint(a), a.substr(0, 8));
  // The mask of a secret, from its hint: the shape of a UUID, the hyphens and the hint in clear, a bullet for the others.
  const auto bullets = [](size_t n) {
    std::string out;
    for (size_t i = 0; i < n; ++i) out += "\xE2\x80\xA2";
    return out;
  };
  CHECK_EQ(mcp_secret_mask("3f2a9c1e"), "3f2a9c1e-" + bullets(4) + "-" + bullets(4) + "-" + bullets(4) + "-" + bullets(12));
  CHECK_EQ(mcp_secret_mask(mcp_secret_hint("a11da7a0-0000-4000-8000-000000000001")), "a11da7a0-" + bullets(4) + "-" + bullets(4) + "-" + bullets(4) + "-" + bullets(12));
  // A hint that is not known, or not the start of a UUID, shows nothing.
  CHECK_EQ(mcp_secret_mask(""), bullets(8) + "-" + bullets(4) + "-" + bullets(4) + "-" + bullets(4) + "-" + bullets(12));
  CHECK_EQ(mcp_secret_mask("chm_"), mcp_secret_mask(""));
  McpHash hash{};
  CHECK(mcp_parse_hash_hex(mcp_hash_hex(mcp_hash_secret("abc")), &hash));
  CHECK(hash == mcp_hash_secret("abc"));
  CHECK(!mcp_parse_hash_hex("zz", &hash));
  CHECK(!mcp_parse_hash_hex(std::string(64, 'g'), &hash));

  int64_t t = 0;
  CHECK(mcp_parse_iso_utc("2027-01-01T00:00:00Z", &t));
  CHECK_EQ(t, int64_t(1798761600));
  CHECK_EQ(mcp_iso_utc(t), std::string("2027-01-01T00:00:00Z"));
  int64_t d = 0;
  CHECK(mcp_parse_iso_utc("2027-01-01", &d));
  CHECK_EQ(d, t);
  CHECK(mcp_parse_iso_utc("2027-01-01T01:02:03.456Z", &d));
  CHECK_EQ(d, t + 3723);
  for (const char* bad : {"", "2027", "2027-13-01", "2027-02-31", "2027-01-01T00:00:00", "2027-01-01T00:00:00+01:00",
                          "2027-01-01 00:00:00Z", "yesterday", "1969-12-31", "2027-01-01T25:00:00Z"}) {
    CHECK(!mcp_parse_iso_utc(bad, &d));
  }

  CHECK(mcp_valid_key_name("ci-bot"));
  CHECK(mcp_valid_key_name("a"));
  CHECK(mcp_valid_key_name("0abc_def-9"));
  CHECK(!mcp_valid_key_name(""));
  CHECK(!mcp_valid_key_name("Upper"));
  CHECK(!mcp_valid_key_name("-lead"));
  CHECK(!mcp_valid_key_name("_lead"));
  CHECK(!mcp_valid_key_name("has space"));
  CHECK(!mcp_valid_key_name("ui_reserved"));
  CHECK(!mcp_valid_key_name(std::string(33, 'a')));
  CHECK(mcp_valid_key_name(std::string(32, 'a')));

  McpKeyContext ctx;
  ctx.hosts = {"prod", "stage"};
  ctx.max_rows_cap = 1000;
  ctx.timeout_cap = 30;
  const auto good = [] {
    McpKey k;
    k.name = "ci";
    k.hosts = {"prod"};
    k.tools = {"list_databases", "query_table"};
    k.databases = {"otel", "analytics.events"};
    return k;
  };
  CHECK(!mcp_validate_key(good(), ctx));
  const auto reason = [&](McpKey k) {
    const auto err = mcp_validate_key(k, ctx);
    return err ? err->field + ":" + err->reason : std::string("ok");
  };
  {
    McpKey k = good();
    k.name = "";
    CHECK_EQ(reason(k), std::string("name:required"));
    k.name = std::string(33, 'a');
    CHECK_EQ(reason(k), std::string("name:too_long"));
    k.name = "Bad Name";
    CHECK_EQ(reason(k), std::string("name:invalid"));
    k = good();
    k.hosts = {"nope"};
    CHECK_EQ(reason(k), std::string("hosts:unknown_host"));
    k.hosts = {"prod", "prod"};
    CHECK_EQ(reason(k), std::string("hosts:duplicate"));
    // A key reads one host at most, and names it.
    k.hosts = {"*"};
    CHECK_EQ(reason(k), std::string("hosts:invalid"));
    k.hosts = {"prod", "stage"};
    CHECK_EQ(reason(k), std::string("hosts:too_many"));
    k.hosts = {"stage"};
    CHECK_EQ(reason(k), std::string("ok"));
    k.hosts = {};
    CHECK_EQ(reason(k), std::string("hosts:required"));  // a key needs a host
    k = good();
    k.tools = {"drop"};
    CHECK_EQ(reason(k), std::string("tools:unknown_tool"));
    k.tools = {"run_query"};
    CHECK_EQ(reason(k), std::string("tools:needs_all_data"));
    k.tools = {"explain_query"};
    CHECK_EQ(reason(k), std::string("tools:needs_all_data"));
    k.databases = {"*"};
    CHECK_EQ(reason(k), std::string("ok"));
    k.tools = {"*"};
    k.databases = {"otel"};
    CHECK_EQ(reason(k), std::string("ok"));  // "*" quietly leaves the SQL tools out
    k = good();
    k.databases = {"a b"};
    CHECK_EQ(reason(k), std::string("databases:invalid"));
    k.databases = {"otel", "otel"};
    CHECK_EQ(reason(k), std::string("databases:duplicate"));
    k = good();
    k.max_rows = 0;
    CHECK_EQ(reason(k), std::string("max_rows:range"));
    k.max_rows = 1001;
    CHECK_EQ(reason(k), std::string("max_rows:range"));
    k.max_rows = 1000;
    CHECK_EQ(reason(k), std::string("ok"));
    k.timeout_seconds = 31;
    CHECK_EQ(reason(k), std::string("timeout_seconds:range"));
    k.timeout_seconds = 5;
    CHECK_EQ(reason(k), std::string("ok"));
  }

  McpKeyInput in;
  CHECK(!mcp_parse_key_input(R"({"name":"a","hosts":["prod"],"tools":["*"],"databases":["*"],"max_rows":null,"timeout_seconds":7})", &in));
  CHECK(in.name && *in.name == "a");
  CHECK(!in.max_rows && in.timeout_seconds && *in.timeout_seconds == 7);
  const auto input_error = [](const char* body) {
    McpKeyInput x;
    const auto err = mcp_parse_key_input(body, &x);
    return err ? err->field + ":" + err->reason : std::string("ok");
  };
  CHECK_EQ(input_error("not json"), std::string(":invalid_json"));
  CHECK_EQ(input_error("[]"), std::string(":invalid_json"));
  CHECK_EQ(input_error("{}"), std::string("name:required"));
  CHECK_EQ(input_error(R"({"name":"a"})"), std::string("hosts:required"));
  CHECK_EQ(input_error(R"({"name":"a","hosts":[]})"), std::string("tools:required"));
  CHECK_EQ(input_error(R"({"name":"a","hosts":[],"tools":[]})"), std::string("databases:required"));
  CHECK_EQ(input_error(R"({"name":3})"), std::string("name:type"));
  CHECK_EQ(input_error(R"({"hosts":"prod"})"), std::string("hosts:type"));
  CHECK_EQ(input_error(R"({"hosts":[1]})"), std::string("hosts:type"));
  CHECK_EQ(input_error(R"({"max_rows":"5"})"), std::string("max_rows:type"));
  // A field that a key does not have is refused: a client that sends an expiry or a memory limit must not believe
  // that its key has one (fields that no longer exist included).
  const std::string full = R"("name":"a","hosts":["prod"],"tools":["*"],"databases":["*"])";
  CHECK_EQ(input_error(("{" + full + R"(,"expires_at":"2027-01-01"})").c_str()), std::string("expires_at:unknown_field"));
  CHECK_EQ(input_error(("{" + full + R"(,"max_memory_bytes":1})").c_str()), std::string("max_memory_bytes:unknown_field"));
  CHECK_EQ(input_error(R"({"enabled":false})"), std::string("enabled:unknown_field"));
  CHECK_EQ(input_error(R"({"description":"x"})"), std::string("description:unknown_field"));
  CHECK_EQ(input_error(R"({"secret":"a11da7a0-0000-4000-8000-000000000001"})"), std::string("secret:unknown_field"));
}

// ---- the key store --------------------------------------------------------------------------------------

McpKey config_key(const std::string& name, const std::string& secret, std::vector<std::string> tools = {"*"},
                  std::vector<std::string> databases = {"*"}) {
  McpKey k;
  k.name = name;
  k.id = name;
  k.source = "config";
  k.secret_hash = mcp_hash_secret(secret);
  k.hosts = {"prod"};
  k.tools = std::move(tools);
  k.databases = std::move(databases);
  return k;
}

McpStoreOptions store_options(const std::string& file) {
  McpStoreOptions o;
  o.storage_file = file;
  o.context.hosts = {"prod", "stage"};
  o.context.max_rows_cap = 1000;
  o.context.timeout_cap = 30;
  o.config_keys.push_back(config_key("cfg-key", "c0f19000-0000-4000-8000-00000000000f"));
  return o;
}

McpKeyInput input_of(const std::string& body) {
  McpKeyInput in;
  const auto err = mcp_parse_key_input(body, &in);
  if (err) {
    std::cerr << "bad test input: " << body << " -> " << err->reason << std::endl;
    std::exit(2);
  }
  return in;
}

const char* kNewKey = R"({"name":"ci-bot","hosts":["prod"],"tools":["list_databases","query_table"],"databases":["otel","analytics.events"]})";

void test_store(const std::string& dir) {
  const std::string file = dir + "/keys.json";
  const int64_t now = 1'800'000'000;
  {
    McpKeyStore store(store_options(file));
    CHECK(store.can_manage());
    CHECK(::access(file.c_str(), F_OK) != 0);  // absent: created on the first write only
    CHECK_EQ(store.list().size(), size_t(1));
    CHECK_EQ(store.list()[0].source, std::string("config"));
    CHECK_EQ(store.list()[0].id, std::string("cfg-key"));
    CHECK_EQ(store.list()[0].secret_hint, std::string(""));  // config_key() gives none: the config reader sets it

    auto created = store.create(input_of(kNewKey), now);
    CHECK_EQ(created.status, 201);
    CHECK(created.key.has_value());
    CHECK_EQ(created.key->id.size(), size_t(15));
    CHECK_EQ(created.key->id.substr(0, 3), std::string("ui_"));
    CHECK_EQ(created.key->source, std::string("ui"));
    CHECK_EQ(created.secret.size(), size_t(36));
    CHECK_EQ(created.key->secret_hint, created.secret.substr(0, 8));
    CHECK_EQ(created.key->created_at.value_or(0), now);

    // The file: version 1, the hash that authenticates and the hint (mode 0600). Never the secret: it comes once,
    // in the answer of the create.
    CHECK(::access(file.c_str(), F_OK) == 0);
    struct stat st;
    CHECK(::stat(file.c_str(), &st) == 0 && (st.st_mode & 0777) == 0600);
    const std::string text = read_file(file);
    CHECK(!contains(text, created.secret));
    CHECK(!contains(text, created.secret.substr(9)));
    CHECK(!contains(text, "\"secret\""));
    CHECK(contains(text, mcp_hash_hex(mcp_hash_secret(created.secret))));
    CHECK(!contains(text, "config-secret"));  // config keys are never written
    CHECK(!contains(text, "cfg-key"));
    const auto doc = parse(text);
    CHECK_EQ(doc["version"].GetInt(), 1);
    CHECK_EQ(doc["keys"].Size(), 1u);

    // Authentication by the secret; the config key too.
    auto auth = store.authenticate(created.secret);
    CHECK(auth.status == McpKeyStore::AuthStatus::Ok);
    CHECK_EQ(auth.key.id, created.key->id);
    CHECK(store.authenticate("c0f19000-0000-4000-8000-00000000000f").status == McpKeyStore::AuthStatus::Ok);
    CHECK(store.authenticate("").status == McpKeyStore::AuthStatus::Missing);
    CHECK(store.authenticate("chm_nope").status == McpKeyStore::AuthStatus::Unknown);
    CHECK(store.authenticate(std::string(600, 'x')).status == McpKeyStore::AuthStatus::Unknown);
    CHECK_EQ(store.list().size(), size_t(2));
    CHECK(!contains(read_file(file), "last_used"));  // when a key was used is its usage's (test_usage)

    // Names and secrets are unique across both sources.
    CHECK_EQ(store.create(input_of(kNewKey), now).error, std::string("name_taken"));
    CHECK_EQ(store.create(input_of(R"({"name":"cfg-key","hosts":["prod"],"tools":[],"databases":[]})"), now).status, 409);

    // Validation errors keep the contract's codes.
    auto bad = store.create(input_of(R"({"name":"x","hosts":["nope"],"tools":[],"databases":[]})"), now);
    CHECK_EQ(bad.status, 400);
    CHECK_EQ(bad.error, std::string("validation"));
    CHECK_EQ(bad.field, std::string("hosts"));
    CHECK_EQ(bad.reason, std::string("unknown_host"));
    bad = store.create(input_of(R"({"name":"x","hosts":["prod"],"tools":["run_query"],"databases":["otel"]})"), now);
    CHECK_EQ(bad.reason, std::string("needs_all_data"));

    // The store keeps the hint, never the secret: no key of the list holds it, in any of its fields.
    CHECK_EQ(created.key->secret_hint, created.secret.substr(0, 8));
    for (const auto& key : store.list()) {
      rapidjson::StringBuffer sb;
      McpJsonWriter w(sb);
      mcp_write_key(w, key, std::nullopt);
      CHECK(!contains(sb.GetString(), created.secret));
      CHECK(!contains(sb.GetString(), "secret_available"));
    }

    // A key is made or deleted: there is no update, no rotation and no switch (the store has none).
    const std::string id = created.key->id;
    CHECK(store.authenticate(created.secret).status == McpKeyStore::AuthStatus::Ok);
    const std::string second_secret = created.secret;

    // A restart reads the same keys back; the hash decides who gets in.
    McpKeyStore again(store_options(file));
    CHECK_EQ(again.list().size(), size_t(2));
    CHECK_EQ(again.list()[1].secret_hint, second_secret.substr(0, 8));
    CHECK(read_file(file).find(second_secret) == std::string::npos);
    CHECK(again.authenticate(second_secret).status == McpKeyStore::AuthStatus::Ok);
    CHECK(again.authenticate("not-the-secret").status == McpKeyStore::AuthStatus::Unknown);
    CHECK_EQ(again.list()[1].name, std::string("ci-bot"));

    // A failed write restores the memory and answers storage_error.
    const std::string before = read_file(file);
    const std::string moved = dir + "-moved";
    CHECK(::rename(dir.c_str(), moved.c_str()) == 0);
    const auto failed = store.create(input_of(R"({"name":"later","hosts":["prod"],"tools":[],"databases":[]})"), now);
    CHECK_EQ(failed.status, 500);
    CHECK_EQ(failed.error, std::string("storage_error"));
    CHECK_EQ(store.list().size(), size_t(2));
    CHECK_EQ(store.remove(id).error, std::string("storage_error"));
    CHECK_EQ(store.list().size(), size_t(2));
    CHECK(store.authenticate(second_secret).status == McpKeyStore::AuthStatus::Ok);
    CHECK(::rename(moved.c_str(), dir.c_str()) == 0);
    CHECK_EQ(read_file(file), before);

    // Delete.
    const auto removed = store.remove(id);
    CHECK_EQ(removed.status, 200);
    CHECK_EQ(store.list().size(), size_t(1));
    CHECK(store.authenticate(second_secret).status == McpKeyStore::AuthStatus::Unknown);
    CHECK_EQ(store.remove(id).error, std::string("not_found"));
    CHECK_EQ(store.remove("cfg-key").error, std::string("config_key"));
    CHECK_EQ(parse(read_file(file))["keys"].Size(), 0u);
  }

  // No storage file: UI keys cannot be made; config keys still work.
  {
    McpStoreOptions o = store_options("");
    McpKeyStore store(o);
    CHECK(!store.storage_configured());
    CHECK(!store.can_manage());
    CHECK_EQ(store.create(input_of(kNewKey), now).error, std::string("storage_not_configured"));
    CHECK_EQ(store.create(input_of(kNewKey), now).status, 409);
    CHECK(store.authenticate("c0f19000-0000-4000-8000-00000000000f").status == McpKeyStore::AuthStatus::Ok);
  }

  // manage_from_ui = false: every write is refused; the file is read.
  {
    McpStoreOptions o = store_options(file);
    McpKeyStore writable(o);
    const auto made = writable.create(input_of(kNewKey), now);
    o.manage_from_ui = false;
    McpKeyStore ro(o);
    CHECK(!ro.can_manage());
    CHECK_EQ(ro.list().size(), size_t(2));
    CHECK(ro.authenticate(made.secret).status == McpKeyStore::AuthStatus::Ok);
    CHECK_EQ(ro.create(input_of(kNewKey), now).error, std::string("manage_disabled"));
    CHECK_EQ(ro.create(input_of(kNewKey), now).status, 403);
    CHECK_EQ(ro.remove(made.key->id).error, std::string("manage_disabled"));
  }
}

void test_store_startup_errors(const std::string& dir) {
  // An invalid file stops the store and is never rewritten.
  const std::string file = dir + "/broken.json";
  for (const std::string& content : std::vector<std::string>{
           "not json", "{", "[]", R"({"version":2,"keys":[]})", R"({"version":1})", R"({"version":1,"keys":[{}]})",
           R"({"version":1,"keys":[{"id":"x","name":"a","secret_sha256":"00"}]})"}) {
    write_file(file, content);
    bool threw = false;
    try {
      McpKeyStore store(store_options(file));
    } catch (const std::exception& e) {
      threw = true;
      CHECK(!contains(e.what(), content) || content.size() < 3);
    }
    CHECK(threw);
    CHECK_EQ(read_file(file), content);
  }
  // A directory that does not exist.
  bool threw = false;
  try {
    McpKeyStore store(store_options(dir + "/no-such-dir/keys.json"));
  } catch (const std::exception& e) {
    threw = true;
    CHECK(contains(e.what(), "does not exist"));
  }
  CHECK(threw);

  // The same secret in the config and in the file, or the same name.
  const std::string good = dir + "/dupes.json";
  const int64_t now = 1'800'000'000;
  {
    McpStoreOptions o = store_options(good);
    o.config_keys.clear();
    McpKeyStore store(o);
    CHECK_EQ(store.create(input_of(kNewKey), now).status, 201);
  }
  {
    McpStoreOptions o = store_options(good);
    o.config_keys.push_back(config_key("ci-bot", "a07e7e70-0000-4000-8000-00000000000e"));
    threw = false;
    try {
      McpKeyStore store(o);
    } catch (const std::exception& e) {
      threw = contains(e.what(), "ci-bot");
    }
    CHECK(threw);
  }
  {
    // The hash of a file key reused by a config key.
    const auto doc = parse(read_file(good));
    McpHash hash{};
    CHECK(mcp_parse_hash_hex(doc["keys"][0]["secret_sha256"].GetString(), &hash));
    McpStoreOptions o = store_options(good);
    McpKey stolen = config_key("other", "x");
    stolen.secret_hash = hash;
    o.config_keys.push_back(stolen);
    threw = false;
    try {
      McpKeyStore store(o);
    } catch (const std::exception& e) {
      threw = contains(e.what(), "same secret");
    }
    CHECK(threw);
  }
  {
    // A file that has no hint for its key (an early one): the key loads and works, its mask shows nothing.
    const auto doc = parse(read_file(good));
    const std::string hash = doc["keys"][0]["secret_sha256"].GetString();
    const std::string body = R"({"version":1,"keys":[{"id":"ui_0a1b2c3d4e5f","name":"old","secret_sha256":")" + hash +
                             R"(","secret_hint":"chm_","hosts":["prod"],"tools":["*"],"databases":["*"]}]})";
    const std::string legacy = dir + "/legacy.json";
    write_file(legacy, body);
    McpStoreOptions o = store_options(legacy);
    o.config_keys.clear();
    McpKeyStore store(o);
    CHECK_EQ(store.list().size(), size_t(1));
    CHECK_EQ(mcp_secret_mask(store.list()[0].secret_hint), mcp_secret_mask(""));
    CHECK_EQ(read_file(legacy), body);  // nothing to take out: the file is not written
  }
  {
    // A key file that holds a secret in clear is not a file of this ChDash (it stores the hash only): the start is
    // refused, with a message that names the key and does not repeat the secret.
    const std::string secret = "a11da7a0-0000-4000-8000-0000000000bb";
    const std::string body = R"({"version":1,"keys":[{"id":"ui_00000000000a","name":"kept","secret_sha256":")" + mcp_hash_hex(mcp_hash_secret(secret)) +
                             R"(","secret":")" + secret + R"(","secret_hint":"a11da7a0","hosts":["prod"],"tools":["*"],"databases":["*"]}]})";
    const std::string old = dir + "/clear.json";
    write_file(old, body);
    McpStoreOptions o = store_options(old);
    o.config_keys.clear();
    threw = false;
    try {
      McpKeyStore store(o);
    } catch (const std::exception& e) {
      threw = contains(e.what(), "secret in clear") && !contains(e.what(), secret);
    }
    CHECK(threw);
    CHECK_EQ(read_file(old), body);  // never rewritten
  }
}

// ---- the usage of the keys ---------------------------------------------------------------------------

struct UsageCall {
  std::string id = "k1";
  int64_t at = 0;
  McpUsageKind kind = McpUsageKind::ToolCall;
  std::string method;  // Request: the JSON-RPC method of the message
  std::string tool;
  std::string status = "ok";
  int64_t duration_ms = 0;
  uint64_t rows = 0;
  uint64_t bytes = 0;
  std::string client_name;
  std::string client_version;
  std::string user_agent = "agent/1";
};

void usage_record(McpUsage& usage, const UsageCall& call) {
  McpUsageEvent event;
  event.key_id = call.id;
  event.key_name = call.id;
  event.key_host = "prod";
  event.key_source = "config";
  event.at = call.at;
  event.kind = call.kind;
  event.method = call.method;
  event.tool = call.tool;
  event.status = call.status;
  event.duration_ms = call.duration_ms;
  event.rows = call.rows;
  event.bytes = call.bytes;
  event.client_name = call.client_name;
  event.client_version = call.client_version;
  event.user_agent = call.user_agent;
  usage.record(event);
}

McpUsageKeyRef usage_key(const std::string& id) { return McpUsageKeyRef{id, id, "prod", "config"}; }

// The JSON of the details of a key, or "" for a 404.
std::string usage_detail(const McpUsage& usage, const std::string& id, bool live, const std::string& window, int64_t now) {
  const McpUsageKeyRef key = usage_key(id);
  const auto range = mcp_usage_window(window, usage.retention_days(), now);
  if (!range) return "bad window";
  rapidjson::StringBuffer sb;
  McpJsonWriter w(sb);
  if (!usage.write_detail(w, id, live ? &key : nullptr, *range, now)) return "";
  return sb.GetString();
}

std::string usage_list(const McpUsage& usage, const std::vector<std::string>& live, const std::string& window, int64_t now) {
  std::vector<McpUsageKeyRef> keys;
  for (const auto& id : live) keys.push_back(usage_key(id));
  rapidjson::StringBuffer sb;
  McpJsonWriter w(sb);
  usage.write_list(w, keys, *mcp_usage_window(window, usage.retention_days(), now), now);
  return sb.GetString();
}

// The count of `field` for `name` in an array of the details (tools by "tool", statuses by "status").
uint64_t usage_count(const rapidjson::Value& rows, const char* by, const std::string& name, const char* field) {
  for (const auto& row : rows.GetArray()) {
    if (std::string(row[by].GetString()) == name) return row[field].GetUint64();
  }
  return 0;
}

// The first day of the first entry of a usage file, as the cells "type/method/result:count", sorted.
std::vector<std::string> usage_file_cells(const rapidjson::Value& entry) {
  std::vector<std::string> out;
  for (const auto& cell : entry["days"][0][1].GetArray()) {
    out.push_back(std::string(cell[0].GetString()) + "/" + cell[1].GetString() + "/" + cell[2].GetString() + ":" + std::to_string(cell[3].GetUint64()));
  }
  std::sort(out.begin(), out.end());
  return out;
}

// The file of a usage that is saved now.
rapidjson::Document usage_file_of(McpUsage& usage, const std::string& file, int64_t now) {
  CHECK(usage.save(now));
  return parse(read_file(file));
}

// Whether a usage file of this text stops the start (and is never rewritten).
bool usage_file_refused(const std::string& file, const std::string& content, int64_t now) {
  write_file(file, content);
  bool threw = false;
  try {
    McpUsageOptions options;
    options.file = file;
    McpUsage usage(options, now);
  } catch (const std::exception&) {
    threw = true;
  }
  bool checked = false;
  try {
    mcp_check_usage_file(file);
  } catch (const std::exception&) {
    checked = true;
  }
  CHECK_EQ(read_file(file), content);
  return threw && checked;
}

// The requests of the keys k1, k2 and a deleted key, as three clients would make them, in the order of the time (a clock that
// goes back counts in the last bucket). The usage must be opened at `now - 4 days` or before, for a retention of 30 days.
// k1: 12 requests, 2 of them 3 days ago; k2: 7; gone: 4, yesterday, and deleted after them. `now` is a whole hour.
void usage_scenario(McpUsage& usage, int64_t now) {
  const int64_t day = 86400;
  const std::string code = "claude-code/2.1.0 (node)";
  const std::string ai = "claude-ai/0.1";
  const auto tool = [&](const std::string& id, int64_t at, const std::string& name, const std::string& status, int64_t ms, uint64_t rows,
                        uint64_t bytes, const std::string& agent) {
    UsageCall call;
    call.id = id;
    call.at = at;
    call.tool = name;
    call.status = status;
    call.duration_ms = ms;
    call.rows = rows;
    call.bytes = bytes;
    call.user_agent = agent;
    usage_record(usage, call);
  };
  const auto request = [&](const std::string& id, int64_t at, const std::string& method, const std::string& status, int64_t ms, uint64_t bytes,
                           const std::string& agent, const std::string& client = "", const std::string& version = "") {
    UsageCall call;
    call.id = id;
    call.at = at;
    call.kind = McpUsageKind::Request;
    call.method = method;
    call.status = status;
    call.duration_ms = ms;
    call.bytes = bytes;
    call.user_agent = agent;
    call.client_name = client;
    call.client_version = version;
    usage_record(usage, call);
  };
  const auto refused = [&](const std::string& id, int64_t at, McpUsageKind kind, const std::string& status, uint64_t bytes, const std::string& agent) {
    UsageCall call;
    call.id = id;
    call.at = at;
    call.kind = kind;
    call.status = status;
    call.bytes = bytes;
    call.user_agent = agent;
    usage_record(usage, call);
  };
  for (int i = 0; i < 2; ++i) tool("k1", now - 3 * day + 5 + i, "list_hosts", "ok", 10, 2, 100, "agent/1");
  for (int i = 0; i < 4; ++i) tool("gone", now - day + 5 + i, "list_hosts", "ok", 5, 0, 80, "agent/1");
  request("k1", now + 1, "initialize", "ok", 40, 300, code, "claude-code", "2.1.0");
  request("k1", now + 2, "tools/list", "ok", 7, 200, code);
  for (int i = 0; i < 3; ++i) tool("k1", now + 3 + i, "list_hosts", "ok", 10, 2, 100, code);
  for (int i = 0; i < 2; ++i) tool("k1", now + 6 + i, "run_query", "ok", 50, 4, 500, code);
  tool("k1", now + 8, "run_query", "timeout", 30, 0, 100, code);
  request("k1", now + 9, "resources/list", "rpc_error_32601", 2, 110, code);
  refused("k1", now + 10, McpUsageKind::RateLimited, "429_rate_limited", 50, code);
  request("k2", now + 20, "initialize", "ok", 30, 250, ai, "claude-ai", "0.1");
  for (int i = 0; i < 2; ++i) tool("k2", now + 21 + i, "list_hosts", "ok", 12, 2, 100, ai);
  tool("k2", now + 23, "run_query", "query_failed", 20, 0, 90, ai);
  refused("k2", now + 24, McpUsageKind::Rejected, "415_unsupported_media_type", 60, ai);
  request("k2", now + 25, "notifications/initialized", "ok", 1, 0, ai);
  request("k2", now + 26, "notifications/x-secret-thing", "ok", 1, 0, ai);
  usage.mark_deleted(usage_key("gone"), now + 100);
}

// The overview of a usage for a query that must be valid.
rapidjson::Document usage_overview(const McpUsage& usage, const std::vector<std::string>& live, const std::string& window, int64_t now,
                                   McpUsageOverviewQuery query = {}) {
  const auto wrong = mcp_usage_overview_check(&query);
  CHECK(!wrong.has_value());
  std::vector<McpUsageKeyRef> keys;
  for (const auto& id : live) keys.push_back(usage_key(id));
  rapidjson::StringBuffer sb;
  McpJsonWriter w(sb);
  usage.write_overview(w, query, keys, *mcp_usage_window(window, usage.retention_days(), now), now);
  return parse(sb.GetString());
}

// The row of an array of an answer whose `by` is `name`, or null.
const rapidjson::Value* usage_row(const rapidjson::Value& rows, const char* by, const std::string& name) {
  for (const auto& row : rows.GetArray()) {
    if (std::string(row[by].GetString()) == name) return &row;
  }
  return nullptr;
}

uint64_t usage_figure(const rapidjson::Value& rows, const char* by, const std::string& name, const char* field) {
  const rapidjson::Value* row = usage_row(rows, by, name);
  CHECK(row != nullptr);
  return row ? (*row)[field].GetUint64() : 0;
}

// The sum of the values of an array of counts.
uint64_t usage_sum(const rapidjson::Value& values) {
  uint64_t sum = 0;
  for (const auto& value : values.GetArray()) sum += value.GetUint64();
  return sum;
}

// What every answer holds: the groups and the rest add up to the requests, at each point and in all, and the points are the ones of
// the window. Returns the requests at each point.
std::vector<uint64_t> check_series(const rapidjson::Value& doc) {
  const auto& series = doc["series"];
  const size_t points = series["t"].Size();
  std::vector<uint64_t> at(points, 0);
  uint64_t all = 0;
  const auto add = [&](const rapidjson::Value& group) {
    CHECK_EQ(group["values"].Size(), static_cast<rapidjson::SizeType>(points));
    CHECK_EQ(usage_sum(group["values"]), group["total"].GetUint64());
    all += group["total"].GetUint64();
    for (size_t p = 0; p < points && p < group["values"].Size(); ++p) at[p] += group["values"][static_cast<rapidjson::SizeType>(p)].GetUint64();
  };
  for (const auto& group : series["groups"].GetArray()) add(group);
  add(series["rest"]);
  CHECK_EQ(all, doc["totals"]["requests"].GetUint64());
  CHECK_EQ(series["step"].GetString() == std::string("hour"), points == 24);
  return at;
}

// What every answer holds without a filter: each facet adds up to the requests.
void check_facets_add_up(const rapidjson::Value& doc) {
  const uint64_t requests = doc["totals"]["requests"].GetUint64();
  uint64_t keys = 0;
  uint64_t methods = 0;
  uint64_t results = 0;
  uint64_t types = 0;
  for (const auto& row : doc["keys"].GetArray()) keys += row["requests"].GetUint64();
  for (const auto& row : doc["methods"].GetArray()) methods += row["requests"].GetUint64();
  for (const auto& row : doc["results"].GetArray()) results += row["count"].GetUint64();
  for (const auto& row : doc["types"].GetArray()) types += row["requests"].GetUint64();
  CHECK_EQ(keys, requests);
  CHECK_EQ(methods, requests);
  CHECK_EQ(results, requests);
  CHECK_EQ(types, requests);
}

// Whether the series and every facet add up to the requests, as one answer (no CHECK inside: the test that counts while the overview
// reads has loops whose length depends on the time, and its number of checks must not).
bool usage_overview_adds_up(const rapidjson::Value& doc) {
  const uint64_t requests = doc["totals"]["requests"].GetUint64();
  uint64_t series = doc["series"]["rest"]["total"].GetUint64();
  for (const auto& group : doc["series"]["groups"].GetArray()) series += group["total"].GetUint64();
  uint64_t keys = 0;
  uint64_t methods = 0;
  uint64_t results = 0;
  uint64_t types = 0;
  for (const auto& row : doc["keys"].GetArray()) keys += row["requests"].GetUint64();
  for (const auto& row : doc["methods"].GetArray()) methods += row["requests"].GetUint64();
  for (const auto& row : doc["results"].GetArray()) results += row["count"].GetUint64();
  for (const auto& row : doc["types"].GetArray()) types += row["requests"].GetUint64();
  return series == requests && keys == requests && methods == requests && results == requests && types == requests;
}

McpUsageOverviewQuery usage_query(const std::string& split, std::vector<std::string> keys = {}, std::vector<std::string> methods = {},
                                  std::vector<std::string> results = {}, std::vector<std::string> types = {}) {
  McpUsageOverviewQuery query;
  query.split = split;
  query.keys = std::move(keys);
  query.methods = std::move(methods);
  query.results = std::move(results);
  query.types = std::move(types);
  return query;
}

void test_usage(const std::string& dir) {
  // A whole hour (2027-01-15T10:00:00Z).
  const int64_t now = 1'800'007'200 - 1'800'007'200 % 3600;
  const int64_t hour = 3600;
  const int64_t day = 86400;

  // The windows that a retention keeps.
  CHECK(mcp_usage_windows(1) == std::vector<std::string>({"24h"}));
  CHECK(mcp_usage_windows(7) == std::vector<std::string>({"24h", "7d"}));
  CHECK(mcp_usage_windows(90) == std::vector<std::string>({"24h", "7d", "30d", "90d"}));
  CHECK(mcp_usage_windows(365) == std::vector<std::string>({"24h", "7d", "30d", "90d", "365d"}));
  CHECK_EQ(mcp_usage_default_window(90), std::string("7d"));
  CHECK_EQ(mcp_usage_default_window(3), std::string("24h"));
  {
    const auto h = mcp_usage_window("24h", 90, now + 1800);
    CHECK(h.has_value());
    CHECK_EQ(h->from, now - 23 * hour);
    CHECK_EQ(h->step, hour);
    CHECK_EQ(h->points, size_t(24));
    const auto d = mcp_usage_window("7d", 90, now);
    CHECK_EQ(d->from, now - now % day - 6 * day);
    CHECK_EQ(d->step, day);
    CHECK_EQ(d->points, size_t(7));
    CHECK(!mcp_usage_window("48h", 90, now).has_value());
    CHECK(!mcp_usage_window("90d", 30, now).has_value());
    CHECK(!mcp_usage_window("", 90, now).has_value());
  }
  CHECK_EQ(mcp_usage_clean("  a\x01" "b\xc3\xa9  ", 64), std::string("a?b??"));
  CHECK_EQ(mcp_usage_clean("abcdef", 3), std::string("abc"));
  CHECK_EQ(mcp_usage_clean("   ", 8), std::string(""));
  // The ids of keys: a name of the configuration, or ui_ and 12 hexadecimal digits.
  CHECK(mcp_valid_key_id("all-data"));
  CHECK(mcp_valid_key_id("ui_0a1b2c3d4e5f"));
  CHECK(!mcp_valid_key_id(""));
  CHECK(!mcp_valid_key_id("ui_0A1B2C3D4E5F"));
  CHECK(!mcp_valid_key_id("ui_0a1b2c3d4e5"));
  CHECK(!mcp_valid_key_id("ui_zzzzzzzzzzzz"));
  CHECK(!mcp_valid_key_id("Bad Key"));

  // What a key did, in memory only.
  {
    McpUsageOptions options;
    options.retention_days = 30;
    McpUsage usage(options, now);
    CHECK(!usage.persisted());
    CHECK_EQ(usage.since(), now);
    // A key that is not used: zeros while it exists, a 404 once it does not.
    CHECK(contains(usage_detail(usage, "k1", true, "24h", now), "\"calls\":0"));
    CHECK_EQ(usage_detail(usage, "k1", false, "24h", now), std::string(""));

    UsageCall init;
    init.kind = McpUsageKind::Request;
    init.method = "initialize";
    init.at = now + 10;
    init.client_name = "claude-code";
    init.client_version = "2.1.0";
    init.user_agent = "claude-code/2.1.0 (node)";
    init.bytes = 300;
    init.duration_ms = 40;  // a protocol request has its time in its cell, but it is no tool call: the totals never count it
    usage_record(usage, init);
    UsageCall list = init;
    list.method = "tools/list";
    list.client_name.clear();
    list.client_version.clear();
    list.at = now + 11;
    usage_record(usage, list);
    UsageCall ok;
    ok.at = now + 20;
    ok.tool = "query_table";
    ok.duration_ms = 12;
    ok.rows = 5;
    ok.bytes = 1000;
    ok.user_agent = init.user_agent;
    usage_record(usage, ok);
    UsageCall failed = ok;
    failed.tool = "run_query";
    failed.status = "timeout";
    failed.duration_ms = 30;
    failed.rows = 0;
    failed.bytes = 100;
    usage_record(usage, failed);
    UsageCall limited;
    limited.kind = McpUsageKind::RateLimited;
    limited.status = "429_rate_limited";
    limited.at = now + 30;
    limited.bytes = 50;
    usage_record(usage, limited);
    UsageCall rejected = limited;
    rejected.kind = McpUsageKind::Rejected;
    rejected.status = "415_Unsupported Media";  // a name is kept as [a-z0-9_]
    usage_record(usage, rejected);
    UsageCall rpc;
    rpc.kind = McpUsageKind::Request;
    rpc.method = "resources/list";
    rpc.status = "rpc_error_32601";
    rpc.at = now + 40;
    usage_record(usage, rpc);

    const auto doc = parse(usage_detail(usage, "k1", true, "24h", now + 60));
    CHECK_EQ(std::string(doc["window"].GetString()), std::string("24h"));
    CHECK_EQ(std::string(doc["from"].GetString()), mcp_iso_utc(now - 23 * hour));
    CHECK(doc["deleted_at"].IsNull());
    CHECK(!doc["persisted"].GetBool());
    CHECK_EQ(std::string(doc["first_used_at"].GetString()), mcp_iso_utc(now + 10));
    CHECK_EQ(std::string(doc["last_used_at"].GetString()), mcp_iso_utc(now + 40));
    const auto& totals = doc["totals"];
    CHECK_EQ(totals["requests"].GetUint64(), uint64_t(7));
    CHECK_EQ(totals["calls"].GetUint64(), uint64_t(2));
    CHECK_EQ(totals["errors"].GetUint64(), uint64_t(2));  // the tool that failed and the JSON-RPC error
    CHECK_EQ(totals["rate_limited"].GetUint64(), uint64_t(1));
    CHECK_EQ(totals["rejected"].GetUint64(), uint64_t(1));
    CHECK_EQ(totals["duration_ms_avg"].GetUint64(), uint64_t(21));  // the two tool calls: the 40 ms requests are not in it
    CHECK_EQ(totals["duration_ms_max"].GetUint64(), uint64_t(30));
    CHECK_EQ(totals["rows"].GetUint64(), uint64_t(5));
    CHECK_EQ(totals["bytes"].GetUint64(), uint64_t(300 + 300 + 1000 + 100 + 50 + 50));
    // One point for each hour, the calls in the current one.
    CHECK_EQ(std::string(doc["series"]["step"].GetString()), std::string("hour"));
    CHECK_EQ(doc["series"]["points"].Size(), 24u);
    CHECK_EQ(std::string(doc["series"]["points"][23]["t"].GetString()), mcp_iso_utc(now));
    CHECK_EQ(doc["series"]["points"][23]["calls"].GetUint64(), uint64_t(2));
    CHECK_EQ(doc["series"]["points"][23]["requests"].GetUint64(), uint64_t(7));
    CHECK_EQ(doc["series"]["points"][23]["errors"].GetUint64(), uint64_t(2));
    CHECK_EQ(doc["series"]["points"][0]["calls"].GetUint64(), uint64_t(0));
    // The tools (the most called first, then by name) and the results: the calls, and the requests that failed.
    CHECK_EQ(doc["tools"].Size(), 2u);
    CHECK_EQ(std::string(doc["tools"][0]["tool"].GetString()), std::string("query_table"));
    CHECK_EQ(usage_count(doc["tools"], "tool", "run_query", "errors"), uint64_t(1));
    CHECK_EQ(usage_count(doc["tools"], "tool", "query_table", "rows"), uint64_t(5));
    CHECK_EQ(usage_count(doc["tools"], "tool", "query_table", "duration_ms_avg"), uint64_t(12));
    CHECK_EQ(usage_count(doc["tools"], "tool", "run_query", "duration_ms_max"), uint64_t(30));
    CHECK_EQ(usage_count(doc["statuses"], "status", "ok", "count"), uint64_t(1));
    CHECK_EQ(usage_count(doc["statuses"], "status", "timeout", "count"), uint64_t(1));
    CHECK_EQ(usage_count(doc["statuses"], "status", "429_rate_limited", "count"), uint64_t(1));
    CHECK_EQ(usage_count(doc["statuses"], "status", "415_unsupported_media", "count"), uint64_t(1));
    CHECK_EQ(usage_count(doc["statuses"], "status", "rpc_error_32601", "count"), uint64_t(1));
    CHECK_EQ(doc["statuses"].Size(), 5u);
    // The clients: the initialize named the client, the requests after it with its User-Agent are its own.
    CHECK_EQ(doc["clients"].Size(), 2u);
    CHECK_EQ(std::string(doc["clients"][1]["name"].GetString()), std::string("claude-code"));
    CHECK_EQ(std::string(doc["clients"][1]["version"].GetString()), std::string("2.1.0"));
    CHECK_EQ(doc["clients"][1]["requests"].GetUint64(), uint64_t(4));
    CHECK_EQ(std::string(doc["clients"][0]["user_agent"].GetString()), std::string("agent/1"));
    CHECK_EQ(std::string(doc["clients"][0]["name"].GetString()), std::string(""));

    // The list: the live keys in their order (zeros for a key that was not used).
    const auto listed = parse(usage_list(usage, {"k2", "k1"}, "7d", now + 60));
    CHECK_EQ(listed["keys"].Size(), 2u);
    CHECK_EQ(std::string(listed["keys"][0]["id"].GetString()), std::string("k2"));
    CHECK_EQ(listed["keys"][0]["calls"].GetUint64(), uint64_t(0));
    CHECK(listed["keys"][0]["last_used_at"].IsNull());
    CHECK_EQ(listed["keys"][1]["requests"].GetUint64(), uint64_t(7));
    CHECK_EQ(listed["keys"][1]["calls"].GetUint64(), uint64_t(2));
    CHECK_EQ(listed["keys"][1]["errors"].GetUint64(), uint64_t(2));
    CHECK_EQ(listed["keys"][1]["rate_limited"].GetUint64(), uint64_t(1));
    CHECK_EQ(listed["keys"][1]["rejected"].GetUint64(), uint64_t(1));
    CHECK_EQ(listed["retention_days"].GetInt64(), int64_t(30));
    CHECK_EQ(usage.last_used_all().at("k1"), now + 40);
    CHECK(!usage.last_used_all().count("k2"));
  }

  // The windows: the last 24 hours by the hour, the last days by the UTC day.
  {
    McpUsageOptions options;
    options.retention_days = 30;
    McpUsage usage(options, now - 10 * day);
    for (const int64_t at : {now - 9 * day, now - 25 * hour, now - 2 * hour, now}) {
      UsageCall call;
      call.at = at;
      call.tool = "list_tables";
      usage_record(usage, call);
    }
    const auto calls = [&](const std::string& window) { return parse(usage_detail(usage, "k1", true, window, now))["totals"]["calls"].GetUint64(); };
    CHECK_EQ(calls("24h"), uint64_t(2));
    CHECK_EQ(calls("7d"), uint64_t(3));
    CHECK_EQ(calls("30d"), uint64_t(4));
    const auto week = parse(usage_detail(usage, "k1", true, "7d", now));
    CHECK_EQ(std::string(week["series"]["step"].GetString()), std::string("day"));
    CHECK_EQ(week["series"]["points"].Size(), 7u);
    CHECK_EQ(week["series"]["points"][6]["calls"].GetUint64(), uint64_t(2));
    // A clock that goes back counts in the last bucket.
    UsageCall back;
    back.at = now - 3 * day;
    back.tool = "list_tables";
    usage_record(usage, back);
    CHECK_EQ(calls("24h"), uint64_t(3));
  }

  // The retention: older days go, and the memory stays bounded between two saves.
  {
    McpUsageOptions options;
    options.retention_days = 7;
    McpUsage usage(options, now - 30 * day);
    for (int64_t i = 30; i >= 0; --i) {
      UsageCall call;
      call.at = now - i * day;
      call.tool = "list_tables";
      usage_record(usage, call);
    }
    CHECK(!mcp_usage_window("30d", 7, now).has_value());
    CHECK_EQ(parse(usage_detail(usage, "k1", true, "7d", now))["totals"]["calls"].GetUint64(), uint64_t(7));
    CHECK_EQ(parse(usage_detail(usage, "k1", true, "24h", now))["totals"]["calls"].GetUint64(), uint64_t(1));
  }

  // A deleted key: its usage stays until the retention ends; a key that was never used, 2 hours.
  {
    McpUsageOptions options;
    options.retention_days = 7;
    options.max_deleted = 2;
    McpUsage usage(options, now);
    for (const char* id : {"a", "b", "c"}) {
      UsageCall call;
      call.id = id;
      call.at = now;
      call.tool = "list_hosts";
      usage_record(usage, call);
    }
    usage.mark_deleted(usage_key("a"), now + 1);
    usage.mark_deleted(usage_key("b"), now + 2);
    auto listed = parse(usage_list(usage, {"c"}, "7d", now + 3));
    CHECK_EQ(listed["keys"].Size(), 3u);
    CHECK_EQ(std::string(listed["keys"][1]["id"].GetString()), std::string("b"));  // the last deletion first
    CHECK_EQ(std::string(listed["keys"][1]["deleted_at"].GetString()), mcp_iso_utc(now + 2));
    CHECK(contains(usage_detail(usage, "a", false, "7d", now + 3), "\"deleted_at\":\"" + mcp_iso_utc(now + 1) + "\""));
    // A call that ends after the deletion counts for the deleted key, which stays deleted.
    UsageCall late;
    late.id = "a";
    late.at = now + 4;
    late.tool = "list_hosts";
    usage_record(usage, late);
    CHECK(contains(usage_detail(usage, "a", false, "7d", now + 5), "\"deleted_at\":\"" + mcp_iso_utc(now + 1) + "\""));
    CHECK_EQ(parse(usage_detail(usage, "a", false, "7d", now + 5))["totals"]["calls"].GetUint64(), uint64_t(2));
    // At most max_deleted entries: the oldest deletion goes.
    usage.mark_deleted(usage_key("c"), now + 6);
    CHECK_EQ(usage_detail(usage, "a", false, "7d", now + 7), std::string(""));
    CHECK(!usage_detail(usage, "b", false, "7d", now + 7).empty());
    // A key that was never used: no line in the list, gone after 2 hours.
    usage.mark_deleted(usage_key("never"), now + 8);
    CHECK(!usage_detail(usage, "never", false, "7d", now + 9).empty());
    listed = parse(usage_list(usage, {}, "7d", now + 9));
    for (const auto& item : listed["keys"].GetArray()) CHECK(std::string(item["id"].GetString()) != "never");
    usage.save(now + 8 + 2 * hour);
    CHECK_EQ(usage_detail(usage, "never", false, "7d", now + 9 + 2 * hour), std::string(""));
    // Older than the retention: gone.
    usage.save(now + 8 * day);
    CHECK_EQ(usage_detail(usage, "b", false, "24h", now + 8 * day), std::string(""));
  }

  // The start: a key that is gone is deleted; a key of the configuration that is back takes its entry again.
  {
    McpUsage usage(McpUsageOptions{}, now);
    for (const char* id : {"gone", "back"}) {
      UsageCall call;
      call.id = id;
      call.at = now;
      call.tool = "list_hosts";
      usage_record(usage, call);
    }
    usage.mark_deleted(usage_key("back"), now + 1);
    usage.sync_live_keys({usage_key("back")}, now + 2);
    CHECK(contains(usage_detail(usage, "gone", false, "24h", now + 3), "\"deleted_at\":\"" + mcp_iso_utc(now + 2) + "\""));
    CHECK(contains(usage_detail(usage, "back", false, "24h", now + 3), "\"deleted_at\":null"));
  }

  // The clients: at most 8, the one seen least recently goes; a client without a name takes the one of its initialize.
  {
    McpUsage usage(McpUsageOptions{}, now);
    for (int i = 0; i < 9; ++i) {
      UsageCall call;
      call.kind = McpUsageKind::Request;
      call.method = "ping";
      call.at = now + i;
      call.user_agent = "agent/" + std::to_string(i);
      usage_record(usage, call);
    }
    UsageCall named;
    named.kind = McpUsageKind::Request;
    named.method = "initialize";
    named.at = now + 20;
    named.user_agent = "agent/8";
    named.client_name = "inspector";
    named.client_version = "0.16";
    usage_record(usage, named);
    const auto doc = parse(usage_detail(usage, "k1", true, "24h", now + 30));
    CHECK_EQ(doc["clients"].Size(), 8u);
    CHECK_EQ(std::string(doc["clients"][0]["name"].GetString()), std::string("inspector"));
    CHECK_EQ(doc["clients"][0]["requests"].GetUint64(), uint64_t(2));
    for (const auto& client : doc["clients"].GetArray()) CHECK(std::string(client["user_agent"].GetString()) != "agent/0");
  }

  // The file: written atomically (0600, no temporary file left), only when something changed, read back by the next start.
  {
    const std::string file = dir + "/usage.json";
    McpUsageOptions options;
    options.file = file;
    {
      McpUsage usage(options, now);
      CHECK(usage.persisted());
      CHECK(::access(file.c_str(), F_OK) != 0);  // written at the first save
      UsageCall call;
      call.at = now + 5;
      call.tool = "query_table";
      call.status = "table_not_allowed";
      call.client_name = "claude-code";
      usage_record(usage, call);
      CHECK(usage.save(now + 6));
      struct stat st;
      CHECK(::stat(file.c_str(), &st) == 0 && (st.st_mode & 0777) == 0600);
      for (const auto& item : std::filesystem::directory_iterator(dir)) CHECK(!contains(item.path().filename().string(), ".tmp"));
      const auto doc = parse(read_file(file));
      CHECK_EQ(doc["version"].GetInt(), 1);
      CHECK_EQ(std::string(doc["since"].GetString()), mcp_iso_utc(now));
      // A bucket is its start and its cells: [type, method, result, count, duration sum, duration max, rows, bytes].
      const auto& bucket = doc["keys"][0]["hours"][0];
      CHECK_EQ(bucket.Size(), 2u);
      CHECK_EQ(bucket[0].GetInt64(), now);
      CHECK_EQ(bucket[1].Size(), 1u);
      CHECK_EQ(bucket[1][0].Size(), 8u);
      CHECK_EQ(std::string(bucket[1][0][0].GetString()), std::string("call"));
      CHECK_EQ(std::string(bucket[1][0][1].GetString()), std::string("query_table"));
      CHECK_EQ(std::string(bucket[1][0][2].GetString()), std::string("table_not_allowed"));
      CHECK_EQ(bucket[1][0][3].GetUint64(), uint64_t(1));
      CHECK_EQ(doc["keys"][0]["days"][0].Size(), 2u);
      // Nothing changed: the file is not written again.
      const std::string before = read_file(file);
      CHECK(usage.save(now + 7));
      CHECK_EQ(read_file(file), before);
      // A failed write keeps the counts to write; a save that is due writes them.
      usage_record(usage, call);
      const std::string moved = dir + "-moved";
      CHECK(::rename(dir.c_str(), moved.c_str()) == 0);
      CHECK(!usage.save(now + 70));
      CHECK(::rename(moved.c_str(), dir.c_str()) == 0);
      CHECK(usage.save_if_due(now + 71));  // due a minute after the last try, not before
      CHECK_EQ(read_file(file), before);
      CHECK(usage.save_if_due(now + 131));
      CHECK(read_file(file) != before);
    }
    McpUsage again(options, now + 200);
    CHECK_EQ(again.since(), now);
    const auto doc = parse(usage_detail(again, "k1", true, "24h", now + 200));
    CHECK_EQ(doc["totals"]["calls"].GetUint64(), uint64_t(2));
    CHECK_EQ(usage_count(doc["statuses"], "status", "table_not_allowed", "count"), uint64_t(2));
    CHECK_EQ(std::string(doc["clients"][0]["name"].GetString()), std::string("claude-code"));
    CHECK_EQ(again.last_used_all().at("k1"), now + 5);
  }
}

// The method of a request, the cells, and the caps that keep them bounded.
void test_usage_cells(const std::string& dir) {
  const int64_t now = 1'800'007'200 - 1'800'007'200 % 3600;
  const std::string file = dir + "/cells.json";
  McpUsageOptions options;
  options.file = file;

  // The method of a request: a method of the protocol as it is (exact, case sensitive), "other" for any other, "invalid" when
  // the message could not be read, "unread" for what was refused before it was read. A tool is the name of the tool.
  {
    McpUsage usage(options, now);
    const auto request = [&](const std::string& method, const std::string& status = "ok") {
      UsageCall call;
      call.at = now + 1;
      call.kind = McpUsageKind::Request;
      call.method = method;
      call.status = status;
      usage_record(usage, call);
    };
    for (const char* method : {"initialize", "ping", "tools/list", "tools/call", "response", "notifications/initialized", "notifications/cancelled",
                               "notifications/progress", "notifications/roots/list_changed", "resources/list", "resources/read",
                               "resources/templates/list", "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get",
                               "completion/complete", "logging/setLevel"}) {
      request(method);
    }
    request("Initialize");  // the method is exact
    request("tools/List");
    request("logging/setlevel");
    request("notifications/x");
    request("sampling/createMessage");
    request("");  // a message that could not be read
    request("", "rpc_error_32700");
    request("tools/call", "rpc_error_32602");  // a tools/call that failed before a tool
    UsageCall tool;
    tool.at = now + 2;
    tool.tool = "List_Hosts";  // a tool is kept as [a-z0-9_]
    usage_record(usage, tool);
    UsageCall limited;
    limited.at = now + 3;
    limited.kind = McpUsageKind::RateLimited;
    limited.method = "tools/call";  // never read: a request that is refused has no method
    limited.status = "429_rate_limited";
    usage_record(usage, limited);
    UsageCall rejected = limited;
    rejected.kind = McpUsageKind::Rejected;
    rejected.method = "";
    rejected.status = "400_unreadable";
    usage_record(usage, rejected);
    const auto doc = usage_file_of(usage, file, now + 5);
    const auto cells = usage_file_cells(doc["keys"][0]);
    std::vector<std::string> want = {
        "call/list_hosts/ok:1",
        "rejected/unread/400_unreadable:1",
        "limited/unread/429_rate_limited:1",
        "request/other/ok:5",  // Initialize, tools/List, logging/setlevel, a notification and a request that no one knows
        "request/invalid/ok:1",
        "request/invalid/rpc_error_32700:1",
        "request/tools/call/rpc_error_32602:1",
    };
    for (const char* method : {"initialize", "ping", "tools/list", "tools/call", "response", "notifications/initialized", "notifications/cancelled",
                               "notifications/progress", "notifications/roots/list_changed", "resources/list", "resources/read",
                               "resources/templates/list", "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get",
                               "completion/complete", "logging/setLevel"}) {
      want.push_back(std::string("request/") + method + "/ok:1");
    }
    std::sort(want.begin(), want.end());
    CHECK(cells == want);
    if (cells != want) {
      for (const auto& cell : cells) std::cerr << "  got " << cell << "\n";
    }
  }

  // A text that a client chose is never kept: 5000 notifications with 5000 names are one cell, in a file that stays small.
  {
    std::filesystem::remove(file);
    McpUsage usage(options, now);
    for (int i = 0; i < 5000; ++i) {
      UsageCall call;
      call.at = now + 1;
      call.kind = McpUsageKind::Request;
      call.method = "notifications/name-" + std::to_string(i);
      usage_record(usage, call);
    }
    const auto doc = usage_file_of(usage, file, now + 5);
    CHECK(usage_file_cells(doc["keys"][0]) == std::vector<std::string>({"request/other/ok:5000"}));
    CHECK(read_file(file).size() < 2000);
  }

  // The caps: a bucket keeps 512 cells, and a request that has no cell goes to the overflow cell of its type, so the totals are exact.
  {
    std::filesystem::remove(file);
    McpUsage usage(options, now);
    const int tools = 600;
    for (int i = 0; i < tools; ++i) {
      UsageCall call;
      call.at = now + 1;
      call.tool = "tool_" + std::to_string(i);
      call.duration_ms = 3;
      call.bytes = 10;
      call.rows = 1;
      usage_record(usage, call);
    }
    // An error of a tool past the cap is counted as an error: its overflow cell is (call, other, other).
    for (int i = 0; i < 5; ++i) {
      UsageCall call;
      call.at = now + 2;
      call.tool = "tool_new_" + std::to_string(i);
      call.status = "failed_" + std::to_string(i);
      call.duration_ms = 9;
      usage_record(usage, call);
    }
    const auto doc = parse(usage_detail(usage, "k1", true, "24h", now + 10));
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(tools + 5));
    CHECK_EQ(doc["totals"]["calls"].GetUint64(), uint64_t(tools + 5));
    CHECK_EQ(doc["totals"]["errors"].GetUint64(), uint64_t(5));
    CHECK_EQ(doc["totals"]["rows"].GetUint64(), uint64_t(tools));
    CHECK_EQ(doc["totals"]["bytes"].GetUint64(), uint64_t(tools * 10));
    CHECK_EQ(doc["totals"]["duration_ms_max"].GetUint64(), uint64_t(9));
    // The tools: the 512 that had a cell, and "other" for the rest (ok and error).
    CHECK_EQ(doc["tools"].Size(), 513u);
    CHECK_EQ(usage_count(doc["tools"], "tool", "other", "calls"), uint64_t(tools - 512 + 5));
    CHECK_EQ(usage_count(doc["tools"], "tool", "other", "errors"), uint64_t(5));
    CHECK_EQ(usage_count(doc["statuses"], "status", "ok", "count"), uint64_t(tools));
    CHECK_EQ(usage_count(doc["statuses"], "status", "other", "count"), uint64_t(5));
    const auto saved = usage_file_of(usage, file, now + 20);
    CHECK_EQ(saved["keys"][0]["days"][0][1].Size(), 514u);  // 512, and the two cells of overflow
    // It reads back as it was written: the overflow cells are not among the 512 of a bucket, so nothing folds again.
    McpUsage again(options, now + 30);
    CHECK_EQ(usage_detail(again, "k1", true, "24h", now + 30), usage_detail(usage, "k1", true, "24h", now + 30));
  }

  // The names are 4096 at most (a cell holds a name in 12 bits): a tool past them is counted as "other", and the totals stay exact.
  {
    McpUsage usage(McpUsageOptions{}, now);
    for (int k = 0; k < 10; ++k) {
      for (int t = 0; t < 500; ++t) {
        UsageCall call;
        call.id = "key-" + std::to_string(k);
        call.at = now;
        call.tool = "tool_" + std::to_string(k) + "_" + std::to_string(t);
        usage_record(usage, call);
      }
    }
    const auto doc = usage_overview(usage, {}, "24h", now);
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(5000));
    CHECK_EQ(doc["totals"]["calls"].GetUint64(), uint64_t(5000));
    CHECK_EQ(doc["methods"].Size(), 200u);  // the facet is cut at 200 rows
    CHECK(doc["omitted"]["methods"].GetUint64() > 3000);
    // The first key has its 500 tools; the last has none left to name: all its calls are "other".
    const auto first = parse(usage_detail(usage, "key-0", false, "24h", now));
    CHECK_EQ(first["tools"].Size(), 500u);
    CHECK_EQ(usage_count(first["tools"], "tool", "other", "calls"), uint64_t(0));
    const auto last = parse(usage_detail(usage, "key-9", false, "24h", now));
    CHECK_EQ(last["tools"].Size(), 1u);
    CHECK_EQ(usage_count(last["tools"], "tool", "other", "calls"), uint64_t(500));
    CHECK_EQ(last["totals"]["calls"].GetUint64(), uint64_t(500));
  }

  // The cap of all the buckets: the cells that it stops are the overflow cell of their type.
  {
    McpUsageOptions small;
    small.max_cells = 2;
    McpUsage usage(small, now);
    for (const char* status : {"a_error", "b_error", "c_error", "d_error"}) {
      UsageCall call;
      call.at = now;
      call.tool = "list_hosts";
      call.status = status;
      usage_record(usage, call);
    }
    const auto doc = parse(usage_detail(usage, "k1", true, "24h", now));
    CHECK_EQ(doc["totals"]["calls"].GetUint64(), uint64_t(4));
    CHECK_EQ(doc["totals"]["errors"].GetUint64(), uint64_t(4));
    CHECK_EQ(usage_count(doc["statuses"], "status", "other", "count"), uint64_t(3));
    CHECK_EQ(usage_count(doc["statuses"], "status", "a_error", "count"), uint64_t(1));
    // The overflow of a request that is refused is a cell of its own type, never a successful call.
    UsageCall limited;
    limited.at = now;
    limited.kind = McpUsageKind::RateLimited;
    limited.status = "429_rate_limited";
    usage_record(usage, limited);
    const auto again = parse(usage_detail(usage, "k1", true, "24h", now));
    CHECK_EQ(again["totals"]["rate_limited"].GetUint64(), uint64_t(1));
    CHECK_EQ(again["totals"]["requests"].GetUint64(), uint64_t(5));
  }

  // The file as it is read: the cells are validated, the duplicates add up, a cell without request is ignored, and what is past
  // the cap of a bucket folds into the overflow cell.
  {
    const std::string bad = dir + "/bad-usage.json";
    const std::string since = R"({"version":1,"since":"2026-10-01T00:00:00Z","keys":[)";
    const std::string entry = R"({"id":"k1","name":"k1","source":"config","host":"prod","first_used_at":null,"last_used_at":null,"deleted_at":null,"clients":[],)";
    const std::string hour = std::to_string(now - 3600);
    const std::string today = std::to_string(now - now % 86400);
    const auto day_with = [&](const std::string& cells) { return since + entry + R"("hours":[],"days":[[)" + today + ",[" + cells + R"(]]]}]})"; };
    for (const std::string& content : std::vector<std::string>{
             "not json", "[]", R"({"version":2,"since":"2026-10-01T00:00:00Z","keys":[]})", R"({"version":1,"keys":[]})", since + "{}]}",
             // the first format of the file had a bucket of 12 fields
             since + entry + R"("hours":[[)" + hour + R"(,0,0,0,0,0,0,0,0,0,{},{}]],"days":[]}]})",
             since + entry + R"("hours":[[)" + hour + R"(]],"days":[]}]})",
             since + entry + R"("hours":[[)" + hour + R"(,{}]],"days":[]}]})",
             since + entry + R"("hours":[[1,[]]],"days":[]}]})",
             since + entry + R"("hours":[],"days":[[172800,[]],[86400,[]]]}]})",
             day_with(R"(["bogus","list_hosts","ok",1,0,0,0,0])"),                  // a type that is not known
             day_with(R"(["call","list hosts","ok",1,0,0,0,0])"),                    // a method with a space
             day_with(R"(["call","","ok",1,0,0,0,0])"),                              // no method
             day_with(R"(["call","list_hosts","a/b",1,0,0,0,0])"),                   // a result with a slash
             day_with(R"(["call","list_hosts","Ok",1,0,0,0,0])"),                    // a result with a capital
             day_with(R"(["call","list_hosts","ok",1,0,0,0])"),                      // a cell of 7 fields
             day_with(R"(["call","list_hosts","ok",1,0,0,0,0,0])"),                  // a cell of 9 fields
             day_with(R"(["call","list_hosts","ok",-1,0,0,0,0])"),                   // a count that is negative
             day_with(R"(["call","list_hosts","ok",1,"0",0,0,0])"),                  // a count that is text
             day_with(R"(["call","list_hosts","ok",1,0,0,0,1.5])"),                  // a count that is not whole
             day_with(R"([1,"list_hosts","ok",1,0,0,0,0])"),                         // a type that is not text
             day_with(R"(["call",5,"ok",1,0,0,0,0])"),                               // a method that is not text
             day_with(R"("call")"),                                                  // a cell that is not an array
             since + entry + R"("hours":[],"days":[[)" + today + R"(,[],0]]}]})",    // a bucket of 3 fields
             since + entry + R"("hours":[],"days":[]},)" + entry + R"("hours":[],"days":[]}]})"}) {
      CHECK(usage_file_refused(bad, content, now));
    }
    // A method of the protocol with a capital and a slash, an unknown tool and a result that no code of ChDash makes are valid.
    write_file(bad, day_with(R"(["request","logging/setLevel","ok",2,3,2,0,10],["call","a_tool_we_never_heard_of","a_new_error",1,1,1,0,0])"));
    {
      McpUsageOptions read;
      read.file = bad;
      McpUsage usage(read, now);
      const auto doc = parse(usage_detail(usage, "k1", true, "7d", now));
      CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(3));
      CHECK_EQ(doc["totals"]["calls"].GetUint64(), uint64_t(1));
      CHECK_EQ(doc["totals"]["errors"].GetUint64(), uint64_t(1));
      CHECK_EQ(usage_count(doc["tools"], "tool", "a_tool_we_never_heard_of", "errors"), uint64_t(1));
    }
    // The duplicates add up (the largest time is the largest), a cell without request is ignored.
    write_file(bad, day_with(R"(["call","list_hosts","ok",1,10,10,3,100],["call","list_hosts","ok",2,40,30,4,200],["call","list_hosts","ok",0,99,99,9,9],["call","other_tool","ok",0,0,0,0,0])"));
    {
      McpUsageOptions read;
      read.file = bad;
      McpUsage usage(read, now);
      const auto doc = parse(usage_detail(usage, "k1", true, "7d", now));
      CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(3));
      CHECK_EQ(doc["totals"]["calls"].GetUint64(), uint64_t(3));
      CHECK_EQ(doc["totals"]["duration_ms_max"].GetUint64(), uint64_t(30));
      CHECK_EQ(doc["totals"]["duration_ms_avg"].GetUint64(), uint64_t(17));
      CHECK_EQ(doc["totals"]["rows"].GetUint64(), uint64_t(7));
      CHECK_EQ(doc["totals"]["bytes"].GetUint64(), uint64_t(300));
      CHECK_EQ(doc["tools"].Size(), 1u);
    }
    // More cells than the cap of a bucket: the ones past it fold into the overflow cell of their type, nothing is dropped.
    std::string cells;
    for (int i = 0; i < 600; ++i) cells += (i ? "," : "") + std::string(R"(["call","t)") + std::to_string(i) + R"(","ok",1,2,2,0,1])";
    cells += R"(,["request","ping","ok",4,0,0,0,0])";
    write_file(bad, day_with(cells));
    {
      McpUsageOptions read;
      read.file = bad;
      McpUsage usage(read, now);
      const auto doc = parse(usage_detail(usage, "k1", true, "7d", now));
      CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(604));
      CHECK_EQ(doc["totals"]["calls"].GetUint64(), uint64_t(600));
      CHECK_EQ(doc["totals"]["bytes"].GetUint64(), uint64_t(600));
      CHECK_EQ(doc["tools"].Size(), 513u);  // 512 tools, and "other": the 88 that the cap left out
      CHECK_EQ(usage_count(doc["tools"], "tool", "other", "calls"), uint64_t(600 - 512));
      CHECK_EQ(usage_count(doc["tools"], "tool", "t0", "calls"), uint64_t(1));
      CHECK_EQ(usage_count(doc["tools"], "tool", "t511", "calls"), uint64_t(1));
      CHECK_EQ(usage_count(doc["tools"], "tool", "t512", "calls"), uint64_t(0));
      // The ping came after the 512 cells: it is counted in the overflow cell of the requests.
      const auto overview = usage_overview(usage, {"k1"}, "7d", now);
      uint64_t calls_other = 0;
      uint64_t requests_other = 0;
      for (const auto& row : overview["methods"].GetArray()) {
        if (std::string(row["method"].GetString()) != "other") continue;
        (std::string(row["kind"].GetString()) == "call" ? calls_other : requests_other) += row["requests"].GetUint64();
      }
      CHECK_EQ(calls_other, uint64_t(88));
      CHECK_EQ(requests_other, uint64_t(4));
      CHECK(usage_row(overview["methods"], "method", "ping") == nullptr);
    }
  }
}

// The names of the rows of an array of an answer, in their order.
std::vector<std::string> usage_names(const rapidjson::Value& rows, const char* by) {
  std::vector<std::string> out;
  for (const auto& row : rows.GetArray()) out.push_back(row[by].GetString());
  return out;
}

// GET /api/mcp/usage/overview: the totals and the series with all the filters, each facet with all the filters but its own.
void test_usage_overview() {
  const int64_t now = 1'800'007'200 - 1'800'007'200 % 3600;
  const int64_t day = 86400;
  const int64_t today = now - now % day;
  McpUsageOptions options;
  options.retention_days = 30;
  McpUsage usage(options, now - 4 * day);
  usage_scenario(usage, now);
  const std::vector<std::string> live = {"k1", "k2"};
  const auto names = [](const std::vector<std::string>& values) { return values; };

  // Without a filter, in 7 days: all the requests, and every facet adds up to them.
  {
    const auto doc = usage_overview(usage, live, "7d", now);
    CHECK_EQ(std::string(doc["window"].GetString()), std::string("7d"));
    CHECK_EQ(std::string(doc["from"].GetString()), mcp_iso_utc(today - 6 * day));
    CHECK_EQ(std::string(doc["to"].GetString()), mcp_iso_utc(now));
    CHECK_EQ(std::string(doc["since"].GetString()), mcp_iso_utc(now - 4 * day));
    CHECK(!doc["persisted"].GetBool());
    CHECK_EQ(doc["retention_days"].GetInt64(), int64_t(30));
    CHECK_EQ(std::string(doc["split"].GetString()), std::string("method"));
    for (const char* dimension : {"key", "method", "result", "type"}) {
      CHECK(doc["filters"][dimension].IsArray());
      CHECK_EQ(doc["filters"][dimension].Size(), 0u);
    }
    const auto& totals = doc["totals"];
    CHECK_EQ(totals["requests"].GetUint64(), uint64_t(23));
    CHECK_EQ(totals["calls"].GetUint64(), uint64_t(15));
    CHECK_EQ(totals["errors"].GetUint64(), uint64_t(3));
    CHECK_EQ(totals["rate_limited"].GetUint64(), uint64_t(1));
    CHECK_EQ(totals["rejected"].GetUint64(), uint64_t(1));
    CHECK_EQ(totals["duration_ms_avg"].GetUint64(), uint64_t(16));  // the 15 tool calls (244 ms): the time of the requests is not in it
    CHECK_EQ(totals["duration_ms_max"].GetUint64(), uint64_t(50));
    CHECK_EQ(totals["rows"].GetUint64(), uint64_t(22));
    CHECK_EQ(totals["bytes"].GetUint64(), uint64_t(3180));
    CHECK_EQ(totals["active_keys"].GetUint64(), uint64_t(3));  // k1, k2 and the deleted key
    CHECK_EQ(totals["keys"].GetUint64(), uint64_t(2));         // the keys that exist
    // The totals are those of the details of the keys.
    uint64_t detail_requests = 0;
    for (const char* id : {"k1", "k2", "gone"}) detail_requests += parse(usage_detail(usage, id, false, "7d", now))["totals"]["requests"].GetUint64();
    CHECK_EQ(detail_requests, totals["requests"].GetUint64());

    const auto at = check_series(doc);
    check_facets_add_up(doc);
    CHECK_EQ(at.size(), size_t(7));
    CHECK_EQ(std::string(doc["series"]["t"][6].GetString()), mcp_iso_utc(today));
    CHECK_EQ(at[6], uint64_t(17));  // today: k1 10, k2 7
    CHECK_EQ(at[5], uint64_t(4));   // yesterday: the deleted key
    CHECK_EQ(at[3], uint64_t(2));   // 3 days ago: k1
    CHECK_EQ(at[0] + at[1] + at[2] + at[4], uint64_t(0));
    // 8 methods: no `rest`. The groups are the largest first, then by name.
    CHECK(usage_names(doc["series"]["groups"], "id") == names({"list_hosts", "run_query", "initialize", "unread", "notifications/initialized", "other",
                                                               "resources/list", "tools/list"}));
    CHECK_EQ(doc["series"]["rest"]["groups"].GetUint64(), uint64_t(0));
    CHECK_EQ(doc["series"]["rest"]["total"].GetUint64(), uint64_t(0));
    for (const auto& group : doc["series"]["groups"].GetArray()) CHECK_EQ(std::string(group["id"].GetString()), std::string(group["label"].GetString()));
    // list_hosts, the largest group, by day: 3 days ago k1 2, yesterday the deleted key 4, today k1 3 and k2 2.
    CHECK_EQ(doc["series"]["groups"][0]["values"][6].GetUint64(), uint64_t(5));
    CHECK_EQ(doc["series"]["groups"][0]["values"][5].GetUint64(), uint64_t(4));
    CHECK_EQ(doc["series"]["groups"][0]["values"][3].GetUint64(), uint64_t(2));

    // The keys: the most requests first, the deleted key with when it was deleted.
    CHECK(usage_names(doc["keys"], "id") == names({"k1", "k2", "gone"}));
    const auto& k1 = doc["keys"][0];
    CHECK_EQ(k1["requests"].GetUint64(), uint64_t(12));
    CHECK_EQ(k1["calls"].GetUint64(), uint64_t(8));
    CHECK_EQ(k1["errors"].GetUint64(), uint64_t(2));
    CHECK_EQ(k1["rate_limited"].GetUint64(), uint64_t(1));
    CHECK_EQ(k1["rejected"].GetUint64(), uint64_t(0));
    CHECK_EQ(k1["duration_ms_avg"].GetUint64(), uint64_t(23));  // (160 + 20) ms over 8 calls
    CHECK_EQ(k1["duration_ms_max"].GetUint64(), uint64_t(50));
    CHECK_EQ(k1["rows"].GetUint64(), uint64_t(18));
    CHECK_EQ(k1["bytes"].GetUint64(), uint64_t(2260));
    CHECK_EQ(std::string(k1["name"].GetString()), std::string("k1"));
    CHECK_EQ(std::string(k1["host"].GetString()), std::string("prod"));
    CHECK_EQ(std::string(k1["source"].GetString()), std::string("config"));
    CHECK(k1["deleted_at"].IsNull());
    CHECK_EQ(std::string(k1["last_used_at"].GetString()), mcp_iso_utc(now + 10));
    const auto& gone = doc["keys"][2];
    CHECK_EQ(gone["requests"].GetUint64(), uint64_t(4));
    CHECK_EQ(std::string(gone["deleted_at"].GetString()), mcp_iso_utc(now + 100));
    CHECK_EQ(gone["rate_limited"].GetUint64(), uint64_t(0));

    // The methods: a row for each type and method. A tool is a "call", a method of the protocol a "request", what was refused before
    // it was read is "refused". The time of a protocol request is its own (the latency of initialize).
    CHECK_EQ(doc["methods"].Size(), 8u);
    const auto* hosts = usage_row(doc["methods"], "method", "list_hosts");
    CHECK(hosts != nullptr);
    CHECK_EQ(std::string((*hosts)["kind"].GetString()), std::string("call"));
    CHECK_EQ((*hosts)["requests"].GetUint64(), uint64_t(11));
    CHECK_EQ((*hosts)["keys"].GetUint64(), uint64_t(3));
    CHECK_EQ((*hosts)["errors"].GetUint64(), uint64_t(0));
    CHECK_EQ((*hosts)["rows"].GetUint64(), uint64_t(14));  // k1 5 calls with 2, k2 2 calls with 2
    CHECK_EQ(usage_figure(doc["methods"], "method", "run_query", "requests"), uint64_t(4));
    CHECK_EQ(usage_figure(doc["methods"], "method", "run_query", "errors"), uint64_t(2));
    CHECK_EQ(usage_figure(doc["methods"], "method", "run_query", "keys"), uint64_t(2));
    CHECK_EQ(usage_figure(doc["methods"], "method", "run_query", "duration_ms_avg"), uint64_t(38));  // (100 + 30 + 20) ms over 4
    CHECK_EQ(usage_figure(doc["methods"], "method", "run_query", "duration_ms_max"), uint64_t(50));
    const auto* init = usage_row(doc["methods"], "method", "initialize");
    CHECK(init != nullptr);
    CHECK_EQ(std::string((*init)["kind"].GetString()), std::string("request"));
    CHECK_EQ((*init)["requests"].GetUint64(), uint64_t(2));
    CHECK_EQ((*init)["duration_ms_avg"].GetUint64(), uint64_t(35));
    CHECK_EQ((*init)["duration_ms_max"].GetUint64(), uint64_t(40));
    CHECK_EQ((*init)["bytes"].GetUint64(), uint64_t(550));
    CHECK_EQ(std::string((*usage_row(doc["methods"], "method", "tools/list"))["kind"].GetString()), std::string("request"));
    CHECK_EQ(usage_figure(doc["methods"], "method", "resources/list", "errors"), uint64_t(1));
    CHECK_EQ(std::string((*usage_row(doc["methods"], "method", "other"))["kind"].GetString()), std::string("request"));  // the unknown notification
    CHECK_EQ(usage_figure(doc["methods"], "method", "other", "requests"), uint64_t(1));
    CHECK_EQ(std::string((*usage_row(doc["methods"], "method", "unread"))["kind"].GetString()), std::string("refused"));
    CHECK_EQ(usage_figure(doc["methods"], "method", "unread", "requests"), uint64_t(2));
    CHECK_EQ(usage_figure(doc["methods"], "method", "unread", "keys"), uint64_t(2));
    CHECK_EQ(usage_figure(doc["methods"], "method", "unread", "errors"), uint64_t(0));  // a refusal is not an error
    CHECK_EQ(std::string(doc["methods"][0]["method"].GetString()), std::string("list_hosts"));  // the most requests first

    // The results: all the requests, the successful protocol requests too.
    CHECK_EQ(usage_figure(doc["results"], "result", "ok", "count"), uint64_t(18));
    CHECK_EQ(usage_figure(doc["results"], "result", "ok", "keys"), uint64_t(3));
    for (const char* result : {"timeout", "rpc_error_32601", "429_rate_limited", "query_failed", "415_unsupported_media_type"}) {
      CHECK_EQ(usage_figure(doc["results"], "result", result, "count"), uint64_t(1));
    }
    CHECK_EQ(doc["results"].Size(), 6u);
    CHECK_EQ(std::string(doc["results"][0]["result"].GetString()), std::string("ok"));
    CHECK_EQ(std::string(doc["results"][1]["result"].GetString()), std::string("415_unsupported_media_type"));  // then by name

    // The types: the four of them, in their order.
    CHECK(usage_names(doc["types"], "type") == names({"call", "request", "limited", "rejected"}));
    CHECK_EQ(usage_figure(doc["types"], "type", "call", "requests"), uint64_t(15));
    CHECK_EQ(usage_figure(doc["types"], "type", "request", "requests"), uint64_t(6));
    CHECK_EQ(usage_figure(doc["types"], "type", "limited", "requests"), uint64_t(1));
    CHECK_EQ(usage_figure(doc["types"], "type", "rejected", "requests"), uint64_t(1));

    // The clients of all the keys: by name and version, or by User-Agent when there is no name; the last seen first.
    CHECK_EQ(doc["clients"].Size(), 3u);
    CHECK_EQ(std::string(doc["clients"][0]["name"].GetString()), std::string("claude-ai"));
    CHECK_EQ(doc["clients"][0]["requests"].GetUint64(), uint64_t(7));
    CHECK_EQ(std::string(doc["clients"][0]["first_seen_at"].GetString()), mcp_iso_utc(now + 20));
    CHECK_EQ(std::string(doc["clients"][0]["last_seen_at"].GetString()), mcp_iso_utc(now + 26));
    CHECK_EQ(std::string(doc["clients"][1]["name"].GetString()), std::string("claude-code"));
    CHECK_EQ(std::string(doc["clients"][1]["version"].GetString()), std::string("2.1.0"));
    CHECK_EQ(std::string(doc["clients"][1]["user_agent"].GetString()), std::string("claude-code/2.1.0 (node)"));
    CHECK_EQ(doc["clients"][1]["requests"].GetUint64(), uint64_t(10));
    CHECK_EQ(std::string(doc["clients"][2]["name"].GetString()), std::string(""));
    CHECK_EQ(std::string(doc["clients"][2]["user_agent"].GetString()), std::string("agent/1"));
    CHECK_EQ(doc["clients"][2]["keys"].GetUint64(), uint64_t(2));  // k1 and the deleted key: one client by User-Agent
    CHECK_EQ(doc["clients"][2]["requests"].GetUint64(), uint64_t(6));
    CHECK_EQ(std::string(doc["clients"][2]["first_seen_at"].GetString()), mcp_iso_utc(now - 3 * day + 5));
    for (const char* facet : {"keys", "methods", "results", "clients"}) CHECK_EQ(doc["omitted"][facet].GetUint64(), uint64_t(0));
  }

  // The last 24 hours: by the hour, today's requests only.
  {
    const auto doc = usage_overview(usage, live, "24h", now);
    CHECK_EQ(std::string(doc["series"]["step"].GetString()), std::string("hour"));
    CHECK_EQ(doc["series"]["t"].Size(), 24u);
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(17));
    CHECK_EQ(doc["totals"]["calls"].GetUint64(), uint64_t(9));
    CHECK_EQ(doc["totals"]["active_keys"].GetUint64(), uint64_t(2));
    const auto at = check_series(doc);
    check_facets_add_up(doc);
    CHECK_EQ(at[23], uint64_t(17));
    CHECK(usage_names(doc["keys"], "id") == names({"k1", "k2"}));  // a key without a request is not a row
    // The clients do not depend on the window: the deleted key's one is there.
    CHECK_EQ(doc["clients"].Size(), 3u);
  }

  // A filter on the type: the totals, the series and the other facets follow it; the facet of the types does not.
  {
    const auto doc = usage_overview(usage, live, "7d", now, usage_query("method", {}, {}, {}, {"call"}));
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(15));
    CHECK_EQ(doc["totals"]["calls"].GetUint64(), uint64_t(15));
    check_series(doc);
    CHECK(usage_names(doc["methods"], "method") == names({"list_hosts", "run_query"}));
    CHECK_EQ(usage_figure(doc["keys"], "id", "k1", "requests"), uint64_t(8));
    CHECK_EQ(usage_figure(doc["keys"], "id", "k2", "requests"), uint64_t(3));
    CHECK_EQ(usage_figure(doc["keys"], "id", "gone", "requests"), uint64_t(4));
    CHECK_EQ(usage_figure(doc["results"], "result", "ok", "count"), uint64_t(13));
    CHECK_EQ(doc["results"].Size(), 3u);
    CHECK_EQ(usage_figure(doc["types"], "type", "call", "requests"), uint64_t(15));
    CHECK_EQ(usage_figure(doc["types"], "type", "request", "requests"), uint64_t(6));  // its own filter does not cut it
    CHECK_EQ(usage_figure(doc["types"], "type", "limited", "requests"), uint64_t(1));
    CHECK_EQ(doc["filters"]["type"].Size(), 1u);
    // The series by type, when the type is filtered: the groups are the types that were chosen.
    const auto split = usage_overview(usage, live, "7d", now, usage_query("type", {}, {}, {}, {"rejected", "call"}));
    CHECK(usage_names(split["series"]["groups"], "id") == names({"rejected", "call"}));
    CHECK_EQ(split["series"]["groups"][0]["total"].GetUint64(), uint64_t(1));
    CHECK_EQ(split["series"]["groups"][1]["total"].GetUint64(), uint64_t(15));
    CHECK_EQ(split["totals"]["requests"].GetUint64(), uint64_t(16));
    check_series(split);
  }

  // A filter on the method: what the key ran, and the codes that it ended with.
  {
    const auto doc = usage_overview(usage, live, "7d", now, usage_query("method", {}, {"run_query"}));
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(4));
    CHECK_EQ(doc["totals"]["errors"].GetUint64(), uint64_t(2));
    CHECK_EQ(doc["totals"]["active_keys"].GetUint64(), uint64_t(2));
    check_series(doc);
    // The groups of a split by the filtered dimension are the values that were chosen.
    CHECK(usage_names(doc["series"]["groups"], "id") == names({"run_query"}));
    CHECK_EQ(doc["series"]["rest"]["groups"].GetUint64(), uint64_t(0));
    // Its error codes (the results that ignore their own filter only).
    CHECK(usage_names(doc["results"], "result") == names({"ok", "query_failed", "timeout"}));
    CHECK_EQ(usage_figure(doc["results"], "result", "ok", "count"), uint64_t(2));
    CHECK_EQ(usage_figure(doc["keys"], "id", "k1", "requests"), uint64_t(3));
    CHECK_EQ(usage_figure(doc["keys"], "id", "k2", "requests"), uint64_t(1));
    CHECK(usage_row(doc["keys"], "id", "gone") == nullptr);
    // The facet of the methods ignores its own filter: the other methods stay, and can be added.
    CHECK_EQ(doc["methods"].Size(), 8u);
    CHECK_EQ(usage_figure(doc["methods"], "method", "list_hosts", "requests"), uint64_t(11));
    CHECK_EQ(usage_figure(doc["types"], "type", "call", "requests"), uint64_t(4));
    CHECK_EQ(usage_figure(doc["types"], "type", "request", "requests"), uint64_t(0));
  }

  // Filters of two dimensions are AND; the values of one are OR. A value that was chosen stays in its facet at 0.
  {
    const auto doc = usage_overview(usage, live, "7d", now, usage_query("method", {}, {"list_hosts"}, {"timeout"}));
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(0));
    CHECK(doc["totals"]["duration_ms_avg"].IsNull());
    CHECK(doc["totals"]["duration_ms_max"].IsNull());
    CHECK_EQ(doc["totals"]["active_keys"].GetUint64(), uint64_t(0));
    CHECK(usage_names(doc["series"]["groups"], "id") == names({"list_hosts"}));
    CHECK_EQ(doc["series"]["groups"][0]["total"].GetUint64(), uint64_t(0));
    CHECK_EQ(doc["series"]["groups"][0]["values"].Size(), 7u);
    check_series(doc);
    // methods: the requests that ended with timeout (any method), and list_hosts, which was chosen
    CHECK(usage_names(doc["methods"], "method") == names({"run_query", "list_hosts"}));
    CHECK_EQ(usage_figure(doc["methods"], "method", "list_hosts", "requests"), uint64_t(0));
    CHECK(usage_row(doc["methods"], "method", "list_hosts")->HasMember("duration_ms_avg"));
    CHECK((*usage_row(doc["methods"], "method", "list_hosts"))["duration_ms_avg"].IsNull());
    CHECK_EQ(std::string((*usage_row(doc["methods"], "method", "list_hosts"))["kind"].GetString()), std::string("call"));
    // results: the requests of list_hosts, and the timeout that was chosen
    CHECK(usage_names(doc["results"], "result") == names({"ok", "timeout"}));
    CHECK_EQ(usage_figure(doc["results"], "result", "ok", "count"), uint64_t(11));
    CHECK_EQ(usage_figure(doc["results"], "result", "timeout", "count"), uint64_t(0));
    CHECK_EQ(doc["keys"].Size(), 0u);
    for (const auto& row : doc["types"].GetArray()) CHECK_EQ(row["requests"].GetUint64(), uint64_t(0));
    // The values of a dimension are OR.
    const auto either = usage_overview(usage, live, "7d", now, usage_query("method", {}, {"run_query", "tools/list", "ping"}));
    CHECK_EQ(either["totals"]["requests"].GetUint64(), uint64_t(5));
    CHECK(usage_names(either["series"]["groups"], "id") == names({"run_query", "tools/list", "ping"}));  // in the order of the request, ping at 0
    CHECK_EQ(either["series"]["groups"][2]["total"].GetUint64(), uint64_t(0));
    check_series(either);
    // A method of the protocol that nothing called is a "request" row at 0, "unread" is "refused", a name that is no method is a tool.
    CHECK_EQ(std::string((*usage_row(either["methods"], "method", "ping"))["kind"].GetString()), std::string("request"));
    const auto kinds = usage_overview(usage, live, "7d", now, usage_query("method", {}, {"unread", "initialize", "list_tables"}, {"nothing_like_it"}));
    CHECK_EQ(std::string((*usage_row(kinds["methods"], "method", "unread"))["kind"].GetString()), std::string("refused"));
    CHECK_EQ(std::string((*usage_row(kinds["methods"], "method", "initialize"))["kind"].GetString()), std::string("request"));
    CHECK_EQ(std::string((*usage_row(kinds["methods"], "method", "list_tables"))["kind"].GetString()), std::string("call"));
  }

  // Values that nothing has: they keep nothing, and they are in their facet at 0 (a key that is not there is known by its id).
  {
    const auto doc = usage_overview(usage, live, "7d", now, usage_query("key", {"ui_000000000000", "k2"}, {"nope"}, {"nothing_here"}));
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(0));
    CHECK(usage_names(doc["series"]["groups"], "id") == names({"ui_000000000000", "k2"}));
    CHECK_EQ(std::string(doc["series"]["groups"][0]["label"].GetString()), std::string("ui_000000000000"));
    CHECK_EQ(std::string(doc["series"]["groups"][1]["label"].GetString()), std::string("k2"));
    check_series(doc);
    CHECK(usage_names(doc["keys"], "id") == names({"k2", "ui_000000000000"}));  // no request: by name
    const auto* ghost = usage_row(doc["keys"], "id", "ui_000000000000");
    CHECK(ghost != nullptr);
    CHECK_EQ(std::string((*ghost)["name"].GetString()), std::string("ui_000000000000"));
    CHECK_EQ((*ghost)["requests"].GetUint64(), uint64_t(0));
    CHECK((*ghost)["deleted_at"].IsNull());
    CHECK((*ghost)["last_used_at"].IsNull());
    CHECK_EQ(std::string((*usage_row(doc["keys"], "id", "k2"))["name"].GetString()), std::string("k2"));
    CHECK(usage_names(doc["methods"], "method") == names({"nope"}));
    CHECK_EQ(std::string(doc["methods"][0]["kind"].GetString()), std::string("call"));
    CHECK(usage_names(doc["results"], "result") == names({"nothing_here"}));
    CHECK_EQ(doc["results"][0]["count"].GetUint64(), uint64_t(0));
  }

  // A deleted key: in the keys with when it was deleted, and a filter on it cuts the clients too.
  {
    const auto doc = usage_overview(usage, live, "7d", now, usage_query("key", {"gone"}));
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(4));
    CHECK_EQ(doc["totals"]["active_keys"].GetUint64(), uint64_t(1));
    CHECK(usage_names(doc["series"]["groups"], "id") == names({"gone"}));
    CHECK_EQ(std::string(doc["series"]["groups"][0]["label"].GetString()), std::string("gone"));
    CHECK_EQ(usage_figure(doc["keys"], "id", "k1", "requests"), uint64_t(12));  // the facet of the keys ignores its own filter
    CHECK_EQ(std::string((*usage_row(doc["keys"], "id", "gone"))["deleted_at"].GetString()), mcp_iso_utc(now + 100));
    CHECK_EQ(doc["clients"].Size(), 1u);
    CHECK_EQ(std::string(doc["clients"][0]["user_agent"].GetString()), std::string("agent/1"));
    CHECK_EQ(doc["clients"][0]["keys"].GetUint64(), uint64_t(1));
    CHECK_EQ(doc["clients"][0]["requests"].GetUint64(), uint64_t(4));
    // In 24 hours it did nothing: a row at 0, as a key that was chosen.
    const auto hours = usage_overview(usage, live, "24h", now, usage_query("method", {"gone"}));
    CHECK_EQ(hours["totals"]["requests"].GetUint64(), uint64_t(0));
    const auto* row = usage_row(hours["keys"], "id", "gone");
    CHECK(row != nullptr);
    CHECK_EQ((*row)["requests"].GetUint64(), uint64_t(0));
    CHECK_EQ(std::string((*row)["deleted_at"].GetString()), mcp_iso_utc(now + 100));
    CHECK(!(*row)["last_used_at"].IsNull());
    CHECK_EQ(hours["clients"].Size(), 1u);  // the window does not cut the clients
  }

  // The clients answer to the filter of the keys only: not to the window, the method, the result or the type.
  {
    const auto whole = usage_overview(usage, live, "7d", now, usage_query("method", {"k2"}));
    CHECK_EQ(whole["clients"].Size(), 1u);
    CHECK_EQ(std::string(whole["clients"][0]["name"].GetString()), std::string("claude-ai"));
    CHECK_EQ(whole["clients"][0]["requests"].GetUint64(), uint64_t(7));
    const auto cut = usage_overview(usage, live, "24h", now, usage_query("result", {"k2"}, {"ping"}, {"timeout"}, {"limited"}));
    CHECK_EQ(cut["totals"]["requests"].GetUint64(), uint64_t(0));
    CHECK_EQ(cut["clients"].Size(), 1u);
    CHECK_EQ(cut["clients"][0]["requests"].GetUint64(), uint64_t(7));
    CHECK_EQ(std::string(cut["clients"][0]["version"].GetString()), std::string("0.1"));
  }

  // A split by key: the labels are the names. A split by result or by type: the id is the label.
  {
    const auto by_key = usage_overview(usage, live, "7d", now, usage_query("key"));
    CHECK(usage_names(by_key["series"]["groups"], "id") == names({"k1", "k2", "gone"}));
    CHECK(usage_names(by_key["series"]["groups"], "label") == names({"k1", "k2", "gone"}));
    CHECK_EQ(by_key["series"]["groups"][0]["total"].GetUint64(), uint64_t(12));
    check_series(by_key);
    const auto ordered = usage_overview(usage, live, "7d", now, usage_query("key", {"k2", "k1"}));
    CHECK(usage_names(ordered["series"]["groups"], "id") == names({"k2", "k1"}));  // the order of the filter, not of the totals
    const auto by_result = usage_overview(usage, live, "7d", now, usage_query("result"));
    CHECK(usage_names(by_result["series"]["groups"], "id") ==
          names({"ok", "415_unsupported_media_type", "429_rate_limited", "query_failed", "rpc_error_32601", "timeout"}));
    CHECK_EQ(by_result["series"]["groups"][0]["total"].GetUint64(), uint64_t(18));
    check_series(by_result);
    const auto by_type = usage_overview(usage, live, "7d", now, usage_query("type"));
    CHECK(usage_names(by_type["series"]["groups"], "id") == names({"call", "request", "limited", "rejected"}));
    CHECK(usage_names(by_type["series"]["groups"], "label") == names({"call", "request", "limited", "rejected"}));
    check_series(by_type);
  }

  // No usage at all: zeros, the four types, nothing else.
  {
    McpUsage empty(options, now);
    const auto doc = usage_overview(empty, live, "7d", now);
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(0));
    CHECK(doc["totals"]["duration_ms_avg"].IsNull());
    CHECK_EQ(doc["totals"]["keys"].GetUint64(), uint64_t(2));
    CHECK_EQ(doc["series"]["groups"].Size(), 0u);
    CHECK_EQ(doc["series"]["rest"]["values"].Size(), 7u);
    CHECK_EQ(doc["keys"].Size(), 0u);
    CHECK_EQ(doc["methods"].Size(), 0u);
    CHECK_EQ(doc["results"].Size(), 0u);
    CHECK_EQ(doc["types"].Size(), 4u);
    CHECK_EQ(doc["clients"].Size(), 0u);
    check_series(doc);
  }
}

// The 8 largest groups of the series, and the others summed in `rest`; the caps of the facets and of the clients.
void test_usage_overview_caps() {
  const int64_t now = 1'800'007'200 - 1'800'007'200 % 3600;
  const int64_t day = 86400;
  McpUsageOptions options;
  options.retention_days = 30;

  // 10 tools: the 8 largest, the tie of the 8th and 9th by name, the others in `rest` at each point.
  {
    McpUsage usage(options, now - day);
    const int counts[] = {10, 9, 8, 7, 6, 5, 4, 3, 3, 1};
    for (int pass = 0; pass < 2; ++pass) {  // the older hour first: the time goes forward
      for (int i = 0; i < 10; ++i) {
        const int here = pass == 0 ? counts[i] / 2 : counts[i] - counts[i] / 2;
        for (int n = 0; n < here; ++n) {
          UsageCall call;
          call.at = pass == 0 ? now - 3600 : now;
          call.tool = "t" + std::to_string(i);
          usage_record(usage, call);
        }
      }
    }
    const auto doc = usage_overview(usage, {"k1"}, "24h", now);
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(56));
    CHECK_EQ(doc["series"]["groups"].Size(), 8u);
    CHECK(usage_names(doc["series"]["groups"], "id") == std::vector<std::string>({"t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"}));
    CHECK_EQ(doc["series"]["rest"]["groups"].GetUint64(), uint64_t(2));
    CHECK_EQ(doc["series"]["rest"]["total"].GetUint64(), uint64_t(4));  // t8 and t9
    CHECK_EQ(doc["series"]["rest"]["values"][22].GetUint64(), uint64_t(1));
    CHECK_EQ(doc["series"]["rest"]["values"][23].GetUint64(), uint64_t(3));
    const auto at = check_series(doc);
    CHECK_EQ(at[22], uint64_t(25));
    CHECK_EQ(at[23], uint64_t(31));
    CHECK_EQ(doc["methods"].Size(), 10u);  // the facet shows every one
    // A split by a dimension that is filtered shows the values that were chosen, not the 8 largest.
    const auto chosen = usage_overview(usage, {"k1"}, "24h", now, usage_query("method", {}, {"t9", "zzz", "t0"}));
    CHECK(usage_names(chosen["series"]["groups"], "id") == std::vector<std::string>({"t9", "zzz", "t0"}));
    CHECK_EQ(chosen["series"]["groups"][1]["total"].GetUint64(), uint64_t(0));
    CHECK_EQ(chosen["series"]["rest"]["groups"].GetUint64(), uint64_t(0));
    CHECK_EQ(chosen["series"]["rest"]["total"].GetUint64(), uint64_t(0));
    CHECK_EQ(chosen["totals"]["requests"].GetUint64(), uint64_t(11));
    check_series(chosen);
    // More than 8 values chosen: all of them, and no `rest`.
    std::vector<std::string> all;
    for (int i = 0; i < 10; ++i) all.push_back("t" + std::to_string(i));
    const auto everyone = usage_overview(usage, {"k1"}, "24h", now, usage_query("method", {}, all));
    CHECK_EQ(everyone["series"]["groups"].Size(), 10u);
    CHECK_EQ(everyone["series"]["rest"]["groups"].GetUint64(), uint64_t(0));
    check_series(everyone);
  }

  // At most 200 rows for each facet (the values that were chosen are always there) and 50 clients; `omitted` counts what was cut.
  {
    McpUsage usage(options, now - day);
    std::vector<std::string> keys;
    std::vector<std::string> results;
    for (int i = 0; i < 250; ++i) {
      UsageCall call;
      call.id = "key-" + std::to_string(i);
      call.at = now + i;
      call.tool = "run_query";
      call.status = "err_" + std::to_string(i);
      call.user_agent = "agent/" + std::to_string(i);
      usage_record(usage, call);
      keys.push_back(call.id);
      results.push_back(call.status);
    }
    std::sort(keys.begin(), keys.end());
    std::sort(results.begin(), results.end());
    const auto doc = usage_overview(usage, {}, "24h", now);
    CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(250));
    CHECK_EQ(doc["totals"]["active_keys"].GetUint64(), uint64_t(250));
    CHECK_EQ(doc["keys"].Size(), 200u);
    CHECK_EQ(doc["omitted"]["keys"].GetUint64(), uint64_t(50));
    CHECK_EQ(std::string(doc["keys"][0]["id"].GetString()), keys.front());  // the same requests: by name
    CHECK_EQ(doc["results"].Size(), 200u);
    CHECK_EQ(doc["omitted"]["results"].GetUint64(), uint64_t(50));
    CHECK_EQ(doc["methods"].Size(), 1u);
    CHECK_EQ(doc["omitted"]["methods"].GetUint64(), uint64_t(0));
    CHECK_EQ(doc["clients"].Size(), 50u);
    CHECK_EQ(doc["omitted"]["clients"].GetUint64(), uint64_t(200));
    CHECK_EQ(doc["series"]["groups"].Size(), 1u);
    // The values that were chosen are kept, however far they come (a facet ignores its own filter, so the others stay).
    const auto kept_key = usage_overview(usage, {}, "24h", now, usage_query("method", {keys.back()}));
    CHECK_EQ(kept_key["keys"].Size(), 201u);
    CHECK_EQ(kept_key["omitted"]["keys"].GetUint64(), uint64_t(49));
    CHECK(usage_row(kept_key["keys"], "id", keys.back()) != nullptr);
    CHECK_EQ(kept_key["totals"]["requests"].GetUint64(), uint64_t(1));
    CHECK_EQ(kept_key["clients"].Size(), 1u);
    const auto kept_result = usage_overview(usage, {}, "24h", now, usage_query("method", {}, {}, {results.back()}));
    CHECK_EQ(kept_result["results"].Size(), 201u);
    CHECK_EQ(kept_result["omitted"]["results"].GetUint64(), uint64_t(49));
    CHECK(usage_row(kept_result["results"], "result", results.back()) != nullptr);
    CHECK_EQ(kept_result["totals"]["requests"].GetUint64(), uint64_t(1));
  }
}

// The rules of the parameters of the overview (the route answers 400 validation, with the field and the reason, when one fails).
void test_usage_overview_check() {
  const auto check = [](McpUsageOverviewQuery query) { return mcp_usage_overview_check(&query); };
  const auto fails = [&](McpUsageOverviewQuery query, const char* field, const char* reason) {
    const auto error = mcp_usage_overview_check(&query);
    CHECK(error.has_value());
    if (!error) return;
    CHECK_EQ(error->field, std::string(field));
    CHECK_EQ(error->reason, std::string(reason));
    CHECK(!error->message.empty());
  };
  CHECK(!check(McpUsageOverviewQuery{}).has_value());
  for (const char* split : {"key", "method", "result", "type"}) CHECK(!check(usage_query(split)).has_value());
  for (const char* split : {"", "Method", "keys", "methods", "key,method", "none"}) fails(usage_query(split), "split", "invalid");

  CHECK(!check(usage_query("key", {"all-data", "ui_0a1b2c3d4e5f", "a"})).has_value());
  for (const char* key : {"", "Bad Key", "ui_xyz", "ui_0A1B2C3D4E5F", "ui_0a1b2c3d4e5", "-lead", "a/b", "has space"}) fails(usage_query("key", {key}), "key", "invalid");
  fails(usage_query("key", {std::string(33, 'a')}), "key", "invalid");

  CHECK(!check(usage_query("method", {}, {"list_hosts", "logging/setLevel", "notifications/roots/list_changed", "A_b/c", std::string(64, 'x')})).has_value());
  for (const char* method : {"", "has space", "tools/call:run_query", "a-b", "a.b", "caf\xc3\xa9", "a\nb"}) fails(usage_query("method", {}, {method}), "method", "invalid");
  fails(usage_query("method", {}, {std::string(65, 'x')}), "method", "invalid");

  CHECK(!check(usage_query("result", {}, {}, {"ok", "rpc_error_32601", "429_rate_limited", std::string(64, 'x')})).has_value());
  for (const char* result : {"", "Ok", "a/b", "a b", "a-b", "caf\xc3\xa9"}) fails(usage_query("result", {}, {}, {result}), "result", "invalid");
  fails(usage_query("result", {}, {}, {std::string(65, 'x')}), "result", "invalid");

  CHECK(!check(usage_query("type", {}, {}, {}, {"call", "request", "limited", "rejected"})).has_value());
  for (const char* type : {"", "Call", "tool", "refused", "calls", "call,request"}) fails(usage_query("type", {}, {}, {}, {type}), "type", "invalid");

  // At most 20 values for each dimension; a value that is repeated counts once.
  std::vector<std::string> keys;
  std::vector<std::string> methods;
  std::vector<std::string> results;
  for (int i = 0; i < 21; ++i) {
    keys.push_back("key-" + std::to_string(i));
    methods.push_back("method_" + std::to_string(i));
    results.push_back("result_" + std::to_string(i));
  }
  const auto first = [](const std::vector<std::string>& values) { return std::vector<std::string>(values.begin(), values.begin() + 20); };
  CHECK(!check(usage_query("key", first(keys), first(methods), first(results))).has_value());
  fails(usage_query("key", keys), "key", "too_many");
  fails(usage_query("key", {}, methods), "method", "too_many");
  fails(usage_query("key", {}, {}, results), "result", "too_many");
  CHECK(!check(usage_query("key", {}, {}, {}, {"call", "request", "limited", "rejected", "call"})).has_value());  // the 5th is a repeat
  fails(usage_query("key", {}, {}, {}, results), "type", "too_many");  // the number comes before the values
  {
    McpUsageOverviewQuery query = usage_query("method", std::vector<std::string>(30, "k1"), {"b", "a", "b", "a", "c"});
    CHECK(!mcp_usage_overview_check(&query).has_value());
    CHECK(query.keys == std::vector<std::string>({"k1"}));
    CHECK(query.methods == std::vector<std::string>({"b", "a", "c"}));  // the first occurrence, in the order of the request
  }
  // The first rule that fails is the answer: the split, then the keys, the methods, the results and the types.
  fails(usage_query("nope", {"Bad Key"}, {"has space"}), "split", "invalid");
  fails(usage_query("key", {"Bad Key"}, {"has space"}, {"A"}, {"x"}), "key", "invalid");
  fails(usage_query("key", {}, {"has space"}, {"A"}, {"x"}), "method", "invalid");
  fails(usage_query("key", {}, {}, {"A"}, {"x"}), "result", "invalid");
}

// Counting while the overview reads: an entry at a time, never a name read outside the lock (the names grow and move).
void test_usage_overview_while_counting() {
  const int64_t now = 1'800'007'200 - 1'800'007'200 % 3600;
  McpUsageOptions options;
  options.retention_days = 7;
  McpUsage usage(options, now);
  const int events = 20000;
  std::thread counter([&] {
    for (int i = 0; i < events; ++i) {
      UsageCall call;
      call.id = "k" + std::to_string(i % 7);
      call.at = now + 1;
      call.tool = "tool_" + std::to_string(i % 150);  // under the 200 rows of a facet: the facets add up to the requests
      if (i % 5 == 0) call.status = "err_" + std::to_string(i % 40);
      call.user_agent = "agent/" + std::to_string(i % 3);
      usage_record(usage, call);
    }
  });
  const std::vector<std::string> live = {"k0", "k1", "k2", "k3", "k4", "k5", "k6"};
  for (int i = 0; i < 40; ++i) {
    const auto doc = usage_overview(usage, live, "24h", now + 1, usage_query(i % 2 ? "key" : "method"));
    CHECK(usage_overview_adds_up(doc));
  }
  counter.join();
  const auto doc = usage_overview(usage, live, "24h", now + 1);
  CHECK_EQ(doc["totals"]["requests"].GetUint64(), uint64_t(events));
  CHECK_EQ(doc["totals"]["active_keys"].GetUint64(), uint64_t(7));
  check_series(doc);
  check_facets_add_up(doc);
}

void test_rate_limiter() {
  McpRateLimiter limiter;
  int retry = 0;
  const int64_t t0 = 1'000'000;
  CHECK(limiter.allow("k", t0, 3, &retry));
  CHECK(limiter.allow("k", t0, 3, &retry));
  CHECK(limiter.allow("k", t0, 3, &retry));
  CHECK(!limiter.allow("k", t0, 3, &retry));
  CHECK(retry >= 1 && retry <= 21);
  CHECK(limiter.allow("other", t0, 3, &retry));  // one bucket per key
  CHECK(!limiter.allow("k", t0 + 5000, 3, &retry));
  CHECK(limiter.allow("k", t0 + 21000, 3, &retry));  // 3 per minute: one token per 20 s
  CHECK(!limiter.allow("k", t0 + 21000, 3, &retry));
  for (int i = 0; i < 100; ++i) CHECK(limiter.allow("free", t0, 0, &retry));  // 0 = no limit
  // A refill never exceeds the burst.
  CHECK(limiter.allow("burst", t0, 2, &retry));
  for (int i = 0; i < 2; ++i) CHECK(limiter.allow("burst", t0 + 10'000'000, 2, &retry));
  CHECK(!limiter.allow("burst", t0 + 10'000'000, 2, &retry));
}

// ---- SQL ---------------------------------------------------------------------------------------------

const std::vector<std::string> kReadWords = {"SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXISTS", "EXPLAIN"};

void test_sql_scanner() {
  const auto scan = [](const std::string& sql) { return mcp_scan_single_statement(sql, kReadWords); };
  for (const char* ok : {"SELECT 1", " select 1 ; ", "SELECT 'a;b'", "SELECT \"a;b\"", "SELECT `a;b`", "SELECT 1 -- ; x",
                         "SELECT 1 /* ; */", "SELECT $$a;b$$", "SELECT $tag$a;$$;b$tag$", "SELECT 'it''s; ok'",
                         "WITH 1 AS x SELECT x", "(SELECT 1)", "EXPLAIN SELECT 1", "SHOW TABLES", "DESCRIBE t",
                         "DESC t", "EXISTS TABLE t", "SELECT 1 # ; comment", "SELECT 1 FORMAT JSON",
                         "-- leading comment\nSELECT 1", "/* c */ SELECT 1;", "SELECT 1;  -- trailing\n", "SELECT 'a\\'b;c'",
                         "SELECT a$b FROM t", "SELECT 1 AS `x;y`", "SELECT 1 as \"it\"\"s;\""}) {
    const auto r = scan(ok);
    if (!r.ok) std::cerr << "should pass: " << ok << " -> " << r.error << ": " << r.message << std::endl;
    CHECK(r.ok);
  }
  CHECK_EQ(scan("  SELECT 1 ;  ").statement, std::string("SELECT 1"));
  CHECK_EQ(scan("select 1").first_keyword, std::string("SELECT"));
  CHECK_EQ(scan("(WITH 1 AS x SELECT x)").first_keyword, std::string("WITH"));
  CHECK_EQ(scan("SELECT 'a;b';").statement, std::string("SELECT 'a;b'"));

  const auto code = [&](const std::string& sql) { return scan(sql).error; };
  CHECK_EQ(code("SELECT 1; SELECT 2"), std::string("multiple_statements"));
  CHECK_EQ(code("SELECT 1;;"), std::string("multiple_statements"));
  CHECK_EQ(code("SELECT 1; -- c\nSELECT 2"), std::string("multiple_statements"));
  CHECK_EQ(code("SELECT 1;SELECT 2;"), std::string("multiple_statements"));
  CHECK_EQ(code("SELECT 1 /* x */; DROP TABLE t"), std::string("multiple_statements"));
  CHECK_EQ(code("SELECT 'a"), std::string("invalid_sql"));
  CHECK_EQ(code("SELECT \"a"), std::string("invalid_sql"));
  CHECK_EQ(code("SELECT `a"), std::string("invalid_sql"));
  CHECK_EQ(code("SELECT /* x"), std::string("invalid_sql"));
  CHECK_EQ(code("SELECT $$a"), std::string("invalid_sql"));
  // A backslash escapes the quote in ClickHouse: this string never closes, so the ; is not a separator.
  CHECK_EQ(code("SELECT 'a\\' ; SELECT 2"), std::string("invalid_sql"));
  CHECK_EQ(code(std::string("SELECT 1\0; DROP", 15)), std::string("invalid_sql"));
  CHECK_EQ(code(""), std::string("empty_sql"));
  CHECK_EQ(code("   "), std::string("empty_sql"));
  CHECK_EQ(code("-- only a comment"), std::string("empty_sql"));
  CHECK_EQ(code(";"), std::string("empty_sql"));
  for (const char* bad : {"DROP TABLE t", "INSERT INTO t VALUES (1)", "ALTER TABLE t DELETE WHERE 1", "CREATE TABLE t (a Int8) ENGINE = Memory",
                          "SET readonly = 0", "SYSTEM FLUSH LOGS", "KILL QUERY WHERE 1", "OPTIMIZE TABLE t", "TRUNCATE TABLE t",
                          "GRANT SELECT ON *.* TO x", "USE db", "ATTACH TABLE t", "RENAME TABLE a TO b", "1", "'SELECT'", "`SELECT` 1"}) {
    CHECK_EQ(code(bad), std::string("statement_not_allowed"));
  }
  CHECK_EQ(code("SELECT 1 INTO OUTFILE '/tmp/x'"), std::string("clause_not_allowed"));
  CHECK_EQ(code("SELECT 1 into /* c */ outfile 'x'"), std::string("clause_not_allowed"));
  // A SETTINGS clause would change the limits of the key (a profile at readonly = 2 lets a statement change them).
  for (const char* bad : {"SELECT 1 SETTINGS max_execution_time = 3600", "select 1 settings /* c */ `max_memory_usage` = 0",
                          "SELECT 1 SETTINGS \"max_rows_to_read\"=0", "SELECT * FROM (SELECT 1 SETTINGS max_result_rows = 0)",
                          "SELECT 1 FORMAT JSON SETTINGS log_comment = 'x'", "EXPLAIN SELECT 1 SETTINGS readonly = 0",
                          "SELECT 1 SETTINGS -- c\n max_threads = 1, log_comment = 'x';"}) {
    CHECK_EQ(code(bad), std::string("clause_not_allowed"));
  }
  // A column, an alias, a table or a text named settings is no clause.
  for (const char* ok : {"SELECT Settings['max_threads'] FROM system.query_log", "SELECT name FROM system.settings WHERE name = 'readonly'",
                         "SELECT 1 AS settings", "SELECT settings = 1 FROM t", "SELECT 'SETTINGS x = 1'", "SELECT 1 -- SETTINGS x = 1",
                         "SELECT s.settings.x = 1 FROM t AS s", "SELECT `SETTINGS` FROM t"}) {
    const auto r = scan(ok);
    if (!r.ok) std::cerr << "should pass: " << ok << " -> " << r.error << ": " << r.message << std::endl;
    CHECK(r.ok);
  }
  CHECK_EQ(code("SELECT * FROM file('/etc/passwd')"), std::string("function_not_allowed"));
  CHECK_EQ(code("SELECT * FROM URL ('http://x', CSV)"), std::string("function_not_allowed"));
  CHECK_EQ(code("SELECT * FROM remote('h', db.t)"), std::string("function_not_allowed"));
  CHECK_EQ(code("SELECT * FROM remoteSecure('h', db.t)"), std::string("function_not_allowed"));
  CHECK_EQ(code("SELECT * FROM s3('x')"), std::string("function_not_allowed"));
  CHECK_EQ(code("SELECT * FROM mysql('x')"), std::string("function_not_allowed"));
  CHECK_EQ(code("SELECT * FROM executable('x')"), std::string("function_not_allowed"));
  CHECK(scan("SELECT file, url FROM t").ok);  // a column named file is not a call
  CHECK(scan("SELECT 'file(x)'").ok);

  // explain_query takes SELECT and WITH only.
  CHECK(mcp_scan_single_statement("SELECT 1", {"SELECT", "WITH"}).ok);
  CHECK(!mcp_scan_single_statement("SHOW TABLES", {"SELECT", "WITH"}).ok);
  CHECK(!mcp_scan_single_statement("EXPLAIN SELECT 1", {"SELECT", "WITH"}).ok);
}

void test_sql_quoting_and_types() {
  CHECK_EQ(sql::quote_ident("a"), std::string("`a`"));
  CHECK_EQ(sql::quote_ident("a`b"), std::string("`a\\`b`"));
  CHECK_EQ(sql::quote_ident("a\\b"), std::string("`a\\\\b`"));
  CHECK_EQ(sql::quote_string("abc"), std::string("'abc'"));
  CHECK_EQ(sql::quote_string("o'rei\\lly"), std::string("'o\\'rei\\\\lly'"));
  CHECK_EQ(sql::quote_string("a\nb\tc\rd"), std::string("'a\\nb\\tc\\rd'"));
  CHECK_EQ(sql::quote_string(std::string("a\0b", 3)), std::string("'a\\0b'"));
  CHECK_EQ(sql::quote_string("a\x01" "b"), std::string("'a\\x01b'"));
  CHECK_EQ(sql::quote_string("' OR 1=1 --"), std::string("'\\' OR 1=1 --'"));
  CHECK_EQ(sql::quote_string(""), std::string("''"));

  const auto cls = [](const char* t) { return mcp_classify_type(t).cls; };
  CHECK(cls("Int8") == McpTypeClass::Integer);
  CHECK(cls("Int256") == McpTypeClass::Integer);
  CHECK(cls("UInt64") == McpTypeClass::UnsignedInteger);
  CHECK(cls("Float64") == McpTypeClass::Float);
  CHECK(cls("Decimal(18, 4)") == McpTypeClass::Decimal);
  CHECK(cls("Decimal64(3)") == McpTypeClass::Decimal);
  CHECK(cls("Bool") == McpTypeClass::Bool);
  CHECK(cls("String") == McpTypeClass::Text);
  CHECK(cls("FixedString(8)") == McpTypeClass::Text);
  CHECK(cls("UUID") == McpTypeClass::Text);
  CHECK(cls("Enum8('a' = 1)") == McpTypeClass::Enum);
  CHECK(cls("Date") == McpTypeClass::Temporal);
  CHECK(cls("DateTime64(9)") == McpTypeClass::Temporal);
  CHECK(cls("Nullable(Int32)") == McpTypeClass::Integer);
  CHECK(mcp_classify_type("Nullable(Int32)").nullable);
  CHECK(cls("LowCardinality(Nullable(String))") == McpTypeClass::Text);
  CHECK(mcp_classify_type("LowCardinality(String)").like_ok);
  CHECK(!mcp_classify_type("UUID").like_ok);
  CHECK(cls("SimpleAggregateFunction(max, UInt64)") == McpTypeClass::UnsignedInteger);
  CHECK(cls("Array(String)") == McpTypeClass::Unsupported);
  CHECK(cls("Map(String, String)") == McpTypeClass::Unsupported);
  CHECK(cls("Tuple(a Int8)") == McpTypeClass::Unsupported);
  CHECK(cls("JSON") == McpTypeClass::Unsupported);
  CHECK(cls("Interval") == McpTypeClass::Unsupported);
  CHECK(mcp_classify_type("AggregateFunction(sum, UInt64)").aggregate_state);
}

McpScalar S(const std::string& v) { return {McpScalar::Kind::String, false, v}; }
McpScalar I(const std::string& v) { return {McpScalar::Kind::Integer, false, v}; }
McpScalar F(const std::string& v) { return {McpScalar::Kind::Float, false, v}; }
McpScalar B(bool v) { return {McpScalar::Kind::Bool, v, v ? "1" : "0"}; }
McpScalar N() { return {McpScalar::Kind::Null, false, ""}; }
McpFilter filter(const std::string& column, const std::string& op, std::vector<McpScalar> values = {}, bool array = false) {
  McpFilter f;
  f.column = column;
  f.op = op;
  f.values = std::move(values);
  f.value_is_array = array;
  return f;
}

void test_sql_builder() {
  const std::vector<McpColumn> columns = {
      {"id", "UInt64", 8}, {"name", "String", 20}, {"note", "Nullable(String)", 5000}, {"score", "Float64", 8},
      {"price", "Decimal(10, 2)", 8}, {"ok", "Bool", 1}, {"ts", "DateTime", 4}, {"tags", "Array(String)", 100},
      {"state", "AggregateFunction(sum, UInt64)", 50}, {"we`ird", "Int32", 4}, {"level", "LowCardinality(String)", 4}};
  McpTableQuery q;
  q.database = "db";
  q.table = "t";
  q.limit = 100;

  // No column list: the wide and the aggregate-state columns are left out and named.
  auto built = mcp_build_table_query(q, columns);
  CHECK(built.ok);
  CHECK_EQ(built.sql, std::string("SELECT `id`, `name`, `score`, `price`, `ok`, `ts`, `tags`, `we\\`ird`, `level` FROM `db`.`t` LIMIT 100"));
  CHECK_EQ(built.omitted.size(), size_t(2));
  CHECK_EQ(built.omitted[0].name, std::string("note"));
  CHECK_EQ(built.omitted[0].reason, std::string("wide"));
  CHECK_EQ(built.omitted[1].reason, std::string("aggregate_state"));

  // A column list is validated against the real columns, and the omissions do not apply.
  q.columns = {"id", "note", "we`ird"};
  built = mcp_build_table_query(q, columns);
  CHECK(built.ok);
  CHECK_EQ(built.sql, std::string("SELECT `id`, `note`, `we\\`ird` FROM `db`.`t` LIMIT 100"));
  CHECK(built.omitted.empty());
  q.columns = {"id", "missing"};
  built = mcp_build_table_query(q, columns);
  CHECK(!built.ok);
  CHECK_EQ(built.error, std::string("unknown_column"));
  CHECK_EQ(built.argument, std::string("columns[1]"));
  q.columns = {"id) FROM secrets --"};
  CHECK_EQ(mcp_build_table_query(q, columns).error, std::string("unknown_column"));
  q.columns = {"id", "id"};
  CHECK_EQ(mcp_build_table_query(q, columns).error, std::string("invalid_argument"));
  q.columns = {};

  // Filters: typed and escaped values.
  q.filters = {filter("name", "=", {S("o'rei\\lly")}), filter("id", ">=", {I("5")}), filter("score", "<", {F("1.5")}),
               filter("ok", "=", {B(true)}), filter("ts", ">", {S("2026-01-01 00:00:00")}), filter("note", "is_null"),
               filter("name", "like", {S("a%")}), filter("level", "in", {S("a"), S("b")}, true),
               filter("id", "not_in", {I("1"), S("2")}, true), filter("name", "not_like", {S("x%")}),
               filter("name", "ilike", {S("%y%")}), filter("note", "is_not_null"), filter("price", "!=", {S("12.50")})};
  q.order_by = {{"id", true}, {"name", false}};
  q.columns = {"id"};
  q.limit = 7;
  built = mcp_build_table_query(q, columns);
  CHECK(built.ok);
  CHECK_EQ(built.sql, std::string(
      "SELECT `id` FROM `db`.`t` WHERE `name` = 'o\\'rei\\\\lly' AND `id` >= 5 AND `score` < 1.5 AND `ok` = true AND "
      "`ts` > '2026-01-01 00:00:00' AND `note` IS NULL AND `name` LIKE 'a%' AND `level` IN ('a', 'b') AND "
      "`id` NOT IN (1, 2) AND `name` NOT LIKE 'x%' AND `name` ILIKE '%y%' AND `note` IS NOT NULL AND `price` != 12.50 "
      "ORDER BY `id` DESC, `name` ASC LIMIT 7"));

  // Injection attempts stay inside a literal or fail.
  const auto filter_error = [&](McpFilter f) {
    McpTableQuery x;
    x.database = "db";
    x.table = "t";
    x.filters = {f};
    const auto b = mcp_build_table_query(x, columns);
    return b.ok ? std::string("ok") : b.error;
  };
  CHECK_EQ(filter_error(filter("name", "=", {S("' OR 1=1 --")})), std::string("ok"));
  CHECK_EQ(filter_error(filter("id", "=", {S("1; DROP TABLE t")})), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("id", "=", {S("1 OR 1=1")})), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("id", "=", {I("-1")})), std::string("invalid_argument"));  // unsigned
  CHECK_EQ(filter_error(filter("we`ird", "=", {I("-1")})), std::string("ok"));
  CHECK_EQ(filter_error(filter("score", "=", {S("1e5")})), std::string("ok"));
  CHECK_EQ(filter_error(filter("score", "=", {S("1e5;")})), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("price", "=", {S("1e5")})), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("ok", "=", {S("maybe")})), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("ts", "=", {B(true)})), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("ts", "=", {I("1700000000")})), std::string("ok"));
  CHECK_EQ(filter_error(filter("name", "=", {N()})), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("name", "=", {S("a"), S("b")}, true)), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("name", "in", {S("a")})), std::string("invalid_argument"));  // not an array
  CHECK_EQ(filter_error(filter("name", "in", {}, true)), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("id", "like", {S("1%")})), std::string("unsupported_column_type"));
  CHECK_EQ(filter_error(filter("name", "like", {I("1")})), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("tags", "=", {S("a")})), std::string("unsupported_column_type"));
  CHECK_EQ(filter_error(filter("tags", "is_null")), std::string("ok"));
  CHECK_EQ(filter_error(filter("name", "regexp", {S("a")})), std::string("invalid_argument"));
  CHECK_EQ(filter_error(filter("name; DROP", "=", {S("a")})), std::string("unknown_column"));
  CHECK_EQ(filter_error(filter("name", "= 1 OR 1", {S("a")})), std::string("invalid_argument"));
  {
    McpTableQuery x;
    x.database = "d`b";
    x.table = "t\\";
    x.columns = {"id"};
    CHECK_EQ(mcp_build_table_query(x, columns).sql, std::string("SELECT `id` FROM `d\\`b`.`t\\\\` LIMIT 100"));
    x.order_by = {{"missing", false}};
    CHECK_EQ(mcp_build_table_query(x, columns).error, std::string("unknown_column"));
    x.order_by.clear();
    x.filters.assign(21, filter("id", "is_null"));
    CHECK_EQ(mcp_build_table_query(x, columns).error, std::string("invalid_argument"));
    x.filters.clear();
    x.filters = {filter("id", "in", std::vector<McpScalar>(101, I("1")), true)};
    CHECK_EQ(mcp_build_table_query(x, columns).error, std::string("invalid_argument"));
  }
  // Every column omitted: send them all rather than an empty SELECT.
  {
    McpTableQuery x;
    x.database = "d";
    x.table = "t";
    const auto b = mcp_build_table_query(x, {{"a", "String", 100000}});
    CHECK(b.ok && b.omitted.empty());
    CHECK_EQ(b.sql, std::string("SELECT `a` FROM `d`.`t` LIMIT 100"));
  }
}

// ---- protocol and tools with fakes ---------------------------------------------------------------------------

struct FakeBackend : McpToolBackend {
  std::vector<std::string> calls;
  bool throws = false;
  McpToolOutcome call_tool(const McpKey&, const std::string& tool, const rapidjson::Value& arguments, int64_t) override {
    if (throws) throw std::runtime_error("boom");
    calls.push_back(tool);
    McpToolOutcome o;
    o.host = "prod";
    o.rows = 3;
    if (tool == "list_hosts") {
      o.json = R"({"hosts":[]})";
    } else if (arguments.HasMember("fail")) {
      return mcp_tool_error("query_failed", "it failed");
    } else {
      o.json = R"({"ok":true})";
    }
    return o;
  }
};

McpKey a_key(std::vector<std::string> tools, std::vector<std::string> databases) {
  McpKey k;
  k.id = "k1";
  k.name = "k1";
  k.hosts = {"prod"};
  k.tools = std::move(tools);
  k.databases = std::move(databases);
  return k;
}

std::string rpc(const std::string& method, const std::string& params = "", const std::string& id = "1") {
  return "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"method\":\"" + method + "\"" + (params.empty() ? "" : ",\"params\":" + params) + "}";
}

void test_protocol() {
  FakeBackend backend;
  McpServerInfo info;
  info.version = "9.9";
  const McpKey all = a_key({"*"}, {"*"});
  const McpKey narrow = a_key({"*"}, {"otel"});
  const int64_t now = 1'800'000'000;

  // initialize negotiates the version.
  for (const char* v : {"2025-06-18", "2025-03-26", "2024-11-05"}) {
    const auto r = mcp_handle_message(rpc("initialize", std::string("{\"protocolVersion\":\"") + v + "\",\"capabilities\":{}}"), all, backend, info, now);
    CHECK_EQ(r.http_status, 200);
    const auto doc = parse(r.body);
    CHECK_EQ(std::string(doc["result"]["protocolVersion"].GetString()), std::string(v));
    CHECK(doc["result"]["capabilities"].HasMember("tools"));
    CHECK(!doc["result"]["capabilities"].HasMember("resources"));
    CHECK_EQ(std::string(doc["result"]["serverInfo"]["version"].GetString()), std::string("9.9"));
    CHECK_EQ(doc["id"].GetInt(), 1);
  }
  // initialize keeps who the client is, for the usage of the key (at most 256 bytes each); a client that says nothing is fine.
  {
    const auto r = mcp_handle_message(rpc("initialize", R"({"protocolVersion":"2025-06-18","clientInfo":{"name":"claude-code","version":"2.1.0"}})"), all, backend, info, now);
    CHECK_EQ(r.client_name, std::string("claude-code"));
    CHECK_EQ(r.client_version, std::string("2.1.0"));
    const auto quiet = mcp_handle_message(rpc("initialize", R"({"protocolVersion":"2025-06-18","clientInfo":{"name":5}})"), all, backend, info, now);
    CHECK_EQ(quiet.http_status, 200);
    CHECK_EQ(quiet.client_name, std::string(""));
    const auto big = mcp_handle_message(rpc("initialize", R"({"protocolVersion":"2025-06-18","clientInfo":{"name":")" + std::string(1000, 'x') + "\"}}"), all, backend, info, now);
    CHECK_EQ(big.client_name.size(), size_t(256));
    CHECK_EQ(mcp_handle_message(rpc("ping"), all, backend, info, now).client_name, std::string(""));
  }
  {
    const auto r = mcp_handle_message(rpc("initialize", R"({"protocolVersion":"1999-01-01"})"), all, backend, info, now);
    CHECK_EQ(std::string(parse(r.body)["result"]["protocolVersion"].GetString()), std::string("2025-06-18"));
    CHECK_EQ(parse(mcp_handle_message(rpc("initialize"), all, backend, info, now).body)["error"]["code"].GetInt(), kRpcInvalidParams);
    CHECK_EQ(parse(mcp_handle_message(rpc("initialize", "{}"), all, backend, info, now).body)["error"]["code"].GetInt(), kRpcInvalidParams);
  }

  // ping, and string ids are echoed.
  CHECK_EQ(std::string(parse(mcp_handle_message(rpc("ping", "", "\"abc\""), all, backend, info, now).body)["id"].GetString()), std::string("abc"));
  CHECK(parse(mcp_handle_message(rpc("ping"), all, backend, info, now).body)["result"].IsObject());

  // tools/list is filtered by the key.
  const auto names = [&](const McpKey& key) {
    std::vector<std::string> out;
    const auto doc = parse(mcp_handle_message(rpc("tools/list"), key, backend, info, now).body);
    for (const auto& t : doc["result"]["tools"].GetArray()) {
      CHECK(t["inputSchema"].IsObject());
      CHECK(t["description"].IsString());
      CHECK(t["annotations"]["readOnlyHint"].GetBool());
      out.push_back(t["name"].GetString());
    }
    return out;
  };
  CHECK_EQ(names(all).size(), mcp_tool_catalog().size());
  CHECK_EQ(names(narrow).size(), mcp_tool_catalog().size() - 2);  // every tool but the two SQL tools
  CHECK_EQ(names(a_key({"list_hosts"}, {"*"})).size(), size_t(1));
  CHECK_EQ(names(a_key({}, {"*"})).size(), size_t(0));
  for (const auto& n : names(narrow)) CHECK(n != "run_query" && n != "explain_query");

  // tools/call: a result with structuredContent that equals the text content.
  {
    const auto r = mcp_handle_message(rpc("tools/call", R"({"name":"list_hosts","arguments":{}})"), all, backend, info, now);
    CHECK(r.tool_called);
    CHECK_EQ(r.tool, std::string("list_hosts"));
    CHECK_EQ(r.outcome.rows, uint64_t(3));
    const auto doc = parse(r.body);
    CHECK(!doc["result"]["isError"].GetBool());
    CHECK_EQ(std::string(doc["result"]["content"][0]["type"].GetString()), std::string("text"));
    CHECK_EQ(std::string(doc["result"]["content"][0]["text"].GetString()), std::string(R"({"hosts":[]})"));
    CHECK(doc["result"]["structuredContent"]["hosts"].IsArray());
  }
  // structuredContent is the same JSON again: only for a client of 2025-06-18 or later, and for a request without the protocol header.
  // The text content is there for every client (ARCH-B-073).
  {
    const std::string call = rpc("tools/call", R"({"name":"list_hosts","arguments":{}})");
    for (const char* version : {"", "2025-06-18"}) {
      const auto doc = parse(mcp_handle_message(call, all, backend, info, now, version).body);
      CHECK(doc["result"].HasMember("structuredContent"));
      CHECK_EQ(std::string(doc["result"]["content"][0]["text"].GetString()), std::string(R"({"hosts":[]})"));
    }
    for (const char* version : {"2025-03-26", "2024-11-05"}) {
      const auto r = mcp_handle_message(call, all, backend, info, now, version);
      const auto doc = parse(r.body);
      CHECK(!doc["result"].HasMember("structuredContent"));
      CHECK(!doc["result"]["isError"].GetBool());
      CHECK_EQ(std::string(doc["result"]["content"][0]["text"].GetString()), std::string(R"({"hosts":[]})"));
      CHECK_EQ(r.outcome.rows, uint64_t(3));
      CHECK_EQ(std::string(doc["jsonrpc"].GetString()), std::string("2.0"));
      CHECK_EQ(doc["id"].GetInt(), 1);
    }
    // A failure keeps its code and message in the text for the older protocol too.
    const auto failed = parse(mcp_handle_message(rpc("tools/call", R"({"name":"query_table","arguments":{"fail":1}})"), all, backend, info, now, "2024-11-05").body);
    CHECK(failed["result"]["isError"].GetBool());
    CHECK(!failed["result"].HasMember("structuredContent"));
    CHECK_EQ(std::string(parse(failed["result"]["content"][0]["text"].GetString())["error"].GetString()), std::string("query_failed"));
  }
  // A tool failure is a result with isError, not a JSON-RPC error.
  {
    const auto r = mcp_handle_message(rpc("tools/call", R"({"name":"query_table","arguments":{"fail":1}})"), all, backend, info, now);
    const auto doc = parse(r.body);
    CHECK(!doc.HasMember("error"));
    CHECK(doc["result"]["isError"].GetBool());
    CHECK_EQ(std::string(doc["result"]["structuredContent"]["error"].GetString()), std::string("query_failed"));
    const auto text = parse(doc["result"]["content"][0]["text"].GetString());
    CHECK_EQ(std::string(text["message"].GetString()), std::string("it failed"));
    CHECK_EQ(r.outcome.error_code, std::string("query_failed"));
  }
  // A tool the key does not hold never reaches the backend.
  {
    backend.calls.clear();
    const auto r = mcp_handle_message(rpc("tools/call", R"({"name":"run_query","arguments":{"sql":"SELECT 1"}})"), narrow, backend, info, now);
    const auto doc = parse(r.body);
    CHECK(doc["result"]["isError"].GetBool());
    CHECK_EQ(std::string(doc["result"]["structuredContent"]["error"].GetString()), std::string("tool_not_allowed"));
    CHECK(backend.calls.empty());
    // Not even run_query named explicitly, with a restricted scope.
    const McpKey sneaky = a_key({"run_query", "query_table"}, {"otel"});
    CHECK(parse(mcp_handle_message(rpc("tools/call", R"({"name":"run_query","arguments":{}})"), sneaky, backend, info, now).body)["result"]["isError"].GetBool());
    CHECK(backend.calls.empty());
  }
  // Unknown tool, bad params.
  CHECK_EQ(parse(mcp_handle_message(rpc("tools/call", R"({"name":"nope"})"), all, backend, info, now).body)["error"]["code"].GetInt(), kRpcInvalidParams);
  CHECK_EQ(parse(mcp_handle_message(rpc("tools/call", "{}"), all, backend, info, now).body)["error"]["code"].GetInt(), kRpcInvalidParams);
  CHECK_EQ(parse(mcp_handle_message(rpc("tools/call", R"({"name":"list_hosts","arguments":[]})"), all, backend, info, now).body)["error"]["code"].GetInt(), kRpcInvalidParams);
  CHECK_EQ(parse(mcp_handle_message(rpc("tools/call", "[1]"), all, backend, info, now).body)["error"]["code"].GetInt(), kRpcInvalidParams);
  // arguments may be absent.
  CHECK(parse(mcp_handle_message(rpc("tools/call", R"({"name":"list_hosts"})"), all, backend, info, now).body)["result"].IsObject());
  // A throwing backend becomes internal_error, without its message.
  backend.throws = true;
  {
    const auto r = mcp_handle_message(rpc("tools/call", R"({"name":"list_hosts"})"), all, backend, info, now);
    CHECK(!contains(r.body, "boom"));
    CHECK_EQ(r.outcome.error_code, std::string("internal_error"));
  }
  backend.throws = false;

  // Unknown methods: -32601.
  for (const char* m : {"resources/list", "prompts/list", "logging/setLevel", "tools/delete", "completion/complete"}) {
    const auto r = mcp_handle_message(rpc(m), all, backend, info, now);
    CHECK_EQ(r.http_status, 200);
    CHECK_EQ(parse(r.body)["error"]["code"].GetInt(), kRpcMethodNotFound);
  }

  // Notifications and client responses: 202 and no body.
  for (const char* body : {R"({"jsonrpc":"2.0","method":"notifications/initialized"})",
                           R"({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}})",
                           R"({"jsonrpc":"2.0","id":5,"result":{}})", R"({"jsonrpc":"2.0","id":5,"error":{"code":1,"message":"x"}})"}) {
    const auto r = mcp_handle_message(body, all, backend, info, now);
    CHECK_EQ(r.http_status, 202);
    CHECK(r.body.empty());
  }

  // Malformed messages.
  CHECK_EQ(mcp_handle_message("not json", all, backend, info, now).http_status, 400);
  CHECK_EQ(parse(mcp_handle_message("not json", all, backend, info, now).body)["error"]["code"].GetInt(), kRpcParseError);
  CHECK_EQ(parse(mcp_handle_message("[]", all, backend, info, now).body)["error"]["code"].GetInt(), kRpcInvalidRequest);
  // No batching (2025-06-18).
  {
    const auto r = mcp_handle_message("[" + rpc("ping") + "," + rpc("ping", "", "2") + "]", all, backend, info, now);
    CHECK_EQ(r.http_status, 400);
    CHECK_EQ(parse(r.body)["error"]["code"].GetInt(), kRpcInvalidRequest);
    CHECK(contains(r.body, "batch"));
  }
  CHECK_EQ(mcp_handle_message("3", all, backend, info, now).http_status, 400);
  CHECK_EQ(mcp_handle_message(R"({"id":1,"method":"ping"})", all, backend, info, now).http_status, 400);
  CHECK_EQ(mcp_handle_message(R"({"jsonrpc":"1.0","id":1,"method":"ping"})", all, backend, info, now).http_status, 400);
  CHECK_EQ(mcp_handle_message(R"({"jsonrpc":"2.0","id":1})", all, backend, info, now).http_status, 400);
  CHECK_EQ(mcp_handle_message(R"({"jsonrpc":"2.0","id":1,"method":5})", all, backend, info, now).http_status, 400);
  CHECK_EQ(mcp_handle_message(R"({"jsonrpc":"2.0","id":{"a":1},"method":"ping"})", all, backend, info, now).http_status, 400);
  CHECK_EQ(mcp_handle_message(R"({"jsonrpc":"2.0","id":1.5,"method":"ping"})", all, backend, info, now).http_status, 400);
  CHECK_EQ(parse(mcp_handle_message(R"({"jsonrpc":"2.0","id":1,"method":"ping","params":5})", all, backend, info, now).body)["error"]["code"].GetInt(), kRpcInvalidParams);

  // The result names the method of the message, also when it fails: the audit line and the usage show it. A message that could
  // not be read has none.
  {
    const auto method_of = [&](const std::string& body) { return mcp_handle_message(body, all, backend, info, now).method; };
    CHECK_EQ(method_of(rpc("ping")), std::string("ping"));
    CHECK_EQ(method_of(rpc("initialize", R"({"protocolVersion":"2025-06-18"})")), std::string("initialize"));
    CHECK_EQ(method_of(rpc("tools/list")), std::string("tools/list"));
    CHECK_EQ(method_of(rpc("tools/call", R"({"name":"list_hosts"})")), std::string("tools/call"));
    CHECK_EQ(method_of(R"({"jsonrpc":"2.0","method":"notifications/initialized"})"), std::string("notifications/initialized"));
    CHECK_EQ(method_of(R"({"jsonrpc":"2.0","id":5,"result":{}})"), std::string("response"));
    // A JSON-RPC error of a message that was read: the method that failed.
    CHECK_EQ(method_of(rpc("resources/list")), std::string("resources/list"));
    CHECK_EQ(method_of(rpc("nope/nothing")), std::string("nope/nothing"));
    CHECK_EQ(method_of(rpc("initialize")), std::string("initialize"));
    CHECK_EQ(method_of(rpc("initialize", "{}")), std::string("initialize"));
    CHECK_EQ(method_of(rpc("tools/call", "{}")), std::string("tools/call"));
    CHECK_EQ(method_of(rpc("tools/call", R"({"name":"nope"})")), std::string("tools/call"));
    CHECK_EQ(method_of(rpc("tools/call", R"({"name":"list_hosts","arguments":[]})")), std::string("tools/call"));
    CHECK_EQ(method_of(R"({"jsonrpc":"2.0","id":1,"method":"ping","params":5})"), std::string("ping"));
    {
      const auto r = mcp_handle_message(R"({"jsonrpc":"2.0","id":{"a":1},"method":"ping"})", all, backend, info, now);
      CHECK_EQ(r.http_status, 400);
      CHECK_EQ(r.rpc_error, kRpcInvalidRequest);
      CHECK_EQ(r.method, std::string("ping"));
      CHECK(!r.tool_called);
    }
    {
      const auto r = mcp_handle_message(rpc("tools/call", R"({"name":"nope"})"), all, backend, info, now);
      CHECK_EQ(r.rpc_error, kRpcInvalidParams);
      CHECK(!r.tool_called);  // it failed before a tool
    }
    // No method: not JSON, a batch, not an object, no "jsonrpc": "2.0", no method, a method that is not text.
    const std::vector<std::string> unread = {"not json", "[]", "[" + rpc("ping") + "]", "3", R"({"id":1,"method":"ping"})",
                                             R"({"jsonrpc":"1.0","id":1,"method":"ping"})", R"({"jsonrpc":"2.0","id":1})",
                                             R"({"jsonrpc":"2.0","id":1,"method":5})"};
    for (const auto& body : unread) {
      const auto r = mcp_handle_message(body, all, backend, info, now);
      CHECK(r.method.empty());
      CHECK(r.rpc_error != 0);
    }
    // The client chooses the method, and a notification takes any: at most 128 bytes (the answer of the error keeps the whole name).
    const std::string long_name(300, 'x');
    const auto cut = mcp_handle_message(rpc(long_name), all, backend, info, now);
    CHECK_EQ(cut.rpc_error, kRpcMethodNotFound);
    CHECK_EQ(cut.method, std::string(128, 'x'));
    CHECK(contains(cut.body, long_name));
    const auto note = mcp_handle_message("{\"jsonrpc\":\"2.0\",\"method\":\"" + long_name + "\"}", all, backend, info, now);
    CHECK_EQ(note.http_status, 202);
    CHECK_EQ(note.method, std::string(128, 'x'));
    CHECK_EQ(method_of(rpc(std::string(128, 'y'))), std::string(128, 'y'));
    CHECK_EQ(method_of(rpc(std::string(129, 'y'))), std::string(128, 'y'));
  }
}

struct FakeDb : McpDatabase {
  struct Call {
    std::string host;
    std::string sql;
    McpDbLimits limits;
  };
  std::vector<Call> calls;
  // The first rule whose substring is in the SQL answers.
  std::vector<std::pair<std::string, McpDbResult>> rules;
  std::string fail_code;
  std::optional<bool> health;

  McpDbResult run(const std::string& host, const std::string& sql, const McpDbLimits& limits) override {
    calls.push_back({host, sql, limits});
    if (!fail_code.empty()) throw McpDbError(fail_code, "DB::Exception: failed");
    for (const auto& rule : rules) {
      if (contains(sql, rule.first)) return rule.second;
    }
    return {};
  }
  std::optional<bool> host_healthy(const std::string&) override { return health; }
};

McpDbResult table_of(std::vector<std::string> names, std::vector<std::vector<std::string>> rows, bool truncated = false) {
  McpDbResult r;
  for (const auto& n : names) r.columns.push_back({n, "String"});
  r.rows = std::move(rows);
  r.truncated = truncated;
  r.elapsed_ms = 4;
  return r;
}

McpToolsConfig tools_config() {
  McpToolsConfig c;
  c.hosts = {{"prod", "Production"}, {"stage", "Staging"}};
  c.max_rows = 1000;
  c.max_result_bytes = 1048576;
  c.query_timeout_seconds = 30;
  c.max_sql_bytes = 200;
  c.max_memory_bytes = 1000000000;
  c.max_rows_to_read = 5000000;
  c.observability.traces = true;
  c.observability.traces_index_table = "otel_traces_trace_id_ts";
  c.observability.logs = true;
  c.observability.metrics = true;
  return c;
}

rapidjson::Document call(McpTools& tools, const McpKey& key, const std::string& tool, const std::string& args, McpToolOutcome* out = nullptr) {
  rapidjson::Document a;
  a.Parse(args.c_str());
  if (a.HasParseError()) {
    std::cerr << "bad args " << args << std::endl;
    std::exit(2);
  }
  const McpToolOutcome o = tools.call_tool(key, tool, a, 0);
  if (out) *out = o;
  return parse(o.json);
}

// The API tools: one wrapper for every row of mcp_api_tools.cpp.
struct FakeApi : McpApiClient {
  std::vector<McpApiRequest> calls;
  McpApiResponse answer;
  McpApiResponse call(const McpApiRequest& request) override {
    calls.push_back(request);
    return answer;
  }
};

std::string query_of(const McpApiRequest& request) {
  std::string out;
  for (const auto& [name, value] : request.query) out += (out.empty() ? "" : "&") + name + "=" + value;
  return out;
}

void test_api_tools() {
  // The table is the registry: every row is a tool of the catalog, in a group of the page, with a route.
  {
    std::set<std::string> names;
    std::set<std::string> groups;
    for (const auto& group : mcp_tool_groups()) CHECK(groups.insert(group.id).second);
    size_t api = 0;
    for (const auto& tool : mcp_tool_catalog()) {
      CHECK(names.insert(tool.name).second);
      CHECK(groups.count(tool.group) == 1);
      if (!tool.api) continue;
      ++api;
      CHECK(!tool.needs_all_data);  // no API tool needs the scope "*"
      CHECK(std::string(tool.api->path).rfind("/api/", 0) == 0);
      CHECK(std::string(tool.api->method) == "GET" || std::string(tool.api->method) == "POST");
      CHECK(std::string(tool.description).size() > 20);
    }
    CHECK_EQ(api, mcp_api_tools().size());
    CHECK(api >= 40);
    // The groups of the families that the API has.
    for (const char* id : {"data", "explorer", "system", "observability", "query", "sql"}) CHECK(groups.count(id) == 1);
    CHECK_EQ(groups.size(), size_t(6));
    // A family has at least two tools (no card is a lone check box), and a section belongs to a family that lists it.
    std::map<std::string, int> per_group;
    for (const auto& tool : mcp_tool_catalog()) {
      ++per_group[tool.group];
      if (!tool.section) continue;
      bool known = false;
      for (const auto& section : mcp_tool_sections()) known = known || (std::string(section.group) == tool.group && std::string(section.id) == tool.section);
      CHECK(known);
    }
    for (const auto& group : mcp_tool_groups()) CHECK(per_group[group.id] >= 2);
    // Observability holds the pages' tools and the simple tools of a signal, in the section of that signal.
    for (const char* name : {"traces_search", "search_traces", "get_trace"}) CHECK_EQ(std::string(mcp_find_tool(name)->section), std::string("traces"));
    for (const char* name : {"logs_search", "search_logs"}) CHECK_EQ(std::string(mcp_find_tool(name)->section), std::string("logs"));
    for (const char* name : {"metrics_series", "list_metrics", "query_metric"}) CHECK_EQ(std::string(mcp_find_tool(name)->section), std::string("metrics"));
    CHECK(mcp_find_tool("list_tables")->section == nullptr && mcp_find_tool("explorer_table")->section == nullptr);
    CHECK_EQ(std::string(mcp_find_tool("query_library")->group), std::string("query"));
    CHECK_EQ(std::string(mcp_find_tool("query_execution")->group), std::string("query"));
    CHECK_EQ(mcp_tool_reads(*mcp_find_tool("list_services")), unsigned(kMcpReadsNone));
  }

  FakeDb db;
  FakeApi api;
  McpTools tools(tools_config(), db, &api);
  McpKey all = a_key({"*"}, {"*"});
  all.hosts = {"prod"};
  api.answer.status = 200;
  api.answer.body = R"({"version":3,"databases":["otel"]})";

  // A GET: the params become the query string, the host is added, the answer comes back as it is.
  {
    McpToolOutcome o;
    auto doc = call(tools, all, "explorer_catalog", R"({"params":{"database":"otel","refresh":1}})", &o);
    CHECK(!o.is_error);
    CHECK_EQ(doc["version"].GetInt(), 3);
    CHECK_EQ(api.calls.size(), size_t(1));
    CHECK_EQ(api.calls[0].method, std::string("GET"));
    CHECK_EQ(api.calls[0].path, std::string("/api/explorer/catalog"));
    CHECK_EQ(query_of(api.calls[0]), std::string("database=otel&refresh=1&host_id=prod\x1f" "mcp"));
    CHECK(db.calls.empty());  // no SQL of the MCP user: the route has its own
    CHECK_EQ(api.calls[0].tool, std::string("explorer_catalog"));  // the statements of the route are named for the key and the tool
    CHECK_EQ(api.calls[0].key_id, all.id);
    CHECK_EQ(api.calls[0].timeout_seconds, int64_t(30));
    CHECK_EQ(api.calls[0].max_bytes, int64_t(1048576));
    // A list repeats the parameter; a boolean and a number are text.
    call(tools, all, "traces_search", R"({"params":{"service":["a","b"],"status":"Error","tag":["k=v"],"limit":5,"align_buckets":true,"min_duration_ms":2.5}})");
    CHECK_EQ(query_of(api.calls[1]), std::string("service=a&service=b&status=Error&tag=k=v&limit=5&align_buckets=true&min_duration_ms=2.5&host_id=prod\x1f" "mcp"));
    // No params at all is fine.
    call(tools, all, "system_overview", "{}");
    CHECK_EQ(query_of(api.calls[2]), std::string("host_id=prod\x1f" "mcp"));
  }

  // A {name} of the path is a param, in the address and not in the query string; it must be plain.
  {
    api.calls.clear();
    auto doc = call(tools, all, "system_query", R"({"params":{"hash":"1a2b-3c","order":"duration"}})");
    CHECK_EQ(api.calls[0].path, std::string("/api/system/queries/1a2b-3c"));
    CHECK_EQ(query_of(api.calls[0]), std::string("order=duration&host_id=prod\x1f" "mcp"));
    CHECK_EQ(std::string(call(tools, all, "system_query", "{}")["error"].GetString()), std::string("invalid_argument"));
    CHECK(contains(call(tools, all, "system_query", "{}")["message"].GetString(), "params.hash is required"));
    for (const char* bad : {"../x", "a/b", "a b", "", "%2e"}) {
      CHECK_EQ(std::string(call(tools, all, "system_query", std::string("{\"params\":{\"hash\":\"") + bad + "\"}}")["error"].GetString()), std::string("invalid_argument"));
    }
    CHECK_EQ(api.calls.size(), size_t(1));
  }

  // A POST: the body goes as JSON, with the host added.
  {
    api.calls.clear();
    call(tools, all, "explorer_table_data", R"({"body":{"database":"otel","table":"otel_logs","limit":3}})");
    CHECK_EQ(api.calls[0].method, std::string("POST"));
    CHECK_EQ(api.calls[0].path, std::string("/api/explorer/table/data"));
    const auto sent = parse(api.calls[0].body);
    CHECK_EQ(std::string(sent["host_id"].GetString()), std::string("prod\x1f" "mcp"));
    CHECK_EQ(std::string(sent["table"].GetString()), std::string("otel_logs"));
    CHECK_EQ(sent["limit"].GetInt(), 3);
    CHECK(api.calls[0].query.empty());
    // The client cannot name another host in the body: the host argument decides.
    call(tools, all, "explorer_table_data", R"({"body":{"host_id":"other","database":"d","table":"t"}})");
    CHECK_EQ(std::string(parse(api.calls[1].body)["host_id"].GetString()), std::string("prod\x1f" "mcp"));
    CHECK_EQ(std::string(call(tools, all, "explorer_table_data", R"({"body":[1]})")["error"].GetString()), std::string("invalid_argument"));
    // A GET tool has no body, a POST tool no params.
    CHECK_EQ(std::string(call(tools, all, "explorer_catalog", R"({"body":{}})")["error"].GetString()), std::string("invalid_argument"));
    CHECK_EQ(std::string(call(tools, all, "explorer_table_data", R"({"params":{}})")["error"].GetString()), std::string("invalid_argument"));
    // The Explorer follows the patterns of the key, on top of what the MCP user may read.
    {
      McpKey narrow = a_key({"*"}, {"otel.otel_logs", "chdash_ui", "metrics.cpu*"});
      narrow.hosts = {"prod"};
      api.calls.clear();
      // A table that a pattern allows goes through; one that none allows never reaches the API.
      call(tools, narrow, "explorer_table", R"({"params":{"database":"otel","table":"otel_logs"}})");
      call(tools, narrow, "explorer_table", R"({"params":{"database":"chdash_ui","table":"anything"}})");
      call(tools, narrow, "explorer_table_data", R"({"body":{"database":"metrics","table":"cpu_load"}})");
      CHECK_EQ(api.calls.size(), size_t(3));
      for (const char* arguments : {R"({"params":{"database":"otel","table":"otel_traces"}})", R"({"params":{"database":"system","table":"query_log"}})"}) {
        CHECK_EQ(std::string(call(tools, narrow, "explorer_table", arguments)["error"].GetString()), std::string("table_not_allowed"));
      }
      CHECK_EQ(std::string(call(tools, narrow, "explorer_table_data", R"({"body":{"database":"otel","table":"otel_traces"}})")["error"].GetString()), std::string("table_not_allowed"));
      CHECK_EQ(std::string(call(tools, narrow, "explorer_graph_definition", R"({"params":{"database":"system","table":"tables"}})")["error"].GetString()), std::string("table_not_allowed"));
      // A name that is not one plain string is never let through (the API could read another value than the one checked).
      for (const char* arguments : {R"({"params":{"database":["otel","system"],"table":"otel_logs"}})", R"({"params":{"database":"otel"}})", R"({"params":{"table":"otel_logs"}})", R"({"params":{"database":"otel","table":""}})", "{}"}) {
        CHECK_EQ(std::string(call(tools, narrow, "explorer_table", arguments)["error"].GetString()), std::string("invalid_argument"));
      }
      CHECK_EQ(api.calls.size(), size_t(3));
      // The catalog: a database that no pattern names is refused; the answer is cut to the patterns.
      CHECK_EQ(std::string(call(tools, narrow, "explorer_catalog", R"({"params":{"database":"system"}})")["error"].GetString()), std::string("database_not_allowed"));
      api.answer.body = R"({"version":3,"database":"","databases":["chdash_ui","metrics","otel","system"],)"
                        R"("database_summaries":[{"name":"chdash_ui","tables":9},{"name":"metrics","tables":3},{"name":"otel","tables":5},{"name":"system","tables":99}],)"
                        R"("tables":[{"database":"otel","name":"otel_logs"},{"database":"otel","name":"otel_traces"},{"database":"metrics","name":"cpu_load"},{"database":"metrics","name":"mem"},{"database":"system","name":"tables"},{"database":"chdash_ui","name":"t"}],"disks":[{"name":"default"}]})";
      const auto cut = call(tools, narrow, "explorer_catalog", "{}");
      std::vector<std::string> databases;
      for (const auto& d : cut["databases"].GetArray()) databases.push_back(d.GetString());
      CHECK(databases == (std::vector<std::string>{"chdash_ui", "metrics", "otel"}));
      // Only a database that the key reads whole keeps its summary: the others count tables that the key does not read.
      CHECK_EQ(cut["database_summaries"].Size(), 1u);
      CHECK_EQ(std::string(cut["database_summaries"][0]["name"].GetString()), std::string("chdash_ui"));
      std::vector<std::string> tables;
      for (const auto& t : cut["tables"].GetArray()) tables.push_back(std::string(t["database"].GetString()) + "." + t["name"].GetString());
      CHECK(tables == (std::vector<std::string>{"otel.otel_logs", "metrics.cpu_load", "chdash_ui.t"}));
      CHECK_EQ(cut["disks"].Size(), 1u);
      // A key with all the data gets the answer as it is.
      CHECK_EQ(call(tools, all, "explorer_catalog", "{}")["tables"].Size(), 6u);
      // The tools that read no data answer any key (the ones about the server are refused by the scope of the key,
      // in the list and in the call: see above).
      call(tools, narrow, "explorer_functions", "{}");
      call(tools, narrow, "format_sql", R"({"body":{"sqls":["select 1"]}})");
      // System, Traces, Logs and Metrics are read with the system user, as the pages do: the patterns of the key cut
      // nothing there, the permission is what gives the tool (this key allows only otel.otel_logs).
      const size_t before = api.calls.size();
      for (const char* name : {"system_overview", "logs_meta", "traces_search", "metrics_series"}) call(tools, narrow, name, "{}");
      CHECK_EQ(api.calls.size(), before + 4);
      api.answer.body = R"({"version":3,"databases":["otel"]})";
    }
    // A key without a host reads nothing, the Query helpers included: they read the version of a host.
    McpKey nohost = a_key({"*"}, {"*"});
    nohost.hosts = {};
    api.calls.clear();
    CHECK_EQ(std::string(call(tools, nohost, "format_sql", R"({"body":{"sql":"select 1"}})")["error"].GetString()), std::string("no_host"));
    CHECK_EQ(std::string(call(tools, nohost, "explorer_catalog", "{}")["error"].GetString()), std::string("no_host"));
    CHECK(api.calls.empty());
    // format_sql: a POST whose body keeps `sql` and gains the host.
    call(tools, all, "format_sql", R"({"body":{"sql":"select 1"}})");
    CHECK(parse(api.calls[0].body).HasMember("sql"));
    CHECK_EQ(std::string(parse(api.calls[0].body)["host_id"].GetString()), std::string("prod\x1f" "mcp"));
    api.answer.body = R"({"version":3,"databases":["otel"]})";
  }

  // The host comes from the key, as for every tool.
  {
    api.calls.clear();
    McpKey two = a_key({"*"}, {"*"});
    two.hosts = {"prod", "stage"};
    CHECK_EQ(std::string(call(tools, two, "system_overview", "{}")["error"].GetString()), std::string("host_required"));
    CHECK_EQ(std::string(call(tools, two, "system_overview", R"({"host":"nope"})")["error"].GetString()), std::string("host_not_allowed"));
    call(tools, two, "system_overview", R"({"host":"stage"})");
    CHECK_EQ(query_of(api.calls[0]), std::string("host_id=stage\x1f" "mcp"));
    CHECK_EQ(api.calls.size(), size_t(1));
    // The host is not a param.
    CHECK_EQ(std::string(call(tools, all, "system_overview", R"({"params":{"host_id":"stage"}})")["error"].GetString()), std::string("invalid_argument"));
  }

  // The identity of a tool is the one of its family (mcp_identity.hpp), and the answer shows the host as the client named it.
  {
    api.calls.clear();
    api.answer.body = R"({"version":1,"host_id":"prod\u001fmcp","source_host_id":"prod\u001Fmcp"})";
    // One identity for every tool that reads ClickHouse: the MCP user as runner, the system user as for the pages
    // (the OpenTelemetry tables, the System page).
    for (const char* name : {"explorer_catalog", "explorer_table", "system_overview", "system_queries", "traces_meta", "traces_search", "logs_meta", "logs_search", "metrics_meta", "metrics_series"}) {
      call(tools, all, name, "{}");
      CHECK(contains(query_of(api.calls.back()) + api.calls.back().body, "prod\x1f" "mcp"));
    }
    // The query library asks no ClickHouse user: the host as it is.
    call(tools, all, "query_library", "{}");
    CHECK_EQ(query_of(api.calls.back()), std::string("host_id=prod"));
    auto doc = call(tools, all, "system_overview", "{}");
    CHECK_EQ(std::string(doc["host_id"].GetString()), std::string("prod"));
    CHECK_EQ(std::string(doc["source_host_id"].GetString()), std::string("prod"));
    CHECK_EQ(mcp_strip_identity("a\x1fmcp b\x1fmcp \\u001fmcp \\u001Fmcp"), std::string("a b  "));
    api.answer.body = R"({"version":3,"databases":["otel"]})";
  }

  // The arguments are checked before anything is sent.
  {
    api.calls.clear();
    for (const char* bad : {R"({"nope":1})", R"({"params":"x"})", R"({"params":{"a b":1}})", R"({"params":{"a":{"b":1}}})", R"({"params":{"a":[[1]]}})",
                            R"({"params":{"a":null}})"}) {
      CHECK_EQ(std::string(call(tools, all, "traces_search", bad)["error"].GetString()), std::string("invalid_argument"));
    }
    CHECK(api.calls.empty());
    // A value that is too long, a list that is too long.
    CHECK_EQ(std::string(call(tools, all, "traces_search", "{\"params\":{\"q\":\"" + std::string(9000, 'x') + "\"}}")["error"].GetString()), std::string("invalid_argument"));
    std::string many = "{\"params\":{\"service\":[";
    for (int i = 0; i < 65; ++i) many += std::string(i ? "," : "") + "\"s\"";
    CHECK_EQ(std::string(call(tools, all, "traces_search", many + "]}}")["error"].GetString()), std::string("invalid_argument"));
    CHECK(api.calls.empty());
  }

  // The answers of the API: an error keeps its code and message, an absent route is `not_enabled`, a list goes under `result`.
  {
    McpToolOutcome o;
    api.answer = {400, R"({"error_code":"invalid_metrics_range","message":"start_ms and end_ms (milliseconds) are required."})", false, ""};
    auto doc = call(tools, all, "metrics_catalog", "{}", &o);
    CHECK(o.is_error);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("invalid_metrics_range"));
    CHECK(contains(doc["message"].GetString(), "start_ms and end_ms"));
    api.answer = {404, R"({"error_code":"unknown_host","message":"Logs source host is not configured."})", false, ""};
    CHECK_EQ(std::string(call(tools, all, "logs_search", "{}")["error"].GetString()), std::string("unknown_host"));
    api.answer = {404, "", false, ""};
    doc = call(tools, all, "query_library", "{}");
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("not_enabled"));
    CHECK(contains(doc["message"].GetString(), "query_library"));
    api.answer = {500, "boom", false, ""};
    CHECK_EQ(std::string(call(tools, all, "system_disks", "{}")["error"].GetString()), std::string("api_error"));
    api.answer = {0, "", false, "the API of ChDash did not answer: Connection"};
    doc = call(tools, all, "system_disks", "{}");
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("api_unavailable"));
    api.answer = {200, "", true, ""};
    CHECK_EQ(std::string(call(tools, all, "system_disks", "{}")["error"].GetString()), std::string("result_too_large"));
    api.answer = {200, R"([1,2,3])", false, ""};
    doc = call(tools, all, "system_disks", "{}");
    CHECK_EQ(doc["result"].Size(), 3u);
    api.answer = {200, "not json", false, ""};
    CHECK_EQ(std::string(call(tools, all, "system_disks", "{}")["error"].GetString()), std::string("api_error"));
    // Without a client, the tool says so.
    McpTools alone(tools_config(), db);
    CHECK_EQ(std::string(call(alone, all, "system_disks", "{}")["error"].GetString()), std::string("api_unavailable"));
  }

  // The scope of the key: API tools need all the data, in the list and in the call.
  {
    FakeDb quiet;
    McpToolBackend& backend = tools;
    McpServerInfo info;
    const McpKey narrow = a_key({"*"}, {"otel"});
    const auto listed = [&](const McpKey& key) {
      std::set<std::string> out;
      const auto doc = parse(mcp_handle_message(rpc("tools/list"), key, backend, info, 0).body);
      for (const auto& t : doc["result"]["tools"].GetArray()) out.insert(t["name"].GetString());
      return out;
    };
    CHECK(listed(narrow).count("search_traces") == 1 && listed(narrow).count("explorer_catalog") == 1 && listed(narrow).count("traces_search") == 1);
    CHECK(listed(narrow).count("explorer_table") == 1 && listed(narrow).count("explorer_functions") == 1 && listed(narrow).count("format_sql") == 1);
    CHECK(listed(narrow).count("system_overview") == 1 && listed(narrow).count("logs_search") == 1);
    CHECK(listed(narrow).count("explorer_graph") == 1 && listed(narrow).count("explorer_storage") == 1 && listed(narrow).count("explorer_names") == 1);
    CHECK(listed(narrow).count("run_query") == 0 && listed(narrow).count("explain_query") == 0);
    CHECK(listed(all).count("explorer_catalog") == 1 && listed(all).count("traces_search") == 1);
    const auto refused = parse(mcp_handle_message(rpc("tools/call", R"({"name":"run_query","arguments":{"sql":"select 1"}})"), narrow, backend, info, 0).body);
    CHECK(refused["result"]["isError"].GetBool());
    CHECK_EQ(std::string(refused["result"]["structuredContent"]["error"].GetString()), std::string("tool_not_allowed"));
    // The schema comes from the row: a GET has params, a POST a body.
    const auto doc = parse(mcp_handle_message(rpc("tools/list"), all, backend, info, 0).body);
    for (const auto& t : doc["result"]["tools"].GetArray()) {
      const std::string name = t["name"].GetString();
      const auto& props = t["inputSchema"]["properties"];
      if (name == "explorer_catalog") CHECK(props.HasMember("host") && props.HasMember("params") && !props.HasMember("body"));
      if (name == "explorer_table_data") CHECK(props.HasMember("host") && props.HasMember("body") && !props.HasMember("params"));
      if (name == "format_sql") CHECK(props.HasMember("host") && props.HasMember("body"));
      CHECK(!t["inputSchema"]["additionalProperties"].GetBool());
    }
  }
}

// The observability tools: the SQL they write, their guard rails and their answers.
void test_observability() {
  FakeDb db;
  McpTools tools(tools_config(), db);
  McpKey all = a_key({"*"}, {"*"});
  McpKey narrow = a_key({"*"}, {"otel"});
  narrow.max_rows = 5;
  const auto id = [](const rapidjson::Document& doc) { return std::string(doc["error"].GetString()); };
  const std::string traces = "`otel`.`otel_traces`";

  // list_services: spans and errors for each service, in the window, never above the row cap of the key.
  {
    db.rules = {{"countIf(StatusCode = 'Error')", table_of({"s", "n", "e", "a"}, {{"\"checkout\"", "120", "3", "12.5"}, {"\"cart\"", "40", "0", "3.25"}})}};
    auto doc = call(tools, narrow, "list_services", "{}");
    CHECK_EQ(doc["services"].Size(), 2u);
    CHECK_EQ(std::string(doc["services"][0]["service"].GetString()), std::string("checkout"));
    CHECK_EQ(doc["services"][0]["spans"].GetInt(), 120);
    CHECK_EQ(doc["services"][0]["errors"].GetInt(), 3);
    CHECK(!doc["truncated"].GetBool());
    CHECK(contains(db.calls.back().sql, "FROM " + traces));
    CHECK(contains(db.calls.back().sql, "Timestamp >= now() - INTERVAL 60 MINUTE"));
    CHECK(contains(db.calls.back().sql, "LIMIT 6"));  // the key's 5 rows, and one more to know that rows were cut
    CHECK_EQ(db.calls.back().limits.max_rows, int64_t(5));
    // The statement is named for its key and its tool (its query_id, mcp_cost.hpp).
    CHECK_EQ(db.calls.back().limits.tool, std::string("list_services"));
    CHECK_EQ(db.calls.back().limits.key_id, narrow.id);
    doc = call(tools, all, "list_services", R"({"signal":"logs","since_minutes":15})");
    CHECK(contains(db.calls.back().sql, "`otel`.`otel_logs`") && contains(db.calls.back().sql, "INTERVAL 15 MINUTE"));
    CHECK_EQ(std::string(call(tools, all, "list_services", R"({"signal":"metrics"})")["error"].GetString()), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "list_services", R"({"since_minutes":0})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "list_services", R"({"since_minutes":99999999})")), std::string("invalid_argument"));
  }

  // search_traces: root spans, the filters in the SQL as quoted text, the order, the cut of the rows.
  {
    db.calls.clear();
    db.rules = {{"ParentSpanId = ''", table_of({"t", "s", "o", "st", "d", "c"},
        {{"\"0af7651916cd43dd8448eb211c80319c\"", "\"checkout\"", "\"POST /pay\"", "\"2026-10-08 10:00:00.000000000\"", "812.5", "\"Error\""},
         {"\"1111111111111111aaaaaaaaaaaaaaaa\"", "\"checkout\"", "\"GET /cart\"", "\"2026-10-08 09:59:00.000000000\"", "10", "\"Ok\""}})}};
    auto doc = call(tools, all, "search_traces",
                    R"({"service":"check'out","operation":"pay","status":"Error","min_duration_ms":250,"order":"slowest","since_minutes":30,"limit":1})");
    CHECK_EQ(doc["count"].GetInt(), 1);
    CHECK(doc["truncated"].GetBool());  // two rows came back for a limit of one
    CHECK_EQ(std::string(doc["traces"][0]["trace_id"].GetString()), std::string("0af7651916cd43dd8448eb211c80319c"));
    CHECK_EQ(std::string(doc["traces"][0]["status"].GetString()), std::string("Error"));
    CHECK_EQ(doc["traces"][0]["duration_ms"].GetDouble(), 812.5);
    const std::string& sql = db.calls.back().sql;
    CHECK(contains(sql, "FROM " + traces));
    CHECK(contains(sql, "INTERVAL 30 MINUTE") && contains(sql, "ParentSpanId = ''"));
    CHECK(contains(sql, "ServiceName = 'check\\'out'"));  // quoted, never concatenated
    CHECK(contains(sql, "positionCaseInsensitive(SpanName, 'pay') > 0"));
    CHECK(contains(sql, "StatusCode = 'Error'") && contains(sql, "Duration >= 250000000"));
    CHECK(contains(sql, "ORDER BY Duration DESC LIMIT 2"));
    doc = call(tools, all, "search_traces", "{}");
    CHECK(contains(db.calls.back().sql, "ORDER BY Timestamp DESC LIMIT 21"));  // 20 by default
    CHECK_EQ(id(call(tools, all, "search_traces", R"({"status":"Fine"})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "search_traces", R"({"order":"random"})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "search_traces", R"({"min_duration_ms":-1})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "search_traces", R"({"limit":0})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "search_traces", R"({"nope":1})")), std::string("invalid_argument"));
    // A limit above the cap of the key is the cap.
    call(tools, narrow, "search_traces", R"({"limit":500})");
    CHECK(contains(db.calls.back().sql, "LIMIT 6"));
  }

  // The tools read the OpenTelemetry tables with the system user of the host, as the pages do: the data of the key does
  // not decide which tables they read, the permission does. Every query of these tools is marked as_system; the others
  // are the MCP user's.
  {
    const McpKey other = a_key({"*"}, {"analytics"});
    db.calls.clear();
    for (const char* tool : {"list_services", "search_traces", "search_logs", "list_metrics"}) {
      call(tools, other, tool, "{}");
      CHECK(!db.calls.empty() && db.calls.back().limits.as_system);
    }
    call(tools, other, "get_trace", R"({"trace_id":"0af7651916cd43dd8448eb211c80319c"})");
    CHECK(db.calls.back().limits.as_system);
    call(tools, other, "query_metric", R"({"metric":"up"})");
    CHECK(db.calls.back().limits.as_system);
    for (const auto& sent : db.calls) CHECK(sent.limits.as_system);  // the index of the trace, the kind of the metric too
    call(tools, other, "list_tables", "{}");
    CHECK(!db.calls.back().limits.as_system);
    call(tools, a_key({"*"}, {"otel.otel_logs"}), "search_traces", "{}");
    CHECK(contains(db.calls.back().sql, "`otel`.`otel_traces`"));
  }

  // traces.service_allowlist is the one allowlist of the three signals: every query of these tools carries it, so a key
  // never reads a service that the pages do not show (the tools read with the system user).
  {
    McpToolsConfig restricted = tools_config();
    restricted.observability.service_allowlist = {"checkout", "pay*"};
    FakeDb rdb;
    McpTools rtools(restricted, rdb);
    const std::string predicate = "(ServiceName = 'checkout' OR startsWith(ServiceName, 'pay'))";
    const McpKey key = a_key({"*"}, {"*"});
    for (const auto& [tool, args] : std::vector<std::pair<const char*, const char*>>{
             {"list_services", "{}"}, {"search_traces", "{}"}, {"get_trace", R"({"trace_id":"0af7651916cd43dd8448eb211c80319c"})"},
             {"search_logs", "{}"}, {"list_metrics", "{}"}, {"query_metric", R"({"metric":"up","kind":"gauge"})"}}) {
      rdb.calls.clear();
      call(rtools, key, tool, args);
      bool found = false;
      for (const auto& sent : rdb.calls) found = found || contains(sent.sql, predicate);
      CHECK(found);
    }
    rdb.calls.clear();
    call(rtools, key, "list_services", R"({"signal":"logs"})");
    CHECK(contains(rdb.calls.back().sql, predicate));
    // "*" (the default) adds a constant that keeps every service.
    FakeDb open_db;
    McpTools open_tools(tools_config(), open_db);
    call(open_tools, key, "search_logs", "{}");
    CHECK(contains(open_db.calls.back().sql, " AND 1 ") || contains(open_db.calls.back().sql, "AND 1 ORDER"));
    // An empty allowlist shows nothing.
    McpToolsConfig closed = tools_config();
    closed.observability.service_allowlist = {};
    FakeDb closed_db;
    McpTools closed_tools(closed, closed_db);
    call(closed_tools, key, "search_logs", "{}");
    CHECK(contains(closed_db.calls.back().sql, " AND 0 "));
  }

  // The tables can differ from a host to another: a call reads the tables of the host that it names, and a signal that is
  // off for that host is not_enabled there only.
  {
    McpToolsConfig two = tools_config();
    McpObservabilityConfig stage = two.observability;
    stage.traces_database = "eu";
    stage.traces_table = "spans";
    stage.logs = false;
    stage.metrics_prefix = "m";
    two.observability_by_host["stage"] = stage;
    FakeDb tdb;
    McpTools ttools(two, tdb);
    McpKey both = a_key({"*"}, {"*"});
    both.hosts = {"prod", "stage"};
    call(ttools, both, "search_traces", R"({"host":"prod"})");
    CHECK(contains(tdb.calls.back().sql, "`otel`.`otel_traces`"));
    call(ttools, both, "search_traces", R"({"host":"stage"})");
    CHECK(contains(tdb.calls.back().sql, "`eu`.`spans`") && !contains(tdb.calls.back().sql, "otel_traces"));
    call(ttools, both, "search_logs", R"({"host":"prod"})");
    CHECK(contains(tdb.calls.back().sql, "`otel`.`otel_logs`"));
    CHECK_EQ(id(call(ttools, both, "search_logs", R"({"host":"stage"})")), std::string("not_enabled"));
    call(ttools, both, "list_metrics", R"({"host":"stage"})");
    CHECK(contains(tdb.calls.back().sql, "`otel`.`m_gauge`"));
  }

  // get_trace: the trace id is hexadecimal; the window comes from the index when it knows the trace.
  {
    CHECK_EQ(id(call(tools, all, "get_trace", "{}")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "get_trace", R"({"trace_id":"x' OR 1=1 --"})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "get_trace", R"({"trace_id":"0af76519"})")), std::string("invalid_argument"));
    db.calls.clear();
    db.rules = {
        {"FROM `otel`.`otel_traces_trace_id_ts`", table_of({"a", "b", "c"}, {{"\"2026-10-08 10:00:00.000000000\"", "\"2026-10-08 10:00:02.500000000\"", "1"}})},
        {"WHERE TraceId = '0af7651916cd43dd8448eb211c80319c'", table_of({"a", "b", "c", "d", "e", "f", "g", "h", "i"},
            {{"\"b7ad6b7169203331\"", "\"\"", "\"checkout\"", "\"POST /pay\"", "\"Server\"", "\"2026-10-08 10:00:00.000000000\"", "2500", "\"Error\"", "\"card declined\""},
             {"\"00f067aa0ba902b7\"", "\"b7ad6b7169203331\"", "\"payments\"", "\"charge\"", "\"Client\"", "\"2026-10-08 10:00:00.100000000\"", "2300.25", "\"Error\"", "\"\""}})}};
    auto doc = call(tools, all, "get_trace", R"({"trace_id":"0af7651916cd43dd8448eb211c80319c"})");
    CHECK_EQ(std::string(doc["trace_id"].GetString()), std::string("0af7651916cd43dd8448eb211c80319c"));
    CHECK_EQ(doc["spans"].Size(), 2u);
    CHECK_EQ(std::string(doc["spans"][0]["service"].GetString()), std::string("checkout"));
    CHECK_EQ(std::string(doc["spans"][1]["parent_span_id"].GetString()), std::string("b7ad6b7169203331"));
    CHECK_EQ(std::string(doc["spans"][0]["status_message"].GetString()), std::string("card declined"));
    CHECK_EQ(db.calls.size(), size_t(2));
    CHECK(contains(db.calls[1].sql, "parseDateTime64BestEffort('2026-10-08 10:00:00.000000000', 9) - INTERVAL 1 MINUTE"));
    CHECK(contains(db.calls[1].sql, "ORDER BY Timestamp"));
    // The trace is not known: not found, not an empty list.
    db.rules.clear();
    CHECK_EQ(id(call(tools, all, "get_trace", R"({"trace_id":"0af7651916cd43dd8448eb211c80319c"})")), std::string("trace_not_found"));
    // The index answers a failure: the lookback window still bounds the read.
    db.calls.clear();
    db.rules = {{"WHERE TraceId = '0af7651916cd43dd8448eb211c80319c' AND Timestamp >= now() - INTERVAL 10080 MINUTE", table_of({"a", "b", "c", "d", "e", "f", "g", "h", "i"},
        {{"\"b7ad6b7169203331\"", "\"\"", "\"checkout\"", "\"POST /pay\"", "\"Server\"", "\"2026-10-08 10:00:00.000000000\"", "5", "\"Ok\"", "\"\""}})}};
    doc = call(tools, all, "get_trace", R"({"trace_id":"0AF7651916CD43DD8448EB211C80319C"})");
    CHECK(doc.HasMember("spans") || doc.HasMember("error"));
  }

  // search_logs.
  {
    db.calls.clear();
    db.rules = {{"FROM `otel`.`otel_logs`", table_of({"t", "s", "sev", "n", "tr", "sp", "b"},
        {{"\"2026-10-08 10:00:00.000000000\"", "\"checkout\"", "\"ERROR\"", "17", "\"0af7651916cd43dd8448eb211c80319c\"", "\"b7ad6b7169203331\"", "\"card declined\""}})}};
    auto doc = call(tools, all, "search_logs",
                    R"({"service":"checkout","severity":"warn","contains":"declined","trace_id":"0af7651916cd43dd8448eb211c80319c","since_minutes":5,"limit":10})");
    CHECK_EQ(doc["records"].Size(), 1u);
    CHECK_EQ(std::string(doc["records"][0]["message"].GetString()), std::string("card declined"));
    CHECK_EQ(doc["records"][0]["severity_number"].GetInt(), 17);
    const std::string& sql = db.calls.back().sql;
    CHECK(contains(sql, "SeverityNumber >= 13") && contains(sql, "positionCaseInsensitive(Body, 'declined') > 0"));
    CHECK(contains(sql, "TraceId = '0af7651916cd43dd8448eb211c80319c'") && contains(sql, "INTERVAL 5 MINUTE"));
    CHECK(contains(sql, "ORDER BY Timestamp DESC LIMIT 11") && contains(sql, "substringUTF8(Body, 1, 2000)"));
    CHECK_EQ(id(call(tools, all, "search_logs", R"({"severity":"loud"})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "search_logs", R"({"trace_id":"nope"})")), std::string("invalid_argument"));
  }

  // list_metrics and query_metric.
  {
    db.calls.clear();
    db.rules = {{"UNION ALL", table_of({"k", "n", "u", "d"}, {{"\"gauge\"", "\"process.cpu\"", "\"1\"", "\"CPU time\""}, {"\"sum\"", "\"http.requests\"", "\"{request}\"", "\"\""}})}};
    auto doc = call(tools, all, "list_metrics", R"({"filter":"http.*","service":"checkout"})");
    CHECK_EQ(doc["metrics"].Size(), 2u);
    CHECK_EQ(std::string(doc["metrics"][1]["kind"].GetString()), std::string("sum"));
    const std::string& sql = db.calls.back().sql;
    for (const char* kind : {"gauge", "sum", "histogram"}) CHECK(contains(sql, std::string("`otel`.`otel_metrics_") + kind + "`"));
    CHECK(contains(sql, "MetricName LIKE 'http.%'") && contains(sql, "ServiceName = 'checkout'"));

    // The kind is found by looking in the tables, in order, for the first point of the metric.
    db.calls.clear();
    db.rules = {
        {"toStartOfInterval", table_of({"t", "v", "n"}, {{"\"2026-10-08 10:00:00\"", "4", "12"}, {"\"2026-10-08 10:01:00\"", "9", "12"}})},
        {"SELECT 1 FROM `otel`.`otel_metrics_sum`", table_of({"x"}, {{"1"}})}};
    doc = call(tools, all, "query_metric", R"({"metric":"http.requests","aggregation":"last","since_minutes":120})");
    CHECK_EQ(std::string(doc["kind"].GetString()), std::string("sum"));
    CHECK_EQ(doc["series"].Size(), 2u);
    CHECK_EQ(doc["series"][1]["value"].GetInt(), 9);
    CHECK_EQ(doc["step_seconds"].GetInt(), 72);  // 120 minutes in about 100 points
    CHECK_EQ(db.calls.size(), size_t(3));        // a probe in gauge (nothing), a probe in sum, the series
    CHECK(contains(db.calls.back().sql, "argMax(Value, TimeUnix)") && contains(db.calls.back().sql, "INTERVAL 72 SECOND"));
    CHECK(contains(db.calls.back().sql, "FROM `otel`.`otel_metrics_sum`"));
    // A kind given: no probe. A histogram has avg, sum and count.
    db.calls.clear();
    doc = call(tools, all, "query_metric", R"({"metric":"http.duration","kind":"histogram","aggregation":"avg","step_seconds":30})");
    CHECK_EQ(db.calls.size(), size_t(1));
    CHECK(contains(db.calls.back().sql, "sum(Sum) / greatest(sum(Count), 1)") && contains(db.calls.back().sql, "INTERVAL 30 SECOND"));
    CHECK_EQ(id(call(tools, all, "query_metric", R"({"metric":"x","kind":"histogram","aggregation":"max"})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "query_metric", R"({"metric":"x","kind":"gauge","aggregation":"count"})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "query_metric", R"({"metric":"x","kind":"summary"})")), std::string("invalid_argument"));
    CHECK_EQ(id(call(tools, all, "query_metric", "{}")), std::string("invalid_argument"));
    // Nothing found in any table.
    db.rules.clear();
    CHECK_EQ(id(call(tools, all, "query_metric", R"({"metric":"nope"})")), std::string("metric_not_found"));
  }

  // A signal that is off in the configuration says so, and sends nothing.
  {
    McpToolsConfig off = tools_config();
    off.observability.traces = false;
    off.observability.logs = false;
    off.observability.metrics = false;
    FakeDb quiet;
    McpTools none(off, quiet);
    for (const char* tool : {"list_services", "search_traces", "search_logs", "list_metrics"}) {
      CHECK_EQ(id(call(none, all, tool, "{}")), std::string("not_enabled"));
    }
    CHECK_EQ(id(call(none, all, "get_trace", R"({"trace_id":"0af7651916cd43dd8448eb211c80319c"})")), std::string("not_enabled"));
    CHECK_EQ(id(call(none, all, "query_metric", R"({"metric":"up"})")), std::string("not_enabled"));
    CHECK(quiet.calls.empty());
  }
}

void test_tools() {
  FakeDb db;
  McpTools tools(tools_config(), db);
  McpKey all = a_key({"*"}, {"*"});
  all.hosts = {"prod"};
  McpKey narrow = a_key({"*"}, {"otel", "chdash_ui.fixture_*"});
  narrow.hosts = {"prod", "stage"};
  narrow.max_rows = 5;
  narrow.timeout_seconds = 7;

  // Hosts: optional with one, required with several, never outside the key.
  {
    McpToolOutcome o;
    auto doc = call(tools, narrow, "list_databases", "{}", &o);
    CHECK(o.is_error);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("host_required"));
    CHECK(contains(doc["message"].GetString(), "prod, stage"));
    doc = call(tools, narrow, "list_databases", R"({"host":"nope"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("host_not_allowed"));
    McpKey no_host = a_key({"*"}, {"*"});
    no_host.hosts = {};
    doc = call(tools, no_host, "list_databases", "{}", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("no_host"));
    McpKey star = a_key({"*"}, {"*"});
    star.hosts = {"*"};
    doc = call(tools, star, "list_databases", "{}", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("host_required"));
    CHECK(db.calls.empty());
    // An unknown argument is refused with its name.
    doc = call(tools, all, "list_databases", R"({"nope":1})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("invalid_argument"));
    CHECK(contains(doc["message"].GetString(), "nope"));
  }

  // list_hosts.
  {
    db.health = true;
    auto doc = call(tools, narrow, "list_hosts", "{}");
    CHECK_EQ(doc["hosts"].Size(), 2u);
    CHECK_EQ(std::string(doc["hosts"][0]["label"].GetString()), std::string("Production"));
    CHECK(doc["hosts"][0]["healthy"].GetBool());
    db.health = std::nullopt;
    doc = call(tools, all, "list_hosts", "{}");
    CHECK_EQ(doc["hosts"].Size(), 1u);
    CHECK(doc["hosts"][0]["healthy"].IsNull());
    CHECK(db.calls.empty());
  }

  // list_databases: the scope filters after the read, and the key's row cap does not cut it.
  {
    db.rules = {{"system.databases", table_of({"name", "engine", "comment"},
        {{"\"chdash_ui\"", "\"Atomic\"", "\"\""}, {"\"otel\"", "\"Atomic\"", "\"c\""}, {"\"system\"", "\"Atomic\"", "\"\""}, {"\"secret_db\"", "\"Atomic\"", "\"\""}})}};
    McpToolOutcome o;
    auto doc = call(tools, narrow, "list_databases", R"({"host":"prod"})", &o);
    CHECK(!o.is_error);
    CHECK_EQ(doc["databases"].Size(), 2u);
    CHECK_EQ(std::string(doc["databases"][1]["name"].GetString()), std::string("otel"));
    CHECK_EQ(db.calls.back().limits.max_rows, kMcpSchemaReadRows);
    CHECK_EQ(db.calls.back().limits.key_id, std::string("k1"));
    CHECK(contains(db.calls.back().sql, "name LIKE 'otel'"));
    CHECK(contains(db.calls.back().sql, "name LIKE 'chdash\\\\_ui'"));
    CHECK_EQ(db.calls.back().host, std::string("prod"));
    doc = call(tools, all, "list_databases", R"({"filter":"o*"})");
    CHECK_EQ(doc["databases"].Size(), 1u);
    CHECK(!contains(db.calls.back().sql, "WHERE"));
    // A key with no data sees nothing, and the query is not even a free read.
    McpKey none = a_key({"*"}, {});
    none.hosts = {"prod"};
    doc = call(tools, none, "list_databases", "{}");
    CHECK_EQ(doc["databases"].Size(), 0u);
    CHECK(contains(db.calls.back().sql, "WHERE 0"));
  }

  // list_tables.
  {
    db.rules = {{"system.tables", table_of({"database", "name", "engine", "total_rows", "total_bytes", "comment"},
        {{"\"chdash_ui\"", "\"fixture_a\"", "\"MergeTree\"", "10", "100", "\"\""},
         {"\"chdash_ui\"", "\"other\"", "\"MergeTree\"", "1", "1", "\"\""},
         {"\"otel\"", "\"otel_logs\"", "\"MergeTree\"", "null", "null", "\"x\""},
         {"\"system\"", "\"tables\"", "\"SystemTables\"", "null", "null", "\"\""}})}};
    auto doc = call(tools, narrow, "list_tables", R"({"host":"prod"})");
    CHECK_EQ(doc["tables"].Size(), 2u);  // other and system.tables are out of scope
    CHECK_EQ(std::string(doc["tables"][0]["name"].GetString()), std::string("fixture_a"));
    CHECK(doc["tables"][1]["total_rows"].IsNull());
    CHECK_EQ(doc["tables"][0]["total_rows"].GetInt(), 10);
    CHECK(!doc["truncated"].GetBool());
    doc = call(tools, narrow, "list_tables", R"({"host":"prod","filter":"fixture_*"})");
    CHECK_EQ(doc["tables"].Size(), 1u);
    CHECK(contains(db.calls.back().sql, "name LIKE 'fixture\\\\_%'"));
    McpToolOutcome o;
    doc = call(tools, narrow, "list_tables", R"({"host":"prod","database":"system"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("database_not_allowed"));
    doc = call(tools, narrow, "list_tables", R"({"host":"prod","database":"otel"})", &o);
    CHECK(!o.is_error);
    CHECK(contains(db.calls.back().sql, "database = 'otel'"));
    // A SQL-injection database name stays a literal.
    McpKey wild = a_key({"*"}, {"*"});
    wild.hosts = {"prod"};
    call(tools, wild, "list_tables", R"({"database":"x' OR 1=1 --"})");
    CHECK(contains(db.calls.back().sql, "database = 'x\\' OR 1=1 --'"));
  }

  // describe_table.
  {
    db.rules = {{"create_table_query", table_of({"engine"},
        {{"\"MergeTree\"", "\"CREATE TABLE t\"", "\"toDate(ts)\"", "\"ts\"", "\"ts\"", "\"\"", "42", "2048", "\"my table\""}})},
        {"FROM system.columns", table_of({"name"},
        {{"\"ts\"", "\"DateTime\"", "\"\"", "\"\"", "\"\"", "1", "1", "1", "0"}, {"\"v\"", "\"String\"", "\"DEFAULT\"", "\"'x'\"", "\"c\"", "0", "0", "0", "0"}})}};
    McpToolOutcome o;
    auto doc = call(tools, narrow, "describe_table", R"({"host":"prod","database":"chdash_ui","table":"fixture_a"})", &o);
    CHECK(!o.is_error);
    CHECK_EQ(std::string(doc["engine"].GetString()), std::string("MergeTree"));
    CHECK_EQ(doc["total_rows"].GetInt(), 42);
    CHECK_EQ(doc["columns"].Size(), 2u);
    CHECK(doc["columns"][0]["in_sorting_key"].GetBool());
    CHECK(!doc["columns"][0]["in_sampling_key"].GetBool());
    CHECK_EQ(std::string(doc["columns"][1]["default_expression"].GetString()), std::string("'x'"));
    doc = call(tools, narrow, "describe_table", R"({"host":"prod","database":"chdash_ui","table":"other"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("table_not_allowed"));
    doc = call(tools, narrow, "describe_table", R"({"host":"prod","database":"chdash_ui"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("invalid_argument"));
    db.rules.clear();
    doc = call(tools, narrow, "describe_table", R"({"host":"prod","database":"otel","table":"nope"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("table_not_found"));
  }

  // query_table.
  {
    db.calls.clear();
    db.rules = {{"FROM system.columns", table_of({"name"}, {{"\"id\"", "\"UInt64\"", "800", "100"}, {"\"msg\"", "\"String\"", "400000", "100"}, {"\"lvl\"", "\"String\"", "100", "100"}})},
                {"SELECT `", table_of({"id", "lvl"}, {{"1", "\"a\""}, {"2", "\"b\""}})}};
    McpToolOutcome o;
    auto doc = call(tools, narrow, "query_table",
                    R"({"host":"prod","database":"otel","table":"otel_logs","filters":[{"column":"lvl","op":"=","value":"a"}],"order_by":[{"column":"id","direction":"desc"}],"limit":3})", &o);
    CHECK(!o.is_error);
    CHECK_EQ(db.calls.size(), size_t(2));
    CHECK_EQ(db.calls[1].sql, std::string("SELECT `id`, `lvl` FROM `otel`.`otel_logs` WHERE `lvl` = 'a' ORDER BY `id` DESC LIMIT 3"));
    CHECK_EQ(db.calls[1].limits.max_rows, int64_t(5));  // the key's cap
    CHECK_EQ(db.calls[1].limits.timeout_seconds, int64_t(7));  // the key's timeout lowers the global one
    CHECK_EQ(db.calls[1].limits.max_bytes, int64_t(1048576));
    CHECK_EQ(db.calls[1].limits.max_memory_bytes, int64_t(1000000000));
    CHECK_EQ(db.calls[1].limits.max_rows_to_read, int64_t(5000000));
    CHECK_EQ(db.calls[0].limits.max_rows, kMcpSchemaReadRows);
    CHECK_EQ(doc["row_count"].GetInt(), 2);
    CHECK_EQ(doc["rows"][1][0].GetInt(), 2);
    CHECK_EQ(std::string(doc["rows"][1][1].GetString()), std::string("b"));
    CHECK_EQ(doc["columns"][0]["name"].GetString(), std::string("id"));
    CHECK_EQ(doc["limit"].GetInt(), 3);
    CHECK(!doc["truncated"].GetBool());
    CHECK_EQ(doc["omitted_columns"].Size(), 1u);
    CHECK_EQ(std::string(doc["omitted_columns"][0]["name"].GetString()), std::string("msg"));
    CHECK_EQ(o.rows, uint64_t(2));
    CHECK_EQ(o.host, std::string("prod"));
    // A limit above the cap asks for one more row and clamps.
    call(tools, narrow, "query_table", R"({"host":"prod","database":"otel","table":"otel_logs","limit":50})");
    CHECK(contains(db.calls.back().sql, "LIMIT 6"));
    doc = call(tools, narrow, "query_table", R"({"host":"prod","database":"otel","table":"otel_logs","limit":50})");
    CHECK_EQ(doc["limit"].GetInt(), 5);
    // Default limit: 100, under the global cap.
    call(tools, all, "query_table", R"({"database":"otel","table":"otel_logs"})");
    CHECK(contains(db.calls.back().sql, "LIMIT 100"));
    CHECK_EQ(db.calls.back().limits.max_rows, int64_t(1000));
    CHECK_EQ(db.calls.back().limits.timeout_seconds, int64_t(30));
    // Errors.
    doc = call(tools, narrow, "query_table", R"({"host":"prod","database":"otel","table":"otel_logs","columns":["zzz"]})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("unknown_column"));
    doc = call(tools, narrow, "query_table", R"({"host":"prod","database":"system","table":"tables"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("table_not_allowed"));
    doc = call(tools, narrow, "query_table", R"({"host":"prod","database":"otel","table":"otel_logs","limit":0})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("invalid_argument"));
    doc = call(tools, narrow, "query_table", R"({"host":"prod","database":"otel","table":"otel_logs","filters":[{"column":"id","op":"=","value":{"a":1}}]})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("invalid_argument"));
    doc = call(tools, narrow, "query_table", R"({"host":"prod","database":"otel","table":"otel_logs","filters":[{"column":"id","op":"=","value":1,"extra":1}]})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("invalid_argument"));
    doc = call(tools, narrow, "query_table", R"({"host":"prod","database":"otel","table":"otel_logs","filters":"id=1"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("invalid_argument"));
    // Truncated by the cap is reported as it came.
    db.rules[1].second.truncated = true;
    doc = call(tools, narrow, "query_table", R"({"host":"prod","database":"otel","table":"otel_logs"})");
    CHECK(doc["truncated"].GetBool());
    db.rules.clear();
    doc = call(tools, narrow, "query_table", R"({"host":"prod","database":"otel","table":"otel_logs"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("table_not_found"));
  }

  // run_query: one statement, the caps of the key.
  {
    db.calls.clear();
    db.rules = {{"SELECT", table_of({"n"}, {{"1"}}, true)}};
    McpToolOutcome o;
    auto doc = call(tools, all, "run_query", R"({"sql":"SELECT 1;"})", &o);
    CHECK(!o.is_error);
    CHECK_EQ(db.calls[0].sql, std::string("SELECT 1"));
    CHECK(doc["truncated"].GetBool());
    CHECK_EQ(doc["rows"][0][0].GetInt(), 1);
    doc = call(tools, all, "run_query", R"({"sql":"SELECT 1; DROP TABLE t"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("multiple_statements"));
    doc = call(tools, all, "run_query", R"({"sql":"DROP TABLE t"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("statement_not_allowed"));
    doc = call(tools, all, "run_query", "{\"sql\":\"SELECT '" + std::string(300, 'x') + "'\"}", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("sql_too_large"));
    doc = call(tools, all, "run_query", "{}", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("invalid_argument"));
    CHECK_EQ(db.calls.size(), size_t(1));
  }

  // explain_query.
  {
    db.calls.clear();
    db.rules = {{"EXPLAIN", table_of({"explain"}, {{"\"Expression\""}, {"\"  ReadFromStorage\""}})}};
    McpToolOutcome o;
    auto doc = call(tools, all, "explain_query", R"({"sql":"SELECT 1"})", &o);
    CHECK(!o.is_error);
    CHECK_EQ(db.calls[0].sql, std::string("EXPLAIN PLAN SELECT 1"));
    CHECK_EQ(doc["lines"].Size(), 2u);
    CHECK_EQ(std::string(doc["lines"][1].GetString()), std::string("  ReadFromStorage"));
    call(tools, all, "explain_query", R"({"sql":"SELECT 1","type":"pipeline"})");
    CHECK_EQ(db.calls.back().sql, std::string("EXPLAIN PIPELINE SELECT 1"));
    call(tools, all, "explain_query", R"({"sql":"WITH 1 AS x SELECT x","type":"AST"})");
    CHECK_EQ(db.calls.back().sql, std::string("EXPLAIN AST WITH 1 AS x SELECT x"));
    call(tools, all, "explain_query", R"({"sql":"SELECT 1","indexes":true,"actions":true})");
    CHECK_EQ(db.calls.back().sql, std::string("EXPLAIN PLAN indexes = 1, actions = 1 SELECT 1"));
    call(tools, all, "explain_query", R"({"sql":"SELECT 1","type":"estimate"})");
    CHECK_EQ(db.calls.back().sql, std::string("EXPLAIN ESTIMATE SELECT 1"));
    doc = call(tools, all, "explain_query", R"({"sql":"SELECT 1","type":"bogus"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("invalid_argument"));
    doc = call(tools, all, "explain_query", R"j({"sql":"INSERT INTO t VALUES (1)"})j", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("statement_not_allowed"));
    doc = call(tools, all, "explain_query", R"({"sql":"SELECT 1; SELECT 2"})", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("multiple_statements"));
    // A bare second statement cannot hide behind the EXPLAIN prefix.
    const size_t n = db.calls.size();
    call(tools, all, "explain_query", R"({"sql":"SELECT 1 -- ; DROP"})");
    CHECK_EQ(db.calls.size(), n + 1);
  }

  // A database failure is a tool failure with its code, and no data of other calls leaks.
  {
    db.fail_code = "timeout";
    McpToolOutcome o;
    auto doc = call(tools, all, "run_query", R"({"sql":"SELECT 1"})", &o);
    CHECK(o.is_error);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("timeout"));
    CHECK(contains(doc["message"].GetString(), "DB::Exception"));
    CHECK_EQ(o.error_code, std::string("timeout"));
    db.fail_code = "permission_denied";
    doc = call(tools, all, "list_databases", "{}", &o);
    CHECK_EQ(std::string(doc["error"].GetString()), std::string("permission_denied"));
    db.fail_code.clear();
  }
}

// ---- configuration ---------------------------------------------------------------------------------------------

AppConfig load(const std::string& dir, const std::string& hcl) {
  const std::string path = dir + "/chdash.hcl";
  write_file(path, hcl);
  return load_config_from_file(path);
}

std::string load_error(const std::string& dir, const std::string& hcl) {
  try {
    load(dir, hcl);
  } catch (const std::exception& e) {
    return e.what();
  }
  return "";
}

const char* kHosts = R"(
clickhouse {
  host {
    name = "prod"
    runner_uri = "clickhouse://runner:r@h:9000"
    system_uri = "clickhouse://system:s@h:9000"
    mcp_uri = "clickhouse://chdash_mcp:m@h:9000"
  }
  host {
    name = "stage"
    runner_uri = "clickhouse://runner:r@h2:9000"
    system_uri = "clickhouse://system:s@h2:9000"
  }
}
)";

const char* kSecret24 = "01234567-89ab-4def-8123-456789abcdef";

// What the tools share (mcp_tool_support.cpp): the context of a call, the host, the arguments, the cells.
void test_tool_support() {
  using namespace mcp_tools;
  struct NoDatabase : McpDatabase {
    McpDbResult run(const std::string&, const std::string&, const McpDbLimits&) override { throw McpDbError("host_unavailable", "down"); }
    std::optional<bool> host_healthy(const std::string&) override { return std::nullopt; }
  } database;
  McpToolsConfig config;
  config.hosts = {{"prod", "Prod"}, {"stage", "Stage"}};
  config.max_rows = 500;
  config.query_timeout_seconds = 30;
  config.max_result_bytes = 2000;
  McpKey key = a_key({"*"}, {"*"});
  key.hosts = {"prod", "stage"};
  key.max_rows = 100;
  key.timeout_seconds = 5;

  // The limits: the key may only lower them; the schema tools read more rows than the key shows; the OpenTelemetry tools run as the system user.
  Ctx ctx = make_ctx(key, config, database);
  CHECK_EQ(ctx.max_rows, int64_t{100});
  CHECK_EQ(ctx.user_limits.max_rows, int64_t{100});
  CHECK_EQ(ctx.user_limits.timeout_seconds, int64_t{5});
  CHECK_EQ(ctx.user_limits.key_id, std::string("k1"));
  CHECK(!ctx.user_limits.as_system && ctx.system_limits.as_system && ctx.system_schema_limits.as_system && !ctx.schema_limits.as_system);
  CHECK_EQ(ctx.schema_limits.max_rows, kMcpSchemaReadRows);
  CHECK_EQ(ctx.schema_limits.max_bytes, kMcpSchemaReadBytes);
  // The tool of the call names the statements of every set of limits (their query_id, mcp_cost.hpp).
  const Ctx named = make_ctx(key, config, database, "query_table");
  for (const McpDbLimits* limits : {&named.user_limits, &named.schema_limits, &named.system_limits, &named.system_schema_limits}) {
    CHECK_EQ(limits->tool, std::string("query_table"));
    CHECK_EQ(limits->key_id, std::string("k1"));
  }
  CHECK_EQ(ctx.user_limits.tool, std::string(""));
  key.max_rows.reset();
  key.timeout_seconds.reset();
  CHECK_EQ(make_ctx(key, config, database).max_rows, int64_t{500});

  // The host: named, or the only one; several hosts need a choice.
  const auto resolve = [&](const char* json, const McpKey& k) {
    rapidjson::Document args;
    args.Parse(json);
    Ctx c = make_ctx(k, config, database);
    try {
      resolve_host(c, args);
    } catch (const ToolFailure& f) {
      return f.code;
    }
    return std::string("ok:") + c.host;
  };
  CHECK_EQ(resolve("{\"host\":\"stage\"}", key), std::string("ok:stage"));
  CHECK_EQ(resolve("{\"host\":\"other\"}", key), std::string("host_not_allowed"));
  CHECK_EQ(resolve("{}", key), std::string("host_required"));
  McpKey one = key;
  one.hosts = {"prod"};
  CHECK_EQ(resolve("{}", one), std::string("ok:prod"));
  McpKey none = key;
  none.hosts = {"nowhere"};
  CHECK_EQ(resolve("{}", none), std::string("no_host"));

  // A failed statement is a failure of the tool with the code of the database.
  Ctx failing = make_ctx(key, config, database);
  failing.host = "prod";
  try {
    run(failing, "SELECT 1", failing.user_limits);
    CHECK(false);
  } catch (const ToolFailure& f) {
    CHECK_EQ(f.code, std::string("host_unavailable"));
  }

  // The arguments.
  rapidjson::Document args;
  args.Parse("{\"a\":\"text\",\"b\":true,\"c\":3,\"n\":null}");
  const auto code_of = [&](const std::function<void()>& fn) {
    try {
      fn();
    } catch (const ToolFailure& f) {
      return f.code + ":" + f.message;
    }
    return std::string("ok");
  };
  CHECK_EQ(*opt_string(args, "a"), std::string("text"));
  CHECK(!opt_string(args, "n") && !opt_string(args, "missing"));
  CHECK_EQ(code_of([&] { opt_string(args, "c"); }), std::string("invalid_argument:c must be a string"));
  CHECK_EQ(code_of([&] { opt_string(args, "a", 2); }), std::string("invalid_argument:a is too long"));
  CHECK_EQ(code_of([&] { req_string(args, "missing"); }), std::string("invalid_argument:missing is required"));
  CHECK(*opt_bool(args, "b"));
  CHECK_EQ(code_of([&] { opt_bool(args, "a"); }), std::string("invalid_argument:a must be true or false"));
  CHECK_EQ(code_of([&] { reject_unknown(args, {"a", "b", "c", "n"}); }), std::string("ok"));
  CHECK_EQ(code_of([&] { reject_unknown(args, {"a"}); }), std::string("invalid_argument:unknown argument b"));

  // Cells are JSON text: a string loses its quotes, null is empty, a number stays.
  CHECK_EQ(cell_text("\"a\\\"b\""), std::string("a\"b"));
  CHECK_EQ(cell_text("null"), std::string());
  CHECK_EQ(cell_text("42"), std::string("42"));
  CHECK_EQ(cell_u64("\"18446744073709551\""), uint64_t{18446744073709551ULL});
  CHECK_EQ(cell_u64("12x"), uint64_t{0});
  CHECK_EQ(cell_u64("12345678901234567890"), uint64_t{0});
  McpDbResult res;
  res.columns = {{"a", "UInt8"}, {"b", "String"}};
  res.rows = {{"1", "\"x\""}, {"", "null"}};
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  write_columns(w, res);
  write_rows(w, res);
  w.EndObject();
  CHECK_EQ(finish(sb), std::string("{\"columns\":[{\"name\":\"a\",\"type\":\"UInt8\"},{\"name\":\"b\",\"type\":\"String\"}],\"rows\":[[1,\"x\"],[null,null]],\"row_count\":2}"));
  CHECK_EQ(glob_conditions("name", {"a*", "b_"}), std::string("name LIKE 'a%' OR name LIKE 'b\\\\_'"));
  CHECK_EQ(describe_table_filter("d'b", "t", "name"), std::string("database = 'd\\'b' AND name = 't'"));
}

void test_config(const std::string& dir) {
  const std::string hosts = kHosts;
  // No mcp block: off, and the existing configs keep working.
  {
    const AppConfig cfg = load(dir, hosts);
    CHECK(!cfg.mcp.enabled);
    CHECK(cfg.mcp.keys.empty());
    CHECK_EQ(cfg.hosts.size(), size_t(2));
    CHECK_EQ(cfg.hosts[0].mcp_uri, std::string("clickhouse://chdash_mcp:m@h:9000"));
    CHECK_EQ(cfg.hosts[1].mcp_uri, std::string(""));
    CHECK_EQ(cfg.mcp.max_rows, int64_t(1000));
    CHECK_EQ(cfg.mcp.max_result_bytes, int64_t(1048576));
    CHECK_EQ(cfg.mcp.query_timeout_seconds, int64_t(30));
    CHECK_EQ(cfg.mcp.max_sql_bytes, int64_t(65536));
    CHECK_EQ(cfg.mcp.max_memory_bytes, int64_t(1073741824));
    CHECK_EQ(cfg.mcp.max_rows_to_read, int64_t(0));
    CHECK_EQ(cfg.mcp.rate_limit_per_minute, int64_t(600));
    CHECK(cfg.mcp.manage_from_ui);
    CHECK(cfg.mcp.allowed_origins.empty());
  }
  // A full block.
  const std::string storage = dir + "/ok-keys.json";
  const std::string secret_file = dir + "/secret.txt";
  write_file(secret_file, std::string("  f11e0000-0000-4000-8000-000000000010 \r\n\n"));
  {
    const AppConfig cfg = load(dir, std::string(R"(
mcp {
  enabled = true
  storage_file = ")") + storage + R"("
  manage_from_ui = false
  max_rows = 500
  max_result_bytes = 2048
  query_timeout_seconds = 10
  max_sql_bytes = 1000
  max_memory_bytes = 33554432
  max_rows_to_read = 99
  rate_limit_per_minute = 0
  allowed_origins = ["https://inspector.example.com", "http://localhost:6274"]
  key {
    name = "a"
    secret = ")" + kSecret24 + R"("
    hosts = ["prod"]
    tools = ["list_databases", "query_table"]
    databases = ["otel", "analytics.e*"]
    max_rows = 200
    timeout_seconds = 10
  }
  key {
    name = "b"
    secret_file = ")" + secret_file + R"("
    hosts = ["prod"]
    tools = ["*"]
    databases = ["*"]
  }
  key {
    name = "c"
    secret = "54a00000-0000-4000-8000-000000000011"
    hosts = ["prod"]
    tools = ["run_query", "explain_query"]
    databases = ["*"]
  }
}
)" + hosts);
    CHECK(cfg.mcp.enabled);
    CHECK(!cfg.mcp.manage_from_ui);
    CHECK_EQ(cfg.mcp.max_rows, int64_t(500));
    CHECK_EQ(cfg.mcp.max_rows_to_read, int64_t(99));
    CHECK_EQ(cfg.mcp.rate_limit_per_minute, int64_t(0));
    CHECK_EQ(cfg.mcp.allowed_origins.size(), size_t(2));
    CHECK_EQ(cfg.mcp.keys.size(), size_t(3));
    CHECK_EQ(cfg.mcp.keys[0].name, std::string("a"));
    CHECK_EQ(cfg.mcp.keys[0].id, std::string("a"));
    CHECK_EQ(cfg.mcp.keys[0].source, std::string("config"));
    CHECK(cfg.mcp.keys[0].secret_hash == mcp_hash_secret(kSecret24));
    CHECK_EQ(cfg.mcp.keys[0].max_rows.value_or(0), int64_t(200));
    // The config keeps the hash and the hint of a secret, never the secret.
    CHECK_EQ(cfg.mcp.keys[0].secret_hint, std::string(kSecret24).substr(0, 8));
    CHECK_EQ(cfg.mcp.keys[1].secret_hint, std::string("f11e0000"));
    CHECK_EQ(cfg.mcp.keys[2].secret_hint, std::string("54a00000"));
    CHECK(cfg.mcp.keys[1].secret_hash == mcp_hash_secret("f11e0000-0000-4000-8000-000000000010"));  // trimmed
    CHECK(cfg.mcp.keys[2].secret_hash == mcp_hash_secret("54a00000-0000-4000-8000-000000000011"));
    CHECK(::access(storage.c_str(), F_OK) != 0);  // loading the config never creates the file
  }
  // mcp.enabled = false skips the cross checks but keeps the shape rules.
  CHECK_EQ(load_error(dir, "mcp { enabled = false }\n" + hosts), std::string(""));
  CHECK(!load(dir, "mcp { enabled = false }\n" + hosts).mcp.enabled);
  CHECK(contains(load_error(dir, "mcp { enabled = false\n key { name = \"x\" } }\n" + hosts), "exactly one of"));

  // The startup errors (docs/mcp.md, "Startup errors"; 8, the usage file, is below 3).
  // 1. enabled with no storage file and no key.
  CHECK(contains(load_error(dir, "mcp { enabled = true }\n" + hosts), "mcp.storage_file"));
  // 2. enabled and no host has mcp_uri.
  CHECK(contains(load_error(dir, "mcp { enabled = true\n storage_file = \"" + storage + "\" }\nclickhouse { host { name = \"h\" runner_uri = \"clickhouse://a@h:9000\" system_uri = \"clickhouse://a@h:9000\" } }"), "mcp_uri"));
  // 3. the storage file is not valid JSON (never rewritten) or its directory is missing.
  {
    const std::string bad = dir + "/bad-keys.json";
    write_file(bad, "{not json");
    const std::string message = load_error(dir, "mcp { enabled = true\n storage_file = \"" + bad + "\" }\n" + hosts);
    CHECK(contains(message, "not valid JSON"));
    CHECK(contains(message, bad));
    CHECK_EQ(read_file(bad), std::string("{not json"));
    CHECK(contains(load_error(dir, "mcp { enabled = true\n storage_file = \"" + dir + "/missing-dir/k.json\" }\n" + hosts), "does not exist"));
  }
  // 8. the usage file: a file of its own, a usage file of this ChDash (never rewritten when it is not), in a directory that exists.
  {
    const std::string keys_file = dir + "/usage-keys.json";
    const auto with_usage = [&](const std::string& usage, const std::string& more = "") {
      return "mcp { enabled = true\n storage_file = \"" + keys_file + "\"\n usage_file = \"" + usage + "\"\n" + more + "}\n" + hosts;
    };
    const std::string usage = dir + "/usage.json";
    const AppConfig cfg = load(dir, with_usage(usage, " usage_retention_days = 30\n"));
    CHECK_EQ(cfg.mcp.usage_file, usage);
    CHECK_EQ(cfg.mcp.usage_retention_days, int64_t(30));
    CHECK_EQ(load(dir, hosts).mcp.usage_retention_days, int64_t(90));
    CHECK(::access(usage.c_str(), F_OK) != 0);  // loading the config never creates the file
    CHECK(contains(load_error(dir, with_usage(keys_file)), "key file"));
    CHECK(contains(load_error(dir, with_usage(dir + "/./usage-keys.json")), "key file"));
    CHECK(contains(load_error(dir, with_usage(usage, " usage_retention_days = 0\n")), "usage_retention_days"));
    CHECK(contains(load_error(dir, with_usage(usage, " usage_retention_days = 366\n")), "usage_retention_days"));
    CHECK(contains(load_error(dir, with_usage(dir + "/missing-dir/usage.json")), "does not exist"));
    const std::string bad = dir + "/bad-usage.json";
    const std::string newer = R"({"version":2,"since":"2026-10-01T00:00:00Z","keys":[]})";
    write_file(bad, newer);
    const std::string message = load_error(dir, with_usage(bad));
    CHECK(contains(message, "version must be 1"));
    CHECK(contains(message, "the file is not changed"));
    CHECK_EQ(read_file(bad), newer);
    const std::string library = dir + "/usage-library.json";
    CHECK(contains(load_error(dir, "query_library {\n enabled = true\n file = \"" + library + "\"\n}\n" + with_usage(library)), "query library"));
  }
  // 4. two keys with the same name or the same secret (config and file included).
  const auto key = [](const std::string& name, const std::string& secret_attr, const std::string& tools = "[\"*\"]", const std::string& databases = "[\"*\"]", const std::string& hosts_attr = "[\"prod\"]") {
    return "key {\n name = \"" + name + "\"\n " + secret_attr + "\n hosts = " + hosts_attr + "\n tools = " + tools + "\n databases = " + databases + "\n }\n";
  };
  const std::string s1 = "secret = \"" + std::string(kSecret24) + "\"";
  // auth_header: Authorization by default; another name is read as given; a bad or reserved name stops the start.
  CHECK_EQ(load(dir, "mcp { enabled = true\n" + key("x", s1) + "}\n" + hosts).mcp.auth_header, std::string("Authorization"));
  CHECK_EQ(load(dir, "mcp { enabled = true\n auth_header = \"X-ChDash-Key\"\n" + key("x", s1) + "}\n" + hosts).mcp.auth_header, std::string("X-ChDash-Key"));
  for (const char* bad : {"", "X Key", "X_Key", "-X", "Content-Type", "host", "Cookie", "Mcp-Session-Id"}) {
    CHECK(contains(load_error(dir, std::string("mcp { enabled = true\n auth_header = \"") + bad + "\"\n" + key("x", s1) + "}\n" + hosts), "mcp.auth_header"));
  }
  // The attributes that no longer exist (a key is made or deleted: no switch, no description, no expiry).
  for (const char* gone : {"enabled = false", "description = \"x\"", "expires_at = \"2027-01-01\""}) {
    CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n " + gone + " } }\n" + hosts), "unknown attribute"));
  }
  const std::string s2 = "secret = \"a07e7e70-0000-4000-8000-0000000000aa\"";
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1) + key("x", s2) + "}\n" + hosts), "two keys have the name x"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1) + key("y", s1) + "}\n" + hosts), "same secret"));
  // A key has a secret that the page can show: a hash alone is refused.
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("y", "secret_sha256 = \"" + mcp_hash_hex(mcp_hash_secret(kSecret24)) + "\"") + "}\n" + hosts), "secret_sha256 is not accepted"));
  {
    const std::string file = dir + "/dupe-keys.json";
    McpStoreOptions o = store_options(file);
    o.config_keys.clear();
    McpKeyStore store(o);
    const auto made = store.create(input_of(R"({"name":"from-ui","hosts":["prod"],"tools":["*"],"databases":["*"]})"), 1'800'000'000);
    const std::string head = "mcp { enabled = true\n storage_file = \"" + file + "\"\n";
    CHECK(contains(load_error(dir, head + key("from-ui", s1) + "}\n" + hosts), "from-ui"));
    CHECK(contains(load_error(dir, head + key("other", "secret = \"" + made.secret + "\"") + "}\n" + hosts), "same secret"));
    CHECK_EQ(load_error(dir, head + key("other", s1) + "}\n" + hosts), std::string(""));
  }
  // 5. a host or a tool that is unknown, or a host without mcp_uri.
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1, "[\"*\"]", "[\"*\"]", "[\"nope\"]") + "}\n" + hosts), "nope"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1, "[\"*\"]", "[\"*\"]", "[\"stage\"]") + "}\n" + hosts), "stage"));
  // A key reads one host, and names it: a startup error says so.
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1, "[\"*\"]", "[\"*\"]", "[\"*\"]") + "}\n" + hosts), "names its host"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1, "[\"*\"]", "[\"*\"]", "[\"prod\", \"stage\"]") + "}\n" + hosts), "one host at most"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1, "[\"drop_table\"]") + "}\n" + hosts), "drop_table"));
  // 6. an SQL tool without databases = ["*"].
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1, "[\"run_query\"]", "[\"otel\"]") + "}\n" + hosts), "run_query"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1, "[\"explain_query\"]", "[]") + "}\n" + hosts), "explain_query"));
  CHECK_EQ(load_error(dir, "mcp { enabled = true\n" + key("x", s1, "[\"run_query\"]", "[\"*\"]") + "}\n" + hosts), std::string(""));
  CHECK_EQ(load_error(dir, "mcp { enabled = true\n" + key("x", s1, "[\"*\"]", "[\"otel\"]") + "}\n" + hosts), std::string(""));
  // 7. an unknown attribute, or not exactly one secret.
  CHECK(contains(load_error(dir, "mcp { enabled = true\n bogus = 1 }\n" + hosts), "unknown attribute bogus"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n colour = \"red\" } }\n" + hosts), "unknown attribute colour"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n extra { a = 1 } }\n" + hosts), "unknown block extra"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\" } }\n" + hosts), "exactly one of secret and secret_file is required"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n secret_file = \"/x\" } }\n" + hosts), "exactly one of"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n secret_sha256 = \"00\" } }\n" + hosts), "secret_sha256 is not accepted"));

  // The other rules of a key.
  // A secret is a UUID version 4, nothing else: not a short one, not a long random one, not another version or variant.
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"short\"") + "}\n" + hosts), "UUID version 4"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"" + std::string(36, 'a') + "\"") + "}\n" + hosts), "UUID version 4"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"a11da7a0-0000-1000-8000-000000000001\"") + "}\n" + hosts), "UUID version 4"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"a11da7a0-0000-4000-c000-000000000001\"") + "}\n" + hosts), "UUID version 4"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"a11da7a000004000800000000000000001\"") + "}\n" + hosts), "UUID version 4"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"all-data-secret-0123456789abcdef\"") + "}\n" + hosts), "UUID version 4"));
  CHECK_EQ(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"A11DA7A0-0000-4000-B000-00000000000F\"") + "}\n" + hosts), std::string(""));
  CHECK(mcp_valid_secret(mcp_generate_secret()));
  CHECK(!mcp_valid_secret("") && !mcp_valid_secret("a11da7a0-0000-4000-8000-00000000000g"));
  // A key needs a host.
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n hosts = [] } }\n" + hosts), "a key needs a host"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + " } }\n" + hosts), "a key needs a host"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret_file = \"" + dir + "/no-such-file\"") + "}\n" + hosts), "secret_file"));
  write_file(dir + "/short-secret", "tiny\n");
  write_file(dir + "/uuid-secret", "a11da7a0-0000-4000-8000-0000000000ff\n");
  CHECK_EQ(load_error(dir, "mcp { enabled = true\n " + key("x", "secret_file = \"" + dir + "/uuid-secret\"") + "}\n" + hosts), std::string(""));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret_file = \"" + dir + "/short-secret\"") + "}\n" + hosts), "UUID version 4"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("ui_reserved", s1) + "}\n" + hosts), "ui_"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("Bad Name", s1) + "}\n" + hosts), "name"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { " + s1 + " } }\n" + hosts), "name is required"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n max_rows = 5000 hosts = [\"prod\"] } }\n" + hosts), "max_rows"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n timeout_seconds = 31 hosts = [\"prod\"] } }\n" + hosts), "timeout_seconds"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n expires_at = \"someday\" } }\n" + hosts), "expires_at"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n hosts = [\"prod\"]\n databases = [\"a b\"] } }\n" + hosts), "databases"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n max_rows = 0\n " + key("x", s1) + "}\n" + hosts), "mcp.max_rows"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n query_timeout_seconds = 99999\n " + key("x", s1) + "}\n" + hosts), "query_timeout_seconds"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n allowed_origins = [\"*\"]\n " + key("x", s1) + "}\n" + hosts), "allowed_origins"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n allowed_origins = [\"example.com\"]\n " + key("x", s1) + "}\n" + hosts), "allowed_origins"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n allowed_origins = [\"https://a/b\"]\n " + key("x", s1) + "}\n" + hosts), "allowed_origins"));

  // The identities of the API tools (mcp_identity.hpp): one entry for each host that has an mcp_uri, with MCP on.
  {
    const std::string one_key = "mcp { enabled = true\n" + key("x", s1) + "}\n";
    const AppConfig cfg = load(dir, one_key + "clickhouse { host { name = \"prod\"\n runner_uri = \"clickhouse://r:rp@h:9000\"\n system_uri = \"clickhouse://s:sp@h:9000\"\n mcp_uri = \"clickhouse://m:mp@h:9000\" }\n"
                                    " host { name = \"stage\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\" } }");
    CHECK_EQ(cfg.mcp_hosts.size(), size_t(1));  // none for stage: it has no mcp_uri
    CHECK_EQ(cfg.mcp_hosts[0].id, std::string("prod\x1f" "mcp"));
    CHECK_EQ(cfg.mcp_hosts[0].runner_uri, std::string("clickhouse://m:mp@h:9000"));  // the MCP user decides what is visible
    CHECK_EQ(cfg.mcp_hosts[0].system_uri, std::string("clickhouse://s:sp@h:9000"));  // the system user only adds figures
    CHECK(cfg.mcp_hosts[0].mcp_uri.empty());
    CHECK_EQ(cfg.hosts.size(), size_t(2));  // they are never in the list of the hosts
    // MCP off: no identity at all.
    CHECK(load(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n mcp_uri = \"clickhouse://m@h:9000\" } }").mcp_hosts.empty());
    // A host name never holds a control character: the identities are made with one.
    CHECK(contains(load_error(dir, "clickhouse { host { name = \"a\x1f" "mcp\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\" } }"), "control character"));
    // The identities are visible to the context of an API tool only (request_context.hpp): a request of a browser never has
    // one, whatever it sends.
    {
      httplib::Request forged;
      forged.set_header("X-ChDash-Internal", std::string(32, '0'));
      CHECK(find_request_host(cfg, forged, "prod\x1f" "mcp") == nullptr);
      RequestContext mcp;
      mcp.caller = RequestContext::Caller::Mcp;
      mcp.caller_id = "k";
      RequestScope scope(mcp);
      CHECK(find_request_host(cfg, forged, "prod\x1f" "mcp") != nullptr);
      CHECK(find_request_host(cfg, forged, "prod") != nullptr);
    }
  }

  // clickhouse.host: the MCP identity is separate.
  {
    // The file of the password is read at the start (a file that cannot be read stops it).
    const std::string password_file = dir + "/runner-pw";
    write_file(password_file, "secret\n");
    const AppConfig cfg = load(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n password_file = \"" + password_file + "\"\n mcp_uri = \"clickhouse://m:pw@h:9000\" } }");
    CHECK_EQ(cfg.hosts[0].mcp_uri, std::string("clickhouse://m:pw@h:9000"));  // the password is in the URI; password_file never applies
    CHECK(contains(cfg.hosts[0].runner_uri, "password_file="));
    const AppConfig no_mcp = load(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n password_file = \"" + password_file + "\" } }");
    CHECK(contains(load_error(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n password_file = \"" + dir + "/missing-pw\" } }"), "cannot open password_file"));
    CHECK_EQ(no_mcp.hosts[0].mcp_uri, std::string(""));
    CHECK(contains(load_error(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n mcp_password_file = \"/x\" } }"), "unknown attribute mcp_password_file"));
    CHECK(contains(load_error(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n mcp_uri = \"http://x\" } }"), "mcp_uri"));
  }
}

} // namespace


// ---- the observability block: Traces, Logs and Metrics, and what a host may change ------------------------------------------

void test_observability_config(const std::string& dir) {
  const std::string hosts = R"(
clickhouse {
  host {
    name = "a"
    runner_uri = "clickhouse://r@h:9000"
    system_uri = "clickhouse://s@h:9000"
    mcp_uri = "clickhouse://m@h:9000"
  }
  host {
    name = "b"
    runner_uri = "clickhouse://r@h2:9000"
    system_uri = "clickhouse://s@h2:9000"
    observability {
      traces { database = "eu"  table = "spans"  trace_index_table = "spans_idx" }
      logs { enabled = false }
      metrics { table_prefix = "m" }
    }
  }
}
)";
  // The canonical form: one block, a section for each signal, one allowlist for the three.
  const std::string block = R"(
observability {
  service_allowlist = ["api*", "auth"]
  traces { enabled = true
    table = "t"
    max_lookback_minutes = 600 }
  logs { enabled = true
    body_search = "substring" }
  metrics { enabled = true }
}
)";
  {
    const AppConfig cfg = load(dir, block + hosts);
    CHECK_EQ(cfg.otel_defaults.traces.table, std::string("t"));
    CHECK_EQ(cfg.otel_defaults.traces.service_allowlist.size(), size_t(2));
    CHECK_EQ(cfg.otel_defaults.logs.body_search, std::string("substring"));
    CHECK(cfg.traces_on() && cfg.logs_on() && cfg.metrics_on());
    // A host that changes nothing has the settings of the block.
    const HostSpec& a = cfg.hosts[0];
    CHECK_EQ(a.otel.traces.table, std::string("t"));
    CHECK_EQ(a.otel.traces.database, std::string("otel"));
    CHECK(a.otel.logs.enabled && a.otel.metrics.enabled);
    CHECK_EQ(a.otel.traces.max_lookback_minutes, 600);
    // A host that overrides where its tables are (and nothing else): the rest is the block's.
    const HostSpec& b = cfg.hosts[1];
    CHECK_EQ(b.otel.traces.database, std::string("eu"));
    CHECK_EQ(b.otel.traces.table, std::string("spans"));
    CHECK_EQ(b.otel.traces.trace_index_table, std::string("spans_idx"));
    CHECK(!b.otel.logs.enabled);
    CHECK_EQ(b.otel.metrics.table_prefix, std::string("m"));
    CHECK_EQ(b.otel.metrics.database, std::string("otel"));
    CHECK_EQ(b.otel.traces.service_allowlist.size(), size_t(2));
    CHECK_EQ(b.otel.traces.max_lookback_minutes, 600);
  }
  {
    // MCP on: the entry of a host that has an mcp_uri carries its settings.
    const AppConfig cfg = load(dir, "mcp { enabled = true\n key { name = \"x\"\n secret = \"" + std::string(kSecret24) + "\"\n hosts = [\"a\"] } }\n" +
                                        block + hosts);
    CHECK_EQ(cfg.mcp_hosts.size(), size_t(1));
    CHECK_EQ(cfg.mcp_hosts[0].otel.traces.table, std::string("t"));
  }
  {
    // The top-level blocks of older configurations still work, and give the same result.
    const AppConfig cfg = load(dir, R"(
traces { enabled = true
  table = "t"
  max_lookback_minutes = 600
  service_allowlist = ["api*", "auth"] }
logs { enabled = true
  body_search = "substring" }
metrics { enabled = true }
)" + hosts);
    CHECK_EQ(cfg.hosts[0].otel.traces.table, std::string("t"));
    CHECK_EQ(cfg.hosts[0].otel.traces.service_allowlist.size(), size_t(2));
    CHECK_EQ(cfg.hosts[1].otel.traces.database, std::string("eu"));
    CHECK(!cfg.hosts[1].otel.logs.enabled);
  }
  {
    // A host may turn a signal on that the block leaves off, with its tables.
    const AppConfig cfg = load(dir, R"(
observability { traces { enabled = false } }
clickhouse {
  host { name = "a"
    runner_uri = "clickhouse://r@h:9000"
    system_uri = "clickhouse://s@h:9000"
    observability { traces { enabled = true  database = "x"  table = "y" } } }
  host { name = "b"
    runner_uri = "clickhouse://r@h2:9000"
    system_uri = "clickhouse://s@h2:9000" }
}
)");
    CHECK(cfg.hosts[0].otel.traces.enabled && !cfg.hosts[1].otel.traces.enabled);
    CHECK(cfg.traces_on());
    CHECK(!cfg.logs_on() && !cfg.metrics_on());
  }
  // Errors: a signal in two places, an unknown setting, a setting that a host cannot change, an empty table.
  CHECK(contains(load_error(dir, block + "traces { enabled = true }\n" + hosts), "keep observability.traces"));
  CHECK(contains(load_error(dir, block + "logs { enabled = true }\n" + hosts), "keep observability.logs"));
  CHECK(contains(load_error(dir, block + "metrics { enabled = true }\n" + hosts), "keep observability.metrics"));
  CHECK(contains(load_error(dir, "observability { service_allowlist = [\"a\"] }\ntraces { service_allowlist = [\"b\"] }\n" + hosts), "keep observability.service_allowlist"));
  CHECK(contains(load_error(dir, "observability { traces { service_allowlist = [\"a\"] } }\n" + hosts), "observability.traces: unknown attribute service_allowlist"));
  CHECK(contains(load_error(dir, "observability { bogus = 1 }\n" + hosts), "observability: unknown attribute bogus"));
  CHECK(contains(load_error(dir, "observability { extra { a = 1 } }\n" + hosts), "observability: unknown block extra"));
  const auto host_with = [](const std::string& inner) {
    return "clickhouse { host { name = \"a\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n observability { " + inner + " } } }";
  };
  CHECK(contains(load_error(dir, host_with("traces { search_limit = 5 }")), "clickhouse.host.observability.traces: unknown attribute search_limit"));
  CHECK(contains(load_error(dir, host_with("logs { body_search = \"off\" }")), "clickhouse.host.observability.logs: unknown attribute body_search"));
  CHECK(contains(load_error(dir, host_with("service_allowlist = [\"a\"]")), "clickhouse.host.observability: unknown attribute service_allowlist"));
  CHECK(contains(load_error(dir, host_with("extra { a = 1 }")), "clickhouse.host.observability: unknown block extra"));
  CHECK(contains(load_error(dir, "observability { traces { enabled = true } }\n" + host_with("traces { table = \"\" }")), "clickhouse.host a: observability.traces database and table cannot be empty"));
  CHECK(contains(load_error(dir, "observability { metrics { enabled = true } }\n" + host_with("metrics { table_prefix = \"\" }")), "metrics database and table_prefix cannot be empty"));
  // A table that the host leaves empty matters only when the signal is on for it.
  CHECK_EQ(load_error(dir, host_with("traces { table = \"\" }")), std::string(""));
}

// ---- the grants of the MCP user, tool by tool ---------------------------------------------------------------------

void test_grants(const std::string& dir) {
  const auto tool = [](const char* name) {
    const McpToolInfo* info = mcp_find_tool(name);
    CHECK(info != nullptr);
    return info;
  };
  // What a tool reads beyond the tables of the key.
  CHECK_EQ(mcp_tool_reads(*tool("explorer_functions")), unsigned(kMcpReadsFunctions));
  CHECK_EQ(mcp_tool_reads(*tool("traces_search")), unsigned(kMcpReadsTraces));
  CHECK_EQ(mcp_tool_reads(*tool("traces_logs")), unsigned(kMcpReadsTraces | kMcpReadsLogs));
  CHECK_EQ(mcp_tool_reads(*tool("logs_histogram")), unsigned(kMcpReadsLogs));
  CHECK_EQ(mcp_tool_reads(*tool("metrics_series")), unsigned(kMcpReadsMetrics));
  CHECK_EQ(mcp_tool_reads(*tool("search_traces")), unsigned(kMcpReadsTraces));
  CHECK_EQ(mcp_tool_reads(*tool("query_metric")), unsigned(kMcpReadsMetrics));
  CHECK_EQ(mcp_tool_reads(*tool("list_tables")), unsigned(kMcpReadsNone));
  CHECK_EQ(mcp_tool_reads(*tool("explorer_table_data")), unsigned(kMcpReadsNone));
  CHECK_EQ(mcp_tool_reads(*tool("system_overview")), unsigned(kMcpReadsNone));
  CHECK_EQ(mcp_tool_reads(*tool("run_query")), unsigned(kMcpReadsNone));

  // The tables come from the configuration of a host; a feature that is off reads nothing.
  OtelSettings cfg;
  CHECK(mcp_user_reads() == std::vector<std::string>{"system.documentation"});
  CHECK(mcp_system_reads(cfg, kMcpReadsAll).empty());
  cfg.traces.enabled = true;
  cfg.logs.enabled = true;
  cfg.metrics.enabled = true;
  const auto has = [](const std::vector<std::string>& list, const std::string& name) {
    return std::find(list.begin(), list.end(), name) != list.end();
  };
  const auto obs = mcp_observability_config(cfg);
  CHECK(mcp_data_tables(obs, kMcpReadsTraces) == std::vector<std::string>{"otel.otel_traces"});
  CHECK(mcp_data_tables(obs, kMcpReadsLogs) == std::vector<std::string>{"otel.otel_logs"});
  CHECK(mcp_data_tables(obs, kMcpReadsMetrics) == (std::vector<std::string>{"otel.otel_metrics_gauge", "otel.otel_metrics_sum", "otel.otel_metrics_histogram"}));
  CHECK(mcp_data_tables(obs, kMcpReadsTraces | kMcpReadsLogs).size() == 2);
  CHECK(mcp_data_tables(obs, kMcpReadsFunctions).empty() && mcp_data_tables(obs, kMcpReadsNone).empty());
  CHECK(mcp_data_tables(mcp_observability_config(OtelSettings()), kMcpReadsAll).empty());
  // The system user reads the OpenTelemetry tables, with the size and the skipping indices of Logs and Metrics, for the pages'
  // tools and the simple tools alike. The MCP user itself reads only the documentation of the functions.
  CHECK(mcp_system_reads(cfg, kMcpReadsTraces) == std::vector<std::string>{"otel.otel_traces"});
  const auto logs = mcp_system_reads(cfg, kMcpReadsLogs);
  CHECK(has(logs, "otel.otel_logs") && has(logs, "system.parts") && has(logs, "system.data_skipping_indices"));
  cfg.traces.database = "tel";
  CHECK(has(mcp_system_reads(cfg, kMcpReadsTraces), "tel.otel_traces"));
  // The tables of a host can differ from another's: the settings of each host decide.
  OtelSettings other = cfg;
  other.traces.database = "eu";
  other.traces.table = "spans";
  CHECK(has(mcp_system_reads(other, kMcpReadsTraces), "eu.spans") && !has(mcp_system_reads(other, kMcpReadsTraces), "tel.otel_traces"));
  other.traces.enabled = false;
  CHECK(mcp_system_reads(other, kMcpReadsTraces).empty());

  // The gaps: the tools that the missing grants take away, with who lacks them.
  HostAccess access;
  CHECK(mcp_tool_gaps(cfg, access).empty());  // not audited: no claim
  access.mcp_audited = true;
  access.mcp_user = "chdash_mcp";
  access.mcp_missing = {"SELECT ON system.documentation"};
  CHECK(mcp_tool_gaps(cfg, access).empty());  // audited but not connected: the caller says that
  access.mcp_connected = true;
  auto gaps = mcp_tool_gaps(cfg, access);
  CHECK_EQ(gaps.size(), size_t(1));
  CHECK_EQ(gaps[0].tool, std::string("explorer_functions"));
  CHECK_EQ(gaps[0].role, std::string("MCP user"));
  CHECK_EQ(gaps[0].user, std::string("chdash_mcp"));
  CHECK_EQ(gaps[0].grants[0], std::string("SELECT ON system.documentation"));
  // The tools of Traces, Logs and Metrics run with the system user: its grants decide, not the ones of the MCP user.
  access.mcp_missing = {"SELECT ON tel.otel_traces"};
  access.checked = true;
  access.system_user = "chdash_system";
  access.system_missing = {"SELECT ON system.parts"};
  gaps = mcp_tool_gaps(cfg, access);
  std::set<std::string> lost;
  for (const auto& gap : gaps) lost.insert(gap.tool);
  CHECK(lost.count("logs_search") && lost.count("metrics_catalog") && lost.count("traces_logs") && lost.count("logs_meta"));
  CHECK(!lost.count("traces_search") && !lost.count("explorer_functions") && !lost.count("list_tables"));
  for (const auto& gap : gaps) {
    if (gap.tool == "logs_search") CHECK(gap.role == "system user" && gap.user == "chdash_system");
  }
  // The simple tools read with the system user too: the grants of the MCP user on the otel tables do not matter.
  CHECK(lost.count("search_logs") && lost.count("query_metric"));  // system.parts is missing for the system user
  CHECK(!lost.count("search_traces") && !lost.count("get_trace") && !lost.count("list_services"));
  CHECK_EQ(mcp_grant_statement({"SELECT ON system.parts", "SELECT ON system.documentation"}, "chdash_mcp"),
           std::string("GRANT SELECT ON system.parts, system.documentation TO chdash_mcp;"));
  CHECK_EQ(mcp_grant_statement({"SELECT ON a.b"}, ""), std::string("GRANT SELECT ON a.b TO <user>;"));

  // A key made from the page asks the running server before it is stored (live_check); a key of the file or of
  // the configuration never does.
  McpStoreOptions options = store_options(dir + "/live.json");
  options.config_keys.clear();
  int asked = 0;
  options.context.live_check = [&](const McpKey& key) -> std::optional<McpValidationError> {
    ++asked;
    if (key.hosts.size() == 1 && key.hosts[0] == "stage") return McpValidationError{"hosts", "mcp_user_unavailable", "down"};
    for (const auto& name : key.tools) {
      if (name == "explorer_functions") return McpValidationError{"tools", "not_grantable", "no grant"};
    }
    return std::nullopt;
  };
  McpKeyStore store(options);
  const int64_t now = 1'800'000'000;
  auto refused = store.create(input_of(R"({"name":"a","hosts":["stage"],"tools":[],"databases":[]})"), now);
  CHECK_EQ(refused.status, 400);
  CHECK_EQ(refused.field, std::string("hosts"));
  CHECK_EQ(refused.reason, std::string("mcp_user_unavailable"));
  refused = store.create(input_of(R"({"name":"a","hosts":["prod"],"tools":["explorer_functions"],"databases":["*"]})"), now);
  CHECK_EQ(refused.reason, std::string("not_grantable"));
  CHECK_EQ(store.list().size(), size_t(0));
  CHECK_EQ(store.create(input_of(R"({"name":"a","hosts":["prod"],"tools":["list_tables"],"databases":[]})"), now).status, 201);
  CHECK_EQ(asked, 3);
  // The static checks come first: a bad name never reaches the server.
  CHECK_EQ(store.create(input_of(R"({"name":"Bad Name","hosts":["prod"],"tools":[],"databases":[]})"), now).status, 400);
  CHECK_EQ(asked, 3);
  // A file that holds such a key still loads: nothing is checked when it is read.
  McpStoreOptions reopened = store_options(dir + "/live.json");
  reopened.config_keys.clear();
  McpKeyStore again(reopened);
  CHECK_EQ(again.list().size(), size_t(1));
}

// ---- server hardening --------------------------------------------------------------------------

namespace {

httplib::Request request_with(std::initializer_list<std::pair<const char*, const char*>> headers, const char* method = "POST") {
  httplib::Request req;
  req.method = method;
  for (const auto& [name, value] : headers) req.headers.emplace(name, value);
  return req;
}

void test_random_identifiers() {
  std::set<std::string> seen;
  for (int i = 0; i < 2000; ++i) {
    const std::string id = random_uuid_v4();
    CHECK_EQ(id.size(), size_t{36});
    CHECK(id[8] == '-' && id[13] == '-' && id[18] == '-' && id[23] == '-');
    CHECK(id[14] == '4');
    CHECK(id[19] == '8' || id[19] == '9' || id[19] == 'a' || id[19] == 'b');
    CHECK(mcp_valid_secret(id));
    seen.insert(id);
  }
  CHECK_EQ(seen.size(), size_t{2000});
  const std::string hex = random_hex(16);
  CHECK_EQ(hex.size(), size_t{32});
  CHECK(hex.find_first_not_of("0123456789abcdef") == std::string::npos);
  CHECK(random_hex(8) != random_hex(8));
  CHECK_EQ(secure_random_bytes(0).size(), size_t{0});
  CHECK_EQ(secure_random_bytes(64).size(), size_t{64});
}

void test_browser_write_guard() {
  // No browser headers (a CLI, a script, the MCP API tools): accepted.
  CHECK(!is_cross_site_request(request_with({})));
  CHECK(!check_browser_write(request_with({{"Content-Type", "application/json"}, {"Content-Length", "2"}})));
  // The browser says where the request comes from.
  CHECK(!is_cross_site_request(request_with({{"Sec-Fetch-Site", "same-origin"}})));
  CHECK(!is_cross_site_request(request_with({{"Sec-Fetch-Site", " None "}})));
  CHECK(is_cross_site_request(request_with({{"Sec-Fetch-Site", "cross-site"}})));
  CHECK(is_cross_site_request(request_with({{"Sec-Fetch-Site", "same-site"}})));
  // Sec-Fetch-Site wins over Origin.
  CHECK(!is_cross_site_request(request_with({{"Sec-Fetch-Site", "same-origin"}, {"Origin", "https://evil.example"}, {"Host", "dash:8080"}})));
  // Without it, Origin must name this server (Host, or the first X-Forwarded-Host).
  CHECK(!is_cross_site_request(request_with({{"Origin", "http://Dash:8080"}, {"Host", "dash:8080"}})));
  CHECK(!is_cross_site_request(request_with({{"Origin", "https://dash.example.com"}, {"Host", "chdash:8080"},
                                             {"X-Forwarded-Host", "dash.example.com, proxy.local"}})));
  CHECK(is_cross_site_request(request_with({{"Origin", "https://evil.example"}, {"Host", "dash:8080"}})));
  CHECK(is_cross_site_request(request_with({{"Origin", "null"}, {"Host", "dash:8080"}})));
  CHECK(is_cross_site_request(request_with({{"Origin", "https://evil.example"}, {"Host", "dash:8080"}, {"X-Forwarded-Host", ""}})));
  // A body must be application/json (a page of another site cannot send it without a preflight).
  auto refusal = check_browser_write(request_with({{"Content-Type", "text/plain"}, {"Content-Length", "10"}}));
  CHECK(refusal && refusal->status == 415 && std::string(refusal->code) == "unsupported_media_type");
  refusal = check_browser_write(request_with({{"Content-Length", "10"}}));
  CHECK(refusal && refusal->status == 415);
  refusal = check_browser_write(request_with({{"Content-Type", "application/x-www-form-urlencoded"}, {"Transfer-Encoding", "chunked"}}));
  CHECK(refusal && refusal->status == 415);
  CHECK(!check_browser_write(request_with({{"Content-Type", "Application/JSON; charset=utf-8"}, {"Content-Length", "10"}})));
  // No body (a DELETE, an empty POST): no media type needed.
  CHECK(!check_browser_write(request_with({{"Content-Length", "0"}}, "DELETE")));
  CHECK(!check_browser_write(request_with({}, "DELETE")));
  refusal = check_browser_write(request_with({{"Sec-Fetch-Site", "cross-site"}, {"Content-Type", "application/json"}}));
  CHECK(refusal && refusal->status == 403 && std::string(refusal->code) == "cross_site_request");
}

void test_page_policy() {
  const std::string html =
      "<html><head><script>alert(1)</script>\n"
      "<script type=\"application/json\" id=\"chdashModules\">{\"a\":1}</script>\n"
      "<script src=\"static/app.js\"></script>\n"
      "<SCRIPT type='text/javascript'>\n  var a = 1;\n</SCRIPT>\n"
      "<scripts>not a script</scripts>\n"
      "</head></html>";
  const std::string policy = page_content_security_policy(html);
  CHECK(contains(policy, "script-src 'self' 'wasm-unsafe-eval' 'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=' "
                         "'sha256-wYD6gJuOAPxlJHFvhr2Zk0r9F+gmt8nwaf1uW8o5LTY=';"));
  CHECK(contains(policy, "frame-ancestors 'none'"));
  CHECK(contains(policy, "object-src 'none'"));
  CHECK(!contains(policy, "'unsafe-eval'"));
  CHECK(!contains(policy, "'unsafe-inline'; img-src") || contains(policy, "style-src 'self' 'unsafe-inline'"));
  // A page without an inline script gets the base policy.
  CHECK_EQ(page_content_security_policy("<p>x</p>"), std::string(kContentSecurityPolicy));
  // An unterminated script is not hashed.
  CHECK_EQ(page_content_security_policy("<script>x"), std::string(kContentSecurityPolicy));
  bool frame = false, sniff = false, referrer = false, policy_header = false;
  for (const auto& [name, value] : security_headers()) {
    frame = frame || (name == "X-Frame-Options" && value == "DENY");
    sniff = sniff || (name == "X-Content-Type-Options" && value == "nosniff");
    referrer = referrer || (name == "Referrer-Policy" && value == "same-origin");
    policy_header = policy_header || (name == "Content-Security-Policy" && value == kContentSecurityPolicy);
  }
  CHECK(frame && sniff && referrer && policy_header);
}

void test_asset_versions() {
  const std::string hash = "b9b85fc46d65b05c6e74a09fb7f1f1f0d3c23e4e83bcf36c2f5c3d48ef7d11ab";
  CHECK(asset_version_matches("b9b85fc46d", hash));
  CHECK(asset_version_matches("b9b85fc46d65", hash));
  CHECK(asset_version_matches(hash, hash));
  CHECK(!asset_version_matches("b9b85fc4", "c" + hash.substr(1)));
  CHECK(!asset_version_matches("b9b85fc", hash));     // too short to name a version
  CHECK(!asset_version_matches("B9B85FC46D", hash));  // lower case only
  CHECK(!asset_version_matches("anything", hash));
  CHECK(!asset_version_matches("", hash));
  CHECK(!asset_version_matches(hash + "00", hash));
}

void test_request_ids() {
  CHECK_EQ(request_id_for(request_with({{"X-Request-Id", "abc-123:x.y_z"}})), std::string("abc-123:x.y_z"));
  const std::string fresh = request_id_for(request_with({{"X-Request-Id", "bad id\n"}}));
  CHECK_EQ(fresh.size(), size_t{16});
  CHECK(request_id_for(request_with({})) != fresh);
  const std::string long_id(129, 'a');
  httplib::Request req;
  req.headers.emplace("X-Request-Id", long_id);
  CHECK_EQ(request_id_for(req).size(), size_t{16});
}

void test_log_lines() {
  const std::string line = format_log_line(LogLevel::Warn, "health.host_down",
      {{"host", "local"}, {"error", std::string("a \"quoted\"\nline")}, {"ping_ms", int64_t{-1}}, {"rows", uint64_t{3}},
       {"ok", false}, {"ms", 1.5}, {"nan", std::numeric_limits<double>::quiet_NaN()}}, 1789171200123);
  CHECK(!line.empty() && line.back() == '\n');
  CHECK(line.find('\n') == line.size() - 1);  // one line, whatever the values hold
  const auto doc = parse(line.substr(0, line.size() - 1));
  CHECK_EQ(std::string(doc["ts"].GetString()), std::string("2026-09-12T00:00:00.123Z"));
  CHECK_EQ(std::string(doc["level"].GetString()), std::string("warn"));
  CHECK_EQ(std::string(doc["event"].GetString()), std::string("health.host_down"));
  CHECK_EQ(std::string(doc["error"].GetString()), std::string("a \"quoted\"\nline"));
  CHECK_EQ(doc["ping_ms"].GetInt64(), int64_t{-1});
  CHECK_EQ(doc["rows"].GetUint64(), uint64_t{3});
  CHECK(doc["ok"].IsFalse());
  CHECK(doc["ms"].GetDouble() == 1.5);
  CHECK(doc["nan"].IsNull());
}

void test_metrics_text() {
  std::string out;
  prom_sample(out, "chdash_x", {{"route", "/a\\\"b\n"}, {"code", "200"}}, 2);
  CHECK_EQ(out, std::string("chdash_x{route=\"/a\\\\\\\"b\\n\",code=\"200\"} 2\n"));
  out.clear();
  prom_sample(out, "chdash_y", {}, 0.25);
  CHECK_EQ(out, std::string("chdash_y 0.25\n"));
  HttpMetrics metrics;
  metrics.request_started();
  metrics.request_started();
  CHECK_EQ(metrics.in_flight(), int64_t{2});
  metrics.request_answered("GET", "/api/hosts", 200, 0.003, true);
  metrics.request_answered("GET", "/api/hosts", 503, 0.3, true);
  metrics.request_answered("GET", "", 400, 0.0, false);
  CHECK_EQ(metrics.in_flight(), int64_t{0});
  out.clear();
  metrics.write(out);
  CHECK(contains(out, "chdash_http_requests_total{method=\"GET\",route=\"/api/hosts\",code=\"200\"} 1\n"));
  CHECK(contains(out, "chdash_http_requests_total{method=\"GET\",route=\"/api/hosts\",code=\"503\"} 1\n"));
  CHECK(contains(out, "chdash_http_requests_total{method=\"GET\",route=\"-\",code=\"400\"} 1\n"));
  // Buckets are cumulative: 0.003 s in every bucket, 0.3 s from 0.5 s on.
  CHECK(contains(out, "chdash_http_request_duration_seconds_bucket{method=\"GET\",route=\"/api/hosts\",le=\"0.005\"} 1\n"));
  CHECK(contains(out, "chdash_http_request_duration_seconds_bucket{method=\"GET\",route=\"/api/hosts\",le=\"0.5\"} 2\n"));
  CHECK(contains(out, "chdash_http_request_duration_seconds_bucket{method=\"GET\",route=\"/api/hosts\",le=\"+Inf\"} 2\n"));
  CHECK(contains(out, "chdash_http_request_duration_seconds_count{method=\"GET\",route=\"/api/hosts\"} 2\n"));
  CHECK(contains(out, "# TYPE chdash_http_request_duration_seconds histogram\n"));
}

void test_worker_group() {
  WorkerGroup group;
  CHECK(group.enter());
  CHECK(group.enter());
  CHECK_EQ(group.active(), size_t{2});
  std::thread late([&] {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    group.leave();
    group.leave();
  });
  CHECK(group.close_and_wait(std::chrono::milliseconds(5000)));
  late.join();
  CHECK_EQ(group.active(), size_t{0});
  CHECK(!group.enter());  // closed: no thread starts any more
  WorkerGroup stuck;
  CHECK(stuck.enter());
  CHECK(!stuck.close_and_wait(std::chrono::milliseconds(20)));
}

// The health runner ends at once on stop(): a sleeping ping thread (the longest interval) and the audit thread wake up,
// and one ping thread for each host means two hosts that refuse the connection are both checked in one interval.
void test_health_runner_stops_at_once() {
  HostSpec host;
  host.id = "unreachable";
  host.label = "unreachable";
  host.runner_uri = "clickhouse://nobody@127.0.0.1:1";
  host.system_uri = host.runner_uri;
  HostSpec other = host;
  other.id = "other";
  HealthSettings settings;
  settings.interval_ms = 600 * 1000;
  settings.timeout_ms = 100;
  HealthRunner runner({host, other}, settings);
  runner.start();
  const auto checked = [&] {
    const auto snapshot = runner.snapshot();
    return std::all_of(snapshot.hosts.begin(), snapshot.hosts.end(), [](const HostHealth& h) { return h.checked_at_ms > 0; });
  };
  for (int i = 0; i < 50 && !checked(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
  CHECK(checked());
  CHECK(!runner.all_healthy());
  CHECK_EQ(runner.healthy_count(), size_t{0});
  CHECK(!runner.snapshot().hosts.front().error.empty());
  // Down hosts are retried every second; a stop during the wait ends both threads at once.
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  const auto started = std::chrono::steady_clock::now();
  runner.stop();
  CHECK(std::chrono::steady_clock::now() - started < std::chrono::milliseconds(1500));
}

} // namespace

int main() {
  const std::string dir = make_temp_dir();
  test_scope();
  test_secrets_time_validation();
  {
    const std::string d = make_temp_dir();
    test_store(d);
  }
  test_store_startup_errors(make_temp_dir());
  test_usage(make_temp_dir());
  test_usage_cells(make_temp_dir());
  test_usage_overview();
  test_usage_overview_caps();
  test_usage_overview_check();
  test_usage_overview_while_counting();
  test_rate_limiter();
  test_sql_scanner();
  test_sql_quoting_and_types();
  test_sql_builder();
  test_protocol();
  test_tools();
  test_observability();
  test_api_tools();
  test_tool_support();
  test_config(dir);
  test_observability_config(dir);
  test_grants(make_temp_dir());
  test_random_identifiers();
  test_browser_write_guard();
  test_page_policy();
  test_asset_versions();
  test_request_ids();
  test_log_lines();
  test_metrics_text();
  test_worker_group();
  test_health_runner_stops_at_once();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
