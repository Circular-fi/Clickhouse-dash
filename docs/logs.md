# OpenTelemetry logs

ChDash can read the OpenTelemetry logs that the OpenTelemetry Collector contrib ClickHouse exporter stores (`otel_logs`). Logs follow the host that the user selects in the UI, like traces. ChDash reads them through the `system_uri` of that host.

This document describes these items:

- The configuration.
- The endpoint for schema detection.
- The Logs explorer (the Logs view of `/observability` and its `/api/logs/*` routes).

## Configuration

```hcl
logs {
  enabled              = true
  database             = "otel"
  table                = "otel_logs"
  max_lookback_minutes = 10080
  search_limit         = 200
  body_search          = "token"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Turns the logs source on. |
| `database`, `table` | `otel`, `otel_logs` | Exporter logs table. |
| `max_lookback_minutes` | `10080` | Widest time range that a logs query can cover (1 minute to 365 days). |
| `search_limit` | `200` | Maximum log records for each search (1 to 10000). |
| `body_search` | `token` | `token`: `hasToken()` on `Body`, which a `tokenbf_v1`/`text` skip index serves. `substring`: case-insensitive scan (an `ngrambf_v1` index serves it if one exists). `off`: no `Body` search. |

The access control for `ServiceName` reuses `traces.service_allowlist`. The same patterns apply to logs. There is no separate allowlist for logs. Unknown keys in the block are startup errors.

`/api/version` exposes `features.logs.enabled` and `features.logs.body_search`.

## Schema detection: `GET /api/logs/meta`

Parameters: `host_id` (optional when one host is configured) and `refresh=1` to bypass the cache.

The route is always registered. It reads only system tables (`system.tables`, `system.columns`, `system.data_skipping_indices`, `system.parts`). It never scans log rows. For this reason, it stays cheap on very large tables. The route caches successful detections for 60 seconds for each source. The response carries `cache: {hit, age_ms, ttl_ms}`.

When `logs.enabled = false`, the route answers `200` with this body:

```json
{"enabled": false, "signal": "logs", "error_code": "logs_disabled", "message": "..."}
```

An unknown `host_id` answers `404 unknown_host`. A failure of the connection or of a system table answers `503 logs_source_unavailable` / `logs_schema_failed`. A missing table is not an error. The response has `table_exists: false`, `schema_ok: false`, `error_code: "logs_table_missing"` and a message.

Response for an existing table (abridged):

```json
{
  "enabled": true, "signal": "logs", "source_host_id": "local",
  "database": "otel", "table": "otel_logs", "table_exists": true,
  "schema_ok": true, "missing_columns": [],
  "max_lookback_minutes": 10080, "search_limit": 200,
  "service_allowlist": ["*"], "service_filter_applied": false,
  "engine": "MergeTree",
  "sorting_key": "ServiceName, TimestampTime, Timestamp",
  "primary_key": "ServiceName, TimestampTime",
  "partition_key": "toDate(TimestampTime)",
  "rows": 17076470, "parts": 6, "bytes_on_disk": 424997325,
  "timestamp_time_column": true,
  "time_column": "TimestampTime", "precise_time_column": "Timestamp",
  "time_bounds": {"min_ms": 1789780973000, "max_ms": 1789867375999,
                  "source": "system.parts.min_max_time", "precision": "second", "scope": "table"},
  "attributes": {
    "log":      {"column": "LogAttributes",      "kind": "map", "type": "Map(LowCardinality(String), String)"},
    "resource": {"column": "ResourceAttributes", "kind": "map", "type": "..."},
    "scope":    {"column": "ScopeAttributes",    "kind": "map", "type": "..."}
  },
  "skip_indexes": [{"name": "idx_body", "type": "tokenbf_v1", "type_full": "tokenbf_v1(32768, 3, 0)", "expr": "Body", "granularity": 8}, "..."],
  "trace_id_index": {"name": "idx_trace_id", "type": "bloom_filter", "type_full": "bloom_filter(0.001)", "expr": "TraceId", "granularity": 1},
  "body_index": {"name": "idx_body", "type": "tokenbf_v1", "type_full": "tokenbf_v1(32768, 3, 0)", "expr": "Body",
                 "granularity": 8, "lowercase": false, "token_search": true, "substring_search": false},
  "body_search": {"configured": "token", "effective": "token", "index_backed": true},
  "columns": [{"name": "Timestamp", "type": "DateTime64(9)"}, {"name": "TimestampTime", "type": "DateTime", "default_kind": "DEFAULT"}, "..."],
  "features": {"search": true, "severity_filter": true, "body_search": true,
               "trace_correlation": true, "trace_id_index": true, "traces_enabled": true,
               "log_attributes": true, "resource_attributes": true},
  "cache": {"hit": false, "age_ms": 0, "ttl_ms": 60000}
}
```

Notes for query builders:

- **Time column.** The exporter layout that the test stack uses (v0.120) has a `TimestampTime DateTime` column. It partitions by `toDate(TimestampTime)` and sorts by `(ServiceName, TimestampTime, Timestamp)`. Put coarse range filters on `TimestampTime` (`time_column`). Put exact ordering on `Timestamp`. Newer exporter releases drop `TimestampTime` and sort by `(toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)`. `time_column` is then `Timestamp`.
- **Attributes.** `kind` is one of these values:
  - `map`: filter with `LogAttributes['k']` and the `mapKeys`/`mapValues` bloom filters.
  - `json`: JSON subcolumns.
  - `string`, `other` or `missing`.
- **Body index.** `lowercase: true` means that the index is on `lower(Body)` (`idx_lower_body` of the newer exporter). To use the index, search `lower(Body)` with a lower-cased token. `index_backed: false` means that the configured search mode works but scans. `tokenbf_v1` and `hasToken()` split on every non-alphanumeric byte (`_` and `.` included). `hasToken()` rejects a needle that contains a separator. Split the user input into tokens first (`analytics.events_buffer` is `analytics`, `events`, `buffer`).
- **Trace correlation.** `trace_id_index` is the `TraceId` skip index (`bloom_filter(0.001)`, or `text(tokenizer = 'array')` on newer layouts). A lookup of "logs of this trace" must always add a time range around the trace.
- **Time bounds** come from the minimum and maximum of the partition key of the parts. They are exact to the second for `toDate(<time>)` partitions. Otherwise, they have day precision. They are table-wide. The service allowlist does not narrow them.

## Logs of a trace: `GET /api/traces/logs`

The trace detail page lists the logs of the open trace (see below). The route is registered with the other trace routes (when `traces.enabled = true`).

Parameters:

| Parameter | Meaning |
| --- | --- |
| `trace_id` | Required. |
| `start_ns`, `end_ns` | Required: the trace bounds in epoch nanoseconds. A request without them is rejected (`400 missing_time_range`). The backend never runs a `TraceId` lookup over the whole table. |
| `service` | Repeated: the services of the trace. They restrict `ServiceName`, the first column of the primary key. Without them, the lookup relies only on the time range and on the `TraceId` skip index. |
| `span_id` | Optional: the logs of one span. |
| `limit` | Optional, 1..`logs.trace_logs_limit` (default: that limit). |
| `host_id` | Optional when one host is configured. |

Query (one statement, read through the `system_uri` of the host):

```sql
SELECT toString(toUnixTimestamp64Nano(Timestamp)), toString(Timestamp, 'UTC'), SeverityText, SeverityNumber,
       ServiceName, SpanId, substring(Body, 1, 65536), length(Body),
       toJSONString(LogAttributes), toJSONString(ResourceAttributes), ScopeName[, EventName]
