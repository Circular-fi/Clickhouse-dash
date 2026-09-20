#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import random
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from generate_otel_traces import NS, generate_trace

BASE_URL = os.environ.get("CLICKHOUSE_HTTP_URL", "http://clickhouse:8123").rstrip("/")
USER = os.environ.get("CLICKHOUSE_USER", "test")
PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "test")
TRACE_COUNT = int(os.environ.get("OTEL_FIXTURE_TRACES", "10000"))
MIN_SPANS = int(os.environ.get("OTEL_FIXTURE_MIN_SPANS", "60"))
MAX_SPANS = int(os.environ.get("OTEL_FIXTURE_MAX_SPANS", "90"))
SEED = int(os.environ.get("OTEL_FIXTURE_SEED", "20260918"))
ERROR_RATE = float(os.environ.get("OTEL_FIXTURE_ERROR_RATE", "0.0002"))
SPREAD_MINUTES = int(os.environ.get("OTEL_FIXTURE_SPREAD_MINUTES", "55"))
BATCH_TRACES = int(os.environ.get("OTEL_FIXTURE_BATCH_TRACES", "100"))
INSERT_TIMEOUT = int(os.environ.get("OTEL_FIXTURE_INSERT_TIMEOUT_SECONDS", "1800"))
FORCE = os.environ.get("OTEL_FIXTURE_FORCE", "0").strip().lower() in {"1","true","yes","on"}
KEEPALIVE = os.environ.get("OTEL_FIXTURE_KEEPALIVE", "0").strip().lower() in {"1","true","yes","on"}

# Small fixtures may keep the Python generator for event/link UI coverage.
# The SQL generator has one production-shaped implementation only: optimized
# rich rows generated server-side with numbers_mt(). Multiple independent OS
# processes issue ClickHouse INSERT loops concurrently so a local benchmark can
# actually use the available CPU/I/O instead of waiting on one query at a time.
GENERATOR = os.environ.get("OTEL_FIXTURE_GENERATOR", "auto").strip().lower()
SQL_THRESHOLD = int(os.environ.get("OTEL_FIXTURE_SQL_THRESHOLD", "50000"))
SQL_CHUNK_TRACES = int(os.environ.get("OTEL_FIXTURE_SQL_CHUNK_TRACES", "2000000"))
SQL_TARGET_SPANS_PER_CHUNK = int(os.environ.get("OTEL_FIXTURE_SQL_TARGET_SPANS_PER_CHUNK", "10000000"))
SQL_PROCESSES = int(os.environ.get("OTEL_FIXTURE_SQL_PROCESSES", "4"))
SQL_MAX_THREADS = int(os.environ.get("OTEL_FIXTURE_SQL_MAX_THREADS", "0"))


def request(query: str, body: bytes = b"", timeout: int = 60) -> bytes:
    url = f"{BASE_URL}/?{urllib.parse.urlencode({'query': query})}"
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("X-ClickHouse-User", USER)
    req.add_header("X-ClickHouse-Key", PASSWORD)
    if body:
        req.add_header("Content-Type", "application/octet-stream")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"ClickHouse HTTP {exc.code}: {detail}") from exc


def wait_ready() -> None:
    print("OTEL fixture: waiting for ClickHouse", flush=True)
    deadline = time.time() + 120
    last_error = ""
    while time.time() < deadline:
        try:
            if request("SELECT 1", timeout=3).strip() == b"1":
                print("OTEL fixture: ClickHouse is ready", flush=True)
                return
        except Exception as exc:
            last_error = str(exc)
        time.sleep(1)
    raise RuntimeError(f"ClickHouse did not become ready: {last_error}")


def active_rows(table: str) -> int:
    value = request(
        "SELECT coalesce(sum(rows), 0) FROM system.parts "
        f"WHERE active AND database = 'otel' AND table = '{table}'"
    ).decode().strip()
    return int(value or "0")


def existing_fixture_counts() -> tuple[int, int]:
    """Return physical span/index rows without scanning fixture data."""
    try:
        value = request(
            "SELECT count() FROM system.tables "
            "WHERE database = 'otel' AND name IN ('otel_traces','otel_traces_trace_id_ts')"
        ).decode().strip()
        if value != "2":
            return 0, 0
        return active_rows("otel_traces"), active_rows("otel_traces_trace_id_ts")
    except Exception:
        return 0, 0

