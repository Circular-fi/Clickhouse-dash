# OpenTelemetry metrics

ChDash can read the OpenTelemetry metrics that the OpenTelemetry Collector contrib ClickHouse exporter stores. The exporter writes one table for each kind of point: `<prefix>_gauge`, `<prefix>_sum`, `<prefix>_histogram`, `<prefix>_exponential_histogram` and `<prefix>_summary`. Metrics follow the host that the user selects in the UI. ChDash reads them through the `system_uri` of that host.

This document describes these items:

- The configuration.
- The endpoint for schema detection.
- The metrics browser (the Metrics view of `/observability`).
- The API behind the metrics browser.

## Configuration

```hcl
observability {
  metrics {
    enabled      = true
    database     = "otel"
    table_prefix = "otel_metrics"
  }
}
```

(The top-level `metrics {}` block of older configurations is still valid. A host can override `enabled`, `database` and `table_prefix` in `clickhouse.host { observability { metrics { } } }`. See docs/configuration.md, "Where the tables of a host are".)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Enables the metrics source. |
| `database` | `otel` | Database that contains the exporter metrics tables. |
| `table_prefix` | `otel_metrics` | Prefix of the table names. The kinds are `<prefix>_gauge` ... `<prefix>_summary`. |

The access control for `ServiceName` is `observability.service_allowlist`. In older configurations, the key is `traces.service_allowlist`. This one allowlist applies to all three signals. An unknown key in the block causes a startup error. `/api/version` shows `features.metrics.enabled`.

## Schema detection: `GET /api/metrics/meta`

Parameters: `host_id` (optional when one host is configured) and `refresh=1` to bypass the cache.

Like `/api/logs/meta`, the server always has this route. It reads only system tables, with four queries for all five tables. It caches successful detections for 60 seconds. The route gives an answer in these cases:

- Disabled: `200 {"enabled": false, "signal": "metrics", "error_code": "metrics_disabled", "message": ...}`.
- Unknown host: `404`.
- Failure of the connection or of a system table: `503 metrics_source_unavailable` / `metrics_schema_failed`.
- No kind table exists: the response has `available_kinds: []`, `error_code: "metrics_tables_missing"` and a message.

Response (shortened):

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

The response reports a kind whose table does not exist as `{"table": ..., "exists": false}`. It also lists this kind in `missing_kinds`. `schema_ok` checks the columns that each kind needs. For example, histograms need `BucketCounts` and `ExplicitBounds`, and summaries need `ValueAtQuantiles.Quantile` and `.Value`.

The exemplars are the `Exemplars Nested(...)` columns of the exporter. ChDash flattens them to `Exemplars.*` arrays. Summaries have none. `features.trace_correlation` is true when a kind has exemplar trace ids and span ids, and traces are enabled. The time bounds apply to the whole table. The service allowlist does not narrow them.

## Metrics browser: the Metrics view (`/observability/metrics`)

The Observability page (`/observability`, see `docs/traces.md`) has a **Metrics** tab when `/api/version` reports `features.metrics.enabled`. The dashboard caches the last answer in `chdash.pageNav.v1`, as Explorer and Traces do. For this reason, the page sets the tabs at the first paint. The Traces and Logs views share the time range. If the user selects a service there, the catalog opens the group of that service. The view has these parts:

- **Catalog** (left): in the default mode, by metric, each metric appears once. Each metric has these items:
  - Its type (`gauge`, `sum`, `hist`, `exp hist`, `summary`).
  - Its unit in words.
  - The number of services that send it.
  - Its services (color swatch and point count) below it, when it is open.

  **By service** lists each service with its metrics instead. The dashboard saves the choice in `chdash.metricsCatalogBy.v1`. The units appear as words: `s` seconds, `ms` milliseconds, `By` bytes, `1` ratio, `{call}` calls, `/s` rates. The UCUM unit is in the tooltip. If a range has no points, the catalog shows when the latest point is. The catalog also offers **Jump to last data**, a secondary action that selects the 24 hours up to the latest point (the time bounds of `/api/metrics/meta`).
- **Filter bar**: it has the same slots as on Traces and Logs:
  - The time range picker. The page resolves relative ranges at each load.
  - A *Service* picker that narrows the catalog to one service.
  - The search field (metric name or service name). On a phone, the catalog drawer opens when the user enters a search term.
  - *Add panel* (6 charts at most).
  - *Search* (reloads the catalog and the charts).
