#pragma once

// The graph of the Explorer is a pure function of what was read.
// It holds the logical nodes (a table, a view, a materialized view, a Buffer, a dictionary, a Distributed table, and so on) and the edges between them.
// It also holds the physical topology under them (a replica, a storage policy, its volumes, their disks, the shards of a cluster).
// load_explorer_graph (explorer_graph.cpp) reads the inputs as the system account. The native tests give the builder inputs that they write.
//
// An object appears only when the AllowedObjectSet allows it. An edge appears only when the set allows both ends. A hidden object is never named.
// A destination that the set does not allow is reported by `target_visible = false` only.

#include "explorer_graph.hpp"

#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {
namespace explorer {

// One table of system.tables, with its texts (from the DdlTextCache).
struct GraphTable {
  std::string database, name, engine, engine_full, ddl, as_select;
  std::vector<std::string> data_paths;
};

struct GraphStorageVolume {
  std::string policy, volume;
  uint64_t priority = 0;
  std::vector<std::string> disks;
  std::string type;
  uint64_t max_part_size = 0;
  double move_factor = 0.0;
};

// `dependencies_*` of system.tables: `from` is the object, `to` the object that depends on it.
struct GraphDependency {
  std::string from_database, from_table, to_database, to_table;
};

struct GraphDictionarySource {
  std::string dictionary_database, dictionary, source_database, source_table;
};

struct GraphClusterRow {
  std::string cluster;
  uint64_t shard = 0, replica = 0;
  std::string host;
};

struct ExplorerGraphInputs {
  std::vector<GraphTable> tables;
  std::unordered_map<std::string, ExplorerDatabaseDisk> disks;                     // by name
  std::unordered_map<std::string, std::vector<GraphStorageVolume>> storage_policies;  // by policy, in volume order
  std::vector<GraphDependency> dependencies;
  std::vector<GraphDictionarySource> dictionary_sources;
  std::vector<GraphClusterRow> clusters;
  bool refreshable_views_available = false;
};

// The kind of a node: "table", "mergetree", "view", "materialized_view", "refreshable_materialized_view", "buffer", "distributed",
// "dictionary", "stream_engine", "external", "tinylog", "stripelog", "log", "memory".
std::string classify_node(const std::string& engine, const std::string& ddl);

// The clusters that the Distributed tables name. The builder reads rows of these clusters only.
std::vector<std::string> referenced_clusters(const std::vector<GraphTable>& tables);

// Fills `out`: its nodes, edges, definitions, refreshable_views_available and truncated. The caller owns the other members.
void build_explorer_graph(const ExplorerGraphInputs& inputs, const AllowedObjectSet& allowed, const ExplorerCatalog& catalog, ExplorerGraph& out);

// "table:<database>.<table>" is the id of a logical node. When two tables have one id, the later table gets a suffix.
std::string table_node_id(std::string_view database, std::string_view table);

}  // namespace explorer
}  // namespace chdash
