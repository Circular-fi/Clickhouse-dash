#pragma once

// This header defines the services view of the Traces page. The view shows the RED metrics of the entry spans of each service
// (rate, errors, duration). It shows them by service, by chart bucket and, with a drill-down, by endpoint. It also shows the
// slowest entry spans, the first time each release was seen, and the database statements that the spans carry. The statements are
// in trace_sql.hpp.

#include "ch_executor.hpp"
#include "trace_filters.hpp"
#include "trace_result.hpp"
#include "trace_sql.hpp"

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace chdash {
namespace trace {

struct ServiceStats {
  uint64_t spans = 0, errors = 0;
  double total_ns = 0;
  uint64_t p50 = 0, p95 = 0, p99 = 0;
};

struct SlowSpan {
  std::string trace_id, span_id, operation, status;
  int64_t start_ms = 0;
  uint64_t duration_ns = 0;
};

struct Release {
  std::string version;
  int64_t first_ms = 0;
  uint64_t spans = 0;
};

// The reads of the view need these values from a request, after its filters became SQL.
struct ServicesQuery {
  std::string table, visibility;
  std::string span_scope;  // "entry" or "root"
  std::string detail;      // the drilled-down service, or empty
  std::string where;       // " AND ..." after the allowlist predicate
  int64_t start_ms = 0, end_ms = 0;
  int64_t bucket_origin_ms = 0;
  bool align_buckets = false;
  bool exact = false;  // read the whole window, whatever its size
  bool releases_supported = false;  // the resource attributes are a Map that traces.features lets the page read
};

struct ServicesOutcome {
  std::string span_kind;  // the predicate of the entry spans
  int64_t bucket_ms = 0, origin_ms = 0, range_start_ms = 0, range_end_ms = 0;
  ServicesWindow window;
  uint64_t estimate_ms = 0;
  std::map<std::string, ServiceStats> services;
  std::map<std::string, std::map<int64_t, ServiceStats>> series;
  std::vector<std::pair<std::string, ServiceStats>> endpoints;  // by total time, busiest first
  BoundedRead read;
  bool partial = false;  // the time budget stopped the read
  std::vector<SlowSpan> slowest;
  std::vector<Release> releases;
  bool releases_supported = false, releases_estimated = false;
  uint64_t slowest_ms = 0, releases_ms = 0;
};

// The view runs one scan over the window. See trace_sql.hpp, "the services view". The estimate that decides the sampling is a
// performance hint. A failure of the estimate makes the scan read the whole window, on a new connection. This function throws
// what ClickHouse throws when the scan fails.
Result<ServicesOutcome> run_services(ChExecutor& db, const ServicesQuery& query);

struct DbStatement {
  std::string service, statement, system;
  uint64_t spans = 0, errors = 0, p95 = 0;
  double total_ns = 0;
};

struct DbOutcome {
  bool supported = false;  // the span attributes are a Map that traces.features lets the page read
  std::vector<DbStatement> rows;
  BoundedRead read;
};

// The answer is estimated only when a cap stopped the read. The bloom filter index can make read_rows smaller than total_rows
// when no cap is set.
DbOutcome run_services_db(ChExecutor& db, const ServicesQuery& query, bool supported);

}  // namespace trace
}  // namespace chdash
