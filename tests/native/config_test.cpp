// This file has unit tests of the configuration file (src/config.cpp, src/config_schema.cpp, src/config_keys.def, src/hcl.cpp,
// src/ch_uri.cpp). The tests check the table of keys, the bounds, the errors that name the key, the derived values, the URIs of the hosts,
// and the HCL parser. No ClickHouse is needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_CONFIG_TESTS=ON
//        cmake --build build --target chdash_config_test
// Run:   ./build/chdash_config_test   (exit code 0 = every check passed)

#include "config.hpp"
#include "config_schema.hpp"
#include "ch_uri.hpp"
#include "hcl.hpp"
#include "mcp_usage_store.hpp"

#include <sys/stat.h>
#include <unistd.h>

#include <cstdlib>
#include <fstream>
#include <iostream>
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

std::string dir;

// Every configuration file requires the access block (docs/access.md). A configuration in these tests that does not test
// it gets the open mode. The tests of the access block write their own access block.
const char* kOpenAccess = "\naccess {\n  mode = \"open\"\n}\n";

void write_file(const std::string& path, const std::string& text) {
  std::ofstream out(path, std::ios::binary | std::ios::trunc);
  const bool config = path.size() > 4 && path.compare(path.size() - 4, 4, ".hcl") == 0;
  out << text << (config && text.find("access {") == std::string::npos ? kOpenAccess : "");
}

const char* kHost = R"(
clickhouse {
  host {
    name = "h"
    runner_uri = "clickhouse://r@h:9000"
    system_uri = "clickhouse://s@h:9000"
  }
}
)";

// This adds the `hcl` text and one host, unless the text holds its own clickhouse block.
AppConfig load(const std::string& hcl, bool with_host = true) {
  const std::string path = dir + "/chdash.hcl";
  write_file(path, with_host ? hcl + kHost : hcl);
  return load_config_from_file(path);
}

// This gives the text of the error of a configuration. The text is "" when the configuration loads.
std::string error_of(const std::string& hcl, bool with_host = true) {
  try {
    load(hcl, with_host);
  } catch (const std::exception& e) {
    return e.what();
  }
  return "";
}

std::string block_text(const std::string& block, const std::string& key, const std::string& value) {
  // "observability.traces" means observability { traces { } }.
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
    // The default that the table declares is the one that the code has. The reference prints the same default.
    if (!key.read_by_code) CHECK_EQ(key.declared_default, key.def);
    if (key.type == "integer" && !key.read_by_code) {
      // "1 to 1024" or "0 or 1 to 1024": the default is inside the range.
      CHECK(!key.range.empty());
    }
  }
  CHECK(seen.size() > 120);
}

// Each number in the table loads its two bounds. A value beyond either bound stops the start with an error that names the key.
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
    // A bound can break a rule between two keys. The table does not know these rules, but finish_config reports them. The error then
    // names the other rule. This check tests that the table itself accepts the bound, or names the key.
    const auto attempt = [&](long long value) { return error_of(block_text(key.block, key.key, std::to_string(value))); };
    // A rule between two keys says "must be at most" or "must be at least". That rule is not the bound of this key.
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
  CHECK(contains(error_of("server { worker_threads = \"x\" }"), "server.worker_threads must be an integer, not \"x\""));
  CHECK(contains(error_of("server { metrics = 1 }"), "server.metrics must be a boolean, not 1"));
  CHECK(contains(error_of("server { listen_host = 5 }"), "server.listen_host must be a string, not 5"));
  CHECK(contains(error_of("query { describe_mode = true }"), "query.describe_mode must be a string, not true"));
  CHECK(contains(error_of("observability { service_allowlist = \"a\" }"), "observability.service_allowlist must be a list of strings, not \"a\""));
  CHECK(contains(error_of("mcp { allowed_origins = 7 }"), "mcp.allowed_origins must be a list of strings, not 7"));
  CHECK(contains(error_of("clickhouse { host { name = 7 } }", false), "clickhouse.host.name must be a string, not 7"));
  CHECK(contains(error_of("logs { body_search = 5 }"), "logs.body_search must be a string, not 5"));
  CHECK(contains(error_of("server { bogus = 1 }"), "server: unknown attribute bogus"));
  CHECK(contains(error_of("explorer { graph { bogus = 1 } }"), "explorer.graph: unknown attribute bogus"));
  CHECK(contains(error_of("bogus { }"), "unknown block bogus"));
  CHECK(contains(error_of("server { listen_port = 70000 }"), "server.listen_port must be between 1 and 65535"));
  CHECK(contains(error_of("query { describe_mode = \"sometimes\" }"), "query.describe_mode must be auto, always or never"));
  CHECK(contains(error_of("observability { logs { body_search = \"fuzzy\" } }"), "observability.logs.body_search must be token, substring, off"));
  CHECK(contains(error_of("logs { body_search = \"fuzzy\" }"), "logs.body_search must be token, substring, off"));  // an older block names itself
  CHECK(contains(error_of("export { archive_format = \"tar\" }"), "export.archive_format must be zip"));
  CHECK(contains(error_of("export { compression = true }"), "export.compression"));
  // This is a key of an older block. The new block does not have it.
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

  const AppConfig set = load("server { listen_host = \"127.0.0.1\"\n listen_port = 9090\n worker_threads = 3\n max_worker_threads = 5\n max_host_streams = 2 }\n"
                             "query { describe_mode = \"never\"\n sample_interval_ms = 10 }");
  CHECK_EQ(set.listen, std::string("127.0.0.1:9090"));
  CHECK_EQ(set.server.worker_threads, size_t(3));
  CHECK_EQ(set.server.max_host_streams, size_t(2));  // at most half of max_worker_threads: a higher value is an error, not a clamp
  CHECK(contains(error_of("server { max_worker_threads = 5\n max_host_streams = 3 }"),
                 "server.max_host_streams must be at most half of server.max_worker_threads (2), not 3"));
  CHECK(contains(error_of("server { max_worker_threads = 100 }"), "server.max_host_streams must be at most half of server.max_worker_threads (50), not 64"));
  CHECK_EQ(error_of("server { max_worker_threads = 128\n max_host_streams = 64 }"), std::string(""));
  CHECK(set.query_options.describe_mode == QueryDescribeMode::Never);
  CHECK_EQ(set.query_options.sample_interval_ms, 10);

  // Automatic never exceeds the maximum.
  CHECK_EQ(load("server { max_worker_threads = 2\n max_host_streams = 1 }").server.worker_threads, size_t(2));

  // A rule between two keys.
  CHECK(contains(error_of("server { worker_threads = 10\n max_worker_threads = 5 }"), "server.max_worker_threads must be at least server.worker_threads"));
  CHECK(contains(error_of("query { sse_batch_bytes = 1048576\n sse_queue_max_bytes = 65536 }"), "query.sse_batch_bytes must be at most query.sse_queue_max_bytes"));
  CHECK(contains(error_of("system { max_lookback_days = 3\n disk_growth_days = 7 }"), "system.disk_growth_days must be at most system.max_lookback_days"));
  CHECK(contains(error_of("observability { traces { default_lookback_minutes = 600\n max_lookback_minutes = 60 } }"), "default_lookback_minutes must be at most"));
  CHECK(contains(error_of("query_library { enabled = true }"), "query_library.file is required"));
  CHECK(contains(error_of("query_library { max_file_bytes = 65536\n max_query_bytes = 100000 }"), "query_library.max_query_bytes must be at most"));

  // Several libraries can exist. The first one is the default. It may leave its name out. The others are named. A block that is not
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

  // The old clamps are errors now. Nothing is changed silently.
  CHECK(contains(error_of("export { max_concurrent = 0 }"), "export.max_concurrent must be between 1 and 64, not 0"));
  CHECK(contains(error_of("query { sample_interval_ms = 1 }"), "query.sample_interval_ms must be between 10 and 1000"));
  CHECK(contains(error_of("health { timeout_ms = 10 }"), "health.timeout_ms must be between 100 and 60000"));
  CHECK(contains(error_of("query { describe_cache_entries = 10000 }"), "query.describe_cache_entries must be between 0 and 4096"));

  // The effective values hold every key. The derived values are shown as they apply.
  bool worker = false, listen = false, mode = false;
  for (const auto& [name, value] : config::effective_values(set)) {
    if (name == "server.worker_threads") worker = value == "3";
    if (name == "server.listen") listen = value == "127.0.0.1:9090";
    if (name == "query.describe_mode") mode = value == "never";
  }
  CHECK(worker && listen && mode);
}

