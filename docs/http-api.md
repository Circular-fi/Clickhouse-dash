# HTTP API

This page lists the HTTP routes of ClickHouse Dash. The pages use them, and other clients can use them too. Each part names the page that tells more.

In the mode `authzen`, each route needs the identity token and the action of the route. The table of the actions is in [access.md](access.md#actions). Every error has the one JSON shape of [operations.md](operations.md#errors).

## Probes and metrics

| Route | What it gives |
| --- | --- |
| `GET /livez` | Liveness: the process answers. |
| `GET /readyz` | Readiness: a host answers, and the server does not stop. |
| `GET /healthz` | Strict health: every host answers. |
| `GET /metrics` | The Prometheus text format. In the mode `authzen`, it needs the identity token ([access.md](access.md#routes-with-no-action)). |

[operations.md](operations.md) tells about the probes, the stop on SIGTERM, the JSON log and the metrics. It also tells about the HTTP security: the headers and the guard of the writes.

## Hosts and metadata

- `GET /api/meta?host_id=<id>`: the build metadata, and optional autocomplete catalogs of the host.
  - A request without `host_id` gets `400 missing_host_id`. The other routes of the pages do the same.
  - The parameter `types` lists the catalogs, for example `types=keywords,functions`.
  - The catalogs of the whole server use `system_uri`. They are `keywords`, `functions`, `table_functions`, `formats`, `settings` and `data_types`.
  - The catalogs that depend on the visibility of the runner use `runner_uri`. They are `databases`, `tables` and `columns`.
  - With `database` and `table`, the catalog `columns` holds the columns of that one table. The editor asks for the columns of a table only when it needs them.
  - A request for the two kinds of catalog gets HTTP 200 with `partial=true` when one requested catalog at least succeeds.
  - The keywords have a fixed built-in fallback. It applies to old system accounts, and to system accounts that ClickHouse Dash cannot reach for a time.
- `GET /api/hosts`: a snapshot of the health of the hosts.
- `GET /api/hosts/stream`: the health of the hosts as an SSE stream.

## SQL format

`POST /api/format` formats SQL text. [formatter.md](formatter.md) tells how the formatter works.

- To format a batch, send `{"host_id", "sqls": [...]}`. The answer is `{"results": [...]}`. It has one entry for each statement, in order:
  - `{"index", "status": "formatted", "formatted_sql"}`. A `warning` appears when the new text can change what ClickHouse reads from the statement. The text then stays as it was written.
  - `{"index", "status": "error" | "skipped", "error": {...}}`.
- A statement that fails does not fail the others. A statement is `skipped` when it starts more than 10 seconds after the start of the batch. A statement is also `skipped` when the caller disconnects.
- The batch holds a ClickHouse connection only while a statement needs it.
- To format one statement, send `{"host_id", "sql"}`. The answer is `{"formatted_sql"}`, with the same `warning`. Otherwise, the answer is an HTTP error.
- The error from ClickHouse gives the location (`position`, `line`, `col`) in the text that the caller sent.
- The backend opens a new connection in place of a stale pooled native connection, and it tries one more time. A healthy connection gets no extra round trip.
- For one statement, a transport failure that stays gives HTTP 502 with `error_code=clickhouse_transport_error`. A timeout gives HTTP 504 `format_timeout`. A host that is down gives HTTP 503 `format_unavailable`. An error of the SQL gives HTTP 422.
- In a batch, the same codes appear in the `error` of the statement.

## Queries

- `POST /api/query/run`: start a query. The answer gives the stream URL and the cancel token.
  - `mode=normal` is the default.
  - `mode=profiling` applies the profile settings only to that native Query object. It needs no application authentication.
  - Each run has a bounded record in the query registry, for its host.
  - A retry for compatibility keeps the public id. Each native ClickHouse attempt has its own id.
  - The backend stops a failed native attempt before it tries again. Thus ClickHouse never sees two attempts that run with the same id.
- `GET /api/query/stream?query_id=...`: the results and the telemetry of the query, as an SSE stream ([telemetry.md](telemetry.md)).
- `POST /api/query/cancel`: cancel a query with its signed token ([configuration.md](configuration.md#authorization-model)).
- `POST /api/query/analysis`: examine a completed query of the registry. The backend reads `system.query_log`, the optional processor profiles, the query-view logs and the distributed child records that it can see locally. It does not run the query again.
- `GET /api/query/execution?host_id=...&query_id=...`: the light record of a registered run. The downloads after a run use it ([post-run-download.md](post-run-download.md)).
- `POST /api/query/deep-analysis`: start a job. The job runs the stored original SQL of the SELECT family again, with ClickHouse 26.7 `EXPLAIN ANALYZE`. The answer has the code `202`.
  - To read the state of the job, send `GET /api/query/deep-analysis?host_id=&job_id=`.
  - To stop the job, send `POST /api/query/deep-analysis/cancel`.
  - The backend refuses a statement that changes data before it runs it. [query-analysis.md](query-analysis.md#deep-analyze-backend) describes the job.

[query-analysis.md](query-analysis.md) describes the profile runs, the analysis on request and Deep Analyze.

## Explorer

- `GET /api/explorer/catalog?host_id=...`: the catalog of the Explorer List, filtered by the ACL. A manual `refresh=1` clears the metadata caches and the authorization caches.
- `GET /api/explorer/table?host_id=...&database=...&table=...`: the detail of a table. It shows these items where the backend can find them:
  - the columns and the compression weight
  - the storage policy and the local storage
  - the parts and the partitions
  - the ingestion
  - the replication
  - the Distributed queue and the topology
  - the dependencies
  - the indexes and the projections
  - the merges and the mutations
  - the DDL
- `POST /api/explorer/table/data`: a preview of 500 rows at most. It uses only the columns that the runner can read. It never sends an implicit `count()`.
- `GET /api/explorer/functions?host_id=...`: the function browser, with the scope of the runner. It reads the ClickHouse 26.7 table `system.documentation` first. When the documentation of the version is not available, it uses the metadata of the server functions and gives no error.
- `GET /api/explorer/graph?host_id=...`: the logical and physical topology, normalized and filtered by the ACL. The optional `database=...` limits the scope of the serialization.
- `GET /api/explorer/activity?host_id=...`: a live activity overlay for the graph, with a short life. It does not build the topology metadata again.

[explorer.md](explorer.md) describes the List and the Graph, the security filter, the semantics of the edges and the scope of the metrics.

## System

- `GET /api/system/overview?host_id=...`: the Overview of the System page. It has the server tiles, the `system.clusters` topology and the replication summary of the tables that the runner can see. It uses fixed, read-only and bounded reads of system tables.
- `/api/system/series`, `/api/system/disks`, `/api/system/queries`, `/api/system/activity` and `/api/system/keeper` serve the rest of the page. The `system` block configures them.
- `GET /api/system/queries/<hash>` gives the `normalized` text of a query shape. It also gives the same text after the formatter, in `normalized_formatted`. This member is `null` when the formatter cannot do it ([system.md](system.md#the-formatted-text-of-a-shape)).
- The routes `/api/explorer/ops/activity` and `/api/explorer/ops/keeper` of v2.14.0 stay as aliases.

[system.md](system.md) describes the System page.

## MCP

- `POST /mcp`: the MCP endpoint, only when `mcp.enabled` is true. In the mode `keys` (the default of `mcp.auth_mode`), it needs `Authorization: Bearer <key>`. In the mode `identity`, it needs the identity token.
- `/api/mcp/meta` and `/api/mcp/keys` serve the MCP page.

[mcp.md](mcp.md) describes the MCP server, its keys, its tools and the grants of its ClickHouse user. [mcp-integration-page.md](mcp-integration-page.md) describes the MCP page.

## Exports

- `POST /api/export/run`: prepare a direct download, and get a one-time export token with a short life.
- `POST /api/export/stream` with `{"token": ...}` in the JSON body: stream a ZIP64 archive directly from ClickHouse, with bounded memory.
  - No temporary file has the size of the result.
  - The token is never in an address. A `GET` on this route starts nothing (`405`).

[massive-export.md](massive-export.md) describes the direct ZIP64 stream exports. [post-run-download.md](post-run-download.md) describes the archives that the browser makes after a run.
