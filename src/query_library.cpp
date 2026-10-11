#include "query_library.hpp"

#include "error_envelope.hpp"
#include "json_parse.hpp"
#include "log.hpp"
#include "query_library_import.hpp"
#include "query_library_json.hpp"
#include "query_library_request.hpp"
#include "query_library_rules.hpp"
#include "secure_random.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <sys/stat.h>

#include <algorithm>
#include <cerrno>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <system_error>
#include <unordered_set>
#include <utility>

namespace chdash {
namespace {

using namespace qlib;

void log_line(LogLevel level, const std::string& message) {
  log_event(level, "query_library", {{"message", message}});
}

} // namespace

// --- store ------------------------------------------------------------------

QueryLibraryStore::QueryLibraryStore(QueryLibraryOptions options) : options_(std::move(options)) {
  std::lock_guard<std::mutex> lk(mu_);
  refresh_locked();
  std::error_code ec;
  const auto parent = std::filesystem::path(options_.file).parent_path();
  if (!parent.empty() && !std::filesystem::is_directory(parent, ec)) {
    log_line(LogLevel::Warn, "the directory of " + options_.file + " does not exist; writes will fail until it is created");
  }
}

QueryLibraryStore::FileStamp QueryLibraryStore::stat_file() const {
  FileStamp s;
  struct stat st {};
  if (::stat(options_.file.c_str(), &st) != 0) {
    s.stat_errno = errno == 0 ? ENOENT : errno;
    return s;
  }
  s.exists = true;
  s.dev = static_cast<uint64_t>(st.st_dev);
  s.ino = static_cast<uint64_t>(st.st_ino);
  s.size = static_cast<uint64_t>(st.st_size);
#if defined(__APPLE__)
  s.mtime_ns = static_cast<int64_t>(st.st_mtimespec.tv_sec) * 1000000000LL + st.st_mtimespec.tv_nsec;
#else
  s.mtime_ns = static_cast<int64_t>(st.st_mtim.tv_sec) * 1000000000LL + st.st_mtim.tv_nsec;
#endif
  return s;
}

void QueryLibraryStore::refresh_locked() {
  const FileStamp now = stat_file();
  if (loaded_once_ && now == stamp_) return;
  const bool had = loaded_once_;
  const int64_t previous_revision = state_.revision;
  loaded_once_ = true;
  stamp_ = now;

  const auto fail = [&](const std::string& message) {
    if (load_error_ != message) {
      log_line(LogLevel::Warn, "cannot load " + options_.file + ": " + message +
               "; the library is served read-only and the file is not modified");
    }
    load_error_ = message;
  };

  if (!now.exists) {
    if (now.stat_errno != ENOENT) {
      fail(std::string("cannot stat the file: ") + std::generic_category().message(now.stat_errno));
      return;
    }
    QueryLibraryState empty;
    empty.revision = had ? previous_revision + 1 : 0;
    state_ = std::move(empty);
    load_error_.clear();
    return;
  }
  if (now.size > options_.max_file_bytes) {
    fail("the file is larger than query_library.max_file_bytes");
    return;
  }
  std::ifstream in(options_.file, std::ios::binary);
  if (!in) {
    fail(std::string("cannot open the file: ") + std::generic_category().message(errno));
    return;
  }
  std::string text{std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
  if (in.bad()) {
    fail("cannot read the file");
    return;
  }
  QueryLibraryMigration migration;
  try {
    QueryLibraryState parsed = parse_query_library_file(text, &migration);
    if (had) parsed.revision = std::max(parsed.revision, previous_revision + 1);
    if (!load_error_.empty()) log_line(LogLevel::Info, "reloaded " + options_.file + "; the load error is cleared");
    state_ = std::move(parsed);
    load_error_.clear();
  } catch (const std::exception& e) {
    fail(e.what());
    return;
  }
  if (!migration.changed()) return;
  // A version-1 file, entries without a host, or an earlier release's history: they are dropped in memory;
  // a writable library also rewrites the file (atomically, as version 2). A
  // read-only library never touches the file.
  const std::string counts = "from version " + std::to_string(migration.from_version) + ", dropped " +
                             std::to_string(migration.dropped_folders) + " folders, " +
                             std::to_string(migration.dropped_queries) + " queries without a host_id, dropped " +
                             std::to_string(migration.dropped_history) + " history entries (history is kept in the browser), moved " +
                             std::to_string(migration.rerooted) + " items to the top level of their host";
  if (!options_.writable) {
    log_line(LogLevel::Info, "migrated " + options_.file + " in memory (" + counts + "); the library is read-only, the file is not modified");
    return;
  }
  try {
    commit_locked(state_);
    log_line(LogLevel::Info, "migrated " + options_.file + " to version " + std::to_string(kQueryLibraryFileVersion) + " (" + counts + ")");
  } catch (const LibraryError& e) {
    log_line(LogLevel::Warn, "migrated " + options_.file + " in memory (" + counts + "); rewriting it failed: " + e.message);
  }
}

bool QueryLibraryStore::writable() {
  std::lock_guard<std::mutex> lk(mu_);
  refresh_locked();
  return options_.writable && load_error_.empty();
}

std::string QueryLibraryStore::load_error() {
  std::lock_guard<std::mutex> lk(mu_);
  refresh_locked();
  return load_error_;
}

void QueryLibraryStore::require_editable_locked() const {
  if (options_.writable && load_error_.empty()) return;
  LibraryError e;
  e.status = 403;
  e.code = "read_only";
  if (!load_error_.empty()) {
    e.message = "the library file could not be loaded; the library is read-only until the file is fixed";
    e.load_error = load_error_;
  } else {
    e.message = "the query library is read-only (query_library.writable = false)";
  }
  throw e;
}

void QueryLibraryStore::check_if_match_locked(const std::string* if_match) const {
  if (!if_match) return;
  const auto expected = parse_if_match_revision(*if_match);
  if (!expected || *expected == state_.revision) return;
  LibraryError e;
  e.status = 409;
  e.code = "conflict";
  e.message = "the library changed; reload it and retry";
  e.revision = state_.revision;
  throw e;
}

// The host of a request: required, and one of the configured hosts.
std::string QueryLibraryStore::require_host_locked(const std::string* raw, const std::string& field) const {
  if (!raw || raw->empty()) throw validation(field, "required", field + " is required");
  if (raw->size() > kQueryLibraryMaxHostIdBytes || has_control(*raw, false) ||
      std::find(options_.host_ids.begin(), options_.host_ids.end(), *raw) == options_.host_ids.end()) {
    throw validation(field, "unknown_host", field + " does not name a configured host");
  }
  return *raw;
}

std::string QueryLibraryStore::new_id_locked(char prefix, const QueryLibraryState& state) {
  for (;;) {
    std::string id = std::string(1, prefix) + "_" + random_hex(8);
    bool used = false;
    if (prefix == 'f') used = find_folder(state, id) != nullptr;
    else used = std::any_of(state.queries.begin(), state.queries.end(), [&](const auto& q) { return q.id == id; });
    if (!used) return id;
  }
}

// Serialize, then replace the file atomically.
void QueryLibraryStore::commit_locked(QueryLibraryState candidate) {
  candidate.updated_at_ms = now_ms();
  const std::string text = serialize_query_library_file(candidate);
  if (text.size() > options_.max_file_bytes) {
    throw too_large("file", "the library would exceed query_library.max_file_bytes (" +
                                std::to_string(options_.max_file_bytes) + " bytes)");
  }
  std::string error;
  if (!atomic_write_file(options_.file, text, &error)) {
    log_line(LogLevel::Warn, "cannot write " + options_.file + ": " + error);
    LibraryError e;
    e.status = 500;
    e.code = "storage_error";
    e.message = "the library file could not be written";
    throw e;
  }
  state_ = std::move(candidate);
  stamp_ = stat_file();
}

template <typename Fn>
QueryLibraryStore::Response QueryLibraryStore::guarded(Fn&& fn) {
  std::lock_guard<std::mutex> lk(mu_);
  try {
    refresh_locked();
    return fn();
  } catch (const LibraryError& e) {
    return render_error(e);
  } catch (const std::exception& e) {
    log_line(LogLevel::Error, std::string("internal error: ") + e.what());
    LibraryError err;
    err.status = 500;
    err.code = "internal_error";
    err.message = "query library internal error";
    return render_error(err);
  }
}

namespace {

template <typename Entity, typename WriteFields>
QueryLibraryStore::Response entity_response(int status, const Entity& entity, int64_t revision, WriteFields&& write_fields) {
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  write_fields(w, entity);
  w.Key("revision"); w.Int64(revision);
  w.EndObject();
  return {status, sb.GetString()};
}

QueryLibraryStore::Response folder_response(int status, const QueryLibraryFolder& f, int64_t revision) {
  return entity_response(status, f, revision, [](JsonWriter& w, const QueryLibraryFolder& x) { write_folder_fields(w, x); });
}

QueryLibraryStore::Response query_response(int status, const QueryLibraryQuery& q, int64_t revision) {
  return entity_response(status, q, revision, [](JsonWriter& w, const QueryLibraryQuery& x) { write_query_fields(w, x); });
}

} // namespace

QueryLibraryStore::Response QueryLibraryStore::get_library(const std::string* host_raw) {
  return guarded([&]() -> Response {
    const std::string host = require_host_locked(host_raw, "host_id");
    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("host_id"); write_string(w, host);
    w.Key("revision"); w.Int64(state_.revision);
    w.Key("updated_at_ms"); w.Int64(state_.updated_at_ms);
    w.Key("writable"); w.Bool(options_.writable && load_error_.empty());
    w.Key("load_error");
    if (load_error_.empty()) w.Null();
    else write_string(w, load_error_);
    w.Key("limits");
    w.StartObject();
    w.Key("max_query_bytes"); w.Uint64(options_.max_query_bytes);
    w.Key("max_file_bytes"); w.Uint64(options_.max_file_bytes);
    w.Key("max_folder_depth"); w.Int(kQueryLibraryMaxFolderDepth);
    w.Key("max_name_bytes"); w.Uint64(kQueryLibraryMaxNameBytes);
    w.Key("max_description_bytes"); w.Uint64(kQueryLibraryMaxDescriptionBytes);
    w.EndObject();
    w.Key("folders");
    w.StartArray();
    for (const auto& f : state_.folders) {
      if (f.host_id != host) continue;
      w.StartObject(); write_folder_fields(w, f); w.EndObject();
    }
    w.EndArray();
    w.Key("queries");
    w.StartArray();
    for (const auto& q : state_.queries) {
      if (q.host_id != host) continue;
      w.StartObject(); write_query_fields(w, q); w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    return {200, sb.GetString()};
  });
}

QueryLibraryStore::Response QueryLibraryStore::create_folder(std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    QueryLibraryState candidate = state_;
    QueryLibraryFolder f;
    const auto host = read_host_field(member(doc, "host_id"), "host_id");
    f.host_id = require_host_locked(host ? &*host : nullptr, "host_id");
    f.parent_id = existing_folder_ref(candidate, member(doc, "parent_id"), "parent_id", f.host_id);
    f.name = read_name(member(doc, "name"), "name");
    if (candidate.folders.size() >= kQueryLibraryMaxFolders) throw too_large("folders", "too many folders");
    ensure_depth(candidate, f.parent_id, 1, "parent_id");
    if (folder_name_taken(candidate, f.host_id, f.parent_id, f.name, nullptr)) {
      throw validation("name", "duplicate", "a folder with this name already exists here");
    }
    f.id = new_id_locked('f', candidate);
    f.created_at_ms = f.updated_at_ms = now_ms();
    candidate.folders.push_back(f);
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    return folder_response(201, f, state_.revision);
  });
}

QueryLibraryStore::Response QueryLibraryStore::update_folder(const std::string& id, std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    QueryLibraryState candidate = state_;
    QueryLibraryFolder* f = find_folder(candidate, id);
    if (!f) throw not_found("folder not found");
    QueryLibraryFolder next = *f;
    bool changed = false;
    // A folder stays on its host.
    if (const auto host = read_host_field(member(doc, "host_id"), "host_id"); host && *host != next.host_id) {
      throw host_mismatch("host_id", "a folder cannot move to another host");
    }
    if (const auto* v = member(doc, "name")) {
      std::string name = read_name(v, "name");
      changed |= name != next.name;
      next.name = std::move(name);
    }
    if (const auto* v = member(doc, "parent_id")) {
      auto parent = existing_folder_ref(candidate, v, "parent_id", next.host_id);
      if (parent != next.parent_id) {
        if (parent) {
          if (*parent == id) throw validation("parent_id", "cycle", "a folder cannot be moved into itself");
          std::optional<std::string> cur = parent;
          size_t steps = 0;
          while (cur) {
            if (*cur == id) throw validation("parent_id", "cycle", "a folder cannot be moved into one of its subfolders");
            const auto* up = find_folder(candidate, *cur);
            if (!up || ++steps > candidate.folders.size()) break;
            cur = up->parent_id;
          }
        }
        int height = 0;
        for (const auto& item : folder_subtree(candidate, id)) height = std::max(height, item.second);
        ensure_depth(candidate, parent, height, "parent_id");
        next.parent_id = parent;
        changed = true;
      }
    }
    if (!changed) return folder_response(200, *f, state_.revision);
    if (folder_name_taken(candidate, next.host_id, next.parent_id, next.name, &id)) {
      throw validation("name", "duplicate", "a folder with this name already exists here");
    }
    next.updated_at_ms = now_ms();
    *f = next;
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    return folder_response(200, next, state_.revision);
  });
}

