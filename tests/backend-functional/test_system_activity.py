"""The System Overview's Activity and Keeper endpoints (/api/system/activity,
/api/system/keeper), formerly the Explorer's Server operations: their v2.14.0
addresses (/api/explorer/ops/...) and config (explorer.operations) still work.

Both endpoints are read-only and bounded. Activity rows that name an object
are serialized only when the runner can SHOW that object; Keeper status is
server-level and limited to an allowlist of metrics/events.
"""
from __future__ import annotations

import json
import os
import time

import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))

ACTIVITY_SECTIONS = ["merges", "mutations", "replication_queue", "replicas", "distribution_queue"]
KEEPER_METRICS = {
    "ZooKeeperSession", "ZooKeeperSessionExpired", "ZooKeeperRequest", "ZooKeeperWatch",
    "ZooKeeperConnectionLossStartedTimestampSeconds", "KeeperAliveConnections", "KeeperOutstandingRequests",
}
KEEPER_EVENTS = {
    "ZooKeeperInit", "ZooKeeperTransactions", "ZooKeeperWaitMicroseconds", "ZooKeeperHardwareExceptions",
    "ZooKeeperUserExceptions", "ZooKeeperOtherExceptions", "ZooKeeperBytesSent", "ZooKeeperBytesReceived",
    "ZooKeeperList", "ZooKeeperCreate", "ZooKeeperRemove", "ZooKeeperExists", "ZooKeeperGet", "ZooKeeperSet",
    "ZooKeeperMulti", "ZooKeeperWatchResponse",
}


def api(path: str, **params) -> requests.Response:
    return requests.get(f"{BASE_URL}{path}", params=params, timeout=60)


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


def test_ops_endpoints_validate_the_host_and_are_advertised_as_features():
    for path in ["/api/system/activity", "/api/system/keeper"]:
        missing = api(path)
        assert missing.status_code == 400, missing.text
        assert missing.json().get("error_code") == "missing_host_id", missing.text
        unknown = api(path, host_id="does-not-exist")
        assert unknown.status_code == 404, unknown.text
    features = api("/api/version").json().get("features", {})
    assert features.get("explorer", {}).get("operations") == {"enabled": True, "keeper": True}, features
    assert features["system"]["activity"] is True and features["system"]["keeper"] is True, features
    # The v2.14.0 page address opens the System page (a redirect).
    page = api("/explorer/_operations")
    assert page.status_code == 200 and '<body data-page="system">' in page.text
    # And the v2.14.0 API addresses answer as the new ones.
    for old, new in [("/api/explorer/ops/activity", "/api/system/activity"), ("/api/explorer/ops/keeper", "/api/system/keeper")]:
        assert set(ok(old, host_id="local")) == set(ok(new, host_id="local")), old


def test_ops_activity_reports_replica_health_of_the_replicated_fixture():
    payload = ok("/api/system/activity", host_id="local", refresh="1")
    assert payload.get("version") == 1, payload
    assert payload.get("row_limit") == 200, payload
    assert payload.get("unavailable_sections") == [], payload
    for section in ACTIVITY_SECTIONS:
        assert isinstance(payload.get(section), list), (section, payload)
        assert len(payload[section]) <= payload["row_limit"], section

    replicas = {(row["database"], row["table"]): row for row in payload["replicas"]}
    events = replicas.get(("chdash_repl", "replicated_events"))
    assert events is not None, replicas.keys()
    assert events["is_readonly"] is False and events["is_session_expired"] is False, events
    assert events["replica_name"], events
    # Counts come from the shared 60 s replica-count cache (both replicas up).
    assert events["total_replicas"] == 2 and events["active_replicas"] == 2, events
    for row in payload["replicas"]:
        assert set(row) >= {"queue_size", "absolute_delay_seconds", "inserts_in_queue", "merges_in_queue", "last_queue_update"}, row

    # Security boundary: every serialized object is in the runner catalog.
    named = {(row["database"], row["table"]) for section in ACTIVITY_SECTIONS for row in payload[section]}
    for database in {database for database, _ in named}:
        catalog = ok("/api/explorer/catalog", host_id="local", database=database)
        visible = {row.get("name") for row in catalog.get("tables", [])}
        assert {table for db, table in named if db == database} <= visible, database


