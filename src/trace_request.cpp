#include "trace_request.hpp"

#include "api_params.hpp"
#include "time_util.hpp"
#include "facet_limits.hpp"
#include "trace_facets.hpp"
#include "trace_sql.hpp"

#include <algorithm>
#include <chrono>

namespace chdash {
namespace trace {

int int_param(const httplib::Request& req, const char* name, int fallback, int lo, int hi) {
  if (!req.has_param(name)) return fallback;
  const auto value = parse_whole_i64(req.get_param_value(name));
  if (!value) return fallback;
  return static_cast<int>(std::max<int64_t>(lo, std::min<int64_t>(hi, *value)));
}

double double_param(const httplib::Request& req, const char* name, double fallback, double lo, double hi) {
  if (!req.has_param(name)) return fallback;
  const auto value = parse_whole_double(req.get_param_value(name));
  if (!value) return fallback;
  return std::max(lo, std::min(hi, *value));
}

int parse_i64_param(const httplib::Request& req, const char* name, int64_t* out) {
  if (!req.has_param(name) || req.get_param_value(name).empty()) return 0;
  const auto value = parse_whole_i64(req.get_param_value(name));
  if (!value) return -1;
  *out = *value;
  return 1;
}

std::vector<std::string> repeated_param_values(const httplib::Request& req, std::string_view name) {
  std::vector<std::string> values;
  const auto range = req.params.equal_range(std::string(name));
  for (auto it = range.first; it != range.second; ++it) {
    if (!it->second.empty()) values.push_back(it->second);
  }
  std::sort(values.begin(), values.end());
  values.erase(std::unique(values.begin(), values.end()), values.end());
  return values;
}

bool feature_param_rejected(const TraceSettings& cfg, const httplib::Request& req, std::string* message) {
  struct Check { const char* param; bool enabled; const char* label; };
  const Check checks[] = {
    {"service", cfg.features.service_filter, "service filter"},
    {"operation", cfg.features.operation_filter, "operation filter"},
    {"status", cfg.features.status_filter, "status filter"},
    {"service_not", cfg.features.service_filter, "service filter"},
    {"operation_not", cfg.features.operation_filter, "operation filter"},
    {"status_not", cfg.features.status_filter, "status filter"},
    {"min_duration_ms", cfg.features.duration_filter, "duration filter"},
    {"max_duration_ms", cfg.features.duration_filter, "duration filter"},
  };
  for (const auto& check : checks) {
    if (req.has_param(check.param) && !req.get_param_value(check.param).empty() && !check.enabled) {
      if (message) *message = std::string(check.label) + " is disabled by traces.features";
      return true;
    }
  }
  return false;
}

bool trace_time_range(const TraceSettings& cfg, const httplib::Request& req, int64_t now, int64_t* start_ms, int64_t* end_ms,
                      std::string* error) {
  int64_t lo = 0, hi = 0;
  const int lo_state = parse_i64_param(req, "start_ms", &lo);
  const int hi_state = parse_i64_param(req, "end_ms", &hi);
  if (lo_state < 0 || hi_state < 0) {
    if (error) *error = std::string(lo_state < 0 ? "start_ms" : "end_ms") + " must be a whole number of milliseconds.";
    return false;
  }
  const bool has_lo = lo_state > 0;
  const bool has_hi = hi_state > 0;
  if (has_lo || has_hi) {
    if (!has_lo || !has_hi) {
      if (error) *error = "start_ms and end_ms must be provided together.";
      return false;
    }
  } else {
    const int lookback = int_param(req, "lookback_minutes", cfg.default_lookback_minutes, 1, cfg.max_lookback_minutes);
    hi = now;
    lo = hi - static_cast<int64_t>(lookback) * 60 * 1000;
  }
  // Searches convert the bounds to nanoseconds. An int64 overflows after the year 2262.
  constexpr int64_t kMaxTraceTimeMs = INT64_MAX / 1000000 - 1;
  if (lo < 0 || hi <= lo || hi > kMaxTraceTimeMs) {
    if (error) *error = "Invalid trace time range.";
    return false;
  }
  const int64_t max_ms = static_cast<int64_t>(cfg.max_lookback_minutes) * 60 * 1000;
  if (hi - lo > max_ms) {
    if (error) *error = "Trace time range exceeds traces.max_lookback_minutes.";
    return false;
  }
  *start_ms = lo;
  *end_ms = hi;
  return true;
}

bool trace_time_range(const TraceSettings& cfg, const httplib::Request& req, int64_t* start_ms, int64_t* end_ms, std::string* error) {
  return trace_time_range(cfg, req, now_ms(), start_ms, end_ms, error);
}

bool parse_trace_filters(const httplib::Request& req, TraceFilterSpec* spec, std::string* validation_error) {
  auto fail = [&](std::string message) {
    if (validation_error) *validation_error = std::move(message);
    return false;
  };
  spec->services = repeated_param_values(req, "service");
  spec->operations = repeated_param_values(req, "operation");
  spec->services_not = repeated_param_values(req, "service_not");
  spec->operations_not = repeated_param_values(req, "operation_not");
  spec->status_not = repeated_param_values(req, "status_not");
  spec->status = req.has_param("status") ? req.get_param_value("status") : std::string{};
  if (!spec->status.empty() && !valid_status(spec->status)) return fail("status must be Error, Ok, Unset, or empty.");
  for (const auto& status : spec->status_not) {
    if (!valid_status(status)) return fail("status_not must be Error, Ok or Unset.");
  }

  const std::string tag_scope = req.has_param("tag_scope") ? req.get_param_value("tag_scope") : std::string{};
  const std::string tag_key = req.has_param("tag_key") ? req.get_param_value("tag_key") : std::string{};
  const std::string tag_value = req.has_param("tag_value") ? req.get_param_value("tag_value") : std::string{};
  if ((!tag_key.empty() || !tag_value.empty()) && (tag_key.empty() || tag_value.empty())) {
    return fail("tag_key and tag_value must be provided together.");
  }
  if (!tag_key.empty() && tag_scope != "span" && tag_scope != "resource" && tag_scope != "any") {
    return fail("tag_scope must be span, resource, or any.");
  }
  if (!tag_key.empty()) spec->tags.push_back(TagFilter{tag_scope, TagOp::Eq, tag_key, tag_value});

  struct TagParam { const char* name; TagOp op; };
  for (const TagParam param : {TagParam{"tag", TagOp::Eq}, TagParam{"tag_not", TagOp::Ne},
                               TagParam{"tag_exists", TagOp::Exists}, TagParam{"tag_missing", TagOp::Missing}}) {
    for (const auto& raw : repeated_param_values(req, param.name)) {
      std::string_view rest;
      TagFilter tag;
      tag.scope = split_tag_scope(raw, &rest);
      tag.op = param.op;
      if (param.op == TagOp::Eq || param.op == TagOp::Ne) {
        const size_t eq = rest.find('=');
        if (eq == std::string_view::npos || eq == 0) {
          return fail(std::string(param.name) + " must be [span:|resource:]key=value.");
        }
        tag.key = std::string(rest.substr(0, eq));
        tag.value = std::string(rest.substr(eq + 1));
      } else {
        tag.key = std::string(rest);
      }
      if (tag.key.empty()) return fail(std::string(param.name) + " needs an attribute key.");
      spec->tags.push_back(std::move(tag));
    }
  }
  for (const auto& tag : spec->tags) {
    if (tag.key.size() > kMaxTagKeyBytes) return fail("Attribute keys are limited to 512 bytes.");
    if (tag.value.size() > kMaxTagValueBytes) return fail("Attribute values are limited to 4096 bytes.");
  }
  if (spec->tags.size() > kMaxTagFilters) return fail("At most 32 attribute filters are accepted.");
  return true;
}

bool parse_window(const httplib::Request& req, const TraceSettings& traces, bool analytics_required, WindowRequest* out, ApiError* error) {
  const auto fail = [&](int status, const char* code, std::string message) {
    error->status = status;
    error->code = code;
    error->message = std::move(message);
    return false;
  };
  if (analytics_required && !traces.analytics) return fail(404, "trace_analytics_disabled", "Trace analytics are disabled by configuration.");
  std::string message;
  if (feature_param_rejected(traces, req, &message)) return fail(400, "trace_filter_disabled", message);
  if (!trace_time_range(traces, req, &out->start_ms, &out->end_ms, &message)) return fail(400, "invalid_trace_range", message);
  out->min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, kMaxDurationMs);
  out->max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, kMaxDurationMs);
  if (out->max_duration_ms > 0.0 && out->min_duration_ms > out->max_duration_ms) {
    return fail(400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
  }
  if (!parse_trace_filters(req, &out->filters, &message)) return fail(400, "invalid_trace_filter", message);
  return true;
}

namespace {

// The bucket grid of the charts uses bucket_origin_ms (the local midnight of the browser). The parameter align_buckets=1 uses
// whole buckets.
void parse_grid(const httplib::Request& req, int64_t* bucket_origin_ms, bool* align_buckets) {
  *bucket_origin_ms = 0;
  parse_i64_param(req, "bucket_origin_ms", bucket_origin_ms);
  *align_buckets = req.has_param("align_buckets") && req.get_param_value("align_buckets") == "1";
}

}  // namespace

bool parse_analytics(const httplib::Request& req, const TraceSettings& traces, AnalyticsRequest* out, ApiError* error) {
  if (!parse_window(req, traces, /*analytics_required=*/true, &out->window, error)) return false;
  parse_grid(req, &out->bucket_origin_ms, &out->align_buckets);
  out->charts = req.has_param("charts") ? req.get_param_value("charts") : std::string{};
  return true;
}

bool parse_service_map(const httplib::Request& req, const TraceSettings& traces, ServiceMapRequest* out, ApiError* error) {
  if (!parse_window(req, traces, /*analytics_required=*/false, &out->window, error)) return false;
  // The parameter sample_factor forces the trace sampling factor (1 = every trace). The time slicing still applies above the read
  // budget.
  out->forced_factor = int_param(req, "sample_factor", 0, 1, kServiceMapMaxSampleFactor);
  return true;
}

bool parse_heatmap(const httplib::Request& req, const TraceSettings& traces, HeatmapRequest* out, ApiError* error) {
  if (!parse_window(req, traces, /*analytics_required=*/true, &out->window, error)) return false;
  out->rows = int_param(req, "rows", 40, 8, 80);
  parse_grid(req, &out->bucket_origin_ms, &out->align_buckets);
  return true;
}

bool parse_deltas(const httplib::Request& req, const TraceSettings& traces, DeltasRequest* out, ApiError* error) {
  if (!parse_window(req, traces, /*analytics_required=*/true, &out->window, error)) return false;
  // A value that is not a number is "present" with the value 0. The box check of the service refuses it (t1 <= t0) or clamps it.
  out->t0_present = parse_i64_param(req, "t0", &out->t0) != 0;
  out->t1_present = parse_i64_param(req, "t1", &out->t1) != 0;
  out->d0_ms = double_param(req, "d0", -1.0, 0.0, kMaxDurationMs);
  out->d1_ms = double_param(req, "d1", -1.0, 0.0, kMaxDurationMs);
  out->baseline = req.has_param("baseline") ? req.get_param_value("baseline") : std::string("outside");
  out->sample = int_param(req, "sample", kDeltaDefaultSample, 100, kDeltaMaxSample);
  return true;
}

bool parse_services(const httplib::Request& req, const TraceSettings& traces, ServicesRequest* out, ApiError* error) {
  const auto fail = [&](int status, const char* code, std::string message) {
    error->status = status;
    error->code = code;
    error->message = std::move(message);
    return false;
  };
  if (!traces.analytics) {
    return fail(404, "trace_analytics_disabled", "Trace analytics (and the services view) are disabled by configuration.");
  }
  std::string message;
  if (feature_param_rejected(traces, req, &message)) return fail(400, "trace_filter_disabled", message);
  if (!trace_time_range(traces, req, &out->start_ms, &out->end_ms, &message)) return fail(400, "invalid_trace_range", message);
  out->span_scope = req.has_param("scope") && !req.get_param_value("scope").empty() ? req.get_param_value("scope") : "entry";
  if (out->span_scope != "entry" && out->span_scope != "root") return fail(400, "invalid_trace_filter", "scope must be entry or root.");
  out->detail = req.has_param("detail") ? req.get_param_value("detail") : std::string{};
  if (out->detail.size() > kServicesMaxDetailBytes) return fail(400, "invalid_trace_filter", "detail is limited to 1024 bytes.");
  if (!out->detail.empty() && !traces.features.service_filter) {
    return fail(400, "trace_filter_disabled", "service filter is disabled by traces.features");
  }
  out->min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, kMaxDurationMs);
  out->max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, kMaxDurationMs);
  if (out->max_duration_ms > 0.0 && out->min_duration_ms > out->max_duration_ms) {
    return fail(400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
  }
  if (!parse_trace_filters(req, &out->filters, &message)) return fail(400, "invalid_trace_filter", message);
  // The grid of the charts and the whole window apply to the services route only. The statements of /services/db never read them.
  parse_grid(req, &out->bucket_origin_ms, &out->align_buckets);
  out->exact = req.has_param("exact") && req.get_param_value("exact") == "1";
  return true;
}

