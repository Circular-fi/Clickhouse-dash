// Unit tests of the MCP server side: scopes, keys and their file, the rate limit, the SQL
// scanner and builder, the protocol (with a fake backend), the tools (with a fake database)
// and the startup errors of the mcp { } configuration block. No ClickHouse needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_MCP_TESTS=ON
//        cmake --build build --target chdash_mcp_test
// Run:   ./build/chdash_mcp_test   (exit code 0 = every check passed)
// The Python harness (test_mcp_contract.py) runs it when MCP_TEST_BINARY points at it.

#include "config.hpp"
#include "mcp_keys.hpp"
#include "mcp_protocol.hpp"
#include "mcp_scope.hpp"
#include "mcp_sql.hpp"
#include "mcp_tools.hpp"

#include <rapidjson/document.h>

#include <sys/stat.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
#include <set>
#include <sstream>
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
  CHECK_EQ(mcp_effective_tools({"*"}, {"otel"}).size(), size_t(11));
  CHECK_EQ(mcp_effective_tools({"*"}, {"*"}).size(), size_t(13));
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
  CHECK(a.size() >= kMcpSecretMinBytes);
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
    k.hosts = {"*"};
    CHECK_EQ(reason(k), std::string("ok"));
    k.hosts = {};
    CHECK_EQ(reason(k), std::string("ok"));  // empty = denied, still a valid key
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
  CHECK(!mcp_parse_key_input(R"({"name":"a","hosts":["prod"],"tools":["*"],"databases":["*"],"max_rows":null,"description":"ignored","expires_at":"2027-01-01","enabled":false,"extra":1})", true, &in));
  CHECK(in.name && *in.name == "a");
  CHECK(in.max_rows_set && !in.max_rows);
  CHECK(in.enabled && !*in.enabled);
  const auto input_error = [](const char* body, bool creating) {
    McpKeyInput x;
    const auto err = mcp_parse_key_input(body, creating, &x);
    return err ? err->field + ":" + err->reason : std::string("ok");
  };
  CHECK_EQ(input_error("not json", true), std::string(":invalid_json"));
  CHECK_EQ(input_error("[]", true), std::string(":invalid_json"));
  CHECK_EQ(input_error("{}", true), std::string("name:required"));
  CHECK_EQ(input_error(R"({"name":"a"})", true), std::string("hosts:required"));
  CHECK_EQ(input_error(R"({"name":"a","hosts":[]})", true), std::string("tools:required"));
  CHECK_EQ(input_error(R"({"name":"a","hosts":[],"tools":[]})", true), std::string("databases:required"));
  CHECK_EQ(input_error("{}", false), std::string("ok"));
  CHECK_EQ(input_error(R"({"name":3})", false), std::string("name:type"));
  CHECK_EQ(input_error(R"({"hosts":"prod"})", false), std::string("hosts:type"));
  CHECK_EQ(input_error(R"({"hosts":[1]})", false), std::string("hosts:type"));
  CHECK_EQ(input_error(R"({"max_rows":"5"})", false), std::string("max_rows:type"));
  // Fields that no longer exist are ignored, like any unknown field.
  CHECK_EQ(input_error(R"({"expires_at":"soon","description":5})", false), std::string("ok"));
  CHECK_EQ(input_error(R"({"enabled":"yes"})", false), std::string("enabled:type"));
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
  o.config_keys.push_back(config_key("cfg-key", "config-secret-0123456789abcdef"));
  return o;
}

