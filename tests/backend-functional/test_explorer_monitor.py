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
- MONITORING_LIMITS_BASE_URL (optional): an instance started with
  tests/config/explorer-monitoring-limits.hcl (query_log_max_rows = 1000 on
  host "local", host "nolog" on a runner without SELECT on system.query_log);
  its tests are skipped when it is not set.
"""
from __future__ import annotations

import json
import os
import time

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
DISABLED_URL = os.environ.get("MONITORING_DISABLED_BASE_URL", "").rstrip("/")
LIMITS_URL = os.environ.get("MONITORING_LIMITS_BASE_URL", "").rstrip("/")
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
needs_limits = pytest.mark.skipif(not LIMITS_URL, reason="MONITORING_LIMITS_BASE_URL is not set")


def api(path: str, base: str = BASE_URL, **params) -> requests.Response:
    return requests.get(f"{base}{path}", params=params, timeout=60)


def ok(path: str, **params) -> dict:
    response = api(path, **params)
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers.get("Cache-Control", ""), response.headers
    return response.json()


def ch(sql: str, auth: tuple[str, str] = CH_AUTH) -> str:
    response = requests.post(CH_URL + "/", data=sql.encode(), auth=auth, timeout=120)
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
    assert api("/api/explorer/monitor/queries", base=DISABLED_URL, host_id="local").status_code == 404
    assert api("/api/explorer/monitor/queries/1", base=DISABLED_URL, host_id="local").status_code == 404
    assert api("/api/explorer/monitor/disks", base=DISABLED_URL, host_id="local").status_code == 404


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
    ({"host_id": "local", "panel": "disks"}, 400, "invalid_panel"),
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


# ---------------------------------------------------------------------------
# Queries: /api/explorer/monitor/queries and /api/explorer/monitor/queries/<hash>

QUERIES = "/api/explorer/monitor/queries"
RUNNER_AUTH = ("chdash_runner", "runner_test")
SYSTEM_AUTH = ("chdash_system", "system_test")
TOPQ_TAG = "chdash-test-topq"
TOPQ_SQL = f"SELECT sum(number) FROM numbers(100000) SETTINGS log_comment = '{TOPQ_TAG}'"
SORT_FIELDS = {
    "total_time": "total_ms", "calls": "calls", "p95": "p95_ms", "max_memory": "max_memory",
    "read_bytes": "read_bytes", "errors": "errors",
}
QUERY_LOG_ROWS = "type IN ('QueryFinish', 'ExceptionWhileProcessing', 'ExceptionBeforeStart') AND is_initial_query"


def queries(base: str = BASE_URL, **params) -> dict:
    response = api(QUERIES, base=base, host_id=params.pop("host_id", "local"), **params)
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers.get("Cache-Control", ""), response.headers
    return response.json()


def shape(hash_: str, base: str = BASE_URL, **params) -> dict:
    response = api(f"{QUERIES}/{hash_}", base=base, host_id=params.pop("host_id", "local"), **params)
    assert response.status_code == 200, response.text
    return response.json()


def sql_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def tagged_window(tag: str) -> tuple[int, int]:
    """The window of the rows `tag` left in query_log (logs flushed), a minute
    wider on each side and never past now: the data present decides, on a
    fresh stack as on a long-lived one."""
    ch("SYSTEM FLUSH LOGS")
    row = ch_rows(
        "SELECT toUInt64(toUnixTimestamp(min(event_time))) AS lo, toUInt64(toUnixTimestamp(max(event_time))) AS hi "
        f"FROM system.query_log WHERE event_date >= today() - 1 AND event_time >= now() - INTERVAL 1 HOUR "
        f"AND log_comment = '{tag}' AND {QUERY_LOG_ROWS}"
    )[0]
    lo, hi = int(row["lo"]), int(row["hi"])
    assert hi > 0, (tag, row)
    now = int(time.time() * 1000)
    return (lo - 60) * 1000, min(now, (hi + 61) * 1000)


@pytest.fixture(scope="module")
def topq() -> dict:
    """The tagged workload: 30 runs of one shape through the runner account,
    then the logs flushed. Returns its hash and the window it ran in."""
    for _ in range(30):
        ch(TOPQ_SQL, auth=RUNNER_AUTH)
    start, end = tagged_window(TOPQ_TAG)
    hashes = {row["h"] for row in ch_rows(
        "SELECT DISTINCT toString(normalized_query_hash) AS h FROM system.query_log "
        f"WHERE event_date >= today() - 1 AND event_time >= now() - INTERVAL 1 HOUR AND log_comment = '{TOPQ_TAG}' AND {QUERY_LOG_ROWS}"
    )}
    assert len(hashes) == 1, hashes
    return {"hash": hashes.pop(), "from_ms": start, "to_ms": end}


@pytest.mark.parametrize("params,status,code", [
    ({}, 400, "missing_host_id"),
    ({"host_id": "does-not-exist"}, 404, "unknown_host"),
    ({"host_id": "local", "sort": "duration"}, 400, "invalid_sort"),
    ({"host_id": "local", "sort": "total_ms DESC; DROP TABLE x"}, 400, "invalid_sort"),
    ({"host_id": "local", "kind": "select"}, 400, "invalid_kind"),
    ({"host_id": "local", "kind": "Select' OR 1=1 --"}, 400, "invalid_kind"),
    ({"host_id": "local", "hide_chdash": "yes"}, 400, "invalid_hide_chdash"),
    ({"host_id": "local", "from_ms": "2000", "to_ms": "1000"}, 400, "invalid_range"),
    ({"host_id": "local", "from_ms": "1e3"}, 400, "invalid_range"),
    ({"host_id": "local", "sql": "SELECT 1"}, 400, "unknown_parameter"),
    ({"host_id": "local", "limit": "1000"}, 400, "unknown_parameter"),
    ({"host_id": "local", "order": "duration"}, 400, "unknown_parameter"),
    ({"host_id": "local", "user": "default"}, 400, "unknown_parameter"),
])
def test_queries_validates_every_parameter_and_lets_none_reach_sql(params, status, code):
    response = api(QUERIES, **params)
    assert response.status_code == status, (params, response.text)
    assert response.json().get("error_code") == code, (params, response.text)


@pytest.mark.parametrize("hash_,params,code", [
    ("abc", {}, "invalid_hash"),
    ("-1", {}, "invalid_hash"),
    ("18446744073709551616", {}, "invalid_hash"),
    ("1%20OR%201%3D1", {}, "invalid_hash"),
    ("12345", {"order": "query_duration_ms"}, "invalid_order"),
    ("12345", {"sort": "calls"}, "unknown_parameter"),
    ("12345", {"hide_chdash": "2"}, "invalid_hide_chdash"),
])
def test_a_shape_validates_its_hash_and_parameters(hash_, params, code):
    response = requests.get(f"{BASE_URL}{QUERIES}/{hash_}", params={"host_id": "local", **params}, timeout=60)
    assert response.status_code == 400, (hash_, params, response.text)
    assert response.json().get("error_code") == code, (hash_, params, response.text)
    assert api(f"{QUERIES}/18446744073709551615", host_id="does-not-exist").status_code == 404


def test_queries_window_is_capped_by_the_query_log_lookback():
    now = int(time.time() * 1000)
    wide = api(QUERIES, host_id="local", from_ms=now - 7 * DAY_MS - 120_000, to_ms=now)
    assert wide.status_code == 400 and wide.json()["error_code"] == "range_too_large", wide.text
    assert "168 hours" in wide.json()["message"], wide.text
    drill = api(f"{QUERIES}/1", host_id="local", from_ms=now - 8 * DAY_MS, to_ms=now)
    assert drill.status_code == 400 and drill.json()["error_code"] == "range_too_large", drill.text
    # The default window: an hour, minute-aligned.
    payload = queries()
    assert abs(payload["requested"]["to_ms"] - payload["requested"]["from_ms"] - HOUR_MS) < 5_000, payload["requested"]
    assert payload["from_ms"] % 60_000 == 0 and payload["to_ms"] % 60_000 == 0, payload
    assert payload["limits"] == {"query_log_max_lookback_hours": 168, "query_log_max_rows": 50_000_000, "row_limit": 50}


def test_top_queries_list_the_tagged_workload_with_its_text(topq):
    payload = queries(from_ms=topq["from_ms"], to_ms=topq["to_ms"], sort="calls", refresh="1")
    assert payload["status"] == "ok" and payload["unavailable_panels"] == [], payload
    assert payload["sort"] == "calls" and payload["kind"] == "all" and payload["hide_chdash"] is True
    rows = payload["queries"]
    assert 0 < len(rows) <= 50, len(rows)
    row = next((item for item in rows if item["hash"] == topq["hash"]), None)
    assert row is not None, [item["hash"] for item in rows]
    assert row["calls"] >= 30, row
    assert row["kind"] == "Select" and "chdash_runner" in row["users"], row
    assert row["errors"] == 0 and row["avg_ms"] <= row["max_ms"] + 1e-6, row
    assert row["read_rows"] >= 30 * 100_000, row
    assert row["first_seen_ms"] <= row["last_seen_ms"], row
    # Phase 2: the last run's text, and its normalized form as ClickHouse
    # computes it.
    assert row["has_text"] is True and TOPQ_TAG in row["example"], row
    expected = ch_rows(f"SELECT normalizeQuery({sql_string(row['example'])}) AS n")[0]["n"]
    assert row["normalized"] == expected, (row["normalized"], expected)
    assert row["example_truncated"] is False and row["last_query_id"], row
    # The window's totals cover every shape, the listed ones included.
    totals = payload["totals"]
    assert totals["calls"] >= sum(item["calls"] for item in rows), totals
    assert totals["shapes"] >= len(rows), totals
    assert payload["phases"]["aggregate"]["status"] == "ok" and payload["phases"]["aggregate"]["rows_read"] > 0
    assert payload["phases"]["text"]["status"] == "ok" and payload["phases"]["text"]["rows_read"] > 0


@pytest.mark.parametrize("sort", list(SORT_FIELDS))
def test_every_sort_orders_the_top_shapes(topq, sort):
    payload = queries(from_ms=topq["from_ms"], to_ms=topq["to_ms"], sort=sort)
    values = [item[SORT_FIELDS[sort]] for item in payload["queries"]]
    assert values, payload
    assert all(a >= b - 1e-6 for a, b in zip(values, values[1:])), (sort, values)


def test_kind_filters_the_shapes(topq):
    checks = [("Select", lambda k: k == "Select"), ("Insert", lambda k: k == "Insert"), ("other", lambda k: k not in ("Select", "Insert"))]
    for kind, check in checks:
        payload = queries(from_ms=topq["from_ms"], to_ms=topq["to_ms"], kind=kind)
        assert payload["kind"] == kind and payload["status"] == "ok", payload
        assert all(check(item["kind"]) for item in payload["queries"]), (kind, [item["kind"] for item in payload["queries"]])
    selects = queries(from_ms=topq["from_ms"], to_ms=topq["to_ms"], kind="Select", sort="calls")
    assert any(item["hash"] == topq["hash"] for item in selects["queries"])
    inserts = queries(from_ms=topq["from_ms"], to_ms=topq["to_ms"], kind="Insert", sort="calls")
    assert all(item["hash"] != topq["hash"] for item in inserts["queries"])


def test_a_shape_has_its_timeline_and_at_most_20_runs_sorted(topq):
    payload = shape(topq["hash"], from_ms=topq["from_ms"], to_ms=topq["to_ms"], refresh="1")
    assert payload["status"] == "ok" and payload["hash"] == topq["hash"], payload
    summary = payload["summary"]
    assert summary["calls"] >= 30 and summary["errors"] == 0, summary
    assert summary["cpu_seconds"] >= 0 and summary["p95_ms"] <= summary["max_ms"] + 1e-6, summary
    assert payload["kind"] == "Select" and TOPQ_TAG in payload["example"]["text"], payload["example"]
    assert payload["normalized"] == ch_rows(f"SELECT normalizeQuery({sql_string(payload['example']['text'])}) AS n")[0]["n"]
    # The timeline: aligned buckets, one value (or null) per bucket per series.
    step = payload["step_seconds"] * 1000
    stamps = payload["timestamps"]
    assert stamps and all(t % step == 0 for t in stamps) and all(b - a == step for a, b in zip(stamps, stamps[1:]))
    assert set(payload["series"]) == {"calls", "errors", "p50_ms", "p95_ms", "read_rows", "max_memory", "cpu_seconds"}
    for name, values in payload["series"].items():
        assert len(values) == len(stamps), name
    assert sum(value or 0 for value in payload["series"]["calls"]) == summary["calls"]
    # The slowest runs first, at most 20; then the latest.
    runs = payload["runs"]
    assert 0 < len(runs) <= 20, len(runs)
    durations = [run["duration_ms"] for run in runs]
    assert durations == sorted(durations, reverse=True), durations
    assert all(run["user"] == "chdash_runner" and run["type"] == "QueryFinish" for run in runs), runs[:2]
    latest = shape(topq["hash"], from_ms=topq["from_ms"], to_ms=topq["to_ms"], order="latest")["runs"]
    times = [run["event_time_ms"] for run in latest]
    assert 0 < len(times) <= 20 and times == sorted(times, reverse=True), times
    assert payload["reads"]["timeline"]["rows_read"] > 0


def test_chdash_own_queries_are_hidden(topq):
    # A query of the system account, and the monitoring's own reads (the
    # Queries phases run with the runner account).
    marker = "chdash_test_topq_system"
    ch(f"SELECT 1 AS {marker}", auth=SYSTEM_AUTH)
    queries(refresh="1")
    ch("SYSTEM FLUSH LOGS")
    now = int(time.time() * 1000)
    recent = f"event_date >= today() - 1 AND event_time >= now() - INTERVAL 1 HOUR AND {QUERY_LOG_ROWS}"
    system_hash = ch_rows(
        "SELECT toString(any(normalized_query_hash)) AS h FROM system.query_log "
        f"WHERE {recent} AND user = 'chdash_system' AND query = 'SELECT 1 AS {marker}'"
    )[0]["h"]
    own_hash = ch_rows(
        "SELECT toString(any(normalized_query_hash)) AS h FROM system.query_log "
        f"WHERE {recent} AND user = 'chdash_runner' AND log_comment = 'chdash-monitoring' "
        "AND query LIKE '%GROUP BY normalized_query_hash ORDER BY%'"
    )[0]["h"]
    assert system_hash != "0" and own_hash != "0", (system_hash, own_hash)
    window = {"from_ms": now - HOUR_MS, "to_ms": now}
    # The system account's shape: hidden by default, there with hide_chdash=0.
    assert shape(system_hash, refresh="1", **window)["summary"]["calls"] == 0
    assert shape(system_hash, hide_chdash="0", refresh="1", **window)["summary"]["calls"] >= 1
    # The monitoring's own reads: never.
    for hide in ("1", "0"):
        assert shape(own_hash, hide_chdash=hide, refresh="1", **window)["summary"]["calls"] == 0, hide
        listed = queries(hide_chdash=hide, sort="calls", refresh="1", **window)
        assert all("chdash-monitoring" not in item["example"] for item in listed["queries"]), hide
        assert own_hash not in {item["hash"] for item in listed["queries"]}
    default = queries(sort="calls", **window)
    assert all("chdash_system" not in item["users"] for item in default["queries"]), default["queries"][:3]


def test_queries_cache_per_minute_window_and_refresh_bypasses_it(topq):
    first = queries(from_ms=topq["from_ms"], to_ms=topq["to_ms"], refresh="1")
    # The same minute-aligned window: one read for 60 s.
    again = queries(from_ms=topq["from_ms"] + 1, to_ms=topq["to_ms"] - 1)
    if again["from_ms"] == first["from_ms"] and again["to_ms"] == first["to_ms"]:
        assert again["generated_at_ms"] == first["generated_at_ms"]
    time.sleep(0.01)
    assert queries(from_ms=topq["from_ms"], to_ms=topq["to_ms"], refresh="1")["generated_at_ms"] > first["generated_at_ms"]


def test_every_queries_read_runs_as_the_runner_read_only_bounded_and_tagged(topq):
    since = int(time.time()) - 5
    queries(from_ms=topq["from_ms"], to_ms=topq["to_ms"], refresh="1")
    shape(topq["hash"], from_ms=topq["from_ms"], to_ms=topq["to_ms"], refresh="1")
    ch("SYSTEM FLUSH LOGS")
    rows = ch_rows(
        "SELECT query, user, Settings['readonly'] AS readonly, Settings['max_execution_time'] AS budget, "
        "Settings['timeout_overflow_mode'] AS on_timeout, Settings['max_rows_to_read'] AS read_cap, "
        "Settings['read_overflow_mode'] AS on_read_cap, Settings['result_overflow_mode'] AS on_result_cap "
        "FROM system.query_log "
        f"WHERE event_date >= toDate({since}) - 1 AND event_time >= toDateTime({since}) AND type = 'QueryFinish' "
        "AND log_comment = 'chdash-monitoring' AND query LIKE '%FROM system.query_log%normalized_query_hash%'"
    )
    # Phase 1, phase 2 and the three reads of a shape.
    assert len(rows) >= 5, [row["query"][:120] for row in rows]
    for row in rows:
        assert row["user"] == "chdash_runner", row["user"]
        assert row["readonly"] == "2" and int(row["budget"]) > 0 and int(row["read_cap"]) == 50_000_000, row
        assert row["on_timeout"] == "throw" and row["on_read_cap"] == "throw" and row["on_result_cap"] == "throw", row
        assert "log_comment != 'chdash-monitoring'" in row["query"], row["query"][:300]


def ensure_nolog_runner() -> None:
    """The runner of host "nolog" (01-chdash-users.sql): everything but
    system.query_log. Re-applied for a server created before it existed."""
    for statement in [
        "CREATE USER IF NOT EXISTS chdash_runner_nolog IDENTIFIED WITH plaintext_password BY 'runner_nolog_test'",
        "REVOKE ALL ON *.* FROM chdash_runner_nolog",
        "GRANT SELECT ON *.* TO chdash_runner_nolog",
        "GRANT SHOW DATABASES ON *.* TO chdash_runner_nolog",
        "GRANT SHOW TABLES ON *.* TO chdash_runner_nolog",
        "GRANT SHOW COLUMNS ON *.* TO chdash_runner_nolog",
        "REVOKE SELECT ON system.query_log FROM chdash_runner_nolog",
    ]:
        ch(statement)


@needs_limits
def test_a_runner_without_the_grant_gets_not_granted_with_the_grant():
    ensure_nolog_runner()
    # The host turns healthy once its runner exists (1 s health interval).
    for _ in range(40):
        hosts = requests.get(f"{LIMITS_URL}/api/hosts", timeout=10).json().get("hosts", [])
        if any(item.get("id") == "nolog" and item.get("healthy") for item in hosts):
            break
        time.sleep(0.5)
    payload = queries(base=LIMITS_URL, host_id="nolog", refresh="1")
    assert payload["status"] == "not_granted", payload
    assert payload["hint"] == "GRANT SELECT ON system.query_log TO chdash_runner_nolog", payload
    assert payload["queries"] == [] and payload["unavailable_panels"][0]["reason"] == "not_granted"
    drill = shape("12345", base=LIMITS_URL, host_id="nolog", refresh="1")
    assert drill["status"] == "not_granted" and drill["hint"] == payload["hint"], drill


@needs_limits
def test_a_read_past_query_log_max_rows_says_window_too_large():
    payload = queries(base=LIMITS_URL, refresh="1")
    assert payload["limits"]["query_log_max_rows"] == 1000, payload["limits"]
    assert payload["status"] == "window_too_large", payload
    assert "max_rows_to_read" in payload["message"], payload["message"]
    assert payload["suggested_span_ms"] and payload["suggested_span_ms"] < HOUR_MS, payload
    assert payload["queries"] == [] and payload["unavailable_panels"][0]["reason"] == "window_too_large"


# ---------------------------------------------------------------------------
# Disks: /api/explorer/monitor/disks and /api/explorer/monitor/series?panel=disk_growth

DISKS = "/api/explorer/monitor/disks"
FIXTURE_DISKS = {"default", "fixture_hot", "fixture_warm"}
TREND_STATUSES = {"growing", "not_growing", "not_enough_history", "no_capacity"}


def disks(**params) -> dict:
    return ok(DISKS, host_id="local", **params)


def growth(**params) -> dict:
    return ok(SERIES, host_id="local", panel="disk_growth", **params)


@pytest.mark.parametrize("params,status,code", [
    ({}, 400, "missing_host_id"),
    ({"host_id": "does-not-exist"}, 404, "unknown_host"),
    ({"host_id": "local", "database": "system"}, 400, "unknown_parameter"),
    ({"host_id": "local", "sql": "SELECT 1"}, 400, "unknown_parameter"),
    ({"host_id": "local", "from_ms": "0"}, 400, "unknown_parameter"),
])
def test_disks_validates_every_parameter(params, status, code):
    response = api(DISKS, **params)
    assert response.status_code == status, (params, response.text)
    assert response.json().get("error_code") == code, (params, response.text)


def test_disks_lists_the_fixture_disks_and_the_tiered_policy():
    payload = disks(refresh="1")
    assert payload["version"] == 1 and payload["host_id"] == "local" and payload["scope"] == "server", payload.keys()
    assert payload["unavailable_panels"] == [], payload["unavailable_panels"]
    assert payload["limits"]["disk_growth_days"] == 7 and payload["limits"]["usage_row_limit"] == 1000, payload["limits"]
    assert set(payload["logs"]) == {"asynchronous_metric_log", "part_log"}, payload["logs"]
    by_name = {disk["name"]: disk for disk in payload["disks"]}
    assert FIXTURE_DISKS <= set(by_name), set(by_name)
    # The ClickHouse ground truth, read with the test account.
    truth = {row["name"]: row for row in ch_rows("SELECT name, path, type FROM system.disks")}
    assert set(by_name) == set(truth), (set(by_name), set(truth))
    for name, disk in by_name.items():
        assert disk["path"] == truth[name]["path"] and disk["type"] == truth[name]["type"], (disk, truth[name])
        assert disk["total_space"] >= disk["free_space"] >= 0, disk
        if disk["total_space"]:
            assert disk["used_space"] == disk["total_space"] - disk["free_space"], disk
        for key in ["unreserved_space", "keep_free_space"]:
            assert isinstance(disk[key], int) and disk[key] >= 0, (key, disk)
        for key in ["is_read_only", "is_broken", "is_encrypted", "is_remote"]:
            assert isinstance(disk[key], bool), (key, disk)
        assert disk["is_broken"] is False, disk
    assert {"policy": "fixture_tiered", "volume": "hot"} in by_name["fixture_hot"]["policies"]
    assert {"policy": "fixture_tiered", "volume": "warm"} in by_name["fixture_warm"]["policies"]
    assert {"policy": "default", "volume": "default"} in by_name["default"]["policies"]
    policies = {policy["name"]: policy for policy in payload["policies"]}
    tiered = policies["fixture_tiered"]["volumes"]
    assert [(v["name"], v["priority"], v["disks"]) for v in tiered] == [("hot", 1, ["fixture_hot"]), ("warm", 2, ["fixture_warm"])], tiered
    assert all(abs(v["move_factor"] - 0.1) < 1e-6 and v["volume_type"] == "JBOD" for v in tiered), tiered
    assert payload["disks_truncated"] is False and payload["policies_truncated"] is False


def test_bytes_by_disk_and_database_match_system_parts():
    payload = disks(refresh="1")
    usage = payload["usage"]
    assert usage["truncated"] is False, usage
    rows = {(row["disk"], row["database"]): row for row in usage["rows"]}
    # The tiered fixture writes to its hot volume.
    hot = rows.get(("fixture_hot", "chdash_ui"))
    assert hot is not None and hot["bytes"] > 0 and hot["parts"] > 0, usage["rows"][:5]
    truth = ch_rows(
        "SELECT sum(bytes_on_disk) AS b, count() AS p FROM system.parts "
        "WHERE active AND database = 'chdash_ui' AND disk_name = 'fixture_hot'"
    )[0]
    assert hot["bytes"] == int(truth["b"]) and hot["parts"] == int(truth["p"]), (hot, truth)
    # Each disk's totals are the sum of its rows (none cut here).
    for disk, total in usage["disks"].items():
        own = [row for row in usage["rows"] if row["disk"] == disk]
        assert total["bytes"] == sum(row["bytes"] for row in own), (disk, total)
        assert total["parts"] == sum(row["parts"] for row in own) and total["databases"] == len(own), (disk, total)
    # Largest first.
    sizes = [row["bytes"] for row in usage["rows"]]
    assert sizes == sorted(sizes, reverse=True), sizes


def test_bytes_by_database_never_name_a_database_the_runner_cannot_see():
    hidden_db = "chdash_monitor_disks_hidden"
    try:
        ch(f"DROP DATABASE IF EXISTS {hidden_db} SYNC")
        ch(f"CREATE DATABASE {hidden_db}")
        ch(f"CREATE TABLE {hidden_db}.events (id UInt64) ENGINE = MergeTree ORDER BY id")
        ch(f"INSERT INTO {hidden_db}.events SELECT number FROM numbers(1000)")
        visible = disks(refresh="1")
        assert any(row["database"] == hidden_db for row in visible["usage"]["rows"]), "the runner sees it first"
        ch(f"REVOKE ALL ON {hidden_db}.* FROM chdash_runner")
        payload = disks(refresh="1")
        assert hidden_db not in json.dumps(payload), [row for row in payload["usage"]["rows"] if row["database"] == hidden_db]
        # Nor counted in the disk's totals.
        default = payload["usage"]["disks"]["default"]
        assert default["bytes"] == sum(row["bytes"] for row in payload["usage"]["rows"] if row["disk"] == "default")
        # The growth answer sums the visible databases and names none.
        assert hidden_db not in json.dumps(growth(refresh="1"))
    finally:
        ch(f"DROP DATABASE IF EXISTS {hidden_db} SYNC")
        # Undo the partial revoke: the runner grants of 01-chdash-users.sql.
        ch(f"GRANT SHOW, SELECT, INSERT, ALTER, CREATE, DROP, TRUNCATE, OPTIMIZE ON {hidden_db}.* TO chdash_runner")
        disks(refresh="1")


def test_disks_cache_60s_and_refresh_bypasses_it():
    first = disks(refresh="1")
    assert disks()["generated_at_ms"] == first["generated_at_ms"]
    time.sleep(0.01)
    assert disks(refresh="1")["generated_at_ms"] > first["generated_at_ms"]


def test_growth_opens_on_disk_growth_days_with_hourly_buckets():
    payload = growth()
    assert payload["panel"] == "disk_growth" and payload["scope"] == "server", payload.keys()
    requested = payload["requested"]
    assert abs(requested["to_ms"] - requested["from_ms"] - 7 * DAY_MS) < 5_000, requested
    assert payload["step_seconds"] == 3600, payload["step_seconds"]
    assert payload["limits"]["disk_growth_days"] == 7 and payload["limits"]["trend_min_points"] == 6, payload["limits"]
    assert payload["limits"]["trend_min_span_seconds"] == 6 * 3600, payload["limits"]
    # ClickHouse 26.7 logs DiskUsed_<disk> (the key column is 26.8's).
    assert payload["disk_metric_form"] == "names", payload["disk_metric_form"]
    assert set(payload["sources"]) == {"disks", "asynchronous_metric_log", "part_log"}, payload["sources"]
    for name, source in payload["sources"].items():
        assert source["status"] == "ok", (name, source)
    assert payload["unavailable_panels"] == []
    stamps = payload["timestamps"]
    assert stamps and all(t % 3_600_000 == 0 for t in stamps)
    assert FIXTURE_DISKS <= {disk["name"] for disk in payload["disks"]}
    for disk in payload["disks"]:
        assert len(disk["used"]) == len(stamps), disk["name"]
        trend = disk["trend"]
        assert trend["status"] in TREND_STATUSES, trend
        if trend["status"] == "growing":
            assert trend["slope_bytes_per_day"] > 0 and trend["days_until_full"] >= 0, trend
            expected = disk["free_space"] / trend["slope_bytes_per_day"]
            assert abs(trend["days_until_full"] - expected) <= 0.01 * expected + 0.01, trend
        else:
            assert trend["days_until_full"] is None, trend
        if trend["status"] in ("growing", "not_growing"):
            assert trend["points"] >= 6 and trend["span_seconds"] >= 6 * 3600, trend
    for name in ["merge_tree_bytes", "written_bytes", "moved_bytes", "moves"]:
        assert len(payload["series"][name]) == len(stamps), name


def test_growth_has_disk_used_default_over_the_last_15_minutes():
    ch("SYSTEM FLUSH LOGS")
    logged = ch_rows(
        "SELECT count() AS n FROM system.asynchronous_metric_log "
        "WHERE metric = 'DiskUsed_default' AND event_date >= today() - 1 AND event_time >= now() - 900"
    )[0]
    assert int(logged["n"]) > 0, logged
    now = int(time.time() * 1000)
    payload = growth(from_ms=now - 15 * 60_000, to_ms=now, refresh="1")
    assert payload["step_seconds"] == 10, payload["step_seconds"]
    default = next(disk for disk in payload["disks"] if disk["name"] == "default")
    used = non_null(default["used"])
    assert used and all(0 < value <= default["total_space"] for value in used), used[:5]
    assert payload["sources"]["asynchronous_metric_log"]["rows_read"] > 0
    # 15 minutes is no history to extrapolate from.
    assert default["trend"]["status"] == "not_enough_history" and default["trend"]["days_until_full"] is None, default["trend"]
    assert non_null(payload["series"]["merge_tree_bytes"]), payload["series"]["merge_tree_bytes"][:5]


def test_growth_counts_the_bytes_a_visible_database_writes():
    scratch = "chdash_monitor_disks_written"
    try:
        ch(f"DROP DATABASE IF EXISTS {scratch} SYNC")
        ch(f"CREATE DATABASE {scratch}")
        ch(f"CREATE TABLE {scratch}.events (id UInt64, payload String) ENGINE = MergeTree ORDER BY id")
        ch(f"INSERT INTO {scratch}.events SELECT number, repeat('x', 100) FROM numbers(100000)")
        ch("SYSTEM FLUSH LOGS")
        now = int(time.time() * 1000)
        payload = growth(from_ms=now - 10 * 60_000, to_ms=now, refresh="1")
        assert payload["sources"]["part_log"]["status"] == "ok", payload["sources"]["part_log"]
        written = sum(non_null(payload["series"]["written_bytes"]))
        part = ch_rows(
            "SELECT sum(size_in_bytes) AS b FROM system.part_log WHERE event_date >= today() - 1 "
            f"AND event_time >= now() - 900 AND database = '{scratch}' AND event_type = 'NewPart'"
        )[0]
        assert int(part["b"]) > 0 and written >= int(part["b"]), (written, part)
        assert all(value >= 0 for value in non_null(payload["series"]["moved_bytes"]))
    finally:
        ch(f"DROP DATABASE IF EXISTS {scratch} SYNC")


def test_growth_window_is_capped_by_max_lookback_days():
    now = int(time.time() * 1000)
    wide = api(SERIES, host_id="local", panel="disk_growth", from_ms=now - 30 * DAY_MS - 60_000, to_ms=now)
    assert wide.status_code == 400 and wide.json()["error_code"] == "range_too_large", wide.text
    assert growth(from_ms=now - 30 * DAY_MS, to_ms=now)["step_seconds"] == 10800


def test_every_disks_read_is_read_only_bounded_and_tagged():
    since = int(time.time()) - 5
    disks(refresh="1")
    growth(refresh="1")
    ch("SYSTEM FLUSH LOGS")
    rows = ch_rows(
        "SELECT query, Settings['readonly'] AS readonly, Settings['max_execution_time'] AS budget, "
        "Settings['timeout_overflow_mode'] AS on_timeout, Settings['max_rows_to_read'] AS read_cap, "
        "Settings['read_overflow_mode'] AS on_read_cap, Settings['max_result_rows'] AS result_cap, "
        "Settings['result_overflow_mode'] AS on_result_cap "
        "FROM system.query_log "
        f"WHERE event_date >= toDate({since}) - 1 AND event_time >= toDateTime({since}) AND type = 'QueryFinish' "
        "AND log_comment = 'chdash-monitoring' AND user = 'chdash_system' "
        "AND (query LIKE '%FROM system.disks%' OR query LIKE '%FROM system.storage_policies%' OR query LIKE '%FROM system.parts%' "
        "OR query LIKE '%DiskUsed%' OR query LIKE '%FROM system.part_log%')"
    )
    queries = " ".join(row["query"] for row in rows)
    for part in ["FROM system.disks", "FROM system.storage_policies", "FROM system.parts WHERE active AND database IN (",
                 "'DiskUsed_default'", "FROM system.part_log WHERE"]:
        assert part in queries, (part, queries[:1500])
    for row in rows:
        assert row["readonly"] == "2", row
        assert int(row["budget"]) > 0 and int(row["read_cap"]) > 0 and int(row["result_cap"]) > 0, row
        assert row["on_timeout"] == "throw" and row["on_read_cap"] == "throw" and row["on_result_cap"] == "throw", row
