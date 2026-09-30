#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import random
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
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


def _env_flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


# Logs and metrics are derived from the spans already stored in otel_traces
# (INSERT ... SELECT, server-side), so TraceId/SpanId/timestamps correlate with
# the trace fixture whatever generator produced it. They only ever write into
# the logs/metrics tables: otel_traces is read, never modified.
LOGS = _env_flag("OTEL_FIXTURE_LOGS")
METRICS = _env_flag("OTEL_FIXTURE_METRICS")
# Rebuild logs/metrics only (keeps the trace fixture). OTEL_FIXTURE_FORCE=1
# rebuilds traces and therefore the derived signals too.
SIGNALS_FORCE = _env_flag("OTEL_FIXTURE_SIGNALS_FORCE")
SIGNALS_DATABASE = os.environ.get("OTEL_FIXTURE_SIGNALS_DATABASE", "otel").strip() or "otel"
SIGNALS_DDL_PATH = os.environ.get("OTEL_FIXTURE_SIGNALS_DDL", "/fixture/05-otel-logs-metrics.sql")
# Window ending at the newest span: logs and metrics cover its last N minutes.
SIGNALS_WINDOW_MINUTES = int(os.environ.get("OTEL_FIXTURE_SIGNALS_WINDOW_MINUTES", "1440"))
# Inside the window, every trace of the last LOGS_DENSE_MINUTES gets logs and
# 1 trace in LOGS_TRACE_SAMPLE of the rest; 1 span in LOGS_SPAN_SAMPLE of a
# selected trace (plus its root and every error span) emits 1-3 records.
LOGS_DENSE_MINUTES = int(os.environ.get("OTEL_FIXTURE_LOGS_DENSE_MINUTES", "60"))
LOGS_TRACE_SAMPLE = int(os.environ.get("OTEL_FIXTURE_LOGS_TRACE_SAMPLE", "16"))
LOGS_SPAN_SAMPLE = int(os.environ.get("OTEL_FIXTURE_LOGS_SPAN_SAMPLE", "4"))
SIGNALS_SLICE_MINUTES = int(os.environ.get("OTEL_FIXTURE_SIGNALS_SLICE_MINUTES", "60"))
SIGNALS_COMPLETE_MARKER = "chdash-fixture-complete"
LOG_TABLE = "otel_logs"
METRIC_TABLES = (
    "otel_metrics_gauge",
    "otel_metrics_sum",
    "otel_metrics_histogram",
    "otel_metrics_exponential_histogram",
    "otel_metrics_summary",
)
# OpenTelemetry semantic-convention default buckets for
# http.server.request.duration (seconds).
HISTOGRAM_BOUNDS_S = (0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0)


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
    # Logs and metrics are derived from the spans: a rebuilt trace fixture
    # invalidates them.
    reset_signal_tables((LOG_TABLE,) + METRIC_TABLES)


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
    if SIGNALS_WINDOW_MINUTES < 1 or SIGNALS_SLICE_MINUTES < 1:
        raise RuntimeError("OTEL_FIXTURE_SIGNALS_WINDOW_MINUTES and _SLICE_MINUTES must be >= 1")
    if LOGS_DENSE_MINUTES < 0 or LOGS_TRACE_SAMPLE < 1 or LOGS_SPAN_SAMPLE < 1:
        raise RuntimeError("require OTEL_FIXTURE_LOGS_DENSE_MINUTES >= 0 and LOGS_*_SAMPLE >= 1")
    if not SIGNALS_DATABASE.replace("_", "").isalnum():
        raise RuntimeError("OTEL_FIXTURE_SIGNALS_DATABASE must be a plain identifier")


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

def signal_table(table: str) -> str:
    return f"{SIGNALS_DATABASE}.{table}"


def signal_table_state(table: str) -> tuple[bool, int, bool]:
    """Return (exists, active rows, complete marker) from system tables only."""
    raw = request(
        "SELECT t.comment AS comment, "
        "(SELECT coalesce(sum(rows), 0) FROM system.parts "
        f" WHERE active AND database = '{SIGNALS_DATABASE}' AND table = '{table}') AS rows "
        f"FROM system.tables AS t WHERE t.database = '{SIGNALS_DATABASE}' AND t.name = '{table}' "
        "FORMAT JSONEachRow"
    ).decode().strip()
    if not raw:
        return False, 0, False
    row = json.loads(raw.splitlines()[0])
    return True, int(row.get("rows") or 0), SIGNALS_COMPLETE_MARKER in str(row.get("comment") or "")


def existing_signal_counts() -> dict[str, tuple[int, bool]]:
    """Logs/metrics counterpart of existing_fixture_counts(): rows + completion."""
    counts: dict[str, tuple[int, bool]] = {}
    for table in (LOG_TABLE,) + METRIC_TABLES:
        try:
            exists, rows, complete = signal_table_state(table)
        except Exception:
            exists, rows, complete = False, 0, False
        if exists:
            counts[table] = (rows, complete)
    return counts


