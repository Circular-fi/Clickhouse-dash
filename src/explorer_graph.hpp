#pragma once

#include "allowed_objects.hpp"
#include "explorer_catalog.hpp"

#include <clickhouse/client.h>

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

struct ExplorerGraphTtlRule {
  std::string expression;
  std::string base_expression;
  std::string offset_label;
  std::string action;      // recompress | move | delete | group_by | ttl
  std::string target_kind; // codec | volume | disk | expression
  std::string target;
};

// What an edge or node side panel explains about a logical object. Built from
// the same authorized system.tables texts as the graph; never serialized in
// the graph payload itself (GET /api/explorer/graph/definition serves it per
// object). Referenced objects outside AllowedObjectSet keep only a
// `*_visible = false` flag, never their name.
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
  // Scoped (focused Lineage) payloads only: semantic neighbours of this node
  // that exist but are outside the shipped neighbourhood, per direction.
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

struct ExplorerGraph {
  uint64_t generated_at_ms = 0;
  std::string metric_scope = "local-replica";
  bool refreshable_views_available = true;
  std::vector<ExplorerGraphNode> nodes;
  std::vector<ExplorerGraphEdge> edges;
  // Keyed by logical node id. Kept beside the nodes so scoped graph payloads
  // never copy SELECT texts they do not serialize.
  std::unordered_map<std::string, ExplorerGraphDefinition> definitions;
};

bool load_explorer_graph(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    const ExplorerCatalog& catalog,
    ExplorerGraph& out,
    std::string* error);


} // namespace chdash
