"""OTel logs/metrics prerequisites: meta endpoints and the derived fixture data.

The meta checks compare /api/logs/meta and /api/metrics/meta with ground truth
read straight from ClickHouse system tables. The data checks verify that the
otel_fixture logs/metrics correlate with the stored spans (they are derived
from them) and are skipped when the fixture did not generate them.

CHDASH_ALT_API_BASE_URLS (comma-separated) adds ChDash instances started with
other logs/metrics configurations (disabled, missing tables); every configured
instance is checked for the disabled / missing contract.
"""
from __future__ import annotations

import json
import os

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
ALT_BASE_URLS = [u.strip().rstrip("/") for u in os.environ.get("CHDASH_ALT_API_BASE_URLS", "").split(",") if u.strip()]
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))

METRIC_KINDS = ("gauge", "sum", "histogram", "exponential_histogram", "summary")


def api(path: str, base: str = BASE_URL, **params) -> requests.Response:
    return requests.get(f"{base}{path}", params=params or None, timeout=30)


def ch_rows(sql: str) -> list[dict]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT JSONEachRow").encode(), auth=CH_AUTH, timeout=120)
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def ch_value(sql: str):
    rows = ch_rows(sql)
    return next(iter(rows[0].values())) if rows else None


def features(base: str = BASE_URL) -> dict:
    response = api("/api/version", base)
    assert response.status_code == 200, response.text
    return response.json()["features"]


def logs_meta(base: str = BASE_URL, **params) -> dict:
    response = api("/api/logs/meta", base, **params)
    assert response.status_code == 200, response.text
    return response.json()


def metrics_meta(base: str = BASE_URL, **params) -> dict:
    response = api("/api/metrics/meta", base, **params)
    assert response.status_code == 200, response.text
    return response.json()


def require_logs_enabled() -> dict:
    if not features()["logs"]["enabled"]:
        pytest.skip("logs are disabled in this configuration")
    meta = logs_meta(refresh="1")
    if not meta["table_exists"]:
        pytest.skip("the configured logs table does not exist")
    return meta


def require_metrics_enabled() -> dict:
    if not features()["metrics"]["enabled"]:
        pytest.skip("metrics are disabled in this configuration")
    return metrics_meta(refresh="1")


def table_rows(database: str, table: str) -> int:
    return int(ch_value(
        "SELECT coalesce(sum(rows), 0) FROM system.parts "
        f"WHERE active AND database = '{database}' AND table = '{table}'") or 0)


def parts_bounds_ms(database: str, table: str) -> tuple[int, int]:
    row = ch_rows(
        "SELECT toUnixTimestamp(min(min_time)) * 1000 AS lo, toUnixTimestamp(max(max_time)) * 1000 + 999 AS hi "
        f"FROM system.parts WHERE active AND database = '{database}' AND table = '{table}'")[0]
    return int(row["lo"]), int(row["hi"])


def sql_list(values) -> str:
    return "(" + ",".join("'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'" for v in values) + ")"


# ---------------------------------------------------------------------------
# Configuration surface.

def test_version_exposes_logs_and_metrics_features():
    feats = features()
    assert set(feats["logs"]) >= {"enabled", "body_search"}, feats
    assert feats["logs"]["body_search"] in {"token", "substring", "off"}, feats
    assert isinstance(feats["metrics"]["enabled"], bool), feats


def _check_disabled_or_missing(base: str) -> None:
    feats = features(base)
    logs = logs_meta(base)
    if not feats["logs"]["enabled"]:
        assert logs["enabled"] is False, logs
        assert logs["signal"] == "logs" and logs["error_code"] == "logs_disabled", logs
        assert "logs { enabled = true }" in logs["message"], logs
    elif not logs["table_exists"]:
        assert logs["schema_ok"] is False and logs["error_code"] == "logs_table_missing", logs
        assert logs["table"] in logs["message"] and logs["features"]["search"] is False, logs
    metrics = metrics_meta(base)
    if not feats["metrics"]["enabled"]:
        assert metrics["enabled"] is False, metrics
        assert metrics["signal"] == "metrics" and metrics["error_code"] == "metrics_disabled", metrics
        assert "metrics { enabled = true }" in metrics["message"], metrics
    elif not metrics["available_kinds"]:
        assert metrics["error_code"] == "metrics_tables_missing", metrics
        assert sorted(metrics["missing_kinds"]) == sorted(METRIC_KINDS), metrics
        assert all(metrics["kinds"][k]["exists"] is False for k in METRIC_KINDS), metrics
        assert metrics["features"]["browse"] is False, metrics


