#include "trace_attributes.hpp"

#include "ch_block_value.hpp"
#include "log.hpp"
#include "trace_sql.hpp"

namespace chdash {
namespace trace {

AttributeMapCache::Options attribute_map_cache_options() {
  AttributeMapCache::Options options;
  options.ttl = std::chrono::seconds(60);
  options.failure_backoff = std::chrono::milliseconds(0);
  options.serve_stale_on_error = false;
  options.max_entries = 256;
  return options;
}

namespace {

std::string cache_key(const HostSpec& host, const TraceSettings& cfg) { return host.system_uri + '\x1f' + cfg.database + '\x1f' + cfg.table; }

}  // namespace

bool read_attribute_maps(ChExecutor& db, const TraceSettings& cfg, bool* span_map, bool* resource_map, std::string* error) {
  *span_map = false;
  *resource_map = false;
  try {
    db.select(attribute_maps_sql(cfg.database, cfg.table), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string name = ch_block_text_at(block, 0, row);
        const std::string type = ch_block_text_at(block, 1, row);
        const bool map = type.rfind("Map(", 0) == 0;
        if (name == "SpanAttributes") *span_map = map;
        if (name == "ResourceAttributes") *resource_map = map;
      }
    });
    return true;
  } catch (const std::exception& e) {
    if (error) *error = e.what();
    return false;
  }
}

void store_attribute_maps(AttributeMapCache& cache, const HostSpec& host, const TraceSettings& cfg, bool span_map, bool resource_map) {
  cache.get(
      cache_key(host, cfg),
      [&](AttributeMaps& value, std::string&, std::string&) {
        value = AttributeMaps{span_map, resource_map};
        return true;
      },
      true);
}

bool cached_attribute_maps(ChExecutor& db, AttributeMapCache& cache, const HostSpec& host, const TraceSettings& cfg, bool* span_map,
                           bool* resource_map) {
  const auto result = cache.get(
      cache_key(host, cfg),
      [&](AttributeMaps& value, std::string& code, std::string& message) {
        if (!read_attribute_maps(db, cfg, &value.span_map, &value.resource_map, &message)) {
          code = "trace_attribute_maps_failed";
          return false;
        }
        return true;
      });
  *span_map = result.value && result.value->span_map;
  *resource_map = result.value && result.value->resource_map;
  if (!result.value) {
    // Not "no Map columns": the read failed. The caller says so (503) and the log keeps the reason.
    log_event(LogLevel::Warn, "traces.attribute_maps_failed", {{"table", cfg.database + "." + cfg.table}, {"error", result.error_message}});
    return false;
  }
  return true;
}

AttributeColumns attribute_columns(ChExecutor& db, AttributeMapCache& cache, const HostSpec& host, const TraceSettings& cfg) {
  AttributeColumns cols;
  cols.span_enabled = cfg.features.span_attributes;
  cols.resource_enabled = cfg.features.resource_attributes;
  cols.lookup_failed = !cached_attribute_maps(db, cache, host, cfg, &cols.span_map, &cols.resource_map);
  return cols;
}

}  // namespace trace
}  // namespace chdash
