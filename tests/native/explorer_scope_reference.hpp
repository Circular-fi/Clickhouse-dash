#pragma once

// This is the scope of the Explorer graph, as the code before the split wrote it (src/api_explorer.cpp). It is kept verbatim as the reference that the native
// tests compare with the new implementation (explorer_graph_scope.cpp). The tests use graphs that they generate.

#include "explorer_graph.hpp"

#include <algorithm>
#include <deque>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace reference {

using namespace chdash;

struct ExplorerGraphRequestScope {
  std::string database;
  std::string focus_database;
  std::string focus_table;
  std::string focus_id;
  int depth = 1;
  bool physical = false;
  bool include_system = false;
  bool include_non_storing = true;
  // Per-node one-hop expansions go on top of the global depth: (upstream, id).
  std::vector<std::pair<bool, std::string>> expansions;
};


bool is_system_database(const std::string& database) {
  return database == "system" || database == "information_schema" || database == "INFORMATION_SCHEMA";
}

bool is_non_storing_graph_node(const ExplorerGraphNode& node) {
  return node.kind == "view" || node.kind == "materialized_view" ||
      node.kind == "refreshable_materialized_view" || node.kind == "buffer";
}



std::unordered_set<std::string> logical_storage_available_ids(const ExplorerGraph& graph) {
  std::unordered_map<std::string, const ExplorerGraphNode*> by_id;
  by_id.reserve(graph.nodes.size());
  for (const auto& node : graph.nodes) by_id.emplace(node.id, &node);

  std::unordered_set<std::string> available;
  for (const auto& edge : graph.edges) {
    const auto from_it = by_id.find(edge.from);
    const auto to_it = by_id.find(edge.to);
    if (from_it == by_id.end() || to_it == by_id.end()) continue;
    if (from_it->second->layer == "logical" && to_it->second->layer == "physical") available.insert(edge.from);
  }

  bool changed = true;
  while (changed) {
    changed = false;
    for (const auto& edge : graph.edges) {
      if (edge.kind != "buffer" || !available.count(edge.to) || available.count(edge.from)) continue;
      const auto from_it = by_id.find(edge.from);
      if (from_it == by_id.end() || from_it->second->layer != "logical" || from_it->second->kind != "buffer") continue;
      available.insert(edge.from);
      changed = true;
    }
  }
  return available;
}


