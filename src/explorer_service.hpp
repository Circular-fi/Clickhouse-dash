#pragma once

// The Explorer service: what the routes of the Explorer do, without HTTP. A route (api_explorer.cpp) is an adapter: it finds the host, reads the
// parameters, calls the service with the context of the request, and writes the JSON of the answer (explorer_json.hpp).
//
// The service owns the order of a read and its keeping: the privileges of the runner (AclService: the boundary of every name that leaves), the caches
// of the server (the sidebar, the catalog and graph of a host, the card of a table, the functions, the storage map: single-flight, with a stale answer
// served while one refresh runs), the two connections of a read (the system account for the figures, the runner for what only it may see), and the error
// of a failed read. Which statements a read sends is in explorer_sql.hpp and the readers (explorer_catalog.hpp); nothing here is SQL. The caches and the
// ACL belong to the server and arrive at the construction: a test builds the service with fake connections and its own caches.

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

// The detail of a table is kept 30 s: it is request-driven, and nothing refreshes it.
constexpr uint64_t kTableDetailCacheTtlMs = 30 * 1000;

struct ExplorerStores {
  CatalogCache& list;       // the sidebar: the identity of the objects of a database (one entry for each host and database)
  CatalogCache& catalog;    // the catalog of the graph (one entry for each host)
  TableDetailCache& table_detail;
  GraphCache& graph;
  FunctionsCache& functions;
  StorageCache& storage;
};

// What the page shows of a kept answer: the value, and whether it is older than its TTL (a refresh is running).
template <typename T>
struct Cached {
  std::shared_ptr<const T> value;
  bool stale = false;
};

// The graph of a host for a scope.
struct GraphScopeAnswer {
  std::shared_ptr<const ExplorerGraph> graph;
  ExplorerGraph scoped;
  bool scope_has_more = false;
  std::unordered_set<std::string> storage_available;
  bool stale = false;
};

// One logical object of the graph, with what a panel explains about it.
struct DefinitionAnswer {
  std::shared_ptr<const ExplorerGraph> graph;  // keeps `node` and `definition` alive
  const ExplorerGraphNode* node = nullptr;
  const ExplorerGraphDefinition* definition = nullptr;
  bool stale = false;
};

class ExplorerService {
 public:
  // A connection with the account of `uri`; null with the reason in *error when there is none.
  using Connect = std::function<std::unique_ptr<ChExecutor>(const std::string& uri, std::string* error)>;
  // The runner identity of a host for the ACL (acl_service.hpp).
  using AccessOf = std::function<AclAccess(const HostSpec& host)>;

  ExplorerService(Connect connect, AccessOf access_of, AclService& acl, ExplorerCaches& caches, ExplorerStores stores)
      : connect_(std::move(connect)), access_of_(std::move(access_of)), acl_(acl), caches_(caches), stores_(stores) {}

  // The sidebar: the databases with their totals, or (database_filter) the objects of one database with the figures of the list.
  Result<Cached<ExplorerCatalog>> catalog(const RequestContext& context, const HostSpec& host, const std::string& host_id,
                                          const std::string& database_filter, bool refresh) const;
  Result<Cached<ExplorerStorageMap>> storage(const RequestContext& context, const HostSpec& host, const std::string& host_id, bool refresh) const;
  // The card of a table, kept per object.
  Result<Cached<ExplorerTableDetail>> table(const RequestContext& context, const HostSpec& host, const std::string& host_id,
                                            const std::string& database, const std::string& table, bool refresh) const;
  // The functions of the runner (the runner is the boundary: a function that it cannot call is not listed).
  Result<Cached<ExplorerFunctionsCatalog>> functions(const RequestContext& context, const HostSpec& host, const std::string& host_id, bool refresh) const;
  // The first rows of an object that the runner reads, with the columns that it reads.
  Result<ExplorerPreview> preview(const RequestContext& context, const HostSpec& host, const std::string& database, const std::string& table,
                                  size_t limit) const;

  // The graph of the host, cut to a scope. The logical graph (lineage) and the physical one (storage topology) are on or off as configured.
  Result<GraphScopeAnswer> graph(const RequestContext& context, const HostSpec& host, const std::string& host_id, const GraphScopeRequest& scope,
                                 bool lineage_enabled, bool storage_enabled, bool refresh) const;
  // The definition of one logical object of the graph: from the kept graph only, so nothing is read for the caller.
  Result<DefinitionAnswer> definition(const RequestContext& context, const HostSpec& host, const std::string& host_id, const std::string& database,
                                      const std::string& table, bool refresh) const;

 private:
  // The authorized graph of a host: the privileges of the runner, then the catalog and the graph of the objects that it reads.
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
