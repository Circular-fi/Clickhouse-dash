"""The privilege matrix: what ChDash does when the identities of a host are narrowly or wrongly set up.

A host is healthy when its runner connects. That says nothing about whether its users can do the
work, so each test here puts a host whose runner or system user lacks something, and looks at
three things: what the routes answer, what the hosts API says, and what the process says at start.
A configuration that contradicts itself (a system user without access to system, a runner that
reads nothing) must not look fine.

Instance (tests are skipped without it): PRIVILEGES_BASE_URL, an instance started with
tests/config/privileges.hcl (users in tests/clickhouse-init/01-chdash-users.sql):

  ok          the control: runner and system user as in every other test;
  runnermin   a runner limited to chdash_ui and chdash_repl, no grant on system.*;
  systemnone  a system user that reads no system table;
  systemmin   a system user that reads only system.databases, tables and columns;
  runnernone  a runner that reads nothing;
  bothnone    both of them;
  badauth     the runner does not exist (the host is down);
  badsystem   the system user does not exist;
  toolnone    the MCP user (mcp_uri) connects and reads nothing;
  toolmin     the MCP user reads chdash_ui only;
  toolbad     the MCP user does not exist (no key can read this host).

A test marked xfail(strict) would be an inconsistency of the code that the matrix shows and that is not fixed:
it says what the code should do. When it is fixed the test fails (XPASS): remove its mark. None is left.
"""

from __future__ import annotations

import json
import os
import time

import pytest
import requests
from urllib.parse import urljoin

BASE = os.environ.get("PRIVILEGES_BASE_URL", "").rstrip("/")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "").rstrip("/")
CLICKHOUSE_USER = os.environ.get("CLICKHOUSE_USER", "test")
CLICKHOUSE_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "test")
LOGS_CMD = os.environ.get("PRIVILEGES_LOGS_CMD", "")

pytestmark = pytest.mark.skipif(not BASE, reason="PRIVILEGES_BASE_URL is not set")

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})

CONNECTED = ["ok", "runnermin", "systemnone", "systemmin", "runnernone", "bothnone", "badsystem", "toolnone", "toolmin"]
ALL_HOSTS = CONNECTED + ["badauth"]
# A key reads one host: one key for each host that has an mcp_uri (tests/config/privileges.hcl).
MCP_KEYS = {
    "ok": "matrix-secret-0123456789abcdef",
    "toolnone": "matrix-toolnone-secret-0123456789",
    "toolmin": "matrix-toolmin-secret-01234567890",
}
RUNNER_OK = ["ok", "systemnone", "systemmin", "badsystem"]
WINDOW = {"from": "2026-09-19 12:00:00", "to": "2026-09-19 12:10:00", "limit": "3"}


def call(method: str, path: str, host: str, params: dict | None = None, body: dict | None = None) -> requests.Response:
    params = dict(params or {})
    if method == "GET":
        params["host_id"] = host
        return SESSION.get(f"{BASE}{path}", params=params, timeout=60)
    return SESSION.post(f"{BASE}{path}", params=params, json={"host_id": host, **(body or {})}, timeout=60)


def get(path: str, host: str, **params) -> requests.Response:
    return call("GET", path, host, params)


def post(path: str, host: str, **body) -> requests.Response:
    return call("POST", path, host, None, body)


def hosts() -> dict[str, dict]:
    payload = SESSION.get(f"{BASE}/api/hosts", timeout=30).json()
    return {h["id"]: h for h in payload["hosts"]}


@pytest.fixture(scope="module", autouse=True)
def audited():
    """The access audit runs with the first health cycles: wait for it on every connected host."""
    deadline = time.time() + 60
    while time.time() < deadline:
        known = hosts()
        if all(known[h]["access"]["checked"] for h in CONNECTED if h in known):
            return known
        time.sleep(0.5)
    pytest.fail("the access audit did not run on every connected host in 60 s")


