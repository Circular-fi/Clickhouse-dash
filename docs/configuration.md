# Configuration reference

ClickHouse Dash uses only an HCL file for its configuration:

```bash
chdash --config /etc/clickhouse-dash/config.hcl
chdash --config /etc/clickhouse-dash/config.hcl --health
```

It is an error to start the server or to run `--health` without `--config`.
The application does not read environment variables as configuration. A supervisor or a container runtime can still use environment variables for its own templating. The `chdash` process itself uses only the HCL file.

[`config.example.hcl`](../config.example.hcl) shows the complete syntax.
These items are startup errors:

- Unknown blocks.
- Unknown attributes.
- Duplicate attributes.
- Incorrect HCL types.

## Core blocks

- `server`: listen host and port.
- `query`: limits for interactive queries, batching, SSE backpressure, compatibility DESCRIBE behavior and session lifecycle.
- `client_pool`: lifecycle of the native ClickHouse connection pool.
- `format_cache`: bounded cache of the SQL formatter.
- `health`: polling of the host health.
- `traces`: optional OpenTelemetry trace explorer. It uses a ClickHouse traces table of an OTel Collector.
- `logs` / `metrics`: optional OpenTelemetry logs and metrics sources (tables of the OTel Collector ClickHouse exporter).
- `query_library`: optional server-side query library (folders and saved queries) in a JSON file.
- `mcp`: optional MCP server (`POST /mcp`) with access keys. Each host needs an `mcp_uri`. Refer to [`docs/mcp.md`](mcp.md).
- `system`: the System page (the health of the selected server). It is on by default.
- `clickhouse`: one or more named hosts. Each host has `runner_uri` and `system_uri`. A host can have an `mcp_uri` too.

## Host identities and the access audit

A host has two ClickHouse users, and the health check proves one thing about them: the runner connects. A user that connects and may read nothing is healthy for the health check and useless for the features. For this reason ChDash audits the grants of both users with `CHECK GRANT`. It never reads data and never uses `SHOW GRANTS`. The audit runs with the first health cycles and every 10 minutes.

- **The system user** is checked for `SELECT` on the system tables that the Explorer and the System page read (`system.parts`, `system.disks`, `system.dictionaries`, `system.metrics`, `system.asynchronous_metrics`, `system.clusters`, `system.query_log`). It is also checked for the OpenTelemetry tables that are on for the host (the `observability` block, with the override of the host). ClickHouse lets every user read `system.databases`, `system.tables` and `system.columns` (the rows are filtered by the grants), so the audit does not report them.
- **The runner** is checked for `SELECT` on at least one table (a database-wide grant, or a table-level grant), and for `SELECT` on `system.functions`, `system.documentation` and `system.dictionaries` (the Functions page and `SHOW DICTIONARIES`).
- **The MCP user** (`mcp_uri`, when `mcp.enabled`) is checked the same way: `SELECT` on at least one table, and on `system.documentation` (`explorer_functions`). Every tool of Traces, Logs and Metrics reads the OpenTelemetry tables with the system user, which is checked for them as above (and for `system.data_skipping_indices` when Logs or Metrics are on). The findings are in `access.mcp_user`, `mcp_missing`, `mcp_reads_nothing`, `mcp_audited`, `mcp_connected` and `mcp_error`. An MCP user that cannot connect refuses the keys that name the host, and a missing grant takes some tools away from the keys of the host: the MCP page greys them (`docs/mcp.md`).
- **A system user that cannot connect** is reported too, though the host stays healthy.

A finding never stops the start. It appears in three places:

1. The log, once when it appears and again when it changes: `[access] host=<name> The system user <user> has no SELECT on ...`. A host with no finding says nothing.
2. `GET /api/hosts`, in the `access` object of each host: `ok`, `runner_user`, `system_user`, `runner_reads_nothing`, `runner_missing`, `system_missing` and `warnings` (one sentence each, with the `GRANT` to run). The `error` field of a host that is down says why (the last connection error).
3. Every error answer that comes from a missing grant. The text of ClickHouse ("Not enough privileges") becomes `reason: "not_granted"` with `user`, `grant` and `hint` (`GRANT SELECT ON system.parts TO chdash_sysnone_user;`), whichever route answers.