def test_meta_routes_answer_disabled_or_missing_sources_without_errors():
    for base in [BASE_URL] + ALT_BASE_URLS:
        _check_disabled_or_missing(base)


@pytest.mark.parametrize("path", ["/api/logs/meta", "/api/metrics/meta"])
def test_meta_routes_reject_unknown_hosts_with_404(path):
    feats = features()
    signal = "logs" if "logs" in path else "metrics"
    if not feats[signal]["enabled"]:
        pytest.skip(f"{signal} disabled")
    response = api(path, host_id="no-such-host")
    assert response.status_code == 404, response.text
    assert response.json().get("error_code") == "unknown_host", response.text


# ---------------------------------------------------------------------------
# /api/logs/meta against system-table ground truth.

def test_logs_meta_reports_exporter_schema_indexes_and_bounds():
    meta = require_logs_enabled()
    database, table = meta["database"], meta["table"]
    assert meta["enabled"] is True and meta["schema_ok"] is True, meta
    assert meta["missing_columns"] == [], meta

    tables = ch_rows(f"SELECT sorting_key, partition_key FROM system.tables WHERE database = '{database}' AND name = '{table}'")
    assert meta["sorting_key"] == tables[0]["sorting_key"], meta
    assert meta["partition_key"] == tables[0]["partition_key"], meta
    columns = ch_rows(f"SELECT name, type FROM system.columns WHERE database = '{database}' AND table = '{table}' ORDER BY position")
    assert [(c["name"], c["type"]) for c in meta["columns"]] == [(c["name"], c["type"]) for c in columns]

    has_tt = any(c["name"] == "TimestampTime" for c in columns)
    assert meta["timestamp_time_column"] is has_tt
    assert meta["time_column"] == ("TimestampTime" if has_tt else "Timestamp")
    assert meta["precise_time_column"] == "Timestamp"
    for key, column in (("log", "LogAttributes"), ("resource", "ResourceAttributes"), ("scope", "ScopeAttributes")):
        expected = next((c["type"] for c in columns if c["name"] == column), None)
        assert meta["attributes"][key]["type"] == expected, meta["attributes"]
        if expected and expected.startswith("Map("):
            assert meta["attributes"][key]["kind"] == "map"

    indexes = ch_rows(
        "SELECT name, type, type_full, expr, granularity FROM system.data_skipping_indices "
        f"WHERE database = '{database}' AND table = '{table}' ORDER BY name")
    assert [(i["name"], i["type"], i["type_full"], i["expr"]) for i in meta["skip_indexes"]] == \
        [(i["name"], i["type"], i["type_full"], i["expr"]) for i in indexes]
    trace_index = next((i for i in indexes if i["expr"] == "TraceId"), None)
    if trace_index:
        assert meta["trace_id_index"]["name"] == trace_index["name"], meta["trace_id_index"]
        assert meta["features"]["trace_id_index"] is True
    body_index = next((i for i in indexes if i["expr"] in ("Body", "lower(Body)")), None)
    if body_index:
        assert meta["body_index"]["name"] == body_index["name"]
        assert meta["body_index"]["type"] == body_index["type"]
        assert meta["body_index"]["lowercase"] is body_index["expr"].startswith("lower(")
    assert meta["body_search"]["configured"] == features()["logs"]["body_search"]

    rows = table_rows(database, table)
    assert meta["rows"] == rows, meta
    if rows:
        lo, hi = parts_bounds_ms(database, table)
        assert meta["time_bounds"]["min_ms"] == lo and meta["time_bounds"]["max_ms"] == hi, meta["time_bounds"]
        assert meta["time_bounds"]["scope"] == "table"
    else:
        assert meta["time_bounds"] is None


