#pragma once

// The part of the graph that a request asks for. The graph of a host is built once for all its viewers (ExplorerGraph, explorer_graph.hpp).
// A request names a scope. A scope is a database, or a focus table with a depth. It also has a mode: logical lineage or physical storage.
// It states whether system objects and non-storing objects (views, materialized views, Buffers) appear. It also names one-hop expansions of single nodes.
// The scope is made without a connection. It is a pure function of the graph and the request. The native tests compare it with the old implementation on graphs that they generate.
//
// The graph is indexed once. The index holds the adjacency of the logical edges, the Buffer routing and the physical children. A request does not rebuild it.
// The index belongs to the snapshot. A graph without an index is indexed by the call.

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
  // One-hop expansions of each node, on top of the global depth: (upstream, id).
  std::vector<std::pair<bool, std::string>> expansions;
};

// At most this many `expand` parameters are read.
constexpr size_t kMaxGraphExpansions = 64;

// The scope that a request names. This never fails. A value that is not a number gets the default. An id that the graph does not know expands nothing.
GraphScopeRequest read_graph_scope(const httplib::Request& req);

bool is_system_database(const std::string& database);
// A view, a materialized view or a Buffer: it holds no data of its own.
bool is_non_storing_graph_node(const ExplorerGraphNode& node);

// The adjacency of a graph. It holds the logical edges in both directions, the Buffer routing and the physical children of each node that has an index.
// It keeps the order of the edges. The adjacency is built once for a snapshot.
std::shared_ptr<const ExplorerGraphIndex> index_graph(const ExplorerGraph& graph);

// The nodes and the edges of the scope, in the order of the graph. In a focused lineage, each logical node has the fields hidden_upstream and hidden_downstream.
// They count the neighbours beyond the scope. `index` is the index of `graph`. When `index` is null, it is made here.
ExplorerGraph scope_graph(const ExplorerGraph& graph, const GraphScopeRequest& scope, bool lineage_enabled, bool storage_enabled,
                          const ExplorerGraphIndex* index = nullptr);

// Whether one more level of depth shows a logical node that the scope does not.
bool logical_scope_has_more(const ExplorerGraph& graph, const GraphScopeRequest& scope, const ExplorerGraph& scoped, bool lineage_enabled,
                            const ExplorerGraphIndex* index = nullptr);

// The logical nodes that own a physical placement. A Buffer that routes to such a node is also included.
std::unordered_set<std::string> logical_storage_available_ids(const ExplorerGraph& graph, const ExplorerGraphIndex* index = nullptr);

// The access of humans (docs/access.md): a grant on some databases. The answer keeps only the databases that the subject may read.
// A node of another database goes, with each edge that touches it. A node that names no database (a node of the cluster topology)
// stays only while an edge links it to a node that stays.
ExplorerGraph keep_graph_databases(const ExplorerGraph& scoped, const std::unordered_set<std::string>& readable);
// The databases of the nodes of `graph`, once each, in the order of the nodes. A node that names no database gives none.
std::vector<std::string> graph_databases(const ExplorerGraph& graph);
// The storage map with only the databases that the subject may read. The totals of the answer come from the databases that stay.
ExplorerStorageMap keep_storage_databases(const ExplorerStorageMap& map, const std::unordered_set<std::string>& readable);

}  // namespace explorer
}  // namespace chdash
