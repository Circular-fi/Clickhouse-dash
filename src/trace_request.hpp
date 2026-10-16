#pragma once

// This header defines how the routes of the Traces page read a request: numbers, windows and filters. The code only parses the
// request. Nothing in this header reads ClickHouse, and nothing writes an answer. A parser returns false with the message of the
// 400 answer. The route states which code the answer carries.

#include "error_envelope.hpp"
#include "otel_settings.hpp"
#include "trace_filters.hpp"
#include "trace_spans.hpp"

#include <httplib.h>

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace trace {

// A number is the whole text of the value. For example, "123abc" is not a number. A value that is not a number gets the default.
// A number outside the bounds is replaced by the nearest bound.
int int_param(const httplib::Request& req, const char* name, int fallback, int lo, int hi);
double double_param(const httplib::Request& req, const char* name, double fallback, double lo, double hi);

// The result is 1 when the parameter is a whole number. The result is 0 when the parameter is absent or empty. The result is -1
// when the parameter holds another value.
int parse_i64_param(const httplib::Request& req, const char* name, int64_t* out);

// This function returns the non-empty values of a repeated parameter. The values are sorted and have no duplicates.
std::vector<std::string> repeated_param_values(const httplib::Request& req, std::string_view name);

// The upper bound of a trace duration filter and of the heatmap box is one day, in milliseconds.
constexpr double kMaxDurationMs = 24.0 * 60.0 * 60.0 * 1000.0;

// A filter that traces.features disables is refused. The error message is "service filter is disabled by traces.features".
bool feature_param_rejected(const TraceSettings& cfg, const httplib::Request& req, std::string* message);

// The window of the request uses start_ms and end_ms together. Otherwise, it uses the last lookback_minutes before `now_ms`.
bool trace_time_range(const TraceSettings& cfg, const httplib::Request& req, int64_t now_ms, int64_t* start_ms, int64_t* end_ms,
                      std::string* error);
bool trace_time_range(const TraceSettings& cfg, const httplib::Request& req, int64_t* start_ms, int64_t* end_ms, std::string* error);

bool parse_trace_filters(const httplib::Request& req, TraceFilterSpec* spec, std::string* validation_error);

// This function reads what the routes take from the request. These routes read a window of spans: search, analytics, service map,
// heatmap and deltas. The values are validated in the same order: the window, the span filters and the trace duration bounds. The
// duration bounds are in milliseconds, and a value of 0 means none.
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
// The box of a heatmap sets the trace starts t0..t1 (epoch ms) and the trace durations d0..d1 (ms). The fields `t0_present` and
// `t1_present` show that the request gave these values. The baseline is the traces of the time range outside the box ("outside").
// It can also be all of the traces ("all").
struct DeltasRequest {
  WindowRequest window;
  bool t0_present = false, t1_present = false;
  int64_t t0 = 0, t1 = 0;
  double d0_ms = -1.0, d1_ms = -1.0;
  std::string baseline = "outside";
  int sample = 1000;
};
// The services view and its database statements (trace_services.hpp) read these values: the window, the span scope ("entry" or
// "root"), the drilled-down service, and the span filters. The span filters describe the entry spans themselves. The min and max
// duration bound the Duration of the span itself.
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

// The service and operation pickers read these values: the window and the tag filters. The window is minute-aligned, so that
// requests made in the same minute share one cached scan. The tag filters are the only filters that narrow the pickers. The
// service, operation and status choices must stay selectable.
struct PrefillRequest {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  int64_t aligned_start_ms = 0, aligned_end_ms = 0;
  TraceFilterSpec filters;
  uint64_t read_budget = 0;
};

// The attribute facets read these values: the window, the filters and the read bound. The window is minute-aligned, like the
// prefill. For the values of one key, the request also gives the key and the number of values.
struct FacetRequest {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  int64_t aligned_start_ms = 0, aligned_end_ms = 0;
  TraceFilterSpec filters;
  uint64_t read_cap = 0;
  std::string key_scope, key;
  int limit = 10;
};

// These routes read one trace, one span by its key, the spans of other traces that link to a trace, and the spans around a time.
struct TraceDetailRequest {
  std::string source_host_id;
  std::string trace_id;
};
struct SpanRequest {
  std::string source_host_id;
  std::string trace_id, span_id;
  int64_t timestamp_ns = 0;
};
struct LinkedFromRequest {
  std::string source_host_id;
  std::string trace_id, span_id;
  bool has_range = false;  // start_ms and end_ms were given; else the trace index gives the window of the trace
  int64_t start_ms = 0, end_ms = 0;
};
// The service validates the filter of a context after the connection is open. The raw parameters are `service`, `value` and
// `attr_*`.
struct ContextRequest {
  std::string source_host_id;
  int64_t anchor_ns = 0, window_ms = 60000;
  std::string filter = "any", direction = "around";
  int limit = 50;
  int64_t cursor_ns = 0;
  std::string cursor_span;
  std::string service, value, attr_scope, attr_key, attr_value;
};

// The span search reads these values: the window, the page size and the widening budget. It also reads the span filters. Each
// span must match all of them. The duration bounds apply to the span itself. The span search also reads the kinds, the attribute
// columns to return with each span, and the cursor of the page.
struct SpansRequest {
  std::string source_host_id;
  int64_t start_ms = 0, end_ms = 0;
  int limit = kSpanPageDefaultLimit;
  double budget_ms = kSpanPageBudgetMs;
  double min_duration_ms = 0.0, max_duration_ms = 0.0;
  TraceFilterSpec filters;
  std::vector<std::string> kinds;
  std::vector<SpanAttributeColumn> columns;
  SpanCursor cursor;
};

constexpr int kDeltaDefaultSample = 1000;
constexpr int kDeltaMaxSample = 2500;  // per side: the ids go as parameters, but the sample bounds the work

// ---- the requests of the routes ----

// The window routes are analytics, heatmap and deltas. These three routes are off when traces.analytics = false
// (`analytics_required`). The other routes are not off by this flag. The checks run in this order. The first check that fails
// gives the error: the feature flags, the window, the duration bounds and the filters.
//
// The host and traces.enabled belong to the route. The route reads them from the configuration.
bool parse_window(const httplib::Request& req, const TraceSettings& traces, bool analytics_required, WindowRequest* out, ApiError* error);
bool parse_analytics(const httplib::Request& req, const TraceSettings& traces, AnalyticsRequest* out, ApiError* error);
bool parse_service_map(const httplib::Request& req, const TraceSettings& traces, ServiceMapRequest* out, ApiError* error);
bool parse_heatmap(const httplib::Request& req, const TraceSettings& traces, HeatmapRequest* out, ApiError* error);
bool parse_deltas(const httplib::Request& req, const TraceSettings& traces, DeltasRequest* out, ApiError* error);
// This part is the front half of /api/traces/services and /api/traces/services/db. These two routes are also off when
// traces.analytics = false.
bool parse_services(const httplib::Request& req, const TraceSettings& traces, ServicesRequest* out, ApiError* error);
bool parse_prefill(const httplib::Request& req, const TraceSettings& traces, PrefillRequest* out, ApiError* error);
bool parse_spans(const httplib::Request& req, const TraceSettings& traces, SpansRequest* out, ApiError* error);
// These four checks run on the request before the host is looked up. The routes always did this.
bool parse_trace_detail(const httplib::Request& req, TraceDetailRequest* out, ApiError* error);
bool parse_span(const httplib::Request& req, SpanRequest* out, ApiError* error);
bool parse_linked_from(const httplib::Request& req, LinkedFromRequest* out, ApiError* error);
bool parse_context(const httplib::Request& req, ContextRequest* out, ApiError* error);
// The facets read the keys, and the values of one key. The key (scope=span|resource, key, limit) is checked before the host, as
// the route always did. The window and the filters are checked after the host.
bool parse_facet_key(const httplib::Request& req, FacetRequest* out, ApiError* error);
bool parse_facets(const httplib::Request& req, const TraceSettings& traces, FacetRequest* out, ApiError* error);

// The parameter columns=span:http.route,resource:host.name,key gives the attribute values that are returned with each span. The
// scope "any" reads the span map first.
bool parse_span_columns(const httplib::Request& req, std::vector<SpanAttributeColumn>* out, std::string* error);

// The read bound that a request asks for is at most `cap`. It is rounded down to 1, 2 or 5 times a power of ten. The bound is
// part of the cache key. Therefore the requests share a few keys, not one key for each value.
//
// The parameter read_rows_limit=N lowers the bound of a request. It never raises the bound. A lower cap gives a cheaper answer.
// The answer is marked estimated when the lower cap stops the scan. The tests force a cap with this parameter.
uint64_t read_rows_limit_param(const httplib::Request& req, uint64_t cap);

}  // namespace trace
}  // namespace chdash