def test_logs_meta_matches_the_exporter_layout_of_the_test_stack():
    meta = require_logs_enabled()
    if (meta["database"], meta["table"]) != ("otel", "otel_logs"):
        pytest.skip("not the test-stack logs table")
    assert meta["sorting_key"] == "ServiceName, TimestampTime, Timestamp"
    assert meta["partition_key"] == "toDate(TimestampTime)"
    assert meta["trace_id_index"]["type_full"] == "bloom_filter(0.001)"
    assert meta["body_index"] == {
        "name": "idx_body", "type": "tokenbf_v1", "type_full": "tokenbf_v1(32768, 3, 0)", "expr": "Body",
        "granularity": 8, "lowercase": False, "token_search": True, "substring_search": False,
    }
    if meta["body_search"]["configured"] == "token":
        assert meta["body_search"] == {"configured": "token", "effective": "token", "index_backed": True}
    assert meta["features"]["trace_correlation"] is True


def test_logs_meta_is_cached_and_refreshable():
    require_logs_enabled()
    first = logs_meta(refresh="1")
    assert first["cache"]["hit"] is False and first["cache"]["ttl_ms"] == 60000
    second = logs_meta()
    assert second["cache"]["hit"] is True, second["cache"]
    assert {k: v for k, v in second.items() if k != "cache"} == {k: v for k, v in first.items() if k != "cache"}


# ---------------------------------------------------------------------------
# /api/metrics/meta against system-table ground truth.

def test_metrics_meta_reports_kinds_exemplars_and_bounds():
    meta = require_metrics_enabled()
    database, prefix = meta["database"], meta["table_prefix"]
    existing = {r["name"] for r in ch_rows(f"SELECT name FROM system.tables WHERE database = '{database}' AND startsWith(name, '{prefix}_')")}
    for kind in METRIC_KINDS:
        info = meta["kinds"][kind]
        table = f"{prefix}_{kind}"
        assert info["table"] == table
        assert info["exists"] is (table in existing), info
        if not info["exists"]:
            assert kind in meta["missing_kinds"]
            continue
        assert info["schema_ok"] is True and info["missing_columns"] == [], info
        assert kind in meta["available_kinds"]
        columns = [r["name"] for r in ch_rows(
            f"SELECT name FROM system.columns WHERE database = '{database}' AND table = '{table}' ORDER BY position")]
        assert [c["name"] for c in info["columns"]] == columns
        exemplar_columns = [c for c in columns if c.startswith("Exemplars.")]
        assert info["exemplars"]["columns"] == exemplar_columns
        assert info["exemplars"]["trace_id"] is ("Exemplars.TraceId" in columns)
        rows = table_rows(database, table)
        assert info["rows"] == rows
        if rows:
            lo, hi = parts_bounds_ms(database, table)
            assert (info["time_bounds"]["min_ms"], info["time_bounds"]["max_ms"]) == (lo, hi)
        else:
            assert info["time_bounds"] is None
    if (database, prefix) == ("otel", "otel_metrics"):
        assert meta["available_kinds"] == list(METRIC_KINDS), meta["available_kinds"]
        assert meta["kinds"]["summary"]["exemplars"]["present"] is False
        for kind in ("gauge", "sum", "histogram", "exponential_histogram"):
            assert meta["kinds"][kind]["exemplars"]["present"] is True
            assert meta["kinds"][kind]["time_type"] == "DateTime64(9)"
        assert meta["features"]["exemplars"] is True
        assert meta["features"]["histograms"] is True
    assert meta["rows"] == sum(meta["kinds"][k].get("rows", 0) for k in METRIC_KINDS)


# ---------------------------------------------------------------------------
# Fixture data: logs derived from spans.

