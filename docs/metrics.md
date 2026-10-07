# OpenTelemetry metrics

ChDash can read the OpenTelemetry metrics that the OpenTelemetry Collector contrib ClickHouse exporter stores. The exporter writes one table for each kind of point: `<prefix>_gauge`, `<prefix>_sum`, `<prefix>_histogram`, `<prefix>_exponential_histogram` and `<prefix>_summary`. Metrics follow the host that the user selects in the UI. ChDash reads them through the `system_uri` of that host.

This document describes these items:

- The configuration.
- The endpoint for schema detection.
- The metrics browser (the Metrics view of `/observability`).
- The API behind the metrics browser.

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
| `table_prefix` | `otel_metrics` | Table name prefix. The kinds are `<prefix>_gauge` ... `<prefix>_summary`. |

The access control for `ServiceName` reuses `traces.service_allowlist`. Unknown keys in the block are startup errors. `/api/version` exposes `features.metrics.enabled`.

## Schema detection: `GET /api/metrics/meta`

Parameters: `host_id` (optional when one host is configured) and `refresh=1` to bypass the cache.

Like `/api/logs/meta`, the route is always registered. It reads only system tables (four queries for all five tables). It caches successful detections for 60 seconds. The route answers in these cases:

- Disabled: `200 {"enabled": false, "signal": "metrics", "error_code": "metrics_disabled", "message": ...}`.
- Unknown host: `404`.
- Failure of the connection or of a system table: `503 metrics_source_unavailable` / `metrics_schema_failed`.
- No kind exists: the response has `available_kinds: []`, `error_code: "metrics_tables_missing"` and a message.

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

The response reports a kind whose table is missing as `{"table": ..., "exists": false}`. It also lists the kind in `missing_kinds`. `schema_ok` checks the columns that each kind needs (for example `BucketCounts`/`ExplicitBounds` for histograms, `ValueAtQuantiles.Quantile`/`.Value` for summaries). Exemplars are the `Exemplars Nested(...)` columns of the exporter, flattened to `Exemplars.*` arrays. Summaries have none. `features.trace_correlation` is true when some kind has exemplar trace ids and span ids, and traces are enabled. The time bounds are table-wide. The service allowlist does not narrow them.

## Metrics browser: the Metrics view (`/observability/metrics`)

The Observability page (`/observability`, see `docs/traces.md`) has a **Metrics** tab when `/api/version` reports `features.metrics.enabled`. The dashboard caches the last answer in `chdash.pageNav.v1`, like Explorer and Traces. For this reason, the tabs are settled at the first paint. The time range is shared with the Traces and Logs views. A service that the user picks there opens its group of the catalog. The view has these parts:

- **Catalog** (left): by metric (the default), it shows each metric once. Each metric has these items:
  - Its type (`gauge`, `sum`, `hist`, `exp hist`, `summary`).
  - Its unit in words.
  - The number of services that send it.
  - Its services (color swatch and point count) under it, once it is open.

  **By service** lists each service with its metrics instead. The dashboard keeps the choice in `chdash.metricsCatalogBy.v1`. The units read as words: `s` seconds, `ms` milliseconds, `By` bytes, `1` ratio, `{call}` calls, `/s` rates. The UCUM unit is in the tooltip. If a range has no points, the catalog says when the latest point is. It also offers **Jump to last data**, a secondary action. This action selects the 24 hours up to the latest point (the time bounds of `/api/metrics/meta`).
- **Filter bar**: it has the same slots as on Traces and Logs:
  - The time range picker (relative ranges are resolved for each load).
  - A *Service* picker that narrows the catalog to one service.
  - The search field (metric name or service name). On a phone, typing opens the drawer of the catalog.
  - *Add panel* (up to 6 charts).
  - *Search* (reloads the catalog and the charts).
- **Panels**: a click in the catalog charts the metric in the active panel. An empty panel shows its controls disabled and **Pick a metric** (the search of the bar, or the drawer of the catalog on a phone). The header shows the name, the type, the unit, the temporality / monotonicity, the service and the description. The controls are:
  - Aggregation (the list that the server offers for the type).
  - Group-by (multi-select of point attribute keys).
  - Filter chips (`=` / `!=`, with autocompletion of the key and the value from `/api/metrics/attributes`).
  - The exemplar toggle.