// ---- the usage of the MCP keys: mcp { usage { } } ----

void test_mcp_usage_block() {
  // These are the defaults of the block and the ranges that the table gives. Nothing is counted unless it is turned on.
  const AppConfig defaults = load("");
  CHECK(!defaults.mcp.usage.enabled);
  CHECK_EQ(defaults.mcp.usage.storage, std::string("files"));
  CHECK_EQ(defaults.mcp.usage.dir, std::string(""));
  CHECK_EQ(defaults.mcp.usage.instance, std::string(""));
  CHECK_EQ(defaults.mcp.usage.retention_days, int64_t(90));
  CHECK(!defaults.mcp.usage.all_keys);
  std::set<std::string> keys;
  for (const auto& key : config::schema()) {
    if (key.block != "mcp.usage") continue;
    keys.insert(key.key);
    CHECK(!key.read_by_code);
    if (key.key == "retention_days") CHECK_EQ(key.range, std::string("1 to 365"));
    if (key.key == "storage") CHECK_EQ(key.type, std::string("one of files"));
    CHECK_EQ(key.declared_default, key.def);
  }
  CHECK(keys == std::set<std::string>({"enabled", "storage", "dir", "instance", "retention_days", "all_keys"}));
  CHECK(config::keys_of("mcp").size() > 0);
  for (const auto& key : config::schema()) {
    CHECK(key.block + "." + key.key != "mcp.usage_file" && key.block + "." + key.key != "mcp.usage_retention_days");  // replaced by the block
  }
  CHECK_EQ(load("mcp { usage { retention_days = 1 } }").mcp.usage.retention_days, int64_t(1));
  CHECK_EQ(load("mcp { usage { retention_days = 365 } }").mcp.usage.retention_days, int64_t(365));
  CHECK(contains(error_of("mcp { usage { retention_days = 0 } }"), "mcp.usage.retention_days must be between 1 and 365, not 0 (days)"));
  CHECK(contains(error_of("mcp { usage { retention_days = 366 } }"), "mcp.usage.retention_days must be between 1 and 365, not 366"));
  CHECK(contains(error_of("mcp { usage { storage = \"database\" } }"), "mcp.usage.storage must be files, not \"database\""));
  CHECK(contains(error_of("mcp { usage { enabled = 1 } }"), "mcp.usage.enabled must be a boolean, not 1"));
  CHECK(contains(error_of("mcp { usage { dir = 5 } }"), "mcp.usage.dir must be a string, not 5"));
  CHECK(contains(error_of("mcp { usage { bogus = 1 } }"), "mcp.usage: unknown attribute bogus"));
  CHECK(contains(error_of("mcp { usage { extra { } } }"), "mcp.usage: unknown block extra"));
  CHECK(contains(error_of("mcp { usage { } usage { } }"), "block usage must appear exactly once"));
  CHECK(contains(error_of("mcp { usage_file = \"/x\" }"), "mcp: unknown attribute usage_file"));  // the old keys are gone
  CHECK(contains(error_of("mcp { usage_retention_days = 7 }"), "mcp: unknown attribute usage_retention_days"));
  // When the block is off, the directory is not checked. A block that is off may name a directory that does not exist.
  CHECK_EQ(error_of("mcp { usage { enabled = false\n dir = \"/no/such/dir\"\n instance = \"not valid\" } }"), std::string(""));

  // When the block is on and MCP is on, the directory and the name of the instance are checked.
  const std::string mcp_hosts = "clickhouse { host { name = \"h\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n "
                                "mcp_uri = \"clickhouse://m@h:9000\" } }\n";
  write_file(dir + "/usage-key", "a11da7a0-0000-4000-8000-000000000001\n");
  const std::string key = "key { name = \"k\"\n secret_file = \"" + dir + "/usage-key\"\n hosts = [\"h\"]\n tools = [\"*\"]\n databases = [\"*\"] }\n";
  const auto usage = [&](const std::string& attrs) { return "mcp { enabled = true\n" + key + "usage {\n" + attrs + "\n}\n}\n" + mcp_hosts; };
  const std::string usage_dir = dir + "/usage";
  ::mkdir(usage_dir.c_str(), 0700);
  const AppConfig on = [&] {
    const std::string path = dir + "/usage.hcl";
    write_file(path, usage(" enabled = true\n dir = \"" + usage_dir + "\"\n instance = \"chdash-0\"\n retention_days = 30\n all_keys = true"));
    return load_config_from_file(path);
  }();
  CHECK(on.mcp.usage.enabled);
  CHECK_EQ(on.mcp.usage.dir, usage_dir);
  CHECK_EQ(on.mcp.usage.instance, std::string("chdash-0"));
  CHECK_EQ(on.mcp.usage.retention_days, int64_t(30));
  CHECK(on.mcp.usage.all_keys);
  bool named = false;
  for (const auto& [name, value] : config::effective_values(on)) {
    if (name == "mcp.usage.instance") named = value == "chdash-0";
  }
  CHECK(named);
  const auto failure = [&](const std::string& attrs) { return error_of(usage(attrs), false); };
  CHECK(contains(failure(" enabled = true\n instance = \"chdash-0\""), "mcp.usage.dir is required when mcp.usage.enabled = true"));
  CHECK(contains(failure(" enabled = true\n instance = \"chdash-0\"\n dir = \"" + dir + "/missing\""), "mcp.usage.dir " + dir + "/missing: the directory does not exist"));
  CHECK(contains(failure(" enabled = true\n instance = \"has space\"\n dir = \"" + usage_dir + "\""), "mcp.usage.instance \"has space\" must be 1 to 64 characters"));
  CHECK(contains(failure(" enabled = true\n instance = \"" + std::string(65, 'x') + "\"\n dir = \"" + usage_dir + "\""), "mcp.usage.instance"));
  // An instance without a name is called by the host name, if that host name is the name of an instance.
  const std::string host_name = mcp_usage_host_name();
  if (mcp_valid_usage_instance(host_name)) {
    const std::string path = dir + "/usage-host.hcl";
    write_file(path, usage(" enabled = true\n dir = \"" + usage_dir + "\""));
    CHECK_EQ(load_config_from_file(path).mcp.usage.instance, host_name);
  }
  // The usage of an instance that is not valid is never rewritten. The start stops, and the file stays as it was.
  write_file(usage_dir + "/chdash-1.jsonl.zst", "not a zstd file");
  const std::string message = failure(" enabled = true\n instance = \"chdash-1\"\n dir = \"" + usage_dir + "\"");
  CHECK(contains(message, "chdash-1.jsonl.zst") && contains(message, "the file is not changed"));
  std::ifstream still(usage_dir + "/chdash-1.jsonl.zst", std::ios::binary);
  std::stringstream content;
  content << still.rdbuf();
  CHECK_EQ(content.str(), std::string("not a zstd file"));
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
  // The URI has no password_file parameter. The host attribute reads a file one time, at start.
  CHECK(contains(validate_clickhouse_uri("clickhouse://u@h:9000?password_file=/x"), "unknown parameter password_file"));
  CHECK_EQ(validate_clickhouse_uri("clickhouse://u@h:9000?secure=1&verify=0&ca=/x&ca_dir=/y&sni=0&compression=zstd"), std::string(""));
  // The port of TLS is 9440 when the URI names none.
  std::string err;
  CHECK_EQ(parse_clickhouse_uri("clickhouse://u@h?secure=1", &err)->port, uint16_t(9440));
  CHECK_EQ(parse_clickhouse_uri("clickhouse://u@h?secure=0", &err)->port, uint16_t(9000));
  CHECK_EQ(parse_clickhouse_uri("clickhouse://u@h:9441?secure=1", &err)->port, uint16_t(9441));
  CHECK_EQ(parse_clickhouse_uri("clickhouse://u@[::1]?secure=1", &err)->port, uint16_t(9440));

  // The start message names the host and the field.
  CHECK(contains(host_error("clickhouse://u@h:9000?verfy=0"), "clickhouse.host u: runner_uri: unknown parameter verfy"));
  CHECK(contains(host_error("clickhouse://u@h:9000", "mcp_uri = \"clickhouse://m@h:9000?x=1\"\n"), "clickhouse.host u: mcp_uri: unknown parameter x"));

  // The configuration puts the password into the URI. The password is encoded, and the user stays as it is.
  CHECK_EQ(clickhouse_uri_with_password("clickhouse://u@h:9000?secure=1", "p@ss:w/d+%"), std::string("clickhouse://u:p%40ss%3Aw%2Fd%2B%25@h:9000?secure=1"));
  CHECK_EQ(clickhouse_uri_with_password("clickhouse://u:@h:9000", "x y"), std::string("clickhouse://u:x%20y@h:9000"));
  CHECK_EQ(clickhouse_uri_with_password("clickhouse://h:9000", "x"), std::string("clickhouse://:x@h:9000"));
  const auto encoded = parse_clickhouse_uri(clickhouse_uri_with_password("clickhouse://u@h:9000", "p@ss:w/d+% é"), &err);
  CHECK(encoded && encoded->user == "u" && encoded->password == "p@ss:w/d+% é" && encoded->host == "h" && encoded->port == 9000);
  CHECK_EQ(redact_clickhouse_uri(clickhouse_uri_with_password("clickhouse://u@h:9000", "secret")), std::string("clickhouse://u:***@h:9000"));
  CHECK(!client_options_from_uri("clickhouse://u@h:9000?bogus=1", std::chrono::milliseconds(10), std::chrono::milliseconds(10),
                                 std::chrono::milliseconds(10), &err));
  const auto options = client_options_from_uri("clickhouse://u:pw@h:9000", std::chrono::milliseconds(10), std::chrono::milliseconds(10),
                                               std::chrono::milliseconds(10), &err);
  CHECK(options && options->password == "pw");
}