QueryLibraryStore::Response QueryLibraryStore::delete_folder(const std::string& id, bool recursive, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    if (!find_folder(state_, id)) throw not_found("folder not found");
    const auto subtree = folder_subtree(state_, id);
    std::unordered_set<std::string> doomed;
    for (const auto& item : subtree) doomed.insert(item.first);
    size_t child_folders = subtree.size() - 1;
    size_t direct_queries = 0;
    for (const auto& q : state_.queries) {
      if (q.folder_id && *q.folder_id == id) ++direct_queries;
    }
    if (!recursive && (child_folders > 0 || direct_queries > 0)) {
      LibraryError e;
      e.status = 409;
      e.code = "not_empty";
      e.message = "the folder is not empty; delete it with recursive=1";
      e.folders = child_folders;
      e.queries = direct_queries;
      e.revision = state_.revision;
      throw e;
    }
    QueryLibraryState candidate = state_;
    const size_t folders_before = candidate.folders.size();
    const size_t queries_before = candidate.queries.size();
    candidate.folders.erase(std::remove_if(candidate.folders.begin(), candidate.folders.end(),
                                           [&](const auto& f) { return doomed.count(f.id) != 0; }),
                            candidate.folders.end());
    candidate.queries.erase(std::remove_if(candidate.queries.begin(), candidate.queries.end(),
                                           [&](const auto& q) { return q.folder_id && doomed.count(*q.folder_id) != 0; }),
                            candidate.queries.end());
    const size_t deleted_folders = folders_before - candidate.folders.size();
    const size_t deleted_queries = queries_before - candidate.queries.size();
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("ok"); w.Bool(true);
    w.Key("id"); write_string(w, id);
    w.Key("deleted_folders"); w.Uint64(deleted_folders);
    w.Key("deleted_queries"); w.Uint64(deleted_queries);
    w.Key("revision"); w.Int64(state_.revision);
    w.EndObject();
    return {200, sb.GetString()};
  });
}

