"""Span-level search of the Trace Explorer (/api/traces/spans, /api/traces/span).

Every answer is compared with one direct ClickHouse query over the same
range, filters and order (Timestamp DESC, SpanId DESC, TraceId DESC):
keyset pages never skip or repeat a span, filters apply per span, time slices
widen newest-first and a budget stop hands back a resume cursor that
continues exactly where the page stopped.
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
TABLE = "otel.otel_traces"
ORDER = "ORDER BY Timestamp DESC, SpanId DESC, TraceId DESC"
KEY = "toString(toUnixTimestamp64Nano(Timestamp)), TraceId, SpanId"
HOUR_MS = 3_600_000
MIN_NS = 60 * 10**9
# The fixture ClickHouse is shared by several suites: timing budgets are
# generous; the measured times are printed (pytest -s) for the report.
FIRST_PAGE_BUDGET_MS = 1500
FILTERED_PAGE_BUDGET_MS = 8000


def get(path: str, **params):
    return SESSION.get(f"{BASE_URL}{path}", params={"host_id": "local", **params}, timeout=120)


def ch_rows(sql: str) -> list[list[str]]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT TSV").encode(), auth=CH_AUTH, timeout=300)
    assert response.status_code == 200, response.text
    return [line.split("\t") for line in response.text.splitlines() if line]


def lit(value: str) -> str:
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def window(start_ms: int, end_ms: int) -> str:
    return (f"Timestamp >= fromUnixTimestamp64Milli({start_ms}) AND "
            f"Timestamp <= fromUnixTimestamp64Milli({end_ms})")


def spans(**params) -> dict:
    response = get("/api/traces/spans", **params)
    assert response.status_code == 200, response.text
    return response.json()


def keys(rows: list[dict]) -> list[tuple[str, str, str]]:
    return [(row["start_ns"], row["trace_id"], row["span_id"]) for row in rows]


def truth(start_ms: int, end_ms: int, where: str = "", limit: int | None = None) -> list[tuple[str, str, str]]:
    sql = f"SELECT {KEY} FROM {TABLE} WHERE {window(start_ms, end_ms)}{where} {ORDER}"
    if limit is not None:
        sql += f" LIMIT {limit}"
    return [tuple(row) for row in ch_rows(sql)]


def walk(max_pages: int = 200, **params) -> tuple[list[dict], list[dict]]:
    """Every page of a search by cursor: (rows, payloads)."""
    rows: list[dict] = []
    payloads: list[dict] = []
    cursor = ""
    for _ in range(max_pages):
        payload = spans(**params, **({"cursor": cursor} if cursor else {}))
        payloads.append(payload)
        rows.extend(payload["rows"])
        if not payload["has_more"]:
            return rows, payloads
        cursor = payload["cursor"]
        assert cursor, payload
    raise AssertionError(f"search did not end within {max_pages} pages")


def contiguous(slices: list[dict]) -> None:
    for newer, older in zip(slices, slices[1:]):
        assert int(older["end_ns"]) == int(newer["start_ns"]) - 1, (newer, older)


@pytest.fixture(scope="module")
def meta() -> dict:
    response = get("/api/traces/meta")
    if response.status_code == 404:
        pytest.skip("Trace Explorer disabled in this configuration")
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture(scope="module")
def dense_hour(meta) -> tuple[int, int]:
    """A full hour of fixture spans, two hours before the newest one."""
    rows = ch_rows(f"SELECT toUnixTimestamp64Milli(max(Timestamp)) FROM {TABLE}")
    newest = int(rows[0][0]) if rows and rows[0][0].isdigit() else 0
    if newest < 3 * HOUR_MS:
        pytest.skip("OTEL fixture is empty")
    end_ms = (newest // HOUR_MS) * HOUR_MS - HOUR_MS
    return end_ms - HOUR_MS, end_ms


@pytest.fixture(scope="module")
def full_range(dense_hour) -> tuple[int, int]:
    """Seven days ending one hour after the dense hour (the fixture's span)."""
    end_ms = dense_hour[1] + HOUR_MS
    return end_ms - 7 * 24 * HOUR_MS, end_ms


# --------------------------------------------------------------- first page

def test_first_page_on_one_hour_matches_a_direct_ordered_query(dense_hour):
    start_ms, end_ms = dense_hour
    spans(start_ms=start_ms, end_ms=end_ms, limit=100)  # warm the pool / caches
    started = time.monotonic()
    payload = spans(start_ms=start_ms, end_ms=end_ms, limit=100)
    wall_ms = (time.monotonic() - started) * 1000
    print(f"first page, 1 h unfiltered: server {payload['timing_ms']} ms, wall {wall_ms:.0f} ms")
    assert keys(payload["rows"]) == truth(start_ms, end_ms, limit=100)
    assert payload["has_more"] is True and payload["cursor"]
    assert payload["incomplete"] is False
    # Dense: the first 15-minute slice holds the whole page.
    assert len(payload["slices"]) == 1
    assert int(payload["slices"][0]["end_ns"]) == end_ms * 10**6
    assert int(payload["slices"][0]["end_ns"]) - int(payload["slices"][0]["start_ns"]) + 1 == 15 * MIN_NS
    assert payload["timing_ms"]["total"] < FIRST_PAGE_BUDGET_MS
    row = payload["rows"][0]
    for field in ("timestamp", "start_ns", "trace_id", "span_id", "parent_span_id", "service_name", "span_name",
                  "span_kind", "duration_ns", "status_code", "status_message", "attributes"):
        assert field in row
    # Exact nanosecond text (beyond 2^53) and the UTC text agree.
    assert row["start_ns"].isdigit() and len(row["start_ns"]) == 19
    assert row["timestamp"].replace("-", "").replace(":", "").replace(" ", "").replace(".", "")[-9:] == row["start_ns"][-9:]


def test_limit_is_capped_at_500(dense_hour):
    start_ms, end_ms = dense_hour
    payload = spans(start_ms=start_ms, end_ms=end_ms, limit=5000)
    assert payload["limit"] == 500
    assert len(payload["rows"]) == 500


# ---------------------------------------------------------------- keyset

def test_keyset_pages_never_skip_or_duplicate_with_duplicate_span_ids(dense_hour):
    # A (TraceId, SpanId) stored twice at two timestamps, inside a window
    # narrowed by its own service, operation and attribute bucket.
    dup = []
    # Hour by hour back from the dense hour (not every hour holds one).
    for hours_back in range(24):
        end_ms = dense_hour[1] - hours_back * HOUR_MS
        dup = ch_rows(
            f"SELECT TraceId, SpanId, toUnixTimestamp64Milli(min(Timestamp)), toUnixTimestamp64Milli(max(Timestamp)), "
            f"any(ServiceName), any(SpanName), any(SpanAttributes['fixture.bucket']) FROM {TABLE} "
            f"WHERE {window(end_ms - HOUR_MS, end_ms)} GROUP BY TraceId, SpanId HAVING count() = 2 "
            f"AND uniqExact(Timestamp) = 2 AND max(Timestamp) - min(Timestamp) < 900 LIMIT 1")
        if dup:
            break
    if not dup:
        pytest.skip("no duplicated span ids in the fixture window")
    trace_id, span_id, lo, hi, service, operation, bucket = dup[0]
    lo_ms, hi_ms = int(lo) - 1000, int(hi) + 1000
    where = (f" AND ServiceName = {lit(service)} AND SpanName = {lit(operation)} "
             f"AND mapContains(SpanAttributes, 'fixture.bucket') AND SpanAttributes['fixture.bucket'] = {lit(bucket)}")
    expected = truth(lo_ms, hi_ms, where)
    assert 0 < len(expected) < 40000
    rows, payloads = walk(start_ms=lo_ms, end_ms=hi_ms, service=service, operation=operation,
                          tag=f"span:fixture.bucket={bucket}", limit=500)
    got = keys(rows)
    assert len(got) == len(set(got)), "a span was returned twice"
    assert got == expected
    copies = [key for key in got if key[1] == trace_id and key[2] == span_id]
    assert len(copies) == 2
    assert all(len(p["rows"]) == 500 for p in payloads[:-1])


@pytest.mark.parametrize("limit", [37, 100])
def test_keyset_pages_concatenate_to_the_direct_query(dense_hour, limit):
    start_ms, end_ms = dense_hour
    lo_ms = end_ms - 20 * 60_000
    expected = truth(lo_ms, end_ms, " AND StatusCode = 'Error'")
    assert len(expected) > 2 * limit
    rows, payloads = walk(start_ms=lo_ms, end_ms=end_ms, status="Error", limit=limit)
    assert keys(rows) == expected
    assert payloads[-1]["has_more"] is False and payloads[-1]["cursor"] is None


# ------------------------------------------------------- span-level filters

def test_filters_apply_per_span(dense_hour):
    start_ms, end_ms = dense_hour
    pair = ch_rows(
        f"SELECT ServiceName, SpanName, SpanKind FROM {TABLE} WHERE {window(start_ms, end_ms)} "
        f"GROUP BY ServiceName, SpanName, SpanKind ORDER BY count() DESC LIMIT 1")[0]
    service, operation, kind = pair
    params = dict(start_ms=start_ms, end_ms=end_ms, service=service, operation=operation, kind=kind,
                  status_not="Error", tag_not="span:fixture.bucket=3", tag_exists="resource:service.name",
                  min_duration_ms=5, max_duration_ms=40, limit=200,
                  columns="span:fixture.bucket,resource:service.name,otel.scope.name")
    payload = spans(**params)
    where = (f" AND ServiceName = {lit(service)} AND SpanName = {lit(operation)} AND SpanKind = {lit(kind)} "
             f"AND StatusCode != 'Error' AND NOT (mapContains(SpanAttributes, 'fixture.bucket') AND SpanAttributes['fixture.bucket'] = '3') "
             f"AND mapContains(ResourceAttributes, 'service.name') AND Duration >= 5000000 AND Duration <= 40000000")
    assert keys(payload["rows"]) == truth(start_ms, end_ms, where, limit=200)
    assert payload["attribute_columns"] == [
        {"scope": "span", "key": "fixture.bucket"}, {"scope": "resource", "key": "service.name"}, {"scope": "any", "key": "otel.scope.name"}]
    for row in payload["rows"]:
        assert row["service_name"] == service and row["span_name"] == operation and row["span_kind"] == kind
        assert row["status_code"] != "Error"
        assert 5_000_000 <= row["duration_ns"] <= 40_000_000
        bucket, resource_service, scope_name = row["attributes"]
        assert bucket != "3" and resource_service == service and scope_name is not None
    # Attribute values equal the stored ones.
    sample = payload["rows"][:5]
    stored = {(r[0], r[1]): (r[2], r[3]) for r in ch_rows(
        f"SELECT TraceId, SpanId, SpanAttributes['fixture.bucket'], ResourceAttributes['service.name'] FROM {TABLE} "
        f"WHERE {window(start_ms, end_ms)} AND (TraceId, SpanId) IN ({', '.join(f'({lit(r['trace_id'])}, {lit(r['span_id'])})' for r in sample)})")}
    for row in sample:
        assert stored[(row["trace_id"], row["span_id"])] == (row["attributes"][0], row["attributes"][1])


def test_missing_attribute_columns_read_as_null(dense_hour):
    start_ms, end_ms = dense_hour
    payload = spans(start_ms=start_ms, end_ms=end_ms, limit=20, columns="span:no.such.key")
    assert payload["rows"] and all(row["attributes"] == [None] for row in payload["rows"])


def test_kind_filter_accepts_either_spelling(dense_hour):
    start_ms, end_ms = dense_hour
    payload = spans(start_ms=start_ms, end_ms=end_ms, kind=["Server", "SPAN_KIND_SERVER"], limit=50)
    assert payload["rows"] and {row["span_kind"] for row in payload["rows"]} <= {"Server", "SPAN_KIND_SERVER"}


# ------------------------------------------------------- progressive slices

def test_slices_widen_newest_first_until_the_page_fills(full_range):
    start_ms, end_ms = full_range
    # About one error span per few thousand: the first slices are too small.
    payload = spans(start_ms=start_ms, end_ms=end_ms, status="Error", tag="span:fixture.bucket=7", limit=500)
    print(f"7 d, status + tag, 500 spans: {payload['timing_ms']} ms, slices "
          f"{[(int(s['end_ns']) - int(s['start_ns']) + 1) // MIN_NS for s in payload['slices']]} min")
    slices = payload["slices"]
    assert int(slices[0]["end_ns"]) == end_ms * 10**6
    assert int(slices[0]["end_ns"]) - int(slices[0]["start_ns"]) + 1 == 15 * MIN_NS
    contiguous(slices)
    widths = [int(s["end_ns"]) - int(s["start_ns"]) + 1 for s in slices]
    if not payload["incomplete"]:
        # Without a budget stop, the widths follow 15 min, 1 h, 6 h, 24 h.
        assert widths[: min(len(widths), 3)] == [15 * MIN_NS, 60 * MIN_NS, 360 * MIN_NS][: min(len(widths), 3)]
    assert payload["timing_ms"]["total"] < FILTERED_PAGE_BUDGET_MS


def test_a_filter_matching_nothing_reads_the_range_back_to_its_start(full_range):
    start_ms, end_ms = full_range
    payload = spans(start_ms=start_ms, end_ms=end_ms, tag="span:fixture.bucket=no-such-bucket")
    assert payload["rows"] == []
    slices = payload["slices"]
    contiguous(slices)
    if payload["incomplete"]:
        assert payload["has_more"] and payload["cursor"]
    else:
        assert payload["has_more"] is False and payload["cursor"] is None
        assert int(slices[-1]["start_ns"]) == start_ms * 10**6
    assert payload["timing_ms"]["total"] < FILTERED_PAGE_BUDGET_MS


def test_budget_stop_returns_a_resume_cursor_that_loses_nothing(dense_hour):
    # budget_ms=0: each page reads one slice, then stops with a cursor at the
    # slice boundary; following the cursors yields the direct query's spans.
    start_ms, end_ms = dense_hour
    lo_ms = end_ms - 3 * HOUR_MS
    where = " AND StatusCode = 'Error' AND SpanAttributes['fixture.bucket'] = '9'"
    expected = truth(lo_ms, end_ms, where)
    first = spans(start_ms=lo_ms, end_ms=end_ms, status="Error", tag="span:fixture.bucket=9", limit=500, budget_ms=0)
    assert len(first["slices"]) == 1
    if len(first["rows"]) < 500:
        assert first["incomplete"] is True and first["stop_reason"] == "time_budget"
        assert first["has_more"] and first["cursor"]
        assert first["searched_to_ns"] == str(int(first["slices"][0]["start_ns"]) - 1)
    rows, payloads = walk(start_ms=lo_ms, end_ms=end_ms, status="Error", tag="span:fixture.bucket=9", limit=500, budget_ms=0)
    assert keys(rows) == expected
    assert any(p["incomplete"] for p in payloads)
    # A budget stop resumes at its slice boundary: the next page's slice
    # starts right below it (no gap, no overlap).
    for page, after in zip(payloads, payloads[1:]):
        if page["incomplete"]:
            assert page["cursor"].split(".")[3] == "b"
            assert int(after["slices"][0]["end_ns"]) == int(page["slices"][-1]["start_ns"]) - 1


def test_seven_day_filtered_pages_stay_bounded(full_range):
    start_ms, end_ms = full_range
    cursor = ""
    times = []
    for _ in range(3):
        payload = spans(start_ms=start_ms, end_ms=end_ms, status="Error", tag="span:fixture.bucket=7",
                        service_not="api_service", limit=100, **({"cursor": cursor} if cursor else {}))
        times.append(payload["timing_ms"]["total"])
        assert payload["timing_ms"]["total"] < FILTERED_PAGE_BUDGET_MS
        if not payload["has_more"]:
            break
        cursor = payload["cursor"]
    print(f"7 d filtered pages: {times} ms")


# ------------------------------------------------------------- validation

@pytest.mark.parametrize("params,code", [
    ({"cursor": "nope"}, "invalid_cursor"),
    ({"cursor": "1.99999999999999999999.1.k.00.00"}, "invalid_cursor"),
    ({"cursor": "1.5.900000000000.x.00.00"}, "invalid_cursor"),
    ({"columns": "span:" + "k" * 600}, "invalid_trace_columns"),
    ({"columns": ",".join(f"span:k{i}" for i in range(21))}, "invalid_trace_columns"),
    ({"kind": "x" * 65}, "invalid_trace_filter"),
    ({"status": "Bad"}, "invalid_trace_filter"),
    ({"min_duration_ms": 10, "max_duration_ms": 5}, "invalid_trace_duration"),
])
def test_invalid_requests_are_rejected(dense_hour, params, code):
    start_ms, end_ms = dense_hour
    response = get("/api/traces/spans", start_ms=start_ms, end_ms=end_ms, **params)
    assert response.status_code == 400, response.text
    assert response.json()["error_code"] == code


def test_cursor_after_the_range_end_is_rejected(dense_hour):
    start_ms, end_ms = dense_hour
    payload = spans(start_ms=start_ms, end_ms=end_ms, limit=10)
    response = get("/api/traces/spans", start_ms=start_ms - HOUR_MS, end_ms=start_ms, cursor=payload["cursor"])
    assert response.status_code == 400 and response.json()["error_code"] == "invalid_cursor"


# ---------------------------------------------------------- one span by key

def test_span_endpoint_returns_the_row_by_its_key(dense_hour, meta):
    start_ms, end_ms = dense_hour
    row = spans(start_ms=start_ms, end_ms=end_ms, limit=1)["rows"][0]
    response = get("/api/traces/span", trace_id=row["trace_id"], span_id=row["span_id"], timestamp_ns=row["start_ns"])
    assert response.status_code == 200, response.text
    span = response.json()["span"]
    assert span["start_ns_text"] == row["start_ns"]
    assert (span["trace_id"], span["span_id"], span["service_name"], span["span_name"]) == (
        row["trace_id"], row["span_id"], row["service_name"], row["span_name"])
    stored = ch_rows(
        f"SELECT toJSONString(SpanAttributes) FROM {TABLE} WHERE Timestamp = fromUnixTimestamp64Nano({row['start_ns']}) "
        f"AND TraceId = {lit(row['trace_id'])} AND SpanId = {lit(row['span_id'])} LIMIT 1")[0][0]
    if meta["features"]["span_attributes"]:
        assert span["span_attributes"] == stored
    missing = get("/api/traces/span", trace_id=row["trace_id"], span_id=row["span_id"], timestamp_ns=int(row["start_ns"]) + 1)
    assert missing.status_code == 404
    assert get("/api/traces/span", trace_id=row["trace_id"]).status_code == 400
