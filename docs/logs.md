# OpenTelemetry logs

ChDash can read OpenTelemetry logs stored by the OpenTelemetry Collector
contrib ClickHouse exporter (`otel_logs`). Like traces, logs follow the host
selected in the UI and are read through that host's `system_uri`.

This document covers the configuration and the schema-detection endpoint.
The logs UIs (logs in the trace detail, a logs explorer) build on it.

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
| `max_lookback_minutes` | `10080` | Widest time range a logs query may cover (1 minute to 365 days). |
| `search_limit` | `200` | Maximum log records per search (1 to 10000). |
| `body_search` | `token` | `token`: `hasToken()` on `Body`, served by a `tokenbf_v1`/`text` skip index. `substring`: case-insensitive scan (served by an `ngrambf_v1` index if one exists). `off`: no `Body` search. |

`ServiceName` access control reuses `traces.service_allowlist`: the same
patterns apply to logs, and there is no separate logs allowlist. Unknown keys
in the block are startup errors.

`/api/version` exposes `features.logs.enabled` and `features.logs.body_search`.

## Schema detection: `GET /api/logs/meta`

Parameters: `host_id` (optional when one host is configured), `refresh=1` to
bypass the cache.

The route is always registered. It only reads system tables
(`system.tables`, `system.columns`, `system.data_skipping_indices`,
`system.parts`) and never scans log rows, so it stays cheap on very large
tables. Successful detections are cached for 60 seconds per source; the
response carries `cache: {hit, age_ms, ttl_ms}`.

When `logs.enabled = false` it answers `200` with:

```json
{"enabled": false, "signal": "logs", "error_code": "logs_disabled", "message": "..."}
```

An unknown `host_id` answers `404 unknown_host`; a connection or system-table
failure answers `503 logs_source_unavailable` / `logs_schema_failed`. A missing
table is not an error: the response has `table_exists: false`,
`schema_ok: false`, `error_code: "logs_table_missing"` and a message.

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

- **Time column.** The exporter layout used by the test stack (v0.120) has a
  `TimestampTime DateTime` column, partitions by `toDate(TimestampTime)` and
  sorts by `(ServiceName, TimestampTime, Timestamp)`: coarse range filters
  belong on `TimestampTime` (`time_column`), exact ordering on `Timestamp`.
  Newer exporter releases drop `TimestampTime` and sort by
  `(toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)`;
  `time_column` is then `Timestamp`.
- **Attributes.** `kind` is `map` (filter with `LogAttributes['k']` and the
  `mapKeys`/`mapValues` bloom filters), `json` (JSON subcolumns), `string`,
  `other` or `missing`.
- **Body index.** `lowercase: true` means the index is on `lower(Body)`
  (newer exporter `idx_lower_body`): search `lower(Body)` with a lower-cased
  token for the index to apply. `index_backed: false` means the configured
  search mode works but scans. `tokenbf_v1` and `hasToken()` split on every
  non-alphanumeric byte (`_` and `.` included), and `hasToken()` rejects a
  needle containing a separator: split user input into tokens first
  (`analytics.events_buffer` is `analytics`, `events`, `buffer`).
- **Trace correlation.** `trace_id_index` is the `TraceId` skip index
  (`bloom_filter(0.001)`, or `text(tokenizer = 'array')` on newer layouts);
  "logs of this trace" lookups should always add a time range around the trace.
- **Time bounds** come from the parts' partition-key min/max (exact to the
  second for `toDate(<time>)` partitions, day precision otherwise) and are
  table-wide: they are not narrowed by the service allowlist.

## Logs of a trace: `GET /api/traces/logs`

The trace detail page lists the logs of the open trace (see below). The route
is registered with the other trace routes (when `traces.enabled = true`).

Parameters:

| Parameter | Meaning |
| --- | --- |
| `trace_id` | Required. |
| `start_ns`, `end_ns` | Required: the trace bounds in epoch nanoseconds. A request without them is rejected (`400 missing_time_range`): a `TraceId` lookup is never run over the whole table. |
| `service` | Repeated: the services of the trace. They restrict `ServiceName`, the first primary key column. Without them the lookup relies on the time range and the `TraceId` skip index alone. |
| `span_id` | Optional: the logs of one span. |
| `limit` | Optional, 1..`logs.trace_logs_limit` (default: that limit). |
| `host_id` | Optional when one host is configured. |