QueryLibraryStore::Response QueryLibraryStore::create_query(std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    QueryLibraryState candidate = state_;
    QueryLibraryQuery q;
    const auto host = read_host_field(member(doc, "host_id"), "host_id");
    q.host_id = require_host_locked(host ? &*host : nullptr, "host_id");
    q.folder_id = existing_folder_ref(candidate, member(doc, "folder_id"), "folder_id", q.host_id);
    q.name = read_name(member(doc, "name"), "name");
    q.description = read_description(member(doc, "description"), "description");
    q.sql = read_sql(member(doc, "sql"), "sql", options_.max_query_bytes);
    if (candidate.queries.size() >= kQueryLibraryMaxQueries) throw too_large("queries", "too many saved queries");
    if (query_name_taken(candidate, q.host_id, q.folder_id, q.name, nullptr)) {
      throw validation("name", "duplicate", "a query with this name already exists in this folder");
    }
    q.id = new_id_locked('q', candidate);
    q.created_at_ms = q.updated_at_ms = now_ms();
    candidate.queries.push_back(q);
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    return query_response(201, q, state_.revision);
  });
}

QueryLibraryStore::Response QueryLibraryStore::update_query(const std::string& id, std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    QueryLibraryState candidate = state_;
    QueryLibraryQuery* q = find_query(candidate, id);
    if (!q) throw not_found("query not found");
    QueryLibraryQuery next = *q;
    // A query stays on its host: a folder of another host is refused.
    if (const auto host = read_host_field(member(doc, "host_id"), "host_id"); host && *host != next.host_id) {
      throw host_mismatch("host_id", "a saved query cannot move to another host");
    }
    if (const auto* v = member(doc, "name")) next.name = read_name(v, "name");
    if (const auto* v = member(doc, "description")) next.description = read_description(v, "description");
    if (const auto* v = member(doc, "sql")) next.sql = read_sql(v, "sql", options_.max_query_bytes);
    if (const auto* v = member(doc, "folder_id")) next.folder_id = existing_folder_ref(candidate, v, "folder_id", next.host_id);
    const bool changed = next.name != q->name || next.description != q->description || next.sql != q->sql ||
                         next.folder_id != q->folder_id;
    if (!changed) return query_response(200, *q, state_.revision);
    if (query_name_taken(candidate, next.host_id, next.folder_id, next.name, &id)) {
      throw validation("name", "duplicate", "a query with this name already exists in this folder");
    }
    next.updated_at_ms = now_ms();
    *q = next;
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    return query_response(200, next, state_.revision);
  });
}

