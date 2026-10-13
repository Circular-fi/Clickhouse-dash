// Unit tests of the configuration file (src/config.cpp, src/config_schema.cpp, src/config_keys.def, src/hcl.cpp,
// src/ch_uri.cpp): the table of keys, the bounds, the errors that name the key, the derived values, the URIs of the hosts,
// and the HCL parser. No ClickHouse is needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_CONFIG_TESTS=ON
//        cmake --build build --target chdash_config_test
// Run:   ./build/chdash_config_test   (exit code 0 = every check passed)

#include "config.hpp"
#include "config_schema.hpp"
#include "ch_uri.hpp"
#include "hcl.hpp"

#include <unistd.h>

#include <cstdlib>
#include <fstream>
#include <iostream>
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

std::string dir;

void write_file(const std::string& path, const std::string& text) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  out << text;
}

const char* kHost = R"(
clickhouse {
  host {
    name = "h"
    runner_uri = "clickhouse://r:p@h:9000"
    system_uri = "clickhouse://s:p@h:9000"
  }
}
)";

// `hcl` and, unless it holds its own clickhouse block, one host.
AppConfig load(const std::string& hcl, bool with_host = true) {
  const std::string path = dir + "/chdash.hcl";
  write_file(path, with_host ? hcl + kHost : hcl);
  return load_config_from_file(path);
}

// The text of the error that a configuration gives, "" when it loads.
std::string error_of(const std::string& hcl, bool with_host = true) {
  try {
    load(hcl, with_host);
  } catch (const std::exception& e) {
    return e.what();
  }
  return "";
}

std::string block_text(const std::string& block, const std::string& key, const std::string& value) {
  // "observability.traces" is observability { traces { } }.
  std::vector<std::string> parts;
  std::stringstream stream(block);
  for (std::string part; std::getline(stream, part, '.');) parts.push_back(part);
  std::string open, close;
  for (const auto& part : parts) {
    open += part + " { ";
    close += " }";
  }
  return open + key + " = " + value + close + "\n";
}

// ---- the table ----

void test_the_table_is_sound() {
  std::set<std::string> seen;
  for (const auto& key : config::schema()) {
    const std::string name = key.block + "." + key.key;
    CHECK(seen.insert(name).second);
    CHECK(!key.doc.empty() && key.doc.back() == '.');
    CHECK(!key.type.empty());
    // The default that the table declares (and the reference prints) is the one that the code has.
    if (!key.read_by_code) CHECK_EQ(key.declared_default, key.def);
    if (key.type == "integer" && !key.read_by_code) {
      // "1 to 1024" or "0 or 1 to 1024": the default is inside.
      CHECK(!key.range.empty());
    }
  }
  CHECK(seen.size() > 120);
}

// Every number of the table: its two bounds load, a value beyond either stops the start with an error that names the key.
void test_the_bounds_of_every_number() {
  for (const auto& key : config::schema()) {
    if (key.read_by_code || key.type != "integer") continue;
    const std::string name = key.block + "." + key.key;
    std::string range = key.range;
    bool zero = false;
    if (range.rfind("0 or ", 0) == 0) {
      zero = true;
      range = range.substr(5);
    }
    const auto to = range.find(" to ");
    CHECK(to != std::string::npos);
    const long long lo = std::stoll(range.substr(0, to));
    const long long hi = std::stoll(range.substr(to + 4));
    // A bound can break a rule between two keys, which the table does not know (finish_config says it): the error then
    // names the other rule. The check here is that the table itself accepts the bound or names the key.
    const auto attempt = [&](long long value) { return error_of(block_text(key.block, key.key, std::to_string(value))); };
    // (A rule between two keys says "must be at most" or "must be at least": that one is not the bound of this key.)
    const auto own_bound = [&](const std::string& error) {
      return contains(error, name + " must be") && !contains(error, name + " must be at");
    };
    for (const long long ok : {lo, hi}) CHECK(!own_bound(attempt(ok)));
    const std::string below = attempt(lo - 1);
    const std::string above = attempt(hi + 1);
    if (zero && lo - 1 == 0) {
      CHECK(!own_bound(below));
    } else {
      CHECK(own_bound(below));
    }
    CHECK(own_bound(above));
    if (zero) CHECK(!own_bound(attempt(0)));
  }
}

