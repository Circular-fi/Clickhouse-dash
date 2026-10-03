"""Synthetic spans a test writes for itself, in a day of its own.

Some checks need a shape no fixture holds on every stack: more spans in an
hour than a sample cap (a fresh stack's bulk fixture is ~750 k spans in all),
or one span stored twice. They write exactly those rows into otel.otel_traces
on a day no fixture and no other test reads (late August 2026: the rich day is
2026-09-12, the bulk fixture lies after it), and drop that day's partition
when they are done (the table is PARTITION BY toDate(Timestamp)). Every
synthetic TraceId starts with SYNTHETIC_PREFIX; a day holding other rows is
never touched.
"""
from __future__ import annotations

import contextlib
import os

import pytest
import requests

CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))
TABLE = "otel.otel_traces"
SYNTHETIC_PREFIX = "c0ffee"
COLUMNS = ("Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, ResourceAttributes, "
           "ScopeName, SpanAttributes, Duration, StatusCode")


def _query(sql: str, timeout: int = 600) -> str:
    response = requests.post(CH_URL + "/", data=sql.encode(), auth=CH_AUTH, timeout=timeout)
    assert response.status_code == 200, response.text
    return response.text


def _drop(day: str) -> None:
    _query(f"ALTER TABLE {TABLE} DROP PARTITION '{day}'")


@contextlib.contextmanager
def scoped_spans(day: str, select_sql: str):
    """Insert `select_sql` (selecting COLUMNS, every TraceId starting with
    SYNTHETIC_PREFIX, every Timestamp on `day`) for the duration of the block."""
    foreign = int(_query(f"SELECT count() FROM {TABLE} WHERE toDate(Timestamp) = '{day}' "
                         f"AND NOT startsWith(TraceId, '{SYNTHETIC_PREFIX}')").strip() or 0)
    if foreign:
        pytest.skip(f"{day} holds {foreign} spans that are not synthetic")
    _drop(day)  # what an interrupted earlier run left
    try:
        _query(f"INSERT INTO {TABLE} ({COLUMNS}) SELECT * FROM ({select_sql}) WHERE toDate(Timestamp) = '{day}'")
        yield
    finally:
        _drop(day)