FROM otel.otel_logs
PREWHERE TimestampTime BETWEEN toDateTime(<start s> - trace_margin_before_seconds)
                           AND toDateTime(<end s> + 1 + trace_margin_after_seconds)
WHERE ServiceName IN (<services>) AND TraceId = '<trace>' [AND SpanId = '<span>']
  AND <traces.service_allowlist predicate>
ORDER BY Timestamp
LIMIT <limit + 1>
SETTINGS max_execution_time = 10, merge_tree_min_rows_for_concurrent_read = 8192,
         merge_tree_min_bytes_for_concurrent_read = 1
```

- The margins are `logs.trace_margin_before_seconds` (default 5) and `logs.trace_margin_after_seconds` (default 30). They catch the records that the exporter wrote just before the first span, or after the end of the last span. Exporters often flush logs later than their span. The window is clamped to `logs.max_lookback_minutes` from its start (`window.clamped: true`).
- Without a `TimestampTime` column (newer exporter layouts), the range is on `Timestamp`. `Map` and `JSON` attribute columns are both serialized with `toJSONString`. The backend reads the column types from `system.columns` and caches them for 60 seconds for each source.
- The `ServiceName` allowlist is the allowlist of the traces (`src/otel_allowlist.hpp`, shared by the trace routes and the log routes).
- The backend reads one more row than the limit. `truncated: true` means that the trace has more logs than the response returns.
- The small time window leaves only a few granules after the indexes. The settings for concurrent read let ClickHouse read them with several threads. Without them, ClickHouse uses one thread. This gives about 25 ms instead of 45 ms on the test fixture.

The test stack has 17 million log rows and 2 billion spans. On this stack, a trace of the last fixture hour with about 80 logs answers in 20-35 ms (server `elapsed_ms`, round trip included).

Response (abridged):

```json
{
  "enabled": true, "signal": "logs", "table_exists": true, "source_host_id": "local",
  "database": "otel", "table": "otel_logs", "trace_id": "000000000000000000000000017c5287", "span_id": "",
  "window": {"start_ns": "1789865553877551302", "end_ns": "1789865554067551302", "from_s": 1789865548,
             "to_s": 1789865585, "margin_before_s": 5, "margin_after_s": 30, "time_column": "TimestampTime",
             "clamped": false},
  "services": ["api_service", "..."], "attributes": {"log": "map", "resource": "map"},
  "limit": 1000, "count": 79, "truncated": false, "elapsed_ms": 24,
  "logs": [{"timestamp_ns": "1789865553889660032", "timestamp": "2026-09-20 00:52:33.889660032",
            "severity_text": "INFO", "severity_number": 9, "service_name": "clickhouse_writer",
            "span_id": "00000000be294383", "body": "inserted 156 rows into analytics.events_buffer in 19 ms",
            "log_attributes": "{\"code.function\":\"...\"}", "resource_attributes": "{...}",
            "scope_name": "clickhouse_writer"}]
}
```

`timestamp_ns` is exact (text). `timestamp` is UTC. The route cuts a body that is longer than 64 KiB. It then sets `body_truncated: true` and gives the full `body_bytes`. The route answers in these cases:

- Logs are disabled: `200 {"enabled": false, "error_code": "logs_disabled", "logs": []}`.
- The table is missing: `200` with `table_exists: false` and `error_code: "logs_table_missing"`.
- The table has no `TraceId`/`SpanId`: `logs_trace_correlation_unavailable`.
- The parameters are not valid: `400`.
- The host is unknown: `404`.
- A connection or a query fails: `503`.

### In the trace detail page

The logs load after the trace has rendered. They never delay the trace. They do not load at all when `/api/version` reports `features.logs.enabled = false`.

- **Header**: a `Logs` item with the count (`n+` when truncated) and the number of error logs. A click shows or hides the logs panel. The dashboard remembers the state.
- **Logs panel**: every log of the trace in time order. Each log has the severity, the offset from the trace start (absolute time on hover), the service, the span and the body. The panel also has severity chips, a service picker and a text filter over the loaded logs. A click on a row opens its span (`?span=`). The Logs group of the inspector is open, and the log is marked. The arrow expands the full body, the log attributes and the resource attributes.
- **Waterfall**: each span row that has logs shows a log count badge. The color of the badge is the color of the most severe log. The timeline of the row shows a marker for each log. The badge or a marker lists the logs of the span under its row. The list uses the waterfall columns, with a diamond at the time of each log.
- **Span inspector**: a `Logs (n)` group with the logs of the span.

A log belongs to the span of its `SpanId`. `(TraceId, SpanId)` is not always unique (the same span is stored twice at different times). In this case, a log belongs to the span whose interval holds it. Otherwise, it belongs to the nearest span. Logs without a span of the trace are listed in the panel only.

## Logs explorer: the Logs view (`/observability/logs`)

When `logs.enabled = true`, the Observability page (`/observability`, see `docs/traces.md`) has a **Logs** tab. Otherwise, the tab is hidden. The dashboard caches the availability in `chdash.pageNav.v1` for the first paint, like the page switcher. The time range and the service are shared with the Traces and Metrics views. The view follows the model of the search page of HyperDX:

- **Search bar**: it has these controls:
  - The time range picker of Traces (quick ranges, absolute range, calendar).
  - Services (multi-select, with record counts for the range).
  - Minimum level.
  - Body text.
  - Filters `key=value` and `key!=value`.

  `TraceId=<id>` in the filter box filters one trace. Every setting is in the URL (`from`, `to`, `service`, `level`, `sev`, `q`, `attr`, `trace_id`, `tab`, `cols`, `denoise`). For this reason, the user can share a search, reload it and navigate it with Back / Forward.
- **Fields**: the left sidebar. It is the component of the Traces **Attributes** panel (`app_facet_panel.js`). It has these parts:
  - The field keys of the matching records, under the name of their scope (Record, Log attributes, Resource attributes, Scope attributes). Each key has its sampled count ("from a 3M sample" when the count is on a sample).
  - A key search.
  - The top values of an expanded key.
  - Pins.
  - A folded rail of 32 px. It is folded by default under 1100 px. On phones, the panel stacks above the histogram.

  A checked value adds a `key=value` filter (`LogAttributes.<key>=...`, the column, or the service picker for `ServiceName`). The exclude button adds `key!=value`. Several checked values of one key match any of them. The panel shows the active filters (from the chips, the Filter box or the URL). The dashboard keeps the pins and the fold state in `localStorage`.
- **Volume histogram**: records over time, stacked by severity class (error, warn, info, debug). The total is the sum of the buckets. The buckets align on the local midnight of the browser. Drag over the chart to zoom the time range. The legend toggles the severity classes.
- **Results**: a virtualized table, newest first (time, level, service, body). The user can add host, TraceId, SpanId, scope and any attribute from **Columns**. Scrolling loads older pages through keyset cursors. The status line beside the tabs describes the tab that is shown (the listed records on Results, the mined sample on Patterns). The service colors are the colors of the Traces view (same session assignment).
- **Record panel**: click a row (or use the arrow keys) to see every field and attribute.
  - Below 1600 px, the Fields panel folds to its rail while the record panel is open. The table drops its columns of lowest priority before Body would shrink under 320 px. The order is: attributes, scope, span, trace, host, then service.
  - Each value has the actions *filter*, *exclude*, *search only this* and *copy*.
  - **Open trace** opens `/observability/traces/<TraceId>?span=<SpanId>` (the own page of the trace).
  - **Surrounding context** lists the records around the record. The user can select anything, same service, same host (`ResourceAttributes['host.name']`) or same trace, within ±1 min to ±1 h.
- **Patterns**: templates that the dashboard mines from a sample of the search. Each pattern shows its count, its share beside its own bar, its trend and a sample record. The status line reads "21 patterns in a sample of 9,472 of 6,544,139 logs · counts extrapolated ×691 from the sample". **Denoise** hides the patterns above 10 % of the sample. A click on a pattern searches its constant words.
- **No live tail**: the dashboard reads the records on load, on a change of a filter or of the range, and with **Search**. Nothing polls on a timer.

Token search (`body_search = "token"`) matches whole tokens, case-sensitively (the exporter index is on `Body`, not on `lower(Body)`). `miss` matches `cache miss`, but `mis` does not. All separate terms must match. `"quoted text"` must appear verbatim. `-term` excludes.

## Logs API

All routes take `host_id` (optional with one host). The backend registers them only when `logs.enabled = true`. Searches, histograms and patterns share the filter parameters:

| Parameter | Meaning |
| --- | --- |
| `start_ms`, `end_ms` | Range, both inclusive (`end_ms` covers its whole millisecond). Without them: `lookback_minutes` (default 15). At most `logs.max_lookback_minutes`. |
| `service` (repeated) | `ServiceName IN (...)`. `traces.service_allowlist` always applies. |
| `severity_min` | `SeverityNumber >= n` (0-24). |
| `severity` (repeated) | Classes `error` (>= 17), `warn` (13-16), `info` (9-12), `debug` (<= 8). |
| `q` | Body search, see below. |
| `attr` (repeated) | `key=value` or `key!=value`. A bare key matches `LogAttributes` or `ResourceAttributes`. `LogAttributes.<key>`, `ResourceAttributes.<key>`, `ScopeAttributes.<key>` pick one map. `ServiceName`, `SeverityText`, `TraceId`, `SpanId`, `ScopeName`, `ScopeVersion` compare the column. Several `key=value` of one key match any of the values. Every `key!=value` excludes its value. |
| `trace_id`, `span_id` | Hexadecimal ids. |

Every query filters the columns of the primary key first (`ServiceName`, and `TimestampTime` on the older exporter layout, plus the exact `Timestamp` bound). It runs with `max_execution_time = 30` and `max_rows_to_read = 1000000000` (`read_overflow_mode = 'throw'`). A query over that guard answers `422 logs_scan_limit`. A timeout answers `504 logs_timeout`.

**Body search.** The mode decides how the backend builds the search:

- `token`: The backend splits the text into terms (whitespace, `"quoted phrases"`, `-negations`). It splits each term into tokens exactly like `tokenbf_v1` does (every ASCII non-alphanumeric byte separates). Every token becomes `hasToken(Body, 'token')`. For this reason, the `idx_body` index skips granules and `hasToken()` never sees a separator. A term with separators (`analytics.events_buffer`, `key=user:12`) also needs `position(Body, 'term') > 0`. With a `lower(Body)` index, the search uses `hasToken(lower(Body), ...)` and `positionCaseInsensitive`.
- `substring`: `Body ILIKE '%term%'`. The searches then scan only windows of 15 minutes. Histograms and patterns with text are limited to 6 hours (`400 logs_substring_range`).
- `off`: `q` answers `400 logs_body_search_disabled`.

### `GET /api/logs/search`

Newest-first records. `limit` (default and maximum `logs.search_limit`), `cursor` (next page). The route ignores `after` of the former live tail (a page).

- **Order and cursor.** `ORDER BY Timestamp DESC, cityHash64(ServiceName, TraceId, SpanId, SeverityNumber, Body) DESC`. The `id` of each row is `<Timestamp ns>-<tiebreak>`. `next_cursor` continues strictly after the last row: `Timestamp < ts OR (Timestamp = ts AND tiebreak < h)`. There is no `OFFSET`. A page costs the same at any depth. The route never skips or repeats records that share a timestamp.
- **Progressive windows** (HyperDX `searchWindows`): the backend reads the newest 15 minutes first. Then it reads windows of 1 h, 6 h and 24 h further back. It stops when the page is full or when it reaches the range start. `windows` lists them with their row counts and durations. After 12 s, the search stops widening. It answers with a `next_cursor` that resumes below the last scanned window (`budget_exhausted: true`).

Response: `rows`, `row_count`, `next_cursor`, `exhausted`, `truncated`, `windows`, `text_search: {active, mode, index_backed}` and `timing_ms`. Each row has these fields: `id`, `ts_ns`, `ts_ms`, `service`, `severity_text`, `severity_number`, `trace_id`, `span_id`, `trace_flags`, `scope_name`, `scope_version`, `log_attributes`, `resource_attributes`, `scope_attributes` and `body`. `body` has the first 16384 characters. Beyond that, `body_truncated` / `body_length` apply.

```sql
SELECT ... FROM otel.otel_logs
WHERE TimestampTime >= toDateTime(lo_s) AND TimestampTime <= toDateTime(hi_s)
  AND Timestamp >= fromUnixTimestamp64Nano(lo_ns) AND Timestamp <= fromUnixTimestamp64Nano(hi_ns)
  AND <allowlist> AND ServiceName IN (...) AND hasToken(Body, 'cache') AND hasToken(Body, 'miss')
