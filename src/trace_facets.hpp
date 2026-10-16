#pragma once

// This header declares what the Traces page discovers about its source. The page makes these discoveries before a search and next
// to a search. The discovery has three parts: the schema of the tables (meta), the (service, operation) pairs that fill the
// pickers (prefill), and the attribute keys and the values of one key (facets).
//
// Each read has bounds. A read cap and a time budget limit each read. The server owns the cache. An answer is marked estimated
// when a bound stops the scan.

#include "ch_executor.hpp"
#include "facet_limits.hpp"
#include "otel_settings.hpp"
#include "trace_filters.hpp"
#include "trace_sql.hpp"
#include "ttl_cache.hpp"

#include <cstdint>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace chdash {
namespace trace {

// ---- meta ----

struct MetaOutcome {
  bool schema_ok = false;         // the table has the columns that the page reads
  bool index_available = false;   // the trace index table exists and is not empty of a name
  bool span_attribute_map = false, resource_attribute_map = false;
};

// This function reads the columns of the table. It also checks whether the trace index table exists. It throws what ClickHouse
// throws. The attribute maps are read by read_attribute_maps (trace_attributes.hpp), which does not throw.
void read_schema(ChExecutor& db, const TraceSettings& traces, MetaOutcome* out);

// ---- prefill ----

// This comment describes the service and operation prefill. The browser requests the prefill again on each time-range change and
// each page load. Each cache miss scans every span of the window, which takes seconds on wide windows. Therefore identical
// minute-aligned ranges share one result for a short TTL.
struct Prefill {
  std::vector<std::pair<std::string, std::string>> pairs;
  bool truncated = false;
  // A read bound stopped the scans. The pairs are then a subset.
  bool estimated = false;
  // The number of scan passes and the number of rows read.
  int passes = 0;
  uint64_t read_rows = 0;
  int64_t start_ms = 0;
  int64_t end_ms = 0;
};
using PrefillCache = TtlCache<std::string, Prefill>;

constexpr uint64_t kPrefillPassRows = 20000000;
constexpr uint64_t kPrefillReadRows = 100000000;
constexpr int kPrefillMaxPasses = 8;
constexpr int64_t kPrefillSeedMs = 5 * 60 * 1000;
constexpr size_t kPrefillExcludeBytes = 128 * 1024;
constexpr size_t kPrefillHardLimit = 20000;
constexpr int64_t kPrefillAlignMs = 60 * 1000;

// This comment describes the statement of one pass and the pairs that it leaves out. The sorting key starts with (ServiceName,
// SpanName). A scan that excludes the known pairs (NOT IN on the key prefix) uses the primary index to skip every granule that
// holds only those pairs.
std::string prefill_excluded_sql(const std::set<std::pair<std::string, std::string>>& known);
std::string prefill_pass_sql(const std::string& table, int64_t from_ms, int64_t end_ms, const std::string& visibility,
                             const std::string& tag_filters, const std::string& excluded, uint64_t cap);

// Discovery needs only the existence of a pair. The discovery runs in passes. Pass 1 is the seed. It reads the newest
// kPrefillSeedMs of the window. Its pairs are usually most of the pairs of the window.
//
// Pass 2 and the later passes read the whole window. They use NOT IN on the known pairs. Each pass stops at kPrefillPassRows rows
// read. The passes continue until one pass completes.
//
// A pass that its cap does not stop scans all rows that it did not exclude. The list is then exact when the last pass runs to its
// end. Otherwise, the passes, the read budget or the time budget is spent. The list is then a subset, and the answer is marked
// estimated. This function throws what ClickHouse throws.
Prefill read_prefill(ChExecutor& db, const std::string& table, const std::string& visibility, const std::string& tag_filters,
                     int64_t aligned_start_ms, int64_t aligned_end_ms, uint64_t read_budget);

// ---- facets ----

// This section declares the attribute facets of the Traces search page. The facets give the most frequent keys of a sample, and
// the top values of one key. A value keeps at most kFacetMaxKeys + 1 keys.
struct FacetKeys {
  struct Key { std::string scope, key; uint64_t count = 0; };
  std::vector<Key> keys;
  uint64_t sampled_spans = 0;
  bool estimated = false;
  bool timed_out = false;
  uint64_t query_ms = 0;
};
struct FacetValues {
  std::vector<std::pair<std::string, uint64_t>> values;
  uint64_t spans_with_key = 0;
  uint64_t distinct_values = 0;
  bool estimated = false;
  bool timed_out = false;
  uint64_t query_ms = 0;
};
using FacetKeysCache = TtlCache<std::string, FacetKeys>;
using FacetValuesCache = TtlCache<std::string, FacetValues>;

// This function returns the SQL for the most frequent attribute keys (span + resource). It counts the spans that match the
// filters and that carry each key. The count uses the number of sampled spans. One capped pass reads only the key subcolumns of
// the maps.
std::string facet_keys_sql(const std::string& table, int64_t aligned_start_ms, int64_t aligned_end_ms, const std::string& visibility,
                           const std::string& span_filters, bool span, bool resource, uint64_t read_cap);
// This function returns the SQL for the top values of one attribute key. The result has the sampled span count of each value.
std::string facet_values_sql(const std::string& table, int64_t aligned_start_ms, int64_t aligned_end_ms, const std::string& visibility,
                             const std::string& span_filters, const std::string& key_scope, const std::string& key, int limit,
                             uint64_t read_cap);

// These functions throw what ClickHouse throws.
FacetKeys read_facet_keys(ChExecutor& db, const std::string& sql, uint64_t read_cap);
FacetValues read_facet_values(ChExecutor& db, const std::string& sql, uint64_t read_cap);

}  // namespace trace
}  // namespace chdash