bool parse_prefill(const httplib::Request& req, const TraceSettings& traces, PrefillRequest* out, ApiError* error) {
  std::string message;
  if (!trace_time_range(traces, req, &out->start_ms, &out->end_ms, &message)) {
    error->status = 400;
    error->code = "invalid_trace_range";
    error->message = message;
    return false;
  }
  // The range is a minute-aligned superset of the requested range. The list only feeds the service and operation pickers. The
  // alignment lets "last N minutes" requests share one scan. These requests are made in the same minute, for example at a reload
  // or a range toggle.
  out->aligned_start_ms = (out->start_ms / kPrefillAlignMs) * kPrefillAlignMs;
  out->aligned_end_ms = ((out->end_ms + kPrefillAlignMs - 1) / kPrefillAlignMs) * kPrefillAlignMs;
  if (!parse_trace_filters(req, &out->filters, &message)) {
    error->status = 400;
    error->code = "invalid_trace_filter";
    error->message = message;
    return false;
  }
  out->read_budget = read_rows_limit_param(req, kPrefillReadRows);
  return true;
}

bool parse_facet_key(const httplib::Request& req, FacetRequest* out, ApiError* error) {
  out->key_scope = req.has_param("scope") ? req.get_param_value("scope") : std::string{};
  out->key = req.has_param("key") ? req.get_param_value("key") : std::string{};
  if (out->key_scope != "span" && out->key_scope != "resource") {
    error->status = 400;
    error->code = "invalid_trace_facet";
    error->message = "scope must be span or resource.";
    return false;
  }
  if (out->key.empty() || out->key.size() > kMaxTagKeyBytes) {
    error->status = 400;
    error->code = "invalid_trace_facet";
    error->message = "key must be 1 to 512 bytes.";
    return false;
  }
  out->limit = int_param(req, "limit", 10, 1, kFacetMaxValues);
  return true;
}

