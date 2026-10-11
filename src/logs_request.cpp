#include "logs_request.hpp"

#include "api_params.hpp"
#include "facet_limits.hpp"
#include "service_result.hpp"

#include <algorithm>
#include <iterator>

namespace chdash {
namespace logs {

namespace {

std::string param(const httplib::Request& req, const char* name) {
  return req.has_param(name) ? req.get_param_value(name) : std::string{};
}

std::optional<int64_t> int_param(const httplib::Request& req, const char* name) { return parse_whole_i64(param(req, name)); }

std::vector<std::string> repeated(const httplib::Request& req, const char* name) {
  std::vector<std::string> values;
  const auto range = req.params.equal_range(name);
  for (auto it = range.first; it != range.second; ++it) {
    if (!it->second.empty()) values.push_back(it->second);
  }
  std::sort(values.begin(), values.end());
  values.erase(std::unique(values.begin(), values.end()), values.end());
  return values;
}

// The key of an attr filter ("k=v" / "k!=v"), or "" when malformed.
std::string attr_filter_key(const std::string& raw) {
  const size_t eq = raw.find('=');
  if (eq == std::string::npos || eq == 0) return {};
  return raw.substr(0, raw[eq - 1] == '!' ? eq - 1 : eq);
}

const char* const kTopLevelColumns[] = {"ServiceName", "SeverityText", "TraceId", "SpanId", "ScopeName", "ScopeVersion"};

bool top_level_column(const std::string& key) {
  return std::any_of(std::begin(kTopLevelColumns), std::end(kTopLevelColumns), [&](const char* c) { return key == c; });
}

const char* facet_map_name(const std::string& scope) {
  if (scope == "log") return "LogAttributes";
  if (scope == "resource") return "ResourceAttributes";
  if (scope == "scope") return "ScopeAttributes";
  return nullptr;
}

// The filters on the field (scope, key) itself leave the request, so the values of the field ignore its own filters: its other values stay
// listed (and can be added). A bare key filters both LogAttributes and ResourceAttributes, so it counts as either map's own filter.
void drop_own_filters(FilterInput* filter, const std::string& scope, const std::string& key) {
  if (scope == "column" && key == "ServiceName") filter->services.clear();
  const char* map = facet_map_name(scope);
  std::vector<std::string> kept;
  for (const auto& raw : filter->attrs) {
    const std::string k = attr_filter_key(raw);
    const bool own = scope == "column" ? k == key : k == std::string(map) + "." + key || (k == key && scope != "scope" && !top_level_column(k));
    if (!own) kept.push_back(raw);
  }
  filter->attrs = std::move(kept);
}

}  // namespace

int clamp_or(const std::optional<int64_t>& value, int fallback, int lo, int hi) {
  if (!value) return fallback;
  return static_cast<int>(std::max<int64_t>(lo, std::min<int64_t>(hi, *value)));
}

FilterInput parse_filter_input(const httplib::Request& req) {
  FilterInput f;
  f.start_ms = int_param(req, "start_ms");
  f.end_ms = int_param(req, "end_ms");
  f.lookback_minutes = int_param(req, "lookback_minutes");
  f.services = repeated(req, "service");
  f.severity_min = param(req, "severity_min");
  f.severities = repeated(req, "severity");
  f.trace_id = param(req, "trace_id");
  f.span_id = param(req, "span_id");
  f.attrs = repeated(req, "attr");
  f.q = param(req, "q");
  return f;
}

SearchRequest parse_search(const httplib::Request& req) {
  SearchRequest out;
  out.filter = parse_filter_input(req);
  out.limit = int_param(req, "limit");
  out.cursor = param(req, "cursor");
  return out;
}

HistogramRequest parse_histogram(const httplib::Request& req) {
  HistogramRequest out;
  out.filter = parse_filter_input(req);
  out.buckets = int_param(req, "buckets");
  out.bucket_origin_ms = int_param(req, "bucket_origin_ms");
  return out;
}

ContextRequest parse_context(const httplib::Request& req) {
  ContextRequest out;
  out.ts_ns = param(req, "ts_ns");
  out.tie = param(req, "tie");
  out.preset = param(req, "preset");
  out.service = param(req, "service");
  out.host = param(req, "host");
  out.trace_id = param(req, "trace_id");
  out.window_ms = int_param(req, "window_ms");
  out.limit = int_param(req, "limit");
  return out;
}

PatternsRequest parse_patterns(const httplib::Request& req) {
  PatternsRequest out;
  out.filter = parse_filter_input(req);
  out.sample = int_param(req, "sample");
  out.buckets = int_param(req, "buckets");
  out.max_patterns = int_param(req, "max_patterns");
  return out;
}

ServicesRequest parse_services(const httplib::Request& req) {
  ServicesRequest out;
  out.filter.start_ms = int_param(req, "start_ms");
  out.filter.end_ms = int_param(req, "end_ms");
  out.filter.lookback_minutes = int_param(req, "lookback_minutes");
  return out;
}

FacetsRequest parse_facets(const httplib::Request& req) {
  FacetsRequest out;
  out.filter = parse_filter_input(req);
  return out;
}

bool parse_facet_values(const httplib::Request& req, FacetValuesRequest* out, ApiError* error) {
  FacetValuesRequest request;
  request.scope = param(req, "scope");
  request.key = param(req, "key");
  const auto bad = [&](std::string message) {
    *error = make_error(400, "invalid_logs_facet", std::move(message));
    return false;
  };
  if (request.scope != "log" && request.scope != "resource" && request.scope != "scope" && request.scope != "column") {
    return bad("scope must be log, resource, scope or column.");
  }
  if (request.key.empty() || request.key.size() > kFacetMaxKeyBytes) return bad("key must be 1 to 512 bytes.");
  if (request.scope == "column" && request.key != "ServiceName" && request.key != "SeverityText" && request.key != "ScopeName" &&
      request.key != "ScopeVersion") {
    return bad("column must be ServiceName, SeverityText, ScopeName or ScopeVersion.");
  }
  request.limit = int_param(req, "limit");
  request.filter = parse_filter_input(req);
  drop_own_filters(&request.filter, request.scope, request.key);
  *out = std::move(request);
  return true;
}

}  // namespace logs
}  // namespace chdash
