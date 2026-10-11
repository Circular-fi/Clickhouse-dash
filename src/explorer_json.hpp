#pragma once

// The JSON of each answer of the Explorer (docs/explorer.md). A writer takes what the service returned and the facts of the request that the answer
// repeats (the host, the database, whether the answer is stale); it writes nothing else and reads no configuration.

#include "explorer_catalog.hpp"
#include "explorer_graph.hpp"
#include "explorer_graph_scope.hpp"

#include <optional>
#include <string>
#include <unordered_set>

namespace chdash {
namespace explorer {

// The sidebar: the databases (with the totals of each) or one database with its tables and disks.
std::string catalog_json(const std::string& host_id, const std::string& database_filter, const ExplorerCatalog& catalog, bool stale);
std::string storage_json(const std::string& host_id, const ExplorerStorageMap& map, bool stale);
std::string table_json(const std::string& host_id, const ExplorerTableDetail& detail, bool stale, uint64_t cache_ttl_ms);
std::string functions_json(const std::string& host_id, const ExplorerFunctionsCatalog& functions, bool stale, bool markdown_links_enabled);
// Null when a cell is not valid typed JSON (the route answers 500 preview_serialization_failed).
std::optional<std::string> preview_json(const std::string& host_id, const std::string& database, const std::string& table, const ExplorerPreview& preview);

// The scope of the request over the graph of the host: `scoped` has the nodes and edges to send; `storage_available` the logical nodes with a placement.
std::string graph_json(const std::string& host_id, const ExplorerGraph& graph, const ExplorerGraph& scoped, const GraphScopeRequest& scope,
                       bool scope_has_more, const std::unordered_set<std::string>& storage_available, bool stale, int live_refresh_ms);
std::string definition_json(const std::string& host_id, const ExplorerGraphNode& node, const ExplorerGraphDefinition& definition, bool stale);

}  // namespace explorer
}  // namespace chdash