def _wait_for_failing_mutation(database: str, table: str, timeout_s: float = 30) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        rows = ch_rows(
            f"SELECT latest_fail_reason FROM system.mutations WHERE database = '{database}' AND table = '{table}' AND NOT is_done"
        )
        if rows and rows[0]["latest_fail_reason"]:
            return
        time.sleep(0.5)
    raise AssertionError(f"mutation on {database}.{table} did not fail in time")


def test_ops_activity_lists_failing_mutations_only_for_objects_the_runner_can_see():
    visible_db = "chdash_ops_visible"
    hidden_db = "chdash_ops_hidden"
    try:
        for database in [visible_db, hidden_db]:
            ch(f"CREATE DATABASE IF NOT EXISTS {database}")
            ch(f"DROP TABLE IF EXISTS {database}.stuck")
            ch(f"CREATE TABLE {database}.stuck (id UInt64, v UInt64) ENGINE = MergeTree ORDER BY id")
            ch(f"INSERT INTO {database}.stuck SELECT number, number FROM numbers(10)")
        # The runner keeps no privilege on the hidden database, so it can no
        # longer SHOW it (any table privilege implies SHOW TABLES).
        ch(f"REVOKE ALL ON {hidden_db}.* FROM chdash_runner")
        for database in [visible_db, hidden_db]:
            ch(f"ALTER TABLE {database}.stuck UPDATE v = throwIf(v >= 0, 'chdash ops test failure') WHERE 1")
        for database in [visible_db, hidden_db]:
            _wait_for_failing_mutation(database, "stuck")

        payload = ok("/api/system/activity", host_id="local", refresh="1")
        mutations = payload["mutations"]
        mine = [row for row in mutations if row["database"] == visible_db and row["table"] == "stuck"]
        assert len(mine) == 1, mutations
        mutation = mine[0]
        assert mutation["is_done"] is False, mutation
        assert "chdash ops test failure" in mutation["latest_fail_reason"], mutation
        assert mutation["latest_fail_error_code_name"], mutation
        assert mutation["parts_to_do"] >= 1, mutation
        assert "UPDATE" in mutation["command"], mutation
        # Failing mutations sort first.
        assert mutations.index(mutation) <= sum(1 for row in mutations if row["latest_fail_reason"]) - 1, mutations
        assert not any(row["database"] == hidden_db for row in mutations), mutations
        assert all(row["database"] != hidden_db for section in ACTIVITY_SECTIONS for row in payload[section])
    finally:
        for database in [visible_db, hidden_db]:
            ch(f"KILL MUTATION WHERE database = '{database}' SYNC")
            ch(f"DROP DATABASE IF EXISTS {database} SYNC")
        # Undo the partial revoke: the runner grants of 01-chdash-users.sql.
        ch(f"GRANT SHOW, SELECT, INSERT, ALTER, CREATE, DROP, TRUNCATE, OPTIMIZE ON {hidden_db}.* TO chdash_runner")
        api("/api/system/activity", host_id="local", refresh="1")


def test_ops_keeper_reports_the_session_and_allowlisted_counters_only():
    payload = ok("/api/system/keeper", host_id="local", refresh="1")
    assert payload.get("version") == 1, payload
    assert payload.get("configured") is True, payload
    assert payload.get("unavailable_sections") == [], payload
    connections = payload.get("connections") or []
    assert connections, payload
    connection = connections[0]
    assert connection["host"] and connection["port"] > 0, connection
    assert connection["is_expired"] is False, connection
    assert connection["session_uptime_seconds"] >= 0, connection
    assert set(payload["metrics"]) <= KEEPER_METRICS, payload["metrics"]
    assert set(payload["events"]) <= KEEPER_EVENTS, payload["events"]
    assert payload["metrics"].get("ZooKeeperSession", 0) >= 1, payload["metrics"]
    assert payload["events"].get("ZooKeeperTransactions", 0) > 0, payload["events"]
    assert isinstance(payload.get("average_wait_ms"), (int, float)) and payload["average_wait_ms"] >= 0, payload
    # Server-level: no object name is ever part of the Keeper payload.
    assert "zookeeper_path" not in json.dumps(payload)
