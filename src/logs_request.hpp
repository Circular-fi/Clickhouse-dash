#pragma once

// What the routes of the Logs page (/api/logs/search, histogram, context, patterns, services, facets, facet_values) read from a request:
// the filters that they share (the time range, the services, the severity, the trace and span, the attribute filters, the text search)
// and what each route adds. Parsing only, and only what does not need the table: nothing here reads ClickHouse or the schema of the
// table, so a value that a route has to check against the table (a trace id on a table with no TraceId column, a range that must fit
// logs.max_lookback_minutes) stays text or a number here and is checked by logs_filters.hpp once the schema is known. The numbers
// that a route clamps are clamped by the code that knows the bounds.
//
// A parser returns false with the 400 answer in *error only for what no host or table can change (the scope and the key of a facet).

#include "error_envelope.hpp"

#include <httplib.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace chdash {
namespace logs {

// The filters that every route but the context shares. The repeated parameters are sorted and unique.
struct FilterInput {
  std::optional<int64_t> start_ms, end_ms;  // a parameter that is absent or not a number is no value
  std::optional<int64_t> lookback_minutes;
  std::vector<std::string> services;        // service=
  std::string severity_min;                 // as written; "" when absent
  std::vector<std::string> severities;      // severity=
  std::string trace_id, span_id;
  std::vector<std::string> attrs;           // attr=key=value and attr=key!=value
  std::string q;                            // the text search
};

struct SearchRequest {
  FilterInput filter;
  std::optional<int64_t> limit;
  std::string cursor;  // "<timestamp ns>-<tiebreak>"; "" when absent
};

struct HistogramRequest {
  FilterInput filter;
  std::optional<int64_t> buckets;
  std::optional<int64_t> bucket_origin_ms;
};

// The context of one record. The search filters do not apply to it: only the preset narrows it.
struct ContextRequest {
  std::string ts_ns, tie;  // the record: its timestamp and its tiebreak, as written
  std::string preset;      // "" is "anything"
  std::string service, host, trace_id;
  std::optional<int64_t> window_ms, limit;
};

struct PatternsRequest {
  FilterInput filter;
  std::optional<int64_t> sample, buckets, max_patterns;
};

// The picker of the services: the range only, no other filter.
struct ServicesRequest {
  FilterInput filter;
};

struct FacetsRequest {
  FilterInput filter;
};

struct FacetValuesRequest {
  std::string scope;  // log, resource, scope or column
  std::string key;
  std::optional<int64_t> limit;
  FilterInput filter;  // without the filters on the field itself, so its other values stay listed
};

FilterInput parse_filter_input(const httplib::Request& req);
SearchRequest parse_search(const httplib::Request& req);
HistogramRequest parse_histogram(const httplib::Request& req);
ContextRequest parse_context(const httplib::Request& req);
PatternsRequest parse_patterns(const httplib::Request& req);
ServicesRequest parse_services(const httplib::Request& req);
FacetsRequest parse_facets(const httplib::Request& req);
bool parse_facet_values(const httplib::Request& req, FacetValuesRequest* out, ApiError* error);

// The integer parameter `value` clamped to [lo, hi], or `fallback` when it is no number.
int clamp_or(const std::optional<int64_t>& value, int fallback, int lo, int hi);

}  // namespace logs
}  // namespace chdash