def _logs_fixture() -> tuple[int, int]:
    """(window end ms, rows) of the fixture logs, or skip."""
    meta = require_logs_enabled()
    if (meta["database"], meta["table"]) != ("otel", "otel_logs") or not meta["rows"]:
        pytest.skip("OTEL logs fixture is empty")
    return meta["time_bounds"]["max_ms"], meta["rows"]


def test_fixture_logs_reference_spans_of_the_trace_fixture():
    end_ms, _ = _logs_fixture()
    sample = ch_rows(
        "SELECT TraceId, SpanId, toUnixTimestamp64Nano(Timestamp) AS ts, LogAttributes['log.origin'] AS origin "
        "FROM otel.otel_logs "
        f"WHERE TimestampTime >= toDateTime({end_ms // 1000 - 3600}) AND TraceId != '' "
        "ORDER BY cityHash64(TraceId, SpanId, Timestamp) LIMIT 300")
    assert len(sample) >= 100, len(sample)
    spans = ch_rows(
        "SELECT TraceId, SpanId, toUnixTimestamp64Nano(Timestamp) AS start, Duration FROM otel.otel_traces "
        f"WHERE Timestamp >= fromUnixTimestamp64Milli(toInt64({end_ms - 2 * 3600_000})) "
        f"AND TraceId IN {sql_list({row['TraceId'] for row in sample})}")
    # The large trace fixture may hold the same (TraceId, SpanId) at two
    # timestamps (separate trace loads); a log must match one of those spans.
    by_id: dict[tuple[str, str], list[dict]] = {}
    for s in spans:
        by_id.setdefault((s["TraceId"], s["SpanId"]), []).append(s)
    missing = [row for row in sample if (row["TraceId"], row["SpanId"]) not in by_id]
    assert not missing, missing[:5]

    def within(row: dict, span: dict) -> bool:
        start, end = int(span["start"]), int(span["start"]) + int(span["Duration"])
        ts = int(row["ts"])
        if row["origin"] == "after_span":
            return end + 1_000_000_000 <= ts <= end + 3_000_000_000
        return start <= ts <= end

    for row in sample:
        candidates = by_id[(row["TraceId"], row["SpanId"])]
        assert any(within(row, span) for span in candidates), (row, candidates)


def test_every_error_span_of_the_window_has_an_error_log_with_its_status_message():
    end_ms, _ = _logs_fixture()
    errors = ch_rows(
        "SELECT TraceId, SpanId, StatusMessage FROM otel.otel_traces "
        f"WHERE Timestamp >= fromUnixTimestamp64Milli(toInt64({end_ms - 3600_000})) AND StatusCode = 'Error' "
        "ORDER BY TraceId, SpanId LIMIT 100")
    if not errors:
        pytest.skip("no error span in the last fixture hour")
    logs = ch_rows(
        "SELECT TraceId, SpanId, Body, SeverityNumber, LogAttributes['exception.type'] AS exception_type "
        "FROM otel.otel_logs "
        f"WHERE TimestampTime >= toDateTime({end_ms // 1000 - 3600 - 5}) AND SeverityText = 'ERROR' "
        f"AND TraceId IN {sql_list({e['TraceId'] for e in errors})}")
    by_span = {}
    for row in logs:
        by_span.setdefault((row["TraceId"], row["SpanId"]), []).append(row)
    for error in errors:
        records = by_span.get((error["TraceId"], error["SpanId"]), [])
        expected = error["StatusMessage"] or None
        assert any(r["exception_type"] == "SyntheticFixtureError" and int(r["SeverityNumber"]) == 17 and
                   (expected is None or r["Body"] == expected) for r in records), (error, records)


