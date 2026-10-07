// Unit tests of the query library store (src/query_library.cpp).
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF
//          -DCHDASH_BUILD_QUERY_LIBRARY_TESTS=ON
//        cmake --build build --target chdash_query_library_test
// Run:   ./build/chdash_query_library_test   (exit code 0 = every check passed)
// The Python harness runs it when QUERY_LIBRARY_TEST_BINARY points at it.

#include "query_library.hpp"

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
  // Replace with a new inode, like an editor's "save as" (rename).
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
  auto lib = json(store.get_library(LOCAL));
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

  // Depth: 8 levels allowed, the 9th refused.
  std::vector<std::string> chain{reports};
  for (int level = 2; level <= 8; ++level) {
    r = store.create_folder(folder_body("L" + std::to_string(level), chain.back()), nullptr);
    CHECK_STATUS(r, 201);
    chain.push_back(str(json(r), "id"));
  }
  r = store.create_folder(folder_body("L9", chain.back()), nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "depth");

  // Moves: no cycles, no moving into itself.
  r = store.update_folder(reports, "{\"parent_id\":\"" + chain[3] + "\"}", nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "cycle");
  r = store.update_folder(reports, "{\"parent_id\":\"" + reports + "\"}", nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "reason") == "cycle");

  r = store.create_folder(folder_body("Other"), nullptr);
  CHECK_STATUS(r, 201);
  const std::string other = str(json(r), "id");
  // Moving the 8-level chain below Other would make it 9 deep.
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
  const int64_t revision = num(json(store.get_library(LOCAL)), "revision");
  const std::string stale = std::to_string(revision - 1);
  r = store.update_query(query, "{\"name\":\"Renamed\"}", &stale);
  CHECK_STATUS(r, 409);
  CHECK(str(json(r), "error") == "conflict");
  CHECK(num(json(r), "revision") == revision);
  const std::string current = "\"" + std::to_string(revision) + "\"";
  r = store.update_query(query, "{\"name\":\"Renamed\"}", &current);
  CHECK_STATUS(r, 200);
  CHECK(num(json(r), "revision") == revision + 1);
  const std::string any = "*";
  CHECK_STATUS(store.update_query(query, "{\"name\":\"Renamed again\"}", &any), 200);
  const std::string garbage = "abc";
  CHECK_STATUS(store.update_query(query, "{\"name\":\"x\"}", &garbage), 400);

  // Delete: non-empty folder needs recursive.
  r = store.delete_folder(other, false, nullptr);
  CHECK_STATUS(r, 409);
  CHECK(str(json(r), "error") == "not_empty");
  r = store.delete_folder(reports, true, nullptr);
  CHECK_STATUS(r, 200);
  CHECK(num(json(r), "deleted_folders") == 7);  // Reports + L2..L7 (L8 moved away)
  r = store.delete_folder(other, true, nullptr);
  CHECK_STATUS(r, 200);
  CHECK(num(json(r), "deleted_folders") == 2);
  CHECK(num(json(r), "deleted_queries") == 1);
  CHECK_STATUS(store.delete_folder(other, true, nullptr), 404);
  lib = json(store.get_library(LOCAL));
  CHECK(lib["folders"].Size() == 0);
  CHECK(lib["queries"].Size() == 1);

  // Persistence: a new store on the same file sees the same library.
  QueryLibraryStore again(options_for(path));
  auto lib2 = json(again.get_library(LOCAL));
  CHECK(num(lib2, "revision") == num(lib, "revision"));
  CHECK(lib2["queries"].Size() == 1);
}

