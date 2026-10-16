#pragma once

// The Explorer service. It holds what the Explorer routes do, without HTTP.
// A route (api_explorer.cpp) is an adapter. It finds the host, reads the parameters, and calls the service with the context of the request.
// Then it writes the JSON of the answer (explorer_json.hpp).
//
// The service owns the order of a read, and the keeping of its results.
// It uses the privileges of the runner (AclService). These privileges are the boundary of every name that leaves.
// It uses the caches of the server: the sidebar, the catalog and graph of a host, the card of a table, the functions and the storage map.
// These caches are single-flight. A stale answer is served while one refresh runs.
//
// A read uses two connections. The system account reads the figures. The runner reads what only it may see.
// The service also owns the error of a failed read.
// The statements of a read are in explorer_sql.hpp and the readers (explorer_catalog.hpp). Nothing here is SQL.
// The server owns the caches and the ACL. They arrive at the construction. A test builds the service with fake connections and its own caches.

#include "acl_service.hpp"
#include "ch_executor.hpp"
#include "explorer_catalog.hpp"
#include "explorer_graph.hpp"
#include "explorer_graph_scope.hpp"
#include "health_runner.hpp"
#include "request_context.hpp"
#include "service_result.hpp"
#include "ttl_cache.hpp"

#include <functional>
#include <memory>
#include <string>
#include <unordered_set>

namespace chdash {
namespace explorer {

using CatalogCache = TtlCache<std::string, ExplorerCatalog>;
using TableDetailCache = TtlCache<std::string, ExplorerTableDetail>;
using GraphCache = TtlCache<std::string, ExplorerGraph>;
using FunctionsCache = TtlCache<std::string, ExplorerFunctionsCatalog>;
using StorageCache = TtlCache<std::string, ExplorerStorageMap>;

// The detail of a table is kept for 30 s. The detail is request-driven. Nothing refreshes it.
constexpr uint64_t kTableDetailCacheTtlMs = 30 * 1000;

struct ExplorerStores {
  CatalogCache& list;       // the sidebar: the identity of the objects of a database (one entry for each host and database)
  CatalogCache& catalog;    // the catalog of the graph (one entry for each host)
  TableDetailCache& table_detail;
  GraphCache& graph;
  FunctionsCache& functions;
  StorageCache& storage;
};

// The page shows two things for a kept answer: the value, and whether it is older than its TTL. A value older than its TTL means that a refresh is in progress.
template <typename T>
struct Cached {
  std::shared_ptr<const T> value;
  bool stale = false;
};

// The graph of a host, for one scope.
struct GraphScopeAnswer {
  std::shared_ptr<const ExplorerGraph> graph;
  ExplorerGraph scoped;
  bool scope_has_more = false;
  std::unordered_set<std::string> storage_available;
  bool stale = false;
};

// One logical object of the graph. It includes what a panel explains about the object.
struct DefinitionAnswer {
  std::shared_ptr<const ExplorerGraph> graph;  // keeps `node` and `definition` alive
  const ExplorerGraphNode* node = nullptr;
  const ExplorerGraphDefinition* definition = nullptr;
  bool stale = false;
};

class ExplorerService {
 public:
  // Connection with the account of `uri`. It is null when there is none. The reason is set in *error.
  using Connect = std::function<std::unique_ptr<ChExecutor>(const std::string& uri, std::string* error)>;
  // The runner identity of a host for the ACL (acl_service.hpp).
  using AccessOf = std::function<AclAccess(const HostSpec& host)>;

  ExplorerService(Connect connect, AccessOf access_of, AclService& acl, ExplorerCaches& caches, ExplorerStores stores)
      : connect_(std::move(connect)), access_of_(std::move(access_of)), acl_(acl), caches_(caches), stores_(stores) {}

  // The sidebar. It holds the databases with their totals. With database_filter, it holds the objects of one database with the figures of the list.
  Result<Cached<ExplorerCatalog>> catalog(const RequestContext& context, const HostSpec& host, const std::string& host_id,
                                          const std::string& database_filter, bool refresh) const;
  Result<Cached<ExplorerStorageMap>> storage(const RequestContext& context, const HostSpec& host, const std::string& host_id, bool refresh) const;
  // The card of a table, kept per object.
  Result<Cached<ExplorerTableDetail>> table(const RequestContext& context, const HostSpec& host, const std::string& host_id,
                                            const std::string& database, const std::string& table, bool refresh) const;
  // The functions of the runner. The runner is the boundary. A function that the runner cannot call is not listed.
  Result<Cached<ExplorerFunctionsCatalog>> functions(const RequestContext& context, const HostSpec& host, const std::string& host_id, bool refresh) const;
  // The first rows of an object that the runner reads, with the columns that it reads.
  Result<ExplorerPreview> preview(const RequestContext& context, const HostSpec& host, const std::string& database, const std::string& table,
                                  size_t limit) const;

  // The graph of the host, cut to a scope. The logical graph (lineage) and the physical graph (storage topology) are on or off, as configured.
  Result<GraphScopeAnswer> graph(const RequestContext& context, const HostSpec& host, const std::string& host_id, const GraphScopeRequest& scope,
                                 bool lineage_enabled, bool storage_enabled, bool refresh) const;
  // The definition of one logical object of the graph. It uses only the kept graph, so nothing is read for the caller.
  Result<DefinitionAnswer> definition(const RequestContext& context, const HostSpec& host, const std::string& host_id, const std::string& database,
                                      const std::string& table, bool refresh) const;

 private:
  // The authorized graph of a host. It first uses the privileges of the runner.
  // Then it uses the catalog and the graph of the objects that the runner reads.
  struct Snapshot {
    std::shared_ptr<const ExplorerGraph> graph;
    bool stale = false;
  };
  Result<Snapshot> graph_snapshot(const HostSpec& host, const std::string& host_id, bool refresh) const;

  Connect connect_;
  AccessOf access_of_;
  AclService& acl_;
  ExplorerCaches& caches_;
  ExplorerStores stores_;
};

}  // namespace explorer
}  // namespace chdash
