# Operations: probes, shutdown, logs, metrics and HTTP security

This page tells an operator how ChDash starts, stops, reports its state and protects its pages. The settings are in the `server` block ([configuration.md](configuration.md#the-server-block)).

## Health probes

| Route | Answer | Use it for |
|---|---|---|
| `GET /livez` | `200 ok` while the process serves HTTP. It does not ask ClickHouse. | The liveness probe. A failure means a stuck process: a restart can help. |
| `GET /readyz` | `200` when the server does not stop and at least one host answered its last ping, else `503`. JSON: `ready`, `stopping`, `healthy_hosts`, `total_hosts`. | The readiness probe of a load balancer or an orchestrator. |
| `GET /healthz` | `200 ok` only when every host answers, else `503` (`db_unhealthy`, or `server_stopping`). | The strict check of earlier versions. Do not use it as a liveness probe: one host that is down would restart the server, and a restart repairs nothing. |
| `GET /api/health` | The same as `/healthz`, as JSON with the counts. | The pages and the tests. |

`chdash --config <file> --health` sends `GET /livez` to the server that runs with this configuration. It uses the loopback address when the server listens on every address (`0.0.0.0` or `::`). It exits with status 0 when the answer is 200, and 1 otherwise. It does not connect to ClickHouse and does not read the key file or the query library. The test image and the example compose file use it as the container health check: `--interval=10s --timeout=3s --retries=3`.

A Kubernetes deployment can use the routes directly:

```yaml
livenessProbe:  { httpGet: { path: /livez,  port: 8080 }, periodSeconds: 10, timeoutSeconds: 3, failureThreshold: 3 }
readinessProbe: { httpGet: { path: /readyz, port: 8080 }, periodSeconds: 5,  timeoutSeconds: 3 }
terminationGracePeriodSeconds: 15   # more than server.shutdown_timeout_ms
```

Each host has a ping thread of its own. A host that is slow or down never delays the ping of another host. The access audit (`CHECK GRANT`, docs/configuration.md "Host identities and the access audit") runs in a separate thread, with its own connections and a budget of 60 seconds for each host. The audit never delays a ping. When the budget ends, the audit reports only what it read, and the log has the line `access.audit_incomplete`.

## Shutdown

SIGTERM and SIGINT stop the server cleanly. This is true for every build. In a container, the binary is process 1, and process 1 ignores a signal that it does not handle. ChDash handles SIGTERM itself, so `docker stop` and a Kubernetes pod stop at once and do not wait for the kill.

The stop has these steps:

1. `/readyz` and `/healthz` answer 503 (`server_stopping`). A request that still comes on an open connection answers 503 `server_stopping`. The probes and `/metrics` still answer.
2. ChDash cancels each running query and sends `KILL QUERY` to ClickHouse. The result stream of each query ends with an `error` event (`error_code: "server_stopping"`) and a `done` event, so the page shows that the server stopped the query.
3. ChDash kills the ClickHouse query of each export. The ZIP archive ends with an `error.txt` that says that the server stopped. The archive is complete, not cut.
4. The health threads stop, and the host status streams end.
5. The listening socket closes: a new connection is refused. The requests in progress end.
6. ChDash waits for each query thread. Then the process exits with status 0.

`server.shutdown_timeout_ms` (default 10 000) limits the whole stop. When the stop takes longer, or when a second signal comes, the process exits at once with status 1 (log line `server.shutdown_timeout` or `server.signal_again`). Give the container more time than this limit: `stop_grace_period: 15s` in compose, `terminationGracePeriodSeconds: 15` in Kubernetes. `init: true` is not necessary, but it does no harm.

## Errors

Every error of the HTTP API has the same JSON body, on every route:

```json
{"error_code": "logs_timeout", "message": "The logs query exceeded its time limit. Narrow the time range or add filters.", "retryable": true}
```

- `error_code` says what happened. It is a word of the route (`trace_not_found`, `invalid_range`) or one of the codes below.
- `message` is a sentence for a person.
- `retryable` is `true` when the same request may work later: the server is stopping or busy, a host is down, or a time ran out. It follows the status (429, 503 and 504) unless the code says otherwise.
- Some errors add members: `field` and `reason` (a value that was refused), `user`, `grant` and `hint` (a missing grant), `query_id` and `index` (a run), `revision`, `folders` and `queries` (the query library), and `clickhouse` (`code`, `position`, `line`, `col` and `near`, the place of a mistake in the SQL).
- An error has `Cache-Control: no-store`. The `error` event of a stream has the same body.

A failure of a ClickHouse statement gets its status from the **code that ClickHouse sends**, never from a word in its message. The same failure has the same answer on every page:

| ClickHouse | Status | `error_code` | `retryable` |
|---|---|---|---|
| `TIMEOUT_EXCEEDED` (159), or a socket that waited too long | 504 | `<page>_timeout` | yes |
| `TOO_MANY_ROWS` (158), `TOO_MANY_BYTES` (307), `TOO_MANY_ROWS_OR_BYTES` (396) | 422 | `<page>_scan_limit` | no |
| `MEMORY_LIMIT_EXCEEDED` (241) | 422 | `<page>_memory_limit` | no |
| `ACCESS_DENIED` (497) | 503 | `<page>_not_granted`, with `reason`, `user`, `grant` and `hint` | no |
| The caller went away, or `QUERY_WAS_CANCELLED` (394) | 499 | `canceled` | no |
| The connection failed, or ClickHouse is overloaded (202, 203, 209, 210, 279) | 503 | `host_unavailable` | yes |
| Any other refusal of ClickHouse | 503 | the code of the route (`trace_search_failed`) | no |
| A fault of ChDash itself | 500 | the code of the route | no |

`<page>` is `logs`, `trace`, `metrics` or `signal`. A request that is wrong (a bad parameter, a bad JSON body) answers 400 with a code of its own. A route whose host is unknown answers 404 `unknown_host`.

A route with a short, fixed list of parameters (the System page, `/api/system/...`) refuses any other name: 400 `unknown_parameter`. A number in a parameter is the whole text of the value: `123abc`, ` 12` and `1e3` are not integers. The trace and metrics routes read a bad `start_ms` or `end_ms` as 400. For the other numbers of the Traces routes (`limit`, `lookback_minutes`, the duration bounds), a text that is not a number gives the default, and a number outside the bounds gives the nearest bound.

MCP keeps two shapes that its protocol defines: the JSON-RPC error of `POST /mcp` (`{"error": {"code", "message"}}`), and the result of a failed tool (`isError: true`, `{"error", "message"}` in `structuredContent`, [mcp.md](mcp.md)). The HTTP errors of `POST /mcp` and of the `/api/mcp` routes have the body above.

## Admission

The heavy reads of the pages, and the calls of the API tools of MCP, take a place before they open a connection to ClickHouse. This keeps a burst (five tabs that refresh, eight tool calls, three Deep Analyze) from opening as many connections to a host as there are requests and from holding as many threads of the server.

| Class | Routes | Limit (the `admission` block) |
|---|---|---|
| `heavy` | The reads of the Explorer, System, Traces, Logs and Metrics pages (not their `meta` routes) | `heavy_per_host` (default 16) for each host |
| `analysis` | `POST /api/query/analysis` and `POST /api/query/deep-analysis` | `analysis_per_host` (default 1) for each host |
| `mcp` | The API tools of MCP | `mcp_max` (default 8) in all |

A request past the limit waits at most `admission.wait_ms` (default 5000). It stops waiting when the browser goes away or the server stops. When no place comes, the answer is `503 server_busy` with `Retry-After: 1` and `retryable: true`. `0` for a limit means no limit. A host that the request does not name (an unknown one) takes no place.

`GET /metrics` shows `chdash_admission_in_use`, `chdash_admission_waiting` and `chdash_admission_refused_total` for each class and host.

Deep Analyze is a synchronous request: it replays the SQL of the run with `EXPLAIN ANALYZE` on the connection of the runner. It has the bounds of a run (`query.max_execution_time_s`, `query.max_memory_usage` and `query.max_rows_to_read`), one place for each host, and it stops when the browser closes the request or the server stops. It is not a job that the page polls, because that would need another protocol between the page and the server.

## Logs

ChDash writes its log on stderr: one JSON object on each line.

```json
{"ts":"2026-10-10T12:00:00.123Z","level":"info","event":"http.request","request_id":"9f2c1d0e8a7b6c5d","method":"POST","path":"/api/query/run","route":"/api/query/run","status":200,"duration_ms":1.4,"bytes":426,"stream":false,"remote":"10.0.0.7"}
```

- `ts` is UTC with milliseconds. `level` is `info`, `warn` or `error`. `event` names what happened.
- A line never holds row data, a secret, a password, a token or a `query_id`. The text of an unexpected exception can quote SQL, so it is cut to 300 bytes.
- Each line is written whole. Two threads never mix their lines.

The events:

| Event | When |
|---|---|
| `server.config`, `server.host`, `server.mcp`, `server.query_library` | At start: the settings, and each host with its URIs (passwords removed). |
| `server.listening`, `server.listen_failed` | The server listens, or cannot bind its address. |
| `server.signal`, `server.stopping`, `server.stopped`, `server.shutdown_timeout`, `server.signal_again` | The stop (see "Shutdown"). |
| `server.stats` | Every `server.stats_log_interval_ms` (default 5 minutes; 0 = never): requests in flight, connections, sessions, query threads, streams, exports, healthy hosts. |
| `http.request` | One line for each request (`server.access_log`, default true): `request_id`, `method`, `path` (never the query string: it can hold an export token), `route`, `status`, `duration_ms` (to the answer headers), `bytes`, `stream`, `remote`. A probe that succeeds is not logged. |
| `http.stream_end` | A stream (a query result, an export, the host status) ended: `request_id`, `path`, `duration_ms`. |
| `http.unhandled_exception` | A handler failed. The client gets a JSON 500 `internal_error`, never the text of the exception. |
| `health.host_down`, `health.host_up` | A host stops or starts to answer its ping (once for each change, with the error). |
| `access.finding`, `access.audit_incomplete` | A finding of the access audit (when it appears or changes), or an audit that used all its budget. |
| `mcp.call` | One line for each MCP call (docs/mcp.md, "Audit log"). |
| `query.cancel_failed` | A cancel could not reach ClickHouse. |
| `query.kill_failed` | A `KILL QUERY` of a cancel did not work (a missing grant or a lost connection): the cancel stays best effort. |
| `mcp.tool_failed` | A tool of MCP failed with an exception: the tool, the key and the cut text of the error. |
| `traces.index_fallback`, `traces.estimate_failed`, `traces.filters_are_broad_failed`, `traces.release_markers_failed`, `traces.attribute_maps_failed` | A Traces route left its fast path: the index search, the estimate of the size of a window, the test of broad filters, the release markers, or the read of the attribute columns. The answer is still given, slower or with less detail (the search says `fallback_reason`). |
| `query_library` | A load, a migration or a write error of the query library file. |

Each answer has an `X-Request-Id` header. ChDash keeps the `X-Request-Id` of a request when a proxy sets one (1 to 128 characters of `A-Z a-z 0-9 . _ : -`). Otherwise it makes a new one. The `request_id` of the log is the same value.

## Metrics

`GET /metrics` gives the Prometheus text format (version 0.0.4). Set `server.metrics = false` to remove the route. The metrics name hosts and identities. They never show a URI, a user or a password. Do not expose this route to the Internet: like the rest of ChDash, it has no login.

| Metric | Type | What |
|---|---|---|
| `chdash_build_info{version,git_sha}` | gauge | Always 1. |
| `chdash_process_start_time_seconds`, `chdash_uptime_seconds` | gauge | The start of the process. |
| `chdash_stopping` | gauge | 1 while the server stops. |
| `chdash_http_requests_total{method,route,code}` | counter | Answered requests. `route` is the pattern of the handler (`-` when no handler matched). |
| `chdash_http_request_duration_seconds{method,route}` | histogram | From the first byte of the request to the answer headers. A stream counts until its first byte. |
| `chdash_http_requests_in_flight` | gauge | Requests that wait for their answer. |
| `chdash_http_connections_active`, `chdash_http_connections_queued` | gauge | Connections that a worker serves, and connections that wait for a worker (`server.max_queued_requests`). |
| `chdash_http_connections_refused_total` | counter | Connections closed at once because the queue was full. |
| `chdash_query_sessions{state}` | gauge | Query sessions: `created`, `running`, `finished`, `error`, `canceled`, `result_limit_reached`. |
| `chdash_query_threads`, `chdash_query_streams` | gauge | Queries that ClickHouse executes, and open result streams. |
| `chdash_host_streams`, `chdash_exports_active` | gauge | Open host status streams and exports. |
| `chdash_host_up{host}`, `chdash_host_ping_seconds{host}` | gauge | The last ping of each host (runner credentials). |
| `chdash_host_access_findings{host}` | gauge | Findings of the access audit. |
| `chdash_clickhouse_connections{host,identity,state}` | gauge | Native connections of the pool: `idle` or `leased`, for `runner`, `system` and `mcp`. |
| `chdash_clickhouse_connections_opened_total`, `chdash_clickhouse_connections_invalidated_total` | counter | Connections that the pool opened, and leased connections that their user marked unsafe. |

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

A page shell has a policy of its own: ChDash adds the hash (`'sha256-…'`) of each inline script of the shell to `script-src`. These scripts run, and no other inline script runs. `'wasm-unsafe-eval'` lets the pages compile the WebAssembly kernels of this server (docs/wasm.md). It does not allow `eval`. `'unsafe-inline'` in `style-src` is necessary because the pages set style attributes. A reverse proxy must not replace these headers. It can add headers, for example `Strict-Transport-Security` when it terminates TLS.

### The guard of the writes

ChDash has no login. A page of another site must not be able to use the browser of a user to change anything or to run SQL. For this reason, every `POST`, `PUT`, `PATCH` and `DELETE` (a run, a cancel, a format, an analysis, an export, the table preview, the query library, the MCP keys) passes one guard before ChDash reads the body:

- When the browser sends `Sec-Fetch-Site`, the value must be `same-origin` or `none`. Otherwise the answer is 403 `cross_site_request`.
- Without `Sec-Fetch-Site` (an older browser), an `Origin` header must name this server: the `Host` header, or the first `X-Forwarded-Host`. Otherwise the answer is 403 `cross_site_request`. A proxy that changes `Host` must set `X-Forwarded-Host`.
- A request with a body must send `Content-Type: application/json`. Otherwise the answer is 415 `unsupported_media_type`. A page of another site cannot send this type without a CORS preflight, and ChDash never allows a preflight.

A client that is not a browser (curl, a script, a test) sends neither header and passes. `POST /mcp` has its own rules (`mcp.allowed_origins`, docs/mcp.md). The routes of the MCP page that show a secret or what a key reaches (`GET .../secret`, `GET .../access`, `GET /api/mcp/access`) also refuse a cross-site request.

### Static assets

The staged shells ask for each script, stylesheet and WebAssembly kernel as `static/<file>?v=<hash>`, where the hash starts the SHA-256 of the file. ChDash answers `Cache-Control: public, max-age=31536000, immutable` only when the `?v=` value is 8 to 64 lower-case hexadecimal digits that start the SHA-256 of the bytes that it sends. Any other `?v=` gets the current bytes with `Cache-Control: no-store`. Thus a tab that a deploy left behind never binds an old address to new code in the cache of the browser. A shell and an address without `?v=` revalidate (`max-age=0, must-revalidate`). A web font is kept for a week.

### Identifiers and secrets

The `query_id` of a run, the `export_id` of an export, the signing secret of the cancel and export tokens, the secrets of the MCP keys, the internal token of the MCP API tools and the names of the temporary files come from the system random source (`getrandom`, else `/dev/urandom`). A `query_id` gives access to the result stream of its query, so it must not be guessable.