# Every route that a page or a tool uses, with what it needs.
ROUTES = {
    "explorer.catalog": ("GET", "/api/explorer/catalog", {}, None),
    "explorer.catalog.database": ("GET", "/api/explorer/catalog", {"database": "chdash_ui"}, None),
    "explorer.table": ("GET", "/api/explorer/table", {"database": "chdash_ui", "table": "weather_observations"}, None),
    "explorer.data": ("POST", "/api/explorer/table/data", {}, {"database": "chdash_ui", "table": "weather_observations", "limit": 3}),
    "explorer.graph": ("GET", "/api/explorer/graph", {"database": "chdash_ui"}, None),
    "explorer.functions": ("GET", "/api/explorer/functions", {}, None),
    "explorer.storage": ("GET", "/api/explorer/storage", {}, None),
    "meta": ("GET", "/api/meta", {"types": "keywords,functions,catalog"}, None),
    "system.overview": ("GET", "/api/system/overview", {}, None),
    "system.queries": ("GET", "/api/system/queries", {}, None),
    "system.disks": ("GET", "/api/system/disks", {}, None),
    "system.activity": ("GET", "/api/system/activity", {}, None),
    "system.keeper": ("GET", "/api/system/keeper", {}, None),
    "traces.meta": ("GET", "/api/traces/meta", {}, None),
    "traces.search": ("GET", "/api/traces/search", WINDOW, None),
    "logs.meta": ("GET", "/api/logs/meta", {}, None),
    "logs.search": ("GET", "/api/logs/search", WINDOW, None),
    "metrics.meta": ("GET", "/api/metrics/meta", {}, None),
    "format": ("POST", "/api/format", {}, {"sqls": ["select 1"]}),
}


def route(host: str, name: str) -> requests.Response:
    method, path, params, body = ROUTES[name]
    return call(method, path, host, params, body)


# ---- the control ------------------------------------------------------------------------------------------------------------------

def test_the_control_host_answers_every_route():
    for name in ROUTES:
        response = route("ok", name)
        assert response.status_code == 200, (name, response.status_code, response.text[:300])
    assert hosts()["ok"]["access"] == {
        "checked": True, "ok": True, "runner_user": "chdash_runner", "system_user": "chdash_system",
        "runner_reads_nothing": False, "mcp_user": "chdash_mcp", "mcp_reads_nothing": False, "mcp_audited": True,
        "mcp_connected": True, "mcp_error": "", "mcp_missing": [],
        "runner_missing": [], "system_missing": [], "warnings": [],
    }


# ---- what every route must do, whatever the setup ---------------------------------------------------------------------------------

@pytest.mark.parametrize("host", ALL_HOSTS)
def test_no_route_crashes_or_hangs_and_every_error_is_structured(host):
    for name in ROUTES:
        started = time.time()
        response = route(host, name)
        assert time.time() - started < 30, (host, name, "took more than 30 s")
        assert response.status_code != 500, (host, name, response.text[:300])
        if response.status_code >= 400:
            payload = response.json()
            assert isinstance(payload.get("error_code"), str) and payload["error_code"], (host, name, payload)
            assert isinstance(payload.get("message"), str) and payload["message"], (host, name, payload)


@pytest.mark.parametrize("host", ALL_HOSTS)
def test_a_missing_grant_is_named_the_same_way_by_every_route(host):
    """"Not enough privileges" becomes reason = not_granted, with the user, the grant and the statement."""
    seen = 0
    for name in ROUTES:
        response = route(host, name)
        if response.status_code < 400:
            continue
        payload = response.json()
        if "Not enough privileges" not in payload["message"]:
            continue
        seen += 1
        assert payload.get("reason") == "not_granted", (host, name, payload)
        assert payload.get("user"), (host, name, payload)
        assert payload.get("grant"), (host, name, payload)
        assert payload.get("hint", "").startswith("GRANT ") and payload["user"] in payload["hint"], (host, name, payload)
    if host in ("systemnone", "systemmin", "bothnone", "runnermin", "runnernone"):
        assert seen > 0, f"{host}: no route met a missing grant, the matrix does not test what it claims"


