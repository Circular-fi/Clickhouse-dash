# Configuration keys

This file is generated from `src/config_keys.def`. Do not edit it: run `python3 tools/gen_config_reference.py`.

Each key is in the block of the configuration file that its section names (`observability.traces` is
`observability { traces { ... } }`). A value outside its range stops the start with an error that names the key.
`chdash --config <file> --print-config` writes the value of every key as it applies, and where the value comes from.
The blocks `clickhouse.host`, `mcp.mcp_key`, `mcp.key` and `query_library` can appear more than once. Each block is one host, one key or one library.
An `mcp_key` block has the name of its key as its label: `mcp_key "ci-bot" { ... }`. No other block takes a label.
The block `mcp.key` is the older form of `mcp.mcp_key`: ChDash reads it for one release and writes a warning.
The block `access` is required: a file without it stops the start ([access.md](access.md)).
The prose of the keys is in [configuration.md](configuration.md).

## Secrets

A secret is never written in the file: a password in a URI, or a `token` or `secret` in a key, stops the start. A secret has two forms,
and each form is a key of its own in the tables below:

- `<name>_env` gives the name of an environment variable. The value of the secret is the value of the variable.
- `<name>_file` gives the path of a file. The value of the secret is the content of the file, without its last line end.

Give exactly one of the two forms. A variable that is not set or is empty, and a file that cannot be read or is empty,
stop the start. ChDash reads each secret one time, at start. ChDash reads no environment variable that the file does not name.
The keys that accept `_env` and `_file` are the ones whose type is `environment variable name` or `file path` in the sections
`clickhouse.host`, `mcp.mcp_key`, `mcp.key` and `access.pdp`. `--print-config` shows the source of a secret (`env:VAR` or `file:/path`), never its value.

## Values from the environment or from a file

An attribute that is not a secret can also take its value from a different place, when the file tells it. Such an attribute
`<name>` has three forms: `<name>` (the value is in the file), `<name>_env` (an environment variable) and `<name>_file` (a file,
without its last line end). Give only one of the three forms. The same rules as for a secret apply to `_env` and `_file`.
These attributes have the three forms: `otlp_endpoint` of the section `telemetry`, `public_keys` of the section `access.identity`
and `url` of the section `access.pdp`. `--print-config` shows the value of each one and its source.

## `server`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `listen_host` | text | `0.0.0.0` |  | The address that the server listens on. |
| `listen_port` | integer | `8080` | 1 to 65535 | The port that the server listens on. |
| `worker_threads` | integer | `0` | 0 or 1 to 1024 threads | Threads that stay ready to serve a request. 0 = the larger of 8 and the number of hardware threads. |
| `max_worker_threads` | integer | `256` | 1 to 4096 threads | The most threads that the pool grows to when streams hold threads. It is at least worker_threads. |
| `max_queued_requests` | integer | `1024` | 16 to 100000 requests | Requests that wait for a thread. A request past the limit is refused with 503. |
| `max_body_bytes` | integer | `0` | 0 or 65536 to 2147483648 bytes | The largest request body. A larger body is refused with 413 before it is read. 0 = derived from query.max_sql_bytes and the query library. |
| `max_host_streams` | integer | `64` | 0 to 4096 streams | Open status streams of the pages (one for each visible page). It is at most half of max_worker_threads: a higher value stops the start. Past the limit a page polls. |
| `write_timeout_ms` | integer | `120000` | 1000 to 3600000 ms | How long one write of a response waits for a client that does not read (a paused download). Past it the response ends. |
| `shutdown_timeout_ms` | integer | `10000` | 1000 to 600000 ms | How long a stop (SIGTERM, SIGINT) waits for the running requests. Past it the process ends with status 1. |
| `metrics` | boolean | `true` |  | Serve GET /metrics (the Prometheus text format). |
| `access_log` | boolean | `true` |  | Write one log line for each request. A probe that succeeds is not written. |
| `stats_log_interval_ms` | integer | `300000` | 0 or 10000 to 86400000 ms | Write a server.stats log line this often. 0 = never. |