- **Chart**: it has these elements:
  - Lines for each series (top 20 + "Other", dashed).
  - A value axis that knows the unit (`s`/`ms`/... -> durations, `By` -> bytes, `{thing}` -> counts, `/s` rates).
  - A crosshair tooltip with every series value.
  - Legend toggles (Alt+click shows one series only).
  - Exemplar diamonds.

  Exemplars sit on the value axis when the plotted aggregation has the unit of the metric (gauges, quantiles, averages). Otherwise (rates, counts), they sit on a strip at the bottom. The chart thins overlapping diamonds (it keeps the largest value). A click opens `/observability/traces/<trace_id>?span=<span_id>` (the own page of the trace). The chart draws a series that the exporter sends less often than the bucket across its regular empty buckets. Summaries show a note: their quantiles are per series only.

Everything is in the URL:

- `from` / `to` (raw range, for example `now-6h`).
- The first panel as `service`, `metric`, `kind`, `agg`, `group_by=k1,k2`, repeatable `filter=k=v` / `filter_not=k=v` and `exemplars=0`.
- Further panels as repeatable `panel=<the same parameters, URL-encoded>`.
- `active=<index>`.

## Metrics browser API

Four read-only routes back the Metrics view. They exist only when `metrics.enabled` is true (otherwise `404`, like the traces routes). They read the exporter tables through the `system_uri` of the host. They apply `traces.service_allowlist` to every query (`service_allowlist_predicate()` in `src/otel_allowlist.hpp`, shared with the traces routes). A service outside the allowlist has no data.

Common parameters: `host_id` (optional with one host) and `start_ms` / `end_ms` (required, epoch milliseconds, at most 90 days apart). The errors are:

- `400 invalid_metrics_range` (catalog window).
- `400 invalid_metrics_request` (missing or invalid parameter).
- `404 unknown_host`.
- `404 metrics_table_missing` (the table of the kind does not exist).
- `503 metrics_source_unavailable`.
- `503 metrics_query_failed` (ClickHouse error text).

Every query carries `SETTINGS max_execution_time = 30`. Every response has `timing_ms: {query, total}`.

`kind` is one of `gauge`, `sum`, `histogram`, `exponential_histogram`, `summary` (tables `<table_prefix>_<kind>`).

### `GET /api/metrics/catalog`

Every metric with points in the window, for each service. There is one `UNION ALL` branch for each existing kind table (the backend reads the existence from `system.tables` and caches it for 60 s):

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

`GROUP BY ServiceName, MetricName` follows the prefix of the sorting key of the exporter. The route returns at most 5000 entries (`truncated: true` beyond). The backend caches the answers for 60 s for each host, allowlist and window rounded to the minute (`cache: {hit, age_ms, ttl_ms}`). `refresh=1` bypasses the cache.

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

`temporality` is `delta`, `cumulative`, `mixed` or `null` (gauges, summaries). `monotonic` is set for sums only.

### `GET /api/metrics/attributes`

Parameters: `kind`, `service`, `metric`, the window, and the optional `filter` / `filter_not` (see series). The route reads point attributes (`Attributes`) only.

- Without `key`: `SELECT DISTINCT toString(arrayJoin(mapKeys(Attributes))) ... PREWHERE ServiceName = :s AND MetricName = :m AND <TimeUnix window> LIMIT 201` -> `{"keys": [...sorted], "truncated": false}` (200 keys at most).
- With `key`: the top 100 values by point count (`mapContains(Attributes, key)`, `GROUP BY v ORDER BY n DESC, v`) -> `{"key", "values": [{"value", "points"}], "truncated"}`. The route ignores the filters on the same key. In this way, the list stays usable for autocompletion.

### `GET /api/metrics/series`

Parameters:

- `kind`, `service`, `metric` and the window.
- `bucket_origin_ms` (the local midnight of the browser).
- `agg`.
- `group_by=k1,k2` (up to 5 point attribute keys).
- Repeatable `filter=k=v` / `filter_not=k=v` (split on the first `=`). Several values of one key become `IN` / `NOT IN`.
- `limit` (top-K groups, default 20, 1..50).
- Optional `step_ms`.

