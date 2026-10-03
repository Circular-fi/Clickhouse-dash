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
