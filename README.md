# clickhouse-dash

A lightweight real-time ClickHouse query dashboard.


- Backend: **C++17** using clickhouse-cpp, cpp-httplib, and RapidJSON
- Frontend: **vanilla JavaScript and Canvas**
- Query transport: **ClickHouse native TCP**
- Browser transport: **Server-Sent Events**

## Features

- Execute ClickHouse SQL with streamed result batches.
- Explicit **Run with profiling** mode enables processor/query-view logging only for that execution; normal Run keeps the existing lightweight path.
- On-demand **Analyze** reads persisted ClickHouse execution logs by panel-scoped `query_id` without replaying the query.
- Original compact telemetry: elapsed time, read progress, read rates, CPU usage, and current/peak query memory.
- CPU and memory are sourced from ClickHouse query-group native profile events; inferred thread counts are not exposed.
- Safe JSON serialization for native types and non-finite floating-point values.
- Multi-host configuration, health checks, query cancellation, SQL formatting, history, saved queries, syntax highlighting, autocomplete, and reference diagnostics.
- Lazy table-scoped column metadata to keep the idle browser heap small.
- Bounded result, history, metadata, SSE, and session caches.
- One self-contained binary with embedded frontend assets.
- Reproducible source-vs-release tests and benchmarks with a direct ClickHouse HTTP floor.

## Architecture

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

## Telemetry

Telemetry uses the original compact positional tick contract for compatibility. The thread metric is removed because ClickHouse does not provide a deterministic live active-thread count for a query. Read progress, rows, bytes, CPU, and memory remain available.

Deterministic SSE control events are compared strictly. `result_rows` and `tick` counts are operational and may change with result batching, query duration, or scheduling without changing query semantics.

See [`docs/telemetry.md`](docs/telemetry.md) for the complete event contract, field definitions, and compatibility policy.

## Quick start with Docker tests and benchmarks

The host only needs Docker Compose. Python, Node.js and Playwright are contained in the test images.

Local development stack (current ClickHouse + freshly built source dashboard):

```bash
cd tests
docker compose up -d
```

Full automated analysis:

```bash
docker compose --profile test up -d --build
```

The default stack rebuilds and starts the source dashboard on port 18080 against the current ClickHouse. The `test` profile adds exactly one one-shot test container. That container runs four explicit categories — backend functional, frontend functional, performance and design — creates one archive, then exits:

```text
tests/artifacts/chdash-test-review.zip
```

No Python, Node.js, Playwright browser, test web UI, release comparator or historical ClickHouse service is required on the host.

## Local build

Requirements: CMake 3.20 or newer, a C++17 compiler, and Ninja.

```bash
cmake -S src -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --target chdash
./build/chdash --config /path/to/config.hcl
```

The default build embeds frontend assets into the binary.

## Trace Explorer ClickHouse indexes

For large OpenTelemetry trace tables on ClickHouse 26.1+, keep the standard OTel table definitions and add the two lightweight projection indexes used by Trace Explorer:

```sql
ALTER TABLE otel.otel_traces
    ADD PROJECTION IF NOT EXISTS prj_traceid INDEX TraceId TYPE basic;

ALTER TABLE otel.otel_traces_trace_id_ts
    ADD PROJECTION IF NOT EXISTS prj_start INDEX Start TYPE basic;
```

If those tables already contain historical data, materialize the projections once:

```sql
ALTER TABLE otel.otel_traces
    MATERIALIZE PROJECTION prj_traceid;

ALTER TABLE otel.otel_traces_trace_id_ts
    MATERIALIZE PROJECTION prj_start;
```

The materialization is asynchronous by default; use `SETTINGS mutations_sync=1` when you need the command to wait. For very large historical tables, materialize partition-by-partition. See [`docs/traces.md`](docs/traces.md) for the Trace Explorer schema, access-control, search-path, and projection details.

## Massive downloads

The Run menu can stream complete CSV or JSON exports directly from ClickHouse
into a ZIP64 download. The backend does not spool result datasets to disk or
retain them in RAM; exports are bounded by a per-block serializer buffer and
use short-lived one-time download capabilities. See
[`docs/massive-export.md`](docs/massive-export.md).

## Configuration

The preferred mode is a complete HCL file:

```bash
chdash --config /etc/clickhouse-dash/config.hcl
chdash --config /etc/clickhouse-dash/config.hcl --health
```

Application configuration is HCL-only: `--config` is required for server and
health modes, and application environment variables are not read. See
[`config.example.hcl`](config.example.hcl) for the complete schema and
[`docs/configuration.md`](docs/configuration.md) for the source-grounded
configuration behavior.

ChDash does **not** implement end-user authentication or per-user RBAC. Everyone who can reach the panel uses the same ClickHouse authorization context for a configured host: `runner_uri`. The backend keeps a bounded query registry by public `query_id` and host so Analyze/Execution/Deep Analyze can find completed runs after their SSE session is reaped. Internal signed capabilities are used only for actions such as cancellation and one-time export downloads; they are not user identities.

The critical privilege boundary is connection role: SQL supplied by the panel is executed with `runner_uri` only. `system_uri` is reserved for backend-generated technical queries such as system-log/metadata reads and `KILL QUERY`; user SQL is never replayed or executed through it.

