#include "explorer_graph_scope.hpp"

#include "api_params.hpp"

#include <algorithm>
#include <deque>
#include <unordered_map>

namespace chdash {

// The adjacency of the graph. Each node has its place in graph.nodes. The adjacency gives the nodes that each node links to.
struct ExplorerGraphIndex {
  std::unordered_map<std::string, uint32_t> by_id;
  // The edges between two logical nodes, in the order of the edges. downstream[from] contains `to`. upstream[to] contains `from`.
  std::vector<std::vector<uint32_t>> downstream, upstream;
  // The "buffer" edges between two logical nodes. forward[from] contains `to`. backward[to] contains `from` when `from` is a Buffer.
  std::vector<std::vector<uint32_t>> buffer_forward, buffer_backward;
  // The edges from a node to a physical node, in the order of the edges.
  std::vector<std::vector<uint32_t>> physical_children;
  // The logical nodes that have an edge to a physical node, and the Buffers that route to such a node.
  std::vector<uint32_t> placed;
};

namespace explorer {

ExplorerGraph keep_graph_databases(const ExplorerGraph& scoped, const std::unordered_set<std::string>& readable) {
  ExplorerGraph out;
  out.generated_at_ms = scoped.generated_at_ms;
  out.metric_scope = scoped.metric_scope;
  out.refreshable_views_available = scoped.refreshable_views_available;
  out.truncated = scoped.truncated;
  out.unavailable_sections = scoped.unavailable_sections;
  out.unavailable_issues = scoped.unavailable_issues;
  std::unordered_set<std::string> kept;
  std::unordered_set<std::string> unnamed;
  for (const auto& node : scoped.nodes) {
    if (node.database.empty()) unnamed.insert(node.id);
    else if (readable.count(node.database) != 0) kept.insert(node.id);
  }
  // An edge stays when its two ends stay. A node with no database (a shard, a replica of a cluster) stays when a path of edges
  // links it to a node of a readable database, through other nodes with no database only.
  std::unordered_map<std::string, std::vector<std::string>> links;
  for (const auto& edge : scoped.edges) {
    links[edge.from].push_back(edge.to);
    links[edge.to].push_back(edge.from);
  }
  std::deque<std::string> queue(kept.begin(), kept.end());
  while (!queue.empty()) {
    const std::string current = std::move(queue.front());
    queue.pop_front();
    const auto it = links.find(current);
    if (it == links.end()) continue;
    for (const auto& next : it->second) {
      if (unnamed.count(next) != 0 && kept.insert(next).second) queue.push_back(next);
    }
  }
  for (const auto& node : scoped.nodes) {
    if (kept.count(node.id) != 0) out.nodes.push_back(node);
  }
  for (const auto& edge : scoped.edges) {
    if (kept.count(edge.from) != 0 && kept.count(edge.to) != 0) out.edges.push_back(edge);
  }
  return out;
}

std::vector<std::string> graph_databases(const ExplorerGraph& graph) {
  std::vector<std::string> out;
  std::unordered_set<std::string> seen;
  for (const auto& node : graph.nodes) {
    if (!node.database.empty() && seen.insert(node.database).second) out.push_back(node.database);
  }
  return out;
}

ExplorerStorageMap keep_storage_databases(const ExplorerStorageMap& map, const std::unordered_set<std::string>& readable) {
  ExplorerStorageMap out;
  out.generated_at_ms = map.generated_at_ms;
  out.metric_scope = map.metric_scope;
  out.table_limit_per_database = map.table_limit_per_database;
  for (const auto& database : map.databases) {
    if (readable.count(database.name) != 0) out.databases.push_back(database);
  }
  return out;
}

GraphScopeRequest read_graph_scope(const httplib::Request& req) {
  GraphScopeRequest scope;
  if (req.has_param("database")) scope.database = req.get_param_value("database");
  if (req.has_param("focus_database")) scope.focus_database = req.get_param_value("focus_database");
  if (req.has_param("focus_table")) scope.focus_table = req.get_param_value("focus_table");
  if (!scope.focus_database.empty() && !scope.focus_table.empty()) {
    scope.focus_id = "table:" + scope.focus_database + "." + scope.focus_table;
  }
  if (req.has_param("depth")) {
    const auto depth = parse_whole_i64(req.get_param_value("depth"));
    scope.depth = depth ? static_cast<int>(std::clamp<int64_t>(*depth, 0, 8)) : 1;
  }
  scope.physical = req.has_param("mode") && req.get_param_value("mode") == "physical";
  scope.include_system = req.has_param("include_system") && req.get_param_value("include_system") == "1";
  scope.include_non_storing = !req.has_param("include_non_storing") || req.get_param_value("include_non_storing") != "0";
  // Repeated expand=up:table:db.t and expand=down:table:db.u parameters. The ids are compared only with the ids of the authorized graph.
  // An unknown or hidden id is a no-op.
  const size_t expand_count = std::min(req.get_param_value_count("expand"), kMaxGraphExpansions);
  for (size_t i = 0; i < expand_count; ++i) {
    const std::string item = req.get_param_value("expand", i);
    if (item.rfind("up:", 0) == 0 && item.size() > 3) scope.expansions.emplace_back(true, item.substr(3));
    else if (item.rfind("down:", 0) == 0 && item.size() > 5) scope.expansions.emplace_back(false, item.substr(5));
  }
  return scope;
}

bool is_system_database(const std::string& database) {
  return database == "system" || database == "information_schema" || database == "INFORMATION_SCHEMA";
}

bool is_non_storing_graph_node(const ExplorerGraphNode& node) {
  return node.kind == "view" || node.kind == "materialized_view" || node.kind == "refreshable_materialized_view" || node.kind == "buffer";
}

std::shared_ptr<const ExplorerGraphIndex> index_graph(const ExplorerGraph& graph) {
  auto index = std::make_shared<ExplorerGraphIndex>();
  const size_t n = graph.nodes.size();
  index->by_id.reserve(n);
  for (size_t i = 0; i < n; ++i) index->by_id.emplace(graph.nodes[i].id, static_cast<uint32_t>(i));
  index->downstream.resize(n);
  index->upstream.resize(n);
  index->buffer_forward.resize(n);
  index->buffer_backward.resize(n);
  index->physical_children.resize(n);
  std::vector<char> is_placed(n, 0);
  for (const auto& edge : graph.edges) {
    const auto from_it = index->by_id.find(edge.from);
    const auto to_it = index->by_id.find(edge.to);
    if (from_it == index->by_id.end() || to_it == index->by_id.end()) continue;
    const uint32_t from = from_it->second, to = to_it->second;
    const ExplorerGraphNode& a = graph.nodes[from];
    const ExplorerGraphNode& b = graph.nodes[to];
    if (a.layer == "logical" && b.layer == "logical") {
      index->downstream[from].push_back(to);
      index->upstream[to].push_back(from);
      if (edge.kind == "buffer") {
        index->buffer_forward[from].push_back(to);
        if (a.kind == "buffer") index->buffer_backward[to].push_back(from);
      }
    }
    if (b.layer == "physical") index->physical_children[from].push_back(to);
    if (a.layer == "logical" && b.layer == "physical") is_placed[from] = 1;
  }
  // A Buffer that routes to a node with a placement also gets a placement. The same rule applies along the rest of the route. A chain of Buffers is followed.
  std::deque<uint32_t> queue;
  for (uint32_t i = 0; i < n; ++i) if (is_placed[i]) queue.push_back(i);
  while (!queue.empty()) {
    const uint32_t current = queue.front();
    queue.pop_front();
    for (const uint32_t from : index->buffer_backward[current]) {
      if (is_placed[from]) continue;
      is_placed[from] = 1;
      queue.push_back(from);
    }
  }
  for (uint32_t i = 0; i < n; ++i) if (is_placed[i]) index->placed.push_back(i);
  return index;
}

namespace {

// The nodes of a scope, given by their place in the graph. A flag says whether the scope is a focused lineage.
struct ScopedNodes {
  std::vector<char> included;
  bool focused_lineage = false;
};

struct Walk {
  std::vector<uint32_t> neighbors, intermediates;
};

class Scoper {
 public:
  Scoper(const ExplorerGraph& graph, const ExplorerGraphIndex& index, const GraphScopeRequest& scope, bool lineage_enabled, bool storage_enabled)
      : graph_(graph), index_(index), scope_(scope), lineage_(lineage_enabled), storage_(storage_enabled) {}

