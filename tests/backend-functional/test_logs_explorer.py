"""Logs explorer routes: /api/logs/{search,histogram,context,patterns,services}.

Every check compares the API with ground truth read straight from ClickHouse
(otel.otel_logs, filled by the otel_fixture service): row order and keyset
paging, token search, attribute / severity / trace filters, histogram buckets,
context presets and pattern counts. Ranges are picked from /api/logs/meta
time_bounds, so the tests follow whatever window the fixture covers. They are
skipped when logs are disabled or the table is empty.
"""
from __future__ import annotations

import json
import os
import time

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))
TABLE = "otel.otel_logs"
TIE = "cityHash64(ServiceName, TraceId, SpanId, SeverityNumber, Body)"


def api(path: str, **params):
    return requests.get(f"{BASE_URL}{path}", params=params, timeout=90)


def ok(path: str, **params) -> dict:
    response = api(path, **params)
    assert response.status_code == 200, response.text
    return response.json()


def ch_rows(sql: str) -> list[dict]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT JSONEachRow").encode(), auth=CH_AUTH, timeout=180)
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def ch_value(sql: str):
    rows = ch_rows(sql)
    return next(iter(rows[0].values())) if rows else None


def time_sql(start_ms: int, end_ms: int) -> str:
    # The API range is [start_ms, end_ms] with end_ms covering its whole millisecond.
    return (f"Timestamp >= fromUnixTimestamp64Milli(toInt64({start_ms})) "
            f"AND Timestamp < fromUnixTimestamp64Milli(toInt64({end_ms + 1}))")


def ids_sql(where: str, limit: int | None = None, order: str = "DESC") -> str:
    tail = f" LIMIT {limit}" if limit else ""
    return (f"SELECT concat(toString(toUnixTimestamp64Nano(Timestamp)), '-', toString({TIE})) AS id FROM {TABLE} "
            f"WHERE {where} ORDER BY Timestamp {order}, {TIE} {order}{tail}")


@pytest.fixture(scope="module")
def meta() -> dict:
    version = ok("/api/version")
    if not version["features"].get("logs", {}).get("enabled"):
        pytest.skip("logs are disabled on this instance")
    m = ok("/api/logs/meta")
    if not m.get("table_exists") or not m.get("time_bounds") or m.get("rows", 0) < 1000:
        pytest.skip("otel_logs is missing or empty")
    return m


@pytest.fixture(scope="module")
def window(meta) -> tuple[int, int]:
    """The newest 30 minutes of the fixture (dense logs)."""
    end_ms = int(meta["time_bounds"]["max_ms"])
    return end_ms - 30 * 60 * 1000, end_ms


def test_logs_page_shell_is_served(meta):
    response = requests.get(f"{BASE_URL}/logs", timeout=30)
    assert response.status_code == 200
    assert 'id="logsWorkspace"' in response.text
    assert 'data-page="logs"' in response.text


def test_search_rows_are_newest_first_like_clickhouse(window):
    start_ms, end_ms = window
    payload = ok("/api/logs/search", start_ms=start_ms, end_ms=end_ms, limit=100)
    expected = [row["id"] for row in ch_rows(ids_sql(time_sql(start_ms, end_ms), 100))]
    assert [row["id"] for row in payload["rows"]] == expected
    assert payload["row_count"] == 100 and payload["next_cursor"] and payload["truncated"] is True
    first = payload["rows"][0]
    for key in ("ts_ns", "ts_ms", "service", "severity_text", "severity_number", "body", "trace_id", "span_id",
                "log_attributes", "resource_attributes", "scope_attributes"):
        assert key in first, key
    assert isinstance(first["log_attributes"], dict) and isinstance(first["resource_attributes"], dict)
    assert int(first["ts_ns"]) // 1_000_000 == first["ts_ms"]
    # Progressive windows: the newest slice alone fills a dense page.
    assert payload["windows"][0]["end_ms"] == end_ms
    assert payload["windows"][0]["end_ms"] - payload["windows"][0]["start_ms"] <= 15 * 60 * 1000


