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
  o.history_on_server = true;
  o.history_max_entries = 5;
  o.max_file_bytes = 64 * 1024;
  o.max_query_bytes = 2048;
  return o;
}

std::string folder_body(const std::string& name, const std::string& parent = "") {
  return std::string("{\"name\":\"") + name + "\",\"parent_id\":" + (parent.empty() ? "null" : "\"" + parent + "\"") + "}";
}

std::string query_body(const std::string& name, const std::string& sql, const std::string& folder = "") {
  return std::string("{\"name\":\"") + name + "\",\"sql\":\"" + sql + "\",\"folder_id\":" +
         (folder.empty() ? "null" : "\"" + folder + "\"") + "}";
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
  auto lib = json(store.get_library());
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
  r = store.update_folder(chain.back(), "{\"parent_id\":\"" + other + "\",\"description\":\"moved\"}", nullptr);
  CHECK_STATUS(r, 200);
  CHECK(str(json(r), "parent_id") == other);
  CHECK(str(json(r), "description") == "moved");

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
  r = store.update_query(query, "{\"tags\":[\"a\",\"A\",\"b\"],\"sql\":\"SELECT 3\"}", nullptr);
  CHECK_STATUS(r, 200);
  CHECK(json(r)["tags"].Size() == 2);
  CHECK(str(json(r), "sql") == "SELECT 3");
  CHECK_STATUS(store.update_query("q_missing", "{\"name\":\"x\"}", nullptr), 404);

  // If-Match.
  const int64_t revision = num(json(store.get_library()), "revision");
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
  lib = json(store.get_library());
  CHECK(lib["folders"].Size() == 0);
  CHECK(lib["queries"].Size() == 1);

  // Persistence: a new store on the same file sees the same library.
  QueryLibraryStore again(options_for(path));
  auto lib2 = json(again.get_library());
  CHECK(num(lib2, "revision") == num(lib, "revision"));
  CHECK(lib2["queries"].Size() == 1);
}

void test_history(const std::string& dir) {
  const std::string path = dir + "/history.json";
  QueryLibraryStore store(options_for(path));
  const int64_t revision = num(json(store.get_library()), "revision");
  for (int i = 1; i <= 8; ++i) {
    const std::string body = "{\"sql\":\"SELECT " + std::to_string(i) + "\",\"host_id\":\"local\",\"ran_at_ms\":" +
                             std::to_string(1000 * i) + ",\"elapsed_ms\":1.5,\"rows\":1,\"status\":\"ok\"}";
    CHECK_STATUS(store.append_history(body, nullptr), 201);
  }
  CHECK(num(json(store.get_library()), "revision") == revision);  // history does not bump the library revision
  const std::string limit = "2";
  auto page = json(store.list_history(&limit, nullptr, nullptr, nullptr));
  CHECK(page["entries"].Size() == 2);
  CHECK(page["has_more"].GetBool());
  CHECK(str(page["entries"][0], "sql") == "SELECT 8");
  const std::string before = std::to_string(page["entries"][1]["ran_at_ms"].GetInt64());
  const std::string ten = "10";
  page = json(store.list_history(&ten, &before, nullptr, nullptr));
  CHECK(page["entries"].Size() == 3);  // cap 5: 8,7 | 6,5,4
  CHECK(!page["has_more"].GetBool());
  CHECK(str(page["entries"][2], "sql") == "SELECT 4");
  const std::string needle = "select 6";
  page = json(store.list_history(nullptr, nullptr, nullptr, &needle));
  CHECK(page["entries"].Size() == 1);
  const std::string bad = "0";
  CHECK_STATUS(store.list_history(&bad, nullptr, nullptr, nullptr), 400);
  CHECK_STATUS(store.append_history("{\"sql\":\"SELECT 1\",\"status\":\"weird\"}", nullptr), 400);
  CHECK_STATUS(store.append_history("{\"sql\":\"" + std::string(3000, 'y') + "\"}", nullptr), 413);
  const std::string id = str(json(store.list_history(nullptr, nullptr, nullptr, nullptr))["entries"][0], "id");
  CHECK_STATUS(store.delete_history_entry(id, nullptr), 200);
  CHECK_STATUS(store.delete_history_entry(id, nullptr), 404);
  auto cleared = json(store.clear_history(nullptr));
  CHECK(num(cleared, "deleted") == 4);
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
  CHECK_STATUS(store.import_library("{\"queries\":[]}", nullptr), 403);
  CHECK_STATUS(store.clear_history(nullptr), 403);
  // History append is not library editing.
  CHECK_STATUS(store.append_history("{\"sql\":\"SELECT 1\"}", nullptr), 201);
}