- **Panels**: a click on a metric in the catalog charts that metric in the active panel.
  - If one service sends the metric, the chart appears at once.
  - For a metric that several services send, a click on its name charts it and leaves its services open.
  - The panel then says **Choose a service for <metric>** and lists the services that send it as buttons.
  - A chart shows one service at a time, because the series API needs a `service`.
  - The chevron folds and unfolds the services. On the keyboard, Left and Right do the same, and Enter charts the metric.
  - When a link opens a panel with a metric and no service, the panel asks the same question. If only one service sends the metric, the panel takes that service at once.
  - An empty panel shows its controls disabled and the text **Pick a metric**. To select a metric, use the search of the bar, or the catalog drawer on a phone.
  - The header shows the name, the type, the unit, the temporality / monotonicity, the service and the description. The controls are:
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

  The exemplars sit on the value axis when the plotted aggregation has the unit of the metric (gauges, quantiles, averages). Otherwise (rates, counts), they sit on a strip at the bottom. The chart removes diamonds that overlap and keeps the largest one. A click opens `/observability/traces/<trace_id>?span=<span_id>`, the own page of the trace.

For a series that the exporter sends less often than the bucket size, the chart draws a line across the regular empty buckets. Summaries show a note: their quantiles are per series only.

The URL holds all state of the view:

- `from` / `to` (raw range, for example `now-6h`).
- The first panel uses `service`, `metric`, `kind`, `agg`, `group_by=k1,k2`, the repeatable `filter=k=v` / `filter_not=k=v` and `exemplars=0`.
- Further panels use the repeatable `panel=<the same parameters, URL-encoded>`. The page keeps the first 6 panels and ignores the others. An address therefore cannot open more panels than the Add button allows.
- `active=<index>`.

## Metrics browser API

Four read-only routes support the Metrics view. The routes exist when `metrics.enabled` is true for at least one host. For a host with metrics disabled, the route answers `404` `metrics_disabled`, as the traces routes do.

The routes read the exporter tables through the `system_uri` of the host. Every query applies `traces.service_allowlist` (`service_allowlist_predicate()` in `src/otel_allowlist.hpp`, shared with the traces routes). A service outside the allowlist has no data.

Common parameters: `host_id` (optional with one host) and `start_ms` / `end_ms` (required, epoch milliseconds, at most 90 days apart). The routes return these errors:

- `400 invalid_metrics_range` (catalog window).
- `400 invalid_metrics_request` (absent or invalid parameter).
- `404 unknown_host`.
- `404 metrics_table_missing` (the table of the kind does not exist).
- `503 metrics_source_unavailable`.
- `503 metrics_query_failed` (ClickHouse error text).

Every query sets `SETTINGS max_execution_time = 30`. The statements that read or rank the series also set `max_memory_usage = 2000000000`, `max_bytes_before_external_group_by = 1000000000` and `max_bytes_before_external_sort = 1000000000`. Every response has `timing_ms: {query, total}`.

The SQL text does not contain the service, the metric, the attribute keys or the attribute values of a request. ClickHouse receives them as query parameters (`{p1:String}`, `{p2:String}`, ...), separate from the text. A quote mark, a backslash or a new line in a value is a plain character. The same rule applies to the logs of a trace (`GET /api/traces/logs`: the trace id, the span id and the services).

`kind` is one of `gauge`, `sum`, `histogram`, `exponential_histogram`, `summary` (tables `<table_prefix>_<kind>`).

### `GET /api/metrics/catalog`

The route returns every metric that has points in the window, for each service. `start_ms` and `end_ms` (epoch milliseconds, together) set the window. When both are omitted, the window is the last 24 hours up to now. The catalog groups every point of its window. The query has one `UNION ALL` branch for each kind table that exists. The backend reads the existence from `system.tables` and caches it for 60 s:

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

`GROUP BY ServiceName, MetricName` follows the prefix of the sorting key of the exporter. The route returns at most 5000 entries. Beyond that, it sets `truncated: true`. The scan reads at most 200 million rows (`max_rows_to_read` with `read_overflow_mode = 'break'`). When the scan reaches the limit, it stops, and `estimated: true` shows that the point counts are partial.

