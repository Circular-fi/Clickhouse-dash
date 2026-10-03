"""Span insight endpoints of the Trace Explorer against the OTel fixture.

/api/traces/linked_from (spans of other traces linking to a trace or span)
and /api/traces/context (spans around a span's start time), each compared
with a direct ClickHouse query over the same bounded window.
"""
from __future__ import annotations

import os
import time

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))
RICH_DAY_MS = 1_789_171_200_000  # 2026-09-12 00:00:00 UTC (tests/README.md, "Rich OTel dataset")


def get(path: str, **kwargs):
    return SESSION.get(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 30), **kwargs)


def ch_rows(sql: str) -> list[list[str]]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT TSV").encode(), auth=CH_AUTH, timeout=120)
    assert response.status_code == 200, response.text
    return [line.split("\t") for line in response.text.splitlines() if line]


def lit(value: str) -> str:
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


@pytest.fixture(scope="module")
def meta() -> dict:
    response = get("/api/traces/meta", params={"host_id": "local"})
    if response.status_code == 404:
        pytest.skip("Trace Explorer disabled in this configuration")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def anchor_span() -> dict:
    # A span of a trace six hours before the newest one (spans on both sides
    # of it), from the detail endpoint (Python keeps start_ns exact).
    rows = ch_rows(
        "SELECT TraceId FROM otel.otel_traces_trace_id_ts WHERE Start <= "
        "(SELECT max(Start) FROM otel.otel_traces_trace_id_ts) - INTERVAL 6 HOUR ORDER BY Start DESC LIMIT 1")
    if not rows:
        pytest.skip("OTEL fixture is empty")
    detail = get("/api/traces/trace", params={"host_id": "local", "trace_id": rows[0][0]})
    assert detail.status_code == 200, detail.text
    spans = detail.json()["spans"]
    assert spans
    return spans[len(spans) // 2]


def test_meta_exposes_highlighted_attributes_and_insight_settings(meta):
    assert meta["highlighted_attributes"] == [
        "service.version", "deployment.environment.name", "deployment.environment", "http.route", "user.id"]
    assert meta["linked_from_margin_minutes"] == 60
    assert meta["context_windows_ms"] == [1000, 10000, 60000, 300000]


# ------------------------------------------------------------- linked from

def _linked_truth(trace_id: str, lo_ms: int, hi_ms: int, span_id: str = "") -> list[tuple[str, str]]:
    pair = f" AND arrayExists((t, s) -> t = {lit(trace_id)} AND s = {lit(span_id)}, Links.TraceId, Links.SpanId)" if span_id else ""
    return [(r[0], r[1]) for r in ch_rows(
        f"SELECT TraceId, SpanId FROM otel.otel_traces WHERE Timestamp >= fromUnixTimestamp64Milli({lo_ms}) "
        f"AND Timestamp <= fromUnixTimestamp64Milli({hi_ms}) AND has(Links.TraceId, {lit(trace_id)}) "
        f"AND TraceId != {lit(trace_id)}{pair} ORDER BY Timestamp DESC, SpanId DESC LIMIT 100")]


def _linked(params: dict) -> dict:
    started = time.monotonic()
    response = get("/api/traces/linked_from", params={"host_id": "local", **params})
    elapsed = time.monotonic() - started
    assert response.status_code == 200, response.text
    payload = response.json()
    # Bounded scan: a few hundred ms on the ~2 B span fixture.
    assert elapsed < 5, f"linked_from took {elapsed:.2f} s"
    assert payload["elapsed_ms"] < 3000, payload["elapsed_ms"]
    return payload


def test_linked_from_matches_direct_query_inside_the_bounded_window(meta, anchor_span):
    margin_ms = meta["linked_from_margin_minutes"] * 60_000
    trace_id = anchor_span["trace_id"]
    bounds = ch_rows(
        f"SELECT toUnixTimestamp64Milli(min(Start)), toUnixTimestamp64Milli(max(End)) FROM otel.otel_traces_trace_id_ts WHERE TraceId = {lit(trace_id)}")
    start_ms, end_ms = int(bounds[0][0]), int(bounds[0][1]) + 1

    # Window from the trace index: the trace's own bounds widened by the margin.
    by_index = _linked({"trace_id": trace_id})
    assert by_index["range_source"] == "trace_index"
    assert by_index["range"] == [start_ms - margin_ms, end_ms + margin_ms]
    assert [(r["trace_id"], r["span_id"]) for r in by_index["rows"]] == _linked_truth(trace_id, *by_index["range"])

    # Window from the caller (the page sends the loaded trace's bounds).
    by_request = _linked({"trace_id": trace_id, "span_id": anchor_span["span_id"], "start_ms": start_ms, "end_ms": end_ms})
    assert by_request["range_source"] == "request"
    assert by_request["range"] == [start_ms - margin_ms, end_ms + margin_ms]
    assert [(r["trace_id"], r["span_id"]) for r in by_request["rows"]] == _linked_truth(trace_id, *by_request["range"], anchor_span["span_id"])


def test_linked_from_finds_the_links_the_fixture_holds():
    # A link across traces must be listed by its target trace (and the pair
    # for its span). The bulk fixture holds none (the SQL generator writes no
    # links, the Python one links spans of the same trace); the rich day
    # (2026-09-12, tests/README.md) links each consumer batch trace to the
    # producer spans of the checkouts before it: the newest one of 10:00-11:00.
    found = ch_rows(
        f"SELECT TraceId, SpanId, Links.TraceId[1], Links.SpanId[1], toUnixTimestamp64Milli(Timestamp) FROM otel.otel_traces "
        f"WHERE Timestamp >= fromUnixTimestamp64Milli({RICH_DAY_MS + 10 * 3_600_000}) "
        f"AND Timestamp < fromUnixTimestamp64Milli({RICH_DAY_MS + 11 * 3_600_000}) AND notEmpty(Links.TraceId) "
        f"AND Links.TraceId[1] != TraceId ORDER BY Timestamp DESC, SpanId DESC LIMIT 1")
    if not found:
        pytest.skip("the rich OTel dataset (2026-09-12) is not loaded")
    source_trace, source_span, target_trace, target_span, at_ms = found[0]
    at_ms = int(at_ms)
    payload = _linked({"trace_id": target_trace, "start_ms": at_ms, "end_ms": at_ms + 1})
    assert (source_trace, source_span) in [(r["trace_id"], r["span_id"]) for r in payload["rows"]]
    assert [(r["trace_id"], r["span_id"]) for r in payload["rows"]] == _linked_truth(target_trace, *payload["range"])
    pair = _linked({"trace_id": target_trace, "span_id": target_span, "start_ms": at_ms, "end_ms": at_ms + 1})
    assert [(r["trace_id"], r["span_id"]) for r in pair["rows"]] == _linked_truth(target_trace, *pair["range"], target_span)


def test_linked_from_rejects_unbounded_or_invalid_windows(meta):
    base = {"host_id": "local", "trace_id": "00000000000000000000000000000001"}
    cases = [
        ({"trace_id": ""}, "missing_trace_id"),
        ({"trace_id": "x" * 300}, "invalid_trace_id"),
        ({"start_ms": 1000}, "invalid_trace_range"),
        ({"start_ms": 5000, "end_ms": 1000}, "invalid_trace_range"),
        ({"start_ms": 0, "end_ms": (meta["max_lookback_minutes"] + 1) * 60_000}, "invalid_trace_range"),
    ]
    for params, code in cases:
        response = get("/api/traces/linked_from", params={**base, **params})
        assert response.status_code == 400, (params, response.text)
        assert response.json()["error_code"] == code, (params, response.text)
    unknown = get("/api/traces/linked_from", params={**base, "trace_id": "ffffffffffffffffffffffffffffffff"})
    assert unknown.status_code == 404 and unknown.json()["error_code"] == "trace_not_found", unknown.text


# ----------------------------------------------------------------- context

def _context(params: dict) -> tuple[dict, float]:
    started = time.monotonic()
    response = get("/api/traces/context", params={"host_id": "local", **params})
    elapsed = time.monotonic() - started
    assert response.status_code == 200, response.text
    return response.json(), elapsed


def _context_truth(anchor_ns: int, window_ms: int, predicate: str, keyset: str, order: str, limit: int) -> list[tuple[str, str]]:
    window_ns = window_ms * 1_000_000
    where = (f"Timestamp >= fromUnixTimestamp64Nano({anchor_ns - window_ns}) AND Timestamp <= fromUnixTimestamp64Nano({anchor_ns + window_ns})"
             f"{(' AND ' + predicate) if predicate else ''} AND {keyset}")
    return [(r[0], r[1]) for r in ch_rows(
        f"SELECT toString(toUnixTimestamp64Nano(Timestamp)), SpanId FROM otel.otel_traces WHERE {where} "
        f"ORDER BY Timestamp {order}, SpanId {order} LIMIT {limit}")]


def _preset_cases(span: dict) -> list[tuple[str, dict, int, str]]:
    import json as _json
    attrs = _json.loads(span.get("span_attributes") or "{}")
    resource = _json.loads(span.get("resource_attributes") or "{}")
    service = span["service_name"]
    cases = [
        ("anything 10 s", {"filter": "any"}, 10_000, ""),
        ("same service 1 min", {"filter": "service", "service": service}, 60_000, f"ServiceName = {lit(service)}"),
    ]
    if attrs:
        key, value = sorted(attrs.items())[0]
        cases.append(("span attribute 1 min", {"filter": "attribute", "attr_scope": "span", "attr_key": key, "attr_value": value}, 60_000,
                      f"mapContains(SpanAttributes, {lit(key)}) AND SpanAttributes[{lit(key)}] = {lit(value)}"))
    resource_keys = sorted(k for k in resource if k != "service.name")
    if resource_keys:
        key = resource_keys[0]
        cases.append(("resource attribute 1 s", {"filter": "attribute", "attr_scope": "resource", "attr_key": key, "attr_value": resource[key]}, 1_000,
                      f"mapContains(ResourceAttributes, {lit(key)}) AND ResourceAttributes[{lit(key)}] = {lit(resource[key])}"))
    return cases


def test_context_presets_match_direct_query_around_the_anchor(anchor_span):
    anchor_ns = int(anchor_span["start_ns"])
    for label, params, window_ms, predicate in _preset_cases(anchor_span):
        payload, _ = _context({"timestamp_ns": anchor_ns, "window_ms": window_ms, "limit": 20, **params})
        newer = _context_truth(anchor_ns, window_ms, predicate, f"Timestamp > fromUnixTimestamp64Nano({anchor_ns})", "ASC", 11)
        older = _context_truth(anchor_ns, window_ms, predicate, f"Timestamp <= fromUnixTimestamp64Nano({anchor_ns})", "DESC", 11)
        expected = list(reversed(newer[:10])) + older[:10]
        got = [(r["start_ns_text"], r["span_id"]) for r in payload["rows"]]
        assert got == expected, label
        assert payload["has_newer"] is (len(newer) > 10), label
        assert payload["has_older"] is (len(older) > 10), label
        assert payload["window_ms"] == window_ms and payload["filter"] == params["filter"], label
        # Every row is inside the window and newest first.
        starts = [int(r["start_ns_text"]) for r in payload["rows"]]
        assert starts == sorted(starts, reverse=True), label
        assert all(abs(ns - anchor_ns) <= window_ms * 1_000_000 for ns in starts), label
        # The anchor span itself is listed (unfiltered and same-service cases).
        if params["filter"] in ("any", "service"):
            assert anchor_span["span_id"] in [r["span_id"] for r in payload["rows"]], label


def test_context_keyset_pages_equal_one_ordered_scan(anchor_span):
    anchor_ns = int(anchor_span["start_ns"])
    service = anchor_span["service_name"]
    predicate = f"ServiceName = {lit(service)}"
    base = {"timestamp_ns": anchor_ns, "window_ms": 60_000, "filter": "service", "service": service}
    first, _ = _context({**base, "limit": 20})
    rows = list(first["rows"])
    # Three pages older from the last row, two pages newer from the first row.
    for _ in range(3):
        page, _ = _context({**base, "direction": "older", "limit": 50, "cursor_ns": rows[-1]["start_ns_text"], "cursor_span_id": rows[-1]["span_id"]})
        assert "has_newer" not in page
        rows += page["rows"]
    for _ in range(2):
        page, _ = _context({**base, "direction": "newer", "limit": 50, "cursor_ns": rows[0]["start_ns_text"], "cursor_span_id": rows[0]["span_id"]})
        assert "has_older" not in page
        rows = page["rows"] + rows
    got = [(r["start_ns_text"], r["span_id"]) for r in rows]
    older = _context_truth(anchor_ns, 60_000, predicate, f"Timestamp <= fromUnixTimestamp64Nano({anchor_ns})", "DESC", 10 + 150)
    newer = _context_truth(anchor_ns, 60_000, predicate, f"Timestamp > fromUnixTimestamp64Nano({anchor_ns})", "ASC", 10 + 100)
    assert got == list(reversed(newer)) + older
    assert len(set(got)) == len(got)


def test_context_answers_within_the_timing_budget(anchor_span):
    anchor_ns = int(anchor_span["start_ns"])
    service = anchor_span["service_name"]
    # Warm once, then the budget: same service ±1 min < 1 s, anything ±5 min < 2 s.
    for params, budget in [({"filter": "service", "service": service, "window_ms": 60_000}, 1.0),
                           ({"filter": "any", "window_ms": 300_000}, 2.0)]:
        _context({"timestamp_ns": anchor_ns, **params})
        payload, elapsed = _context({"timestamp_ns": anchor_ns, **params})
        assert payload["rows"], params
        assert elapsed < budget, f"{params}: {elapsed:.3f} s"
        assert payload["elapsed_ms"] < budget * 1000, payload["elapsed_ms"]


def test_context_rejects_unbounded_or_invalid_requests(anchor_span):
    anchor_ns = int(anchor_span["start_ns"])
    base = {"host_id": "local", "timestamp_ns": anchor_ns}
    cases = [
        ({"timestamp_ns": ""}, "missing_timestamp"),
        ({"window_ms": 1234}, "invalid_context_window"),
        ({"window_ms": 3_600_000}, "invalid_context_window"),
        ({"filter": "everything"}, "invalid_context_filter"),
        ({"filter": "service"}, "invalid_context_filter"),
        ({"filter": "host"}, "invalid_context_filter"),
        ({"filter": "attribute", "attr_scope": "span"}, "invalid_context_filter"),
        ({"filter": "attribute", "attr_scope": "both", "attr_key": "k", "attr_value": "v"}, "invalid_context_filter"),
        ({"direction": "sideways"}, "invalid_direction"),
        ({"direction": "older"}, "missing_cursor"),
        ({"timestamp_ns": 5}, "invalid_timestamp"),
    ]
    for params, code in cases:
        response = get("/api/traces/context", params={**base, **params})
        assert response.status_code == 400, (params, response.text)
        assert response.json()["error_code"] == code, (params, response.text)
    # The limit is clamped to 200 rows.
    payload, _ = _context({"timestamp_ns": anchor_ns, "filter": "any", "window_ms": 300_000, "limit": 5000})
    assert payload["limit"] == 200 and len(payload["rows"]) <= 200