def set_signal_comment(table: str, comment: str) -> None:
    escaped = comment.replace("\\", "\\\\").replace("'", "\\'")
    request(f"ALTER TABLE {signal_table(table)} MODIFY COMMENT '{escaped}'")


def reset_signal_tables(tables) -> None:
    for table in tables:
        exists, _, _ = signal_table_state(table)
        if not exists:
            continue
        print(f"OTEL fixture: clearing {signal_table(table)}", flush=True)
        request(f"TRUNCATE TABLE {signal_table(table)}")
        set_signal_comment(table, "")


def signal_ddl_statements() -> list[str]:
    """Statements of tests/clickhouse-init/05-otel-logs-metrics.sql.

    docker-entrypoint-initdb.d only runs on an empty ClickHouse volume, so a
    persistent test volume created before the logs/metrics tables existed gets
    them here. Every statement is CREATE ... IF NOT EXISTS or a GRANT.
    """
    with open(SIGNALS_DDL_PATH, encoding="utf-8") as handle:
        text = handle.read()
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("--")]
    statements = [part.strip() for part in "\n".join(lines).split(";") if part.strip()]
    if SIGNALS_DATABASE != "otel":
        statements = [
            s.replace("DATABASE IF NOT EXISTS otel", f"DATABASE IF NOT EXISTS {SIGNALS_DATABASE}")
            .replace("otel.", f"{SIGNALS_DATABASE}.")
            for s in statements
        ]
    return statements


def ensure_signal_tables() -> None:
    for statement in signal_ddl_statements():
        try:
            request(statement)
        except RuntimeError as exc:
            if statement.startswith("GRANT"):
                print(f"OTEL fixture: warning: {statement!r} failed: {exc}", flush=True)
                continue
            raise


def signal_window_ns() -> tuple[int, int] | None:
    """[start, end) ending just after the newest span, from system.parts only."""
    raw = request(
        "SELECT toInt64(toUnixTimestamp(max(max_time))), coalesce(sum(rows), 0) FROM system.parts "
        "WHERE active AND database = 'otel' AND table = 'otel_traces' FORMAT TSV"
    ).decode().strip()
    max_s, rows = (int(value or "0") for value in raw.split("\t"))
    if rows <= 0:
        return None
    if max_s <= 0:
        # Not partitioned by a time column: one bounded aggregate instead.
        max_s = int(request("SELECT toInt64(toUnixTimestamp(max(Timestamp))) FROM otel.otel_traces").decode().strip() or "0")
    end_ns = (max_s + 1) * NS
    start_ns = end_ns - max(1, SIGNALS_WINDOW_MINUTES) * 60 * NS
    return start_ns, end_ns


def signal_services(start_ns: int, end_ns: int) -> list[str]:
    recent = max(start_ns, end_ns - 15 * 60 * NS)
    raw = request(
        "SELECT DISTINCT toString(ServiceName) FROM otel.otel_traces "
        f"WHERE Timestamp >= {ns_literal(recent)} AND Timestamp < {ns_literal(end_ns)} "
        "ORDER BY 1 FORMAT TSV"
    ).decode()
    return [line for line in raw.splitlines() if line]


def ns_literal(ns: int) -> str:
    return f"fromUnixTimestamp64Nano(toInt64({ns}))"


def sql_string_array(values) -> str:
    return "[" + ",".join("'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'" for v in values) + "]"


SERVICE_VERSION_SQL = (
    "concat('1.', toString(cityHash64({svc}) % 7), '.', toString(cityHash64({svc}, 'patch') % 20))"
)


def resource_attributes_sql(svc: str, host: str | None) -> str:
    host_part = f"'host.name', {host}, " if host else ""
    return (
        f"map('service.name', {svc}, 'service.version', {SERVICE_VERSION_SQL.format(svc=svc)}, {host_part}"
        "'deployment.environment.name', 'test', 'telemetry.sdk.language', 'python', "
        "'telemetry.synthetic', 'true')"
    )


