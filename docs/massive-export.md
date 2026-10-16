# Massive streamed exports

The massive export is an API for clients other than the ChDash pages. The pages do not use it. `Run -> Download CSV` and `Run -> Download JSON` run the query in the normal way. They download the rows that the page received. See `post-run-download.md`.

The export path does not fill a result table. It does not keep the complete result in the memory of the client. It does not keep the result in the backend memory. It does not keep the result in a temporary file of the backend.

## Handshake and download capability

The client sends this request to prepare the export:

```http
POST api/export/run
Content-Type: application/json

{"host_id": "local", "format": "csv", "queries": ["SELECT 1", "SELECT 2"]}
```

The request contains `host_id`, `format` and the ordered SQL statements. The backend validates the host. It stores only a bounded and short-lived description of the export that waits for the stream.
The backend answers with a signed capability:

```json
{"export_id": "...", "format": "csv", "expires_in_ms": 120000, "stream_url": "api/export/stream", "token": "eyJ..."}
```

The client then starts the download with a `POST` request. The token is in the JSON body. The token is never in an address:

```http
POST api/export/stream
Content-Type: application/json

{"token": "eyJ..."}
```

A token in an address ends in the access logs. It also ends in the history of a browser, in a `Referer` header and in the logs of a proxy. A body does not end in these logs. For the same reason, `GET api/export/stream` starts nothing. It answers `405 method_not_allowed` with `Allow: POST`. It does not use the token.

The stream runs the SQL of the export. That SQL can be a command (`CREATE`, `ALTER`, `INSERT`). A method that a browser or a proxy sends on its own must not reach the stream. Examples are a prefetch and an `<img>` request. Like every write of ChDash, the `POST` needs `Content-Type: application/json` (`415 unsupported_media_type`). It also refuses a request from another site (`403 cross_site_request`).

The short token belongs to the export and to the host. It expires quickly. On the first accepted stream, the backend consumes the pending export in one atomic step. A second `POST` with the same token answers `404 export_not_found`. The token is an internal one-time capability. It is not a token for user authentication.

Use this example in a script:

```sh
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"host_id":"local","format":"csv","queries":["SELECT 1"]}' http://localhost:8080/api/export/run > handshake.json
curl -X POST -H 'Content-Type: application/json' \
  -d "{\"token\": \"$(jq -r .token handshake.json)\"}" -o export.zip http://localhost:8080/api/export/stream
```

