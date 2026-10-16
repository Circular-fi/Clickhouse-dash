#pragma once

// The routes of the Metrics page (/api/metrics/catalog, attributes, series, exemplars) read these values from a request.
// The values are the kind, the window, the attribute filters, the group setting and the bucket grid. This file only parses them.
// Nothing here reads ClickHouse, and nothing writes an answer.
// A parser returns false with the 400 answer in *error. The code is invalid_metrics_request. For the window of the catalog, the code is invalid_metrics_range.

#include "error_envelope.hpp"

#include <httplib.h>

#include <cstdint>
#include <string>
#include <vector>

namespace chdash {
namespace metrics {

// The five tables of the exporter, one for each kind of metric: <table_prefix>_<kind>.
constexpr size_t kKindCount = 5;
extern const char* const kKinds[kKindCount];

constexpr int64_t kMaxRangeMs = 90LL * 24 * 60 * 60 * 1000;
// The window of the catalog, when the request names none. The catalog groups every point of its window. So, the default is a day.
constexpr int64_t kCatalogDefaultRangeMs = 24LL * 60 * 60 * 1000;
constexpr size_t kMaxGroupBy = 5;
constexpr int kDefaultTopK = 20;
constexpr int kMaxTopK = 50;

struct TimeWindow {
  int64_t start_ms = 0;
  int64_t end_ms = 0;
};

struct AttributeFilter {
  std::string key;
  std::string op;  // "=" or "!="
  std::string value;
};

// ~60-120 buckets for a window, on a grid anchored at the browser's midnight.
struct BucketGrid {
  int64_t size_ms = 60000;
  int64_t origin_ms = 0;  // bucket_origin_ms mod size

  int64_t floor(int64_t t) const {
    const int64_t offset = t - origin_ms;
    return origin_ms + (offset >= 0 ? offset / size_ms : -((-offset + size_ms - 1) / size_ms)) * size_ms;
  }
  // The SQL that gives the bucket (ms) of a DateTime64 column.
  std::string sql(const std::string& column) const;
};

struct CatalogRequest {
  TimeWindow window;
  bool refresh = false;
};

struct AttributesRequest {
  std::string kind, service, metric;
  TimeWindow window;
  std::vector<AttributeFilter> filters;
  std::string key;  // empty: the keys; else the values of this key
};

struct SeriesRequest {
  std::string kind, service, metric, agg;
  TimeWindow window;
  std::vector<AttributeFilter> filters;
  std::vector<std::string> group_by;
  BucketGrid grid;
  int top_k = kDefaultTopK;
};

struct ExemplarsRequest {
  std::string kind, service, metric;
  TimeWindow window;
  std::vector<AttributeFilter> filters;
  BucketGrid grid;
  int64_t per_bucket = 3;
  int64_t limit = 500;
};

// `now_ms` is the end of the window that the catalog takes when the request names none.
bool parse_catalog(const httplib::Request& req, int64_t now_ms, CatalogRequest* out, ApiError* error);
bool parse_attributes(const httplib::Request& req, AttributesRequest* out, ApiError* error);
bool parse_series(const httplib::Request& req, SeriesRequest* out, ApiError* error);
bool parse_exemplars(const httplib::Request& req, ExemplarsRequest* out, ApiError* error);

}  // namespace metrics
}  // namespace chdash
