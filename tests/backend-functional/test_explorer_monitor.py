"""Explorer Monitoring endpoints (/api/explorer/monitor/...), docs/explorer.md "Monitoring".

The Overview is a set of fixed, allowlisted, bounded system-table reads: the
request names the host only. Every SELECT runs read-only with a time budget,
a read cap and the 'chdash-monitoring' log_comment. Replicated tables count
only when the runner can SHOW them.

Instances:
- API_BASE_URL: the default compose instance (Monitoring on, the default).
- MONITORING_DISABLED_BASE_URL (optional): an instance started with
  tests/config/explorer-monitoring-disabled.hcl; its tests are skipped when
  it is not set.
"""
from __future__ import annotations

import json
import os
import time

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
DISABLED_URL = os.environ.get("MONITORING_DISABLED_BASE_URL", "").rstrip("/")
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))

OVERVIEW = "/api/explorer/monitor/overview"
# The allowlists of src/explorer_monitor.cpp.
ASYNC_METRICS = {
    "Uptime", "OSMemoryTotal", "CGroupMemoryTotal", "MemoryResident", "LoadAverage1", "LoadAverage15",
    "OSUserTimeNormalized", "OSSystemTimeNormalized", "TotalPartsOfMergeTreeTables", "MaxPartCountForPartition",
    "TotalBytesOfMergeTreeTables", "ReplicasMaxAbsoluteDelay", "ReplicasSumQueueSize",
    "KeeperIsLeader", "KeeperIsFollower", "KeeperIsObserver", "KeeperIsStandalone", "KeeperZnodeCount",
    "KeeperAvgLatency", "KeeperMaxLatency", "KeeperFollowers", "KeeperSyncedFollowers",
}
METRICS = {
    "Query", "Merge", "PartMutation", "TCPConnection", "HTTPConnection", "MySQLConnection", "PostgreSQLConnection",
    "InterserverConnection", "ReadonlyReplica", "DelayedInserts", "ZooKeeperSession",
    "BackgroundMergesAndMutationsPoolTask", "BackgroundMergesAndMutationsPoolSize",
}
LOGS = {"query_log", "metric_log", "asynchronous_metric_log", "part_log", "zookeeper_connection"}
REASONS = {"disabled", "not_granted", "unsupported", "window_too_large", "readonly_account", "failed"}

needs_disabled = pytest.mark.skipif(not DISABLED_URL, reason="MONITORING_DISABLED_BASE_URL is not set")


def api(path: str, base: str = BASE_URL, **params) -> requests.Response:
    return requests.get(f"{base}{path}", params=params, timeout=60)


def ok(path: str, **params) -> dict:
    response = api(path, **params)
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers.get("Cache-Control", ""), response.headers
    return response.json()


def ch(sql: str) -> str:
    response = requests.post(CH_URL + "/", data=sql.encode(), auth=CH_AUTH, timeout=120)
    assert response.status_code == 200, (sql, response.text)
    return response.text


def ch_rows(sql: str) -> list[dict]:
    return [json.loads(line) for line in ch(sql + " FORMAT JSONEachRow").splitlines() if line.strip()]


def overview(refresh: bool = True) -> dict:
    return ok(OVERVIEW, host_id="local", **({"refresh": "1"} if refresh else {}))


def test_overview_validates_the_host_and_is_advertised_as_a_feature():
    missing = api(OVERVIEW)
    assert missing.status_code == 400, missing.text
    assert missing.json().get("error_code") == "missing_host_id", missing.text
    unknown = api(OVERVIEW, host_id="does-not-exist")
    assert unknown.status_code == 404, unknown.text
    assert unknown.json().get("error_code") == "unknown_host", unknown.text
    features = api("/api/version").json().get("features", {}).get("explorer", {})
    assert features.get("monitoring") == {
        "enabled": True, "top_queries": True, "cluster_fanout": False, "default_lookback_minutes": 60,
        "max_lookback_days": 30, "query_log_max_lookback_hours": 168, "disk_growth_days": 7,
    }, features
    # The page routes of the view and its sections, and the former address.
    for path in ["/explorer/_monitoring", "/explorer/_monitoring/activity", "/explorer/_operations"]:
        assert api(path).status_code == 200, path


