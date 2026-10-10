"""No trace answer names a span that service_allowlist hides (docs/traces.md, "service_allowlist").

An instance with tests/config/traces-allowlist.hcl shows only the "inventory" and "auth" services of the rich OTel
dataset (2026-09-12). Their parents ("frontend", "checkout") and the producer spans that "inventory" links to
("checkout") are hidden. Every endpoint that serializes a span is checked: the parent of a span is named only when the
answer shows that parent too (trace detail), never in a list of spans of many traces (context, linked-from, span
search, one span); a link names only a span that the allowlist shows; and the "missing parents" count of the search
does not count hidden parents. The module skips without TRACES_ALLOWLIST_BASE_URL or the rich day.
"""
from __future__ import annotations

import json
import os

import pytest
import requests

BASE_URL = os.environ.get("TRACES_ALLOWLIST_BASE_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(not BASE_URL, reason="TRACES_ALLOWLIST_BASE_URL is not set")

SESSION = requests.Session()
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))

DAY_MS = 1_789_171_200_000  # 2026-09-12 00:00:00 UTC
HOUR = 3_600_000
H9 = (DAY_MS + 9 * HOUR, DAY_MS + 10 * HOUR)
VISIBLE = {"inventory", "auth"}


def get(path: str, **params) -> dict:
    response = SESSION.get(f"{BASE_URL}{path}", params={"host_id": "local", **params}, timeout=120)
    assert response.status_code == 200, (path, params, response.text)
    return response.json()


def ch_rows(sql: str) -> list[dict]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT JSONEachRow SETTINGS output_format_json_quote_64bit_integers = 0").encode(),
                             auth=CH_AUTH, timeout=300)
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def lit(value) -> str:
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def window(lo_ms: int, hi_ms: int) -> str:
    return f"Timestamp >= fromUnixTimestamp64Milli({lo_ms}) AND Timestamp < fromUnixTimestamp64Milli({hi_ms})"


@pytest.fixture(scope="module", autouse=True)
def rich():
    rows = ch_rows("SELECT coalesce(sum(rows), 0) AS n FROM system.parts WHERE active AND database = 'otel' "
                   "AND table = 'otel_traces' AND partition_id = '20260912'")
    if not rows or not rows[0]["n"]:
        pytest.skip("the rich OTel dataset (2026-09-12) is not loaded")


def hidden_parent_span() -> dict:
    """An inventory span of the busy hour whose parent is a span of a hidden service."""
    return ch_rows(
        f"SELECT c.TraceId AS trace_id, c.SpanId AS span_id, c.ParentSpanId AS parent, toString(toUnixTimestamp64Nano(c.Timestamp)) AS ts "
        f"FROM (SELECT TraceId, SpanId, ParentSpanId, Timestamp FROM otel.otel_traces WHERE {window(*H9)} AND ServiceName = 'inventory' "
        f"AND ParentSpanId != '') AS c JOIN (SELECT TraceId, SpanId FROM otel.otel_traces WHERE {window(*H9)} "
        f"AND ServiceName NOT IN ('inventory', 'auth')) AS p ON c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId "
        "ORDER BY c.Timestamp LIMIT 1")[0]


def test_the_allowlist_of_the_instance_is_restricted():
    body = get("/api/traces/search", start_ms=H9[0], end_ms=H9[0] + 60_000, limit=100)
    assert body["rows"] and set(body["services"]) <= VISIBLE


def test_context_never_names_a_parent():
    span = hidden_parent_span()
    body = get("/api/traces/context", timestamp_ns=span["ts"], window_ms=1000, limit=50)
    assert body["rows"], body
    assert {r["service_name"] for r in body["rows"]} <= VISIBLE
    assert span["span_id"] in {r["span_id"] for r in body["rows"]}
    assert all(r["parent_span_id"] == "" for r in body["rows"]), [r["parent_span_id"] for r in body["rows"] if r["parent_span_id"]]


def test_span_search_and_one_span_never_name_a_parent():
    span = hidden_parent_span()
    one = get("/api/traces/span", trace_id=span["trace_id"], span_id=span["span_id"], timestamp_ns=span["ts"])
    assert one["span"]["span_id"] == span["span_id"] and one["span"]["parent_span_id"] == ""
    ts_ms = int(span["ts"]) // 1_000_000
    page = get("/api/traces/spans", start_ms=ts_ms - 1000, end_ms=ts_ms + 1000, limit=50)
    assert page["rows"]
    assert all(r["parent_span_id"] == "" for r in page["rows"])


def test_trace_detail_names_only_the_parents_it_shows():
    span = hidden_parent_span()
    body = get("/api/traces/trace", trace_id=span["trace_id"])
    shown = {s["span_id"] for s in body["spans"]}
    assert {s["service_name"] for s in body["spans"]} <= VISIBLE
    assert all(s["parent_span_id"] in shown or s["parent_span_id"] == "" for s in body["spans"])
    assert next(s for s in body["spans"] if s["span_id"] == span["span_id"])["parent_span_id"] == ""


def test_linked_from_never_names_a_hidden_span():
    batch = ch_rows(
        f"SELECT Links.TraceId AS lt, Links.SpanId AS ls FROM otel.otel_traces WHERE {window(*H9)} "
        "AND ServiceName = 'inventory' AND SpanName = 'receive orders' AND length(Links.TraceId) >= 1 ORDER BY Timestamp LIMIT 1")[0]
    target_trace, target_span = batch["lt"][0], batch["ls"][0]
    target_service = ch_rows(
        f"SELECT ServiceName FROM otel.otel_traces WHERE {window(H9[0] - 2 * HOUR, H9[1] + 2 * HOUR)} "
        f"AND TraceId = {lit(target_trace)} AND SpanId = {lit(target_span)} LIMIT 1")[0]["ServiceName"]
    assert target_service not in VISIBLE  # the producer of the batch is hidden
    for params in ({"trace_id": target_trace, "span_id": target_span}, {"trace_id": target_trace}):
        body = get("/api/traces/linked_from", **params)
        for row in body["rows"]:
            assert row["service_name"] in VISIBLE and row["parent_span_id"] == ""
            assert target_span not in json.loads(row["link_span_ids"] or "[]"), row
        assert body["rows"] == [], body["rows"]


def test_search_does_not_count_hidden_parents_as_missing():
    span = hidden_parent_span()
    ts_ms = int(span["ts"]) // 1_000_000
    body = get("/api/traces/search", start_ms=ts_ms - 60_000, end_ms=ts_ms + 60_000, limit=100)
    columns = body["columns"]
    missing = columns.index("missing_parents")
    ids = columns.index("trace_id")
    rows = {row[ids]: row[missing] for row in body["rows"]}
    assert span["trace_id"] in rows
    assert all(count == 0 for count in rows.values()), rows
