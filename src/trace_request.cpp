#include "trace_request.hpp"

#include "api_params.hpp"
#include "time_util.hpp"
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
  // Searches convert bounds to nanoseconds (int64 overflows after year 2262).
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

// The bucket grid of the charts: bucket_origin_ms (the browser's local midnight) and align_buckets=1 (whole buckets).
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
  // sample_factor forces the trace sampling factor (1 = every trace); the time slicing still applies above the read budget.
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
  // A value that is not a number is "present" with the value 0: the box check of the service refuses it (t1 <= t0) or clamps it.
  out->t0_present = parse_i64_param(req, "t0", &out->t0) != 0;
  out->t1_present = parse_i64_param(req, "t1", &out->t1) != 0;
  out->d0_ms = double_param(req, "d0", -1.0, 0.0, kMaxDurationMs);
  out->d1_ms = double_param(req, "d1", -1.0, 0.0, kMaxDurationMs);
  out->baseline = req.has_param("baseline") ? req.get_param_value("baseline") : std::string("outside");
  out->sample = int_param(req, "sample", kDeltaDefaultSample, 100, kDeltaMaxSample);
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