def test_overview_shape_server_tiles_and_detected_logs():
    payload = overview()
    assert payload.get("version") == 1, payload
    assert payload.get("host_id") == "local", payload
    assert payload.get("scope") == "server", payload
    assert payload.get("unavailable_panels") == [], payload
    server = payload["server"]
    assert server["hostname"] and server["version"] and server["timezone"], server
    assert server["uptime_seconds"] > 0, server
    metrics = payload["metrics"]
    # Allowlisted names only, every value a finite number.
    assert set(metrics) <= ASYNC_METRICS | METRICS, set(metrics) - (ASYNC_METRICS | METRICS)
    for name in ["Uptime", "MemoryResident", "OSMemoryTotal", "TotalPartsOfMergeTreeTables", "Query", "TCPConnection"]:
        assert isinstance(metrics.get(name), (int, float)), (name, metrics)
    # system.metrics counts the running queries, the one reading it included.
    assert metrics["Query"] >= 1, metrics
    # The optional system logs this server writes (the later sections read them).
    assert set(payload["logs"]) == LOGS, payload["logs"]
    assert payload["logs"]["query_log"] is True, payload["logs"]


def test_topology_lists_the_two_replica_cluster_without_fan_out():
    payload = overview()
    topology = payload["topology"]
    assert topology["truncated"] is False and topology["row_limit"] == 1000, topology
    nodes = [node for node in topology["nodes"] if node["cluster"] == "chdash_cluster"]
    assert len(nodes) == 2, topology
    assert sorted(node["replica_num"] for node in nodes) == [1, 2], nodes
    assert {node["shard_num"] for node in nodes} == {1}, nodes
    assert sum(1 for node in nodes if node["is_local"]) == 1, nodes
    for node in nodes:
        assert node["host_name"] and node["port"] > 0, node
        for key in ["errors_count", "slowdowns_count", "estimated_recovery_time"]:
            assert node[key] is None or node[key] >= 0, (key, node)
    # The ClickHouse ground truth, read with the test account.
    expected = ch_rows("SELECT host_name, replica_num FROM system.clusters WHERE cluster = 'chdash_cluster' ORDER BY replica_num")
    assert [node["host_name"] for node in nodes] == [row["host_name"] for row in expected], (nodes, expected)


def test_keeper_is_configured_and_embedded():
    payload = overview()
    metrics = payload["metrics"]
    assert metrics.get("ZooKeeperSession", 0) >= 1, metrics
    # The test server embeds ClickHouse Keeper: its role metrics are there.
    assert any(metrics.get(name, 0) > 0 for name in ["KeeperIsLeader", "KeeperIsFollower", "KeeperIsStandalone", "KeeperIsObserver"]), metrics
    keeper = ok("/api/explorer/ops/keeper", host_id="local")
    assert keeper.get("configured") is True, keeper


def test_replication_summary_counts_the_replicated_fixture():
    replication = overview()["replication"]
    assert replication is not None
    # chdash_repl.replicated_events and replicated_daily, at least.
    assert replication["tables"] >= 2, replication
    assert replication["readonly"] == 0 and replication["session_expired"] == 0, replication
    for key in ["max_delay_seconds", "queue_size", "inserts_in_queue", "merges_in_queue", "future_parts_over",
                "parts_to_check_over", "queue_over", "inserts_over"]:
        assert isinstance(replication[key], int) and replication[key] >= 0, (key, replication)
    assert replication["truncated"] is False, replication


def _replicated_tables() -> int:
    return overview()["replication"]["tables"]