void test_types_unknown_keys_and_enums() {
  CHECK(contains(error_of("server { worker_threads = \"x\" }"), "server.worker_threads must be an integer"));
  CHECK(contains(error_of("server { metrics = 1 }"), "server.metrics must be a boolean"));
  CHECK(contains(error_of("server { bogus = 1 }"), "server: unknown attribute bogus"));
  CHECK(contains(error_of("explorer { graph { bogus = 1 } }"), "explorer.graph: unknown attribute bogus"));
  CHECK(contains(error_of("bogus { }"), "unknown block bogus"));
  CHECK(contains(error_of("server { listen_port = 70000 }"), "server.listen_port must be between 1 and 65535"));
  CHECK(contains(error_of("query { describe_mode = \"sometimes\" }"), "query.describe_mode must be auto, always or never"));
  CHECK(contains(error_of("observability { logs { body_search = \"fuzzy\" } }"), "observability.logs.body_search must be token, substring, off"));
  CHECK(contains(error_of("logs { body_search = \"fuzzy\" }"), "logs.body_search must be token, substring, off"));  // an older block names itself
  CHECK(contains(error_of("export { archive_format = \"tar\" }"), "export.archive_format must be zip"));
  CHECK(contains(error_of("export { compression = true }"), "export.compression"));
  // A key of an older block that the new one does not have.
  CHECK(contains(error_of("observability { traces { service_allowlist = [\"a\"] } }"), "observability.traces: unknown attribute service_allowlist"));
  CHECK_EQ(error_of("traces { service_allowlist = [\"a\"] }"), std::string(""));
  CHECK(contains(error_of("traces { enabled = true }\nobservability { traces { enabled = true } }"), "keep observability.traces"));
}

void test_values_and_derived_settings() {
  const AppConfig defaults = load("");
  CHECK(defaults.server.worker_threads >= 8);  // 0 = automatic
  CHECK(defaults.server.worker_threads <= defaults.server.max_worker_threads);
  CHECK_EQ(defaults.listen, std::string("0.0.0.0:8080"));
  CHECK_EQ(defaults.query_options.describe_mode == QueryDescribeMode::Auto, true);
  CHECK_EQ(defaults.result_preview_row_limit, 10000);
  CHECK(defaults.server.max_body_bytes >= defaults.query_max_sql_bytes * 2);  // 0 = derived

  const AppConfig set = load("server { listen_host = \"127.0.0.1\"\n listen_port = 9090\n worker_threads = 3\n max_worker_threads = 5\n max_host_streams = 100 }\n"
                             "query { describe_mode = \"never\"\n sample_interval_ms = 10 }");
  CHECK_EQ(set.listen, std::string("127.0.0.1:9090"));
  CHECK_EQ(set.server.worker_threads, size_t(3));
  CHECK_EQ(set.server.max_host_streams, size_t(2));  // at most half of max_worker_threads
  CHECK(set.query_options.describe_mode == QueryDescribeMode::Never);
  CHECK_EQ(set.query_options.sample_interval_ms, 10);

  // Automatic never exceeds the maximum.
  CHECK_EQ(load("server { max_worker_threads = 2 }").server.worker_threads, size_t(2));

  // A rule between two keys.
  CHECK(contains(error_of("server { worker_threads = 10\n max_worker_threads = 5 }"), "server.max_worker_threads must be at least server.worker_threads"));
  CHECK(contains(error_of("query { sse_batch_bytes = 1048576\n sse_queue_max_bytes = 65536 }"), "query.sse_batch_bytes must be at most query.sse_queue_max_bytes"));
  CHECK(contains(error_of("system { max_lookback_days = 3\n disk_growth_days = 7 }"), "system.disk_growth_days must be at most system.max_lookback_days"));
  CHECK(contains(error_of("observability { traces { default_lookback_minutes = 600\n max_lookback_minutes = 60 } }"), "default_lookback_minutes must be at most"));
  CHECK(contains(error_of("query_library { enabled = true }"), "query_library.file is required"));
  CHECK(contains(error_of("query_library { max_file_bytes = 65536\n max_query_bytes = 100000 }"), "query_library.max_query_bytes must be at most"));

  // Several libraries: the first is the default one (it may leave its name out), the others are named; a block that is not
  // enabled is ignored.
  {
    const AppConfig single = load("query_library { enabled = true\n file = \"/a.json\" }");
    CHECK_EQ(single.query_libraries.size(), size_t(1));
    CHECK_EQ(single.query_libraries[0].name, std::string("default"));
    CHECK(!single.query_libraries[0].writable);
    const AppConfig many = load("query_library { enabled = true\n file = \"/a.json\"\n writable = true }\n"
                                "query_library { enabled = true\n name = \"runbooks\"\n file = \"/b.json\" }\n"
                                "query_library { enabled = false\n name = \"off\"\n file = \"/c.json\" }");
    CHECK_EQ(many.query_libraries.size(), size_t(2));
    CHECK_EQ(many.query_libraries[0].name, std::string("default"));
    CHECK(many.query_libraries[0].writable);
    CHECK_EQ(many.query_libraries[1].name, std::string("runbooks"));
    CHECK(!many.query_libraries[1].writable);
    CHECK(load("").query_libraries.empty());
    CHECK(contains(error_of("query_library { enabled = true\n file = \"/a.json\" }\nquery_library { enabled = true\n file = \"/b.json\" }"), "query_library.name is required"));
    CHECK(contains(error_of("query_library { enabled = true\n name = \"x\"\n file = \"/a.json\" }\nquery_library { enabled = true\n name = \"x\"\n file = \"/b.json\" }"), "duplicate query_library.name: x"));
    CHECK(contains(error_of("query_library { enabled = true\n file = \"/a.json\" }\nquery_library { enabled = true\n name = \"y\"\n file = \"/a.json\" }"), "used by two libraries"));
    CHECK_EQ(load("query_library { enabled = true\n name = \"Team \\u00e9quipe 1\"\n file = \"/a.json\" }").query_libraries[0].name, std::string("Team \xc3\xa9quipe 1"));
    CHECK(contains(error_of("query_library { enabled = true\n name = \" lead\"\n file = \"/a.json\" }"), "query_library.name must be 1 to 128 bytes"));
    CHECK(contains(error_of("query_library { enabled = true\n name = \"tab\\there\"\n file = \"/a.json\" }"), "query_library.name must be 1 to 128 bytes"));
    CHECK(contains(error_of("query_library { enabled = true\n file = \"/a.json\"\n label = \"L\" }"), "unknown attribute label"));
  }

  // The old clamps are errors now: nothing is changed silently.
  CHECK(contains(error_of("export { max_concurrent = 0 }"), "export.max_concurrent must be between 1 and 64, not 0"));
  CHECK(contains(error_of("query { sample_interval_ms = 1 }"), "query.sample_interval_ms must be between 10 and 1000"));
  CHECK(contains(error_of("health { timeout_ms = 10 }"), "health.timeout_ms must be between 100 and 60000"));
  CHECK(contains(error_of("query { describe_cache_entries = 10000 }"), "query.describe_cache_entries must be between 0 and 4096"));

  // The effective values hold every key, the derived ones as they apply.
  bool worker = false, listen = false, mode = false;
  for (const auto& [name, value] : config::effective_values(set)) {
    if (name == "server.worker_threads") worker = value == "3";
    if (name == "server.listen") listen = value == "127.0.0.1:9090";
    if (name == "query.describe_mode") mode = value == "never";
  }
  CHECK(worker && listen && mode);
}

