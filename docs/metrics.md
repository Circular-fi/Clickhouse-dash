# OpenTelemetry metrics

ChDash can read OpenTelemetry metrics stored by the OpenTelemetry Collector
contrib ClickHouse exporter. The exporter writes one table per point kind:
`<prefix>_gauge`, `<prefix>_sum`, `<prefix>_histogram`,
`<prefix>_exponential_histogram` and `<prefix>_summary`. Metrics follow the
host selected in the UI and are read through that host's `system_uri`.

This document covers the configuration and the schema-detection endpoint.
The metrics browser builds on it.

## Configuration

```hcl
metrics {
  enabled      = true
  database     = "otel"
  table_prefix = "otel_metrics"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Turns the metrics source on. |
| `database` | `otel` | Database of the exporter metrics tables. |
| `table_prefix` | `otel_metrics` | Table name prefix; kinds are `<prefix>_gauge` ... `<prefix>_summary`. |

`ServiceName` access control reuses `traces.service_allowlist`. Unknown keys
in the block are startup errors. `/api/version` exposes
`features.metrics.enabled`.

## Schema detection: `GET /api/metrics/meta`

Parameters: `host_id` (optional when one host is configured), `refresh=1` to
bypass the cache.

Like `/api/logs/meta`, the route is always registered, reads only system
tables (four queries for all five tables), and caches successful detections
for 60 seconds. Disabled: `200 {"enabled": false, "signal": "metrics",
"error_code": "metrics_disabled", "message": ...}`. Unknown host: `404`.
Connection or system-table failure: `503 metrics_source_unavailable` /
`metrics_schema_failed`. When no kind exists the response has
`available_kinds: []`, `error_code: "metrics_tables_missing"` and a message.

Response (abridged):

```json
{
  "enabled": true, "signal": "metrics", "source_host_id": "local",
  "database": "otel", "table_prefix": "otel_metrics",
  "service_allowlist": ["*"], "service_filter_applied": false,
  "kinds": {
    "histogram": {
      "table": "otel_metrics_histogram", "exists": true, "schema_ok": true, "missing_columns": [],
      "engine": "MergeTree",
      "sorting_key": "ServiceName, MetricName, Attributes, toUnixTimestamp64Nano(TimeUnix)",
      "primary_key": "...", "partition_key": "toDate(TimeUnix)",
      "rows": 103692, "parts": 1, "bytes_on_disk": 1234567,
      "time_column": "TimeUnix", "time_type": "DateTime64(9)",
      "time_bounds": {"min_ms": 1789780980000, "max_ms": 1789867380999,
                      "source": "system.parts.min_max_time", "precision": "second", "scope": "table"},
      "attributes": {"point": {"column": "Attributes", "kind": "map", "type": "..."},
                     "resource": {"...": "..."}, "scope": {"...": "..."}},
      "exemplars": {"present": true,
                    "columns": ["Exemplars.FilteredAttributes", "Exemplars.TimeUnix", "Exemplars.Value",
                                "Exemplars.SpanId", "Exemplars.TraceId"],
                    "trace_id": true, "span_id": true, "time_unix": true, "value": true,
                    "filtered_attributes": true},
      "skip_indexes": ["..."], "columns": ["..."]
    },
    "gauge": {"...": "..."}, "sum": {"...": "..."},
    "exponential_histogram": {"...": "..."}, "summary": {"...": "..."}
  },
  "available_kinds": ["gauge", "sum", "histogram", "exponential_histogram", "summary"],
  "missing_kinds": [],
  "rows": 878512,
  "time_bounds": {"min_ms": 1789780970000, "max_ms": 1789867380999, "...": "..."},
  "features": {"browse": true, "gauges": true, "sums": true, "histograms": true,
               "exponential_histograms": true, "summaries": true,
               "exemplars": true, "trace_correlation": true, "traces_enabled": true},
  "cache": {"hit": false, "age_ms": 0, "ttl_ms": 60000}
}
```

A kind whose table is missing is reported as `{"table": ..., "exists": false}`
and listed in `missing_kinds`. `schema_ok` checks the columns each kind needs
(for example `BucketCounts`/`ExplicitBounds` for histograms,
`ValueAtQuantiles.Quantile`/`.Value` for summaries). Exemplars are the
exporter's `Exemplars Nested(...)` columns, flattened to `Exemplars.*` arrays;
summaries have none. `features.trace_correlation` is true when some kind has
exemplar trace and span ids and traces are enabled. Time bounds are
table-wide (not narrowed by the service allowlist).

## Test fixture

`tests/clickhouse-init/05-otel-logs-metrics.sql` creates the five exporter
tables; the `otel_fixture` service fills them when `OTEL_FIXTURE_METRICS=1`
(on in `tests/docker-compose.yml`), from the stored spans of the same window
as the logs (last 24 hours of the trace fixture):

| Table | Metric | Shape |
| --- | --- | --- |
| `otel_metrics_histogram` | `http.server.request.duration` (unit `s`) | One point per 10 s, `ServiceName` and span name (`Attributes['span.name']`); semantic-convention buckets `[0.005 ... 10]`; `sum(BucketCounts) = Count`. Half the services export delta (`AggregationTemporality = 1`), the other half cumulative (`2`). One exemplar per point: the slowest span of the interval (`Exemplars.Value = Max` for delta points). |
| `otel_metrics_sum` | `traces.span.metrics.calls` (unit `{call}`) | Cumulative monotonic span counts per 10 s with `span.name`, `span.kind` (`SPAN_KIND_*`) and `status.code` (`STATUS_CODE_*`). The alphabetically first service restarts once in the middle of the window: its counters start again from zero with a new `StartTimeUnix` (one counter reset per series). |
| `otel_metrics_gauge` | `process.cpu.utilization` (unit `1`), `queue.depth` (unit `{message}`) | Synthetic waves every 10 s for 3 hosts per service (`Attributes['host.name']` = `<service>-0..2`). |
| `otel_metrics_summary` | `span.duration.summary` (unit `s`) | Per minute and service over the last hour: quantiles 0 / 0.5 / 0.9 / 0.99 / 1. |
| `otel_metrics_exponential_histogram` | `span.duration.exponential` (unit `s`) | Per minute and service over the last hour, scale 3, delta, one exemplar (the slowest span). |

On the local 2-billion-span volume this is about 880 thousand points,
generated in about 16 s. Idempotency and `OTEL_FIXTURE_SIGNALS_FORCE=1` work
as for logs (see `docs/logs.md`).