def test_replication_summary_ignores_tables_the_runner_cannot_see():
    hidden_db = "chdash_monitor_hidden"
    try:
        ch(f"DROP DATABASE IF EXISTS {hidden_db} SYNC")
        ch(f"CREATE DATABASE {hidden_db}")
        ch(
            f"CREATE TABLE {hidden_db}.events (id UInt64) "
            f"ENGINE = ReplicatedMergeTree('/clickhouse/tables/{{shard}}/{hidden_db}/events', '{{replica}}') ORDER BY id"
        )
        visible = _replicated_tables()
        ch(f"REVOKE ALL ON {hidden_db}.* FROM chdash_runner")
        assert _replicated_tables() == visible - 1
        payload = json.dumps(overview())
        assert hidden_db not in payload
    finally:
        ch(f"DROP DATABASE IF EXISTS {hidden_db} SYNC")
        # Undo the partial revoke: the runner grants of 01-chdash-users.sql.
        ch(f"GRANT SHOW, SELECT, INSERT, ALTER, CREATE, DROP, TRUNCATE, OPTIMIZE ON {hidden_db}.* TO chdash_runner")
        overview()


def test_every_monitoring_read_is_read_only_bounded_and_tagged():
    since = int(time.time()) - 5
    overview()
    ch("SYSTEM FLUSH LOGS")
    rows = ch_rows(
        "SELECT query, Settings['readonly'] AS readonly, Settings['max_execution_time'] AS budget, "
        "Settings['timeout_overflow_mode'] AS on_timeout, Settings['max_rows_to_read'] AS read_cap, "
        "Settings['read_overflow_mode'] AS on_read_cap, Settings['result_overflow_mode'] AS on_result_cap "
        "FROM system.query_log "
        f"WHERE event_date >= toDate({since}) - 1 AND event_time >= toDateTime({since}) AND type = 'QueryFinish' "
        "AND log_comment = 'chdash-monitoring' AND user = 'chdash_system'"
    )
    queries = " ".join(row["query"] for row in rows)
    for table in ["system.asynchronous_metrics", "system.metrics", "system.clusters", "system.replicas"]:
        assert f"FROM {table}" in queries, (table, queries[:2000])
    for row in rows:
        assert row["readonly"] == "2", row
        assert int(row["budget"]) > 0 and int(row["read_cap"]) > 0, row
        assert row["on_timeout"] == "throw" and row["on_read_cap"] == "throw" and row["on_result_cap"] == "throw", row


def test_refresh_bypasses_the_short_cache():
    first = overview(refresh=True)
    # Within the live TTL (min(explorer.cache_ttl_ms, 5 s)) every viewer shares one read.
    assert overview(refresh=False)["generated_at_ms"] == first["generated_at_ms"]
    time.sleep(0.01)
    assert overview(refresh=True)["generated_at_ms"] > first["generated_at_ms"]


@needs_disabled
def test_monitoring_off_removes_the_routes_and_the_feature():
    response = api(OVERVIEW, base=DISABLED_URL, host_id="local")
    assert response.status_code == 404, response.text
    features = api("/api/version", base=DISABLED_URL).json()["features"]["explorer"]
    assert features["monitoring"]["enabled"] is False, features
    assert features["monitoring"]["top_queries"] is False and features["monitoring"]["cluster_fanout"] is False, features
    # Activity's endpoints keep their own switch (explorer.operations).
    assert features["operations"]["enabled"] is True, features
    assert api("/api/explorer/ops/activity", base=DISABLED_URL, host_id="local").status_code == 200
    assert api(SERIES, base=DISABLED_URL, host_id="local").status_code == 404


# ---------------------------------------------------------------------------
# Performance: /api/explorer/monitor/series

