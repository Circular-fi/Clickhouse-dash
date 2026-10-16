# Operations: probes, shutdown, logs, metrics and HTTP security

This page tells an operator how ChDash starts, stops, reports its state and protects its pages. The settings are in the `server` block ([configuration.md](configuration.md#the-server-block)).

## Health probes

| Route | Answer | Use it for |
|---|---|---|
| `GET /livez` | `200 ok` while the process serves HTTP. It does not ask ClickHouse. | The liveness probe. A failure means a stuck process. A restart can help. |
| `GET /readyz` | `200` when the server does not stop and at least one host answers its last ping. Otherwise, `503`. JSON: `ready`, `stopping`, `healthy_hosts`, `total_hosts`. | The readiness probe of a load balancer or an orchestrator. |
| `GET /healthz` | `200 ok` only when every host answers. Otherwise, `503` (`db_unhealthy`, or `server_stopping`). | The strict check of earlier versions. Do not use it as a liveness probe. If one host is down, the liveness probe fails and the server restarts. A restart repairs nothing. |
| `GET /api/health` | The same as `/healthz`, as JSON with the counts. | The pages and the tests. |

`chdash --config <file> --health` sends `GET /livez` to the server that runs with this configuration. When the server listens on every address (`0.0.0.0` or `::`), the command uses the loopback address. The command exits with status 0 when the answer is 200. Otherwise, it exits with status 1. It does not connect to ClickHouse, and it does not read the key file or the query library. The test image and the example compose file use it as the container health check: `--interval=10s --timeout=3s --retries=3`.

A Kubernetes deployment can use the routes directly:

```yaml
livenessProbe:  { httpGet: { path: /livez,  port: 8080 }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
readinessProbe: { httpGet: { path: /readyz, port: 8080 }, periodSeconds: 5,  timeoutSeconds: 3 }
terminationGracePeriodSeconds: 15   # more than server.shutdown_timeout_ms
```

Each host has a ping thread of its own. A slow or down host does not delay the ping of another host. The access audit runs in a separate thread (`CHECK GRANT`, docs/configuration.md "Host identities and the access audit"). It has its own connections and a budget of 60 seconds for each host. The audit never delays a ping. When the budget ends, the audit reports only what it read, and the log has the line `access.audit_incomplete`.

## Shutdown

SIGTERM and SIGINT stop the server cleanly. This is true for every build. In a container, the binary is process 1. Process 1 ignores a signal that it does not handle. ChDash handles SIGTERM itself. Therefore, `docker stop` and a Kubernetes pod stop at once and do not wait for the kill.

The stop has these steps:

1. `/readyz` and `/healthz` answer 503 (`server_stopping`). A request that still comes on an open connection answers 503 `server_stopping`. The probes and `/metrics` still answer.
2. ChDash cancels each query that runs. It sends `KILL QUERY` to ClickHouse. The result stream of each query ends with an `error` event (`error_code: "server_stopping"`) and a `done` event. The page then shows that the server stopped the query.
3. ChDash kills the ClickHouse query of each export. The ZIP archive ends with an `error.txt` file. This file states that the server stopped. The archive is complete, not cut.
4. The health threads stop, and the host status streams end.
5. The listening socket closes. A new connection is refused. The requests in progress end. ChDash writes the usage of the MCP keys (the file of this instance in `mcp.usage.dir`, docs/mcp.md). It writes the usage again when the requests have ended.
6. ChDash waits for each query thread. Then the process exits with status 0.

`server.shutdown_timeout_ms` (default 10 000) limits the whole stop. If the stop takes longer, or if a second signal comes, the process exits at once with status 1. The log line is `server.shutdown_timeout` or `server.signal_again`. Give the container more time than this limit. Set `stop_grace_period: 15s` in compose and `terminationGracePeriodSeconds: 15` in Kubernetes. `init: true` is not necessary, but it does no harm.

## Errors

Every HTTP API error has the same JSON body on every route:

```json
{"error_code": "logs_timeout", "message": "The logs query exceeded its time limit. Narrow the time range or add filters.", "retryable": true}
```

- `error_code` says what happened. It is a word of the route (`trace_not_found`, `invalid_range`) or one of the codes below.
- `message` is a sentence for a person.
- `retryable` is `true` when the same request can work later. This applies when the server stops or is busy, when a host is down, or when a time limit ends. The value follows the status (429, 503 and 504) unless the code gives another value.
- Some errors add members. `field` and `reason` give a refused value. `user`, `grant` and `hint` describe a grant that is not present. `query_id` and `index` identify a run. `revision`, `folders` and `queries` belong to the query library. `clickhouse` gives `code`, `position`, `line`, `col` and `near`. These members give the place of a mistake in the SQL.
- An error has `Cache-Control: no-store`. The `error` event of a stream has the same body.

The status of a failed ClickHouse statement depends on the **code that ClickHouse sends**. It never comes from a word in the message. The same failure gives the same answer on every page:

| ClickHouse | Status | `error_code` | `retryable` |
|---|---|---|---|
| `TIMEOUT_EXCEEDED` (159), or a socket that waited too long | 504 | `<page>_timeout` | yes |
| `TOO_MANY_ROWS` (158), `TOO_MANY_BYTES` (307), `TOO_MANY_ROWS_OR_BYTES` (396) | 422 | `<page>_scan_limit` | no |
| `MEMORY_LIMIT_EXCEEDED` (241) | 422 | `<page>_memory_limit` | no |
| `ACCESS_DENIED` (497) | 503 | `<page>_not_granted`, with `reason`, `user`, `grant` and `hint` | no |
| The caller disconnects, or `QUERY_WAS_CANCELLED` (394) | 499 | `canceled` | no |
| The connection fails, or ClickHouse is overloaded (202, 203, 209, 210, 279) | 503 | `host_unavailable` | yes |
| Any other refusal of ClickHouse | 503 | the code of the route (`trace_search_failed`) | no |
| A fault of ChDash itself | 500 | the code of the route | no |

`<page>` is `logs`, `trace`, `metrics` or `signal`. A wrong request (a bad parameter or a bad JSON body) answers 400 with a code of its own. A route that names an unknown host answers 404 `unknown_host`. A statement that ChDash refuses to run answers 403 `sql_forbidden`. Such a statement is a `KILL QUERY` in the SQL of a run or of an export.

The System page routes, `/api/system/...`, have a short, fixed list of parameters. They answer 400 `unknown_parameter` to any other name. A number in a parameter is the whole text of the value, so `123abc`, ` 12` and `1e3` are not integers. The trace and metrics routes read a bad `start_ms` or `end_ms` as 400. For the other numbers of the Traces routes (`limit`, `lookback_minutes`, the duration bounds), a text that is not a number gives the default. A number outside the bounds gives the nearest bound.

A batch of statements (`POST /api/format` with `sqls`) answers 200 with a status for each statement. The error of a statement is in its entry. This entry has the same members and the member `index`. A statement whose meaning the formatter changes gets the status `formatted`. Its entry keeps the text as it was written, and it also has a `warning` (`format_meaning_changed`).

The `clickhouse` member of a refused statement shows where ClickHouse stopped. The position counts in the text that the client sent. A text that is longer than the limit answers 422. The message gives the limit ([formatter.md](formatter.md)).

MCP keeps two shapes that its protocol defines. The first is the JSON-RPC error of `POST /mcp` (`{"error": {"code", "message"}}`). The second is the result of a failed tool (`isError: true`, `{"error", "message"}` in `structuredContent`, [mcp.md](mcp.md)). The HTTP errors of `POST /mcp` and of the `/api/mcp` routes have the body above.

## Admission

The heavy reads of the pages and the calls of the API tools of MCP take a place before they open a connection to ClickHouse. Without this limit, a burst opens one connection to a host for each request. It also holds one server thread for each request. A burst can be five tabs that refresh, eight tool calls or three Deep Analyze requests.

| Class | Routes | Limit (the `admission` block) |
|---|---|---|
| `heavy` | The reads of the Explorer, System, Traces, Logs and Metrics pages, not their `meta` routes; and the cost of an MCP key (`GET /api/mcp/keys/<id>/cost`, for the host of the key) | `heavy_per_host` (default 16) for each host |
| `analysis` | `POST /api/query/analysis`, and the job of `POST /api/query/deep-analysis` (from its start to its end) | `analysis_per_host` (default 1) for each host |
| `mcp` | The API tools of MCP | `mcp_max` (default 8) in all |

A request above the limit waits at most `admission.wait_ms` (default 5000). The wait ends when the browser disconnects or the server stops. When no place becomes free, the answer is `503 server_busy` with `Retry-After: 1` and `retryable: true`. A limit of `0` means no limit. A request that does not name a known host takes no place.

`GET /metrics` shows `chdash_admission_in_use`, `chdash_admission_waiting` and `chdash_admission_refused_total` for each class and host.

Deep Analyze is a job. It replays the SQL of the run with `EXPLAIN ANALYZE` on the connection of the runner. The request that starts it answers at once. The job keeps one place of the `analysis` class until it ends.

The job has the bounds of a run and a time limit of its own (`analysis.deep_max_execution_time_s`). It can be canceled and has a bounded store of results. A client polls it. [query-analysis.md](query-analysis.md#deep-analyze-backend) describes the protocol.

## Logs

ChDash writes its log to stderr. Each line is one JSON object.

```json
{"ts":"2026-10-10T12:00:00.123Z","level":"info","event":"http.request","request_id":"9f2c1d0e8a7b6c5d","method":"POST","path":"/api/query/run","route":"/api/query/run","status":200,"duration_ms":1.4,"bytes":426,"stream":false,"remote":"10.0.0.7"}
```

- `ts` is UTC with milliseconds. `level` is `info`, `warn` or `error`. `event` names what happened.
- A line never holds row data, a secret, a password, a token or a `query_id`. The text of an unexpected exception can quote SQL. ChDash cuts this text to 300 bytes.
- Each line is written whole. Two threads never mix their lines.

The events:

| Event | When |
|---|---|
| `server.config`, `server.config.sources`, `server.host`, `server.mcp`, `server.query_library` | At start. `server.config` has the settings. It includes the hosts, the libraries and the MCP keys of the file. `server.config.sources` tells the source of each value that is not a default (`file`, `env:VAR` or `file:/path`). `server.host` has the URIs of a host. The passwords are removed. A secret shows as `<hidden>`. |
| `server.listening`, `server.listen_failed` | The server listens, or it cannot bind its address. |
| `server.signal`, `server.stopping`, `server.stopped`, `server.shutdown_timeout`, `server.signal_again` | The stop (see "Shutdown"). |
| `server.stats` | Every `server.stats_log_interval_ms` (default 5 minutes; 0 = never). The line gives the requests in flight, connections, sessions, query threads, streams, exports and healthy hosts. |
| `http.request` | One line for each request. `server.access_log` controls this line (default true). The line has `request_id`, `method`, `path`, `route`, `status`, `duration_ms`, `bytes`, `stream` and `remote`. The `path` never has the query string, because it can hold an export token. `duration_ms` ends at the answer headers. A successful probe is not logged. |
| `http.stream_end` | A stream ends. A stream is a query result, an export or the host status. The line has `request_id`, `path` and `duration_ms`. |
| `http.unhandled_exception` | A handler fails. The client gets a JSON 500 `internal_error`, never the text of the exception. |
| `health.host_down`, `health.host_up` | A host stops or starts to answer its ping. The line is written once for each change. It has the error. |
| `access.finding`, `access.audit_incomplete` | The access audit reports a finding when the finding appears or changes. `access.audit_incomplete` marks an audit that used all its budget. |
| `mcp.call` | One record for each request to `POST /mcp`. The record has the fields of the call log of the MCP contract (docs/mcp.md, "Call log"). |
| `mcp.page` | One line for each action of the MCP page on the keys (docs/mcp.md, "Call log"). |
| `config.warning` | The configuration uses a deprecated form. Or a key has a token of the older form (docs/mcp.md, "Startup warnings"). |
| `query.cancel_failed` | A cancel fails to reach ClickHouse. |
| `query.kill_failed` | A `KILL QUERY` of a cancel does not work. The cause is an absent grant or a lost connection. The cancel stays best effort. |
| `mcp.tool_failed` | A tool of MCP fails with an exception. The line has the tool, the key and the cut text of the error. |
| `mcp.usage_save_failed` | The usage file of this instance cannot be written. The file is `<mcp.usage.dir>/<instance>.jsonl.zst` (docs/mcp.md). The line has the file and the error. The counts stay in memory. The next save tries again a minute later. ChDash writes the whole file every minute when a count changed. Above 8 MiB of JSON before compression, it writes every 5 minutes instead. A cell takes about 150 to 200 bytes of JSON before compression. The million cells that an instance keeps at most take 150 to 200 MB of JSON. That is a tenth of that size when compressed. This stays under the 512 MiB (128 MiB compressed) that a read can use. |
| `mcp.usage_file_skipped` | ChDash did not read the file of another instance in `mcp.usage.dir`. The line has the instance, the file and the reason. The reasons are these. A file is not zstd. A line is not valid. The `format` or `version` is not the expected one. A header names another instance. A file exceeds a bound. The file cannot be opened. The directory holds more than 256 instances. The bounds are 128 MiB compressed, 512 MiB decompressed, 64 KiB for a line, 10,000 keys and 2,000,000 cells. One line is written for each change of the file. The file is not read until it changes. The answers of the usage list show this reason (`instances`, status `skipped`). The skip does not stop anything. |
| `mcp.usage_instance_conflict` | Another live process writes the file of this instance. Its `boot` differs from the `boot` of this process, and it wrote the file less than 2 minutes ago. The line, which is written once for each change of the other process, has the instance, the directory and when the other process wrote. This process does not write its file, and its counts stay in memory. The answers say `conflict`. This process writes again after the other process has not written for 2 minutes. Give each instance its own `mcp.usage.instance`. |
| `mcp.usage_file_removed` | ChDash removed the file of an instance that is gone. Both its header and its file were older than `mcp.usage.retention_days` and a day. The line has the instance, the file and when the file was written. |
| `mcp.usage_refresh_failed` | The directory `mcp.usage.dir` cannot be listed. The answers keep what they read before. The line has the directory and the error. One line is written for each change of the error. |
| `mcp.usage_dir_writable_by_all` | At the start, `mcp.usage.dir` is a directory that anyone can write in. The sticky bit is not set. Anyone who can write there can plant a file that the other instances read. This person can also remove a file. Give the directory to ChDash alone, or set the sticky bit. |
| `traces.index_fallback`, `traces.estimate_failed`, `traces.filters_are_broad_failed`, `traces.release_markers_failed`, `traces.attribute_maps_failed` | A Traces route left its fast path. This happens in the index search or in the estimate of the size of a window. It also happens in the test of broad filters, in the release markers or in the read of the attribute columns. The answer is still given. It is slower, or it has less detail. The search says `fallback_reason`. |
| `query_library` | A load, migration or write error of the query library file. |

Each answer has an `X-Request-Id` header. When a proxy sets the `X-Request-Id` of a request, ChDash keeps it. The value has 1 to 128 characters of `A-Z a-z 0-9 . _ : -`. Otherwise, ChDash makes a new one. The `request_id` of the log has the same value.

## Metrics

`GET /metrics` gives the Prometheus text format (version 0.0.4). To remove the route, set `server.metrics = false`. The metrics name hosts and identities. They never show a URI, a user or a password. Do not expose this route to the Internet, because it needs no identity token. This is also true in the authzen mode of the `access` block ([access.md](access.md)).

| Metric | Type | What |
|---|---|---|
| `chdash_build_info{version,git_sha}` | gauge | Always 1. |
| `chdash_process_start_time_seconds`, `chdash_uptime_seconds` | gauge | The start of the process. |
| `chdash_stopping` | gauge | 1 while the server stops. |
| `chdash_http_requests_total{method,route,code}` | counter | Answered requests. `route` is the pattern of the handler. It is `-` when no handler matches. |
| `chdash_http_request_duration_seconds{method,route}` | histogram | The time from the first byte of the request to the answer headers. A stream counts until its first byte. |
| `chdash_http_requests_in_flight` | gauge | Requests that wait for their answer. |
| `chdash_http_connections_active`, `chdash_http_connections_queued` | gauge | Connections that a worker serves. Connections that wait for a worker (`server.max_queued_requests`). |
| `chdash_http_connections_refused_total` | counter | Connections closed at once because the queue is full. |
| `chdash_query_sessions{state}` | gauge | Query sessions: `created`, `running`, `finished`, `error`, `canceled`, `result_limit_reached`. |
| `chdash_query_threads`, `chdash_query_streams` | gauge | Queries that ClickHouse runs. Open result streams. |
| `chdash_host_streams`, `chdash_exports_active` | gauge | Open host status streams and exports. |
| `chdash_host_up{host}`, `chdash_host_ping_seconds{host}` | gauge | The last ping of each host (runner credentials). |
| `chdash_host_access_findings{host}` | gauge | Findings of the access audit. |
| `chdash_clickhouse_connections{host,identity,state}` | gauge | Native connections of the pool: `idle` or `leased`, for `runner`, `system` and `mcp`. |
| `chdash_clickhouse_connections_opened_total`, `chdash_clickhouse_connections_invalidated_total` | counter | Connections that the pool opened. Leased connections that their user marked unsafe. |
| `chdash_telemetry_exported_total{signal}`, `chdash_telemetry_dropped_total{signal,reason}`, `chdash_telemetry_export_requests_total{signal,result}`, `chdash_telemetry_queue_items{signal}` | counter, gauge | The OTLP export of MCP, when `telemetry.enabled` is `true`. Refer to [server-telemetry.md](server-telemetry.md#metrics). |

## HTTP security

### Headers

Every answer has these headers:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |

A page shell has a policy of its own. ChDash adds the hash (`'sha256-…'`) of each inline script of the shell to `script-src`. Only these scripts run, and no other inline script runs. `'wasm-unsafe-eval'` lets the pages compile the WebAssembly kernels of this server (docs/wasm.md).

The value `'wasm-unsafe-eval'` does not let `eval` run. `'unsafe-inline'` in `style-src` is necessary, because the pages set style attributes. A reverse proxy must not replace these headers. It can add headers. For example, it can add `Strict-Transport-Security` when it terminates TLS.

### The guard of the writes

A page of another site must not use the browser of a user to change anything or to run SQL. This applies also when the browser has an identity token of the access gateway ([access.md](access.md)). For this reason, every `POST`, `PUT`, `PATCH` and `DELETE` request passes one guard before ChDash reads the body. These requests include a run, a cancel, a format, an analysis, an export, the table preview, the query library and the MCP keys.

- When the browser sends `Sec-Fetch-Site`, the value must be `same-origin` or `none`. Otherwise, the answer is 403 `cross_site_request`.
- If the browser does not send `Sec-Fetch-Site` (an older browser), the `Origin` header must name this server. The name is the `Host` header or the first `X-Forwarded-Host`. Otherwise, the answer is 403 `cross_site_request`. A proxy that changes `Host` must set `X-Forwarded-Host`.
- A request with a body must send `Content-Type: application/json`. Otherwise, the answer is 415 `unsupported_media_type`. A page of another site cannot send this type without a CORS preflight. ChDash never lets a preflight succeed.

A client that is not a browser sends neither header, and it passes the guard. Examples are curl, a script or a test. `POST /mcp` has its own rules (`mcp.allowed_origins`, docs/mcp.md). The MCP routes that show a secret, what a key reaches, what it did or what it cost also refuse a cross-site request. These routes are `GET .../secret`, `GET .../access`, `GET /api/mcp/access`, `GET /api/mcp/usage`, `GET /api/mcp/usage/overview`, `GET .../usage` and `GET .../cost`.

### Static assets

The staged shells ask for each script, stylesheet and WebAssembly kernel as `static/<file>?v=<hash>`, where the hash starts the SHA-256 of the file. ChDash answers `Cache-Control: public, max-age=31536000, immutable` only when the `?v=` value has 8 to 64 lower-case hexadecimal digits. These digits must start the SHA-256 of the bytes that ChDash sends. Any other `?v=` value gets the current bytes with `Cache-Control: no-store`. Thus, a tab that was open before a deploy never binds an old address to new code in the cache of the browser. A shell and an address without `?v=` revalidate (`max-age=0, must-revalidate`), and a web font is kept for a week.

### Identifiers and secrets

These values come from the system random source:

- the `query_id` of a run;
- the `export_id` of an export;
- the signing secret of the cancel and export tokens;
- the tokens of the MCP keys;
- the span identifiers of the MCP call log;
- the internal token of the MCP API tools;
- the UUID that ends the `query_id` of a statement of an MCP call (`chdash-mcp/<key id>/<tool>/<uuid>`, docs/mcp.md);
- the names of the temporary files.

ChDash uses `getrandom`. When that is not available, it uses `/dev/urandom`. A `query_id` gives access to the result stream of its query. Therefore, it must not be guessable.
