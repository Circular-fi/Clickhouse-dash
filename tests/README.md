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

The heavy `otel_fixture` service is intentionally behind the Compose `otel` profile, so a normal rebuild does **not** start or wait for it. Start it explicitly with `docker compose --profile otel up -d --build otel_fixture`. The `test` profile also enables it automatically because the full test suite expects seeded trace data.

The OTEL schema is initialized by `tests/clickhouse-init/03-otel-traces.sql` as part of ClickHouse startup. The local `otel.otel_traces` base table intentionally mirrors the production exporter table: the same codecs, native bloom/minmax skipping indexes, `PARTITION BY toDate(Timestamp)`, and `ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))`. The only additions are the ClickHouse 26.1+ lightweight secondary projection indexes validated by the large local benchmark: `prj_traceid` on `otel_traces` and `prj_start` on the trace-id time index. `prj_timestamp` is intentionally not added: on the production-shaped benchmark it consumed substantial disk for negligible timestamp-scan improvement.

`prj_traceid` accelerates exact/`IN` TraceId pruning without changing the production sort key, and `prj_start` adds time-oriented pruning on `otel_traces_trace_id_ts` while its base `(TraceId, Start)` ordering remains available for direct trace lookup. On a persistent test volume created before these projections existed, the fixture detects missing definitions and materializes them once for existing rows. If the base local table was created by an older ChDash fixture with a different `ORDER BY`, recreate the local ClickHouse volume once (`docker compose down -v`) so the production-compatible base schema is applied; `CREATE TABLE IF NOT EXISTS` deliberately does not rewrite existing MergeTree data.

When the `otel` profile is enabled, no host-side Python or manual `clickhouse-client` import is required. The fixture generates 10,000 domain-neutral traces by default. Small fixtures may use the Python generator for event/link UI coverage; large fixtures use one SQL implementation only: production-shaped **optimized-rich** rows generated directly by `INSERT ... SELECT FROM numbers_mt()`. The SQL path writes `otel_traces_trace_id_ts` directly from the same deterministic trace sequence, avoiding Python row generation, JSON upload, `ARRAY JOIN`, per-span hashes, and a final `GROUP BY TraceId`.

The fixture remains healthy after the initial seed and reuses an existing completed OTEL dataset on later runs, so rebuilding ChDash does not reseed the traces. Presence checks use `system.parts` metadata rather than `uniqExact(TraceId)`, so even a fixture containing hundreds of millions of spans does not get scanned on every compose rebuild. Set `OTEL_FIXTURE_FORCE=1` when you explicitly want a fresh fixture. ClickHouse data is stored in the named `clickhouse_data` volume, so an eventual container recreation does not discard the seeded data.

The fixture size can be overridden through `OTEL_FIXTURE_TRACES`, `OTEL_FIXTURE_MIN_SPANS`, `OTEL_FIXTURE_MAX_SPANS`, `OTEL_FIXTURE_SEED`, `OTEL_FIXTURE_ERROR_RATE`, `OTEL_FIXTURE_BATCH_TRACES`, and `OTEL_FIXTURE_SPREAD_MINUTES`; defaults are listed in `.env.example`. A partially completed **parallel** SQL fixture is deliberately not resumed from `count(rows)`: the workers own disjoint TraceId ranges, so a row count is not a safe contiguous cursor and could otherwise create duplicate/missing TraceIds. Rebuild an interrupted parallel fixture with `OTEL_FIXTURE_FORCE=1`; single-process loads can still grow contiguously. Massive-mode controls are `OTEL_FIXTURE_GENERATOR=auto|python|sql`, `OTEL_FIXTURE_SQL_THRESHOLD`, `OTEL_FIXTURE_SQL_CHUNK_TRACES`, `OTEL_FIXTURE_SQL_TARGET_SPANS_PER_CHUNK`, `OTEL_FIXTURE_SQL_PROCESSES` (default `4` independent OS processes), `OTEL_FIXTURE_SQL_MAX_THREADS` (`0` keeps the ClickHouse query default), and `OTEL_FIXTURE_INSERT_TIMEOUT_SECONDS`. Each process owns a disjoint trace range and independently loops over span INSERT + trace-index INSERT, so several ClickHouse insert pipelines run concurrently without Python GIL serialization.

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