Query (one statement, read through the host's `system_uri`):

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

- The margins (`logs.trace_margin_before_seconds`, default 5, and
  `logs.trace_margin_after_seconds`, default 30) catch records written just
  before the first span or after the last one ends (exporters often flush
  logs later than their span). The window is clamped to
  `logs.max_lookback_minutes` from its start (`window.clamped: true`).
- Without a `TimestampTime` column (newer exporter layouts) the range is on
  `Timestamp`. `Map` and `JSON` attribute columns are both serialized with
  `toJSONString`; the column types are read from `system.columns` and cached
  60 seconds per source.
- The `ServiceName` allowlist is the one of the traces
  (`src/otel_allowlist.hpp`, shared by the trace and log routes).
- One more row than the limit is read: `truncated: true` means the trace has
  more logs than returned.
- The small time window leaves only a few granules after the indexes; the
  concurrent-read settings let ClickHouse read them with several threads
  instead of one (about 25 ms instead of 45 ms on the test fixture).

On the test stack (17 million log rows, 2 billion spans) a trace of the last
fixture hour with about 80 logs answers in 20-35 ms (server `elapsed_ms`,
round trip included).

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

`timestamp_ns` is exact (text); `timestamp` is UTC. A body longer than 64 KiB
is cut, with `body_truncated: true` and the full `body_bytes`. When logs are
disabled the route answers `200 {"enabled": false, "error_code":
"logs_disabled", "logs": []}`; a missing table answers `200` with
`table_exists: false` and `error_code: "logs_table_missing"`; a table without
`TraceId`/`SpanId` answers `logs_trace_correlation_unavailable`. Invalid
parameters answer `400`, an unknown host `404`, a connection or query failure
`503`.

### In the trace detail page

The logs load after the trace has rendered (the trace is never delayed by
them), and not at all when `/api/version` reports `features.logs.enabled =
false`.

- **Header**: a `Logs` item with the count (`n+` when truncated) and the
  number of error logs; a click shows or hides the logs panel (remembered).
- **Logs panel**: every log of the trace in time order, with severity,
  offset from the trace start (absolute time on hover), service, span and
  body; severity chips, a service picker and a text filter over the loaded
  logs. A row click opens its span (`?span=`) with the inspector's Logs
  group open and the log marked; the arrow expands the full body, the log
  attributes and the resource attributes.
- **Waterfall**: a log count badge on each span row with logs (coloured by
  its most severe log) and a marker per log on the row's timeline. The badge
  or a marker lists the span's logs under its row, on the waterfall columns
  (a diamond at each log's time).
- **Span inspector**: a `Logs (n)` group with the span's logs.

A log belongs to the span of its `SpanId`. `(TraceId, SpanId)` is not always
unique (the same span stored twice at different times): a log then belongs
to the span whose interval holds it, else to the nearest one. Logs without a
span of the trace are listed in the panel only.

## Test fixture

The test stack creates `otel.otel_logs` with the exporter DDL
(`tests/clickhouse-init/05-otel-logs-metrics.sql`) and the `otel_fixture`
service fills it when `OTEL_FIXTURE_LOGS=1` (on in `tests/docker-compose.yml`).
Records are derived from the stored spans with one `INSERT ... SELECT` per
hour of the window, so `TraceId`, `SpanId` and timestamps correlate:

- window: the last `OTEL_FIXTURE_SIGNALS_WINDOW_MINUTES` (1440) minutes of
  the trace fixture, ending at the newest span;
- every trace of the last `OTEL_FIXTURE_LOGS_DENSE_MINUTES` (60) minutes and
  1 trace in `OTEL_FIXTURE_LOGS_TRACE_SAMPLE` (16) of the rest has logs; in
  those traces the root span and 1 span in `OTEL_FIXTURE_LOGS_SPAN_SAMPLE` (4)
  emit 1-3 records each;
- every error span of the window gets an `ERROR` record at the span end whose
  `Body` is the span `StatusMessage` (`exception.type` =
  `SyntheticFixtureError`);
- severities are about DEBUG 20 % / INFO 65 % / WARN 10 % / ERROR 5 %;
  about 5 % of records have no trace context (`log.origin = background`) and
  about 5 % are written 1-3 s after their span ended (`log.origin = after_span`);
- bodies carry variable tokens (`cache miss key=user:123`,
  `inserted 649 rows into analytics.events_buffer in 2 ms`,
  `GET /v1/events 200 in 35 ms`, ...);
- `LogAttributes`: `code.function`, `code.lineno`, `log.origin`,
  `http.route` / `http.request.method` / `http.response.status_code` for
  HTTP spans, `exception.type` / `exception.message` /
  `exception.stacktrace` on ERROR records;
- `ResourceAttributes`: `service.name`, `service.version` (stable per
  service), `host.name` (`<service>-0..2`), `deployment.environment.name`.

On the 2-billion-span local volume this is about 17 million records, inserted
in about 25 s. The load is idempotent: a complete earlier load (marked in the
table comment) is kept, an interrupted one is rebuilt, and
`OTEL_FIXTURE_SIGNALS_FORCE=1` rebuilds logs and metrics without touching the
traces.
