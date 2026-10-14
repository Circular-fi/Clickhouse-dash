#include "query_library_read.hpp"

#include "query_library_rules.hpp"

#include <algorithm>
#include <cctype>

namespace chdash {
namespace qlib {
namespace {

std::string lower_ascii(const std::string& text) {
  std::string out = text;
  for (auto& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

// By name without the case of ASCII letters, then by id: the same order at every request, so that a cursor means the same item.
template <typename T>
bool before(const T* a, const T* b) {
  const std::string x = lower_ascii(a->name);
  const std::string y = lower_ascii(b->name);
  if (x != y) return x < y;
  return a->id < b->id;
}

}  // namespace

LibraryPage library_page(const QueryLibraryState& s, const std::string& host, const std::optional<std::string>& parent, size_t cursor,
                         size_t limit) {
  LibraryPage page;
  limit = std::max<size_t>(1, std::min(limit, kLibraryPageMax));
  std::unordered_map<std::string, std::vector<const QueryLibraryFolder*>> sub_folders;
  std::unordered_map<std::string, std::vector<const QueryLibraryQuery*>> sub_queries;
  std::unordered_map<std::string, const QueryLibraryFolder*> by_id;
  for (const auto& f : s.folders) {
    if (f.host_id != host) continue;
    ++page.host_folders;
    by_id[f.id] = &f;
    sub_folders[f.parent_id.value_or("")].push_back(&f);
  }
  std::unordered_map<std::string, size_t> under;  // the queries under each folder, subfolders included
  for (const auto& q : s.queries) {
    if (q.host_id != host) continue;
    ++page.host_queries;
    sub_queries[q.folder_id.value_or("")].push_back(&q);
    int hops = 0;
    for (std::string id = q.folder_id.value_or(""); !id.empty() && hops <= kQueryLibraryMaxFolderDepth + 1; ++hops) {
      ++under[id];
      const auto it = by_id.find(id);
      id = it == by_id.end() ? std::string() : it->second->parent_id.value_or("");
    }
  }
  for (auto& item : sub_folders) std::sort(item.second.begin(), item.second.end(), before<QueryLibraryFolder>);
  for (auto& item : sub_queries) std::sort(item.second.begin(), item.second.end(), before<QueryLibraryQuery>);

  const auto children_of = [&](const std::string& id) { return (sub_folders.count(id) ? sub_folders[id].size() : 0) + (sub_queries.count(id) ? sub_queries[id].size() : 0); };
  const std::string key = parent.value_or("");
  page.parent_queries = parent ? under[key] : page.host_queries;
  const std::vector<const QueryLibraryFolder*> first_folders = sub_folders.count(key) ? sub_folders[key] : std::vector<const QueryLibraryFolder*>{};
  const std::vector<const QueryLibraryQuery*> first_queries = sub_queries.count(key) ? sub_queries[key] : std::vector<const QueryLibraryQuery*>{};
  page.level_total = first_folders.size() + first_queries.size();

  const auto describe = [&](const QueryLibraryFolder* f) {
    page.query_count[f->id] = under.count(f->id) ? under[f->id] : 0;
    page.child_count[f->id] = children_of(f->id);
    page.subfolder_count[f->id] = sub_folders.count(f->id) ? sub_folders[f->id].size() : 0;
  };

  if (page.level_total > limit) {
    // The first level alone is larger than a page: a window of it, folders first.
    const size_t end = std::min(page.level_total, cursor + limit);
    for (size_t i = cursor; i < end; ++i) {
      if (i < first_folders.size()) page.folders.push_back(first_folders[i]);
      else page.queries.push_back(first_queries[i - first_folders.size()]);
    }
    for (const auto* f : page.folders) describe(f);
    if (end < page.level_total) page.next_cursor = end;
    return page;
  }

  for (const auto* f : first_folders) page.folders.push_back(f);
  for (const auto* q : first_queries) page.queries.push_back(q);
  for (const auto* f : first_folders) describe(f);
  size_t total = page.level_total;
  std::vector<const QueryLibraryFolder*> frontier = first_folders;
  while (!frontier.empty()) {
    size_t next_size = 0;
    for (const auto* f : frontier) next_size += children_of(f->id);
    if (next_size == 0 || total + next_size > limit) break;
    std::vector<const QueryLibraryFolder*> next_frontier;
    for (const auto* f : frontier) {
      page.loaded.insert(f->id);
      if (sub_folders.count(f->id)) {
        for (const auto* child : sub_folders[f->id]) {
          page.folders.push_back(child);
          describe(child);
          next_frontier.push_back(child);
        }
      }
      if (sub_queries.count(f->id)) {
        for (const auto* q : sub_queries[f->id]) page.queries.push_back(q);
      }
    }
    total += next_size;
    ++page.depth;
    frontier = std::move(next_frontier);
  }
  // A folder without children has nothing to load.
  bool complete = true;
  for (const auto* f : page.folders) {
    if (page.child_count[f->id] == 0) page.loaded.insert(f->id);
    if (!page.loaded.count(f->id)) complete = false;
  }
  page.complete = complete;
  return page;
}

std::string folder_path_text(const QueryLibraryState& s, const std::optional<std::string>& folder) {
  std::vector<std::string> names;
  std::optional<std::string> current = folder;
  for (int hops = 0; current && hops <= kQueryLibraryMaxFolderDepth + 1; ++hops) {
    const QueryLibraryFolder* f = find_folder(s, *current);
    if (!f) break;
    names.push_back(f->name);
    current = f->parent_id;
  }
  if (names.empty()) return "/";
  std::string out;
  for (auto it = names.rbegin(); it != names.rend(); ++it) out += "/" + *it;
  return out;
}

std::vector<std::string> folder_ancestors(const QueryLibraryState& s, const std::optional<std::string>& folder) {
  std::vector<std::string> ids;
  std::optional<std::string> current = folder;
  for (int hops = 0; current && hops <= kQueryLibraryMaxFolderDepth + 1; ++hops) {
    const QueryLibraryFolder* f = find_folder(s, *current);
    if (!f) break;
    ids.push_back(f->id);
    current = f->parent_id;
  }
  std::reverse(ids.begin(), ids.end());
  return ids;
}

std::vector<LibraryHit> library_search(const QueryLibraryState& s, const std::string& host, const std::vector<std::string>& terms, size_t limit,
                                       size_t* total) {
  std::vector<LibraryHit> hits;
  // The path of a folder is computed once: a search reads every query of the host.
  std::unordered_map<std::string, std::string> paths;
  const auto path_of = [&](const std::optional<std::string>& folder) -> const std::string& {
    const std::string key = folder.value_or("");
    auto it = paths.find(key);
    if (it == paths.end()) it = paths.emplace(key, folder_path_text(s, folder)).first;
    return it->second;
  };
  std::vector<const QueryLibraryQuery*> matched;
  for (const auto& q : s.queries) {
    if (q.host_id != host) continue;
    const std::string hay = lower_ascii(q.name + "\n" + q.description + "\n" + q.sql + "\n" + path_of(q.folder_id));
    bool all = true;
    for (const auto& term : terms) {
      if (hay.find(term) == std::string::npos) {
        all = false;
        break;
      }
    }
    if (all) matched.push_back(&q);
  }
  std::sort(matched.begin(), matched.end(), before<QueryLibraryQuery>);
  if (total) *total = matched.size();
  for (const auto* q : matched) {
    if (hits.size() >= limit) break;
    hits.push_back({q, path_of(q->folder_id)});
  }
  return hits;
}

}  // namespace qlib
}  // namespace chdash