// ---- the secrets of the configuration: _env and _file, one form, read one time (CHD-CFG-2, -3, -4, -5) ----

// This is a host with the attributes `extra` and the URIs `uris`. The default has no password.
std::string host_with(const std::string& extra, const std::string& runner = "clickhouse://r@h:9000", const std::string& system = "clickhouse://s@h:9000") {
  return "clickhouse { host { name = \"p\"\n runner_uri = \"" + runner + "\"\n system_uri = \"" + system + "\"\n" + extra + " } }\n";
}

void test_secrets() {
  write_file(dir + "/pw-runner", "runner-pw\n");
  write_file(dir + "/pw-system", "system-pw");
  write_file(dir + "/pw-shared", "shared-pw\r\n");
  write_file(dir + "/pw-mcp", "mcp-pw\n\n");
  write_file(dir + "/pw-empty", "\n");
  write_file(dir + "/pw-nul", std::string("a\0b", 3));
  ::setenv("CHDASH_TEST_RUNNER_PW", "env-runner", 1);
  ::setenv("CHDASH_TEST_EMPTY_PW", "", 1);
  ::unsetenv("CHDASH_TEST_UNSET_PW");
  const auto first = [&](const AppConfig& cfg) { return cfg.hosts.at(0); };
  const auto failure = [&](const std::string& hosts) { return error_of(hosts, false); };
  const auto source = [&](const AppConfig& cfg, const std::string& name) {
    for (const auto& value : config::effective_config(cfg)) {
      if (value.name == name) return value.source + "|" + value.value;
    }
    return std::string("missing");
  };

  // _file gives the content without the last line end (one \n or \r\n only). _env gives the variable.
  const AppConfig files = load(host_with("runner_password_file = \"" + dir + "/pw-runner\"\n system_password_file = \"" + dir + "/pw-system\"\n mcp_uri = \"clickhouse://m@h:9000\"\n mcp_password_file = \"" + dir + "/pw-mcp\""), false);
  CHECK_EQ(first(files).runner_uri, std::string("clickhouse://r:runner-pw@h:9000"));
  CHECK_EQ(first(files).system_uri, std::string("clickhouse://s:system-pw@h:9000"));
  CHECK_EQ(first(files).mcp_uri, std::string("clickhouse://m:mcp-pw%0A@h:9000"));  // only one line end goes
  CHECK_EQ(source(files, "clickhouse.host[p].runner_password"), "file:" + dir + "/pw-runner|<hidden>");
  CHECK_EQ(source(files, "clickhouse.host[p].mcp_password"), "file:" + dir + "/pw-mcp|<hidden>");
  const AppConfig env = load(host_with("runner_password_env = \"CHDASH_TEST_RUNNER_PW\"\n system_password_file = \"" + dir + "/pw-system\""), false);
  CHECK_EQ(first(env).runner_uri, std::string("clickhouse://r:env-runner@h:9000"));
  CHECK_EQ(source(env, "clickhouse.host[p].runner_password"), std::string("env:CHDASH_TEST_RUNNER_PW|<hidden>"));
  // password_file or password_env gives the password of both URIs. The file is read one time.
  const AppConfig shared = load(host_with("password_file = \"" + dir + "/pw-shared\""), false);
  CHECK_EQ(first(shared).runner_uri, std::string("clickhouse://r:shared-pw@h:9000"));
  CHECK_EQ(first(shared).system_uri, std::string("clickhouse://s:shared-pw@h:9000"));
  write_file(dir + "/pw-shared", "changed");  // a change after the start never reaches the URIs: nothing reads the file again
  CHECK_EQ(first(shared).runner_uri, std::string("clickhouse://r:shared-pw@h:9000"));
  CHECK_EQ(first(load(host_with("password_env = \"CHDASH_TEST_RUNNER_PW\""), false)).system_uri, std::string("clickhouse://s:env-runner@h:9000"));
  // A configuration can still have no password (an account without one).
  CHECK_EQ(first(load(host_with(""), false)).runner_uri, std::string("clickhouse://r@h:9000"));
  CHECK_EQ(source(load(host_with(""), false), "clickhouse.host[p].runner_password"), std::string("default|<none>"));

  // The configuration refuses a password in clear text. This applies to the URI, to a parameter of the URI and to an attribute.
  CHECK(contains(failure(host_with("", "clickhouse://r:pw@h:9000")), "clickhouse.host p: runner_uri holds a password in clear text"));
  CHECK(contains(failure(host_with("", "clickhouse://r@h:9000", "clickhouse://s:pw@h:9000")), "clickhouse.host p: system_uri holds a password in clear text"));
  CHECK(contains(failure(host_with("mcp_uri = \"clickhouse://m:pw@h:9000\"")), "clickhouse.host p: mcp_uri holds a password in clear text"));
  CHECK(contains(failure(host_with("", "clickhouse://r@h:9000?password_file=/x")), "runner_uri has the parameter password_file"));
  CHECK(!contains(failure(host_with("", "clickhouse://r:topsecret@h:9000")), "topsecret"));  // the message never repeats the password
  CHECK(contains(failure(host_with("password = \"x\"")), "clickhouse.host p.password: a secret is never written in the file: use password_env"));
  CHECK(contains(failure(host_with("runner_password = \"x\"")), "runner_password: a secret is never written in the file"));
  CHECK(contains(failure(host_with("mcp_uri = \"clickhouse://m@h:9000\"\n mcp_password = \"x\"")), "mcp_password: a secret is never written in the file"));
  // Use exactly one form. No form takes precedence silently.
  CHECK(contains(failure(host_with("password_env = \"CHDASH_TEST_RUNNER_PW\"\n password_file = \"" + dir + "/pw-shared\"")),
                 "give exactly one of password_env and password_file, not both"));
  CHECK(contains(failure(host_with("password_file = \"" + dir + "/pw-shared\"\n runner_password_file = \"" + dir + "/pw-runner\"")),
                 "password_file and runner_password_file both give the password of runner_uri: give only one of them"));
  CHECK(contains(failure(host_with("password_file = \"" + dir + "/pw-shared\"\n system_password_env = \"CHDASH_TEST_RUNNER_PW\"")),
                 "password_file and system_password_env both give the password of system_uri"));
  CHECK(contains(failure(host_with("mcp_password_file = \"" + dir + "/pw-mcp\"")), "mcp_password_file needs mcp_uri"));
  CHECK_EQ(failure(host_with("mcp_uri = \"clickhouse://m@h:9000\"\n password_file = \"" + dir + "/pw-shared\"\n mcp_password_env = \"CHDASH_TEST_RUNNER_PW\"")), std::string(""));
  CHECK_EQ(first(load(host_with("mcp_uri = \"clickhouse://m@h:9000\"\n password_file = \"" + dir + "/pw-runner\""), false)).mcp_uri, std::string("clickhouse://m@h:9000"));  // the shared password never applies to MCP
  // A source that cannot give the secret stops the start. The error names the attribute and the variable or the path.
  CHECK(contains(failure(host_with("password_env = \"CHDASH_TEST_UNSET_PW\"")), "clickhouse.host p.password_env: the environment variable CHDASH_TEST_UNSET_PW is not set"));
  CHECK(contains(failure(host_with("password_env = \"CHDASH_TEST_EMPTY_PW\"")), "the environment variable CHDASH_TEST_EMPTY_PW is empty"));
  CHECK(contains(failure(host_with("password_env = \"not a name\"")), "password_env must be the name of an environment variable"));
  CHECK(contains(failure(host_with("password_env = 5")), "password_env must be a string (the name of an environment variable), not 5"));
  CHECK(contains(failure(host_with("password_file = \"" + dir + "/none\"")), "clickhouse.host p.password_file: cannot open " + dir + "/none"));
  CHECK(contains(failure(host_with("password_file = \"" + dir + "/pw-empty\"")), "pw-empty is empty"));
  CHECK(contains(failure(host_with("password_file = \"" + dir + "\"")), "password_file"));  // a directory
  CHECK(contains(failure(host_with("password_file = \"" + dir + "/pw-nul\"")), "holds a NUL byte"));
  CHECK(contains(failure(host_with("password_file = \"\"")), "password_file cannot be empty"));
}