@pytest.mark.parametrize("host", ["ok", "runnermin", "runnernone"])
def test_the_source_host_of_an_answer_is_the_host_that_asked(host):
    """Hosts that share an identity share a cache: the answer must still name the host that asked."""
    for name in ("logs.meta", "metrics.meta"):
        response = route(host, name)
        assert response.status_code == 200, (host, name)
        assert response.json()["source_host_id"] == host, (host, name, response.json()["source_host_id"])


# ---- the hosts API says what the health check cannot ------------------------------------------------------------------------------

def test_a_host_is_healthy_when_it_connects_and_the_access_report_says_the_rest(audited):
    known = hosts()
    for host in CONNECTED:
        assert known[host]["healthy"] is True, host
    assert known["badauth"]["healthy"] is False
    # Only the control has nothing to say.
    assert [h for h in CONNECTED if known[h]["access"]["ok"]] == ["ok"]


def test_a_down_host_says_why():
    entry = hosts()["badauth"]
    assert entry["healthy"] is False
    assert entry["error"] and "chdash_nobody" in entry["error"], entry
    assert hosts()["ok"]["error"] is None


def test_the_access_report_names_the_runner_that_reads_nothing():
    known = hosts()
    for host in ("runnernone", "bothnone"):
        access = known[host]["access"]
        assert access["runner_reads_nothing"] is True, host
        assert any("can read no table" in w and "chdash_runner_none" in w and "GRANT SELECT ON" in w for w in access["warnings"]), access
    for host in ("ok", "runnermin", "systemnone"):
        assert known[host]["access"]["runner_reads_nothing"] is False, host


def test_the_access_report_names_the_system_grants_that_are_missing():
    known = hosts()
    for host, user in (("systemnone", "chdash_sysnone_user"), ("systemmin", "chdash_sysmin_user"), ("bothnone", "chdash_sysnone_user")):
        access = known[host]["access"]
        assert access["system_user"] == user
        for table in ("system.parts", "system.disks", "system.query_log", "otel.otel_traces", "otel.otel_logs", "otel.otel_metrics_gauge"):
            assert f"SELECT ON {table}" in access["system_missing"], (host, table, access["system_missing"])
        assert any(user in w and "GRANT" in w for w in access["warnings"]), access
    # ClickHouse lets every user read system.databases, tables and columns (the rows are filtered by their grants):
    # the audit does not report them, for a user that has no grant at all either.
    for host in ("systemnone", "systemmin"):
        for table in ("system.databases", "system.tables", "system.columns"):
            assert f"SELECT ON {table}" not in known[host]["access"]["system_missing"], (host, table)


def test_the_access_report_names_what_the_functions_page_needs_from_the_runner():
    access = hosts()["runnermin"]["access"]
    assert "SELECT ON system.documentation" in access["runner_missing"]
    assert any("Functions page" in w and "chdash_runner_min" in w for w in access["warnings"]), access
    assert not any("can read no table" in w for w in access["warnings"])


def test_a_system_user_that_cannot_connect_is_reported_though_the_host_is_healthy():
    entry = hosts()["badsystem"]
    assert entry["healthy"] is True
    assert entry["access"]["ok"] is False
    assert any("system user chdash_nobody cannot connect" in w for w in entry["access"]["warnings"]), entry["access"]


@pytest.mark.skipif(not LOGS_CMD, reason="PRIVILEGES_LOGS_CMD is not set")
def test_the_process_says_at_start_what_the_hosts_lack():
    import subprocess

    log = subprocess.run(LOGS_CMD, shell=True, capture_output=True, text=True, timeout=30)
    text = log.stdout + log.stderr
    assert "[access] host=systemnone The system user chdash_sysnone_user has no SELECT on" in text
    assert "[access] host=runnernone The runner user chdash_runner_none can read no table" in text
    assert "[access] host=ok" not in text


# ---- the MCP user ------------------------------------------------------------------------------------------------------------------