  ScopedNodes nodes() const {
    ScopedNodes out;
    out.included.assign(graph_.nodes.size(), 0);
    if (!scope_.focus_id.empty()) {
      const auto root_it = index_.by_id.find(scope_.focus_id);
      if (root_it == index_.by_id.end()) return out;
      const uint32_t root = root_it->second;
      if (graph_.nodes[root].layer != "logical" || !allowed(root)) return out;
      if (!scope_.physical && lineage_) {
        lineage(root, out);
        out.focused_lineage = true;
      } else if (scope_.physical && storage_) {
        physical(root, out);
      }
      return out;
    }
    for (uint32_t i = 0; i < graph_.nodes.size(); ++i) {
      const ExplorerGraphNode& node = graph_.nodes[i];
      if (!scope_.database.empty() && node.database != scope_.database) continue;
      if (!allowed(i)) continue;
      if (scope_.physical) {
        if (storage_ && (node.layer == "logical" || node.layer == "physical")) out.included[i] = 1;
      } else if (lineage_ && node.layer == "logical") {
        out.included[i] = 1;
      }
    }
    if (scope_.physical && storage_ && !scope_.database.empty()) shared_below(out);
    return out;
  }

  // One semantic hop from `start` in one direction. When non-storing objects are hidden, View, MV and Buffer nodes cost zero hops (same rule as depth).
  // The walk passes through them. They are reported separately as intermediates.
  Walk walk(uint32_t start, bool up) const {
    Walk out;
    const auto& links = up ? index_.upstream : index_.downstream;
    std::unordered_set<uint32_t> seen{start};
    std::vector<uint32_t> stack{start};
    while (!stack.empty()) {
      const uint32_t current = stack.back();
      stack.pop_back();
      for (const uint32_t next : links[current]) {
        if (!allowed(next)) continue;
        if (!seen.insert(next).second) continue;
        if (!scope_.include_non_storing && is_non_storing_graph_node(graph_.nodes[next])) {
          out.intermediates.push_back(next);
          stack.push_back(next);
        } else {
          out.neighbors.push_back(next);
        }
      }
    }
    return out;
  }

