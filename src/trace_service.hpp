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
#include "trace_detail.hpp"
#include "trace_facets.hpp"
#include "trace_result.hpp"
#include "trace_filters.hpp"
#include "trace_request.hpp"
#include "trace_search.hpp"
#include "trace_services.hpp"
#include "trace_spans.hpp"
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

struct ServicesAnswer {
  std::string source_host_id;
  std::string span_scope, detail;
  int64_t start_ms = 0, end_ms = 0;
  ServicesOutcome outcome;
  uint64_t total_ms = 0;
};
struct ServicesDbAnswer {
  std::string source_host_id;
  std::string detail;
  int64_t start_ms = 0, end_ms = 0;
  DbOutcome outcome;
};

// The caches that the service uses. They belong to the server (a TtlCache is single-flight and bounded); a test builds its own.
struct TraceCaches {
  AttributeMapCache& attribute_maps;
  PrefillCache& prefill;
  FacetKeysCache& facet_keys;
  FacetValuesCache& facet_values;
};

struct MetaAnswer {
  std::string source_host_id;
  TraceSettings traces;
  MetaOutcome outcome;
};

struct PrefillAnswer {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  bool tag_filtered = false;
  uint64_t read_budget = 0;
  std::shared_ptr<const Prefill> value;
};

struct FacetKeysAnswer {
  std::string source_host_id;
  FacetRequest request;
  bool span = false, resource = false;
  bool cached = false;
  std::shared_ptr<const FacetKeys> value;
};
struct FacetValuesAnswer {
  std::string source_host_id;
  FacetRequest request;
  bool cached = false;
  std::shared_ptr<const FacetValues> value;
};

struct TraceDetailAnswer {
  std::string source_host_id, trace_id;
  TraceFeatureSettings features;
  std::vector<DetailSpan> spans;  // the parent of a span that the allowlist hides is already removed
  bool truncated = false;
};
struct SpanAnswer {
  std::string source_host_id;
  TraceFeatureSettings features;
  bool all_services = true;
  std::vector<std::string> values;  // the columns of the row: see kSpanSearchColumns, then the attributes, events and links
};
struct ContextAnswer {
  std::string source_host_id;
  ContextRequest request;
  int64_t lo_ns = 0, hi_ns = 0;
  bool all_services = true;
  ContextOutcome outcome;
};
struct LinkedFromAnswer {
  std::string source_host_id;
  std::string trace_id, span_id;
  std::string range_source;  // "request" or "trace_index"
  int64_t lo_ms = 0, hi_ms = 0;
  int margin_minutes = 0;
  bool truncated = false;
  double elapsed_ms = 0;
  bool all_services = true;
  std::vector<SpanRow> rows;
};

struct SpansAnswer {
  std::string source_host_id;
  SpansRequest request;
  bool all_services = true;
  SpanSearchOutcome outcome;
  double total_ms = 0;
};

class TraceService {
 public:
  // A connection to the trace source of a host (the system account); null with the reason in *error when there is none.
  using OpenFn = std::function<std::unique_ptr<ChExecutor>(const HostSpec& host, std::string* error)>;

  TraceService(OpenFn open, TraceCaches caches)
      : open_(std::move(open)), attribute_maps_(caches.attribute_maps), prefill_(caches.prefill), facet_keys_(caches.facet_keys),
        facet_values_(caches.facet_values) {}

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
  // The RED metrics of the entry spans of each service; with a detail, of each endpoint of that service.
  Result<ServicesAnswer> services(const RequestContext& context, const HostSpec& host, const ServicesRequest& request) const;
  // The database statements that the spans carry.
  Result<ServicesDbAnswer> services_db(const RequestContext& context, const HostSpec& host, const ServicesRequest& request) const;

  // The schema of the source: the columns, the trace index, the attribute maps. Always read fresh; its answer replaces the cached
  // attribute maps.
  Result<MetaAnswer> meta(const RequestContext& context, const HostSpec& host, const std::string& source_host_id) const;
  // The (service, operation) pairs of the pickers, from a cache of minute-aligned windows.
  Result<PrefillAnswer> prefill(const RequestContext& context, const HostSpec& host, const PrefillRequest& request) const;
  // The attribute keys of the spans that match the filters, and the values of one key.
  Result<FacetKeysAnswer> facet_keys(const RequestContext& context, const HostSpec& host, const FacetRequest& request) const;
  Result<FacetValuesAnswer> facet_values(const RequestContext& context, const HostSpec& host, const FacetRequest& request) const;

  // The spans of a trace (the trace index gives its window), one span by its row key, the spans of other traces that link to a trace, and the
  // spans around a time.
  Result<TraceDetailAnswer> trace_detail(const RequestContext& context, const HostSpec& host, const TraceDetailRequest& request) const;
  Result<SpanAnswer> span(const RequestContext& context, const HostSpec& host, const SpanRequest& request) const;
  Result<LinkedFromAnswer> linked_from(const RequestContext& context, const HostSpec& host, const LinkedFromRequest& request) const;
  Result<ContextAnswer> context(const RequestContext& context, const HostSpec& host, const ContextRequest& request) const;
  // The span search: keyset pages over newest-first time slices (trace_spans.hpp).
  Result<SpansAnswer> spans(const RequestContext& context, const HostSpec& host, const SpansRequest& request) const;

 private:
  // A connection, the attribute columns of the table, and the statements' common parts of one request.
  struct OpenedScope {
    std::unique_ptr<ChExecutor> db;
    TraceScope scope;
  };
  Result<OpenedScope> open_scope(const HostSpec& host, const WindowRequest& request) const;
  // The part of the services routes that the two share: a connection, the span filters, the attribute columns, the query.
  struct OpenedServices {
    std::unique_ptr<ChExecutor> db;
    ServicesQuery query;
    AttributeColumns columns;
  };
  Result<OpenedServices> open_services(const HostSpec& host, const ServicesRequest& request) const;
  std::string connect_error(const std::string& reason) const;

  OpenFn open_;
  AttributeMapCache& attribute_maps_;
  PrefillCache& prefill_;
  FacetKeysCache& facet_keys_;
  FacetValuesCache& facet_values_;
};

}  // namespace trace
}  // namespace chdash
