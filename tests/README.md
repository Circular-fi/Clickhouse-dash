# ChDash Docker tests

The test workflow is fully containerized. The host needs only Docker + Docker Compose: no Python, Node.js, Playwright or browser installation is required.

## Local development

From `tests/`:

```bash
docker compose up -d
```

This starts exactly:

- ClickHouse `26.7.5.10`;
- a fresh Release build of the current ChDash working tree at `http://localhost:18080`.

`chdash_source` uses `pull_policy: build`, so the local source image is rebuilt by a normal `docker compose up -d`.

## Full test profile

```bash
docker compose --profile test up -d --build
```

The command remains detached. It keeps the normal ClickHouse + ChDash services and adds **one single one-shot container named `tests`**. There is no test UI and no separate frontend/performance/aggregation service.

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
