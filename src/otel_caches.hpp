#pragma once

// The caches hold what the Logs, Metrics and Traces-logs routes read about a source before they query it.
// This data includes the columns and indexes of its table, the kind tables that exist, and the answer of the detection of the meta routes.
// Each cache is a TtlCache. It makes one read per source at a time (single-flight). Its key comes from the configuration only.
// The Server owns the caches (server.hpp), so each Server has its own. The route code gets the cache as an argument.

#include "ttl_cache.hpp"

#include <chrono>
#include <set>
#include <string>
#include <vector>

namespace chdash {

// ---- /api/logs/meta and /api/metrics/meta: the serialized answer of the detection. The cache keeps successful lookups only. It has no back-off and no stale answer.
constexpr auto kSignalMetaCacheTtl = std::chrono::seconds(60);
constexpr size_t kSignalMetaCacheMaxEntries = 256;

using SignalMetaCache = TtlCache<std::string, std::string>;

inline SignalMetaCache::Options signal_meta_cache_options() {
  SignalMetaCache::Options options;
  options.ttl = kSignalMetaCacheTtl;
  options.failure_backoff = std::chrono::milliseconds(0);
  options.serve_stale_on_error = false;
  options.max_entries = kSignalMetaCacheMaxEntries;
  options.value_bytes = [](const std::string& body) { return body.size(); };
  return options;
}

// ---- The Logs page: which optional columns and indexes the exporter layout has (api_logs.cpp). The cache keeps them for kSchemaCacheTtl.
// A table that does not exist yet is kept for a few seconds only. The exporter creates it.
constexpr auto kSchemaCacheTtl = std::chrono::seconds(60);

struct LogsSchema {
  bool exists = false;
  bool timestamp_time = false;
  bool trace_id = false;
  bool span_id = false;
  bool trace_flags = false;
  bool scope_name = false;
  bool scope_version = false;
  bool log_attributes = false;
  bool resource_attributes = false;
  bool scope_attributes = false;
  // Map(String, String) attribute columns. The facets read their key subcolumns. A JSON column filters, but it is not faceted.
  bool log_attributes_map = false;
  bool resource_attributes_map = false;
  bool scope_attributes_map = false;
  bool body_lower_index = false;
  bool body_token_index = false;
};

using LogsSchemaCache = TtlCache<std::string, LogsSchema>;

inline LogsSchemaCache::Options logs_schema_cache_options() {
  LogsSchemaCache::Options options;
  options.ttl = kSchemaCacheTtl;
  options.max_entries = 256;
  options.ttl_of = [](const LogsSchema& schema) -> std::chrono::milliseconds {
    return schema.exists ? std::chrono::milliseconds(kSchemaCacheTtl) : std::chrono::milliseconds(5000);
  };
  return options;
}

// ---- The logs of a trace: the schema facts of the query, from one system.columns read (api_trace_logs.cpp). A missing table is not kept.
// The exporter can create the table at any time.
constexpr auto kLogColumnsCacheTtl = std::chrono::seconds(60);
constexpr size_t kLogColumnsCacheMaxEntries = 256;

struct LogColumns {
  bool exists = false;
  bool timestamp_time = false;
  bool trace_id = false;
  bool span_id = false;
  bool scope_name = false;
  bool event_name = false;
  std::string log_attributes_type;
  std::string resource_attributes_type;
  std::vector<std::string> missing;
};

using LogColumnsCache = TtlCache<std::string, LogColumns>;

inline LogColumnsCache::Options log_columns_cache_options() {
  LogColumnsCache::Options options;
  options.ttl = kLogColumnsCacheTtl;
  options.max_entries = kLogColumnsCacheMaxEntries;
  options.ttl_of = [](const LogColumns& columns) -> std::chrono::milliseconds {
    return columns.exists ? std::chrono::milliseconds(kLogColumnsCacheTtl) : std::chrono::milliseconds(0);
  };
  return options;
}

// ---- The Metrics page: the kind tables of a source. The cache keeps them like the catalog (metrics_service.hpp).
constexpr auto kCatalogTtl = std::chrono::seconds(60);
constexpr size_t kCatalogCacheMaxEntries = 256;

// The kinds whose table exists. Among them are the kinds whose table has ScopeName and ScopeVersion (the exporter writes both).
// A series is told apart from another series by its scope too, when the kind has these scope columns.
struct KindTables {
  std::set<std::string> kinds;
  std::set<std::string> with_scope;
};

using KindTablesCache = TtlCache<std::string, KindTables>;

inline KindTablesCache::Options kind_tables_cache_options() {
  KindTablesCache::Options options;
  options.ttl = kCatalogTtl;
  options.max_entries = kCatalogCacheMaxEntries;
  return options;
}

}  // namespace chdash
