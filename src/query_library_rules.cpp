#include "query_library_rules.hpp"

#include "query_library_request.hpp"

#include <algorithm>
#include <unordered_map>
#include <unordered_set>

namespace chdash {
namespace qlib {

// --- tree helpers -----------------------------------------------------------

const QueryLibraryFolder* find_folder(const QueryLibraryState& s, const std::string& id) {
  for (const auto& f : s.folders) if (f.id == id) return &f;
  return nullptr;
}

QueryLibraryFolder* find_folder(QueryLibraryState& s, const std::string& id) {
  for (auto& f : s.folders) if (f.id == id) return &f;
  return nullptr;
}

QueryLibraryQuery* find_query(QueryLibraryState& s, const std::string& id) {
  for (auto& q : s.queries) if (q.id == id) return &q;
  return nullptr;
}

// Folders on the path from `id` up to the root, `id` included (0 for root).
int folder_depth(const QueryLibraryState& s, const std::optional<std::string>& id) {
  int depth = 0;
  std::optional<std::string> cur = id;
  while (cur) {
    const auto* f = find_folder(s, *cur);
    if (!f) break;
    ++depth;
    if (depth > static_cast<int>(s.folders.size())) break;  // defensive; cycles are rejected on load
    cur = f->parent_id;
  }
  return depth;
}

// `id` and every folder below it, breadth first, with their level (1 = id).
std::vector<std::pair<std::string, int>> folder_subtree(const QueryLibraryState& s, const std::string& id) {
  std::unordered_map<std::string, std::vector<std::string>> children;
  for (const auto& f : s.folders) {
    if (f.parent_id) children[*f.parent_id].push_back(f.id);
  }
  std::vector<std::pair<std::string, int>> out{{id, 1}};
  std::unordered_set<std::string> seen{id};
  for (size_t i = 0; i < out.size(); ++i) {
    const auto it = children.find(out[i].first);
    if (it == children.end()) continue;
    for (const auto& child : it->second) {
      if (seen.insert(child).second) out.emplace_back(child, out[i].second + 1);
    }
  }
  return out;
}

// Sibling names are unique per host: the top level of each host is its own.
bool folder_name_taken(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& parent,
                       const std::string& name, const std::string* except_id) {
  const std::string folded = fold_ascii(name);
  for (const auto& f : s.folders) {
    if (except_id && f.id == *except_id) continue;
    if (f.host_id == host && f.parent_id == parent && fold_ascii(f.name) == folded) return true;
  }
  return false;
}

bool query_name_taken(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& folder,
                      const std::string& name, const std::string* except_id) {
  const std::string folded = fold_ascii(name);
  for (const auto& q : s.queries) {
    if (except_id && q.id == *except_id) continue;
    if (q.host_id == host && q.folder_id == folder && fold_ascii(q.name) == folded) return true;
  }
  return false;
}

// A folder reference of an item of `host`: null (the top level) or a folder
// of the same host (400 host_mismatch for a folder of another host).
std::optional<std::string> existing_folder_ref(const QueryLibraryState& s, const rapidjson::Value* v,
                                               const std::string& field, const std::string& host) {
  auto ref = read_ref(v, field);
  if (!ref) return ref;
  const auto* folder = find_folder(s, *ref);
  if (!folder) throw validation(field, "not_found", field + " does not name an existing folder");
  if (folder->host_id != host) throw host_mismatch(field, field + " names a folder of another host");
  return ref;
}

void ensure_depth(const QueryLibraryState& s, const std::optional<std::string>& parent, int subtree_height,
                  const std::string& field) {
  if (folder_depth(s, parent) + subtree_height > kQueryLibraryMaxFolderDepth) {
    throw validation(field, "depth", "folders can be nested at most " + std::to_string(kQueryLibraryMaxFolderDepth) + " levels deep");
  }
}

std::string unique_query_name(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& folder,
                              const std::string& name) {
  if (!query_name_taken(s, host, folder, name, nullptr)) return name;
  for (int n = 2; n < 100000; ++n) {
    const std::string suffix = " (" + std::to_string(n) + ")";
    std::string base = truncate_utf8(name, kQueryLibraryMaxNameBytes - suffix.size());
    std::string candidate = base + suffix;
    if (!query_name_taken(s, host, folder, candidate, nullptr)) return candidate;
  }
  throw validation("name", "duplicate", "no free name for an imported query");
}

// De-duplication key of an imported query: name + SQL, ignoring a " (n)"
// suffix added by an earlier import's rename, so re-importing is a no-op.
std::string import_key(const std::string& name, const std::string& sql) {
  std::string base = name;
  if (base.size() > 4 && base.back() == ')') {
    const auto open = base.rfind(" (");
    if (open != std::string::npos && open + 3 < base.size() &&
        std::all_of(base.begin() + static_cast<std::ptrdiff_t>(open) + 2, base.end() - 1,
                    [](char c) { return c >= '0' && c <= '9'; })) {
      base.resize(open);
    }
  }
  return base + std::string(1, '\0') + sql;
}

}  // namespace qlib
}  // namespace chdash