`runner_uri` defines query visibility and is used for the host health check,
database/table/column autocomplete, formatting, and user queries. `system_uri`
is used for server-wide catalogs, diagnostics, final statistics, and query
cancellation. A system-account failure therefore does not mark an otherwise
queryable host as down.

## HTTP API

- `GET /healthz` strict process health.
- `GET /api/meta` build metadata and optional scoped autocomplete catalogs.
  Server-wide catalogs (`keywords`, `functions`, `table_functions`, `formats`,
  `settings`, and `data_types`) use `system_uri`; visibility-sensitive catalogs
  (`databases`, `tables`, and `columns`) use `runner_uri`. Mixed requests return
  HTTP 200 with `partial=true` when at least one requested catalog succeeds.
  Keywords have a deterministic built-in fallback for old or temporarily
  unreachable system accounts.
- `GET /api/hosts` host health snapshot.
- `GET /api/hosts/stream` host health SSE stream.
- `POST /api/format` SQL formatting batch. Stale pooled native connections are reconnected and retried once without adding a healthy-path round trip. Persistent transport failures return HTTP 502 with `error_code=clickhouse_transport_error`; SQL formatting errors return HTTP 422.
- `POST /api/query/run` start a query and obtain its stream URL and cancel token. `mode=normal` is the default; `mode=profiling` applies profiling settings only to that native Query object and requires no application authentication. Every run is associated with a bounded host-scoped query-registry record. Compatibility retries keep the public id stable while using unique native ClickHouse attempt ids, synchronously stopping a failed native attempt before retrying so ClickHouse never sees two running attempts with the same id.
- `GET /api/query/stream?query_id=...` query results and telemetry SSE stream.
- `POST /api/query/cancel` cancel a query with its signed token.
- `POST /api/query/analysis` inspect a registered, completed query from `system.query_log`, optional processor profiles, query-view logs, and locally visible distributed child records. No replay is performed.
- `GET /api/query/execution?host_id=...&query_id=...` retrieve the lightweight registered execution record used by post-run downloads.
- `POST /api/query/deep-analysis` explicitly re-run the stored original SELECT-family SQL with ClickHouse 26.7 `EXPLAIN ANALYZE`; mutating statements are refused before execution.
- `GET /api/explorer/catalog?host_id=...` ACL-filtered Explorer List catalog. A
  manual `refresh=1` invalidates both metadata and authorization caches.
- `GET /api/explorer/table?host_id=...&database=...&table=...` table detail
  (columns and compression weight, storage policy/local storage, parts/partitions,
  ingestion, replication, Distributed queue/topology where resolvable,
  dependencies, indexes/projections, merges/mutations, DDL).
- `POST /api/explorer/table/data` preview up to 500 rows using only runner-readable
  columns. It never issues an implicit `count()`.
- `GET /api/explorer/functions?host_id=...` runner-scoped function browser. It
  prefers ClickHouse 26.7 `system.documentation` and falls back cleanly to
  server function metadata when version-matched documentation is unavailable.
- `GET /api/explorer/graph?host_id=...` ACL-filtered normalized logical/physical
  topology. Optional `database=...` limits the serialized scope.
- `GET /api/explorer/activity?host_id=...` short-lived live activity overlay for
  the graph; it does not rebuild topology metadata.
- `POST /api/export/run` prepare a direct-download request and issue a short-lived one-time export token.
- `GET /api/export/stream?token=...` stream a ZIP64 archive directly from ClickHouse with bounded memory and no result-sized temporary file.

Explorer List/Graph behavior, security filtering, edge semantics, and metric
scope are documented in [`docs/explorer.md`](docs/explorer.md). Query profiling,
on-demand analysis, and Deep Analyze are documented in [`docs/query-analysis.md`](docs/query-analysis.md).
Post-run browser archives are documented in [`docs/post-run-download.md`](docs/post-run-download.md),
and direct ZIP64 streaming exports in [`docs/massive-export.md`](docs/massive-export.md).

## Development and support

- Development workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security reporting: [`SECURITY.md`](SECURITY.md)
- Support: [`SUPPORT.md`](SUPPORT.md)
- License: MIT, see [`LICENSE`](LICENSE)


### Runner/system cancellation boundary

`runner_uri` executes panel SQL; `system_uri` is reserved for ChDash-generated system metadata and cancellation operations. Direct `KILL QUERY` statements submitted through the panel are rejected so a shared runner identity cannot bypass cancel capabilities by cancelling another panel query as its own ClickHouse user.

## Frontend functional + design review

Playwright frontend review is included automatically in the Docker `test` profile. It exercises Query, results, cancel/error states, Analyze, Explorer and light/dark rendering at several desktop widths, then contributes screenshots, traces, runtime errors, layout/style heuristics and accessibility findings to the combined archive.

```bash
cd tests
docker compose --profile test up -d --build
```

Combined review artifact:

```text
tests/artifacts/chdash-test-review.zip
```

The single one-shot `tests` container runs backend-functional, frontend-functional, performance and design phases and produces the combined archive. No Python or Node.js is required on the host. Visual baselines remain opt-in until the current design has been reviewed and accepted. See `tests/README.md`.
