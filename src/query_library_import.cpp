#include "query_library_import.hpp"

#include "query_library_json.hpp"
#include "query_library_request.hpp"
#include "query_library_rules.hpp"

#include <optional>
#include <unordered_map>
#include <unordered_set>

namespace chdash {
namespace qlib {

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

  std::unordered_map<std::string, std::string> folder_map;  // import id -> server id
  size_t imported_folders = 0;
  size_t merged_folders = 0;
  for (const size_t index : order) {
    const auto& item = items[index];
    std::optional<std::string> parent;
    if (item.parent) {
      const auto mapped = folder_map.find(*item.parent);
      if (mapped != folder_map.end()) parent = mapped->second;
      else if (const auto* known = find_folder(candidate, *item.parent); known && known->host_id == host) parent = *item.parent;
    }
    const std::string folded = fold_ascii(item.name);
    const QueryLibraryFolder* existing = nullptr;
    for (const auto& f : candidate.folders) {
      if (f.host_id == host && f.parent_id == parent && fold_ascii(f.name) == folded) { existing = &f; break; }
    }
    if (existing && copy) {
      throw validation(item.field + ".name", "duplicate", "a folder named \"" + item.name + "\" already exists there");
    }
    if (existing) {
      folder_map[item.import_id] = existing->id;
      ++merged_folders;
      continue;
    }
    if (candidate.folders.size() >= kQueryLibraryMaxFolders) throw too_large("folders", "too many folders");
    ensure_depth(candidate, parent, 1, item.field + ".parent_id");
    QueryLibraryFolder f;
    f.id = new_id('f', candidate);
    f.host_id = host;
    f.parent_id = parent;
    f.name = item.name;
    f.created_at_ms = f.updated_at_ms = now;
    folder_map[item.import_id] = f.id;
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
      else if (const auto* known = find_folder(candidate, ref); known && known->host_id == host) q.folder_id = ref;
    }
    const std::string key = import_key(q.name, q.sql);
    if (!keys.insert(key).second && !copy) {
      ++skipped_queries;
      continue;
    }
    if (candidate.queries.size() >= kQueryLibraryMaxQueries) throw too_large("queries", "too many saved queries");
    if (copy) {
      const std::string folded = fold_ascii(q.name);
      for (const auto& other : candidate.queries) {
        if (other.host_id == host && other.folder_id == q.folder_id && fold_ascii(other.name) == folded) {
          throw validation(field + ".name", "duplicate", "a query named \"" + q.name + "\" already exists there");
        }
      }
    } else {
      q.name = unique_query_name(candidate, host, q.folder_id, q.name);
    }
    q.id = new_id('q', candidate);
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