## `query`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `describe_mode` | one of auto\|always\|never | `auto` |  | When a statement is described before it runs, to read the types that the native client cannot read. |
| `result_preview_row_limit` | integer | `10000` | 0 to 10000000 rows | Rows of a result that the Query page receives. The statement goes on to its end. 0 = no limit. |
| `max_sql_bytes` | integer | `4194304` | 1024 to 67108864 bytes | The largest SQL text that a run, an export or a format accepts. |
| `sample_interval_ms` | integer | `40` | 10 to 1000 ms | How often a running statement sends its live counters. |
| `result_batch_rows` | integer | `1000` | 1 to 10000 rows | Rows in one result event. |
| `result_batch_bytes` | integer | `262144` | 16384 to 4194304 bytes | Bytes in one result event, at most. |
| `sse_batch_events` | integer | `8` | 1 to 64 events | Events that one write to the browser carries, at most. |
| `sse_batch_bytes` | integer | `262144` | 16384 to 4194304 bytes | Bytes that one write to the browser carries, at most. |
| `sse_queue_max_bytes` | integer | `8388608` | 16384 to 134217728 bytes | Bytes of results that wait for a slow browser. Past it ClickHouse waits. It is at least sse_batch_bytes. |
| `max_result_cell_bytes` | integer | `33554432` | 1024 to 134217728 bytes | The largest value of one cell in a result. A larger value is cut. |
| `max_result_event_bytes` | integer | `33554432` | 1024 to 134217728 bytes | The largest result event. |
| `describe_cache_entries` | integer | `256` | 0 to 4096 entries | Descriptions of statements that are kept. 0 = none. |
| `describe_cache_ttl_ms` | integer | `60000` | 0 to 86400000 ms | How long a description is kept. |
| `session_max_count` | integer | `256` | 1 to 100000 sessions | Runs that exist at the same time. A run past the limit is refused with 429. |
| `session_abandoned_ttl_ms` | integer | `60000` | 1000 to 86400000 ms | A run whose stream the browser never opened ends after this time. |
| `session_terminal_ttl_ms` | integer | `30000` | 0 to 86400000 ms | A finished run is kept for this time. |
| `session_reaper_interval_ms` | integer | `5000` | 250 to 60000 ms | How often ended runs are removed. |
| `cancel_token_ttl_ms` | integer | `172800000` | 1000 to 172800000 ms | How long the token that cancels a run is valid. |
| `max_execution_time_s` | integer | `0` | 0 to 604800 seconds | max_execution_time of a run. 0 = the settings profile of the runner user decides. A bound is never looser than the profile. |
| `max_memory_usage` | integer | `0` | 0 to 1099511627776 bytes | max_memory_usage of a run. 0 = the settings profile of the runner user decides. |
| `max_rows_to_read` | integer | `0` | 0 to 1000000000000000 rows | max_rows_to_read of a run. 0 = the settings profile of the runner user decides. |

## `client_pool`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `max_idle` | integer | `4` | 0 to 64 connections | Idle connections that are kept for one ClickHouse address. |
| `idle_ttl_ms` | integer | `60000` | 0 to 86400000 ms | An idle connection is closed after this time. |
| `validate_after_idle_ms` | integer | `15000` | 0 to 86400000 ms | A connection that was idle for this time is pinged before it is used again. |
| `reaper_interval_ms` | integer | `5000` | 250 to 60000 ms | How often idle connections are checked. |
| `max_leased_per_uri` | integer | `128` | 0 to 100000 connections | Connections in use at the same time for one ClickHouse address. 0 = no limit. |
| `lease_wait_ms` | integer | `5000` | 0 to 60000 ms | How long a request waits for a connection before it fails with pool_exhausted. |

## `generated_queries`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `timeout_ms` | integer | `60000` | 1000 to 3600000 ms | The time of one request of a page. Each statement of the request gets max_execution_time = the seconds that remain. |
| `max_memory_usage` | integer | `4294967296` | 0 to 1099511627776 bytes | max_memory_usage of each statement that a page writes. 0 = the settings profile decides. |
| `max_rows_to_read` | integer | `20000000000` | 0 to 1000000000000000 rows | Rows that one statement of a page may read. A statement that would read more fails with <page>_scan_limit. 0 = the settings profile decides. |

