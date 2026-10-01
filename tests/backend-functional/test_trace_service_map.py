"""/api/traces/service_map against the OTel fixture.

Edges (parent service -> child service of a cross-service parent / child span
pair) and nodes (spans per service) are compared with an unsampled direct
ClickHouse query on a small window; forced trace sampling must estimate the
same counts; the search filters select traces; wide windows stay within their
time budget through time slices and trace sampling.
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
MINUTE_MS = 60_000


def get(path: str, **kwargs):
    return SESSION.get(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 120), **kwargs)


def ch_rows(sql: str) -> list[list[str]]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT TSV").encode(), auth=CH_AUTH, timeout=300)
    assert response.status_code == 200, response.text
    return [line.split("\t") for line in response.text.splitlines() if line]


def service_map(params: dict) -> tuple[dict, float]:
    started = time.monotonic()
    response = get("/api/traces/service_map", params={"host_id": "local", **params})
    elapsed = time.monotonic() - started
    assert response.status_code == 200, response.text
    return response.json(), elapsed


@pytest.fixture(scope="module")
def window() -> tuple[int, int]:
    # Two minutes six hours before the newest trace: about a million spans on
    # the fixture's busy days, below both budgets (no sampling).
    rows = ch_rows("SELECT toUnixTimestamp64Milli(max(Start)) FROM otel.otel_traces_trace_id_ts")
    if not rows or rows[0][0] in ("", "0"):
        pytest.skip("OTEL fixture is empty")
    start = int(rows[0][0]) - 6 * 60 * MINUTE_MS
    start -= start % MINUTE_MS
    if int(ch_rows(f"SELECT count() FROM {TABLE} WHERE {time_sql(start, start + 2 * MINUTE_MS)}")[0][0]) == 0:
        pytest.skip("OTEL fixture has no spans in the probe window")
    return start, start + 2 * MINUTE_MS


def time_sql(start: int, end: int) -> str:
    return f"Timestamp >= fromUnixTimestamp64Milli({start}) AND Timestamp <= fromUnixTimestamp64Milli({end})"


def truth(start: int, end: int, trace_filter: str = "") -> tuple[dict, dict]:
    """Nodes {service: (spans, errors)} and edges {(parent, child): (calls, errors)},
    joining the (TraceId, SpanId) strings: independent of the endpoint's hashing.
    LEFT ANY: one parent per child (INNER ANY would also keep one child per parent)."""
    scope = f"FROM {TABLE} WHERE {time_sql(start, end)}"
    if trace_filter:
        scope += f" AND TraceId IN (SELECT TraceId FROM {TABLE} WHERE {time_sql(start, end)} AND {trace_filter})"
    nodes = {r[0]: (int(r[1]), int(r[2])) for r in ch_rows(
        f"SELECT ServiceName, count(), countIf(StatusCode = 'Error') {scope} GROUP BY ServiceName")}
    edges = {(r[0], r[1]): (int(r[2]), int(r[3])) for r in ch_rows(
        f"SELECT p.ServiceName, c.ServiceName, count(), countIf(c.StatusCode = 'Error') "
        f"FROM (SELECT TraceId, ParentSpanId, ServiceName, StatusCode {scope} AND ParentSpanId != '') AS c "
        f"ANY LEFT JOIN (SELECT TraceId, SpanId, ServiceName {scope}) AS p "
        f"ON c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId "
        f"WHERE p.ServiceName != '' AND p.ServiceName != c.ServiceName GROUP BY 1, 2")}
    return nodes, edges


def as_maps(body: dict) -> tuple[dict, dict]:
    nodes = {n["service"]: n for n in body["nodes"]}
    edges = {(e["source"], e["target"]): e for e in body["edges"]}
    return nodes, edges


def test_unsampled_map_equals_a_direct_parent_child_join(window):
    start, end = window
    body, _ = service_map({"start_ms": start, "end_ms": end})
    assert body["sampled"] is False and body["sample_factor"] == 1
    assert body["sampling"]["trace_factor"] == 1 and body["sampling"]["slices"] == 0
    assert body["sampling"]["estimate_source"] == "explain"
    assert body["edge_rule"] == "parent_child_cross_service"
    nodes, edges = as_maps(body)
    true_nodes, true_edges = truth(start, end)
    assert true_edges, "the fixture has cross-service parent / child spans"
    assert {k: (v["spans"], v["errors"]) for k, v in nodes.items()} == true_nodes
    assert {k: (v["calls"], v["errors"]) for k, v in edges.items()} == true_edges
    for (source, target), edge in edges.items():
        assert source != target
        assert edge["sampled_count"] == edge["calls"]
        assert 0 < edge["p50_ns"] <= edge["p95_ns"] <= edge["p99_ns"]
        assert edge["error_rate"] == pytest.approx(edge["errors"] / edge["calls"])
    # Durations: the child spans of the edge (reservoir quantiles, approximate).
    source, target = max(true_edges, key=lambda key: true_edges[key][0])
    p95 = float(ch_rows(
        f"SELECT quantileExact(0.95)(c.Duration) FROM (SELECT TraceId, ParentSpanId, Duration FROM {TABLE} "
        f"WHERE {time_sql(start, end)} AND ServiceName = '{target}') AS c ANY LEFT JOIN "
        f"(SELECT TraceId, SpanId, 1 AS found FROM {TABLE} WHERE {time_sql(start, end)} AND ServiceName = '{source}') AS p "
        f"ON c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId WHERE p.found = 1")[0][0])
    assert edges[(source, target)]["p95_ns"] == pytest.approx(p95, rel=0.1)


def test_edge_kind_is_async_for_messaging_spans(window):
    """An edge is "async" when most of its child spans are Consumer spans or have
    a Producer parent (messaging), else "sync": the map dashes async calls."""
    start, end = window
    body, _ = service_map({"start_ms": start, "end_ms": end})
    _, edges = as_maps(body)
    scope = f"FROM {TABLE} WHERE {time_sql(start, end)}"
    kinds = {(r[0], r[1]): int(r[2]) * 2 >= int(r[3]) and int(r[2]) > 0 for r in ch_rows(
        f"SELECT p.ServiceName, c.ServiceName, "
        f"countIf(c.SpanKind IN ('Consumer', 'SPAN_KIND_CONSUMER') OR p.SpanKind IN ('Producer', 'SPAN_KIND_PRODUCER')), count() "
        f"FROM (SELECT TraceId, ParentSpanId, ServiceName, SpanKind {scope} AND ParentSpanId != '') AS c "
        f"ANY LEFT JOIN (SELECT TraceId, SpanId, ServiceName, SpanKind {scope}) AS p "
        f"ON c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId "
        f"WHERE p.ServiceName != '' AND p.ServiceName != c.ServiceName GROUP BY 1, 2")}
    assert edges and kinds
    for key, edge in edges.items():
        assert edge["kind"] in ("sync", "async"), edge
        assert edge["kind"] == ("async" if kinds[key] else "sync"), key


def test_forced_trace_sampling_scales_counts(window):
    start, end = window
    body, _ = service_map({"start_ms": start, "end_ms": end, "sample_factor": 4})
    assert body["sampled"] is True
    assert body["sampling"]["trace_factor"] == 4 and body["sample_factor"] == 4
    nodes, edges = as_maps(body)
    true_nodes, true_edges = truth(start, end)
    assert set(edges) == set(true_edges)
    for service, (spans, _) in true_nodes.items():
        assert nodes[service]["spans"] == pytest.approx(spans, rel=0.1), service
        assert nodes[service]["spans"] == nodes[service]["sampled_count"] * 4
    for key, (calls, _) in true_edges.items():
        assert edges[key]["calls"] == pytest.approx(calls, rel=0.1), key
    # Consistent per trace: the sampled spans are exactly those of the sampled traces.
    sampled = int(ch_rows(f"SELECT count() FROM {TABLE} WHERE {time_sql(start, end)} AND cityHash64(TraceId) % 4 = 0")[0][0])
    assert sum(n["sampled_count"] for n in nodes.values()) == sampled


def test_search_filters_select_the_traces_on_the_map(window):
    start, end = window
    true_nodes, _ = truth(start, end)
    service = sorted(true_nodes)[-1]
    for params, trace_filter in (
        ({"service": service}, f"ServiceName = '{service}'"),
        ({"status": "Error"}, "StatusCode = 'Error'"),
        ({"service": service, "status": "Error"}, f"ServiceName = '{service}' AND StatusCode = 'Error'"),
        ({"tag": "span:missing.key=value"}, "0"),
    ):
        body, _ = service_map({"start_ms": start, "end_ms": end, **params})
        nodes, edges = as_maps(body)
        want_nodes, want_edges = truth(start, end, trace_filter)
        assert {k: v["spans"] for k, v in nodes.items()} == {k: v[0] for k, v in want_nodes.items()}, params
        assert {k: v["calls"] for k, v in edges.items()} == {k: v[0] for k, v in want_edges.items()}, params
    # Excluding every service of the window leaves an empty map.
    params = [("start_ms", start), ("end_ms", end), ("host_id", "local")] + [("service_not", s) for s in true_nodes]
    response = get("/api/traces/service_map", params=params)
    assert response.status_code == 200, response.text
    assert response.json()["nodes"] == [] and response.json()["edges"] == []


def test_invalid_requests_are_rejected():
    now = int(time.time() * 1000)
    for params, code in (
        ({"start_ms": now - MINUTE_MS}, "invalid_trace_range"),
        ({"start_ms": now, "end_ms": now - MINUTE_MS}, "invalid_trace_range"),
        ({"status": "Broken"}, "invalid_trace_filter"),
        ({"tag": "=value"}, "invalid_trace_filter"),
        ({"min_duration_ms": 10, "max_duration_ms": 5}, "invalid_trace_duration"),
    ):
        response = get("/api/traces/service_map", params={"host_id": "local", **params})
        assert response.status_code == 400, (params, response.text)
        assert response.json()["error_code"] == code


@pytest.mark.parametrize("minutes,budget_s", [(60, 6.0), (24 * 60, 10.0), (7 * 24 * 60, 12.0)])
def test_wide_windows_are_bounded_by_time_slices_and_trace_sampling(minutes, budget_s):
    # Windows ending at the fixture's busiest hour (a shared ClickHouse:
    # generous budgets; ~0.3-0.9 s measured alone).
    rows = ch_rows("SELECT toUnixTimestamp64Milli(max(Start)) FROM otel.otel_traces_trace_id_ts")
    if not rows or rows[0][0] in ("", "0"):
        pytest.skip("OTEL fixture is empty")
    end = int(rows[0][0]) - 36 * 60 * MINUTE_MS
    end -= end % MINUTE_MS
    body, elapsed = service_map({"start_ms": end - minutes * MINUTE_MS, "end_ms": end})
    assert elapsed < budget_s, (minutes, elapsed, body["timing_ms"])
    sampling = body["sampling"]
    if sampling["estimated_spans"] <= 12_000_000:
        pytest.skip("window smaller than the read budget on this fixture")
    assert body["sampled"] is True
    assert sampling["slices"] > 0 and 0 < sampling["time_coverage"] < 1
    assert sampling["estimated_spans"] * sampling["time_coverage"] <= 12_500_000
    assert body["sample_factor"] == pytest.approx(sampling["trace_factor"] / sampling["time_coverage"])
    assert body["nodes"] and body["edges"]
    # Scaled span totals estimate the window's spans (EXPLAIN ESTIMATE counts whole granules).
    assert sum(n["spans"] for n in body["nodes"]) == pytest.approx(sampling["estimated_spans"], rel=0.35)
