# Configuration reference

ClickHouse Dash uses only one HCL file for its configuration:

```bash
chdash --config /etc/clickhouse-dash/config.hcl
chdash --config /etc/clickhouse-dash/config.hcl --health
chdash --config /etc/clickhouse-dash/config.hcl --print-config
```

It is an error to start the server or to run `--health` or `--print-config` without `--config`.

`--print-config` checks the file, prints the value that applies for each key, and exits with status 0. Each line is `name = value  # source`. The source shows where the value comes from:

- `file`: the file gives the value.
- `env:VAR`: the environment variable `VAR` gives it.
- `file:/path`: the file at that path gives it.
- `default`: the program gives it.

The output has the keys of the table, the service allowlist and the highlighted attributes. It also has each host, each query library and each MCP key of the file (for example `clickhouse.host[prod].runner_uri`, `query_library[team].file` and `mcp.key[ci].hosts`). It hides each secret: a secret shows as `<hidden>`, or as `<none>` when it is not set. The password in a URI shows as `***`. The server writes the same values in the `server.config` log line at start. It writes the sources that are not `default` in the `server.config.sources` line.

`--health` asks the server (`GET /livez` on its listen port). It exits with status 0 when the server answers ([operations.md](operations.md#health-probes)).

The configuration file is the only source of configuration. ChDash reads an environment variable only when the file names it with an attribute that ends in `_env`. Refer to [Secrets](#secrets). A supervisor or a container runtime can use environment variables for its own needs. The `chdash` process does not read them.

[`config.example.hcl`](../config.example.hcl) shows the complete syntax. [`configuration-reference.md`](configuration-reference.md) lists every key with its type, default, range and use. It is generated from the table of keys in the code (`src/config_keys.def`). It always agrees with the program.

The syntax is a subset of HCL: blocks, attributes, strings in double quotes, whole decimal numbers, `true` and `false`, and lists of strings. Strings accept the escapes `\"`, `\\`, `\n`, `\r`, `\t`, `\uXXXX` and `\UXXXXXXXX`. Comments start with `#` or `//`. A comment can also sit between `/*` and `*/`.

The program does not support block labels (`host "x" { }`), numbers with a fraction, an exponent or a digit separator, heredoc strings, or expressions. The error says so. A syntax error names the line and the column.

These items are startup errors:

- Unknown blocks.
- Unknown attributes.
- Duplicate attributes.
- Incorrect HCL types. The error names the key, the type that it must have, and the value that the file gives.
- A number outside the range of its key, or a text that is not one of the choices of its key. ChDash does not change a value to make it fit. The value in the file is the value that applies. Otherwise, the process does not start. The error names the key, the range and the value.
- Two keys that contradict each other (for example `server.max_worker_threads` below `server.worker_threads`).
- A ClickHouse URI that is not valid: a parameter that is not known (`verfy=0`), or a compression that does not exist. The error names the host and the field.
- A secret in clear text. These are a password in `runner_uri`, `system_uri` or `mcp_uri`, and the parameter `password_file` in one of them. These are also the attributes `password`, `runner_password`, `system_password` and `mcp_password`, and the attribute `secret` of an MCP key. The error never repeats the secret.
- A secret with two sources. These are `<name>_env` and `<name>_file` together, or two attributes that give the same password (for example `password_file` and `runner_password_file`). Nothing takes precedence silently.
- A secret that ChDash cannot read. This is an environment variable that is not set or is empty, or a file that cannot be read or is empty. The error gives the attribute and the variable or the path.
- Two keys that contradict each other. These are `server.max_host_streams` above half of `server.max_worker_threads`, and an `explorer.operations` block with a `system` block. `explorer.operations.enabled = false` with `keeper = true` is also a contradiction. So is `access.mode = "open"` with an `access.identity` or `access.pdp` block.
- A file without the `access` block ([access.md](access.md)).

## Core blocks

- `server`: listen host and port, and the capacity of the HTTP server (refer to [The server block](#the-server-block)).
- `query`: limits for interactive queries, batching, SSE backpressure, compatibility DESCRIBE behavior and session lifecycle.
- `generated_queries`: the bounds of the queries that ChDash writes itself (refer to [The bounds of the queries](#the-bounds-of-the-queries)).
- `client_pool`: lifecycle of the native ClickHouse connection pool, and the bound of its connections.
- `format_cache`: bounded cache of the SQL formatter.
- `health`: polling of the host health.
- `traces`: optional OpenTelemetry trace explorer. It uses a ClickHouse traces table of an OTel Collector.
- `logs` / `metrics`: optional OpenTelemetry logs and metrics sources (tables of the OTel Collector ClickHouse exporter).
- `query_library`: optional server-side query library (folders and saved queries) in a JSON file.
- `mcp`: optional MCP server (`POST /mcp`) with access keys. Each host needs an `mcp_uri`. Refer to [`docs/mcp.md`](mcp.md).
- `telemetry`: optional OTLP export of the spans and of the call log of MCP. Refer to [`docs/server-telemetry.md`](server-telemetry.md).
- `access`: required. It sets the access of humans to the pages and to the API. Use `mode = "authzen"` (an identity token on each request, and a PDP that decides each action) or `mode = "open"` (no check). Refer to [`docs/access.md`](access.md).
- `system`: the System page (the health of the selected server). It is enabled by default.
- `clickhouse`: one or more named hosts. Each host has `runner_uri` and `system_uri`. A host can have an `mcp_uri` too.

## The server block

```hcl
server {
  listen_host         = "0.0.0.0"
  listen_port         = 8080
  worker_threads      = 0
  max_worker_threads  = 256
  max_queued_requests = 1024
  max_body_bytes      = 0
  max_host_streams    = 64
  write_timeout_ms    = 120000

  shutdown_timeout_ms   = 10000
  metrics               = true
  access_log            = true
  stats_log_interval_ms = 300000
}
```

A stream holds one worker thread for as long as it lasts. These are the streams: a query that is in
progress (`GET /api/query/stream`), an export, and the host status of each open
page (`GET /api/hosts/stream`). The capacity settings keep threads free.
A request such as a cancel still gets an answer.

- `worker_threads`: the threads kept ready. `0` (the default) is
  `max(8, hardware threads)`. At most 1024.
- `max_worker_threads`: the most threads the pool grows to under load (at least
  `worker_threads`, at most 4096). A thread that stays idle for 3 seconds
  exits.
- `max_queued_requests` (16..100000): the connections that wait for a thread
  when all of them are busy. Past it, a new connection is closed at once.
- `max_body_bytes`: the largest request body. A larger one answers 413 before
  it is read. `0` (the default) is twice `query.max_sql_bytes` plus 1 MiB. When
  the query library is enabled, `0` is the larger of that value and
  `query_library.max_file_bytes` plus 64 KiB. Between 64 KiB and 2 GiB.
- `max_host_streams`: the open host status streams. Past it, a page gets 503
  and polls `GET /api/hosts` every 5 seconds instead. The value is at most half
  of `max_worker_threads`. A higher value stops the start. ChDash does not lower
  it.
- `shutdown_timeout_ms` (1000..600000, default 10000): the longest stop after
  SIGTERM or SIGINT. Past it, the process exits with status 1
  ([operations.md](operations.md#shutdown)).
- `metrics` (default true): `GET /metrics`, the Prometheus text format
  ([operations.md](operations.md#metrics)).
- `access_log` (default true): one log line for each request
  ([operations.md](operations.md#logs)).
- `stats_log_interval_ms` (default 300000; `0` = never, else at least 10000):
  the interval of the `server.stats` log line.
- `write_timeout_ms` (1000..3600000, default 120000): how long one write of a
  response waits for a client that does not read. A paused download, a slow
  disk or a busy browser tab can stop reading for a while. Past this time, the
  response ends: an export or a run is then canceled. The value applies to
  every response.

Each worker thread has a stack of 8 MiB. The binary is linked with
`-z stack-size`. Otherwise, musl gives 128 KiB. A request body nested deeper
than 256 arrays or objects is refused as invalid JSON. The SQL formatter returns
a statement that is nested too deep to lay out as it was written.

A binary with embedded assets (every release) serves only those assets. A build
without them (`-DCHDASH_EMBED_STATIC=OFF`, the test image) reads `./static`. It
serves a file only when its resolved path stays inside that directory.

## The bounds of the queries

Every statement that ChDash sends to ClickHouse has a label and bounds. The settings go with the statement. The settings profile of the ClickHouse user stays the base:

- ChDash reads the profile of the user once for each connection (`getSetting`). It sends a bound only when the bound is stricter than the profile. ChDash never makes a bound of the profile looser.
- A user with `readonly = 1` cannot change a setting. Its statements get no setting from ChDash, and only its profile bounds them.
- A `SETTINGS` clause in the SQL has priority over the settings of ChDash. To enforce a bound on the users of the panel, put it in the settings profile of the runner, with a constraint.
- If ClickHouse refuses a setting of ChDash (`READONLY` or a constraint of the profile), ChDash runs the statement again without its settings. On that connection, ChDash sends no settings again.
- A statement of a read-only subject of the access of humans (`readonly = 1`, [access.md](access.md)) is not run again. It fails, and the connection keeps its state: its later statements still get all their settings. A `SETTINGS` clause of such a statement can thus never remove the bounds of the connection. If a constraint of the profile of the runner refuses a bound of ChDash, the statements of a read-only subject fail (fail closed): set the bound in the profile, or remove it from the configuration.

| What | `log_comment` | Bounds |
|---|---|---|
| A run of the Query page | `chdash-run` | `query.max_execution_time_s`, `query.max_memory_usage`, `query.max_rows_to_read` (0 = the profile, the default) |
| Deep Analyze | `chdash-deep-analysis` | the same as a run, and `analysis.deep_max_execution_time_s` (default 300 seconds) |
| A statement of an export | `chdash-export` | `export.max_execution_time_s`, `export.max_memory_usage` (0 = the profile, the default) |
| A request of a page (Explorer, System, Traces, Logs, Metrics, the analysis, the formatter, the metadata) | `chdash:<path of the route>`, `chdash-system` for the System page | `generated_queries` |
| A tool of MCP | `chdash-mcp key=<id>` | the limits of the key (`docs/mcp.md`) |
| A cancel, the health checks | `chdash:cancel`, `chdash:health` | none |

```hcl
generated_queries {
  timeout_ms       = 60000
  max_memory_usage = 4294967296
  max_rows_to_read = 20000000000
}
```

- `timeout_ms` (1000..3600000, default 60000): the time of one request of a page. Each statement of the request gets `max_execution_time` = the seconds that remain (at least 1). A statement that starts after the end fails at once with `TIMEOUT_EXCEEDED`. It does not reach ClickHouse. A route that sets its own `max_execution_time` in its SQL keeps it.
- `max_memory_usage` (default 4 GiB): the memory of one statement, in bytes. `0` leaves it to the profile.
- `max_rows_to_read` (default 20 000 000 000): the rows that one statement may read. A statement that reads more rows fails with `<page>_scan_limit` (422, [operations.md](operations.md#errors)). `0` leaves it to the profile. The System page sets its own cap (`system.query_log_max_rows`), and a route that sets `max_rows_to_read` in its SQL keeps it.
- The Explorer adds its own caps. Each statement gets 10 seconds. The data preview gets 30 seconds and 64 MiB of result (`result_overflow_mode = 'break'`: the preview then has fewer rows).
- The Metrics catalog stops its scan after 200 million rows read and answers `estimated: true` (`docs/metrics.md`).

A request of a page stops when the browser closes the connection. The next packet of the statement in progress throws. ChDash closes the connection, and ClickHouse cancels the statement. A run stops in the same way (and with `KILL QUERY`). An export stops too.

The heavy reads of the pages obtain a slot first, for each host ([operations.md](operations.md#admission)). The `admission` block sets `heavy_per_host`, `analysis_per_host`, `mcp_max` and `wait_ms`. A statement stops too when the server stops.

The preview limit of a run (`query.result_preview_row_limit`) is a normal end. ChDash stops reading with a Cancel packet of the native protocol: the connection stays usable, and ChDash sends no `KILL QUERY`.

## The connections

A connection returns to the pool only when its last statement ended in a known state. That state is the end of its result, or an error that ClickHouse sent. A statement that a transport error, a receive timeout, a cancel or an error of ChDash interrupted can leave its packets in the socket. ChDash then closes the connection. A next statement of the same request opens a new one.

```hcl
client_pool {
  max_leased_per_uri = 128
  lease_wait_ms      = 5000
}
```

- `max_leased_per_uri` (default 128, 0 = no limit): the connections that are lent at once for one ClickHouse URI. Past it, a request waits for a connection.
- `lease_wait_ms` (0..60000, default 5000): how long a request waits. Then it fails with `pool_exhausted`.
- A cancel (`KILL QUERY`) and an export use a connection of their own, outside of the pool.

## Host identities and the access audit

A host has two ClickHouse users. The health check proves one thing about them: the runner connects. A user that connects and may read nothing is healthy for the health check and useless for the features. For this reason, ChDash audits the grants of both users with `CHECK GRANT`. It never reads data and never uses `SHOW GRANTS`. The audit runs during the first health cycles and every 10 minutes.

- **The system user** is checked for `SELECT` on the system tables that the Explorer and the System page read. These tables are `system.parts`, `system.disks`, `system.dictionaries`, `system.metrics`, `system.asynchronous_metrics`, `system.clusters` and `system.query_log`. It is also checked for the OpenTelemetry tables that are enabled for the host (the `observability` block, with the host override). ClickHouse lets every user read `system.databases`, `system.tables` and `system.columns` (the rows are filtered by the grants), so the audit does not report them.
- **The runner** is checked for `SELECT` on at least one table. This can be a database-wide grant or a table-level grant. It is also checked for `SELECT` on `system.functions`, `system.documentation` and `system.dictionaries` (the Functions page and `SHOW DICTIONARIES`).
- **The MCP user** (`mcp_uri`, when `mcp.enabled`) is checked the same way: `SELECT` on at least one table, and on `system.documentation` (`explorer_functions`). Every tool of Traces, Logs and Metrics reads the OpenTelemetry tables with the system user. That user is checked for them as above, and for `system.data_skipping_indices` when Logs or Metrics are enabled. The findings are in `access.mcp_user`, `mcp_missing`, `mcp_reads_nothing`, `mcp_audited`, `mcp_connected` and `mcp_error`. An MCP user that cannot connect refuses the keys that name the host. A missing grant removes some tools from the keys of the host. The MCP page shows these tools in grey (`docs/mcp.md`).
- **The privilege `displaySecretsInShowAndSelect`.** The runner and the MCP user are checked for this privilege (`CHECK GRANT displaySecretsInShowAndSelect ON *.*`). A user that holds it is a finding. Refer to [Secrets in the DDL texts](#secrets-in-the-ddl-texts).
- **A system user that cannot connect** is reported too, though the host stays healthy.

The audit has its own thread and a budget of 60 seconds for each host. It never delays the health check of a host. A finding never stops the start. It appears in three places:

1. The log, once when it appears and again when it changes: `{"event":"access.finding","host":"<name>","finding":"The system user <user> has no SELECT on ..."}` ([operations.md](operations.md#logs)). A host with no finding says nothing.
2. `GET /api/hosts`, in the `access` object of each host: `ok`, `runner_user`, `system_user`, `runner_reads_nothing`, `runner_shows_secrets`, `mcp_shows_secrets`, `runner_missing`, `system_missing` and `warnings` (one sentence each, with the `GRANT` to run). The `error` field of a host that is down says why (the last connection error).
3. Every error answer that comes from a missing grant. The text of ClickHouse ("Not enough privileges") becomes `reason: "not_granted"` with `user`, `grant` and `hint` (`GRANT SELECT ON system.parts TO chdash_sysnone_user;`), whichever route answers.

`tests/backend-functional/test_privileges.py` is the matrix of these setups. The setups are: a runner limited to two databases, a runner that reads nothing, a system user that reads nothing, and a user that does not exist. The tests that it marks `xfail` list what the code still does not do the same way everywhere.

### Secrets in the DDL texts

ClickHouse can mask the secrets in the DDL of an object. A secret is a key or a password of an `S3`, `MySQL`, `PostgreSQL` or `URL` engine or table function. The masked text has `'[HIDDEN]'` in place of each secret. Three columns of `system.tables` have such a text: `create_table_query`, `engine_full` and `as_select`.

ChDash reads these three columns as the runner. The runner is the identity that bounds the caller. For the API tools of MCP, the runner is the MCP user. The system user never gives a DDL text. A caller of the Explorer or of an API tool gets the text that the runner sees, and no more.

A user reads the clear text when three conditions hold together:

| # | Condition | Default |
| --- | --- | --- |
| 1 | The server setting `display_secrets_in_show_and_select` is `true`. It is in the configuration file of the server. | `false` |
| 2 | The setting `format_display_secrets_in_show_and_select` is `1` for the query. The profile of the user sets it, or the query sets it. | `0` |
| 3 | The user holds the privilege `displaySecretsInShowAndSelect`. | not granted |

The test of this rule ran on ClickHouse 26.7.5.10, the version of the test stack. The users had `SELECT` on the tables. The tables had a secret in an `S3` engine and in a view that calls `s3()`:

| User | Server setting (1) | Format setting (2) | Privilege (3) | Text that the user reads |
| --- | --- | --- | --- | --- |
| plain | on | `0` | no | masked |
| plain, query sets the format setting to `1` | on | `1` | no | masked |
| privilege only | on | `0` | yes | masked |
| privilege, profile sets the format setting to `1` | on | `1` | yes | clear |
| privilege, `readonly = 2`, query sets the format setting to `1` | on | `1` | yes | clear |
| privilege, profile with `format_display_secrets_in_show_and_select = 0 CONST` | on | locked at `0` | yes | masked. A query that sets `1` fails with `SETTING_CONSTRAINT_VIOLATION`. |
| privilege, profile sets the format setting to `1` | off | `1` | yes | masked |

`CHECK GRANT displaySecretsInShowAndSelect ON *.*` gives `1` to a user that holds the privilege. It also gives `1` to a user that has all the privileges. It gives `0` to any other user.

A user with `readonly = 2` can change every setting except `readonly`. Its query can set the format setting. A profile with `readonly = 1` refuses every change of a setting.

What to do:

- Do not grant `displaySecretsInShowAndSelect` to the runner or to the MCP user.
- If one of them must hold it, lock the format setting in its settings profile. A constraint that cannot change the value is `CONST`:

  ```sql
  CREATE SETTINGS PROFILE chdash_runner_profile SETTINGS format_display_secrets_in_show_and_select = 0 CONST TO chdash_runner;
  ```

  A `readonly` constraint on the setting has the same effect: `SETTINGS format_display_secrets_in_show_and_select = 0 READONLY`.
- Leave the server setting `display_secrets_in_show_and_select` off when no user needs it.

The access audit checks the privilege of the runner and of the MCP user every 10 minutes. It does not check the profile, so it reports each holder, also when a constraint locks the setting. A holder is a finding: the log line `access.finding`, `warnings` in `GET /api/hosts` and the fields `runner_shows_secrets` and `mcp_shows_secrets`. A finding never stops the start.

## Authorization model

ChDash has no login page and no user directory. The `access` block selects one of two models ([access.md](access.md)):

- `mode = "authzen"`: an access gateway in front of ChDash authenticates each human and sends a signed identity token. ChDash verifies the token on each request of the pages and of the API. It asks an AuthZEN PDP for each action (`query.run.read`, `query.run.write`, `query.export`, `library.read`, `library.write`, `explorer.read`, `system.read`, `system.kill_query`, `observability.read`, `mcp.keys.read`, `mcp.keys.write`, `mcp.usage.read`). Without `query.run.write`, a run has `readonly = 1`.
- `mode = "open"`: ChDash checks nothing. Everyone who can reach the port has all the actions.

In the two models, the credentials of the configured host limit the access to ClickHouse:

- `runner_uri` is the ClickHouse authorization boundary. It is the **only** connection on which the dashboard can run panel-supplied SQL.
- `system_uri` is a technical connection of the backend. The backend uses it only for the metadata queries and log queries that it generates, and for cancellation. It never reads a DDL text that ClickHouse masks by user. The cancel of a run, of an export and of a Deep Analyze job (and the stop of the server) send their `KILL QUERY` through it.

Every caller who has an action on a given panel and host therefore has the same ClickHouse permissions. These are the permissions of its `runner_uri` (with `readonly = 1` without `query.run.write`). If you need different sets of data permissions, expose different deployments or hosts that use different runners.

The server still signs short-lived internal capability tokens with a random secret that it creates at start. These tokens are not user identities. For example, `/api/query/cancel` requires the signed token that the server issued for that query.

Cancel tokens carry `purpose=cancel`, the host ID, the query ID, `iat` and `exp`. `query.cancel_token_ttl_ms` has the default value of 48 hours. When ChDash restarts, it changes the signing secret. Older capabilities become invalid before their nominal expiry.

`POST /api/query/cancel` answers `{"ok": true, "stopped": <bool>, "killed": <n>}`. `stopped` is true when a run of this server owned the query and stopped it. `killed` is the number of ClickHouse queries that `KILL QUERY` found (0: no query runs any more). When `KILL QUERY` cannot run (a missing grant, no connection), the answer has `kill_error`, and the run of this server stops anyway. When no run of this server owned the query, that failure is a 502 `cancel_failed`.

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
  acl_cache_ttl_ms        = 60000
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
  deep_max_execution_time_s = 300
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
- The page switcher itself is removed when no Explorer page, Observability page or System page remains.

The `system` block controls the **System** page (`/system[/<section>]`, refer to [System](system.md)) and its `/api/system/...` endpoints. Every key is optional.

- `enabled` defaults to `true`. If `enabled = false`, the dashboard removes these items:
  - The System entry of the page switcher.
  - The page.
  - Every `/api/system/...` route, with the `/api/explorer/ops/...` aliases.
  - The redirects of the former Explorer addresses. `/explorer/_monitoring[/<section>]` and `/explorer/_operations` then open the Explorer Catalog.
- `activity` defaults to `true`. It controls the Activity part of the Overview and `/api/system/activity`.
- `keeper` defaults to `true`. It controls the Keeper card of the Overview and `/api/system/keeper`. If `keeper = false`, the tables of merges, mutations, replication and Distributed stay.
- `top_queries` defaults to `true`. It controls the Queries section and its `/api/system/queries` routes. The dashboard reads them with the runner account. The runner account then needs `SELECT ON system.query_log`. Otherwise, the section shows the GRANT.
- `cluster_fanout` defaults to `false`. If you enable it, the dashboard uses the `clusterAllReplicas` views. The system account needs `GRANT REMOTE ON *.*` for them. If it is disabled, every figure comes from the selected host only.

The other keys bound the history parts. These parts read the system logs of the server. The dashboard refuses the values outside these ranges at startup:

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

- `enabled = false` disables both `system.activity` and `system.keeper`.
- `keeper = false` disables `system.keeper`.
- `enabled = false` with `keeper = true` stops the start. The two keys contradict each other.
- A `system { }` block in the same file stops the start. Remove `explorer.operations` and use `system.activity` and `system.keeper`: ChDash does not let one of them take precedence silently.

`/api/version` still reports `features.explorer.operations` (`enabled`, `keeper`). It mirrors `system.activity` and `system.keeper`. `/api/explorer/ops/activity` and `/api/explorer/ops/keeper` stay as aliases of `/api/system/activity` and `/api/system/keeper`.

`explorer.cache_ttl_ms` (default 5,000, 0 to 1 hour) is the TTL of the Explorer metadata. `explorer.acl_cache_ttl_ms` (default 60,000, 0 to 1 hour) is the TTL of the runner ACL. Refer to [Caches and privileges](#caches-and-privileges).

`explorer.function_markdown_links` defaults to `false`. The dashboard then shows the links in the ClickHouse function Markdown as plain text. If you enable it, only the targets that are relative to the documentation and begin with `/` or `./` become links. Arbitrary external URLs are not clickable.

### Caches and privileges

The backend keeps what it reads from ClickHouse in bounded caches (`src/ttl_cache.hpp`). These rules apply to all of them:

- A value is fresh for its TTL after its read ended. The TTL uses a monotonic clock: a change of the system clock never ages a value or makes it young again.
- There is one read for each key at a time. A second request of the same key waits for that read, up to 60 s. It never fails because the first request is still reading.
- `refresh=1` asks for a read that starts after the request. A read that is in progress finishes first. All the requests that asked meanwhile share the next read. A loop of `refresh=1` therefore never runs two reads of one key at a time.
- A failed read is never kept as a value. Its error is sent again for 2 s, so that a host that is down is not asked on every request. When an older value exists, some pages send it with `"stale": true` instead of the error.
- The live answers are the Explorer catalog and graph, and the Overview, Activity and Keeper of the System page. They are sent at once after their TTL ends, with `"stale": true`. One read runs in the background meanwhile.
- Each cache has a limit in entries and in bytes (the least recently used entry goes first). An entry older than 10 minutes, or than its TTL when the TTL is longer, is removed.
- A key never holds the text of a client in full. The filters of the trace and log facets and of the trace prefill are held as a SHA-256 digest. `read_rows_limit` is rounded down to 1, 2 or 5 times a power of ten.

**The runner ACL.** What the runner of a host may read decides which objects are shown. The Explorer, the System pages, the execution statistics, the analysis, the exports and MCP show only these objects. The backend discovers it as the runner, with `CHECK GRANT` and zero-row probes. It never reads the grant list. It keeps one answer for each identity: the SHA-256 of the runner URI. The derived MCP identity has its own answer. These rules apply:

- The answers are kept for `explorer.acl_cache_ttl_ms` (60 s by default). They are sent for the same time again while one read runs in the background. A change of the grants therefore shows after 2 × `acl_cache_ttl_ms` at most, or at once with the Refresh of a page (`refresh=1`). Set a short TTL if the grants change often and a refresh is not an option.
- The lists are at table level: `CHECK GRANT SELECT` on the table, else a zero-row `SELECT`. The columns of a table are checked only when the table is opened.
- Only `ACCESS_DENIED` (code 497) means "not readable". Another server error about one object leaves that object out. A connection error or a timeout is not an answer: the route answers 503, and the failure is not kept beyond 2 s. An ACL that cannot be read again is never sent from memory.
- One discovery checks at most 4,000 objects in 20 s. To decide whether a database is readable, it probes at most 400 of its objects. Past a bound, the answer says `acl_truncated` (Explorer) or `truncated` (MCP), and the objects that were not checked are not shown.

**The DDL texts.** The Explorer keeps the `engine_full`, `create_table_query` and `as_select` texts of the objects by identity. It reads them as the runner (as the MCP user for the API tools of MCP). The system user never gives one. The identity is the SHA-256 of the URI of the connection, because ClickHouse masks the secrets of these texts by user ([Secrets in the DDL texts](#secrets-in-the-ddl-texts)). It reads at most 2,000 names in one query. The limits are 200,000 entries and 128 MiB.

**The format cache** (`format_cache { }`). The key has the host, the ClickHouse version of the host (its health check), the line width and the SHA-256 of the text. A hit also compares the text. Only the text that was formatted is a key. The formatter runs again on a text that is already formatted. A text that the formatter returned as written, with a warning, is not kept: the next request checks it again.

### The observability block

The Traces, Logs and Metrics pages have one block, `observability`, with a section for each signal and one allowlist for the three. A signal is disabled until its `enabled` is `true`. The block holds the settings that are the same for every host. The tables can differ from one host to another: [a host overrides them](#where-the-tables-of-a-host-are).

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

The older top-level `traces {}`, `logs {}` and `metrics {}` blocks (and `traces.service_allowlist`) still work, and mean the same. A signal is set in one place only. A configuration that has `observability { traces { } }` and a top-level `traces {}` does not start. A configuration that gives the allowlist twice does not start either. Use `observability` in new configurations.

The defaults match the OpenTelemetry Collector ClickHouse exporter (`otel_traces` plus `otel_traces_trace_id_ts`, `otel_logs`, `otel_metrics_gauge`, `_sum`, `_histogram`, `_exponential_histogram` and `_summary`). The pages follow the host that the user selects in the normal host picker. They always read with the `system_uri` of that host. There is no override of the credentials for each signal.

#### Where the tables of a host are

Two hosts do not always keep their OpenTelemetry tables under the same names (another database, a prefix for each region, no logs at all). A host can override where its tables are, and whether a signal is enabled for it, in an `observability` block of its own:

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
- What the host does not name is the setting of the block. A host may enable a signal that the block disables, with its tables.
- A signal is enabled for the instance when it is enabled for at least one host: the pages and the routes exist. Each request is served with the settings of the host that it names. A host where the signal is disabled answers `traces_disabled`, `logs_disabled` or `metrics_disabled`. The other hosts answer normally. `/api/version` (`features.traces.enabled`, `features.logs.enabled`, `features.metrics.enabled`) says whether the signal is enabled for at least one host. `/api/traces/meta`, `/api/logs/meta` and `/api/metrics/meta` name the tables of the host that they describe.
- The access audit (see above) checks the tables of each host with its system user. The MCP tools read the tables of the host that they name.
- A signal that is enabled for a host needs a database and a table (or a prefix). If one is empty, the start stops with this error: `clickhouse.host <name>: observability.traces database and table cannot be empty`.

#### The rules of the Trace Explorer

`default_lookback_minutes` and `max_lookback_minutes` bound only the search and filter queries. The lookback does not limit a direct lookup of `/observability/traces/<trace-id>`. This lookup requires `trace_index_table`. ChDash resolves the time range of the trace there. It never scans all the history in the traces table to find a missing TraceId.

`traces.analytics` defaults to `false`. Set it to `true` to enable the expensive graphs of the matching traces and of the duration percentiles. The search results use `/api/traces/search`. The graph data uses the independent route `/api/traces/analytics`. For this reason, the loading of the graph never blocks the response with the trace results.

`service_allowlist` is a whitelist of `ServiceName` that the backend enforces **for traces, logs and metrics**. The default `service_allowlist = ["*"]` allows all services. These rules apply:

- An entry without `*` is an exact name.
- `test_*` allows every service with a name that starts with `test_`.
- `*_worker` allows the matches of the suffix.
- Multiple `*` wildcards are accepted.
- An explicitly empty list denies every service.

The whitelist applies to the trace search, to the cards and to the direct loads of a TraceId, to the logs and to the metrics. The MCP tools also apply it. They read with the system user, as the pages do. So a key never reads a service that the pages do not show.

For this reason, nobody can use `/observability/traces/<trace-id>` to read spans from a service that is not allowed. When a trace crosses allowed services and denied services, the dashboard returns only the allowed spans. Hidden parents can therefore make an allowed child look like a visible root.

The nested feature switches remove the UI control and the corresponding payload and query surface. For example, you can disable `resource_attributes`, `span_attributes`, `events` and `links` when the trace page must show only the timing.

For large trace datasets, `docs/traces.md` describes the recommended projection indexes for ClickHouse 26.1+ (`prj_traceid` and `prj_start`). They are optimizations of the storage and of the queries. They are not ChDash configuration fields.

For local or demo data, `examples/generate_otel_traces.py` creates synthetic traces of several services. They are compatible with the standard OTel ClickHouse trace columns. By default, it generates about 60–90 spans for each trace. It makes branches in the style of Kafka, RPC and ClickHouse, and it makes events, links and occasional errors. It also emits optional `otel_traces_trace_id_ts` rows. These rows are for installations where the standard materialized view does not fill the auxiliary table.

#### Logs and metrics

- `logs.max_lookback_minutes` is from 1 minute to 365 days. `logs.search_limit` is from 1 to 10000. A value outside the range stops the start.
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
- `name` names the library. It is the id in the API (`?library=`) and the name that the Query page shows. The value is any text of at most 128 bytes, with no control character and no space at either end. It matters only with several libraries. A single library that keeps the name `default` shows as *Shared server storage*.
- Repeat the `query_library {}` block for **several libraries**, each with its own `file` and `writable`. For example, a library that everyone edits can sit next to a read-only one. Every block after the first needs a different `name`, and each `file` is different too. The first block is the default library of the API. Details: [`docs/query-library.md`](query-library.md#several-libraries-on-the-server).
- `/api/version` reports `features.query_library = {enabled, writable, libraries}`. `libraries` is `[{name, writable}]` in the order of the file. `writable` is false while the file has a load error.

[`docs/query-library.md`](query-library.md) describes the REST API and the file format.

The optional `mcp {}` block enables the MCP server. AI clients call `POST /mcp` with an access key, and read ClickHouse data through the host `mcp_uri`. The default is `enabled = false`.

```hcl
mcp {
  enabled      = true
  storage_file = "/var/lib/chdash/mcp_keys.json"

  keys {
    mode = "hybrid"
  }

  max_rows              = 1000
  max_result_bytes      = 1048576
  query_timeout_seconds = 30
  max_sql_bytes         = 65536
  max_memory_bytes      = 1073741824
  max_rows_to_read      = 0
  rate_limit_per_minute = 600
  allowed_origins       = []

  usage {
    enabled  = true
    dir      = "/var/lib/chdash/usage"
    instance = "chdash-0"
  }

  mcp_key "ci-bot" {
    token_file = "/run/secrets/chdash-mcp-ci"   # or: token_env = "CHDASH_MCP_CI_KEY"
    subject    = "alice"
    tools      = ["list_databases", "list_tables", "describe_table", "query_table"]
    expires    = "2027-10-15T00:00:00Z"
    scope {
      hosts     = ["local"]
      databases = ["otel"]
    }
    limits {
      max_rows = 200
    }
  }
}
```

- `enabled = true` needs at least one host with `mcp_uri`, and keys: an `mcp_key` block, or a `storage_file` for the keys of the page. Otherwise, ChDash stops with `config error`.
- `keys { mode }` tells which keys apply: `static` (the `mcp_key` blocks only), `dynamic` (the keys of the page only) or `hybrid` (the two, the default). `manage_from_ui` is the older form of `mode`: `false` is `static` and `true` is `hybrid`. ChDash reads it for one release, with a warning. `manage_from_ui` and `keys.mode` together stop the start.
- The label of an `mcp_key` block is the name of the key. The block has exactly one of `token_env` and `token_file`. The token is `mcp_` and 43 base64url characters. It is never written in the file: a `token` attribute stops the start. The optional attributes are `subject`, `tools`, `expires` (RFC 3339), `scope { hosts, databases }` and `limits { max_rows, timeout_seconds, rate_limit_per_minute }`.
- The older `key { name = ... }` block is still read for one release, with a warning. A token of the older form (a UUID version 4) is accepted until you replace it, with a warning.
- The keys of the page are in `storage_file`. The file holds the hash and the hint of each token, with mode 0600. ChDash never stores a token. The page shows it once, when you make the key.
- A host without `mcp_uri` is invisible to MCP. The password of the MCP user is in `mcp_password_env` or `mcp_password_file` of the host, and `mcp_uri` has no password. It never falls back to the runner or system credentials. It never falls back to `password_file` or `password_env` either.
- Each limit is a global cap. A key can only lower `max_rows` and `timeout_seconds`.
- The `usage {}` block enables the usage of the keys (what each key did), and it is disabled by default: nothing is counted. When it is enabled, `dir` is required: a directory that exists and where ChDash can create files. Each ChDash keeps its counts in a file of its own there (`<instance>.jsonl.zst`, JSON Lines compressed with zstd). Several ChDash can share the directory, and the answers sum them. `instance` names this ChDash (the host name by default), and `retention_days` (default 90) says how long the usage is kept. `all_keys` lets a key read the usage of all the keys (refer to [`docs/mcp.md`](mcp.md#the-usage-block)).
- `/api/version` reports `features.mcp = {enabled}`. `/api/mcp/meta` always answers.

[`docs/mcp.md`](mcp.md) describes the keys, the tools, the endpoint, the API, the grants of the ClickHouse user and the startup errors.

`analysis.registry_ttl_ms` and `analysis.registry_max_entries` bound the in-memory query registry for each host. This bound does not depend on the lifetime of the SSE session. The registry contains no query results and no user identity.

`analysis.registry_sql_max_bytes` adds a separate global byte budget. It is for the exact original SQL that the backend retains only for Deep Analyze. Deep Analyze can then replay the statement through `runner_uri`. It does not need to trust a copy of the query log from the technical account.

Deep Analyze runs as a job. A client polls the job (`docs/query-analysis.md`). `analysis.deep_max_execution_time_s` (default 300, 0 = the profile of the runner) bounds each job in ClickHouse. The server keeps at most 16 jobs and 64 MiB of results. Each job that ended is kept for 10 minutes.

`export.max_execution_time_s` and `export.max_memory_usage` bound each exported statement in ClickHouse (0, the default, leaves them to the profile of the runner). `export.receive_timeout_ms` (default 600000, 0 = no limit, else at least 10000) ends a statement that sends nothing (no row, no progress) for that long. A dead peer is found sooner: the connections use TCP keepalive.

`export.archive_format` currently accepts only `zip`. This fixes the V1 archive contract to ZIP/ZIP64 on purpose. Massive exports use the two-phase handshake `/api/export/run` → `/api/export/stream` and a forward-only ZIP64 writer. `docs/massive-export.md` describes them.

The `query` block holds the safety limits for interactive results:

```hcl
query {
  max_result_cell_bytes  = 33554432
  max_result_event_bytes = 33554432
  cancel_token_ttl_ms     = 172800000
  max_execution_time_s    = 0
  max_memory_usage        = 0
  max_rows_to_read        = 0
}
```

`max_execution_time_s` (0..604800), `max_memory_usage` and `max_rows_to_read` bound a run in ClickHouse (refer to [The bounds of the queries](#the-bounds-of-the-queries)). `0`, the default, leaves the bound to the settings profile of the runner user. `result_preview_row_limit` limits only the rows that go to the browser, not the work of ClickHouse.

The first two defaults are 32 MiB. A cell or an event that is too large fails with an explicit error: `result_cell_too_large` or `result_event_too_large`. The dashboard does not truncate data silently. These limits apply to interactive SSE results. They do not apply to the dedicated massive-export stream.

## Query behavior

A normal Run never does an automatic lookup in `system.query_log`. It never forces `SYSTEM FLUSH LOGS`. The dashboard removed the former final-query-log settings, because they conflict with the strict minimal Run contract. The dashboard reads the persisted logs only through the explicit Analyze action. The existing native setting `send_profile_events` stays. It feeds the interactive CPU and memory metrics. It does not add a second query.

The live telemetry now distinguishes the ClickHouse write progress and the result rows that the backend serializes to the browser. Native Progress packets give `written_rows` and `written_bytes`. The backend tracks the counters of the result payload separately as `result_rows_emitted` and `result_bytes_emitted`.

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

Do **not** grant `KILL QUERY`, `IMPERSONATE` or access-management privileges to the runner. ChDash rejects direct `KILL QUERY` panel SQL and export SQL in all cases. If you keep these privileges off the runner, you also protect the boundary when somebody uses the runner credentials outside ChDash. If `analysis.flush_logs = true`, the system account also needs the corresponding `SYSTEM FLUSH LOGS` privilege.

Verify the important boundary from ClickHouse itself:

```sql
-- Run as chdash_runner: expected result is 0.
CHECK GRANT KILL QUERY ON *.*;

-- Run as chdash_system: expected result is 1.
CHECK GRANT KILL QUERY ON *.*;
```

The integration stack under `tests/` provisions the distinct users `chdash_runner` and `chdash_system`. It checks these two conditions at runtime.

## Secrets

A secret is never written in the configuration file. It is a password of a ClickHouse account, the secret of an MCP key, or the token of ChDash at the PDP (`access.pdp`). Each secret has two forms. Exactly one of them applies:

- `<name>_env = "VAR"`: the value is in the environment variable `VAR`.
- `<name>_file = "/path"`: the value is the content of the file, without its last line end. The line end is one `\n` or `\r\n`. ChDash keeps every other byte.

These cases stop the start: two forms for one secret, and a secret in clear text. A variable that is not set or is empty stops it too. So does a file that cannot be read, that holds a NUL byte or that is empty. The error gives the attribute and the variable or the path, never the value.

ChDash reads each secret one time, at start. It does not read a file or a variable again when it opens a connection. To change a password, change the file or the variable, then restart ChDash. There is no exception: a rotation of a secret needs a restart.

The attributes of a host are these:

- `password_env` and `password_file`: the password of `runner_uri` and of `system_uri`.
- `runner_password_env` and `runner_password_file`: the password of `runner_uri` only.
- `system_password_env` and `system_password_file`: the password of `system_uri` only.
- `mcp_password_env` and `mcp_password_file`: the password of `mcp_uri` only.

The attributes of an MCP key are `token_env` and `token_file` (`secret_env` and `secret_file` in the older `key` block). The token of the PDP is `access.pdp.token_env` or `access.pdp.token_file`. The reference ([configuration-reference.md](configuration-reference.md)) lists them.

### Values from the environment or from a file

An attribute that is not a secret can also take its value from a variable or a file, when the file tells it. Such an attribute `<name>` has three forms:

- `<name> = "..."`: the value is in the file.
- `<name>_env = "VAR"`: the value is in the environment variable `VAR`.
- `<name>_file = "/path"`: the value is the content of the file, without its last line end.

Give only one of the three forms. The rules of the secrets apply to `_env` and `_file`. A variable that is not set or is empty stops the start. So does a file that cannot be read or is empty. `--print-config` shows the value and its source. These attributes have the three forms: `telemetry.otlp_endpoint` (refer to [server-telemetry.md](server-telemetry.md)), `access.identity.public_keys` and `access.pdp.url` (refer to [access.md](access.md)).

A URI gives the user and the address, never the password:

```hcl
clickhouse {
  host {
    name                  = "local"
    runner_uri            = "clickhouse://chdash_runner@clickhouse:9000"
    system_uri            = "clickhouse://chdash_system@clickhouse:9000"
    runner_password_file  = "/run/secrets/chdash_runner_password"
    system_password_env   = "CHDASH_SYSTEM_PASSWORD"
  }
}
```

These rules apply to the passwords of a host:

- A password in the URI stops the start (`clickhouse://user:password@host`). So does the parameter `password_file` in the URI.
- `password_env` or `password_file` gives one password to `runner_uri` and to `system_uri`. Use it when the two accounts have the same password. Do not use it with `runner_password_*` or `system_password_*`: ChDash stops the start, because it does not choose between them.
- `mcp_uri` has its own attributes, `mcp_password_env` and `mcp_password_file`. They need `mcp_uri`. The password of the host never applies to MCP.
- A host with no password attribute connects with no password.

The URI parameters are `compression`, `secure`, `verify`, `ca`, `ca_dir` and `sni`. A parameter that is not in this list stops the start. With `secure=1` and no port in the URI, the port is 9440. This is the native TLS port of ClickHouse. Without `secure`, the port is 9000.

The `compression` query parameter of the URI sets the compression of native protocol blocks for each connection. The values are `lz4` (default), `zstd` or `none`. For example: `clickhouse://chdash_runner@clickhouse:9000?compression=zstd`. LZ4 typically makes the traffic of results and exports 3-10x smaller, for a negligible CPU cost. Use `none` only when ClickHouse is on the same host and the CPU is the bottleneck.
