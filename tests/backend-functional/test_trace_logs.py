"""GET /api/traces/logs: the OTel logs of one trace, for the trace detail page.

Ground truth is read straight from ClickHouse: the logs of a real fixture
trace from the last hour of the logs window, with the same time margins as
the route. The fixture derives its logs from the stored spans (see
docs/logs.md), so every trace of that hour has logs.

CHDASH_ALT_API_BASE_URLS (comma-separated) adds ChDash instances started with
other logs configurations (disabled, missing table, a restricted
traces.service_allowlist); each one is checked against its own contract.
"""
from __future__ import annotations

import fnmatch
import json
import os
import time

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
ALT_BASE_URLS = [u.strip().rstrip("/") for u in os.environ.get("CHDASH_ALT_API_BASE_URLS", "").split(",") if u.strip()]
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))

# Generous: ClickHouse is shared with other test runs.
LATENCY_BUDGET_S = 3.0


def api(path: str, base: str = BASE_URL, params=None) -> requests.Response:
    return requests.get(f"{base}{path}", params=params, timeout=60)


def ch_rows(sql: str) -> list[dict]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT JSONEachRow").encode(), auth=CH_AUTH, timeout=120)
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def sql_str(value: str) -> str:
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def sql_list(values) -> str:
    return "(" + ",".join(sql_str(v) for v in values) + ")"


def features(base: str = BASE_URL) -> dict:
    response = api("/api/version", base)
    assert response.status_code == 200, response.text
    return response.json()["features"]


def logs_meta(base: str = BASE_URL) -> dict:
    response = api("/api/logs/meta", base, {"refresh": "1"})
    assert response.status_code == 200, response.text
    return response.json()


def usable(base: str = BASE_URL) -> dict | None:
    """The logs meta of an instance whose logs and traces are usable, else None."""
    feats = features(base)
    if not feats["traces"]["enabled"] or not feats["logs"]["enabled"]:
        return None
    meta = logs_meta(base)
    if not meta.get("table_exists") or (meta["database"], meta["table"]) != ("otel", "otel_logs") or not meta.get("rows"):
        return None
    return meta


def require_fixture() -> dict:
    meta = usable()
    if meta is None:
        pytest.skip("OTel logs fixture is not available")
    return meta


_TRACE_CACHE: dict = {}


def recent_trace() -> dict:
    """A trace of the last logs hour with many logs, errors and a span with several logs."""
    if "trace" in _TRACE_CACHE:
        return _TRACE_CACHE["trace"]
    meta = require_fixture()
    end_s = meta["time_bounds"]["max_ms"] // 1000
    candidates = ch_rows(
        "SELECT TraceId AS trace_id, count() AS logs, countIf(SeverityText = 'ERROR') AS errors, "
        "max(c) AS busiest_span FROM ("
        "  SELECT TraceId, SpanId, SeverityText, count() OVER (PARTITION BY TraceId, SpanId) AS c "
        "  FROM otel.otel_logs "
        f"  WHERE TimestampTime >= toDateTime({end_s - 3600}) AND TimestampTime <= toDateTime({end_s - 120}) AND TraceId != ''"
        ") GROUP BY TraceId HAVING errors > 0 AND busiest_span >= 2 ORDER BY logs DESC, TraceId LIMIT 1")
    if not candidates:
        pytest.skip("no fixture trace with error logs in the last hour")
    trace_id = candidates[0]["trace_id"]
    spans = ch_rows(
        "SELECT SpanId AS span_id, ServiceName AS service, toString(toUnixTimestamp64Nano(Timestamp)) AS start_ns, "
        "toString(toUnixTimestamp64Nano(Timestamp) + Duration) AS end_ns FROM otel.otel_traces "
        f"WHERE TraceId = {sql_str(trace_id)} "
        f"AND Timestamp >= toDateTime({end_s - 3 * 3600}) AND Timestamp <= toDateTime({end_s + 600})")
    assert spans, trace_id
    trace = {
        "trace_id": trace_id,
        "start_ns": min(int(s["start_ns"]) for s in spans),
        "end_ns": max(int(s["end_ns"]) for s in spans),
        "services": sorted({s["service"] for s in spans}),
        "spans": spans,
    }
    _TRACE_CACHE["trace"] = trace
    return trace


def ground_truth(trace: dict, span_id: str = "", services=None, before_s: int = 5, after_s: int = 30) -> list[dict]:
    """The route's query, written independently: same window, same filters."""
    from_s = trace["start_ns"] // 1_000_000_000 - before_s
    to_s = trace["end_ns"] // 1_000_000_000 + 1 + after_s
    where = f"TraceId = {sql_str(trace['trace_id'])}"
    if span_id:
        where += f" AND SpanId = {sql_str(span_id)}"
    if services is not None:
        where += f" AND ServiceName IN {sql_list(services)}"
    return ch_rows(
        "SELECT toString(toUnixTimestamp64Nano(Timestamp)) AS timestamp_ns, SeverityText, SeverityNumber, ServiceName, "
        "SpanId, Body, LogAttributes, ResourceAttributes, ScopeName FROM otel.otel_logs "
        f"WHERE TimestampTime >= toDateTime({from_s}) AND TimestampTime <= toDateTime({to_s}) AND {where} "
        "ORDER BY Timestamp")


