#include "query_library_import.hpp"

#include "query_library_json.hpp"
#include "query_library_request.hpp"
#include "query_library_rules.hpp"

#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace qlib {

namespace {

// The most renames of one name in one import: "name (2)" to "name (1000)". A query after that is refused (413).
constexpr int kMaxRenamesOfOneName = 1000;
// A suffix " (n)" has at most this many bytes (" (1000)"). The base of a rename is cut so that the whole name fits.
constexpr size_t kMaxSuffixBytes = 7;

// The key of a name in a folder of one host. It compares the name without the case of ASCII letters, as the rules of the tree do.
// The folder is part of the key with its length, so that no name joins the folder.
std::string name_key(const std::optional<std::string>& folder, const std::string& name) {
  std::string key = folder ? std::to_string(folder->size()) + ":" + *folder : std::string("-");
  key.push_back('\0');
  key += fold_ascii(name);
  return key;
}

// What an import reads again and again about the state. It is built once for an import, and kept up to date as the import adds folders and
// queries. Each lookup is then one hash probe. The linear scans of the state made the work of an import grow with the square or the cube of its size,
// under the lock of the library.
struct ImportIndex {
  std::unordered_map<std::string, size_t> folder_at;           // folder id -> position in `folders`, for the folders of every host
  std::unordered_map<std::string, std::string> folder_by_name;  // name_key(parent, name) -> folder id, for the folders of the host
  std::unordered_set<std::string> query_names;                  // name_key(folder, name), for the queries of the host
  std::unordered_set<std::string> used_ids;                     // every folder id and query id of the state
  std::unordered_map<std::string, int> next_rename;             // name_key(folder, base of the name) -> the next suffix to try
  std::unordered_map<std::string, int> depth;                   // folder id -> the number of folders from the root to it (memo)

  ImportIndex(const QueryLibraryState& state, const std::string& host) {
    folder_at.reserve(state.folders.size());
    for (size_t i = 0; i < state.folders.size(); ++i) {
      const auto& f = state.folders[i];
      folder_at.emplace(f.id, i);
      used_ids.insert(f.id);
      if (f.host_id == host) folder_by_name.emplace(name_key(f.parent_id, f.name), f.id);
    }
    for (const auto& q : state.queries) {
      used_ids.insert(q.id);
      if (q.host_id == host) query_names.insert(name_key(q.folder_id, q.name));
    }
  }

  const QueryLibraryFolder* folder(const QueryLibraryState& state, const std::string& id) const {
    const auto it = folder_at.find(id);
    return it == folder_at.end() ? nullptr : &state.folders[it->second];
  }

  // The number of folders on the path from `id` up to the root, `id` included (folder_depth of the rules, with a memo).
  int depth_of(const QueryLibraryState& state, const std::optional<std::string>& id) {
    if (!id) return 0;
    std::vector<const QueryLibraryFolder*> chain;
    int known = 0;
    std::optional<std::string> current = id;
    while (current) {
      const auto memo = depth.find(*current);
      if (memo != depth.end()) {
        known = memo->second;
        break;
      }
      const auto* f = folder(state, *current);
      if (!f) break;
      chain.push_back(f);
      if (chain.size() > state.folders.size()) break;  // defensive; cycles are rejected on load
      current = f->parent_id;
    }
    int value = known;
    for (auto it = chain.rbegin(); it != chain.rend(); ++it) depth[(*it)->id] = ++value;
    return value;
  }
};

}  // namespace