def logs_insert_sql(start_ns: int, end_ns: int, dense_start_ns: int) -> str:
    """1-3 log records per sampled span of [start_ns, end_ns).

    Every error span gets an ERROR record (Body = StatusMessage) at its end.
    Other records: DEBUG 20 % / INFO 65 % / WARN 10 % / ERROR 5 %; ~5 % carry
    no trace context and ~5 % land 1-3 s after their span ended.
    """
    trace_sample = max(1, LOGS_TRACE_SAMPLE)
    span_sample = max(1, LOGS_SPAN_SAMPLE)
    return f"""
INSERT INTO {signal_table(LOG_TABLE)}
(
    Timestamp, TraceId, SpanId, TraceFlags, SeverityText, SeverityNumber,
    ServiceName, Body, ResourceSchemaUrl, ResourceAttributes,
    ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes
)
SELECT
    fromUnixTimestamp64Nano(log_ns) AS Timestamp,
    if(orphan, '', trace_id) AS TraceId,
    if(orphan, '', span_id) AS SpanId,
    toUInt8(if(orphan, 0, 1)) AS TraceFlags,
    severity_text AS SeverityText,
    toUInt8(severity_number) AS SeverityNumber,
    service_name AS ServiceName,
    body AS Body,
    'https://opentelemetry.io/schemas/1.26.0' AS ResourceSchemaUrl,
    {resource_attributes_sql('service_name', 'host_name')} AS ResourceAttributes,
    '' AS ScopeSchemaUrl,
    scope_name AS ScopeName,
    scope_version AS ScopeVersion,
    CAST(map(), 'Map(String, String)') AS ScopeAttributes,
    mapFromArrays(
        arrayConcat(
            ['code.function', 'code.lineno', 'log.origin'],
            if(http_route != '', ['http.route', 'http.request.method', 'http.response.status_code'], []),
            if(severity_number = 17, ['exception.type', 'exception.message', 'exception.stacktrace'], [])
        ),
        arrayConcat(
            [code_function, code_lineno, multiIf(orphan, 'background', late, 'after_span', 'span')],
            if(http_route != '', [http_route, http_method, toString(http_status)], []),
            if(severity_number = 17, [exception_type, body, concat(
                exception_type, ': ', body,
                '\\n    at ', code_function, ' (', service_name, '/handlers.py:', code_lineno, ')',
                '\\n    at dispatch (runtime/loop.py:88)',
                '\\n    at main (runtime/entry.py:21)'
            )], [])
        )
    ) AS LogAttributes
FROM
(
    SELECT
        *,
        multiIf(
            status_log, if(status_message = '', concat(span_name, ' failed'), status_message),
            severity_number = 5, arrayElement([
                concat('cache miss key=user:', toString(num_a)),
                concat('span context propagated traceparent=00-', trace_id, '-', span_id, '-01'),
                concat('config reload skipped checksum unchanged revision=', toString(100 + num_b % 900))
            ], variant + 1),
            severity_number = 13, arrayElement([
                concat('slow operation ', span_name, ' took ', toString(duration_ms), ' ms threshold_ms=25'),
                concat('retrying upstream call attempt=', toString(2 + num_a % 3), ' backoff_ms=', toString(50 * (1 + num_b % 8))),
                concat('queue depth above soft limit depth=', toString(1000 + num_a % 4000), ' limit=1000')
            ], variant + 1),
            severity_number = 17, arrayElement([
                'upstream timeout after 5000 ms calling enrichment.fetch',
                concat('failed to deliver notification recipient=r-', toString(num_b), ': connection reset by peer'),
                concat('insert into analytics.events_buffer failed: code 252 too many parts partition=', toString(num_a % 12))
            ], variant + 1),
            service_name IN ('edge_gateway', 'api_service'),
                concat(http_method, ' ', if(http_route = '', '/v1/events', http_route), ' ', toString(http_status), ' in ', toString(duration_ms), ' ms'),
            service_name = 'clickhouse_writer',
                concat('inserted ', toString(64 + num_a % 4032), ' rows into analytics.events_buffer in ', toString(1 + duration_ms), ' ms'),
            service_name = 'cache_service',
                concat('cache hit key=user:', toString(num_a), ' ttl_s=', toString(30 + num_b % 600)),
            service_name = 'auth_service',
                concat('session validated user_id=', toString(num_b), ' scopes=', toString(1 + num_a % 5)),
            service_name IN ('event_ingest', 'test_ingest'),
                concat('received batch size=', toString(1 + num_a % 500), ' from topic events.raw partition=', toString(num_b % 12)),
            service_name IN ('enrichment_worker', 'test_enrichment'),
                concat('enriched event account=acct-', toString(num_a), ' fields=', toString(3 + num_b % 20)),
            service_name = 'notification_worker',
                concat('notification delivered channel=', arrayElement(['email', 'sms', 'push'], 1 + num_a % 3), ' recipient=r-', toString(num_b)),
            service_name IN ('processing_worker', 'test_worker'),
                concat('job ', lower(hex(num_b)), ' processed in ', toString(duration_ms), ' ms'),
            concat(span_name, ' completed in ', toString(duration_ms), ' ms')
        ) AS body,
        if(status_log, 'SyntheticFixtureError',
           arrayElement(['TimeoutError', 'ConnectionResetError', 'ClickHouseError'], variant + 1)) AS exception_type
    FROM
    (
        SELECT
            *,
            cityHash64(span_hash, k) AS log_hash,
            (span_error AND k = 0) AS status_log,
            log_hash % 100 AS roll,
            if(status_log, 17, multiIf(roll < 20, 5, roll < 85, 9, roll < 95, 13, 17)) AS severity_number,
            multiIf(severity_number = 5, 'DEBUG', severity_number = 9, 'INFO', severity_number = 13, 'WARN', 'ERROR') AS severity_text,
            (NOT status_log AND intDiv(log_hash, 65536) % 20 = 0) AS orphan,
            (NOT status_log AND NOT orphan AND intDiv(log_hash, 16777216) % 20 = 1) AS late,
            start_ns + duration_ns AS end_ns,
            multiIf(
                status_log, end_ns,
                late, end_ns + 1000000000 + toInt64(intDiv(log_hash, 4294967296) % 2000000000),
                start_ns + intDiv(duration_ns * toInt64(k + 1), toInt64(log_count + 1))
            ) AS log_ns,
            intDiv(duration_ns, 1000000) AS duration_ms,
            intDiv(log_hash, 1099511627776) % 3 AS variant,
            intDiv(log_hash, 256) % 5000 AS num_a,
            intDiv(log_hash, 1048576) % 100000 AS num_b,
            multiIf(
                match(span_name, '^(HTTP )?(GET|POST|PUT|PATCH|DELETE) /'), extract(span_name, ' (/[^ ]*)'),
                service_name IN ('edge_gateway', 'api_service'), '/v1/events',
                ''
            ) AS http_route,
            if(match(span_name, '(GET|POST|PUT|PATCH|DELETE) /'), extract(span_name, '(GET|POST|PUT|PATCH|DELETE) /'), 'GET') AS http_method,
            if(severity_number = 17, 500, arrayElement([200, 200, 200, 201, 204], 1 + num_a % 5)) AS http_status,
            concat(service_name, '.', replaceRegexpAll(lower(span_name), '[^a-z0-9]+', '_')) AS code_function,
            toString(10 + num_a % 400) AS code_lineno,
            concat(replaceAll(service_name, '_', '-'), '-', toString(span_hash % 3)) AS host_name
        FROM
        (
            SELECT
                TraceId AS trace_id,
                SpanId AS span_id,
                toString(ServiceName) AS service_name,
                toString(SpanName) AS span_name,
                StatusMessage AS status_message,
                ScopeName AS scope_name,
                ScopeVersion AS scope_version,
                toInt64(toUnixTimestamp64Nano(Timestamp)) AS start_ns,
                toInt64(Duration) AS duration_ns,
                (StatusCode = 'Error') AS span_error,
                cityHash64(TraceId, SpanId) AS span_hash,
                (1 + span_hash % 3) AS log_count,
                arrayJoin(range(toUInt64(log_count))) AS k
            FROM otel.otel_traces
            WHERE Timestamp >= {ns_literal(start_ns)} AND Timestamp < {ns_literal(end_ns)}
              AND (
                StatusCode = 'Error'
                OR (
                  (Timestamp >= {ns_literal(dense_start_ns)} OR cityHash64(TraceId) % {trace_sample} = 0)
                  AND (ParentSpanId = '' OR cityHash64(SpanId) % {span_sample} = 0)
                )
              )
        )
    )
)
{sql_insert_settings()}
""".strip()


