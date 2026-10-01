# ChDash Docker tests

The test workflow is fully containerized. The host needs only Docker + Docker Compose: no Python, Node.js, Playwright or browser installation is required.

## Local development

From `tests/`:

```bash
docker compose up -d --build
```

This starts only the normal development stack:

- ClickHouse `26.7.5.10`;
- ClickHouse init SQL that creates the OTEL tables and trace projection indexes;
- a fresh Release build of the current ChDash working tree at `http://localhost:18080`.
- a second ClickHouse replica (`clickhouse_replica`) joined to the primary through the ClickHouse Keeper embedded in `clickhouse` (cluster `chdash_cluster`, config in `tests/clickhouse-config/`). The fixture `tests/clickhouse-init/04-replicated-fixtures.sql` (re-applied by every test run) creates `chdash_repl` with ReplicatedMergeTree / ReplicatedSummingMergeTree tables, a materialized view and a Distributed table, so replica counts, queues and the graph's `nR` badges are exercised locally.

The heavy `otel_fixture` service is intentionally behind the Compose `otel` profile, so a normal rebuild does **not** start or wait for it. Start it explicitly with `docker compose --profile otel up -d --build otel_fixture`. The `test` profile also enables it automatically because the full test suite expects seeded trace data.

The OTEL schema is initialized by `tests/clickhouse-init/03-otel-traces.sql` as part of ClickHouse startup. The local `otel.otel_traces` base table intentionally mirrors the production exporter table: the same codecs, native bloom/minmax skipping indexes, `PARTITION BY toDate(Timestamp)`, and `ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))`. The only additions are the ClickHouse 26.1+ lightweight secondary projection indexes validated by the large local benchmark: `prj_traceid` on `otel_traces` and `prj_start` on the trace-id time index. `prj_timestamp` is intentionally not added: on the production-shaped benchmark it consumed substantial disk for negligible timestamp-scan improvement.

`prj_traceid` accelerates exact/`IN` TraceId pruning without changing the production sort key, and `prj_start` adds time-oriented pruning on `otel_traces_trace_id_ts` while its base `(TraceId, Start)` ordering remains available for direct trace lookup. On a persistent test volume created before these projections existed, the fixture detects missing definitions and materializes them once for existing rows. If the base local table was created by an older ChDash fixture with a different `ORDER BY`, recreate the local ClickHouse volume once (`docker compose down -v`) so the production-compatible base schema is applied; `CREATE TABLE IF NOT EXISTS` deliberately does not rewrite existing MergeTree data.

When the `otel` profile is enabled, no host-side Python or manual `clickhouse-client` import is required. The fixture generates 10,000 domain-neutral traces by default. Small fixtures may use the Python generator for event/link UI coverage; large fixtures use one SQL implementation only: production-shaped **optimized-rich** rows generated directly by `INSERT ... SELECT FROM numbers_mt()`. The SQL path writes `otel_traces_trace_id_ts` directly from the same deterministic trace sequence, avoiding Python row generation, JSON upload, `ARRAY JOIN`, per-span hashes, and a final `GROUP BY TraceId`.

The fixture remains healthy after the initial seed and reuses an existing completed OTEL dataset on later runs, so rebuilding ChDash does not reseed the traces. Presence checks use `system.parts` metadata rather than `uniqExact(TraceId)`, so even a fixture containing hundreds of millions of spans does not get scanned on every compose rebuild. Set `OTEL_FIXTURE_FORCE=1` when you explicitly want a fresh fixture. ClickHouse data is stored in the named `clickhouse_data` volume, so an eventual container recreation does not discard the seeded data.