ORDER BY Timestamp DESC, cityHash64(ServiceName, TraceId, SpanId, SeverityNumber, Body) DESC
LIMIT 200
SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw',
         max_rows_to_read = 1000000000, read_overflow_mode = 'throw'
```

### `GET /api/logs/histogram`

Record counts for each bucket and severity class, for the same filters. `buckets` (target count, 10-300, default 80) picks a bucket of 1 s .. 7 d. `bucket_origin_ms` anchors the grid (the browser sends its local midnight, as the Traces analytics do). Response: `bucket_ms`, `bucket_origin_ms` (origin modulo the bucket), `buckets: [[start_ms, error, warn, info, debug], ...]` and `totals` (`total` is the sum of the buckets). Grids that are aligned to the second bucket `TimestampTime` instead of `Timestamp`.

### `GET /api/logs/context`

Records around one record. The route ignores the search filters. The parameters are:

- `ts_ns` and `tie` (the two halves of the `id` of a row).
- `preset` = `anything` | `service` (`service=`) | `host` (`host=`, matched on `ResourceAttributes['host.name']`) | `trace` (`trace_id=`).
- `window_ms` (1 s .. 1 h, default 5 min).
- `limit` for each side (default 50, maximum 200).

Response: `rows` newest first with the anchor among them (`anchor_found`), `before_count`, `after_count`, `more_before`, `more_after`.

### `GET /api/logs/patterns`

Drain templates (the algorithm of `common-utils/drain` of HyperDX: depth 4, similarity 0.4, 100 children for each node). The backend mines them on the server from a bounded sample. The route counts the matching records. Then it reads at most `sample` (default 10000) of them. It reads all of them when they fit. Otherwise, it uses a deterministic block sample (`cityHash64(_part, intDiv(_part_offset, 64)) % 1000000 < rate`). This sample reads `Body` only for the granules that hold a picked block. On the test fixture, this is about a fifth of the bytes of `ORDER BY rand()`. The backend first masks the bodies. Quoted strings, UUIDs and hex ids, and numbers that are not glued to a word become `<*>`.

Response: `total`, `sample_size`, `sampled`, `sample_method` (`all` or `block_hash`), `scale` (`total / sample_size`), `pattern_count` and `patterns` sorted by count. Each pattern has these fields:

- `pattern`.
- `sample_count`.
- `count` (scaled).
- `share` (of the sample).
- `noisy` (`share > 0.10`, hidden by Denoise).
- `sample` (one record).
- `search` (the constant words, usable as `q`).
- `service` / `service_count`.
- `severity` (most frequent class).
- `sparkline` (scaled counts over `sparkline_buckets` equal slices of the range).

### `GET /api/logs/facets` and `GET /api/logs/facet_values`

These routes serve the Fields panel. They use the same caps as the Traces attribute facets (`facet_limits.hpp`, see "Attribute facets" in `docs/traces.md`):

- The filters of the search, over the range aligned to the minute (`scanned_range`). The backend caches the answers for 60 s for each host, window and filter set.
- At most 3 M sampled records.
- At most 50 M rows read.
- 100 k distinct values grouped.
- A budget of 5 s.

`estimated: true` means that a cap stopped the scan.

`/api/logs/facets` reads the key subcolumns of the maps and the record columns in one pass. It returns `keys: [[scope, key, count], ...]`, most frequent first, and `sampled_records`. The scopes are `log`, `resource` and `scope` for `Map` attribute columns, and `column` for `ServiceName`, `SeverityText`, `ScopeName` and `ScopeVersion`.

```sql
SELECT toString(sampled), toString(t.1), toString(t.2), toString(t.3) FROM (
  SELECT count() AS sampled,
         sumMap(k0, arrayResize([toUInt64(1)], length(k0), toUInt64(1))) AS m0, ...,
         countIf(c0 != '') AS n0, ...
  FROM (SELECT LogAttributes.keys AS k0, ..., `ServiceName` AS c0, ...
        FROM otel.otel_logs WHERE <time> AND <allowlist> <filters> LIMIT 3000000))
