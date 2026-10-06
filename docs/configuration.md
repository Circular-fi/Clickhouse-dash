# Configuration reference

ClickHouse Dash is configured exclusively with an HCL file:

```bash
chdash --config /etc/clickhouse-dash/config.hcl
chdash --config /etc/clickhouse-dash/config.hcl --health
```

Starting the server or running `--health` without `--config` is an error.
Application environment variables are not read as configuration. This does not
prevent a supervisor or container runtime from using environment variables for
its own templating, but the `chdash` process itself only consumes the HCL file.

The complete syntax is shown in [`config.example.hcl`](../config.example.hcl).
Unknown blocks, unknown attributes, duplicate attributes, and incorrect HCL
types are startup errors.

## Core blocks

- `server`: listen host and port.
- `query`: interactive query limits, batching, SSE backpressure, compatibility
  DESCRIBE behavior, and session lifecycle.
- `client_pool`: native ClickHouse connection pool lifecycle.
- `format_cache`: bounded SQL formatter cache.
- `health`: host health polling.
- `traces`: optional OpenTelemetry trace explorer backed by an OTel Collector ClickHouse traces table.
- `logs` / `metrics`: optional OpenTelemetry logs and metrics sources (OTel Collector ClickHouse exporter tables).
- `query_library`: optional server-side query library (folders, saved queries) in a JSON file.
- `system`: the System page (the selected server's health), on by default.
- `clickhouse`: one or more named hosts, each with `runner_uri` and `system_uri`.

## Authorization model

ChDash has no end-user login, Bearer authentication, or per-user RBAC. Access to ClickHouse is defined entirely by the configured host credentials:

- `runner_uri` is the ClickHouse authorization boundary and is the **only** connection on which panel-supplied SQL may execute;
- `system_uri` is a technical backend connection used only for backend-generated metadata/log queries and cancellation.

Every caller who can reach a given panel/host therefore has the same ClickHouse permissions: the permissions of its `runner_uri`. If different permission sets are required, expose different runner-backed deployments/hosts outside ChDash.

The server still signs short-lived internal capability tokens with a random boot-time secret. These tokens are not user identities. In particular, `/api/query/cancel` requires the signed token issued for that query. Cancel tokens carry `purpose=cancel`, host/query IDs, `iat`, and `exp`; `query.cancel_token_ttl_ms` defaults to 48 hours. Restarting ChDash rotates the signing secret and invalidates older capabilities before their nominal expiry.

## Evolution blocks

The HCL contract exposes the settings required by Explorer, the System page, analysis, and massive export:

```hcl
explorer {
  browse = true

  graph {
    lineage          = true
    storage_topology = true
  }

  cache_ttl_ms            = 5000
  live_refresh_ms         = 2000
  function_cache_ttl_ms   = 3600000
  function_markdown_links = false
}

system {
  enabled                      = true
  activity                     = true
  keeper                       = true
  top_queries                  = true
  cluster_fanout               = false
  default_lookback_minutes     = 60
  max_lookback_days            = 30
  query_log_max_lookback_hours = 168
  query_log_max_rows           = 50000000
  disk_growth_days             = 7
}

traces {
  enabled                  = false
  analytics                = false
  database                 = "otel"
  table                    = "otel_traces"
  trace_index_table        = "otel_traces_trace_id_ts"
  service_allowlist        = ["*"]
  default_lookback_minutes = 60
  max_lookback_minutes     = 10080
  search_limit             = 100
  max_spans_per_trace      = 10000
  # Optional; see docs/traces.md.
  highlighted_attributes   = ["service.version", "deployment.environment.name", "deployment.environment", "http.route", "user.id"]
  linked_from_margin_minutes = 60

  features {
    service_filter      = true
    operation_filter    = true
    status_filter       = true
    duration_filter     = true
    resource_attributes = true
    span_attributes     = true
    events              = true
    links               = true
  }
}

analysis {
  registry_ttl_ms      = 3600000
  registry_max_entries = 10000
  registry_sql_max_bytes = 33554432
  log_lookup_timeout_ms = 2000
  flush_logs            = false
  allow_deep_analyze    = false
}

export {
  max_concurrent      = 1
  output_buffer_bytes = 262144
  archive_format      = "zip"
  compression         = false
}
```

Explorer availability is derived from the enabled surfaces; there is no separate `enabled` switch. `explorer.browse` controls the Browse surface. The nested `explorer.graph` block controls the graph families: Graph is enabled when either `lineage` or `storage_topology` is true, and Explorer itself is enabled when Browse or Graph is enabled. If only Browse or Graph remains, the Browse/Graph selector disappears and that surface becomes implicit. Likewise, if only one graph family remains, the Lineage/Storage selector disappears and that family becomes implicit. Setting `browse = false`, `graph.lineage = false`, and `graph.storage_topology = false` disables Explorer routes and removes the Explorer entry of the page switcher (Query / Explorer / Observability / System); the switcher itself goes when no Explorer, Observability or System page remains.

`system` controls the **System** page (`/system[/<section>]`, see [System](system.md)) and its `/api/system/...` endpoints; every key is optional. `enabled = false` removes the page switcher's System entry, the page, every `/api/system/...` route (the `/api/explorer/ops/...` aliases included) and the redirects of the former Explorer addresses (`/explorer/_monitoring[/<section>]` and `/explorer/_operations` then open the Explorer Catalog); it defaults to `true`. `activity` (the Overview's Activity part and `/api/system/activity`) and `keeper` (the Overview's Keeper card and `/api/system/keeper`) default to `true`; with `keeper = false` the merge/mutation/replication/Distributed tables stay. `top_queries` (`true`) is the Queries section and its `/api/system/queries` routes, read with the runner account, which then needs `SELECT ON system.query_log` (the section shows the GRANT otherwise). `cluster_fanout` (`false`) opts into the `clusterAllReplicas` views, which need `GRANT REMOTE ON *.*` for the system account; off, every figure is the selected host's own. The other keys bound the history parts, which read the server's system logs, and are clamped at startup: `max_lookback_days` (30, 1 to 365: `metric_log` and `asynchronous_metric_log`), `default_lookback_minutes` (60, 1 minute to `max_lookback_days`), `query_log_max_lookback_hours` (168, 1 to 720), `query_log_max_rows` (50,000,000 rows read per request, 1,000 to 10,000,000,000; a larger read stops with an error rather than a partial answer) and `disk_growth_days` (7, 1 to `max_lookback_days`). The Overview's Performance part (`/api/system/series`) opens on `default_lookback_minutes`, refuses a window wider than `max_lookback_days` and reads its latency percentiles from `query_log` only for windows of `query_log_max_lookback_hours` or less (bounded by `query_log_max_rows`), the average from `metric_log` beyond. Disks (`/api/system/disks` and `/api/system/series?panel=disk_growth`) charts the disks' growth over the last `disk_growth_days` by default (any window up to `max_lookback_days`). Queries reads windows of `query_log_max_lookback_hours` or less, each read capped by `query_log_max_rows`. `/api/version` reports the block as `features.system` (`enabled`, `activity`, `keeper`, `top_queries`, `cluster_fanout` and the four windows; not `query_log_max_rows`, which only the Queries answers report). Every System query sets `readonly = 2`, a time budget and read caps, so neither account may have a `readonly = 1` profile. The live answers (the Overview's tiles, Keeper and Activity) are cached per host for `min(explorer.cache_ttl_ms, 5 s)`, at least 1 s.

