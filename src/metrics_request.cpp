#include "metrics_request.hpp"

#include "api_params.hpp"
#include "service_result.hpp"

#include <algorithm>
#include <iterator>
#include <stdexcept>
#include <utility>

namespace chdash {
namespace metrics {

const char* const kKinds[kKindCount] = {"gauge", "sum", "histogram", "exponential_histogram", "summary"};

namespace {

// A request that the route refuses: thrown by the readers below, caught by the parsers, which turn it into the 400 answer.
struct BadRequest : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string param(const httplib::Request& req, const char* name) {
  return req.has_param(name) ? req.get_param_value(name) : std::string{};
}

// A number that is the whole text of the parameter; an absent or malformed value is no value.
bool parse_i64_param(const httplib::Request& req, const char* name, int64_t* out) {
  const auto value = parse_whole_i64(param(req, name));
  if (!value) return false;
  *out = *value;
  return true;
}

// start_ms and end_ms; when `default_range_ms` is set and the request names neither, the last `default_range_ms` up to `now_ms`.
TimeWindow parse_window(const httplib::Request& req, int64_t now_ms, int64_t default_range_ms = 0) {
  TimeWindow window;
  if (default_range_ms > 0 && !req.has_param("start_ms") && !req.has_param("end_ms")) {
    window.end_ms = now_ms;
    window.start_ms = window.end_ms - default_range_ms;
    return window;
  }
  if (!parse_i64_param(req, "start_ms", &window.start_ms) || !parse_i64_param(req, "end_ms", &window.end_ms)) {
    throw BadRequest("start_ms and end_ms (milliseconds) are required.");
  }
  constexpr int64_t kMaxTimeMs = INT64_MAX / 1000000 - 1;
  if (window.start_ms < 0 || window.end_ms <= window.start_ms || window.end_ms > kMaxTimeMs) {
    throw BadRequest("Invalid metrics time range.");
  }
  if (window.end_ms - window.start_ms > kMaxRangeMs) {
    throw BadRequest("Metrics time range exceeds 90 days.");
  }
  return window;
}

std::string required(const httplib::Request& req, const char* name) {
  std::string value = param(req, name);
  if (value.empty()) throw BadRequest(std::string(name) + " is required.");
  if (value.size() > 1024) throw BadRequest(std::string(name) + " is too long.");
  return value;
}

std::string parse_kind(const httplib::Request& req) {
  const std::string kind = required(req, "kind");
  for (const char* k : kKinds) {
    if (kind == k) return kind;
  }
  throw BadRequest("kind must be gauge, sum, histogram, exponential_histogram or summary.");
}

std::vector<AttributeFilter> parse_filters(const httplib::Request& req) {
  std::vector<AttributeFilter> out;
  for (const auto& [name, op] : {std::pair<const char*, const char*>{"filter", "="}, {"filter_not", "!="}}) {
    const auto range = req.params.equal_range(name);
    for (auto it = range.first; it != range.second; ++it) {
      const std::string& text = it->second;
      if (text.empty()) continue;
      const size_t eq = text.find('=');
      if (eq == std::string::npos || eq == 0) throw BadRequest(std::string(name) + " must be key=value.");
      if (text.size() > 2048) throw BadRequest(std::string(name) + " is too long.");
      out.push_back(AttributeFilter{text.substr(0, eq), op, text.substr(eq + 1)});
    }
  }
  if (out.size() > 32) throw BadRequest("Too many attribute filters (max 32).");
  return out;
}

// Splits on a delimiter, keeping empty fields.
std::vector<std::string> split_commas(const std::string& text) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= text.size(); ++i) {
    if (i != text.size() && text[i] != ',') continue;
    out.emplace_back(text.substr(start, i - start));
    start = i + 1;
  }
  return out;
}

std::vector<std::string> parse_group_by(const httplib::Request& req) {
  std::vector<std::string> out;
  for (auto& key : split_commas(param(req, "group_by"))) {
    if (key.empty()) continue;
    if (key.size() > 256) throw BadRequest("group_by key is too long.");
    if (std::find(out.begin(), out.end(), key) == out.end()) out.push_back(key);
  }
  if (out.size() > kMaxGroupBy) throw BadRequest("group_by accepts at most 5 attribute keys.");
  return out;
}

BucketGrid choose_grid(const httplib::Request& req, const TimeWindow& window) {
  const int64_t range_ms = window.end_ms - window.start_ms;
  static const int64_t kCandidates[] = {10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200,
                                        86400, 172800, 604800};
  BucketGrid grid;
  grid.size_ms = kCandidates[std::size(kCandidates) - 1] * 1000;
  for (int64_t seconds : kCandidates) {
    if (seconds * 1000 * 120 >= range_ms) {
      grid.size_ms = seconds * 1000;
      break;
    }
  }
  int64_t step_ms = 0;
  if (parse_i64_param(req, "step_ms", &step_ms) && step_ms > 0) {
    const int64_t min_step = std::max<int64_t>(1000, (range_ms + 999) / 1000);
    grid.size_ms = std::max(min_step, std::min(step_ms, std::max<int64_t>(range_ms, 1000)));
  }
  int64_t origin = 0;
  parse_i64_param(req, "bucket_origin_ms", &origin);
  grid.origin_ms = ((origin % grid.size_ms) + grid.size_ms) % grid.size_ms;
  return grid;
}

// Runs a reader; the 400 answer of a BadRequest goes to *error.
template <typename Fn>
bool guarded(ApiError* error, Fn&& fn, const char* code = "invalid_metrics_request") {
  try {
    fn();
    return true;
  } catch (const BadRequest& e) {
    if (error) *error = make_error(400, code, e.what());
    return false;
  }
}

}  // namespace