ExplorerGraph scope_graph(
    const ExplorerGraph& graph,
    const ExplorerGraphRequestScope& scope,
    bool lineage_enabled,
    bool storage_enabled) {
  ExplorerGraph out;
  out.generated_at_ms = graph.generated_at_ms;
  out.metric_scope = graph.metric_scope;
  out.refreshable_views_available = graph.refreshable_views_available;
  out.unavailable_sections = graph.unavailable_sections;
  out.unavailable_issues = graph.unavailable_issues;

  std::unordered_map<std::string, const ExplorerGraphNode*> by_id;
  by_id.reserve(graph.nodes.size());
  for (const auto& node : graph.nodes) by_id.emplace(node.id, &node);

  auto allowed_system = [&](const ExplorerGraphNode& node) {
    return scope.include_system || !is_system_database(node.database);
  };

  // This is the directed logical adjacency. It is filled only for a focused Lineage scope.
  std::unordered_map<std::string, std::vector<std::string>> downstream;
  std::unordered_map<std::string, std::vector<std::string>> upstream;
  struct SemanticWalk { std::vector<std::string> neighbors; std::vector<std::string> intermediates; };
  // This is one semantic hop from `start` in one direction. When non-storing objects
  // are hidden, View/MV/Buffer nodes cost zero hops (same rule as depth).
  // The walk goes through them. They are reported separately as intermediates.
  auto semantic_walk = [&](const std::string& start, bool up) {
    SemanticWalk walk;
    const auto& links = up ? upstream : downstream;
    std::unordered_set<std::string> seen{start};
    std::vector<std::string> stack{start};
    while (!stack.empty()) {
      const std::string current = stack.back();
      stack.pop_back();
      const auto it = links.find(current);
      if (it == links.end()) continue;
      for (const auto& next : it->second) {
        if (!seen.insert(next).second) continue;
        const auto node_it = by_id.find(next);
        if (node_it == by_id.end()) continue;
        if (!scope.include_non_storing && is_non_storing_graph_node(*node_it->second)) {
          walk.intermediates.push_back(next);
          stack.push_back(next);
        } else {
          walk.neighbors.push_back(next);
        }
      }
    }
    return walk;
  };
  bool focused_lineage = false;

  std::unordered_set<std::string> included;
  if (!scope.focus_id.empty()) {
    const auto root_it = by_id.find(scope.focus_id);
    if (root_it != by_id.end() && root_it->second->layer == "logical" && allowed_system(*root_it->second)) {
      if (!scope.physical && lineage_enabled) {
        std::unordered_map<std::string, std::vector<std::string>> adjacency;
        for (const auto& edge : graph.edges) {
          const auto from_it = by_id.find(edge.from);
          const auto to_it = by_id.find(edge.to);
          if (from_it == by_id.end() || to_it == by_id.end()) continue;
          if (from_it->second->layer != "logical" || to_it->second->layer != "logical") continue;
          if (!allowed_system(*from_it->second) || !allowed_system(*to_it->second)) continue;
          adjacency[edge.from].push_back(edge.to);
          adjacency[edge.to].push_back(edge.from);
          downstream[edge.from].push_back(edge.to);
          upstream[edge.to].push_back(edge.from);
        }

        // Depth is a semantic hop count that the user sees. When non-storing objects
        // are hidden, View, MV and Buffer intermediates cost zero hops. For example:
        // table -> view -> mv -> table is depth 1, not depth 3. The code still ships
        // those hidden intermediates inside the scoped payload, so the browser
        // can contract them into the correct typed edge.
        std::unordered_map<std::string, int> distance;
        std::deque<std::string> queue;
        distance.emplace(scope.focus_id, 0);
        queue.push_front(scope.focus_id);
        while (!queue.empty()) {
          const std::string current = queue.front();
          queue.pop_front();
          const int current_depth = distance[current];
          const auto adj_it = adjacency.find(current);
          if (adj_it == adjacency.end()) continue;
          for (const auto& next : adj_it->second) {
            const auto node_it = by_id.find(next);
            if (node_it == by_id.end()) continue;
            const int cost = (!scope.include_non_storing && is_non_storing_graph_node(*node_it->second)) ? 0 : 1;
            const int next_depth = current_depth + cost;
            if (next_depth > scope.depth) continue;
            const auto known = distance.find(next);
            if (known != distance.end() && known->second <= next_depth) continue;
            distance[next] = next_depth;
            if (cost == 0) queue.push_front(next);
            else queue.push_back(next);
          }
        }
        for (const auto& [id, _] : distance) included.insert(id);

        // Per-node expansions add one semantic hop in one direction from an
        // anchor that is itself shown. The rule is applied to a fixed point, so a chain of
        // expansions (expand A, then the node it revealed) is order-free. An
        // anchor that is no longer shown expands nothing.
        if (!scope.expansions.empty()) {
          bool grew = true;
          for (size_t pass = 0; grew && pass <= scope.expansions.size(); ++pass) {
            grew = false;
            for (const auto& [up, anchor] : scope.expansions) {
              if (!included.count(anchor)) continue;
              // The hidden intermediates on the way are shipped for contraction.
              const auto walk = semantic_walk(anchor, up);
              for (const auto& id : walk.neighbors) if (included.insert(id).second) grew = true;
              for (const auto& id : walk.intermediates) if (included.insert(id).second) grew = true;
            }
          }
        }
        focused_lineage = true;
      } else if (scope.physical && storage_enabled) {
        // Storage mode needs only the focused table. It also needs the Buffer routes that feed or
        // drain it, and their physical descendants. Do not ship the unrelated
        // database-wide physical topology to the browser.
        std::unordered_set<std::string> logical_roots{scope.focus_id};
        bool changed = true;
        while (changed) {
          changed = false;
          for (const auto& edge : graph.edges) {
            if (edge.kind != "buffer") continue;
            const auto from_it = by_id.find(edge.from);
            const auto to_it = by_id.find(edge.to);
            if (from_it == by_id.end() || to_it == by_id.end()) continue;
            if (from_it->second->layer != "logical" || to_it->second->layer != "logical") continue;
            if (!allowed_system(*from_it->second) || !allowed_system(*to_it->second)) continue;
            if (logical_roots.count(edge.from) && logical_roots.insert(edge.to).second) changed = true;
            if (logical_roots.count(edge.to) && from_it->second->kind == "buffer" && logical_roots.insert(edge.from).second) changed = true;
          }
        }
        included.insert(logical_roots.begin(), logical_roots.end());
        changed = true;
        while (changed) {
          changed = false;
          for (const auto& edge : graph.edges) {
            if (!included.count(edge.from) || included.count(edge.to)) continue;
            const auto to_it = by_id.find(edge.to);
            if (to_it == by_id.end() || to_it->second->layer != "physical") continue;
            included.insert(edge.to);
            changed = true;
          }
        }
      }
    }
  } else {
    for (const auto& node : graph.nodes) {
      if (!scope.database.empty() && node.database != scope.database) continue;
      if (!allowed_system(node)) continue;
      if (scope.physical) {
        if (storage_enabled && (node.layer == "logical" || node.layer == "physical")) included.insert(node.id);
      } else if (lineage_enabled && node.layer == "logical") {
        included.insert(node.id);
      }
    }
  }

  out.nodes.reserve(included.size());
  for (const auto& node : graph.nodes) if (included.count(node.id)) out.nodes.push_back(node);
  if (focused_lineage) {
    // This lets the browser draw a per-node "+N" only where something is left to
    // expand. The browser does not receive the next ring.
    for (auto& node : out.nodes) {
      if (node.layer != "logical") continue;
      for (const bool up : {true, false}) {
        uint64_t hidden = 0;
        for (const auto& id : semantic_walk(node.id, up).neighbors) if (!included.count(id)) ++hidden;
        (up ? node.hidden_upstream : node.hidden_downstream) = hidden;
      }
    }
  }
  out.edges.reserve(graph.edges.size());
  for (const auto& edge : graph.edges) {
    if (included.count(edge.from) && included.count(edge.to)) out.edges.push_back(edge);
  }
  return out;
}

bool logical_scope_has_more(
    const ExplorerGraph& graph,
    const ExplorerGraphRequestScope& scope,
    const ExplorerGraph& scoped,
    bool lineage_enabled) {
  if (!lineage_enabled || scope.physical || scope.focus_id.empty() || scope.depth >= 8) return false;
  ExplorerGraphRequestScope next_scope = scope;
  next_scope.depth = std::min(8, scope.depth + 1);
  const ExplorerGraph next = scope_graph(graph, next_scope, lineage_enabled, false);
  std::unordered_set<std::string> current_ids;
  current_ids.reserve(scoped.nodes.size());
  for (const auto& node : scoped.nodes) if (node.layer == "logical") current_ids.insert(node.id);
  for (const auto& node : next.nodes) {
    if (node.layer == "logical" && !current_ids.count(node.id)) return true;
  }
  return false;
}


}  // namespace reference
