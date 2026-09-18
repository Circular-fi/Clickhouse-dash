#pragma once

#include "allowed_objects.hpp"
#include "explorer_catalog.hpp"

#include <clickhouse/client.h>

#include <cstdint>
#include <optional>
#include <string>
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
};

bool load_explorer_graph(
    clickhouse::Client& system,
    const AllowedObjectSet& allowed,
    const ExplorerCatalog& catalog,
    ExplorerGraph& out,
    std::string* error);


} // namespace chdash