def histogram_le_sql() -> str:
    return "[" + ", ".join(f"countIf(Duration <= {int(round(b * NS))})" for b in HISTOGRAM_BOUNDS_S) + "]"


def histogram_insert_sql(start_ns: int, end_ns: int, cumulative_services: list[str]) -> str:
    """http.server.request.duration per 10 s, ServiceName and SpanName.

    Services listed in cumulative_services export cumulative temporality, the
    others delta. Each point carries one exemplar: the slowest span.
    """
    bounds = "[" + ", ".join(repr(b) for b in HISTOGRAM_BOUNDS_S) + "]"
    buckets = len(HISTOGRAM_BOUNDS_S) + 1
    window = (
        "(PARTITION BY service_name, span_name ORDER BY bucket_start "
        "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)"
    )
    return f"""
INSERT INTO {signal_table('otel_metrics_histogram')}
(
    ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes,
    ScopeDroppedAttrCount, ScopeSchemaUrl, ServiceName, MetricName, MetricDescription, MetricUnit,
    Attributes, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds,
    `Exemplars.FilteredAttributes`, `Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.SpanId`, `Exemplars.TraceId`,
    Flags, Min, Max, AggregationTemporality
)
SELECT
    {resource_attributes_sql('service_name', None)} AS ResourceAttributes,
    'https://opentelemetry.io/schemas/1.26.0' AS ResourceSchemaUrl,
    'chdash.fixture.spanmetrics' AS ScopeName,
    '1.0.0' AS ScopeVersion,
    CAST(map(), 'Map(String, String)') AS ScopeAttributes,
    0 AS ScopeDroppedAttrCount,
    '' AS ScopeSchemaUrl,
    service_name AS ServiceName,
    'http.server.request.duration' AS MetricName,
    'Duration of HTTP server requests.' AS MetricDescription,
    's' AS MetricUnit,
    map('span.name', span_name) AS Attributes,
    if(cumulative, {ns_literal(start_ns)}, bucket_start) AS StartTimeUnix,
    bucket_start + toIntervalSecond(10) AS TimeUnix,
    if(cumulative, sum(cnt) OVER {window}, cnt) AS Count,
    if(cumulative, sum(total_s) OVER {window}, total_s) AS Sum,
    if(cumulative, sumForEach(bucket_counts) OVER {window}, bucket_counts) AS BucketCounts,
    {bounds} AS ExplicitBounds,
    [CAST(map(), 'Map(String, String)')] AS `Exemplars.FilteredAttributes`,
    [slowest.3] AS `Exemplars.TimeUnix`,
    [max_s] AS `Exemplars.Value`,
    [slowest.2] AS `Exemplars.SpanId`,
    [slowest.1] AS `Exemplars.TraceId`,
    0 AS Flags,
    if(cumulative, min(min_s) OVER {window}, min_s) AS Min,
    if(cumulative, max(max_s) OVER {window}, max_s) AS Max,
    if(cumulative, 2, 1) AS AggregationTemporality
FROM
(
    SELECT
        *,
        (service_name IN {sql_string_array(cumulative_services) if cumulative_services else "['']"}) AS cumulative,
        arrayMap(i -> toUInt64(if(i = 1, toInt64(le_counts[1]), if(i <= {buckets - 1}, toInt64(le_counts[i]) - toInt64(le_counts[i - 1]), toInt64(cnt) - toInt64(le_counts[{buckets - 1}])))),
                 range(1, {buckets + 1})) AS bucket_counts
    FROM
    (
        SELECT
            toStartOfInterval(Timestamp, toIntervalSecond(10)) AS bucket_start,
            toString(ServiceName) AS service_name,
            toString(SpanName) AS span_name,
            count() AS cnt,
            sum(Duration) / 1e9 AS total_s,
            min(Duration) / 1e9 AS min_s,
            max(Duration) / 1e9 AS max_s,
            {histogram_le_sql()} AS le_counts,
            argMax(tuple(TraceId, SpanId, Timestamp), Duration) AS slowest
        FROM otel.otel_traces
        WHERE Timestamp >= {ns_literal(start_ns)} AND Timestamp < {ns_literal(end_ns)}
        GROUP BY bucket_start, service_name, span_name
    )
)
{sql_insert_settings()}
""".strip()