// ---- the URIs of the hosts (ARCH-B-104) ----

std::string host_error(const std::string& runner_uri, const std::string& extra = "") {
  return error_of("clickhouse { host { name = \"u\"\n runner_uri = \"" + runner_uri + "\"\n system_uri = \"clickhouse://s@h:9000\"\n" + extra + " } }", false);
}

void test_uris() {
  CHECK_EQ(validate_clickhouse_uri("clickhouse://u:p@h:9000"), std::string(""));
  CHECK(contains(validate_clickhouse_uri("http://h"), "clickhouse://"));
  CHECK(contains(validate_clickhouse_uri("clickhouse://u@h:9000?verfy=0"), "unknown parameter verfy"));
  CHECK(contains(validate_clickhouse_uri("clickhouse://u@h:9000?compression=gzip"), "unsupported compression"));
  CHECK(contains(validate_clickhouse_uri("clickhouse://u:p@h:9000?password_file=/x"), "mutually exclusive"));
  CHECK(contains(validate_clickhouse_uri("clickhouse://u@h:9000?password_file=" + dir + "/none"), "cannot open password_file"));
  write_file(dir + "/pw", "secret\n");
  CHECK_EQ(validate_clickhouse_uri("clickhouse://u@h:9000?password_file=" + dir + "/pw"), std::string(""));
  CHECK_EQ(validate_clickhouse_uri("clickhouse://u@h:9000?secure=1&verify=0&ca=/x&ca_dir=/y&sni=0&compression=zstd"), std::string(""));
  // The port of TLS is 9440 when the URI names none.
  std::string err;
  CHECK_EQ(parse_clickhouse_uri("clickhouse://u@h?secure=1", &err)->port, uint16_t(9440));
  CHECK_EQ(parse_clickhouse_uri("clickhouse://u@h?secure=0", &err)->port, uint16_t(9000));
  CHECK_EQ(parse_clickhouse_uri("clickhouse://u@h:9441?secure=1", &err)->port, uint16_t(9441));
  CHECK_EQ(parse_clickhouse_uri("clickhouse://u@[::1]?secure=1", &err)->port, uint16_t(9440));

  // The start says which host and which field.
  CHECK(contains(host_error("clickhouse://u@h:9000?verfy=0"), "clickhouse.host u: runner_uri: unknown parameter verfy"));
  CHECK(contains(host_error("clickhouse://u@h:9000", "mcp_uri = \"clickhouse://m@h:9000?x=1\"\n"), "clickhouse.host u: mcp_uri: unknown parameter x"));
  CHECK(contains(host_error("clickhouse://u@h:9000", "password_file = \"" + dir + "/none\"\n"), "cannot open password_file"));

  // A rotated password is read at the next check, not before (the file is read again when its time or size changes).
  write_file(dir + "/pw2", "one\n");
  const auto first = client_options_from_uri("clickhouse://u@h:9000?password_file=" + dir + "/pw2", std::chrono::milliseconds(10),
                                              std::chrono::milliseconds(10), std::chrono::milliseconds(10), &err);
  CHECK(first && first->password == "one");
  write_file(dir + "/pw2", "second\n");
  const auto second = client_options_from_uri("clickhouse://u@h:9000?password_file=" + dir + "/pw2", std::chrono::milliseconds(10),
                                               std::chrono::milliseconds(10), std::chrono::milliseconds(10), &err);
  CHECK(second && second->password == "second");
  CHECK(!client_options_from_uri("clickhouse://u@h:9000?bogus=1", std::chrono::milliseconds(10), std::chrono::milliseconds(10),
                                 std::chrono::milliseconds(10), &err));
}

