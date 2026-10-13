# Configuration keys

This file is generated from `src/config_keys.def`. Do not edit it: run `python3 tools/gen_config_reference.py`.

Each key is in the block of the configuration file that its section names (`observability.traces` is
`observability { traces { ... } }`). A value outside its range stops the start with an error that names the key.
`chdash --config <file> --print-config` writes the value of every key as it applies.
The prose of the keys, and the blocks of hosts and MCP keys, are in [configuration.md](configuration.md).

## `server`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `listen_host` | text | `0.0.0.0` |  | The address that the server listens on. |
| `listen_port` | integer | `8080` | 1 to 65535 | The port that the server listens on. |
| `worker_threads` | integer | `0` | 0 or 1 to 1024 threads | Threads that stay ready to serve a request. 0 = the larger of 8 and the number of hardware threads. |
| `max_worker_threads` | integer | `256` | 1 to 4096 threads | The most threads that the pool grows to when streams hold threads. It is at least worker_threads. |
| `max_queued_requests` | integer | `1024` | 16 to 100000 requests | Requests that wait for a thread. A request past the limit is refused with 503. |
| `max_body_bytes` | integer | `0` | 0 or 65536 to 2147483648 bytes | The largest request body. A larger body is refused with 413 before it is read. 0 = derived from query.max_sql_bytes and the query library. |
| `max_host_streams` | integer | `64` | 0 to 4096 streams | Open status streams of the pages (one for each visible page). At most half of max_worker_threads. Past the limit a page polls. |
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

## `mcp`

| Key | Type | Default | Range | Use |
|---|---|---|---|---|
| `auth_header` | text | `Authorization` | an HTTP header name | The request header that carries the key. Authorization takes Bearer <key>. |
| `allowed_origins` | list of texts | `[]` | https://host[:port], at most 256 bytes each | The origins of the pages that may call from a browser. A call with no Origin is always accepted. |
| `enabled` | boolean | `false` |  | Serve the MCP endpoint, POST /mcp. |
| `storage_file` | text |  |  | The JSON file of the keys that are made on the MCP page. |
| `manage_from_ui` | boolean | `true` |  | Allow the MCP page to make and delete keys. When false, a change is refused with 403 manage_disabled. |
| `max_rows` | integer | `1000` | 1 to 1000000 rows | Rows that a call returns, at most. A key can lower it. |
| `max_result_bytes` | integer | `1048576` | 1024 to 268435456 bytes | Bytes that a call returns, at most. |
| `query_timeout_seconds` | integer | `30` | 1 to 3600 seconds | The time of one call. A key can lower it. |
| `max_sql_bytes` | integer | `65536` | 256 to 4194304 bytes | The largest SQL text of a call. |
| `max_memory_bytes` | integer | `1073741824` | 16777216 to 1099511627776 bytes | max_memory_usage of a call. |
| `max_rows_to_read` | integer | `0` | 0 to 1000000000000000 rows | max_rows_to_read of a call. 0 = no limit from ChDash. |
| `rate_limit_per_minute` | integer | `600` | 0 to 1000000 calls | Calls that one key may make in one minute. 0 = no limit. |