`tests/backend-functional/test_privileges.py` is the matrix of these setups (a runner limited to two databases, a runner that reads nothing, a system user that reads nothing, a user that does not exist). The tests that it marks `xfail` list what the code still does not do the same way everywhere.

## Authorization model

ChDash has no end-user login, no Bearer authentication and no RBAC for each user. The credentials of the configured host define fully the access to ClickHouse:

- `runner_uri` is the ClickHouse authorization boundary. It is the **only** connection on which the dashboard can run panel-supplied SQL.
- `system_uri` is a technical connection of the backend. The backend uses it only for the metadata queries and log queries that it generates, and for cancellation.

Every caller who can reach a given panel and host therefore has the same ClickHouse permissions. These are the permissions of its `runner_uri`. If you need different sets of permissions, expose different deployments or hosts that use different runners. Do this outside ChDash.

The server still signs short-lived internal capability tokens with a random secret that it creates at boot. These tokens are not user identities. For example, `/api/query/cancel` requires the signed token that the server issued for that query. Cancel tokens carry `purpose=cancel`, the host ID, the query ID, `iat` and `exp`. `query.cancel_token_ttl_ms` has the default value of 48 hours. When ChDash restarts, it changes the signing secret. Older capabilities become invalid before their nominal expiry.

## Evolution blocks

The HCL contract has the settings that Explorer, the System page, the analysis and the massive export need:

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

