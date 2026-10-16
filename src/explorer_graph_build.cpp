#include "explorer_graph_build.hpp"

#include "explorer_rules.hpp"
#include "explorer_values.hpp"
#include "json_text.hpp"
#include "sql_structure.hpp"

#include <algorithm>
#include <cctype>
#include <map>
#include <set>
#include <sstream>
#include <unordered_set>
#include <utility>

namespace chdash {
namespace explorer {

namespace {

using sql::QualifiedName;

// Panels show the SELECT of the object. A generated view with a pathological definition must not turn one definition response into megabytes.
constexpr size_t kDefinitionSqlLimit = 32 * 1024;

// `CLICKHOUSE(HOST ... TABLE 't')` -> `CLICKHOUSE`. Only the leading kind identifier is kept: connection arguments (host, user, masked
// password) are not graph metadata.
std::string leading_identifier(std::string_view text) {
  size_t pos = 0;
  auto ident = sql::parse_identifier(text, pos);
  if (!ident) return {};
  std::string out = *ident;
  std::transform(out.begin(), out.end(), out.begin(), [](unsigned char ch) { return static_cast<char>(std::toupper(ch)); });
  return out;
}

// A node id is unique in this graph. Two tables whose names join to one id (`a.b` + `c` and `a` + `b.c`) do not share it.
// The later table gets a suffix.
class NodeIds {
 public:
  std::string add(std::string_view database, std::string_view table) {
    std::string id = table_node_id(database, table);
    if (!used_.insert(id).second) {
      for (size_t n = 2;; ++n) {
        const std::string candidate = id + "#" + std::to_string(n);
        if (used_.insert(candidate).second) {
          id = candidate;
          break;
        }
      }
    }
    by_key_.emplace(table_key(database, table), id);
    return id;
  }
  // The id of a table that has a node. The plain id of an object without a node. An edge to such an object is dropped with its scope.
  std::string of(std::string_view database, std::string_view table) const {
    const auto it = by_key_.find(table_key(database, table));
    return it == by_key_.end() ? table_node_id(database, table) : it->second;
  }

