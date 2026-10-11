"""A filtered trace search that reaches the cap of its index scan keeps what it found.

The search tests the traces of the trace index in rank order (newest index row first), up to a cap, until `limit` of them have a span
that matches the filters. When it reaches the cap with fewer than `limit` traces (a rare filter), it used to throw them away and rank the
whole window by the spans. Now it keeps them, and the span ranking finds the other traces among the ones that the scan did not test
(search_path "trace_index_then_spans", fallback_reason "index_scan_cap").

`index_candidate_cap` lowers the cap (it never raises it), so that a window of the fixture reaches it. The expected answer is computed
here with direct ClickHouse queries over the same window, in the same order as the server: the index rank is the newest index row, then the
TraceId; the traces that the scan did not test are ranked by their first span.
"""
from __future__ import annotations

import os

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))

HOUR_MS = 3_600_000
# The rich fixture day (tests/README.md, "Rich OTel dataset"): 2026-09-12 UTC; its 10:00-11:00 hour holds request traffic, ~450 error spans.
RICH_DAY_MS = 1_789_171_200_000
START_MS, END_MS = RICH_DAY_MS + 10 * HOUR_MS, RICH_DAY_MS + 11 * HOUR_MS
LIMIT = 8


def ch_rows(sql: str) -> list[list[str]]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT TSV").encode(), auth=CH_AUTH, timeout=120)
    assert response.status_code == 200, response.text
    return [line.split("\t") for line in response.text.splitlines() if line]


def search(**params) -> dict:
    response = SESSION.get(f"{BASE_URL}/api/traces/search", params={"host_id": "local", "start_ms": START_MS, "end_ms": END_MS, **params}, timeout=120)
    assert response.status_code == 200, response.text
    return response.json()


def spans_window(column: str = "Timestamp") -> str:
    return f"{column} >= fromUnixTimestamp64Milli({START_MS}) AND {column} <= fromUnixTimestamp64Milli({END_MS})"


def expected(cap: int, limit: int, spans_filter: str) -> tuple[list[str], list[str], list[str]]:
    """(the traces that the scan keeps, the traces that the ranking adds, the traces of the index that the scan tests)."""
    tested_rows = ch_rows(
        "SELECT toString(TraceId), toString(toUnixTimestamp64Nano(toDateTime64(max(Start), 9))) AS ns "
        f"FROM otel.otel_traces_trace_id_ts WHERE {spans_window('Start')} GROUP BY TraceId ORDER BY max(Start) DESC, TraceId ASC LIMIT {cap}")
    tested = [row[0] for row in tested_rows]
    oldest_tested_ns = int(tested_rows[-1][1])
    matching = {row[0] for row in ch_rows(f"SELECT DISTINCT toString(TraceId) FROM otel.otel_traces WHERE {spans_window()} AND {spans_filter}")}
    kept = [trace for trace in tested if trace in matching][:limit]
    untested = matching - set(tested)
    completion: list[str] = []
    if len(kept) < limit and untested:
        ids = ", ".join("'" + trace + "'" for trace in sorted(untested))
        rows = ch_rows(
            "SELECT toString(TraceId), toString(toUnixTimestamp64Nano(min(Timestamp))) AS first_ns FROM otel.otel_traces "
            f"WHERE {spans_window()} AND Timestamp <= fromUnixTimestamp64Nano({oldest_tested_ns}) AND TraceId IN ({ids}) "
            f"GROUP BY TraceId ORDER BY min(Timestamp) DESC LIMIT {limit - len(kept)}")
        completion = [row[0] for row in rows]
    return kept, completion, tested


def test_a_scan_that_reaches_its_cap_keeps_the_traces_it_found_and_the_ranking_completes_the_answer():
    # Find a cap that the search reaches with fewer than LIMIT traces that match, and with traces to complete.
    for cap in (5, 10, 20, 40, 80):
        kept, completion, tested = expected(cap, LIMIT, "StatusCode = 'Error'")
        if 0 < len(kept) < LIMIT and completion:
            break
    else:
        pytest.skip("the fixture has no window where a cap is reached with some traces kept")
    body = search(status="Error", limit=LIMIT, index_candidate_cap=cap)
    assert body["search_path"] == "trace_index_then_spans", body
    assert body["fallback_reason"] == "index_scan_cap", body
    assert "partial" not in body, body
    ids = [row[0] for row in body["rows"]]
    assert set(ids) == set(kept) | set(completion), (cap, kept, completion, ids)
    assert len(ids) == len(set(ids)) == len(kept) + len(completion)
    # Whatever the path, the list is by the first span of the traces, newest first.
    starts = [row[1] for row in body["rows"]]
    assert starts == sorted(starts, reverse=True), starts


def test_the_cap_that_is_not_reached_changes_nothing():
    plain = search(status="Error", limit=LIMIT)
    capped = search(status="Error", limit=LIMIT, index_candidate_cap=640000)  # never raises the cap of 64,000
    assert plain["search_path"] == capped["search_path"]
    assert [row[0] for row in plain["rows"]] == [row[0] for row in capped["rows"]]
    assert "fallback_reason" not in plain and "partial" not in plain


def test_a_cap_that_matches_nothing_gives_the_whole_window_to_the_span_ranking():
    # No trace has this service: nothing is kept, and the answer is empty with the whole-window path, as it was before.
    body = search(service="no-such-service-for-the-cap-test", limit=LIMIT, index_candidate_cap=40)
    assert body["rows"] == []
    assert body.get("fallback_reason") in (None, "index_scan_cap")
    assert "partial" not in body
