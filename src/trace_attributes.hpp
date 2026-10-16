#pragma once

// This file finds the attribute columns of the traces table that are Maps. The tagged searches, the attribute columns of the span
// search, the facets and the deltas read these maps. Therefore they must know which columns are Maps.
//
// The map columns are a schema fact. The schema changes only on DDL, not on each request. The server therefore keeps the answer
// for each source (system URI + table). It does not read system.columns on every request. The route /api/traces/meta always reads
// the columns again and refreshes the cache.

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

// Only one read runs for each source at a time (single-flight). The cache keeps only successful lookups. A failed lookup is
// retried by the next request, without a back-off. The key comes from the configuration only.
AttributeMapCache::Options attribute_map_cache_options();

// This function reads the columns of the table from ClickHouse. It returns false when the read fails, and it puts the reason in
// *error.
bool read_attribute_maps(ChExecutor& db, const TraceSettings& cfg, bool* span_map, bool* resource_map, std::string* error = nullptr);

// The route /api/traces/meta reads the columns itself. Its answer replaces the kept answer.
void store_attribute_maps(AttributeMapCache& cache, const HostSpec& host, const TraceSettings& cfg, bool span_map, bool resource_map);

// This function returns the kept answer. If no answer is kept, it reads the columns. It returns false when the columns cannot be
// read.
bool cached_attribute_maps(ChExecutor& db, AttributeMapCache& cache, const HostSpec& host, const TraceSettings& cfg, bool* span_map,
                           bool* resource_map);

// This function returns the maps that filters, facets and columns may read. A map is usable when it is stored as a Map and
// traces.features enables it.
AttributeColumns attribute_columns(ChExecutor& db, AttributeMapCache& cache, const HostSpec& host, const TraceSettings& cfg);

}  // namespace trace
}  // namespace chdash
