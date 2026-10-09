#include "mcp_api_tools.hpp"

// The window that the OpenTelemetry routes share, said once.
#define WINDOW "`start_ms` and `end_ms` (epoch milliseconds, together) or `lookback_minutes`"
#define TRACE_FILTERS                                                                                           \
  "Filters: `service`, `operation`, `status` (Error, Ok or Unset; a list means any of), `service_not`, "         \
  "`operation_not`, `status_not`, `tag` (`[span:|resource:]key=value`), `tag_not`, `tag_exists`, "               \
  "`tag_missing`, `min_duration_ms`, `max_duration_ms`."
#define LOG_FILTERS                                                                                            \
  "Filters: `service` (a list means any of), `severity_min` (a SeverityNumber from 0 to 24: 9 info, 13 warn, "  \
  "17 error), `q` (words in the message), `filter` (`[log:|resource:|scope:]key=value`)."

namespace chdash {

// One row for each read function of the ChDash API. The wrapper does the rest (see the header).
const std::vector<McpApiTool>& mcp_api_tools() {
  static const std::vector<McpApiTool> tools = {
      // ---- Explorer: the databases, the tables and their lineage -------------------------------------
      {"explorer_catalog", "explorer", "Explorer catalog",
       "The databases and the tables, views and dictionaries that the Explorer shows, with engine, rows and size. "
       "Params: `database` (one database only), `refresh` (1 skips the cache).",
       "GET", "/api/explorer/catalog", McpApiScope::Catalog},
      {"explorer_table", "explorer", "Explorer table",
       "Everything the Explorer knows about one table: columns, keys, engine, CREATE statement, size, parts, "
       "partitions, dependencies. Params: `database` and `table` (required), `refresh`.",
       "GET", "/api/explorer/table", McpApiScope::Table},
      {"explorer_table_data", "explorer", "Explorer table preview",
       "A preview of the first rows of one table (the Preview tab). Body: `database` and `table` (required), "
       "`limit` (1 to 500, default 100).",
       "POST", "/api/explorer/table/data", McpApiScope::Table},
      {"explorer_functions", "explorer", "Explorer functions",
       "The functions of the ClickHouse server (and their aliases) with their description, syntax and "
       "category. Params: `refresh`.",
       "GET", "/api/explorer/functions", McpApiScope::Free},
      {"explorer_storage", "explorer", "Explorer storage",
       "How the data is spread over the databases and the tables on disk, server wide. Params: `refresh`.",
       "GET", "/api/explorer/storage", McpApiScope::Free},
      {"explorer_graph", "explorer", "Explorer graph",
       "The topology of the server: tables, views, materialized views, dictionaries and the links between "
       "them (lineage), with the health of replicated tables. Params: `refresh`.",
       "GET", "/api/explorer/graph", McpApiScope::Free},
      {"explorer_graph_definition", "explorer", "Explorer graph object",
       "What one object of the graph is: its definition, its sources and its targets. Params: `database` and "
       "`table` (required).",
       "GET", "/api/explorer/graph/definition", McpApiScope::Table},
      {"explorer_names", "explorer", "Names for completion",
       "The names that the SQL editor completes: databases, tables, columns and their types. Params: "
       "`database`, `table`, `types` (1 adds the types of the columns).",
       "GET", "/api/meta", McpApiScope::Free},

      // ---- System: the health and the load of the server --------------------------------------------
      {"system_overview", "system", "System overview",
       "The state of the server in one answer: version, uptime, memory, running queries, merges, mutations, "
       "replication, errors and the databases by size. Params: `refresh`.",
       "GET", "/api/system/overview", McpApiScope::Free},
      {"system_series", "system", "System series",
       "Time series of the server (performance panels, disk growth). Params: `panel` (for example "
       "`disk_growth`), `scope`, `from_ms` and `to_ms` (epoch milliseconds), `refresh`.",
       "GET", "/api/system/series", McpApiScope::Free},
      {"system_disks", "system", "System disks",
       "Disks, free space and the size of the databases and tables on them. Params: `refresh`.",
       "GET", "/api/system/disks", McpApiScope::Free},
      {"system_queries", "system", "System top queries",
       "The queries of the server grouped by their normalized text, with count, time, rows, bytes and errors. "
       "Params: `from_ms` and `to_ms`, `sort`, `kind`, `errors` (all, with or without), `user`, `database`, "
       "`table`, `hide_chdash` (1 or 0), `refresh`.",
       "GET", "/api/system/queries", McpApiScope::Free},
      {"system_query", "system", "System query detail",
       "One group of queries by its hash: the normalized text, the runs, the slowest and the failed ones. "
       "Params: `hash` (required, from system_queries), `from_ms` and `to_ms`, `order` (duration), "
       "`hide_chdash`, `refresh`.",
       "GET", "/api/system/queries/{hash}", McpApiScope::Free},
      {"system_activity", "system", "System activity",
       "What the server does now: running queries, merges, mutations, fetches. Params: `refresh`.",
       "GET", "/api/system/activity", McpApiScope::Free},
      {"system_keeper", "system", "System Keeper",
       "The ClickHouse Keeper (ZooKeeper) state: sessions, nodes, replication queues. Params: `refresh`.",
       "GET", "/api/system/keeper", McpApiScope::Free},
      {"query_execution", "query", "Query execution",
       "The record of a query that ChDash ran: status, timings and profile counters. Params: `query_id` "
       "(required).",
       "GET", "/api/query/execution", McpApiScope::Free},

      // ---- Traces: the OpenTelemetry traces of the Observability page -------------------------------
      {"traces_meta", "observability", "Traces schema",
       "How the trace tables look on this host (columns, version, the features that are on). Call it first "
       "to know what the other traces tools can do.",
       "GET", "/api/traces/meta", McpApiScope::Free, "traces"},
      {"traces_search", "observability", "Search traces",
       "Search traces (Jaeger semantics: a trace is listed when one of its spans matches every filter). "
       "Window: " WINDOW ". " TRACE_FILTERS " `limit`.",
       "GET", "/api/traces/search", McpApiScope::Free, "traces"},
      {"traces_analytics", "observability", "Traces analytics",
       "The counts and the duration percentiles of the matching traces over time. Window and filters as in "
       "traces_search, plus `bucket_origin_ms`, `align_buckets`, `charts`.",
       "GET", "/api/traces/analytics", McpApiScope::Free, "traces"},
      {"traces_service_map", "observability", "Traces service map",
       "The services of the matching traces and the calls between them, with counts, errors and latency. "
       "Window and filters as in traces_search, plus `scope` (entry or root), `detail` (one service), "
       "`sample_factor`.",
       "GET", "/api/traces/service_map", McpApiScope::Free, "traces"},
      {"traces_heatmap", "observability", "Traces latency heatmap",
       "How the trace durations spread over time (counts in log-scaled latency rows). Window and filters as "
       "in traces_search, plus `rows` (8 to 80), `bucket_origin_ms`, `align_buckets`.",
       "GET", "/api/traces/heatmap", McpApiScope::Free, "traces"},
      {"traces_deltas", "observability", "Traces differences",
       "What the traces in a time and duration box have that the others do not (attributes that differ). "
       "Window and filters as in traces_search, plus the box: `t0` and `t1` (trace start, epoch ms), `d0` "
       "and `d1` (duration, ms), `baseline` (outside or all), `sample`.",
       "GET", "/api/traces/deltas", McpApiScope::Free, "traces"},
      {"traces_services", "observability", "Traces services",
       "Each service with its request count, errors and P50, P95 and P99 latency, and its endpoints. Window "
       "and filters as in traces_search, plus `scope` (entry or root), `exact` (1), `detail` (one service).",
       "GET", "/api/traces/services", McpApiScope::Free, "traces"},
      {"traces_services_db", "observability", "Traces database statements",
       "The database statements seen in spans (db.query.text, db.statement) with count and latency. Window "
       "and filters as in traces_search.",
       "GET", "/api/traces/services/db", McpApiScope::Free, "traces"},
      {"traces_prefill", "observability", "Traces services and operations",
       "The pairs (service, operation) seen in the window. Window: " WINDOW ". Only the `tag` filters apply.",
       "GET", "/api/traces/prefill", McpApiScope::Free, "traces"},
      {"traces_facets", "observability", "Traces attribute keys",
       "The attribute keys of the spans in the window, most frequent first. Window and filters as in "
       "traces_search.",
       "GET", "/api/traces/facets", McpApiScope::Free, "traces"},
      {"traces_facet_values", "observability", "Traces attribute values",
       "The values of one attribute key with their counts. Params: `scope` (span or resource), `key` "
       "(required), `limit`, plus the window and filters of traces_search.",
       "GET", "/api/traces/facet_values", McpApiScope::Free, "traces"},
      {"traces_trace", "observability", "Trace detail",
       "One whole trace: every span with its timings, status and attributes. Params: `trace_id` (required, "
       "32 hexadecimal characters), `start_ms` and `end_ms` when known.",
       "GET", "/api/traces/trace", McpApiScope::Free, "traces"},
      {"traces_linked_from", "observability", "Traces linked from",
       "The spans of other traces that link to one span. Params: `trace_id` and `span_id` (required), "
       "`start_ms` and `end_ms`.",
       "GET", "/api/traces/linked_from", McpApiScope::Free, "traces"},
      {"traces_context", "observability", "Traces around a span",
       "The spans that ran around one moment on the same service, host, pod or attribute. Params: "
       "`timestamp_ns` (required), `window_ms`, `filter` (any, service, host, pod or attribute), `service`, "
       "`value`, `attr_scope`, `attr_key`, `attr_value`, `direction` (around, older or newer), `cursor_ns`, "
       "`cursor_span_id`, `limit`.",
       "GET", "/api/traces/context", McpApiScope::Free, "traces"},
      {"traces_spans", "observability", "Search spans",
       "Search spans instead of traces, newest first. Window: " WINDOW ". " TRACE_FILTERS " `kind` "
       "(repeatable), `columns` (`span:http.route,resource:host.name`, at most 20), `limit` (at most 500), "
       "`cursor` (from the previous page).",
       "GET", "/api/traces/spans", McpApiScope::Free, "traces"},
      {"traces_span", "observability", "Span detail",
       "One span with its attributes, events and links. Params: `trace_id`, `span_id`, `timestamp_ns` "
       "(required).",
       "GET", "/api/traces/span", McpApiScope::Free, "traces"},
      {"traces_logs", "observability", "Logs of a trace",
       "The log records written during one trace (or one span). Params: `trace_id` (required), `span_id`, "
       "`limit`.",
       "GET", "/api/traces/logs", McpApiScope::Free, "traces"},

      // ---- Logs: the OpenTelemetry logs of the Observability page -----------------------------------
      {"logs_meta", "observability", "Logs schema",
       "How the log table looks on this host (columns, text search mode). Call it first to know what the "
       "other logs tools can do.",
       "GET", "/api/logs/meta", McpApiScope::Free, "logs"},
      {"logs_search", "observability", "Search logs",
       "Search log records, newest first. Window: " WINDOW ". " LOG_FILTERS " `limit`, `cursor` (from the "
       "previous page).",
       "GET", "/api/logs/search", McpApiScope::Free, "logs"},
      {"logs_histogram", "observability", "Logs histogram",
       "Record counts over time by severity class. Window and filters as in logs_search, plus `buckets` (10 "
       "to 300), `bucket_origin_ms`.",
       "GET", "/api/logs/histogram", McpApiScope::Free, "logs"},
      {"logs_context", "observability", "Logs around a record",
       "The records around one record. Params: `ts_ns` and `tie` (the two halves of a record id, from "
       "logs_search), `preset` (anything, service, host or trace), `service`, `host`, `trace_id`, "
       "`window_ms`, `limit` (each side).",
       "GET", "/api/logs/context", McpApiScope::Free, "logs"},
      {"logs_patterns", "observability", "Logs patterns",
       "The message templates that the matching records fall into, with counts (Drain). Window and filters "
       "as in logs_search, plus `max_patterns`, `sample`, `buckets`.",
       "GET", "/api/logs/patterns", McpApiScope::Free, "logs"},
      {"logs_services", "observability", "Logs services",
       "The services that wrote logs in the window, with counts. Window and filters as in logs_search.",
       "GET", "/api/logs/services", McpApiScope::Free, "logs"},
      {"logs_facets", "observability", "Logs attribute keys",
       "The attribute keys of the records in the window, most frequent first. Window and filters as in "
       "logs_search.",
       "GET", "/api/logs/facets", McpApiScope::Free, "logs"},
      {"logs_facet_values", "observability", "Logs attribute values",
       "The values of one field with their counts. Params: `scope` (log, resource, scope or column), `key` "
       "(required), `limit`, plus the window and filters of logs_search.",
       "GET", "/api/logs/facet_values", McpApiScope::Free, "logs"},

      // ---- Metrics: the OpenTelemetry metrics of the Observability page -----------------------------
      {"metrics_meta", "observability", "Metrics schema",
       "How the metric tables look on this host (the kinds that exist). Call it first.",
       "GET", "/api/metrics/meta", McpApiScope::Free, "metrics"},
      {"metrics_catalog", "observability", "Metrics catalog",
       "The metrics reported in the window, by service and kind, with unit and description. Params: "
       "`start_ms` and `end_ms` (required, epoch ms), `refresh`.",
       "GET", "/api/metrics/catalog", McpApiScope::Free, "metrics"},
      {"metrics_attributes", "observability", "Metric attributes",
       "The attribute keys of one metric, or the values of one key. Params: `metric`, `service`, `kind` "
       "(gauge, sum, histogram, exponential_histogram or summary), `key`, `start_ms` and `end_ms` "
       "(required).",
       "GET", "/api/metrics/attributes", McpApiScope::Free, "metrics"},
      {"metrics_series", "observability", "Metric series",
       "One metric as time series. Params: `metric` and `service` (required), `kind`, `agg` (avg, min, max, "
       "sum, last, rate, p50, p95 or p99, by kind), `group_by` (an attribute), `filter` and `filter_not` "
       "(`key=value`), `step_ms`, `start_ms` and `end_ms` (required), `limit`.",
       "GET", "/api/metrics/series", McpApiScope::Free, "metrics"},
      {"metrics_exemplars", "observability", "Metric exemplars",
       "Sample points of a metric with the trace that produced them. Params: as metrics_series, plus "
       "`per_bucket`.",
       "GET", "/api/metrics/exemplars", McpApiScope::Free, "metrics"},

      // ---- Library: the saved queries ------------------------------------------------------------------
      {"query_library", "query", "Query library",
       "The saved queries and their folders (the Query page library of the server). Answers `not_enabled` "
       "when the configuration has no query_library. Params: `recursive`.",
       "GET", "/api/query-library", McpApiScope::Free},

      // ---- Query helpers: functions of ChDash that read no data ---------------------------------------
      {"format_sql", "query", "Format SQL",
       "Format SQL text like the Format button of the Query page (it reads the ClickHouse version of the "
       "host to parse it). Body: `sql` (required) or `sqls` (a list), `line_width`.",
       "POST", "/api/format", McpApiScope::Free},
  };
  return tools;
}

McpIdentity mcp_api_identity(const McpApiTool& tool) {
  const std::string group = tool.group;
  if (std::string(tool.name) == "query_library") return McpIdentity::Page;
  return McpIdentity::Runner;
}

}  // namespace chdash