SERIES = "/api/explorer/monitor/series"
METRIC_LOG_SERIES = {
    "qps", "select_qps", "insert_qps", "failed_qps", "avg_query_ms", "cpu_cores", "io_wait_cores", "memory_tracked",
    "memory_tracked_max", "memory_merges", "queries_running", "merges_running", "mutations_running", "merged_rows_s",
    "inserted_rows_s", "inserted_bytes_s", "delayed_inserts_s", "rejected_inserts_s", "selected_rows_s", "selected_bytes_s",
    "pool_merges_task", "pool_merges_size", "pool_fetches_task", "pool_fetches_size", "pool_moves_task",
    "pool_schedule_task", "pool_common_task", "parts_active", "parts_outdated",
}
ASYNC_SERIES = {
    "os_user_cores", "os_system_cores", "os_iowait_cores", "os_user_ratio", "load_1m", "memory_resident",
    "os_memory_available", "parts_total", "parts_max_partition", "replicas_max_delay", "replicas_queue",
}
QUERY_LOG_SERIES = {"finished_qps", "error_qps", "p50_ms", "p95_ms", "p99_ms"}
HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS


def series(**params) -> dict:
    return ok(SERIES, host_id="local", **params)


def data_window(seconds: int = 600) -> tuple[int, int]:
    """The last `seconds` of the metric_log data actually present: a fresh CI
    stack holds minutes of it, the long-lived local stack days."""
    ch("SYSTEM FLUSH LOGS")
    row = ch_rows("SELECT toUInt64(toUnixTimestamp(min(event_time))) AS lo, toUInt64(toUnixTimestamp(max(event_time))) AS hi FROM system.metric_log")[0]
    lo, hi = int(row["lo"]), int(row["hi"])
    assert hi > 0, row
    start = max(lo, hi - seconds)
    return start * 1000, (hi + 1) * 1000


def non_null(values: list) -> list:
    return [value for value in values if value is not None]


@pytest.mark.parametrize("params,status,code", [
    ({}, 400, "missing_host_id"),
    ({"host_id": "does-not-exist"}, 404, "unknown_host"),
    ({"host_id": "local", "from_ms": "2000", "to_ms": "1000"}, 400, "invalid_range"),
    ({"host_id": "local", "from_ms": "1000", "to_ms": "1000"}, 400, "invalid_range"),
    ({"host_id": "local", "from_ms": "-5", "to_ms": "1000"}, 400, "invalid_range"),
    ({"host_id": "local", "from_ms": "1e3", "to_ms": "5000"}, 400, "invalid_range"),
    ({"host_id": "local", "from_ms": "0 OR 1=1", "to_ms": "5000"}, 400, "invalid_range"),
    ({"host_id": "local", "panel": "performance' OR 1=1 --"}, 400, "invalid_panel"),
    ({"host_id": "local", "panel": "disk_growth"}, 400, "invalid_panel"),
    ({"host_id": "local", "scope": "cluster"}, 400, "cluster_fanout_disabled"),
    ({"host_id": "local", "scope": "everything"}, 400, "invalid_scope"),
    ({"host_id": "local", "sort": "total_time"}, 400, "unknown_parameter"),
    ({"host_id": "local", "metric": "ProfileEvent_Query"}, 400, "unknown_parameter"),
    ({"host_id": "local", "sql": "SELECT 1"}, 400, "unknown_parameter"),
    ({"host_id": "local", "step": "1"}, 400, "unknown_parameter"),
])
def test_series_validates_every_parameter_and_lets_none_reach_sql(params, status, code):
    response = api(SERIES, **params)
    assert response.status_code == status, (params, response.text)
    assert response.json().get("error_code") == code, (params, response.text)


def test_series_range_is_capped_by_max_lookback_days():
    now = int(time.time() * 1000)
    too_wide = api(SERIES, host_id="local", from_ms=now - 30 * DAY_MS - 60_000, to_ms=now)
    assert too_wide.status_code == 400, too_wide.text
    assert too_wide.json()["error_code"] == "range_too_large", too_wide.text
    assert "30 days" in too_wide.json().get("message", too_wide.text), too_wide.text
    # Exactly the cap is allowed.
    payload = series(from_ms=now - 30 * DAY_MS, to_ms=now)
    assert payload["step_seconds"] == 10800, payload["step_seconds"]