## `admission`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `heavy_per_host` | integer | `16` | 0 or 0 to 1024 requests | Reads of the Explorer, System, Traces, Logs and Metrics pages that run at once for one ClickHouse host. 0 = no limit. |
| `analysis_per_host` | integer | `1` | 0 or 0 to 64 requests | Query Analysis and Deep Analyze requests that run at once for one ClickHouse host. 0 = no limit. |
| `mcp_max` | integer | `8` | 0 or 0 to 256 calls | Calls of the API tools of MCP that run at once, in all. 0 = no limit. |
| `wait_ms` | integer | `5000` | 0 to 60000 ms | How long a request waits for a place before it is refused with 503 server_busy. |

## `format_cache`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `max_entries` | integer | `512` | 0 to 100000 entries | Formatted statements that are kept. 0 = no cache. |
| `max_bytes` | integer | `16777216` | 0 to 1073741824 bytes | Bytes of formatted statements that are kept. |
| `ttl_ms` | integer | `600000` | 0 to 86400000 ms | How long a formatted statement is kept. |

## `health`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `interval_ms` | integer | `5000` | 250 to 600000 ms | How often each ClickHouse host is checked. |
| `timeout_ms` | integer | `800` | 100 to 60000 ms | How long a check of a host waits for an answer. |

## `explorer`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `browse` | boolean | `true` |  | Show the Catalog of databases and tables. |
| `cache_ttl_ms` | integer | `5000` | 0 to 3600000 ms | How long the Explorer keeps the answers about the objects of a host. |
| `acl_cache_ttl_ms` | integer | `60000` | 0 to 3600000 ms | How long the Explorer keeps what the runner may read. The answer is served for as long again while one read refreshes it. |
| `live_refresh_ms` | integer | `2000` | 250 to 60000 ms | How often a page that shows live state asks again. |
| `function_cache_ttl_ms` | integer | `3600000` | 1000 to 86400000 ms | How long the list of the functions of ClickHouse is kept. |
| `function_markdown_links` | boolean | `false` |  | Show the links of the documentation of a function. The browser keeps only the links that start with / or ./. |

## `explorer.graph`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `lineage` | boolean | `true` |  | Show the lineage of views and materialized views in the graph. |
| `storage_topology` | boolean | `true` |  | Show the storage topology (Distributed, Buffer, replicas) in the graph. |

## `system`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `enabled` | boolean | `true` |  | Serve the System page and its routes. |
| `activity` | boolean | `true` |  | Show the activity of the server (merges, mutations, replication queues). |
| `keeper` | boolean | `true` |  | Show the state of Keeper. |
| `top_queries` | boolean | `true` |  | Show the Queries section (system.query_log). |
| `cluster_fanout` | boolean | `false` |  | Read the whole cluster with clusterAllReplicas(). The system user needs the REMOTE grant. |
| `default_lookback_minutes` | integer | `60` | 1 to 525600 minutes | The window of the performance history when the page names none. It is at most max_lookback_days. |
| `max_lookback_days` | integer | `30` | 1 to 365 days | The longest window of the performance history. |
| `query_log_max_lookback_hours` | integer | `168` | 1 to 720 hours | The longest window of the Queries section. |
| `query_log_max_rows` | integer | `50000000` | 1000 to 10000000000 rows | Rows of system.query_log that one request reads, at most. A wider window is refused with window_too_large. |
| `disk_growth_days` | integer | `7` | 1 to 365 days | The window of the disk growth forecast. It is at most max_lookback_days. |

