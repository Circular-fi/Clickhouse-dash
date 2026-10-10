#pragma once

// The Traces service: what the routes of the Traces page do, without HTTP. A route (api_traces.cpp) is an adapter: it finds the
// host, parses the request (trace_request.hpp), calls the service with the context of the request, and writes the JSON of the
// answer (trace_json.hpp).
//
// The service owns the order of a read: it takes a connection (a ChExecutor, ch_executor.hpp), finds out which attribute
// columns are Maps, writes the filters as SQL, and runs the strategy of the route (trace_search.hpp) with the SQL builders
// of trace_sql.hpp. It returns the answer as data, or the ApiError that the route sends. The caches that it uses belong to the
// server and arrive at the construction: a test builds the service with a fake executor and its own caches.

#include "ch_executor.hpp"
#include "health_runner.hpp"
#include "request_context.hpp"
#include "trace_analytics.hpp"
#include "trace_attributes.hpp"
#include "trace_result.hpp"
#include "trace_filters.hpp"
#include "trace_request.hpp"
#include "trace_search.hpp"
#include "ttl_cache.hpp"

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <utility>

namespace chdash {
namespace trace {

struct SearchAnswer {
  std::string source_host_id;
  SearchOutcome outcome;
  // With a restricted allowlist a parent may be absent because it is hidden: the count of missing parents would reveal it.
  bool all_services = true;
  uint64_t total_ms = 0;
};

struct AnalyticsAnswer {
  std::string source_host_id;
  AnalyticsOutcome outcome;
  uint64_t total_ms = 0;
};

struct ServiceMapAnswer {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  ServiceMapOutcome outcome;
  double total_ms = 0;
};

struct HeatmapAnswer {
  std::string source_host_id;
  int64_t range_start_ms = 0, range_end_ms = 0, bucket_ms = 0, origin_ms = 0;
  bool has_filters = false;
  HeatmapOutcome run;
  HeatmapBins bins;
  uint64_t total_ms = 0;
};

struct DeltasAnswer {
  std::string source_host_id;
  int64_t t0 = 0, t1 = 0;
  double d0_ms = 0, d1_ms = 0;
  std::string baseline;
  int sample = 0;
  DeltaWindows windows;
  bool window_sampled = false;
  DeltaSamples samples;
  DeltaRanking ranking;
  uint64_t attributes_ms = 0, total_ms = 0;
};

class TraceService {
 public:
  // A connection to the trace source of a host (the system account); null with the reason in *error when there is none.
  using OpenFn = std::function<std::unique_ptr<ChExecutor>(const HostSpec& host, std::string* error)>;

  TraceService(OpenFn open, AttributeMapCache& attribute_maps) : open_(std::move(open)), attribute_maps_(attribute_maps) {}

  // The newest traces of the window that match the filters, with their summaries.
  Result<SearchAnswer> search(const RequestContext& context, const HostSpec& host, const WindowRequest& request, size_t limit) const;

  // The charts: the count of traces and the quantiles of their duration, by bucket.
  Result<AnalyticsAnswer> analytics(const RequestContext& context, const HostSpec& host, const AnalyticsRequest& request) const;
  // The services and the calls between them.
  Result<ServiceMapAnswer> service_map(const RequestContext& context, const HostSpec& host, const ServiceMapRequest& request) const;
  // The traces counted by time bucket and log-scaled duration row.
  Result<HeatmapAnswer> heatmap(const RequestContext& context, const HostSpec& host, const HeatmapRequest& request) const;
  // Which attribute values set the traces of a heatmap box apart.
  Result<DeltasAnswer> deltas(const RequestContext& context, const HostSpec& host, const DeltasRequest& request) const;

 private:
  // A connection, the attribute columns of the table, and the statements' common parts of one request.
  struct OpenedScope {
    std::unique_ptr<ChExecutor> db;
    TraceScope scope;
  };
  Result<OpenedScope> open_scope(const HostSpec& host, const WindowRequest& request) const;
  std::string connect_error(const std::string& reason) const;

  OpenFn open_;
  AttributeMapCache& attribute_maps_;
};

}  // namespace trace
}  // namespace chdash