@pytest.mark.parametrize("span_ms,step", [
    (10 * 60_000, 10), (HOUR_MS, 30), (6 * HOUR_MS, 300), (DAY_MS, 300), (7 * DAY_MS, 3600), (30 * DAY_MS, 10800),
])
def test_series_step_table_and_aligned_buckets(span_ms, step):
    now = int(time.time() * 1000)
    payload = series(from_ms=now - span_ms, to_ms=now)
    assert payload["step_seconds"] == step, (span_ms, payload["step_seconds"])
    stamps = payload["timestamps"]
    # At most 300 buckets (plus the two partial ends of the alignment).
    assert 0 < len(stamps) <= 302, len(stamps)
    assert all(stamp % (step * 1000) == 0 for stamp in stamps), stamps[:3]
    assert stamps == sorted(stamps) and all(b - a == step * 1000 for a, b in zip(stamps, stamps[1:]))
    assert payload["from_ms"] == stamps[0] and payload["to_ms"] == stamps[-1] + step * 1000
    assert payload["from_ms"] <= now - span_ms and payload["to_ms"] >= now
    # Every series has one value (or null) per bucket.
    for name, values in payload["series"].items():
        assert len(values) == len(stamps), name


def test_series_shape_sources_and_default_window():
    payload = series()
    assert payload["version"] == 1 and payload["host_id"] == "local", payload.keys()
    assert payload["panel"] == "performance" and payload["scope"] == "server"
    requested = payload["requested"]
    # The default window: explorer.monitoring.default_lookback_minutes (60).
    assert abs(requested["to_ms"] - requested["from_ms"] - HOUR_MS) < 5_000, requested
    assert payload["step_seconds"] == 30
    assert payload["limits"] == {"max_lookback_days": 30, "query_log_max_lookback_hours": 168, "max_points": 300}
    assert set(payload["sources"]) == {"metric_log", "asynchronous_metric_log", "query_log"}
    for name, source in payload["sources"].items():
        assert source["status"] == "ok", (name, source)
        assert source["table"] == name and source["rows_read"] >= 0 and source["elapsed_ms"] >= 0, source
    assert payload["sources"]["metric_log"]["missing"] == []
    assert set(payload["series"]) == METRIC_LOG_SERIES | ASYNC_SERIES | QUERY_LOG_SERIES, set(payload["series"]) ^ (METRIC_LOG_SERIES | ASYNC_SERIES | QUERY_LOG_SERIES)
    assert payload["unavailable_panels"] == []
    # chdash_repl holds replicated tables: the Replication chart applies.
    assert payload["replicated_tables"] is True


def test_series_has_qps_and_cpu_over_the_data_present():
    start, end = data_window(600)
    payload = series(from_ms=start, to_ms=end, refresh="1")
    assert payload["sources"]["metric_log"]["status"] == "ok", payload["sources"]
    qps = non_null(payload["series"]["qps"])
    cpu = non_null(payload["series"]["cpu_cores"])
    assert qps and any(value > 0 for value in qps), payload["series"]["qps"]
    assert cpu and all(value >= 0 for value in cpu), payload["series"]["cpu_cores"]
    assert non_null(payload["series"]["memory_tracked"]), payload["series"]["memory_tracked"]
    # asynchronous_metric_log samples every second as well.
    assert non_null(payload["series"]["os_user_cores"]), payload["series"]["os_user_cores"]
    assert payload["sources"]["metric_log"]["rows_read"] > 0