`explorer.operations { enabled, keeper }` is the v2.14.0 key of the former Server operations view and still works: `enabled = false` turns both `system.activity` and `system.keeper` off, `keeper = false` turns `system.keeper` off. A `system { }` block that sets `activity` or `keeper` wins over it. `/api/version` still reports `features.explorer.operations` (`enabled`, `keeper`), mirroring `system.activity` and `system.keeper`, and `/api/explorer/ops/activity` and `/api/explorer/ops/keeper` stay as aliases of `/api/system/activity` and `/api/system/keeper`.

`explorer.function_markdown_links` defaults to `false`, so links embedded in ClickHouse function Markdown are rendered as plain text. When enabled, only documentation-relative targets beginning with `/` or `./` become links; arbitrary external URLs remain non-clickable.

The Trace Explorer is disabled by default. Its table defaults match the OpenTelemetry Collector ClickHouse exporter (`otel_traces` plus `otel_traces_trace_id_ts`). Trace queries always follow the host selected in the normal host picker and always use that host's `system_uri`; there is no per-trace host or credential override. `default_lookback_minutes` and `max_lookback_minutes` bound search/filter queries only. Direct `/observability/traces/<trace-id>` lookups are not lookback-limited and require `trace_index_table`; ChDash resolves the trace time range there and never scans all history in `otel_traces` to recover a missing TraceId.

`traces.analytics` defaults to `false`. Set it to `true` to enable the expensive matching-trace and duration-percentile graphs. Search results use `/api/traces/search`; graph data uses the independent `/api/traces/analytics` route, so loading the graph never blocks the trace-result response.

