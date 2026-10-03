# OpenTelemetry metrics

ChDash can read OpenTelemetry metrics stored by the OpenTelemetry Collector
contrib ClickHouse exporter. The exporter writes one table per point kind:
`<prefix>_gauge`, `<prefix>_sum`, `<prefix>_histogram`,
`<prefix>_exponential_histogram` and `<prefix>_summary`. Metrics follow the
host selected in the UI and are read through that host's `system_uri`.

This document covers the configuration, the schema-detection endpoint, the
metrics browser (the Metrics view of `/observability`) and the API behind it.

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

## Metrics browser: the Metrics view (`/observability/metrics`)

The Observability page (`/observability`, see `docs/traces.md`) has a
**Metrics** tab when `/api/version` reports `features.metrics.enabled` (the
last answer is cached in `chdash.pageNav.v1`, like Explorer and Traces, so
the tabs are settled at first paint). Its time range is shared with the
Traces and Logs views; a service picked there opens its group of the
catalog. The view has:

- **Catalog** (left): by metric (the default), each metric once with its
  type (`gauge`, `sum`, `hist`, `exp hist`, `summary`), its unit in words and
  the number of services sending it, its services (colour swatch and point
  count) under it once opened; **By service** lists each service with its
  metrics instead (the choice is kept in `chdash.metricsCatalogBy.v1`).
  Units read as words: `s` seconds, `ms` milliseconds, `By` bytes, `1`
  ratio, `{call}` calls, `/s` rates; the UCUM unit is in the tooltip. The
  search box filters by metric or service name. A range without points says
  when the latest point is and offers **Jump to last data** (the 24 hours up
  to it, `/api/metrics/meta` time bounds), a secondary action.
- **Toolbar**: the Traces time range picker (relative ranges are resolved for
  each load), *Add panel* (up to 6 charts) and *Refresh*.
