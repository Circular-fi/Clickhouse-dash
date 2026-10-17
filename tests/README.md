# ChDash Docker tests

The test workflow runs in containers. The host needs only Docker + Docker Compose. The host does not need Python, Node.js, Playwright or a browser.

## Local development

Run this command from `tests/`:

```bash
docker compose up -d --build
```

This command starts only the normal development stack:

- ClickHouse `26.7.5.10`;
- ClickHouse init SQL that creates the OTEL tables and the trace projection indexes. On a fresh volume, it also creates what a long-lived server already has. It creates the system log tables that ChDash detects for Run with profiling, and the `chdash_perf` database (`06-fresh-server-prerequisites.sql`);
- a fresh Release build of the current ChDash working tree at `http://localhost:18080`.
- a second ClickHouse replica (`clickhouse_replica`) that joins the primary through the ClickHouse Keeper embedded in `clickhouse` (cluster `chdash_cluster`, config in `tests/clickhouse-config/`). The fixture `tests/clickhouse-cluster/04-replicated-fixtures.sql` creates `chdash_repl` with ReplicatedMergeTree and ReplicatedSummingMergeTree tables, a materialized view and a Distributed table. Every test run applies it again. Replica counts, queues and the graph's `nR` badges are tested locally.

  It is not a primary init script. The image runs it against a server that listens on 127.0.0.1 only (embedded Keeper included), before the replica starts. Its `ON CLUSTER` DDL needs both replicas.

  On a fresh stack, the init script of the replica (`clickhouse-cluster/04-replicated-fixtures.sh`) waits within 180 s until Keeper answers both replicas. It then applies the fixture through the primary. The ClickHouse healthchecks connect through the network address of the container. A server that still runs its init scripts is not reported healthy.

The heavy `otel_fixture` service is behind the Compose `otel` profile on purpose. A normal rebuild does **not** start or wait for it. Start it explicitly with `docker compose --profile otel up -d --build otel_fixture`. The `test` profile also enables it, because the full test suite expects seeded trace data.

The init script `tests/clickhouse-init/03-otel-traces.sql` creates the OTEL schema when ClickHouse starts. The local base table `otel.otel_traces` mirrors the production exporter table on purpose. It has the same codecs, the same native bloom and minmax skipping indexes, `PARTITION BY toDate(Timestamp)` and `ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))`. 

The only additions are two lightweight secondary projection indexes. They need ClickHouse 26.1 or later. The large local benchmark validated them. They are `prj_traceid` on `otel_traces` and `prj_start` on the trace-id time index.

The fixture does not add `prj_timestamp`. On the production-shaped benchmark, it used a large amount of disk for a negligible gain in timestamp scans.

`prj_traceid` accelerates exact and `IN` TraceId pruning. It does not change the production sort key. `prj_start` adds time-based pruning on `otel_traces_trace_id_ts`. The base ordering `(TraceId, Start)` stays available for direct trace lookup. On a persistent test volume that existed before these projections, the fixture finds the missing definitions. It then materializes them once for the rows that are already there.

If an older ChDash fixture created the base local table with a different `ORDER BY`, recreate the local ClickHouse volume once (`docker compose down -v`). This applies the production-compatible base schema. `CREATE TABLE IF NOT EXISTS` does not rewrite the MergeTree data that is already there. This is intended.

If the `otel` profile is enabled, you do not need Python on the host or a manual `clickhouse-client` import. The fixture generates 10,000 domain-neutral traces by default. Small fixtures can use the Python generator for event and link UI coverage.

Large fixtures use only one SQL implementation. It generates production-shaped **optimized-rich** rows directly with `INSERT ... SELECT FROM numbers_mt()`. The SQL path writes `otel_traces_trace_id_ts` from the same deterministic trace sequence. It does not use Python row generation, JSON upload, `ARRAY JOIN`, per-span hashes or a final `GROUP BY TraceId`.

The fixture stays healthy after the first seed. On later runs, it reuses a complete OTEL dataset. Therefore, a rebuild of ChDash does not seed the traces again.

Presence checks use `system.parts` metadata, not `uniqExact(TraceId)`. A fixture with hundreds of millions of spans is not scanned on each Compose rebuild. Set `OTEL_FIXTURE_FORCE=1` only when you want a fresh fixture. The ClickHouse data is stored in the named `clickhouse_data` volume. A container that is recreated later does not delete the seeded data.

You can change the fixture size with `OTEL_FIXTURE_TRACES`, `OTEL_FIXTURE_MIN_SPANS`, `OTEL_FIXTURE_MAX_SPANS`, `OTEL_FIXTURE_SEED`, `OTEL_FIXTURE_ERROR_RATE`, `OTEL_FIXTURE_BATCH_TRACES` and `OTEL_FIXTURE_SPREAD_MINUTES`. The defaults are in `.env.example`. Do not resume a partly completed **parallel** SQL fixture from `count(rows)`.

The workers own separate TraceId ranges. A row count is not a safe contiguous cursor. It can create duplicate or missing TraceIds. Rebuild an interrupted parallel fixture with `OTEL_FIXTURE_FORCE=1`. A single-process load can still grow contiguously.

The controls for massive mode are `OTEL_FIXTURE_GENERATOR=auto|python|sql`, `OTEL_FIXTURE_SQL_THRESHOLD`, `OTEL_FIXTURE_SQL_CHUNK_TRACES`, `OTEL_FIXTURE_SQL_TARGET_SPANS_PER_CHUNK`, `OTEL_FIXTURE_SQL_PROCESSES` (default `4` independent OS processes), `OTEL_FIXTURE_SQL_MAX_THREADS` (`0` keeps the ClickHouse query default) and `OTEL_FIXTURE_INSERT_TIMEOUT_SECONDS`. Each process owns a separate trace range. It loops on span INSERT and trace-index INSERT. Therefore, several ClickHouse insert pipelines run at the same time, without Python GIL serialization.

**Logs and metrics.** The file `tests/clickhouse-init/05-otel-logs-metrics.sql` holds the exporter DDL for `otel.otel_logs` and the five `otel.otel_metrics_*` tables. Init scripts do not run again on the persistent `clickhouse_data` volume. Therefore, the fixture applies this file itself. Every statement uses `CREATE ... IF NOT EXISTS`.

Set `OTEL_FIXTURE_LOGS=1` and `OTEL_FIXTURE_METRICS=1` to load both signals. Compose sets both. The fixture then derives logs and metrics from the stored spans. It uses server-side `INSERT ... SELECT` over the last `OTEL_FIXTURE_SIGNALS_WINDOW_MINUTES` (1440) of the trace fixture. It reads `otel_traces` and never changes it.

Logs cover every trace of the last `OTEL_FIXTURE_LOGS_DENSE_MINUTES` (60) minutes. For the rest, the fixture keeps 1 trace in `OTEL_FIXTURE_LOGS_TRACE_SAMPLE` (16). `OTEL_FIXTURE_LOGS_SPAN_SAMPLE` (default 4) thins the spans. On the 2-billion-span volume, this gives about 17 M log records in about 25 s. It gives about 880 k metric points in about 16 s.

The table comment marks a complete load. The fixture keeps a complete load on later runs. It rebuilds an interrupted load. `OTEL_FIXTURE_SIGNALS_FORCE=1` rebuilds only logs and metrics. `OTEL_FIXTURE_FORCE=1` rebuilds the traces, and it also rebuilds logs and metrics. Details are in `docs/logs.md` and `docs/metrics.md`.

### Rich OTel dataset

The bulk fixture is large but flat. It has depth 1, two attributes and no links. The script `tests/otel-fixture/rich_fixture.py` (`OTEL_FIXTURE_RICH=1`, on in compose) adds a small and deterministic e-commerce workload. Features can be tested on real rows with it, not with `page.route` mocks.

All data lies on **2026-09-12 UTC** (traffic 00:05–23:01). The bulk fixture never uses this day. Tests that take their window from the newest data, or from 2026-09-13..20, are not affected.

| Part | Volume (defaults) | Where |
| --- | --- | --- |
| traces | 40,693 traces, ~545 k spans, ~42 k index rows | `otel.otel_traces`, `otel.otel_traces_trace_id_ts` |
| logs | ~217 k records (~6 k without trace context) | `otel.otel_logs` |
| metrics | ~21 k histogram, ~100 k counter, ~29 k gauge points | `otel_metrics_{histogram,sum,gauge}` of `OTEL_FIXTURE_RICH_METRICS_DATABASE` (`otel`) |

The whole load takes about 10 s. It uses 4 generator processes and JSONEachRow inserts. The metrics use `INSERT ... SELECT` over the spans of that day.

The data has this shape:

- **Services** `api-gateway` (envoy) → `frontend` (Node.js) → `checkout` (Java), `payments` (Go), `inventory` (Python), `auth` (Go), `search` (Python), `recommendation` (Python), `notification` (.NET). Flows: `GET /healthz` (one span), `GET /api/v1/home`, `GET /api/v1/search`, `GET /api/v1/products/{id}`, `POST /api/v1/cart/items`, `POST /api/v1/login`, `POST /api/v1/checkout` (depth 9: gateway → frontend → checkout → `CheckoutService.placeOrder` → payments → `fees.compute` / PSP call. It also has `publish orders` → notification `process orders`).
- **Protocols** HTTP client and server pairs (`http.request.method`, `http.route`, `url.full`, `http.response.status_code` incl. 401/402/409/500/502/504). gRPC (`rpc.system=grpc`, `rpc.service`, `rpc.method`, `rpc.grpc.status_code`). PostgreSQL, Redis and ClickHouse client spans (`db.system`, `db.query.text` or `db.statement`, `db.name`, `db.operation.name`). Kafka (`messaging.system=kafka`, `messaging.destination.name=orders`).
- **Links** Every 2 minutes, an `inventory` `receive orders` batch trace links to the `publish orders` span of each checkout of the previous 2 minutes. Each per-message `process orders` child links to its producer (`link.kind=follows_from`).
- **Errors** appear deep in branches as `exception` events (`exception.type`, `exception.message`, `exception.stacktrace`, `exception.escaped`). They include: `java.lang.NullPointerException` and a Spring `HttpServerErrorException$GatewayTimeout` (checkout); Go `*url.Error` deadline (payments → PSP, 5 s); Python `KeyError`, `redis.exceptions.TimeoutError` and a ClickHouse `DatabaseError` (inventory, search); JavaScript `TypeError` and gRPC `Error` (frontend); .NET `System.Net.Mail.SmtpException` (notification, also as `exception.*` span attributes). In the last case, the request itself succeeds. Other events are `cache.miss` and `retry`.
- **Incomplete traces** ~1.5 % of the requests lost their frontend server span. ~0.5 % lost their root span (dangling `ParentSpanId`).
- **Large traces** The `search` `catalog.reindex` jobs run at 03:00, 06:30, 09:15, 18:00 and 21:00. They have ~2 k, 4 k, 8 k, 10 k and 12 k spans (10–40 s, several index rows each). The last one exceeds `max_spans_per_trace` (10,000).
- **Resources** The `service.version` switches show the release annotations. api-gateway 1.32.0 at 04:00, auth 5.2.1 at 06:00, frontend 3.9.0 at 08:00, checkout 1.15.0 at 10:00, recommendation 0.22.0 at 11:00, inventory 0.10.0 at 12:00, payments 2.4.0 at 14:00 and 2.4.1 at 16:00, notification 2.8.0 at 17:00, search 4.1.0 at 19:00. Each version has one ReplicaSet of 2–3 pods (`k8s.pod.name`, `k8s.namespace.name`). The pods are distributed across six nodes (`host.name` = `k8s.node.name`). The data also has `deployment.environment.name=production`, `telemetry.sdk.*` and `process.runtime.*`.
- **Slow cohort** From 14:00 to 16:00, checkouts with `feature.flag=new_pricing` spend 2–7 s in payments' `fees.compute`. These checkouts are half of all checkouts. The other half carry `control`. From 13:30 to 16:30, no other trace takes 1.5 s or more. Therefore, a heatmap box over that band ranks `feature.flag` first.
- **Logs** Each span has these records: request received and completed, gateway access logs, cache misses, retries, order steps, and an `ERROR` record with the `exception.*` attributes of every exception event. Trace-less pod start and stop records appear at each release. Connection-pool stats appear every 5 minutes for each pod.
- **Metrics** `http.server.request.duration` is a delta histogram per minute and per HTTP server span name. Each minute has one exemplar, the slowest span of that minute. `traces.span.metrics.calls` is a cumulative counter per minute. It resets at each release of the service. `process.cpu.utilization` is a gauge for each pod (`host.name` / `k8s.pod.name`). Payments runs hot during the incident.

TraceIds are `blake2b(seed:trace:n)`. Each trace uses `random.Random(f"{seed}:trace:{n}")` for its SpanIds. The same seed and trace count always give the same rows. The settings are: `OTEL_FIXTURE_RICH_TRACES` (40000 request traces), `OTEL_FIXTURE_RICH_SEED` (20260912), `OTEL_FIXTURE_RICH_LOGS` / `OTEL_FIXTURE_RICH_METRICS` (1), `OTEL_FIXTURE_RICH_METRICS_DATABASE` (`otel`), `OTEL_FIXTURE_RICH_PROCESSES` (4), `OTEL_FIXTURE_RICH_CHUNK_TRACES` (1500).

Idempotency: each part (traces with their index rows, logs and metrics) is complete when two conditions hold. Its table comment carries `chdash-rich-fixture=v2/seed-<seed>/traces-<n>`, which is appended to the logs and metrics completion marker and never replaces it. The 2026-09-12 partition also holds rows.

Complete parts are kept. Empty parts are generated. A part that holds rows without the marker, or with another seed, stays untouched. The fixture prints a message for that part.

`OTEL_FIXTURE_RICH_FORCE=1` rebuilds the data. It drops the 2026-09-12 partition of the rich tables. It deletes the index rows whose `Start` lies in that day. It refuses to run when that day holds rows of any other service.

The bulk fixture leaves the rich day out of its own counts. `OTEL_FIXTURE_FORCE=1` and `OTEL_FIXTURE_SIGNALS_FORCE=1` truncate the tables. After either one, the fixture runs a rich reload.

`backend-functional/test_rich_fixture.py` tests the Trace Explorer, trace logs and metrics exemplars on this day. It skips when the day is absent. The metrics check also skips when the configured metrics database has no rich points.

Tests of span-derived logs and metrics restrict themselves to the newest day. These tests either aggregate whole tables or take their windows from the oldest point. The affected tests are `test_metrics_browser.py` `kind_bounds` and `test_otel_signals.py` log mix. The rich day has its own releases, severity mix and services.

Tests that need real rows, but not a large volume, read this day. They do not read the bulk fixture. One hour of the bulk fixture holds ~22 M spans. The tests that read this day are these.

They include the filter bar, listener, side panel and design captures of Traces, Logs and Metrics. They also include the traces range picker tests. They also include the 7-day bucket grid of `test_trace_analytics_seven_day_duration_percentiles_are_not_empty`. The 7-day grid covers seven days that end on 2026-09-12. It has six empty days, then this one.

Budgets on dense data keep bounded windows of the bulk fixture, one to six hours long.

**Fresh and long-lived stacks.** The CI profile starts from empty volumes. The bulk fixture then holds 10,000 traces (~750 k spans, Python generator: no `fixture.bucket`, links within a trace only). These traces cover the ~55 minutes before the stack started. Its logs and metrics cover those minutes only.

A long-lived local stack can hold ~2 B SQL-generated spans over a week. This day is the only data that both stacks hold. Therefore, tests do not assume either bulk shape:

- correctness checks that need varied attributes, errors or links read one hour of this day. They take the attribute values that they filter on from its rows (`test_trace_spans.py` keyset paging over ~450 error spans, per-span filters and budget stop; `test_trace_heatmap.py` cells and deltas; the multi-tag and analytics tag filters of `test_routes.py`; cross-trace links; `trace-spans.spec.js`; the logs patterns and denoise spec);
- budgets on dense data take their window from the bulk fixture's newest data (the hour two hours before the newest span when it is busy, else the newest hour);
- windows of span-derived logs and metrics start at the first point of the newest day (`kind_bounds`), not at its first minute;
- A test writes its own shape when no fixture holds that shape on every stack. The test writes it on a day of its own in late August 2026. The test drops that partition afterwards (`backend-functional/synthetic_spans.py`). Examples are the facet tests' 3.6 M spans in 70 minutes (above the 3 M-span facet sample) and the span stored twice of the keyset test.

To load this data into a stack that runs, without changes to the other parts, run these commands:

```bash
docker build -t chdash-otel-fixture -f tests/otel-fixture/Dockerfile .
docker run --rm --network chdash-tests_default -e OTEL_FIXTURE_LOGS=0 -e OTEL_FIXTURE_METRICS=0 \
  -e OTEL_FIXTURE_RICH=1 chdash-otel-fixture
```

### Production-scale trace benchmark


To run the fastest production-shaped benchmark with billions of rows, do not change the ClickHouse server settings. Use the SQL generator. It has only the optimized-rich implementation now. Keep the chunks at about 10–15 million spans.

Chunks of 50M spans can be slower. Each inserted block then needs much more sorting and index work before it commits. Use this command:

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

To create a dataset of about the same order of magnitude as a 24-hour dataset with ~150 million spans, use two million traces. Keep the default 60–90 spans for each trace. Distribute the traces across 24 hours. Use this command:

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

The SQL generator keeps Events and Links empty on purpose. This gives the highest insertion throughput. The default 10k Python fixture is still the source for event and link UI coverage. Each SQL chunk inserts its span rows and its one-row-per-trace time-index rows. Therefore, no final scan across ~150M spans is needed.

The projection indexes are defined before the seed. ClickHouse fills them automatically as it writes each MergeTree part.

For a **very large trace-count benchmark** (especially `prj_start` on `otel_traces_trace_id_ts`), set one span for each trace. The SQL generator uses `numbers_mt()` directly. It never uses `ARRAY JOIN`. The stored row count is about the trace count. It is not `trace_count × 60–90`.

For example, 50 million traces distributed across seven days. A 24-hour query then selects about one seventh of the index. This is a useful local pruning test. Use this command:

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

