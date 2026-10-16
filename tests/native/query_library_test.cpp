// Unit tests of the query library. They test the store (src/query_library.cpp).
// They also test the units below the store that work without a file.
// These units are the request reader (query_library_request.cpp), the rules of the tree (query_library_rules.cpp),
// and the import (query_library_import.cpp).
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF
//          -DCHDASH_BUILD_QUERY_LIBRARY_TESTS=ON
//        cmake --build build --target chdash_query_library_test
// Run:   ./build/chdash_query_library_test   (exit code 0 = every check passed)
// The Python harness (test_native_unit_tests.py) runs the binary when QUERY_LIBRARY_TEST_BINARY names it.

#include "query_library.hpp"
#include "query_library_read.hpp"
#include "query_library_import.hpp"
#include "query_library_json.hpp"
#include "query_library_request.hpp"
#include "query_library_rules.hpp"

#include <rapidjson/document.h>

#include <sys/stat.h>
#include <unistd.h>

#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

using chdash::QueryLibraryOptions;
using chdash::QueryLibraryStore;

namespace {

int g_failures = 0;
int g_checks = 0;

// The configured hosts of options_for(); every request names one of them.
const std::string kLocal = "local";
const std::string kOther = "other";
const std::string* const LOCAL = &kLocal;
const std::string* const OTHER = &kOther;

#define CHECK(cond)                                                                        \
  do {                                                                                     \
    ++g_checks;                                                                            \
    if (!(cond)) {                                                                         \
      ++g_failures;                                                                        \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: " #cond << std::endl;   \
    }                                                                                      \
  } while (0)

#define CHECK_STATUS(resp, expected)                                                                     \
  do {                                                                                                   \
    ++g_checks;                                                                                          \
    if ((resp).status != (expected)) {                                                                   \
      ++g_failures;                                                                                      \
      std::cerr << __FILE__ << ":" << __LINE__ << ": status " << (resp).status << " != " << (expected)  \
                << " body=" << (resp).body << std::endl;                                                 \
    }                                                                                                    \
  } while (0)

rapidjson::Document json(const QueryLibraryStore::Response& r) {
  rapidjson::Document d;
  d.Parse(r.body.c_str());
  if (d.HasParseError() || !d.IsObject()) {
    std::cerr << "not a JSON object: " << r.body << std::endl;
    std::exit(2);
  }
  return d;
}

std::string str(const rapidjson::Value& v, const char* key) {
  if (!v.HasMember(key) || !v[key].IsString()) return {};
  return v[key].GetString();
}

int64_t num(const rapidjson::Value& v, const char* key) {
  if (!v.HasMember(key) || !v[key].IsInt64()) return -1;
  return v[key].GetInt64();
}

std::string read_file(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  return std::string{std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

void write_plain(const std::string& path, const std::string& text) {
  // Replace the file with a new inode, as an editor does with a save as (rename).
  const std::string tmp = path + ".edit";
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    out << text;
  }
  CHECK(std::rename(tmp.c_str(), path.c_str()) == 0);
}

size_t count_entries(const std::string& dir) {
  size_t n = 0;
  if (DIR* d = ::opendir(dir.c_str())) {
    while (auto* e = ::readdir(d)) {
      if (std::strcmp(e->d_name, ".") != 0 && std::strcmp(e->d_name, "..") != 0) ++n;
    }
    ::closedir(d);
  }
  return n;
}

std::string make_temp_dir() {
  const char* base = std::getenv("TMPDIR");
  std::string templ = std::string(base && *base ? base : "/tmp") + "/chdash-qlib-XXXXXX";
  std::vector<char> buf(templ.begin(), templ.end());
  buf.push_back('\0');
  if (!::mkdtemp(buf.data())) {
    std::perror("mkdtemp");
    std::exit(2);
  }
  return buf.data();
}

QueryLibraryOptions options_for(const std::string& file) {
  QueryLibraryOptions o;
  o.file = file;
  o.writable = true;
  o.max_file_bytes = 64 * 1024;
  o.max_query_bytes = 2048;
  o.host_ids = {kLocal, kOther};
  return o;
}

std::string folder_body(const std::string& name, const std::string& parent = "", const std::string& host = kLocal) {
  return std::string("{\"host_id\":\"") + host + "\",\"name\":\"" + name + "\",\"parent_id\":" +
         (parent.empty() ? "null" : "\"" + parent + "\"") + "}";
}

std::string query_body(const std::string& name, const std::string& sql, const std::string& folder = "",
                       const std::string& host = kLocal) {
  return std::string("{\"host_id\":\"") + host + "\",\"name\":\"" + name + "\",\"sql\":\"" + sql +
         "\",\"folder_id\":" + (folder.empty() ? "null" : "\"" + folder + "\"") + "}";
}

void test_atomic_write(const std::string& dir) {
  const std::string path = dir + "/atomic.json";
  std::string error;
  CHECK(chdash::atomic_write_file(path, "first", &error));
  CHECK(read_file(path) == "first");
  struct stat st {};
  CHECK(::stat(path.c_str(), &st) == 0);
  CHECK((st.st_mode & 0777) == 0600);
  const ino_t first_inode = st.st_ino;
  CHECK(chdash::atomic_write_file(path, "second", &error));
  CHECK(read_file(path) == "second");
  CHECK(::stat(path.c_str(), &st) == 0);
  CHECK(st.st_ino != first_inode);  // replaced by rename, never rewritten in place
  CHECK((st.st_mode & 0777) == 0600);
  CHECK(count_entries(dir) == 1);   // no temporary file left behind
  CHECK(!chdash::atomic_write_file(dir + "/missing-dir/x.json", "x", &error));
  CHECK(!error.empty());
  CHECK(count_entries(dir) == 1);
}

void test_crud_tree_and_conflicts(const std::string& dir) {
  const std::string path = dir + "/library.json";
  QueryLibraryStore store(options_for(path));
  auto lib = json(store.export_library(LOCAL, nullptr));
  CHECK(num(lib, "revision") == 0);
  CHECK(lib["writable"].GetBool());
  CHECK(lib["load_error"].IsNull());
  CHECK(::access(path.c_str(), F_OK) != 0);  // created on first write only

  auto r = store.create_folder(folder_body("Reports"), nullptr);
  CHECK_STATUS(r, 201);
  const std::string reports = str(json(r), "id");
  CHECK(reports.rfind("f_", 0) == 0);
  CHECK(num(json(r), "revision") == 1);
  struct stat st {};
  CHECK(::stat(path.c_str(), &st) == 0);
  CHECK((st.st_mode & 0777) == 0600);

  // Sibling names are unique, case-insensitively.
  r = store.create_folder(folder_body("reports"), nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "field") == "name");
  CHECK(str(json(r), "reason") == "duplicate");

  // Validation.
  CHECK_STATUS(store.create_folder("{\"name\":\"\"}", nullptr), 400);
  CHECK_STATUS(store.create_folder("not json", nullptr), 400);
  CHECK_STATUS(store.create_folder(folder_body("x", "f_missing"), nullptr), 400);

  // Depth: the code allows 8 levels and refuses the 9th.
  std::vector<std::string> chain{reports};
  for (int level = 2; level <= 8; ++level) {
    r = store.create_folder(folder_body("L" + std::to_string(level), chain.back()), nullptr);
    CHECK_STATUS(r, 201);
    chain.push_back(str(json(r), "id"));
  }
  r = store.create_folder(folder_body("L9", chain.back()), nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "depth");

  // Moves: the code refuses cycles and a move into the folder itself.
  r = store.update_folder(reports, "{\"parent_id\":\"" + chain[3] + "\"}", nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "cycle");
  r = store.update_folder(reports, "{\"parent_id\":\"" + reports + "\"}", nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "cycle");

  r = store.create_folder(folder_body("Other"), nullptr);
  CHECK_STATUS(r, 201);
  const std::string other = str(json(r), "id");
  // A move of the 8-level chain below Other makes it 9 levels deep.
  r = store.update_folder(reports, "{\"parent_id\":\"" + other + "\"}", nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "depth");
  // A leaf can move.
  r = store.update_folder(chain.back(), "{\"parent_id\":\"" + other + "\"}", nullptr);
  CHECK_STATUS(r, 200);
  CHECK(str(json(r), "parent_id") == other);
  CHECK(!json(r).HasMember("description"));

  // Queries.
  r = store.create_query(query_body("Top tables", "SELECT 1", other), nullptr);
  CHECK_STATUS(r, 201);
  const std::string query = str(json(r), "id");
  CHECK(query.rfind("q_", 0) == 0);
  CHECK_STATUS(store.create_query(query_body("TOP TABLES", "SELECT 2", other), nullptr), 400);
  CHECK_STATUS(store.create_query(query_body("Top tables", "SELECT 2"), nullptr), 201);  // other folder
  CHECK_STATUS(store.create_query(query_body("Empty", "  "), nullptr), 400);
  const std::string big(3000, 'x');
  r = store.create_query(query_body("Big", big), nullptr);
  CHECK_STATUS(r, 413);
  CHECK(str(json(r), "field") == "sql");
  r = store.update_query(query, "{\"sql\":\"SELECT 3\"}", nullptr);
  CHECK_STATUS(r, 200);
  CHECK(!json(r).HasMember("tags"));
  CHECK(str(json(r), "sql") == "SELECT 3");
  CHECK_STATUS(store.update_query("q_missing", "{\"name\":\"x\"}", nullptr), 404);

  // If-Match.
  const int64_t revision = num(json(store.export_library(LOCAL, nullptr)), "revision");
  const std::string stale = std::to_string(revision - 1);
  r = store.update_query(query, "{\"name\":\"Renamed\"}", &stale);
  CHECK_STATUS(r, 409);
  CHECK(str(json(r), "error_code") == "conflict");
  CHECK(num(json(r), "revision") == revision);
  const std::string current = "\"" + std::to_string(revision) + "\"";
  r = store.update_query(query, "{\"name\":\"Renamed\"}", &current);
  CHECK_STATUS(r, 200);
  CHECK(num(json(r), "revision") == revision + 1);
  const std::string any = "*";
  CHECK_STATUS(store.update_query(query, "{\"name\":\"Renamed again\"}", &any), 200);
  const std::string garbage = "abc";
  CHECK_STATUS(store.update_query(query, "{\"name\":\"x\"}", &garbage), 400);

  // Delete: a non-empty folder needs the recursive option.
  r = store.delete_folder(other, false, nullptr);
  CHECK_STATUS(r, 409);
  CHECK(str(json(r), "error_code") == "not_empty");
  r = store.delete_folder(reports, true, nullptr);
  CHECK_STATUS(r, 200);
  CHECK(num(json(r), "deleted_folders") == 7);  // Reports + L2..L7 (L8 moved away)
  r = store.delete_folder(other, true, nullptr);
  CHECK_STATUS(r, 200);
  CHECK(num(json(r), "deleted_folders") == 2);
  CHECK(num(json(r), "deleted_queries") == 1);
  CHECK_STATUS(store.delete_folder(other, true, nullptr), 404);
  lib = json(store.export_library(LOCAL, nullptr));
  CHECK(lib["folders"].Size() == 0);
  CHECK(lib["queries"].Size() == 1);

  // Persistence: a new store on the same file reads the same library.
  QueryLibraryStore again(options_for(path));
  auto lib2 = json(again.export_library(LOCAL, nullptr));
  CHECK(num(lib2, "revision") == num(lib, "revision"));
  CHECK(lib2["queries"].Size() == 1);
}

// The history of the runs is in the browser. A file of an earlier release that still holds one loads without it.
// The store never writes a history to a file.
void test_history_is_not_kept(const std::string& dir) {
  const std::string path = dir + "/history.json";
  write_plain(path, "{\"version\":2,\"revision\":3,\"folders\":[],\"queries\":["
                    "{\"id\":\"q_a\",\"host_id\":\"local\",\"name\":\"A\",\"sql\":\"SELECT 1\"}],"
                    "\"history\":[{\"id\":\"h_1\",\"sql\":\"SELECT history_marker_1\",\"host_id\":\"local\",\"ran_at_ms\":1000},"
                    "{\"id\":\"h_2\",\"sql\":\"SELECT history_marker_2\",\"host_id\":\"local\",\"ran_at_ms\":2000}]}");
  std::ostringstream captured;
  auto* old = std::cerr.rdbuf(captured.rdbuf());
  {
    QueryLibraryStore store(options_for(path));
    CHECK(store.writable());
    auto lib = json(store.export_library(LOCAL, nullptr));
    CHECK(lib["load_error"].IsNull());
    CHECK(lib["queries"].Size() == 1);
    CHECK(!lib.HasMember("history_store"));
    CHECK(!lib["limits"].HasMember("history_max_entries"));
    // The writable library rewrote the file without the history.
    rapidjson::Document file;
    file.Parse(read_file(path).c_str());
    CHECK(!file.HasParseError());
    CHECK(!file.HasMember("history"));
    CHECK(file["queries"].Size() == 1);
    CHECK(read_file(path).find("history_marker") == std::string::npos);
    CHECK_STATUS(store.create_query(query_body("B", "SELECT 2"), nullptr), 201);
    file.Parse(read_file(path).c_str());
    CHECK(!file.HasMember("history"));

    // Read-only: the store ignores the history in memory and does not touch the file.
    const std::string ro_path = dir + "/history-ro.json";
    write_plain(ro_path, "{\"version\":2,\"revision\":1,\"folders\":[],\"queries\":[],"
                         "\"history\":[{\"id\":\"h_1\",\"sql\":\"SELECT history_marker_3\",\"host_id\":\"local\"}]}");
    const std::string before = read_file(ro_path);
    auto o = options_for(ro_path);
    o.writable = false;
    QueryLibraryStore ro(o);
    CHECK(json(ro.export_library(LOCAL, nullptr))["load_error"].IsNull());
    CHECK(read_file(ro_path) == before);
  }
  std::cerr.rdbuf(old);
  CHECK(captured.str().find("history entries") != std::string::npos);
  CHECK(captured.str().find("history_marker") == std::string::npos);  // SQL is never logged
}

void test_read_only(const std::string& dir) {
  const std::string path = dir + "/ro.json";
  auto o = options_for(path);
  o.writable = false;
  QueryLibraryStore store(o);
  CHECK(!store.writable());
  auto r = store.create_folder(folder_body("x"), nullptr);
  CHECK_STATUS(r, 403);
  CHECK(str(json(r), "error_code") == "read_only");
  CHECK_STATUS(store.create_query(query_body("x", "SELECT 1"), nullptr), 403);
  CHECK_STATUS(store.import_library("{\"host_id\":\"local\",\"queries\":[]}", nullptr), 403);
}

void test_malformed_and_reload(const std::string& dir) {
  const std::string path = dir + "/broken.json";
  const std::string broken = "{\"version\":1,\"folders\":[{\"id\":\"f_1\",\"name\":";
  write_plain(path, broken);

  std::ostringstream captured;
  auto* old = std::cerr.rdbuf(captured.rdbuf());
  {
    QueryLibraryStore store(options_for(path));
    auto lib = json(store.export_library(LOCAL, nullptr));
    CHECK(!lib["load_error"].IsNull());
    CHECK(!lib["writable"].GetBool());
    CHECK(!store.writable());
    auto r = store.create_folder(folder_body("x"), nullptr);
    CHECK_STATUS(r, 403);
    CHECK(json(r).HasMember("load_error"));
    CHECK(read_file(path) == broken);  // never overwritten

    // A fix of the file on disk clears the error. No restart is needed.
    write_plain(path, "{\"version\":2,\"revision\":7,\"folders\":[{\"id\":\"f_a\",\"host_id\":\"local\",\"parent_id\":null,\"name\":\"A\"}],"
                      "\"queries\":[{\"id\":\"q_a\",\"host_id\":\"local\",\"folder_id\":\"f_a\",\"name\":\"Q\",\"sql\":\"SELECT secret_marker_123\"}]}");
    lib = json(store.export_library(LOCAL, nullptr));
    CHECK(lib["load_error"].IsNull());
    CHECK(lib["writable"].GetBool());
    CHECK(num(lib, "revision") >= 7);
    CHECK(lib["queries"].Size() == 1);

    // An external edit with the same revision still moves the revision forward.
    const int64_t before = num(lib, "revision");
    write_plain(path, "{\"version\":2,\"revision\":7,\"folders\":[],\"queries\":[]}");
    lib = json(store.export_library(LOCAL, nullptr));
    CHECK(num(lib, "revision") > before);
    CHECK(lib["queries"].Size() == 0);

    // Structural problems are load errors too.
    write_plain(path, "{\"version\":2,\"folders\":[{\"id\":\"f_a\",\"host_id\":\"local\",\"parent_id\":\"f_b\",\"name\":\"A\"},"
                      "{\"id\":\"f_b\",\"host_id\":\"local\",\"parent_id\":\"f_a\",\"name\":\"B\"}]}");
    CHECK(!json(store.export_library(LOCAL, nullptr))["load_error"].IsNull());
    // A folder of one host inside a folder of another is inconsistent.
    write_plain(path, "{\"version\":2,\"folders\":[{\"id\":\"f_a\",\"host_id\":\"local\",\"name\":\"A\"},"
                      "{\"id\":\"f_b\",\"host_id\":\"other\",\"parent_id\":\"f_a\",\"name\":\"B\"}]}");
    CHECK(!json(store.export_library(LOCAL, nullptr))["load_error"].IsNull());
    write_plain(path, "{\"version\":3}");
    CHECK(!json(store.export_library(LOCAL, nullptr))["load_error"].IsNull());
    CHECK(read_file(path) == "{\"version\":3}");  // never rewritten
  }
  std::cerr.rdbuf(old);
  CHECK(captured.str().find("\"event\":\"query_library\"") != std::string::npos);
  CHECK(captured.str().find("secret_marker_123") == std::string::npos);  // SQL is never logged
}

void test_import(const std::string& dir) {
  const std::string path = dir + "/import.json";
  QueryLibraryStore store(options_for(path));
  CHECK_STATUS(store.create_query(query_body("Existing", "SELECT 1"), nullptr), 201);
  const std::string payload =
      "{\"host_id\":\"local\",\"folders\":[{\"id\":\"local-1\",\"parent_id\":null,\"name\":\"Imported\"},"
      "{\"id\":\"local-2\",\"parent_id\":\"local-1\",\"name\":\"Child\"}],"
      "\"queries\":[{\"name\":\"Existing\",\"sql\":\"SELECT 1\"},"
      "{\"name\":\"Existing\",\"sql\":\"SELECT 2\"},"
      "{\"name\":\"In child\",\"sql\":\"SELECT 3\",\"folder_id\":\"local-2\"},"
      "{\"name\":\"In child\",\"sql\":\"SELECT 3\",\"folder_id\":\"local-2\"}]}";
  auto r = json(store.import_library(payload, nullptr));
  CHECK(num(r, "imported_folders") == 2);
  CHECK(num(r, "imported_queries") == 2);
  CHECK(num(r, "skipped_queries") == 2);
  CHECK(r["folder_ids"].HasMember("local-2"));
  auto lib = json(store.export_library(LOCAL, nullptr));
  CHECK(lib["folders"].Size() == 2);
  CHECK(lib["queries"].Size() == 3);
  bool renamed = false;
  for (const auto& q : lib["queries"].GetArray()) renamed |= str(q, "name") == "Existing (2)";
  CHECK(renamed);
  const int64_t revision = num(lib, "revision");
  r = json(store.import_library(payload, nullptr));
  CHECK(num(r, "imported_folders") == 0);
  CHECK(num(r, "merged_folders") == 2);
  CHECK(num(r, "imported_queries") == 0);  // "Existing (2)" still matches "Existing" + SELECT 2
  CHECK(num(r, "skipped_queries") == 4);
  r = json(store.import_library(
      "{\"host_id\":\"local\",\"folders\":[{\"id\":\"a\",\"parent_id\":\"b\",\"name\":\"A\"},{\"id\":\"b\",\"parent_id\":\"a\",\"name\":\"B\"}]}",
      nullptr));
  CHECK(str(r, "reason") == "cycle");
  CHECK(num(json(store.export_library(LOCAL, nullptr)), "revision") == revision);  // nothing new: no write

  // "copy": a folder moves in from the browser's storage, under an existing folder.
  // The store does not merge, skip or rename anything. The same query twice stays twice.
  // A clashing folder name is a 400 duplicate, and the store writes nothing.
  std::string imported;
  const auto folders_now = json(store.export_library(LOCAL, nullptr));  // a named document: a range-for over a temporary dangles
  for (const auto& f : folders_now["folders"].GetArray()) {
    if (str(f, "name") == "Imported") imported = str(f, "id");
  }
  CHECK(!imported.empty());
  const std::string copy =
      "{\"host_id\":\"local\",\"copy\":true,\"folders\":[{\"id\":\"b-1\",\"parent_id\":\"" + imported + "\",\"name\":\"Moved\"},"
      "{\"id\":\"b-2\",\"parent_id\":\"b-1\",\"name\":\"Deeper\"}],"
      "\"queries\":[{\"name\":\"Existing\",\"sql\":\"SELECT 1\",\"folder_id\":\"b-1\"},"
      "{\"name\":\"Twin\",\"sql\":\"SELECT 1\",\"folder_id\":\"b-2\"}]}";
  r = json(store.import_library(copy, nullptr));
  CHECK(num(r, "imported_folders") == 2);
  CHECK(num(r, "merged_folders") == 0);
  CHECK(num(r, "imported_queries") == 2);
  CHECK(num(r, "skipped_queries") == 0);
  CHECK(r["folder_ids"].HasMember("b-1"));
  const std::string moved = str(r["folder_ids"], "b-1");
  lib = json(store.export_library(LOCAL, nullptr));
  bool parented = false;
  bool kept_name = false;
  for (const auto& f : lib["folders"].GetArray()) parented |= str(f, "id") == moved && str(f, "parent_id") == imported;
  for (const auto& q : lib["queries"].GetArray()) kept_name |= str(q, "name") == "Existing" && str(q, "folder_id") == moved;
  CHECK(parented && kept_name);
  const int64_t before_clash = num(lib, "revision");
  r = json(store.import_library(copy, nullptr));
  CHECK(str(r, "reason") == "duplicate");
  CHECK(num(json(store.export_library(LOCAL, nullptr)), "revision") == before_clash);
  CHECK_STATUS(store.import_library("{\"host_id\":\"local\",\"copy\":1,\"folders\":[]}", nullptr), 400);
}

void test_file_limit(const std::string& dir) {
  const std::string path = dir + "/limit.json";
  auto o = options_for(path);
  o.max_file_bytes = 16 * 1024;
  o.max_query_bytes = 2048;
  QueryLibraryStore store(o);
  int created = 0;
  QueryLibraryStore::Response r;
  for (int i = 0; i < 40; ++i) {
    r = store.create_query(query_body("q" + std::to_string(i), std::string(1500, 'q')), nullptr);
    if (r.status != 201) break;
    ++created;
  }
  CHECK_STATUS(r, 413);
  CHECK(str(json(r), "error_code") == "too_large");
  CHECK(created >= 5);
  struct stat st {};
  CHECK(::stat(path.c_str(), &st) == 0);
  CHECK(static_cast<size_t>(st.st_size) <= o.max_file_bytes);
}

// Folders and queries belong to one host. Reads filter by host.
// The host is required and must be configured. The store refuses a move across hosts.
void test_per_host(const std::string& dir) {
  const std::string path = dir + "/hosts.json";
  QueryLibraryStore store(options_for(path));
  const std::string unknown = "elsewhere";
  const std::string empty;
  auto r = store.export_library(nullptr, nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "field") == "host_id");
  CHECK(str(json(r), "reason") == "required");
  CHECK(str(json(store.export_library(&empty, nullptr)), "reason") == "required");
  r = store.export_library(&unknown, nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "unknown_host");
  // Writes name their host.
  r = store.create_folder("{\"name\":\"No host\"}", nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "field") == "host_id");
  CHECK_STATUS(store.create_folder(folder_body("Unknown", "", unknown), nullptr), 400);
  CHECK_STATUS(store.create_query("{\"name\":\"q\",\"sql\":\"SELECT 1\"}", nullptr), 400);
  CHECK_STATUS(store.create_query("{\"name\":\"q\",\"sql\":\"SELECT 1\",\"host_id\":7}", nullptr), 400);
  CHECK_STATUS(store.import_library("{\"queries\":[]}", nullptr), 400);

  r = store.create_folder(folder_body("Ops"), nullptr);
  CHECK_STATUS(r, 201);
  CHECK(str(json(r), "host_id") == "local");
  const std::string local_ops = str(json(r), "id");
  // The same name at the top level of another host is another folder.
  r = store.create_folder(folder_body("Ops", "", kOther), nullptr);
  CHECK_STATUS(r, 201);
  const std::string other_ops = str(json(r), "id");
  r = store.create_query(query_body("Parts", "SELECT 1", local_ops), nullptr);
  CHECK_STATUS(r, 201);
  CHECK(str(json(r), "host_id") == "local");
  const std::string local_query = str(json(r), "id");
  CHECK_STATUS(store.create_query(query_body("Parts", "SELECT 2", other_ops, kOther), nullptr), 201);
  CHECK_STATUS(store.create_query(query_body("Top", "SELECT 3", "", kOther), nullptr), 201);

  auto lib = json(store.export_library(LOCAL, nullptr));
  CHECK(str(lib, "host_id") == "local");
  CHECK(lib["folders"].Size() == 1);
  CHECK(lib["queries"].Size() == 1);
  CHECK(str(lib["folders"][0], "host_id") == "local");
  auto other = json(store.export_library(OTHER, nullptr));
  CHECK(other["folders"].Size() == 1);
  CHECK(other["queries"].Size() == 2);
  CHECK(num(lib, "revision") == num(other, "revision"));  // one library revision

  // Across hosts: 400 host_mismatch, nothing changes.
  const int64_t revision = num(lib, "revision");
  r = store.create_query(query_body("Cross", "SELECT 4", other_ops), nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "host_mismatch");
  CHECK(str(json(r), "field") == "folder_id");
  r = store.update_query(local_query, "{\"folder_id\":\"" + other_ops + "\"}", nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "host_mismatch");
  r = store.update_query(local_query, "{\"host_id\":\"other\"}", nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "host_mismatch");
  CHECK_STATUS(store.update_query(local_query, "{\"host_id\":\"local\",\"name\":\"Parts\"}", nullptr), 200);
  r = store.create_folder(folder_body("Child", other_ops), nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "host_mismatch");
  r = store.update_folder(local_ops, "{\"parent_id\":\"" + other_ops + "\"}", nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "host_mismatch");
  CHECK(num(json(store.export_library(LOCAL, nullptr)), "revision") == revision);
  // Moves inside a host work.
  CHECK_STATUS(store.update_query(local_query, "{\"folder_id\":null}", nullptr), 200);

  // Import keeps the request's host, whatever the payload says.
  r = store.import_library(
      "{\"host_id\":\"other\",\"folders\":[{\"id\":\"b1\",\"name\":\"Imported\"}],"
      "\"queries\":[{\"name\":\"Imp\",\"sql\":\"SELECT 9\",\"host_id\":\"local\",\"folder_id\":\"b1\"},"
      "{\"name\":\"Into local\",\"sql\":\"SELECT 10\",\"folder_id\":\"" + local_ops + "\"}]}",
      nullptr);
  CHECK_STATUS(r, 200);
  CHECK(num(json(r), "imported_queries") == 2);
  other = json(store.export_library(OTHER, nullptr));
  CHECK(other["queries"].Size() == 4);
  for (const auto& q : other["queries"].GetArray()) {
    CHECK(str(q, "host_id") == "other");
    if (str(q, "name") == "Into local") CHECK(q["folder_id"].IsNull());  // a folder of another host means the top level
  }
  CHECK(json(store.export_library(LOCAL, nullptr))["queries"].Size() == 1);

  // On disk: version 2, a host on every entry.
  rapidjson::Document file;
  file.Parse(read_file(path).c_str());
  CHECK(file["version"].GetInt() == 2);
  CHECK(!file.HasMember("history"));
  for (const auto* key : {"folders", "queries"}) {
    for (const auto& item : file[key].GetArray()) CHECK(!str(item, "host_id").empty());
  }
}

// A version-1 file has folders without a host. Entries without a host are dropped on load.
// A writable library rewrites the file as version 2. A read-only library serves the cleaned library
// and never touches the file.
const char* kVersion1 =
    "{\"version\":1,\"revision\":4,\"folders\":["
    "{\"id\":\"f_ops\",\"parent_id\":null,\"name\":\"Operations\"},"
    "{\"id\":\"f_sub\",\"parent_id\":\"f_ops\",\"name\":\"Merges\"}],"
    "\"queries\":["
    "{\"id\":\"q_hostless\",\"folder_id\":null,\"name\":\"No host\",\"sql\":\"SELECT 1\",\"host_id\":null},"
    "{\"id\":\"q_in_folder\",\"folder_id\":\"f_sub\",\"name\":\"Parts\",\"sql\":\"SELECT 2\",\"host_id\":\"local\"},"
    "{\"id\":\"q_top\",\"folder_id\":null,\"name\":\"Top\",\"sql\":\"SELECT 3\",\"host_id\":\"other\"}],"
    "\"history\":["
    "{\"id\":\"h_1\",\"sql\":\"SELECT 4\",\"host_id\":null,\"ran_at_ms\":1000},"
    "{\"id\":\"h_2\",\"sql\":\"SELECT 5\",\"host_id\":\"local\",\"ran_at_ms\":2000},"
    "{\"id\":\"h_3\",\"sql\":\"SELECT 6\",\"ran_at_ms\":3000}]}";

void check_migrated(QueryLibraryStore& store) {
  auto lib = json(store.export_library(LOCAL, nullptr));
  CHECK(lib["load_error"].IsNull());
  CHECK(lib["folders"].Size() == 0);
  CHECK(lib["queries"].Size() == 1);
  CHECK(str(lib["queries"][0], "id") == "q_in_folder");
  CHECK(lib["queries"][0]["folder_id"].IsNull());  // its folder had no host: the top level
  CHECK(num(lib, "revision") == 4);
  auto other = json(store.export_library(OTHER, nullptr));
  CHECK(other["queries"].Size() == 1);
}

void test_migration(const std::string& dir) {
  std::ostringstream captured;
  auto* old = std::cerr.rdbuf(captured.rdbuf());
  {
    // Writable: dropped, then rewritten atomically as version 2.
    const std::string path = dir + "/v1-writable.json";
    write_plain(path, kVersion1);
    struct stat before {};
    CHECK(::stat(path.c_str(), &before) == 0);
    QueryLibraryStore store(options_for(path));
    CHECK(store.writable());
    check_migrated(store);
    struct stat after {};
    CHECK(::stat(path.c_str(), &after) == 0);
    CHECK(after.st_ino != before.st_ino);  // replaced by rename
    CHECK((after.st_mode & 0777) == 0600);
    rapidjson::Document file;
    file.Parse(read_file(path).c_str());
    CHECK(!file.HasParseError());
    CHECK(file["version"].GetInt() == 2);
    CHECK(file["folders"].Size() == 0);
    CHECK(file["queries"].Size() == 2);
    CHECK(!file.HasMember("history"));  // an earlier release's history is dropped
    CHECK(num(file, "revision") == 4);
    // The load of the rewritten file changes nothing more.
    const std::string rewritten = read_file(path);
    QueryLibraryStore again(options_for(path));
    check_migrated(again);
    CHECK(read_file(path) == rewritten);
    // Still editable after the migration.
    CHECK_STATUS(again.create_folder(folder_body("Operations"), nullptr), 201);

    // Read-only: the store keeps the same library in memory and does not touch the file.
    const std::string ro_path = dir + "/v1-readonly.json";
    write_plain(ro_path, kVersion1);
    auto o = options_for(ro_path);
    o.writable = false;
    QueryLibraryStore ro(o);
    check_migrated(ro);
    CHECK(read_file(ro_path) == kVersion1);
    CHECK_STATUS(ro.create_folder(folder_body("x"), nullptr), 403);
    CHECK(read_file(ro_path) == kVersion1);

    // A version-2 file that holds entries without a host drops them and rewrites the file.
    const std::string v2_path = dir + "/v2-hostless.json";
    write_plain(v2_path, "{\"version\":2,\"revision\":1,\"folders\":[{\"id\":\"f_x\",\"name\":\"X\"}],"
                         "\"queries\":[{\"id\":\"q_x\",\"name\":\"X\",\"sql\":\"SELECT 1\",\"host_id\":\"local\"}]}");
    QueryLibraryStore v2(options_for(v2_path));
    CHECK(json(v2.export_library(LOCAL, nullptr))["folders"].Size() == 0);
    CHECK(json(v2.export_library(LOCAL, nullptr))["queries"].Size() == 1);
    rapidjson::Document v2file;
    v2file.Parse(read_file(v2_path).c_str());
    CHECK(v2file["folders"].Size() == 0);

    // An external edit that adds a version-1 file migrates it on reload.
    write_plain(v2_path, kVersion1);
    check_migrated(v2);
    v2file.Parse(read_file(v2_path).c_str());
    CHECK(v2file["version"].GetInt() == 2);

    // A malformed file is never rewritten, whatever its version.
    const std::string bad_path = dir + "/v1-broken.json";
    const std::string broken = std::string(kVersion1).substr(0, 120);
    write_plain(bad_path, broken);
    QueryLibraryStore bad(options_for(bad_path));
    CHECK(!json(bad.export_library(LOCAL, nullptr))["load_error"].IsNull());
    CHECK(read_file(bad_path) == broken);
  }
  std::cerr.rdbuf(old);
  CHECK(captured.str().find("migrated") != std::string::npos);
  CHECK(captured.str().find("SELECT") == std::string::npos);  // SQL is never logged
}

// ---- the units below the store: no file ----

chdash::QueryLibraryState small_state() {
  chdash::QueryLibraryState state;
  const auto folder = [&](const char* id, const char* host, const char* parent, const char* name) {
    chdash::QueryLibraryFolder f;
    f.id = id;
    f.host_id = host;
    if (parent) f.parent_id = std::string(parent);
    f.name = name;
    state.folders.push_back(f);
  };
  folder("f1", "local", nullptr, "Ops");
  folder("f2", "local", "f1", "Daily");
  folder("f3", "local", "f2", "Deep");
  folder("f4", "other", nullptr, "ops");
  chdash::QueryLibraryQuery q;
  q.id = "q1";
  q.host_id = "local";
  q.folder_id = std::string("f2");
  q.name = "Top";
  q.sql = "SELECT 1";
  state.queries.push_back(q);
  return state;
}

template <typename Fn>
std::string refused_with(Fn&& fn) {
  try {
    fn();
  } catch (const chdash::qlib::LibraryError& e) {
    return e.code + "/" + e.field + "/" + e.reason;
  }
  return "accepted";
}

rapidjson::Document parsed(const char* text) {
  rapidjson::Document d;
  d.Parse(text);
  return d;
}

void test_the_rules_of_the_tree() {
  using namespace chdash::qlib;
  const auto state = small_state();
  const std::string f1_id = "f1";
  CHECK(find_folder(state, "f2") != nullptr && find_folder(state, "nope") == nullptr);
  CHECK(folder_depth(state, std::nullopt) == 0);
  CHECK(folder_depth(state, std::string("f3")) == 3);
  CHECK(folder_depth(state, std::string("f4")) == 1);
  const auto subtree = folder_subtree(state, "f1");
  CHECK(subtree.size() == 3 && subtree[0].second == 1 && subtree[2].first == "f3" && subtree[2].second == 3);
  // A name is free per host and folder. The code compares names without the case of ASCII letters.
  CHECK(folder_name_taken(state, "local", std::nullopt, "OPS", nullptr));
  CHECK(!folder_name_taken(state, "local", std::nullopt, "OPS", &f1_id));
  CHECK(folder_name_taken(state, "other", std::nullopt, "OPS", nullptr));
  CHECK(!folder_name_taken(state, "local", std::string("f1"), "Ops", nullptr));
  CHECK(query_name_taken(state, "local", std::string("f2"), "top", nullptr));
  CHECK(!query_name_taken(state, "other", std::string("f2"), "top", nullptr));
  CHECK(unique_query_name(state, "local", std::string("f2"), "Top") == "Top (2)");
  CHECK(unique_query_name(state, "local", std::string("f2"), "Free") == "Free");
  // The depth that a move or a create would reach.
  CHECK(refused_with([&] { ensure_depth(state, std::string("f3"), 5, "parent_id"); }) == "accepted");
  CHECK(refused_with([&] { ensure_depth(state, std::string("f3"), 6, "parent_id"); }) == "validation/parent_id/depth");
  // A folder reference names a folder of the same host.
  const auto doc = parsed("{\"parent_id\":\"f4\",\"gone\":\"zz\",\"top\":null,\"ok\":\"f1\"}");
  CHECK(refused_with([&] { existing_folder_ref(state, member(doc, "parent_id"), "parent_id", "local"); }) == "validation/parent_id/host_mismatch");
  CHECK(refused_with([&] { existing_folder_ref(state, member(doc, "gone"), "gone", "local"); }) == "validation/gone/not_found");
  CHECK(!existing_folder_ref(state, member(doc, "top"), "top", "local").has_value());
  CHECK(existing_folder_ref(state, member(doc, "ok"), "ok", "local") == std::string("f1"));
  // An import compares name and SQL. It ignores the suffix that an earlier import added.
  CHECK(import_key("Top (2)", "S") == import_key("Top", "S"));
  CHECK(import_key("Top (x)", "S") != import_key("Top", "S"));
  CHECK(import_key("Top", "S") != import_key("Top", "T"));
}

void test_the_fields_of_a_request() {
  using namespace chdash::qlib;
  const auto doc = parsed("{\"name\":\"  Daily  \",\"empty\":\"  \",\"ctl\":\"a\\u0001\",\"num\":5,\"sql\":\"SELECT 1\","
                          "\"neg\":-1,\"float\":2.6,\"big\":1e300,\"d\":\"x\\u0000y\"}");
  CHECK(read_name(member(doc, "name"), "name") == "Daily");
  CHECK(refused_with([&] { read_name(nullptr, "name"); }) == "validation/name/required");
  CHECK(refused_with([&] { read_name(member(doc, "empty"), "empty"); }) == "validation/empty/required");
  CHECK(refused_with([&] { read_name(member(doc, "ctl"), "ctl"); }) == "validation/ctl/invalid");
  CHECK(refused_with([&] { read_name(member(doc, "num"), "num"); }) == "validation/num/type");
  CHECK(refused_with([&] { read_sql(member(doc, "sql"), "sql", 3); }) == "too_large/sql/");
  CHECK(read_sql(member(doc, "sql"), "sql", 100) == "SELECT 1");
  CHECK(refused_with([&] { read_description(member(doc, "d"), "d"); }) == "validation/d/invalid");
  CHECK(read_description(nullptr, "d").empty());
  CHECK(read_opt_int(member(doc, "num"), "num") == 5);
  CHECK(read_opt_int(member(doc, "float"), "float") == 3);
  CHECK(!read_opt_int(nullptr, "none").has_value());
  CHECK(refused_with([&] { read_opt_int(member(doc, "neg"), "neg"); }) == "validation/neg/range");
  CHECK(refused_with([&] { read_opt_int(member(doc, "big"), "big"); }) == "validation/big/range");
  CHECK(refused_with([&] { parse_body("[1]"); }) == "validation/body/invalid_json");
  CHECK(refused_with([&] { parse_body("{"); }) == "validation/body/invalid_json");
  CHECK(parse_if_match_revision("W/\"7\"") == 7);
  CHECK(!parse_if_match_revision("*").has_value());
  CHECK(refused_with([&] { parse_if_match_revision("seven"); }) == "validation/If-Match/invalid");
  CHECK(trim_ascii(" \t x \n") == "x");
  CHECK(fold_ascii("AbC-\xC3\x89") == "abc-\xC3\x89");
  CHECK(truncate_utf8("a\xC3\xA9" "b", 2) == "a");
  // The error answer uses the one envelope. It gives what a client reads to fix the call.
  LibraryError e = validation("name", "duplicate", "taken");
  e.revision = 9;
  const auto answer = render_error(e);
  CHECK(answer.status == 400 && answer.body.find("\"field\":\"name\"") != std::string::npos && answer.body.find("\"revision\":9") != std::string::npos);
}

void test_the_import_into_a_state() {
  using namespace chdash::qlib;
  auto state = small_state();
  int next = 0;
  const NewId new_id = [&](char prefix, const chdash::QueryLibraryState&) { return std::string(1, prefix) + "_n" + std::to_string(++next); };
  // The payload has a folder under one of its own (by import id), a folder that exists (merged), a query twice, and one of the queries is known.
  const auto doc = parsed(
      "{\"folders\":[{\"id\":\"a\",\"name\":\"Mine\"},{\"id\":\"b\",\"parent_id\":\"a\",\"name\":\"Inner\"},{\"name\":\"ops\"}],"
      "\"queries\":[{\"name\":\"Q\",\"sql\":\"SELECT 2\",\"folder_id\":\"b\"},{\"name\":\"Q\",\"sql\":\"SELECT 2\",\"folder_id\":\"b\"},"
      "{\"name\":\"Top\",\"sql\":\"SELECT 1\",\"folder_id\":\"f2\"},{\"name\":\"Top\",\"sql\":\"SELECT 9\",\"folder_id\":\"f2\"}]}");
  const auto out = import_into(state, doc, "local", 1000, new_id, 1234);
  CHECK(out.imported_folders == 2 && out.merged_folders == 1);
  CHECK(out.imported_queries == 2 && out.skipped_queries == 2);
  CHECK(out.changed());
  CHECK(out.folder_ids.size() == 2 && out.folder_ids[0].first == "a" && out.folder_ids[0].second == "f_n1" && out.folder_ids[1].second == "f_n2");
  // The merged folder has no id in the payload, so the answer does not list it. The clash of "Top" is renamed.
  CHECK(state.folders.size() == 6 && state.folders[5].parent_id == std::string("f_n1") && state.folders[5].created_at_ms == 1234);
  bool renamed = false;
  for (const auto& q : state.queries) renamed |= q.name == "Top (2)" && q.sql == "SELECT 9" && q.id == "q_n4";
  CHECK(renamed);
  // The same payload again is a no-op.
  auto again = state;
  const auto repeat = import_into(again, doc, "local", 1000, new_id, 1234);
  CHECK(!repeat.changed() && repeat.skipped_queries == 4 && repeat.merged_folders == 3 && again.queries.size() == state.queries.size());
  // A copy refuses a folder that its parent already holds. It writes nothing that the caller keeps.
  auto copied = small_state();
  const auto clash = parsed("{\"copy\":true,\"folders\":[{\"name\":\"ops\"}]}");
  CHECK(refused_with([&] { import_into(copied, clash, "local", 1000, new_id, 1); }) == "validation/folders[0].name/duplicate");
  // Refusals of the payload.
  const auto run = [&](const char* text) {
    auto s = small_state();
    const auto d = parsed(text);
    return refused_with([&] { import_into(s, d, "local", 12, new_id, 1); });
  };
  CHECK(run("{\"folders\":3}") == "validation/folders/type");
  CHECK(run("{\"queries\":{}}") == "validation/queries/type");
  CHECK(run("{\"copy\":\"yes\"}") == "validation/copy/type");
  CHECK(run("{\"folders\":[{\"id\":\"a\",\"parent_id\":\"b\",\"name\":\"A\"},{\"id\":\"b\",\"parent_id\":\"a\",\"name\":\"B\"}]}") == "validation/folders/cycle");
  CHECK(run("{\"folders\":[{\"id\":\"a\",\"name\":\"A\"},{\"id\":\"a\",\"name\":\"B\"}]}") == "validation/folders[1].id/duplicate");
  CHECK(run("{\"queries\":[{\"name\":\"Q\",\"sql\":\"SELECT 1000000000000\"}]}") == "too_large/queries[0].sql/");
  CHECK(run("{\"queries\":[3]}") == "validation/queries[0]/type");
  // An import with nothing to import changes nothing.
  CHECK(run("{}") == "accepted");
}

} // namespace