bool parse_facets(const httplib::Request& req, const TraceSettings& traces, FacetRequest* out, ApiError* error) {
  const auto fail = [&](const char* code, std::string message) {
    error->status = 400;
    error->code = code;
    error->message = std::move(message);
    return false;
  };
  std::string message;
  if (feature_param_rejected(traces, req, &message)) return fail("trace_filter_disabled", message);
  if (!trace_time_range(traces, req, &out->start_ms, &out->end_ms, &message)) return fail("invalid_trace_range", message);
  out->aligned_start_ms = (out->start_ms / kPrefillAlignMs) * kPrefillAlignMs;
  out->aligned_end_ms = ((out->end_ms + kPrefillAlignMs - 1) / kPrefillAlignMs) * kPrefillAlignMs;
  if (!parse_trace_filters(req, &out->filters, &message)) return fail("invalid_trace_filter", message);
  out->read_cap = read_rows_limit_param(req, kFacetReadRowsCap);
  return true;
}

namespace {

bool refuse(ApiError* error, int status, const char* code, std::string message) {
  error->status = status;
  error->code = code;
  error->message = std::move(message);
  return false;
}

std::string text_param(const httplib::Request& req, const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; }

}  // namespace

bool parse_trace_detail(const httplib::Request& req, TraceDetailRequest* out, ApiError* error) {
  if (!req.has_param("trace_id") || req.get_param_value("trace_id").empty()) return refuse(error, 400, "missing_trace_id", "trace_id is required.");
  out->trace_id = req.get_param_value("trace_id");
  if (out->trace_id.size() > 256) return refuse(error, 400, "invalid_trace_id", "trace_id is too long.");
  return true;
}