def calls_sum_insert_sql(start_ns: int, end_ns: int, reset_service: str, reset_ns: int) -> str:
    """Cumulative monotonic traces.span.metrics.calls (spanmetrics connector shape).

    reset_service restarts at reset_ns: its counters start again from zero with
    a new StartTimeUnix, which is one counter reset per series of that service.
    """
    return f"""
INSERT INTO {signal_table('otel_metrics_sum')}
(
    ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes,
    ScopeDroppedAttrCount, ScopeSchemaUrl, ServiceName, MetricName, MetricDescription, MetricUnit,
    Attributes, StartTimeUnix, TimeUnix, Value, Flags,
    `Exemplars.FilteredAttributes`, `Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.SpanId`, `Exemplars.TraceId`,
    AggregationTemporality, IsMonotonic
)
SELECT
    {resource_attributes_sql('service_name', None)} AS ResourceAttributes,
    'https://opentelemetry.io/schemas/1.26.0' AS ResourceSchemaUrl,
    'chdash.fixture.spanmetrics' AS ScopeName,
    '1.0.0' AS ScopeVersion,
    CAST(map(), 'Map(String, String)') AS ScopeAttributes,
    0 AS ScopeDroppedAttrCount,
    '' AS ScopeSchemaUrl,
    service_name AS ServiceName,
    'traces.span.metrics.calls' AS MetricName,
    'Number of spans per span name, kind and status.' AS MetricDescription,
    '{{call}}' AS MetricUnit,
    map('span.name', span_name,
        'span.kind', concat('SPAN_KIND_', upper(span_kind)),
        'status.code', concat('STATUS_CODE_', upper(status_code))) AS Attributes,
    if(epoch = 1, {ns_literal(reset_ns)}, {ns_literal(start_ns)}) AS StartTimeUnix,
    bucket_start + toIntervalSecond(10) AS TimeUnix,
    toFloat64(sum(cnt) OVER (
        PARTITION BY service_name, span_name, span_kind, status_code, epoch
        ORDER BY bucket_start ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS Value,
    0 AS Flags,
    CAST([], 'Array(Map(String, String))') AS `Exemplars.FilteredAttributes`,
    CAST([], 'Array(DateTime64(9))') AS `Exemplars.TimeUnix`,
    CAST([], 'Array(Float64)') AS `Exemplars.Value`,
    CAST([], 'Array(String)') AS `Exemplars.SpanId`,
    CAST([], 'Array(String)') AS `Exemplars.TraceId`,
    2 AS AggregationTemporality,
    true AS IsMonotonic
FROM
(
    SELECT
        toStartOfInterval(Timestamp, toIntervalSecond(10)) AS bucket_start,
        toString(ServiceName) AS service_name,
        toString(SpanName) AS span_name,
        toString(SpanKind) AS span_kind,
        toString(StatusCode) AS status_code,
        toUInt8(service_name = '{reset_service}' AND bucket_start >= {ns_literal(reset_ns)}) AS epoch,
        count() AS cnt
    FROM otel.otel_traces
    WHERE Timestamp >= {ns_literal(start_ns)} AND Timestamp < {ns_literal(end_ns)}
    GROUP BY bucket_start, service_name, span_name, span_kind, status_code
)
{sql_insert_settings()}
""".strip()


