# SQL format test harness

This test harness validates SQL fixtures against the formatter API and captures the raw syntax rewrite returned directly by ClickHouse.

It does not treat the formatter response as the only source of truth for parser rewrites. After each `/api/format` call, it sends the formatted SQL to ClickHouse with `EXPLAIN SYNTAX` and stores the raw ClickHouse response body under a mounted volume.

## What it does

For each file in `format/sql`:

1. Reads the expected formatted SQL fixture.
2. Compacts it into a single-line input payload.
3. Sends it to `/api/format`.
4. Optionally rewrites the fixture when the formatter output changed structurally.
5. Asserts the formatter output matches the fixture.
6. Sends the formatted SQL directly to ClickHouse with `EXPLAIN SYNTAX`.
7. Saves the raw ClickHouse response body under `artifacts/sql_raw`.

## Why ClickHouse is queried directly

The formatter API already returns a rewritten SQL string. That is useful for fixture validation, but it is not enough when you want to inspect how ClickHouse itself normalizes or rewrites the query.

The raw files in `artifacts/sql_raw` therefore come from ClickHouse itself, not from the formatter API response.

## Updating fixtures

If the formatter now removes redundant parentheses or applies structural rewrites in addition to indentation, run with `UPDATE_EXPECTED_SQL=1`.

That mode rewrites the SQL fixtures under `format/sql` with the exact formatter output returned by the API.

## Docker Compose

The provided `docker-compose.yml` starts:

- `clickhouse`: disposable ClickHouse instance used for direct syntax parsing.
- `format-tests`: the pytest runner.

The test runner assumes the formatter API already exists and is reachable through `API_BASE_URL`.

By default the compose file targets `http://host.docker.internal:8080`, which works when the formatter API is running on the host machine.

## Run

```bash
docker compose up --build --abort-on-container-exit --exit-code-from format-tests
```

## Common environment variables

```bash
API_BASE_URL=http://host.docker.internal:8080
API_HEALTH_PATH=/api/health
UPDATE_EXPECTED_SQL=0
ASSERT_CLICKHOUSE_SUCCESS=1
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_RAW_DIR=/artifacts/sql_raw
```

## Volumes

The compose file mounts:

- `./format/sql:/tests/format/sql` so fixture updates persist locally.
- `./artifacts/sql_raw:/artifacts/sql_raw` so raw ClickHouse syntax outputs persist locally.

Each query writes its raw ClickHouse response to:

```text
artifacts/sql_raw/<sql-file-stem>.sql
```
