"""Services view endpoints of the Trace Explorer against the OTel fixture.

/api/traces/services (RED metrics of entry spans per service, per endpoint
and per bucket, slowest spans, release first-seen times) and
/api/traces/services/db (database statements), each compared with a direct
ClickHouse query over the same window. Timing budgets are generous: the
ClickHouse server is shared with other test runs.
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

ENTRY = "(SpanKind IN ('Server', 'Consumer', 'SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')"
ORIGIN_MS = 3_600_000
EXACT_ROWS = 150_000_000


def get(path: str, **kwargs):
    return SESSION.get(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 60), **kwargs)


def ch_rows(sql: str) -> list[list[str]]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT TSV").encode(), auth=CH_AUTH, timeout=180)
    assert response.status_code == 200, response.text
    return [line.split("\t") for line in response.text.splitlines() if line]


def window(start_ms: int, end_ms: int) -> str:
    return f"Timestamp >= fromUnixTimestamp64Milli({start_ms}) AND Timestamp <= fromUnixTimestamp64Milli({end_ms})"


@pytest.fixture(scope="module")
def fixture_end_ms() -> int:
    rows = ch_rows("SELECT toUnixTimestamp64Milli(max(Start)) FROM otel.otel_traces_trace_id_ts")
    end_ms = int(rows[0][0]) if rows and rows[0][0] else 0
    if end_ms <= 0:
        pytest.skip("OTEL fixture is empty")
    return end_ms + 1


def services(params: dict, *, timeout: int = 90, path: str = "/api/traces/services") -> dict:
    response = get(path, params={"host_id": "local", **params}, timeout=timeout)
    if response.status_code == 404 and response.json().get("error_code") == "trace_analytics_disabled":
        pytest.skip("trace analytics (and the services view) disabled in this configuration")
    assert response.status_code == 200, response.text
    return response.json()


def by_name(payload: dict, key: str = "services") -> dict[str, list]:
    return {row[0]: row for row in payload.get(key) or []}


def assert_quantile_close(actual: int, expected: float, label: str) -> None:
    # t-digest (merged from per-bucket states) against exact quantiles.
    assert abs(actual - expected) <= max(0.1 * expected, 2_000_000), (label, actual, expected)


def test_services_match_ground_truth_per_service_and_bucket(fixture_end_ms):
    start_ms, end_ms = fixture_end_ms - 3_600_000, fixture_end_ms
    started = time.monotonic()
    payload = services({"start_ms": start_ms, "end_ms": end_ms, "bucket_origin_ms": ORIGIN_MS})
    elapsed = time.monotonic() - started
    assert payload["scope"] == "entry" and payload["estimated"] is False and payload["partial"] is False, payload
    assert payload["columns"] == ["service", "spans", "errors", "p50_ns", "p95_ns", "p99_ns", "total_ns"]
    # Target 1 s on the ~2 B span fixture; generous for a shared server.
    assert elapsed < 10, f"1 h of services took {elapsed:.1f} s"
    truth = {
        row[0]: row for row in ch_rows(
            "SELECT ServiceName, count(), countIf(StatusCode = 'Error'), sum(Duration), "
            "quantileExact(0.5)(Duration), quantileExact(0.95)(Duration), quantileExact(0.99)(Duration) "
            f"FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND {ENTRY} GROUP BY ServiceName")
    }
    got = by_name(payload)
    assert set(got) == set(truth) and got, (sorted(got), sorted(truth))
    for name, row in truth.items():
        service = got[name]
        assert service[1] == int(row[1]) and service[2] == int(row[2]) and service[6] == int(row[3]), (name, service, row)
        for index, label in ((3, "p50"), (4, "p95"), (5, "p99")):
            assert_quantile_close(service[index], float(row[index + 1]), f"{name} {label}")
        assert service[3] <= service[4] <= service[5]
    # Buckets of the analytics grid, anchored at bucket_origin_ms.
    bucket_ms = int(payload["bucket_ms"])
    origin = int(payload["bucket_origin_ms"])
    assert origin == ORIGIN_MS % bucket_ms
    name = max(truth, key=lambda key: int(truth[key][1]))
    expected = {
        int(bucket): (int(count), int(errors)) for bucket, count, errors in ch_rows(
            f"SELECT {origin} + intDiv(toUnixTimestamp64Milli(Timestamp) - {origin}, {bucket_ms}) * {bucket_ms}, count(), "
            f"countIf(StatusCode = 'Error') FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND {ENTRY} "
            f"AND ServiceName = '{name}' GROUP BY 1")
    }
    series = {int(point[0]): (int(point[1]), int(point[2])) for point in payload["series"][name]}
    assert series == expected
    assert sum(count for count, _ in series.values()) == got[name][1]


def test_services_honour_the_span_filters(fixture_end_ms):
    start_ms, end_ms = fixture_end_ms - 1_800_000, fixture_end_ms
    base = {"start_ms": start_ms, "end_ms": end_ms}
    everything = by_name(services(base))
    assert len(everything) >= 2, everything
    first, second = sorted(everything)[:2]
    only = by_name(services({**base, "service": first}))
    assert list(only) == [first] and only[first][1] == everything[first][1]
    without = by_name(services({**base, "service_not": first}))
    assert first not in without and set(without) == set(everything) - {first}
    errors = by_name(services({**base, "status": "Error"}))
    for name, row in errors.items():
        assert row[1] == row[2] == everything[name][2], (name, row)
    # Attribute filters describe the entry span itself.
    key = ch_rows(f"SELECT arrayJoin(mapKeys(SpanAttributes)) FROM otel.otel_traces WHERE {window(start_ms, end_ms)} "
                  f"AND {ENTRY} AND ServiceName = '{second}' LIMIT 1")
    if key:
        present = by_name(services({**base, "tag_exists": f"span:{key[0][0]}", "service": second}))
        truth = ch_rows(f"SELECT count() FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND {ENTRY} "
                        f"AND ServiceName = '{second}' AND mapContains(SpanAttributes, '{key[0][0]}')")
        assert present[second][1] == int(truth[0][0])
    # Duration bounds apply to the span's own Duration.
    p50_ms = everything[first][3] / 1e6
    slow = by_name(services({**base, "service": first, "min_duration_ms": p50_ms}))
    truth = ch_rows(f"SELECT count() FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND {ENTRY} "
                    f"AND ServiceName = '{first}' AND Duration >= {round(p50_ms * 1e6)}")
    assert slow.get(first, [None, 0])[1] == int(truth[0][0])
    # Root spans only.
    roots = by_name(services({**base, "scope": "root"}))
    truth = {row[0]: int(row[1]) for row in ch_rows(
        f"SELECT ServiceName, count() FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND ParentSpanId = '' GROUP BY 1")}
    assert {name: row[1] for name, row in roots.items()} == truth


def test_service_detail_lists_endpoints_slowest_spans_and_releases(fixture_end_ms):
    start_ms, end_ms = fixture_end_ms - 3_600_000, fixture_end_ms
    name = ch_rows(f"SELECT ServiceName FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND {ENTRY} "
                   "GROUP BY 1 ORDER BY count() DESC LIMIT 1")[0][0]
    payload = services({"start_ms": start_ms, "end_ms": end_ms, "detail": name})
    assert payload["detail"] == name and list(by_name(payload)) == [name]
    truth = {row[0]: row for row in ch_rows(
        "SELECT SpanName, count(), countIf(StatusCode = 'Error'), sum(Duration) FROM otel.otel_traces "
        f"WHERE {window(start_ms, end_ms)} AND {ENTRY} AND ServiceName = '{name}' GROUP BY 1")}
    endpoints = by_name(payload, "endpoints")
    assert set(endpoints) == set(truth)
    for op, row in truth.items():
        assert endpoints[op][1:3] == [int(row[1]), int(row[2])] and endpoints[op][6] == int(row[3])
    totals = [row[6] for row in payload["endpoints"]]
    assert totals == sorted(totals, reverse=True)
    slowest = payload["slowest"]
    assert slowest and payload["slowest_columns"][4] == "duration_ns"
    durations = [row[4] for row in slowest]
    assert durations == sorted(durations, reverse=True)
    top = ch_rows(f"SELECT max(Duration) FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND {ENTRY} AND ServiceName = '{name}'")
    assert durations[0] == int(top[0][0])
    assert all(start_ms <= row[3] <= end_ms and len(row[0]) > 0 for row in slowest)
    # Releases: the first span of each service.version in the window.
    assert payload["releases_supported"] is True
    versions = {row[0]: int(row[1]) for row in ch_rows(
        f"SELECT ResourceAttributes['service.version'] AS v, toUnixTimestamp64Milli(min(Timestamp)) FROM otel.otel_traces "
        f"WHERE {window(start_ms, end_ms)} AND ServiceName = '{name}' AND v != '' GROUP BY v")}
    assert {row[0]: row[1] for row in payload["releases"]} == versions


def test_long_windows_are_sampled_by_time_bounded_and_close_to_ground_truth(fixture_end_ms):
    end_ms = fixture_end_ms
    start_ms = end_ms - 7 * 86_400_000 + 1000
    estimate = sum(int(row[3]) for row in ch_rows(
        f"EXPLAIN ESTIMATE SELECT 1 FROM otel.otel_traces WHERE {window(start_ms, end_ms)}"))
    if estimate <= EXACT_ROWS:
        pytest.skip("the fixture's week is small enough to be read whole")
    started = time.monotonic()
    payload = services({"start_ms": start_ms, "end_ms": end_ms, "bucket_origin_ms": ORIGIN_MS}, timeout=120)
    elapsed = time.monotonic() - started
    assert payload["estimated"] is True and 0 < payload["sample_fraction"] < 1, payload
    assert payload["estimated_rows"] > EXACT_ROWS
    assert elapsed < 30, f"7 days of services took {elapsed:.1f} s"
    truth = {row[0]: int(row[1]) for row in ch_rows(
        f"SELECT ServiceName, count() FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND {ENTRY} GROUP BY 1")}
    got = by_name(payload)
    assert set(got) == set(truth)
    for name, count in truth.items():
        assert abs(got[name][1] - count) <= 0.15 * count, (name, got[name][1], count)
    # Every bucket of the grid is sampled: the buckets holding spans are
    # listed (a bucket whose spans all lie outside its slice may be missed).
    bucket_ms = int(payload["bucket_ms"])
    origin = int(payload["bucket_origin_ms"])
    name = max(truth, key=truth.get)
    buckets = {int(point[0]) for point in payload["series"][name]}
    filled = {int(row[0]) for row in ch_rows(
        f"SELECT DISTINCT {origin} + intDiv(toUnixTimestamp64Milli(Timestamp) - {origin}, {bucket_ms}) * {bucket_ms} "
        f"FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND ServiceName = '{name}'")}
    assert buckets <= filled and len(buckets) >= 0.9 * len(filled), (sorted(filled - buckets), len(filled))
    # exact=1 reads the whole window (still time-bounded: partial when stopped).
    exact = services({"start_ms": end_ms - 2 * 86_400_000, "end_ms": end_ms, "exact": "1"}, timeout=120)
    assert exact["estimated"] is False and exact["sample_fraction"] == 1


def test_database_statements_match_ground_truth(fixture_end_ms):
    start_ms, end_ms = fixture_end_ms - 3_600_000, fixture_end_ms
    payload = services({"start_ms": start_ms, "end_ms": end_ms}, path="/api/traces/services/db")
    assert payload["supported"] is True and payload["estimated"] is False, payload
    assert payload["columns"] == ["service", "statement", "db_system", "spans", "errors", "total_ns", "p95_ns"]
    truth = {(row[0], row[1]): int(row[2]) for row in ch_rows(
        "SELECT ServiceName, coalesce(nullif(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement']) AS s, count() "
        f"FROM otel.otel_traces WHERE {window(start_ms, end_ms)} AND s != '' GROUP BY 1, 2 ORDER BY sum(Duration) DESC LIMIT 50")}
    # The fixture usually has no database spans: the answer is then empty.
    assert {(row[0], row[1]): row[3] for row in payload["statements"]} == truth


def test_services_reject_malformed_parameters(fixture_end_ms):
    base = {"host_id": "local", "start_ms": fixture_end_ms - 60_000, "end_ms": fixture_end_ms}
    for params, code in (({"scope": "all"}, "invalid_trace_filter"), ({"detail": "x" * 2000}, "invalid_trace_filter"),
                         ({"min_duration_ms": 10, "max_duration_ms": 1}, "invalid_trace_duration"),
                         ({"status": "Nope"}, "invalid_trace_filter"), ({"start_ms": 5}, "invalid_trace_range")):
        for route in ("/api/traces/services", "/api/traces/services/db"):
            response = get(route, params={**base, **params})
            if response.status_code == 404:
                pytest.skip("services view disabled in this configuration")
            assert response.status_code == 400, (route, params, response.text)
            assert response.json().get("error_code") == code, (route, params, response.text)
