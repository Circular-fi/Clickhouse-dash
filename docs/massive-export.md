# Massive streamed exports

`Run -> Download CSV` and `Run -> Download JSON` are different on purpose from the post-Run browser ZIP in `post-run-download.md`.

The direct-download path does not fill the result table. It does not keep the complete result in the browser memory, in the backend memory or in a temporary file of the backend.

## Handshake and download capability

The browser prepares the export with this request:

```http
POST api/export/run
```

The request contains `host_id`, `format` and the ordered SQL statements. The backend validates the host. It stores only a bounded and short-lived description of the pending export.
It returns a signed capability URL:

```text
api/export/stream?token=...
```

The short token belongs to the export and to the host. It expires quickly. The backend consumes the pending export atomically on the first accepted stream. The token is an internal one-time capability. It is not a token for user authentication.

Execution metadata is a **required** part of this export contract. Before the backend accepts the handshake, it does these checks:

- It validates that it can discover the runner authorization boundary. The boundary comes from the ACL cache of the runner identity, which the Explorer and the System pages share (refer to [Caches and privileges](configuration.md#caches-and-privileges)). The preflight does not run a new discovery for each request.
- It validates that the system context for `execution.csv` is reachable.
- If log flushing is enabled, it checks the privilege with `CHECK GRANT SYSTEM FLUSH LOGS ON *.*`. It does not flush. Only when the server gives an answer that the backend cannot decode, the preflight proves the privilege with one `SYSTEM FLUSH LOGS query_log`. Later, the collector flushes only when a `query_log` row is missing.

If a check fails, `POST api/export/run` returns an explicit JSON error. The download does not start. The one-time stream repeats this preflight before it commits the attachment headers. This protects against a loss of the connectivity between the two requests. A change of the grants shows after the TTL of the ACL cache (`explorer.acl_cache_ttl_ms`).

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

The ZIP writer is forward-only. It uses ZIP64 local and central records and a data descriptor. For this reason, it never seeks, and it supports entries larger than 4 GiB. V1 uses `STORE` on purpose (no ZIP compression). This keeps the CPU usage and the memory predictable.

`output_buffer_bytes` bounds the staging buffer of the serializer. The memory does not grow with the number of exported rows. The only exceptions are the current ClickHouse block, this buffer, the small ZIP metadata directory and the socket buffers.

The JSON result file uses **JSONEachRow semantics**. Every row is one complete JSON object followed by a newline. The archive member has the name `results.json` for the UI contract. The consumers must not expect one large JSON array.

The values of the JSON file follow the contract of the Query results ("Result values" in `docs/telemetry.md`). For example, a `UInt64` is a string of its digits, NaN is `"nan"` and a Map is a list of `[key, value]` pairs.

CSV includes a header. A field has quotes in the RFC style only when it needs them: a comma, a quote, a line break, or a blank at either end. An embedded quote is doubled. The dashboard encodes nested ClickHouse values as compact JSON inside the CSV cell. These values are Array, Tuple, Map and other structural values. The dashboard does not flatten them with an ambiguous custom delimiter. A `Nullable` null is a bare `\N`, as in the CSV format of ClickHouse (`format_csv_null_representation`). A text that is exactly `\N` has quotes, so a reader never takes it for a NULL. `Float32` keeps its shortest text: `0.1`, not `0.10000000149011612`.

The backend always runs the panel SQL through `runner_uri`. This includes commands such as `CREATE`, `ALTER`, `INSERT` or `OPTIMIZE`, when the runner has the permission. Statements that return rows stream their rows. A successful command without a result set gets a stable synthetic result member that contains `status=OK`. For this reason, its archive is not ambiguous. The backend uses `system_uri` only afterward, for the lookup of the execution log that it generates.

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

The statements run one after the other. Assume that a statement fails after the backend already streamed output. Then the backend closes the result member of that statement, and this member can contain partial data. After that, the backend appends `execution.csv` and `error.txt`. It does not start the later statements. If the HTTP connection is still usable, the backend still sends the ZIP central directory.

The same rule to stop on an error applies in this case: the SQL succeeds, but the backend cannot collect the required execution metadata after the query in the bounded lookup window. Then `execution.csv` has the status `export_error`. `error.txt` contains the failure of the collector. The backend does not start a later statement. The backend never serializes the errors of the collector as a successful execution.

## Backpressure and disconnects

`DataSink::write` of `cpp-httplib` is synchronous with the HTTP stream. A slow browser therefore slows the producer naturally. One write waits at most `server.write_timeout_ms` (default 120 seconds) for a client that does not read, for example a paused download. Past that time, the export stops. Each export owns a dedicated native ClickHouse connection. The backend never returns this connection to the interactive connection pool.

The ClickHouse query uses `Query::OnDataCancelable`. If the HTTP sink is not writable any more, the callback returns `false`. This causes `clickhouse-cpp` to send a native Cancel packet. The progress callback also checks the sink. A statement can send no row and no progress for a long time (a long DDL, `OPTIMIZE ... FINAL`, a mutation with `mutations_sync`). For this case, a watchdog thread checks the download every second while the statement runs. When the download is closed, the watchdog runs `KILL QUERY ... ASYNC` in the runner context. The export then gives its slot of `export.max_concurrent` back at once.

Each statement carries `log_comment = 'chdash-export'`, and `max_execution_time` and `max_memory_usage` when `export.max_execution_time_s` and `export.max_memory_usage` set them (0, the default, leaves them to the profile of the runner). A statement that sends nothing for `export.receive_timeout_ms` (default 10 minutes, 0 = no limit) fails. The connection uses TCP keepalive, so a peer that is gone is found sooner.

## No resume

The backend does not keep the generated archive. For this reason, an arbitrary HTTP Range resume is not possible. The backend returns `Accept-Ranges: none` on purpose. The user must prepare an interrupted export again. A resumable export needs a separate architecture with object storage. This is outside V1.

## Limits

`export.max_concurrent` bounds the number of concurrent streams. The number of pending handshakes and the total number of retained SQL bytes are also bounded. These bounds are independent of the active export results.
