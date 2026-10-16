#pragma once

// This is the service of the System page, without HTTP. It shows what the routes of /api/system/* do after the request is parsed (system_request.hpp).
// A route (api_system.cpp, api_system_activity.cpp) is an adapter. It parses the request.
//
// It finds the host and checks that the host is up. It calls the service with the context of the request.
// It writes the JSON of the answer (system_json.hpp).
//
// The service takes its connections from two ports (a ChExecutor, ch_executor.hpp).
// The system account serves everything that is server-level.
// The runner account serves the Queries. ClickHouse grants decide there, as in the Query page.
//
// A cache that the server owns keeps each answer. The cache lets one read run at a time for each key.
// The capabilities of a server are kept for 10 minutes. The Overview and the Activity are served at once past their TTL, while one read refreshes them.
// The other answers use the same cache.
//
// A failure of a read is the ApiError that the route sends. A connection that failed is not given again.
// A test builds the service with a fake executor, a fake ACL source, and caches of its own.

#include "acl_service.hpp"
#include "ch_executor.hpp"
#include "health_runner.hpp"
#include "request_context.hpp"
#include "service_result.hpp"
#include "system_activity.hpp"
#include "system_disks.hpp"
#include "system_monitor.hpp"
#include "system_overview.hpp"
#include "system_query_format.hpp"
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

// This holds what a read gave. It shows whether the value is older than its TTL.
// The value is served while one read refreshes it.
template <typename T>
struct Cached {
  std::shared_ptr<const T> value;
  bool stale = false;
};

// The caches of the server. server.hpp owns them. A test makes its own caches.
struct SystemCaches {
  TtlCache<std::string, MonitorCapabilities>& capabilities;
  TtlCache<std::string, SystemMonitorOverview>& overview;
  TtlCache<std::string, SystemMonitorSeries>& series;
  TtlCache<std::string, SystemMonitorQueries>& queries;
  TtlCache<std::string, SystemMonitorQuery>& query;
  // The formatted text of a shape, keyed by host and text. The key does not use the window.
  // Every window of a shape has the same text.
  TtlCache<std::string, ShapeFormatted>& shape_format;
  TtlCache<std::string, SystemMonitorDisks>& disks;
  TtlCache<std::string, SystemMonitorDiskGrowth>& growth;
  TtlCache<std::string, SystemActivity>& activity;
  TtlCache<std::string, SystemKeeperStatus>& keeper;
};

class SystemService {
 public:
  // This gives a connection to a host. It returns null, with the reason in *error, when there is no connection.
  using OpenFn = std::function<std::unique_ptr<ChExecutor>(const HostSpec& host, std::string* error)>;

  struct Ports {
    // The system account of the host. When the host has no system account, this is the runner account.
    OpenFn system;
    // The runner account. Its receive timeout is longer than the time budgets of the Queries.
    OpenFn runner;
    // The identity of the runner of a host. It sets the boundary of what the runner may see (acl_service.hpp).
    std::function<AclAccess(const HostSpec&)> runner_access;
    // The total and active replicas of tables. Each table takes one Keeper request. The Explorer keeps the result.
    ReplicaCountsFn replica_counts;
    // The formatter of a host. It uses the runner account of the host, inside the scope of the request.
    // It takes the masked text of a shape, and it gives the formatted text. When it is not set, a shape has no formatted text.
    std::function<ShapeFormatReply(const HostSpec& host, const std::string& masked_sql)> format;
  };

  SystemService(Ports ports, SystemCaches caches, AclService& acl) : ports_(std::move(ports)), caches_(caches), acl_(acl) {}

  // This is what a server exposes: its optional system logs and its versioned columns. It is kept for 10 minutes.
  // It is kept for 1 minute while an optional log table is absent, because ClickHouse creates the table at its first flush.
  // A failed detection is not kept. The panels then read their base columns, and ClickHouse gives the answer.
  std::shared_ptr<const MonitorCapabilities> capabilities(const HostSpec& host) const;

  Result<Cached<SystemMonitorOverview>> overview(const RequestContext& context, const HostSpec& host, const HostRequest& request) const;
  Result<Cached<SystemMonitorSeries>> series(const RequestContext& context, const HostSpec& host, const SeriesRequest& request) const;
  Result<Cached<SystemMonitorDiskGrowth>> disk_growth(const RequestContext& context, const HostSpec& host, const SeriesRequest& request) const;
  Result<Cached<SystemMonitorDisks>> disks(const RequestContext& context, const HostSpec& host, const HostRequest& request) const;
  Result<Cached<SystemMonitorQueries>> queries(const RequestContext& context, const HostSpec& host, const QueriesRequest& request) const;
  Result<Cached<SystemMonitorQuery>> query(const RequestContext& context, const HostSpec& host, const QueryRequest& request) const;
  // The normalized text of a shape, formatted (system_query_format.hpp). It is null when the text cannot be formatted.
  // Examples are a text that the formatter refuses, a text that is too large, and a host that is down.
  // The key holds the host and the text. So a second request of the shape does not ask ClickHouse again.
  // This never fails the route. The answer is then the raw text.
  std::shared_ptr<const std::string> shape_text_formatted(const RequestContext& context, const HostSpec& host, const std::string& normalized) const;
  Result<Cached<SystemActivity>> activity(const RequestContext& context, const HostSpec& host, const HostRequest& request) const;
  Result<Cached<SystemKeeperStatus>> keeper(const RequestContext& context, const HostSpec& host, const HostRequest& request) const;

 private:
  Ports ports_;
  SystemCaches caches_;
  AclService& acl_;
};

// The longest normalized text that is formatted, and the longest formatted text that an answer carries.
constexpr size_t kShapeFormatMaxInputBytes = 64 * 1024;
constexpr size_t kShapeFormatMaxOutputBytes = 256 * 1024;

// The rows that every System page lists: at most this many rows for each kind of the Activity.
constexpr size_t kSystemActivityRowLimit = 200;

}  // namespace system_page
}  // namespace chdash