def test_fixture_log_severity_mix_trace_context_and_attributes():
    end_ms, _ = _logs_fixture()
    # The span-derived logs cover the day ending at the newest span; the rich
    # dataset (2026-09-12, tests/README.md) has its own mix and releases.
    window = f"TimestampTime >= toDateTime({end_ms // 1000 - 86400 - 60})"
    stats = ch_rows(
        f"SELECT SeverityText AS sev, count() AS n FROM otel.otel_logs WHERE {window} GROUP BY sev")
    total = sum(int(r["n"]) for r in stats)
    share = {r["sev"]: int(r["n"]) / total for r in stats}
    assert set(share) == {"DEBUG", "INFO", "WARN", "ERROR"}, share
    for sev, expected, tolerance in (("DEBUG", 0.20, 0.03), ("INFO", 0.65, 0.03), ("WARN", 0.10, 0.02), ("ERROR", 0.05, 0.02)):
        assert abs(share[sev] - expected) <= tolerance, share
    row = ch_rows(
        "SELECT countIf(TraceId = '') / count() AS orphan, "
        "countIf(LogAttributes['log.origin'] = 'after_span') / count() AS late, "
        "countIf(SeverityText = 'ERROR' AND (LogAttributes['exception.type'] = '' OR LogAttributes['exception.stacktrace'] = '')) AS bad_errors, "
        "countIf(LogAttributes['code.function'] = '') AS no_function, "
        "countIf(ResourceAttributes['host.name'] = '' OR ResourceAttributes['service.version'] = '' "
        "        OR ResourceAttributes['service.name'] != ServiceName) AS bad_resource, "
        "uniqExact(ServiceName, ResourceAttributes['service.version']) = uniqExact(ServiceName) AS stable_versions, "
        "countIf(LogAttributes['http.route'] != '') AS http_rows, "
        "countIf(TimestampTime != toDateTime(Timestamp)) AS bad_timestamp_time "
        f"FROM otel.otel_logs WHERE {window}")[0]
    assert 0.03 <= float(row["orphan"]) <= 0.07, row
    assert 0.03 <= float(row["late"]) <= 0.07, row
    assert int(row["bad_errors"]) == 0 and int(row["no_function"]) == 0 and int(row["bad_resource"]) == 0, row
    assert int(row["stable_versions"]) == 1 and int(row["http_rows"]) > 0, row
    assert int(row["bad_timestamp_time"]) == 0, row


def test_fixture_log_bodies_are_token_searchable():
    _logs_fixture()
    # tokenbf_v1 / hasToken split on every non-alphanumeric byte ('_' and '.'
    # included): 'analytics.events_buffer' is the tokens analytics/events/buffer.
    hits = int(ch_value("SELECT count() FROM otel.otel_logs WHERE hasToken(Body, 'analytics')") or 0)
    assert hits > 0
    tokens = ch_rows(
        "SELECT countIf(Body LIKE 'cache miss key=user:%') AS cache_miss, "
        "countIf(match(Body, '^inserted [0-9]+ rows into analytics.events_buffer in [0-9]+ ms$')) AS inserted, "
        "countIf(match(Body, '^(GET|POST) /[^ ]+ [0-9]{3} in [0-9]+ ms$')) AS http "
        "FROM otel.otel_logs")[0]
    assert all(int(v) > 0 for v in tokens.values()), tokens


# ---------------------------------------------------------------------------
# Fixture data: metrics derived from spans.

def _metrics_fixture() -> dict:
    meta = require_metrics_enabled()
    if (meta["database"], meta["table_prefix"]) != ("otel", "otel_metrics") or \
            not all(meta["kinds"][k].get("rows") for k in METRIC_KINDS):
        pytest.skip("OTEL metrics fixture is empty")
    return meta