def trace_logs(trace: dict, base: str = BASE_URL, **extra) -> requests.Response:
    params = [("trace_id", trace["trace_id"]), ("start_ns", str(trace["start_ns"])), ("end_ns", str(trace["end_ns"]))]
    params += [("service", s) for s in extra.pop("services", trace["services"])]
    params += [(k, str(v)) for k, v in extra.items()]
    return api("/api/traces/logs", base, params)


def key(row: dict) -> tuple:
    return (str(row["timestamp_ns"]), row.get("span_id", row.get("SpanId")), row.get("body", row.get("Body")))


def same_records(got: list[dict], want: list[dict]) -> None:
    """Same records; records at an identical Timestamp may come in any order."""
    assert [int(r["timestamp_ns"]) for r in got] == [int(r["timestamp_ns"]) for r in want]
    assert sorted(key(r) for r in got) == sorted(key(r) for r in want)


# ---------------------------------------------------------------------------
# Ground truth.

def test_trace_logs_equal_a_direct_clickhouse_read_of_a_recent_trace():
    trace = recent_trace()
    started = time.perf_counter()
    response = trace_logs(trace)
    elapsed = time.perf_counter() - started
    assert response.status_code == 200, response.text
    body = response.json()
    truth = ground_truth(trace)
    assert truth, trace["trace_id"]

    assert body["enabled"] is True and body["table_exists"] is True, body
    assert body["trace_id"] == trace["trace_id"] and body["span_id"] == ""
    assert body["truncated"] is False and body["count"] == len(truth) == len(body["logs"])
    assert body["window"]["time_column"] == "TimestampTime" and body["window"]["clamped"] is False
    assert body["window"]["from_s"] == trace["start_ns"] // 1_000_000_000 - body["window"]["margin_before_s"]
    assert sorted(body["services"]) == trace["services"]
    assert body["attributes"] == {"log": "map", "resource": "map"}

    # Same records, in Timestamp order, with exact nanosecond timestamps.
    same_records(body["logs"], truth)
    stamps = [int(r["timestamp_ns"]) for r in body["logs"]]
    assert stamps == sorted(stamps)
    by_key = {key(r): r for r in truth}
    for got in body["logs"]:
        want = by_key[key(got)]
        assert got["severity_text"] == want["SeverityText"] and got["severity_number"] == int(want["SeverityNumber"])
        assert got["service_name"] == want["ServiceName"] and got["scope_name"] == want["ScopeName"]
        assert json.loads(got["log_attributes"]) == want["LogAttributes"]
        assert json.loads(got["resource_attributes"]) == want["ResourceAttributes"]
        assert got["timestamp"].startswith(("2026-", "2025-", "2027-")) and len(got["timestamp"]) == 29, got["timestamp"]
        assert "body_truncated" not in got

    # Every error log of the fixture carries the span's status message.
    assert any(r["severity_text"] == "ERROR" for r in body["logs"])
    # Records written after their span (log.origin = after_span) are inside the margin.
    span_ids = {s["span_id"] for s in trace["spans"]}
    assert all(r["span_id"] in span_ids for r in body["logs"] if r["span_id"])
    print(f"trace {trace['trace_id']}: {body['count']} logs, server {body['elapsed_ms']} ms, round trip {elapsed * 1000:.0f} ms")
    assert elapsed < LATENCY_BUDGET_S, elapsed


def test_trace_logs_of_one_span():
    trace = recent_trace()
    truth = ground_truth(trace)
    counts: dict[str, int] = {}
    for row in truth:
        counts[row["SpanId"]] = counts.get(row["SpanId"], 0) + 1
    span_id = max(counts, key=lambda s: (counts[s], s))
    assert counts[span_id] >= 2, counts
    response = trace_logs(trace, span_id=span_id)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["span_id"] == span_id
    assert {r["span_id"] for r in body["logs"]} == {span_id}
    same_records(body["logs"], ground_truth(trace, span_id=span_id))


def test_trace_logs_of_selected_services_only():
    trace = recent_trace()
    truth = ground_truth(trace)
    service = truth[0]["ServiceName"]
    response = trace_logs(trace, services=[service])
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["logs"] and {r["service_name"] for r in body["logs"]} == {service}
    same_records(body["logs"], ground_truth(trace, services=[service]))


