# Docker test and benchmark console

The `tests/` directory provides one reproducible stack for functional validation and performance measurement. It starts:

- a dedicated ClickHouse server;
- `chdash_source`, compiled from the local source tree in Release mode;
- `chdash_release`, started from the highest versioned archive in `tests/releases/`;
- one Python runner that executes jobs, builds reports, and serves the web console.

## Start the stack

From this directory:

```bash
docker compose up -d --build
```

Services:

```text
Quality console    http://localhost:18082
Source dashboard   http://localhost:18080
Release dashboard  http://localhost:18081
ClickHouse HTTP    http://localhost:18123
ClickHouse TCP     localhost:19000
```

Follow the runner:

```bash
docker compose logs -f tests
```

Remove containers and volumes:

```bash
docker compose down -v --remove-orphans
```

## Web console

The console has independent **Tests** and **Benchmark** tabs.

The Tests tab shows the JUnit summary, harness self-tests, failed cases, source-vs-release native-type diagnosis, expected-vs-actual SQL formatting diffs, incremental pytest logs, run history, and downloadable artifacts.

The Benchmark tab shows source-vs-release latency, deterministic SSE compatibility, expected operational event differences, direct ClickHouse HTTP measurements, incremental logs, and downloadable artifacts.

Each tab has its own run button and ZIP report button. Reports are self-contained and include a compact `report-manifest.json` for automated analysis.

State changes do not recreate result tables. Horizontal and vertical scroll positions remain stable. Logs are read incrementally, artifacts are loaded on demand, and detailed SQL diffs are generated only when a case is opened.

## Automatic execution

API tests run automatically when the runner starts. A failed test does not terminate the web container; the result remains available and jobs can be rerun from the UI.

```bash
# Disable automatic jobs
TEST_RUNNER_AUTO_TESTS=0 docker compose up -d --build

# Run tests and then the benchmark at startup
TEST_RUNNER_AUTO_BENCHMARK=1 docker compose up -d --build
```

## Release selection

Place any number of versioned archives in:

```text
tests/releases/
```

Example:

```text
chdash_2.8.0_linux_amd64.tar.gz
chdash_2.8.1_linux_amd64.tar.gz
chdash_2.8.2_linux_amd64.tar.gz
```

`chdash_release` automatically selects the highest version found in the filename.

## Native-type diagnosis

The source binary is always validated with `AggregateFunction`, `JSON`, wide integers, non-finite floats, and other native edge cases. When a case fails, the runner repeats the same query against the selected release and classifies the outcome as a source regression, a shared product limitation, different product failures, or a harness/transport error.

Detailed results are written to:

```text
tests/artifacts/tests/<run>/query_types_results.json
```

Sensitive tokens are redacted from reports.

## Benchmark paths

Each query runs through three paths:

```text
source       local source build through chdash SSE
release      selected release through chdash SSE
http_direct  ClickHouse HTTP with JSONCompactEachRowWithNamesAndTypes
```

Connections are reused across warmups and measured runs. Direct HTTP reports both:

- **HTTP wire**: time until the final response byte is received;
- **HTTP verified**: wire time plus Python JSON decoding and row hashing.

The benchmark validates row count and hash, column names and types, terminal status, required SSE events, deterministic event counts, normalized core-event order, and direct-HTTP equivalence.

SSE events are classified as:

- deterministic control events: `meta`, `result_meta`, `error`, and `done`;
- operational events: `result_rows` and `tick`;
- optional transport events: `keepalive` and `message`.

Operational counts may differ when batching or telemetry cadence changes. Source/release differences remain visible in the comparison tables but do not create top-level warnings when row order, row hash, result types, and deterministic control events remain equivalent. Set `BENCH_STRICT_EVENT_COUNTS=1` only when exact operational counts are intentionally part of the compatibility contract.

The source and release may emit different operational event counts because their result batch sizes and telemetry cadence differ. Those differences remain visible without being promoted to failures when the returned data and deterministic control events are equivalent.

Common settings:

```bash
BENCH_RUNS=10 BENCH_WARMUP=2 docker compose up -d --build
BENCH_DISABLE_DIRECT_HTTP=1 docker compose up -d --build
BENCH_STRICT_EVENT_COUNTS=1 docker compose up -d --build
```

## Remote active instance

Add a real host block to `tests/config/CH_HOSTS.hcl`, then expose the matching HTTP endpoint to the direct benchmark:

```hcl
host {
  name       = "active"
  runner_uri = "clickhouse://user:password@clickhouse-active.example.com:9000"
  system_uri = "clickhouse://user:password@clickhouse-active.example.com:9000"
}
```

```bash
BENCH_HOST_IDS="local,active" \
BENCH_CLICKHOUSE_HTTP_TARGETS="local=http://clickhouse:8123,active=https://user:password@clickhouse-active.example.com:8443" \
CH_HOSTS_SOURCE_CONFIG=./config/CH_HOSTS.hcl \
docker compose up -d --build
```

## Artifacts and ZIP reports

Runs are stored under:

```text
tests/artifacts/tests/<run>/
tests/artifacts/benchmark/<run>/
```

A ZIP report is built on first download and cached until the run changes. It contains original artifacts such as JUnit XML, SQL diffs, query-type traces, benchmark CSV/JSON/Markdown files, JSONL measurements, compressed SSE traces, and logs.

## Runner overhead controls

```bash
TEST_RUNNER_LOG_INITIAL_BYTES=131072
TEST_RUNNER_LOG_CHUNK_BYTES=65536
TEST_RUNNER_MAX_RUNS=30
TEST_RUNNER_MAX_HISTORY=30
TEST_RUNNER_FORMAT_PAGE_SIZE=20
TEST_RUNNER_FORMAT_MAX_DIFF_ROWS=1800
TEST_RUNNER_JSON_GZIP_MIN_BYTES=4096
TEST_RUNNER_JSON_GZIP_LEVEL=3
TEST_RUNNER_REPORT_COMPRESSION_LEVEL=3
TEST_RUNNER_SSE_HEARTBEAT_SECONDS=15
TEST_RUNNER_QUIET_ACCESS_LOGS=1
FORMAT_RESULTS_FLUSH_EVERY=20
BENCH_TRACE_COMPRESSION_LEVEL=3
```

Health checks use `/api/health` and do not parse reports or scan artifact trees. Completed benchmark measurements are appended to `runs.partial.jsonl` and atomically promoted to `runs.jsonl`; the partial file remains only after a real interruption.

## Repository contract checks

The test runner mounts the repository at `/repo` in read-only mode. Static harness tests inspect the exact source tree, release workflow, formatting fixtures, and frontend resources that are used to build the source container.

The source container uses `config/CH_HOSTS.source.hcl` by default. Its
`meta-partial` host intentionally combines a working `runner_uri` with invalid
`system_uri` credentials. This verifies that query health and visible
database/table catalogs remain available while server-wide metadata is
reported as a partial response rather than an HTTP 503. The release and
benchmark containers continue to use `config/CH_HOSTS.hcl` and only benchmark
the normal `local` host.


## Native TCP pool diagnostics

The source container expires idle native clients before ClickHouse reaches its server-side socket timeout. The default settings are:

```bash
CH_CLIENT_POOL_MAX_IDLE=8
CH_CLIENT_POOL_IDLE_TTL_MS=60000
CH_CLIENT_POOL_VALIDATE_AFTER_IDLE_MS=15000
CH_CLIENT_POOL_REAPER_INTERVAL_MS=5000
```

Set `CH_CLIENT_POOL_MAX_IDLE=0` for a no-pooling diagnostic run. This removes idle sockets completely at the cost of a new native connection for every operation.

The health runner pings `runner_uri`, because this is the account and endpoint
that determine whether user queries can run. `system_uri` is opened only for
server-wide diagnostics and metadata. An unavailable admin account can make
those individual catalogs partial, but it does not make the query host itself
unhealthy.

Compatibility fallbacks use a distinct native query id per attempt. The public
browser id stays unchanged, cancellation targets every attempt, and the failed
native attempt is stopped synchronously before retrying. This specifically
guards against `QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING` during driver fallback.