The fixture size can be overridden through `OTEL_FIXTURE_TRACES`, `OTEL_FIXTURE_MIN_SPANS`, `OTEL_FIXTURE_MAX_SPANS`, `OTEL_FIXTURE_SEED`, `OTEL_FIXTURE_ERROR_RATE`, `OTEL_FIXTURE_BATCH_TRACES`, and `OTEL_FIXTURE_SPREAD_MINUTES`; defaults are listed in `.env.example`. A partially completed **parallel** SQL fixture is deliberately not resumed from `count(rows)`: the workers own disjoint TraceId ranges, so a row count is not a safe contiguous cursor and could otherwise create duplicate/missing TraceIds. Rebuild an interrupted parallel fixture with `OTEL_FIXTURE_FORCE=1`; single-process loads can still grow contiguously. Massive-mode controls are `OTEL_FIXTURE_GENERATOR=auto|python|sql`, `OTEL_FIXTURE_SQL_THRESHOLD`, `OTEL_FIXTURE_SQL_CHUNK_TRACES`, `OTEL_FIXTURE_SQL_TARGET_SPANS_PER_CHUNK`, `OTEL_FIXTURE_SQL_PROCESSES` (default `4` independent OS processes), `OTEL_FIXTURE_SQL_MAX_THREADS` (`0` keeps the ClickHouse query default), and `OTEL_FIXTURE_INSERT_TIMEOUT_SECONDS`. Each process owns a disjoint trace range and independently loops over span INSERT + trace-index INSERT, so several ClickHouse insert pipelines run concurrently without Python GIL serialization.

**Logs and metrics.** `tests/clickhouse-init/05-otel-logs-metrics.sql` holds the exporter DDL for `otel.otel_logs` and the five `otel.otel_metrics_*` tables. Because init scripts never re-run on the persistent `clickhouse_data` volume, the fixture also applies this file itself (every statement is `CREATE ... IF NOT EXISTS`). With `OTEL_FIXTURE_LOGS=1` / `OTEL_FIXTURE_METRICS=1` (both on in compose) it then derives logs and metrics from the stored spans with server-side `INSERT ... SELECT` over the last `OTEL_FIXTURE_SIGNALS_WINDOW_MINUTES` (1440) of the trace fixture, reading `otel_traces` without ever modifying it. Logs cover every trace of the last `OTEL_FIXTURE_LOGS_DENSE_MINUTES` (60) minutes and 1 trace in `OTEL_FIXTURE_LOGS_TRACE_SAMPLE` (16) of the rest (`OTEL_FIXTURE_LOGS_SPAN_SAMPLE`, default 4, thins the spans); on the 2-billion-span volume that is ~17 M log records in ~25 s and ~880 k metric points in ~16 s. A complete load is marked in the table comment and kept on later runs; an interrupted one is rebuilt; `OTEL_FIXTURE_SIGNALS_FORCE=1` rebuilds logs/metrics only, and `OTEL_FIXTURE_FORCE=1` (which rebuilds traces) rebuilds them too. Details: `docs/logs.md`, `docs/metrics.md`.

### Rich OTel dataset

The bulk fixture is large but flat (depth 1, two attributes, no links). `tests/otel-fixture/rich_fixture.py` (`OTEL_FIXTURE_RICH=1`, on in compose) adds a small, deterministic e-commerce workload so features can be tested on real rows instead of `page.route` mocks. Everything lies on **2026-09-12 UTC** (traffic 00:05–23:01), a day the bulk fixture never uses, so tests that derive their window from the newest data or from 2026-09-13..20 are unaffected.

| Part | Volume (defaults) | Where |
| --- | --- | --- |
| traces | 40,693 traces, ~545 k spans, ~42 k index rows | `otel.otel_traces`, `otel.otel_traces_trace_id_ts` |
| logs | ~217 k records (~6 k without trace context) | `otel.otel_logs` |
| metrics | ~21 k histogram, ~100 k counter, ~29 k gauge points | `otel_metrics_{histogram,sum,gauge}` of `OTEL_FIXTURE_RICH_METRICS_DATABASE` (`otel`) |

