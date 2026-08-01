# clickhouse-dash

A lightweight real-time ClickHouse query dashboard.

[![CI](https://github.com/Circular-fi/Clickhouse-dash/actions/workflows/ci.yml/badge.svg)](https://github.com/Circular-fi/Clickhouse-dash/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Circular-fi/Clickhouse-dash/actions/workflows/codeql.yml/badge.svg)](https://github.com/Circular-fi/Clickhouse-dash/actions/workflows/codeql.yml)
[![Release](https://github.com/Circular-fi/Clickhouse-dash/actions/workflows/release.yaml/badge.svg)](https://github.com/Circular-fi/Clickhouse-dash/actions/workflows/release.yaml)

- Backend: **C++17** using clickhouse-cpp, cpp-httplib, and RapidJSON
- Frontend: **vanilla JavaScript and Canvas**
- Query transport: **ClickHouse native TCP**
- Browser transport: **Server-Sent Events**

## Features

- Execute ClickHouse SQL with streamed result batches.
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

## Quick start with tests and benchmarks

```bash
cd tests
docker compose up -d --build
```

The stack starts its own ClickHouse server, the local source build, the highest release archive in `tests/releases/`, and one Python quality console.

```text
Source dashboard   http://localhost:18080
Release dashboard  http://localhost:18081
Quality console    http://localhost:18082
```

The quality console keeps result-table scroll positions stable, loads logs and artifacts incrementally, shows expected-vs-actual SQL formatting diffs, separates benchmark warnings from blocking errors, and exports self-contained ZIP reports.

## Local build

Requirements: CMake 3.20 or newer, a C++17 compiler, and Ninja.

```bash
cmake -S src -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --target chdash
./build/chdash
```

The default build embeds frontend assets into the binary.

## Configuration

The preferred mode is a complete HCL file:

```bash
chdash --config /etc/clickhouse-dash/config.hcl
chdash --config /etc/clickhouse-dash/config.hcl --health
```

When `--config` is present, the application ignores all configuration
environment variables. Every legacy environment option has an HCL equivalent.
See [`config.example.hcl`](config.example.hcl) for the complete schema and
[`docs/configuration.md`](docs/configuration.md) for the exhaustive mapping and
the code-verified effect of every option.

Without `--config`, the legacy environment mode remains supported and
`CH_HOSTS` remains required.

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
- `POST /api/query/run` start a query and obtain its stream URL and cancel token. Compatibility retries keep the public id stable while using unique native ClickHouse attempt ids, synchronously stopping a failed native attempt before retrying so ClickHouse never sees two running attempts with the same id.
- `GET /api/query/stream?query_id=...` query results and telemetry SSE stream.
- `POST /api/query/cancel` cancel a query with its signed token.

## Development and support

- Development workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security reporting: [`SECURITY.md`](SECURITY.md)
- Support: [`SUPPORT.md`](SUPPORT.md)
- License: MIT, see [`LICENSE`](LICENSE)
