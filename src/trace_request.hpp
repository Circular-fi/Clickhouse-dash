#pragma once

// What the routes of the Traces page read from a request: numbers, windows, filters. Parsing only: nothing here reads
// ClickHouse, and nothing writes an answer. A parser returns false with the message of the 400 answer (the route says which
// code it carries).

#include "error_envelope.hpp"
#include "otel_settings.hpp"
#include "trace_filters.hpp"

#include <httplib.h>

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace trace {

// A number is the whole text of the value ("123abc" is not one): a value that is not a number is the default. A number outside
// the bounds is the nearest bound.
int int_param(const httplib::Request& req, const char* name, int fallback, int lo, int hi);
double double_param(const httplib::Request& req, const char* name, double fallback, double lo, double hi);

// 1: the parameter is a whole number, 0: it is absent or empty, -1: it holds something else.
int parse_i64_param(const httplib::Request& req, const char* name, int64_t* out);

// The non-empty values of a repeated parameter, sorted, without duplicates.
std::vector<std::string> repeated_param_values(const httplib::Request& req, std::string_view name);

// The upper bound of a trace duration filter and of the box of the heatmap: one day, in milliseconds.
constexpr double kMaxDurationMs = 24.0 * 60.0 * 60.0 * 1000.0;

// A filter that traces.features turned off is refused ("service filter is disabled by traces.features").
bool feature_param_rejected(const TraceSettings& cfg, const httplib::Request& req, std::string* message);

// The window of the request: start_ms and end_ms together, or the last lookback_minutes before `now_ms`.
bool trace_time_range(const TraceSettings& cfg, const httplib::Request& req, int64_t now_ms, int64_t* start_ms, int64_t* end_ms,
                      std::string* error);
bool trace_time_range(const TraceSettings& cfg, const httplib::Request& req, int64_t* start_ms, int64_t* end_ms, std::string* error);

bool parse_trace_filters(const httplib::Request& req, TraceFilterSpec* spec, std::string* validation_error);

// What the routes that read a window of spans (search, analytics, service map, heatmap, deltas) take from the request, validated in
// the same order: the window, the span filters and the trace duration bounds (milliseconds, 0 = none).
struct WindowRequest {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  TraceFilterSpec filters;
  double min_duration_ms = 0.0, max_duration_ms = 0.0;
};

struct AnalyticsRequest {
  WindowRequest window;
  int64_t bucket_origin_ms = 0;
  bool align_buckets = false;
  std::string charts;  // "counts", "durations", or empty for both; the service refuses a text that names neither
};
struct ServiceMapRequest {
  WindowRequest window;
  int forced_factor = 0;  // 0: from the size of the window
};
struct HeatmapRequest {
  WindowRequest window;
  int rows = 40;
  int64_t bucket_origin_ms = 0;
  bool align_buckets = false;
};
// The box of a heatmap: the trace starts t0..t1 (epoch ms) and the trace durations d0..d1 (ms); `t0_present` and `t1_present` say
// that the request gave them. The baseline is the traces of the time range outside the box ("outside") or all of them ("all").
struct DeltasRequest {
  WindowRequest window;
  bool t0_present = false, t1_present = false;
  int64_t t0 = 0, t1 = 0;
  double d0_ms = -1.0, d1_ms = -1.0;
  std::string baseline = "outside";
  int sample = 1000;
};
// The services view and its database statements (trace_services.hpp): the window, the span scope ("entry" or "root"), the drilled-down
// service, and the span filters, which describe the entry spans themselves; min / max duration bound the span's own Duration.
struct ServicesRequest {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  std::string span_scope = "entry";
  std::string detail;
  TraceFilterSpec filters;
  double min_duration_ms = 0.0, max_duration_ms = 0.0;
  int64_t bucket_origin_ms = 0;
  bool align_buckets = false;
  bool exact = false;
};

// The service / operation pickers: the window (minute-aligned, so that requests made within the same minute share one cached scan) and
// the tag filters, which are the only filters that narrow the pickers (the service / operation / status choices must stay selectable).
struct PrefillRequest {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  int64_t aligned_start_ms = 0, aligned_end_ms = 0;
  TraceFilterSpec filters;
  uint64_t read_budget = 0;
};

// The attribute facets: the window (minute-aligned like the prefill), the filters, the read bound, and for the values of one key the
// key and the number of values.
struct FacetRequest {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  int64_t aligned_start_ms = 0, aligned_end_ms = 0;
  TraceFilterSpec filters;
  uint64_t read_cap = 0;
  std::string key_scope, key;
  int limit = 10;
};

constexpr int kDeltaDefaultSample = 1000;
constexpr int kDeltaMaxSample = 2500;  // per side: the ids go as parameters, but the sample bounds the work

// ---- the requests of the routes ----

// The window routes: analytics, heatmap and deltas are off with traces.analytics = false (`analytics_required`), the others are not.
// The checks run in this order, and the first that fails is the error: the feature flags, the window, the duration bounds, the
// filters. (The host and traces.enabled are the route's own, which has the configuration.)
bool parse_window(const httplib::Request& req, const TraceSettings& traces, bool analytics_required, WindowRequest* out, ApiError* error);
bool parse_analytics(const httplib::Request& req, const TraceSettings& traces, AnalyticsRequest* out, ApiError* error);
bool parse_service_map(const httplib::Request& req, const TraceSettings& traces, ServiceMapRequest* out, ApiError* error);
bool parse_heatmap(const httplib::Request& req, const TraceSettings& traces, HeatmapRequest* out, ApiError* error);
bool parse_deltas(const httplib::Request& req, const TraceSettings& traces, DeltasRequest* out, ApiError* error);
// The front half of /api/traces/services and /api/traces/services/db (they are off with traces.analytics = false, too).
bool parse_services(const httplib::Request& req, const TraceSettings& traces, ServicesRequest* out, ApiError* error);
bool parse_prefill(const httplib::Request& req, const TraceSettings& traces, PrefillRequest* out, ApiError* error);
// The facets of the keys, and of the values of one key: the key (scope=span|resource, key, limit) is checked before the host, as the
// route always did; the window and the filters after.
bool parse_facet_key(const httplib::Request& req, FacetRequest* out, ApiError* error);
bool parse_facets(const httplib::Request& req, const TraceSettings& traces, FacetRequest* out, ApiError* error);

// columns=span:http.route,resource:host.name,key: attribute values returned with each span (scope "any" reads the span map first).
bool parse_span_columns(const httplib::Request& req, std::vector<SpanAttributeColumn>* out, std::string* error);

// The read bound a request asks for, at most `cap`, rounded down to 1, 2 or 5 times a power of ten: the bound is part of the
// cache key, so the requests share a few keys instead of one per value. read_rows_limit=N lowers the bound of a request (never
// raises it): a cheaper answer, marked estimated when the lower cap stops the scan (the tests force a cap with it).
uint64_t read_rows_limit_param(const httplib::Request& req, uint64_t cap);

}  // namespace trace
}  // namespace chdash