// ---- the telemetry block: a closed schema, the three forms of otlp_endpoint, the durations, the contradictions ----

void test_telemetry_block() {
  const auto source = [&](const AppConfig& cfg, const std::string& name) {
    for (const auto& value : config::effective_config(cfg)) {
      if (value.name == name) return value.source + "|" + value.value;
    }
    return std::string("missing");
  };
  // The defaults: off, nothing to send.
  const AppConfig none = load("");
  CHECK(!none.telemetry.enabled);
  CHECK_EQ(source(none, "telemetry.otlp_endpoint"), std::string("default|"));
  CHECK_EQ(source(none, "telemetry.export_interval"), std::string("default|5s"));
  CHECK_EQ(source(none, "telemetry.export_timeout"), std::string("default|10s"));
  CHECK_EQ(source(none, "telemetry.connect_timeout"), std::string("default|2s"));
  CHECK_EQ(source(none, "telemetry.service_name"), std::string("default|chdash"));
  CHECK_EQ(source(none, "telemetry.call_log"), std::string("default|true"));
  // The _env and _file forms of the endpoint have no entry of their own.
  CHECK_EQ(source(none, "telemetry.otlp_endpoint_env"), std::string("missing"));

  // The three forms of otlp_endpoint, each with its source.
  const AppConfig plain = load("telemetry {\n enabled = true\n otlp_endpoint = \"http://collector:4318\"\n export_interval = \"15s\"\n"
                               " export_timeout = \"500ms\"\n connect_timeout = \"500ms\"\n service_name = \"chd\"\n call_log = false\n}\n");
  CHECK(plain.telemetry.enabled);
  CHECK_EQ(plain.telemetry.otlp_endpoint, std::string("http://collector:4318"));
  CHECK_EQ(plain.telemetry.export_interval_ms, 15000);
  CHECK_EQ(plain.telemetry.export_timeout_ms, 500);
  CHECK_EQ(plain.telemetry.connect_timeout_ms, 500);
  CHECK_EQ(plain.telemetry.service_name, std::string("chd"));
  CHECK(!plain.telemetry.call_log);
  CHECK_EQ(source(plain, "telemetry.otlp_endpoint"), std::string("file|http://collector:4318"));
  CHECK_EQ(source(plain, "telemetry.export_interval"), std::string("file|15s"));
  CHECK_EQ(source(plain, "telemetry.export_timeout"), std::string("file|500ms"));
  // mcp is off: a warning, not an error.
  bool warned = false;
  for (const auto& warning : plain.warnings) warned = warned || contains(warning, "telemetry.enabled = true, but mcp.enabled = false");
  CHECK(warned);
  ::setenv("CHDASH_TEST_OTLP_ENDPOINT", "http://env-collector:4318/otlp", 1);
  ::unsetenv("CHDASH_TEST_OTLP_UNSET");
  const AppConfig env = load("telemetry { otlp_endpoint_env = \"CHDASH_TEST_OTLP_ENDPOINT\" }");
  CHECK_EQ(env.telemetry.otlp_endpoint, std::string("http://env-collector:4318/otlp"));
  CHECK_EQ(source(env, "telemetry.otlp_endpoint"), std::string("env:CHDASH_TEST_OTLP_ENDPOINT|http://env-collector:4318/otlp"));
  write_file(dir + "/otlp-endpoint", "http://file-collector:4318\n");
  const AppConfig file = load("telemetry { otlp_endpoint_file = \"" + dir + "/otlp-endpoint\" }");
  CHECK_EQ(file.telemetry.otlp_endpoint, std::string("http://file-collector:4318"));
  CHECK_EQ(source(file, "telemetry.otlp_endpoint"), "file:" + dir + "/otlp-endpoint|http://file-collector:4318");

  // Use exactly one form. A source that gives no value stops the start. The error names the attribute and the variable or the path.
  CHECK(contains(error_of("telemetry {\n otlp_endpoint = \"http://a:1\"\n otlp_endpoint_env = \"CHDASH_TEST_OTLP_ENDPOINT\"\n}"),
                 "telemetry: give exactly one of otlp_endpoint, otlp_endpoint_env and otlp_endpoint_file"));
  CHECK(contains(error_of("telemetry {\n otlp_endpoint_env = \"CHDASH_TEST_OTLP_ENDPOINT\"\n otlp_endpoint_file = \"/x\"\n}"),
                 "give exactly one of otlp_endpoint_env and otlp_endpoint_file"));
  CHECK(contains(error_of("telemetry { otlp_endpoint_env = \"CHDASH_TEST_OTLP_UNSET\" }"),
                 "telemetry.otlp_endpoint_env: the environment variable CHDASH_TEST_OTLP_UNSET is not set"));
  CHECK(contains(error_of("telemetry { otlp_endpoint_file = \"" + dir + "/none\" }"), "telemetry.otlp_endpoint_file: cannot open " + dir + "/none"));
  CHECK(contains(error_of("telemetry { otlp_endpoint = \"\" }"), "telemetry.otlp_endpoint cannot be empty"));
  CHECK(contains(error_of("telemetry { otlp_endpoint = 4318 }"), "telemetry.otlp_endpoint must be a string, not 4318"));
  // The endpoint accepts http only, with no user or password. The error gives the source and the value.
  CHECK(contains(error_of("telemetry { otlp_endpoint = \"https://collector:4318\" }"), "telemetry.otlp_endpoint (file) https is not available"));
  CHECK(contains(error_of("telemetry { otlp_endpoint = \"http://u:p@collector:4318\" }"), "must not hold a user or a password"));
  CHECK(contains(error_of("telemetry { otlp_endpoint = \"collector:4318\" }"), "must start with http://, not \"collector:4318\""));
  // The block is closed. An unknown attribute or block stops the start. OTEL_* names are not keys of the file.
  CHECK(contains(error_of("telemetry { headers = \"x\" }"), "telemetry: unknown attribute headers"));
  CHECK(contains(error_of("telemetry { exporter { } }"), "telemetry: unknown block exporter"));
  CHECK(contains(error_of("telemetry { enabled = \"yes\" }"), "telemetry.enabled must be a boolean, not \"yes\""));
  // A duration is an integer and one unit, inside the range. No coercion happens.
  CHECK(contains(error_of("telemetry { export_interval = \"1.5s\" }"), "telemetry.export_interval must be a duration (an integer and one of ms, s, m and h"));
  CHECK(contains(error_of("telemetry { export_interval = 15 }"), "telemetry.export_interval must be a string, not 15"));
  CHECK(contains(error_of("telemetry { export_interval = \"50ms\" }"), "telemetry.export_interval must be between 100ms and 1h, not \"50ms\""));
  CHECK(contains(error_of("telemetry { export_timeout = \"6m\" }"), "telemetry.export_timeout must be between 100ms and 5m, not \"6m\""));
  CHECK_EQ(error_of("telemetry { export_interval = \"1h\" }"), std::string(""));
  // The rules between two keys.
  CHECK(contains(error_of("telemetry { enabled = true }"), "telemetry.enabled = true needs otlp_endpoint"));
  CHECK(contains(error_of("telemetry {\n max_queue_size = 10\n max_export_batch_size = 11\n}"),
                 "telemetry.max_export_batch_size (11) must be at most telemetry.max_queue_size (10)"));
  CHECK(contains(error_of("telemetry { connect_timeout = \"20s\" }"), "telemetry.connect_timeout (20s) must be at most telemetry.export_timeout (10s)"));
  CHECK(contains(error_of("telemetry { service_name = \"\" }"), "telemetry.service_name must be 1 to 255 bytes"));
  CHECK(contains(error_of("telemetry {\n enabled = true\n enabled = false\n}"), "duplicate attribute 'enabled'"));
  CHECK(contains(error_of("telemetry { }\ntelemetry { }"), "block telemetry must appear exactly once"));
}