## `analysis`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `registry_ttl_ms` | integer | `3600000` | 1000 to 86400000 ms | How long the registry keeps a run for its analysis. |
| `registry_max_entries` | integer | `10000` | 1 to 1000000 entries | Runs that the registry keeps. |
| `registry_sql_max_bytes` | integer | `33554432` | 0 to 536870912 bytes | Bytes of SQL text that the registry keeps. 0 = the text of no run is kept. |
| `log_lookup_timeout_ms` | integer | `2000` | 0 to 60000 ms | How long the analysis waits for the log tables of ClickHouse to show a run. |
| `flush_logs` | boolean | `false` |  | Run SYSTEM FLUSH LOGS when the log tables do not show a run yet. |
| `allow_deep_analyze` | boolean | `false` |  | Allow Deep Analyze. It runs the statement again with EXPLAIN ANALYZE. |
| `deep_max_execution_time_s` | integer | `300` | 0 to 604800 seconds | How long a Deep Analyze job can run before ClickHouse stops its statement. 0 = the settings profile of the runner user decides. |

## `export`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `max_concurrent` | integer | `1` | 1 to 64 exports | Exports that run at the same time. |
| `output_buffer_bytes` | integer | `262144` | 16384 to 16777216 bytes | The write buffer of an export. |
| `archive_format` | one of zip | `zip` |  | The format of the archive. Only zip exists. |
| `compression` | boolean | `false` |  | Compress the archive. It must be false: the archive is stored without compression. |
| `token_ttl_ms` | integer | `120000` | 5000 to 600000 ms | How long the link of a download is valid. |
| `pending_max_entries` | integer | `32` | 1 to 4096 entries | Exports that wait for their download. |
| `pending_sql_max_bytes` | integer | `16777216` | 1048576 to 536870912 bytes | Bytes of SQL text of the exports that wait. |
| `max_queries` | integer | `256` | 1 to 4096 statements | Statements in one export. |
| `max_execution_time_s` | integer | `0` | 0 to 604800 seconds | max_execution_time of each exported statement. 0 = the settings profile of the runner user decides. |
| `max_memory_usage` | integer | `0` | 0 to 1099511627776 bytes | max_memory_usage of each exported statement. 0 = the settings profile decides. |
| `receive_timeout_ms` | integer | `600000` | 0 or 10000 to 604800000 ms | A statement that sends nothing (no row, no progress) for this long fails. 0 = no limit. |

## `query_library`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `enabled` | boolean | `false` |  | Keep the saved queries on the server, in one file. The block can be repeated: each enabled block is one more library. |
| `name` | text |  |  | The name of the library: the id of the API (?library=) and what the Query page shows (at most 128 bytes; any text, no control character and no space at either end). The first library may leave it out (it is then "default"; a single library of that name shows as "Shared server storage"); the others need one, each different. |
| `file` | text |  |  | The path of the file. It is required when the library is enabled. |
| `writable` | boolean | `false` |  | Allow a change. When false, a change is refused with 403 read_only. |
| `max_file_bytes` | integer | `8388608` | 65536 to 1073741824 bytes | The largest library file. |
| `max_query_bytes` | integer | `262144` | 1024 to 67108864 bytes | The largest saved query. It is at most max_file_bytes. |

## `observability`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `service_allowlist` | list of texts | `["*"]` | 256 bytes each | The services that the three signals show: a name, a prefix with *, a suffix with *, or a regular expression in re:. |

## `observability.traces`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `highlighted_attributes` | list of texts | `service.version, deployment.environment.name, deployment.environment, http.route, user.id` | 32 keys of 1 to 256 bytes | Attributes that the trace header shows as chips. |
| `enabled` | boolean | `false` |  | Show the Traces page. |
| `analytics` | boolean | `false` |  | Show the analytics, the heatmap, the service map and the differences of traces. |
| `database` | text | `otel` |  | The database of the traces table. |
| `table` | text | `otel_traces` |  | The traces table of the OpenTelemetry Collector. |
| `trace_index_table` | text | `otel_traces_trace_id_ts` |  | The table that gives the time range of a trace. A direct link to a trace needs it. |
| `default_lookback_minutes` | integer | `60` | 1 to 43200 minutes | The window of a search when the page names none. It is at most max_lookback_minutes. |
| `max_lookback_minutes` | integer | `10080` | 1 to 525600 minutes | The longest window of a search. |
| `search_limit` | integer | `100` | 1 to 1000 traces | Traces that one search returns, at most. |
| `max_spans_per_trace` | integer | `10000` | 100 to 100000 spans | Spans of one trace that the detail reads, at most. |
| `linked_from_margin_minutes` | integer | `60` | 1 to 1440 minutes | The window of a linked-from search is the window of the trace widened by this margin. |

