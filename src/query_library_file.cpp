#include "query_library_file.hpp"

#include "json_parse.hpp"
#include "query_library_json.hpp"
#include "secure_random.hpp"

#include <rapidjson/document.h>
#include <rapidjson/error/en.h>
#include <rapidjson/prettywriter.h>
#include <rapidjson/stringbuffer.h>

#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <cerrno>
#include <cmath>
#include <filesystem>
#include <stdexcept>
#include <system_error>
#include <unordered_map>
#include <unordered_set>

namespace chdash {
namespace {

using namespace qlib;

// --- persisted file parsing -------------------------------------------------

[[noreturn]] void file_error(const std::string& message) { throw std::runtime_error(message); }

std::string file_string(const rapidjson::Value& obj, const char* key, const std::string& ctx, bool required) {
  const auto* v = member(obj, key);
  if (!v || v->IsNull()) {
    if (required) file_error(ctx + "." + key + " is required");
    return {};
  }
  if (!v->IsString()) file_error(ctx + "." + key + " must be a string");
  return json_text(*v);
}

std::optional<std::string> file_opt_string(const rapidjson::Value& obj, const char* key, const std::string& ctx) {
  const auto* v = member(obj, key);
  if (!v || v->IsNull()) return std::nullopt;
  if (!v->IsString()) file_error(ctx + "." + key + " must be a string or null");
  if (v->GetStringLength() == 0) return std::nullopt;
  return json_text(*v);
}

int64_t file_int(const rapidjson::Value& obj, const char* key, const std::string& ctx, int64_t fallback) {
  const auto* v = member(obj, key);
  if (!v || v->IsNull()) return fallback;
  if (v->IsInt64()) return v->GetInt64();
  if (v->IsNumber() && std::isfinite(v->GetDouble()) && std::fabs(v->GetDouble()) < 9.0e15) {
    return static_cast<int64_t>(std::llround(v->GetDouble()));
  }
  file_error(ctx + "." + key + " must be an integer");
}

std::string file_id(const rapidjson::Value& obj, const std::string& ctx) {
  std::string id = file_string(obj, "id", ctx, true);
  if (id.empty() || id.size() > kQueryLibraryMaxIdBytes) file_error(ctx + ".id must be 1 to 128 bytes");
  return id;
}

const rapidjson::Value* file_array(const rapidjson::Value& root, const char* key) {
  const auto* v = member(root, key);
  if (!v || v->IsNull()) return nullptr;
  if (!v->IsArray()) file_error(std::string(key) + " must be an array");
  return v;
}

} // namespace

// --- file format ------------------------------------------------------------

QueryLibraryState parse_query_library_file(std::string_view text, QueryLibraryMigration* migration) {
  if (json_nests_deeper_than(text, kJsonMaxDepth)) {
    file_error("arrays and objects nest deeper than " + std::to_string(kJsonMaxDepth) + " levels");
  }
  rapidjson::Document doc;
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc, text);
  if (doc.HasParseError()) {
    file_error(std::string("invalid JSON at offset ") + std::to_string(doc.GetErrorOffset()) + ": " +
               rapidjson::GetParseError_En(doc.GetParseError()));
  }
  if (!doc.IsObject()) file_error("the top-level value must be an object");
  const auto* version = member(doc, "version");
  if (!version || !version->IsInt64()) file_error("version is required");
  if (version->GetInt64() != 1 && version->GetInt64() != kQueryLibraryFileVersion) {
    file_error("unsupported version " + std::to_string(version->GetInt64()) + " (expected 1 or 2)");
  }
  QueryLibraryMigration local;
  QueryLibraryMigration& mig = migration ? *migration : local;
  mig = QueryLibraryMigration{};
  mig.from_version = static_cast<int>(version->GetInt64());

  QueryLibraryState state;
  state.revision = file_int(doc, "revision", "file", 0);
  if (state.revision < 0) file_error("revision cannot be negative");
  state.updated_at_ms = file_int(doc, "updated_at_ms", "file", 0);

