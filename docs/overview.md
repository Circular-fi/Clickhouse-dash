# Overview

ClickHouse Dash is a web console for ClickHouse. One self-contained binary serves the pages, the HTTP API and an optional MCP server. This page gives the stack, the path of a query and the list of the features. Each item links to the page that tells more.

## Stack

- Backend: C++17 with clickhouse-cpp, cpp-httplib and RapidJSON.
- Frontend: plain JavaScript and Canvas. The default build embeds the files of the frontend into the binary.
- Query transport: ClickHouse native TCP.
- Browser transport: Server-Sent Events (SSE).
- WebAssembly kernels do the heavy work of the frontend. They are the SQL highlighter and scanner, the Explorer graph router and the layered layout. They also sort the results and prepare the charts. Each kernel has a JavaScript fallback ([wasm.md](wasm.md)).

## The path of a query

```text
Browser
  POST /api/query/run
  GET  /api/query/stream?query_id=...  (SSE)
  POST /api/query/cancel
       |
       v
cpp-httplib server
       |
       v
ClickHouse native TCP via clickhouse-cpp
```

1. The browser starts a run with `POST /api/query/run`. The answer gives the stream URL and the cancel token.
2. The browser opens the SSE stream. The query starts only then, so a client that does not open the stream runs nothing.
3. The backend runs the SQL with the account of `runner_uri`. The browser reads the result batches and the telemetry from the stream ([telemetry.md](telemetry.md)).
4. To stop the run, the browser sends `POST /api/query/cancel` with the token. The backend sends `KILL QUERY` with the account of `system_uri` ([configuration.md](configuration.md#authorization-model)).

[http-api.md](http-api.md) lists all the routes.

## Features

### Query

- Run ClickHouse SQL. The results come in batches, as a stream.
- Right-click a result row, then select **Details** to expand that row in place. This works in the Query results, in the panels of a multiquery run and in the data preview of the Explorer. The results must have two rows at least.
- The detail row opens directly below the row. It shows the name, the type and the full, pretty-printed value of each column, as a result with one row does. The detail row has the width of the visible table. It also works with virtualized results.
- These actions close the detail row: a click elsewhere, Escape, the close button and a new query. Shift+right-click keeps the context menu of the browser.
- The explicit mode `Run with profiling` enables the processor logs and the query-view logs for that one run only. A normal Run keeps the light path ([query-analysis.md](query-analysis.md)).
- The action `Analyze` reads the execution logs that ClickHouse keeps, on request. It finds them by the `query_id` of the panel. It does not run the query again.
- The live counters are the original compact set ([telemetry.md](telemetry.md)). They are the elapsed time, the read progress, the read rates, the CPU use, and the current and peak memory.
- The native profile events of the ClickHouse query group give the CPU and the memory. The page shows no thread count, because ClickHouse gives no exact count while a query runs.
- The JSON of the results is safe for the native types and for floating-point values that are not finite ([telemetry.md](telemetry.md#result-values)).
- The page has several hosts, health checks and the cancel of a query. It also has the SQL formatter ([formatter.md](formatter.md)), the history and the saved queries ([query-library.md](query-library.md)).
- The editor has syntax colors, autocomplete, and warnings on the names of tables, functions and columns in the SQL.
- The editor reads the columns of one table only when it needs them. This keeps the heap of an idle page small.

### System

The System page (`/system`) shows the health of the selected server. It has these parts:

- An Overview. It has the server tiles, a treemap of the databases, the topology, Keeper and the replication. It also has ten performance charts from the system logs, and the queues of merges, mutations, replication and Distributed.
- The top query shapes of `system.query_log`.
- The disks, with their growth and the time until they are full.

The page uses fixed, read-only and bounded reads of system tables. The `system` block configures it ([system.md](system.md)).

### Other pages

- The Explorer shows the tables that the runner can read ([explorer.md](explorer.md)). It has the catalog, the detail of a table, a preview of its data, the functions and a graph of the topology.
- The Observability pages show OpenTelemetry traces, logs and metrics from the tables of the ClickHouse exporter ([traces.md](traces.md), [logs.md](logs.md), [metrics.md](metrics.md)).

### MCP

A built-in MCP server (`POST /mcp`) is optional. AI clients read ClickHouse data with access keys. Each key has its own hosts, tools and data. MCP has its own ClickHouse user, and each read query runs with `readonly=1` and has caps on rows, bytes and time. The **MCP integration** page (`/mcp-integration`) manages the keys ([mcp.md](mcp.md), [mcp-integration-page.md](mcp-integration-page.md)).

### Runtime

- Bounded caches keep the results, the history, the metadata, the SSE events and the sessions ([configuration.md](configuration.md#caches-and-privileges)).
- The pages can download the rows that they received. An API streams complete CSV or JSON exports from ClickHouse into a ZIP64 archive, with bounded memory ([post-run-download.md](post-run-download.md), [massive-export.md](massive-export.md)).
- One self-contained binary holds the frontend files. The Linux release archives hold a static binary ([SECURITY.md](../SECURITY.md#verify-a-release) tells how to check an archive).
- The tests and the performance cases run in Docker, in one container. The phases are backend, frontend, timing, embedded build, performance and design ([tests/README.md](../tests/README.md)).