def test_the_access_report_names_what_the_mcp_user_lacks():
    known = hosts()
    ok = known["ok"]["access"]
    assert ok["mcp_user"] == "chdash_mcp" and ok["mcp_missing"] == [] and ok["mcp_reads_nothing"] is False
    none = known["toolnone"]["access"]
    assert none["mcp_user"] == "chdash_tool_none" and none["mcp_reads_nothing"] is True
    assert any("MCP user chdash_tool_none can read no table" in w for w in none["warnings"]), none
    small = known["toolmin"]["access"]
    assert small["mcp_reads_nothing"] is False
    # Only the documentation of the functions: every tool of Traces, Logs and Metrics (the pages' tools and the simple ones)
    # reads the otel tables with the system user, so the MCP user is not audited for them.
    assert small["mcp_missing"] == ["SELECT ON system.documentation"], small["mcp_missing"]
    assert any("MCP user chdash_tool_min has no SELECT on" in w and "permission_denied" in w for w in small["warnings"]), small
    # An MCP user that cannot connect is said so: no key can read this host.
    bad = known["toolbad"]["access"]
    assert bad["mcp_user"] == "chdash_nobody" and bad["mcp_audited"] is True and bad["mcp_connected"] is False and bad["mcp_error"], bad
    assert any("MCP user chdash_nobody cannot connect" in w for w in bad["warnings"]), bad
    # A host without an mcp_uri has no MCP report.
    for host in ("runnermin", "systemnone", "badsystem"):
        access = known[host]["access"]
        assert access["mcp_user"] == "" and access["mcp_missing"] == [] and access["mcp_audited"] is False, host


def mcp(method: str, path: str, **kwargs) -> requests.Response:
    return SESSION.request(method, f"{BASE}{path}", timeout=60, **kwargs)


def tool(host: str, name: str, **args) -> dict:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": {"host": host, **args}}}
    response = SESSION.post(f"{BASE}/mcp", json=body, headers={"Authorization": f"Bearer {MCP_KEYS[host]}"}, timeout=60)
    assert response.status_code == 200, response.text
    return response.json()["result"]


def test_the_tools_see_what_the_mcp_user_reads_not_what_the_runner_reads():
    # The runner of toolmin reads everything; the MCP user reads chdash_ui (and system.* through ClickHouse).
    page = get("/api/explorer/catalog", "toolmin").json()["databases"]
    assert "otel" in page and "chdash_repl" in page, page
    as_tool = tool("toolmin", "explorer_catalog")
    assert as_tool["isError"] is False
    names = set(as_tool["structuredContent"]["databases"])
    assert "chdash_ui" in names and "otel" not in names and "chdash_repl" not in names, names
    assert as_tool["structuredContent"]["host_id"] == "toolmin"
    # A user that reads nothing sees nothing.
    assert tool("toolnone", "explorer_catalog")["structuredContent"]["databases"] == []
    denied = tool("toolnone", "explorer_table", params={"database": "chdash_ui", "table": "weather_observations"})
    assert denied["isError"] is True and denied["structuredContent"]["error"] == "object_not_found"


def test_a_tool_whose_grant_the_mcp_user_lacks_says_permission_denied_with_the_grant():
    # The Functions page of the Explorer: system.documentation, read by the MCP user.
    functions = tool("toolmin", "explorer_functions")
    assert functions["isError"] is True and functions["structuredContent"]["error"] == "permission_denied"
    assert "system.documentation" in functions["structuredContent"]["message"]
    assert "chdash_tool_min" in functions["structuredContent"]["message"]


def test_the_tools_of_traces_logs_and_metrics_read_with_the_system_user_as_the_pages_do():
    """The MCP user of toolmin reads none of the otel tables, and every tool of Observability answers: the system user reads them."""
    for name, args in (("traces_search", {"params": WINDOW}), ("logs_meta", {}), ("traces_meta", {}), ("metrics_meta", {}),
                       ("search_traces", {}), ("search_logs", {}), ("list_metrics", {}), ("list_services", {})):
        result = tool("toolmin", name, **args)
        assert result["isError"] is False, (name, result)
    # A tool of System too: the state of the server, read with the system user.
    assert tool("toolmin", "system_overview")["isError"] is False