The whole load takes about 10 s (4 generator processes, JSONEachRow inserts; metrics are `INSERT ... SELECT` over that day's spans).

Shape:

- **Services** `api-gateway` (envoy) → `frontend` (Node.js) → `checkout` (Java), `payments` (Go), `inventory` (Python), `auth` (Go), `search` (Python), `recommendation` (Python), `notification` (.NET). Flows: `GET /healthz` (one span), `GET /api/v1/home`, `GET /api/v1/search`, `GET /api/v1/products/{id}`, `POST /api/v1/cart/items`, `POST /api/v1/login`, `POST /api/v1/checkout` (depth 9: gateway → frontend → checkout → `CheckoutService.placeOrder` → payments → `fees.compute` / PSP call, plus `publish orders` → notification `process orders`).
- **Protocols** HTTP client/server pairs (`http.request.method`, `http.route`, `url.full`, `http.response.status_code` incl. 401/402/409/500/502/504), gRPC (`rpc.system=grpc`, `rpc.service`, `rpc.method`, `rpc.grpc.status_code`), PostgreSQL / Redis / ClickHouse client spans (`db.system`, `db.query.text` or `db.statement`, `db.name`, `db.operation.name`), Kafka (`messaging.system=kafka`, `messaging.destination.name=orders`).
- **Links** every 2 minutes an `inventory` `receive orders` batch trace links to the `publish orders` span of each checkout of the previous 2 minutes, and each per-message `process orders` child links to its producer (`link.kind=follows_from`).
- **Errors** deep in branches with `exception` events (`exception.type`, `exception.message`, `exception.stacktrace`, `exception.escaped`): `java.lang.NullPointerException` and a Spring `HttpServerErrorException$GatewayTimeout` (checkout), Go `*url.Error` deadline (payments → PSP, 5 s), Python `KeyError`, `redis.exceptions.TimeoutError` and a ClickHouse `DatabaseError` (inventory, search), JavaScript `TypeError` and gRPC `Error` (frontend), .NET `System.Net.Mail.SmtpException` (notification, also as `exception.*` span attributes; the request itself succeeds). Other events: `cache.miss`, `retry`.
- **Incomplete traces** ~1.5 % of the requests lost their frontend server span and ~0.5 % their root span (dangling `ParentSpanId`).
- **Large traces** `search` `catalog.reindex` jobs at 03:00, 06:30, 09:15, 18:00 and 21:00 with ~2 k, 4 k, 8 k, 10 k and 12 k spans (10–40 s, several index rows each); the last one exceeds `max_spans_per_trace` (10,000).
- **Resources** `service.version` switches (release annotations): api-gateway 1.32.0 at 04:00, auth 5.2.1 at 06:00, frontend 3.9.0 at 08:00, checkout 1.15.0 at 10:00, recommendation 0.22.0 at 11:00, inventory 0.10.0 at 12:00, payments 2.4.0 at 14:00 and 2.4.1 at 16:00, notification 2.8.0 at 17:00, search 4.1.0 at 19:00; one ReplicaSet of 2–3 pods per version (`k8s.pod.name`, `k8s.namespace.name`) spread over six nodes (`host.name` = `k8s.node.name`), `deployment.environment.name=production`, `telemetry.sdk.*`, `process.runtime.*`.
- **Slow cohort** from 14:00 to 16:00 checkouts with `feature.flag=new_pricing` (half of them; the others carry `control`) spend 2–7 s in payments' `fees.compute`. From 13:30 to 16:30 no other trace takes 1.5 s or more, so a heatmap box over that band ranks `feature.flag` first.
- **Logs** per span: request received / completed, gateway access logs, cache misses, retries, order steps, an `ERROR` record with the `exception.*` attributes of every exception event; trace-less pod start/stop records at each release and connection-pool stats every 5 minutes per pod.
- **Metrics** `http.server.request.duration` (delta histogram per minute and HTTP server span name, one exemplar = the slowest span of the minute), `traces.span.metrics.calls` (cumulative counter per minute, reset at each release of the service), `process.cpu.utilization` (gauge per pod with `host.name` / `k8s.pod.name`; payments runs hot during the incident).

TraceIds are `blake2b(seed:trace:n)`, SpanIds come from a per-trace `random.Random(f"{seed}:trace:{n}")`, so the same seed and trace count always produce the same rows. Knobs: `OTEL_FIXTURE_RICH_TRACES` (40000 request traces), `OTEL_FIXTURE_RICH_SEED` (20260912), `OTEL_FIXTURE_RICH_LOGS` / `OTEL_FIXTURE_RICH_METRICS` (1), `OTEL_FIXTURE_RICH_METRICS_DATABASE` (`otel`), `OTEL_FIXTURE_RICH_PROCESSES` (4), `OTEL_FIXTURE_RICH_CHUNK_TRACES` (1500).

Idempotency: each part (traces with their index rows, logs, metrics) is complete when its table comment carries `chdash-rich-fixture=v2/seed-<seed>/traces-<n>` (appended to the logs/metrics completion marker, never replacing it) and the 2026-09-12 partition holds rows. Complete parts are kept; empty parts are generated; a part holding rows without the marker (an interrupted load) or with another seed is left untouched with a message. `OTEL_FIXTURE_RICH_FORCE=1` rebuilds: it drops the 2026-09-12 partition of the rich tables and deletes the index rows whose `Start` lies in that day, and refuses when that day holds rows of any other service. The bulk fixture leaves the rich day out of its own counts, and `OTEL_FIXTURE_FORCE=1` / `OTEL_FIXTURE_SIGNALS_FORCE=1` (which truncate) are followed by a rich reload. `backend-functional/test_rich_fixture.py` exercises the Trace Explorer, trace logs and metrics exemplars on this day and skips when it is absent (the metrics check also skips when the configured metrics database has no rich points). Tests of the span-derived logs and metrics that aggregate whole tables or derive windows from the oldest point restrict themselves to the newest day (`test_metrics_browser.py` `kind_bounds`, `test_otel_signals.py` log mix): the rich day has its own releases, severity mix and services.

To load it into a running stack without touching the other parts:

```bash
docker build -t chdash-otel-fixture -f tests/otel-fixture/Dockerfile .
docker run --rm --network chdash-tests_default -e OTEL_FIXTURE_LOGS=0 -e OTEL_FIXTURE_METRICS=0 \
  -e OTEL_FIXTURE_RICH=1 chdash-otel-fixture
```

### Production-scale trace benchmark


For the fastest production-shaped billion-row benchmark without changing ClickHouse server settings, use the SQL generator (it now has only the optimized-rich implementation) and keep chunks around 10–15 million spans. Larger 50M-span chunks can be slower because each inserted block has much more sorting/index work before it commits:

```bash
cd tests
OTEL_FIXTURE_FORCE=1 \
OTEL_FIXTURE_GENERATOR=sql \
OTEL_FIXTURE_TRACES=25000000 \
OTEL_FIXTURE_MIN_SPANS=60 \
OTEL_FIXTURE_MAX_SPANS=90 \
OTEL_FIXTURE_SPREAD_MINUTES=10080 \
OTEL_FIXTURE_SQL_TARGET_SPANS_PER_CHUNK=10000000 \
OTEL_FIXTURE_SQL_PROCESSES=4 \
docker compose --profile otel up -d --build otel_fixture
```

To create roughly the same order of magnitude as a 24-hour dataset containing ~150 million spans, use two million traces with the default 60–90 spans/trace and spread them over 24 hours:

```bash
cd tests
OTEL_FIXTURE_FORCE=1 \
OTEL_FIXTURE_GENERATOR=sql \
OTEL_FIXTURE_TRACES=2000000 \
OTEL_FIXTURE_SPREAD_MINUTES=1440 \
OTEL_FIXTURE_SQL_CHUNK_TRACES=2000000 \
docker compose --profile otel up -d --build otel_fixture

docker compose --profile otel logs -f otel_fixture
```

The SQL generator deliberately keeps Events and Links empty to maximize insertion throughput; the default 10k Python fixture remains the source for event/link UI coverage. Each SQL chunk inserts both its span rows and its one-row-per-trace time-index rows, so no final scan across ~150M spans is required. Projection indexes are defined before seeding and are therefore populated automatically as each MergeTree part is written.

For a **very large trace-count benchmark** (especially `prj_start` on `otel_traces_trace_id_ts`), set one span per trace. The same SQL generator uses `numbers_mt()` directly and never uses `ARRAY JOIN`, so the stored row count is approximately the trace count instead of `trace_count × 60–90`.

For example, 50 million traces distributed over seven days makes a 24-hour query select roughly one seventh of the index and is a useful local pruning test:

```bash
cd tests
OTEL_FIXTURE_FORCE=1 \
OTEL_FIXTURE_GENERATOR=sql \
OTEL_FIXTURE_TRACES=50000000 \
OTEL_FIXTURE_MIN_SPANS=1 \
OTEL_FIXTURE_MAX_SPANS=1 \
OTEL_FIXTURE_SPREAD_MINUTES=10080 \
OTEL_FIXTURE_SQL_CHUNK_TRACES=2000000 \
docker compose --profile otel up -d --build otel_fixture

docker compose --profile otel logs -f otel_fixture
```

To approach the ~170M trace-index rows discussed for production, raise `OTEL_FIXTURE_TRACES` to `170000000`. Start with 10–50M first to measure disk and insertion throughput on the local machine.

Useful size checks after the fixture becomes healthy:

```sql
SELECT
    table,
    sum(rows) AS rows,
    formatReadableSize(sum(bytes_on_disk)) AS disk
FROM system.parts
WHERE active
  AND database = 'otel'
  AND table IN ('otel_traces', 'otel_traces_trace_id_ts')
GROUP BY table
ORDER BY table;
```

## Full test profile

```bash
docker compose --profile test up -d --build
```

The command remains detached. The `test` profile also activates `otel_fixture`, waits for its healthcheck, and then runs **one single one-shot container named `tests`**. There is no test UI and no separate frontend/performance/aggregation service.

The `tests` container executes four categories sequentially:

1. **backend-functional** — live query formatting and API route/function flows;
2. **frontend-functional** — Playwright functionality tests at the canonical 1440x900 viewport;
3. **performance** — hardcoded query/DDL/INSERT timing scenarios;
4. **design** — Playwright screenshots at 1920x1080, 1440x900 and 1280x800 plus layout/accessibility audits.

It always attempts to produce:

```text
tests/artifacts/chdash-test-review.zip
```

and then exits. `Exited (0)` means all four technical phases completed successfully. `Exited (1)` means at least one phase failed; the ZIP is still attempted so the diagnostics can be reviewed.

Check status/logs with:

```bash
docker compose --profile test ps -a
docker compose --profile test logs -f tests
```

The archive contains exactly:

```text
chdash-test-review/
├── manifest.json
├── README.md
├── backend-functional/
├── frontend-functional/
├── performance/
└── design/
```

Upload that single ZIP for review.

## Backend functional

The backend phase hits the running ChDash service rather than only inspecting source files. It checks formatter fixtures against `/api/format`, native query/result types, core health/meta/host routes, query run/stream, analysis/execution/deep-analysis, Explorer routes, export and cancel-token rejection behavior.

## Frontend functional

Playwright validates interactions and behavior only. It does not capture design-review screenshots and does not fail because a page is aesthetically poor. Runtime page errors are still treated as functional failures.

## Performance

Cases are hardcoded in:

```text
tests/performance/cases.json
```

They currently include SELECTs, aggregation, `CREATE TABLE`, `INSERT` and reading inserted data. The measured result is written to:

```text
performance/actual.json
```

The repository baseline is:

```text
tests/performance/expected.json
```

It now contains the first approved local Docker baseline envelope from 2026-09-05. Performance failures are based on per-case `median_ms_max` and `p95_ms_max` limits, deliberately leaving headroom above the first measured run so normal Docker scheduling noise does not create flaky failures.

Expected metrics use per-case maximums such as:

```json
{
  "cases": {
    "select_literal": {
      "median_ms_max": 12.5,
      "p95_ms_max": 18.0
    }
  }
}
```

## Design

The design phase is separate from frontend functionality. It captures deterministic states across three desktop viewports and records:

- full-page screenshots;
- horizontal overflow;
- elements outside the viewport;
- clipped text candidates;
- controls smaller than 32 px;
- overlapping controls;
- font/radius/color/spacing token counts;
- axe accessibility findings;
- Playwright traces/videos when a capture itself fails.

Design heuristics are report signals rather than aesthetic pass/fail rules. Visual baseline comparison remains opt-in via `VISUAL_COMPARE=1` until the redesign is accepted.

## Cleanup

```bash
docker compose --profile test down -v --remove-orphans
```
