"""The OpenTelemetry tables per host (docs/configuration.md, "observability").

Three hosts of one ClickHouse server (tests/config/otel-hosts.hcl): `main` has the tables of the `observability` block, `alt`
has its own logs and metrics tables (empty copies in the database otel_alt) and no traces, `nologs` has no logs. Each request is served
with the settings of the host that it names, so the same route answers differently from a host to another.
"""

from __future__ import annotations

import os

import pytest
import requests

BASE = os.environ.get("OTEL_HOSTS_BASE_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(not BASE, reason="OTEL_HOSTS_BASE_URL is not set")

SESSION = requests.Session()


def get(path: str, host: str, **params) -> requests.Response:
    return SESSION.get(f"{BASE}{path}", params={"host_id": host, **params}, timeout=60)


def ok(path: str, host: str, **params) -> dict:
    response = get(path, host, **params)
    assert response.status_code == 200, (path, host, response.status_code, response.text[:300])
    return response.json()


def test_the_hosts_are_all_healthy_and_the_signals_are_on_for_the_instance():
    hosts = SESSION.get(f"{BASE}/api/hosts", timeout=30).json()["hosts"]
    assert [h["id"] for h in hosts] == ["main", "alt", "nologs", "denied"]
    features = SESSION.get(f"{BASE}/api/version", timeout=30).json()["features"]
    # A signal is on when it is on for at least one host: the pages exist, each request answers for its host.
    assert features["traces"]["enabled"] and features["logs"]["enabled"] and features["metrics"]["enabled"]


def test_logs_are_read_from_the_tables_of_each_host():
    main = ok("/api/logs/meta", "main")
    assert (main["database"], main["table"], main["table_exists"]) == ("otel", "otel_logs", True)
    alt = ok("/api/logs/meta", "alt")
    assert (alt["database"], alt["table"], alt["table_exists"]) == ("otel_alt", "logs_copy", True)
    assert alt["source_host_id"] == "alt" and main["source_host_id"] == "main"
    # The same route, the same window: the host with the data answers rows, the host with its own (empty) table none.
    end_ms = int(main["time_bounds"]["max_ms"])
    window = {"start_ms": end_ms - 30 * 60 * 1000, "end_ms": end_ms, "limit": 20}
    a = ok("/api/logs/search", "main", **window)
    b = ok("/api/logs/search", "alt", **window)
    assert a["source_host_id"] == "main" and b["source_host_id"] == "alt"
    assert a["row_count"] > 0 and b["row_count"] == 0


def test_a_signal_that_is_off_for_a_host_is_off_for_that_host_only():
    for path in ("/api/traces/meta", "/api/traces/search"):
        response = get(path, "alt")
        assert response.status_code == 404 and response.json()["error_code"] == "traces_disabled", (path, response.text)
    assert ok("/api/traces/meta", "main")["database"] == "otel"
    assert ok("/api/traces/meta", "nologs")["table"] == "otel_traces"
    # The meta of Logs and Metrics answers 200 with enabled = false (the page draws its "disabled" state from it).
    meta = ok("/api/logs/meta", "nologs")
    assert meta["enabled"] is False and meta["error_code"] == "logs_disabled"
    response = get("/api/logs/search", "nologs")
    assert response.status_code == 404 and response.json()["error_code"] == "logs_disabled", response.text
    assert get("/api/logs/meta", "main").status_code == 200


def test_metrics_are_read_from_the_tables_of_each_host():
    main = ok("/api/metrics/meta", "main")
    assert (main["database"], main["table_prefix"]) == ("otel", "otel_metrics")
    alt = ok("/api/metrics/meta", "alt")
    assert (alt["database"], alt["table_prefix"]) == ("otel_alt", "metrics")
    assert alt["features"]["gauges"] and alt["features"]["sums"] and alt["features"]["histograms"]
    # The catalog of each host reads its own tables: the answer names the host, and the empty copies hold no metric.
    now = int(__import__("time").time() * 1000)
    window = {"start_ms": now - 80 * 24 * 3600 * 1000, "end_ms": now, "refresh": "1"}
    assert ok("/api/metrics/catalog", "alt", **window)["source_host_id"] == "alt"


def test_the_access_audit_reads_the_tables_of_each_host():
    # The system user reads otel and otel_alt: nothing is missing there (the audit checks the tables of each host). The host
    # whose logs are in a database that the user may not read is told so, with the table of that host.
    audit = {h["id"]: h["access"] for h in SESSION.get(f"{BASE}/api/hosts", timeout=30).json()["hosts"]}
    for name in ("main", "alt", "nologs"):
        assert audit[name]["system_missing"] == [], (name, audit[name])
    assert "SELECT ON not_granted_db.logs" in audit["denied"]["system_missing"], audit["denied"]
    # The page says it too, instead of "table missing".
    response = get("/api/logs/meta", "denied")
    assert response.status_code == 503 and response.json()["error_code"] == "logs_table_not_granted", response.text