## `observability.logs`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `enabled` | boolean | `false` |  | Show the Logs page. |
| `database` | text | `otel` |  | The database of the logs table. |
| `table` | text | `otel_logs` |  | The logs table of the OpenTelemetry Collector. |
| `max_lookback_minutes` | integer | `10080` | 1 to 525600 minutes | The longest window of a search. |
| `search_limit` | integer | `200` | 1 to 10000 records | Records that one search returns, at most. |
| `body_search` | one of token\|substring\|off | `token` |  | How a search reads the text of a record: token (hasToken, uses the index), substring (a scan) or off (no text search). |
| `trace_logs_limit` | integer | `1000` | 1 to 10000 records | Records of one trace that the trace page shows, at most. |
| `trace_margin_before_seconds` | integer | `5` | 0 to 3600 seconds | The logs of a trace are read from this long before its start. |
| `trace_margin_after_seconds` | integer | `30` | 0 to 3600 seconds | The logs of a trace are read up to this long after its end. |

## `observability.metrics`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `enabled` | boolean | `false` |  | Show the Metrics page. |
| `database` | text | `otel` |  | The database of the metric tables. |
| `table_prefix` | text | `otel_metrics` |  | The prefix of the metric tables: <prefix>_gauge, <prefix>_sum, <prefix>_histogram and the others. |

## `clickhouse.host`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `name` | text |  | 1 or more bytes, no control character | The id of the host. It is required and each host has a different one. The pages and the API name the host with it. |
| `label` | text |  |  | The name that the pages show. Default: the value of name. |
| `runner_uri` | text |  | clickhouse://user@host[:port][?parameters] | The URI of the account that runs the queries of the people (the runner). It is required. It never holds a password: use runner_password_env, runner_password_file, password_env or password_file. The parameters are compression, secure, verify, ca, ca_dir and sni. |
| `system_uri` | text |  | clickhouse://user@host[:port][?parameters] | The URI of the system account. The backend uses it for its own reads. It is required. It never holds a password: use system_password_env, system_password_file, password_env or password_file. |
| `mcp_uri` | text |  | clickhouse://user@host[:port][?parameters] | The URI of the account of the MCP tools. A host without it is not visible to MCP. It never holds a password: use mcp_password_env or mcp_password_file. |
| `password_env` | environment variable name |  | letters, digits and _ | The variable that holds the password of runner_uri and of system_uri. It is a secret. Give only one of password_env and password_file, and none of the runner_password_* and system_password_* keys. |
| `password_file` | file path |  |  | The file that holds the password of runner_uri and of system_uri, without its last line end. It is a secret. Give only one of password_env and password_file, and none of the runner_password_* and system_password_* keys. |
| `runner_password_env` | environment variable name |  | letters, digits and _ | The variable that holds the password of runner_uri only. It is a secret. Give only one of runner_password_env and runner_password_file. |
| `runner_password_file` | file path |  |  | The file that holds the password of runner_uri only, without its last line end. It is a secret. Give only one of runner_password_env and runner_password_file. |
| `system_password_env` | environment variable name |  | letters, digits and _ | The variable that holds the password of system_uri only. It is a secret. Give only one of system_password_env and system_password_file. |
| `system_password_file` | file path |  |  | The file that holds the password of system_uri only, without its last line end. It is a secret. Give only one of system_password_env and system_password_file. |
| `mcp_password_env` | environment variable name |  | letters, digits and _ | The variable that holds the password of mcp_uri. It is a secret. It needs mcp_uri. Give only one of mcp_password_env and mcp_password_file. No other password key applies to mcp_uri. |
| `mcp_password_file` | file path |  |  | The file that holds the password of mcp_uri, without its last line end. It is a secret. It needs mcp_uri. Give only one of mcp_password_env and mcp_password_file. No other password key applies to mcp_uri. |