def test_the_same_tool_with_a_good_mcp_user_answers():
    for name, args in (("explorer_catalog", {}), ("traces_meta", {}), ("logs_meta", {}), ("metrics_meta", {})):
        result = tool("ok", name, **args)
        assert result["isError"] is False, (name, result)
        assert result["structuredContent"].get("source_host_id", result["structuredContent"].get("host_id")) in ("ok", None), name
    # The list of the functions of the server is large: too large for the cap of a tool is the answer, a grant is not.
    functions = tool("ok", "explorer_functions")
    assert functions["isError"] is False or functions["structuredContent"]["error"] == "result_too_large", functions


# ---- a runner limited to two databases (the report of the field) --------------------------------------------------------------------

def test_a_runner_limited_to_two_databases_opens_the_explorer_without_error():
    """SHOW DICTIONARIES needs SELECT on system.dictionaries: refused to such a runner, which must not stop the Explorer."""
    response = get("/api/explorer/catalog", "runnermin", database="chdash_ui")
    assert response.status_code == 200, response.text
    tables = {t["name"] for t in response.json()["tables"]}
    assert "weather_observations" in tables
    assert "station_dictionary" in tables  # a dictionary that SHOW TABLES lists stays


def test_a_runner_limited_to_two_databases_shows_only_their_tables():
    # The tables of a database come with the database (the first answer lists the names only).
    for database in ("chdash_ui", "chdash_repl"):
        listed = get("/api/explorer/catalog", "runnermin", database=database).json()["tables"]
        assert listed and {t["database"] for t in listed} == {database}, database
    assert get("/api/explorer/table", "runnermin", database="chdash_ui", table="weather_observations").status_code == 200
    assert post("/api/explorer/table/data", "runnermin", database="chdash_ui", table="weather_observations", limit=3).status_code == 200
    # A table of a database that the runner cannot read does not exist for it.
    for database, table in (("chdash_perf", "anything"), ("otel", "otel_traces"), ("system", "query_log")):
        denied = get("/api/explorer/table", "runnermin", database=database, table=table)
        assert denied.status_code == 404 and denied.json()["error_code"] == "object_not_found", (database, table, denied.text)
    graph = get("/api/explorer/graph", "runnermin", database="chdash_ui").json()
    assert {n["database"] for n in graph["nodes"]} <= {"chdash_ui", "chdash_repl"}


def test_the_functions_page_of_a_runner_without_system_grants_says_which_grant_it_lacks():
    response = get("/api/explorer/functions", "runnermin")
    payload = response.json()
    assert response.status_code == 503 and payload["error_code"] == "functions_unavailable"
    assert payload["reason"] == "not_granted" and "system.documentation" in payload["grant"], payload
    assert payload["user"] == "chdash_runner_min" and "chdash_runner_min" in payload["hint"], payload


def test_a_runner_limited_to_two_databases_sees_only_the_names_of_those_two():
    """The runner may SHOW every database and read two: the names, the sizes and the tables follow SELECT.
    (system stays: the runner reads system.databases, tables and columns, which ClickHouse gives to every user.)"""
    catalog = get("/api/explorer/catalog", "runnermin").json()
    assert set(catalog["databases"]) == {"chdash_ui", "chdash_repl", "system"}
    assert {s["name"] for s in catalog["database_summaries"]} <= set(catalog["databases"])
    assert get("/api/explorer/catalog", "runnermin", database="chdash_perf").json()["tables"] == []
    assert get("/api/explorer/catalog", "runnermin", database="otel").json()["tables"] == []