McpKeyInput input_of(const std::string& body, bool creating = true) {
  McpKeyInput in;
  const auto err = mcp_parse_key_input(body, creating, &in);
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
    CHECK_EQ(store.list()[0].key.source, std::string("config"));
    CHECK_EQ(store.list()[0].key.id, std::string("cfg-key"));
    CHECK_EQ(store.list()[0].key.secret_hint, std::string(""));

    auto created = store.create(input_of(kNewKey), now);
    CHECK_EQ(created.status, 201);
    CHECK(created.key.has_value());
    CHECK_EQ(created.key->id.size(), size_t(15));
    CHECK_EQ(created.key->id.substr(0, 3), std::string("ui_"));
    CHECK_EQ(created.key->source, std::string("ui"));
    CHECK_EQ(created.secret.size(), size_t(36));
    CHECK_EQ(created.key->secret_hint, created.secret.substr(0, 8));
    CHECK_EQ(created.key->created_at.value_or(0), now);

    // The file: version 1, the hash that authenticates, the secret that the page shows (this file only, mode 0600).
    CHECK(::access(file.c_str(), F_OK) == 0);
    struct stat st;
    CHECK(::stat(file.c_str(), &st) == 0 && (st.st_mode & 0777) == 0600);
    const std::string text = read_file(file);
    CHECK(contains(text, created.secret));
    CHECK(contains(text, mcp_hash_hex(mcp_hash_secret(created.secret))));
    CHECK(!contains(text, "config-secret"));  // config keys are never written
    CHECK(!contains(text, "cfg-key"));
    const auto doc = parse(text);
    CHECK_EQ(doc["version"].GetInt(), 1);
    CHECK_EQ(doc["keys"].Size(), 1u);

    // Authentication by the secret; the config key too.
    auto auth = store.authenticate(created.secret, now + 10);
    CHECK(auth.status == McpKeyStore::AuthStatus::Ok);
    CHECK_EQ(auth.key.id, created.key->id);
    CHECK(store.authenticate("config-secret-0123456789abcdef", now).status == McpKeyStore::AuthStatus::Ok);
    CHECK(store.authenticate("", now).status == McpKeyStore::AuthStatus::Missing);
    CHECK(store.authenticate("chm_nope", now).status == McpKeyStore::AuthStatus::Unknown);
    CHECK(store.authenticate(std::string(600, 'x'), now).status == McpKeyStore::AuthStatus::Unknown);
    const auto listed = store.list();
    CHECK_EQ(listed.size(), size_t(2));
    CHECK_EQ(listed[1].last_used_at.value_or(0), now + 10);  // in memory, not in the file
    CHECK(!contains(read_file(file), "last_used"));

    // Names and secrets are unique across both sources.
    CHECK_EQ(store.create(input_of(kNewKey), now).error, std::string("name_taken"));
    CHECK_EQ(store.create(input_of(R"({"name":"cfg-key","hosts":[],"tools":[],"databases":[]})"), now).status, 409);

    // Validation errors keep the contract's codes.
    auto bad = store.create(input_of(R"({"name":"x","hosts":["nope"],"tools":[],"databases":[]})"), now);
    CHECK_EQ(bad.status, 400);
    CHECK_EQ(bad.error, std::string("validation"));
    CHECK_EQ(bad.field, std::string("hosts"));
    CHECK_EQ(bad.reason, std::string("unknown_host"));
    bad = store.create(input_of(R"({"name":"x","hosts":[],"tools":["run_query"],"databases":["otel"]})"), now);
    CHECK_EQ(bad.reason, std::string("needs_all_data"));

    // The store keeps the secret, so the page can show it again; the key says so.
    CHECK_EQ(created.key->secret, created.secret);
    CHECK_EQ(created.key->secret_hint, created.secret.substr(0, 8));
    const auto shown = store.reveal(created.key->id);
    CHECK_EQ(shown.status, 200);
    CHECK_EQ(shown.secret, created.secret);
    CHECK_EQ(store.reveal("ui_000000000000").error, std::string("not_found"));
    // A config key from secret_sha256 has no secret to show.
    CHECK_EQ(store.reveal("cfg-key").error, std::string("secret_unavailable"));
    CHECK_EQ(store.reveal("cfg-key").status, 404);

    // Update: any field; the secret stays the same; the disabled state.
    const std::string id = created.key->id;
    auto updated = store.update(id, input_of(R"({"enabled":false,"max_rows":10})", false), now + 20);
    CHECK_EQ(updated.status, 200);
    CHECK(!updated.key->enabled);
    CHECK_EQ(updated.key->max_rows.value_or(0), int64_t(10));
    CHECK_EQ(store.reveal(id).secret, created.secret);
    CHECK(store.authenticate(created.secret, now + 30).status == McpKeyStore::AuthStatus::Disabled);
    updated = store.update(id, input_of(R"({"enabled":true})", false), now + 20);
    updated = store.update(id, input_of(R"({"name":"renamed"})", false), now + 20);
    CHECK(store.authenticate(created.secret, now + 30).status == McpKeyStore::AuthStatus::Ok);
    CHECK_EQ(store.update(id, input_of(R"({"name":"cfg-key"})", false), now).error, std::string("name_taken"));
    CHECK_EQ(store.update(id, input_of(R"({"max_rows":5000})", false), now).reason, std::string("range"));
    CHECK_EQ(store.update("ui_000000000000", input_of("{}", false), now).error, std::string("not_found"));
    CHECK_EQ(store.update("cfg-key", input_of("{}", false), now).error, std::string("config_key"));
    CHECK_EQ(store.update("cfg-key", input_of("{}", false), now).status, 409);

    // Rotation: the old secret stops working at once.
    const auto rotated = store.rotate(id, now + 40);
    CHECK_EQ(rotated.status, 200);
    CHECK(rotated.secret != created.secret);
    CHECK(store.authenticate(created.secret, now + 41).status == McpKeyStore::AuthStatus::Unknown);
    CHECK(store.authenticate(rotated.secret, now + 41).status == McpKeyStore::AuthStatus::Ok);
    CHECK_EQ(store.reveal(id).secret, rotated.secret);
    CHECK_EQ(store.rotate("cfg-key", now).error, std::string("config_key"));
    CHECK_EQ(store.rotate("ui_000000000000", now).error, std::string("not_found"));
    const std::string second_secret = rotated.secret;

    // A restart reads the same keys back; the hash decides who gets in, the stored secret is what the page shows.
    McpKeyStore again(store_options(file));
    CHECK_EQ(again.list().size(), size_t(2));
    CHECK_EQ(again.reveal(id).secret, second_secret);
    CHECK(read_file(file).find(second_secret) != std::string::npos);
    CHECK(again.authenticate(second_secret, now).status == McpKeyStore::AuthStatus::Ok);
    CHECK(again.authenticate(created.secret, now).status == McpKeyStore::AuthStatus::Unknown);
    CHECK_EQ(again.list()[1].key.name, std::string("renamed"));

    // A failed write restores the memory and answers storage_error.
    const std::string before = read_file(file);
    const std::string moved = dir + "-moved";
    CHECK(::rename(dir.c_str(), moved.c_str()) == 0);
    const auto failed = store.create(input_of(R"({"name":"later","hosts":[],"tools":[],"databases":[]})"), now);
    CHECK_EQ(failed.status, 500);
    CHECK_EQ(failed.error, std::string("storage_error"));
    CHECK_EQ(store.list().size(), size_t(2));
    CHECK_EQ(store.update(id, input_of(R"({"max_rows":3})", false), now).error, std::string("storage_error"));
    CHECK_EQ(store.list()[1].key.max_rows.value_or(0), int64_t(10));
    CHECK_EQ(store.remove(id).error, std::string("storage_error"));
    CHECK_EQ(store.list().size(), size_t(2));
    CHECK_EQ(store.rotate(id, now).error, std::string("storage_error"));
    CHECK(store.authenticate(second_secret, now).status == McpKeyStore::AuthStatus::Ok);
    CHECK(::rename(moved.c_str(), dir.c_str()) == 0);
    CHECK_EQ(read_file(file), before);

    // Delete.
    const auto removed = store.remove(id);
    CHECK_EQ(removed.status, 200);
    CHECK_EQ(store.list().size(), size_t(1));
    CHECK(store.authenticate(second_secret, now).status == McpKeyStore::AuthStatus::Unknown);
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
    CHECK(store.authenticate("config-secret-0123456789abcdef", now).status == McpKeyStore::AuthStatus::Ok);
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
    CHECK(ro.authenticate(made.secret, now).status == McpKeyStore::AuthStatus::Ok);
    CHECK_EQ(ro.create(input_of(kNewKey), now).error, std::string("manage_disabled"));
    CHECK_EQ(ro.create(input_of(kNewKey), now).status, 403);
    CHECK_EQ(ro.update(made.key->id, input_of("{}", false), now).error, std::string("manage_disabled"));
    CHECK_EQ(ro.rotate(made.key->id, now).error, std::string("manage_disabled"));
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
    o.config_keys.push_back(config_key("ci-bot", "another-secret-0123456789abcdef"));
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
    // A file written before the secret was kept: the key loads and works, the page has no secret to show.
    const auto doc = parse(read_file(good));
    const std::string hash = doc["keys"][0]["secret_sha256"].GetString();
    const std::string body = R"({"version":1,"keys":[{"id":"ui_0a1b2c3d4e5f","name":"old","secret_sha256":")" + hash +
                             R"(","secret_hint":"chm_","hosts":["prod"],"tools":["*"],"databases":["*"]}]})";
    const std::string legacy = dir + "/legacy.json";
    write_file(legacy, body);
    McpStoreOptions o = store_options(legacy);
    o.config_keys.clear();
    McpKeyStore store(o);
    CHECK_EQ(store.reveal("ui_0a1b2c3d4e5f").error, std::string("secret_unavailable"));
    CHECK(!store.list()[0].key.secret.size());

    // A secret that is not the one of its hash stops the store: it would show a key that does not work.
    std::string wrong = body;
    wrong.insert(wrong.find("\"secret_hint\""), R"("secret":"chm_not-the-secret",)");
    write_file(legacy, wrong);
    threw = false;
    try {
      McpKeyStore broken(o);
    } catch (const std::exception& e) {
      threw = contains(e.what(), "does not match secret_sha256");
    }
    CHECK(threw);
  }
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
  CHECK_EQ(mcp_quote_identifier("a"), std::string("`a`"));
  CHECK_EQ(mcp_quote_identifier("a`b"), std::string("`a\\`b`"));
  CHECK_EQ(mcp_quote_identifier("a\\b"), std::string("`a\\\\b`"));
  CHECK_EQ(mcp_quote_string("abc"), std::string("'abc'"));
  CHECK_EQ(mcp_quote_string("o'rei\\lly"), std::string("'o\\'rei\\\\lly'"));
  CHECK_EQ(mcp_quote_string("a\nb\tc\rd"), std::string("'a\\nb\\tc\\rd'"));
  CHECK_EQ(mcp_quote_string(std::string("a\0b", 3)), std::string("'a\\0b'"));
  CHECK_EQ(mcp_quote_string("a\x01" "b"), std::string("'a\\x01b'"));
  CHECK_EQ(mcp_quote_string("' OR 1=1 --"), std::string("'\\' OR 1=1 --'"));
  CHECK_EQ(mcp_quote_string(""), std::string("''"));

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
  CHECK_EQ(names(all).size(), size_t(13));
  CHECK_EQ(names(narrow).size(), size_t(11));
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

  // The scope of the key decides which tables the tools read.
  {
    const McpKey other = a_key({"*"}, {"analytics"});
    const size_t before = db.calls.size();
    for (const char* tool : {"list_services", "search_traces", "search_logs", "list_metrics"}) {
      CHECK_EQ(id(call(tools, other, tool, "{}")), std::string("table_not_allowed"));
    }
    CHECK_EQ(id(call(tools, other, "get_trace", R"({"trace_id":"0af7651916cd43dd8448eb211c80319c"})")), std::string("table_not_allowed"));
    CHECK_EQ(id(call(tools, other, "query_metric", R"({"metric":"up"})")), std::string("table_not_allowed"));
    CHECK_EQ(db.calls.size(), before);  // nothing was sent to ClickHouse
    const McpKey one_table = a_key({"*"}, {"otel.otel_logs"});
    CHECK_EQ(id(call(tools, one_table, "search_traces", "{}")), std::string("table_not_allowed"));
    call(tools, one_table, "search_logs", "{}");
    CHECK(contains(db.calls.back().sql, "`otel`.`otel_logs`"));
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

const char* kSecret24 = "0123456789abcdef01234567";

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
  write_file(secret_file, std::string("  file-secret-0123456789abcdefghij \r\n\n"));
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
    enabled = false
  }
  key {
    name = "b"
    secret_file = ")" + secret_file + R"("
    hosts = ["*"]
    tools = ["*"]
    databases = ["*"]
  }
  key {
    name = "c"
    secret_sha256 = ")" + mcp_hash_hex(mcp_hash_secret("sha-secret-0123456789abcdefghij")) + R"("
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
    CHECK(!cfg.mcp.keys[0].enabled);
    CHECK_EQ(cfg.mcp.keys[0].secret, std::string(kSecret24));
    CHECK_EQ(cfg.mcp.keys[1].secret, std::string("file-secret-0123456789abcdefghij"));
    CHECK(cfg.mcp.keys[2].secret.empty());
    CHECK(cfg.mcp.keys[1].secret_hash == mcp_hash_secret("file-secret-0123456789abcdefghij"));  // trimmed
    CHECK(cfg.mcp.keys[2].secret_hash == mcp_hash_secret("sha-secret-0123456789abcdefghij"));
    CHECK(::access(storage.c_str(), F_OK) != 0);  // loading the config never creates the file
  }
  // mcp.enabled = false skips the cross checks but keeps the shape rules.
  CHECK_EQ(load_error(dir, "mcp { enabled = false }\n" + hosts), std::string(""));
  CHECK(!load(dir, "mcp { enabled = false }\n" + hosts).mcp.enabled);
  CHECK(contains(load_error(dir, "mcp { enabled = false\n key { name = \"x\" } }\n" + hosts), "exactly one of"));

  // The seven startup errors.
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
  // 4. two keys with the same name or the same secret (config and file included).
  const auto key = [](const std::string& name, const std::string& secret_attr, const std::string& tools = "[\"*\"]", const std::string& databases = "[\"*\"]", const std::string& hosts_attr = "[\"prod\"]") {
    return "key {\n name = \"" + name + "\"\n " + secret_attr + "\n hosts = " + hosts_attr + "\n tools = " + tools + "\n databases = " + databases + "\n }\n";
  };
  const std::string s1 = "secret = \"" + std::string(kSecret24) + "\"";
  const std::string s2 = "secret = \"another-0123456789abcdefghij\"";
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1) + key("x", s2) + "}\n" + hosts), "two keys have the name x"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1) + key("y", s1) + "}\n" + hosts), "same secret"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n" + key("x", s1) + key("y", "secret_sha256 = \"" + mcp_hash_hex(mcp_hash_secret(kSecret24)) + "\"") + "}\n" + hosts), "same secret"));
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
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\" } }\n" + hosts), "exactly one of secret, secret_file and secret_sha256"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n secret_file = \"/x\" } }\n" + hosts), "exactly one of"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n secret_sha256 = \"00\" } }\n" + hosts), "exactly one of"));

  // The other rules of a key.
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"short\"") + "}\n" + hosts), "at least 24 bytes"));
  CHECK_EQ(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"" + std::string(24, 'a') + "\"") + "}\n" + hosts), std::string(""));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret = \"" + std::string(23, 'a') + "\"") + "}\n" + hosts), "at least 24 bytes"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret_sha256 = \"zz\"") + "}\n" + hosts), "64 hexadecimal"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret_file = \"" + dir + "/no-such-file\"") + "}\n" + hosts), "secret_file"));
  write_file(dir + "/short-secret", "tiny\n");
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("x", "secret_file = \"" + dir + "/short-secret\"") + "}\n" + hosts), "at least 24 bytes"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("ui_reserved", s1) + "}\n" + hosts), "ui_"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n " + key("Bad Name", s1) + "}\n" + hosts), "name"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { " + s1 + " } }\n" + hosts), "name is required"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n max_rows = 5000 hosts = [\"prod\"] } }\n" + hosts), "max_rows"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n timeout_seconds = 31 hosts = [\"prod\"] } }\n" + hosts), "timeout_seconds"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n expires_at = \"someday\" } }\n" + hosts), "expires_at"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n key { name = \"x\"\n " + s1 + "\n databases = [\"a b\"] } }\n" + hosts), "databases"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n max_rows = 0\n " + key("x", s1) + "}\n" + hosts), "mcp.max_rows"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n query_timeout_seconds = 99999\n " + key("x", s1) + "}\n" + hosts), "query_timeout_seconds"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n allowed_origins = [\"*\"]\n " + key("x", s1) + "}\n" + hosts), "allowed_origins"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n allowed_origins = [\"example.com\"]\n " + key("x", s1) + "}\n" + hosts), "allowed_origins"));
  CHECK(contains(load_error(dir, "mcp { enabled = true\n allowed_origins = [\"https://a/b\"]\n " + key("x", s1) + "}\n" + hosts), "allowed_origins"));

  // clickhouse.host: the MCP identity is separate.
  {
    const AppConfig cfg = load(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n password_file = \"/runner-pw\"\n mcp_uri = \"clickhouse://m:pw@h:9000\" } }");
    CHECK_EQ(cfg.hosts[0].mcp_uri, std::string("clickhouse://m:pw@h:9000"));  // the password is in the URI; password_file never applies
    CHECK(contains(cfg.hosts[0].runner_uri, "password_file="));
    const AppConfig no_mcp = load(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n password_file = \"/runner-pw\" } }");
    CHECK_EQ(no_mcp.hosts[0].mcp_uri, std::string(""));
    CHECK(contains(load_error(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n mcp_password_file = \"/x\" } }"), "unknown attribute mcp_password_file"));
    CHECK(contains(load_error(dir, "clickhouse { host { name = \"p\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n mcp_uri = \"http://x\" } }"), "mcp_uri"));
  }
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
  test_rate_limiter();
  test_sql_scanner();
  test_sql_quoting_and_types();
  test_sql_builder();
  test_protocol();
  test_tools();
  test_observability();
  test_config(dir);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
