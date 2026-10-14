#pragma once

// Server-side query library (folders, saved queries) kept in one versioned
// JSON file. The history of the runs is never kept here: it stays in the
// browser. See docs/query-library.md for the file format
// and the REST contract.
//
// The store never executes SQL and never derives a filesystem path from a
// request: the only file it touches is QueryLibraryOptions::file (plus a
// temporary sibling used for atomic replacement). Saved SQL is never logged.

#include "query_library_file.hpp"
#include "query_library_state.hpp"

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

struct QueryLibraryOptions {
  // The id of the library in the API (?library=), and its name in the UI.
  std::string name;
  std::string file;
  // The configured ClickHouse host ids: every request names one of them
  // (host_id), and the library and its folders are per host.
  std::vector<std::string> host_ids;
  bool writable = false;
  size_t max_file_bytes = 8 * 1024 * 1024;
  size_t max_query_bytes = 256 * 1024;
};

class QueryLibraryStore {
public:
  struct Response {
    int status = 200;
    std::string body;  // JSON object
  };

  explicit QueryLibraryStore(QueryLibraryOptions options);

  QueryLibraryStore(const QueryLibraryStore&) = delete;
  QueryLibraryStore& operator=(const QueryLibraryStore&) = delete;

  // Effective editability: configured writable and the file loaded cleanly.
  bool writable();
  std::string load_error();
  const QueryLibraryOptions& options() const { return options_; }

  // `if_match` is the raw If-Match header value, or nullptr when absent.
  // `host_id` is the request's host_id parameter, or nullptr when absent
  // (400: it is required and must name a configured host).
  // The reads (docs/query-library.md, "REST API"). The page is what the Query page loads: at most kLibraryPageMax items under `parent_id`
  // (null: the top level of the host), as many levels deep as fit, with the minimal data of each (no SQL) and, for each folder, whether its
  // children came with it. `cursor` is the offset in the first level when that level alone is larger than a page.
  Response get_page(const std::string* host_id, const std::string* parent_id, size_t cursor, size_t limit);
  // One query, whole, with the folders above it.
  Response get_query(const std::string* host_id, const std::string& id);
  // The queries whose name, description, SQL or folder path hold every word of `text`: at most `limit`, minimal data and their path.
  Response search(const std::string* host_id, const std::string& text, size_t limit);
  // The host's whole library, or one folder with everything under it, with the SQL: a backup, and what a move to another storage copies.
  Response export_library(const std::string* host_id, const std::string* folder_id);
  Response create_folder(std::string_view body, const std::string* if_match);
  Response update_folder(const std::string& id, std::string_view body, const std::string* if_match);
  Response delete_folder(const std::string& id, bool recursive, const std::string* if_match);
  Response create_query(std::string_view body, const std::string* if_match);
  Response update_query(const std::string& id, std::string_view body, const std::string* if_match);
  Response delete_query(const std::string& id, const std::string* if_match);
  Response import_library(std::string_view body, const std::string* if_match);

private:
  struct FileStamp {
    bool exists = false;
    uint64_t dev = 0;
    uint64_t ino = 0;
    uint64_t size = 0;
    int64_t mtime_ns = 0;
    int stat_errno = 0;  // set when stat() failed
    bool operator==(const FileStamp& o) const {
      return exists == o.exists && stat_errno == o.stat_errno && dev == o.dev && ino == o.ino && size == o.size &&
             mtime_ns == o.mtime_ns;
    }
    bool operator!=(const FileStamp& o) const { return !(*this == o); }
  };

  FileStamp stat_file() const;
  void refresh_locked();
  void require_editable_locked() const;
  void check_if_match_locked(const std::string* if_match) const;
  std::string require_host_locked(const std::string* raw, const std::string& field) const;
  void commit_locked(QueryLibraryState candidate);
  std::string new_id_locked(char prefix, const QueryLibraryState& state);

  template <typename Fn>
  Response guarded(Fn&& fn);

  QueryLibraryOptions options_;
  std::mutex mu_;
  QueryLibraryState state_;
  FileStamp stamp_;
  bool loaded_once_ = false;
  std::string load_error_;
};

} // namespace chdash