 private:
  bool allowed(uint32_t node) const { return scope_.include_system || !is_system_database(graph_.nodes[node].database); }

  // Depth is a semantic hop count that the user sees. When non-storing objects are hidden, View, MV and Buffer intermediates cost zero hops. For example, table -> view
  // -> mv -> table is depth 1, not depth 3. The scoped payload still ships these hidden intermediates, so the browser can contract them into
  // the correct typed edge.
  void lineage(uint32_t root, ScopedNodes& out) const {
    std::unordered_map<uint32_t, int> distance;
    std::deque<uint32_t> queue;
    distance.emplace(root, 0);
    queue.push_front(root);
    while (!queue.empty()) {
      const uint32_t current = queue.front();
      queue.pop_front();
      const int current_depth = distance[current];
      for (const auto* links : {&index_.downstream[current], &index_.upstream[current]}) {
        for (const uint32_t next : *links) {
          if (!allowed(next)) continue;
          const int cost = (!scope_.include_non_storing && is_non_storing_graph_node(graph_.nodes[next])) ? 0 : 1;
          const int next_depth = current_depth + cost;
          if (next_depth > scope_.depth) continue;
          const auto known = distance.find(next);
          if (known != distance.end() && known->second <= next_depth) continue;
          distance[next] = next_depth;
          if (cost == 0) queue.push_front(next);
          else queue.push_back(next);
        }
      }
    }
    for (const auto& [node, _] : distance) out.included[node] = 1;

    // A per-node expansion adds one semantic hop in one direction from an anchor that is itself shown. The expansions apply to a fixed point,
    // so a chain of expansions (expand A, then the node it revealed) has no order dependence. An anchor that is no longer shown expands nothing.
    if (scope_.expansions.empty()) return;
    std::vector<std::pair<bool, uint32_t>> anchors;
    for (const auto& [up, id] : scope_.expansions) {
      const auto it = index_.by_id.find(id);
      if (it != index_.by_id.end()) anchors.emplace_back(up, it->second);
    }
    bool grew = true;
    for (size_t pass = 0; grew && pass <= scope_.expansions.size(); ++pass) {
      grew = false;
      for (const auto& [up, anchor] : anchors) {
        if (!out.included[anchor]) continue;
        // The hidden intermediates on the way ship for contraction.
        const Walk found = walk(anchor, up);
        for (const uint32_t id : found.neighbors) if (!out.included[id]) { out.included[id] = 1; grew = true; }
        for (const uint32_t id : found.intermediates) if (!out.included[id]) { out.included[id] = 1; grew = true; }
      }
    }
  }

