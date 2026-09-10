# Massive streamed exports

`Run -> Download CSV` and `Run -> Download JSON` are intentionally different
from the post-Run browser ZIP described in `post-run-download.md`.

The direct-download path does not populate the result table and does not retain
the complete result in browser memory, backend memory, or a backend temporary
file.

## Handshake and download capability

The browser prepares the export with:

```http
POST api/export/run
```

with `host_id`, `format`, and the ordered SQL statements. The backend validates the host and stores only a bounded, short-lived pending export description.
It returns a signed capability URL:

```text
api/export/stream?token=...
```

The short token is tied to the export and host. It expires quickly and the pending export is atomically consumed on the first accepted stream. It is an internal one-time capability, not a user-authentication token.

Execution metadata is a **required** part of this export contract. Before the
handshake is accepted, the backend validates that the runner authorization
boundary can be discovered and that the system context used for `execution.csv`
is reachable. When log flushing is enabled it also executes the same
`SYSTEM FLUSH LOGS query_log` operation used by the collector. A failure is
returned by `POST api/export/run` as an explicit JSON error; no download is
started. The one-time stream repeats this preflight before attachment headers
are committed, protecting against grants/connectivity changing between the two
requests.

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

The ZIP writer is forward-only. It uses ZIP64 local/central records and a data
descriptor, so it never seeks and supports entries beyond 4 GiB. V1 deliberately
uses `STORE` (no ZIP compression) to keep CPU usage and memory predictable.

`output_buffer_bytes` bounds the serializer staging buffer. Apart from a current
ClickHouse block, this buffer, the small ZIP metadata directory, and socket
buffers, memory does not grow with the exported row count.

The JSON result file uses **JSONEachRow semantics**: every row is one complete
JSON object followed by a newline. The archive member is named `results.json`
for the UI contract, but consumers must not expect one giant JSON array.

CSV includes a header. Cells are RFC-style quoted with embedded quotes doubled.
Nested ClickHouse values (Array/Tuple/Map and other structural values) are
encoded as compact JSON inside the CSV cell rather than flattened with an
ambiguous custom delimiter. `Nullable` null is written as `\\N` in CSV.

Panel SQL is always executed through `runner_uri`, including commands such as `CREATE`, `ALTER`, `INSERT`, or `OPTIMIZE` when that runner has permission. Row-returning statements stream their rows. A successful command without a result set gets a stable synthetic result member containing `status=OK`, so its archive is not ambiguous. `system_uri` is used only afterward for backend-generated execution-log lookup.

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

Statements execute sequentially. If one fails after output has already been
streamed, its result member is closed (and may therefore contain partial data),
then `execution.csv` and `error.txt` are appended. Later statements are not
started. The ZIP central directory is still emitted when the HTTP connection
remains usable.

The same stop-on-error rule applies if the SQL itself succeeds but the required
post-query execution metadata cannot be collected within the bounded lookup
window. In that case `execution.csv` uses status `export_error`, `error.txt`
contains the collector failure, and no later statement is started. Collector
errors are never serialized as a successful execution.

## Backpressure and disconnects

`cpp-httplib`'s `DataSink::write` is synchronous with the HTTP stream, so a slow
browser naturally slows the producer. Each export owns a dedicated native
ClickHouse connection; it is never returned to the interactive connection pool.

The ClickHouse query uses `Query::OnDataCancelable`. If the HTTP sink stops being
writable, the callback returns `false`, which causes `clickhouse-cpp` to send a
native Cancel packet. A runner-context `KILL QUERY ... ASYNC` is also attempted
best-effort for disconnect paths where the socket failure is observed outside a
data callback.

## No resume

The backend does not persist the generated archive, so arbitrary HTTP Range
resume is not possible. `Accept-Ranges: none` is returned intentionally. An
interrupted export must be prepared again. Resumable exports would require a
separate object-storage architecture and are outside V1.

## Limits

`export.max_concurrent` bounds concurrent streams. Pending handshakes are also
bounded by count and total retained SQL bytes, independently from active export
results.