std::string BucketGrid::sql(const std::string& column) const {
  return std::to_string(origin_ms) + " + intDiv(toUnixTimestamp64Milli(" + column + ") - " + std::to_string(origin_ms) + ", " +
         std::to_string(size_ms) + ") * " + std::to_string(size_ms);
}

bool parse_catalog(const httplib::Request& req, int64_t now_ms, CatalogRequest* out, ApiError* error) {
  // The window of the catalog has a code of its own.
  if (!guarded(error, [&] { out->window = parse_window(req, now_ms, kCatalogDefaultRangeMs); }, "invalid_metrics_range")) return false;
  const std::string refresh = param(req, "refresh");
  out->refresh = refresh == "1" || refresh == "true";
  return true;
}

bool parse_attributes(const httplib::Request& req, AttributesRequest* out, ApiError* error) {
  if (!guarded(error, [&] {
        out->kind = parse_kind(req);
        out->service = required(req, "service");
        out->metric = required(req, "metric");
        out->window = parse_window(req, 0);
        out->filters = parse_filters(req);
      })) {
    return false;
  }
  out->key = param(req, "key");
  return true;
}

bool parse_series(const httplib::Request& req, SeriesRequest* out, ApiError* error) {
  return guarded(error, [&] {
    out->kind = parse_kind(req);
    out->service = required(req, "service");
    out->metric = required(req, "metric");
    out->window = parse_window(req, 0);
    out->filters = parse_filters(req);
    out->group_by = parse_group_by(req);
    out->grid = choose_grid(req, out->window);
    out->agg = param(req, "agg");
    int64_t limit = 0;
    if (parse_i64_param(req, "limit", &limit)) {
      if (limit < 1 || limit > kMaxTopK) throw BadRequest("limit must be between 1 and 50.");
      out->top_k = static_cast<int>(limit);
    }
  });
}

bool parse_exemplars(const httplib::Request& req, ExemplarsRequest* out, ApiError* error) {
  return guarded(error, [&] {
    out->kind = parse_kind(req);
    if (out->kind == "summary") throw BadRequest("Summaries have no exemplars.");
    out->service = required(req, "service");
    out->metric = required(req, "metric");
    out->window = parse_window(req, 0);
    out->filters = parse_filters(req);
    out->grid = choose_grid(req, out->window);
    if (parse_i64_param(req, "per_bucket", &out->per_bucket) && (out->per_bucket < 1 || out->per_bucket > 20)) {
      throw BadRequest("per_bucket must be between 1 and 20.");
    }
    if (parse_i64_param(req, "limit", &out->limit) && (out->limit < 1 || out->limit > 2000)) {
      throw BadRequest("limit must be between 1 and 2000.");
    }
  });
}

}  // namespace metrics
}  // namespace chdash