def test_fixture_histogram_buckets_sum_to_counts_with_both_temporalities():
    _metrics_fixture()
    row = ch_rows(
        "SELECT count() AS n, "
        "countIf(arraySum(BucketCounts) != Count) AS bad_sum, "
        "countIf(length(BucketCounts) != length(ExplicitBounds) + 1) AS bad_len, "
        "countIf(Min > Max OR Sum < Min * Count - 1e-6) AS bad_minmax, "
        "uniqExact(ExplicitBounds) AS bounds_variants, "
        "groupUniqArray(AggregationTemporality) AS temporalities, "
        "countIf(length(`Exemplars.TraceId`) != 1) AS no_exemplar, "
        "countIf(AggregationTemporality = 1 AND abs(`Exemplars.Value`[1] - Max) > 1e-9) AS exemplar_not_max, "
        "any(MetricUnit) AS unit "
        "FROM otel.otel_metrics_histogram WHERE MetricName = 'http.server.request.duration'")[0]
    assert int(row["n"]) > 0, row
    assert int(row["bad_sum"]) == 0 and int(row["bad_len"]) == 0 and int(row["bad_minmax"]) == 0, row
    assert int(row["bounds_variants"]) == 1 and row["unit"] == "s", row
    assert sorted(row["temporalities"]) == [1, 2], row
    assert int(row["no_exemplar"]) == 0 and int(row["exemplar_not_max"]) == 0, row
    # Cumulative series never decrease.
    decreasing = ch_value(
        "SELECT countIf(Count < prev) FROM (SELECT Count, lagInFrame(Count, 1, 0) OVER "
        "(PARTITION BY ServiceName, toString(Attributes) ORDER BY TimeUnix ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS prev "
        "FROM otel.otel_metrics_histogram WHERE AggregationTemporality = 2)")
    assert int(decreasing) == 0


def test_fixture_delta_histogram_counts_match_the_spans():
    _metrics_fixture()
    point = ch_rows(
        "SELECT ServiceName, Attributes['span.name'] AS span_name, "
        "toUnixTimestamp64Nano(StartTimeUnix) AS lo, toUnixTimestamp64Nano(TimeUnix) AS hi, Count "
        "FROM otel.otel_metrics_histogram WHERE AggregationTemporality = 1 "
        "ORDER BY TimeUnix DESC LIMIT 1 OFFSET 100")[0]
    spans = ch_value(
        "SELECT count() FROM otel.otel_traces "
        f"WHERE Timestamp >= fromUnixTimestamp64Nano(toInt64({point['lo']})) "
        f"AND Timestamp < fromUnixTimestamp64Nano(toInt64({point['hi']})) "
        f"AND ServiceName = '{point['ServiceName']}' AND SpanName = '{point['span_name']}'")
    assert int(spans) == int(point["Count"]), point


def test_fixture_exemplars_point_at_stored_spans():
    _metrics_fixture()
    sample = ch_rows(
        "SELECT `Exemplars.TraceId`[1] AS trace_id, `Exemplars.SpanId`[1] AS span_id, "
        "toUnixTimestamp64Nano(`Exemplars.TimeUnix`[1]) AS ts, `Exemplars.Value`[1] AS value "
        "FROM otel.otel_metrics_histogram ORDER BY cityHash64(TimeUnix, ServiceName) LIMIT 100")
    sample += ch_rows(
        "SELECT `Exemplars.TraceId`[1] AS trace_id, `Exemplars.SpanId`[1] AS span_id, "
        "toUnixTimestamp64Nano(`Exemplars.TimeUnix`[1]) AS ts, `Exemplars.Value`[1] AS value "
        "FROM otel.otel_metrics_exponential_histogram ORDER BY cityHash64(TimeUnix, ServiceName) LIMIT 20")
    lo = min(int(r["ts"]) for r in sample)
    hi = max(int(r["ts"]) for r in sample)
    spans = ch_rows(
        "SELECT TraceId, SpanId, toUnixTimestamp64Nano(Timestamp) AS ts, Duration FROM otel.otel_traces "
        f"WHERE Timestamp >= fromUnixTimestamp64Nano(toInt64({lo})) AND Timestamp <= fromUnixTimestamp64Nano(toInt64({hi})) "
        f"AND TraceId IN {sql_list({r['trace_id'] for r in sample})}")
    # Exemplars carry the span start and duration: match the exact span.
    stored = {(s["TraceId"], s["SpanId"], int(s["ts"])): int(s["Duration"]) for s in spans}
    for row in sample:
        duration = stored.get((row["trace_id"], row["span_id"], int(row["ts"])))
        assert duration is not None, row
        assert abs(duration / 1e9 - float(row["value"])) < 1e-9, (row, duration)