// The page of the tree has at most 100 items and as many levels as fit. A first level larger than a page comes in windows.
chdash::QueryLibraryFolder test_folder(const std::string& id, const std::string& name, const std::string& parent = "") {
  chdash::QueryLibraryFolder f;
  f.id = id;
  f.host_id = *LOCAL;
  f.name = name;
  if (!parent.empty()) f.parent_id = parent;
  return f;
}

chdash::QueryLibraryQuery test_query(const std::string& id, const std::string& name, const std::string& folder = "", const std::string& sql = "SELECT 1") {
  chdash::QueryLibraryQuery q;
  q.id = id;
  q.host_id = *LOCAL;
  q.name = name;
  q.sql = sql;
  if (!folder.empty()) q.folder_id = folder;
  return q;
}

void test_the_page_of_the_tree() {
  using chdash::qlib::library_page;
  chdash::QueryLibraryState s;
  // 10 folders of 9 queries: 10 + 90 = 100 items, so everything fits in one answer, two levels deep.
  for (int i = 0; i < 10; ++i) {
    s.folders.push_back(test_folder("f" + std::to_string(i), "Team " + std::to_string(i)));
    for (int j = 0; j < 9; ++j) s.queries.push_back(test_query("q" + std::to_string(i) + "_" + std::to_string(j), "Query " + std::to_string(j), "f" + std::to_string(i)));
  }
  auto page = library_page(s, *LOCAL, std::nullopt, 0, 100);
  CHECK(page.folders.size() == 10 && page.queries.size() == 90);
  CHECK(page.depth == 1 && page.complete && !page.next_cursor);
  CHECK(page.loaded.size() == 10 && page.query_count.at("f3") == 9 && page.child_count.at("f3") == 9);
  CHECK(page.host_folders == 10 && page.host_queries == 90);
  // One more folder: 11 + 99 = 110 items do not fit. The page keeps the levels that fit: the folders only. Their children wait.
  s.folders.push_back(test_folder("f10", "Team 10"));
  for (int j = 0; j < 9; ++j) s.queries.push_back(test_query("q10_" + std::to_string(j), "Query " + std::to_string(j), "f10"));
  page = library_page(s, *LOCAL, std::nullopt, 0, 100);
  CHECK(page.folders.size() == 11 && page.queries.empty() && page.depth == 0);
  CHECK(!page.complete && page.loaded.empty() && page.query_count.at("f10") == 9 && page.child_count.at("f10") == 9);
  // The code reads a folder of the page on its own. It reads its children, one level (they fit).
  page = library_page(s, *LOCAL, std::string("f10"), 0, 100);
  CHECK(page.folders.empty() && page.queries.size() == 9 && page.complete && page.level_total == 9);
  CHECK(page.parent_queries == 9 && page.host_queries == 99);
  // The names are ordered without the case. Folders come first. "Team 1" comes before "Team 10" and "Team 2".
  page = library_page(s, *LOCAL, std::nullopt, 0, 100);
  CHECK(page.folders.front()->name == "Team 0" && page.folders[1]->name == "Team 1" && page.folders[2]->name == "Team 10");
  // A first level larger than a page comes in windows: 250 queries at the top level.
  chdash::QueryLibraryState flat;
  for (int i = 0; i < 250; ++i) flat.queries.push_back(test_query("q" + std::to_string(i), "Q" + std::string(i < 10 ? "00" : i < 100 ? "0" : "") + std::to_string(i)));
  auto first = library_page(flat, *LOCAL, std::nullopt, 0, 100);
  CHECK(first.queries.size() == 100 && first.next_cursor && *first.next_cursor == 100 && !first.complete && first.level_total == 250);
  auto second = library_page(flat, *LOCAL, std::nullopt, 100, 100);
  CHECK(second.queries.size() == 100 && second.next_cursor && *second.next_cursor == 200);
  auto last = library_page(flat, *LOCAL, std::nullopt, 200, 100);
  CHECK(last.queries.size() == 50 && !last.next_cursor);
  CHECK(first.queries.front()->name == "Q000" && second.queries.front()->name == "Q100" && last.queries.back()->name == "Q249");
  // The windows cover the level once. Folders come first: 120 folders and 50 queries.
  chdash::QueryLibraryState mixed;
  for (int i = 0; i < 120; ++i) mixed.folders.push_back(test_folder("f" + std::to_string(i), "F" + std::string(i < 10 ? "00" : i < 100 ? "0" : "") + std::to_string(i)));
  for (int i = 0; i < 50; ++i) mixed.queries.push_back(test_query("q" + std::to_string(i), "Q" + std::to_string(i)));
  auto m1 = library_page(mixed, *LOCAL, std::nullopt, 0, 100);
  auto m2 = library_page(mixed, *LOCAL, std::nullopt, 100, 100);
  CHECK(m1.folders.size() == 100 && m1.queries.empty() && m2.folders.size() == 20 && m2.queries.size() == 50 && !m2.next_cursor);
  // A limit below the maximum is kept. A limit above it is cut to the maximum.
  CHECK(library_page(flat, *LOCAL, std::nullopt, 0, 10).queries.size() == 10);
  CHECK(library_page(flat, *LOCAL, std::nullopt, 0, 5000).queries.size() == 100);
  // The other host has its own library.
  CHECK(library_page(flat, *OTHER, std::nullopt, 0, 100).level_total == 0);
}