void test_malformed_and_reload(const std::string& dir) {
  const std::string path = dir + "/broken.json";
  const std::string broken = "{\"version\":1,\"folders\":[{\"id\":\"f_1\",\"name\":";
  write_plain(path, broken);

  std::ostringstream captured;
  auto* old = std::cerr.rdbuf(captured.rdbuf());
  {
    QueryLibraryStore store(options_for(path));
    auto lib = json(store.get_library());
    CHECK(!lib["load_error"].IsNull());
    CHECK(!lib["writable"].GetBool());
    CHECK(!store.writable());
    auto r = store.create_folder(folder_body("x"), nullptr);
    CHECK_STATUS(r, 403);
    CHECK(json(r).HasMember("load_error"));
    CHECK_STATUS(store.append_history("{\"sql\":\"SELECT secret_marker_123\"}", nullptr), 403);
    CHECK(read_file(path) == broken);  // never overwritten

    // Fixing the file on disk clears the error without a restart.
    write_plain(path, "{\"version\":1,\"revision\":7,\"folders\":[{\"id\":\"f_a\",\"parent_id\":null,\"name\":\"A\"}],"
                      "\"queries\":[{\"id\":\"q_a\",\"folder_id\":\"f_a\",\"name\":\"Q\",\"sql\":\"SELECT secret_marker_123\"}]}");
    lib = json(store.get_library());
    CHECK(lib["load_error"].IsNull());
    CHECK(lib["writable"].GetBool());
    CHECK(num(lib, "revision") >= 7);
    CHECK(lib["queries"].Size() == 1);

    // An external edit with the same revision still moves the revision forward.
    const int64_t before = num(lib, "revision");
    write_plain(path, "{\"version\":1,\"revision\":7,\"folders\":[],\"queries\":[]}");
    lib = json(store.get_library());
    CHECK(num(lib, "revision") > before);
    CHECK(lib["queries"].Size() == 0);

    // Structural problems are load errors too.
    write_plain(path, "{\"version\":1,\"folders\":[{\"id\":\"f_a\",\"parent_id\":\"f_b\",\"name\":\"A\"},"
                      "{\"id\":\"f_b\",\"parent_id\":\"f_a\",\"name\":\"B\"}]}");
    CHECK(!json(store.get_library())["load_error"].IsNull());
    write_plain(path, "{\"version\":2}");
    CHECK(!json(store.get_library())["load_error"].IsNull());
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
      "{\"folders\":[{\"id\":\"local-1\",\"parent_id\":null,\"name\":\"Imported\"},"
      "{\"id\":\"local-2\",\"parent_id\":\"local-1\",\"name\":\"Child\"}],"
      "\"queries\":[{\"name\":\"Existing\",\"sql\":\"SELECT 1\"},"
      "{\"name\":\"Existing\",\"sql\":\"SELECT 2\"},"
      "{\"name\":\"In child\",\"sql\":\"SELECT 3\",\"folder_id\":\"local-2\",\"tags\":[\"t\"]},"
      "{\"name\":\"In child\",\"sql\":\"SELECT 3\",\"folder_id\":\"local-2\"}]}";
  auto r = json(store.import_library(payload, nullptr));
  CHECK(num(r, "imported_folders") == 2);
  CHECK(num(r, "imported_queries") == 2);
  CHECK(num(r, "skipped_queries") == 2);
  CHECK(r["folder_ids"].HasMember("local-2"));
  auto lib = json(store.get_library());
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
      "{\"folders\":[{\"id\":\"a\",\"parent_id\":\"b\",\"name\":\"A\"},{\"id\":\"b\",\"parent_id\":\"a\",\"name\":\"B\"}]}",
      nullptr));
  CHECK(str(r, "reason") == "cycle");
  CHECK(num(json(store.get_library()), "revision") == revision);  // nothing new: no write
}

void test_file_limit(const std::string& dir) {
  const std::string path = dir + "/limit.json";
  auto o = options_for(path);
  o.max_file_bytes = 16 * 1024;
  o.max_query_bytes = 2048;
  o.history_max_entries = 100;
  QueryLibraryStore store(o);
  const std::string sql(1500, 'h');
  for (int i = 0; i < 8; ++i) CHECK_STATUS(store.append_history("{\"sql\":\"" + sql + "\"}", nullptr), 201);
  // Library edits evict the oldest history entries first.
  int created = 0;
  QueryLibraryStore::Response r;
  for (int i = 0; i < 40; ++i) {
    r = store.create_query(query_body("q" + std::to_string(i), std::string(1500, 'q')), nullptr);
    if (r.status != 201) break;
    ++created;
  }
  CHECK_STATUS(r, 413);
  CHECK(str(json(r), "error") == "too_large");
  CHECK(created >= 8);
  CHECK(json(store.list_history(nullptr, nullptr, nullptr, nullptr))["entries"].Size() < 8);
  struct stat st {};
  CHECK(::stat(path.c_str(), &st) == 0);
  CHECK(static_cast<size_t>(st.st_size) <= o.max_file_bytes);
}

} // namespace

int main() {
  const std::string dir = make_temp_dir();
  test_atomic_write(make_temp_dir());
  test_crud_tree_and_conflicts(dir);
  test_history(dir);
  test_read_only(dir);
  test_malformed_and_reload(dir);
  test_import(dir);
  test_file_limit(dir);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