def test_progressive_windows_widen_until_the_limit_is_filled(meta):
    end_ms = int(meta["time_bounds"]["max_ms"])
    start_ms = end_ms - 24 * 60 * 60 * 1000
    # A rare filter: one service's records of one ERROR body template, fewer
    # than the limit in the newest 15 minutes.
    rare = "hasToken(Body, 'synthetic') AND hasToken(Body, 'bulk')"
    service = ch_value(f"SELECT ServiceName FROM {TABLE} WHERE {time_sql(end_ms - 15 * 60000, end_ms)} AND {rare} "
                       f"GROUP BY ServiceName HAVING count() < 200 ORDER BY count() DESC LIMIT 1")
    if not service or int(ch_value(f"SELECT count() FROM {TABLE} WHERE {time_sql(start_ms, end_ms)} AND {rare} "
                                   f"AND ServiceName = '{service}'")) < 200:
        pytest.skip("no rare-enough filter in the fixture")
    params = dict(start_ms=start_ms, end_ms=end_ms, limit=200, service=service, q="synthetic bulk", severity_min=17)
    payload = ok("/api/logs/search", **params)
    windows = payload["windows"]
    sizes = [w["end_ms"] - w["start_ms"] for w in windows]
    assert len(windows) >= 2, windows
    assert sizes[0] <= 15 * 60 * 1000 + 1
    assert all(b >= a for a, b in zip(sizes, sizes[1:-1])), sizes
    # Contiguous, newest first, no gap between windows.
    for newer, older in zip(windows, windows[1:]):
        assert older["end_ms"] <= newer["start_ms"] <= older["end_ms"] + 1
    expected = [row["id"] for row in ch_rows(ids_sql(
        f"{time_sql(start_ms, end_ms)} AND ServiceName = '{service}' AND {rare} AND SeverityNumber >= 17", 200))]
    assert [row["id"] for row in payload["rows"]] == expected


def paged_ids(params: dict, limit: int, max_pages: int = 60) -> list[str]:
    ids: list[str] = []
    cursor = None
    for _ in range(max_pages):
        page = ok("/api/logs/search", **params, limit=limit, **({"cursor": cursor} if cursor else {}))
        ids.extend(row["id"] for row in page["rows"])
        cursor = page["next_cursor"]
        if not cursor:
            return ids
    raise AssertionError("paging did not finish")


def test_keyset_paging_never_skips_or_duplicates(window):
    start_ms, end_ms = window
    # A service's WARN records over one dense minute: a few hundred rows.
    lo = end_ms - 60 * 1000
    service = ch_value(f"SELECT ServiceName FROM {TABLE} WHERE {time_sql(lo, end_ms)} AND SeverityNumber BETWEEN 13 AND 16 "
                       f"GROUP BY ServiceName HAVING count() BETWEEN 100 AND 4000 ORDER BY count() LIMIT 1")
    if not service:
        pytest.skip("no service with a paging-sized WARN set")
    where = f"{time_sql(lo, end_ms)} AND ServiceName = '{service}' AND SeverityNumber >= 13 AND SeverityNumber <= 16"
    expected = [row["id"] for row in ch_rows(ids_sql(where))]
    got = paged_ids(dict(start_ms=lo, end_ms=end_ms, service=service, severity="warn"), limit=37)
    assert len(got) == len(set(got)), "duplicate rows across pages"
    assert got == expected


def test_keyset_cursor_splits_records_sharing_a_timestamp(window):
    start_ms, end_ms = window
    dup = ch_rows(f"SELECT toString(toUnixTimestamp64Nano(Timestamp)) AS ts, count() AS c FROM {TABLE} "
                  f"WHERE {time_sql(start_ms, end_ms)} GROUP BY Timestamp HAVING c > 1 ORDER BY Timestamp DESC LIMIT 1")
    if not dup:
        pytest.skip("no two records share a timestamp in the window")
    ts = int(dup[0]["ts"])
    group = ch_rows(ids_sql(f"Timestamp = fromUnixTimestamp64Nano(toInt64({ts}))"))
    ids = [row["id"] for row in group]
    # Continue right after the first record of the group: the next page starts
    # with the rest of the group, in tiebreak order.
    page = ok("/api/logs/search", start_ms=start_ms, end_ms=end_ms, limit=len(ids) - 1, cursor=ids[0])
    assert [row["id"] for row in page["rows"]] == ids[1:]