@pytest.mark.skipif(not CLICKHOUSE_URL, reason="CLICKHOUSE_URL is not set")
def test_the_names_of_a_restricted_runner_cost_a_bounded_number_of_queries():
    """Listing what a runner may read is a CHECK GRANT and a zero-row SELECT per table, never a DESCRIBE and a check per column (that cost a million queries an hour)."""
    def finished() -> int:
        requests.post(CLICKHOUSE_URL, params={"user": CLICKHOUSE_USER, "password": CLICKHOUSE_PASSWORD}, data=b"SYSTEM FLUSH LOGS", timeout=60)
        text = requests.post(
            CLICKHOUSE_URL, params={"user": CLICKHOUSE_USER, "password": CLICKHOUSE_PASSWORD},
            data=b"SELECT count() FROM system.query_log WHERE user = 'chdash_runner_min' AND type = 'QueryFinish'", timeout=60,
        ).text
        return int(text.strip())

    before = finished()
    for _ in range(2):
        assert get("/api/explorer/catalog", "runnermin", refresh="1").status_code == 200
        assert get("/api/explorer/catalog", "runnermin", database="chdash_ui", refresh="1").status_code == 200
    spent = finished() - before
    # Two checks for a table that is not granted whole (CHECK GRANT, then a zero-row SELECT), a few hundred tables: bounded.
    assert spent < 2500, f"a restricted runner spent {spent} queries on four catalog answers"


# ---- a runner that reads nothing ----------------------------------------------------------------------------------------------------

def test_a_runner_that_reads_nothing_sees_nothing_and_leaks_nothing():
    for host in ("runnernone", "bothnone"):
        catalog = get("/api/explorer/catalog", host).json()
        assert catalog["databases"] == [] and catalog["tables"] == []
        for name, path, params in (("table", "/api/explorer/table", {"database": "chdash_ui", "table": "weather_observations"}),):
            denied = get(path, host, **params)
            assert denied.status_code == 404 and denied.json()["error_code"] == "object_not_found"
        data = post("/api/explorer/table/data", host, database="chdash_ui", table="weather_observations", limit=3)
        assert data.status_code == 404
    graph = get("/api/explorer/graph", "runnernone", database="chdash_ui")
    assert graph.status_code == 200 and graph.json()["nodes"] == []


def test_the_query_page_of_a_runner_that_reads_nothing_fails_with_the_grant_named():
    # The query runs with the runner: the error names the user and the grant, like the other routes.
    started = post("/api/query/run", "runnernone", sql="SELECT count() FROM chdash_ui.weather_observations", mode="normal")
    assert started.status_code == 200, started.text
    stream = SESSION.get(urljoin(BASE + "/", started.json()["stream_url"]), stream=True, timeout=60)
    text = b"".join(stream.iter_content(chunk_size=None)).decode("utf-8", "replace")
    assert "event: error" in text and "Not enough privileges" in text, text[:400]
    data = next(line[5:] for line in text.splitlines() if line.startswith("data:") and "Not enough privileges" in line)
    payload = json.loads(data)
    assert payload.get("reason") == "not_granted" and payload.get("user") == "chdash_runner_none", payload


# ---- a system user that reads nothing ---------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("host", ["systemnone", "systemmin"])
def test_a_system_user_without_grants_degrades_the_system_page_panel_by_panel(host):
    """The System overview is the model: 200, each panel that cannot be read named, with the grant to run."""
    response = get("/api/system/overview", host)
    assert response.status_code == 200, response.text
    panels = response.json()["unavailable_panels"]
    assert panels, "the overview does not say that any panel is unavailable"
    for panel in panels:
        assert panel["reason"] == "not_granted" and panel["hint"].startswith("GRANT SELECT ON system."), panel


@pytest.mark.parametrize("host", ["systemnone", "systemmin"])
def test_the_pages_that_need_system_say_not_granted_with_the_grant(host):
    for name in ("system.disks", "system.activity", "system.keeper", "traces.search"):
        response = route(host, name)
        assert response.status_code == 503, (host, name, response.status_code)
        payload = response.json()
        assert payload["reason"] == "not_granted" and payload["grant"].startswith("SELECT"), (host, name, payload)


@pytest.mark.parametrize("host", ["systemnone", "systemmin"])
def test_the_explorer_catalog_works_without_storage_and_says_so_only_in_the_hosts_report(host):
    response = get("/api/explorer/catalog", host, database="chdash_ui")
    assert response.status_code == 200
    assert response.json()["disks"] == []
    assert hosts()[host]["access"]["ok"] is False