// The history of the runs is the browser's: a file of an earlier release that
// still holds one loads without it, and nothing the store writes carries one.
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
    auto lib = json(store.get_library(LOCAL));
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

    // Read-only: the history is ignored in memory and the file is not touched.
    const std::string ro_path = dir + "/history-ro.json";
    write_plain(ro_path, "{\"version\":2,\"revision\":1,\"folders\":[],\"queries\":[],"
                         "\"history\":[{\"id\":\"h_1\",\"sql\":\"SELECT history_marker_3\",\"host_id\":\"local\"}]}");
    const std::string before = read_file(ro_path);
    auto o = options_for(ro_path);
    o.writable = false;
    QueryLibraryStore ro(o);
    CHECK(json(ro.get_library(LOCAL))["load_error"].IsNull());
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
  CHECK(str(json(r), "error") == "read_only");
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
    auto lib = json(store.get_library(LOCAL));
    CHECK(!lib["load_error"].IsNull());
    CHECK(!lib["writable"].GetBool());
    CHECK(!store.writable());
    auto r = store.create_folder(folder_body("x"), nullptr);
    CHECK_STATUS(r, 403);
    CHECK(json(r).HasMember("load_error"));
    CHECK(read_file(path) == broken);  // never overwritten

    // Fixing the file on disk clears the error without a restart.
    write_plain(path, "{\"version\":2,\"revision\":7,\"folders\":[{\"id\":\"f_a\",\"host_id\":\"local\",\"parent_id\":null,\"name\":\"A\"}],"
                      "\"queries\":[{\"id\":\"q_a\",\"host_id\":\"local\",\"folder_id\":\"f_a\",\"name\":\"Q\",\"sql\":\"SELECT secret_marker_123\"}]}");
    lib = json(store.get_library(LOCAL));
    CHECK(lib["load_error"].IsNull());
    CHECK(lib["writable"].GetBool());
    CHECK(num(lib, "revision") >= 7);
    CHECK(lib["queries"].Size() == 1);

    // An external edit with the same revision still moves the revision forward.
    const int64_t before = num(lib, "revision");
    write_plain(path, "{\"version\":2,\"revision\":7,\"folders\":[],\"queries\":[]}");
    lib = json(store.get_library(LOCAL));
    CHECK(num(lib, "revision") > before);
    CHECK(lib["queries"].Size() == 0);

    // Structural problems are load errors too.
    write_plain(path, "{\"version\":2,\"folders\":[{\"id\":\"f_a\",\"host_id\":\"local\",\"parent_id\":\"f_b\",\"name\":\"A\"},"
                      "{\"id\":\"f_b\",\"host_id\":\"local\",\"parent_id\":\"f_a\",\"name\":\"B\"}]}");
    CHECK(!json(store.get_library(LOCAL))["load_error"].IsNull());
    // A folder of one host inside a folder of another is inconsistent.
    write_plain(path, "{\"version\":2,\"folders\":[{\"id\":\"f_a\",\"host_id\":\"local\",\"name\":\"A\"},"
                      "{\"id\":\"f_b\",\"host_id\":\"other\",\"parent_id\":\"f_a\",\"name\":\"B\"}]}");
    CHECK(!json(store.get_library(LOCAL))["load_error"].IsNull());
    write_plain(path, "{\"version\":3}");
    CHECK(!json(store.get_library(LOCAL))["load_error"].IsNull());
    CHECK(read_file(path) == "{\"version\":3}");  // never rewritten
  }
  std::cerr.rdbuf(old);
  CHECK(captured.str().find("[query_library]") != std::string::npos);
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
  auto lib = json(store.get_library(LOCAL));
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
  CHECK(num(json(store.get_library(LOCAL)), "revision") == revision);  // nothing new: no write

  // "copy": a folder moved in from the browser's storage, under an existing
  // folder: nothing merged, skipped or renamed (the same query twice stays
  // twice), a clashing folder name is a 400 duplicate and writes nothing.
  std::string imported;
  const auto folders_now = json(store.get_library(LOCAL));  // a named document: a range-for over a temporary dangles
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
  lib = json(store.get_library(LOCAL));
  bool parented = false;
  bool kept_name = false;
  for (const auto& f : lib["folders"].GetArray()) parented |= str(f, "id") == moved && str(f, "parent_id") == imported;
  for (const auto& q : lib["queries"].GetArray()) kept_name |= str(q, "name") == "Existing" && str(q, "folder_id") == moved;
  CHECK(parented && kept_name);
  const int64_t before_clash = num(lib, "revision");
  r = json(store.import_library(copy, nullptr));
  CHECK(str(r, "reason") == "duplicate");
  CHECK(num(json(store.get_library(LOCAL)), "revision") == before_clash);
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
  CHECK(str(json(r), "error") == "too_large");
  CHECK(created >= 5);
  struct stat st {};
  CHECK(::stat(path.c_str(), &st) == 0);
  CHECK(static_cast<size_t>(st.st_size) <= o.max_file_bytes);
}

