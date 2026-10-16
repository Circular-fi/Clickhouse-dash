#pragma once

// The Logs service: the functions of the Logs page. The service does not use HTTP.
// A route (api_logs.cpp) is an adapter. It parses the request (logs_request.hpp). It finds the host.
//
// The route calls the service with the context of the request. It writes the JSON of the answer (logs_json.hpp).
//
// The service takes a connection (a ChExecutor, ch_executor.hpp) to the system account of the host.
// It reads the schema of the table (cached). It checks the filters against it (logs_filters.hpp).
// It sends the statements of logs_sql.hpp. It returns the answer as data, or the ApiError that the route sends.
//
// The caches of the service belong to the server. They arrive at the construction, and so do the clocks.
// So a test can give a search a budget that runs out without a wait.

#include "ch_executor.hpp"
#include "health_runner.hpp"
#include "logs_filters.hpp"
#include "logs_patterns.hpp"
#include "logs_request.hpp"
#include "logs_sql.hpp"
#include "otel_caches.hpp"
#include "request_context.hpp"
#include "service_result.hpp"
#include "ttl_cache.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace chdash {
namespace logs {

// A search stops widening its windows when it has spent this much time. It answers with a cursor that continues where it stopped.
constexpr int64_t kSearchBudgetMs = 12000;
// The pattern extraction (Drain) uses the CPU on a thread of the server. It stops after this time.
constexpr int64_t kMiningBudgetMs = 2000;
// Progressive search windows (HyperDX searchWindows). The newest slice comes first.
constexpr int64_t kSearchWindowsSeconds[] = {15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60};
// body_search = "substring" scans Body. Searches use only short windows.
// Histograms and patterns with a text filter are limited to this range.
constexpr int64_t kSubstringWindowSeconds = 15 * 60;
constexpr int64_t kSubstringMaxRangeMs = 6LL * 60 * 60 * 1000;

// ---- the rows ----

struct LogRow {
  int64_t ts_ns = 0;
  uint64_t tie = 0;
  std::string service, severity_text, body, trace_id, span_id, scope_name, scope_version;
  std::string log_attrs, resource_attrs, scope_attrs;  // JSON objects
  int severity_number = 0;
  int64_t body_length = 0;
  int trace_flags = 0;
};

// The outcome of a text search. Every route that has filters reports it in the same way.
struct TextSearchInfo {
  bool active = false;
  std::string mode;
  bool index_backed = false;
};

// ---- the answers ----

struct WindowStat {
  int64_t lo_ns = 0, hi_ns = 0;
  size_t rows = 0;
  int64_t ms = 0;
};

struct SearchAnswer {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  size_t limit = 0;
  std::vector<LogRow> rows;
  std::string next_cursor;  // "" when the range is exhausted
  bool exhausted = false;
  bool budget_exhausted = false;
  int64_t scanned_from_ms = 0;
  TextSearchInfo text_search;
  std::vector<WindowStat> windows;
  int64_t total_ms = 0;
};

struct HistogramBucket {
  int64_t t = 0;
  uint64_t counts[4] = {0, 0, 0, 0};  // error, warn, info, debug
};

struct HistogramAnswer {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  int64_t grid_start_ms = 0, bucket_ms = 0, bucket_origin_ms = 0;
  std::vector<HistogramBucket> buckets;
  uint64_t totals[4] = {0, 0, 0, 0};
  TextSearchInfo text_search;
  int64_t total_ms = 0;
};

struct ContextAnswer {
  std::string source_host_id;
  std::string preset;
  int64_t window_ms = 0;
  int64_t range_start_ms = 0, range_end_ms = 0;
  bool has_anchor = false;
  std::string anchor_id;
  bool anchor_found = false;
  std::vector<LogRow> rows;  // newer first, then the anchor, then older
  size_t before_count = 0, after_count = 0;
  bool more_before = false, more_after = false;
  int64_t total_ms = 0;
};

struct PatternsAnswer {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  uint64_t total = 0;
  size_t sample_size = 0, sample_target = 0;
  std::string sample_method;  // "all" or "block_hash"
  uint64_t sample_rate_ppm = 0;
  MinedPatterns mined;
  int sparkline_buckets = 0;
  double sparkline_bucket_ms = 0;
  TextSearchInfo text_search;
  int64_t count_ms = 0, sample_ms = 0, mine_ms = 0, total_ms = 0;
};

struct ServicesAnswer {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  std::vector<std::pair<std::string, uint64_t>> services;
  int64_t total_ms = 0;
};

// The facets of the Fields panel: the most frequent keys of a sample, and the top values of one key.
// A value keeps at most kFacetMaxKeys + 1 keys. The facets of the Traces page are in trace_facets.hpp.
struct LogFacetKeys {
  struct Key {
    std::string scope, key;
    uint64_t count = 0;
  };
  std::vector<Key> keys;
  uint64_t sampled = 0;
  bool estimated = false;
  bool timed_out = false;
  uint64_t query_ms = 0;
};
struct LogFacetValues {
  std::vector<std::pair<std::string, uint64_t>> values;
  uint64_t with_key = 0;
  uint64_t distinct_values = 0;
  bool estimated = false;
  bool timed_out = false;
  uint64_t query_ms = 0;
};
using FacetKeysCache = TtlCache<std::string, LogFacetKeys>;
using FacetValuesCache = TtlCache<std::string, LogFacetValues>;

struct FacetCommon {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;  // the range of the request
  FacetWindow scanned;               // the aligned range that was scanned
  TextSearchInfo text_search;
  bool cached = false;
};

struct FacetKeysAnswer {
  FacetCommon common;
  std::vector<std::string> scopes;   // the maps of the table that were read
  std::vector<std::string> columns;  // the record columns that were read
  std::shared_ptr<const LogFacetKeys> value;
};

struct FacetValuesAnswer {
  FacetCommon common;
  std::string scope, key;
  int limit = 0;
  std::shared_ptr<const LogFacetValues> value;
};

struct LogsCaches {
  LogsSchemaCache& schema;
  FacetKeysCache& facet_keys;
  FacetValuesCache& facet_values;
};

// The clocks of the service. `steady_ms` measures the budgets.
// `wall_ms` gives the end of a range that names a lookback.
struct LogsClock {
  std::function<int64_t()> steady_ms;
  std::function<int64_t()> wall_ms;
  static LogsClock real();
};

class LogsService {
 public:
  // Return a connection to the logs source of a host (the system account).
  // Return null, with the reason in *error, when there is none.
  using OpenFn = std::function<std::unique_ptr<ChExecutor>(const HostSpec& host, std::string* error)>;