**Buckets.** The route uses the smallest bucket size that gives at most 120 buckets. The sizes are: 10 s, 15 s, 30 s, 1, 2, 5, 10, 15, 30 min, 1, 2, 3, 6, 12 h, 1, 2, 7 d. In practice, this gives 60-120 buckets (1 h -> 30 s, 24 h -> 15 min, 7 d -> 2 h). The buckets lie on a grid that is anchored at `bucket_origin_ms`, like the Traces analytics: `origin + intDiv(toUnixTimestamp64Milli(TimeUnix) - origin, size) * size`. For this reason, day buckets start at the local midnight. `timestamps` is the dense grid from the bucket that holds `start_ms` to the bucket that holds `end_ms`. Each series has one value (or `null`) for each timestamp. Rates (`rate`, `count_rate`) divide by the seconds of the bucket inside the window. The window usually cuts the first and the last bucket. For this reason, the rates do not under-report them.

**Aggregations** (`aggs` lists what the metric supports. The first is the default, except for summaries, which default to `p50`):

| Kind | Aggregations | Computation |
| --- | --- | --- |
| gauge | `avg`, `min`, `max`, `last`, `sum` | avg/min/max over every point of the group in the bucket. Per series (`cityHash64(Attributes, ResourceAttributes)`) the last value in the bucket (`argMax(Value, TimeUnix)`): `last` averages them, `sum` adds them. |
| sum, monotonic | `rate`, `increase` | Per-point deltas (below), `increase` = their sum per bucket, `rate` = increase / seconds of the bucket inside the window. |
| sum, not monotonic | `last`, `avg`, `min`, `max` (cumulative) or `sum`, `rate` (delta only) | Cumulative up/down counters are levels: gauge math. |
| histogram | `p50`, `p90`, `p95`, `p99`, `avg`, `count_rate`, `count` | Bucket counts added per group and bucket, quantiles interpolated. `avg = sum(Sum) / sum(Count)`, `count = sum(Count)`, `count_rate = count / seconds of the bucket inside the window`. |
| exponential_histogram | same as histogram | Exponential buckets merged, same quantile rule. |
| summary | `p<q>` for every stored quantile (`p0`, `p50`, `p90`, `p99`, `p100`...), `avg`, `count_rate` | Quantiles per series only. `avg` / `count_rate` from `Count` / `Sum` deltas. |

**Counter deltas and resets.** A delta point (`AggregationTemporality = 1`) contributes its value. A cumulative point (`2`) contributes its difference to the previous point of the same series. The backend finds the previous point with `lagInFrame(...) OVER (PARTITION BY cityHash64(Attributes, ResourceAttributes) ORDER BY TimeUnix)`. When the `StartTimeUnix` changed or the value decreased, it is a counter reset. The point then contributes its whole value, because the counter restarted from zero (Prometheus `increase()` rule). It does not contribute a negative jump. The first point of a series has no predecessor and no delta. For this reason, the scan starts `max(bucket, 15 min)` before `start_ms`, and the backend counts only the points inside the window. Deltas land in the bucket of the later point.

**Histogram differences.** The backend differences cumulative histogram points in the same way. It does this element by element on `BucketCounts` and on `Count` / `Sum`. A reset keeps the own counts of the point. These events are a reset:

- A new `StartTimeUnix`.
- A decrease of `Count`.
- A decrease of any bucket.
- A different bucket count.
- Different `ExplicitBounds`.

The backend then adds the differences with `sumForEach` for each group, bucket and bounds. If the series of a group use different bounds, the backend merges them in C++. It moves each source bucket to the target bucket that holds its upper bound. Metrics where all points are delta skip the window function entirely.

**Quantiles** follow Prometheus `histogram_quantile`:

- The rank is q x total count.
- The first bucket whose cumulative count reaches the rank holds the quantile. The backend interpolates it linearly between the bounds of the bucket.
- The first bucket starts at 0 when its upper bound is positive.
- A rank in the `+Inf` bucket answers the largest finite bound.