The backend caches the answers for 60 s for each host, allowlist and window. It rounds the window to the minute (`cache: {hit, age_ms, ttl_ms}`). `refresh=1` bypasses the cache.

```json
{"v": 1, "source_host_id": "local", "range": [s, e],
 "services": [{"name": "api_service", "metrics": [
   {"name": "http.server.request.duration", "kind": "histogram", "unit": "s",
    "description": "Duration of HTTP server requests.", "temporality": "delta",
    "monotonic": null, "monotonic_mixed": null, "points": 8641}]}],
 "service_count": 12, "metric_count": 72, "truncated": false, "estimated": false, "limit": 5000,
 "kinds": ["gauge", "sum", "histogram", "exponential_histogram", "summary"],
 "timing_ms": {...}, "cache": {...}}
```

`temporality` is `delta`, `cumulative`, `mixed` or `null` (gauges, summaries). The route sets `monotonic` and `monotonic_mixed` for sums only. `monotonic` is true when at least one series of the metric is monotonic. `monotonic_mixed` is true when some series are monotonic and some are not. In that case, the aggregations that the metric offers follow the monotonic series. The other series can show a rate that is not a rate.

### `GET /api/metrics/attributes`

Parameters: `kind`, `service`, `metric`, the window, and the optional `filter` / `filter_not` (see series). The route reads only point attributes (`Attributes`).

- Without `key`: `SELECT DISTINCT toString(arrayJoin(mapKeys(Attributes))) ... PREWHERE ServiceName = :s AND MetricName = :m AND <TimeUnix window> LIMIT 201` -> `{"keys": [...sorted], "truncated": false}` (200 keys at most).
- With `key`: the top 100 values by point count (`mapContains(Attributes, key)`, `GROUP BY v ORDER BY n DESC, v`) -> `{"key", "values": [{"value", "points"}], "truncated"}`. The route ignores the filters on the same key. So, the list stays usable for autocompletion.

### `GET /api/metrics/series`

Parameters:

- `kind`, `service`, `metric` and the window.
- `bucket_origin_ms` (the local midnight of the browser).
- `agg`.
- `group_by=k1,k2` (5 point attribute keys at most).
- Repeatable `filter=k=v` / `filter_not=k=v`. The route divides each value at the first `=`. Several values of one key become `IN` / `NOT IN`.
- `limit` (top-K groups, default 20, 1..50).
- Optional `step_ms`.

**Buckets.** The route uses the smallest bucket size that gives at most 120 buckets. Sizes are: 10 s, 15 s, 30 s, 1, 2, 5, 10, 15, 30 min, 1, 2, 3, 6, 12 h, 1, 2, 7 d. In practice, this gives 60-120 buckets (1 h -> 30 s, 24 h -> 15 min, 7 d -> 2 h). The buckets lie on a grid anchored at `bucket_origin_ms`, as in the Traces analytics: `origin + intDiv(toUnixTimestamp64Milli(TimeUnix) - origin, size) * size`. Day buckets therefore start at the local midnight.

`timestamps` is the dense grid from the bucket that holds `start_ms` to the bucket that holds `end_ms`. Each series has one value (or `null`) for each timestamp. Rates (`rate`, `count_rate`) divide by the seconds of the bucket inside the window. The window usually cuts the first and the last bucket. The rates therefore do not under-report them.

**Aggregations** (`aggs` lists the aggregations that the metric supports. The first one is the default, except for summaries. Summaries default to `p50`):

| Kind | Aggregations | Computation |
| --- | --- | --- |
| gauge | `avg`, `min`, `max`, `last`, `sum` | avg, min and max over every point of the group in the bucket. For each series (see "Series identity"), the route uses the last value in the bucket (`argMax(Value, TimeUnix)`). `last` averages these values, and `sum` adds them. |
| sum, monotonic | `rate`, `increase` | Per-point deltas (see below). `increase` is the sum of the deltas per bucket. `rate` is the increase divided by the seconds of the bucket inside the window. |
| sum, not monotonic | `last`, `avg`, `min`, `max` (cumulative) or `sum`, `rate` (delta only) | Cumulative up/down counters are levels, so the route uses gauge math. |
| histogram | `p50`, `p90`, `p95`, `p99`, `avg`, `count_rate`, `count` | The route adds the bucket counts for each group and bucket. It interpolates the quantiles. `avg = sum(Sum) / sum(Count)`, `count = sum(Count)`, `count_rate = count / seconds of the bucket inside the window`. |
| exponential_histogram | same as histogram | The route merges the exponential buckets and uses the same quantile rule. |
| summary | `p<q>` for every stored quantile (`p0`, `p50`, `p90`, `p99`, `p100`...), `avg`, `count_rate` | Quantiles apply per series only. `avg` and `count_rate` use the `Count` and `Sum` deltas. |