`traces.service_allowlist` is a backend-enforced `ServiceName` whitelist. The default `service_allowlist = ["*"]` allows all services. Entries without `*` are exact names; `test_*` allows every service whose name starts with `test_`; `*_worker` allows suffix matches; and multiple `*` wildcards are accepted. An explicitly empty list denies every service. The whitelist is applied to trace search, cards, and direct TraceId loads, so `/observability/traces/<trace-id>` cannot be used to read spans from a non-allowed service. When a trace crosses allowed and denied services, only allowed spans are returned; hidden parents may therefore make an allowed child appear as a visible root.

The nested feature switches remove both the UI control and the corresponding payload/query surface. In particular, `resource_attributes`, `span_attributes`, `events`, and `links` can be disabled when the trace page should expose timing only.

For large trace datasets, `docs/traces.md` documents the recommended ClickHouse 26.1+ projection indexes (`prj_traceid` and `prj_start`). They are storage/query optimizations and are not ChDash configuration fields; ChDash continues to query the standard `otel_traces` and `otel_traces_trace_id_ts` table names.

For local/demo data, `examples/generate_otel_traces.py` creates synthetic multi-service traces compatible with the standard OTel ClickHouse trace columns. Its defaults generate roughly 60–90 spans per trace, with Kafka/RPC/ClickHouse-style branches, events, links, and occasional errors. It also emits optional `otel_traces_trace_id_ts` rows for installations where the standard materialized view is not populating the auxiliary table.

The optional `logs {}` and `metrics {}` blocks point ChDash at the OTel Collector ClickHouse exporter logs table (`otel_logs`) and metrics tables (`otel_metrics_gauge`, `_sum`, `_histogram`, `_exponential_histogram`, `_summary`). Both are disabled by default, read through the selected host's `system_uri`, and reuse `traces.service_allowlist` for `ServiceName` filtering (there is no per-signal allowlist).

```hcl
logs {
  enabled              = false
  database             = "otel"
  table                = "otel_logs"
  max_lookback_minutes = 10080
  search_limit         = 200
  body_search          = "token" # token | substring | off
  trace_logs_limit            = 1000
  trace_margin_before_seconds = 5
  trace_margin_after_seconds  = 30
}

metrics {
  enabled      = false
  database     = "otel"
  table_prefix = "otel_metrics"
}
```

`logs.max_lookback_minutes` is clamped to 1 minute..365 days and `logs.search_limit` to 1..10000; `logs.body_search` must be `token`, `substring`, or `off`. `logs.trace_logs_limit` (1..10000) caps the log records of one trace shown on the trace page, read from the trace start minus `logs.trace_margin_before_seconds` to its end plus `logs.trace_margin_after_seconds` (each 0..3600). `/api/version` reports `features.logs.enabled`, `features.logs.body_search`, and `features.metrics.enabled`; `/api/logs/meta` and `/api/metrics/meta` describe the detected schema (see `docs/logs.md` and `docs/metrics.md`).

The optional `query_library {}` block moves the Query page's saved queries from the browser to a JSON file on the server, shared by every user, with folders and descriptions. The history of the runs is never part of it: it stays in the browser (`localStorage`), per host, and is never shared.

```hcl
query_library {
  enabled  = false
  file     = "/var/lib/chdash/query_library.json"
  writable = false

  max_file_bytes  = 8388608
  max_query_bytes = 262144
}
```

With `enabled = false` (the default) every `/api/query-library` route answers 404 and the browser keeps its library in localStorage. `file` is required when enabled; its directory must exist, and the file is created with mode 0600 on the first write. `writable = false` serves the library read-only: folder/query creation, edits, moves, deletions and imports answer 403 `read_only`. A `history {}` block (`history.store`, `history.max_entries`, from earlier releases) is refused at startup: delete it. `max_file_bytes` (64 KiB..1 GiB) caps the file: a write that would exceed it answers 413. `max_query_bytes` (1 KiB..`max_file_bytes`) caps the SQL of one saved query. A file that cannot be parsed is never overwritten: the library is served read-only with `load_error` until the file is fixed. `/api/version` reports `features.query_library = {enabled, writable}`, where `writable` is false while the file has a load error. The REST API and the file format are documented in [`docs/query-library.md`](query-library.md).

`analysis.registry_ttl_ms` and `analysis.registry_max_entries` bound the in-memory host-scoped query registry independently of SSE session lifetime. The registry contains no query results or user identity. `analysis.registry_sql_max_bytes` adds a separate global byte budget for the exact original SQL retained only so Deep Analyze can replay the statement through `runner_uri` without trusting a technical-account query-log copy.