  // Every entry belongs to one host. Entries without a host_id, which means every folder
  // of a version-1 file, are dropped. A folder or query left in a dropped
  // folder moves to the top level of its host. The structure is checked on
  // the whole file first. So a broken file is a load error either way.
  std::vector<QueryLibraryFolder> all_folders;
  std::unordered_set<std::string> folder_ids;
  if (const auto* folders = file_array(doc, "folders")) {
    if (folders->Size() > kQueryLibraryMaxFolders) file_error("too many folders");
    for (rapidjson::SizeType i = 0; i < folders->Size(); ++i) {
      const std::string ctx = "folders[" + std::to_string(i) + "]";
      const auto& item = (*folders)[i];
      if (!item.IsObject()) file_error(ctx + " must be an object");
      QueryLibraryFolder f;
      f.id = file_id(item, ctx);
      f.host_id = file_opt_string(item, "host_id", ctx).value_or("");
      f.parent_id = file_opt_string(item, "parent_id", ctx);
      f.name = file_string(item, "name", ctx, true);
      f.created_at_ms = file_int(item, "created_at_ms", ctx, 0);
      f.updated_at_ms = file_int(item, "updated_at_ms", ctx, f.created_at_ms);
      if (!folder_ids.insert(f.id).second) file_error(ctx + ".id is a duplicate");
      all_folders.push_back(std::move(f));
    }
  }
  std::unordered_map<std::string, const QueryLibraryFolder*> folder_by_id;
  for (const auto& f : all_folders) folder_by_id[f.id] = &f;
  for (const auto& f : all_folders) {
    if (f.parent_id && folder_ids.count(*f.parent_id) == 0) file_error("folder " + f.id + " has an unknown parent_id");
  }
  for (const auto& f : all_folders) {
    size_t steps = 0;
    std::optional<std::string> cur = f.parent_id;
    while (cur) {
      if (*cur == f.id || ++steps > all_folders.size()) file_error("folder " + f.id + " is part of a parent_id cycle");
      cur = folder_by_id[*cur]->parent_id;
    }
  }
  std::unordered_set<std::string> dropped;
  for (const auto& f : all_folders) {
    if (f.host_id.empty()) dropped.insert(f.id);
  }
  for (const auto& f : all_folders) {
    if (f.host_id.empty()) continue;
    QueryLibraryFolder kept = f;
    if (kept.parent_id) {
      if (dropped.count(*kept.parent_id)) {
        kept.parent_id.reset();
        ++mig.rerooted;
      } else if (folder_by_id[*kept.parent_id]->host_id != kept.host_id) {
        file_error("folder " + kept.id + " and its parent belong to different hosts");
      }
    }
    state.folders.push_back(std::move(kept));
  }
  mig.dropped_folders = dropped.size();

  std::unordered_set<std::string> query_ids;
  if (const auto* queries = file_array(doc, "queries")) {
    if (queries->Size() > kQueryLibraryMaxQueries) file_error("too many queries");
    for (rapidjson::SizeType i = 0; i < queries->Size(); ++i) {
      const std::string ctx = "queries[" + std::to_string(i) + "]";
      const auto& item = (*queries)[i];
      if (!item.IsObject()) file_error(ctx + " must be an object");
      QueryLibraryQuery q;
      q.id = file_id(item, ctx);
      q.folder_id = file_opt_string(item, "folder_id", ctx);
      if (q.folder_id && folder_ids.count(*q.folder_id) == 0) file_error(ctx + ".folder_id names an unknown folder");
      q.name = file_string(item, "name", ctx, true);
      q.description = file_string(item, "description", ctx, false);
      q.sql = file_string(item, "sql", ctx, true);
      q.host_id = file_opt_string(item, "host_id", ctx).value_or("");
      q.created_at_ms = file_int(item, "created_at_ms", ctx, 0);
      q.updated_at_ms = file_int(item, "updated_at_ms", ctx, q.created_at_ms);
      if (!query_ids.insert(q.id).second) file_error(ctx + ".id is a duplicate");
      if (q.host_id.empty()) {
        ++mig.dropped_queries;
        continue;
      }
      if (q.folder_id) {
        if (dropped.count(*q.folder_id)) {
          q.folder_id.reset();
          ++mig.rerooted;
        } else if (folder_by_id[*q.folder_id]->host_id != q.host_id) {
          file_error(ctx + " and its folder belong to different hosts");
        }
      }
      state.queries.push_back(std::move(q));
    }
  }