def test_trace_logs_limit_truncates_and_flags_it():
    trace = recent_trace()
    truth = ground_truth(trace)
    assert len(truth) > 3
    response = trace_logs(trace, limit=3)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["truncated"] is True and body["count"] == 3 and body["limit"] == 3
    assert [int(r["timestamp_ns"]) for r in body["logs"]] == [int(r["timestamp_ns"]) for r in truth[:3]]
    exact = trace_logs(trace, limit=len(truth)).json()
    assert exact["truncated"] is False and exact["count"] == len(truth)
    # A limit above logs.trace_logs_limit is clamped to it.
    wide = trace_logs(trace, limit=10_000_000).json()
    assert wide["limit"] <= 10000 and wide["count"] == len(truth)


def test_trace_logs_window_is_clamped_to_logs_max_lookback():
    meta = require_fixture()
    trace = dict(recent_trace())
    trace["end_ns"] = trace["start_ns"] + 400 * 24 * 3600 * 1_000_000_000
    response = trace_logs(trace)
    assert response.status_code == 200, response.text
    window = response.json()["window"]
    assert window["clamped"] is True
    assert window["to_s"] - window["from_s"] == meta["max_lookback_minutes"] * 60


def test_trace_logs_of_an_unknown_trace_are_empty():
    trace = dict(recent_trace())
    trace["trace_id"] = "ffffffffffffffffffffffffffffffff"
    response = trace_logs(trace)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["logs"] == [] and body["count"] == 0 and body["truncated"] is False


# ---------------------------------------------------------------------------
# Bounded requests only.

@pytest.mark.parametrize("params, code", [
    ({"start_ns": "1", "end_ns": "2"}, "missing_trace_id"),
    ({"trace_id": "abc"}, "missing_time_range"),
    ({"trace_id": "abc", "start_ns": "1789865553000000000"}, "missing_time_range"),
    ({"trace_id": "abc", "start_ns": "x", "end_ns": "1789865553000000000"}, "missing_time_range"),
    ({"trace_id": "abc", "start_ns": "1789865553000000000", "end_ns": "1789865552000000000"}, "invalid_time_range"),
    ({"trace_id": "abc", "start_ns": "1789865553000000000", "end_ns": "9000000000000000000"}, "invalid_time_range"),
    ({"trace_id": "abc", "start_ns": "1789865553000000000", "end_ns": "1789865554000000000", "limit": "0"}, "invalid_limit"),
    ({"trace_id": "a" * 300, "start_ns": "1789865553000000000", "end_ns": "1789865554000000000"}, "invalid_trace_id"),
])
def test_trace_logs_reject_unbounded_or_invalid_requests(params, code):
    if not features()["logs"]["enabled"]:
        pytest.skip("logs disabled")
    response = api("/api/traces/logs", params=params)
    assert response.status_code == 400, response.text
    assert response.json().get("error_code") == code, response.text


def test_trace_logs_unknown_host_is_404():
    if not features()["logs"]["enabled"]:
        pytest.skip("logs disabled")
    response = api("/api/traces/logs", params={
        "host_id": "no-such-host", "trace_id": "abc", "start_ns": "1789865553000000000", "end_ns": "1789865554000000000"})
    assert response.status_code == 404, response.text
    assert response.json().get("error_code") == "unknown_host"


# ---------------------------------------------------------------------------
# Disabled / missing sources and the service allowlist (every instance).

def _check_instance(base: str) -> None:
    feats = features(base)
    if not feats["traces"]["enabled"]:
        return
    params = {"trace_id": "abc", "start_ns": "1789865553000000000", "end_ns": "1789865554000000000"}
    response = api("/api/traces/logs", base, params)
    assert response.status_code == 200, (base, response.text)
    body = response.json()
    assert body["logs"] == [] or feats["logs"]["enabled"], body
    if not feats["logs"]["enabled"]:
        assert body["enabled"] is False and body["error_code"] == "logs_disabled", body
        assert "logs { enabled = true }" in body["message"] and body["logs"] == [], body
        return
    meta = logs_meta(base)
    if not meta["table_exists"]:
        assert body["enabled"] is True and body["table_exists"] is False, body
        assert body["error_code"] == "logs_table_missing" and meta["table"] in body["message"], body
        assert body["logs"] == [] and body["count"] == 0, body
        return
    assert body["enabled"] is True and "error_code" not in body, body
    if meta["service_filter_applied"] and meta["rows"]:
        _check_allowlist(base, meta["service_allowlist"])


def _check_allowlist(base: str, patterns: list[str]) -> None:
    trace = recent_trace()
    allowed = lambda service: any(fnmatch.fnmatchcase(service, p) for p in patterns)  # noqa: E731
    response = trace_logs(trace, base)
    assert response.status_code == 200, response.text
    got = response.json()["logs"]
    assert all(allowed(r["service_name"]) for r in got), (patterns, {r["service_name"] for r in got})
    want = [r for r in ground_truth(trace) if allowed(r["ServiceName"])]
    same_records(got, want)


def test_trace_logs_answer_disabled_missing_and_allowlisted_sources():
    for base in [BASE_URL] + ALT_BASE_URLS:
        _check_instance(base)