// Folders and queries belong to one host: reads filter by it, the
// host is required and must be configured, a move across hosts is refused.
void test_per_host(const std::string& dir) {
  const std::string path = dir + "/hosts.json";
  QueryLibraryStore store(options_for(path));
  const std::string unknown = "elsewhere";
  const std::string empty;
  auto r = store.get_library(nullptr);
  CHECK_STATUS(r, 400);
  CHECK(str(json(r), "field") == "host_id");
  CHECK(str(json(r), "reason") == "required");
  CHECK(str(json(store.get_library(&empty)), "reason") == "required");
  r = store.get_library(&unknown);
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

  auto lib = json(store.get_library(LOCAL));
  CHECK(str(lib, "host_id") == "local");
  CHECK(lib["folders"].Size() == 1);
  CHECK(lib["queries"].Size() == 1);
  CHECK(str(lib["folders"][0], "host_id") == "local");
  auto other = json(store.get_library(OTHER));
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
  CHECK(num(json(store.get_library(LOCAL)), "revision") == revision);
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
  other = json(store.get_library(OTHER));
  CHECK(other["queries"].Size() == 4);
  for (const auto& q : other["queries"].GetArray()) {
    CHECK(str(q, "host_id") == "other");
    if (str(q, "name") == "Into local") CHECK(q["folder_id"].IsNull());  // a folder of another host means the top level
  }
  CHECK(json(store.get_library(LOCAL))["queries"].Size() == 1);

  // On disk: version 2, a host on every entry.
  rapidjson::Document file;
  file.Parse(read_file(path).c_str());
  CHECK(file["version"].GetInt() == 2);
  CHECK(!file.HasMember("history"));
  for (const auto* key : {"folders", "queries"}) {
    for (const auto& item : file[key].GetArray()) CHECK(!str(item, "host_id").empty());
  }
}

// A version-1 file (folders without a host) and entries without a host:
// dropped on load. A writable library rewrites the file as version 2; a
// read-only one serves the cleaned library and never touches the file.
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
  auto lib = json(store.get_library(LOCAL));
  CHECK(lib["load_error"].IsNull());
  CHECK(lib["folders"].Size() == 0);
  CHECK(lib["queries"].Size() == 1);
  CHECK(str(lib["queries"][0], "id") == "q_in_folder");
  CHECK(lib["queries"][0]["folder_id"].IsNull());  // its folder had no host: the top level
  CHECK(num(lib, "revision") == 4);
  auto other = json(store.get_library(OTHER));
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
    // Loading the rewritten file changes nothing more.
    const std::string rewritten = read_file(path);
    QueryLibraryStore again(options_for(path));
    check_migrated(again);
    CHECK(read_file(path) == rewritten);
    // Still editable after the migration.
    CHECK_STATUS(again.create_folder(folder_body("Operations"), nullptr), 201);

    // Read-only: the same library in memory, the file untouched.
    const std::string ro_path = dir + "/v1-readonly.json";
    write_plain(ro_path, kVersion1);
    auto o = options_for(ro_path);
    o.writable = false;
    QueryLibraryStore ro(o);
    check_migrated(ro);
    CHECK(read_file(ro_path) == kVersion1);
    CHECK_STATUS(ro.create_folder(folder_body("x"), nullptr), 403);
    CHECK(read_file(ro_path) == kVersion1);

    // A version-2 file holding entries without a host: dropped and rewritten too.
    const std::string v2_path = dir + "/v2-hostless.json";
    write_plain(v2_path, "{\"version\":2,\"revision\":1,\"folders\":[{\"id\":\"f_x\",\"name\":\"X\"}],"
                         "\"queries\":[{\"id\":\"q_x\",\"name\":\"X\",\"sql\":\"SELECT 1\",\"host_id\":\"local\"}]}");
    QueryLibraryStore v2(options_for(v2_path));
    CHECK(json(v2.get_library(LOCAL))["folders"].Size() == 0);
    CHECK(json(v2.get_library(LOCAL))["queries"].Size() == 1);
    rapidjson::Document v2file;
    v2file.Parse(read_file(v2_path).c_str());
    CHECK(v2file["folders"].Size() == 0);

    // An external edit dropping in a version-1 file is migrated on reload.
    write_plain(v2_path, kVersion1);
    check_migrated(v2);
    v2file.Parse(read_file(v2_path).c_str());
    CHECK(v2file["version"].GetInt() == 2);

    // A malformed file is never rewritten, whatever its version.
    const std::string bad_path = dir + "/v1-broken.json";
    const std::string broken = std::string(kVersion1).substr(0, 120);
    write_plain(bad_path, broken);
    QueryLibraryStore bad(options_for(bad_path));
    CHECK(!json(bad.get_library(LOCAL))["load_error"].IsNull());
    CHECK(read_file(bad_path) == broken);
  }
  std::cerr.rdbuf(old);
  CHECK(captured.str().find("migrated") != std::string::npos);
  CHECK(captured.str().find("SELECT") == std::string::npos);  // SQL is never logged
}

} // namespace

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
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