bool parse_span(const httplib::Request& req, SpanRequest* out, ApiError* error) {
  out->trace_id = text_param(req, "trace_id");
  out->span_id = text_param(req, "span_id");
  if (out->trace_id.empty() || out->span_id.empty() || !parse_i64_param(req, "timestamp_ns", &out->timestamp_ns)) {
    return refuse(error, 400, "missing_span_key", "trace_id, span_id and timestamp_ns are required.");
  }
  if (out->trace_id.size() > 256 || out->span_id.size() > 256 || out->timestamp_ns < 0) {
    return refuse(error, 400, "invalid_span_key", "The span key is invalid.");
  }
  return true;
}

bool parse_linked_from(const httplib::Request& req, LinkedFromRequest* out, ApiError* error) {
  out->trace_id = text_param(req, "trace_id");
  out->span_id = text_param(req, "span_id");
  if (out->trace_id.empty()) return refuse(error, 400, "missing_trace_id", "trace_id is required.");
  if (out->trace_id.size() > 256) return refuse(error, 400, "invalid_trace_id", "trace_id is too long.");
  if (out->span_id.size() > 256) return refuse(error, 400, "invalid_span_id", "span_id is too long.");
  const bool has_lo = parse_i64_param(req, "start_ms", &out->start_ms) != 0;
  const bool has_hi = parse_i64_param(req, "end_ms", &out->end_ms) != 0;
  if (has_lo != has_hi) return refuse(error, 400, "invalid_trace_range", "start_ms and end_ms must be provided together.");
  out->has_range = has_lo;
  return true;
}