## `clickhouse.host.observability.traces`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `enabled` | boolean |  |  | Show the Traces page for this host. Default: the value of observability.traces.enabled. |
| `database` | text |  |  | The database of the traces table of this host. Default: the value of observability.traces.database. |
| `table` | text |  |  | The traces table of this host. Default: the value of observability.traces.table. |
| `trace_index_table` | text |  |  | The table of this host that gives the time range of a trace. Default: the value of observability.traces.trace_index_table. |

## `clickhouse.host.observability.logs`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `enabled` | boolean |  |  | Show the Logs page for this host. Default: the value of observability.logs.enabled. |
| `database` | text |  |  | The database of the logs table of this host. Default: the value of observability.logs.database. |
| `table` | text |  |  | The logs table of this host. Default: the value of observability.logs.table. |

## `clickhouse.host.observability.metrics`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `enabled` | boolean |  |  | Show the Metrics page for this host. Default: the value of observability.metrics.enabled. |
| `database` | text |  |  | The database of the metric tables of this host. Default: the value of observability.metrics.database. |
| `table_prefix` | text |  |  | The prefix of the metric tables of this host. Default: the value of observability.metrics.table_prefix. |

## `mcp`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `auth_header` | text | `Authorization` | an HTTP header name | The request header that carries the key. Authorization takes Bearer <key>. |
| `allowed_origins` | list of texts | `[]` | https://host[:port], at most 256 bytes each | The origins of the pages that may call from a browser. A call with no Origin is always accepted. |
| `enabled` | boolean | `false` |  | Serve the MCP endpoint, POST /mcp. |
| `storage_file` | text |  |  | The JSON file of the keys that are made on the MCP page. |
| `manage_from_ui` | boolean | `true` |  | Deprecated: use keys.mode. false is the static mode, true the hybrid mode. It stops the start when keys.mode is also in the file. |
| `max_rows` | integer | `1000` | 1 to 1000000 rows | Rows that a call returns, at most. A key can lower it. |
| `max_result_bytes` | integer | `1048576` | 1024 to 268435456 bytes | Bytes that a call returns, at most. |
| `query_timeout_seconds` | integer | `30` | 1 to 3600 seconds | The time of one call. A key can lower it. |
| `max_sql_bytes` | integer | `65536` | 256 to 4194304 bytes | The largest SQL text of a call. |
| `max_memory_bytes` | integer | `1073741824` | 16777216 to 1099511627776 bytes | max_memory_usage of a call. |
| `max_rows_to_read` | integer | `0` | 0 to 1000000000000000 rows | max_rows_to_read of a call. 0 = no limit from ChDash. |
| `rate_limit_per_minute` | integer | `600` | 0 to 1000000 calls | Calls that one key may make in one minute. 0 = no limit. |

## `mcp.usage`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `enabled` | boolean | `false` |  | Count what each key does (requests, errors, clients, time, rows, bytes) and keep it. Off: nothing is counted, the routes of the usage answer 404 not_enabled, and the Keys table has no Used column. |
| `storage` | one of files | `files` |  | Where the usage is kept. Only files exists for now: one file for each instance of ChDash, in the directory dir. A database will come later. |
| `dir` | text |  |  | The directory of the usage files. Required when the usage is on. It must exist, and ChDash must be able to create files in it. Several ChDash can share it: each one writes its own file (the name of its instance and .jsonl.zst) and reads the others, so the answers add up the instances. |
| `instance` | text |  |  | The name of this ChDash in the usage files: 1 to 64 characters of A-Z a-z 0-9 . _ -. Two instances that run at the same time must not share it. Empty: the host name of the machine (the start fails when it is not a valid name: set this key). |
| `retention_days` | integer | `90` | 1 to 365 days | How long the usage of a key is kept (also after the key is deleted). It is kept by the minute, 5 minutes and 15 minutes up to the day, then by 3 hours (from 7 days), by 12 hours (from 30 days) and by the day. |
| `all_keys` | boolean | `false` |  | Let a key read the usage of all the keys of all the instances (the tool mcp_analysis_all_usage, which the tools of the key must also name). Never the ClickHouse cost of another key. |