def test_series_latency_appears_after_a_tagged_workload():
    for _ in range(10):
        ch("SELECT sum(number) FROM numbers(200000) SETTINGS log_comment = 'chdash-test-perf' FORMAT Null")
    ch("SYSTEM FLUSH LOGS")
    now = int(time.time() * 1000)
    payload = series(from_ms=now - 10 * 60_000, to_ms=now, refresh="1")
    assert payload["sources"]["query_log"]["status"] == "ok", payload["sources"]
    p95 = non_null(payload["series"]["p95_ms"])
    finished = non_null(payload["series"]["finished_qps"])
    assert p95 and all(value >= 0 for value in p95), payload["series"]["p95_ms"]
    assert finished and any(value > 0 for value in finished), payload["series"]["finished_qps"]
    for p50, p99 in zip(payload["series"]["p50_ms"], payload["series"]["p99_ms"]):
        if p50 is not None and p99 is not None:
            assert p50 <= p99 + 1e-6, (p50, p99)


def test_series_skips_query_log_past_its_lookback():
    now = int(time.time() * 1000)
    # query_log_max_lookback_hours = 168: 7 days still read it, 8 do not.
    within = series(from_ms=now - 7 * DAY_MS, to_ms=now)
    assert within["sources"]["query_log"]["status"] == "ok", within["sources"]
    wider = series(from_ms=now - 8 * DAY_MS, to_ms=now)
    assert wider["sources"]["query_log"]["status"] == "out_of_range", wider["sources"]
    assert wider["sources"]["query_log"]["rows_read"] == 0
    assert not set(wider["series"]) & QUERY_LOG_SERIES, set(wider["series"])
    # Not a failure: no unavailable panel; the average latency stays.
    assert wider["unavailable_panels"] == []
    assert "avg_query_ms" in wider["series"]


def test_series_cache_is_per_aligned_window_and_refresh_bypasses_it():
    start, end = data_window(600)
    first = series(from_ms=start, to_ms=end, refresh="1")
    # The same aligned window (the step is 10 s here): one read for 15 s.
    again = series(from_ms=start + 1, to_ms=end - 1 if end - 1 > start + 1 else end)
    if again["from_ms"] == first["from_ms"] and again["to_ms"] == first["to_ms"]:
        assert again["generated_at_ms"] == first["generated_at_ms"]
    time.sleep(0.01)
    assert series(from_ms=start, to_ms=end, refresh="1")["generated_at_ms"] > first["generated_at_ms"]


def test_every_series_read_is_read_only_bounded_and_tagged():
    since = int(time.time()) - 5
    now = int(time.time() * 1000)
    series(from_ms=now - HOUR_MS, to_ms=now, refresh="1")
    ch("SYSTEM FLUSH LOGS")
    rows = ch_rows(
        "SELECT query, Settings['readonly'] AS readonly, Settings['max_execution_time'] AS budget, "
        "Settings['timeout_overflow_mode'] AS on_timeout, Settings['max_rows_to_read'] AS read_cap, "
        "Settings['read_overflow_mode'] AS on_read_cap, Settings['max_result_rows'] AS result_cap, "
        "Settings['result_overflow_mode'] AS on_result_cap "
        "FROM system.query_log "
        f"WHERE event_date >= toDate({since}) - 1 AND event_time >= toDateTime({since}) AND type = 'QueryFinish' "
        "AND log_comment = 'chdash-monitoring' AND user = 'chdash_system' "
        "AND (query LIKE '%FROM system.metric_log%' OR query LIKE '%FROM system.asynchronous_metric_log%' OR query LIKE '%FROM system.query_log%')"
    )
    tables = {table for row in rows for table in ["metric_log", "asynchronous_metric_log", "query_log"] if f"FROM system.{table} " in row["query"]}
    assert tables == {"metric_log", "asynchronous_metric_log", "query_log"}, [row["query"][:200] for row in rows]
    for row in rows:
        assert row["readonly"] == "2", row
        assert int(row["budget"]) == 10 and int(row["read_cap"]) > 0 and int(row["result_cap"]) > 0, row
        assert row["on_timeout"] == "throw" and row["on_read_cap"] == "throw" and row["on_result_cap"] == "throw", row
