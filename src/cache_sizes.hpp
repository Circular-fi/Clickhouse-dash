#pragma once

#include "explorer_catalog.hpp"
#include "explorer_graph.hpp"
#include "system_activity.hpp"
#include "system_monitor.hpp"

#include <cstddef>
#include <string>
#include <utility>
#include <vector>

// Estimates of the memory of the values that the server caches keep, for their budgets in bytes (TtlCache). They are
// rough on purpose: texts by their size, records by their size plus a fixed share for their small fields.
namespace chdash::cache_size {

inline size_t text(const std::string& value) { return sizeof(std::string) + value.size(); }

template <typename Item, typename Fn>
size_t items(const std::vector<Item>& values, Fn&& each) {
  size_t bytes = sizeof(values);
  for (const auto& value : values) bytes += each(value);
  return bytes;
}

inline size_t texts(const std::vector<std::string>& values) { return items(values, [](const std::string& v) { return text(v); }); }

inline size_t table_summary(const ExplorerTableSummary& table) {
  return sizeof(table) + table.database.size() + table.name.size() + table.engine.size() + table.engine_full.size() +
         table.sorting_key.size() + table.primary_key.size() + table.partition_key.size() + table.sampling_key.size() + 256;
}

inline size_t catalog(const ExplorerCatalog& value) {
  return sizeof(value) + texts(value.databases) +
         items(value.database_summaries, [](const ExplorerDatabaseSummary& d) { return sizeof(d) + d.name.size() + 64 * d.disks.size(); }) +
         items(value.tables, table_summary) + 128 * value.database_disks.size() + texts(value.unavailable_sections) +
         256 * value.unavailable_issues.size();
}

inline size_t graph(const ExplorerGraph& value) {
  size_t bytes = sizeof(value) + 512 * value.nodes.size() + 256 * value.edges.size() + texts(value.unavailable_sections) +
                 256 * value.unavailable_issues.size();
  for (const auto& [id, definition] : value.definitions) {
    bytes += sizeof(definition) + id.size() + definition.select_sql.size() + 256;
  }
  return bytes;
}

inline size_t table_detail(const ExplorerTableDetail& value) {
  return sizeof(value) + table_summary(value.summary) + value.create_table_query.size() + value.table_ttl.size() +
         512 * (value.columns.size() + value.parts.size() + value.partitions.size() + value.indexes_and_projections.size() +
                value.mutations.size() + value.merges.size() + value.dependencies.size() + value.topology.size() +
                value.distribution_queue.size() + value.replication_queue.size() + value.storage.size());
}

inline size_t functions(const ExplorerFunctionsCatalog& value) {
  return items(value.functions, [](const ExplorerFunctionInfo& f) {
    return sizeof(f) + f.name.size() + f.description.size() + f.syntax.size() + f.arguments.size() + f.parameters.size() +
           f.returned_value.size() + f.examples.size() + 128;
  });
}

inline size_t storage(const ExplorerStorageMap& value) {
  return items(value.databases, [](const ExplorerStorageDatabase& d) {
    return sizeof(d) + d.name.size() + items(d.tables, [](const ExplorerStorageTable& t) { return sizeof(t) + t.name.size() + t.engine.size(); });
  });
}

inline size_t activity(const SystemActivity& value) {
  return sizeof(value) + 1024 * (value.merges.size() + value.mutations.size() + value.replication_queue.size() +
                                 value.replicas.size() + value.distribution_queue.size());
}

inline size_t queries(const SystemMonitorQueries& value) {
  return sizeof(value) + 1024 * value.queries.size() + 128 * (value.users.size() + value.databases.size() + value.tables.size());
}

inline size_t query(const SystemMonitorQuery& value) {
  size_t bytes = sizeof(value) + 8 * value.buckets.size() + 512 * value.runs.size();
  for (const auto& [name, points] : value.series) bytes += name.size() + 8 * points.size() + 64;
  return bytes;
}

inline size_t series(const SystemMonitorSeries& value) {
  size_t bytes = sizeof(value) + 8 * value.buckets.size();
  for (const auto& [name, points] : value.series) bytes += name.size() + 8 * points.size() + 64;
  return bytes;
}

inline size_t growth(const SystemMonitorDiskGrowth& value) {
  size_t bytes = sizeof(value) + 8 * value.buckets.size() + 256 * value.disks.size();
  for (const auto& [name, points] : value.series) bytes += name.size() + 8 * points.size() + 64;
  return bytes;
}

inline size_t pairs(const std::vector<std::pair<std::string, std::string>>& values) {
  return items(values, [](const std::pair<std::string, std::string>& p) { return text(p.first) + text(p.second); });
}

inline size_t counted(const std::vector<std::pair<std::string, uint64_t>>& values) {
  return items(values, [](const std::pair<std::string, uint64_t>& p) { return text(p.first) + sizeof(uint64_t); });
}

} // namespace chdash::cache_size
