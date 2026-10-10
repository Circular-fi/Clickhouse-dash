#pragma once

// Which attribute columns of the traces table are Maps. Tagged searches, the attribute columns of the span search, the facets and
// the deltas read the maps, so they must know. It is a schema fact that changes on DDL, not per request: it is kept per source
// (system URI + table) instead of reading system.columns on every request. /api/traces/meta always reads it fresh and refreshes
// the cache.

#include "ch_executor.hpp"
#include "health_runner.hpp"
#include "otel_settings.hpp"
#include "trace_filters.hpp"
#include "ttl_cache.hpp"

#include <string>

namespace chdash {
namespace trace {

struct AttributeMaps {
  bool span_map = false;
  bool resource_map = false;
};
using AttributeMapCache = TtlCache<std::string, AttributeMaps>;

// One read per source at a time (single-flight). Only successful lookups are kept: a failure is retried by the next request (no
// back-off). The key comes from the configuration only.
AttributeMapCache::Options attribute_map_cache_options();

// The columns of the table, read from ClickHouse. False with the reason in *error when the read failed.
bool read_attribute_maps(ChExecutor& db, const TraceSettings& cfg, bool* span_map, bool* resource_map, std::string* error = nullptr);

// /api/traces/meta read the columns itself: its answer replaces the kept one.
void store_attribute_maps(AttributeMapCache& cache, const HostSpec& host, const TraceSettings& cfg, bool span_map, bool resource_map);

// The kept answer, or a read. False when the columns could not be read.
bool cached_attribute_maps(ChExecutor& db, AttributeMapCache& cache, const HostSpec& host, const TraceSettings& cfg, bool* span_map,
                           bool* resource_map);

// The maps that filters, facets and columns may read: stored as Maps, and enabled by traces.features.
AttributeColumns attribute_columns(ChExecutor& db, AttributeMapCache& cache, const HostSpec& host, const TraceSettings& cfg);

}  // namespace trace
}  // namespace chdash