def test_token_search_matches_hastoken_ground_truth(window):
    start_ms, end_ms = window
    lo = end_ms - 10 * 60 * 1000
    cases = {
        "cache miss": "hasToken(Body, 'cache') AND hasToken(Body, 'miss')",
        # Separators inside a term: every token plus the verbatim text.
        "analytics.events_buffer": "hasToken(Body, 'analytics') AND hasToken(Body, 'events') AND hasToken(Body, 'buffer') "
                                   "AND position(Body, 'analytics.events_buffer') > 0",
        "key=user:12": "hasToken(Body, 'key') AND hasToken(Body, 'user') AND hasToken(Body, '12') AND position(Body, 'key=user:12') > 0",
        "\"too many parts\"": "hasToken(Body, 'too') AND hasToken(Body, 'many') AND hasToken(Body, 'parts') "
                              "AND position(Body, 'too many parts') > 0",
        "events -GET": "hasToken(Body, 'events') AND NOT hasToken(Body, 'GET')",
    }
    for q, predicate in cases.items():
        payload = ok("/api/logs/search", start_ms=lo, end_ms=end_ms, limit=150, q=q)
        expected = [row["id"] for row in ch_rows(ids_sql(f"{time_sql(lo, end_ms)} AND {predicate}", 150))]
        assert [row["id"] for row in payload["rows"]] == expected, q
        assert payload["text_search"]["active"] is True and payload["text_search"]["mode"] == "token"
    # The exporter's tokenbf_v1 idx_body serves the search.
    assert payload["text_search"]["index_backed"] is True


def test_attribute_severity_and_trace_filters(window):
    start_ms, end_ms = window
    lo = end_ms - 5 * 60 * 1000
    sample = ch_rows(f"SELECT ResourceAttributes['host.name'] AS host, LogAttributes['code.function'] AS fn, TraceId AS trace "
                     f"FROM {TABLE} WHERE {time_sql(lo, end_ms)} AND TraceId != '' AND LogAttributes['code.function'] != '' "
                     f"ORDER BY Timestamp DESC LIMIT 1")[0]
    cases = [
        ({"attr": f"host.name={sample['host']}"},
         f"(LogAttributes['host.name'] = '{sample['host']}' OR ResourceAttributes['host.name'] = '{sample['host']}')"),
        ({"attr": f"LogAttributes.code.function={sample['fn']}"}, f"LogAttributes['code.function'] = '{sample['fn']}'"),
        ({"attr": [f"ResourceAttributes.host.name={sample['host']}", "log.origin!=after_span"]},
         f"ResourceAttributes['host.name'] = '{sample['host']}' AND NOT (LogAttributes['log.origin'] = 'after_span' "
         f"OR ResourceAttributes['log.origin'] = 'after_span')"),
        ({"attr": "SeverityText=WARN"}, "SeverityText = 'WARN'"),
        ({"severity_min": 13}, "SeverityNumber >= 13"),
        ({"severity": ["error", "debug"]}, "(SeverityNumber >= 17 OR SeverityNumber <= 8)"),
        ({"trace_id": sample["trace"]}, f"TraceId = '{sample['trace']}'"),
    ]
    for params, predicate in cases:
        payload = ok("/api/logs/search", start_ms=lo, end_ms=end_ms, limit=120, **params)
        expected = [row["id"] for row in ch_rows(ids_sql(f"{time_sql(lo, end_ms)} AND {predicate}", 120))]
        assert expected, params
        assert [row["id"] for row in payload["rows"]] == expected, params


def test_services_filter_and_service_choices(window):
    start_ms, end_ms = window
    services = ok("/api/logs/services", start_ms=start_ms, end_ms=end_ms)["services"]
    expected = ch_rows(f"SELECT ServiceName AS name, count() AS count FROM {TABLE} WHERE {time_sql(start_ms, end_ms)} "
                       f"GROUP BY ServiceName ORDER BY ServiceName")
    assert [(s["name"], s["count"]) for s in services] == [(e["name"], int(e["count"])) for e in expected]
    two = [expected[0]["name"], expected[-1]["name"]]
    payload = ok("/api/logs/search", start_ms=start_ms, end_ms=end_ms, limit=80, service=two)
    assert {row["service"] for row in payload["rows"]} <= set(two)
    truth = [row["id"] for row in ch_rows(ids_sql(f"{time_sql(start_ms, end_ms)} AND ServiceName IN ('{two[0]}', '{two[1]}')", 80))]
    assert [row["id"] for row in payload["rows"]] == truth


