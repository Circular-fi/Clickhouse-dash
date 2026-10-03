"""Duration heatmap and box-select attribute deltas against the OTel fixture.

/api/traces/heatmap (traces per time bucket x log duration row) is compared
cell by cell with a direct ClickHouse computation of the same trace
durations; /api/traces/deltas (attribute shares of a box vs its baseline)
with a direct computation over the same two stable samples. Filters and
timing budgets are checked on the ~2B-span fixture (the ClickHouse server is
shared, so budgets are generous).
"""
from __future__ import annotations

import math
import os
import time

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))

BINS_PER_OCTAVE = 32
DURATION = ("(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - "
            "toInt64(min(toUnixTimestamp64Nano(Timestamp))))")


def get(path: str, **kwargs):
    return SESSION.get(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 120), **kwargs)


def ch_rows(sql: str) -> list[list[str]]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT TSV").encode(), auth=CH_AUTH, timeout=300)
    assert response.status_code == 200, response.text
    return [line.split("\t") for line in response.text.splitlines() if line]


def lit(value: str) -> str:
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def window_sql(lo_ms: int, hi_ms: int) -> str:
    return f"Timestamp >= fromUnixTimestamp64Milli({lo_ms}) AND Timestamp <= fromUnixTimestamp64Milli({hi_ms})"


@pytest.fixture(scope="module")
def meta() -> dict:
    response = get("/api/traces/meta", params={"host_id": "local"})
    if response.status_code == 404:
        pytest.skip("Trace Explorer disabled in this configuration")
    assert response.status_code == 200, response.text
    body = response.json()
    if not body.get("analytics_enabled"):
        pytest.skip("Trace analytics disabled in this configuration")
    return body


@pytest.fixture(scope="module")
def window(meta) -> tuple[int, int]:
    # Ten minutes, twelve hours before the newest indexed trace (whole
    # traces on both sides).
    rows = ch_rows("SELECT toUnixTimestamp64Milli(toDateTime64(max(Start), 3)) FROM otel.otel_traces_trace_id_ts")
    if not rows or rows[0][0] in ("", "0"):
        pytest.skip("OTEL fixture is empty")
    newest = int(rows[0][0])
    lo = (newest - 12 * 3600_000) // 600_000 * 600_000
    return lo, lo + 600_000


def heatmap(params: dict) -> tuple[dict, float]:
    started = time.monotonic()
    response = get("/api/traces/heatmap", params={"host_id": "local", **params})
    elapsed = time.monotonic() - started
    assert response.status_code == 200, response.text
    return response.json(), elapsed


def truth_fine_cells(lo: int, hi: int, bucket_ms: int, span_filter: str = "", having: str = "") -> dict[tuple[int, int], int]:
    candidate = (f" AND TraceId IN (SELECT TraceId FROM otel.otel_traces WHERE {window_sql(lo, hi)} AND {span_filter})"
                 if span_filter else "")
    rows = ch_rows(
        f"SELECT intDiv(toUnixTimestamp64Milli(s), {bucket_ms}) * {bucket_ms} AS b, "
        f"toInt32(floor(log2(greatest(d, 1)) * {BINS_PER_OCTAVE})) AS f, count() FROM ("
        f"SELECT min(Timestamp) AS s, {DURATION} AS d FROM otel.otel_traces WHERE {window_sql(lo, hi)}{candidate} "
        f"GROUP BY TraceId{having}) GROUP BY b, f")
    return {(int(r[0]), int(r[1])): int(r[2]) for r in rows}