The handshake and the stream use the one JSON error shape of [operations.md](operations.md#errors). The table lists these errors:

| Status | `error_code` | When |
|---|---|---|
| 400 | `invalid_json`, `missing_host_id`, `missing_format`, `missing_queries`, `invalid_format`, `invalid_queries`, `missing_export_token` | The request is not valid. |
| 403 | `sql_forbidden` | A statement is a `KILL QUERY`. The cancel capability of ChDash cancels a query. SQL does not cancel it. |
| 404 | `unknown_host`, `export_not_found` | The host or the export is not known. Or the token expired, or it was used. |
| 405 | `method_not_allowed` | `GET api/export/stream`. |
| 413 | `too_many_queries`, `sql_too_large`, `export_sql_too_large` | A limit of the handshake is exceeded. |
| 429 | `export_queue_full`, `export_capacity` | There are too many pending handshakes. Or all `export.max_concurrent` streams are in use. |
| 503 | `host_down`, `export_metadata_unavailable` | The host is down. Or the metadata of the archive cannot be read. |

Execution metadata is a **required** part of this export contract. The backend runs these checks before it accepts the handshake:

- It validates that it can discover the runner authorization boundary. The boundary comes from the ACL cache of the runner identity. The Explorer and the System pages share this cache. Refer to [Caches and privileges](configuration.md#caches-and-privileges). The preflight does not run a new discovery for each request.
- It validates that the system context for `execution.csv` is reachable.
- If log flushing is on, it checks the privilege with `CHECK GRANT SYSTEM FLUSH LOGS ON *.*`. The backend does not flush the logs. Only when the server gives an answer that the backend cannot decode, the preflight proves the privilege with one `SYSTEM FLUSH LOGS query_log`. Later, the collector flushes only when a `query_log` row is missing.

If a check fails, `POST api/export/run` returns an explicit JSON error. The download does not start. The one-time stream repeats this preflight before it sends the attachment headers. This step protects against a loss of connectivity between the two requests. A change of the grants becomes visible after the TTL of the ACL cache (`explorer.acl_cache_ttl_ms`).

## Streaming pipeline

```text
ClickHouse native blocks
        |
        v
CSV / JSONEachRow serializer
        |
        v
ZIP64 STORE writer
        |
        v
cpp-httplib DataSink
        |
        v
browser download
```

The ZIP writer is forward-only. It uses ZIP64 local and central records and a data descriptor. For this reason, it never seeks, and it supports entries larger than 4 GiB. V1 uses `STORE` on purpose. There is no ZIP compression. This keeps the CPU usage and the memory predictable.

`output_buffer_bytes` sets the limit of the staging buffer of the serializer. The memory does not grow with the number of exported rows. These are the only exceptions: the current ClickHouse block, this buffer, the small ZIP metadata directory and the socket buffers.

The JSON result file uses **JSONEachRow semantics**. Each row is one complete JSON object. A newline follows each object. The archive member has the name `results.json` for the UI contract. Readers of the file must not expect one large JSON array.

The values of the JSON file follow the contract of the Query results. Refer to "Result values" in `docs/telemetry.md`. For example, a `UInt64` is a string of its digits. NaN is `"nan"`. A Map is a list of `[key, value]` pairs.

CSV includes a header. A field has RFC style quotes only when it needs them. A field needs quotes when it has a comma, a quote, a line break, or a blank at either end. The writer doubles an embedded quote. The dashboard encodes nested ClickHouse values as compact JSON inside the CSV cell.

These values are Array, Tuple, Map and other structural values. The dashboard does not flatten them with an ambiguous custom delimiter. A `Nullable` null is a bare `\N`, as in the CSV format of ClickHouse (`format_csv_null_representation`). A text that is exactly `\N` has quotes. A reader therefore never takes it for a NULL. `Float32` keeps its shortest text: `0.1`, not `0.10000000149011612`.

The backend always runs the panel SQL through `runner_uri`. This includes commands such as `CREATE`, `ALTER`, `INSERT` or `OPTIMIZE`. This applies when the runner has the permission. Statements that return rows stream their rows.

A successful command without a result set gets a stable synthetic result member. This member contains `status=OK`. For this reason, the archive is not ambiguous. The backend uses `system_uri` only after that. It uses `system_uri` for the lookup of the execution log that it generates.

## Archive layout

Single statement:

```text
query.zip
├── query.sql
├── results.csv       # or results.json
└── execution.csv
```

Multiquery:

```text
queries.zip
├── query-001/
│   ├── query.sql
│   ├── results.csv
│   └── execution.csv
├── query-002/
│   └── ...
└── ...
```

The statements run one after the other. Assume that a statement fails after the backend sends output. Then the backend closes the result member of that statement. This member can contain partial data. After that, the backend appends `execution.csv` and `error.txt`.

The backend does not start the later statements. If the HTTP connection is still usable, the backend still sends the ZIP central directory.

The same rule to stop on an error applies in this case. The SQL succeeds. However, the backend cannot collect the required execution metadata after the query, in the bounded lookup window. Then `execution.csv` has the status `export_error`. `error.txt` contains the failure of the collector.

The backend does not start a later statement. The backend never serializes the errors of the collector as a successful execution.

## Backpressure and disconnects

`DataSink::write` of `cpp-httplib` is synchronous with the HTTP stream. A slow browser therefore slows the producer naturally. One write waits at most `server.write_timeout_ms` (default 120 seconds) for a client that does not read, for example a paused download. After that time, the export stops. Each export has a dedicated native ClickHouse connection. The backend never returns this connection to the interactive connection pool.

The ClickHouse query uses `Query::OnDataCancelable`. If the HTTP sink is not writable any more, the callback returns `false`. This causes `clickhouse-cpp` to send a native Cancel packet. The progress callback also checks the sink. A statement can send no row and no progress for a long time (a long DDL, `OPTIMIZE ... FINAL`, a mutation with `mutations_sync`).

For this case, a watchdog thread checks the download every second while the statement runs. When the download closes, the watchdog runs `KILL QUERY ... ASYNC` with the system account. It uses `system_uri`, as the cancel of a run does. The runner has no `KILL QUERY` grant. Refer to [Authorization model](configuration.md#authorization-model). The export then releases its slot of `export.max_concurrent` at once.

Each statement carries `log_comment = 'chdash-export'`. It also carries `max_execution_time` and `max_memory_usage` when `export.max_execution_time_s` and `export.max_memory_usage` set them. A value of 0, the default, leaves them to the profile of the runner. A statement fails when it sends nothing for `export.receive_timeout_ms` (default 10 minutes, 0 = no limit). The connection uses TCP keepalive. This finds a peer that is gone sooner.

## No resume

The backend does not keep the generated archive. For this reason, an arbitrary HTTP Range resume is not possible. The backend returns `Accept-Ranges: none` on purpose. The user must prepare an interrupted export again. A resumable export needs a separate architecture with object storage. This is outside V1.

## Limits

`export.max_concurrent` sets the limit of concurrent streams. The number of pending handshakes has a limit. The total number of retained SQL bytes also has a limit. These limits do not depend on the results of the active exports.
