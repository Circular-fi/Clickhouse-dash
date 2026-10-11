#pragma once

// The System page without HTTP: what the routes of /api/system/* do once the request is parsed (system_request.hpp). A route (api_system.cpp,
// api_system_activity.cpp) is an adapter: it parses the request, finds the host and checks that it is up, calls the service with the context of
// the request, and writes the JSON of the answer (system_json.hpp).
//
// The service takes its connections from two ports (a ChExecutor, ch_executor.hpp): the system account, for everything that is server-level,
// and the runner account, for the Queries (ClickHouse grants decide there, as in the Query page). Each answer is kept by a cache that the server
// owns, one read at a time for a key: the capabilities of a server (10 minutes), the Overview and the Activity (served at once past their
// TTL while one read refreshes them), and the others. A failure of a read is the ApiError that the route sends, and a connection that failed
// is not lent again. A test builds the service with a fake executor, a fake ACL source and caches of its own.

#include "acl_service.hpp"
#include "ch_executor.hpp"
#include "health_runner.hpp"
#include "request_context.hpp"
#include "service_result.hpp"
#include "system_activity.hpp"
#include "system_disks.hpp"
#include "system_monitor.hpp"
#include "system_overview.hpp"
#include "system_queries.hpp"
#include "system_request.hpp"
#include "system_series.hpp"
#include "system_settings.hpp"
#include "ttl_cache.hpp"

#include <functional>
#include <memory>
#include <string>

namespace chdash {
namespace system_page {

// What a read gave and whether it is older than its TTL (served while one read refreshes it).
template <typename T>
struct Cached {
  std::shared_ptr<const T> value;
  bool stale = false;
};

// The caches of the server (server.hpp owns them: a test makes its own).
struct SystemCaches {
  TtlCache<std::string, MonitorCapabilities>& capabilities;
  TtlCache<std::string, SystemMonitorOverview>& overview;
  TtlCache<std::string, SystemMonitorSeries>& series;
  TtlCache<std::string, SystemMonitorQueries>& queries;
  TtlCache<std::string, SystemMonitorQuery>& query;
  TtlCache<std::string, SystemMonitorDisks>& disks;
  TtlCache<std::string, SystemMonitorDiskGrowth>& growth;
  TtlCache<std::string, SystemActivity>& activity;
  TtlCache<std::string, SystemKeeperStatus>& keeper;
};

class SystemService {
 public:
  // A connection to a host; null with the reason in *error when there is none.
  using OpenFn = std::function<std::unique_ptr<ChExecutor>(const HostSpec& host, std::string* error)>;

  struct Ports {
    // The system account of the host (its runner account when it has no system account).
    OpenFn system;
    // The runner account, with a receive timeout that outlasts the time budgets of the Queries.
    OpenFn runner;
    // The identity of the runner of a host, for the boundary of what it may see (acl_service.hpp).
    std::function<AclAccess(const HostSpec&)> runner_access;
    // The total and active replicas of tables (one Keeper request for each, kept by the Explorer).
    ReplicaCountsFn replica_counts;
  };

  SystemService(Ports ports, SystemCaches caches, AclService& acl, const SystemSettings& settings)
      : ports_(std::move(ports)), caches_(caches), acl_(acl), settings_(settings) {}

  // What a server exposes (its optional system logs and versioned columns): kept 10 minutes, 1 minute while an optional log table is missing
  // (ClickHouse creates it at its first flush). A failed detection is not kept: the panels then read their base columns and let ClickHouse answer.
  std::shared_ptr<const MonitorCapabilities> capabilities(const HostSpec& host) const;

  Result<Cached<SystemMonitorOverview>> overview(const RequestContext& context, const HostSpec& host, const HostRequest& request) const;
  Result<Cached<SystemMonitorSeries>> series(const RequestContext& context, const HostSpec& host, const SeriesRequest& request) const;
  Result<Cached<SystemMonitorDiskGrowth>> disk_growth(const RequestContext& context, const HostSpec& host, const SeriesRequest& request) const;
  Result<Cached<SystemMonitorDisks>> disks(const RequestContext& context, const HostSpec& host, const HostRequest& request) const;
  Result<Cached<SystemMonitorQueries>> queries(const RequestContext& context, const HostSpec& host, const QueriesRequest& request) const;
  Result<Cached<SystemMonitorQuery>> query(const RequestContext& context, const HostSpec& host, const QueryRequest& request) const;
  Result<Cached<SystemActivity>> activity(const RequestContext& context, const HostSpec& host, const HostRequest& request) const;
  Result<Cached<SystemKeeperStatus>> keeper(const RequestContext& context, const HostSpec& host, const HostRequest& request) const;

 private:
  Ports ports_;
  SystemCaches caches_;
  AclService& acl_;
  const SystemSettings& settings_;
};

// The rows that every System page lists: at most this many rows for each kind of the Activity.
constexpr size_t kSystemActivityRowLimit = 200;

}  // namespace system_page
}  // namespace chdash