## `mcp.keys`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `mode` | one of static\|dynamic\|hybrid | `hybrid` |  | Which keys apply. static: the mcp_key blocks only (the page makes no key and the key file is not read). dynamic: the keys of the page only (an mcp_key block stops the start). hybrid: the two. |

## `mcp.mcp_key`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `token_env` | environment variable name |  | letters, digits and _ | The variable that holds the token of the key: mcp_ and 43 base64url characters. It is a secret. Give exactly one of token_env and token_file. The token is never written in the file. |
| `token_file` | file path |  |  | The file that holds the token of the key, without its last line end: mcp_ and 43 base64url characters. It is a secret. Give exactly one of token_env and token_file. The token is never written in the file. |
| `subject` | text |  | 1 to 64 characters of A-Z a-z 0-9 . _ @ + - | The name of the user for whom the key operates. The call log shows it. |
| `tools` | list of texts | `[]` | names of tools, or * | The tools that the key can call. * is every read tool but the restricted tools. An empty list means no tool. |
| `expires` | text |  | an RFC 3339 time | The time when the key stops. After it, a request with the key gets 401. Empty: the key does not expire. |

## `mcp.mcp_key.scope`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `hosts` | list of texts |  | one name of a host that has mcp_uri | The host that the key reads. A key reads one host. Default: the host with mcp_uri, when the configuration has one only. |
| `databases` | list of texts | `[]` | patterns of databases and tables, or * | The data that the key reads. An empty list means no data. |

## `mcp.mcp_key.limits`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `max_rows` | integer |  | 1 to mcp.max_rows | The rows that a call of the key returns, at most. Default: the value of mcp.max_rows. |
| `timeout_seconds` | integer |  | 1 to mcp.query_timeout_seconds | The time of one call of the key. Default: the value of mcp.query_timeout_seconds. |
| `rate_limit_per_minute` | integer |  | 1 to mcp.rate_limit_per_minute | The requests that the key can send in one minute. Default: the value of mcp.rate_limit_per_minute. |

## `mcp.key`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `name` | text |  | a-z, 0-9, - and _ (at most 32 bytes), no ui_ at the start | The name of the key. It is required and each key has a different one. |
| `secret_env` | environment variable name |  | letters, digits and _ | The variable that holds the token of the key: an mcp_ token, or the UUID version 4 of an older key. It is a secret. Give exactly one of secret_env and secret_file. The secret is never written in the file. |
| `secret_file` | file path |  |  | The file that holds the token of the key, without its last line end: an mcp_ token, or the UUID version 4 of an older key. It is a secret. Give exactly one of secret_env and secret_file. The secret is never written in the file. |
| `hosts` | list of texts |  | one name of a host that has mcp_uri | The host that the key reads. It is required. A key reads one host: make one key for each host. |
| `tools` | list of texts | `[]` | names of tools, or * | The tools that the key can call. An empty list means no tool. |
| `databases` | list of texts | `[]` | patterns of databases and tables, or * | The data that the key reads. An empty list means no data. |
| `max_rows` | integer |  | 1 to mcp.max_rows | The rows that a call of the key returns, at most. Default: the value of mcp.max_rows. |
| `timeout_seconds` | integer |  | 1 to mcp.query_timeout_seconds | The time of one call of the key. Default: the value of mcp.query_timeout_seconds. |