- **Panels**: a click in the catalog charts the metric in the active panel.
  An empty panel shows its controls disabled and **Pick a metric** (the
  catalog's search, its drawer on a phone).
  The header shows the name, type, unit, temporality / monotonicity, service
  and description. Controls: aggregation (the list the server offers for the
  type), group-by (multi-select of point attribute keys), filter chips
  (`=` / `!=`, key and value autocompletion from `/api/metrics/attributes`)
  and the exemplar toggle.
- **Chart**: lines per series (top 20 + "Other", dashed), a unit-aware value
  axis (`s`/`ms`/... -> durations, `By` -> bytes, `{thing}` -> counts,
  `/s` rates), a crosshair tooltip with every series value, legend toggles
  (Alt+click shows one series only) and exemplar diamonds. Exemplars sit on
  the value axis when the plotted aggregation has the metric unit (gauges,
  quantiles, averages) and on a strip at the bottom otherwise (rates,
  counts); overlapping diamonds are thinned (largest value kept) and a click
  opens `/observability/traces/<trace_id>?span=<span_id>` (the Traces view, in
  place). Series exported less often than
  the bucket are drawn across their regular empty buckets. Summaries show a
  note: their quantiles are per series only.

Everything is in the URL: `from` / `to` (raw range, e.g. `now-6h`), then the
first panel as `service`, `metric`, `kind`, `agg`, `group_by=k1,k2`,
repeatable `filter=k=v` / `filter_not=k=v`, `exemplars=0`; further panels as
repeatable `panel=<the same parameters, URL-encoded>`; `active=<index>`.

## Metrics browser API

Four read-only routes back the Metrics view. They exist only when
`metrics.enabled` is true (otherwise `404`, like the traces routes), read the
exporter tables through the host's `system_uri`, and apply
`traces.service_allowlist` to every query (`service_allowlist_predicate()` in
`src/otel_allowlist.hpp`, shared with the traces routes). A service outside
the allowlist simply has no data.

Common parameters: `host_id` (optional with one host), `start_ms` / `end_ms`
(required, epoch milliseconds, at most 90 days apart). Errors:
`400 invalid_metrics_range` (catalog window) / `400 invalid_metrics_request`
(missing or invalid parameter), `404 unknown_host`, `404 metrics_table_missing`
(the kind's table does not exist), `503 metrics_source_unavailable`,
`503 metrics_query_failed` (ClickHouse error text). Every query carries
`SETTINGS max_execution_time = 30`; every response has
`timing_ms: {query, total}`.

`kind` is one of `gauge`, `sum`, `histogram`, `exponential_histogram`,
`summary` (tables `<table_prefix>_<kind>`).

### `GET /api/metrics/catalog`

Every metric with points in the window, per service. One `UNION ALL` branch
per existing kind table (existence read from `system.tables`, cached 60 s):

```sql
SELECT kind, service, metric, unit, description, tmin, tmax, mono_min, mono_max, points FROM (
  SELECT 'histogram' AS kind, toString(ServiceName) AS service, MetricName AS metric,
         any(MetricUnit) AS unit, any(MetricDescription) AS description,
         toString(min(AggregationTemporality)) AS tmin, toString(max(AggregationTemporality)) AS tmax,
         '' AS mono_min, '' AS mono_max, toString(count()) AS points
  FROM otel.otel_metrics_histogram
  PREWHERE TimeUnix >= fromUnixTimestamp64Milli(:start) AND TimeUnix <= fromUnixTimestamp64Milli(:end)
  WHERE <allowlist> GROUP BY ServiceName, MetricName
  UNION ALL ...)
ORDER BY service, metric, kind LIMIT 5001
```

`GROUP BY ServiceName, MetricName` follows the exporter's sorting key prefix.
At most 5000 entries (`truncated: true` beyond). Answers are cached 60 s per
host, allowlist and minute-rounded window (`cache: {hit, age_ms, ttl_ms}`;
`refresh=1` bypasses the cache).

```json
{"v": 1, "source_host_id": "local", "range": [s, e],
 "services": [{"name": "api_service", "metrics": [
   {"name": "http.server.request.duration", "kind": "histogram", "unit": "s",
    "description": "Duration of HTTP server requests.", "temporality": "delta",
    "monotonic": null, "points": 8641}]}],
 "service_count": 12, "metric_count": 72, "truncated": false, "limit": 5000,
 "kinds": ["gauge", "sum", "histogram", "exponential_histogram", "summary"],
 "timing_ms": {...}, "cache": {...}}
```

`temporality` is `delta`, `cumulative`, `mixed` or `null` (gauges, summaries);
`monotonic` is set for sums only.

### `GET /api/metrics/attributes`

`kind`, `service`, `metric`, window, optional `filter` / `filter_not` (see
series). Point attributes (`Attributes`) only.

- Without `key`: `SELECT DISTINCT toString(arrayJoin(mapKeys(Attributes)))
  ... PREWHERE ServiceName = :s AND MetricName = :m AND <TimeUnix window>
  LIMIT 201` -> `{"keys": [...sorted], "truncated": false}` (200 keys max).
- With `key`: the top 100 values by point count (`mapContains(Attributes, key)`,
  `GROUP BY v ORDER BY n DESC, v`) -> `{"key", "values": [{"value", "points"}],
  "truncated"}`. Filters on the same key are ignored so the list stays usable
  for autocompletion.

### `GET /api/metrics/series`

Parameters: `kind`, `service`, `metric`, window, `bucket_origin_ms` (the
browser's local midnight), `agg`, `group_by=k1,k2` (up to 5 point attribute
keys), repeatable `filter=k=v` / `filter_not=k=v` (split on the first `=`;
several values of one key become `IN` / `NOT IN`), `limit` (top-K groups,
default 20, 1..50), optional `step_ms`.

**Buckets.** The smallest of 10 s, 15 s, 30 s, 1, 2, 5, 10, 15, 30 min, 1, 2,
3, 6, 12 h, 1, 2, 7 d giving at most 120 buckets (60-120 in practice: 1 h ->
30 s, 24 h -> 15 min, 7 d -> 2 h). They lie on a grid anchored at
`bucket_origin_ms` like the Traces analytics:
`origin + intDiv(toUnixTimestamp64Milli(TimeUnix) - origin, size) * size`, so
day buckets start at local midnight. `timestamps` is the dense grid from the
bucket holding `start_ms` to the one holding `end_ms`; each series has one
value (or `null`) per timestamp. Rates (`rate`, `count_rate`) divide by the
seconds of the bucket inside the window, so the first and last buckets, which
the window usually cuts, are not under-reported.

**Aggregations** (`aggs` lists what the metric supports, the first is the
default except summaries, which default to `p50`):

| Kind | Aggregations | Computation |
| --- | --- | --- |
| gauge | `avg`, `min`, `max`, `last`, `sum` | avg/min/max over every point of the group in the bucket. Per series (`cityHash64(Attributes, ResourceAttributes)`) the last value in the bucket (`argMax(Value, TimeUnix)`): `last` averages them, `sum` adds them. |
| sum, monotonic | `rate`, `increase` | Per-point deltas (below), `increase` = their sum per bucket, `rate` = increase / seconds of the bucket inside the window. |
| sum, not monotonic | `last`, `avg`, `min`, `max` (cumulative) or `sum`, `rate` (delta only) | Cumulative up/down counters are levels: gauge math. |
| histogram | `p50`, `p90`, `p95`, `p99`, `avg`, `count_rate`, `count` | Bucket counts added per group and bucket, quantiles interpolated; `avg = sum(Sum) / sum(Count)`, `count = sum(Count)`, `count_rate = count / seconds of the bucket inside the window`. |
| exponential_histogram | same as histogram | Exponential buckets merged, same quantile rule. |
| summary | `p<q>` for every stored quantile (`p0`, `p50`, `p90`, `p99`, `p100`...), `avg`, `count_rate` | Quantiles per series only; `avg` / `count_rate` from `Count` / `Sum` deltas. |

**Counter deltas and resets.** A delta point (`AggregationTemporality = 1`)
contributes its value. A cumulative point (`2`) contributes its difference to
the previous point of the same series, found with
`lagInFrame(...) OVER (PARTITION BY cityHash64(Attributes, ResourceAttributes)
ORDER BY TimeUnix)`. When the `StartTimeUnix` changed or the value decreased
it is a counter reset: the point contributes its whole value (the counter
restarted from zero, Prometheus `increase()` rule) instead of a negative
jump. The first point of a series has no predecessor and no delta, so the
scan starts `max(bucket, 15 min)` before `start_ms` and only points inside the
window are counted. Deltas land in the bucket of the later point.

**Histogram differences.** Cumulative histogram points are differenced the
same way, element by element on `BucketCounts` and on `Count` / `Sum`. A reset
(new `StartTimeUnix`, `Count` decrease, any bucket decrease, different bucket
count or different `ExplicitBounds`) keeps the point's own counts. Differences
are then added with `sumForEach` per group, bucket and bounds; groups whose
series use different bounds are merged in C++ by moving each source bucket to
the target bucket holding its upper bound. All-delta metrics skip the window
function entirely.

**Quantiles** follow Prometheus `histogram_quantile`: rank = q x total count;
the first bucket whose cumulative count reaches the rank holds the quantile,
linearly interpolated between its bounds; the first bucket starts at 0 when
its upper bound is positive; a rank in the `+Inf` bucket answers the largest
finite bound.

**Exponential histograms.** Bucket `i` of `PositiveBucketCounts` with offset
`o` covers `(base^(o+i), base^(o+i+1)]`, `base = 2^(2^-scale)`; negative
buckets mirror them and `ZeroCount` is the `[0, 0]` bucket. Rows are
aggregated per `(Scale, PositiveOffset, NegativeOffset)`, then merged in C++
at the smallest scale of the group (index `k` at scale `s` becomes
`floor(k / 2^(s - min_scale))`). Cumulative points are differenced when the
scale and offsets did not change (otherwise treated as a reset). Quantiles are
linear inside the exponential bucket.

**Summaries.** Summary quantiles are precomputed by each producer and cannot
be merged: a quantile aggregation ignores `group_by`, draws one line per
series (the last value in each bucket) and answers `per_series: true` with a
`note`. `avg` and `count_rate` aggregate normally.

**Top-K and "other".** Groups are ranked by the sum of `|value|` over the
buckets (quantiles: by observation count). The first `limit` are returned,
the rest are folded into one series `{"key": "__other__", "other": true}`:
additive values are added, averages weighted by point count, min/max kept,
histogram buckets merged before the quantile. Per-series summaries fold
nothing (`truncated: true` only). ClickHouse returns at most 300000 (group,
bucket) rows; beyond that `truncated_rows: true`.

```json
{"v": 1, "source_host_id": "local", "kind": "histogram", "service": "api_service",
 "metric": "http.server.request.duration", "unit": "s", "description": "...",
 "temporality": "delta", "monotonic": null, "points": 8641,
 "agg": "p95", "default_agg": "p50",
 "aggs": ["p50", "p90", "p95", "p99", "avg", "count_rate", "count"],
 "value_unit": "s", "range": [s, e], "bucket_ms": 900000, "bucket_origin_ms": 0,
 "group_by": ["span.name"], "filters": [{"key": "k", "op": "=", "value": "v"}],
 "timestamps": [t0, t1, ...],
 "series": [{"key": "request.validate", "labels": {"span.name": "request.validate"},
             "values": [0.1994, null, ...], "total": 123.4, "other": false}],
 "other_series_count": 0, "group_count": 1, "top_k": 20, "truncated": false,
 "truncated_rows": false, "per_series": false, "note": null, "timing_ms": {...}}
```

`value_unit` is the metric unit, `<unit>/s` for `rate` (`/s` without a unit),
`/s` for `count_rate` and empty for `count`. A missing group-by attribute is
`""` in `labels`; the series `key` joins the label values with `\u001f`.

### `GET /api/metrics/exemplars`

`kind` (not `summary`), `service`, `metric`, window, `bucket_origin_ms`,
`step_ms`, filters as for series, `per_bucket` (1..20, default 3), `limit`
(1..2000, default 500). The largest exemplars of each series bucket:

```sql
SELECT toString(<bucket of e.1>) AS b, toString(toUnixTimestamp64Milli(e.1)), toString(e.2), e.3, e.4, attrs
FROM (SELECT arrayJoin(arrayZip(`Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.TraceId`, `Exemplars.SpanId`)) AS e,
             toJSONString(Attributes) AS attrs
      FROM otel.otel_metrics_histogram
      PREWHERE ServiceName = :s AND MetricName = :m AND <TimeUnix window>
      WHERE <allowlist> <filters> AND notEmpty(`Exemplars.TraceId`))
WHERE notEmpty(e.3) AND e.1 >= :start AND e.1 <= :end
ORDER BY e.2 DESC, e.1 LIMIT :per_bucket BY b LIMIT :limit + 1
```

```json
{"v": 1, "kind": "histogram", "service": "api_service", "metric": "...",
 "bucket_ms": 900000, "exemplars": [{"t": 1789780980214, "value": 0.19,
 "trace_id": "0000...46fa88", "span_id": "00000000a37d4400",
 "attributes": {"span.name": "request.validate"}}],
 "truncated": false, "per_bucket": 3, "traces_enabled": true, "timing_ms": {...}}
```

Exemplars are sorted by time; `trace_id` / `span_id` open
`/observability/traces/<trace_id>?span=<span_id>`.

### Measured timings

Local stack (880 thousand metric points, one ClickHouse shared with other
test clients), full 24-hour fixture window, cold cache, server-side total:

| Request | Time |
| --- | --- |
| catalog (12 services, 72 metrics, 5 tables) | 70 ms |
| series gauge `queue.depth` by `host.name` | 40 ms |
| series cumulative counter, rate by `status.code` | 35 ms |
| series cumulative counter, 2 group keys, top 2 + other | 80-130 ms |
| series delta histogram p95 | 20 ms |
| series cumulative histogram p95 (window function) | 95 ms |
| series exponential histogram / summary | 10-15 ms |
| attributes keys / values | 8 ms |
| exemplars (97 buckets x 3) | 15 ms |

## Test fixture

`tests/clickhouse-init/05-otel-logs-metrics.sql` creates the five exporter
tables; the `otel_fixture` service fills them when `OTEL_FIXTURE_METRICS=1`
(on in `tests/docker-compose.yml`), from the stored spans of the same window
as the logs (last 24 hours of the trace fixture):

| Table | Metric | Shape |
| --- | --- | --- |
| `otel_metrics_histogram` | `http.server.request.duration` (unit `s`) | One point per 10 s, `ServiceName` and span name (`Attributes['span.name']`); semantic-convention buckets `[0.005 ... 10]`; `sum(BucketCounts) = Count`. Half the services export delta (`AggregationTemporality = 1`), the other half cumulative (`2`). One exemplar per point: the slowest span of the interval (`Exemplars.Value = Max` for delta points). |
| `otel_metrics_sum` | `traces.span.metrics.calls` (unit `{call}`) | Cumulative monotonic span counts per 10 s with `span.name`, `span.kind` (`SPAN_KIND_*`) and `status.code` (`STATUS_CODE_*`). The alphabetically first service restarts once halfway through the spans of the window (a fresh stack holds spans only in its last ~55 minutes): its counters start again from zero with a new `StartTimeUnix` (one counter reset per series). |
| `otel_metrics_gauge` | `process.cpu.utilization` (unit `1`), `queue.depth` (unit `{message}`) | Synthetic waves every 10 s for 3 hosts per service (`Attributes['host.name']` = `<service>-0..2`). |
| `otel_metrics_summary` | `span.duration.summary` (unit `s`) | Per minute and service over the last hour: quantiles 0 / 0.5 / 0.9 / 0.99 / 1. |
| `otel_metrics_exponential_histogram` | `span.duration.exponential` (unit `s`) | Per minute and service over the last hour, scale 3, delta, one exemplar (the slowest span). |

On the local 2-billion-span volume this is about 880 thousand points,
generated in about 16 s. Idempotency and `OTEL_FIXTURE_SIGNALS_FORCE=1` work
as for logs (see `docs/logs.md`).