// ---- the keys of MCP: the secret is _env or _file only ----

// This covers the access block (docs/access.md, contract 11.2). The tests check that it is required, the two modes, the identity and the PDP, and their errors.
void test_access_block() {
  const auto source = [&](const AppConfig& cfg, const std::string& name) {
    for (const auto& value : config::effective_config(cfg)) {
      if (value.name == name) return value.source + "|" + value.value;
    }
    return std::string("missing");
  };
  // Without the block, the start stops (U01). The file has another extension, so write_file adds no access block.
  {
    const std::string path = dir + "/no-access.conf";
    write_file(path, kHost);
    std::string error;
    try {
      load_config_from_file(path);
    } catch (const std::exception& e) {
      error = e.what();
    }
    CHECK(contains(error, "the access block is missing"));
  }
  // The open mode: a warning, and no other key applies.
  const AppConfig open = load("access { mode = \"open\" }");
  CHECK(!open.access.enforced());
  CHECK(contains(open.warnings.back(), "access.mode = \"open\""));
  CHECK_EQ(source(open, "access.mode"), std::string("file|open"));
  CHECK_EQ(source(open, "access.identity.issuer"), std::string("missing"));

  // A key file (the test key of the docker tests) and the token of the PDP.
  const std::string pem =
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n";
  write_file(dir + "/identity.pem", pem);
  write_file(dir + "/pdp-token", "pdp-secret\n");
  const auto authzen = [&](const std::string& identity, const std::string& pdp) {
    return "access {\n mode = \"authzen\"\n identity {\n" + identity + "\n }\n pdp {\n" + pdp + "\n }\n}\n";
  };
  const std::string identity = " issuer = \"https://issuer\"\n audience = \"db\"\n public_keys_file = \"" + dir + "/identity.pem\"";
  const std::string pdp = " url = \"http://pdp:4182/base\"\n token_file = \"" + dir + "/pdp-token\"";
  const AppConfig full = load(authzen(identity + "\n max_age = \"2m\"\n header = \"X-Id\"", pdp + "\n timeout = \"250ms\"\n cache_ttl = \"0s\""));
  CHECK(full.access.enforced());
  CHECK_EQ(full.access.issuer, std::string("https://issuer"));
  CHECK_EQ(full.access.audience, std::string("db"));
  CHECK_EQ(full.access.header, std::string("X-Id"));
  CHECK_EQ(full.access.keys.size(), size_t(1));
  CHECK_EQ(full.access.max_age_ms, int64_t(120000));
  CHECK_EQ(full.access.pdp_endpoint.host, std::string("pdp"));
  CHECK_EQ(full.access.pdp_endpoint.port, 4182);
  CHECK_EQ(full.access.pdp_endpoint.base_path, std::string("/base"));
  CHECK_EQ(full.access.pdp_token, std::string("pdp-secret"));
  CHECK_EQ(full.access.pdp_timeout_ms, int64_t(250));
  CHECK_EQ(full.access.pdp_cache_ttl_ms, int64_t(0));
  CHECK_EQ(source(full, "access.mode"), std::string("file|authzen"));
  CHECK_EQ(source(full, "access.identity.public_keys"), "file:" + dir + "/identity.pem|[\"Ed25519 kid=kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k\"]");
  CHECK_EQ(source(full, "access.pdp.token"), "file:" + dir + "/pdp-token|<hidden>");
  CHECK_EQ(source(full, "access.pdp.cache_ttl"), std::string("file|0ms"));
  for (const auto& value : config::effective_config(full)) CHECK(!contains(value.value, "pdp-secret"));
  // The defaults.
  const AppConfig defaults = load(authzen(identity, pdp));
  CHECK_EQ(defaults.access.header, std::string("X-Identity-Token"));
  CHECK_EQ(source(defaults, "access.identity.max_age"), std::string("default|5m"));
  CHECK_EQ(source(defaults, "access.pdp.timeout"), std::string("default|500ms"));
  CHECK_EQ(source(defaults, "access.pdp.cache_ttl"), std::string("default|30s"));
  // The keys and the token from the environment.
  ::setenv("CHDASH_TEST_IDENTITY_KEYS", pem.c_str(), 1);
  ::setenv("CHDASH_TEST_PDP_TOKEN", "env-token", 1);
  ::setenv("CHDASH_TEST_PDP_URL", "http://pdp-env:80", 1);
  const AppConfig env = load(authzen(" issuer = \"i\"\n audience = \"db\"\n public_keys_env = \"CHDASH_TEST_IDENTITY_KEYS\"",
                                     " url_env = \"CHDASH_TEST_PDP_URL\"\n token_env = \"CHDASH_TEST_PDP_TOKEN\""));
  CHECK_EQ(env.access.pdp_token, std::string("env-token"));
  CHECK_EQ(source(env, "access.pdp.token"), std::string("env:CHDASH_TEST_PDP_TOKEN|<hidden>"));
  CHECK_EQ(source(env, "access.pdp.url"), std::string("env:CHDASH_TEST_PDP_URL|http://pdp-env:80"));
  CHECK(contains(source(env, "access.identity.public_keys"), "env:CHDASH_TEST_IDENTITY_KEYS|"));

  // The errors: each one names the key, and the value when it is not a secret.
  CHECK(contains(error_of("access { }"), "access.mode is required"));
  CHECK(contains(error_of("access { mode = \"closed\" }"), "access.mode must be \"authzen\" or \"open\", not \"closed\""));
  CHECK(contains(error_of("access { mode = \"open\"\n pdp { url = \"http://p\" } }"), "contradict each other"));
  CHECK(contains(error_of("access { mode = \"open\"\n other = 1 }"), "access: unknown attribute other"));
  CHECK(contains(error_of("access { mode = \"authzen\" }"), "needs the access.identity block"));
  CHECK(contains(error_of("access { mode = \"authzen\"\n identity {\n" + identity + "\n }\n}"), "needs the access.pdp block"));
  CHECK(contains(error_of(authzen(" audience = \"db\"\n public_keys_file = \"" + dir + "/identity.pem\"", pdp)), "access.identity.issuer is required"));
  CHECK(contains(error_of(authzen(" issuer = \"i\"\n public_keys_file = \"" + dir + "/identity.pem\"", pdp)), "access.identity.audience is required"));
  CHECK(contains(error_of(authzen(" issuer = \"i\"\n audience = \"db\"", pdp)), "give one of public_keys, public_keys_env and public_keys_file"));
  CHECK(contains(error_of(authzen(identity + "\n public_keys = \"x\"", pdp)), "give exactly one of public_keys, public_keys_env and public_keys_file"));
  CHECK(contains(error_of(authzen(" issuer = \"i\"\n audience = \"db\"\n public_keys = \"not a key\"", pdp)), "access.identity.public_keys (file): line 1"));
  CHECK(contains(error_of(authzen(identity + "\n header = \"Cookie\"", pdp)), "access.identity.header must be a header of its own"));
  CHECK(contains(error_of(authzen(identity + "\n header = \"X Id\"", pdp)), "access.identity.header must be an HTTP header name"));
  CHECK(contains(error_of(authzen(identity + "\n max_age = \"0s\"", pdp)), "access.identity.max_age must be between 1s and 24h, not \"0s\""));
  CHECK(contains(error_of(authzen(identity + "\n other = 1", pdp)), "access.identity: unknown attribute other"));
  CHECK(contains(error_of(authzen(identity, " token_file = \"" + dir + "/pdp-token\"")), "give one of url, url_env and url_file"));
  CHECK(contains(error_of(authzen(identity, " url = \"https://pdp\"\n token_file = \"" + dir + "/pdp-token\"")), "https is not available"));
  CHECK(contains(error_of(authzen(identity, " url = \"pdp:80\"\n token_file = \"" + dir + "/pdp-token\"")), "access.pdp.url (file) must start with http://, not \"pdp:80\""));
  CHECK(contains(error_of(authzen(identity, " url = \"http://pdp\"")), "access.pdp needs the token"));
  const std::string clear = error_of(authzen(identity, " url = \"http://pdp\"\n token = \"in-clear\""));
  CHECK(contains(clear, "access.pdp.token: a secret is never written in the file"));
  CHECK(!contains(clear, "in-clear"));
  ::unsetenv("CHDASH_TEST_PDP_UNSET");
  CHECK(contains(error_of(authzen(identity, " url = \"http://pdp\"\n token_env = \"CHDASH_TEST_PDP_UNSET\"")), "CHDASH_TEST_PDP_UNSET is not set"));
  CHECK(contains(error_of(authzen(identity, pdp + "\n timeout = \"5ms\"")), "access.pdp.timeout must be between 10ms and 1m, not \"5ms\""));
  CHECK(contains(error_of(authzen(identity, pdp + "\n cache_ttl = \"2h\"")), "access.pdp.cache_ttl must be between 0ms and 1h, not \"2h\""));
  write_file(dir + "/pdp-token-space", "two words\n");
  const std::string spaced = error_of(authzen(identity, " url = \"http://pdp\"\n token_file = \"" + dir + "/pdp-token-space\""));
  CHECK(contains(spaced, "access.pdp.token (file:" + dir + "/pdp-token-space) must be 1 to 4096 visible ASCII characters"));
  CHECK(!contains(spaced, "two words"));
  CHECK(contains(error_of("access { mode = \"open\" }\naccess { mode = \"open\" }"), "block access must appear exactly once"));

  // The audience and the name of each host are ids for the PDP (docs/access.md, "Hosts"): 1 to 256 bytes of UTF-8.
  CHECK(contains(error_of(authzen(" issuer = \"i\"\n audience = \"" + std::string(257, 'a') + "\"\n public_keys_file = \"" + dir + "/identity.pem\"", pdp)),
                 "access.identity.audience is required: the name of this server in the aud of the tokens, 1 to 256 bytes of UTF-8"));
  const auto with_host = [&](const std::string& name) {
    return authzen(identity, pdp) + "clickhouse {\n host {\n name = \"" + name +
           "\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n }\n}\n";
  };
  const std::string long_name = error_of(with_host(std::string(300, 'h')), false);
  CHECK(contains(long_name, "clickhouse.host.name and access.mode = \"authzen\" contradict each other"));
  CHECK(contains(long_name, "(300 bytes)"));
  CHECK(contains(error_of(with_host("caf\xFF"), false), "contradict each other"));
  CHECK_EQ(error_of(with_host("caf\xC3\xA9-" + std::string(250, 'h')), false), std::string(""));
  // The open mode keeps the rule of 1.0.8: any length.
  CHECK_EQ(error_of("access { mode = \"open\" }\nclickhouse {\n host {\n name = \"" + std::string(300, 'h') +
                    "\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n }\n}\n", false),
           std::string(""));
}

