#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from generate_otel_traces import NS, dt64, generate_trace

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
INSERT_TIMEOUT = int(os.environ.get("OTEL_FIXTURE_INSERT_TIMEOUT_SECONDS", "180"))
FORCE = os.environ.get("OTEL_FIXTURE_FORCE", "0").strip().lower() in {"1","true","yes","on"}
KEEPALIVE = os.environ.get("OTEL_FIXTURE_KEEPALIVE", "0").strip().lower() in {"1","true","yes","on"}


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


def fixture_already_present() -> bool:
    if FORCE:
        return False
    try:
        value = request("SELECT count() FROM system.tables WHERE database = 'otel' AND name IN ('otel_traces','otel_traces_trace_id_ts')").decode().strip()
        if value != "2":
            return False
        traces = int(request("SELECT uniqExact(TraceId) FROM otel.otel_traces").decode().strip() or "0")
        index_rows = int(request("SELECT count() FROM otel.otel_traces_trace_id_ts").decode().strip() or "0")
        return traces > 0 and index_rows > 0
    except Exception:
        return False

def create_schema() -> None:
    print("OTEL fixture: recreating otel tables", flush=True)
    statements = [
        "CREATE DATABASE IF NOT EXISTS otel",
        "DROP TABLE IF EXISTS otel.otel_traces_trace_id_ts",
        "DROP TABLE IF EXISTS otel.otel_traces",
        r"""
CREATE TABLE otel.otel_traces
(
    Timestamp DateTime64(9),
    TraceId String,
    SpanId String,
    ParentSpanId String,
    TraceState String,
    SpanName LowCardinality(String),
    SpanKind LowCardinality(String),
    ServiceName LowCardinality(String),
    ResourceAttributes Map(String, String),
    ScopeName String,
    ScopeVersion String,
    SpanAttributes Map(String, String),
    Duration UInt64,
    StatusCode LowCardinality(String),
    StatusMessage String,
    `Events.Timestamp` Array(DateTime64(9)),
    `Events.Name` Array(String),
    `Events.Attributes` Array(Map(String, String)),
    `Links.TraceId` Array(String),
    `Links.SpanId` Array(String),
    `Links.TraceState` Array(String),
    `Links.Attributes` Array(Map(String, String))
)
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (Timestamp, TraceId, SpanId)
SETTINGS index_granularity = 8192
""",
        r"""
CREATE TABLE otel.otel_traces_trace_id_ts
(
    TraceId String,
    Start DateTime64(9),
    End DateTime64(9)
)
ENGINE = MergeTree
ORDER BY (TraceId, Start)
SETTINGS index_granularity = 8192
""",
        "GRANT SELECT ON otel.* TO chdash_system",
    ]
    for statement in statements:
        request(statement.strip())


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


def populate_traces() -> tuple[int, str]:
    if TRACE_COUNT < 1:
        raise RuntimeError("OTEL_FIXTURE_TRACES must be >= 1")
    if MIN_SPANS < 10 or MAX_SPANS < MIN_SPANS:
        raise RuntimeError("require 10 <= OTEL_FIXTURE_MIN_SPANS <= OTEL_FIXTURE_MAX_SPANS")
    if BATCH_TRACES < 1:
        raise RuntimeError("OTEL_FIXTURE_BATCH_TRACES must be >= 1")

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


def populate_trace_index() -> None:
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
    wait_ready()
    if fixture_already_present():
        print("OTEL fixture: existing dataset detected; keeping it (set OTEL_FIXTURE_FORCE=1 to rebuild)", flush=True)
        return mark_ready_and_maybe_wait()
    create_schema()
    expected_spans, first_trace = populate_traces()
    populate_trace_index()

    span_count = request("SELECT count() FROM otel.otel_traces").decode().strip()
    trace_count = request("SELECT uniqExact(TraceId) FROM otel.otel_traces").decode().strip()
    index_count = request("SELECT count() FROM otel.otel_traces_trace_id_ts").decode().strip()
    elapsed = time.monotonic() - started
    print(
        f"OTEL fixture ready: traces={trace_count}, spans={span_count}, index_rows={index_count}, "
        f"generated_spans={expected_spans}, first_trace_id={first_trace}, elapsed={elapsed:.1f}s",
        flush=True,
    )
    return mark_ready_and_maybe_wait()


if __name__ == "__main__":
    raise SystemExit(main())