PROJECTION_INDEXES = (
    (
        "otel_traces",
        "prj_traceid",
        "ALTER TABLE otel.otel_traces ADD PROJECTION IF NOT EXISTS prj_traceid INDEX TraceId TYPE basic",
    ),
    (
        "otel_traces_trace_id_ts",
        "prj_start",
        "ALTER TABLE otel.otel_traces_trace_id_ts ADD PROJECTION IF NOT EXISTS prj_start INDEX Start TYPE basic",
    ),
)


def ensure_projection_indexes(*, materialize_existing: bool = True) -> None:
    """Keep persistent test volumes compatible with the init-time schema."""
    for table, projection, statement in PROJECTION_INDEXES:
        exists = request(
            "SELECT count() FROM system.projections "
            f"WHERE database = 'otel' AND table = '{table}' AND name = '{projection}'"
        ).decode().strip()
        if exists == "1":
            continue

        print(f"OTEL fixture: adding missing projection {table}.{projection}", flush=True)
        request(statement)

        rows = active_rows(table)
        if materialize_existing and rows > 0:
            print(
                f"OTEL fixture: materializing {table}.{projection} for {rows} existing rows",
                flush=True,
            )
            request(
                f"ALTER TABLE otel.{table} MATERIALIZE PROJECTION {projection} "
                "SETTINGS mutations_sync = 1",
                timeout=INSERT_TIMEOUT,
            )


def reset_fixture_data() -> None:
    print("OTEL fixture: clearing existing OTEL fixture rows", flush=True)
    request("TRUNCATE TABLE otel.otel_traces_trace_id_ts")
    request("TRUNCATE TABLE otel.otel_traces")


def append_span_rows(buffer: bytearray, spans) -> None:
    for span in spans:
        buffer.extend(json.dumps(span.row(), separators=(",", ":"), sort_keys=False).encode("utf-8"))
        buffer.append(10)


def flush_batch(buffer: bytearray) -> None:
    if not buffer:
        return
    request(
        "INSERT INTO otel.otel_traces FORMAT JSONEachRow",
        bytes(buffer),
        timeout=INSERT_TIMEOUT,
    )
    buffer.clear()


def validate_fixture_options() -> None:
    if TRACE_COUNT < 1:
        raise RuntimeError("OTEL_FIXTURE_TRACES must be >= 1")
    if MIN_SPANS < 1 or MAX_SPANS < MIN_SPANS:
        raise RuntimeError("require 1 <= OTEL_FIXTURE_MIN_SPANS <= OTEL_FIXTURE_MAX_SPANS")
    if BATCH_TRACES < 1:
        raise RuntimeError("OTEL_FIXTURE_BATCH_TRACES must be >= 1")
    if GENERATOR not in {"auto", "python", "sql"}:
        raise RuntimeError("OTEL_FIXTURE_GENERATOR must be auto, python or sql")
    if SQL_THRESHOLD < 1:
        raise RuntimeError("OTEL_FIXTURE_SQL_THRESHOLD must be >= 1")
    if SQL_CHUNK_TRACES < 1:
        raise RuntimeError("OTEL_FIXTURE_SQL_CHUNK_TRACES must be >= 1")
    if SQL_TARGET_SPANS_PER_CHUNK < 1:
        raise RuntimeError("OTEL_FIXTURE_SQL_TARGET_SPANS_PER_CHUNK must be >= 1")
    if SQL_PROCESSES < 1:
        raise RuntimeError("OTEL_FIXTURE_SQL_PROCESSES must be >= 1")
    if SQL_MAX_THREADS < 0:
        raise RuntimeError("OTEL_FIXTURE_SQL_MAX_THREADS must be >= 0")


def selected_generator() -> str:
    if GENERATOR != "auto":
        return GENERATOR
    return "sql" if TRACE_COUNT >= SQL_THRESHOLD else "python"


