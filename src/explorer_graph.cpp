// The reads of the Explorer graph, as the system account. The reads cover only the objects of the AllowedObjectSet.
// They cover the disks, the storage policies, the tables with their DDL texts (a cache that re-reads only what changed), the dependencies,
// the sources of the dictionaries, the clusters that Distributed tables name, and whether system.view_refreshes exists.
// The graph itself is made by build_explorer_graph (explorer_graph_build.hpp).
#include "explorer_graph.hpp"

#include "ddl_text_cache.hpp"
#include "explorer_graph_build.hpp"
#include "explorer_graph_scope.hpp"
#include "explorer_rules.hpp"
#include "explorer_sql.hpp"
#include "explorer_values.hpp"
#include "time_util.hpp"

#include <exception>
#include <set>
#include <unordered_map>

namespace chdash {

using namespace explorer;

bool load_explorer_graph(
    ChExecutor& system,
    ExplorerCaches& caches,
    const std::string& system_identity,
    const AllowedObjectSet& allowed,
    const ExplorerCatalog& catalog,
    ExplorerGraph& out,
    std::string* error) {
  out = ExplorerGraph{};
  out.generated_at_ms = static_cast<uint64_t>(now_ms());
  out.metric_scope = catalog.metric_scope;
  out.unavailable_sections = catalog.unavailable_sections;
  out.unavailable_issues = catalog.unavailable_issues;

  ExplorerGraphInputs inputs;

  // Storage policies may reference cold disks. These disks hold no parts for the selected database now. Load system.disks directly, so that
  // the SSD, HDD and S3 destinations still have the host, path, type and capacity metadata in topology.
  std::string disks_error;
  const bool disks_loaded = try_select(system, graph_disks_sql(),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ExplorerDatabaseDisk disk;
        disk.host_name = block_string_at(block, 0, row);
        disk.name = block_string_at(block, 1, row);
        disk.path = block_string_at(block, 2, row);
        disk.type = block_string_at(block, 3, row);
        disk.free_space = parse_u64(block_string_at(block, 4, row));
        disk.total_space = parse_u64(block_string_at(block, 5, row));
        inputs.disks[disk.name] = std::move(disk);
      }
    }, &disks_error);
  if (!disks_loaded) {
    if (!degrade_on_denied("disk", disks_error, out)) {
      if (error) *error = "Disk metadata query failed: " + disks_error;
      return false;
    }
  }

  bool needs_storage_policies = false;
  for (const auto& summary : catalog.tables) {
    if (!summary.storage_policy.empty()) { needs_storage_policies = true; break; }
  }
  if (needs_storage_policies) {
    std::string policy_error;
    const bool policies_loaded = try_select(system, graph_storage_policies_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          GraphStorageVolume value;
          value.policy = block_string_at(block, 0, row);
          value.volume = block_string_at(block, 1, row);
          value.priority = parse_u64(block_string_at(block, 2, row)).value_or(0);
          value.disks = split_unit_separator(block_string_at(block, 3, row));
          value.type = block_string_at(block, 4, row);
          value.max_part_size = parse_u64(block_string_at(block, 5, row)).value_or(0);
          value.move_factor = parse_double(block_string_at(block, 6, row)).value_or(0.0);
          inputs.storage_policies[value.policy].push_back(std::move(value));
        }
      }, &policy_error);
    if (!policies_loaded) {
      if (!degrade_on_denied("storage_policy", policy_error, out)) {
        if (error) *error = "Storage policy metadata query failed: " + policy_error;
        return false;
      }
    }
  }

  std::string last_error;
  // Identity and version columns only. The formatted DDL texts come from DdlTextCache. The cache re-reads them only for objects whose
  // metadata_modification_time changed since the previous graph build.
  std::vector<DdlObjectVersion> versions;
  const bool tables_loaded = try_select(system, graph_tables_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          GraphTable item;
          item.database = block_string_at(block, 0, row);
          item.name = block_string_at(block, 1, row);
          if (!allowed.allows_table(item.database, item.name)) continue;
          item.engine = block_string_at(block, 2, row);
          item.data_paths = split_unit_separator(block_string_at(block, 3, row));
          versions.push_back(DdlObjectVersion{item.database, item.name, block_string_at(block, 4, row),
                                              block_string_at(block, 5, row) == "1"});
          inputs.tables.push_back(std::move(item));
        }
      }, &last_error);
  if (tables_loaded) {
    try {
      const auto texts = caches.ddl_texts.get(system, system_identity, versions);
      for (auto& item : inputs.tables) {
        const auto it = texts.find(DdlTextCache::object_key(item.database, item.name));
        if (it == texts.end()) continue;
        item.engine_full = it->second.engine_full;
        item.ddl = it->second.create_table_query;
        item.as_select = it->second.as_select;
      }
    } catch (const std::exception& e) {
      last_error = std::string("system.tables DDL lookup failed: ") + e.what();
      if (error) *error = last_error;
      return false;
    }
  }
  if (!tables_loaded) {
    if (error) *error = last_error.empty() ? "Unable to load system.tables for graph." : last_error;
    return false;
  }

  // Buffer runtime rows and bytes are already in the catalog baseline of system.tables (`total_rows` and `total_bytes`). ClickHouse
  // 26.7 has no `system.buffers` table. Do not make the graph rendering depend on this version-specific system table.

  // system.tables gives the materialized views that depend on each current table. The builder filters both ends before it serializes them, so
  // a hidden MV cannot leak.
  std::string section_error;
  const bool dependencies_loaded = try_select(system, graph_dependencies_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          inputs.dependencies.push_back(GraphDependency{block_string_at(block, 0, row), block_string_at(block, 1, row),
                                                        block_string_at(block, 2, row), block_string_at(block, 3, row)});
        }
      }, &section_error);
  if (!dependencies_loaded) {
    if (error) *error = "Graph dependency metadata query failed: " + section_error;
    return false;
  }

  // A dictionary's source table is structured metadata too (loading_dependencies_*). This is best effort. A server without these columns loses
  // only the dictionary source edges. The rest of the topology stays exact.
  (void)try_select(system, graph_dictionary_sources_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          inputs.dictionary_sources.push_back(GraphDictionarySource{block_string_at(block, 0, row), block_string_at(block, 1, row),
                                                                    block_string_at(block, 2, row), block_string_at(block, 3, row)});
        }
      });

  // Expand the Distributed cluster topology once, in bulk. The cluster rows do not reveal table names. The builder attaches them only to
  // Distributed nodes that are already authorized and that reference this cluster.
  const auto clusters = referenced_clusters(inputs.tables);
  if (!clusters.empty()) {
    const std::set<std::string> referenced(clusters.begin(), clusters.end());
    section_error.clear();
    const bool clusters_loaded = try_select(system, graph_clusters_sql(),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          const std::string cluster = block_string_at(block, 0, row);
          if (!referenced.count(cluster)) continue;
          inputs.clusters.push_back({cluster, parse_u64(block_string_at(block, 1, row)).value_or(0),
                                     parse_u64(block_string_at(block, 2, row)).value_or(0), block_string_at(block, 3, row)});
        }
      }, &section_error);
    if (!clusters_loaded) {
      if (!degrade_on_denied("distributed_cluster_topology", section_error, out)) {
        if (error) *error = "Distributed cluster topology query failed: " + section_error;
        return false;
      }
    }
  }

  // A missing optional source is a valid structure. A failure to check whether the source exists is an error. Never turn a ClickHouse exception
  // into a fake "unavailable" state.
  section_error.clear();
  bool refresh_table_exists = false;
  const bool refresh_probe_loaded = try_select(system, graph_refresh_probe_sql(),
      [&](const clickhouse::Block& block) {
        if (block.GetRowCount()) refresh_table_exists = truthy(block_string_at(block, 0, 0));
      }, &section_error);
  if (!refresh_probe_loaded) {
    if (!degrade_on_denied("refreshable_view_capability", section_error, out)) {
      if (error) *error = "Refreshable-view capability query failed: " + section_error;
      return false;
    }
  }
  inputs.refreshable_views_available = refresh_table_exists;

  build_explorer_graph(inputs, allowed, catalog, out);
  // The adjacency is made once for the snapshot that every viewer shares.
  out.index = explorer::index_graph(out);
  return true;
}

}  // namespace chdash