## `telemetry`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `enabled` | boolean | `false` |  | Send the SERVER span of each MCP request, a child span for each ClickHouse statement of the call, the call log, and the CLIENT span of each call to the PDP of the access block to an OTLP/HTTP receiver (JSON encoding). It needs otlp_endpoint. |
| `otlp_endpoint` | text |  | http://host[:port][/path] | The base URL of the OTLP/HTTP receiver. The spans go to <base>/v1/traces and the call log to <base>/v1/logs. Only http: ChDash has no TLS client. It is required when enabled is true. Give only one of otlp_endpoint, otlp_endpoint_env and otlp_endpoint_file. |
| `otlp_endpoint_env` | environment variable name |  | letters, digits and _ | The variable that holds the value of otlp_endpoint. Give only one of otlp_endpoint, otlp_endpoint_env and otlp_endpoint_file. |
| `otlp_endpoint_file` | file path |  |  | The file that holds the value of otlp_endpoint, without its last line end. Give only one of otlp_endpoint, otlp_endpoint_env and otlp_endpoint_file. |
| `service_name` | text | `chdash` |  | The service.name of the resource of the spans and the log records: 1 to 255 bytes, no control character. |
| `export_interval` | duration | `5s` | 100ms to 1h | The longest time that a span or a log record waits in the queue before it is sent. A full batch is sent at once. |
| `export_timeout` | duration | `10s` | 100ms to 5m | The time of one export request. A batch that fails with a connection error, 429, 502, 503 or 504 is sent again two times at most, then dropped and counted. |
| `connect_timeout` | duration | `2s` | 100ms to 1m | The time to open the connection to the receiver. It is at most export_timeout. |
| `max_queue_size` | integer | `2048` | 1 to 1000000 items | The spans that wait for the export, at most, and the log records too. A new item past the limit is dropped and counted in chdash_telemetry_dropped_total. |
| `max_export_batch_size` | integer | `512` | 1 to 100000 items | The items of one export request, at most. It is at most max_queue_size. |
| `call_log` | boolean | `true` |  | Send the call log (mcp.call) as OTLP log records too. The JSON line of the log is always written. |

## `access`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `mode` | one of authzen\|open |  |  | Required: a file without the access block stops the start. authzen: each request of the pages and of the API needs a valid identity token, and the PDP decides each action. open: no check; the start writes a warning. Use open only for a server alone on a closed network. open takes no identity block and no pdp block. |

## `access.identity`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `header` | text | `X-Identity-Token` | an HTTP header name, not Cookie or Authorization | The request header that carries the identity token. The token is never read from a cookie or from a query parameter. |
| `issuer` | text |  | 1 to 1024 bytes, no control character | Required with authzen: the value that the iss claim of a token must have. |
| `audience` | text |  | 1 to 256 bytes, no control character | Required with authzen: the name of this server. The aud claim of a token must contain it. It is also the id of the service resource that ChDash sends to the PDP, and the server of GET /.well-known/access-actions. |
| `public_keys` | text |  | PEM, 1 to 16 SubjectPublicKeyInfo blocks | The public keys of the issuer: Ed25519 (EdDSA) or P-256 with an uncompressed point (ES256). A token signed by one of them is accepted. Give exactly one of public_keys, public_keys_env and public_keys_file. |
| `public_keys_env` | environment variable name |  | letters, digits and _ | The variable that holds the value of public_keys. Give exactly one of public_keys, public_keys_env and public_keys_file. |
| `public_keys_file` | file path |  |  | The file that holds the value of public_keys, without its last line end. Give exactly one of public_keys, public_keys_env and public_keys_file. |
| `max_age` | duration | `5m` | 1s to 24h | The longest life of a token: exp - iat is at most this value. A token with a longer life gets 401. |

## `access.pdp`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `url` | text |  | http://host[:port][/path] | Required with authzen: the base URL of the AuthZEN PDP. ChDash sends POST <url>/access/v1/evaluation and <url>/access/v1/evaluations. Only http: ChDash has no TLS client, so the network between ChDash and the PDP must be private to them. Give exactly one of url, url_env and url_file. |
| `url_env` | environment variable name |  | letters, digits and _ | The variable that holds the value of url. Give exactly one of url, url_env and url_file. |
| `url_file` | file path |  |  | The file that holds the value of url, without its last line end. Give exactly one of url, url_env and url_file. |
| `token_env` | environment variable name |  | letters, digits and _ | The variable that holds the token of this server at the PDP (Authorization: Bearer). It is a secret. Give exactly one of token_env and token_file. |
| `token_file` | file path |  |  | The file that holds the token of this server at the PDP, without its last line end. It is a secret. Give exactly one of token_env and token_file. |
| `timeout` | duration | `500ms` | 10ms to 1m | The time of one request to the PDP. Without an answer in this time, the decision is false (fail closed). |
| `cache_ttl` | duration | `30s` | 0s to 1h | How long ChDash keeps an answer of the PDP for one subject, action and resource. 0s: no cache. A failure is never kept. |