void test_mcp_key_secrets() {
  write_file(dir + "/key-secret", "a11da7a0-0000-4000-8000-0000000000a1\n");
  ::setenv("CHDASH_TEST_KEY", "a11da7a0-0000-4000-8000-0000000000a2", 1);
  const std::string hosts = "clickhouse { host { name = \"h\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n mcp_uri = \"clickhouse://m@h:9000\" } }\n";
  const auto key = [&](const std::string& secret) {
    return "mcp { enabled = true\n key { name = \"k\"\n " + secret + "\n hosts = [\"h\"]\n tools = [\"*\"]\n databases = [\"*\"] } }\n" + hosts;
  };
  const auto failure = [&](const std::string& secret) { return error_of(key(secret), false); };
  CHECK_EQ(failure("secret_file = \"" + dir + "/key-secret\""), std::string(""));
  CHECK_EQ(failure("secret_env = \"CHDASH_TEST_KEY\""), std::string(""));
  CHECK(contains(failure("secret = \"a11da7a0-0000-4000-8000-0000000000a3\""), "mcp.key k.secret: a secret is never written in the file: use secret_env"));
  CHECK(!contains(failure("secret = \"a11da7a0-0000-4000-8000-0000000000a3\""), "a11da7a0"));
  CHECK(contains(failure(""), "mcp.key k: exactly one of secret_env and secret_file is required"));
  CHECK(contains(failure("secret_env = \"CHDASH_TEST_KEY\"\n secret_file = \"" + dir + "/key-secret\""), "give exactly one of secret_env and secret_file, not both"));
  CHECK(contains(failure("secret_env = \"CHDASH_TEST_NO_SUCH_KEY\""), "mcp.key k.secret_env: the environment variable CHDASH_TEST_NO_SUCH_KEY is not set"));
  CHECK(contains(failure("secret_env = \"CHDASH_TEST_RUNNER_PW\""), "secret_env: the token (env:CHDASH_TEST_RUNNER_PW) must be mcp_ and 43 base64url characters, or the UUID version 4 of an older key"));
  CHECK(contains(failure("secret_file = \"" + dir + "/key-secret\"\n max_rows = 5000"), "mcp.key k: max_rows: max_rows must be between 1 and 1000, not 5000"));
  CHECK(contains(failure("secret_file = \"" + dir + "/key-secret\"\n timeout_seconds = 31"), "timeout_seconds must be between 1 and 30, not 31"));
  CHECK(contains(failure("secret_file = \"" + dir + "/key-secret\"\n max_rows = \"many\""), "mcp.key.max_rows must be an integer, not \"many\""));
  // The effective values show where the secret comes from and never the secret.
  const std::string path = dir + "/key.hcl";
  write_file(path, key("secret_file = \"" + dir + "/key-secret\""));
  const AppConfig cfg = load_config_from_file(path);
  bool shown = false;
  for (const auto& value : config::effective_config(cfg)) {
    CHECK(!contains(value.value, "a11da7a0") && !contains(value.name, "a11da7a0"));
    if (value.name == "mcp.key[k].secret") shown = value.value == "<hidden>" && value.source == "file:" + dir + "/key-secret";
  }
  CHECK(shown);
  // The key and the host are in the reference too.
  std::set<std::string> blocks;
  for (const auto& row : config::schema()) blocks.insert(row.block);
  CHECK(blocks.count("clickhouse.host") && blocks.count("mcp.key") && blocks.count("clickhouse.host.observability.traces"));
}

// ---- the mcp_key block of the contract, the modes of the keys, and the older forms ----