// ---- the HCL parser (ARCH-B-105) ----

std::string hcl_error(const std::string& text) {
  try {
    parse_hcl(text);
  } catch (const HclParseError& e) {
    return e.what();
  }
  return "";
}

void test_hcl() {
  const HclObject object = parse_hcl("# one\n// two\n/* three\n four */ a = 1\nb = \"x\\u00e9\\U0001F600\\n\"\nc = true\nd = [\"x\", \"y\",]\nblk { e = -5 }\nblk { f = 6 }\n");
  CHECK_EQ(object.attrs.at("a").as_int(), int64_t(1));
  CHECK_EQ(object.attrs.at("b").as_string(), std::string("x\xc3\xa9\xf0\x9f\x98\x80\n"));
  CHECK(object.attrs.at("c").as_bool());
  CHECK_EQ(object.attrs.at("d").as_string_list().size(), size_t(2));
  CHECK_EQ(object.blocks.at("blk").size(), size_t(2));
  CHECK_EQ(object.blocks.at("blk")[0].attrs.at("e").as_int(), int64_t(-5));

  // The place of an error is a line and a column.
  CHECK(contains(hcl_error("a = 1\nb = ?\n"), "line 2, column 5"));
  CHECK(contains(hcl_error("a = 1\n\n  c = \"x\n"), "a string cannot hold a line break"));
  CHECK(contains(hcl_error("a = \"x"), "unterminated string at line 1, column 5"));
  CHECK(contains(hcl_error("a = 1\na = 2"), "duplicate attribute 'a'"));
  // Unknown escapes and what the subset leaves out say so.
  CHECK(contains(hcl_error("a = \"\\q\""), "unknown escape \\q"));
  CHECK(contains(hcl_error("a = \"\\u12\""), "unicode escape needs 4 hexadecimal digits"));
  CHECK(contains(hcl_error("a = \"\\uD800\""), "names no character"));
  CHECK(contains(hcl_error("host \"x\" { }"), "block labels are not supported"));
  CHECK(contains(hcl_error("a = 1.5"), "only whole decimal numbers"));
  CHECK(contains(hcl_error("a = 1_000"), "only whole decimal numbers"));
  CHECK(contains(hcl_error("a = 10ms"), "only whole decimal numbers"));
  CHECK(contains(hcl_error("a = <<EOF\nx\nEOF\n"), "heredoc strings are not supported"));
  CHECK(contains(hcl_error("/* open"), "unterminated /* comment"));
  CHECK(contains(hcl_error("a = 99999999999999999999"), "invalid int64"));
  // Deep nesting is refused, not recursed into.
  std::string deep;
  for (int i = 0; i < 40; ++i) deep += "b { ";
  CHECK(contains(hcl_error(deep), "levels deep"));
  std::string fine;
  for (int i = 0; i < 16; ++i) fine += "b { ";
  for (int i = 0; i < 16; ++i) fine += "} ";
  CHECK_EQ(hcl_error(fine), std::string(""));
}

} // namespace

int main() {
  char templ[] = "/tmp/chdash-config-XXXXXX";
  if (!::mkdtemp(templ)) {
    std::perror("mkdtemp");
    return 2;
  }
  dir = templ;
  test_the_table_is_sound();
  test_the_bounds_of_every_number();
  test_types_unknown_keys_and_enums();
  test_values_and_derived_settings();
  test_uris();
  test_hcl();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