**Series identity.** Two points belong to one series when they have the same `Attributes` and `ResourceAttributes`, and the same `ScopeName` and `ScopeVersion`. The series is `cityHash64(Attributes, ResourceAttributes, ScopeName, ScopeVersion)`. Two instrumentation scopes can write the same metric with the same attributes. Without the scope, their points form one series. The differences between them then show false resets.

A table that has no `ScopeName` or no `ScopeVersion` column uses the series `cityHash64(Attributes, ResourceAttributes)`. The backend reads these columns from `system.columns` for the kind tables. It keeps them for 60 s.

**Counter deltas and resets.** A delta point (`AggregationTemporality = 1`) contributes its value. A cumulative point (`2`) contributes its difference to the previous point of the same series. The backend finds the previous point with `lagInFrame(...) OVER (PARTITION BY <series> ORDER BY TimeUnix)`. When the `StartTimeUnix` changes or the value decreases, this is a counter reset. The point then contributes its whole value, because the counter restarted from zero (Prometheus `increase()` rule). The point does not contribute a negative jump.

The first point of a series has no predecessor and no delta. For this reason, the scan starts `max(bucket, 15 min)` before `start_ms`. The backend counts only the points inside the window. Each delta goes to the bucket of the later point.

**Histogram differences.** The backend takes the differences of cumulative histogram points in the same way. It does this element by element on `BucketCounts`, and on `Count` / `Sum`. A reset keeps the point's own counts. These events cause a reset:

- A new `StartTimeUnix`.
- A decrease of `Count`.
- A decrease of any bucket.
- A different bucket count.
- Different `ExplicitBounds`.

The backend then adds the differences with `sumForEach` for each group, bucket and bounds. The rows are in the order of their bounds (`ORDER BY g, b, bstr`). When the series of a group use different bounds, the backend merges them in C++ onto the sorted union of all their bounds. Each source bucket goes to the bucket that has its upper bound. A row with no bounds is one `+Inf` bucket.

The result does not depend on the order of the rows. A metric where all points are delta skips the window function entirely.

**Quantiles** follow Prometheus `histogram_quantile`:

- The rank is q x total count.
- The first bucket whose cumulative count reaches the rank holds the quantile. The backend interpolates linearly between the bounds of that bucket.
- The first bucket starts at 0 when its upper bound is positive.
- A rank in the `+Inf` bucket returns the largest finite bound.

**Exponential histograms.** Bucket `i` of `PositiveBucketCounts` with offset `o` covers `(base^(o+i), base^(o+i+1)]`, where `base = 2^(2^-scale)`. Negative buckets mirror these buckets. `ZeroCount` is the `[0, 0]` bucket.

The backend aggregates the rows for each `(Scale, PositiveOffset, NegativeOffset)`. Then it merges them in C++ at the smallest scale of the group. Index `k` at scale `s` becomes `floor(k / 2^(s - min_scale))`. The backend takes the differences of cumulative points when the scale and the offsets stay the same. Otherwise, it treats them as a reset. Quantiles are linear inside the exponential bucket.

**Summaries.** Each producer computes the summary quantiles in advance. It is not possible to merge them. A quantile aggregation ignores `group_by`. It draws one line for each series, with the last value in each bucket. The response then has `per_series: true` and a `note`. `avg` and `count_rate` aggregate normally.

**Top-K and "other".** The backend ranks the groups by the sum of `|value|` over the buckets. For quantiles, it ranks them by observation count. The route returns the first `limit` groups. It folds the rest into one series `{"key": "__other__", "other": true}`:

- The route adds the additive values.
- The route weights the averages by point count.
- The route keeps the min and max.
- The route merges the histogram buckets before the quantile.

ClickHouse ranks the groups when the request groups by attributes, and for the series of a summary. The route sends two statements. The first statement wraps the statement of the buckets. It computes the score of each group with the formula of the aggregation. It orders the groups by score and then by key. It returns the keys of the `limit` best groups, the number of groups and the sum of the scores.