void test_mcp_key_block() {
  const std::string token = "mcp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK";
  write_file(dir + "/token-a", token + "\n");
  write_file(dir + "/token-b", "mcp_bbbbBBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK");
  write_file(dir + "/token-uuid", "a11da7a0-0000-4000-8000-0000000000c1\n");
  write_file(dir + "/token-bad", "not-a-token\n");
  ::setenv("CHDASH_TEST_MCP_TOKEN", "mcp_eeeeBBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK", 1);
  CHECK(mcp_valid_token(token) && !mcp_valid_token("mcp_short") && !mcp_valid_token("xcp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK"));
  const std::string hosts = "clickhouse { host { name = \"h\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n mcp_uri = \"clickhouse://m@h:9000\" } }\n";
  const auto mcp = [&](const std::string& body) { return "mcp { enabled = true\n " + body + " }\n" + hosts; };
  const auto ok_key = [&](const std::string& name, const std::string& extra = "") {
    return "mcp_key \"" + name + "\" {\n token_file = \"" + dir + "/token-a\"\n tools = [\"*\"]\n " + extra + "\n }\n";
  };
  const auto failure = [&](const std::string& body) { return error_of(mcp(body), false); };

  // A complete block: the scope, the limits, the subject and the expiry.
  const std::string path = dir + "/mcp-key.hcl";
  write_file(path, mcp(ok_key("ci-bot", "subject = \"alice\"\n expires = \"2027-10-15T02:00:00+02:00\"\n"
                                         " scope {\n hosts = [\"h\"]\n databases = [\"otel\"]\n }\n limits {\n max_rows = 50\n timeout_seconds = 5\n rate_limit_per_minute = 60\n }")));
  const AppConfig cfg = load_config_from_file(path);
  CHECK_EQ(cfg.mcp.keys.size(), size_t(1));
  const McpKey& key = cfg.mcp.keys.front();
  CHECK_EQ(key.name, std::string("ci-bot"));
  CHECK_EQ(key.subject, std::string("alice"));
  CHECK(key.expires_at && *key.expires_at == 1823558400);  // 2027-10-15T00:00:00Z
  CHECK(key.hosts == std::vector<std::string>({"h"}) && key.databases == std::vector<std::string>({"otel"}));
  CHECK(key.max_rows && *key.max_rows == 50 && key.timeout_seconds && *key.timeout_seconds == 5);
  CHECK(key.rate_limit_per_minute && *key.rate_limit_per_minute == 60);
  CHECK(!key.legacy_token && key.secret_hint == token.substr(0, 12));
  CHECK(cfg.mcp.keys_mode == McpKeysMode::Hybrid);
  // The only warning is the one of the open mode of the access block (kOpenAccess).
  CHECK_EQ(cfg.warnings.size(), size_t(1));
  CHECK(contains(cfg.warnings.at(0), "access.mode = \"open\""));
  bool hidden = false;
  for (const auto& value : config::effective_config(cfg)) {
    CHECK(!contains(value.value, token));
    if (value.name == "mcp.mcp_key[ci-bot].token") hidden = value.value == "<hidden>" && value.source == "file:" + dir + "/token-a";
    if (value.name == "mcp.mcp_key[ci-bot].scope.databases") CHECK_EQ(value.value, std::string("[\"otel\"]"));
    if (value.name == "mcp.mcp_key[ci-bot].limits.rate_limit_per_minute") CHECK_EQ(value.value, std::string("60"));
    if (value.name == "mcp.keys.mode") CHECK(value.value == "hybrid" && value.source == "default");
  }
  CHECK(hidden);

  // With one host of MCP, a key without a scope reads that host. The token can come from a variable.
  CHECK_EQ(failure("mcp_key \"env-key\" { token_env = \"CHDASH_TEST_MCP_TOKEN\" }"), std::string(""));
  // The token is never in clear text. Use exactly one form: a variable or a file that exists. The format must be valid.
  CHECK(contains(failure("mcp_key \"k\" { token = \"" + token + "\" }"), "mcp.mcp_key k.token: a secret is never written in the file"));
  CHECK(!contains(failure("mcp_key \"k\" { token = \"" + token + "\" }"), token));
  CHECK(contains(failure("mcp_key \"k\" {\n token_env = \"CHDASH_TEST_MCP_TOKEN\"\n token_file = \"" + dir + "/token-a\" }"),
                 "give exactly one of token_env and token_file, not both"));
  CHECK(contains(failure("mcp_key \"k\" { tools = [] }"), "mcp.mcp_key k: exactly one of token_env and token_file is required"));
  CHECK(contains(failure("mcp_key \"k\" { token_env = \"CHDASH_TEST_NO_SUCH_TOKEN\" }"),
                 "mcp.mcp_key k.token_env: the environment variable CHDASH_TEST_NO_SUCH_TOKEN is not set"));
  CHECK(contains(failure("mcp_key \"k\" { token_file = \"" + dir + "/no-such-token\" }"), "mcp.mcp_key k.token_file: cannot open"));
  CHECK(contains(failure("mcp_key \"k\" { token_file = \"" + dir + "/token-bad\" }"), "must be mcp_ and 43 base64url characters"));
  // The label, the attributes, the blocks.
  CHECK(contains(failure("mcp_key { token_file = \"" + dir + "/token-a\" }"), "mcp.mcp_key needs its name as a label"));
  CHECK(contains(failure("mcp_key \"Bad Name\" { token_file = \"" + dir + "/token-a\" }"), "the name must use a-z"));
  CHECK(contains(failure(ok_key("k", "colour = \"red\"")), "mcp.mcp_key k: unknown attribute colour"));
  CHECK(contains(failure(ok_key("k", "scope { owners = [] }")), "mcp.mcp_key k.scope: unknown attribute owners"));
  CHECK(contains(failure(ok_key("k", "limits { max_memory = 1 }")), "mcp.mcp_key k.limits: unknown attribute max_memory"));
  CHECK(contains(failure(ok_key("k", "scope { }\n scope { }")), "block scope must appear exactly once"));
  CHECK(contains(failure(ok_key("k", "subject = \"a b\"")), "subject must be 1 to 64 characters"));
  CHECK(contains(failure(ok_key("k", "expires = \"next year\"")), "expires must be an RFC 3339 time"));
  CHECK(contains(failure(ok_key("k", "limits { max_rows = 5000 }")), "mcp.mcp_key k: max_rows: max_rows must be between 1 and 1000, not 5000"));
  CHECK(contains(failure(ok_key("k", "limits { rate_limit_per_minute = 601 }")),
                 "mcp.mcp_key k: rate_limit_per_minute: rate_limit_per_minute must be between 1 and 600, not 601"));
  CHECK(contains(failure(ok_key("k", "tools = [\"no_such_tool\"]")), "duplicate attribute"));
  CHECK(contains(failure("mcp_key \"k\" {\n token_file = \"" + dir + "/token-a\"\n tools = [\"no_such_tool\"] }"), "unknown tool no_such_tool"));
  // Two keys with the same name or the same token.
  CHECK(contains(failure(ok_key("k") + ok_key("k")), "two keys have the name k"));
  CHECK(contains(failure(ok_key("k") + ok_key("j")), "have the same token"));
  // A key that expired is a warning, not an error.
  write_file(path, mcp(ok_key("old", "expires = \"2020-01-01T00:00:00Z\"")));
  CHECK(contains(load_config_from_file(path).warnings.at(0), "mcp key old expired at 2020-01-01T00:00:00Z"));
  // A token of an older key (a UUID): accepted, with a warning to replace it.
  write_file(path, mcp("mcp_key \"legacy\" { token_file = \"" + dir + "/token-uuid\" }"));
  const AppConfig legacy = load_config_from_file(path);
  CHECK(legacy.mcp.keys.at(0).legacy_token);
  CHECK(contains(legacy.warnings.at(0), "the token is a UUID of an older version"));

  // The modes of the keys.
  CHECK(contains(failure("keys { mode = \"open\" }\n storage_file = \"" + dir + "/keys.json\""), "mcp.keys.mode must be one of static, dynamic and hybrid"));
  CHECK(contains(failure("keys { mode = \"dynamic\" }\n storage_file = \"" + dir + "/keys.json\"\n" + ok_key("k")), "takes the keys of the page only"));
  CHECK(contains(failure("keys { mode = \"dynamic\" }"), "needs mcp.storage_file"));
  CHECK(contains(failure("keys { mode = \"static\" }\n storage_file = \"" + dir + "/keys.json\""), "needs at least one mcp_key block"));
  CHECK(contains(failure("keys { mode = \"static\" }\n manage_from_ui = false\n" + ok_key("k")), "manage_from_ui and mcp.keys.mode are both in the file"));
  write_file(path, mcp("keys { mode = \"static\" }\n" + ok_key("k")));
  CHECK(load_config_from_file(path).mcp.keys_mode == McpKeysMode::Static);
  // manage_from_ui = false is the static mode, with a warning.
  write_file(path, mcp("manage_from_ui = false\n" + ok_key("k")));
  const AppConfig older = load_config_from_file(path);
  CHECK(older.mcp.keys_mode == McpKeysMode::Static && !older.mcp.manage_from_ui);
  CHECK(contains(older.warnings.at(0), "mcp.manage_from_ui is deprecated"));
  // The older key block: read, with a warning.
  write_file(path, mcp("key { name = \"old\"\n secret_file = \"" + dir + "/token-b\"\n hosts = [\"h\"] }"));
  const AppConfig old_block = load_config_from_file(path);
  CHECK_EQ(old_block.mcp.keys.at(0).name, std::string("old"));
  CHECK(contains(old_block.warnings.at(0), "the key block is deprecated"));
  // A label on another block of mcp.
  CHECK(contains(failure("key \"x\" { name = \"x\" }"), "mcp.key takes no label"));
  // RFC 3339 times.
  int64_t at = 0;
  CHECK(mcp_parse_rfc3339("2027-10-15T00:00:00Z", &at) && at == 1823558400);
  CHECK(mcp_parse_rfc3339("2027-10-15T00:00:00.123Z", &at) && at == 1823558400);
  CHECK(mcp_parse_rfc3339("2027-10-14T19:00:00-05:00", &at) && at == 1823558400);
  CHECK(!mcp_parse_rfc3339("2027-10-15", &at) && !mcp_parse_rfc3339("2027-10-15T00:00:00", &at) && !mcp_parse_rfc3339("2027-10-15T00:00:00+2:00", &at));
}