bool parse_context(const httplib::Request& req, ContextRequest* out, ApiError* error) {
  if (!parse_i64_param(req, "timestamp_ns", &out->anchor_ns)) return refuse(error, 400, "missing_timestamp", "timestamp_ns is required.");
  out->window_ms = 60000;
  if (req.has_param("window_ms") && !parse_i64_param(req, "window_ms", &out->window_ms)) out->window_ms = -1;
  if (std::find(std::begin(kContextWindowsMs), std::end(kContextWindowsMs), out->window_ms) == std::end(kContextWindowsMs)) {
    return refuse(error, 400, "invalid_context_window", "window_ms must be 1000, 10000, 60000 or 300000.");
  }
  const int64_t window_ns = out->window_ms * kNsPerMs;
  if (out->anchor_ns < window_ns || out->anchor_ns > INT64_MAX - window_ns) {
    return refuse(error, 400, "invalid_timestamp", "timestamp_ns is out of range.");
  }
  out->filter = req.has_param("filter") && !req.get_param_value("filter").empty() ? req.get_param_value("filter") : "any";
  out->direction = req.has_param("direction") && !req.get_param_value("direction").empty() ? req.get_param_value("direction") : "around";
  if (out->direction != "around" && out->direction != "older" && out->direction != "newer") {
    return refuse(error, 400, "invalid_direction", "direction must be around, older or newer.");
  }
  out->limit = int_param(req, "limit", 50, 1, 200);
  out->cursor_span = text_param(req, "cursor_span_id");
  if (out->direction != "around") {
    if (!parse_i64_param(req, "cursor_ns", &out->cursor_ns)) {
      return refuse(error, 400, "missing_cursor", "cursor_ns is required to page older or newer.");
    }
    if (out->cursor_span.size() > 256) return refuse(error, 400, "invalid_cursor", "cursor_span_id is too long.");
  }
  out->service = text_param(req, "service");
  out->value = text_param(req, "value");
  out->attr_scope = text_param(req, "attr_scope");
  out->attr_key = text_param(req, "attr_key");
  out->attr_value = text_param(req, "attr_value");
  return true;
}

