#pragma once

// The part of the graph that a request asks for. The graph of a host is built once for all its viewers (ExplorerGraph, explorer_graph.hpp); a
// request names a scope: a database, or a focus table with a depth, a mode (logical lineage or physical storage), whether system objects and
// non-storing objects (views, materialized views, Buffers) are shown, and one-hop expansions of single nodes. The scope is made without a
// connection: it is a pure function of the graph and the request, and the native tests compare it with the old implementation on graphs that
// they generate.
//
// The graph is indexed once (an adjacency of the logical edges, the Buffer routing, the physical children): a request does not rebuild it. The
// index belongs to the snapshot; a graph that has none is indexed by the call.

#include "explorer_graph.hpp"

#include <httplib.h>

#include <memory>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace chdash {
namespace explorer {

struct GraphScopeRequest {
  std::string database;
  std::string focus_database;
  std::string focus_table;
  std::string focus_id;  // "table:<focus_database>.<focus_table>" when both are given
  int depth = 1;
  bool physical = false;
  bool include_system = false;
  bool include_non_storing = true;
  // Per-node one-hop expansions on top of the global depth: (upstream, id).
  std::vector<std::pair<bool, std::string>> expansions;
};

// At most this many `expand` parameters are read.
constexpr size_t kMaxGraphExpansions = 64;

// The scope that a request names. Never fails: a value that is not a number is the default, and an id that the graph does not know expands nothing.
GraphScopeRequest read_graph_scope(const httplib::Request& req);

bool is_system_database(const std::string& database);
// A view, a materialized view or a Buffer: it holds no data of its own.
bool is_non_storing_graph_node(const ExplorerGraphNode& node);

// The adjacency of a graph (a node that has an index in its nodes, the logical edges both ways, the Buffer routing, the physical children), in the order
// of its edges. Built once for a snapshot.
std::shared_ptr<const ExplorerGraphIndex> index_graph(const ExplorerGraph& graph);

// The nodes and the edges of the scope, in the order of the graph. In a focused lineage each logical node says how many neighbours it has beyond the
// scope (hidden_upstream, hidden_downstream). `index` is the one of `graph` (null: made here).
ExplorerGraph scope_graph(const ExplorerGraph& graph, const GraphScopeRequest& scope, bool lineage_enabled, bool storage_enabled,
                          const ExplorerGraphIndex* index = nullptr);

// Whether one more level of depth would show a logical node that the scope does not.
bool logical_scope_has_more(const ExplorerGraph& graph, const GraphScopeRequest& scope, const ExplorerGraph& scoped, bool lineage_enabled,
                            const ExplorerGraphIndex* index = nullptr);

// The logical nodes that own a physical placement (or are a Buffer that routes to one that does).
std::unordered_set<std::string> logical_storage_available_ids(const ExplorerGraph& graph, const ExplorerGraphIndex* index = nullptr);

}  // namespace explorer
}  // namespace chdash