  // Storage mode needs only the focused table, the Buffer routes that feed or drain it, and their physical descendants. Do not ship the unrelated
  // database-wide physical topology to the browser.
  void physical(uint32_t root, ScopedNodes& out) const {
    std::vector<uint32_t> queue{root};
    out.included[root] = 1;
    for (size_t at = 0; at < queue.size(); ++at) {
      const uint32_t current = queue[at];
      for (const uint32_t next : index_.buffer_forward[current]) {
        if (!allowed(next) || out.included[next]) continue;
        out.included[next] = 1;
        queue.push_back(next);
      }
      for (const uint32_t from : index_.buffer_backward[current]) {
        if (!allowed(from) || out.included[from]) continue;
        out.included[from] = 1;
        queue.push_back(from);
      }
    }
    // The physical nodes below every logical root, transitively.
    std::vector<uint32_t> below(queue.begin(), queue.end());
    for (size_t at = 0; at < below.size(); ++at) {
      for (const uint32_t child : index_.physical_children[below[at]]) {
        if (out.included[child]) continue;
        out.included[child] = 1;
        below.push_back(child);
      }
    }
  }

  // The topology of a cluster belongs to no database. The Distributed tables of several databases share it. The Storage mode of a database shows the
  // shared nodes below its own tables, and no other nodes.
  void shared_below(ScopedNodes& out) const {
    std::vector<uint32_t> queue;
    for (uint32_t i = 0; i < graph_.nodes.size(); ++i) {
      if (!out.included[i] || graph_.nodes[i].layer != "logical") continue;
      for (const uint32_t child : index_.physical_children[i]) {
        if (!graph_.nodes[child].database.empty() || out.included[child]) continue;
        out.included[child] = 1;
        queue.push_back(child);
      }
    }
    for (size_t at = 0; at < queue.size(); ++at) {
      for (const uint32_t child : index_.physical_children[queue[at]]) {
        if (out.included[child]) continue;
        out.included[child] = 1;
        queue.push_back(child);
      }
    }
  }