**Exponential histograms.** Bucket `i` of `PositiveBucketCounts` with offset `o` covers `(base^(o+i), base^(o+i+1)]`, with `base = 2^(2^-scale)`. Negative buckets mirror them. `ZeroCount` is the `[0, 0]` bucket. The backend aggregates the rows for each `(Scale, PositiveOffset, NegativeOffset)`. Then it merges them in C++ at the smallest scale of the group (index `k` at scale `s` becomes `floor(k / 2^(s - min_scale))`). The backend differences cumulative points when the scale and the offsets did not change. Otherwise, it treats them as a reset. Quantiles are linear inside the exponential bucket.

**Summaries.** Each producer precomputes the summary quantiles. It is not possible to merge them. A quantile aggregation ignores `group_by`. It draws one line for each series (the last value in each bucket). It answers `per_series: true` with a `note`. `avg` and `count_rate` aggregate normally.

**Top-K and "other".** The backend ranks groups by the sum of `|value|` over the buckets (quantiles: by observation count). The route returns the first `limit` groups. It folds the rest into one series `{"key": "__other__", "other": true}`:

- Additive values are added.
- Averages are weighted by point count.
- Min and max are kept.
- Histogram buckets are merged before the quantile.

Per-series summaries fold nothing (`truncated: true` only). ClickHouse returns at most 300000 (group, bucket) rows. Beyond that, `truncated_rows: true`.

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

`value_unit` is the unit of the metric. For `rate`, it is `<unit>/s` (`/s` without a unit). For `count_rate`, it is `/s`. For `count`, it is empty. A missing group-by attribute is `""` in `labels`. The series `key` joins the label values with `\u001f`.

### `GET /api/metrics/exemplars`

Parameters: `kind` (not `summary`), `service`, `metric`, the window, `bucket_origin_ms`, `step_ms`, the filters as for series, `per_bucket` (1..20, default 3) and `limit` (1..2000, default 500). The route returns the largest exemplars of each series bucket:

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

The exemplars are sorted by time. `trace_id` / `span_id` open `/observability/traces/<trace_id>?span=<span_id>`.

### Measured timings

The measurement used these conditions:

- The local stack with 880 thousand metric points. One ClickHouse served it, and other test clients also used this ClickHouse.
- The full 24-hour fixture window.
- A cold cache.
- The total on the server side.

The results are:

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

`tests/clickhouse-init/05-otel-logs-metrics.sql` creates the five exporter tables. The `otel_fixture` service fills them when `OTEL_FIXTURE_METRICS=1` (on in `tests/docker-compose.yml`). It uses the stored spans of the same window as the logs (the last 24 hours of the trace fixture):

| Table | Metric | Shape |
| --- | --- | --- |
| `otel_metrics_histogram` | `http.server.request.duration` (unit `s`) | One point per 10 s, `ServiceName` and span name (`Attributes['span.name']`); semantic-convention buckets `[0.005 ... 10]`; `sum(BucketCounts) = Count`. Half the services export delta (`AggregationTemporality = 1`), the other half cumulative (`2`). One exemplar per point: the slowest span of the interval (`Exemplars.Value = Max` for delta points). |
| `otel_metrics_sum` | `traces.span.metrics.calls` (unit `{call}`) | Cumulative monotonic span counts per 10 s with `span.name`, `span.kind` (`SPAN_KIND_*`) and `status.code` (`STATUS_CODE_*`). The alphabetically first service restarts once halfway through the spans of the window (a fresh stack holds spans only in its last ~55 minutes): its counters start again from zero with a new `StartTimeUnix` (one counter reset per series). |
| `otel_metrics_gauge` | `process.cpu.utilization` (unit `1`), `queue.depth` (unit `{message}`) | Synthetic waves every 10 s for 3 hosts per service (`Attributes['host.name']` = `<service>-0..2`). |
| `otel_metrics_summary` | `span.duration.summary` (unit `s`) | Per minute and service over the last hour: quantiles 0 / 0.5 / 0.9 / 0.99 / 1. |
| `otel_metrics_exponential_histogram` | `span.duration.exponential` (unit `s`) | Per minute and service over the last hour, scale 3, delta, one exemplar (the slowest span). |

On the local volume with 2 billion spans, this is about 880 thousand points, generated in about 16 s. The idempotency and `OTEL_FIXTURE_SIGNALS_FORCE=1` work as for logs (see `docs/logs.md`).