LEFT ARRAY JOIN arrayConcat(arrayMap((k, c) -> tuple('log', toString(k), c), m0.1, m0.2), ...,
                            [tuple('column', 'ServiceName', n0), ...]) AS t
SETTINGS max_execution_time = 5, timeout_overflow_mode = 'break',
         max_rows_to_read = 50000000, read_overflow_mode = 'break'
```

`/api/logs/facet_values?scope=log|resource|scope|column&key=...&limit=...` (limit 1-500, default 10) counts the values of one field (`values: [[value, count], ...]`, `records_with_key`, `distinct_values`, `has_more`). The route leaves out the own filters of the field. These are the `service` filter for `ServiceName`, and the `attr` filters on the column, on `<Map>.<key>` or on the bare key. In this way, the other values of the field stay listed. A column facet must name one of the four columns (`400 invalid_logs_facet`). A JSON attribute column answers `400 logs_facet_unsupported`.

### `GET /api/logs/services`

Service names with record counts in the range, for the service picker. The route applies the allowlist and ignores the other filters.

## Test fixture

The test stack creates `otel.otel_logs` with the exporter DDL (`tests/clickhouse-init/05-otel-logs-metrics.sql`). The `otel_fixture` service fills it when `OTEL_FIXTURE_LOGS=1` (on in `tests/docker-compose.yml`). The fixture derives the records from the stored spans with one `INSERT ... SELECT` for each hour of the window. For this reason, `TraceId`, `SpanId` and the timestamps correlate:

- Window: the last `OTEL_FIXTURE_SIGNALS_WINDOW_MINUTES` (1440) minutes of the trace fixture, ending at the newest span.
- Traces with logs: every trace of the last `OTEL_FIXTURE_LOGS_DENSE_MINUTES` (60) minutes has logs. 1 trace in `OTEL_FIXTURE_LOGS_TRACE_SAMPLE` (16) of the rest has logs. In those traces, the root span and 1 span in `OTEL_FIXTURE_LOGS_SPAN_SAMPLE` (4) emit 1-3 records each.
- Every error span of the window gets an `ERROR` record at the end of the span. The `Body` of the record is the span `StatusMessage` (`exception.type` = `SyntheticFixtureError`).
- The severities are about DEBUG 20 % / INFO 65 % / WARN 10 % / ERROR 5 %. About 5 % of the records have no trace context (`log.origin = background`). About 5 % are written 1-3 s after their span ended (`log.origin = after_span`).
- The bodies carry variable tokens (`cache miss key=user:123`, `inserted 649 rows into analytics.events_buffer in 2 ms`, `GET /v1/events 200 in 35 ms`, ...).
- `LogAttributes`: `code.function`, `code.lineno`, `log.origin`, `http.route` / `http.request.method` / `http.response.status_code` for HTTP spans, and `exception.type` / `exception.message` / `exception.stacktrace` on ERROR records.
- `ResourceAttributes`: `service.name`, `service.version` (stable for each service), `host.name` (`<service>-0..2`), `deployment.environment.name`.

On the local volume with 2 billion spans, this is about 17 million records, inserted in about 25 s. The load is idempotent. The fixture keeps a complete earlier load (marked in the table comment). It rebuilds an interrupted load. `OTEL_FIXTURE_SIGNALS_FORCE=1` rebuilds logs and metrics without a change to the traces.