@pytest.mark.parametrize("host", ["systemnone", "systemmin"])
def test_the_table_card_and_the_graph_degrade_like_the_catalog(host):
    """A section that the system user may not read is left out and named, with the grant: the answer is 200."""
    for name in ("explorer.table", "explorer.graph"):
        response = route(host, name)
        assert response.status_code == 200, (host, name, response.text[:300])
        payload = response.json()
        assert payload["unavailable_sections"], (host, name)
        for issue in payload["unavailable"]:
            assert issue["reason"] == "not_granted" and issue["grant"].startswith("SELECT"), (host, name, issue)
            assert issue["hint"].startswith("GRANT ") and issue["user"] in issue["hint"], (host, name, issue)
    card = route(host, "explorer.table").json()
    # What the runner reads is still there: the columns and the data.
    assert card["summary"]["name"] == "weather_observations" and card["columns"]
    assert post("/api/explorer/table/data", host, database="chdash_ui", table="weather_observations", limit=3).status_code == 200


@pytest.mark.parametrize("host", ["systemnone", "systemmin"])
def test_a_logs_table_that_the_system_user_cannot_read_is_not_reported_missing(host):
    for name in ("logs.meta", "logs.search", "metrics.meta"):
        response = route(host, name)
        assert response.status_code == 503, (host, name, response.status_code, response.text[:200])
        payload = response.json()
        assert payload["error_code"].endswith("_not_granted"), (host, name, payload)
        assert payload["reason"] == "not_granted" and payload["grant"].startswith("SELECT ON otel."), (host, name, payload)


# ---- a host whose credentials are wrong ----------------------------------------------------------------------------------------------

OTEL_ROUTES = ("traces.meta", "traces.search", "logs.meta", "logs.search", "metrics.meta")


def test_a_down_host_answers_every_route_with_a_structured_503():
    for name in ROUTES:
        response = route("badauth", name)
        if name == "meta":
            # The editor keeps its built-in keywords.
            assert response.status_code == 200, (name, response.status_code)
            continue
        if name in OTEL_ROUTES:
            continue
        # format asks the server (formatQuery): 502 for a host that is down, where the other routes say 503.
        assert response.status_code in ((502, 503) if name == "format" else (503,)), (name, response.status_code, response.text[:200])
        assert response.json()["error_code"] and response.json()["message"], (name, response.text)


def test_the_opentelemetry_routes_ignore_the_health_of_the_host():
    """A characterization, not a wish: traces, logs and metrics read with the system user only. A host
    whose runner is down (so for the UI the host is down) still serves them. The two views of "the host
    is down" contradict each other; this test says which one the code follows today."""
    for name in OTEL_ROUTES:
        response = route("badauth", name)
        assert response.status_code == 200, (name, response.status_code, response.text[:200])
    assert hosts()["badauth"]["healthy"] is False


def test_a_down_host_has_one_answer_on_every_route():
    codes = {name: route("badauth", name).json()["error_code"] for name in ROUTES if name not in ("meta",) + OTEL_ROUTES}
    assert set(codes.values()) == {"host_unavailable"}, codes


def test_a_host_with_a_wrong_system_user_still_reads_through_the_runner_and_says_so_on_the_system_page():
    assert get("/api/explorer/catalog", "badsystem").status_code == 200
    overview = get("/api/system/overview", "badsystem")
    assert overview.status_code == 503 and overview.json()["error_code"] == "system_context_unavailable"
    assert "chdash_nobody" in overview.json()["message"]


# ---- a key is given the tools that the MCP user of its host can serve ------------------------------------------------------------

def meta_host(name: str) -> dict:
    return next(h for h in mcp("GET", "/api/mcp/meta").json()["hosts"] if h["name"] == name)