The second statement reads the cells of those groups. It folds every other group into the group `__other__` in the SQL. So, ClickHouse sends at most `limit + 1` groups. The number of groups, and of buckets, of the window does not change the rows that come back. The keys of the best groups are query parameters.

`group_count` is the number of groups of the window. `other_series_count` is the number of groups that the other series fold. The `total` of the other series is the part of the sum of the scores that the best groups leave. A request that does not group, and that is not a summary, has one group. It does not rank.

Both statements have `max_memory_usage = 2 GB`. A group-by or a sort over 1 GB goes to disk. When the memory limit is reached, the route answers 422 `metrics_memory_limit`.

Per-series summaries do not fold any group. They set only `truncated: true`. A statement of the series returns at most 300000 (group, bucket) rows. Beyond that, the route sets `truncated_rows: true`. The route also sets this flag for a window with more buckets than the kept groups have. With the bounds of a request, this case cannot occur.

```json
{"v": 1, "source_host_id": "local", "kind": "histogram", "service": "api_service",
 "metric": "http.server.request.duration", "unit": "s", "description": "...",
 "temporality": "delta", "monotonic": null, "monotonic_mixed": null, "points": 8641,
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

`value_unit` is the unit of the metric. For `rate`, it is `<unit>/s`, or `/s` when there is no unit. For `count_rate`, it is `/s`. For `count`, it is empty. A group-by attribute that is absent gives `""` in `labels`. The series `key` joins the label values with `\u001f`.

### `GET /api/metrics/exemplars`

Parameters: `kind` (not `summary`), `service`, `metric`, the window, `bucket_origin_ms`, `step_ms`, the filters as for series, `per_bucket` (1..20, default 3) and `limit` (1..2000, default 500). The route returns the largest exemplars of each bucket of each series:

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

The route sorts the exemplars by time. `trace_id` / `span_id` open `/observability/traces/<trace_id>?span=<span_id>`.

### Measured timings

The measurement used these conditions:

- The local stack had 880 thousand metric points. One ClickHouse served it. Other test clients also used this ClickHouse.
- The full 24-hour window of the fixture.
- A cold cache.
- The total time on the server side.

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

`tests/clickhouse-init/05-otel-logs-metrics.sql` creates the five exporter tables. The `otel_fixture` service fills them when `OTEL_FIXTURE_METRICS=1`. `tests/docker-compose.yml` enables this variable. The service uses the stored spans of the same window as the logs. This window is the last 24 hours of the trace fixture:

| Table | Metric | Shape |
| --- | --- | --- |
| `otel_metrics_histogram` | `http.server.request.duration` (unit `s`) | One point per 10 s for each `ServiceName` and span name (`Attributes['span.name']`). Buckets follow the semantic conventions: `[0.005 ... 10]`. `sum(BucketCounts) = Count`. Half of the services export delta (`AggregationTemporality = 1`). The other half export cumulative (`2`). Each point has one exemplar: the slowest span of the interval (`Exemplars.Value = Max` for delta points). |
| `otel_metrics_sum` | `traces.span.metrics.calls` (unit `{call}`) | Cumulative monotonic span counts per 10 s, with `span.name`, `span.kind` (`SPAN_KIND_*`) and `status.code` (`STATUS_CODE_*`). The alphabetically first service restarts once, halfway through the spans of the window. A fresh stack holds spans only in its last ~55 minutes. Its counters start again from zero with a new `StartTimeUnix`. This gives one counter reset per series. |
| `otel_metrics_gauge` | `process.cpu.utilization` (unit `1`), `queue.depth` (unit `{message}`) | Synthetic waves every 10 s for 3 hosts per service (`Attributes['host.name']` = `<service>-0..2`). |
| `otel_metrics_summary` | `span.duration.summary` (unit `s`) | Per minute and service over the last hour: quantiles 0 / 0.5 / 0.9 / 0.99 / 1. |
| `otel_metrics_exponential_histogram` | `span.duration.exponential` (unit `s`) | Per minute and service over the last hour, scale 3, delta, one exemplar (the slowest span). |

On the local volume with 2 billion spans, the fixture has about 880 thousand points. The fixture generates them in about 16 s. Idempotency and `OTEL_FIXTURE_SIGNALS_FORCE=1` behave as for logs (see `docs/logs.md`).