  const ExplorerGraph& graph_;
  const ExplorerGraphIndex& index_;
  const GraphScopeRequest& scope_;
  bool lineage_, storage_;
};

const ExplorerGraphIndex& index_of(const ExplorerGraph& graph, const ExplorerGraphIndex* given, std::shared_ptr<const ExplorerGraphIndex>& holder) {
  if (given) return *given;
  if (graph.index) return *graph.index;
  holder = index_graph(graph);
  return *holder;
}

}  // namespace

ExplorerGraph scope_graph(const ExplorerGraph& graph, const GraphScopeRequest& scope, bool lineage_enabled, bool storage_enabled,
                          const ExplorerGraphIndex* given) {
  std::shared_ptr<const ExplorerGraphIndex> holder;
  const ExplorerGraphIndex& index = index_of(graph, given, holder);
  ExplorerGraph out;
  out.generated_at_ms = graph.generated_at_ms;
  out.metric_scope = graph.metric_scope;
  out.refreshable_views_available = graph.refreshable_views_available;
  out.unavailable_sections = graph.unavailable_sections;
  out.unavailable_issues = graph.unavailable_issues;
  out.truncated = graph.truncated;

  const Scoper scoper(graph, index, scope, lineage_enabled, storage_enabled);
  const ScopedNodes scoped = scoper.nodes();
  out.nodes.reserve(graph.nodes.size());
  std::vector<uint32_t> place;  // the place of a node of the answer in the graph
  for (uint32_t i = 0; i < graph.nodes.size(); ++i) {
    if (!scoped.included[i]) continue;
    out.nodes.push_back(graph.nodes[i]);
    place.push_back(i);
  }
  if (scoped.focused_lineage) {
    // The browser draws a per-node "+N" only where a node can still expand. This keeps the next ring out of the payload.
    for (size_t k = 0; k < out.nodes.size(); ++k) {
      ExplorerGraphNode& node = out.nodes[k];
      if (node.layer != "logical") continue;
      for (const bool up : {true, false}) {
        uint64_t hidden = 0;
        for (const uint32_t id : scoper.walk(place[k], up).neighbors) if (!scoped.included[id]) ++hidden;
        (up ? node.hidden_upstream : node.hidden_downstream) = hidden;
      }
    }
  }
  out.edges.reserve(graph.edges.size());
  for (const auto& edge : graph.edges) {
    const auto from = index.by_id.find(edge.from);
    const auto to = index.by_id.find(edge.to);
    if (from == index.by_id.end() || to == index.by_id.end()) continue;
    if (scoped.included[from->second] && scoped.included[to->second]) out.edges.push_back(edge);
  }
  return out;
}

bool logical_scope_has_more(const ExplorerGraph& graph, const GraphScopeRequest& scope, const ExplorerGraph& scoped, bool lineage_enabled,
                            const ExplorerGraphIndex* given) {
  if (!lineage_enabled || scope.physical || scope.focus_id.empty() || scope.depth >= 8) return false;
  std::shared_ptr<const ExplorerGraphIndex> holder;
  const ExplorerGraphIndex& index = index_of(graph, given, holder);
  GraphScopeRequest next_scope = scope;
  next_scope.depth = std::min(8, scope.depth + 1);
  const Scoper scoper(graph, index, next_scope, lineage_enabled, false);
  const ScopedNodes next = scoper.nodes();
  std::unordered_set<std::string> current_ids;
  current_ids.reserve(scoped.nodes.size());
  for (const auto& node : scoped.nodes) if (node.layer == "logical") current_ids.insert(node.id);
  for (uint32_t i = 0; i < graph.nodes.size(); ++i) {
    if (next.included[i] && graph.nodes[i].layer == "logical" && !current_ids.count(graph.nodes[i].id)) return true;
  }
  return false;
}

std::unordered_set<std::string> logical_storage_available_ids(const ExplorerGraph& graph, const ExplorerGraphIndex* given) {
  std::shared_ptr<const ExplorerGraphIndex> holder;
  const ExplorerGraphIndex& index = index_of(graph, given, holder);
  std::unordered_set<std::string> available;
  for (const uint32_t node : index.placed) available.insert(graph.nodes[node].id);
  return available;
}

}  // namespace explorer
}  // namespace chdash