def test_the_page_is_told_which_tools_the_mcp_user_of_a_host_cannot_serve():
    ok = meta_host("ok")["mcp"]
    assert ok["state"] == "ok" and ok["user"] == "chdash_mcp" and ok["unavailable_tools"] == [], ok
    small = meta_host("toolmin")["mcp"]
    assert small["state"] == "ok" and small["user"] == "chdash_tool_min"
    lost = {item["tool"]: item for item in small["unavailable_tools"]}
    # What the MCP user runs itself: the documentation of the functions. The tools of Observability (the pages' tools and the
    # simple ones) read the otel tables with the system user, which has the grants: not lost.
    assert set(lost) == {"explorer_functions"}, sorted(lost)
    assert lost["explorer_functions"]["grants"] == ["SELECT ON system.documentation"]
    assert lost["explorer_functions"]["role"] == "MCP user" and lost["explorer_functions"]["user"] == "chdash_tool_min"
    assert lost["explorer_functions"]["statement"] == "GRANT SELECT ON system.documentation TO chdash_tool_min;"
    # A user that reads nothing lacks the same grant; a host whose MCP user cannot connect is "unavailable".
    assert {item["tool"] for item in meta_host("toolnone")["mcp"]["unavailable_tools"]} == {"explorer_functions"}
    bad = meta_host("toolbad")["mcp"]
    assert bad["state"] == "unavailable" and bad["error"] and bad["unavailable_tools"] == [], bad
    # A host without an mcp_uri is not offered to a key at all.
    names = [h["name"] for h in mcp("GET", "/api/mcp/meta").json()["hosts"]]
    assert "runnermin" not in names and "systemnone" not in names


def create_key(host: str, tools: list[str], databases: list[str] | None = None, name: str = "grant-check") -> requests.Response:
    body = {"name": name, "hosts": [host], "tools": tools, "databases": databases or ["*"]}
    return mcp("POST", "/api/mcp/keys", json=body)


def test_a_key_cannot_be_given_a_tool_that_the_mcp_user_cannot_serve():
    refused = create_key("toolmin", ["list_tables", "explorer_functions"])
    assert refused.status_code == 400, refused.text
    error = refused.json()
    assert error["error"] == "validation" and error["field"] == "tools" and error["reason"] == "not_grantable", error
    assert "explorer_functions" in error["message"] and "GRANT SELECT ON system.documentation TO chdash_tool_min;" in error["message"]
    assert create_key("toolnone", ["explorer_functions"]).json()["reason"] == "not_grantable"
    # The tools that it can serve go through; the key is stored, then removed.
    # (Every tool of Observability reads with the system user: toolmin has the grants.)
    made = create_key("toolmin", ["list_tables", "explorer_table", "system_overview", "query_table", "traces_search", "logs_search", "search_traces", "search_logs"])
    assert made.status_code == 201, made.text
    mcp("DELETE", f"/api/mcp/keys/{made.json()['key']['id']}")
    # The control host serves every tool.
    everything = create_key("ok", ["explorer_functions", "traces_search", "logs_search", "metrics_series"], name="grant-check-ok")
    assert everything.status_code == 201, everything.text
    mcp("DELETE", f"/api/mcp/keys/{everything.json()['key']['id']}")


def test_a_key_cannot_read_a_host_whose_mcp_user_cannot_connect():
    refused = create_key("toolbad", ["list_tables"])
    assert refused.status_code == 400, refused.text
    error = refused.json()
    assert error["field"] == "hosts" and error["reason"] == "mcp_user_unavailable", error
    assert "chdash_nobody" in error["message"] and "toolbad" in error["message"]
    # Every tool of Observability reads with the system user: the data of the key does not matter.
    narrow = create_key("ok", ["search_traces", "traces_search"], databases=["chdash_ui"], name="grant-check-data")
    assert narrow.status_code == 201, narrow.text
    mcp("DELETE", f"/api/mcp/keys/{narrow.json()['key']['id']}")
    # No such host, no mcp_uri, a wildcard and a list: refused before the server looks at any user.
    assert create_key("runnermin", ["list_tables"]).json()["reason"] == "unknown_host"
    assert create_key("*", ["list_tables"]).json()["reason"] == "invalid"
    two = mcp("POST", "/api/mcp/keys", json={"name": "two", "hosts": ["ok", "toolmin"], "tools": [], "databases": ["*"]})
    assert two.status_code == 400 and two.json()["reason"] == "too_many", two.text
    assert mcp("GET", "/api/mcp/keys").json()["keys"] and all(len(k["hosts"]) <= 1 for k in mcp("GET", "/api/mcp/keys").json()["keys"])