def populate_traces_python() -> tuple[int, str]:

    print(
        f"OTEL fixture: generating {TRACE_COUNT} traces ({MIN_SPANS}-{MAX_SPANS} spans/trace), "
        f"batch={BATCH_TRACES} traces",
        flush=True,
    )

    rng = random.Random(SEED)
    now_ns = int(datetime.now(tz=timezone.utc).timestamp() * NS)
    buffer = bytearray()
    total_spans = 0
    first_trace_id = ""
    started = time.monotonic()

    for i in range(TRACE_COUNT):
        back_ns = rng.randint(0, SPREAD_MINUTES * 60 * NS) if SPREAD_MINUTES else 0
        base_ns = now_ns - back_ns
        spans = generate_trace(rng, base_ns, MIN_SPANS, MAX_SPANS, ERROR_RATE, i)
        spans.sort(key=lambda span: (span.start_ns, span.span_id))
        if not first_trace_id:
            first_trace_id = spans[0].trace_id
        append_span_rows(buffer, spans)
        total_spans += len(spans)

        completed = i + 1
        if completed % BATCH_TRACES == 0 or completed == TRACE_COUNT:
            flush_batch(buffer)
            elapsed = max(0.001, time.monotonic() - started)
            print(
                f"OTEL fixture: inserted {completed}/{TRACE_COUNT} traces, {total_spans} spans "
                f"({completed / elapsed:.1f} traces/s, {total_spans / elapsed:.0f} spans/s)",
                flush=True,
            )

    return total_spans, first_trace_id


def populate_trace_index_from_spans() -> None:
    print("OTEL fixture: building trace-id time index", flush=True)
    request(
        """
INSERT INTO otel.otel_traces_trace_id_ts
SELECT
    TraceId,
    min(Timestamp) AS Start,
    max(Timestamp + toIntervalNanosecond(toInt64(Duration))) AS End
FROM otel.otel_traces
GROUP BY TraceId
""".strip(),
        timeout=INSERT_TIMEOUT,
    )


def sql_insert_settings() -> str:
    settings = [
        "min_insert_block_size_rows = 262144",
        "min_insert_block_size_bytes = 67108864",
    ]
    if SQL_MAX_THREADS > 0:
        settings.append(f"max_threads = {SQL_MAX_THREADS}")
        settings.append(f"max_insert_threads = {SQL_MAX_THREADS}")
    return "SETTINGS " + ", ".join(settings)