 private:
  std::unordered_set<std::string> used_;
  std::unordered_map<std::string, std::string> by_key_;
};

void add_edge_unique(ExplorerGraph& graph, std::unordered_set<std::string>& seen, ExplorerGraphEdge edge) {
  // The string literal "\0" is empty. Use an explicit NUL separator, so that different (from, to, kind) triples cannot collide in the dedup key.
  std::string key;
  key.reserve(edge.from.size() + edge.to.size() + edge.kind.size() + 2);
  key += edge.from;
  key.push_back('\0');
  key += edge.to;
  key.push_back('\0');
  key += edge.kind;
  if (!seen.insert(key).second) return;
  edge.id = "edge:" + std::to_string(graph.edges.size() + 1);
  graph.edges.push_back(std::move(edge));
}

}  // namespace

std::string table_node_id(std::string_view database, std::string_view table) {
  return "table:" + std::string(database) + "." + std::string(table);
}

std::string classify_node(const std::string& engine, const std::string& ddl) {
  if (engine == "MaterializedView") {
    return contains_ci(ddl, "REFRESH EVERY") || contains_ci(ddl, "REFRESH AFTER")
        ? "refreshable_materialized_view"
        : "materialized_view";
  }
  if (engine == "View" || engine == "ParameterizedView") return "view";
  if (engine == "Distributed") return "distributed";
  if (engine == "Buffer") return "buffer";
  if (engine == "Kafka" || engine == "RabbitMQ" || engine == "NATS" || engine == "S3Queue") return "stream_engine";
  if (contains_ci(engine, "Dictionary")) return "dictionary";
  if (engine == "Remote" || engine == "RemoteSecure" || engine == "URL" || engine == "MySQL" || engine == "PostgreSQL") return "external";
  if (contains_ci(engine, "MergeTree")) return "mergetree";
  if (engine == "TinyLog") return "tinylog";
  if (engine == "StripeLog") return "stripelog";
  if (engine == "Log") return "log";
  if (engine == "Memory") return "memory";
  return "table";
}

std::vector<std::string> referenced_clusters(const std::vector<GraphTable>& tables) {
  std::set<std::string> clusters;
  for (const auto& table : tables) {
    if (classify_node(table.engine, table.ddl) != "distributed") continue;
    const auto args = sql::engine_arguments(table.engine_full, "Distributed");
    if (!args.empty()) clusters.insert(args[0]);
  }
  return std::vector<std::string>(clusters.begin(), clusters.end());
}

void build_explorer_graph(const ExplorerGraphInputs& inputs, const AllowedObjectSet& allowed, const ExplorerCatalog& catalog, ExplorerGraph& out) {
  out.nodes.clear();
  out.edges.clear();
  out.definitions.clear();
  out.truncated = false;

  std::unordered_map<std::string, const ExplorerTableSummary*> summary_by_key;
  for (const auto& summary : catalog.tables) {
    summary_by_key.emplace(table_key(summary.database, summary.name), &summary);
  }

  // The tables that the runner reads, in the order of the read.
  std::vector<const GraphTable*> raw;
  for (const auto& table : inputs.tables) {
    if (allowed.allows_table(table.database, table.name)) raw.push_back(&table);
  }

  const auto& disk_info_by_name = inputs.disks;
  const auto& storage_policy_rows = inputs.storage_policies;

  NodeIds ids;
  std::unordered_map<std::string, size_t> logical_node_index;
  std::unordered_map<std::string, std::string> kind_by_key;
  for (const GraphTable* table_ptr : raw) {
    const GraphTable& table = *table_ptr;
    ExplorerGraphNode node;
    node.id = ids.add(table.database, table.name);
    node.kind = classify_node(table.engine, table.ddl);
    node.database = table.database;
    node.name = table.name;
    node.label = table.name;
    node.engine = table.engine;
    node.ttl_rules = parse_table_ttl_rules(table.ddl);
    const auto summary_it = summary_by_key.find(table_key(table.database, table.name));
    if (summary_it != summary_by_key.end()) {
      const auto& summary = *summary_it->second;
      const bool view_like = node.kind == "view" || node.kind == "materialized_view" || node.kind == "refreshable_materialized_view";
      if (!view_like) {
        node.rows = summary.rows;
        node.logical_bytes = summary.logical_bytes;
        node.physical_bytes = summary.physical_bytes;
        node.resident_bytes = summary.resident_bytes;
        node.active_parts = summary.active_parts;
      }
      if (node.kind == "buffer") {
        const auto args = sql::engine_arguments(table.engine_full, "Buffer");
        if (args.size() >= 9) {
          node.buffer_layers = parse_u64(args[2]).value_or(0);
          node.buffer_min_time = parse_u64(args[3]);
          node.buffer_max_time = parse_u64(args[4]);
          node.buffer_min_rows = parse_u64(args[5]);
          node.buffer_max_rows = parse_u64(args[6]);
          node.buffer_min_bytes = parse_u64(args[7]);
          node.buffer_max_bytes = parse_u64(args[8]);
        }
      }
      node.health = summary.health;
      if (summary.replication.available && summary.replication.total_replicas > 0) {
        node.topology_badge = std::to_string(summary.replication.total_replicas) + "R";
      }
    }
    logical_node_index.emplace(node.id, out.nodes.size());
    kind_by_key.emplace(table_key(table.database, table.name), node.kind);
    out.nodes.push_back(std::move(node));
  }

  std::unordered_set<std::string> seen_edges;

  // system.tables gives the materialized views that depend on each current table. Filter both ends before serialization, so a hidden MV
  // cannot leak.
  for (const auto& dependency : inputs.dependencies) {
    const std::string& source_db = dependency.from_database;
    const std::string& source_table = dependency.from_table;
    const std::string& dep_db = dependency.to_database;
    const std::string& dep_table = dependency.to_table;
    if (is_row_pseudo_object(source_table) || is_row_pseudo_object(dep_table)) continue;
    if (!allowed.allows_table(source_db, source_table) || !allowed.allows_table(dep_db, dep_table)) continue;
    const auto kind_it = kind_by_key.find(table_key(dep_db, dep_table));
    std::string kind = "dependency";
    bool animate = false;
    if (kind_it != kind_by_key.end()) {
      if (kind_it->second == "materialized_view") { kind = "materialized_view"; animate = true; }
      else if (kind_it->second == "refreshable_materialized_view") { kind = "refreshable_mv"; animate = true; }
      else if (kind_it->second == "view") kind = "view";
    }
    add_edge_unique(out, seen_edges, {
      {}, ids.of(source_db, source_table), ids.of(dep_db, dep_table), kind,
      kind == "materialized_view" ? "Materialized View trigger" : "dependency", animate
    });
  }

  // A dictionary's source table is structured metadata too (loading_dependencies_*). The source-to-dictionary edge needs no SOURCE()
  // parsing. This is best effort. A server without these columns loses only the dictionary source edges. The rest of the topology stays exact.
  std::unordered_map<std::string, QualifiedName> dictionary_source_by_id;
  for (const auto& entry : inputs.dictionary_sources) {
    if (!allowed.allows_table(entry.dictionary_database, entry.dictionary)) continue;
    const std::string dict_id = ids.of(entry.dictionary_database, entry.dictionary);
    const bool source_visible =
        allowed.allows_table(entry.source_database, entry.source_table) && kind_by_key.count(table_key(entry.source_database, entry.source_table));
    if (!dictionary_source_by_id.count(dict_id)) {
      dictionary_source_by_id.emplace(dict_id, source_visible ? QualifiedName{entry.source_database, entry.source_table} : QualifiedName{});
    }
    if (!source_visible) continue;
    add_edge_unique(out, seen_edges, {
      {}, ids.of(entry.source_database, entry.source_table), dict_id, "dictionary_source", "dictionary source", false
    });
  }

  // Add engine-specific destinations and targeted SELECT dependencies. The SQL parser is limited on purpose to identifiers after
  // FROM/JOIN/TO. Unknown constructs are omitted, not guessed.
  std::set<std::string> referenced;
  for (const GraphTable* table_ptr : raw) {
    const GraphTable& table = *table_ptr;
    const std::string from_id = ids.of(table.database, table.name);
    const std::string kind = classify_node(table.engine, table.ddl);

    const bool view_like = kind == "view" || kind == "materialized_view" || kind == "refreshable_materialized_view";
    if (view_like || kind == "dictionary" || kind == "buffer" || kind == "distributed") {
      auto& definition = out.definitions[from_id];
      if (view_like && !table.as_select.empty()) {
        definition.select_sql_truncated = table.as_select.size() > kDefinitionSqlLimit;
        definition.select_sql = std::string(utf8_prefix(table.as_select, kDefinitionSqlLimit));
      }
      if (kind == "dictionary") {
        if (const auto source = sql::clause_arguments(table.ddl, "SOURCE")) definition.dictionary_source_kind = leading_identifier(*source);
        if (const auto layout = sql::clause_arguments(table.ddl, "LAYOUT")) definition.dictionary_layout = leading_identifier(*layout);
        if (const auto lifetime = sql::clause_arguments(table.ddl, "LIFETIME")) definition.dictionary_lifetime = *lifetime;
        const auto source_it = dictionary_source_by_id.find(from_id);
        if (source_it != dictionary_source_by_id.end() && !source_it->second.table.empty()) {
          definition.target_database = source_it->second.database;
          definition.target_table = source_it->second.table;
          definition.target_visible = true;
        }
      }
    }
    const auto set_definition_target = [&](const std::string& database, const std::string& name) {
      auto& definition = out.definitions[from_id];
      definition.target_visible = allowed.allows_table(database, name);
      // A destination outside the runner's visibility is reported only as "not visible": its name never leaves the backend.
      definition.target_database = definition.target_visible ? database : std::string{};
      definition.target_table = definition.target_visible ? name : std::string{};
    };

    if (kind == "materialized_view" || kind == "refreshable_materialized_view") {
      const auto target = sql::materialized_view_target(table.ddl, table.database);
      if (target) set_definition_target(target->database, target->table);
      if (target && allowed.allows_table(target->database, target->table)) {
        add_edge_unique(out, seen_edges, {
          {}, from_id, ids.of(target->database, target->table),
          kind == "refreshable_materialized_view" ? "refreshable_mv_output" : "materialized_view_output",
          kind == "refreshable_materialized_view" ? "refresh output" : "Materialized View output",
          true
        });
      }
    }

    if (kind == "view" || kind == "refreshable_materialized_view") {
      const std::string& select_sql = !table.as_select.empty() ? table.as_select : table.ddl;
      for (const auto& source : sql::relation_sources(select_sql, table.database)) {
        if (!allowed.allows_table(source.database, source.table)) continue;
        add_edge_unique(out, seen_edges, {
          {}, ids.of(source.database, source.table), from_id,
          kind == "refreshable_materialized_view" ? "refreshable_mv" : "view",
          kind == "refreshable_materialized_view" ? "refresh input" : "logical view",
          kind == "refreshable_materialized_view"
        });
      }
    }

    if (kind == "buffer") {
      const auto args = sql::engine_arguments(table.engine_full, "Buffer");
      if (args.size() >= 2) {
        const std::string dest_db = args[0].empty() ? table.database : args[0];
        const std::string& dest_table = args[1];
        set_definition_target(dest_db, dest_table);
        if (allowed.allows_table(dest_db, dest_table)) {
          add_edge_unique(out, seen_edges, {
            {}, from_id, ids.of(dest_db, dest_table), "buffer", "buffer forwarding", true
          });
        }
      }
    }

    if (kind == "distributed") {
      const auto args = sql::engine_arguments(table.engine_full, "Distributed");
      if (!args.empty()) {
        referenced.insert(args[0]);
        out.definitions[from_id].distributed_cluster = args[0];
      }
      if (args.size() >= 4) out.definitions[from_id].distributed_sharding_key = sql::compact_spaces(args[3]);
      if (args.size() >= 3) {
        const std::string dest_db = args[1].empty() ? table.database : args[1];
        const std::string& dest_table = args[2];
        set_definition_target(dest_db, dest_table);
        if (allowed.allows_table(dest_db, dest_table)) {
          add_edge_unique(out, seen_edges, {
            {}, from_id, ids.of(dest_db, dest_table), "distributed_route", "routes to", false
          });
        }
      }
    }
  }

  // Physical children are part of the same normalized model, but Logical mode ignores them. Storage topology models ClickHouse placement
  // explicitly as: table -> local replica -> storage policy -> ordered volumes -> disks. This keeps logical table dependencies completely
  // out of the physical view. It also makes the hot, warm and cold (including S3) policy order visible, without a guess.
  std::unordered_set<std::string> disk_nodes_created;
  std::unordered_set<std::string> policy_nodes_created;
  std::unordered_set<std::string> volume_nodes_created;

  auto ensure_disk_node = [&](const std::string& database, const std::string& disk) {
    const std::string disk_id = "physical:database:" + database + ":disk:" + disk;
    if (disk_nodes_created.insert(disk_id).second) {
      ExplorerGraphNode disk_node;
      disk_node.id = disk_id;
      disk_node.layer = "physical";
      disk_node.kind = "disk";
      disk_node.database = database;
      disk_node.name = disk;
      disk_node.label = disk;
      disk_node.disk_name = disk;
      if (const auto info_it = disk_info_by_name.find(disk); info_it != disk_info_by_name.end()) {
        const auto& info = info_it->second;
        disk_node.host_name = info.host_name;
        disk_node.disk_path = info.path;
        disk_node.disk_type = info.type;
        disk_node.disk_free_space = info.free_space;
        disk_node.disk_total_space = info.total_space;
      }
      out.nodes.push_back(std::move(disk_node));
    }
    return disk_id;
  };

  for (const GraphTable* table_ptr : raw) {
    const GraphTable& table = *table_ptr;
    const auto summary_it = summary_by_key.find(table_key(table.database, table.name));
    if (summary_it == summary_by_key.end()) continue;
    const auto& summary = *summary_it->second;
    const std::string parent = ids.of(table.database, table.name);

    // View-like and non-persistent engines do not own a physical placement.
    const std::string table_kind = classify_node(table.engine, table.ddl);
    if (table_kind == "view" || table_kind == "materialized_view" ||
        table_kind == "refreshable_materialized_view" || table_kind == "dictionary" ||
        table.engine == "Memory" || table.engine == "Buffer") {
      continue;
    }

    std::string physical_parent = parent;
    if (summary.replication.available) {
      ExplorerGraphNode replica;
      replica.id = "physical:" + parent + ":replica:local";
      replica.layer = "physical";
      replica.parent_id = parent;
      replica.kind = "replica";
      replica.database = table.database;
      replica.name = summary.replication.replica_name.empty() ? "local replica" : summary.replication.replica_name;
      replica.label = replica.name;
      replica.replica_num = 1;
      physical_parent = replica.id;
      out.nodes.push_back(replica);
      add_edge_unique(out, seen_edges, {{}, parent, replica.id, "contains", "local replica", false});
    }

    // Log-family tables have real on-disk storage but no system.parts rows. Resolve their system.tables.data_paths against system.disks
    // instead of classifying them as non-storing objects.
    if (is_log_family(table.engine) && !table.data_paths.empty()) {
      std::unordered_set<std::string> attached;
      for (const auto& path : table.data_paths) {
        const std::string best_disk = disk_of_path(path, [&](auto&& visit) {
          for (const auto& [disk_name, info] : disk_info_by_name) visit(disk_name, info.path);
        });
        if (best_disk.empty() || !attached.insert(best_disk).second) continue;
        const std::string disk_id = ensure_disk_node(table.database, best_disk);
        add_edge_unique(out, seen_edges, {{}, physical_parent, disk_id, "contains", "data path", false});
      }
      if (!attached.empty()) continue;
    }

    const auto policy_it = storage_policy_rows.find(summary.storage_policy);
    if (!summary.storage_policy.empty() && policy_it != storage_policy_rows.end() && !policy_it->second.empty()) {
      const std::string policy_id = "physical:database:" + table.database + ":policy:" + summary.storage_policy;
      if (policy_nodes_created.insert(policy_id).second) {
        ExplorerGraphNode policy_node;
        policy_node.id = policy_id;
        policy_node.layer = "physical";
        policy_node.kind = "storage_policy";
        policy_node.database = table.database;
        policy_node.name = summary.storage_policy;
        policy_node.label = summary.storage_policy;
        policy_node.storage_policy = summary.storage_policy;
        out.nodes.push_back(std::move(policy_node));
      }
      add_edge_unique(out, seen_edges, {{}, physical_parent, policy_id, "storage_policy", "storage policy", false});

      std::string previous_volume_id;
      for (const auto& volume : policy_it->second) {
        const std::string volume_id = policy_id + ":volume:" + std::to_string(volume.priority) + ":" + volume.volume;
        if (volume_nodes_created.insert(volume_id).second) {
          ExplorerGraphNode volume_node;
          volume_node.id = volume_id;
          volume_node.layer = "physical";
          volume_node.kind = "volume";
          volume_node.database = table.database;
          volume_node.name = volume.volume;
          volume_node.label = volume.volume;
          volume_node.storage_policy = summary.storage_policy;
          volume_node.volume_name = volume.volume;
          volume_node.volume_priority = volume.priority;
          volume_node.move_factor = volume.move_factor;
          volume_node.topology_badge = volume.type;
          out.nodes.push_back(std::move(volume_node));
        }

        // A policy is ordered. Draw the first volume from the policy. Then chain each colder tier from the previous volume, not as a star.
        // This makes the SSD to HDD to S3 placement readable. The routing projection stays faithful to ClickHouse volume_priority.
        std::string volume_label = "priority " + std::to_string(volume.priority);
        if (volume.move_factor > 0.0) {
          std::ostringstream factor;
          factor << " · move " << volume.move_factor;
          volume_label += factor.str();
        }
        if (previous_volume_id.empty()) {
          add_edge_unique(out, seen_edges, {{}, policy_id, volume_id, "policy_volume", volume_label, false});
        } else {
          add_edge_unique(out, seen_edges, {{}, previous_volume_id, volume_id, "volume_tier", volume_label, false});
        }
        previous_volume_id = volume_id;

        for (const auto& disk : volume.disks) {
          if (disk.empty()) continue;
          const std::string disk_id = ensure_disk_node(table.database, disk);
          add_edge_unique(out, seen_edges, {{}, volume_id, disk_id, "volume_disk", "disk", false});
        }
      }

      // TTL is temporal metadata attached to the table, not another placement path. It is serialized on the logical root as an ordered
      // timeline, so it cannot distort the storage-policy DAG or create long crossing arrows.
    } else {
      // Engines and policies that do not expose system.storage_policies still get a fallback. The fallback uses the disks that hold
      // active parts now.
      for (const auto& disk : summary.disks) {
        const std::string disk_id = ensure_disk_node(table.database, disk);
        add_edge_unique(out, seen_edges, {{}, physical_parent, disk_id, "contains", "disk", false});
      }
    }
  }

  // Expand the Distributed cluster topology once, in bulk. The cluster rows do not reveal table names. They attach only to
  // Distributed nodes that are already authorized and that reference the cluster. The topology of a cluster is made once and shared.
  // It has a node for each shard and each replica, whatever the number of Distributed tables that name the cluster. It also has an edge
  // from each of those tables to each shard. A cluster whose nodes do not fit the graph (kMaxGraphNodes, kMaxGraphEdges) has no topology.
  // A table whose shard edges do not fit has none. `truncated` says so.
  if (!referenced.empty()) {
    std::map<std::string, std::vector<const GraphTable*>> distributed_by_cluster;
    for (const GraphTable* table : raw) {
      if (classify_node(table->engine, table->ddl) != "distributed") continue;
      const auto args = sql::engine_arguments(table->engine_full, "Distributed");
      if (!args.empty()) distributed_by_cluster[args[0]].push_back(table);
    }

    std::map<std::string, std::vector<const GraphClusterRow*>> cluster_rows;
    for (const auto& row : inputs.clusters) {
      if (referenced.count(row.cluster)) cluster_rows[row.cluster].push_back(&row);
    }

    for (const auto& [cluster, tables] : distributed_by_cluster) {
      const auto rows_it = cluster_rows.find(cluster);
      if (rows_it == cluster_rows.end()) continue;
      uint64_t max_shard = 0;
      std::unordered_map<uint64_t, uint64_t> replicas_per_shard;
      for (const GraphClusterRow* row : rows_it->second) {
        max_shard = std::max(max_shard, row->shard);
        replicas_per_shard[row->shard] = std::max(replicas_per_shard[row->shard], row->replica);
      }
      uint64_t max_replica = 0;
      for (const auto& pair : replicas_per_shard) max_replica = std::max(max_replica, pair.second);
      std::unordered_set<uint64_t> shards;
      for (const GraphClusterRow* row : rows_it->second) shards.insert(row->shard);
      const size_t added = shards.size() + rows_it->second.size();

      // The nodes of the cluster, once each: the shards (in the order of the rows) and their replicas, with the edges between them.
      std::vector<std::string> shard_ids;
      const bool fits = out.nodes.size() + added <= kMaxGraphNodes && out.edges.size() + added <= kMaxGraphEdges;
      if (fits) {
        std::unordered_set<uint64_t> shard_created;
        for (const GraphClusterRow* row_ptr : rows_it->second) {
          const GraphClusterRow& row = *row_ptr;
          const std::string shard_id = "physical:cluster:" + cluster + ":shard:" + std::to_string(row.shard);
          if (shard_created.insert(row.shard).second) {
            ExplorerGraphNode shard;
            shard.id = shard_id;
            shard.layer = "physical";
            shard.kind = "shard";
            shard.name = "shard-" + std::to_string(row.shard);
            shard.label = shard.name;
            shard.shard_num = row.shard;
            out.nodes.push_back(shard);
            shard_ids.push_back(shard_id);
          }
          ExplorerGraphNode replica;
          replica.id = shard_id + ":replica:" + std::to_string(row.replica);
          replica.layer = "physical";
          replica.parent_id = shard_id;
          replica.kind = "replica";
          replica.name = row.host.empty() ? "replica-" + std::to_string(row.replica) : row.host;
          replica.label = replica.name;
          replica.shard_num = row.shard;
          replica.replica_num = row.replica;
          replica.host_name = row.host;
          out.nodes.push_back(replica);
          add_edge_unique(out, seen_edges, {{}, shard_id, replica.id, "contains", "replica", false});
        }
      }

      for (const GraphTable* table : tables) {
        const std::string parent = ids.of(table->database, table->name);
        const auto logical_it = logical_node_index.find(parent);
        if (logical_it != logical_node_index.end() && max_shard > 0) {
          out.nodes[logical_it->second].topology_badge = std::to_string(max_shard) + "S × " + std::to_string(max_replica) + "R";
        }
        auto& definition = out.definitions[parent];
        definition.distributed_shards = max_shard;
        definition.distributed_replicas = max_replica;
        if (!fits || out.edges.size() + shard_ids.size() > kMaxGraphEdges) {
          out.truncated = true;
          continue;
        }
        for (const std::string& shard_id : shard_ids) add_edge_unique(out, seen_edges, {{}, parent, shard_id, "contains", "shard", false});
      }
    }
  }

  out.refreshable_views_available = inputs.refreshable_views_available;
}

}  // namespace explorer
}  // namespace chdash