ImportOutcome import_into(QueryLibraryState& candidate, const rapidjson::Document& doc, const std::string& host, size_t max_query_bytes,
                          const NewId& new_id, int64_t now) {
  const auto* folders = member(doc, "folders");
  const auto* queries = member(doc, "queries");
  if (folders && !folders->IsNull() && !folders->IsArray()) throw validation("folders", "type", "folders must be an array");
  if (queries && !queries->IsNull() && !queries->IsArray()) throw validation("queries", "type", "queries must be an array");
  const auto* copy_field = member(doc, "copy");
  if (copy_field && !copy_field->IsNull() && !copy_field->IsBool()) throw validation("copy", "type", "copy must be a boolean");
  const bool copy = copy_field && copy_field->IsBool() && copy_field->GetBool();
  const rapidjson::SizeType folder_count = folders && folders->IsArray() ? folders->Size() : 0;
  const rapidjson::SizeType query_count = queries && queries->IsArray() ? queries->Size() : 0;
  if (folder_count > kQueryLibraryMaxFolders) throw too_large("folders", "too many folders in the import");
  if (query_count > kQueryLibraryMaxQueries) throw too_large("queries", "too many queries in the import");

  struct ImportFolder {
    std::string import_id;
    std::optional<std::string> parent;
    std::string name;
    std::string field;
  };
  std::vector<ImportFolder> items;
  std::unordered_map<std::string, size_t> by_id;
  for (rapidjson::SizeType i = 0; i < folder_count; ++i) {
    const std::string field = "folders[" + std::to_string(i) + "]";
    const auto& item = (*folders)[i];
    if (!item.IsObject()) throw validation(field, "type", field + " must be an object");
    ImportFolder f;
    f.field = field;
    if (const auto* v = member(item, "id"); v && !v->IsNull()) {
      if (!v->IsString() || v->GetStringLength() == 0 || v->GetStringLength() > kQueryLibraryMaxIdBytes) {
        throw validation(field + ".id", "invalid", field + ".id must be a non-empty string");
      }
      f.import_id = json_text(*v);
    } else {
      f.import_id = "\x01import-" + std::to_string(i);
    }
    if (const auto* v = member(item, "parent_id"); v && v->IsString() && v->GetStringLength() > 0) f.parent = json_text(*v);
    f.name = read_name(member(item, "name"), field + ".name");
    if (!by_id.emplace(f.import_id, items.size()).second) {
      throw validation(field + ".id", "duplicate", field + ".id is a duplicate");
    }
    items.push_back(std::move(f));
  }

  // Parents first; a parent outside the payload means root.
  std::vector<size_t> order;
  std::vector<int> mark(items.size(), 0);  // 0 new, 1 visiting, 2 done
  for (size_t start = 0; start < items.size(); ++start) {
    std::vector<size_t> chain;
    size_t cur = start;
    for (;;) {
      if (mark[cur] == 2) break;
      if (mark[cur] == 1) throw validation("folders", "cycle", "the imported folders contain a parent_id cycle");
      mark[cur] = 1;
      chain.push_back(cur);
      if (!items[cur].parent) break;
      const auto it = by_id.find(*items[cur].parent);
      if (it == by_id.end()) break;
      cur = it->second;
    }
    for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
      mark[*it] = 2;
      order.push_back(*it);
    }
  }

  ImportIndex seen(candidate, host);
  // A new id that no folder and no query of the state has. The index holds the ids, so the check is one probe, not a scan of the state.
  const auto fresh_id = [&](char prefix) {
    for (;;) {
      std::string id = new_id(prefix, candidate);
      if (seen.used_ids.insert(id).second) return id;
    }
  };

  std::unordered_map<std::string, std::string> folder_map;  // import id -> server id
  size_t imported_folders = 0;
  size_t merged_folders = 0;
  for (const size_t index : order) {
    const auto& item = items[index];
    std::optional<std::string> parent;
    if (item.parent) {
      const auto mapped = folder_map.find(*item.parent);
      if (mapped != folder_map.end()) parent = mapped->second;
      else if (const auto* known = seen.folder(candidate, *item.parent); known && known->host_id == host) parent = *item.parent;
    }
    const std::string folder_key = name_key(parent, item.name);
    const auto existing = seen.folder_by_name.find(folder_key);
    if (existing != seen.folder_by_name.end() && copy) {
      throw validation(item.field + ".name", "duplicate", "a folder named \"" + item.name + "\" already exists there");
    }
    if (existing != seen.folder_by_name.end()) {
      folder_map[item.import_id] = existing->second;
      ++merged_folders;
      continue;
    }
    if (candidate.folders.size() >= kQueryLibraryMaxFolders) throw too_large("folders", "too many folders");
    if (seen.depth_of(candidate, parent) + 1 > kQueryLibraryMaxFolderDepth) {
      throw validation(item.field + ".parent_id", "depth", "folders can be nested at most " + std::to_string(kQueryLibraryMaxFolderDepth) + " levels deep");
    }
    QueryLibraryFolder f;
    f.id = fresh_id('f');
    f.host_id = host;
    f.parent_id = parent;
    f.name = item.name;
    f.created_at_ms = f.updated_at_ms = now;
    folder_map[item.import_id] = f.id;
    seen.folder_at.emplace(f.id, candidate.folders.size());
    seen.folder_by_name.emplace(folder_key, f.id);
    candidate.folders.push_back(std::move(f));
    ++imported_folders;
  }

  std::unordered_set<std::string> keys;
  for (const auto& q : candidate.queries) {
    if (q.host_id == host) keys.insert(import_key(q.name, q.sql));
  }
  size_t imported_queries = 0;
  size_t skipped_queries = 0;
  for (rapidjson::SizeType i = 0; i < query_count; ++i) {
    const std::string field = "queries[" + std::to_string(i) + "]";
    const auto& item = (*queries)[i];
    if (!item.IsObject()) throw validation(field, "type", field + " must be an object");
    QueryLibraryQuery q;
    q.name = read_name(member(item, "name"), field + ".name");
    q.description = read_description(member(item, "description"), field + ".description");
    q.sql = read_sql(member(item, "sql"), field + ".sql", max_query_bytes);
    q.host_id = host;
    if (const auto* v = member(item, "folder_id"); v && v->IsString() && v->GetStringLength() > 0) {
      const std::string ref = json_text(*v);
      const auto mapped = folder_map.find(ref);
      if (mapped != folder_map.end()) q.folder_id = mapped->second;
      else if (const auto* known = seen.folder(candidate, ref); known && known->host_id == host) q.folder_id = ref;
    }
    const std::string key = import_key(q.name, q.sql);
    if (!keys.insert(key).second && !copy) {
      ++skipped_queries;
      continue;
    }
    if (candidate.queries.size() >= kQueryLibraryMaxQueries) throw too_large("queries", "too many saved queries");
    if (copy) {
      if (seen.query_names.count(name_key(q.folder_id, q.name)) != 0) {
        throw validation(field + ".name", "duplicate", "a query named \"" + q.name + "\" already exists there");
      }
    } else if (seen.query_names.count(name_key(q.folder_id, q.name)) != 0) {
      // The name is taken in the folder. Take the first " (n)" that is free. The next suffix to try is kept for each name, so the work of all the
      // renames of one name is linear. The key of the counter cuts the name where a rename cuts it: two long names that end the same after the cut
      // share the counter. The number of renames of one name is bounded.
      int& n = seen.next_rename.try_emplace(name_key(q.folder_id, truncate_utf8(q.name, kQueryLibraryMaxNameBytes - kMaxSuffixBytes)), 2).first->second;
      for (;; ++n) {
        if (n > kMaxRenamesOfOneName) throw too_large(field + ".name", "too many queries with the name \"" + q.name + "\" in the import");
        const std::string suffix = " (" + std::to_string(n) + ")";
        std::string renamed = truncate_utf8(q.name, kQueryLibraryMaxNameBytes - suffix.size()) + suffix;
        if (seen.query_names.count(name_key(q.folder_id, renamed)) == 0) {
          q.name = std::move(renamed);
          break;
        }
      }
    }
    seen.query_names.insert(name_key(q.folder_id, q.name));
    q.id = fresh_id('q');
    const auto created = read_opt_int(member(item, "created_at_ms"), field + ".created_at_ms");
    const auto updated = read_opt_int(member(item, "updated_at_ms"), field + ".updated_at_ms");
    q.created_at_ms = created.value_or(now);
    q.updated_at_ms = updated.value_or(q.created_at_ms);
    candidate.queries.push_back(std::move(q));
    ++imported_queries;
  }

  ImportOutcome out;
  out.imported_folders = imported_folders;
  out.merged_folders = merged_folders;
  out.imported_queries = imported_queries;
  out.skipped_queries = skipped_queries;
  for (const auto& item : items) {
    if (item.import_id.empty() || item.import_id[0] == '\x01') continue;
    const auto it = folder_map.find(item.import_id);
    if (it == folder_map.end()) continue;
    out.folder_ids.emplace_back(item.import_id, it->second);
  }
  return out;
}

}  // namespace qlib
}  // namespace chdash
