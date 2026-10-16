#pragma once

// The settings of the OpenTelemetry pages (Traces, Logs, Metrics) are in the `observability` block of the configuration
// (docs/configuration.md). The block holds the settings of every host. A host can change where its tables are
// (`clickhouse.host { observability { traces { table = ... } } }`). The configuration resolves them once.
// Each HostSpec holds the settings that apply to it (health_runner.hpp). The code reads them from the host that it serves.

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

struct TraceFeatureSettings {
  bool service_filter = true;
  bool operation_filter = true;
  bool status_filter = true;
  bool duration_filter = true;
  bool resource_attributes = true;
  bool span_attributes = true;
  bool events = true;
  bool links = true;
};

struct TraceSettings {
  bool enabled = false;
  bool analytics = false;
  std::string database = "otel";
  std::string table = "otel_traces";
  std::string trace_index_table = "otel_traces_trace_id_ts";
  std::vector<std::string> service_allowlist{"*"};
  int default_lookback_minutes = 60;
  int max_lookback_minutes = 7 * 24 * 60;
  size_t search_limit = 100;
  size_t max_spans_per_trace = 10000;
  // Attributes that the trace header shows as key: value chips. The root span comes first.
  // Then comes the first span that has the key.
  std::vector<std::string> highlighted_attributes{
      "service.version", "deployment.environment.name", "deployment.environment", "http.route", "user.id"};
  // "Linked from" lookups scan the window of the trace, widened by this margin.
  int linked_from_margin_minutes = 60;
  TraceFeatureSettings features;
};

// OpenTelemetry logs (ClickHouse exporter otel_logs table). ServiceName access control reuses traces.service_allowlist.
struct LogSettings {
  bool enabled = false;
  std::string database = "otel";
  std::string table = "otel_logs";
  int max_lookback_minutes = 7 * 24 * 60;
  size_t search_limit = 200;
  // "token": hasToken, backed by a tokenbf_v1 or text index on Body.
  // "substring": an ILIKE-style scan. "off": no search on Body.
  std::string body_search = "token";
  // Logs of one trace (trace detail): at most trace_logs_limit records.
  // The read starts at the trace start minus trace_margin_before_seconds.
  // It ends at the trace end plus trace_margin_after_seconds.
  // Records are often written after their span.
  size_t trace_logs_limit = 1000;
  int trace_margin_before_seconds = 5;
  int trace_margin_after_seconds = 30;
};

// OpenTelemetry metrics (ClickHouse exporter <table_prefix>_{gauge,sum,
// histogram,exponential_histogram,summary} tables).
struct MetricSettings {
  bool enabled = false;
  std::string database = "otel";
  std::string table_prefix = "otel_metrics";
};

// A host can change two things. It can turn a signal on or off, and it can set where its tables are.
// All other settings are the same for every host: the limits, the allowlist and the features.
struct OtelHostOverride {
  std::optional<bool> traces_enabled;
  std::optional<std::string> traces_database;
  std::optional<std::string> traces_table;
  std::optional<std::string> traces_index_table;
  std::optional<bool> logs_enabled;
  std::optional<std::string> logs_database;
  std::optional<std::string> logs_table;
  std::optional<bool> metrics_enabled;
  std::optional<std::string> metrics_database;
  std::optional<std::string> metrics_table_prefix;
  bool any() const {
    return traces_enabled || traces_database || traces_table || traces_index_table || logs_enabled || logs_database ||
           logs_table || metrics_enabled || metrics_database || metrics_table_prefix;
  }
};

// The settings of the three signals for one host.
struct OtelSettings {
  TraceSettings traces;
  LogSettings logs;
  MetricSettings metrics;
};

// `defaults` with the override of a host applied.
inline OtelSettings apply_otel_override(OtelSettings defaults, const OtelHostOverride& over) {
  if (over.traces_enabled) defaults.traces.enabled = *over.traces_enabled;
  if (over.traces_database) defaults.traces.database = *over.traces_database;
  if (over.traces_table) defaults.traces.table = *over.traces_table;
  if (over.traces_index_table) defaults.traces.trace_index_table = *over.traces_index_table;
  if (over.logs_enabled) defaults.logs.enabled = *over.logs_enabled;
  if (over.logs_database) defaults.logs.database = *over.logs_database;
  if (over.logs_table) defaults.logs.table = *over.logs_table;
  if (over.metrics_enabled) defaults.metrics.enabled = *over.metrics_enabled;
  if (over.metrics_database) defaults.metrics.database = *over.metrics_database;
  if (over.metrics_table_prefix) defaults.metrics.table_prefix = *over.metrics_table_prefix;
  return defaults;
}

// The tables ("database.table") that the system user must read for the signals that are on for a host.
// The tables include the skipping indices that the Logs and Metrics pages read. The access audit checks them (health_runner.hpp).
inline std::vector<std::string> otel_system_reads(const OtelSettings& otel) {
  std::vector<std::string> out;
  const auto add = [&out](const std::string& database, const std::string& table) {
    if (!database.empty() && !table.empty()) out.push_back(database + "." + table);
  };
  if (otel.traces.enabled) {
    add(otel.traces.database, otel.traces.table);
    add(otel.traces.database, otel.traces.trace_index_table);
  }
  if (otel.logs.enabled) add(otel.logs.database, otel.logs.table);
  if (otel.metrics.enabled) {
    for (const char* kind : {"gauge", "sum", "histogram"}) add(otel.metrics.database, otel.metrics.table_prefix + "_" + kind);
  }
  if (otel.logs.enabled || otel.metrics.enabled) out.push_back("system.data_skipping_indices");
  return out;
}

} // namespace chdash