`export.archive_format` currently accepts only `zip`; this deliberately fixes
the V1 archive contract to ZIP/ZIP64. Massive exports use the two-phase
`/api/export/run` → `/api/export/stream` handshake and a forward-only ZIP64
writer, as documented in `docs/massive-export.md`.

Interactive result safety limits live in `query`:

```hcl
query {
  max_result_cell_bytes  = 33554432
  max_result_event_bytes = 33554432
  cancel_token_ttl_ms     = 172800000
}
```

The first two defaults are 32 MiB. Oversized cells/events fail explicitly with `result_cell_too_large` or `result_event_too_large`; data is not silently truncated. These limits apply to interactive SSE results, not the dedicated massive-export stream.

## Query behavior

Normal Run never performs an automatic `system.query_log` lookup and never
forces `SYSTEM FLUSH LOGS`. The former final-query-log settings were removed
because they conflict with the strict minimal Run contract. Persisted logs are
read only through the explicit Analyze action. The existing
`send_profile_events` native setting is kept because it feeds the interactive
CPU/memory metrics and does not introduce a second query.

The live telemetry now distinguishes ClickHouse write progress from result rows
serialized to the browser. Native Progress packets provide `written_rows` and
`written_bytes`; result payload counters are tracked separately as
`result_rows_emitted` and `result_bytes_emitted`.

## Recommended ClickHouse account separation

ChDash rejects top-level `KILL QUERY` statements submitted as panel/export SQL. This is intentional: ClickHouse lets a user cancel its own queries even without the global `KILL QUERY` privilege, and all panel users share the same runner identity. Cancellation therefore goes through the ChDash cancel capability and the `system_uri` account only.

Use two different ClickHouse users. `runner_uri` defines exactly what anyone
with access to the panel may execute. The technical `system_uri` should not be
used as a general SQL account.

A typical starting point is:

```sql
CREATE USER chdash_runner IDENTIFIED WITH sha256_password BY '<runner-password>';
CREATE USER chdash_system IDENTIFIED WITH sha256_password BY '<system-password>';

-- Adapt the database scope and write privileges to what the panel is meant to do.
GRANT SELECT, INSERT, ALTER, CREATE, DROP, TRUNCATE, OPTIMIZE ON analytics.* TO chdash_runner;

-- Technical account used by ChDash for metadata/log lookups and cancellation.
GRANT SELECT ON system.* TO chdash_system;
GRANT KILL QUERY ON *.* TO chdash_system;
GRANT SYSTEM FLUSH LOGS ON *.* TO chdash_system;
```

Do **not** grant `KILL QUERY`, `IMPERSONATE`, or access-management privileges to the runner. ChDash rejects direct `KILL QUERY` panel/export SQL regardless, but keeping those privileges off the runner also protects the boundary if the runner credentials are ever used outside ChDash. If `analysis.flush_logs = true`, the system account also needs the corresponding `SYSTEM FLUSH LOGS` privilege.

Verify the important boundary from ClickHouse itself:

```sql
-- Run as chdash_runner: expected result is 0.
CHECK GRANT KILL QUERY ON *.*;

-- Run as chdash_system: expected result is 1.
CHECK GRANT KILL QUERY ON *.*;
```

The integration stack under `tests/` provisions distinct `chdash_runner` and
`chdash_system` users and checks these two conditions at runtime.

## Password files

Inside `clickhouse.host`, `password_file` applies to both `runner_uri` and
`system_uri`. `runner_password_file` and `system_password_file` override it per
role. The URI must contain the username but no password:

```hcl
clickhouse {
  host {
    name          = "local"
    runner_uri            = "clickhouse://chdash_runner@clickhouse:9000"
    system_uri            = "clickhouse://chdash_system@clickhouse:9000"
    runner_password_file  = "/run/secrets/chdash_runner_password"
    system_password_file  = "/run/secrets/chdash_system_password"
  }
}
```

Native protocol block compression is negotiated per connection through the
`compression` URI query parameter: `lz4` (default), `zstd` or `none`, e.g.
`clickhouse://chdash_runner@clickhouse:9000?compression=zstd`. LZ4 typically
shrinks result and export traffic 3-10x for negligible CPU; use `none` only
when ClickHouse is on the same host and CPU is the bottleneck.

The file is read when a native ClickHouse client is created. One final LF or
CRLF is removed; other whitespace is preserved. A NUL byte, an unreadable file,
or combining a URI password with a password file causes client creation to
fail.
