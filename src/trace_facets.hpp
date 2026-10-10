#pragma once

// What the Traces page discovers about its source before and beside a search: the schema of the tables (meta), the (service, operation)
// pairs that fill the pickers (prefill), and the attribute keys and the values of one key (facets). The reads are bounded: a read
// cap, a time budget, and a cache that the server owns; an answer is marked estimated when a bound stopped the scan.

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

// Reads the columns of the table and whether the trace index table exists. Throws what ClickHouse throws. The attribute maps are read
// by read_attribute_maps (trace_attributes.hpp), which does not throw.
void read_schema(ChExecutor& db, const TraceSettings& traces, MetaOutcome* out);

// ---- prefill ----

// Service / operation prefill. The browser re-requests it on every time-range change and page load; each miss scans every span of the
// window (seconds on wide windows), so identical minute-aligned ranges share one result for a short TTL.
struct Prefill {
  std::vector<std::pair<std::string, std::string>> pairs;
  bool truncated = false;
  // A read bound stopped the scans: the pairs are then a subset.
  bool estimated = false;
  // The scans: passes run and rows read.
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

// The statement of one pass, and the pairs that it leaves out: the sorting key starts with (ServiceName, SpanName), so a scan that
// excludes the pairs already known (NOT IN on the key prefix) skips, through the primary index, every granule holding only them.
std::string prefill_excluded_sql(const std::set<std::pair<std::string, std::string>>& known);
std::string prefill_pass_sql(const std::string& table, int64_t from_ms, int64_t end_ms, const std::string& visibility,
                             const std::string& tag_filters, const std::string& excluded, uint64_t cap);

// Discovery only needs existence. The passes: (1) the seed, the newest kPrefillSeedMs of the window, whose pairs are usually most of the
// window's; (2) passes over the whole window, NOT IN the known pairs, each capped at kPrefillPassRows rows read, until one completes.
// Every pass is a complete scan of what it did not exclude unless its cap stopped it, so the list is exact when the last pass ran to
// its end; else (passes, the read budget or the time budget spent) it is a subset, answered as estimated. Throws what ClickHouse throws.
Prefill read_prefill(ChExecutor& db, const std::string& table, const std::string& visibility, const std::string& tag_filters,
                     int64_t aligned_start_ms, int64_t aligned_end_ms, uint64_t read_budget);

// ---- facets ----

// Attribute facets of the Traces search page: the most frequent keys of a sample, and the top values of one key. A value keeps
// kFacetMaxKeys + 1 keys at most.
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

// The most frequent attribute keys (span + resource) of the spans that match the filters, by the number of sampled spans carrying
// them. One capped pass reads only the key subcolumns of the maps.
std::string facet_keys_sql(const std::string& table, int64_t aligned_start_ms, int64_t aligned_end_ms, const std::string& visibility,
                           const std::string& span_filters, bool span, bool resource, uint64_t read_cap);
// The top values of one attribute key with their sampled span counts.
std::string facet_values_sql(const std::string& table, int64_t aligned_start_ms, int64_t aligned_end_ms, const std::string& visibility,
                             const std::string& span_filters, const std::string& key_scope, const std::string& key, int limit,
                             uint64_t read_cap);

// Throw what ClickHouse throws.
FacetKeys read_facet_keys(ChExecutor& db, const std::string& sql, uint64_t read_cap);
FacetValues read_facet_values(ChExecutor& db, const std::string& sql, uint64_t read_cap);

}  // namespace trace
}  // namespace chdash