def expected_cells(fine: dict[tuple[int, int], int], rows_wanted: int):
    """The server's rebinning: 1 % quantile bin .. slowest bin into rows."""
    totals: dict[int, int] = {}
    for (_, f), n in fine.items():
        totals[f] = totals.get(f, 0) + n
    total = sum(totals.values())
    cut = max(1, math.ceil(total * 0.01))
    seen = 0
    lo_bin = min(totals)
    for f in sorted(totals):
        seen += totals[f]
        if seen >= cut:
            lo_bin = f
            break
    hi_bin = max(totals)
    span = hi_bin - lo_bin + 1
    rows = min(rows_wanted, span)
    cells: dict[tuple[int, int], int] = {}
    for (b, f), n in fine.items():
        row = 0 if f <= lo_bin else (f - lo_bin) * rows // span
        cells[(b, row)] = cells.get((b, row), 0) + n
    edges = [2 ** ((lo_bin + (r * span + rows - 1) // rows) / BINS_PER_OCTAVE) for r in range(rows + 1)]
    return total, rows, edges, cells


def test_heatmap_cells_match_ground_truth(window):
    lo, hi = window
    body, elapsed = heatmap({"start_ms": lo, "end_ms": hi, "rows": 30})
    assert body["unit"] == "traces" and body["duration_source"] == "span_bounds"
    assert body["bucket_ms"] == 60_000 and body["range"] == [lo, hi]
    total, rows, edges, cells = expected_cells(truth_fine_cells(lo, hi, 60_000), 30)
    assert body["total"] == total > 0
    assert body["rows"] == rows
    assert len(body["y_edges_ns"]) == rows + 1
    for got, want in zip(body["y_edges_ns"], edges):
        assert got == pytest.approx(want, rel=1e-9, abs=0.01)
    got = {(c[0], c[1]): c[2] for c in body["cells"]}
    assert got == cells
    assert body["max_count"] == max(cells.values())
    assert elapsed < 30, elapsed


def test_heatmap_honours_span_and_duration_filters(window):
    lo, hi = window
    services = ch_rows(f"SELECT ServiceName, uniqExact(TraceId) FROM otel.otel_traces WHERE {window_sql(lo, hi)} "
                       "GROUP BY ServiceName ORDER BY 2 ASC LIMIT 1")
    service = services[0][0]
    body, _ = heatmap({"start_ms": lo, "end_ms": hi, "service": service})
    total, _, _, cells = expected_cells(truth_fine_cells(lo, hi, 60_000, f"ServiceName = {lit(service)}"), 40)
    assert body["total"] == total
    assert {(c[0], c[1]): c[2] for c in body["cells"]} == cells

    body, _ = heatmap({"start_ms": lo, "end_ms": hi, "tag": "span:fixture.bucket=3"})
    total, _, _, cells = expected_cells(
        truth_fine_cells(lo, hi, 60_000, "mapContains(SpanAttributes, 'fixture.bucket') AND SpanAttributes['fixture.bucket'] = '3'"), 40)
    assert body["total"] == total > 0
    assert {(c[0], c[1]): c[2] for c in body["cells"]} == cells

    # Trace duration filter: only traces of at least the median duration.
    median = int(float(ch_rows(f"SELECT quantileExact(0.5)(d) FROM (SELECT {DURATION} AS d FROM otel.otel_traces "
                               f"WHERE {window_sql(lo, hi)} GROUP BY TraceId)")[0][0]))
    body, _ = heatmap({"start_ms": lo, "end_ms": hi, "min_duration_ms": median / 1e6})
    min_ns = round(median / 1e6 * 1e6)
    total, _, _, _ = expected_cells(truth_fine_cells(lo, hi, 60_000, having=f" HAVING {DURATION} >= {min_ns}"), 40)
    assert body["total"] == total

    body, _ = heatmap({"start_ms": lo, "end_ms": hi, "status": "Error", "service_not": service})
    truth = truth_fine_cells(lo, hi, 60_000, f"StatusCode = 'Error' AND NOT (ServiceName = {lit(service)})")
    assert body["total"] == sum(truth.values())


def test_heatmap_buckets_follow_the_origin(window):
    lo, hi = window
    origin = 7 * 60_000 + 13_000  # an odd origin: buckets start at :13 s
    body, _ = heatmap({"start_ms": lo, "end_ms": hi, "bucket_origin_ms": origin})
    assert body["bucket_origin_ms"] == origin % 60_000
    assert all((c[0] - origin) % 60_000 == 0 for c in body["cells"])


def test_heatmap_rejects_bad_parameters(window):
    lo, hi = window
    for params, code in [
        ({"start_ms": lo}, "invalid_trace_range"),
        ({"start_ms": lo, "end_ms": hi, "min_duration_ms": 5, "max_duration_ms": 1}, "invalid_trace_duration"),
        ({"start_ms": lo, "end_ms": hi, "status": "Broken"}, "invalid_trace_filter"),
        ({"start_ms": lo, "end_ms": hi, "tag": "=x"}, "invalid_trace_filter"),
    ]:
        response = get("/api/traces/heatmap", params={"host_id": "local", **params})
        assert response.status_code == 400, response.text
        assert response.json()["error_code"] == code


# ------------------------------------------------------------------ deltas

def deltas(params: dict) -> tuple[dict, float]:
    started = time.monotonic()
    response = get("/api/traces/deltas", params={"host_id": "local", **params})
    elapsed = time.monotonic() - started
    assert response.status_code == 200, response.text
    return response.json(), elapsed


def truth_samples(lo: int, hi: int, t0: int, t1: int, d0_ns: int, d1_ns: int, sample: int, margin_ms: int):
    reads = window_sql(max(lo, t0 - margin_ms), min(hi, t1 + margin_ms))
    rows = ch_rows(
        f"SELECT TraceId, in_box, count() OVER (PARTITION BY in_box) FROM (SELECT TraceId, d >= {d0_ns} AND d <= {d1_ns} AS in_box FROM ("
        f"SELECT TraceId, min(Timestamp) AS s, {DURATION} AS d FROM otel.otel_traces WHERE {reads} GROUP BY TraceId "
        f"HAVING s >= fromUnixTimestamp64Milli({t0}) AND s <= fromUnixTimestamp64Milli({t1}))) "
        f"ORDER BY in_box DESC, cityHash64(TraceId) LIMIT {sample} BY in_box")
    ids_in = [r[0] for r in rows if r[1] == "1"]
    ids_out = [r[0] for r in rows if r[1] == "0"]
    totals = {r[1]: int(r[2]) for r in rows}
    return reads, ids_in, ids_out, totals


def test_deltas_match_a_direct_computation_on_the_same_samples(window):
    lo, hi = window
    t0, t1 = lo + 120_000, lo + 420_000
    median = int(float(ch_rows(f"SELECT quantileExact(0.5)(d) FROM (SELECT {DURATION} AS d FROM otel.otel_traces "
                               f"WHERE {window_sql(lo, hi)} GROUP BY TraceId)")[0][0]))
    d0_ms, d1_ms = median / 1e6, median / 1e6 * 4
    body, elapsed = deltas({"start_ms": lo, "end_ms": hi, "t0": t0, "t1": t1, "d0": d0_ms, "d1": d1_ms, "sample": 400})
    assert body["unit"] == "traces" and body["baseline"] == "outside"
    assert body["box"] == {"t0": t0, "t1": t1, "d0": pytest.approx(d0_ms), "d1": pytest.approx(d1_ms)}
    assert body["window_sampled"] is False and body["sampled_windows"] == [[t0, t1]]
    margin = body["read_margin_ms"]
    assert margin == max(1000, min(300000, math.ceil(d1_ms * 2)))
    reads, ids_in, ids_out, totals = truth_samples(lo, hi, t0, t1, round(d0_ms * 1e6), round(d1_ms * 1e6), 400, margin)
    assert body["selection"] == {"sampled": len(ids_in), "traces": totals.get("1", 0)}
    assert body["baseline_sample"] == {"sampled": len(ids_out), "traces": totals.get("0", 0)}
    assert len(ids_in) > 0 and len(ids_out) > 0
    # Per (key, value): sampled traces of each side with a span carrying it.
    id_list = lambda ids: "(" + ",".join(lit(i) for i in ids) + ")"  # noqa: E731
    truth = {}
    for scope, key, value, n_in, n_out in ch_rows(
            f"SELECT kv.1, kv.2, kv.3, uniqExactIf(TraceId, side), uniqExactIf(TraceId, NOT side) FROM ("
            f"SELECT TraceId, TraceId IN {id_list(ids_in)} AS side, arrayJoin(arrayConcat("
            "[('column', 'ServiceName', toString(ServiceName)), ('column', 'SpanName', toString(SpanName)), ('column', 'StatusCode', toString(StatusCode))], "
            "arrayMap((k, v) -> ('span', toString(k), toString(v)), mapKeys(SpanAttributes), mapValues(SpanAttributes)), "
            "arrayMap((k, v) -> ('resource', toString(k), toString(v)), mapKeys(ResourceAttributes), mapValues(ResourceAttributes)))) AS kv "
            f"FROM otel.otel_traces WHERE {reads} AND TraceId IN {id_list(ids_in + ids_out)}) GROUP BY kv"):
        truth[(scope, key, value)] = (int(n_in), int(n_out))
    assert body["keys"], body
    assert len(body["keys"]) <= 20
    scores = [k["score"] for k in body["keys"]]
    assert scores == sorted(scores, reverse=True)
    for item in body["keys"]:
        assert item["field"] in ("tag", "service", "operation", "status")
        assert 0 < len(item["values"]) <= 6
        for v in item["values"]:
            n_in, n_out = truth[(item["scope"], item["key"], v["value"])]
            assert (v["selection_count"], v["baseline_count"]) == (n_in, n_out)
            assert v["selection_pct"] == pytest.approx(round(n_in / len(ids_in) * 100, 2), abs=0.011)
            assert v["baseline_pct"] == pytest.approx(round(n_out / len(ids_out) * 100, 2), abs=0.011)
        best = max(abs(v["selection_pct"] - v["baseline_pct"]) for v in item["values"])
        assert item["score"] == pytest.approx(best + (2 if item["boosted"] else 0), abs=0.02)
    # A key whose values are equally shared on both sides never ranks: every
    # sampled trace has the same deployment environment.
    ranked = {(k["scope"], k["key"]) for k in body["keys"]}
    env = truth.get(("resource", "deployment.environment.name", "test"))
    if env == (len(ids_in), len(ids_out)):
        assert ("resource", "deployment.environment.name") not in ranked
    assert elapsed < 30, elapsed

    # The same request answers the same samples (stable cityHash64 order).
    again, _ = deltas({"start_ms": lo, "end_ms": hi, "t0": t0, "t1": t1, "d0": d0_ms, "d1": d1_ms, "sample": 400})
    assert again["keys"] == body["keys"]

    # baseline=all weighs both samples by the traces they stand for.
    everything, _ = deltas({"start_ms": lo, "end_ms": hi, "t0": t0, "t1": t1, "d0": d0_ms, "d1": d1_ms, "sample": 400, "baseline": "all"})
    t_in, t_out = totals.get("1", 0), totals.get("0", 0)
    assert everything["baseline_sample"]["traces"] == t_in + t_out
    for item in everything["keys"]:
        for v in item["values"]:
            n_in, n_out = truth[(item["scope"], item["key"], v["value"])]
            want = (n_in / len(ids_in) * t_in + n_out / len(ids_out) * t_out) / (t_in + t_out) * 100
            assert v["baseline_pct"] == pytest.approx(want, abs=0.011)


def test_deltas_honour_filters(window):
    lo, hi = window
    t0, t1 = lo, hi
    body, _ = deltas({"start_ms": lo, "end_ms": hi, "t0": t0, "t1": t1, "d0": 0, "d1": 86_400_000, "tag": "span:fixture.bucket=3"})
    # Every sampled trace has a span with fixture.bucket=3: never a difference.
    assert body["baseline_sample"]["sampled"] == 0
    truth = ch_rows(f"SELECT uniqExact(TraceId) FROM (SELECT TraceId, min(Timestamp) AS s FROM otel.otel_traces WHERE {window_sql(lo, hi)} "
                    f"AND TraceId IN (SELECT TraceId FROM otel.otel_traces WHERE {window_sql(lo, hi)} AND SpanAttributes['fixture.bucket'] = '3') "
                    f"GROUP BY TraceId HAVING s >= fromUnixTimestamp64Milli({t0}) AND s <= fromUnixTimestamp64Milli({t1}))")
    assert body["selection"]["traces"] == int(truth[0][0])
    for item in body["keys"]:
        if item["key"] == "fixture.bucket":
            assert any(v["value"] == "3" and v["selection_pct"] == 100 for v in item["values"])


def test_deltas_bound_a_wide_box(window):
    lo, hi = window
    start, end = lo - 12 * 3600_000, lo + 12 * 3600_000
    body, elapsed = deltas({"start_ms": start, "end_ms": end, "t0": start, "t1": end, "d0": 0, "d1": 1000})
    assert body["window_sampled"] is True
    assert len(body["sampled_windows"]) == 6
    assert body["sampled_ms"] <= 30 * 60_000
    assert all(start <= a < b <= end for a, b in body["sampled_windows"])
    assert body["selection"]["sampled"] <= 1000
    assert elapsed < 45, elapsed


def test_deltas_reject_bad_boxes(window):
    lo, hi = window
    base = {"start_ms": lo, "end_ms": hi}
    for params in [
        {"d0": 1, "d1": 2},
        {"t0": lo + 10, "t1": lo + 5, "d0": 1, "d1": 2},
        {"t0": hi + 10, "t1": hi + 50, "d0": 1, "d1": 2},
        {"t0": lo, "t1": hi, "d0": 5, "d1": 2},
        {"t0": lo, "t1": hi, "d0": 1},
    ]:
        response = get("/api/traces/deltas", params={"host_id": "local", **base, **params})
        assert response.status_code == 400, response.text
        assert response.json()["error_code"] == "invalid_trace_box"
    response = get("/api/traces/deltas", params={"host_id": "local", **base, "t0": lo, "t1": hi, "d0": 1, "d1": 2, "baseline": "median"})
    assert response.status_code == 400 and response.json()["error_code"] == "invalid_trace_baseline"


# One hour and six of the bulk fixture (tens of millions of spans), the widest
# quick range under a day. A day of the bulk fixture read ~0.5 B spans to
# measure the host as much as the query.
@pytest.mark.parametrize("hours,budget", [(1, 20), (6, 30)])
def test_heatmap_timing_budget(window, hours, budget):
    lo, _ = window
    body, elapsed = heatmap({"start_ms": lo - hours * 3600_000 + 600_000, "end_ms": lo + 600_000})
    assert body["total"] > 0
    assert elapsed < budget, (hours, elapsed, body["timing_ms"])