def histogram_truth(start_ms: int, end_ms: int, size: int, origin: int, where: str = "1") -> list[list[int]]:
    rows = ch_rows(
        f"SELECT {origin} + intDiv(toUnixTimestamp64Milli(Timestamp) - {origin}, {size}) * {size} AS b, "
        f"countIf(SeverityNumber >= 17) AS e, countIf(SeverityNumber >= 13 AND SeverityNumber < 17) AS w, "
        f"countIf(SeverityNumber >= 9 AND SeverityNumber < 13) AS i, countIf(SeverityNumber < 9) AS d "
        f"FROM {TABLE} WHERE {time_sql(start_ms, end_ms)} AND {where} GROUP BY b ORDER BY b")
    return [[int(r["b"]), int(r["e"]), int(r["w"]), int(r["i"]), int(r["d"])] for r in rows]


def test_histogram_buckets_match_ground_truth_on_the_local_midnight_grid(window):
    start_ms, end_ms = window
    # A browser two hours east of UTC: buckets align on its local midnight.
    day = 24 * 3600 * 1000
    origin_ms = (start_ms // day) * day - 2 * 3600 * 1000
    payload = ok("/api/logs/histogram", start_ms=start_ms, end_ms=end_ms, bucket_origin_ms=origin_ms, buckets=90)
    size = payload["bucket_ms"]
    assert size in (15000, 30000, 60000)
    assert payload["bucket_origin_ms"] == origin_ms % size
    assert payload["buckets"] == histogram_truth(start_ms, end_ms, size, payload["bucket_origin_ms"])
    totals = payload["totals"]
    assert totals["total"] == sum(sum(b[1:]) for b in payload["buckets"])
    assert totals["total"] == int(ch_value(f"SELECT count() FROM {TABLE} WHERE {time_sql(start_ms, end_ms)}"))
    assert [totals[k] for k in ("error", "warn", "info", "debug")] == [sum(b[i] for b in payload["buckets"]) for i in range(1, 5)]

    # Sub-second origin: buckets come from Timestamp (not TimestampTime) and stay exact.
    odd = ok("/api/logs/histogram", start_ms=end_ms - 120000, end_ms=end_ms, bucket_origin_ms=123, buckets=24)
    assert odd["buckets"] == histogram_truth(end_ms - 120000, end_ms, odd["bucket_ms"], odd["bucket_origin_ms"])


def test_histogram_total_with_filters_is_the_filtered_count(window):
    start_ms, end_ms = window
    payload = ok("/api/logs/histogram", start_ms=start_ms, end_ms=end_ms, q="inserted rows", severity_min=9)
    where = "hasToken(Body, 'inserted') AND hasToken(Body, 'rows') AND SeverityNumber >= 9"
    assert payload["totals"]["total"] == int(ch_value(f"SELECT count() FROM {TABLE} WHERE {time_sql(start_ms, end_ms)} AND {where}"))
    assert payload["totals"]["total"] > 0


def test_context_presets(window):
    start_ms, end_ms = window
    anchor = ok("/api/logs/search", start_ms=end_ms - 5 * 60 * 1000, end_ms=end_ms - 60 * 1000, limit=1,
                q="inserted", trace_id=ch_value(
                    f"SELECT TraceId FROM {TABLE} WHERE {time_sql(end_ms - 5 * 60000, end_ms - 60000)} AND TraceId != '' "
                    f"AND hasToken(Body, 'inserted') ORDER BY Timestamp DESC LIMIT 1"))["rows"][0]
    ts, tie = anchor["id"].split("-")
    host = anchor["resource_attributes"]["host.name"]
    presets = {
        "anything": ({}, "1"),
        "service": ({"service": anchor["service"]}, f"ServiceName = '{anchor['service']}'"),
        "host": ({"host": host}, f"ResourceAttributes['host.name'] = '{host}'"),
        "trace": ({"trace_id": anchor["trace_id"]}, f"TraceId = '{anchor['trace_id']}'"),
    }
    window_ms = 120000
    for preset, (extra, predicate) in presets.items():
        payload = ok("/api/logs/context", ts_ns=ts, tie=tie, preset=preset, window_ms=window_ms, limit=20, **extra)
        ids = [row["id"] for row in payload["rows"]]
        assert payload["anchor_found"] is True and anchor["id"] in ids, preset
        at = ids.index(anchor["id"])
        assert at == payload["after_count"], preset
        lo_ns, hi_ns = int(ts) - window_ms * 1_000_000, int(ts) + window_ms * 1_000_000
        base = f"Timestamp >= fromUnixTimestamp64Nano(toInt64({lo_ns})) AND Timestamp <= fromUnixTimestamp64Nano(toInt64({hi_ns})) AND {predicate}"
        key = f"(toUnixTimestamp64Nano(Timestamp), {TIE})"
        older = [r["id"] for r in ch_rows(ids_sql(f"{base} AND {key} < (toInt64({ts}), toUInt64({tie}))", 20))]
        newer = [r["id"] for r in ch_rows(ids_sql(f"{base} AND {key} > (toInt64({ts}), toUInt64({tie}))", 20, order="ASC"))]
        assert ids[at + 1:] == older, preset
        assert ids[:at] == list(reversed(newer)), preset
        if preset == "trace":
            assert {row["trace_id"] for row in payload["rows"]} == {anchor["trace_id"]}
        if preset == "host":
            assert {row["resource_attributes"].get("host.name") for row in payload["rows"]} == {host}
        if preset == "service":
            assert {row["service"] for row in payload["rows"]} == {anchor["service"]}


def test_patterns_shape_scaling_and_filter_round_trip(window):
    start_ms, end_ms = window
    payload = ok("/api/logs/patterns", start_ms=start_ms, end_ms=end_ms)
    total = int(ch_value(f"SELECT count() FROM {TABLE} WHERE {time_sql(start_ms, end_ms)}"))
    assert payload["total"] == total
    assert payload["sampled"] is True and payload["sample_method"] == "block_hash"
    assert 5000 <= payload["sample_size"] <= payload["sample_target"] == 10000
    assert payload["scale"] == pytest.approx(total / payload["sample_size"], rel=1e-6)
    patterns = payload["patterns"]
    assert patterns and payload["pattern_count"] == len(patterns)
    assert sum(p["sample_count"] for p in patterns) == payload["sample_size"]
    assert sum(p["share"] for p in patterns) == pytest.approx(1.0, abs=1e-6)
    assert sum(p["count"] for p in patterns) == pytest.approx(total, rel=0.01)
    counts = [p["sample_count"] for p in patterns]
    assert counts == sorted(counts, reverse=True)
    for p in patterns:
        assert p["noisy"] == (p["share"] > 0.10)
        assert p["count"] == round(p["sample_count"] * payload["scale"])
        assert len(p["sparkline"]) == payload["sparkline_buckets"]
        assert sum(p["sparkline"]) == pytest.approx(p["count"], abs=len(p["sparkline"]))
        assert p["severity"] in ("error", "warn", "info", "debug")
    templates = {p["pattern"]: p for p in patterns}
    inserted = templates.get("inserted <*> rows into analytics.events_buffer in <*> ms")
    assert inserted, sorted(templates)[:20]
    # The pattern's search text finds exactly that template.
    rows = ok("/api/logs/search", start_ms=start_ms, end_ms=end_ms, limit=100, q=inserted["search"])["rows"]
    assert rows and all(row["body"].startswith("inserted ") and "rows into analytics.events_buffer in" in row["body"] for row in rows)


def test_patterns_on_a_small_set_are_exact(window):
    start_ms, end_ms = window
    lo = end_ms - 2 * 60 * 1000
    service = ch_value(f"SELECT ServiceName FROM {TABLE} WHERE {time_sql(lo, end_ms)} AND SeverityNumber >= 17 "
                       f"GROUP BY ServiceName ORDER BY count() DESC LIMIT 1")
    payload = ok("/api/logs/patterns", start_ms=lo, end_ms=end_ms, service=service, severity_min=17)
    total = int(ch_value(f"SELECT count() FROM {TABLE} WHERE {time_sql(lo, end_ms)} AND ServiceName = '{service}' AND SeverityNumber >= 17"))
    assert 0 < total <= 10000
    assert payload["sampled"] is False and payload["sample_size"] == total and payload["scale"] == 1
    assert sum(p["count"] for p in payload["patterns"]) == total


def test_validation_errors():
    now = int(time.time() * 1000)
    bad = [
        ("/api/logs/search", {"start_ms": now, "end_ms": now - 1}, "invalid_logs_range"),
        ("/api/logs/search", {"start_ms": now - 400 * 24 * 3600 * 1000, "end_ms": now}, "invalid_logs_range"),
        ("/api/logs/search", {"start_ms": now - 60000}, "invalid_logs_range"),
        ("/api/logs/search", {"start_ms": now - 60000, "end_ms": now, "cursor": "nope"}, "invalid_logs_cursor"),
        ("/api/logs/search", {"start_ms": now - 60000, "end_ms": now, "cursor": "1-2", "after": "1-2"}, "invalid_logs_cursor"),
        ("/api/logs/search", {"start_ms": now - 60000, "end_ms": now, "severity": "loud"}, "invalid_logs_filter"),
        ("/api/logs/search", {"start_ms": now - 60000, "end_ms": now, "severity_min": 99}, "invalid_logs_filter"),
        ("/api/logs/search", {"start_ms": now - 60000, "end_ms": now, "attr": "novalue"}, "invalid_logs_filter"),
        ("/api/logs/search", {"start_ms": now - 60000, "end_ms": now, "trace_id": "xyz'"}, "invalid_logs_filter"),
        ("/api/logs/histogram", {"start_ms": now - 60000, "end_ms": now, "attr": "=x"}, "invalid_logs_filter"),
        ("/api/logs/context", {}, "invalid_logs_context"),
        ("/api/logs/context", {"ts_ns": now * 1000000, "preset": "host"}, "invalid_logs_context"),
        ("/api/logs/context", {"ts_ns": now * 1000000, "preset": "trace", "trace_id": "zz"}, "invalid_logs_context"),
        ("/api/logs/context", {"ts_ns": now * 1000000, "preset": "galaxy"}, "invalid_logs_context"),
    ]
    for path, params, code in bad:
        response = api(path, **params)
        assert response.status_code == 400, (path, params, response.text)
        assert response.json().get("error_code") == code, (path, params, response.text)


def test_live_tail_returns_only_newer_records(window):
    start_ms, end_ms = window
    page = ok("/api/logs/search", start_ms=start_ms, end_ms=end_ms, limit=30)["rows"]
    pivot = page[10]
    tail = ok("/api/logs/search", start_ms=start_ms, end_ms=end_ms, limit=200, after=pivot["id"])
    assert tail["mode"] == "tail" and tail["next_cursor"] is None
    assert [row["id"] for row in tail["rows"]] == [row["id"] for row in page[:10]]
    newest = ok("/api/logs/search", start_ms=start_ms, end_ms=end_ms, limit=5, after=page[0]["id"])
    assert newest["rows"] == []


def test_timing_budgets(meta):
    """Generous budgets: the ClickHouse container is shared with other suites."""
    end_ms = int(meta["time_bounds"]["max_ms"])
    day = dict(start_ms=end_ms - 24 * 3600 * 1000, end_ms=end_ms)
    hour = dict(start_ms=end_ms - 3600 * 1000, end_ms=end_ms)
    budgets = [
        ("/api/logs/search", day, 10.0),
        ("/api/logs/search", {**day, "q": "cache miss"}, 15.0),
        ("/api/logs/histogram", day, 15.0),
        ("/api/logs/patterns", hour, 15.0),
        ("/api/logs/services", day, 10.0),
    ]
    for path, params, budget in budgets:
        started = time.perf_counter()
        ok(path, **params)
        elapsed = time.perf_counter() - started
        assert elapsed < budget, (path, params, elapsed)


SUBSTRING_BASE_URL = os.environ.get("CHDASH_LOGS_SUBSTRING_API_BASE_URL", "").rstrip("/")


@pytest.mark.skipif(not SUBSTRING_BASE_URL, reason="CHDASH_LOGS_SUBSTRING_API_BASE_URL (logs.body_search = substring) not set")
def test_substring_body_search_uses_narrow_windows():
    meta = requests.get(f"{SUBSTRING_BASE_URL}/api/logs/meta", timeout=30).json()
    assert meta["body_search"]["effective"] == "substring"
    end_ms = int(meta["time_bounds"]["max_ms"])
    lo = end_ms - 3600 * 1000
    response = requests.get(f"{SUBSTRING_BASE_URL}/api/logs/search", timeout=90,
                            params=dict(start_ms=lo, end_ms=end_ms, q="EVENTS_buffer", limit=50))
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["text_search"] == {"active": True, "mode": "substring", "index_backed": False}
    assert all(w["end_ms"] - w["start_ms"] <= 15 * 60 * 1000 for w in payload["windows"])
    expected = [row["id"] for row in ch_rows(ids_sql(f"{time_sql(lo, end_ms)} AND Body ILIKE '%events\\\\_buffer%'", 50))]
    assert [row["id"] for row in payload["rows"]] == expected
    wide = requests.get(f"{SUBSTRING_BASE_URL}/api/logs/histogram", timeout=30,
                        params=dict(start_ms=end_ms - 7 * 3600 * 1000, end_ms=end_ms, q="x"))
    assert wide.status_code == 400 and wide.json()["error_code"] == "logs_substring_range"
