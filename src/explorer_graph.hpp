#pragma once

#include "allowed_objects.hpp"
#include "explorer_catalog.hpp"
#include "explorer_ttl.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

// The side panel of a node or an edge explains a logical object. It uses the same authorized system.tables texts as the graph (read as the runner).
// The graph payload never serializes these texts. GET /api/explorer/graph/definition serves them for each object.
// A referenced object outside AllowedObjectSet keeps only a `*_visible = false` flag. It never keeps the name.
struct ExplorerGraphDefinition {
  std::string select_sql;          // View / MV / refreshable MV AS SELECT
  bool select_sql_truncated = false;
  std::string target_database;     // MV TO / Buffer / Distributed destination
  std::string target_table;
  bool target_visible = false;
  std::string dictionary_source_kind; // CLICKHOUSE, MYSQL, FILE, ...
  std::string dictionary_layout;
  std::string dictionary_lifetime;
  std::string distributed_cluster;
  std::string distributed_sharding_key;
  uint64_t distributed_shards = 0;
  uint64_t distributed_replicas = 0;
};

struct ExplorerGraphNode {
  std::string id;
  std::string layer = "logical"; // logical | physical
  std::string parent_id;
  std::string kind;
  std::string database;
  std::string name;
  std::string engine;
  std::string label;
  std::string health = "healthy";
  std::string topology_badge;
  std::optional<uint64_t> rows;
  std::optional<uint64_t> logical_bytes;
  std::optional<uint64_t> physical_bytes;
  std::optional<uint64_t> resident_bytes;
  uint64_t active_parts = 0;
  uint64_t shard_num = 0;
  uint64_t replica_num = 0;
  std::string host_name;
  std::string disk_name;
  std::string disk_path;
  std::string disk_type;
  std::string storage_policy;
  std::string volume_name;
  uint64_t volume_priority = 0;
  double move_factor = 0.0;
  std::optional<uint64_t> disk_free_space;
  std::optional<uint64_t> disk_total_space;
  std::optional<uint64_t> buffer_min_time;
  std::optional<uint64_t> buffer_max_time;
  std::optional<uint64_t> buffer_min_rows;
  std::optional<uint64_t> buffer_max_rows;
  std::optional<uint64_t> buffer_min_bytes;
  std::optional<uint64_t> buffer_max_bytes;
  uint64_t buffer_layers = 0;
  std::vector<ExplorerGraphTtlRule> ttl_rules;
  // Scoped payloads of a focused lineage only: semantic neighbours of this node.
  // They exist, but lie outside the shipped neighbourhood. The count is given per direction.
  uint64_t hidden_upstream = 0;
  uint64_t hidden_downstream = 0;
};

struct ExplorerGraphEdge {
  std::string id;
  std::string from;
  std::string to;
  std::string kind;
  std::string label;
  bool can_animate = false;
};

// The graph is bounded. The topology of a cluster is omitted when it makes the graph larger than this.
// The cluster topology has a node for each shard and each replica, shared by the Distributed tables that name it. `truncated` says so.
constexpr size_t kMaxGraphNodes = 20000;
constexpr size_t kMaxGraphEdges = 40000;

// The adjacency of a graph, made once for a snapshot (explorer_graph_scope.hpp).
struct ExplorerGraphIndex;

struct ExplorerGraph {
  uint64_t generated_at_ms = 0;
  std::string metric_scope = "local-replica";
  bool refreshable_views_available = true;
  std::vector<ExplorerGraphNode> nodes;
  std::vector<ExplorerGraphEdge> edges;
  // A bound removed some topology (kMaxGraphNodes, kMaxGraphEdges).
  bool truncated = false;
  // Made when the graph is loaded; the scope of a request reads it.
  std::shared_ptr<const ExplorerGraphIndex> index;
  // Keyed by logical node id. Kept beside the nodes so scoped graph payloads
  // never copy SELECT texts they do not serialize.
  std::unordered_map<std::string, ExplorerGraphDefinition> definitions;
  // The sections that are not in the catalog under the graph. A missing grant of the system user caused each omission.
  std::vector<std::string> unavailable_sections;
  std::vector<ExplorerUnavailableIssue> unavailable_issues;
};

// `runner_identity`: acl_identity_key of the runner URI (DdlTextCache). The system account gives the graph inputs (numbers and structure).
// The runner gives the DDL texts, because ClickHouse masks their secrets for each user (the SELECT of a view, engine_full).
// explorer_graph.cpp reads them. Then it builds the graph (explorer_graph_build.hpp).
bool load_explorer_graph(
    ChExecutor& system,
    ChExecutor& runner,
    ExplorerCaches& caches,
    const std::string& runner_identity,
    const AllowedObjectSet& allowed,
    const ExplorerCatalog& catalog,
    ExplorerGraph& out,
    std::string* error);


} // namespace chdash