def gauges_insert_sql(start_ns: int, end_ns: int, services: list[str]) -> str:
    """process.cpu.utilization and queue.depth every 10 s per service host."""
    step_ns = 10 * NS
    first_ns = (start_ns // step_ns) * step_ns
    points = max(1, (end_ns - first_ns) // step_ns)
    return f"""
INSERT INTO {signal_table('otel_metrics_gauge')}
(
    ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes,
    ScopeDroppedAttrCount, ScopeSchemaUrl, ServiceName, MetricName, MetricDescription, MetricUnit,
    Attributes, StartTimeUnix, TimeUnix, Value, Flags,
    `Exemplars.FilteredAttributes`, `Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.SpanId`, `Exemplars.TraceId`
)
SELECT
    {resource_attributes_sql('service_name', 'host_name')} AS ResourceAttributes,
    'https://opentelemetry.io/schemas/1.26.0' AS ResourceSchemaUrl,
    'chdash.fixture.hostmetrics' AS ScopeName,
    '1.0.0' AS ScopeVersion,
    CAST(map(), 'Map(String, String)') AS ScopeAttributes,
    0 AS ScopeDroppedAttrCount,
    '' AS ScopeSchemaUrl,
    service_name AS ServiceName,
    metric_name AS MetricName,
    if(metric_name = 'queue.depth', 'Messages waiting in the service work queue.',
       'Difference in process.cpu.time since the last measurement, divided by the elapsed time and number of CPUs.') AS MetricDescription,
    if(metric_name = 'queue.depth', '{{message}}', '1') AS MetricUnit,
    map('host.name', host_name) AS Attributes,
    fromUnixTimestamp64Nano(toInt64(0)) AS StartTimeUnix,
    fromUnixTimestamp64Nano(t_ns) AS TimeUnix,
    if(metric_name = 'queue.depth',
       greatest(0., round(200 + 150 * sin(2 * pi() * t_s / 900 + phase) + 40 * noise)),
       greatest(0.01, least(0.99, 0.35 + 0.25 * sin(2 * pi() * t_s / 3600 + phase) + 0.1 * noise))) AS Value,
    0 AS Flags,
    CAST([], 'Array(Map(String, String))') AS `Exemplars.FilteredAttributes`,
    CAST([], 'Array(DateTime64(9))') AS `Exemplars.TimeUnix`,
    CAST([], 'Array(Float64)') AS `Exemplars.Value`,
    CAST([], 'Array(String)') AS `Exemplars.SpanId`,
    CAST([], 'Array(String)') AS `Exemplars.TraceId`
FROM
(
    SELECT
        toInt64({first_ns}) + toInt64(number) * {step_ns} AS t_ns,
        t_ns / 1e9 AS t_s,
        arrayJoin({sql_string_array(services)}) AS service_name,
        arrayJoin([0, 1, 2]) AS host_idx,
        arrayJoin(['process.cpu.utilization', 'queue.depth']) AS metric_name,
        concat(replaceAll(service_name, '_', '-'), '-', toString(host_idx)) AS host_name,
        (cityHash64(service_name, host_idx) % 628) / 100. AS phase,
        (cityHash64(t_ns, service_name, host_idx, metric_name) % 1000) / 1000. - 0.5 AS noise
    FROM numbers({points})
)
{sql_insert_settings()}
""".strip()


def summary_insert_sql(start_ns: int, end_ns: int) -> str:
    """A few summary points: span.duration.summary per minute and service."""
    return f"""
INSERT INTO {signal_table('otel_metrics_summary')}
(
    ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes,
    ScopeDroppedAttrCount, ScopeSchemaUrl, ServiceName, MetricName, MetricDescription, MetricUnit,
    Attributes, StartTimeUnix, TimeUnix, Count, Sum,
    `ValueAtQuantiles.Quantile`, `ValueAtQuantiles.Value`, Flags
)
SELECT
    {resource_attributes_sql('service_name', None)} AS ResourceAttributes,
    'https://opentelemetry.io/schemas/1.26.0' AS ResourceSchemaUrl,
    'chdash.fixture.spanmetrics' AS ScopeName,
    '1.0.0' AS ScopeVersion,
    CAST(map(), 'Map(String, String)') AS ScopeAttributes,
    0 AS ScopeDroppedAttrCount,
    '' AS ScopeSchemaUrl,
    service_name AS ServiceName,
    'span.duration.summary' AS MetricName,
    'Span duration quantiles per service (summary).' AS MetricDescription,
    's' AS MetricUnit,
    CAST(map(), 'Map(String, String)') AS Attributes,
    minute_start AS StartTimeUnix,
    minute_start + toIntervalSecond(60) AS TimeUnix,
    cnt AS Count,
    total_s AS Sum,
    [0., 0.5, 0.9, 0.99, 1.] AS `ValueAtQuantiles.Quantile`,
    arrayMap(v -> v / 1e9, qs) AS `ValueAtQuantiles.Value`,
    0 AS Flags
FROM
(
    SELECT
        toStartOfMinute(Timestamp) AS minute_start,
        toString(ServiceName) AS service_name,
        count() AS cnt,
        sum(Duration) / 1e9 AS total_s,
        arrayMap(v -> toFloat64(v), quantilesExact(0, 0.5, 0.9, 0.99, 1)(Duration)) AS qs
    FROM otel.otel_traces
    WHERE Timestamp >= {ns_literal(start_ns)} AND Timestamp < {ns_literal(end_ns)}
    GROUP BY minute_start, service_name
)
{sql_insert_settings()}
""".strip()


def exponential_histogram_insert_sql(start_ns: int, end_ns: int, scale: int = 3) -> str:
    """A few base-2 exponential histogram points (delta) per minute and service."""
    factor = 2 ** scale
    return f"""
INSERT INTO {signal_table('otel_metrics_exponential_histogram')}
(
    ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes,
    ScopeDroppedAttrCount, ScopeSchemaUrl, ServiceName, MetricName, MetricDescription, MetricUnit,
    Attributes, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount,
    PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts,
    `Exemplars.FilteredAttributes`, `Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.SpanId`, `Exemplars.TraceId`,
    Flags, Min, Max, AggregationTemporality
)
SELECT
    {resource_attributes_sql('service_name', None)} AS ResourceAttributes,
    'https://opentelemetry.io/schemas/1.26.0' AS ResourceSchemaUrl,
    'chdash.fixture.spanmetrics' AS ScopeName,
    '1.0.0' AS ScopeVersion,
    CAST(map(), 'Map(String, String)') AS ScopeAttributes,
    0 AS ScopeDroppedAttrCount,
    '' AS ScopeSchemaUrl,
    service_name AS ServiceName,
    'span.duration.exponential' AS MetricName,
    'Span duration per service as a base-2 exponential histogram.' AS MetricDescription,
    's' AS MetricUnit,
    CAST(map(), 'Map(String, String)') AS Attributes,
    minute_start AS StartTimeUnix,
    minute_start + toIntervalSecond(60) AS TimeUnix,
    count_total AS Count,
    sum_ns / 1e9 AS Sum,
    {scale} AS Scale,
    toUInt64(0) AS ZeroCount,
    toInt32(min_idx) AS PositiveOffset,
    arrayMap(i -> toUInt64(arraySum(arrayMap(p -> if(p.1 = i, p.2, 0), pairs))),
             range(min_idx, max_idx + 1)) AS PositiveBucketCounts,
    toInt32(0) AS NegativeOffset,
    CAST([], 'Array(UInt64)') AS NegativeBucketCounts,
    [CAST(map(), 'Map(String, String)')] AS `Exemplars.FilteredAttributes`,
    [slow.3] AS `Exemplars.TimeUnix`,
    [slow.4 / 1e9] AS `Exemplars.Value`,
    [slow.2] AS `Exemplars.SpanId`,
    [slow.1] AS `Exemplars.TraceId`,
    0 AS Flags,
    min_ns / 1e9 AS Min,
    max_ns / 1e9 AS Max,
    1 AS AggregationTemporality
FROM
(
    SELECT
        minute_start,
        service_name,
        toUInt64(sum(cnt)) AS count_total,
        sum(total_ns) AS sum_ns,
        min(min_bucket_ns) AS min_ns,
        max(max_bucket_ns) AS max_ns,
        min(idx) AS min_idx,
        max(idx) AS max_idx,
        groupArray((idx, cnt)) AS pairs,
        argMax(slowest, slowest.4) AS slow
    FROM
    (
        SELECT
            toStartOfMinute(Timestamp) AS minute_start,
            toString(ServiceName) AS service_name,
            toInt64(ceil(log2(Duration / 1e9) * {factor})) - 1 AS idx,
            count() AS cnt,
            sum(Duration) AS total_ns,
            min(Duration) AS min_bucket_ns,
            max(Duration) AS max_bucket_ns,
            argMax(tuple(TraceId, SpanId, Timestamp, Duration), Duration) AS slowest
        FROM otel.otel_traces
        WHERE Timestamp >= {ns_literal(start_ns)} AND Timestamp < {ns_literal(end_ns)} AND Duration > 0
        GROUP BY minute_start, service_name, idx
    )
    GROUP BY minute_start, service_name
)
{sql_insert_settings()}
""".strip()


def _timed(label: str, sql: str, table: str) -> float:
    started = time.monotonic()
    before = signal_table_state(table)[1]
    request(sql, timeout=INSERT_TIMEOUT)
    elapsed = time.monotonic() - started
    after = signal_table_state(table)[1]
    print(f"OTEL fixture: {label}: +{after - before} rows into {signal_table(table)} in {elapsed:.1f}s", flush=True)
    return elapsed


def _slices(start_ns: int, end_ns: int) -> list[tuple[int, int]]:
    step = max(1, SIGNALS_SLICE_MINUTES) * 60 * NS
    out = []
    cursor = start_ns
    while cursor < end_ns:
        out.append((cursor, min(end_ns, cursor + step)))
        cursor += step
    return out


def populate_logs(start_ns: int, end_ns: int) -> None:
    dense_start_ns = max(start_ns, end_ns - max(0, LOGS_DENSE_MINUTES) * 60 * NS)
    slices = _slices(start_ns, end_ns)
    print(
        f"OTEL fixture: generating logs for {len(slices)} slices of {SIGNALS_SLICE_MINUTES}m "
        f"(window={SIGNALS_WINDOW_MINUTES}m, dense={LOGS_DENSE_MINUTES}m, "
        f"trace_sample=1/{LOGS_TRACE_SAMPLE}, span_sample=1/{LOGS_SPAN_SAMPLE}, "
        f"workers={SQL_PROCESSES})",
        flush=True,
    )
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=max(1, SQL_PROCESSES)) as pool:
        futures = [
            pool.submit(request, logs_insert_sql(s, e, dense_start_ns), b"", INSERT_TIMEOUT)
            for s, e in slices
        ]
        for done, future in enumerate(as_completed(futures), 1):
            future.result()
            if done % 6 == 0 or done == len(futures):
                print(f"OTEL fixture: logs slices {done}/{len(futures)} ({time.monotonic() - started:.1f}s)", flush=True)
    rows = signal_table_state(LOG_TABLE)[1]
    elapsed = time.monotonic() - started
    print(f"OTEL fixture: logs ready: rows={rows}, elapsed={elapsed:.1f}s", flush=True)
    set_signal_comment(
        LOG_TABLE,
        f"{SIGNALS_COMPLETE_MARKER} window_minutes={SIGNALS_WINDOW_MINUTES} dense_minutes={LOGS_DENSE_MINUTES} "
        f"trace_sample={LOGS_TRACE_SAMPLE} span_sample={LOGS_SPAN_SAMPLE} rows={rows}",
    )


def populate_metrics(start_ns: int, end_ns: int) -> None:
    services = signal_services(start_ns, end_ns)
    if not services:
        print("OTEL fixture: no services in the metrics window; skipping metrics", flush=True)
        return
    cumulative = services[1::2]
    reset_ns = start_ns + (end_ns - start_ns) // 2
    reset_ns -= reset_ns % (10 * NS)
    recent_ns = max(start_ns, end_ns - 60 * 60 * NS)
    print(
        f"OTEL fixture: generating metrics for {len(services)} services; cumulative histograms for "
        f"{','.join(cumulative) or '-'}; counter reset for {services[0]}",
        flush=True,
    )
    started = time.monotonic()
    _timed("histogram http.server.request.duration", histogram_insert_sql(start_ns, end_ns, cumulative), "otel_metrics_histogram")
    _timed("sum traces.span.metrics.calls", calls_sum_insert_sql(start_ns, end_ns, services[0], reset_ns), "otel_metrics_sum")
    _timed("gauges process.cpu.utilization/queue.depth", gauges_insert_sql(start_ns, end_ns, services), "otel_metrics_gauge")
    _timed("summary span.duration.summary", summary_insert_sql(recent_ns, end_ns), "otel_metrics_summary")
    _timed("exponential histogram span.duration.exponential", exponential_histogram_insert_sql(recent_ns, end_ns), "otel_metrics_exponential_histogram")
    for table in METRIC_TABLES:
        set_signal_comment(table, f"{SIGNALS_COMPLETE_MARKER} window_minutes={SIGNALS_WINDOW_MINUTES}")
    print(f"OTEL fixture: metrics ready in {time.monotonic() - started:.1f}s", flush=True)


def populate_signals(*, traces_changed: bool = False) -> None:
    """Idempotently derive otel_logs / otel_metrics_* from the stored spans."""
    if not (LOGS or METRICS):
        return
    ensure_signal_tables()
    window = signal_window_ns()
    if window is None:
        print("OTEL fixture: otel_traces is empty; skipping logs/metrics", flush=True)
        return
    start_ns, end_ns = window
    if SIGNALS_FORCE or traces_changed:
        reset_signal_tables(((LOG_TABLE,) if LOGS else ()) + (METRIC_TABLES if METRICS else ()))
    counts = existing_signal_counts()

    if LOGS:
        rows, complete = counts.get(LOG_TABLE, (0, False))
        if rows > 0 and complete:
            print(f"OTEL fixture: {LOG_TABLE} already holds {rows} fixture rows; keeping it. "
                  "Use OTEL_FIXTURE_SIGNALS_FORCE=1 to rebuild logs/metrics only.", flush=True)
        else:
            if rows > 0:
                print(f"OTEL fixture: {LOG_TABLE} holds {rows} rows from an interrupted load; rebuilding", flush=True)
                reset_signal_tables((LOG_TABLE,))
            populate_logs(start_ns, end_ns)

    if METRICS:
        states = [counts.get(table, (0, False)) for table in METRIC_TABLES]
        if all(rows > 0 and complete for rows, complete in states):
            total = sum(rows for rows, _ in states)
            print(f"OTEL fixture: metrics tables already hold {total} fixture rows; keeping them", flush=True)
        else:
            if any(rows > 0 for rows, _ in states):
                print("OTEL fixture: metrics tables hold a partial load; rebuilding", flush=True)
                reset_signal_tables(METRIC_TABLES)
            populate_metrics(start_ns, end_ns)


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
        populate_signals()
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
    # New spans move the fixture window: logs/metrics derived from the previous
    # spans no longer match it.
    populate_signals(traces_changed=True)
    return mark_ready_and_maybe_wait()


if __name__ == "__main__":
    raise SystemExit(main())