# Traces, logs and metrics: the OpenTelemetry pages, in one block. See "The observability block" below.
observability {
  service_allowlist = ["*"]

  traces {
    enabled                  = false
    analytics                = false
    database                 = "otel"
    table                    = "otel_traces"
    trace_index_table        = "otel_traces_trace_id_ts"
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

Explorer has no separate `enabled` switch. Its availability comes from the surfaces that are enabled. `explorer.browse` controls the Browse surface. The nested `explorer.graph` block controls the graph families. These rules apply:

- Graph is enabled when `lineage` or `storage_topology` is true.
- Explorer is enabled when Browse or Graph is enabled.
- If only Browse or Graph remains, the Browse/Graph selector disappears. That surface becomes implicit.
- If only one graph family remains, the Lineage/Storage selector disappears. That family becomes implicit.
- If you set `browse = false`, `graph.lineage = false` and `graph.storage_topology = false`, Explorer is disabled. The Explorer routes are disabled, and the Explorer entry of the page switcher (Query / Explorer / Observability / System) is removed.
- The page switcher itself goes when no Explorer page, Observability page or System page remains.

The `system` block controls the **System** page (`/system[/<section>]`, refer to [System](system.md)) and its `/api/system/...` endpoints. Every key is optional.

- `enabled` defaults to `true`. If `enabled = false`, the dashboard removes these items:
  - The System entry of the page switcher.
  - The page.
  - Every `/api/system/...` route, with the `/api/explorer/ops/...` aliases.
  - The redirects of the former Explorer addresses. `/explorer/_monitoring[/<section>]` and `/explorer/_operations` then open the Explorer Catalog.
- `activity` defaults to `true`. It controls the Activity part of the Overview and `/api/system/activity`.
- `keeper` defaults to `true`. It controls the Keeper card of the Overview and `/api/system/keeper`. If `keeper = false`, the tables of merges, mutations, replication and Distributed stay.
- `top_queries` defaults to `true`. It controls the Queries section and its `/api/system/queries` routes. The dashboard reads them with the runner account. The runner account then needs `SELECT ON system.query_log`. Otherwise, the section shows the GRANT.
- `cluster_fanout` defaults to `false`. If you enable it, the dashboard uses the `clusterAllReplicas` views. The system account needs `GRANT REMOTE ON *.*` for them. If it is off, every figure is from the selected host only.

The other keys bound the history parts. These parts read the system logs of the server. The dashboard limits the values at startup:

| Key | Default | Range | Use |
|---|---|---|---|
| `max_lookback_days` | 30 | 1 to 365 | `metric_log` and `asynchronous_metric_log` |
| `default_lookback_minutes` | 60 | 1 minute to `max_lookback_days` | Default window |
| `query_log_max_lookback_hours` | 168 | 1 to 720 | Window of `query_log` |
| `query_log_max_rows` | 50,000,000 rows read for each request | 1,000 to 10,000,000,000 | A larger read stops with an error. It does not give a partial answer. |
| `disk_growth_days` | 7 | 1 to `max_lookback_days` | Default window of the disk growth |

These rules apply to the windows:

- The Performance part of the Overview (`/api/system/series`) opens on `default_lookback_minutes`.
- It refuses a window that is wider than `max_lookback_days`.
- It reads the latency percentiles from `query_log` only for windows of `query_log_max_lookback_hours` or less. `query_log_max_rows` bounds these reads. For longer windows, it reads the average from `metric_log`.
- Disks (`/api/system/disks` and `/api/system/series?panel=disk_growth`) shows the growth of the disks over the last `disk_growth_days` by default. Any window up to `max_lookback_days` is possible.
- Queries reads windows of `query_log_max_lookback_hours` or less. `query_log_max_rows` caps each read.

`/api/version` reports the block as `features.system`. The report contains `enabled`, `activity`, `keeper`, `top_queries`, `cluster_fanout` and the four windows. It does not contain `query_log_max_rows`. Only the answers of Queries report that key.

Every System query sets `readonly = 2`, a time budget and read caps. For this reason, neither account can have a `readonly = 1` profile. The live answers are the tiles, Keeper and Activity of the Overview. The dashboard caches them for each host for `min(explorer.cache_ttl_ms, 5 s)`, at least 1 s.

`explorer.operations { enabled, keeper }` is the v2.14.0 key of the former Server operations view. It still works:

- `enabled = false` turns both `system.activity` and `system.keeper` off.
- `keeper = false` turns `system.keeper` off.
- A `system { }` block that sets `activity` or `keeper` wins over it.

`/api/version` still reports `features.explorer.operations` (`enabled`, `keeper`). It mirrors `system.activity` and `system.keeper`. `/api/explorer/ops/activity` and `/api/explorer/ops/keeper` stay as aliases of `/api/system/activity` and `/api/system/keeper`.

`explorer.function_markdown_links` defaults to `false`. The dashboard then shows the links in the ClickHouse function Markdown as plain text. If you enable it, only the targets that are relative to the documentation and begin with `/` or `./` become links. Arbitrary external URLs stay not clickable.

### The observability block

The Traces, Logs and Metrics pages have one block, `observability`, with a section for each signal and one allowlist for the three. A signal is off until its `enabled` is `true`. The block holds the settings that are the same for every host. The tables can differ from a host to another: [a host overrides them](#where-the-tables-of-a-host-are).

```hcl
observability {
  service_allowlist = ["*"]       # the allowlist of the three signals

  traces {
    enabled              = true
    analytics            = false
    database             = "otel"
    table                = "otel_traces"
    trace_index_table    = "otel_traces_trace_id_ts"
    # default_lookback_minutes, max_lookback_minutes, search_limit, max_spans_per_trace,
    # highlighted_attributes, linked_from_margin_minutes, features { ... }: see docs/traces.md
  }
  logs {
    enabled              = true
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
    enabled      = true
    database     = "otel"
    table_prefix = "otel_metrics"
  }
}
```

The older top-level `traces {}`, `logs {}` and `metrics {}` blocks (and `traces.service_allowlist`) still work, and mean the same. A signal is set in one place only: a configuration that has `observability { traces { } }` and a top-level `traces {}` does not start, and neither does one that gives the allowlist twice. New configurations should use `observability`.

The defaults match the OpenTelemetry Collector ClickHouse exporter (`otel_traces` plus `otel_traces_trace_id_ts`, `otel_logs`, `otel_metrics_gauge`, `_sum`, `_histogram`, `_exponential_histogram` and `_summary`). The pages follow the host that the user selects in the normal host picker. They always read with the `system_uri` of that host. There is no override of the credentials for each signal.

#### Where the tables of a host are

Two hosts do not always keep their OpenTelemetry tables under the same names (another database, a prefix for each region, no logs at all). A host can override where its tables are, and whether a signal is on for it, in an `observability` block of its own:

```hcl
clickhouse {
  host {
    name = "eu"
    # ...
    observability {
      traces  { database = "otel_eu"  table = "spans"  trace_index_table = "spans_by_trace" }
      logs    { table = "records" }
      metrics { table_prefix = "eu_metrics" }
    }
  }
  host {
    name = "lab"
    # ...
    observability {
      traces  { enabled = false }
      logs    { enabled = false }
    }
  }
}
```

- A host can change `enabled`, `database` and `table` (traces: also `trace_index_table`; logs: `table`; metrics: `table_prefix`). Everything else (the lookbacks, the limits, the allowlist, the features) is the block of the configuration, the same for every host. An attribute that a host cannot change is an error.
- What the host does not name is the setting of the block. A host may turn on a signal that the block leaves off, with its tables.
- A signal is on for the instance when it is on for at least one host: the pages and the routes exist. Each request is served with the settings of the host that it names: a host where the signal is off answers `traces_disabled`, `logs_disabled` or `metrics_disabled`, the other hosts answer normally. `/api/version` (`features.traces.enabled`, `features.logs.enabled`, `features.metrics.enabled`) says whether the signal is on for at least one host; `/api/traces/meta`, `/api/logs/meta` and `/api/metrics/meta` name the tables of the host that they describe.
- The access audit (see above) checks the tables of each host with its system user, and the MCP tools read the tables of the host that they name.
- A signal that is on for a host needs a database and a table (or a prefix): `clickhouse.host <name>: observability.traces database and table cannot be empty` is a startup error.

#### The rules of the Trace Explorer

`default_lookback_minutes` and `max_lookback_minutes` bound only the search and filter queries. The lookback does not limit a direct lookup of `/observability/traces/<trace-id>`. This lookup requires `trace_index_table`. ChDash resolves the time range of the trace there. It never scans all the history in the traces table to find a missing TraceId.

`traces.analytics` defaults to `false`. Set it to `true` to enable the expensive graphs of the matching traces and of the duration percentiles. The search results use `/api/traces/search`. The graph data uses the independent route `/api/traces/analytics`. For this reason, the loading of the graph never blocks the response with the trace results.

`service_allowlist` is a whitelist of `ServiceName` that the backend enforces **for traces, logs and metrics**. The default `service_allowlist = ["*"]` allows all services. These rules apply:

- An entry without `*` is an exact name.
- `test_*` allows every service with a name that starts with `test_`.
- `*_worker` allows the matches of the suffix.
- Multiple `*` wildcards are accepted.
- An explicitly empty list denies every service.

The whitelist applies to the trace search, to the cards and to the direct loads of a TraceId, to the logs and to the metrics. The MCP tools carry it too: they read with the system user, as the pages do, so a key never reads a service that the pages do not show. For this reason, nobody can use `/observability/traces/<trace-id>` to read spans from a service that is not allowed. When a trace crosses allowed services and denied services, the dashboard returns only the allowed spans. Hidden parents can therefore make an allowed child look like a visible root.

The nested feature switches remove the UI control and the corresponding payload and query surface. For example, you can disable `resource_attributes`, `span_attributes`, `events` and `links` when the trace page must show only the timing.

For large trace datasets, `docs/traces.md` describes the recommended projection indexes for ClickHouse 26.1+ (`prj_traceid` and `prj_start`). They are optimizations of the storage and of the queries. They are not ChDash configuration fields.

For local or demo data, `examples/generate_otel_traces.py` creates synthetic traces of several services. They are compatible with the standard OTel ClickHouse trace columns. By default, it generates about 60–90 spans for each trace. It makes branches in the style of Kafka, RPC and ClickHouse, and it makes events, links and occasional errors. It also emits optional `otel_traces_trace_id_ts` rows. These rows are for installations where the standard materialized view does not fill the auxiliary table.

#### Logs and metrics

- The dashboard limits `logs.max_lookback_minutes` to the range of 1 minute to 365 days. It limits `logs.search_limit` to the range of 1 to 10000.
- `logs.body_search` must be `token`, `substring` or `off`.
- `logs.trace_logs_limit` (1..10000) caps the log records of one trace that the trace page shows. The dashboard reads them from the start of the trace minus `logs.trace_margin_before_seconds` to its end plus `logs.trace_margin_after_seconds` (each 0..3600).
- `/api/version` reports `features.logs.enabled`, `features.logs.body_search` and `features.metrics.enabled`.
- `/api/logs/meta` and `/api/metrics/meta` describe the schema that the dashboard detected (refer to `docs/logs.md` and `docs/metrics.md`).

The optional `query_library {}` block moves the saved queries of the Query page from the browser to a JSON file on the server. Every user shares this file. It has folders and descriptions. The history of the runs is never a part of it. The history stays in the browser (`localStorage`) for each host, and nobody shares it.

```hcl
query_library {
  enabled  = false
  file     = "/var/lib/chdash/query_library.json"
  writable = false

  max_file_bytes  = 8388608
  max_query_bytes = 262144
}
```

- With `enabled = false` (the default), every `/api/query-library` route answers 404. The browser keeps its library in localStorage.
- `file` is required when the library is enabled. Its directory must exist. The dashboard creates the file with mode 0600 on the first write.
- `writable = false` serves the library read-only. The creation of folders and queries, edits, moves, deletions and imports answer 403 `read_only`.
- A `history {}` block (`history.store`, `history.max_entries`, from earlier releases) is refused at startup. Delete it.
- `max_file_bytes` (64 KiB..1 GiB) caps the file. A write that exceeds it answers 413.
- `max_query_bytes` (1 KiB..`max_file_bytes`) caps the SQL of one saved query.
- The dashboard never overwrites a file that it cannot parse. It serves the library read-only with `load_error` until you fix the file.
- `/api/version` reports `features.query_library = {enabled, writable}`. `writable` is false while the file has a load error.

[`docs/query-library.md`](query-library.md) describes the REST API and the file format.

The optional `mcp {}` block turns on the MCP server. AI clients call `POST /mcp` with an access key, and read ClickHouse data through the host `mcp_uri`. The default is `enabled = false`.

```hcl
mcp {
  enabled        = true
  storage_file   = "/var/lib/chdash/mcp_keys.json"
  manage_from_ui = true

  max_rows              = 1000
  max_result_bytes      = 1048576
  query_timeout_seconds = 30
  max_sql_bytes         = 65536
  max_memory_bytes      = 1073741824
  max_rows_to_read      = 0
  rate_limit_per_minute = 600
  allowed_origins       = []

  key {
    name      = "ci-bot"
    secret    = "replace-with-a-long-random-secret"
    hosts     = ["local"]
    tools     = ["list_databases", "list_tables", "describe_table", "query_table"]
    databases = ["otel"]
  }
}
```

- `enabled = true` needs a `storage_file`, or at least one `key` block, and at least one host with `mcp_uri`. If not, ChDash stops with `config error`.
- Each `key` block has exactly one of `secret`, `secret_file` and `secret_sha256` (24 bytes or more). The keys of the page are in `storage_file` (the hash and the secret, mode 0600). The two sources add up.
- A host without `mcp_uri` is invisible to MCP. The password of the MCP user is in `mcp_uri`. It never falls back to the runner or system credentials, nor to `password_file`.
- Each limit is a global cap. A key can only lower `max_rows` and `timeout_seconds`.
- `/api/version` reports `features.mcp = {enabled}`. `/api/mcp/meta` always answers.

[`docs/mcp.md`](mcp.md) describes the keys, the tools, the endpoint, the API, the grants of the ClickHouse user and the startup errors.

`analysis.registry_ttl_ms` and `analysis.registry_max_entries` bound the in-memory query registry for each host. This bound does not depend on the lifetime of the SSE session. The registry contains no query results and no user identity. `analysis.registry_sql_max_bytes` adds a separate global byte budget. It is for the exact original SQL that the backend retains only for Deep Analyze. Deep Analyze can then replay the statement through `runner_uri`. It does not need to trust a copy of the query log from the technical account.

`export.archive_format` currently accepts only `zip`. This fixes the V1 archive contract to ZIP/ZIP64 on purpose. Massive exports use the two-phase handshake `/api/export/run` → `/api/export/stream` and a forward-only ZIP64 writer. `docs/massive-export.md` describes them.

The `query` block holds the safety limits for interactive results:

```hcl
query {
  max_result_cell_bytes  = 33554432
  max_result_event_bytes = 33554432
  cancel_token_ttl_ms     = 172800000
}
```

The first two defaults are 32 MiB. A cell or an event that is too large fails with an explicit error: `result_cell_too_large` or `result_event_too_large`. The dashboard does not truncate data silently. These limits apply to interactive SSE results. They do not apply to the dedicated massive-export stream.

## Query behavior

A normal Run never does an automatic lookup in `system.query_log`. It never forces `SYSTEM FLUSH LOGS`. The dashboard removed the former final-query-log settings, because they conflict with the strict minimal Run contract. The dashboard reads the persisted logs only through the explicit Analyze action. The existing native setting `send_profile_events` stays. It feeds the interactive CPU and memory metrics. It does not add a second query.

The live telemetry now makes a difference between the ClickHouse write progress and the result rows that the backend serializes to the browser. Native Progress packets give `written_rows` and `written_bytes`. The backend tracks the counters of the result payload separately as `result_rows_emitted` and `result_bytes_emitted`.

## Recommended ClickHouse account separation

ChDash rejects top-level `KILL QUERY` statements that the user sends as panel SQL or export SQL. This is intentional. ClickHouse lets a user cancel its own queries even without the global `KILL QUERY` privilege, and all panel users share the same runner identity. Cancellation therefore goes only through the ChDash cancel capability and the `system_uri` account.

Use two different ClickHouse users. `runner_uri` defines exactly what anyone with access to the panel can run. Do not use the technical `system_uri` as a general SQL account.

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

Do **not** grant `KILL QUERY`, `IMPERSONATE` or access-management privileges to the runner. ChDash rejects direct `KILL QUERY` panel SQL and export SQL in all cases. But if you keep these privileges off the runner, you also protect the boundary when somebody uses the runner credentials outside ChDash. If `analysis.flush_logs = true`, the system account also needs the corresponding `SYSTEM FLUSH LOGS` privilege.

Verify the important boundary from ClickHouse itself:

```sql
-- Run as chdash_runner: expected result is 0.
CHECK GRANT KILL QUERY ON *.*;

-- Run as chdash_system: expected result is 1.
CHECK GRANT KILL QUERY ON *.*;
```

The integration stack under `tests/` provisions the distinct users `chdash_runner` and `chdash_system`. It checks these two conditions at runtime.

## Password files

Inside `clickhouse.host`, `password_file` applies to `runner_uri` and to `system_uri`. It does not apply to `mcp_uri`: write the password of the MCP user in `mcp_uri`. `runner_password_file` and `system_password_file` override it for each role. The URI must contain the username but no password:

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

The `compression` query parameter of the URI sets the compression of native protocol blocks for each connection. The values are `lz4` (default), `zstd` or `none`. For example: `clickhouse://chdash_runner@clickhouse:9000?compression=zstd`. LZ4 typically makes the traffic of results and exports 3-10x smaller, for a negligible CPU cost. Use `none` only when ClickHouse is on the same host and the CPU is the bottleneck.

The dashboard reads the file when it creates a native ClickHouse client. It removes one final LF or CRLF. It keeps other whitespace. The client creation fails in these cases:

- The file contains a NUL byte.
- The file is not readable.
- The URI has a password and a password file is also set.