void test_the_search_and_the_detail_of_a_query(const std::string& dir) {
  QueryLibraryStore store(options_for(dir + "/read.json"));
  const std::string ops = str(json(store.create_folder(folder_body("Operations"), nullptr)), "id");
  CHECK_STATUS(store.create_query(query_body("Active parts", "SELECT table FROM system.parts", ops), nullptr), 201);
  CHECK_STATUS(store.create_query(query_body("The answer", "SELECT 42 AS answer"), nullptr), 201);
  // The page has no SQL. One query has the SQL, with the folders above it.
  auto page = json(store.get_page(LOCAL, nullptr, 0, 100));
  CHECK(page["queries"].Size() == 2 && !page["queries"][0].HasMember("sql") && !page["queries"][0].HasMember("description"));
  CHECK(page["folders"][0]["query_count"].GetInt() == 1 && page["folders"][0]["loaded"].GetBool());
  CHECK(page["totals"]["queries"].GetInt() == 2 && page["complete"].GetBool());
  const std::string id = str(json(store.create_query(query_body("Third", "SELECT 3", ops), nullptr)), "id");
  auto detail = json(store.get_query(LOCAL, id));
  CHECK(str(detail, "sql") == "SELECT 3" && detail["ancestors"].Size() == 1 && str(detail, "path") == "/Operations");
  CHECK_STATUS(store.get_query(LOCAL, "q_missing"), 404);
  CHECK_STATUS(store.get_query(OTHER, id), 404);
  const std::string missing = "f_missing";
  CHECK_STATUS(store.get_page(LOCAL, &missing, 0, 100), 404);
  // The search reads the name, the description, the SQL, and the path. It checks every word, without the case.
  auto found = json(store.search(LOCAL, "PARTS operations", 100));
  CHECK(found["total"].GetInt() == 1 && str(found["results"][0], "path") == "/Operations");
  CHECK(json(store.search(LOCAL, "answer", 100))["results"].Size() == 1);
  CHECK(json(store.search(LOCAL, "nothing like it", 100))["total"].GetInt() == 0);
  CHECK_STATUS(store.search(LOCAL, "   ", 100), 400);
  // The export of a folder gives the folder and what is under it, with the SQL. The export of the host gives everything.
  auto exported = json(store.export_library(LOCAL, &ops));
  CHECK(exported["folders"].Size() == 1 && exported["queries"].Size() == 2 && exported["queries"][0].HasMember("sql"));
  CHECK(json(store.export_library(LOCAL, nullptr))["queries"].Size() == 3);
  CHECK_STATUS(store.export_library(LOCAL, &missing), 404);
}

int main() {
  const std::string dir = make_temp_dir();
  test_atomic_write(make_temp_dir());
  test_crud_tree_and_conflicts(dir);
  test_history_is_not_kept(dir);
  test_read_only(dir);
  test_malformed_and_reload(dir);
  test_import(dir);
  test_file_limit(dir);
  test_per_host(dir);
  test_migration(dir);
  test_the_rules_of_the_tree();
  test_the_fields_of_a_request();
  test_the_import_into_a_state();
  test_the_page_of_the_tree();
  test_the_search_and_the_detail_of_a_query(make_temp_dir());
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