def effective_sql_chunk_traces() -> int:
    avg_spans = max(1, (MIN_SPANS + MAX_SPANS) // 2)
    by_span_budget = max(1, SQL_TARGET_SPANS_PER_CHUNK // avg_spans)
    return min(SQL_CHUNK_TRACES, by_span_budget)


def bulk_trace_insert_sql(offset: int, count: int, now_ns: int) -> str:
    """Build the only SQL fixture shape: production-like optimized rich spans.

    Candidate rows are generated directly by numbers_mt(), without ARRAY JOIN
    and without per-span hashes. Rows are emitted in service-major groups to
    reduce sorting work for production's (ServiceName, SpanName, Timestamp)
    ORDER BY while retaining 60-90-span traces (or any configured span range).
    """
    span_variants = MAX_SPANS - MIN_SPANS + 1
    spread_ns = max(0, SPREAD_MINUTES) * 60 * NS
    service_count = 12
    slots_per_service = (MAX_SPANS + service_count - 1) // service_count
    candidate_rows = count * service_count * slots_per_service
    error_every = 0 if ERROR_RATE <= 0 else max(1, round(1.0 / ERROR_RATE))
    error_expr = (
        "0"
        if error_every == 0
        else f"((trace_no * 1315423911 + span_idx * 2654435761) % {error_every}) = 0"
    )
    total_denominator = max(1, TRACE_COUNT - 1)

    return f"""
INSERT INTO otel.otel_traces
(
    Timestamp, TraceId, SpanId, ParentSpanId, TraceState,
    SpanName, SpanKind, ServiceName, ResourceAttributes,
    ScopeName, ScopeVersion, SpanAttributes, Duration,
    StatusCode, StatusMessage,
    `Events.Timestamp`, `Events.Name`, `Events.Attributes`,
    `Links.TraceId`, `Links.SpanId`, `Links.TraceState`, `Links.Attributes`
)
WITH
    toUInt64({SEED}) AS fixture_seed,
    toInt64({now_ns}) AS fixture_now_ns,
    toUInt64({spread_ns}) AS fixture_spread_ns,
    ['api_service','auth_service','cache_service','clickhouse_writer',
     'edge_gateway','enrichment_worker','event_ingest','notification_worker',
     'processing_worker','test_enrichment','test_ingest','test_worker'] AS services,
    ['request.validate','session.lookup','cache.get','clickhouse.insert',
     'HTTP POST /v1/events','enrichment.fetch','events.raw receive','notification.deliver',
     'job.process','test.enrichment.fetch','test.input receive','test.worker.process'] AS operations,
    ['Internal','Client','Producer','Consumer'] AS kinds
SELECT
    fromUnixTimestamp64Nano(start_ns) AS Timestamp,
    lower(leftPad(hex(trace_no), 32, '0')) AS TraceId,
    lower(leftPad(hex(bitShiftLeft(trace_no, 7) + toUInt64(span_idx)), 16, '0')) AS SpanId,
    if(span_idx = 0, '', lower(leftPad(hex(bitShiftLeft(trace_no, 7)), 16, '0'))) AS ParentSpanId,
    '' AS TraceState,
    arrayElement(operations, service_zero + 1) AS SpanName,
    if(span_idx = 0, 'Server', arrayElement(kinds, toUInt32(1 + (span_idx % 4)))) AS SpanKind,
    service_name AS ServiceName,
    map(
        'service.name', service_name,
        'deployment.environment.name', 'test',
        'telemetry.synthetic', 'true'
    ) AS ResourceAttributes,
    service_name AS ScopeName,
    '1.0.0' AS ScopeVersion,
    map(
        'otel.scope.name', service_name,
        'fixture.bucket', toString(trace_no % 16)
    ) AS SpanAttributes,
    if(
        span_idx = 0,
        toUInt64(span_count) * 1000000 + 100000000,
        toUInt64(50000 + ((trace_no * 1315423911 + span_idx * 2654435761) % 50000000))
    ) AS Duration,
    if({error_expr}, 'Error', if(span_idx = 0, 'Unset', 'Ok')) AS StatusCode,
    if({error_expr}, 'synthetic bulk fixture error', '') AS StatusMessage,
    CAST([], 'Array(DateTime64(9))') AS `Events.Timestamp`,
    CAST([], 'Array(String)') AS `Events.Name`,
    CAST([], 'Array(Map(String, String))') AS `Events.Attributes`,
    CAST([], 'Array(String)') AS `Links.TraceId`,
    CAST([], 'Array(String)') AS `Links.SpanId`,
    CAST([], 'Array(String)') AS `Links.TraceState`,
    CAST([], 'Array(Map(String, String))') AS `Links.Attributes`
FROM
(
    SELECT
        trace_no,
        span_idx,
        service_zero,
        span_count,
        arrayElement(services, service_zero + 1) AS service_name,
        fixture_now_ns
            - toInt64(fixture_spread_ns)
            + toInt64(
                intDiv(
                    toUInt128(trace_no) * toUInt128(fixture_spread_ns),
                    toUInt128({total_denominator})
                )
            )
            + toInt64(span_idx) * 1000000 AS start_ns
    FROM
    (
        SELECT
            toUInt64({offset}) + trace_local AS trace_no,
            span_idx,
            service_zero,
            toUInt32(
                {MIN_SPANS}
                + (((toUInt64({offset}) + trace_local) * toUInt64(11400714819323198485) + fixture_seed) % {span_variants})
            ) AS span_count
        FROM
        (
            SELECT
                toUInt64(intDiv(number % toUInt64({count * slots_per_service}), toUInt64({slots_per_service}))) AS trace_local,
                toUInt32(intDiv(number, toUInt64({count * slots_per_service}))) AS service_zero,
                toUInt32(
                    intDiv(number, toUInt64({count * slots_per_service}))
                    + (number % toUInt64({slots_per_service})) * {service_count}
                ) AS span_idx
            FROM numbers_mt({candidate_rows})
        )
        WHERE span_idx < {MAX_SPANS}
    )
    WHERE span_idx < span_count
)
{sql_insert_settings()}
""".strip()


def bulk_trace_index_insert_sql(offset: int, count: int, now_ns: int) -> str:
    spread_ns = max(0, SPREAD_MINUTES) * 60 * NS
    span_variants = MAX_SPANS - MIN_SPANS + 1
    total_denominator = max(1, TRACE_COUNT - 1)
    return f"""
INSERT INTO otel.otel_traces_trace_id_ts (TraceId, Start, End)
WITH
    toUInt64({SEED}) AS fixture_seed,
    toInt64({now_ns}) AS fixture_now_ns,
    toUInt64({spread_ns}) AS fixture_spread_ns
SELECT
    lower(leftPad(hex(trace_no), 32, '0')) AS TraceId,
    fromUnixTimestamp64Nano(base_ns) AS Start,
    fromUnixTimestamp64Nano(base_ns + toInt64(span_count) * 1000000 + 100000000) AS End
FROM
(
    SELECT
        trace_no,
        toUInt32(
            {MIN_SPANS}
            + ((trace_no * toUInt64(11400714819323198485) + fixture_seed) % {span_variants})
        ) AS span_count,
        fixture_now_ns
            - toInt64(fixture_spread_ns)
            + toInt64(
                intDiv(
                    toUInt128(trace_no) * toUInt128(fixture_spread_ns),
                    toUInt128({total_denominator})
                )
            ) AS base_ns
    FROM
    (
        SELECT toUInt64({offset}) + number AS trace_no
        FROM numbers_mt({count})
    )
)
{sql_insert_settings()}
""".strip()


def _sql_worker(worker_id: int, start_offset: int, trace_count: int, chunk_traces: int, now_ns: int) -> tuple[int, float]:
    """Independent process: loop over its own range and issue blocking INSERTs.

    Several of these OS processes run at once, so ClickHouse receives several
    independent INSERT pipelines concurrently. There is no Python GIL sharing
    between workers and no central per-chunk scheduler in the hot path.
    """
    started = time.monotonic()
    inserted = 0
    offset = start_offset
    end_offset = start_offset + trace_count
    avg_spans = (MIN_SPANS + MAX_SPANS) // 2

    while offset < end_offset:
        count = min(chunk_traces, end_offset - offset)
        chunk_started = time.monotonic()
        request(bulk_trace_insert_sql(offset, count, now_ns), timeout=INSERT_TIMEOUT)
        request(bulk_trace_index_insert_sql(offset, count, now_ns), timeout=INSERT_TIMEOUT)
        offset += count
        inserted += count
        chunk_elapsed = max(0.001, time.monotonic() - chunk_started)
        elapsed = max(0.001, time.monotonic() - started)
        print(
            f"OTEL fixture: worker={worker_id} inserted {inserted}/{trace_count} traces "
            f"(~{inserted * avg_spans} spans, {count / chunk_elapsed:.0f} traces/s chunk, "
            f"{inserted / elapsed:.0f} traces/s worker)",
            flush=True,
        )

    return inserted, time.monotonic() - started


def _split_ranges(start_offset: int, trace_count: int, process_count: int) -> list[tuple[int, int, int]]:
    workers = min(process_count, trace_count)
    base, remainder = divmod(trace_count, workers)
    ranges = []
    cursor = start_offset
    for worker_id in range(workers):
        count = base + (1 if worker_id < remainder else 0)
        ranges.append((worker_id, cursor, count))
        cursor += count
    return ranges


def populate_traces_sql(*, start_offset: int = 0, trace_count: int | None = None) -> tuple[int, str]:
    requested = TRACE_COUNT if trace_count is None else trace_count
    if requested <= 0:
        return 0, "sql-generated"

    chunk_traces = effective_sql_chunk_traces()
    ranges = _split_ranges(start_offset, requested, SQL_PROCESSES)
    print(
        f"OTEL fixture: SQL optimized-rich generator; append={requested} traces "
        f"from offset={start_offset}, spans/trace={MIN_SPANS}-{MAX_SPANS}, "
        f"processes={len(ranges)}, chunk/process={chunk_traces}, "
        f"target_spans/chunk={SQL_TARGET_SPANS_PER_CHUNK}, spread={SPREAD_MINUTES}m",
        flush=True,
    )

    now_ns = int(datetime.now(tz=timezone.utc).timestamp() * NS)
    started = time.monotonic()
    inserted_total = 0

    with ProcessPoolExecutor(max_workers=len(ranges)) as pool:
        futures = {
            pool.submit(_sql_worker, worker_id, offset, count, chunk_traces, now_ns): worker_id
            for worker_id, offset, count in ranges
        }
        for future in as_completed(futures):
            worker_id = futures[future]
            inserted, worker_elapsed = future.result()
            inserted_total += inserted
            print(
                f"OTEL fixture: worker={worker_id} complete; traces={inserted}, "
                f"elapsed={worker_elapsed:.1f}s, aggregate_completed={inserted_total}/{requested}",
                flush=True,
            )

    elapsed = max(0.001, time.monotonic() - started)
    avg_spans = (MIN_SPANS + MAX_SPANS) // 2
    print(
        f"OTEL fixture: parallel SQL load complete; traces={inserted_total}, "
        f"~spans={inserted_total * avg_spans}, elapsed={elapsed:.1f}s, "
        f"{inserted_total / elapsed:.0f} traces/s overall",
        flush=True,
    )
    return inserted_total * avg_spans, "sql-generated"

def mark_ready_and_maybe_wait() -> int:
    try:
        with open("/tmp/fixture-ready", "w", encoding="utf-8") as handle:
            handle.write("ready\n")
    except OSError:
        pass
    if not KEEPALIVE:
        return 0
    print("OTEL fixture: ready; keeping container alive", flush=True)
    while True:
        time.sleep(3600)

def main() -> int:
    started = time.monotonic()
    validate_fixture_options()
    wait_ready()
    ensure_projection_indexes(materialize_existing=not FORCE)
    existing_spans, existing_traces = existing_fixture_counts()
    if FORCE:
        reset_fixture_data()
        existing_spans, existing_traces = 0, 0
    elif existing_traces >= TRACE_COUNT and existing_spans > 0:
        print(
            f"OTEL fixture: existing dataset already satisfies target "
            f"({existing_traces} traces >= {TRACE_COUNT}); keeping it. "
            "Use OTEL_FIXTURE_FORCE=1 to rebuild from zero.",
            flush=True,
        )
        return mark_ready_and_maybe_wait()

    generator = selected_generator()
    if existing_traces > 0 and existing_traces < TRACE_COUNT:
        if SQL_PROCESSES > 1:
            raise RuntimeError(
                "partial parallel OTEL fixture cannot be resumed safely from a row count: "
                "workers own disjoint TraceId ranges, so a restart could duplicate some traces "
                "and skip others. Re-run with OTEL_FIXTURE_FORCE=1 to rebuild deterministically."
            )
        generator = "sql"
        print(
            f"OTEL fixture: growing existing fixture from {existing_traces} to "
            f"{TRACE_COUNT} traces (current spans={existing_spans})",
            flush=True,
        )
    if generator == "python" and MIN_SPANS < 10:
        raise RuntimeError(
            "the rich Python generator requires OTEL_FIXTURE_MIN_SPANS >= 10; "
            "use OTEL_FIXTURE_GENERATOR=sql for 1-span-per-trace load tests"
        )
    print(f"OTEL fixture: generator={generator}", flush=True)
    if generator == "sql":
        to_insert = max(0, TRACE_COUNT - existing_traces)
        expected_spans, first_trace = populate_traces_sql(
            start_offset=existing_traces,
            trace_count=to_insert,
        )
    else:
        expected_spans, first_trace = populate_traces_python()
        populate_trace_index_from_spans()

    span_count = active_rows("otel_traces")
    index_count = active_rows("otel_traces_trace_id_ts")
    trace_count = index_count
    elapsed = time.monotonic() - started
    print(
        f"OTEL fixture ready: traces={trace_count}, spans={span_count}, index_rows={index_count}, "
        f"generated_spans={expected_spans}, first_trace_id={first_trace}, elapsed={elapsed:.1f}s",
        flush=True,
    )
    return mark_ready_and_maybe_wait()


if __name__ == "__main__":
    raise SystemExit(main())