bool parse_spans(const httplib::Request& req, const TraceSettings& traces, SpansRequest* out, ApiError* error) {
  std::string message;
  if (feature_param_rejected(traces, req, &message)) return refuse(error, 400, "trace_filter_disabled", message);
  if (!trace_time_range(traces, req, &out->start_ms, &out->end_ms, &message)) return refuse(error, 400, "invalid_trace_range", message);
  out->limit = int_param(req, "limit", kSpanPageDefaultLimit, 1, kSpanPageMaxLimit);
  // The parameter budget_ms can only lower the widening budget. The tests use it to reach a resume point in a deterministic way.
  out->budget_ms = static_cast<double>(int_param(req, "budget_ms", static_cast<int>(kSpanPageBudgetMs), 0, static_cast<int>(kSpanPageBudgetMs)));
  // This check is at span level. It uses the Duration of the span itself.
  out->min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, kMaxDurationMs);
  out->max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, kMaxDurationMs);
  if (out->max_duration_ms > 0.0 && out->min_duration_ms > out->max_duration_ms) {
    return refuse(error, 400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
  }
  if (!parse_trace_filters(req, &out->filters, &message)) return refuse(error, 400, "invalid_trace_filter", message);
  out->kinds = repeated_param_values(req, "kind");
  if (out->kinds.size() > kSpanKindsMax) return refuse(error, 400, "invalid_trace_filter", "At most 16 span kinds are accepted.");
  for (const auto& kind : out->kinds) {
    if (kind.size() > 64) return refuse(error, 400, "invalid_trace_filter", "kind values are limited to 64 bytes.");
  }
  if (!parse_span_columns(req, &out->columns, &message)) return refuse(error, 400, "invalid_trace_columns", message);
  if (req.has_param("cursor") && !req.get_param_value("cursor").empty()) {
    if (!decode_span_cursor(req.get_param_value("cursor"), &out->cursor) || out->cursor.ts_ns > out->end_ms * kNsPerMs) {
      return refuse(error, 400, "invalid_cursor", "cursor is not a span search cursor of this range.");
    }
  }
  return true;
}

bool parse_span_columns(const httplib::Request& req, std::vector<SpanAttributeColumn>* out, std::string* error) {
  constexpr size_t kSpanColumnsMax = 20;
  for (const auto& raw : repeated_param_values(req, "columns")) {
    for (const auto& item : split_char(raw, ',')) {
      if (item.empty()) continue;
      std::string_view rest;
      SpanAttributeColumn column;
      column.scope = split_tag_scope(item, &rest);
      column.key = std::string(rest);
      if (column.key.empty() || column.key.size() > kMaxTagKeyBytes) {
        *error = "columns entries must be [span:|resource:]key with a 1 to 512 byte key.";
        return false;
      }
      const bool seen = std::any_of(out->begin(), out->end(), [&](const SpanAttributeColumn& other) {
        return other.scope == column.scope && other.key == column.key;
      });
      if (!seen) out->push_back(std::move(column));
    }
  }
  if (out->size() > kSpanColumnsMax) {
    *error = "At most 20 attribute columns are accepted.";
    return false;
  }
  return true;
}

uint64_t read_rows_limit_param(const httplib::Request& req, uint64_t cap) {
  if (!req.has_param("read_rows_limit")) return cap;
  uint64_t value = cap;
  try {
    const long long asked = std::stoll(req.get_param_value("read_rows_limit"));
    value = static_cast<uint64_t>(std::max<long long>(1, std::min<long long>(static_cast<long long>(cap), asked)));
  } catch (...) {
    return cap;
  }
  if (value == cap) return cap;
  uint64_t step = 1;
  while (step <= value / 10) step *= 10;
  for (const uint64_t factor : {5, 2, 1}) {
    if (factor * step <= value) return factor * step;
  }
  return step;
}

}  // namespace trace
}  // namespace chdash
