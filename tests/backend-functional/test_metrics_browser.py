"""Metrics browser API: /api/metrics/{catalog,attributes,series,exemplars}.

Every numeric answer is checked against ground truth computed here from the
raw exporter rows read straight from ClickHouse (counter deltas with resets,
histogram bucket differences, Prometheus-style quantile interpolation,
exponential bucket bounds). Windows come from /api/metrics/meta time bounds,
so the checks follow whatever window the otel fixture generated.
"""
from __future__ import annotations

import json
import math
import os
import time
from collections import defaultdict
from pathlib import Path

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))
REPO = Path(os.environ.get("TEST_REPOSITORY_ROOT", "/repo"))

MINUTE = 60_000
LOOKBACK_MS = 15 * MINUTE
HIST = "http.server.request.duration"
CALLS = "traces.span.metrics.calls"


def api(path: str, **params) -> requests.Response:
    return requests.get(f"{BASE_URL}{path}", params=params, timeout=60)


def ok(path: str, **params) -> dict:
    response = api(path, **params)
    assert response.status_code == 200, response.text
    return response.json()


def ch_rows(sql: str) -> list[dict]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT JSONEachRow").encode(), auth=CH_AUTH, timeout=120)
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def q(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


@pytest.fixture(scope="module")
def meta() -> dict:
    features = ok("/api/version")["features"]
    if not features["metrics"]["enabled"]:
        pytest.skip("metrics are disabled in this configuration")
    body = ok("/api/metrics/meta", refresh="1")
    if not body.get("available_kinds"):
        pytest.skip("no metrics tables")
    return body


def kind_bounds(meta: dict, kind: str) -> tuple[int, int]:
    bounds = (meta["kinds"].get(kind) or {}).get("time_bounds")
    if not bounds:
        pytest.skip(f"no {kind} points in the fixture")
    return bounds["min_ms"], bounds["max_ms"]


def table(meta: dict, kind: str) -> str:
    return f"`{meta['database']}`.`{meta['kinds'][kind]['table']}`"


def small_window(meta: dict, kind: str, minutes: int = 5, where: str = "middle") -> tuple[int, int]:
    lo, hi = kind_bounds(meta, kind)
    if where == "middle":
        start = ((lo + hi) // 2) // MINUTE * MINUTE
    else:
        start = (lo // MINUTE + 20) * MINUTE
    return start, start + minutes * MINUTE - 1


def covered_s(bucket: int, start: int, end: int, step: int = 60_000) -> float:
    """Seconds of a bucket inside [start, end]: rates divide by it, so the
    buckets cut by the window edges are not under-reported."""
    return (min(bucket + step, end) - max(bucket, start)) / 1000.0


def ms(value: str) -> int:
    """ClickHouse DateTime64 text (UTC session) -> epoch ms."""
    from datetime import datetime, timezone
    head, _, frac = value.partition(".")
    dt = datetime.strptime(head, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000) + int((frac + "000")[:3] or 0)


def raw_points(meta: dict, kind: str, service: str, metric: str, lo: int, hi: int, columns: str) -> list[dict]:
    return ch_rows(
        f"SELECT toString(cityHash64(Attributes, ResourceAttributes)) AS sid, Attributes, "
        f"toUnixTimestamp64Milli(TimeUnix) AS t, toUnixTimestamp64Milli(StartTimeUnix) AS st, {columns} "
        f"FROM {table(meta, kind)} WHERE ServiceName = {q(service)} AND MetricName = {q(metric)} "
        f"AND TimeUnix >= fromUnixTimestamp64Milli({lo}) AND TimeUnix <= fromUnixTimestamp64Milli({hi}) "
        f"ORDER BY sid, TimeUnix SETTINGS output_format_json_quote_64bit_integers = 0, output_format_json_quote_64bit_floats = 0")


def bucket_of(t: int, size: int, origin: int = 0) -> int:
    return origin + (t - origin) // size * size


def series_by_key(body: dict) -> dict:
    return {s["key"]: s for s in body["series"]}


def values_at(body: dict, series: dict) -> dict:
    return {t: v for t, v in zip(body["timestamps"], series["values"]) if v is not None}


def prom_quantile(qv: float, bounds: list[float], counts: list[float]) -> float:
    total = sum(max(0, c) for c in counts)
    if total <= 0 or not bounds:
        return math.nan
    rank = qv * total
    cumulative = 0.0
    for i, c in enumerate(counts):
        c = max(0, c)
        if c > 0 and cumulative + c >= rank:
            if i >= len(bounds):
                return bounds[-1]
            upper = bounds[i]
            if i == 0 and upper <= 0:
                return upper
            lower = 0.0 if i == 0 else bounds[i - 1]
            return lower + (upper - lower) * (rank - cumulative) / c
        cumulative += c
    return bounds[-1]


def service_with_temporality(meta: dict, kind: str, metric: str, temporality: int) -> str:
    lo, hi = kind_bounds(meta, kind)
    rows = ch_rows(
        f"SELECT ServiceName AS s FROM {table(meta, kind)} WHERE MetricName = {q(metric)} "
        f"GROUP BY s HAVING min(AggregationTemporality) = {temporality} AND max(AggregationTemporality) = {temporality} "
        f"ORDER BY s LIMIT 1")
    if not rows:
        pytest.skip(f"no {metric} service with temporality {temporality}")
    return rows[0]["s"]


# ---------------------------------------------------------------------------
# Catalog


def test_catalog_matches_clickhouse(meta):
    lo, hi = meta["time_bounds"]["min_ms"], meta["time_bounds"]["max_ms"]
    started = time.time()
    body = ok("/api/metrics/catalog", start_ms=lo, end_ms=hi, refresh="1")
    assert time.time() - started < 5.0
    assert body["truncated"] is False
    assert body["cache"]["hit"] is False
    assert set(body["kinds"]) == set(meta["available_kinds"])

    expected = {}
    for kind in body["kinds"]:
        temporality = "toString(min(AggregationTemporality)) AS tmin, toString(max(AggregationTemporality)) AS tmax" \
            if kind in ("sum", "histogram", "exponential_histogram") else "'' AS tmin, '' AS tmax"
        mono = "toString(max(toUInt8(IsMonotonic)))" if kind == "sum" else "''"
        for row in ch_rows(
                f"SELECT toString(ServiceName) AS s, MetricName AS m, any(MetricUnit) AS u, count() AS n, {temporality}, "
                f"{mono} AS mono FROM {table(meta, kind)} WHERE TimeUnix >= fromUnixTimestamp64Milli({lo}) "
                f"AND TimeUnix <= fromUnixTimestamp64Milli({hi}) GROUP BY ServiceName, MetricName "
                f"SETTINGS output_format_json_quote_64bit_integers = 0"):
            if row["tmin"] == "":
                temp = None
            elif row["tmin"] != row["tmax"]:
                temp = "mixed"
            else:
                temp = {"1": "delta", "2": "cumulative"}.get(row["tmin"])
            expected[(row["s"], row["m"], kind)] = {
                "unit": row["u"], "points": int(row["n"]), "temporality": temp,
                "monotonic": None if row["mono"] == "" else row["mono"] == "1"}

    got = {}
    for service in body["services"]:
        for metric in service["metrics"]:
            got[(service["name"], metric["name"], metric["kind"])] = {
                "unit": metric["unit"], "points": metric["points"], "temporality": metric["temporality"],
                "monotonic": metric["monotonic"]}
    assert got == expected
    assert body["service_count"] == len({key[0] for key in expected})
    assert body["metric_count"] == len(expected)
    names = [s["name"] for s in body["services"]]
    assert names == sorted(names)

    again = ok("/api/metrics/catalog", start_ms=lo, end_ms=hi)
    assert again["cache"]["hit"] is True
    assert again["services"] == body["services"]
    # A hit reports its own timing: no query time.
    assert again["timing_ms"]["query"] == 0
    assert again["timing_ms"]["total"] < 1000


def test_catalog_types_of_the_fixture(meta):
    lo, hi = meta["time_bounds"]["min_ms"], meta["time_bounds"]["max_ms"]
    body = ok("/api/metrics/catalog", start_ms=lo, end_ms=hi)
    kinds = defaultdict(set)
    for service in body["services"]:
        for metric in service["metrics"]:
            kinds[metric["name"]].add((metric["kind"], metric["unit"]))
            if metric["name"] == CALLS:
                assert metric["monotonic"] is True and metric["temporality"] == "cumulative"
            if metric["name"] == HIST:
                assert metric["temporality"] in ("delta", "cumulative")
                assert metric["description"]
    assert kinds[HIST] == {("histogram", "s")}
    assert kinds[CALLS] == {("sum", "{call}")}
    assert ("gauge", "{message}") in kinds["queue.depth"]


# ---------------------------------------------------------------------------
# Gauges


def test_gauge_avg_min_max_per_bucket_and_host(meta):
    start, end = small_window(meta, "gauge")
    service = "api_service"
    rows = raw_points(meta, "gauge", service, "queue.depth", start, end, "Value AS v")
    assert rows, "no gauge points in the window"
    expected = defaultdict(list)
    for row in rows:
        expected[(row["Attributes"].get("host.name", ""), bucket_of(row["t"], MINUTE))].append(row["v"])
    for agg, fn in (("avg", lambda xs: sum(xs) / len(xs)), ("min", min), ("max", max)):
        body = ok("/api/metrics/series", kind="gauge", service=service, metric="queue.depth", start_ms=start, end_ms=end,
                  bucket_origin_ms=0, step_ms=MINUTE, agg=agg, group_by="host.name")
        assert body["bucket_ms"] == MINUTE and body["agg"] == agg and body["value_unit"] == "{message}"
        assert body["timestamps"] == list(range(start, end + 1, MINUTE))
        got = {}
        for series in body["series"]:
            for t, v in values_at(body, series).items():
                got[(series["labels"]["host.name"], t)] = v
        assert got.keys() == expected.keys()
        for key, values in expected.items():
            assert got[key] == pytest.approx(fn(values), rel=1e-12), (agg, key)


def test_gauge_last_and_sum_across_hosts(meta):
    start, end = small_window(meta, "gauge")
    rows = raw_points(meta, "gauge", "api_service", "queue.depth", start, end, "Value AS v")
    last = {}
    for row in rows:  # ordered by series then time: the last write wins
        last[(row["sid"], bucket_of(row["t"], MINUTE))] = row["v"]
    per_bucket = defaultdict(list)
    for (sid, b), v in last.items():
        per_bucket[b].append(v)
    for agg, fn in (("sum", sum), ("last", lambda xs: sum(xs) / len(xs))):
        body = ok("/api/metrics/series", kind="gauge", service="api_service", metric="queue.depth", start_ms=start,
                  end_ms=end, bucket_origin_ms=0, step_ms=MINUTE, agg=agg)
        assert len(body["series"]) == 1 and body["series"][0]["labels"] == {}
        got = values_at(body, body["series"][0])
        assert got.keys() == per_bucket.keys()
        for b, values in per_bucket.items():
            assert got[b] == pytest.approx(fn(values), rel=1e-12)


# ---------------------------------------------------------------------------
# Counters


def counter_ground_truth(rows: list[dict], start: int, size: int, origin: int = 0, label=None) -> dict:
    """Prometheus-style increase: per series difference to the previous point,
    the whole value after a reset (new StartTimeUnix or a decrease)."""
    out = defaultdict(float)
    previous = {}
    for row in rows:
        prev = previous.get(row["sid"])
        previous[row["sid"]] = row
        if prev is None or row["t"] < start:
            continue
        reset = prev["st"] != row["st"] or row["v"] < prev["v"]
        delta = row["v"] if reset else row["v"] - prev["v"]
        key = bucket_of(row["t"], size, origin)
        out[(label(row) if label else "", key)] += delta
    return out


def reset_time(meta: dict, service: str) -> int:
    rows = ch_rows(
        f"SELECT toUnixTimestamp64Milli(max(StartTimeUnix)) AS t, uniqExact(StartTimeUnix) AS n FROM {table(meta, 'sum')} "
        f"WHERE ServiceName = {q(service)} AND MetricName = {q(CALLS)} SETTINGS output_format_json_quote_64bit_integers = 0")
    if not rows or int(rows[0]["n"]) < 2:
        pytest.skip(f"{service} has no counter reset")
    return int(rows[0]["t"])


def test_cumulative_counter_increase_across_the_reset(meta):
    service = "api_service"
    reset = reset_time(meta, service)
    start = (reset // MINUTE - 3) * MINUTE
    end = start + 7 * MINUTE - 1
    rows = raw_points(meta, "sum", service, CALLS, start - LOOKBACK_MS, end, "Value AS v")
    starts_in_window = {row["st"] for row in rows if row["t"] >= start}
    assert len(starts_in_window) >= 2, "the reset is not inside the window"
    expected = counter_ground_truth(rows, start, MINUTE)

    body = ok("/api/metrics/series", kind="sum", service=service, metric=CALLS, start_ms=start, end_ms=end,
              bucket_origin_ms=0, step_ms=MINUTE, agg="increase")
    assert body["monotonic"] is True and body["temporality"] == "cumulative"
    assert body["aggs"] == ["rate", "increase"] and body["value_unit"] == "{call}"
    got = values_at(body, body["series"][0])
    assert got.keys() == {b for _, b in expected}
    for (_, b), v in expected.items():
        assert got[b] == pytest.approx(v, rel=1e-12)
    assert all(v >= 0 for v in got.values())
    # The reset bucket is not a dip to (near) zero nor a negative jump: its
    # increase stays within 2x of its neighbours.
    reset_bucket = bucket_of(reset, MINUTE)
    neighbours = [v for b, v in got.items() if b != reset_bucket]
    assert got[reset_bucket] > 0.5 * min(neighbours)
    assert got[reset_bucket] < 2.0 * max(neighbours)

    rate = ok("/api/metrics/series", kind="sum", service=service, metric=CALLS, start_ms=start, end_ms=end,
              bucket_origin_ms=0, step_ms=MINUTE, agg="rate")
    assert rate["value_unit"] == "{call}/s"
    for b, v in values_at(rate, rate["series"][0]).items():
        assert v == pytest.approx(got[b] / covered_s(b, start, end), rel=1e-12)


def test_counter_top_k_folds_the_rest_into_other(meta):
    service = "api_service"
    start, end = small_window(meta, "sum", minutes=10)
    params = dict(kind="sum", service=service, metric=CALLS, start_ms=start, end_ms=end, bucket_origin_ms=0,
                  step_ms=MINUTE, agg="rate", group_by="span.kind,status.code")
    full = ok("/api/metrics/series", limit=50, **params)
    assert full["group_count"] >= 3, "need more groups than the limit"
    assert not any(s["other"] for s in full["series"])
    ranked = sorted(full["series"], key=lambda s: (-s["total"], s["key"]))
    top = ok("/api/metrics/series", limit=2, **params)
    assert top["truncated"] is True and top["top_k"] == 2
    assert top["other_series_count"] == full["group_count"] - 2
    assert [s["key"] for s in top["series"][:2]] == [s["key"] for s in ranked[:2]]
    other = top["series"][2]
    assert other["other"] is True and other["key"] == "__other__" and other["labels"] == {}
    for i, t in enumerate(top["timestamps"]):
        rest = [s["values"][i] for s in ranked[2:] if s["values"][i] is not None]
        if rest:
            assert other["values"][i] == pytest.approx(sum(rest), rel=1e-12)
        else:
            assert other["values"][i] is None
    for s in top["series"][:2]:
        assert set(s["labels"]) == {"span.kind", "status.code"}

    # Ground truth for the grouped rates.
    rows = raw_points(meta, "sum", service, CALLS, start - LOOKBACK_MS, end, "Value AS v")
    expected = counter_ground_truth(rows, start, MINUTE,
                                    label=lambda r: (r["Attributes"].get("span.kind", ""), r["Attributes"].get("status.code", "")))
    for s in full["series"]:
        label = (s["labels"]["span.kind"], s["labels"]["status.code"])
        for t, v in values_at(full, s).items():
            assert v == pytest.approx(expected[(label, t)] / covered_s(t, start, end), rel=1e-12)


def test_filters_equal_and_not_equal(meta):
    service = "api_service"
    start, end = small_window(meta, "sum", minutes=5)
    params = dict(kind="sum", service=service, metric=CALLS, start_ms=start, end_ms=end, bucket_origin_ms=0,
                  step_ms=MINUTE, agg="increase", group_by="status.code")
    everything = series_by_key(ok("/api/metrics/series", **params))
    assert "STATUS_CODE_OK" in everything and len(everything) >= 2
    only_ok = ok("/api/metrics/series", filter="status.code=STATUS_CODE_OK", **params)
    assert only_ok["filters"] == [{"key": "status.code", "op": "=", "value": "STATUS_CODE_OK"}]
    assert list(series_by_key(only_ok)) == ["STATUS_CODE_OK"]
    assert only_ok["series"][0]["values"] == everything["STATUS_CODE_OK"]["values"]
    not_ok = ok("/api/metrics/series", filter_not="status.code=STATUS_CODE_OK", **params)
    assert set(series_by_key(not_ok)) == set(everything) - {"STATUS_CODE_OK"}
    for key, s in series_by_key(not_ok).items():
        assert s["values"] == everything[key]["values"]
    both = requests.get(f"{BASE_URL}/api/metrics/series", params=list(params.items()) + [
        ("filter", "status.code=STATUS_CODE_OK"), ("filter", "status.code=STATUS_CODE_ERROR")], timeout=60).json()
    assert set(series_by_key(both)) == {"STATUS_CODE_OK", "STATUS_CODE_ERROR"} & set(everything)
    none = ok("/api/metrics/series", filter="status.code=no-such-value", **params)
    assert none["series"] == [] and none["group_count"] == 0


# ---------------------------------------------------------------------------
# Histograms


def histogram_ground_truth(rows: list[dict], start: int, size: int) -> dict:
    cells = {}
    previous = {}
    for row in rows:
        prev = previous.get(row["sid"])
        previous[row["sid"]] = row
        counts = [float(c) for c in row["BucketCounts"]]
        if row["temporality"] == 1:
            delta_counts, dcount, dsum = counts, float(row["Count"]), row["Sum"]
        else:
            if prev is None:
                continue
            reset = (prev["st"] != row["st"] or row["Count"] < prev["Count"] or len(counts) != len(prev["BucketCounts"])
                     or row["ExplicitBounds"] != prev["ExplicitBounds"]
                     or any(c < p for c, p in zip(row["BucketCounts"], prev["BucketCounts"])))
            if reset:
                delta_counts, dcount, dsum = counts, float(row["Count"]), row["Sum"]
            else:
                delta_counts = [c - p for c, p in zip(counts, prev["BucketCounts"])]
                dcount, dsum = float(row["Count"] - prev["Count"]), row["Sum"] - prev["Sum"]
        if row["t"] < start:
            continue
        b = bucket_of(row["t"], size)
        cell = cells.setdefault(b, {"bounds": row["ExplicitBounds"], "counts": [0.0] * len(delta_counts), "count": 0.0, "sum": 0.0})
        cell["counts"] = [a + d for a, d in zip(cell["counts"], delta_counts)]
        cell["count"] += dcount
        cell["sum"] += dsum
    return cells


@pytest.mark.parametrize("temporality", [1, 2], ids=["delta", "cumulative"])
def test_histogram_quantiles_match_hand_computation(meta, temporality):
    service = service_with_temporality(meta, "histogram", HIST, temporality)
    start, end = small_window(meta, "histogram")
    rows = raw_points(meta, "histogram", service, HIST, start - LOOKBACK_MS, end,
                      "Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality AS temporality")
    cells = histogram_ground_truth(rows, start, MINUTE)
    assert len(cells) == 5
    for agg in ("p50", "p90", "p95", "p99", "avg", "count", "count_rate"):
        body = ok("/api/metrics/series", kind="histogram", service=service, metric=HIST, start_ms=start, end_ms=end,
                  bucket_origin_ms=0, step_ms=MINUTE, agg=agg)
        assert body["temporality"] == ("delta" if temporality == 1 else "cumulative")
        assert body["aggs"] == ["p50", "p90", "p95", "p99", "avg", "count_rate", "count"]
        got = values_at(body, body["series"][0])
        assert got.keys() == cells.keys()
        for b, cell in cells.items():
            if agg.startswith("p"):
                expected = prom_quantile(int(agg[1:]) / 100.0, cell["bounds"], cell["counts"])
            elif agg == "avg":
                expected = cell["sum"] / cell["count"]
            elif agg == "count":
                expected = cell["count"]
            else:
                expected = cell["count"] / covered_s(b, start, end)
            assert got[b] == pytest.approx(expected, rel=1e-9), (agg, b)
        if agg.startswith("p") or agg == "avg":
            assert body["value_unit"] == "s"
        elif agg == "count_rate":
            assert body["value_unit"] == "/s"


def test_cumulative_histogram_matches_delta_scale(meta):
    """Differenced cumulative points give per-interval counts: the counts per
    bucket are of the same order for delta and cumulative services."""
    delta_service = service_with_temporality(meta, "histogram", HIST, 1)
    cumulative_service = service_with_temporality(meta, "histogram", HIST, 2)
    start, end = small_window(meta, "histogram")
    counts = {}
    for service in (delta_service, cumulative_service):
        body = ok("/api/metrics/series", kind="histogram", service=service, metric=HIST, start_ms=start, end_ms=end,
                  bucket_origin_ms=0, step_ms=MINUTE, agg="count")
        counts[service] = [v for v in body["series"][0]["values"] if v is not None]
    ratio = sum(counts[cumulative_service]) / sum(counts[delta_service])
    assert 0.2 < ratio < 5.0


def test_exponential_histogram_bounds_and_quantiles(meta):
    kind = "exponential_histogram"
    lo, hi = kind_bounds(meta, kind)
    service = ch_rows(f"SELECT any(ServiceName) AS s, any(MetricName) AS m FROM {table(meta, kind)}")[0]
    size = 5 * MINUTE
    start = (lo // size + 1) * size
    end = start + 4 * size - 1
    assert end <= hi
    rows = raw_points(meta, kind, service["s"], service["m"], start, end,
                      "Scale AS scale, PositiveOffset AS po, PositiveBucketCounts AS pos, ZeroCount AS zero, Count, Sum, Min, Max, "
                      "NegativeBucketCounts AS neg, AggregationTemporality AS temporality")
    assert rows and all(r["temporality"] == 1 and not r["neg"] for r in rows), "fixture exp histograms are delta, positive"
    cells = {}
    for row in rows:
        cell = cells.setdefault(bucket_of(row["t"], size), {"buckets": defaultdict(float), "scale": row["scale"], "zero": 0.0,
                                                            "count": 0.0, "sum": 0.0, "min": math.inf, "max": -math.inf})
        assert row["scale"] == cell["scale"]
        for i, c in enumerate(row["pos"]):
            cell["buckets"][row["po"] + i] += c
        cell["zero"] += row["zero"]
        cell["count"] += row["Count"]
        cell["sum"] += row["Sum"]
        cell["min"] = min(cell["min"], row["Min"])
        cell["max"] = max(cell["max"], row["Max"])

    def exp_quantile(qv, cell):
        base = 2.0 ** (2.0 ** -cell["scale"])
        ranges = []
        if cell["zero"] > 0:
            ranges.append((0.0, 0.0, cell["zero"]))
        for index in sorted(cell["buckets"]):
            c = cell["buckets"][index]
            if c > 0:
                # Bucket index i of offset o covers (base^(o+i), base^(o+i+1)].
                ranges.append((base ** index, base ** (index + 1), c))
        total = sum(r[2] for r in ranges)
        rank = qv * total
        cumulative = 0.0
        for lower, upper, c in ranges:
            if cumulative + c >= rank:
                return lower + (upper - lower) * (rank - cumulative) / c
            cumulative += c
        return ranges[-1][1]

    for agg in ("p50", "p99", "avg"):
        body = ok("/api/metrics/series", kind=kind, service=service["s"], metric=service["m"], start_ms=start, end_ms=end,
                  bucket_origin_ms=0, step_ms=size, agg=agg)
        got = values_at(body, body["series"][0])
        assert got.keys() == cells.keys()
        for b, cell in cells.items():
            expected = cell["sum"] / cell["count"] if agg == "avg" else exp_quantile(int(agg[1:]) / 100.0, cell)
            assert got[b] == pytest.approx(expected, rel=1e-9), (agg, b)
            if agg != "avg":
                base = 2.0 ** (2.0 ** -cell["scale"])
                assert cell["min"] / base <= got[b] <= cell["max"] * base


# ---------------------------------------------------------------------------
# Summaries


def test_summary_quantiles_are_per_series(meta):
    kind = "summary"
    lo, hi = kind_bounds(meta, kind)
    ref = ch_rows(f"SELECT any(ServiceName) AS s, any(MetricName) AS m FROM {table(meta, kind)}")[0]
    size = 5 * MINUTE
    start = (lo // size + 1) * size
    end = start + 4 * size - 1
    body = ok("/api/metrics/series", kind=kind, service=ref["s"], metric=ref["m"], start_ms=start, end_ms=end,
              bucket_origin_ms=0, step_ms=size, agg="p90", group_by="span.name")
    assert body["per_series"] is True and body["note"] and body["group_by"] == []
    assert "p50" in body["aggs"] and "p90" in body["aggs"] and body["aggs"][-2:] == ["avg", "count_rate"]
    rows = ch_rows(
        f"SELECT toString(cityHash64(Attributes, ResourceAttributes)) AS sid, "
        f"{bucket_expr(size)} AS b, argMax(`ValueAtQuantiles.Value`[indexOf(`ValueAtQuantiles.Quantile`, 0.9)], TimeUnix) AS v "
        f"FROM {table(meta, kind)} WHERE ServiceName = {q(ref['s'])} AND MetricName = {q(ref['m'])} "
        f"AND TimeUnix >= fromUnixTimestamp64Milli({start}) AND TimeUnix <= fromUnixTimestamp64Milli({end}) "
        f"GROUP BY sid, b SETTINGS output_format_json_quote_64bit_integers = 0")
    expected = {(r["sid"], int(r["b"])): r["v"] for r in rows}
    got = {}
    for s in body["series"]:
        for t, v in values_at(body, s).items():
            got[(s["key"], t)] = v
    assert got == pytest.approx(expected, rel=1e-12)
    default = ok("/api/metrics/series", kind=kind, service=ref["s"], metric=ref["m"], start_ms=start, end_ms=end,
                 bucket_origin_ms=0)
    assert default["agg"] == "p50" and default["default_agg"] == "p50"


def bucket_expr(size: int) -> str:
    return f"intDiv(toUnixTimestamp64Milli(TimeUnix), {size}) * {size}"


# ---------------------------------------------------------------------------
# Attributes and exemplars


def test_attribute_keys_and_values(meta):
    lo, hi = kind_bounds(meta, "sum")
    params = dict(kind="sum", service="api_service", metric=CALLS, start_ms=lo, end_ms=hi)
    keys = ok("/api/metrics/attributes", **params)
    expected = sorted(r["k"] for r in ch_rows(
        f"SELECT DISTINCT arrayJoin(mapKeys(Attributes)) AS k FROM {table(meta, 'sum')} "
        f"WHERE ServiceName = 'api_service' AND MetricName = {q(CALLS)}"))
    assert keys["keys"] == expected and keys["truncated"] is False
    values = ok("/api/metrics/attributes", key="status.code", **params)
    expected_values = ch_rows(
        f"SELECT Attributes['status.code'] AS v, count() AS n FROM {table(meta, 'sum')} "
        f"WHERE ServiceName = 'api_service' AND MetricName = {q(CALLS)} AND mapContains(Attributes, 'status.code') "
        f"GROUP BY v ORDER BY n DESC, v SETTINGS output_format_json_quote_64bit_integers = 0")
    assert values["values"] == [{"value": r["v"], "points": int(r["n"])} for r in expected_values]
    narrowed = ok("/api/metrics/attributes", key="span.kind", filter="status.code=STATUS_CODE_ERROR", **params)
    assert narrowed["values"] and all(v["points"] > 0 for v in narrowed["values"])


def test_exemplars_link_to_stored_spans(meta):
    start, end = small_window(meta, "histogram", minutes=30)
    service = service_with_temporality(meta, "histogram", HIST, 1)
    body = ok("/api/metrics/exemplars", kind="histogram", service=service, metric=HIST, start_ms=start, end_ms=end,
              bucket_origin_ms=0, step_ms=5 * MINUTE, per_bucket=2)
    exemplars = body["exemplars"]
    assert exemplars and body["traces_enabled"] is True and body["bucket_ms"] == 5 * MINUTE
    assert [e["t"] for e in exemplars] == sorted(e["t"] for e in exemplars)
    per_bucket = defaultdict(list)
    for e in exemplars:
        assert start <= e["t"] <= end
        assert len(e["trace_id"]) == 32 and len(e["span_id"]) == 16
        per_bucket[bucket_of(e["t"], 5 * MINUTE)].append(e["value"])
    grid = {bucket_of(t, 5 * MINUTE) for t in range(start, end + 1, MINUTE)}
    assert set(per_bucket) == grid and all(len(v) == 2 for v in per_bucket.values())
    # The kept exemplars are the largest of their bucket.
    top = ch_rows(
        f"SELECT intDiv(toUnixTimestamp64Milli(e.1), {5 * MINUTE}) * {5 * MINUTE} AS b, max(e.2) AS v FROM "
        f"(SELECT arrayJoin(arrayZip(`Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.TraceId`)) AS e "
        f"FROM {table(meta, 'histogram')} WHERE ServiceName = {q(service)} AND MetricName = {q(HIST)} "
        f"AND TimeUnix >= fromUnixTimestamp64Milli({start}) AND TimeUnix <= fromUnixTimestamp64Milli({end})) "
        f"WHERE notEmpty(e.3) AND e.1 >= fromUnixTimestamp64Milli({start}) AND e.1 <= fromUnixTimestamp64Milli({end}) "
        f"GROUP BY b SETTINGS output_format_json_quote_64bit_integers = 0")
    for row in top:
        assert max(per_bucket[int(row["b"])]) == pytest.approx(row["v"], rel=1e-12)

    sample = exemplars[:20]
    span_names = sorted({e["attributes"].get("span.name", "") for e in sample} - {""})
    trace_ids = ", ".join(q(e["trace_id"]) for e in sample)
    found = ch_rows(
        f"SELECT DISTINCT TraceId AS trace_id, SpanId AS span_id FROM otel.otel_traces WHERE ServiceName = {q(service)} "
        + (f"AND SpanName IN ({', '.join(q(n) for n in span_names)}) " if span_names else "")
        + f"AND Timestamp >= fromUnixTimestamp64Milli({start - 3_600_000}) AND Timestamp <= fromUnixTimestamp64Milli({end}) "
        f"AND TraceId IN ({trace_ids})")
    pairs = {(r["trace_id"], r["span_id"]) for r in found}
    for e in sample:
        assert (e["trace_id"], e["span_id"]) in pairs


def test_exemplars_respect_filters(meta):
    start, end = small_window(meta, "histogram", minutes=10)
    service = service_with_temporality(meta, "histogram", HIST, 1)
    base = dict(kind="histogram", service=service, metric=HIST, start_ms=start, end_ms=end, bucket_origin_ms=0)
    everything = ok("/api/metrics/exemplars", **base)["exemplars"]
    assert everything
    span = everything[0]["attributes"]["span.name"]
    kept = ok("/api/metrics/exemplars", filter=f"span.name={span}", **base)["exemplars"]
    assert kept and all(e["attributes"]["span.name"] == span for e in kept)
    dropped = ok("/api/metrics/exemplars", filter_not=f"span.name={span}", **base)["exemplars"]
    assert all(e["attributes"]["span.name"] != span for e in dropped)


# ---------------------------------------------------------------------------
# Grid, validation, budgets


def test_bucket_grid_is_anchored_on_the_browser_midnight(meta):
    lo, hi = kind_bounds(meta, "gauge")
    start, end = hi - 24 * 3_600_000, hi
    origin = 1_789_772_400_000  # any local midnight: only origin mod bucket matters
    body = ok("/api/metrics/series", kind="gauge", service="api_service", metric="queue.depth", start_ms=start, end_ms=end,
              bucket_origin_ms=origin)
    size = body["bucket_ms"]
    assert size == 900_000 and 60 <= len(body["timestamps"]) <= 121
    assert body["bucket_origin_ms"] == origin % size
    assert all((t - origin) % size == 0 for t in body["timestamps"])
    assert body["timestamps"][0] <= start < body["timestamps"][0] + size
    one_hour = ok("/api/metrics/series", kind="gauge", service="api_service", metric="queue.depth",
                  start_ms=hi - 3_600_000, end_ms=hi, bucket_origin_ms=origin)
    assert one_hour["bucket_ms"] == 30_000


def test_unknown_service_or_metric_is_empty_not_an_error(meta):
    lo, hi = kind_bounds(meta, "gauge")
    body = ok("/api/metrics/series", kind="gauge", service="no-such-service", metric="queue.depth", start_ms=lo, end_ms=hi)
    assert body["series"] == [] and body["points"] == 0
    assert ok("/api/metrics/exemplars", kind="gauge", service="no-such-service", metric="x", start_ms=lo, end_ms=hi)["exemplars"] == []
    assert ok("/api/metrics/attributes", kind="gauge", service="no-such-service", metric="x", start_ms=lo, end_ms=hi)["keys"] == []


@pytest.mark.parametrize("path,params,code", [
    ("/api/metrics/catalog", {}, "invalid_metrics_range"),
    ("/api/metrics/catalog", {"start_ms": 10, "end_ms": 5}, "invalid_metrics_range"),
    ("/api/metrics/catalog", {"start_ms": 0, "end_ms": 91 * 86_400_000}, "invalid_metrics_range"),
    ("/api/metrics/series", {"service": "s", "metric": "m", "start_ms": 1, "end_ms": 2}, "invalid_metrics_request"),
    ("/api/metrics/series", {"kind": "bogus", "service": "s", "metric": "m", "start_ms": 1, "end_ms": 2}, "invalid_metrics_request"),
    ("/api/metrics/series", {"kind": "gauge", "metric": "m", "start_ms": 1, "end_ms": 2}, "invalid_metrics_request"),
    ("/api/metrics/series", {"kind": "gauge", "service": "s", "metric": "m"}, "invalid_metrics_request"),
    ("/api/metrics/series", {"kind": "gauge", "service": "s", "metric": "m", "start_ms": 1, "end_ms": 2, "agg": "p99"},
     "invalid_metrics_request"),
    ("/api/metrics/series", {"kind": "gauge", "service": "s", "metric": "m", "start_ms": 1, "end_ms": 2, "filter": "novalue"},
     "invalid_metrics_request"),
    ("/api/metrics/series", {"kind": "gauge", "service": "s", "metric": "m", "start_ms": 1, "end_ms": 2,
                             "group_by": "a,b,c,d,e,f"}, "invalid_metrics_request"),
    ("/api/metrics/series", {"kind": "gauge", "service": "s", "metric": "m", "start_ms": 1, "end_ms": 2, "limit": 0},
     "invalid_metrics_request"),
    ("/api/metrics/exemplars", {"kind": "summary", "service": "s", "metric": "m", "start_ms": 1, "end_ms": 2},
     "invalid_metrics_request"),
    ("/api/metrics/attributes", {"kind": "gauge", "service": "s", "start_ms": 1, "end_ms": 2}, "invalid_metrics_request"),
])
def test_invalid_requests_are_400(meta, path, params, code):
    response = api(path, **params)
    assert response.status_code == 400, response.text
    assert response.json()["error_code"] == code


def test_unknown_host_is_404(meta):
    response = api("/api/metrics/catalog", start_ms=1, end_ms=2, host_id="no-such-host")
    assert response.status_code == 404
    assert response.json()["error_code"] == "unknown_host"


def test_metrics_page_route(meta):
    if not (REPO / "src" / "static" / "metrics.html").exists():
        pytest.skip("metrics.html is not in this tree")
    response = requests.get(f"{BASE_URL}/metrics", timeout=30)
    assert response.status_code == 200
    assert "text/html" in response.headers.get("Content-Type", "")


def test_timing_budgets_on_the_whole_window(meta):
    lo, hi = meta["time_bounds"]["min_ms"], meta["time_bounds"]["max_ms"]
    budgets = []
    started = time.time()
    ok("/api/metrics/catalog", start_ms=lo, end_ms=hi, refresh="1")
    budgets.append(("catalog", time.time() - started))
    cases = [
        ("gauge", "queue.depth", {"group_by": "host.name"}),
        ("sum", CALLS, {"group_by": "span.kind,status.code", "agg": "rate"}),
        ("histogram", HIST, {"agg": "p99"}),
        ("exponential_histogram", "span.duration.exponential", {"agg": "p99"}),
        ("summary", "span.duration.summary", {}),
    ]
    for service in ("api_service", "auth_service"):
        for kind, metric, extra in cases:
            if kind not in meta["available_kinds"]:
                continue
            started = time.time()
            body = ok("/api/metrics/series", kind=kind, service=service, metric=metric, start_ms=lo, end_ms=hi,
                      bucket_origin_ms=0, **extra)
            budgets.append((f"series {kind} {service}", time.time() - started))
            assert body["timing_ms"]["total"] < 5000
        started = time.time()
        ok("/api/metrics/exemplars", kind="histogram", service=service, metric=HIST, start_ms=lo, end_ms=hi, bucket_origin_ms=0)
        budgets.append((f"exemplars {service}", time.time() - started))
    slow = [(name, round(seconds, 2)) for name, seconds in budgets if seconds > 5.0]
    assert not slow, slow