  LogsService(OpenFn open, LogsCaches caches, LogsClock clock = LogsClock::real())
      : open_(std::move(open)), caches_(caches), clock_(std::move(clock)) {}

  // Return the newest rows, one window at a time. The newest slice comes first.
  // The windows widen until the limit is filled or the budget is spent.
  Result<SearchAnswer> search(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                              const SearchRequest& request) const;
  // Return the volume over time, by severity class.
  Result<HistogramAnswer> histogram(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                                    const HistogramRequest& request) const;
  // Return the records around one record.
  Result<ContextAnswer> context(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                                const ContextRequest& request) const;
  // Return the templates that Drain extracts from a bounded sample.
  Result<PatternsAnswer> patterns(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                                  const PatternsRequest& request) const;
  // Return the services with records in the range.
  Result<ServicesAnswer> services(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                                  const ServicesRequest& request) const;
  // Return the field keys of the matching records, and the top values of one field.
  // Each call reads one key (the scan is capped and sampled).
  Result<FacetKeysAnswer> facets(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                                 const FacetsRequest& request) const;
  Result<FacetValuesAnswer> facet_values(const RequestContext& context, const HostSpec& host, const std::string& source_host_id,
                                         const FacetValuesRequest& request) const;

 private:
  // Return the connection, the schema and the name of the table.
  // Return an error when there is no connection, or when the table is not one of the exporter tables.
  struct Opened {
    std::unique_ptr<ChExecutor> db;
    LogsSchema schema;
    std::string table;
  };
  std::optional<ApiError> open(const HostSpec& host, Opened* out) const;
  LogsSchema load_schema(ChExecutor& db, const HostSpec& host) const;

  OpenFn open_;
  LogsCaches caches_;
  LogsClock clock_;
};

}  // namespace logs
}  // namespace chdash