QueryLibraryStore::Response QueryLibraryStore::delete_query(const std::string& id, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    QueryLibraryState candidate = state_;
    const auto it = std::find_if(candidate.queries.begin(), candidate.queries.end(), [&](const auto& q) { return q.id == id; });
    if (it == candidate.queries.end()) throw not_found("query not found");
    candidate.queries.erase(it);
    candidate.revision = state_.revision + 1;
    commit_locked(std::move(candidate));
    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("ok"); w.Bool(true);
    w.Key("id"); write_string(w, id);
    w.Key("revision"); w.Int64(state_.revision);
    w.EndObject();
    return {200, sb.GetString()};
  });
}

// Import (typically the browser's localStorage library of one host, once) into the library of the request's host_id: the rules are in
// query_library_import.hpp.
QueryLibraryStore::Response QueryLibraryStore::import_library(std::string_view body, const std::string* if_match) {
  return guarded([&]() -> Response {
    require_editable_locked();
    check_if_match_locked(if_match);
    const auto doc = parse_body(body);
    const auto host_field = read_host_field(member(doc, "host_id"), "host_id");
    const std::string host = require_host_locked(host_field ? &*host_field : nullptr, "host_id");
    QueryLibraryState candidate = state_;
    const ImportOutcome outcome = import_into(
        candidate, doc, host, options_.max_query_bytes,
        [this](char prefix, const QueryLibraryState& state) { return new_id_locked(prefix, state); }, now_ms());
    if (outcome.changed()) {
      candidate.revision = state_.revision + 1;
      commit_locked(std::move(candidate));
    }

    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("ok"); w.Bool(true);
    w.Key("imported_folders"); w.Uint64(outcome.imported_folders);
    w.Key("merged_folders"); w.Uint64(outcome.merged_folders);
    w.Key("imported_queries"); w.Uint64(outcome.imported_queries);
    w.Key("skipped_queries"); w.Uint64(outcome.skipped_queries);
    w.Key("folder_ids");
    w.StartObject();
    for (const auto& [import_id, library_id] : outcome.folder_ids) {
      write_string(w, import_id);
      write_string(w, library_id);
    }
    w.EndObject();
    w.Key("revision"); w.Int64(state_.revision);
    w.EndObject();
    return {200, sb.GetString()};
  });
}

} // namespace chdash