To approach the ~170M trace-index rows that are discussed for production, set `OTEL_FIXTURE_TRACES` to `170000000`. Start with 10–50M traces. Measure the disk use and the insertion throughput on the local machine first.

Run these size checks after the fixture is healthy:

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

The command runs in detached mode. The `test` profile also starts `otel_fixture` and waits for its healthcheck. Then it runs **one one-shot container named `tests`**. There is no test UI. There is no separate frontend, performance or aggregation service.

The `tests` container runs these categories in sequence:

1. **backend-functional** — live query formatting and API route/function flows, and the harness (the structural rules of the sources, the tools' own checks and the Node unit tests of the pure frontend modules, `tests/frontend/model`);
2. **frontend-functional** — Playwright functionality tests at the canonical 1440x900 viewport, without the timing-budget tests;
3. **frontend-timing** — the timing-budget tests of the same specs, alone, after the others (`PW_PERF=only`): no other browser test loads the host while a budget is measured;
4. **frontend-embedded** — the same Playwright specs against `chdash_embedded`, the server built with the files embedded in the binary (see "Embedded build" below); `--quick` runs the specs that read the production asset path most (`PRODUCTION_PATH_SPECS` of the runner);
5. **performance** — hardcoded query/DDL/INSERT timing scenarios (`PERF_RUNS`, 20 by default, measured runs after `PERF_WARMUP`; the p95 limits of `expected.json` are the second slowest of twenty, not the maximum of five);
6. **design** — Playwright screenshots at 1920x1080, 1440x900 and 1280x800 plus layout/accessibility audits.

It always tries to produce:

```text
tests/artifacts/chdash-test-review.zip
```

Then the command exits. `Exited (0)` means that all phases completed successfully. `Exited (1)` means that at least one phase failed. The ZIP is still tried, so that you can review the diagnostics.

Check the status and the logs with these commands:

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
├── frontend-timing/
├── frontend-embedded/
├── performance/
└── design/
```

Upload that single ZIP for review.

## Embedded build

The service `chdash_source` (target `runtime` of `tests/Dockerfile.source`) reads `./static` from the disk. A build with `CHDASH_EMBED_STATIC=OFF` does the same. A release build does not read from the disk. It serves the files that are compiled into the binary.

`tools/stage_static.py` versions these files first. The versions appear as `?v=<hash>` in every shell and import, in the map `__chdashAssetVersions`, in `.gz` copies and in a long cache lifetime for a versioned file. A bug of this path breaks no test on `chdash_source`. For example, a module can load outside `loader.url`, or a `.wasm` file can lack its version.

The service `chdash_embedded` is the same server, built the release way (target `runtime-embedded`). Its image has no `./static` directory. Therefore, a file that is not embedded gives a 404. The `frontend-embedded` phase runs the Playwright specs on it. To run it alone, use these commands:

```bash
docker compose -f tests/docker-compose.yml --profile embedded up -d --build --wait chdash_embedded
tests/tools/pw-changed.sh -t chdash-tests-embedded     # the specs of the changed files
docker build -f tests/Dockerfile.source --target runtime-embedded -t chdash-mine:embedded .   # an image of this tree
```

`tests/smoke/Dockerfile.release` builds the release binary itself (Zig, static-pie). The embedded test image is the GCC build. It uses the same embedding step. It is quick to build next to the test stack.

`backend-functional/test_embedded_static.py` runs on `chdash_embedded` (`EMBEDDED_BASE_URL`). Without that variable, the test is skipped. The test checks these points. The version in every shell is the hash of the bytes that are sent. A versioned address is immutable, and a wrong address is not.

A gzip copy has the same bytes and is never an address. A kernel is served as `application/wasm`, and its bytes equal the committed file. The policy of a staged shell hashes exactly its inline scripts.

## Running tests quickly

**Playwright projects.** `tests/frontend/playwright.config.js` builds its projects from three environment variables:

| Mode | What runs |
| --- | --- |
| default | layout specs (`accessibility`, `design`, `explorer-nav`, `obs-filterbar`, `page-chrome`, `ui-*`, `visual-regression`) on `desktop-1920`, `desktop-1440` and `laptop-1280`; behavioural specs on `desktop-1440`, plus their viewport-sensitive tests (titles matching `LAYOUT_TITLES`: overflow, fits the viewport, captures, ...) on the other two; the timing-budget tests (`PERF_TITLES`) last, one at a time |
| `PW_ALL_PROJECTS=1` | every test on every viewport: the pre-release run |
| `PW_SHARED_HOST=1` | leaves the timing-budget tests out and defaults to one worker; for runs on a host other runs share (budgets measure the host then, not the code) |
| `PW_PERF=skip\|only\|with` | `skip`: no timing-budget tests; `only`: those tests alone (no other test, one worker); `with` (default): queued after the others, but a worker of the others may still be running. The official run does `skip`, then `only` |

Projects of one viewport share its name. Therefore, `--project=desktop-1440` selects both its behavioural tests and its timing-budget tests. Snapshots and reports keep the viewport name. `PW_WORKERS=<n>` sets the worker count. The default is 2, or 1 with `PW_SHARED_HOST=1`.

The tests of a file are spread among the workers (`fullyParallel`). A failed test runs again at the end, alone (`retryStrategy: 'isolated'`).

Videos and traces are recorded on the first retry only. `CI=1` retries once. A failure without a retry keeps its screenshot and `error-context.md`. `PW_ARTIFACTS=full` records them for every failed test, as it did before.

**Specs of the changed files.** `tests/tools/pw-changed.sh` finds the files that changed since the merge base with `main`. Use `-b <ref>` for another base. Uncommitted and untracked files are included. The script maps each file to its specs through a table of source modules. A script that the table does not name gets the specs of the pages that load it, from `modules.json` and the imports. A foundation module of six pages or more gets the general set.

The script then runs these specs on `desktop-1440` with `PW_SHARED_HOST=1`. It uses the `chdash-tests-all:local` image and `chdash_source`. Use `-t <container>` for another instance. `-n` prints the selection. `-a` runs the three viewports. Arguments after `--` go to Playwright.

```bash
tests/tools/pw-changed.sh -n                      # which specs
tests/tools/pw-changed.sh -t chdash-mine -- --reporter=line
```

**Runner.** `python /tests/test-suite/run-all-tests.py` (the `tests` service) runs the full official suite. It sets `PW_ALL_PROJECTS=1`. Therefore, its phases select the same tests on the same viewports, whatever the defaults above are. The frontend-functional phase runs on `desktop-1440`. The design phase runs on all three viewports.

`--quick` (or `CHDASH_TESTS_QUICK=1`) runs every test at least once. The design phase then runs on `desktop-1440` only. The other phases are the same as in the full run. The performance phase takes seconds. With fewer runs or no warm-up, the timing measures a cold server. `manifest.json` says `mode: quick`.

**Fixture reset.** The runner resets the ClickHouse fixtures before the backend phase. These are `01`, `02`, `05` of `clickhouse-init/` and `04` of `clickhouse-cluster/`. It also tells the backend conftest (`CHDASH_FIXTURES_FRESH=1`) not to reset them again.

If you run the tests by hand with `CLICKHOUSE_URL` set, the conftest resets only when needed. After a reset, it writes a digest in the comment of the `chdash_ui` database. The digest covers the four scripts and the state that they produced. That state holds the fixture tables and their UUIDs, the row counts, the users, the grants and the dictionary status. The next run skips the reset while both match.

`CHDASH_FIXTURE_RESET=always` forces a reset. `CHDASH_FIXTURE_RESET=never` skips it. Without `CLICKHOUSE_URL`, nothing is reset.

**On a shared host** (several agents and one ClickHouse):

1. Run one Playwright run at a time for each agent. Use your own ChDash container.
2. Iterate on one project with the changed specs first. Use `tests/tools/pw-changed.sh`, or `--project=desktop-1440 specs/<file>` with `PW_SHARED_HOST=1`.
3. Run the whole default suite once at the end. Use `PW_ALL_PROJECTS=1` only for the pre-release run.
4. Wait for a run until it exits. Do not use `sleep` or `until` polling loops.
5. Run pytest without `CLICKHOUSE_URL`. Then the shared fixtures are not reset during another run.

## Backend functional

### The harness

`tests/harness` holds the tests that pytest runs without an instance. Do not use it to freeze the text of the sources. A test that checks that a string, an id, a constant or a comment exists in `src/` breaks at each refactor. Such a test proves nothing about what the product does.

Test the behaviour of a unit where you can test it for real. Use the native tests (`tests/native`, services over a fake `ChExecutor`). Use HTTP tests against an instance (`tests/backend-functional`, `tests/api`). Use the Node tests of the pure frontend modules (`tests/frontend/model`, run by `harness/test_frontend_models.py`). Use Playwright only when a browser is needed.

A check that reads the sources is kept only for a structural rule that no behaviour test can see. Such a check carries a one-line reason (`Why:`):

- `test_backend_code_rules.py`: what no C++ unit may do. Examples are a statement outside `ch_query.cpp`, a connection opened by hand, an `/api` route outside a query scope, MCP that reaches the runner, a second write guard, a seeded random source and a function-local cache.
- `test_frontend_code_rules.py`: what no module may do. Examples are a history write that bypasses the router, a local Escape handler, a bare `fetch`, a direct `localStorage`, a hand-built tab row and a page that loads the modules of another family. `test_dom_builder_contract.py` checks the markup sinks. `test_frontend_format_colour_rules.py` checks the local formatters and raw colours.
- `test_css_rules.py`, `test_css_tokens_contract.py`, `test_type_scale_contract.py`, `test_accessibility_rules.py`: the stylesheet sources (layers, tokens, scales, breakpoints, contrast, focus).
- `test_page_shells_contract.py`, `test_module_graph_contract.py`, `test_page_stylesheets_contract.py`, `test_icons_contract.py`, `test_docs_references_contract.py`, `test_config_schema_contract.py`, `test_test_suite_contract.py`: the generated and cross-referenced files must agree (shells, module graph, sheets, sprite, the names that a document gives, the key table, the specs that the runner runs).
- `test_ci_workflow_policy.py`, `test_repository_hygiene_contract.py`: the rules of the workflows and of the repository.
- The other files run other programs: the Node unit scripts and tests, the native binaries when the environment names them, the generator and the tools (`test_dangling_capture_check.py`, `test_release_smoke.py`, `test_static_assets_contract.py`, `test_wasm_contract.py`, `test_otel_trace_generator.py`, `test_pw_changed_contract.py`, `test_js_names_contract.py`).

Do not add a new numbered or per-release file. Put a check in the file that is named after its subject. Otherwise, write a behaviour test.

The backend phase sends requests to the ChDash service that runs. It does not only inspect source files. It checks formatter fixtures against `/api/format`. It checks native query and result types, core health, meta and host routes, query run and stream, analysis, execution and deep-analysis, Explorer routes, export, and cancel-token rejection behavior.

The backend phase of the official run takes the whole directory `tests/backend-functional`. A file that is not named in `run-all-tests.py` never runs. Therefore, the runner names no file.

The files that need their own configuration run against a server of the test image. The compose stack starts that server for them. These services are `chdash_otel_hosts`, `chdash_traces_allowlist`, `chdash_privileges`, `chdash_mcp_profile`, `chdash_mcp_telemetry`, `chdash_access`, `chdash_system_disabled`, `chdash_system_limits` and `chdash_embedded`. The `tests` service names them by the variables of the tables below.

With `CHDASH_REQUIRE_FIXTURES=1` (set by the compose file), a test that skips for want of one of them stops the run. The list is `STACK_INSTANCES` in `backend-functional/conftest.py`. The file `harness/test_test_suite_contract.py` fails when one of them is not in the environment of the `tests` service.

Some checks still skip in the container. These are the checks that need a command or a directory of the host (`*_CMD`, `*_DATA_DIR`). They also include the MCP and query-library instances that only their own spec and test files use. The optional `CHDASH_ALT_API_BASE_URLS` also skips.

### System page

`backend-functional/test_system.py` tests the `/api/system/...` routes, the page and the redirects of the former Explorer addresses. `backend-functional/test_system_activity.py` tests Activity and Keeper, their v2.14.0 `/api/explorer/ops/...` aliases and the `explorer.operations` key. Both files run against `chdash_source`. Two optional instances cover what one configuration cannot. These instances use the same image and the same ClickHouse. Their tests skip when the variable is not set:

| Variable | Instance |
| --- | --- |
| `SYSTEM_DISABLED_BASE_URL` | `config/system-disabled.hcl`: `system.enabled = false`; the page and its routes (the `/api/explorer/ops/...` aliases included) answer 404, `/api/version` reports `features.system.enabled = false` and the former Explorer addresses open the Explorer instead of a redirect |
| `SYSTEM_LIMITS_BASE_URL` | `config/system-limits.hcl`: `query_log_max_rows = 1000` on host `local` (Queries answer `window_too_large`), host `nolog` on `chdash_runner_nolog`, which may not read `system.query_log` (`not_granted`; the test creates the user on a server older than `01-chdash-users.sql`'s); it also sets the v2.14.0 `explorer.operations.keeper = false` (the Keeper off, Activity on) |

### The OpenTelemetry tables of each host

`backend-functional/test_otel_hosts.py` creates four hosts on the test ClickHouse. Each host has a different `observability` override (`config/otel-hosts.hcl`). The hosts are these. `main` uses the block as it is.

`alt` has its own logs and metrics tables. These are empty copies in the database `otel_alt` of `clickhouse-init/02-frontend-fixtures.sql`. `alt` has no traces. `nologs` has no logs. `denied` has logs in a database that the system user cannot read.

The test checks these points. Each request gets the tables of its host. A signal that is off for one host is off there only. The access audit names the tables of each host. Its tests skip without the instance:

| Variable | Instance |
| --- | --- |
| `OTEL_HOSTS_BASE_URL` | `config/otel-hosts.hcl` |

### The hidden spans of the trace allowlist

`backend-functional/test_trace_hidden_parents.py` shows only the `inventory` and `auth` services of the rich OTel dataset (`config/traces-allowlist.hcl`). It checks that no trace answer names a hidden span. This applies to the parents in the trace detail, the context, the span search and one span. It also applies to the link targets of linked-from and to the `missing_parents` count of the search. Its tests skip without the instance:

| Variable | Instance |
| --- | --- |
| `TRACES_ALLOWLIST_BASE_URL` | `config/traces-allowlist.hcl` |

### HTTP hardening

`backend-functional/test_http_hardening.py` checks the security headers. It checks the policy of each page shell, which uses the hashes of its inline scripts. It checks the guard of every write (403 `cross_site_request`, 415 `unsupported_media_type`). It checks the probes (`/livez`, `/readyz`), `/metrics`, the request ids, the JSON errors of the HTTP layer and the cache of a versioned asset.

`frontend/specs/http-security.spec.js` opens each page. It runs the WebAssembly kernels in the browser without one violation of the Content-Security-Policy. `smoke/release_smoke.py` checks the same headers on the release binary. The shells of that binary carry the asset versions. The script also checks that SIGTERM ends the binary with status 0. The JSON log, the metrics text, the guard and the page policy also have C++ unit tests in `native/mcp_test.cpp`.

### Privilege matrix

`backend-functional/test_privileges.py` creates one host for each way that the identities of a host can be configured too narrowly or wrongly. The test checks the routes, the hosts API (`access`, `error`) and the start log. Its tests skip without the instance:

| Variable | Instance |
| --- | --- |
| `PRIVILEGES_BASE_URL` | `config/privileges.hcl`: hosts `ok` (the control), `runnermin` (a runner with SELECT on `chdash_ui` and `chdash_repl` only), `systemnone` and `systemmin` (a system user that reads no or three system tables), `runnernone` and `bothnone` (users that connect and read nothing), `badauth` (the runner does not exist), `badsystem` (the system user does not exist), `toolnone` and `toolmin` (an MCP user that reads nothing, or `chdash_ui` only), `toolbad` (the MCP user does not exist), and `secretsrunner` and `secretstool` (the runner or the MCP user holds `displaySecretsInShowAndSelect`: the audit reports it, `runner_shows_secrets` and `mcp_shows_secrets`). A key reads one host, so the config has one key for each host that has an `mcp_uri`; the instance needs a writable `/data` for the keys that the tests make. The users are in `clickhouse-init/01-chdash-users.sql` |
| `MCP_PROFILE_BASE_URL` | `config/mcp.profile.hcl` (compose service `chdash_mcp_profile`; it has no `mcp.usage` block, so the usage of the keys is off there, and `specs/mcp-contract.spec.js` reads it for the contract of the usage that is off): MCP users whose settings profile sets `readonly`: `ro2` (`readonly = 2`, three databases), `ro2cap` (`readonly = 2`, `max_result_rows = 7`, `max_execution_time = 4`: the profile wins over the configuration, and a stricter key still lowers it) and `ro1` (`readonly = 1`: no setting can be sent). The users are in `clickhouse-init/01-chdash-users.sql` |
| `PRIVILEGES_LOGS_CMD` | optional: a command that prints the log of that instance, for the `access.finding` lines of the start |

### Server telemetry

`backend-functional/test_mcp_telemetry.py` checks the OTLP export of MCP (`docs/server-telemetry.md`). The SERVER span of a request has the correct attributes. The parent is the trace context from the headers and from `_meta`. The ClickHouse statements have child spans, and so do the statements of an API tool. No argument and no SQL is sent.

The span of a refused request is exported. A parent that is not sampled is checked too.

The test also checks that the call log is an OTLP log record. It checks that a retry after 503 works. It checks the metrics `chdash_telemetry_*`.

| Variable | Instance |
| --- | --- |
| `TELEMETRY_BASE_URL` | `config/mcp.telemetry.hcl` (compose service `chdash_mcp_telemetry`): MCP with the `telemetry` block on, a short `export_interval`, and the endpoint of the fake receiver |
| `OTLP_RECEIVER_URL` | the fake OTLP receiver (compose service `otlp_receiver`, `otel-fixture/otlp_receiver.py` in the image of the fixture): it keeps the bodies of `POST /v1/traces` and `POST /v1/logs`, gives them at `GET /received`, and answers a status that a test asks for (`POST /answer`) |

The exporter itself has C++ unit tests. They cover the queue, the batches, the drops, the retries and the stop. They use a fake receiver in the process: `native/telemetry_test.cpp` (CMake option `CHDASH_BUILD_TELEMETRY_TESTS`, target `chdash_telemetry_test`). `harness/test_native_unit_tests.py` runs it when `TELEMETRY_TEST_BINARY` names it.

### Access of humans

`backend-functional/test_access.py` checks the access of humans (`docs/access.md`; the cases U02 to U10 of section 11 of the MCP server contract). It checks the identity token. The cases are: no token, a wrong signature, a wrong `iss`, `aud`, `exp` or life value, a token in a cookie or a query parameter, and two copies of the header. It checks the list of actions and the AuthZEN requests that the PDP receives. It checks `403` on a `false` decision, on an error and on a timeout of the PDP.

The test also checks the cache of the decisions and `readonly = 1` for a run without `query.run.write`. It checks a decision for one database in the Explorer. It checks the one batch of `/api/version`, the MCP endpoint that keeps its keys, and the CLIENT span of a call to the PDP. It signs the tokens with the test keys of `config/secrets/access-identity-keys.pem`. The signing code is `backend-functional/identity_tokens.py`, which is pure Python.

| Variable | Instance |
| --- | --- |
| `ACCESS_BASE_URL` | `config/access.authzen.hcl` (compose service `chdash_access`): `access.mode = "authzen"`, a cache of 1 s, MCP with a static key, and the OTLP export to its own receiver |
| `ACCESS_PDP_URL` | the fake PDP (compose service `access_pdp`, `otel-fixture/fake_pdp.py`): it keeps each request that it receives (`GET /control/received`) and answers what a test asks (`POST /control/answer`) |
| `ACCESS_OTLP_URL` | the fake OTLP receiver of that instance (compose service `access_otlp_receiver`) |
| `ACCESS_LOGS_CMD` | optional: a command that prints the log of `chdash_access`, for the decision records (U10) |

The units below it have C++ unit tests. `native/access_test.cpp` (CMake option `CHDASH_BUILD_ACCESS_TESTS`, target `chdash_access_test`) covers them. It tests the signatures against the vectors of the RFCs and the PEM keys. It tests the identity token, the rule of each route, and the client of the PDP on a fake transport. `harness/test_native_unit_tests.py` runs it when `ACCESS_TEST_BINARY` names it. `native/config_test.cpp` tests the errors of the `access` block.

A test marked `xfail(strict)` shows an inconsistency that the matrix finds and that is not fixed yet. The test states what the code must do. When the code is fixed, the test fails as XPASS, and the mark must be removed. The matrix has no such test today.

The table card and the graph degrade on a missing grant. The names of the Explorer follow `SELECT`. A table of logs or metrics that the system user cannot read is `not_granted`, not "missing". A down host answers `host_unavailable` on every route that needs it.

The Queries tests run a tagged workload. The workload is 30 runs of one query as `chdash_runner`, with `log_comment = 'chdash-test-topq'`. The tests flush the logs. Then they query the window that these rows cover. Therefore, a fresh stack and a long-lived one give the same answers.

The Disks tests read the fixture disks and the `fixture_tiered` policy (`clickhouse-config/fixture-storage.xml`). They create a database and revoke it from the runner. They check that the runner never sees it. They also read the growth of the last 15 minutes. A fresh stack holds no more than that.

The System page has C++ unit tests below its routes (`native/system_monitor_test.cpp`, CMake option `CHDASH_BUILD_SYSTEM_TESTS`, target `chdash_system_monitor_test`). They test the SQL builders and the disk forecast of every section. They cover the ClickHouse 26.8 `DiskUsed` / `key` form, which the 26.7 stack cannot use. They also test the parsing of a request, the JSON, and the Activity and Keeper status. The status tests use a fake ClickHouse (`ChExecutor`) and a fake ACL source.

The formatted text of a query shape (`src/system_query_format.cpp`) is tested. The tests check the placeholders of normalizeQuery, which are masked and then put back. They check the `AS` padding and a placeholder that is lost. They check the service that keeps the text by host and text, on a fake formatter. `SystemService` is tested with its caches, its two accounts (system and runner) and its errors.

`harness/test_native_unit_tests.py` runs them when `SYSTEM_MONITOR_TEST_BINARY` names the built binary. `frontend/specs/system.spec.js` tests the page in the browser.

`test_system.py` is in the official backend phase (`run-all-tests.py`). It also checks `normalized_formatted` of a shape on a real ClickHouse. The cases are a SELECT with its `AS` column, a syntax error, a text that is too large, and an INSERT. The statements of the formatter are counted in `system.query_log`. Therefore, the test checks that a second request of the shape does not ask again. The two instance-dependent groups skip there.

### Query library

`backend-functional/test_query_library.py` covers the server-side query library (`docs/query-library.md`). Both instance configs declare two hosts (`local` and `other`, on the same ClickHouse). The per-host tests use them. Against `chdash_source` (feature disabled), the file only checks that every route answers 404. The other tests need dedicated instances. Without them, these tests skip:

| Variable | Instance |
| --- | --- |
| `QUERY_LIBRARY_BASE_URL` | `config/query-library.writable.hcl`, with an empty writable directory mounted at `/data` (for the browser spec: `QUERY_LIBRARY_LIVE_URL`, the compose service `chdash_qlib`) |
| `QUERY_LIBRARY_RO_BASE_URL` | `config/query-library.readonly.hcl`, with a writable `/data` (optionally holding a copy of `config/query-library.seed.json` as `query_library.json`) |
| `QUERY_LIBRARY_DATA_DIR` | the writable instance's `/data` as seen by pytest (file mode, external edit, malformed file, version 1 migration) |
| `QUERY_LIBRARY_RO_DATA_DIR` | the read-only instance's `/data` as seen by pytest (version 1 migration in memory, file untouched) |
| `QUERY_LIBRARY_RESTART_CMD` | a command that restarts the writable instance (persistence across a restart) |
| `QUERY_LIBRARY_DISABLED_BASE_URL` | optional; defaults to `API_BASE_URL` |

The test configurations hold no secret. Each password and each secret of a key is a file in `tests/config/secrets/` (`runner_password_file`, `secret_file` and the others). The compose file mounts these files at `/run/secrets/chdash-test`. A container that you start by hand needs the same mount. The examples below include it.

Example. Run these commands from the repository root, with the compose stack started. Run pytest on the host, so that the restart command can reach Docker. Run the containers as your user, so that pytest can read the 0600 file:

```bash
mkdir -p /tmp/qlib/rw /tmp/qlib/ro && cp tests/config/query-library.seed.json /tmp/qlib/ro/query_library.json
docker build -t chdash-qlib:local -f tests/Dockerfile.source .
docker run -d --name chdash-qlib --network chdash-tests_default --user "$(id -u):$(id -g)" -p 127.0.0.1:18471:8080 \
  -e CHDASH_CONFIG_FILE=/config/chdash.hcl -v "$PWD/tests/config/query-library.writable.hcl:/config/chdash.hcl:ro" -v "$PWD/tests/config/secrets:/run/secrets/chdash-test:ro" \
  -v /tmp/qlib/rw:/data chdash-qlib:local
docker run -d --name chdash-qlib-ro --network chdash-tests_default --user "$(id -u):$(id -g)" -p 127.0.0.1:18472:8080 \
  -e CHDASH_CONFIG_FILE=/config/chdash.hcl -v "$PWD/tests/config/query-library.readonly.hcl:/config/chdash.hcl:ro" -v "$PWD/tests/config/secrets:/run/secrets/chdash-test:ro" \
  -v /tmp/qlib/ro:/data chdash-qlib:local
cd tests && QUERY_LIBRARY_DISABLED_BASE_URL=http://127.0.0.1:18080 \
  QUERY_LIBRARY_BASE_URL=http://127.0.0.1:18471 QUERY_LIBRARY_RO_BASE_URL=http://127.0.0.1:18472 \
  QUERY_LIBRARY_DATA_DIR=/tmp/qlib/rw QUERY_LIBRARY_RO_DATA_DIR=/tmp/qlib/ro QUERY_LIBRARY_RESTART_CMD="docker restart -t 2 chdash-qlib" \
  python3 -m pytest -q backend-functional/test_query_library.py
```

The statements and the connections of ChDash have C++ unit tests (`native/ch_query_test.cpp`, CMake option `CHDASH_BUILD_CH_QUERY_TESTS`, target `chdash_ch_query_test`). Without a server, the tests check the settings that a statement gets from its scope and from the settings profile of the user.

With `CHDASH_TEST_CLICKHOUSE_URI` (for example `clickhouse://test:test@clickhouse:9000` on the network of the test stack), the tests also check these points. A statement that a callback interrupts never leaves its packets to the next lease. A callback that stops the read keeps its connection. The settings reach ClickHouse. The deadline and the cancel stop a statement before it is sent. The pool bounds its leases.

`harness/test_backend_code_rules.py` holds the structural rules. No statement and no connection may exist outside `src/ch_query.cpp`. Every `/api` route must run in a query scope.

The path of a result to the browser has C++ unit tests (`native/result_path_test.cpp`, CMake option `CHDASH_BUILD_RESULT_TESTS`, target `chdash_result_path_test`). They test the JSON cell encoder against the generic algorithm. A ratio budget applies to Map cells. They also test the thread that encodes the blocks.

They also test the units that a run builds on these parts. These units are the plan of the columns and the SQL that wraps a statement (`src/query_result_plan.cpp`), the events of a result (`src/query_result_events.cpp`), and the cost that the ProfileEvents packets report (`src/query_run_profile.cpp`).

`harness/test_native_unit_tests.py` runs the binary when `RESULT_PATH_TEST_BINARY` names it. The performance phase has the case `select_weather_buffer_120k` (120,064 rows with nested columns). It has a budget on the JSON encoding time that the `done` event reports (`timing_ms.encode`). `frontend/specs/streaming.spec.js` holds the budget of the stream reader (a ratio to `EventSource`) and the tests of the Elapsed tile.

The C++ unit tests of the library (`native/query_library_test.cpp`, CMake option `CHDASH_BUILD_QUERY_LIBRARY_TESTS`) cover two areas. The first is the store, which the tests run on a temporary file. The second is the units below the store, which use no file. These units are the reading of a request, the rules of the tree, and the import (`src/query_library_*.cpp`). `harness/library_sources.py` reads these sources for the structural rules of `harness/test_backend_code_rules.py`. `harness/test_native_unit_tests.py` runs them when `QUERY_LIBRARY_TEST_BINARY` names the built `chdash_query_library_test`.

### MCP

`backend-functional/test_mcp.py` covers the MCP endpoint, its keys and its startup errors (`docs/mcp.md`). Against `chdash_source` (MCP disabled), the file only checks that every route answers as documented. The other tests need dedicated instances. Without them, these tests skip:

| Variable | Instance |
| --- | --- |
| `MCP_BASE_URL` | `config/mcp.hcl`, with an empty writable directory mounted at `/data`: it holds the key file and the usage file of the instance (`chdash-mcp-test.jsonl.zst`, the instance of `mcp.usage`; `all_keys` is on, so a key that names `mcp_analysis_all_usage` reads the usage of every key), and the tests put the files of other instances there |
| `MCP_DATA_DIR` | that `/data` as seen by pytest (file mode, hashes only, storage errors, the usage files: the `zstd` command of the tests image reads them) |
| `MCP_RESTART_CMD` | a command that restarts that instance (keys survive a restart) |
| `MCP_LOGS_CMD` | a command that prints the log of that instance (the records `mcp.call` of the call log) |
| `MCP_RO_BASE_URL` | `config/mcp.readonly.hcl`, with a writable directory at `/data` that holds a copy of `config/mcp.seed.json` as `mcp_keys.json`. The file has the older forms (`manage_from_ui = false`, a `key` block): the mode is `static`, so the key of the file gets 401 (the usage of the keys is on there too: `chdash-mcp-ro.jsonl.zst`, with `all_keys` off: `cfg-reader` names `mcp_analysis_all_usage` and still does not have it) |
| `MCP_RO_DATA_DIR` | that directory as seen by pytest |
| `MCP_NOSTORAGE_BASE_URL` | `config/mcp.nostorage.hcl`: config keys only, and the usage of the keys is off (its key names `mcp_analysis_all_usage`, which is then `not_enabled`, and the tools of the usage are not offered) |
| `MCP_STARTUP_CMD` | a command that runs the real binary on a config file, with `{dir}` and `{name}` (the startup errors) |
| `MCP_STARTUP_CONFIG_DIR` | where the binary sees `{dir}` (default `/cfg`) |
| `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` | an admin account: the tests make the database `mcp_scratch` and grant it to `chdash_mcp` |

The ClickHouse user `chdash_mcp` comes from `clickhouse-init/01-chdash-users.sql`. On a volume that exists already, run the `chdash_mcp` statements of that file once with the admin account. You can also run the backend tests without `CHDASH_FIXTURE_RESET=never`, because the fixture reset applies them.

```bash
mkdir -p /tmp/mcp/rw /tmp/mcp/ro && cp tests/config/mcp.seed.json /tmp/mcp/ro/mcp_keys.json
docker build -t chdash-mcp:local -f tests/Dockerfile.source .
docker run -d --name chdash-mcp --network chdash-tests_default --user "$(id -u):$(id -g)" -p 127.0.0.1:18120:8080 \
  -e CHDASH_CONFIG_FILE=/config/chdash.hcl -v "$PWD/tests/config/mcp.hcl:/config/chdash.hcl:ro" -v "$PWD/tests/config/secrets:/run/secrets/chdash-test:ro" -v /tmp/mcp/rw:/data chdash-mcp:local
docker run -d --name chdash-mcp-ro --network chdash-tests_default --user "$(id -u):$(id -g)" -p 127.0.0.1:18121:8080 \
  -e CHDASH_CONFIG_FILE=/config/chdash.hcl -v "$PWD/tests/config/mcp.readonly.hcl:/config/chdash.hcl:ro" -v "$PWD/tests/config/secrets:/run/secrets/chdash-test:ro" -v /tmp/mcp/ro:/data chdash-mcp:local
docker run -d --name chdash-mcp-ns --network chdash-tests_default -p 127.0.0.1:18122:8080 \
  -e CHDASH_CONFIG_FILE=/config/chdash.hcl -v "$PWD/tests/config/mcp.nostorage.hcl:/config/chdash.hcl:ro" -v "$PWD/tests/config/secrets:/run/secrets/chdash-test:ro" chdash-mcp:local
cd tests && MCP_BASE_URL=http://127.0.0.1:18120 MCP_DATA_DIR=/tmp/mcp/rw MCP_RESTART_CMD="docker restart -t 2 chdash-mcp" \
  MCP_LOGS_CMD="docker logs chdash-mcp 2>&1" MCP_RO_BASE_URL=http://127.0.0.1:18121 MCP_RO_DATA_DIR=/tmp/mcp/ro \
  MCP_NOSTORAGE_BASE_URL=http://127.0.0.1:18122 CLICKHOUSE_URL=http://127.0.0.1:18123 \
  MCP_STARTUP_CMD='docker run --rm -v {dir}:/cfg:ro --entrypoint /app/chdash chdash-mcp:local --config /cfg/{name}' \
  python3 -m pytest -q backend-functional/test_mcp.py
```

The server caches and the runner ACL have C++ unit tests (`native/cache_acl_test.cpp`, CMake option `CHDASH_BUILD_CACHE_TESTS`, target `chdash_cache_acl_test`). These tests use a fake monotonic clock and a fake ClickHouse identity. They cover these units.

`TtlCache` has single-flight, stale-while-revalidate, `refresh=1` and invalidation that keep one read per key, failures that are never values, LRU bounds in entries and bytes, and purge. The ACL discovery and `AclService` treat only `ACCESS_DENIED` as "not readable". A transport error is no answer. An object in error is left out alone. The budgets report `truncated`. There is one answer per identity.

`DdlTextCache` is per identity, reads 2,000 names at most, and is bounded. `FormatCache` compares the text on a hit.

`backend-functional/test_acl_and_caches.py` checks what the routes show of them.

The C++ unit tests (`native/mcp_test.cpp`, CMake option `CHDASH_BUILD_MCP_TESTS`, target `chdash_mcp_test`) cover the scopes, the keys and their file. They cover the usage of the keys (`src/mcp_usage.cpp`, `src/mcp_usage_state.cpp`, `src/mcp_usage_store.cpp`). This usage includes the counts and their cells, the method and the client of a request, and the caps. It also includes the windows and the six tiers that the code reads, the clients, the deleted keys, and the JSON Lines zstd files of an instance. It also includes the overview of all the keys, with its filters and its facets.

The tests also cover the instances that share a directory. The cases are merging, the instance as a dimension, skipped files and their bounds, conflicts and gone instances. The tests also cover the rate limit, the SQL splitter and builder, and the protocol and the tools with fakes. The context that the tools share is `src/mcp_tool_support.cpp`. The tools are in `src/mcp_tools_<family>.cpp`.

The eight startup errors are tested with the real configuration loader. The usage block is the eighth error.

`native/config_test.cpp` has the keys of `mcp.usage` among the table of keys. `harness/test_native_unit_tests.py` runs the binary when `MCP_TEST_BINARY` names it.

The text of a statement has C++ unit tests (`native/sql_test.cpp`, CMake option `CHDASH_BUILD_SQL_TESTS`, target `chdash_sql_test`). They cover these units. The literals and names that ChDash writes into SQL are in `sql_literal.hpp`. The one lexer is in `sql_lexer.hpp`. It handles comments, quotes, `$$` text and Unicode spaces.

The other units are the `KILL QUERY` policy, the MCP SQL scan, and the lineage of a view. The format service is tested with a fake port. The test covers its batch, with a status for each statement.

The test also compares the lexer with the WebAssembly kernels of the page (`src/wasm/highlight.c` and `sqlscan.c`, built natively by `native/wasm_kernel_*.c`). The comparison uses 6,000 generated scripts.

The same test reads `frontend/model/sql-lex-vectors.json`. This file holds the cases of the one SQL lexer of the page. The kernels give its answers. The lexer of the backend gives the same answers, except on the texts marked `differs`. These texts show the differences from ClickHouse that are intended.

The configuration has `native/config_test.cpp` (option `CHDASH_BUILD_CONFIG_TESTS`, target `chdash_config_test`). It tests the table of keys, the bounds, the defaults, the HCL parser and the URIs. The error answer has `native/error_test.cpp` (option `CHDASH_BUILD_ERROR_TESTS`, target `chdash_error_test`). It tests the envelope, the classification of a ClickHouse failure by its code, and the parameters of a route.

The way a request is served has `native/request_test.cpp` (option `CHDASH_BUILD_REQUEST_TESTS`, target `chdash_request_test`). It tests admission, the request context, the routes that run in the process, the pending exports and the jobs of Deep Analyze.

The Traces page has `native/trace_test.cpp` (option `CHDASH_BUILD_TRACE_TESTS`, target `chdash_trace_test`). It tests the parsing of a request, the span filters and the statements of every route. The statements are compared with the text that the code wrote before the split of `api_traces.cpp` (`native/trace_golden.hpp`). It also tests the strategies of the search and of the charts on a fake ClickHouse (`ChExecutor`), and the service with its errors and its JSON.

The Metrics page has `native/metrics_test.cpp` (option `CHDASH_BUILD_METRICS_TESTS`, target `chdash_metrics_test`). It tests the parsing of a request and the statements of every route. The statements are compared with the text that the code sent before the split of `api_metrics.cpp` (`native/metrics_golden.hpp`). It also tests the cells, the merge and the quantiles of the histograms, the choice of the aggregations, and the service on a fake ClickHouse with its JSON.

The Explorer has `native/explorer_test.cpp` (option `CHDASH_BUILD_EXPLORER_TESTS`, target `chdash_explorer_test`). It tests every statement. The statements are compared with the text that the code sent before the split (`native/explorer_golden.hpp`). On a fake ClickHouse, it tests the rules on the rows that were read, the readers of the catalog, the sidebar, the storage map, the card of a table, the functions and the preview. It also tests the TTL parser, the graph builder and the JSON of each answer.

The scope of the graph is compared with the old implementation. That implementation is kept in `native/explorer_scope_reference.hpp`, and the comparison uses generated graphs. The service with its errors is tested too.

The tests of the pages share `native/native_check.hpp` (the checks) and `native/fake_executor.hpp` (the fake `ChExecutor`). `tests/sanitize/run-native-tests.sh` runs all of them under the sanitizers.

The Logs page has `native/logs_test.cpp` (option `CHDASH_BUILD_LOGS_TESTS`, target `chdash_logs_test`). It tests the terms and tokens of a search, the SQL of a term, the masking of a message, the Drain templates, the parsing of a request, and the filters against the schema of the table. It tests the statements of every route. The statements are compared with the text that the code sent before the split of `api_logs.cpp` (`native/logs_golden.hpp`).

It also tests the mining of the patterns. The service runs on a fake ClickHouse with a clock that the test sets. The tests check the budget of a search, the cache of the facets and the JSON.

## Frontend functional

**Instances of the browser specs.** The MCP page and the query library are tested against in-memory fakes behind `page.route` (`helpers/mcp-fake.js`, the library fake of `query-library.spec.js`). Therefore, the page specs run on any instance. Two more servers of the test image check the fakes against the real thing: `chdash_mcp` (`config/mcp.hcl`) and `chdash_qlib` (`config/query-library.writable.hcl`). Each has a volume of its own.

`specs/mcp-contract.spec.js` (`MCP_CONTRACT_BASE_URL`, and `MCP_PROFILE_BASE_URL` for the usage that is off) sends the same calls to the real MCP routes and to the fake. It compares the shape of each answer (`helpers/shape.js`). The shape covers the usage with its `instances` and its `elsewhere` flags. It covers the overview with the instance as a dimension, its `order` and its `rankings`. The `orders` that the six charts of the Usage tab request come in one read. It covers the catalog of the tools with its `always` / `explicit_only` / `available` flags, and the 404 `not_enabled` of an instance whose usage is off.

The spec then drives the real page. It tests the config keys, a key made in the page with its secret shown once, and its deletion.

Several instances that share a usage directory cannot be made from a page. `specs/a11y-contract.spec.js` therefore runs its axe checks against the same fake. It checks the Instance list of the Usage tab, the note of the usage of a key and its list, their warnings, and the usage that is off. The real instance serves the Usage tab. Its bar, its lists and its six charts are checked with their legends in both modes. The New key form with its MCP analysis card and the keys are checked too.

The live check of `query-library.spec.js` (`QUERY_LIBRARY_LIVE_URL`) runs the page against the real library. A spec that needs an instance and does not get its variable skips. `CHDASH_REQUIRE_FIXTURES=1` (set by the compose file for the `tests` service) makes that a failure. Every browser run lists its skipped tests (`skipped.json`, `helpers/skip-reporter.js`). The official run fails above `CHDASH_MAX_SKIPS` (0 for the functional and embedded phases). To run one by hand, use `docker run -d --network chdash-tests_default -v $PWD/tests/config/mcp.hcl:/config/chdash.hcl:ro -v <volume>:/data -e CHDASH_CONFIG_FILE=/config/chdash.hcl chdash-tests-source:local`, then set `MCP_CONTRACT_BASE_URL=http://<container>:8080`.

**Streamed export.** `specs/export-protocol.spec.js` runs the handshake and the download of `docs/massive-export.md`. It uses the page's own `fetch`. It reads the ZIP64 archive with `helpers/zip.js`. The pages do not use the export. The spec shows the browser's view of the guards. These guards are: no token in an address, GET 405, one use of a token, and a refused form or fetch from another site.

**Leaks.** `helpers/leaks.js` counts what a view binds and must release. These items are: event listeners (window, document, connected nodes, media queries), the targets of `ResizeObserver`, `IntersectionObserver` and `MutationObserver`, `setInterval` timers, workers, event sources and broadcast channels. `specs/leak-tracker.spec.js` tests the tracker. `specs/ui-layers.spec.js` runs rounds that search, change the range and open panels. It does this in one page of each Observability view. The counts after the last round must equal the counts after the second round.

Playwright checks interactions and behavior only. It does not capture design-review screenshots. It does not fail because a page looks poor. Runtime page errors are still functional failures.

## Performance

The cases are hardcoded in:

```text
tests/performance/cases.json
```

The cases currently include SELECTs, aggregation, `CREATE TABLE`, `INSERT` and reads of inserted data. The measured result is written to:

```text
performance/actual.json
```

The repository baseline is:

```text
tests/performance/expected.json
```

It now contains the first approved local Docker baseline envelope, from 2026-09-05. Performance failures use the per-case `median_ms_max` and `p95_ms_max` limits. The limits leave headroom above the first measured run on purpose. Therefore, normal Docker scheduling noise does not create flaky failures.

The expected metrics use per-case maximums, for example:

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

The design phase is separate from the frontend functional tests. It captures deterministic states on three desktop viewports. It records these items:

- full-page screenshots;
- horizontal overflow;
- elements outside the viewport;
- clipped text candidates;
- controls smaller than 32 px;
- overlapping controls;
- font/radius/color/spacing token counts;
- axe accessibility findings;
- Playwright traces and videos of the retry, when a capture itself fails. With `PW_ARTIFACTS=full`, the phase records them for every failure.

Design heuristics are report signals. They are not aesthetic pass or fail rules. Two hard gates apply next to them. Any axe violation fails the run. `specs/accessibility.spec.js` covers Query, analysis and Explorer. `specs/a11y-contract.spec.js` covers every other page and state.

`specs/visual-regression.spec.js` compares the Query page with a result. It uses the PNGs of `tests/frontend/snapshots/<viewport>/`. The pinned Playwright image on linux/amd64 creates the PNGs. The volatile figures of the page are replaced by a fixed text. The comparison is exact. `VISUAL_COMPARE=0` skips it.

After an intended change of the look, run `npm run snapshots:update` in the test container (`tests/frontend`). Then commit the new PNGs. The analysis modal and the Explorer have no baseline. Their figures depend on the state of the server.

## Sanitizers, static analysis and the release smoke test

These checks find defects that the functional tests do not see. Examples are a dangling reference, a heap overflow, a leak, undefined behavior, a data race, a parser crash on a strange input, and a bug that only the release binary has. They need Docker only.

### Sanitizers

`tests/Dockerfile.sanitize` builds the server and the native tests with clang 19, AddressSanitizer and UndefinedBehaviorSanitizer (CMake option `CHDASH_SANITIZE=address,undefined`, `src/BuildFlags.cmake`). Its targets are `native` (the native unit tests, `tests/sanitize/run-native-tests.sh`) and `sanitized` (the server). The build uses `CHDASH_WERROR=ON`.

- AddressSanitizer covers all code, and the dependencies too. It runs with `detect_leaks=1`, `strict_string_checks=1` and `detect_stack_use_after_return=1`. `tests/sanitize/lsan.supp` lists the accepted leaks (the file is empty).
- UndefinedBehaviorSanitizer covers our code only, and a finding stops the process (`-fno-sanitize-recover=undefined`). The vendored lz4 of clickhouse-cpp adds 0 to a null pointer for an empty block. That finding is not ours to fix.
- Every build ends the server cleanly on SIGTERM and SIGINT (`src/main.cpp`, docs/operations.md "Shutdown"). The destructors run, so with `address` LeakSanitizer reports at exit.

`tests/tools/sanitize.sh` builds the images and runs the tests:

| Command | What runs |
| --- | --- |
| `native` | `chdash_query_library_test`, `chdash_system_monitor_test`, `chdash_mcp_test`, `chdash_result_path_test`, `chdash_format_depth_test`, `chdash_format_test`, `chdash_cache_acl_test`, `chdash_telemetry_test`, `chdash_access_test` and `chdash_ch_query_test` (with its server cases when the network of the test stack exists) |
| `backend` | the sanitized server next to the test ClickHouse, then the format and type checks of `tests/api`, `tests/backend-functional` (the whole directory) and `tests/harness` against it |
| `frontend` | Playwright (`desktop-1440`) on `page-per-view`, `query-library`, `observability`, `system` and `explorer-nav` against the sanitized server |
| `load` | `tests/sanitize/load.py` against the sanitized server: 12 clients for 90 s (`CHDASH_LOAD_WORKERS`, `CHDASH_LOAD_SECONDS`) run queries that they read, drop or cancel, exports, formats and the cached pages |
| `all` | `native`, `backend`, `load` and `frontend` |

The script stops the server with SIGTERM after the tests. It fails in three cases. In the first case, a test fails. In the second case, the server log holds `AddressSanitizer`, `LeakSanitizer` or `runtime error:`. In the third case, the server exits with a code other than 0.

On a shared host, set `CHDASH_SANITIZE_PREFIX` (the names of the image and the container), `CHDASH_SANITIZE_PORT` and `CHDASH_FIXTURE_RESET=never`. The header of the script lists the variables.

The `sanitize.yml` workflow runs `native`, `backend` and `frontend` on request. It starts the ClickHouse services of `docker-compose.yml`. It keeps the server log as the `sanitize-logs` artifact. The backend and harness run takes about 2 minutes on a server that is not loaded. The Playwright subset takes about 2 minutes. Both fit in a pull request run.

### ThreadSanitizer

`CHDASH_SANITIZE=thread` builds the same targets with ThreadSanitizer (`--build-arg CHDASH_SANITIZE=thread`, CMake `CHDASH_SANITIZE=thread`). ThreadSanitizer covers all code, and the dependencies too. A race shows only when both sides are instrumented. ThreadSanitizer cannot be combined with AddressSanitizer. By default, the images and containers are named `chdash-tsan`.

```bash
CHDASH_SANITIZE=thread tests/tools/sanitize.sh native
CHDASH_SANITIZE=thread tests/tools/sanitize.sh backend
CHDASH_SANITIZE=thread tests/tools/sanitize.sh load
```

A race is written to the server log (`WARNING: ThreadSanitizer`). The server continues and exits with code 25 at the end (`TSAN_OPTIONS=halt_on_error=0:exitcode=25`). One run therefore shows every race. The script fails on such a log line and on the exit code.

`tests/sanitize/tsan.supp` lists the accepted reports. The file is empty. The `tsan` job of `sanitize.yml` runs `native`, `backend` and `load`.

The `backend` tests send one request at a time. The races are in the shared state of concurrent requests (the caches, the client pool, the query registry, a session that the browser drops). `load` makes that traffic.

### Fuzzing

`tests/fuzz` holds one libFuzzer target for each parser of untrusted text and for each WebAssembly kernel:

| Target | Code | Checks besides a crash or a sanitizer finding |
| --- | --- | --- |
| `json_parse` | `parse_json_bounded` (`src/json_parse.hpp`), the parse of every request body | the depth bound holds; a parsed text, written again, parses to the same value |
| `format` | the SQL formatter without ClickHouse: `postprocess_format_query`, the masks and the restore passes of `src/sql_scan.hpp`, `unwrap_alter_table_commands`, and `FormatBatch` on a fake ClickHouse | no input takes more than 25 s (the formatter gives up after 2 s); a warning gives the text as written; the place of an error is in the text |
| `user_sql_policy` | `user_sql_is_forbidden` (no direct `KILL QUERY`) | a script that starts with `KILL QUERY` is refused; text after a refused script does not make it accepted |
| `mcp_sql` | `mcp_scan_single_statement`, the quoting functions and `mcp_build_table_query` of `src/mcp_sql.cpp` | an accepted statement is accepted again alone; a quoted value never ends a statement; a built `SELECT` passes the scan |
| `hcl` | `parse_hcl` (`src/hcl.cpp`), the parser of the configuration file | the parser fails only with `HclParseError` |
| `wasm_<kernel>` | each kernel of `src/wasm` built natively (`tests/fuzz/wasm_native_rt.h`: one `malloc` block for each allocation, so AddressSanitizer sees the end of each block) | the results are inside their buffers and in order (tokens, rows, permutations) |

The kernel targets use the inputs that the adapter of the page gives (`src/static/app_wasm_<kernel>.js`). The coordinates of the graph kernels stay finite and below 1e7. Past 2^31, a double to int conversion is undefined in C. In WebAssembly, it saturates (`-mnontrapping-fptoint`). Therefore, a native report there does not apply to the browser.

`tests/tools/fuzz.sh` builds the `fuzz` stage of `tests/Dockerfile.sanitize` (clang 19, `CHDASH_BUILD_FUZZERS=ON`, AddressSanitizer and UndefinedBehaviorSanitizer) and runs `tests/fuzz/run-fuzzers.sh` in it:

```bash
tests/tools/fuzz.sh                    # every target, 60 s each, several at a time
tests/tools/fuzz.sh 900 format         # one target for 15 minutes
CHDASH_FUZZ_JOBS=2 tests/tools/fuzz.sh # two targets at a time
```

Each target starts from `tests/fuzz/corpus/<target>`. The HCL target also starts from `config.example.hcl` and `tests/config/*.hcl`. Each target uses the dictionary of its language (`tests/fuzz/*.dict`). The corpus grows in `/tmp/chdash-fuzz/<target>/corpus` (`CHDASH_FUZZ_OUT`). The next run starts from it.

A finding is a file `crash-*`, `leak-*`, `timeout-*` or `oom-*` next to `fuzz.log`. The script then exits with status 1. To replay a finding, run the target on the file:

```bash
docker run --rm -v /tmp/chdash-fuzz/format:/in:ro --entrypoint /work/fuzz/chdash_fuzz_format chdash-fuzz:local /in/crash-<sha1>
```

When you fix a finding, add its input to `tests/fuzz/corpus/<target>/`. The `fuzz` job of `sanitize.yml` runs every target for 60 s and keeps the findings as the `fuzz-findings` artifact.

Two tests of `test_routes.py` and four Playwright tests (`explorer-nav`, `explorer-storage` and `functional` specs) need the fixture state of a fresh reset. This state holds the Buffer and Memory tables. These tests fail on any server, sanitized or not, when a long-running stack has flushed the fixtures.

### clang-tidy

`.clang-tidy` selects the checks. `tests/tools/clang-tidy.sh` runs them on `src/*.cpp` through the CMake compile database (`CMAKE_EXPORT_COMPILE_COMMANDS`). It uses clang 19. The `chdash-tidy-build` volume keeps the dependencies. Any finding fails the run.

The `clang-tidy.yml` workflow runs on each pull request, on `main` and every week. A pull request checks the changed `.cpp` files. It checks all files when a header or a build file changes.

### Dangling captures

`tools/check_handler_captures.py` finds a `[&]` lambda in a function that uses a local of that function (the v2.16.3 bug). `tests/harness/test_dangling_capture_check.py` runs it on `src/server.cpp` and on the code of v2.16.3 (`946ba81^`), and the `clang-tidy.yml` workflow runs it too.

### Release smoke test

`tests/smoke/release_smoke.py --binary <chdash> [--scratch]` starts a release binary with `tests/smoke/release-smoke.hcl`. In that file, every page is on and ClickHouse is unreachable. The script then probes the routes. These routes are the pages, the redirects, `/api/version` (the features), `/api/health`, the query library and the static files (`?v=`, immutable, gzip).

The script fails when a route gives a wrong status, `Location` or type. It also fails when the server stops. `--scratch` runs the binary in a `FROM scratch` container, like the shipped image.

`tests/smoke/Dockerfile.release` builds the binary as the release workflow does. It uses Zig 0.15.2 with a checked SHA-256, musl, static-pie, the hardening flags, embedded files and stripping.

Before the strip, `tests/smoke/check_release_binary.sh` checks these points. The binary is static-pie and needs no shared library. It has full RELRO, a stack that is not executable, and the stack protector.

`release.yaml` runs both checks on each Linux binary. It runs the smoke test on each macOS binary, before the upload. `release-smoke.yml` builds and probes the binary on each pull request. `tests/harness/test_release_smoke.py` tests the script against a fake server with the 2.16.3 answer.

`tests/tools/release-backend.sh` runs `tests/backend-functional` and the format and type checks of `tests/api` against the release binary. It builds the `runtime` target of `tests/smoke/Dockerfile.release`. That target holds the binary alone in a `FROM scratch` image. The script starts the image next to the test ClickHouse stack. It fails when a test fails or the server stops. The `backend` job of `release-smoke.yml` runs it on each pull request.

## Cleanup

```bash
docker compose --profile test down -v --remove-orphans
```