def test_fixture_call_counter_is_cumulative_monotonic_with_one_reset():
    _metrics_fixture()
    row = ch_rows(
        "SELECT countIf(AggregationTemporality != 2 OR NOT IsMonotonic) AS bad_flags, "
        "uniqExact(Attributes['span.kind']) AS kinds, "
        "countIf(NOT startsWith(Attributes['status.code'], 'STATUS_CODE_')) AS bad_status "
        "FROM otel.otel_metrics_sum WHERE MetricName = 'traces.span.metrics.calls'")[0]
    assert int(row["bad_flags"]) == 0 and int(row["kinds"]) >= 2 and int(row["bad_status"]) == 0, row
    decreasing = ch_value(
        "SELECT countIf(Value < prev) FROM (SELECT Value, lagInFrame(Value, 1, 0) OVER "
        "(PARTITION BY ServiceName, toString(Attributes), StartTimeUnix ORDER BY TimeUnix "
        " ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS prev "
        "FROM otel.otel_metrics_sum WHERE MetricName = 'traces.span.metrics.calls')")
    assert int(decreasing) == 0
    resets = ch_rows(
        "SELECT ServiceName, uniqExact(StartTimeUnix) AS starts FROM otel.otel_metrics_sum "
        "WHERE MetricName = 'traces.span.metrics.calls' GROUP BY ServiceName HAVING starts > 1")
    assert len(resets) == 1 and int(resets[0]["starts"]) == 2, resets
    # Across the reset the series value drops back (the restart is visible).
    drop = ch_value(
        "SELECT countIf(Value < prev) FROM (SELECT Value, lagInFrame(Value, 1, 0) OVER "
        "(PARTITION BY toString(Attributes) ORDER BY TimeUnix ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS prev "
        "FROM otel.otel_metrics_sum WHERE MetricName = 'traces.span.metrics.calls' "
        f"AND ServiceName = '{resets[0]['ServiceName']}')")
    assert int(drop) >= 1


def test_fixture_gauges_summaries_and_exponential_histograms():
    _metrics_fixture()
    gauges = ch_rows(
        "SELECT MetricName, count() AS n, min(Value) AS lo, max(Value) AS hi, "
        "countIf(Attributes['host.name'] = '' OR Attributes['host.name'] != ResourceAttributes['host.name']) AS bad_host, "
        "uniqExact(Attributes['host.name']) AS hosts "
        "FROM otel.otel_metrics_gauge GROUP BY MetricName ORDER BY MetricName")
    by_name = {g["MetricName"]: g for g in gauges}
    assert set(by_name) == {"process.cpu.utilization", "queue.depth"}, gauges
    cpu = by_name["process.cpu.utilization"]
    assert 0 < float(cpu["lo"]) < float(cpu["hi"]) < 1, cpu
    assert all(int(g["bad_host"]) == 0 and int(g["hosts"]) >= 3 for g in gauges), gauges
    summary = ch_rows(
        "SELECT count() AS n, countIf(length(`ValueAtQuantiles.Quantile`) != 5) AS bad_len, "
        "countIf(NOT arrayAll((a, b) -> a <= b, arrayPopBack(`ValueAtQuantiles.Value`), arrayPopFront(`ValueAtQuantiles.Value`))) AS unsorted "
        "FROM otel.otel_metrics_summary")[0]
    assert int(summary["n"]) > 0 and int(summary["bad_len"]) == 0 and int(summary["unsorted"]) == 0, summary
    exp = ch_rows(
        "SELECT count() AS n, countIf(arraySum(PositiveBucketCounts) + ZeroCount != Count) AS bad_sum, "
        "countIf(Scale != 3) AS bad_scale, countIf(length(`Exemplars.TraceId`) != 1) AS no_exemplar "
        "FROM otel.otel_metrics_exponential_histogram")[0]
    assert int(exp["n"]) > 0 and int(exp["bad_sum"]) == 0 and int(exp["bad_scale"]) == 0 and int(exp["no_exemplar"]) == 0, exp