// ---- the effective configuration: hosts, keys, libraries, lists and their sources (CHD-CFG-8) ----

void test_effective_config() {
  write_file(dir + "/pw-eff", "never-shown\n");
  write_file(dir + "/eff-key", "a11da7a0-0000-4000-8000-0000000000b1\n");
  ::setenv("CHDASH_TEST_EFF_PW", "never-shown-either", 1);
  const std::string text =
      "server { listen_port = 9191 }\n"
      "observability { service_allowlist = [\"api\", \"re:^web-.*$\"]\n traces { highlighted_attributes = [\"http.route\"] } }\n"
      "query_library { enabled = true\n name = \"team\"\n file = \"/lib/team.json\"\n writable = true }\n"
      "mcp { enabled = true\n allowed_origins = [\"https://a.example\"]\n key { name = \"ci\"\n secret_file = \"" + dir + "/eff-key\"\n hosts = [\"h\"]\n tools = [\"list_databases\"]\n databases = [\"otel\"]\n max_rows = 10 } }\n"
      "clickhouse { host { name = \"h\"\n label = \"Main\"\n runner_uri = \"clickhouse://r@h:9000\"\n system_uri = \"clickhouse://s@h:9000\"\n"
      " mcp_uri = \"clickhouse://m@h:9000\"\n runner_password_file = \"" + dir + "/pw-eff\"\n system_password_env = \"CHDASH_TEST_EFF_PW\"\n"
      " observability { traces { table = \"spans\" } } } }\n";
  const std::string path = dir + "/effective.hcl";
  write_file(path, text);
  const AppConfig cfg = load_config_from_file(path);
  std::map<std::string, std::pair<std::string, std::string>> by_name;
  for (const auto& value : config::effective_config(cfg)) {
    CHECK(!contains(value.value, "never-shown") && !contains(value.value, "a11da7a0"));
    by_name[value.name] = {value.value, value.source};
  }
  const auto is = [&](const std::string& name, const std::string& value, const std::string& source) {
    const auto found = by_name.find(name);
    const bool ok = found != by_name.end() && found->second.first == value && found->second.second == source;
    if (!ok) std::cerr << "effective value " << name << ": " << (found == by_name.end() ? "missing" : found->second.first + " from " + found->second.second) << std::endl;
    CHECK(ok);
  };
  is("server.listen", "0.0.0.0:9191", "file");
  is("server.worker_threads", std::to_string(cfg.server.worker_threads), "default");
  is("observability.service_allowlist", "[\"api\", \"re:^web-.*$\"]", "file");
  is("observability.traces.highlighted_attributes", "[\"http.route\"]", "file");
  is("mcp.allowed_origins", "[\"https://a.example\"]", "file");
  is("mcp.auth_header", "Authorization", "default");
  is("clickhouse.host[h].label", "Main", "file");
  is("clickhouse.host[h].runner_uri", "clickhouse://r:***@h:9000", "file");
  is("clickhouse.host[h].runner_password", "<hidden>", "file:" + dir + "/pw-eff");
  is("clickhouse.host[h].system_password", "<hidden>", "env:CHDASH_TEST_EFF_PW");
  is("clickhouse.host[h].mcp_uri", "clickhouse://m@h:9000", "file");
  is("clickhouse.host[h].mcp_password", "<none>", "default");
  is("clickhouse.host[h].observability.traces.table", "spans", "file");
  is("query_library[team].file", "/lib/team.json", "file");
  is("query_library[team].writable", "true", "file");
  is("query_library[team].max_file_bytes", "8388608", "default");
  is("mcp.key[ci].hosts", "[\"h\"]", "file");
  is("mcp.key[ci].tools", "[\"list_databases\"]", "file");
  is("mcp.key[ci].databases", "[\"otel\"]", "file");
  is("mcp.key[ci].max_rows", "10", "file");
  is("mcp.key[ci].timeout_seconds", "30", "default");
  is("mcp.key[ci].secret", "<hidden>", "file:" + dir + "/eff-key");
}

// ---- contradictions: system and explorer.operations (CHD-CFG-6) ----

void test_operations_and_system() {
  CHECK_EQ(error_of("explorer { operations { keeper = false } }"), std::string(""));
  CHECK(!load("explorer { operations { keeper = false } }").system.keeper);
  CHECK(load("explorer { operations { keeper = false } }").system.activity);
  const AppConfig off = load("explorer { operations { enabled = false } }");
  CHECK(!off.system.activity && !off.system.keeper);
  CHECK(contains(error_of("explorer { operations { keeper = false } }\nsystem { activity = true }"),
                 "explorer.operations and the system block are both in the file: remove explorer.operations"));
  CHECK(contains(error_of("explorer { operations { enabled = true } }\nsystem { }"), "explorer.operations and the system block are both in the file"));
  CHECK(contains(error_of("explorer { operations { enabled = false\n keeper = true } }"), "explorer.operations.enabled = false and explorer.operations.keeper = true contradict"));
  CHECK_EQ(error_of("system { keeper = false }"), std::string(""));
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
  // The parser keeps one label. The loader refuses it on each block except mcp_key (config.cpp).
  CHECK_EQ(hcl_error("host \"x\" { }"), std::string(""));
  CHECK(parse_hcl("blk \"lab\" { a = 1 }").blocks.at("blk")[0].labeled);
  CHECK_EQ(parse_hcl("blk \"lab\" { a = 1 }").blocks.at("blk")[0].label, std::string("lab"));
  CHECK(!parse_hcl("blk { a = 1 }").blocks.at("blk")[0].labeled);
  CHECK(contains(hcl_error("host \"x\" \"y\" { }"), "a block has one label at most"));
  CHECK(contains(hcl_error("host \"x\" = 1"), "expected '{' after the label"));
  CHECK(contains(error_of("server \"x\" { }"), "server takes no label"));
  CHECK(contains(error_of("observability { traces \"t\" { } }"), "observability.traces takes no label"));
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
  test_mcp_usage_block();
  test_uris();
  test_secrets();
  test_mcp_key_secrets();
  test_telemetry_block();
  test_access_block();
  try {
    test_mcp_key_block();
  } catch (const std::exception& e) {
    ++g_failures;
    std::cerr << "test_mcp_key_block: threw " << e.what() << std::endl;
  }
  test_effective_config();
  test_operations_and_system();
  test_hcl();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