  // The history of an earlier release is not kept. It lives in the browser. The history is counted, not read.
  if (const auto* history = file_array(doc, "history")) mig.dropped_history = history->Size();
  return state;
}

std::string serialize_query_library_file(const QueryLibraryState& state) {
  rapidjson::StringBuffer sb;
  rapidjson::PrettyWriter<rapidjson::StringBuffer> w(sb);
  w.SetIndent(' ', 2);
  w.StartObject();
  w.Key("version"); w.Int(kQueryLibraryFileVersion);
  w.Key("revision"); w.Int64(state.revision);
  w.Key("updated_at_ms"); w.Int64(state.updated_at_ms);
  w.Key("folders");
  w.StartArray();
  for (const auto& f : state.folders) { w.StartObject(); write_folder_fields(w, f); w.EndObject(); }
  w.EndArray();
  w.Key("queries");
  w.StartArray();
  for (const auto& q : state.queries) { w.StartObject(); write_query_fields(w, q); w.EndObject(); }
  w.EndArray();
  w.EndObject();
  std::string out(sb.GetString(), sb.GetSize());
  out.push_back('\n');
  return out;
}

// --- atomic write -----------------------------------------------------------

bool atomic_write_file(const std::string& path, std::string_view data, std::string* error) {
  namespace fs = std::filesystem;
  const fs::path target(path);
  const std::string base = target.filename().string();
  if (base.empty() || base == "." || base == "..") {
    if (error) *error = "the configured path has no file name";
    return false;
  }
  fs::path dir = target.parent_path();
  if (dir.empty()) dir = ".";

  // An unpredictable name comes from secure_random.hpp. O_EXCL below refuses a file that someone made in advance.
  const fs::path tmp = dir / ("." + base + ".tmp-" + std::to_string(static_cast<long>(::getpid())) + "-" + random_hex(8));

  int flags = O_WRONLY | O_CREAT | O_EXCL;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
#ifdef O_NOFOLLOW
  flags |= O_NOFOLLOW;
#endif
  const int fd = ::open(tmp.c_str(), flags, S_IRUSR | S_IWUSR);
  if (fd < 0) {
    if (error) *error = std::string("cannot create the temporary file: ") + std::generic_category().message(errno);
    return false;
  }

  std::string failure;
  if (::fchmod(fd, S_IRUSR | S_IWUSR) != 0) failure = std::string("fchmod: ") + std::generic_category().message(errno);
  size_t written = 0;
  while (failure.empty() && written < data.size()) {
    const ssize_t n = ::write(fd, data.data() + written, data.size() - written);
    if (n < 0) {
      if (errno == EINTR) continue;
      failure = std::string("write: ") + std::generic_category().message(errno);
      break;
    }
    written += static_cast<size_t>(n);
  }
  if (failure.empty() && ::fsync(fd) != 0) failure = std::string("fsync: ") + std::generic_category().message(errno);
  if (::close(fd) != 0 && failure.empty()) failure = std::string("close: ") + std::generic_category().message(errno);
  if (failure.empty() && ::rename(tmp.c_str(), target.c_str()) != 0) {
    failure = std::string("rename: ") + std::generic_category().message(errno);
  }
  if (!failure.empty()) {
    ::unlink(tmp.c_str());
    if (error) *error = failure;
    return false;
  }

  // Make the rename durable. This is a best-effort step, because the data is already in place.
  int dir_flags = O_RDONLY;
#ifdef O_DIRECTORY
  dir_flags |= O_DIRECTORY;
#endif
#ifdef O_CLOEXEC
  dir_flags |= O_CLOEXEC;
#endif
  const int dfd = ::open(dir.c_str(), dir_flags);
  if (dfd >= 0) {
    (void)::fsync(dfd);
    ::close(dfd);
  }
  return true;
}

} // namespace chdash
