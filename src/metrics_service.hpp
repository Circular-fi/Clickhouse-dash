#pragma once

// The Metrics service: what the routes of the Metrics page do, without HTTP. A route (api_metrics.cpp) is an adapter: it parses the
// request (metrics_request.hpp), finds the host, calls the service with the context of the request, and writes the JSON of the answer
// (metrics_json.hpp).
//
// The service takes a connection (a ChExecutor, ch_executor.hpp), checks that the table of the kind exists and may be read, sends the
// statements of metrics_sql.hpp, folds the rows with metrics_aggregate.hpp, and returns the answer as data, or the ApiError that the route
// sends. The caches that it uses belong to the server and arrive at the construction: a test builds the service with a fake executor and
// its own caches.

#include "ch_executor.hpp"
#include "health_runner.hpp"
#include "metrics_aggregate.hpp"
#include "metrics_request.hpp"
#include "metrics_sql.hpp"
#include "otel_caches.hpp"
#include "request_context.hpp"
#include "service_result.hpp"
#include "ttl_cache.hpp"

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace chdash {
namespace metrics {

// ---- the catalog ----

struct CatalogEntry {
  std::string kind, metric, unit, description, temporality;
  int monotonic = -1;  // -1: not a sum
  int64_t points = 0;
};

// What the catalog of a window holds. It is what the cache keeps: each answer reports its own timing and cache status.
struct CatalogSnapshot {
  std::string source_host_id;
  TimeWindow window;
  std::map<std::string, std::vector<CatalogEntry>> services;
  size_t rows = 0;
  bool truncated = false;
  bool estimated = false;
  std::set<std::string> kinds;  // the kind tables that exist
  std::string missing_message;  // set when no kind table exists
  int64_t query_ms = 0;
};
using CatalogCache = TtlCache<std::string, CatalogSnapshot>;

// The memory of a snapshot, for the budget of the cache.
size_t snapshot_bytes(const CatalogSnapshot& snapshot);

struct CatalogAnswer {
  std::shared_ptr<const CatalogSnapshot> snapshot;
  bool hit = false;
  int64_t age_ms = 0;
  int64_t query_ms = 0;  // what this request spent reading: 0 for a hit
  int64_t total_ms = 0;
};

// ---- the other routes ----

struct AttributesAnswer {
  std::string kind, service, metric;
  std::string key;  // empty: `keys` holds the keys; else `values` holds the values of this key
  std::vector<std::string> keys;
  std::vector<std::pair<std::string, int64_t>> values;
  bool truncated = false;
  int64_t query_ms = 0, total_ms = 0;
};

struct SeriesAnswer {
  std::string source_host_id;
  SeriesRequest request;
  MetricInfo info;
  AggregationPlan plan;
  std::string value_unit;
  std::vector<int64_t> timestamps;
  std::vector<Group> series;  // the groups that are kept, best first
  Group other;                // the others, folded (only when other_count > 0)
  size_t other_count = 0;
  size_t group_count = 0;
  bool truncated_rows = false;
  int64_t query_ms = 0, total_ms = 0;
};

struct ExemplarRow {
  int64_t t = 0;
  double value = 0;
  std::string trace_id, span_id, attributes_json;
};

struct ExemplarsAnswer {
  std::string source_host_id;
  ExemplarsRequest request;
  std::vector<ExemplarRow> exemplars;  // oldest first
  bool truncated = false;
  bool traces_enabled = false;
  int64_t query_ms = 0, total_ms = 0;
};

struct MetricsCaches {
  CatalogCache& catalog;
  KindTablesCache& kinds;
};

class MetricsService {
 public:
  // A connection to the metrics source of a host (the system account); null with the reason in *error when there is none.
  using OpenFn = std::function<std::unique_ptr<ChExecutor>(const HostSpec& host, std::string* error)>;

  MetricsService(OpenFn open, MetricsCaches caches) : open_(std::move(open)), catalog_(caches.catalog), kinds_(caches.kinds) {}

  // The metrics of the window, by service. One read of a key at a time: a second viewer of the same window waits for it.
  Result<CatalogAnswer> catalog(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                                const CatalogRequest& request) const;
  // The attribute keys of a metric, or the values of one key.
  Result<AttributesAnswer> attributes(const RequestContext& context, const HostSpec& host, const AttributesRequest& request) const;
  // The values of a metric by bucket and group, top-K and "other".
  Result<SeriesAnswer> series(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                              const SeriesRequest& request) const;
  // The exemplars (a point of a histogram or a sum that names a trace).
  Result<ExemplarsAnswer> exemplars(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                                    const ExemplarsRequest& request) const;

 private:
  // The kind tables of the source that exist: one system.tables read, kept like the catalog.
  std::set<std::string> existing_kinds(ChExecutor& db, const HostSpec& host) const;
  // An error when the table of `kind` does not exist or the system user may not read it.
  std::optional<ApiError> check_kind_table(ChExecutor& db, const HostSpec& host, const std::string& kind) const;
  std::string connect_error(const std::string& reason) const;

  OpenFn open_;
  CatalogCache& catalog_;
  KindTablesCache& kinds_;
};

}  // namespace metrics
}  // namespace chdash
