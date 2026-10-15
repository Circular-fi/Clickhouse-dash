"""MCP endpoint, keys and page API (docs/mcp.md).

Instances (tests needing one that is not configured are skipped, so the default compose run, one
chdash_source with the feature disabled, only runs the disabled checks):
- API_BASE_URL (or MCP_DISABLED_BASE_URL): MCP disabled, every route answers as documented.
- MCP_BASE_URL: tests/config/mcp.hcl, with an empty writable directory mounted at /data.
- MCP_DATA_DIR: that /data as seen by pytest (file mode, hash only, storage errors).
- MCP_RESTART_CMD: a command restarting that instance (keys survive a restart).
- MCP_LOGS_CMD: a command printing that instance's log (the audit lines).
- MCP_RO_BASE_URL / MCP_RO_DATA_DIR: tests/config/mcp.readonly.hcl, /data holding a copy of
  tests/config/mcp.seed.json as mcp_keys.json.
- MCP_NOSTORAGE_BASE_URL: tests/config/mcp.nostorage.hcl.
- MCP_STARTUP_CMD: a command that runs the REAL binary on a config file, with {dir} (the directory
  that holds the file) and {name} (its name), for the startup errors; for example
  docker run --rm -v {dir}:/cfg:ro --entrypoint /app/chdash chdash-m3b-app:local --config /cfg/{name}
- MCP_PROFILE_BASE_URL: tests/config/mcp.profile.hcl, MCP users whose settings profile sets readonly = 2 or 1 (the compose service
  chdash_mcp_profile, users in tests/clickhouse-init/01-chdash-users.sql).
- CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD: an admin account, to make the scratch
  database mcp_scratch (and to check what the MCP user could not change).
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import pytest
import requests

DISABLED_URL = os.environ.get("MCP_DISABLED_BASE_URL", os.environ.get("API_BASE_URL", "http://chdash_source:8080")).rstrip("/")
MCP_URL = os.environ.get("MCP_BASE_URL", "").rstrip("/")
DATA_DIR = os.environ.get("MCP_DATA_DIR", "")
RESTART_CMD = os.environ.get("MCP_RESTART_CMD", "")
LOGS_CMD = os.environ.get("MCP_LOGS_CMD", "")
RO_URL = os.environ.get("MCP_RO_BASE_URL", "").rstrip("/")
RO_DATA_DIR = os.environ.get("MCP_RO_DATA_DIR", "")
NOSTORAGE_URL = os.environ.get("MCP_NOSTORAGE_BASE_URL", "").rstrip("/")
PROFILE_URL = os.environ.get("MCP_PROFILE_BASE_URL", "").rstrip("/")
STARTUP_CMD = os.environ.get("MCP_STARTUP_CMD", "")
# Where the binary sees the directory {dir} of the command (the mount point of a docker run; "{dir}" when the command runs on the host).
STARTUP_CONFIG_DIR = os.environ.get("MCP_STARTUP_CONFIG_DIR", "/cfg")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "").rstrip("/")
CLICKHOUSE_USER = os.environ.get("CLICKHOUSE_USER", "test")
CLICKHOUSE_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "test")

# Secrets of tests/config/mcp.hcl.
ALL = "a11da7a0-0000-4000-8000-000000000001"
WEATHER = "3ea7be00-0000-4000-8000-000000000002"
OTEL = "07e1ead0-0000-4000-8000-000000000003"
LIMITED = "11317ed0-0000-4000-8000-000000000004"
SECOND = "5ec0d000-0000-4000-8000-000000000005"
HOSTS_ONLY = "4057a000-0000-4000-8000-000000000006"
RATE = "7a7e7e57-0000-4000-8000-000000000007"
# Of tests/config/mcp.profile.hcl.
PROFILE_RO2 = "20a7c0de-0000-4000-8000-000000000001"
PROFILE_RO2CAP = "20a7c0de-0000-4000-8000-000000000002"
PROFILE_RO2CAP_LOW = "20a7c0de-0000-4000-8000-000000000003"
PROFILE_RO1 = "20a7c0de-0000-4000-8000-000000000004"
# Of tests/config/mcp.nostorage.hcl.
ONLY_KEY = "0a17e100-0000-4000-8000-000000000008"
# Of tests/config/mcp.seed.json.
SEED = "5eed0000-0000-4000-8000-000000000009"
# The secret of a page key: a version 4 UUID.
UUID4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")

# Limits of tests/config/mcp.hcl.
MAX_ROWS = 100
MAX_BYTES = 20000
MAX_SQL = 2048
ORIGIN = "https://inspector.example.com"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})

needs_mcp = pytest.mark.skipif(not MCP_URL, reason="MCP_BASE_URL is not set")
needs_profile = pytest.mark.skipif(not PROFILE_URL, reason="MCP_PROFILE_BASE_URL is not set")
needs_data_dir = pytest.mark.skipif(not (MCP_URL and DATA_DIR), reason="MCP_DATA_DIR is not set")
needs_restart = pytest.mark.skipif(not (MCP_URL and RESTART_CMD), reason="MCP_RESTART_CMD is not set")
needs_logs = pytest.mark.skipif(not (MCP_URL and LOGS_CMD), reason="MCP_LOGS_CMD is not set")
needs_ro = pytest.mark.skipif(not RO_URL, reason="MCP_RO_BASE_URL is not set")
needs_nostorage = pytest.mark.skipif(not NOSTORAGE_URL, reason="MCP_NOSTORAGE_BASE_URL is not set")
needs_startup = pytest.mark.skipif(not STARTUP_CMD, reason="MCP_STARTUP_CMD is not set")
needs_clickhouse = pytest.mark.skipif(not (MCP_URL and CLICKHOUSE_URL), reason="CLICKHOUSE_URL is not set")


# ---- helpers -------------------------------------------------------------------------------------------


def post_mcp(base: str, key: str | None, body, *, headers=None, raw: str | None = None) -> requests.Response:
    hdrs = {"Content-Type": "application/json"}
    if key is not None:
        hdrs["Authorization"] = f"Bearer {key}"
    hdrs.update(headers or {})
    data = raw if raw is not None else json.dumps(body)
    return SESSION.post(f"{base}/mcp", data=data, headers=hdrs, timeout=30)


def rpc(base: str, key: str | None, method: str, params=None, *, id_=1, headers=None) -> requests.Response:
    body = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        body["params"] = params
    return post_mcp(base, key, body, headers=headers)


def call_tool(base: str, key: str, name: str, arguments=None) -> dict:
    """The `result` of tools/call: {content, structuredContent, isError}."""
    response = rpc(base, key, "tools/call", {"name": name, "arguments": arguments or {}})
    assert response.status_code == 200, response.text
    body = response.json()
    assert "error" not in body, body
    return body["result"]


def ok_tool(base: str, key: str, name: str, arguments=None) -> dict:
    result = call_tool(base, key, name, arguments)
    assert result["isError"] is False, result
    # The text content and the structured content carry the same JSON.
    assert json.loads(result["content"][0]["text"]) == result["structuredContent"]
    return result["structuredContent"]


def fail_tool(base: str, key: str, name: str, arguments=None, code: str | None = None) -> dict:
    result = call_tool(base, key, name, arguments)
    assert result["isError"] is True, result
    payload = result["structuredContent"]
    assert json.loads(result["content"][0]["text"]) == payload
    assert set(payload) >= {"error", "message"}
    if code:
        assert payload["error"] == code, payload
    return payload


def m(method: str, path: str, **kwargs) -> requests.Response:
    base = kwargs.pop("base", MCP_URL)
    headers = dict(kwargs.pop("headers", {}) or {})
    body = kwargs.pop("body", None)
    if body is not None:
        kwargs["data"] = json.dumps(body)
        headers.setdefault("Content-Type", "application/json")
    return SESSION.request(method, f"{base}{path}", headers=headers, timeout=30, **kwargs)


def api_ok(response: requests.Response, status: int = 200) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["Content-Type"].startswith("application/json")
    return response.json()


def api_error(response: requests.Response, status: int, code: str, **extra) -> dict:
    assert response.status_code == status, response.text
    assert response.headers["Cache-Control"] == "no-store"
    body = response.json()
    assert body["error_code"] == code, body
    assert isinstance(body["retryable"], bool), body
    assert isinstance(body["message"], str) and body["message"]
    for key, value in extra.items():
        assert body[key] == value, body
    return body


def ch(sql: str) -> str:
    response = requests.post(
        CLICKHOUSE_URL, params={"user": CLICKHOUSE_USER, "password": CLICKHOUSE_PASSWORD}, data=sql.encode(), timeout=60
    )
    assert response.status_code == 200, response.text
    return response.text


def new_key_body(name: str | None = None, **overrides) -> dict:
    body = {
        "name": name or f"t-{uuid.uuid4().hex[:10]}",
        "hosts": ["local"],
        "tools": ["list_databases", "list_tables", "describe_table", "query_table"],
        "databases": ["chdash_ui.weather_*"],
    }
    body.update(overrides)
    return body


def make_key(body: dict | None = None) -> tuple[dict, str]:
    created = api_ok(m("POST", "/api/mcp/keys", body=body or new_key_body()), 201)
    return created["key"], created["secret"]


def drop_key(key_id: str) -> None:
    m("DELETE", f"/api/mcp/keys/{key_id}")


@pytest.fixture(scope="module")
def scratch():
    """mcp_scratch: a wide table, and a sink the MCP user may INSERT into while a test shows readonly stops it."""
    if not (MCP_URL and CLICKHOUSE_URL):
        pytest.skip("needs MCP_BASE_URL and CLICKHOUSE_URL")
    ch("CREATE DATABASE IF NOT EXISTS mcp_scratch")
    # Wide parts report the size of each column (system.columns); compact parts, the default for small tables, report 0.
    ch("DROP TABLE IF EXISTS mcp_scratch.wide")
    ch("CREATE TABLE mcp_scratch.wide (id UInt64, small String, big String, note Nullable(String)) ENGINE = MergeTree ORDER BY id "
       "SETTINGS min_bytes_for_wide_part = 0, min_rows_for_wide_part = 0")
    ch("INSERT INTO mcp_scratch.wide SELECT number, concat('s', toString(number)), repeat('x', 5000), if(number % 2 = 0, NULL, 'odd') FROM numbers(30)")
    ch("CREATE TABLE IF NOT EXISTS mcp_scratch.sink (a UInt8) ENGINE = MergeTree ORDER BY a")
    ch("TRUNCATE TABLE mcp_scratch.sink")
    ch("GRANT SELECT ON mcp_scratch.* TO chdash_mcp")
    yield
    ch("REVOKE ALL ON mcp_scratch.* FROM chdash_mcp")


# ---- disabled ------------------------------------------------------------------------------------------------


def test_disabled_instance_answers_as_documented():
    meta = api_ok(m("GET", "/api/mcp/meta", base=DISABLED_URL))
    assert meta == {"enabled": False}
    for method, path in [("GET", "/api/mcp/keys"), ("POST", "/api/mcp/keys"), ("DELETE", "/api/mcp/keys/ui_000000000000"),
                         ("GET", "/api/mcp/keys/ui_000000000000/access"), ("GET", "/api/mcp/usage"), ("GET", "/api/mcp/usage/overview"),
                         ("GET", "/api/mcp/keys/ui_000000000000/usage"), ("GET", "/api/mcp/keys/ui_000000000000/cost")]:
        body = {"name": "x"} if method == "POST" else None
        api_error(m(method, path, base=DISABLED_URL, body=body), 404, "mcp_disabled")
    # No route gives a secret again (SEC-009), on any instance.
    assert m("GET", "/api/mcp/keys/ui_000000000000/secret", base=DISABLED_URL).status_code == 404
    assert m("POST", "/mcp", base=DISABLED_URL, body={}).status_code == 404
    # The two pages of the section are served even when MCP is off (their "disabled" state shows the HCL); 404 only while the shell
    # file (mcp.html, mcpusage.html) is absent.
    for page in ("/mcp-integration", "/mcp-integration/", "/mcp-integration/usage", "/mcp-integration/usage/"):
        assert m("GET", page, base=DISABLED_URL).status_code in (200, 404), page
    version = m("GET", "/api/version", base=DISABLED_URL).json()
    assert version["features"]["mcp"] == {"enabled": False}


# ---- meta and version ----------------------------------------------------------------------------------------


@needs_mcp
def test_meta_and_version():
    meta = api_ok(m("GET", "/api/mcp/meta"))
    assert meta["enabled"] is True
    assert meta["endpoint_path"] == "/mcp"
    assert meta["storage_configured"] is True
    assert meta["manage_from_ui"] is True
    assert meta["can_manage"] is True
    assert meta["protocol_versions"] == ["2025-06-18", "2025-03-26", "2024-11-05"]
    # Only the hosts that have an mcp_uri; healthy is true, false or null.
    assert [h["name"] for h in meta["hosts"]] == ["local", "second"]
    assert meta["hosts"][0]["label"] == "Local ClickHouse"
    assert meta["hosts"][1]["label"] == "second"
    assert all(h["healthy"] in (True, False, None) for h in meta["hosts"])
    # What the MCP user of each host can do: "ok" once the audit ran, and the tools that it cannot serve.
    for host in meta["hosts"]:
        assert set(host["mcp"]) == {"user", "state", "error", "reads_nothing", "profile", "limits", "unavailable_tools"}
        assert host["mcp"]["state"] in ("ok", "unknown") and host["mcp"]["user"] in ("chdash_mcp", "")
        assert host["mcp"]["unavailable_tools"] == []
    tools = {t["name"]: t for t in meta["tools"]}
    assert list(tools)[:5] == ["list_hosts", "list_databases", "list_tables", "describe_table", "query_table"]
    groups = [g["id"] for g in meta["tool_groups"]]
    assert groups == ["data", "explorer", "system", "observability", "query", "sql"]
    assert all(set(g) == {"id", "title", "note", "sections"} and g["title"] and g["note"] for g in meta["tool_groups"])
    # Observability has a section for each signal; the other families have none.
    assert {g["id"]: [s["id"] for s in g["sections"]] for g in meta["tool_groups"]} == {
        "data": [], "explorer": [], "system": [], "observability": ["traces", "logs", "metrics"], "query": [], "sql": []}
    assert {t["group"] for t in meta["tools"]} <= set(groups)
    # No card is a lone check box: a family has at least two tools.
    assert all(sum(1 for t in meta["tools"] if t["group"] == g) >= 2 for g in groups)
    # Traces, Logs and Metrics are a part of Observability, and the simple tools stand in the section of their signal.
    observability = {n: t["section"] for n, t in tools.items() if t["group"] == "observability"}
    assert {observability[n] for n in ("list_services", "search_traces", "get_trace", "traces_search", "traces_trace")} == {"traces"}
    assert {observability[n] for n in ("search_logs", "logs_search", "logs_histogram")} == {"logs"}
    assert {observability[n] for n in ("list_metrics", "query_metric", "metrics_series")} == {"metrics"}
    assert set(observability.values()) == {"traces", "logs", "metrics"}
    assert all(t["section"] == "" for t in meta["tools"] if t["group"] != "observability")
    # The usage of the keys: kept in mcp.usage_file, and the windows of its answers.
    usage = meta["usage"]
    assert usage["persisted"] is True and usage["retention_days"] == 90
    assert usage["windows"] == ["1h", "6h", "24h", "7d", "30d", "90d"] and usage["default_window"] == "7d"
    assert usage["since"].endswith("Z")
    # The windows of the ClickHouse cost of a key (System > Queries is on: it reads query_log the same way).
    assert usage["cost_windows"] == ["1h", "6h", "24h", "7d"]
    assert tools["query_table"]["group"] == "data" and tools["list_hosts"]["group"] == "data"
    assert {tools[n]["group"] for n in ("query_library", "format_sql", "query_execution")} == {"query"}
    # The API tools: one for each read function of the API, in the families of the pages; they need all the data.
    api_tools = {n: t for n, t in tools.items() if t["group"] in ("explorer", "system", "observability", "query") and n not in ("list_services", "search_traces", "get_trace", "search_logs", "list_metrics", "query_metric")}
    # The tools about the server need all the data; the Explorer tools of one table or of the catalog follow the patterns of
    # the key, and a few read no data at all.
    assert len(api_tools) >= 40
    # No API tool needs all the data: the Explorer tools of a table or of the catalog follow the patterns of the key, and
    # the others read as the pages do (the MCP user decides what is visible, the system user adds the figures), so the
    # permission is what gives them. Only the SQL tools need `*`.
    assert {n for n, t in tools.items() if t["needs_all_data"]} == {"run_query", "explain_query"}
    assert all("data_tables" not in t for t in meta["tools"])  # no tool depends on the data of the key for the otel tables
    for name in ("explorer_catalog", "explorer_table", "system_overview", "traces_search", "logs_search", "metrics_series", "format_sql"):
        assert name in api_tools
    assert [n for n, t in tools.items() if t["needs_all_data"] and t["group"] == "sql"] == ["run_query", "explain_query"]
    assert all(isinstance(t["description"], str) and t["description"] for t in meta["tools"])
    assert meta["limits"] == {
        "max_rows": 100, "max_result_bytes": 20000, "query_timeout_seconds": 5, "max_sql_bytes": 2048,
        "max_memory_bytes": 536870912, "max_rows_to_read": 5000000, "rate_limit_per_minute": 120,
    }
    assert meta["name_pattern"] == "^[a-z0-9][a-z0-9_-]{0,31}$"
    assert "secret_min_bytes" not in meta
    assert "allowed_origins" not in meta and ORIGIN not in json.dumps(meta)
    version = m("GET", "/api/version").json()
    assert version["features"]["mcp"] == {"enabled": True}
    # The page routes are normal shells: 200 once the page exists, 404 before (the shell file belongs to the page).
    for page in ("/mcp-integration", "/mcp-integration/", "/mcp-integration/usage", "/mcp-integration/usage/"):
        assert m("GET", page).status_code in (200, 404), page


# ---- the endpoint ---------------------------------------------------------------------------------------------------


@needs_mcp
def test_get_and_delete_answer_405():
    for method in ("GET", "DELETE", "PUT", "PATCH"):
        response = m(method, "/mcp", headers={"Authorization": f"Bearer {ALL}"})
        assert response.status_code == 405, method
        assert response.headers["Allow"] == "POST"


@needs_mcp
def test_authentication():
    body = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    response = post_mcp(MCP_URL, None, body)
    assert response.status_code == 401
    assert "Bearer" in response.headers["WWW-Authenticate"]
    assert response.json()["error_code"] == "unauthorized"
    for key in ("", "chm_unknown", ALL[:-1], ALL + "x", ALL.upper()):
        assert post_mcp(MCP_URL, key, body).status_code == 401, key
    assert post_mcp(MCP_URL, None, body, headers={"Authorization": f"Basic {ALL}"}).status_code == 401
    assert post_mcp(MCP_URL, None, body, headers={"Authorization": ALL}).status_code == 401
    # The secret is never accepted in a query string or another header.
    assert SESSION.post(f"{MCP_URL}/mcp?key={ALL}", json=body, timeout=10).status_code == 401
    assert SESSION.post(f"{MCP_URL}/mcp", json=body, headers={"X-Api-Key": ALL}, timeout=10).status_code == 401
    # Every key has a secret that works, and the case of the scheme is free.
    for key in (ALL, WEATHER):
        assert post_mcp(MCP_URL, key, body).status_code == 200
    assert post_mcp(MCP_URL, None, body, headers={"Authorization": f"bearer {ALL}"}).status_code == 200
    # 401 answers do not say which case it was.
    messages = {post_mcp(MCP_URL, k, body).json()["message"] for k in ("chm_unknown", "chm_other")}
    assert len(messages) == 1


@needs_mcp
def test_origin_check():
    body = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    # No Origin header (a CLI, an SDK, an IDE): accepted.
    assert post_mcp(MCP_URL, ALL, body).status_code == 200
    # A browser page that is not listed is refused, even with a valid key.
    for origin in ("https://evil.example.com", "null", "http://inspector.example.com", ORIGIN + ".evil.com", "https://localhost"):
        response = post_mcp(MCP_URL, ALL, body, headers={"Origin": origin})
        assert response.status_code == 403, origin
        assert response.json()["error_code"] == "origin_not_allowed"
    # Listed (case of the host does not matter).
    assert post_mcp(MCP_URL, ALL, body, headers={"Origin": ORIGIN}).status_code == 200
    assert post_mcp(MCP_URL, ALL, body, headers={"Origin": ORIGIN.upper().replace("HTTPS", "https")}).status_code == 200
    # Even the origin of the server itself is not trusted: only the list counts.
    assert post_mcp(MCP_URL, ALL, body, headers={"Origin": MCP_URL}).status_code == 403


@needs_mcp
def test_structured_content_is_sent_only_to_a_protocol_that_has_it():
    # content[0].text holds the JSON of the tool for every client. structuredContent, the same JSON again, only for the clients of
    # 2025-06-18 and later, and for a request without the header (ARCH-B-073): the older ones do not read it.
    # The key of the second host: the calls of the others count on the rate limit of the all-data key (120 a minute).
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_databases", "arguments": {}}}
    answers = {}
    for version in (None, "2025-06-18", "2025-03-26", "2024-11-05"):
        response = post_mcp(MCP_URL, SECOND, body, headers={"MCP-Protocol-Version": version} if version else None)
        assert response.status_code == 200, (version, response.text)
        answers[version] = response.json()["result"]
    for version in (None, "2025-06-18"):
        assert json.loads(answers[version]["content"][0]["text"]) == answers[version]["structuredContent"], version
    for version in ("2025-03-26", "2024-11-05"):
        assert "structuredContent" not in answers[version], version
        assert answers[version]["isError"] is False
        assert json.loads(answers[version]["content"][0]["text"]) == answers[None]["structuredContent"], version
    # The same for a failed tool: the code and the message are in the text for every client.
    refused = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "describe_table", "arguments": {"database": "nope", "table": "nope"}}}
    old = post_mcp(MCP_URL, SECOND, refused, headers={"MCP-Protocol-Version": "2024-11-05"}).json()["result"]
    assert old["isError"] is True and "structuredContent" not in old and "error" in json.loads(old["content"][0]["text"]), old


@needs_mcp
def test_request_checks():
    body = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    response = post_mcp(MCP_URL, ALL, None, raw=json.dumps(body), headers={"Content-Type": "text/plain"})
    assert response.status_code == 415
    assert post_mcp(MCP_URL, ALL, None, raw=json.dumps(body), headers={"Content-Type": "application/json; charset=utf-8"}).status_code == 200
    assert SESSION.post(f"{MCP_URL}/mcp", data=json.dumps(body), headers={"Authorization": f"Bearer {ALL}"}, timeout=10).status_code in (415,)
    # Too big: 2 x max_sql_bytes + 16 KiB.
    big = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"pad": "x" * (2 * MAX_SQL + 17 * 1024)}})
    response = post_mcp(MCP_URL, ALL, None, raw=big)
    assert response.status_code == 413
    assert response.json()["error_code"] == "payload_too_large"
    # A protocol version header: a known one is fine, an unknown one is a 400.
    assert post_mcp(MCP_URL, ALL, body, headers={"MCP-Protocol-Version": "2025-06-18"}).status_code == 200
    assert post_mcp(MCP_URL, ALL, body, headers={"MCP-Protocol-Version": "2024-11-05"}).status_code == 200
    assert post_mcp(MCP_URL, ALL, body, headers={"MCP-Protocol-Version": "1999-01-01"}).status_code == 400
    # Order: Origin, then the key, then the rest.
    assert post_mcp(MCP_URL, "wrong", None, raw="x", headers={"Content-Type": "text/plain", "Origin": "https://evil.example.com"}).status_code == 403
    assert post_mcp(MCP_URL, "wrong", None, raw="x", headers={"Content-Type": "text/plain"}).status_code == 401
    # The server keeps answering after an early refusal that left a body unread.
    for _ in range(3):
        assert post_mcp(MCP_URL, "wrong", None, raw=big).status_code == 401
        assert post_mcp(MCP_URL, ALL, body).status_code == 200


@needs_mcp
def test_json_rpc_basics():
    # initialize negotiates.
    for version in ("2025-06-18", "2025-03-26", "2024-11-05"):
        result = rpc(MCP_URL, ALL, "initialize", {"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}).json()["result"]
        assert result["protocolVersion"] == version
        assert "tools" in result["capabilities"]
        assert result["serverInfo"]["name"] == "chdash"
        assert isinstance(result["instructions"], str)
    unknown = rpc(MCP_URL, ALL, "initialize", {"protocolVersion": "1999-01-01"}).json()["result"]
    assert unknown["protocolVersion"] == "2025-06-18"
    # ping, and the id comes back as it was sent.
    assert rpc(MCP_URL, ALL, "ping", id_="abc").json() == {"jsonrpc": "2.0", "id": "abc", "result": {}}
    assert rpc(MCP_URL, ALL, "ping", id_=7).json()["id"] == 7
    # Notifications and responses: 202, no body.
    for body in ({"jsonrpc": "2.0", "method": "notifications/initialized"},
                 {"jsonrpc": "2.0", "id": 3, "result": {}}):
        response = post_mcp(MCP_URL, ALL, body)
        assert response.status_code == 202 and response.text == ""
    # Unknown methods: -32601, as an ordinary JSON-RPC answer.
    for method in ("resources/list", "prompts/list", "logging/setLevel", "nope"):
        response = rpc(MCP_URL, ALL, method)
        assert response.status_code == 200
        assert response.json()["error"]["code"] == -32601
    # No batching.
    response = post_mcp(MCP_URL, ALL, [{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "id": 2, "method": "ping"}])
    assert response.status_code == 400
    assert response.json()["error"]["code"] == -32600
    response = post_mcp(MCP_URL, ALL, None, raw="{not json")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == -32700
    assert post_mcp(MCP_URL, ALL, {"id": 1, "method": "ping"}).status_code == 400
    assert rpc(MCP_URL, ALL, "tools/call", {"name": "nope"}).json()["error"]["code"] == -32602
    assert rpc(MCP_URL, ALL, "tools/call", {}).json()["error"]["code"] == -32602


@needs_mcp
def test_tools_list_is_filtered_by_the_key():
    def names(key):
        return [t["name"] for t in rpc(MCP_URL, key, "tools/list").json()["result"]["tools"]]

    every = [t["name"] for t in api_ok(m("GET", "/api/mcp/meta"))["tools"]]
    assert names(ALL) == every  # a key with "*" and all the data holds every tool, API tools included
    assert names(WEATHER) == ["list_hosts", "list_databases", "list_tables", "describe_table", "query_table"]
    # "*" never grants SQL without all data; it grants the observability tools, which read the otel tables.
    # A key with "*" holds every tool except the ones that need all the data (the SQL tools).
    meta_tools = api_ok(m("GET", "/api/mcp/meta"))["tools"]
    assert names(OTEL) == [t["name"] for t in meta_tools if not t["needs_all_data"]]
    assert not [n for n in names(OTEL) if n in ("run_query", "explain_query")]
    assert {"explorer_graph", "explorer_storage", "explorer_names"} <= set(names(OTEL))
    assert {"system_overview", "traces_search", "logs_search", "metrics_series", "search_traces"} <= set(names(OTEL))
    assert names(HOSTS_ONLY) == ["list_hosts"]
    for tool in rpc(MCP_URL, ALL, "tools/list").json()["result"]["tools"]:
        assert tool["inputSchema"]["type"] == "object"
        assert tool["description"]
        assert tool["annotations"]["readOnlyHint"] is True
        assert tool["annotations"]["destructiveHint"] is False


@needs_mcp
def test_a_tool_the_key_lacks_is_refused():
    fail_tool(MCP_URL, WEATHER, "run_query", {"sql": "SELECT 1"}, "tool_not_allowed")
    fail_tool(MCP_URL, OTEL, "explain_query", {"sql": "SELECT 1"}, "tool_not_allowed")
    fail_tool(MCP_URL, HOSTS_ONLY, "list_databases", {}, "tool_not_allowed")


def parse_time(text: str) -> float:
    """Unix seconds of a time of the answers (ISO 8601 UTC, as 2026-10-15T10:00:00Z)."""
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc).timestamp()


def usage_of(key_id: str, window: str = "24h", base: str | None = None) -> dict:
    """The usage of a key in a window (GET /api/mcp/keys/<id>/usage), from the page."""
    return api_ok(m("GET", f"/api/mcp/keys/{key_id}/usage?window={window}", base=base or MCP_URL))


@needs_mcp
def test_rate_limit_per_key():
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    limited_before = usage_of("rate-test")["totals"]["rate_limited"]
    seen = None
    for _ in range(140):  # 120 a minute: a burst of 120
        response = post_mcp(MCP_URL, RATE, body)
        if response.status_code == 429:
            seen = response
            break
        assert response.status_code == 200
    assert seen is not None, "no 429 after 140 calls"
    assert seen.json()["error_code"] == "rate_limited"
    assert 1 <= int(seen.headers["Retry-After"]) <= 60
    # Another key has its own bucket.
    assert post_mcp(MCP_URL, ALL, body).status_code == 200
    # One token comes back every half second.
    time.sleep(1.2)
    assert post_mcp(MCP_URL, RATE, body).status_code == 200
    # The refusal counts in the usage of the key.
    assert usage_of("rate-test")["totals"]["rate_limited"] >= limited_before + 1


# ---- schema tools -----------------------------------------------------------------------------------------------------


@needs_mcp
def test_list_hosts():
    # A key reads one host: the list has that one ("plain" has no mcp_uri: invisible).
    result = ok_tool(MCP_URL, ALL, "list_hosts")
    assert [h["name"] for h in result["hosts"]] == ["local"]
    assert result["hosts"][0]["label"] == "Local ClickHouse"
    assert all(h["healthy"] in (True, False, None) for h in result["hosts"])
    assert [h["name"] for h in ok_tool(MCP_URL, SECOND, "list_hosts")["hosts"]] == ["second"]
    only = ok_tool(MCP_URL, WEATHER, "list_hosts")
    assert [h["name"] for h in only["hosts"]] == ["local"]


@needs_mcp
def test_host_resolution():
    # The host is the one of the key, so the argument is optional. A host the key lacks, or one without mcp_uri: refused.
    assert ok_tool(MCP_URL, WEATHER, "list_databases")["host"] == "local"
    assert ok_tool(MCP_URL, WEATHER, "list_databases", {"host": "local"})["host"] == "local"
    assert ok_tool(MCP_URL, SECOND, "list_databases")["host"] == "second"
    fail_tool(MCP_URL, SECOND, "list_databases", {"host": "local"}, "host_not_allowed")
    fail_tool(MCP_URL, WEATHER, "list_databases", {"host": "second"}, "host_not_allowed")
    fail_tool(MCP_URL, ALL, "list_databases", {"host": "plain"}, "host_not_allowed")
    fail_tool(MCP_URL, ALL, "list_databases", {"host": "nope"}, "host_not_allowed")
    assert ok_tool(MCP_URL, ALL, "list_databases")["host"] == "local"


@needs_mcp
def test_list_databases_follows_the_scope():
    everything = {d["name"] for d in ok_tool(MCP_URL, ALL, "list_databases", {"host": "local"})["databases"]}
    assert {"chdash_ui", "otel", "system"} <= everything
    assert [d["name"] for d in ok_tool(MCP_URL, WEATHER, "list_databases")["databases"]] == ["chdash_ui"]
    assert [d["name"] for d in ok_tool(MCP_URL, OTEL, "list_databases")["databases"]] == ["otel"]
    filtered = ok_tool(MCP_URL, ALL, "list_databases", {"host": "local", "filter": "chdash_*"})["databases"]
    assert filtered and all(d["name"].startswith("chdash_") for d in filtered)


@needs_mcp
def test_list_tables_follows_the_scope():
    tables = ok_tool(MCP_URL, WEATHER, "list_tables")["tables"]
    names = {t["name"] for t in tables}
    assert "weather_observations" in names and "weather_daily_summary" in names
    assert all(t["database"] == "chdash_ui" and t["name"].startswith("weather_") for t in tables)
    assert "wide_types" not in names and "memory_weather" not in names
    first = next(t for t in tables if t["name"] == "weather_observations")
    # UInt64 values are strings of digits (docs/telemetry.md, "Result values").
    assert first["engine"] == "MergeTree" and int(first["total_rows"]) > 0 and int(first["total_bytes"]) > 0
    assert set(first) == {"database", "name", "engine", "total_rows", "total_bytes", "comment"}
    # database and filter.
    only = ok_tool(MCP_URL, WEATHER, "list_tables", {"database": "chdash_ui", "filter": "weather_observation*"})["tables"]
    assert {t["name"] for t in only} == {"weather_observations", "weather_observation_quality_join"}
    exact = ok_tool(MCP_URL, WEATHER, "list_tables", {"database": "chdash_ui", "filter": "weather_observations"})["tables"]
    assert [t["name"] for t in exact] == ["weather_observations"]
    fail_tool(MCP_URL, WEATHER, "list_tables", {"database": "otel"}, "database_not_allowed")
    fail_tool(MCP_URL, WEATHER, "list_tables", {"database": "system"}, "database_not_allowed")
    otel = ok_tool(MCP_URL, OTEL, "list_tables")["tables"]
    assert otel and all(t["database"] == "otel" for t in otel)
    # A key with max_rows = 5 is not cut by it: the scope filters after the read.
    many = ok_tool(MCP_URL, LIMITED, "list_tables", {"host": "local"})["tables"]
    assert len(many) > 5
    # An all-data key sees the system database too.
    system = ok_tool(MCP_URL, ALL, "list_tables", {"host": "local", "database": "system", "filter": "tab*"})["tables"]
    assert any(t["name"] == "tables" for t in system)
    # A filter is a glob, not a pattern: its other characters mean themselves.
    assert ok_tool(MCP_URL, ALL, "list_tables", {"host": "local", "database": "chdash_ui", "filter": "weather_.*"})["tables"] == []
    assert ok_tool(MCP_URL, ALL, "list_tables", {"host": "local", "database": "chdash_ui", "filter": "weather%"})["tables"] == []
    assert ok_tool(MCP_URL, ALL, "list_tables", {"host": "local", "database": "chdash_ui", "filter": "weather_o_servations"})["tables"] == []


@needs_mcp
def test_describe_table():
    info = ok_tool(MCP_URL, WEATHER, "describe_table", {"database": "chdash_ui", "table": "weather_observations"})
    assert info["engine"] == "MergeTree"
    assert info["database"] == "chdash_ui" and info["table"] == "weather_observations"
    assert "CREATE TABLE" in info["create_table_query"]
    assert info["sorting_key"] and info["partition_key"]
    assert int(info["total_rows"]) > 0
    columns = {c["name"]: c for c in info["columns"]}
    assert columns["observed_at"]["type"] == "DateTime64(3)"
    assert columns["observation_date"]["default_kind"] == "MATERIALIZED"
    assert columns["observation_date"]["in_partition_key"] is True
    assert columns["observation_date"]["in_sorting_key"] is True
    assert columns["temperature_c"]["comment"].startswith("Air temperature")
    assert set(columns["id"]) == {"name", "type", "default_kind", "default_expression", "comment", "in_partition_key",
                                  "in_sorting_key", "in_primary_key", "in_sampling_key"}
    fail_tool(MCP_URL, WEATHER, "describe_table", {"database": "chdash_ui", "table": "wide_types"}, "table_not_allowed")
    fail_tool(MCP_URL, WEATHER, "describe_table", {"database": "otel", "table": "otel_logs"}, "table_not_allowed")
    fail_tool(MCP_URL, WEATHER, "describe_table", {"database": "chdash_ui", "table": "weather_nope"}, "table_not_found")
    fail_tool(MCP_URL, WEATHER, "describe_table", {"database": "chdash_ui"}, "invalid_argument")
    fail_tool(MCP_URL, WEATHER, "describe_table", {"database": "chdash_ui", "table": "weather_observations", "extra": 1}, "invalid_argument")
    # All data: any table, system ones too.
    assert ok_tool(MCP_URL, ALL, "describe_table", {"host": "local", "database": "system", "table": "one"})["columns"][0]["name"] == "dummy"


# ---- query_table ---------------------------------------------------------------------------------------------------------


@needs_mcp
def test_query_table_filters_order_and_types():
    result = ok_tool(MCP_URL, WEATHER, "query_table", {
        "database": "chdash_ui", "table": "weather_observations",
        "columns": ["id", "city", "temperature_c", "quality_ok", "observed_at"],
        "filters": [{"column": "city", "op": "=", "value": "Lisbon"}, {"column": "id", "op": "<=", "value": 200}],
        "order_by": [{"column": "id", "direction": "asc"}], "limit": 5})
    assert [c["name"] for c in result["columns"]] == ["id", "city", "temperature_c", "quality_ok", "observed_at"]
    assert result["row_count"] == 5 == len(result["rows"])
    assert result["truncated"] is False
    assert result["limit"] == 5
    # A UInt64 is the string of its digits (docs/telemetry.md, "Result values").
    ids = [int(r[0]) for r in result["rows"]]
    assert all(isinstance(r[0], str) for r in result["rows"])
    assert ids == sorted(ids) and all(i <= 200 for i in ids)
    assert all(r[1] == "Lisbon" for r in result["rows"])
    assert isinstance(result["rows"][0][2], float) and result["rows"][0][3] is True  # numbers and booleans are JSON values
    assert result["rows"][0][4].startswith("2026-")
    if CLICKHOUSE_URL:
        expected = ch("SELECT id FROM chdash_ui.weather_observations WHERE city = 'Lisbon' AND id <= 200 ORDER BY id LIMIT 5 FORMAT TSV").split()
        assert [str(i) for i in ids] == expected
    # in, not_in, like, ilike, not_like, is_null, is_not_null, !=, >, >=, <.
    base = {"database": "chdash_ui", "table": "weather_observations", "columns": ["id"], "order_by": [{"column": "id"}], "limit": 100}

    def ids_for(*filters):
        return [int(r[0]) for r in ok_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": list(filters)})["rows"]]

    assert ids_for({"column": "id", "op": "in", "value": [3, 5, 7]}) == [3, 5, 7]
    assert ids_for({"column": "id", "op": "in", "value": ["3", 5]}) == [3, 5]
    not_in = ids_for({"column": "id", "op": "not_in", "value": [1, 2, 3]}, {"column": "id", "op": "<", "value": 7})
    assert not_in == [0, 4, 5, 6]
    assert ids_for({"column": "id", "op": ">=", "value": 5}, {"column": "id", "op": "<", "value": 8}) == [5, 6, 7]
    assert ids_for({"column": "id", "op": ">", "value": 5}, {"column": "id", "op": "!=", "value": 7}, {"column": "id", "op": "<=", "value": 8}) == [6, 8]
    assert ids_for({"column": "station_id", "op": "like", "value": "WX-LIS-03"}, {"column": "id", "op": "<", "value": 10})
    assert ids_for({"column": "station_id", "op": "ilike", "value": "wx-lis-03"}, {"column": "id", "op": "<", "value": 10}) == \
        ids_for({"column": "station_id", "op": "like", "value": "WX-LIS-03"}, {"column": "id", "op": "<", "value": 10})
    assert ids_for({"column": "station_id", "op": "like", "value": "wx-lis-03"}) == []
    like_ids = ids_for({"column": "station_id", "op": "like", "value": "WX-LIS-%"}, {"column": "id", "op": "<", "value": 20})
    not_like_ids = ids_for({"column": "station_id", "op": "not_like", "value": "WX-LIS-%"}, {"column": "id", "op": "<", "value": 20})
    assert like_ids and not set(like_ids) & set(not_like_ids)
    assert sorted(like_ids + not_like_ids) == list(range(0, 20))
    not_null = ids_for({"column": "notes", "op": "is_not_null"}, {"column": "id", "op": "<", "value": 5})
    nulls = ids_for({"column": "notes", "op": "is_null"}, {"column": "id", "op": "<", "value": 5})
    assert sorted(not_null + nulls) == [0, 1, 2, 3, 4]
    # A boolean column and a date-time bound.
    assert all(r[0] for r in ok_tool(MCP_URL, WEATHER, "query_table", {**base, "columns": ["quality_ok"], "filters": [{"column": "quality_ok", "op": "=", "value": True}], "limit": 5})["rows"])
    bounded = ok_tool(MCP_URL, WEATHER, "query_table", {**base, "columns": ["observed_at"], "limit": 3,
                      "filters": [{"column": "observed_at", "op": ">=", "value": "2026-09-01 00:00:00"}, {"column": "observed_at", "op": "<", "value": "2026-09-01 00:00:10"}]})
    assert 0 < bounded["row_count"] <= 3


@needs_mcp
def test_query_table_never_lets_a_value_become_sql():
    base = {"database": "chdash_ui", "table": "weather_observations", "columns": ["id"], "limit": 100}
    total = ok_tool(MCP_URL, WEATHER, "query_table", {**base})["row_count"]
    assert total == 100
    for evil in ("x' OR '1'='1", "x\\' OR 1=1 --", "'; DROP TABLE chdash_ui.weather_observations; --", "%", "Lisbon' --"):
        result = ok_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": [{"column": "city", "op": "=", "value": evil}]})
        assert result["rows"] == [], evil
        result = ok_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": [{"column": "city", "op": "in", "value": [evil, evil]}]})
        assert result["rows"] == [], evil
    # Numbers must be numbers.
    for evil in ("1 OR 1=1", "1; SELECT 1", "0x10", "1e1000000", "-1"):
        fail_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": [{"column": "id", "op": "=", "value": evil}]}, "invalid_argument")
    fail_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": [{"column": "id", "op": "=", "value": None}]}, "invalid_argument")
    fail_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": [{"column": "id", "op": "=", "value": {"a": 1}}]}, "invalid_argument")
    # Column names come from the real list: nothing else is accepted, not even a quoted expression.
    for column in ("id) FROM chdash_ui.weather_observations --", "`id`", "id, city", "*", "1", "ID"):
        fail_tool(MCP_URL, WEATHER, "query_table", {**base, "columns": [column]}, "unknown_column")
        fail_tool(MCP_URL, WEATHER, "query_table", {**base, "order_by": [{"column": column}]}, "unknown_column")
        fail_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": [{"column": column, "op": "is_null"}]}, "unknown_column")
    fail_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": [{"column": "id", "op": "= 1 OR 1 =", "value": 1}]}, "invalid_argument")
    fail_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": [{"column": "id", "op": "like", "value": "1%"}]}, "unsupported_column_type")
    fail_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": [{"column": "tags", "op": "=", "value": "a"}]}, "unsupported_column_type")
    # Identifiers of the table are scope-checked and quoted, not trusted.
    fail_tool(MCP_URL, WEATHER, "query_table", {"database": "chdash_ui`.`weather_observations", "table": "x"}, "table_not_allowed")
    fail_tool(MCP_URL, WEATHER, "query_table", {"database": "chdash_ui", "table": "weather_observations`; DROP"}, "table_not_found")
    fail_tool(MCP_URL, ALL, "query_table", {"host": "local", "database": "chdash_ui", "table": "weather_observations` --"}, "table_not_found")


@needs_mcp
def test_query_table_scope():
    fail_tool(MCP_URL, WEATHER, "query_table", {"database": "chdash_ui", "table": "wide_types"}, "table_not_allowed")
    fail_tool(MCP_URL, WEATHER, "query_table", {"database": "otel", "table": "otel_logs"}, "table_not_allowed")
    fail_tool(MCP_URL, WEATHER, "query_table", {"database": "system", "table": "tables"}, "table_not_allowed")
    fail_tool(MCP_URL, OTEL, "query_table", {"database": "chdash_ui", "table": "weather_observations"}, "table_not_allowed")
    ok_tool(MCP_URL, OTEL, "query_table", {"database": "otel", "table": "otel_logs", "columns": ["Timestamp"], "limit": 1})
    # A table that does not exist inside the scope is not found, not forbidden.
    fail_tool(MCP_URL, WEATHER, "query_table", {"database": "chdash_ui", "table": "weather_nope"}, "table_not_found")


@needs_mcp
def test_query_table_caps_and_truncated():
    base = {"database": "chdash_ui", "table": "weather_observations", "columns": ["id"]}
    # The global cap is 100 rows; the key's cap lowers it, never raises it.
    result = ok_tool(MCP_URL, WEATHER, "query_table", {**base, "limit": 500})
    assert result["row_count"] == MAX_ROWS and result["truncated"] is True and result["limit"] == MAX_ROWS
    result = ok_tool(MCP_URL, WEATHER, "query_table", {**base, "limit": 40})
    assert result["row_count"] == 40 and result["truncated"] is False
    default = ok_tool(MCP_URL, WEATHER, "query_table", base)  # the default limit is 100
    assert default["row_count"] == 100 and default["limit"] == 100
    limited = ok_tool(MCP_URL, LIMITED, "query_table", {**base})
    assert limited["row_count"] == 5 and limited["truncated"] is True and limited["limit"] == 5
    limited = ok_tool(MCP_URL, LIMITED, "query_table", {**base, "limit": 3})
    assert limited["row_count"] == 3 and limited["truncated"] is False
    assert ok_tool(MCP_URL, OTEL, "query_table", {"database": "otel", "table": "otel_logs", "columns": ["Timestamp"]})["row_count"] == 10
    for bad in (0, -1, "5", 1.5, [1]):
        fail_tool(MCP_URL, WEATHER, "query_table", {**base, "limit": bad}, "invalid_argument")


@needs_clickhouse
def test_query_table_omits_wide_columns(scratch):
    result = ok_tool(MCP_URL, ALL, "query_table", {"host": "local", "database": "mcp_scratch", "table": "wide", "order_by": [{"column": "id"}], "limit": 3})
    assert [c["name"] for c in result["columns"]] == ["id", "small", "note"]
    assert [o["name"] for o in result["omitted_columns"]] == ["big"]
    assert result["omitted_columns"][0]["reason"] == "wide" and result["omitted_columns"][0]["type"] == "String"
    # Asking for the column returns it.
    explicit = ok_tool(MCP_URL, ALL, "query_table", {"host": "local", "database": "mcp_scratch", "table": "wide", "columns": ["id", "big"], "limit": 2})
    assert "omitted_columns" not in explicit
    assert len(explicit["rows"][0][1]) == 5000
    # Nulls come back as JSON null.
    notes = ok_tool(MCP_URL, ALL, "query_table", {"host": "local", "database": "mcp_scratch", "table": "wide", "columns": ["note"], "order_by": [{"column": "id"}], "limit": 2})
    assert notes["rows"] == [[None], ["odd"]]
    # The byte cap cuts a result of wide rows: 20000 bytes hold about 3 rows of 5000.
    wide = ok_tool(MCP_URL, ALL, "query_table", {"host": "local", "database": "mcp_scratch", "table": "wide", "columns": ["big"], "limit": 30})
    assert 1 <= wide["row_count"] <= 4 and wide["truncated"] is True


# ---- run_query, explain_query -----------------------------------------------------------------------------------------------


@needs_mcp
def test_run_query_reads():
    result = ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT number AS n, toString(number) AS s, number / 2 AS h FROM system.numbers LIMIT 3"})
    assert result["columns"] == [{"name": "n", "type": "UInt64"}, {"name": "s", "type": "String"}, {"name": "h", "type": "Float64"}]
    assert result["rows"] == [["0", "0", 0.0], ["1", "1", 0.5], ["2", "2", 1.0]]
    assert result["row_count"] == 3 and result["truncated"] is False and result["elapsed_ms"] >= 0
    # A trailing semicolon is fine; strings and comments may hold one.
    assert ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT 'a;b' AS x -- ; not a second statement\n;"})["rows"] == [["a;b"]]
    for sql in ("SHOW TABLES FROM chdash_ui", "DESCRIBE TABLE chdash_ui.weather_observations", "EXISTS TABLE chdash_ui.weather_observations",
                "EXPLAIN SELECT 1", "WITH 1 AS x SELECT x + 1", "SHOW CREATE TABLE chdash_ui.weather_observations"):
        assert ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": sql})["row_count"] >= 1, sql
    assert ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT 1 FORMAT JSON"})["rows"] == [[1]]


@needs_mcp
def test_run_query_refuses_what_is_not_one_read_statement():
    def code_of(sql, expected):
        fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": sql}, expected)

    code_of("SELECT 1; SELECT 2", "multiple_statements")
    code_of("SELECT 1; DROP TABLE chdash_ui.memory_weather", "multiple_statements")
    code_of("SELECT 1;;", "multiple_statements")
    code_of("SELECT 'a\\'; DROP TABLE x", "invalid_sql")
    code_of("SELECT 'unterminated", "invalid_sql")
    code_of("", "invalid_argument")
    code_of("-- nothing here", "empty_sql")
    for sql in ("DROP TABLE chdash_ui.memory_weather", "INSERT INTO chdash_ui.memory_weather VALUES (1)", "ALTER TABLE chdash_ui.memory_weather DELETE WHERE 1",
                "TRUNCATE TABLE chdash_ui.memory_weather", "CREATE TABLE chdash_ui.x (a Int8) ENGINE = Memory", "SET readonly = 0", "SYSTEM FLUSH LOGS",
                "KILL QUERY WHERE 1", "GRANT SELECT ON *.* TO chdash_mcp", "USE chdash_ui", "OPTIMIZE TABLE chdash_ui.weather_observations"):
        code_of(sql, "statement_not_allowed")
    code_of("SELECT * FROM chdash_ui.memory_weather INTO OUTFILE '/tmp/x'", "clause_not_allowed")
    for fn in ("file('/etc/passwd', 'CSV')", "url('http://127.0.0.1:8123', 'CSV')", "remote('127.0.0.1', system.one)", "s3('http://x/y')", "mysql('h', 'd', 't', 'u', 'p')"):
        code_of(f"SELECT * FROM {fn}", "function_not_allowed")
    code_of("SELECT '" + "x" * MAX_SQL + "'", "sql_too_large")
    fail_tool(MCP_URL, ALL, "run_query", {"host": "local"}, "invalid_argument")
    fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": 5}, "invalid_argument")


@needs_mcp
def test_a_statement_cannot_change_its_settings():
    # Settings cannot be changed from inside the statement: the SETTINGS clause is refused before ClickHouse sees it (readonly
    # = 1 would lock them too, but a profile at readonly = 2 would not: test_a_readonly_2_user_cannot_raise_a_limit).
    for setting in ("readonly = 0", "max_result_rows = 0", "max_execution_time = 3600", "max_memory_usage = 0", "max_rows_to_read = 0", "result_overflow_mode = 'throw'"):
        payload = fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": f"SELECT 1 SETTINGS {setting}"})
        assert payload["error"] == "clause_not_allowed", (setting, payload)
    fail_tool(MCP_URL, ALL, "explain_query", {"host": "local", "sql": "SELECT 1 SETTINGS max_execution_time = 3600"}, "clause_not_allowed")
    assert ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT 1"})["rows"] == [[1]]


@needs_clickhouse
def test_readonly_stops_a_write_even_with_the_grant(scratch):
    # Give the MCP user the INSERT grant it must never have: readonly = 1 still stops the write.
    ch("GRANT INSERT ON mcp_scratch.sink TO chdash_mcp")
    try:
        for sql in ("WITH 1 AS x INSERT INTO mcp_scratch.sink SELECT x", "INSERT INTO mcp_scratch.sink VALUES (1)"):
            payload = fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": sql})
            assert payload["error"] in ("readonly", "statement_not_allowed"), payload
        assert ch("SELECT count() FROM mcp_scratch.sink").strip() == "0"
        # And for a mutation of what the user can read.
        ch("GRANT ALTER DELETE, ALTER UPDATE ON mcp_scratch.wide TO chdash_mcp")
        try:
            fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "ALTER TABLE mcp_scratch.wide DELETE WHERE 1"}, "statement_not_allowed")
        finally:
            ch("REVOKE ALTER DELETE, ALTER UPDATE ON mcp_scratch.wide FROM chdash_mcp")
        assert int(ch("SELECT count() FROM mcp_scratch.wide")) == 30
    finally:
        ch("REVOKE INSERT ON mcp_scratch.sink FROM chdash_mcp")


@needs_mcp
def test_clickhouse_grants_are_the_boundary():
    for sql in ("SELECT * FROM system.users", "SELECT * FROM system.query_log", "SELECT * FROM system.processes",
                "SELECT * FROM system.clusters", "SELECT * FROM default.nothing"):
        payload = fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": sql})
        assert payload["error"] in ("permission_denied", "not_found"), (sql, payload)
    # Even an all-data key sees only what the ClickHouse user may see.
    names = {d["name"] for d in ok_tool(MCP_URL, ALL, "list_databases", {"host": "local"})["databases"]}
    assert "default" not in names
    tables = {t["name"] for t in ok_tool(MCP_URL, ALL, "list_tables", {"host": "local", "database": "system"})["tables"]}
    assert "users" not in tables and "query_log" not in tables


@needs_mcp
def test_row_and_byte_caps_on_free_sql():
    result = ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT number FROM system.numbers LIMIT 1000"})
    assert result["row_count"] == MAX_ROWS and result["truncated"] is True
    result = ok_tool(MCP_URL, LIMITED, "run_query", {"host": "local", "sql": "SELECT number FROM system.numbers LIMIT 1000"})
    assert result["row_count"] == 5 and result["truncated"] is True
    exact = ok_tool(MCP_URL, LIMITED, "run_query", {"host": "local", "sql": "SELECT number FROM system.numbers LIMIT 5"})
    assert exact["row_count"] == 5 and exact["truncated"] is False
    # Bytes: 50 rows of 1000 characters is 50 KB; the cap is 20 KB.
    wide = ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT repeat('x', 1000) AS s FROM system.numbers LIMIT 50"})
    assert 1 <= wide["row_count"] < 50 and wide["truncated"] is True
    assert sum(len(r[0]) for r in wide["rows"]) <= MAX_BYTES
    # One row bigger than the cap: nothing fits, and it says so.
    huge = ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT repeat('x', 100000) AS s"})
    assert huge["rows"] == [] and huge["truncated"] is True
    # The caps of the key never exceed the server's.
    assert ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT number FROM system.numbers LIMIT 50"})["row_count"] == 50


@needs_mcp
def test_timeout_and_read_limit():
    started = time.time()
    payload = fail_tool(MCP_URL, LIMITED, "run_query", {"host": "local", "sql": "SELECT sleep(3)"}, "timeout")  # the key allows 1 s
    assert time.time() - started < 4.5
    assert "DB::Exception" in payload["message"]
    # Under the global timeout of 5 s the same statement works.
    assert ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT sleep(1)"})["row_count"] == 1
    # max_rows_to_read = 5,000,000.
    fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT count() FROM (SELECT number FROM system.numbers LIMIT 10000000)"}, "read_limit")
    # A syntax error and an unknown table are tool errors, not transport errors.
    fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT FROM WHERE"}, "syntax_error")
    fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": "SELECT * FROM chdash_ui.no_such_table"}, "not_found")


@needs_mcp
def test_explain_query():
    for kind in ("plan", "pipeline", "ast", "syntax", "estimate"):
        result = ok_tool(MCP_URL, ALL, "explain_query", {"host": "local", "sql": "SELECT id FROM chdash_ui.weather_observations WHERE id < 5", "type": kind})
        assert result["type"] == kind
        assert result.get("lines") or result.get("rows"), kind
    plan = ok_tool(MCP_URL, ALL, "explain_query", {"host": "local", "sql": "SELECT 1"})
    assert plan["type"] == "plan" and any("ReadFromSystemOne" in line for line in plan["lines"])
    assert ok_tool(MCP_URL, ALL, "explain_query", {"host": "local", "sql": "SELECT id FROM chdash_ui.weather_observations", "indexes": True})["lines"]
    fail_tool(MCP_URL, ALL, "explain_query", {"host": "local", "sql": "INSERT INTO chdash_ui.memory_weather VALUES (1)"}, "statement_not_allowed")
    fail_tool(MCP_URL, ALL, "explain_query", {"host": "local", "sql": "EXPLAIN SELECT 1"}, "statement_not_allowed")
    fail_tool(MCP_URL, ALL, "explain_query", {"host": "local", "sql": "SELECT 1; SELECT 2"}, "multiple_statements")
    fail_tool(MCP_URL, ALL, "explain_query", {"host": "local", "sql": "SELECT 1", "type": "bogus"}, "invalid_argument")


@needs_logs
def test_audit_lines_never_hold_sql_or_data():
    marker = f"audit_marker_{uuid.uuid4().hex[:8]}"
    ok_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": f"SELECT '{marker}' AS secret_value"})
    post_mcp(MCP_URL, "chm_nope", {"jsonrpc": "2.0", "id": 1, "method": "ping"})
    # A JSON-RPC error names its method; a message that could not be read has none ("request"); a method is cut at 128 bytes.
    # The key that only lists hosts: the all-data key has spent its rate limit (120 a minute) by this time of the run.
    assert rpc(MCP_URL, HOSTS_ONLY, "resources/list").json()["error"]["code"] == -32601
    assert rpc(MCP_URL, HOSTS_ONLY, "m" * 300).json()["error"]["code"] == -32601
    assert post_mcp(MCP_URL, HOSTS_ONLY, None, raw="{not json").status_code == 400
    time.sleep(0.3)
    log = subprocess.run(LOGS_CMD, shell=True, capture_output=True, text=True, timeout=30)
    text = log.stdout + log.stderr
    assert marker not in text
    # One JSON line for each call (docs/operations.md, "Logs").
    events = [json.loads(line) for line in text.splitlines() if line.startswith("{") and '"event":"mcp.call"' in line]
    calls = [e for e in events if e["call"] == "tools/call:run_query"]
    assert calls
    last = calls[-1]
    assert last["key"] == "all-data" and last["host"] == "local" and last["status"] == "ok" and "duration_ms" in last and last["rows"] == 1
    assert any(e["status"] == "401_unknown" for e in events)
    assert any(e["call"] == "resources/list" and e["status"] == "rpc_error_32601" and e["key"] == "hosts-only" for e in events)
    assert any(e["call"] == "m" * 128 and e["status"] == "rpc_error_32601" for e in events) and "m" * 129 not in text
    assert any(e["call"] == "request" and e["status"] == "rpc_error_32700" and e["key"] == "hosts-only" for e in events)
    assert ALL not in text and "chm_nope" not in text


# ---- keys: the page API ------------------------------------------------------------------------------------------------------------


KEY_FIELDS = {"id", "name", "source", "secret_hint", "secret_mask", "hosts", "tools", "databases", "max_rows",
              "timeout_seconds", "created_at", "last_used_at"}


@needs_mcp
def test_list_keys_config_keys_first():
    body = api_ok(m("GET", "/api/mcp/keys"))
    keys = body["keys"]
    config = [k for k in keys if k["source"] == "config"]
    assert keys[:len(config)] == config  # config keys first
    by_name = {k["name"]: k for k in config}
    assert {"all-data", "weather-only", "otel-reader", "limited"} <= set(by_name)
    for key in keys:
        assert set(key) == KEY_FIELDS
    key = by_name["weather-only"]
    # A key shows its hint (the first 8 characters of the secret), never the secret.
    assert key["id"] == "weather-only" and key["secret_hint"] == WEATHER[:8]
    # The mask of the secret: the shape of a UUID, the hint in clear, a bullet for the rest.
    bullets = "".join("-" if c == "-" else "\u2022" for c in WEATHER[8:])
    assert key["secret_mask"] == WEATHER[:8] + bullets and len(key["secret_mask"]) == len(WEATHER) and "-" in key["secret_mask"][8:]
    # Every key of the configuration has a hint and a host.
    assert all(len(k["secret_hint"]) == 8 and len(k["hosts"]) == 1 for k in config), [k["name"] for k in config]
    assert key["hosts"] == ["local"] and key["databases"] == ["chdash_ui.weather_*"]
    assert key["tools"] == ["list_hosts", "list_databases", "list_tables", "describe_table", "query_table"]
    assert key["max_rows"] is None and key["timeout_seconds"] is None
    assert key["created_at"] is None
    assert by_name["limited"]["max_rows"] == 5 and by_name["limited"]["timeout_seconds"] == 1
    assert by_name["all-data"]["hosts"] == ["local"] and by_name["all-data"]["databases"] == ["*"]
    assert by_name["second-host"]["hosts"] == ["second"]
    # The list never carries a secret or a hash.
    text = json.dumps(body)
    for secret in (ALL, WEATHER, hashlib.sha256(ALL.encode()).hexdigest()):
        assert secret not in text
    # No route gives the secret of a key: not of a config key, not of a page key (SEC-009).
    for key_id in ("weather-only", "all-data"):
        response = m("GET", f"/api/mcp/keys/{key_id}/secret")
        assert response.status_code == 404 and WEATHER not in response.text and ALL not in response.text


@needs_mcp
def test_key_lifecycle():
    # A key is made or deleted: there is no edit, no rotation and no switch.
    key, secret = make_key(new_key_body(
        "lifecycle-a", hosts=["local"], tools=["list_hosts", "query_table"], databases=["otel", "analytics.events"],
        max_rows=7, timeout_seconds=3))
    try:
        assert set(key) == KEY_FIELDS
        assert key["source"] == "ui" and key["id"].startswith("ui_") and len(key["id"]) == 15
        assert key["name"] == "lifecycle-a"
        assert key["hosts"] == ["local"] and key["tools"] == ["list_hosts", "query_table"]
        assert key["databases"] == ["otel", "analytics.events"]
        assert key["max_rows"] == 7 and key["timeout_seconds"] == 3 and key["last_used_at"] is None
        assert key["created_at"].endswith("Z")
        assert UUID4.fullmatch(secret)
        assert key["secret_hint"] == secret[:8]
        assert key["secret_mask"].startswith(secret[:8]) and secret[9:] not in key["secret_mask"]
        # Listed with the config keys, after them, without the secret.
        listed = api_ok(m("GET", "/api/mcp/keys"))
        assert secret not in json.dumps(listed)
        assert any(k["id"] == key["id"] for k in listed["keys"])
        # The secret works at once, with the scope of the key.
        assert [t["name"] for t in rpc(MCP_URL, secret, "tools/list").json()["result"]["tools"]] == ["list_hosts", "query_table"]
        assert [h["name"] for h in ok_tool(MCP_URL, secret, "list_hosts")["hosts"]] == ["local"]
        fail_tool(MCP_URL, secret, "query_table", {"host": "local", "database": "chdash_ui", "table": "weather_observations"}, "table_not_allowed")
        again = next(k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["id"] == key["id"])
        assert again["last_used_at"] and again["last_used_at"].endswith("Z")
        # The secret came once, in the answer of the create: no route gives it again.
        response = m("GET", f"/api/mcp/keys/{key['id']}/secret")
        assert response.status_code == 404 and secret not in response.text
        # There is no route to change a key.
        for method, path in (("PATCH", f"/api/mcp/keys/{key['id']}"), ("PUT", f"/api/mcp/keys/{key['id']}"), ("POST", f"/api/mcp/keys/{key['id']}/rotate")):
            assert m(method, path, body={"name": "other"}).status_code in (404, 405)
        assert rpc(MCP_URL, secret, "ping").status_code == 200
        # Delete.
        assert api_ok(m("DELETE", f"/api/mcp/keys/{key['id']}")) == {"ok": True, "id": key["id"]}
        assert rpc(MCP_URL, secret, "ping").status_code == 401
        api_error(m("DELETE", f"/api/mcp/keys/{key['id']}"), 404, "not_found")
        assert key["id"] not in json.dumps(api_ok(m("GET", "/api/mcp/keys")))
    finally:
        drop_key(key["id"])


@needs_mcp
def test_usage_of_a_key():
    # What a key did: its requests, tool calls, errors and refusals, by tool and by result, and its clients.
    key, secret = make_key(new_key_body("usage-key", tools=["list_hosts", "query_table"]))
    agent = {"User-Agent": "pytest-usage/1"}
    try:
        empty = usage_of(key["id"])
        assert empty["totals"]["calls"] == 0 and empty["last_used_at"] is None and empty["deleted_at"] is None
        assert empty["clients"] == [] and empty["tools"] == [] and empty["statuses"] == []
        init = rpc(MCP_URL, secret, "initialize", {"protocolVersion": "2025-06-18", "clientInfo": {"name": "pytest-client", "version": "1.2"}}, headers=agent)
        assert init.status_code == 200
        assert rpc(MCP_URL, secret, "tools/list", headers=agent).status_code == 200
        assert rpc(MCP_URL, secret, "nope/nothing", headers=agent).json()["error"]["code"] == -32601
        ok = call_tool(MCP_URL, secret, "list_hosts")
        assert ok["isError"] is False
        fail_tool(MCP_URL, secret, "query_table", {"host": "local", "database": "otel", "table": "otel_traces", "limit": 1}, "table_not_allowed")
        refused = SESSION.post(f"{MCP_URL}/mcp", data="{}", headers={"Authorization": f"Bearer {secret}", "Content-Type": "text/plain"}, timeout=10)
        assert refused.status_code == 415

        usage = usage_of(key["id"])
        assert usage["id"] == key["id"] and usage["name"] == "usage-key" and usage["host"] == "local" and usage["source"] == "ui"
        assert usage["window"] == "24h" and usage["persisted"] is True and usage["retention_days"] == 90
        totals = usage["totals"]
        assert totals["requests"] == 6 and totals["calls"] == 2, totals
        assert totals["errors"] == 2 and totals["rejected"] == 1 and totals["rate_limited"] == 0, totals
        assert totals["duration_ms_max"] >= totals["duration_ms_avg"] >= 0 and totals["bytes"] > 0
        assert {t["tool"]: (t["calls"], t["errors"]) for t in usage["tools"]} == {"list_hosts": (1, 0), "query_table": (1, 1)}
        assert {s["status"]: s["count"] for s in usage["statuses"]} == {
            "ok": 1, "table_not_allowed": 1, "rpc_error_32601": 1, "415_unsupported_media_type": 1}
        # One point for each 15 minutes (the step is a number of seconds); the requests are in the last one (or the one before it, at the
        # turn of a step).
        points = usage["series"]["points"]
        assert usage["series"]["step"] == 900 and len(points) == 96
        assert sum(p["calls"] for p in points[-2:]) == 2 and sum(p["requests"] for p in points) == 6
        # The client named itself in initialize; the requests after it with its User-Agent are its own.
        named = [c for c in usage["clients"] if c["name"] == "pytest-client"]
        assert len(named) == 1 and named[0]["version"] == "1.2" and named[0]["user_agent"] == "pytest-usage/1" and named[0]["requests"] == 3
        assert usage["first_used_at"] <= usage["last_used_at"]
        # The column of the page: every key in one answer, the same counts.
        summary = api_ok(m("GET", "/api/mcp/usage?window=7d"))
        assert summary["window"] == "7d" and summary["persisted"] is True
        row = next(k for k in summary["keys"] if k["id"] == key["id"])
        assert (row["requests"], row["calls"], row["errors"], row["rejected"]) == (6, 2, 2, 1)
        ids = [k["id"] for k in summary["keys"]]
        assert ids[:len(api_ok(m("GET", "/api/mcp/keys"))["keys"])] == [k["id"] for k in api_ok(m("GET", "/api/mcp/keys"))["keys"]]
        assert next(k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["id"] == key["id"])["last_used_at"] == usage["last_used_at"]
        # Never a secret, never SQL.
        for text in (json.dumps(usage), json.dumps(summary)):
            assert secret not in text and secret[9:] not in text and "SELECT" not in text
        # A window that the retention does not keep, a key that exists nowhere.
        api_error(m("GET", f"/api/mcp/keys/{key['id']}/usage?window=365d"), 400, "validation", field="window", reason="invalid")
        api_error(m("GET", "/api/mcp/usage?window=48h"), 400, "validation", field="window", reason="invalid")
        api_error(m("GET", "/api/mcp/keys/ui_000000000000/usage"), 404, "not_found")
        # Each window has the step of its tier, in seconds, and the points of its window; the requests are in all of them.
        for window, step, count in (("1h", 60, 60), ("6h", 300, 72), ("24h", 900, 96), ("7d", 10800, 56), ("30d", 43200, 60), ("90d", 86400, 90)):
            each = usage_of(key["id"], window)
            assert each["series"]["step"] == step and isinstance(each["series"]["step"], int), window
            assert len(each["series"]["points"]) == count and each["totals"]["requests"] == 6, window
            assert sum(p["requests"] for p in each["series"]["points"]) == 6, window
        # A deleted key keeps its usage: it is listed after the keys, with when it was deleted.
        drop_key(key["id"])
        gone = usage_of(key["id"])
        assert gone["deleted_at"] and gone["totals"]["calls"] == 2
        listed = api_ok(m("GET", "/api/mcp/usage"))["keys"]
        row = next(k for k in listed if k["id"] == key["id"])
        assert row["deleted_at"] == gone["deleted_at"] and row["calls"] == 2
        assert all(k["deleted_at"] is None for k in listed[:listed.index(row)] if k["source"] == "config")
    finally:
        drop_key(key["id"])


OVERVIEW_FIELDS = {"window", "from", "to", "since", "persisted", "retention_days", "group", "filters", "totals", "series", "keys", "methods",
                   "results", "types", "clients", "omitted"}
OVERVIEW_FILTERS = ("key", "method", "client", "result", "type")
SERIES_METRICS = ("requests", "errors", "calls", "duration_ms_sum", "bytes")
OVERVIEW_TOTALS = {"requests", "calls", "errors", "rate_limited", "rejected", "duration_ms_avg", "duration_ms_max", "rows", "bytes", "active_keys", "keys"}
OVERVIEW_KEY = {"id", "name", "host", "source", "deleted_at", "requests", "calls", "errors", "rate_limited", "rejected", "duration_ms_avg",
                "duration_ms_max", "rows", "bytes", "last_used_at"}
OVERVIEW_METHOD = {"method", "kind", "requests", "errors", "duration_ms_avg", "duration_ms_max", "rows", "bytes", "keys"}
OVERVIEW_CLIENT = {"client", "requests", "calls", "errors", "rate_limited", "rejected", "duration_ms_avg", "duration_ms_max", "rows", "bytes",
                   "keys", "versions", "last_seen_at"}
# A client that was chosen and has no request: zeros, no time, no version and no sight (a name that no key ever had).
OVERVIEW_CLIENT_ZERO = {"client": "nobody-has-this-name", "requests": 0, "calls": 0, "errors": 0, "rate_limited": 0, "rejected": 0, "duration_ms_avg": None,
                        "duration_ms_max": None, "rows": 0, "bytes": 0, "keys": 0, "versions": [], "last_seen_at": None}


def overview(*params, base: str | None = None) -> dict:
    """GET /api/mcp/usage/overview, the Usage tab. `params` are (name, value) pairs: a filter can repeat."""
    return api_ok(m("GET", "/api/mcp/usage/overview", params=list(params), base=base or MCP_URL))


def overview_rows(rows: list, by: str, field: str) -> dict:
    return {row[by]: row[field] for row in rows}


def points_of(doc: dict, metric: str = "requests") -> list:
    """A metric at each point of a series: the groups and `rest` added up."""
    series = doc["series"]
    return [sum(g[metric][i] for g in series["groups"]) + series["rest"][metric][i] for i in range(len(series["t"]))]


def check_series_adds_up(doc: dict) -> None:
    """What every answer holds: at each point the groups and `rest` add up, for each of the five metrics, to the tiles."""
    series, totals = doc["series"], doc["totals"]
    assert isinstance(series["step"], int) and len(series["t"]) in (60, 72, 96, 56, 90, 365)
    for group in [*series["groups"], series["rest"]]:
        assert all(len(group[metric]) == len(series["t"]) for metric in SERIES_METRICS)
        assert sum(group["requests"]) == group["total"]
    sums = {metric: sum(points_of(doc, metric)) for metric in SERIES_METRICS}
    assert (sums["requests"], sums["errors"], sums["calls"], sums["bytes"]) == (totals["requests"], totals["errors"], totals["calls"], totals["bytes"])
    if sums["calls"]:
        assert totals["duration_ms_avg"] == (sums["duration_ms_sum"] + sums["calls"] // 2) // sums["calls"]
    else:
        assert totals["duration_ms_avg"] is None and sums["duration_ms_sum"] == 0


@needs_mcp
def test_the_usage_overview_cuts_the_requests_of_all_keys():
    # The requests of two keys, as two clients make them: a session, an unknown method, a notification, tool calls that end with
    # their codes, a message that cannot be read, and a request that is refused before it is read.
    a, secret_a = make_key(new_key_body("overview-a", tools=["list_hosts", "run_query"], databases=["*"]))
    b, secret_b = make_key(new_key_body("overview-b", tools=["list_hosts", "query_table"]))
    agent_a, agent_b = {"User-Agent": "overview-agent/1"}, {"User-Agent": "overview-agent/2"}

    def call(secret, agent, name, arguments=None):
        response = rpc(MCP_URL, secret, "tools/call", {"name": name, "arguments": arguments or {}}, headers=agent)
        assert response.status_code == 200, response.text
        return response.json()["result"]

    try:
        init = {"protocolVersion": "2025-06-18", "clientInfo": {"name": "overview-client", "version": "9.9"}}
        assert rpc(MCP_URL, secret_a, "initialize", init, headers=agent_a).status_code == 200
        assert post_mcp(MCP_URL, secret_a, {"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=agent_a).status_code == 202
        assert rpc(MCP_URL, secret_a, "tools/list", headers=agent_a).status_code == 200
        assert rpc(MCP_URL, secret_a, "resources/list", headers=agent_a).json()["error"]["code"] == -32601
        assert post_mcp(MCP_URL, secret_a, {"jsonrpc": "2.0", "method": "notifications/made-up-by-a-client"}, headers=agent_a).status_code == 202
        for _ in range(2):
            assert call(secret_a, agent_a, "list_hosts")["isError"] is False
        assert call(secret_a, agent_a, "run_query", {"host": "local", "sql": "SELECT 1"})["isError"] is False
        for sql, code in (("SELECT 1; SELECT 2", "multiple_statements"), ("DROP TABLE chdash_ui.memory_weather", "statement_not_allowed"),
                          ("SELECT 1 SETTINGS readonly = 0", "clause_not_allowed")):
            result = call(secret_a, agent_a, "run_query", {"host": "local", "sql": sql})
            assert result["isError"] is True and result["structuredContent"]["error"] == code
        assert post_mcp(MCP_URL, secret_a, None, raw="{not json", headers=agent_a).status_code == 400
        refused = SESSION.post(f"{MCP_URL}/mcp", data="{}", headers={"Authorization": f"Bearer {secret_a}", "Content-Type": "text/plain", **agent_a}, timeout=10)
        assert refused.status_code == 415
        # Key A: 13 requests, 6 tool calls, 5 errors (3 tools, 2 JSON-RPC), 1 refusal.
        other = {"protocolVersion": "2025-06-18", "clientInfo": {"name": "other-client", "version": "1.0"}}
        assert rpc(MCP_URL, secret_b, "initialize", other, headers=agent_b).status_code == 200
        assert rpc(MCP_URL, secret_b, "ping", headers=agent_b).status_code == 200
        assert call(secret_b, agent_b, "list_hosts")["isError"] is False
        result = call(secret_b, agent_b, "query_table", {"host": "local", "database": "otel", "table": "otel_traces", "limit": 1})
        assert result["isError"] is True and result["structuredContent"]["error"] == "table_not_allowed"
        # Key B: 4 requests, 2 tool calls, 1 error.

        both = [("key", a["id"]), ("key", b["id"])]
        doc = overview(("window", "24h"), *both)
        assert set(doc) == OVERVIEW_FIELDS
        assert doc["window"] == "24h" and doc["persisted"] is True and doc["retention_days"] == 90 and doc["group"] == "method"
        assert doc["from"].endswith("Z") and doc["to"].endswith("Z") and doc["since"].endswith("Z")
        assert doc["filters"] == {"key": [a["id"], b["id"]], "method": [], "client": [], "result": [], "type": []}
        totals = doc["totals"]
        assert set(totals) == OVERVIEW_TOTALS
        assert (totals["requests"], totals["calls"], totals["errors"], totals["rate_limited"], totals["rejected"]) == (17, 8, 6, 0, 1), totals
        assert totals["active_keys"] == 2 and totals["keys"] == len(api_ok(m("GET", "/api/mcp/keys"))["keys"])
        assert totals["duration_ms_max"] >= totals["duration_ms_avg"] >= 0 and totals["bytes"] > 0
        # The series: 96 points of 15 minutes (the step is a number of seconds); at most 8 groups, the others summed in `rest`; each group
        # has the five metrics, and the bars add up to the tile, at each point.
        series = doc["series"]
        assert set(series) == {"step", "t", "groups", "rest"} and series["step"] == 900 and len(series["t"]) == 96
        assert all(set(group) == {"id", "label", "total", *SERIES_METRICS} for group in series["groups"])
        assert set(series["rest"]) == {"groups", "total", *SERIES_METRICS}
        assert [(g["id"], g["total"]) for g in series["groups"]] == [
            ("run_query", 4), ("list_hosts", 3), ("initialize", 2), ("invalid", 1), ("notifications/initialized", 1), ("other", 1), ("ping", 1),
            ("query_table", 1)]
        assert series["rest"]["groups"] == 3 and series["rest"]["total"] == 3  # resources/list, tools/list, unread
        assert all(len(g[metric]) == 96 for g in series["groups"] for metric in SERIES_METRICS)
        assert all(len(series["rest"][metric]) == 96 for metric in SERIES_METRICS)
        assert sum(points_of(doc)) == 17
        check_series_adds_up(doc)
        # The metrics follow the tiles: the calls, the time of the calls and the bytes of a group (run_query: 4 calls, 3 of them errors).
        run_group = next(g for g in series["groups"] if g["id"] == "run_query")
        assert (sum(run_group["calls"]), sum(run_group["errors"])) == (4, 3) and sum(run_group["bytes"]) > 0
        init_group = next(g for g in series["groups"] if g["id"] == "initialize")
        assert (sum(init_group["calls"]), sum(init_group["duration_ms_sum"])) == (0, 0) and sum(init_group["bytes"]) > 0  # no tool call, no time
        # The keys: the most requests first, with what each one did. The facet of the keys ignores the filter of the keys, so the
        # other keys of the instance that were used in 24 hours are in it too.
        assert all(set(row) == OVERVIEW_KEY for row in doc["keys"])
        mine = [row for row in doc["keys"] if row["id"] in (a["id"], b["id"])]
        assert [(row["id"], row["name"], row["requests"], row["calls"], row["errors"], row["rejected"]) for row in mine] == [
            (a["id"], "overview-a", 13, 6, 5, 1), (b["id"], "overview-b", 4, 2, 1, 0)]
        assert mine[0]["host"] == "local" and mine[0]["source"] == "ui" and mine[0]["deleted_at"] is None and mine[0]["last_used_at"]
        requests_of = [row["requests"] for row in doc["keys"]]
        assert requests_of == sorted(requests_of, reverse=True)
        # The methods: a tool is a "call", a method of the protocol a "request", what was refused before it was read is "refused".
        assert all(set(row) == OVERVIEW_METHOD for row in doc["methods"])
        kinds = overview_rows(doc["methods"], "method", "kind")
        assert kinds == {"list_hosts": "call", "run_query": "call", "query_table": "call", "initialize": "request", "tools/list": "request",
                         "resources/list": "request", "notifications/initialized": "request", "other": "request", "ping": "request",
                         "invalid": "request", "unread": "refused"}, kinds
        counts = overview_rows(doc["methods"], "method", "requests")
        assert counts == {"list_hosts": 3, "run_query": 4, "query_table": 1, "initialize": 2, "tools/list": 1, "resources/list": 1,
                          "notifications/initialized": 1, "other": 1, "ping": 1, "invalid": 1, "unread": 1}, counts
        assert [row["method"] for row in doc["methods"]][:3] == ["run_query", "list_hosts", "initialize"]
        assert overview_rows(doc["methods"], "method", "errors")["run_query"] == 3 and overview_rows(doc["methods"], "method", "keys")["list_hosts"] == 2
        init_row = next(row for row in doc["methods"] if row["method"] == "initialize")
        assert init_row["duration_ms_avg"] is not None and init_row["duration_ms_max"] >= init_row["duration_ms_avg"] >= 0  # the latency of initialize
        # The results cover all the requests (the successful protocol requests too); the types are four, in order.
        assert overview_rows(doc["results"], "result", "count") == {
            "ok": 10, "rpc_error_32601": 1, "rpc_error_32700": 1, "multiple_statements": 1, "statement_not_allowed": 1, "clause_not_allowed": 1,
            "table_not_allowed": 1, "415_unsupported_media_type": 1}
        assert doc["results"][0] == {"result": "ok", "count": 10, "keys": 2}
        assert doc["types"] == [{"type": "call", "requests": 8}, {"type": "request", "requests": 8}, {"type": "limited", "requests": 0},
                                {"type": "rejected", "requests": 1}]
        # The clients, from the cells of the window: the name that the client gave in initialize (clientInfo), the requests that follow it
        # with its User-Agent are its own. The facet follows the filters but its own, the key here.
        assert all(set(row) == OVERVIEW_CLIENT for row in doc["clients"])
        assert [(c["client"], c["keys"], c["requests"], c["calls"], c["errors"], c["versions"]) for c in doc["clients"]] == [
            ("overview-client", 1, 13, 6, 5, ["9.9"]), ("other-client", 1, 4, 2, 1, ["1.0"])]
        assert all(c["last_seen_at"].endswith("Z") for c in doc["clients"])
        assert doc["omitted"] == {"keys": 0, "methods": 0, "results": 0, "clients": 0}

        # Every group: the groups and `rest` add up to the requests, for the five metrics. The label of a key is its name.
        for group in ("key", "method", "client", "result", "type"):
            by = overview(("window", "24h"), ("group", group), *both)
            assert by["group"] == group and by["totals"]["requests"] == 17
            assert sum(g["total"] for g in by["series"]["groups"]) + by["series"]["rest"]["total"] == 17, group
            check_series_adds_up(by)
        by_key = overview(("window", "24h"), ("group", "key"), *both)["series"]
        assert [(g["id"], g["label"], g["total"]) for g in by_key["groups"]] == [(a["id"], "overview-a", 13), (b["id"], "overview-b", 4)]
        by_result = overview(("window", "24h"), ("group", "result"), *both)["series"]
        assert len(by_result["groups"]) == 8 and by_result["rest"]["groups"] == 0 and by_result["groups"][0]["id"] == "ok"
        by_type = overview(("window", "24h"), ("group", "type"), *both)["series"]
        assert [(g["id"], g["label"], g["total"]) for g in by_type["groups"]] == [("call", "call", 8), ("request", "request", 8), ("rejected", "rejected", 1)]
        by_client = overview(("window", "24h"), ("group", "client"), *both)["series"]
        assert [(g["id"], g["label"], g["total"]) for g in by_client["groups"]] == [("overview-client", "overview-client", 13), ("other-client", "other-client", 4)]
        # The bars add up to the requests at each point, whatever the group.
        for group in ("key", "type", "result", "client"):
            assert points_of(overview(("window", "24h"), ("group", group), *both)) == points_of(doc)
        # A filter on the client: the totals follow it, the facet of the clients does not.
        mine = overview(("window", "24h"), ("client", "other-client"), *both)
        assert mine["totals"]["requests"] == 4 and mine["filters"]["client"] == ["other-client"]
        assert [c["client"] for c in mine["clients"]] == ["overview-client", "other-client"]
        # The keys that were chosen are in the facet of the keys at 0: only key B has a request of this client.
        assert {row["id"]: row["requests"] for row in mine["keys"] if row["id"] in (a["id"], b["id"])} == {a["id"]: 0, b["id"]: 4}

        # A filter on the method: run_query lists the codes that it ended with. The facet of the methods ignores its own filter.
        run = overview(("window", "24h"), ("method", "run_query"), *both)
        assert run["totals"]["requests"] == 4 and run["totals"]["errors"] == 3 and run["totals"]["active_keys"] == 1
        assert overview_rows(run["results"], "result", "count") == {"ok": 1, "multiple_statements": 1, "statement_not_allowed": 1, "clause_not_allowed": 1}
        rows = overview_rows(run["keys"], "id", "requests")  # every key that ran run_query, and the keys that were chosen
        assert rows[a["id"]] == 4 and rows[b["id"]] == 0
        assert overview_rows(run["methods"], "method", "requests") == counts
        assert [g["id"] for g in run["series"]["groups"]] == ["run_query"] and run["series"]["rest"]["groups"] == 0
        assert overview_rows(run["types"], "type", "requests") == {"call": 4, "request": 0, "limited": 0, "rejected": 0}
        # Filters of two dimensions are AND, the values of one are OR. A facet ignores its own filter only.
        crossed = overview(("window", "24h"), ("type", "request"), ("result", "ok"), ("key", a["id"]))
        assert crossed["totals"]["requests"] == 4 and crossed["totals"]["calls"] == 0  # initialize, notifications/initialized, tools/list, other
        assert {row["method"] for row in crossed["methods"]} == {"initialize", "notifications/initialized", "tools/list", "other"}
        assert overview_rows(crossed["results"], "result", "count") == {"ok": 4, "rpc_error_32601": 1, "rpc_error_32700": 1}
        either = overview(("window", "24h"), ("method", "ping"), ("method", "resources/list"), *both)
        assert either["totals"]["requests"] == 2 and [g["id"] for g in either["series"]["groups"]] == ["ping", "resources/list"]
        refusals = overview(("window", "24h"), ("type", "rejected"), *both)
        assert refusals["totals"]["requests"] == 1 and refusals["totals"]["rejected"] == 1 and refusals["totals"]["calls"] == 0
        assert [(row["method"], row["kind"]) for row in refusals["methods"]] == [("unread", "refused")]
        assert overview_rows(refusals["results"], "result", "count") == {"415_unsupported_media_type": 1}
        # A value that was chosen stays in its facet at 0: ping is a request of key B, not of key A.
        zero = overview(("window", "24h"), ("method", "ping"), ("key", a["id"]))
        assert zero["totals"]["requests"] == 0 and zero["totals"]["duration_ms_avg"] is None and zero["totals"]["duration_ms_max"] is None
        rows = overview_rows(zero["keys"], "id", "requests")  # the keys that pinged in 24 hours (the other tests use the instance too)
        assert rows[a["id"]] == 0 and rows[b["id"]] == 1
        assert next(row for row in zero["methods"] if row["method"] == "ping")["requests"] == 0
        assert [g["id"] for g in zero["series"]["groups"]] == ["ping"] and sum(zero["series"]["groups"][0]["requests"]) == 0
        ghost = overview(("window", "24h"), ("key", "ui_000000000000"), ("method", "no_such_tool"), ("result", "no_such_result"))
        assert ghost["totals"]["requests"] == 0 and ghost["keys"][0]["id"] == "ui_000000000000" and ghost["keys"][0]["name"] == "ui_000000000000"
        assert [(row["method"], row["kind"], row["requests"]) for row in ghost["methods"]] == [("no_such_tool", "call", 0)]
        assert ghost["results"] == [{"result": "no_such_result", "count": 0, "keys": 0}]

        # The window: 7 days is by 3 hours, and every window has its step in seconds.
        week = overview(("window", "7d"), *both)
        assert week["window"] == "7d" and week["series"]["step"] == 10800 and len(week["series"]["t"]) == 56 and week["totals"]["requests"] == 17
        for window, step, count in (("1h", 60, 60), ("6h", 300, 72), ("30d", 43200, 60), ("90d", 86400, 90)):
            each = overview(("window", window), *both)
            assert each["window"] == window and each["series"]["step"] == step and len(each["series"]["t"]) == count, window
            assert each["totals"]["requests"] == 17, window
            check_series_adds_up(each)
        # A key that is deleted keeps its usage: it stays in the keys with when it was deleted, and answers to its filter.
        drop_key(a["id"])
        gone = overview(("window", "24h"), ("key", a["id"]))
        assert gone["totals"]["requests"] == 13 and gone["totals"]["active_keys"] == 1 and gone["totals"]["keys"] == totals["keys"] - 1
        row = next(row for row in gone["keys"] if row["id"] == a["id"])
        assert row["deleted_at"] and row["name"] == "overview-a" and row["requests"] == 13
        assert [c["client"] for c in gone["clients"]] == ["overview-client"]
        # Never a secret, never SQL.
        text = json.dumps(doc) + json.dumps(run) + json.dumps(gone)
        assert secret_a not in text and secret_b not in text and "SELECT" not in text and "DROP TABLE" not in text
    finally:
        drop_key(a["id"])
        drop_key(b["id"])


@needs_mcp
def test_the_usage_overview_groups_and_filters_by_client():
    # The client of a request is the name that it gave in initialize (clientInfo), else the product of its User-Agent (the text before the
    # first "/" or space). Two clients that name themselves (with two User-Agents), and three that do not.
    a, secret_a = make_key(new_key_body("client-a", tools=["list_hosts"]))
    b, secret_b = make_key(new_key_body("client-b", tools=["list_hosts"]))
    one, two = {"User-Agent": "client-ua-one/1.2.3"}, {"User-Agent": "client-ua-two/4.5"}
    long_name = "n" * 100

    def initialize(secret, agent, name, version):
        info = {"protocolVersion": "2025-06-18", "clientInfo": {"name": name, "version": version}}
        assert rpc(MCP_URL, secret, "initialize", info, headers=agent).status_code == 200

    try:
        initialize(secret_a, one, "client-one", "1.2")
        for _ in range(3):  # no clientInfo: the User-Agent of the request finds its client
            assert rpc(MCP_URL, secret_a, "tools/call", {"name": "list_hosts", "arguments": {}}, headers=one).status_code == 200
        initialize(secret_a, two, "client-two", "4.5")
        for _ in range(2):
            assert rpc(MCP_URL, secret_a, "ping", headers=two).status_code == 200
        time.sleep(1.1)  # the times are in seconds: the upgrade is seen after the first version
        initialize(secret_a, one, "client-one", "1.3")  # an upgrade is the same client: the version is no part of its name
        # Key B: no clientInfo but one (with a name of several words, and one that is cut to 64 bytes); the others are by User-Agent.
        for _ in range(2):
            assert rpc(MCP_URL, secret_b, "tools/list", headers={"User-Agent": "python-httpx/0.27.0"}).status_code == 200
        assert rpc(MCP_URL, secret_b, "ping", headers={"User-Agent": "curl/8.14.1"}).status_code == 200
        initialize(secret_b, {"User-Agent": "vscode/1"}, "Visual Studio Code", "1.99")
        initialize(secret_b, {"User-Agent": "long/1"}, long_name, "1")
        # Key A: 5 + 3 requests; key B: 2 + 1 + 1 + 1.
        both = [("key", a["id"]), ("key", b["id"])]
        window = ("window", "24h")

        # A group by client: the id and the label are the name, the largest first.
        doc = overview(window, ("group", "client"), *both)
        assert doc["group"] == "client" and doc["totals"]["requests"] == 13, doc["totals"]
        groups = [(g["id"], g["label"], g["total"]) for g in doc["series"]["groups"]]
        assert groups == [("client-one", "client-one", 5), ("client-two", "client-two", 3), ("python-httpx", "python-httpx", 2),
                          ("Visual Studio Code", "Visual Studio Code", 1), ("curl", "curl", 1), ("n" * 64, "n" * 64, 1)], groups
        assert doc["series"]["rest"]["groups"] == 0
        check_series_adds_up(doc)

        # The facet of the clients: the counters of a key, the keys that used the client, its versions (the last seen first) and its last sight.
        assert all(set(row) == OVERVIEW_CLIENT for row in doc["clients"])
        rows = {row["client"]: row for row in doc["clients"]}
        assert [row["client"] for row in doc["clients"]] == [g[0] for g in groups]
        assert (rows["client-one"]["requests"], rows["client-one"]["calls"], rows["client-one"]["keys"]) == (5, 3, 1)
        assert rows["client-one"]["versions"] == ["1.3", "1.2"] and rows["client-two"]["versions"] == ["4.5"]
        assert rows["python-httpx"]["versions"] == [] and rows["curl"]["versions"] == [] and rows["Visual Studio Code"]["versions"] == ["1.99"]
        assert all(row["last_seen_at"].endswith("Z") for row in doc["clients"])
        assert parse_time(rows["client-one"]["last_seen_at"]) > parse_time(rows["client-two"]["last_seen_at"])
        assert rows["client-one"]["duration_ms_avg"] is not None and rows["curl"]["duration_ms_avg"] is None  # the time of the tool calls
        assert sum(row["requests"] for row in doc["clients"]) == 13 and doc["omitted"]["clients"] == 0

        # A filter on a client: the totals, the series and the other facets follow it; the facet of the clients does not.
        mine = overview(window, ("client", "client-two"), *both)
        assert mine["totals"]["requests"] == 3 and mine["filters"]["client"] == ["client-two"]
        assert [row["client"] for row in mine["clients"]] == [g[0] for g in groups]
        assert {row["id"]: row["requests"] for row in mine["keys"] if row["id"] in (a["id"], b["id"])} == {a["id"]: 3, b["id"]: 0}
        assert {row["method"] for row in mine["methods"]} == {"initialize", "ping"}
        check_series_adds_up(mine)
        # Two clients are OR, and the other filters are AND; a name with spaces in it, and the one that was cut to 64 bytes, are clients.
        either = overview(window, ("client", "python-httpx"), ("client", "curl"), *both)
        assert either["totals"]["requests"] == 3 and either["filters"]["client"] == ["python-httpx", "curl"]
        assert overview(window, ("client", "python-httpx"), ("client", "curl"), ("method", "ping"), *both)["totals"]["requests"] == 1
        assert overview(window, ("client", "Visual Studio Code"), *both)["totals"]["requests"] == 1
        assert overview(window, ("client", "n" * 64), *both)["totals"]["requests"] == 1
        assert overview(window, ("client", "n" * 63), *both)["totals"]["requests"] == 0  # the name is cut to 64 bytes, not to 63
        # A client that was chosen is in the groups, in the order of the request, and in its facet at 0 when nothing of it matches: a client
        # that no request has is listed as a line of zeros.
        chosen = overview(window, ("group", "client"), ("client", "curl"), ("client", "nobody-has-this-name"), ("client", "client-two"), *both)
        assert [(g["id"], g["total"]) for g in chosen["series"]["groups"]] == [("curl", 1), ("nobody-has-this-name", 0), ("client-two", 3)]
        assert chosen["series"]["rest"]["groups"] == 0 and chosen["totals"]["requests"] == 4
        check_series_adds_up(chosen)
        zero = overview(window, ("method", "list_hosts"), ("client", "curl"), ("client", "nobody-has-this-name"), *both)
        assert zero["totals"]["requests"] == 0
        zero_rows = {row["client"]: row for row in zero["clients"]}
        assert set(zero_rows) == {"client-one", "curl", "nobody-has-this-name"}  # the clients of list_hosts, and the two that were chosen
        assert zero_rows["curl"]["requests"] == 0 and zero_rows["curl"]["duration_ms_avg"] is None and zero_rows["curl"]["keys"] == 0
        assert zero_rows["nobody-has-this-name"] == {**OVERVIEW_CLIENT_ZERO}
        # The facet of the clients follows the other filters: the method here.
        pings = overview(window, ("method", "ping"), *both)
        assert [(row["client"], row["requests"]) for row in pings["clients"]] == [("client-two", 2), ("curl", 1)]

        # The records of the clients of a key (their life, by name, version and User-Agent) are what they were.
        records = usage_of(a["id"])["clients"]
        assert {(c["name"], c["version"], c["user_agent"]) for c in records} == {
            ("client-one", "1.2", "client-ua-one/1.2.3"), ("client-one", "1.3", "client-ua-one/1.2.3"), ("client-two", "4.5", "client-ua-two/4.5")}
        # Never a secret, never SQL, never an address.
        text = json.dumps(doc) + json.dumps(mine) + json.dumps(chosen)
        assert secret_a not in text and secret_b not in text and "SELECT" not in text
    finally:
        drop_key(a["id"])
        drop_key(b["id"])


@needs_mcp
def test_the_usage_overview_refuses_what_it_does_not_read():
    # 400 validation with the parameter and the reason; a typo is an error, not a filter that does nothing.
    def invalid(params, field, reason):
        api_error(m("GET", "/api/mcp/usage/overview", params=params), 400, "validation", field=field, reason=reason)

    invalid([("window", "48h")], "window", "invalid")
    invalid([("window", "365d")], "window", "invalid")  # the retention of this instance is 90 days
    invalid([("window", "12h")], "window", "invalid")
    # `split` is gone: it is a name that the route does not read, as a typo is.
    invalid([("split", "method")], "split", "unknown")
    invalid([("split", "key"), ("group", "key")], "split", "unknown")
    invalid([("group", "keys")], "group", "invalid")
    invalid([("group", "")], "group", "invalid")
    invalid([("group", "nope")], "group", "invalid")
    invalid([("group", "Client")], "group", "invalid")
    invalid([("nope", "1")], "nope", "unknown")
    invalid([("limit", "5")], "limit", "unknown")
    invalid([("clients", "x")], "clients", "unknown")  # the filter is `client`
    invalid([("key", "Bad Key")], "key", "invalid")
    invalid([("key", "ui_zzzzzzzzzzzz")], "key", "invalid")
    invalid([("key", "")], "key", "invalid")
    invalid([("method", "has space")], "method", "invalid")
    invalid([("method", "x" * 65)], "method", "invalid")
    invalid([("client", "")], "client", "invalid")
    invalid([("client", " leading")], "client", "invalid")
    invalid([("client", "trailing ")], "client", "invalid")
    invalid([("client", "x" * 65)], "client", "invalid")
    invalid([("client", "caf\u00e9")], "client", "invalid")
    invalid([("client", "line\nbreak")], "client", "invalid")
    invalid([("result", "Not-A-Result")], "result", "invalid")
    invalid([("result", "a/b")], "result", "invalid")
    invalid([("type", "tool")], "type", "invalid")
    invalid([("type", "call"), ("type", "refused")], "type", "invalid")
    for field, value in (("key", "key-{}"), ("method", "method_{}"), ("client", "client {}"), ("result", "result_{}")):
        invalid([(field, value.format(i)) for i in range(21)], field, "too_many")
        # Twenty are fine, and a value that is repeated counts once.
        assert overview(*[(field, value.format(i)) for i in range(20)])["totals"]["requests"] == 0
        assert overview(*[(field, value.format(0))] * 30)["filters"][field] == [value.format(0)]
    # A name with spaces inside is a valid client, and one of 64 bytes.
    assert overview(("client", "Visual Studio Code"), ("client", "c" * 64))["filters"]["client"] == ["Visual Studio Code", "c" * 64]
    # Every value of every dimension is checked, in the order: the window, the unknown names, the group, the filters.
    invalid([("window", "48h"), ("nope", "1")], "window", "invalid")
    invalid([("nope", "1"), ("group", "x")], "nope", "unknown")
    invalid([("group", "x"), ("key", "Bad Key")], "group", "invalid")
    invalid([("key", "Bad Key"), ("client", " x")], "key", "invalid")
    invalid([("client", " x"), ("result", "A")], "client", "invalid")
    # Without a parameter: the default window of the meta, the group by method.
    plain = overview()
    meta = api_ok(m("GET", "/api/mcp/meta"))["usage"]
    assert plain["window"] == meta["default_window"] and plain["group"] == "method" and "split" not in plain
    assert plain["filters"] == {"key": [], "method": [], "client": [], "result": [], "type": []}
    # The route of the page is a read of the page only, like the others.
    for headers in ({"Sec-Fetch-Site": "cross-site"}, {"Origin": "https://evil.example.com"}):
        api_error(m("GET", "/api/mcp/usage/overview", headers=headers), 403, "cross_site_request")
    assert m("GET", "/api/mcp/usage/overview", headers={"Sec-Fetch-Site": "same-origin"}).status_code == 200


@needs_mcp
def test_key_validation_errors():
    def invalid(body, field, reason, method="POST", path="/api/mcp/keys"):
        response = m(method, path, body=body)
        api_error(response, 400, "validation", field=field, reason=reason)

    good = new_key_body("validation-key")
    invalid({}, "name", "required")
    invalid({**good, "name": ""}, "name", "required")
    invalid({k: v for k, v in good.items() if k != "hosts"}, "hosts", "required")
    invalid({**good, "hosts": []}, "hosts", "required")  # a key needs a host
    invalid({k: v for k, v in good.items() if k != "tools"}, "tools", "required")
    invalid({k: v for k, v in good.items() if k != "databases"}, "databases", "required")
    invalid({**good, "name": 5}, "name", "type")
    invalid({**good, "hosts": "local"}, "hosts", "type")
    invalid({**good, "tools": [1]}, "tools", "type")
    invalid({**good, "max_rows": "5"}, "max_rows", "type")
    invalid({**good, "name": "Has Space"}, "name", "invalid")
    invalid({**good, "name": "UPPER"}, "name", "invalid")
    invalid({**good, "name": "-lead"}, "name", "invalid")
    invalid({**good, "name": "ui_reserved"}, "name", "invalid")
    invalid({**good, "name": "a" * 33}, "name", "too_long")
    api_ok(m("POST", "/api/mcp/keys", body={**good, "name": "a" * 32}), 201)
    drop_key(next(k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["name"] == "a" * 32)["id"])
    invalid({**good, "hosts": ["nope"]}, "hosts", "unknown_host")
    invalid({**good, "hosts": ["plain"]}, "hosts", "unknown_host")  # a host without mcp_uri is invisible
    invalid({**good, "hosts": ["local", "local"]}, "hosts", "duplicate")
    # A key reads one host, and names it: no list of hosts, no wildcard.
    invalid({**good, "hosts": ["local", "second"]}, "hosts", "too_many")
    invalid({**good, "hosts": ["*"]}, "hosts", "invalid")
    invalid({**good, "tools": ["drop_table"]}, "tools", "unknown_tool")
    invalid({**good, "tools": ["run_query"]}, "tools", "needs_all_data")
    invalid({**good, "tools": ["explain_query"], "databases": ["otel"]}, "tools", "needs_all_data")
    invalid({**good, "databases": ["a b"]}, "databases", "invalid")
    invalid({**good, "databases": ["db.", "x"]}, "databases", "invalid")
    invalid({**good, "databases": ["otel", "otel"]}, "databases", "duplicate")
    invalid({**good, "max_rows": 0}, "max_rows", "range")
    invalid({**good, "max_rows": 101}, "max_rows", "range")  # never above the server's cap
    invalid({**good, "timeout_seconds": 6}, "timeout_seconds", "range")
    # A field that a key does not have is refused: a client must not believe that its key has an expiry or a
    # memory limit (ARCH-B-070). Nothing is made.
    invalid({**good, "name": "unknown-fields", "expires_at": "2020-01-01"}, "expires_at", "unknown_field")
    invalid({**good, "name": "unknown-fields", "max_memory_bytes": 1}, "max_memory_bytes", "unknown_field")
    invalid({**good, "name": "unknown-fields", "description": "x"}, "description", "unknown_field")
    assert not [k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["name"] == "unknown-fields"]
    response = m("POST", "/api/mcp/keys", data="{not json", headers={"Content-Type": "application/json"})
    api_error(response, 400, "validation", reason="invalid_json")
    # run_query with all data is fine.
    key, _ = make_key({**good, "name": "sql-ok", "tools": ["run_query"], "databases": ["*"]})
    drop_key(key["id"])
    # "*" in tools is fine without all data: the SQL tools just stay out.
    key, secret = make_key({**good, "name": "star-tools", "tools": ["*"], "databases": ["otel"]})
    try:
        assert "run_query" not in [t["name"] for t in rpc(MCP_URL, secret, "tools/list").json()["result"]["tools"]]
    finally:
        drop_key(key["id"])

@needs_mcp
def test_names_are_unique_across_both_sources():
    api_error(m("POST", "/api/mcp/keys", body=new_key_body("all-data")), 409, "name_taken")  # a config key
    key, _ = make_key(new_key_body("unique-one"))
    other = None
    try:
        api_error(m("POST", "/api/mcp/keys", body=new_key_body("unique-one")), 409, "name_taken")
        other, _ = make_key(new_key_body("unique-two"))
        api_error(m("POST", "/api/mcp/keys", body=new_key_body("weather-only")), 409, "name_taken")
    finally:
        drop_key(key["id"])
        if other:
            drop_key(other["id"])


@needs_mcp
def test_config_keys_are_read_only():
    for path_id in ("all-data", "weather-only"):
        api_error(m("DELETE", f"/api/mcp/keys/{path_id}"), 409, "config_key")
    # Still there, still working.
    assert rpc(MCP_URL, ALL, "ping").status_code == 200
    assert next(k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["name"] == "all-data")["max_rows"] is None


@needs_mcp
def test_key_routes_cross_site_guard():
    key, secret = make_key(new_key_body("guard-key"))
    try:
        path = f"/api/mcp/keys/{key['id']}"
        for headers in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Origin": "https://evil.example.com"}):
            api_error(m("POST", "/api/mcp/keys", body=new_key_body("blocked"), headers=headers), 403, "cross_site_request")
            api_error(m("DELETE", path, headers=headers), 403, "cross_site_request")
            # The data of a key and what it did are read from the ChDash page only, like a change.
            api_error(m("GET", path + "/access", headers=headers), 403, "cross_site_request")
            api_error(m("GET", path + "/usage", headers=headers), 403, "cross_site_request")
            api_error(m("GET", path + "/cost", headers=headers), 403, "cross_site_request")
            api_error(m("GET", "/api/mcp/usage", headers=headers), 403, "cross_site_request")
            api_error(m("GET", "/api/mcp/usage/overview", headers=headers), 403, "cross_site_request")
        # Same origin passes, by the browser's header or by Origin = Host.
        host = MCP_URL.split("//", 1)[1]
        for headers in ({"Sec-Fetch-Site": "same-origin"}, {"Origin": f"http://{host}"}, {"Sec-Fetch-Site": "none"}):
            assert api_ok(m("GET", path + "/access", headers=headers))["id"] == key["id"]
        # A body must be application/json.
        for method, target in (("POST", "/api/mcp/keys"),):
            response = SESSION.request(method, MCP_URL + target, data=json.dumps({"name": "x"}), headers={"Content-Type": "text/plain"}, timeout=10)
            api_error(response, 415, "unsupported_media_type")
            response = SESSION.request(method, MCP_URL + target, data=json.dumps({"name": "x"}), timeout=10)
            api_error(response, 415, "unsupported_media_type")
        # Reads need no guard.
        assert m("GET", "/api/mcp/keys", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 200
        assert m("GET", "/api/mcp/meta", headers={"Origin": "https://evil.example.com"}).status_code == 200
        # Nothing changed.
        assert rpc(MCP_URL, secret, "ping").status_code == 200
    finally:
        drop_key(key["id"])


# ---- the key file -------------------------------------------------------------------------------------------------------------------------


@needs_data_dir
def test_key_file_holds_the_hash_never_the_secret_and_is_private():
    key, secret = make_key(new_key_body("file-check"))
    try:
        path = Path(DATA_DIR) / "mcp_keys.json"
        assert path.exists()
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        text = path.read_text()
        # The secret came once, in the answer of the create: nowhere does ChDash keep it (SEC-009).
        assert secret not in text and secret[9:] not in text
        document = json.loads(text)
        assert document["version"] == 1
        stored = next(k for k in document["keys"] if k["id"] == key["id"])
        assert stored["secret_sha256"] == hashlib.sha256(secret.encode()).hexdigest()
        assert stored["secret_hint"] == secret[:8]
        assert stored["name"] == "file-check" and stored["hosts"] == ["local"]
        assert "last_used_at" not in stored and "secret" not in stored
        assert "description" not in stored and "expires_at" not in stored
        # Config keys are never written.
        assert "weather-only" not in text and "all-data" not in text
        assert not [p for p in Path(DATA_DIR).iterdir() if p.name.startswith(".mcp_keys.json.tmp")]  # no temporary file is left
        assert "enabled" not in stored and "state" not in stored
    finally:
        drop_key(key["id"])


@needs_data_dir
def test_usage_file_holds_counts_never_secrets():
    # The usage file: written by the stop and every minute (mode 0600), counts and names, never a secret or SQL.
    key, secret = make_key(new_key_body("usage-file", tools=["list_hosts"]))
    try:
        assert ok_tool(MCP_URL, secret, "list_hosts")["count"] == 1
        path = Path(DATA_DIR) / "mcp_usage.json"
        deadline = time.time() + 75
        while time.time() < deadline:
            if path.exists() and key["id"] in path.read_text():
                break
            time.sleep(1)
        assert path.exists() and key["id"] in path.read_text(), "the usage file was not written within a minute"
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        text = path.read_text()
        assert secret not in text and secret[9:] not in text and "SELECT" not in text
        document = json.loads(text)
        assert document["version"] == 1 and document["since"].endswith("Z")
        entry = next(e for e in document["keys"] if e["id"] == key["id"])
        assert entry["name"] == "usage-file" and entry["host"] == "local" and entry["source"] == "ui" and entry["deleted_at"] is None
        # An entry has the six tiers (m1, m5, m15, h3, h12, d1: the steps of 1 minute, 5 minutes, 15 minutes, 3 hours, 12 hours, 1 day), and
        # a bucket is its start and its cells: [type, client, method, result, count, duration sum, duration max, rows, bytes].
        steps = {"m1": 60, "m5": 300, "m15": 900, "h3": 10800, "h12": 43200, "d1": 86400}
        assert "hours" not in entry and "days" not in entry and all(isinstance(entry[tier], list) for tier in steps)
        for tier, step in steps.items():
            bucket = entry[tier][-1]  # the retention of this instance is 90 days: every tier is kept
            assert len(bucket) == 2 and bucket[0] % step == 0, tier
            assert all(len(cell) == 9 for cell in bucket[1]), tier
        cells = {tuple(cell[:4]): cell[4:] for cell in entry["m1"][-1][1]}
        assert len(cells[("call", "chdash-backend-functional", "list_hosts", "ok")]) == 5 and cells[("call", "chdash-backend-functional", "list_hosts", "ok")][0] >= 1
        # The key made one call: it is in each tier, as the same cell.
        assert all([cell[:4] for cell in entry[tier][-1][1]] == [list(cell_key) for cell_key in cells] for tier in steps)
        # Nothing that a client chose is in the file, for any key: a method of a request is one of the protocol (or "other", "invalid",
        # for a message that could not be read), a result is of the shape that the file keeps, and a client is printable ASCII (1 to 64 bytes,
        # no space at either end): its name, or the product of its User-Agent.
        known = {"initialize", "ping", "tools/list", "tools/call", "response", "notifications/initialized", "notifications/cancelled",
                 "notifications/progress", "notifications/roots/list_changed", "resources/list", "resources/read", "resources/templates/list",
                 "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel",
                 "other", "invalid"}
        for each in document["keys"]:
            assert len({client for tier in steps for bucket in each[tier] for kind, client, *_ in bucket[1] if client not in ("other", "unknown")}) <= 16
            for tier, step in steps.items():
                for bucket in each[tier]:
                    assert len(bucket) == 2 and bucket[0] % step == 0
                    for kind, client, method, result, *counts in bucket[1]:
                        assert kind in ("call", "request", "limited", "rejected") and len(counts) == 5 and counts[0] >= 1
                        assert re.fullmatch(r"[A-Za-z0-9_/]{1,64}", method) and re.fullmatch(r"[a-z0-9_]{1,64}", result), (method, result)
                        assert re.fullmatch(r"[\x20-\x7e]{1,64}", client) and client == client.strip(" "), client
                        if kind == "request":
                            assert method in known, method
                        if kind in ("limited", "rejected"):
                            assert method == "unread" and result != "ok", (kind, method, result)
    finally:
        drop_key(key["id"])


@needs_data_dir
def test_a_failed_write_answers_500_and_changes_nothing():
    directory = Path(DATA_DIR)
    key, secret = make_key(new_key_body("before-failure"))
    keys_before = api_ok(m("GET", "/api/mcp/keys"))["keys"]
    original = directory.stat().st_mode
    try:
        os.chmod(directory, 0o555)
        probe = directory / ".probe"
        try:
            probe.write_text("x")
            probe.unlink()
            pytest.skip("the directory stays writable (pytest runs as root): cannot make a write fail")
        except PermissionError:
            pass
        response = m("POST", "/api/mcp/keys", body=new_key_body("never-made"))
        api_error(response, 500, "storage_error")
        api_error(m("DELETE", f"/api/mcp/keys/{key['id']}"), 500, "storage_error")
    finally:
        os.chmod(directory, original)
    # The memory was restored: the same keys, the old secret still works.
    assert api_ok(m("GET", "/api/mcp/keys"))["keys"] == keys_before
    assert rpc(MCP_URL, secret, "ping").status_code == 200
    drop_key(key["id"])


@needs_restart
def test_keys_survive_a_restart():
    key, secret = make_key(new_key_body("survivor", tools=["list_hosts"], max_rows=9))
    patched = key
    rpc(MCP_URL, secret, "ping")
    assert ok_tool(MCP_URL, secret, "list_hosts")["count"] == 1
    used = usage_of(key["id"])
    subprocess.run(RESTART_CMD, shell=True, check=True, timeout=120)
    deadline = time.time() + 60
    while True:
        try:
            if m("GET", "/api/mcp/meta").status_code == 200:
                break
        except requests.RequestException:
            pass
        assert time.time() < deadline, "the instance did not come back"
        time.sleep(0.5)
    try:
        # The usage was written at the stop: the counts and the last use come back from the usage file.
        kept = usage_of(key["id"])
        assert kept["totals"] == used["totals"] and kept["last_used_at"] == used["last_used_at"] and kept["since"] == used["since"]
        assert next(k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["id"] == key["id"])["last_used_at"] == used["last_used_at"]
        assert rpc(MCP_URL, secret, "ping").status_code == 200
        again = next(k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["id"] == key["id"])
        assert again["max_rows"] == 9 and again["created_at"] == patched["created_at"]
        assert again["secret_hint"] == secret[:8]
        assert again["last_used_at"] is not None  # the usage of the key, not the key file
        assert usage_of(key["id"])["totals"]["requests"] == used["totals"]["requests"] + 1
    finally:
        drop_key(key["id"])


# ---- read-only and no-storage instances ---------------------------------------------------------------------------------------------------------


@needs_ro
def test_read_only_instance():
    meta = api_ok(m("GET", "/api/mcp/meta", base=RO_URL))
    assert meta["manage_from_ui"] is False and meta["storage_configured"] is True and meta["can_manage"] is False
    keys = api_ok(m("GET", "/api/mcp/keys", base=RO_URL))["keys"]
    assert [k["name"] for k in keys] == ["cfg-reader", "seed-key"]  # config first, then the file
    assert keys[1]["source"] == "ui" and keys[1]["id"] == "ui_0a1b2c3d4e5f" and keys[1]["secret_hint"] == SEED[:8]
    assert keys[1]["created_at"] == "2026-10-01T10:00:00Z"
    # No secret is shown again, of a config key or of a key of the file.
    for key_id in ("ui_0a1b2c3d4e5f", "cfg-reader"):
        assert m("GET", f"/api/mcp/keys/{key_id}/secret", base=RO_URL).status_code == 404
    # The keys of the file work, and what they do is counted: a read of the page, not a change.
    assert rpc(RO_URL, SEED, "ping").status_code == 200
    assert api_ok(m("GET", "/api/mcp/keys/ui_0a1b2c3d4e5f/usage", base=RO_URL))["totals"]["requests"] >= 1
    assert any(k["id"] == "ui_0a1b2c3d4e5f" for k in api_ok(m("GET", "/api/mcp/usage", base=RO_URL))["keys"])
    # The Usage tab reads too, on an instance where the keys are read-only: a read, not a change.
    seen = api_ok(m("GET", "/api/mcp/usage/overview", base=RO_URL, params=[("key", "ui_0a1b2c3d4e5f")]))
    assert seen["totals"]["requests"] >= 1 and seen["filters"]["key"] == ["ui_0a1b2c3d4e5f"] and seen["totals"]["active_keys"] == 1
    assert any(row["id"] == "ui_0a1b2c3d4e5f" and row["source"] == "ui" for row in seen["keys"])
    assert any(row["method"] == "ping" and row["kind"] == "request" for row in seen["methods"])
    assert [t["name"] for t in rpc(RO_URL, SEED, "tools/list").json()["result"]["tools"]] == ["list_databases", "list_tables", "describe_table", "query_table"]
    assert ok_tool(RO_URL, SEED, "list_tables", {})["tables"]
    # Every write is refused.
    api_error(m("POST", "/api/mcp/keys", base=RO_URL, body=new_key_body()), 403, "manage_disabled")
    api_error(m("DELETE", "/api/mcp/keys/ui_0a1b2c3d4e5f", base=RO_URL), 403, "manage_disabled")
    api_error(m("DELETE", "/api/mcp/keys/cfg-reader", base=RO_URL), 403, "manage_disabled")
    assert rpc(RO_URL, SEED, "ping").status_code == 200
    if RO_DATA_DIR:
        # The seed file holds the hash only, and the start does not touch it.
        text = (Path(RO_DATA_DIR) / "mcp_keys.json").read_text()
        document = json.loads(text)
        assert [k["name"] for k in document["keys"]] == ["seed-key"]
        assert SEED not in text and "secret" not in document["keys"][0]
        assert document["keys"][0]["secret_sha256"] == hashlib.sha256(SEED.encode()).hexdigest()


@needs_nostorage
def test_no_storage_instance():
    meta = api_ok(m("GET", "/api/mcp/meta", base=NOSTORAGE_URL))
    # No usage_file: the usage is in memory, since the start.
    assert meta["usage"]["persisted"] is False
    assert meta["storage_configured"] is False and meta["manage_from_ui"] is True and meta["can_manage"] is False
    assert [k["name"] for k in api_ok(m("GET", "/api/mcp/keys", base=NOSTORAGE_URL))["keys"]] == ["only-key"]
    api_error(m("POST", "/api/mcp/keys", base=NOSTORAGE_URL, body=new_key_body()), 409, "storage_not_configured")
    api_error(m("DELETE", "/api/mcp/keys/only-key", base=NOSTORAGE_URL), 409, "config_key")
    assert meta["auth_header"] == "X-ChDash-Key"
    ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    list_hosts = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "list_hosts", "arguments": {}}}
    # The key travels in the header that mcp.auth_header names: the key alone, or "Bearer <key>". Authorization is not read.
    assert post_mcp(NOSTORAGE_URL, None, ping, headers={"X-ChDash-Key": ONLY_KEY}).status_code == 200
    assert post_mcp(NOSTORAGE_URL, None, ping, headers={"X-ChDash-Key": f"Bearer {ONLY_KEY}"}).status_code == 200
    assert post_mcp(NOSTORAGE_URL, None, ping, headers={"x-chdash-key": ONLY_KEY}).status_code == 200
    for refused in ({"Authorization": f"Bearer {ONLY_KEY}"}, {"X-ChDash-Key": ONLY_KEY[:-1]}, {"X-ChDash-Key": ""}, {}):
        response = post_mcp(NOSTORAGE_URL, None, ping, headers=refused)
        assert response.status_code == 401, refused
        assert "X-ChDash-Key" in response.json()["message"]
        assert "WWW-Authenticate" not in response.headers
    result = post_mcp(NOSTORAGE_URL, None, list_hosts, headers={"X-ChDash-Key": ONLY_KEY}).json()["result"]
    assert [h["name"] for h in result["structuredContent"]["hosts"]] == ["local"]
    # The usage is in memory since the start, and the Usage tab reads it.
    seen = api_ok(m("GET", "/api/mcp/usage/overview", base=NOSTORAGE_URL))
    assert seen["persisted"] is False and seen["totals"]["requests"] >= 4 and seen["totals"]["calls"] >= 1
    assert [row["id"] for row in seen["keys"]] == ["only-key"]
    assert {"ping": "request", "list_hosts": "call"}.items() <= {row["method"]: row["kind"] for row in seen["methods"]}.items()
    assert seen["totals"]["keys"] == 1


# ---- what a key reaches (GET /api/mcp/keys/<id>/access) -------------------------------------------------------------


def key_access(name: str, **params) -> dict:
    return api_ok(m("GET", f"/api/mcp/keys/{name}/access", params=params))


@needs_mcp
def test_a_key_reaches_the_tables_that_the_mcp_user_reads_cut_by_its_patterns():
    weather = key_access("weather-only")
    assert weather["all_data"] is False and weather["databases"] == ["chdash_ui.weather_*"]
    # weather-only names the host "local": one host, the MCP user, only the databases and tables that match.
    assert [h["host"] for h in weather["hosts"]] == ["local"]
    local = weather["hosts"][0]
    assert local["status"] == "ok" and local["user"] == "chdash_mcp"
    assert [d["name"] for d in local["databases"]] == ["chdash_ui"]
    tables = [t["name"] for t in local["databases"][0]["tables"]]
    assert tables and all(name.startswith("weather_") for name in tables), tables
    assert local["databases"][0]["table_count"] == len(tables)
    # What the user reads and the key leaves out is counted, not listed.
    assert local["excluded_by_key"] > 0 and local["readable_by_user"] == len(tables) + local["excluded_by_key"]


@needs_mcp
def test_a_key_with_all_the_data_reaches_everything_that_the_mcp_user_reads_and_nothing_more():
    everything = key_access("all-data")
    assert everything["all_data"] is True
    local = everything["hosts"][0]
    names = {d["name"] for d in local["databases"]}
    # The fixture grants of chdash_mcp (01-chdash-users.sql): the three fixture databases and a few system tables.
    assert {"chdash_ui", "chdash_repl", "otel"} <= names
    assert "chdash_perf" not in names and "chdash_rich_scratch" not in names, "databases that the MCP user cannot read"
    assert local["excluded_by_key"] == 0
    system = next(d for d in local["databases"] if d["name"] == "system")
    assert {t["name"] for t in system["tables"]} >= {"tables", "columns", "databases"}
    assert "query_log" not in {t["name"] for t in system["tables"]}
    # One key, one host: the entry of the host of the key, and no other.
    assert [h["host"] for h in everything["hosts"]] == ["local"]
    assert [h["host"] for h in key_access("second-host")["hosts"]] == ["second"]


@needs_clickhouse
def test_the_access_summary_counts_the_databases_and_tables_of_each_key():
    """The table of the page: how many databases and tables each key reaches, from one answer for all the keys."""
    body = api_ok(m("GET", "/api/mcp/access"))
    summary = {item["id"]: item for item in body["keys"]}
    keys = {k["id"] for k in api_ok(m("GET", "/api/mcp/keys"))["keys"]}
    assert set(summary) == keys  # one entry for each key, none more
    weather = summary["weather-only"]
    assert weather["status"] == "ok" and weather["host"] == "local" and weather["user"] == "chdash_mcp"
    assert weather["databases"] == 1 and weather["tables"] > 0 and weather["all_data"] is False
    everything = summary["all-data"]
    assert everything["all_data"] is True and everything["databases"] >= 3 and everything["tables"] > weather["tables"]
    # The same numbers as the details of the key.
    detail = key_access("weather-only")["hosts"][0]
    assert weather["databases"] == len(detail["databases"])
    assert weather["tables"] == sum(d["table_count"] for d in detail["databases"])
    assert summary["second-host"]["host"] == "second"
    # Never a secret, and a read of the page only.
    assert ALL not in json.dumps(body)
    api_error(m("GET", "/api/mcp/access", headers={"Sec-Fetch-Site": "cross-site"}), 403, "cross_site_request")


@needs_mcp
def test_the_access_of_an_unknown_key_is_404():
    api_error(m("GET", "/api/mcp/keys/nobody/access"), 404, "not_found")


@needs_mcp
def test_the_access_of_a_key_is_a_read_of_the_page_only():
    path = "/api/mcp/keys/weather-only/access"
    api_error(m("GET", path, headers={"Sec-Fetch-Site": "cross-site"}), 403, "cross_site_request")
    assert api_ok(m("GET", path, headers={"Sec-Fetch-Site": "same-origin"}))["id"] == "weather-only"
    # It never carries a secret.
    assert WEATHER not in m("GET", path).text


# ---- startup errors (the real binary) ------------------------------------------------------------------------------------------------------------------

HOSTS = """
clickhouse {
  host {
    name       = "prod"
    runner_uri = "clickhouse://r:r@clickhouse:9000"
    system_uri = "clickhouse://s:s@clickhouse:9000"
    mcp_uri    = "clickhouse://chdash_mcp:mcp_test@clickhouse:9000"
  }
  host {
    name       = "stage"
    runner_uri = "clickhouse://r:r@clickhouse:9000"
    system_uri = "clickhouse://s:s@clickhouse:9000"
  }
}
"""
NO_MCP_HOSTS = """
clickhouse {
  host {
    name       = "prod"
    runner_uri = "clickhouse://r:r@clickhouse:9000"
    system_uri = "clickhouse://s:s@clickhouse:9000"
  }
}
"""
KEY = """
  key {
    name      = "k"
    secret    = "01234567-89ab-4def-8123-456789abcdef"
    hosts     = ["prod"]
    tools     = ["list_databases"]
    databases = ["otel"]
    %s
  }
"""


def config_dir(tmp: str) -> str:
    """The directory as the binary sees it: {dir} itself when the command runs on the host."""
    return tmp if STARTUP_CONFIG_DIR == "{dir}" else STARTUP_CONFIG_DIR


def start_binary(config: str, *, name: str = "chdash.hcl", files: dict | None = None) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as tmp:
        os.chmod(tmp, 0o755)
        for file_name, content in (files or {}).items():
            (Path(tmp) / file_name).write_text(content)
            os.chmod(Path(tmp) / file_name, 0o644)
        path = Path(tmp) / name
        path.write_text(config.replace("@DIR@", config_dir(tmp)))
        os.chmod(path, 0o644)
        command = STARTUP_CMD.format(dir=shlex.quote(tmp), name=shlex.quote(name))
        return subprocess.run(command, shell=True, capture_output=True, text=True, timeout=60)


def assert_config_error(result: subprocess.CompletedProcess, *fragments: str) -> None:
    assert result.returncode == 1, (result.returncode, result.stdout, result.stderr)
    assert "config error:" in result.stderr, result.stderr
    for fragment in fragments:
        assert fragment in result.stderr, (fragment, result.stderr)
    assert "fatal:" not in result.stderr
    assert "listen=" not in result.stderr  # the server never started


@needs_startup
def test_startup_error_1_no_storage_and_no_key():
    assert_config_error(start_binary("mcp {\n enabled = true\n}\n" + HOSTS), "mcp.enabled", "storage_file")


@needs_startup
@pytest.mark.parametrize("name", ["", "X Key", "X_Key", "-X", "Content-Type", "host", "Cookie", "Mcp-Session-Id"])
def test_startup_error_auth_header(name):
    config = 'mcp {\n enabled = true\n auth_header = "%s"\n' % name + KEY % "" + "}\n" + HOSTS
    assert_config_error(start_binary(config), "mcp.auth_header")


@needs_startup
def test_startup_error_2_no_host_has_mcp_uri():
    assert_config_error(start_binary("mcp {\n enabled = true\n" + KEY % "" + "}\n" + NO_MCP_HOSTS), "mcp_uri")


@needs_startup
def test_startup_error_3_storage_file():
    # Not JSON: refused, and the file stays as it was.
    with tempfile.TemporaryDirectory() as tmp:
        os.chmod(tmp, 0o755)
        content = "{ this is not json"
        (Path(tmp) / "keys.json").write_text(content)
        os.chmod(Path(tmp) / "keys.json", 0o644)
        (Path(tmp) / "chdash.hcl").write_text(('mcp {\n enabled = true\n storage_file = "@DIR@/keys.json"\n}\n' + HOSTS).replace("@DIR@", config_dir(tmp)))
        os.chmod(Path(tmp) / "chdash.hcl", 0o644)
        result = subprocess.run(STARTUP_CMD.format(dir=shlex.quote(tmp), name="chdash.hcl"), shell=True, capture_output=True, text=True, timeout=60)
        assert_config_error(result, "storage_file", "not valid JSON")
        assert (Path(tmp) / "keys.json").read_text() == content
    # Valid JSON of another shape.
    with tempfile.TemporaryDirectory() as tmp:
        os.chmod(tmp, 0o755)
        (Path(tmp) / "keys.json").write_text('{"version": 7, "keys": []}')
        os.chmod(Path(tmp) / "keys.json", 0o644)
        (Path(tmp) / "chdash.hcl").write_text(('mcp {\n enabled = true\n storage_file = "@DIR@/keys.json"\n}\n' + HOSTS).replace("@DIR@", config_dir(tmp)))
        os.chmod(Path(tmp) / "chdash.hcl", 0o644)
        result = subprocess.run(STARTUP_CMD.format(dir=shlex.quote(tmp), name="chdash.hcl"), shell=True, capture_output=True, text=True, timeout=60)
        assert_config_error(result, "storage_file", "version")
    # The directory does not exist.
    assert_config_error(start_binary('mcp {\n enabled = true\n storage_file = "/no/such/dir/keys.json"\n}\n' + HOSTS), "storage_file", "does not exist")


@needs_startup
def test_startup_error_8_usage_file():
    # The key file is no usage file; a usage file of another shape is refused and never rewritten; its directory must exist.
    same = 'mcp {\n enabled = true\n storage_file = "@DIR@/keys.json"\n usage_file = "@DIR@/keys.json"\n' + KEY % "" + "}\n" + HOSTS
    assert_config_error(start_binary(same), "mcp.usage_file", "key file")
    entry = ('{"id": "k", "name": "k", "source": "config", "host": "local", "first_used_at": null, "last_used_at": null, "deleted_at": null, "clients": [], %s}')
    old_layout = '{"version": 1, "since": "2026-10-01T00:00:00Z", "keys": [' + entry % '"hours": [], "days": []' + ']}'  # no tiers
    old_cell = '{"version": 1, "since": "2026-10-01T00:00:00Z", "keys": [' + entry % (
        '"m1": [], "m5": [], "m15": [], "h3": [], "h12": [], "d1": [[86400, [["call", "list_hosts", "ok", 1, 0, 0, 0, 0]]]]') + ']}'  # no client
    bad_step = '{"version": 1, "since": "2026-10-01T00:00:00Z", "keys": [' + entry % '"m1": [], "m5": [[360, []]], "m15": [], "h3": [], "h12": [], "d1": []' + ']}'
    for content, fragment in (('{"version": 2, "since": "2026-10-01T00:00:00Z", "keys": []}', "version must be 1"),
                              (old_layout, "m1 is missing"), (old_cell, "cell"), (bad_step, "m5")):
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp, 0o755)
            (Path(tmp) / "usage.json").write_text(content)
            os.chmod(Path(tmp) / "usage.json", 0o644)
            (Path(tmp) / "chdash.hcl").write_text(('mcp {\n enabled = true\n usage_file = "@DIR@/usage.json"\n' + KEY % "" + "}\n" + HOSTS).replace("@DIR@", config_dir(tmp)))
            os.chmod(Path(tmp) / "chdash.hcl", 0o644)
            result = subprocess.run(STARTUP_CMD.format(dir=shlex.quote(tmp), name="chdash.hcl"), shell=True, capture_output=True, text=True, timeout=60)
            assert_config_error(result, "mcp.usage_file", fragment, "the file is not changed")
            assert (Path(tmp) / "usage.json").read_text() == content
    assert_config_error(start_binary('mcp {\n enabled = true\n usage_file = "/no/such/dir/usage.json"\n' + KEY % "" + "}\n" + HOSTS), "usage_file", "does not exist")


@needs_startup
def test_startup_error_4_same_name_or_same_secret():
    two_names = "mcp {\n enabled = true\n" + KEY % "" + KEY.replace("01234567-89ab-4def-8123-456789abcdef", "abcdef01-2345-4789-8abc-def012345678") % "" + "}\n" + HOSTS
    assert_config_error(start_binary(two_names), "two keys have the name k")
    second = KEY.replace('name      = "k"', 'name      = "k2"') % ""
    assert_config_error(start_binary("mcp {\n enabled = true\n" + KEY % "" + second + "}\n" + HOSTS), "same secret")
    # A hash alone is refused: give the secret (ChDash keeps its hash only).
    digest = hashlib.sha256(b"01234567-89ab-4def-8123-456789abcdef").hexdigest()
    hashed = (KEY.replace('secret    = "01234567-89ab-4def-8123-456789abcdef"', f'secret_sha256 = "{digest}"').replace('name      = "k"', 'name = "k2"')) % ""
    assert_config_error(start_binary("mcp {\n enabled = true\n" + hashed + "}\n" + HOSTS), "secret_sha256 is not accepted")
    # A key of the file with the name of a key of the config.
    file_keys = {"version": 1, "keys": [{"id": "ui_0a1b2c3d4e5f", "name": "k", "description": "", "secret_sha256": hashlib.sha256(b"a07e7e70-0000-4000-8000-00000000000e").hexdigest(),
                                          "secret_hint": "another-", "hosts": [], "tools": [], "databases": []}]}
    result = start_binary('mcp {\n enabled = true\n storage_file = "@DIR@/keys.json"\n' + KEY % "" + "}\n" + HOSTS, files={"keys.json": json.dumps(file_keys)})
    assert_config_error(result, "keys.json", "also a key of the configuration")


@needs_startup
def test_startup_error_5_unknown_host_or_tool():
    assert_config_error(start_binary("mcp {\n enabled = true\n" + (KEY % "").replace('hosts     = ["prod"]', 'hosts     = ["nowhere"]') + "}\n" + HOSTS), "mcp.key k", "nowhere")
    # A host that exists but has no mcp_uri is not a host for MCP.
    assert_config_error(start_binary("mcp {\n enabled = true\n" + (KEY % "").replace('hosts     = ["prod"]', 'hosts     = ["stage"]') + "}\n" + HOSTS), "mcp.key k", "stage")
    assert_config_error(start_binary("mcp {\n enabled = true\n" + (KEY % "").replace('"list_databases"', '"list_databases", "drop_table"') + "}\n" + HOSTS), "mcp.key k", "drop_table")


@needs_startup
def test_startup_error_6_sql_tool_without_all_data():
    for tool in ("run_query", "explain_query"):
        config = "mcp {\n enabled = true\n" + (KEY % "").replace('"list_databases"', f'"{tool}"') + "}\n" + HOSTS
        assert_config_error(start_binary(config), "mcp.key k", tool, "databases")
    config = "mcp {\n enabled = true\n" + (KEY % "").replace('"list_databases"', '"run_query"').replace('["otel"]', "[]") + "}\n" + HOSTS
    assert_config_error(start_binary(config), "run_query")


@needs_startup
def test_startup_error_7_unknown_attribute_or_secret_count():
    assert_config_error(start_binary("mcp {\n enabled = true\n bogus = 1\n" + KEY % "" + "}\n" + HOSTS), "mcp", "unknown attribute bogus")
    assert_config_error(start_binary("mcp {\n enabled = true\n" + KEY % "colour = \"red\"" + "}\n" + HOSTS), "mcp.key", "unknown attribute colour")
    assert_config_error(start_binary("mcp {\n enabled = true\n" + (KEY % "").replace('    secret    = "01234567-89ab-4def-8123-456789abcdef"\n', "") + "}\n" + HOSTS), "exactly one of secret and secret_file")
    two = (KEY % "").replace('secret    = "01234567-89ab-4def-8123-456789abcdef"', 'secret    = "01234567-89ab-4def-8123-456789abcdef"\n secret_file = "/x"')
    assert_config_error(start_binary("mcp {\n enabled = true\n" + two + "}\n" + HOSTS), "exactly one of secret and secret_file")
    short = (KEY % "").replace("01234567-89ab-4def-8123-456789abcdef", "too-short")
    assert_config_error(start_binary("mcp {\n enabled = true\n" + short + "}\n" + HOSTS), "UUID version 4")
    # A mcp block that is off still checks its shape.
    assert_config_error(start_binary("mcp {\n enabled = false\n nonsense = true\n}\n" + HOSTS), "unknown attribute nonsense")


# ---- observability ---------------------------------------------------------------------------------------------------------------------


@needs_mcp
def test_observability_tools_answer_with_the_shape_of_their_contract():
    # The default window is an hour: the fixture is older, so lists may be empty. The shape never changes,
    # and what a list holds is checked when it holds something.
    services = ok_tool(MCP_URL, OTEL, "list_services")
    assert services["signal"] == "traces" and services["since_minutes"] == 60
    assert set(services) >= {"host", "services", "count", "truncated", "elapsed_ms"}
    for service in services["services"]:
        assert set(service) == {"service", "spans", "errors", "avg_ms"}
    assert ok_tool(MCP_URL, OTEL, "list_services", {"signal": "logs", "since_minutes": 5})["signal"] == "logs"

    found = ok_tool(MCP_URL, OTEL, "search_traces", {"limit": 3})
    assert found["count"] == len(found["traces"]) <= 3 and found["order"] == "recent"
    for trace in found["traces"]:
        assert set(trace) == {"trace_id", "service", "operation", "started", "duration_ms", "status"}
        assert len(trace["trace_id"]) == 32
    slow = ok_tool(MCP_URL, OTEL, "search_traces", {"limit": 3, "order": "slowest", "min_duration_ms": 0})
    durations = [trace["duration_ms"] for trace in slow["traces"]]
    assert durations == sorted(durations, reverse=True)
    none = ok_tool(MCP_URL, OTEL, "search_traces", {"service": "no-such-service-" + uuid.uuid4().hex})
    assert none["traces"] == [] and none["count"] == 0 and none["truncated"] is False
    if found["traces"]:
        # A trace of the search can be opened, and its spans are its own.
        trace_id = found["traces"][0]["trace_id"]
        opened = ok_tool(MCP_URL, OTEL, "get_trace", {"trace_id": trace_id})
        assert opened["trace_id"] == trace_id and opened["count"] == len(opened["spans"]) >= 1
        assert set(opened["spans"][0]) == {"span_id", "parent_span_id", "service", "operation", "kind", "started", "duration_ms", "status", "status_message"}

    records = ok_tool(MCP_URL, OTEL, "search_logs", {"limit": 3, "severity": "info"})
    assert records["count"] == len(records["records"]) <= 3
    for record in records["records"]:
        assert set(record) == {"time", "service", "severity", "severity_number", "trace_id", "span_id", "message"}
        assert record["severity_number"] >= 9

    metrics = ok_tool(MCP_URL, OTEL, "list_metrics")
    for metric in metrics["metrics"]:
        assert set(metric) == {"kind", "name", "unit", "description"} and metric["kind"] in ("gauge", "sum", "histogram")
    if metrics["metrics"]:
        first = metrics["metrics"][0]
        series = ok_tool(MCP_URL, OTEL, "query_metric", {"metric": first["name"], "kind": first["kind"]})
        assert series["metric"] == first["name"] and series["kind"] == first["kind"] and series["aggregation"] == "avg"
        for point in series["series"]:
            assert set(point) == {"time", "value", "points"}


@needs_mcp
def test_observability_tools_refuse_what_they_should():
    fail_tool(MCP_URL, OTEL, "get_trace", {"trace_id": "not-hex"}, "invalid_argument")
    fail_tool(MCP_URL, OTEL, "get_trace", {"trace_id": uuid.uuid4().hex}, "trace_not_found")
    fail_tool(MCP_URL, OTEL, "search_traces", {"status": "Fine"}, "invalid_argument")
    fail_tool(MCP_URL, OTEL, "search_traces", {"since_minutes": 0}, "invalid_argument")
    fail_tool(MCP_URL, OTEL, "search_traces", {"since_minutes": 100001}, "invalid_argument")  # above the lookback of the config
    fail_tool(MCP_URL, OTEL, "search_logs", {"severity": "loud"}, "invalid_argument")
    fail_tool(MCP_URL, OTEL, "query_metric", {"metric": "no.such.metric." + uuid.uuid4().hex}, "metric_not_found")
    fail_tool(MCP_URL, OTEL, "query_metric", {"metric": "x", "kind": "gauge", "aggregation": "count"}, "invalid_argument")
    # The tools of Observability read the otel tables with the system user, as the pages do: the data of the key does not
    # decide, the permission does. A key limited to chdash_ui can hold them, and they answer.
    tools = ["list_services", "search_traces", "search_logs", "list_metrics", "query_metric", "get_trace", "traces_meta", "traces_search", "logs_search", "metrics_series"]
    made, secret_ = make_key(new_key_body("obs-no-otel", tools=tools, databases=["chdash_ui"]))
    try:
        time.sleep(1.1)
        since = ch("SELECT toString(now())").strip()
        time.sleep(1.1)
        for tool in ("list_services", "search_traces", "search_logs", "list_metrics", "traces_meta"):
            result = call_tool(MCP_URL, secret_, tool, {"host": "local"})
            assert result["isError"] is False, (tool, result)
        fail_tool(MCP_URL, secret_, "get_trace", {"host": "local", "trace_id": uuid.uuid4().hex}, "trace_not_found")
        # The queries ran with the system user, never with the MCP user or the runner.
        users = _log_users(since, "%`otel`.`otel_traces`%", "%LIMIT 0%")
        assert "chdash_system" in users and "chdash_mcp" not in users and "chdash_runner" not in users, users
    finally:
        drop_key(made["id"])
    # The row cap of the key applies: the key "otel-reader" has 10 rows.
    assert ok_tool(MCP_URL, OTEL, "search_traces", {"limit": 1000})["count"] <= 10


@needs_mcp
def test_observability_tools_obey_the_read_limit():
    # A window as long as the fixture is old reads billions of rows: the guard rail of the instance
    # (max_rows_to_read = 5 million) answers, and the tool names it. A result is also fine, on a small database.
    result = call_tool(MCP_URL, OTEL, "search_traces", {"since_minutes": 60000, "limit": 1})
    if result["isError"]:
        assert result["structuredContent"]["error"] in ("read_limit", "timeout", "memory_limit")


# ---- API tools -------------------------------------------------------------------------------------------------------------------


@needs_mcp
def test_api_tools_call_the_functions_of_the_api():
    # A key of its own: the shared "all-data" key has spent its calls of the minute on other tests.
    key, secret = make_key(new_key_body("api-everything", tools=["*"], databases=["*"], hosts=["local"]))
    try:
        _api_tools_call_the_functions_of_the_api(secret)
    finally:
        drop_key(key["id"])


def _api_tools_call_the_functions_of_the_api(ALL):
    # The Explorer: the catalog, then the detail of a table of it, then a preview of its rows.
    catalog = ok_tool(MCP_URL, ALL, "explorer_catalog", {"host": "local", "params": {"database": "chdash_ui"}})
    assert catalog["host_id"] == "local" and "chdash_ui" in json.dumps(catalog)
    detail = ok_tool(MCP_URL, ALL, "explorer_table", {"host": "local", "params": {"database": "chdash_ui", "table": "weather_observations"}})
    assert detail["host_id"] == "local"
    preview = ok_tool(MCP_URL, ALL, "explorer_table_data", {"host": "local", "body": {"database": "chdash_ui", "table": "weather_observations", "limit": 3}})
    assert len(preview.get("rows", [])) <= 3
    # System.
    assert ok_tool(MCP_URL, ALL, "system_overview", {"host": "local"})["host_id"] == "local"
    assert "disks" in json.dumps(ok_tool(MCP_URL, ALL, "system_disks", {"host": "local"}))
    # The OpenTelemetry pages: the schema detection, a search over a small window.
    assert isinstance(ok_tool(MCP_URL, ALL, "traces_meta", {"host": "local"}), dict)
    assert isinstance(ok_tool(MCP_URL, ALL, "logs_meta", {"host": "local"}), dict)
    assert isinstance(ok_tool(MCP_URL, ALL, "metrics_meta", {"host": "local"}), dict)
    found = ok_tool(MCP_URL, ALL, "traces_search", {"host": "local", "params": {"lookback_minutes": 5, "limit": 3, "status": ["Error", "Ok"]}})
    assert found["source_host_id"] == "local"
    # A helper of the Query page.
    formatted = ok_tool(MCP_URL, ALL, "format_sql", {"host": "local", "body": {"sql": "select 1,2 from t where a=1"}})
    assert "SELECT" in json.dumps(formatted).upper()
    # The API answers an error: its code and message come back.
    # A window with one end only is a mistake; with no window the catalog reads the last 24 hours.
    assert fail_tool(MCP_URL, ALL, "metrics_catalog", {"host": "local", "params": {"start_ms": 1000}}, "invalid_metrics_range")["message"]
    assert "services" in ok_tool(MCP_URL, ALL, "metrics_catalog", {"host": "local"})
    # A route that this instance does not have (no query_library block): not_enabled.
    fail_tool(MCP_URL, ALL, "query_library", {"host": "local"}, "not_enabled")
    # The arguments are checked first.
    fail_tool(MCP_URL, ALL, "system_overview", {"host": "local", "params": {"host_id": "second"}}, "invalid_argument")
    fail_tool(MCP_URL, ALL, "system_query", {"host": "local"}, "invalid_argument")  # {hash} is required
    fail_tool(MCP_URL, ALL, "system_overview", {"host": "local", "nope": 1}, "invalid_argument")
    fail_tool(MCP_URL, ALL, "system_overview", {"host": "nope"}, "host_not_allowed")


# ---- the Explorer follows the patterns of the key, on top of the grants of the MCP user -----------------------------------------


@needs_clickhouse
def test_the_explorer_tools_follow_the_patterns_of_the_key():
    """What a key reaches is what the MCP user reads, cut by the patterns of the key: the two add up."""
    tools = ["explorer_catalog", "explorer_table", "explorer_table_data", "explorer_functions", "explorer_graph_definition", "format_sql"]
    key, secret = make_key(new_key_body("explorer-weather", tools=tools, databases=["chdash_ui.weather_*"], hosts=["local"]))
    try:
        # The catalog lists the database and the tables that a pattern allows, and nothing else.
        catalog = ok_tool(MCP_URL, secret, "explorer_catalog", {"host": "local"})
        assert catalog["databases"] == ["chdash_ui"], catalog["databases"]
        assert catalog["database_summaries"] == []  # a summary counts all the tables of the database: the key reads some
        listed = ok_tool(MCP_URL, secret, "explorer_catalog", {"host": "local", "params": {"database": "chdash_ui"}})["tables"]
        assert listed and all(t["name"].startswith("weather_") for t in listed), [t["name"] for t in listed]
        fail_tool(MCP_URL, secret, "explorer_catalog", {"host": "local", "params": {"database": "otel"}}, "database_not_allowed")
        # One table: allowed by a pattern, refused by the key, or refused by the MCP user (the two limits add up).
        assert ok_tool(MCP_URL, secret, "explorer_table", {"host": "local", "params": {"database": "chdash_ui", "table": "weather_observations"}})
        assert ok_tool(MCP_URL, secret, "explorer_table_data", {"host": "local", "body": {"database": "chdash_ui", "table": "weather_observations", "limit": 3}})
        for database, table in (("chdash_ui", "events"), ("otel", "otel_traces"), ("system", "query_log")):
            fail_tool(MCP_URL, secret, "explorer_table", {"host": "local", "params": {"database": database, "table": table}}, "table_not_allowed")
            fail_tool(MCP_URL, secret, "explorer_table_data", {"host": "local", "body": {"database": database, "table": table}}, "table_not_allowed")
            fail_tool(MCP_URL, secret, "explorer_graph_definition", {"host": "local", "params": {"database": database, "table": table}}, "table_not_allowed")
        # A name that is not one plain string is refused, never read by the API.
        for params in ({"database": ["system", "chdash_ui"], "table": "weather_observations"}, {"database": "chdash_ui"}, {"table": "weather_observations"}):
            fail_tool(MCP_URL, secret, "explorer_table", {"host": "local", "params": params}, "invalid_argument")
        # Tools that read no data answer; the ones about the server are not in the key.
        assert ok_tool(MCP_URL, secret, "format_sql", {"host": "local", "body": {"sqls": ["select 1"]}})
        assert [t["name"] for t in rpc(MCP_URL, secret, "tools/list").json()["result"]["tools"]] == tools
        # The graph, the storage and the names are read as the pages read them (the MCP user decides what is visible, the
        # system user adds the figures): any key may hold them. The SQL tools still need all the data.
        response = m("POST", "/api/mcp/keys", body=new_key_body("explorer-graph", tools=["explorer_graph"], databases=["chdash_ui"]))
        drop_key(api_ok(response, 201)["key"]["id"])
        api_error(m("POST", "/api/mcp/keys", body=new_key_body("explorer-sql", tools=["run_query"], databases=["chdash_ui"])), 400, "validation",
                  field="tools", reason="needs_all_data")
    finally:
        drop_key(key["id"])


# ---- the statements of a key are named for it, and their cost ---------------------------------------------------------------------


def query_log_rows(sql: str) -> list[list[str]]:
    """Rows of a read of system.query_log by the admin account, once the logs are flushed."""
    ch("SYSTEM FLUSH LOGS")
    return [line.split("\t") for line in ch(sql + " FORMAT TSV").splitlines() if line]


@needs_clickhouse
def test_the_statements_of_a_key_are_named_and_their_cost_is_read():
    # Every statement of a call is named chdash-mcp/<key id>/<tool>/<uuid> (its query_id): the tools that build their SQL, and the routes
    # that an API tool calls, System's too (their log_comment is 'chdash-system'). Each statement has an id of its own.
    key, secret = make_key(new_key_body("named", tools=["list_tables", "explorer_catalog", "system_overview"], databases=["chdash_ui"]))
    try:
        assert ok_tool(MCP_URL, secret, "list_tables", {"database": "chdash_ui"})["count"] >= 1
        ok_tool(MCP_URL, secret, "explorer_catalog", {"params": {"refresh": 1}})
        ok_tool(MCP_URL, secret, "system_overview", {"params": {"refresh": 1}})
        prefix = f"chdash-mcp/{key['id']}/"
        rows = query_log_rows(
            "SELECT splitByChar('/', query_id)[3] AS tool, user, toString(count()), toString(uniqExact(query_id)), "
            "toString(countIf(log_comment = 'chdash-system')) FROM system.query_log "
            f"WHERE event_date >= yesterday() AND startsWith(query_id, '{prefix}') AND type = 'QueryFinish' GROUP BY tool, user")
        assert {"list_tables", "explorer_catalog", "system_overview"} <= {row[0] for row in rows}, rows
        assert all(row[2] == row[3] for row in rows), rows  # one id for each statement
        assert any(row[0] == "system_overview" and int(row[4]) > 0 for row in rows), rows  # named, though labelled 'chdash-system'
        assert any(row[0] == "list_tables" and row[1] == "chdash_mcp" for row in rows), rows

        # The cost of the key: system.query_log of its host, read by the page with the runner account.
        cost = api_ok(m("GET", f"/api/mcp/keys/{key['id']}/cost?window=24h&refresh=1"))
        assert cost["status"] == "ok" and cost["reason"] == "" and cost["id"] == key["id"] and cost["host"] == "local", cost
        assert cost["window"] == "24h" and cost["clamped"] is False and cost["read_at"].endswith("Z") and cost["max_lookback_hours"] == 168
        totals = cost["totals"]
        assert totals["statements"] >= 3 and totals["statements"] >= totals["failed"] + totals["canceled"], totals
        assert {"list_tables", "explorer_catalog", "system_overview"} <= {t["tool"] for t in cost["tools"]}, cost["tools"]
        assert sum(t["statements"] for t in cost["tools"]) == totals["statements"]
        roles = {i["user"]: i["role"] for i in cost["identities"]}
        assert roles.get("chdash_mcp") == "mcp", roles
        assert all(role in ("mcp", "system") for role in roles.values()), roles
        assert all("." in t["name"] and t["statements"] >= 1 for t in cost["tables"]), cost["tables"]
        # Kept 60 s: a second read answers at once with the same read; refresh=1 reads again.
        again = api_ok(m("GET", f"/api/mcp/keys/{key['id']}/cost?window=24h"))
        assert again["read_at"] == cost["read_at"] and again["totals"] == totals
        week = api_ok(m("GET", f"/api/mcp/keys/{key['id']}/cost?window=7d"))
        assert week["status"] == "ok" and week["totals"]["statements"] >= totals["statements"]
        # The short windows: the last hour and the last 6 hours hold the statements of the calls that were just made.
        for window, seconds in (("1h", 3600), ("6h", 6 * 3600)):
            short = api_ok(m("GET", f"/api/mcp/keys/{key['id']}/cost?window={window}&refresh=1"))
            assert short["status"] == "ok" and short["window"] == window and short["clamped"] is False, short
            assert short["totals"]["statements"] >= 3 and short["totals"]["statements"] <= week["totals"]["statements"], short["totals"]
            assert 0 < (parse_time(short["to"]) - parse_time(short["from"])) <= seconds + 60
        api_error(m("GET", f"/api/mcp/keys/{key['id']}/cost?window=30d"), 400, "validation", field="window", reason="invalid")
        api_error(m("GET", f"/api/mcp/keys/{key['id']}/cost?window=12h"), 400, "validation", field="window", reason="invalid")
        api_error(m("GET", "/api/mcp/keys/ui_000000000000/cost"), 404, "not_found")
        assert secret not in json.dumps(cost) and "SELECT" not in json.dumps(cost)
        # A deleted key: its cost is read on the host that its usage kept.
        drop_key(key["id"])
        gone = api_ok(m("GET", f"/api/mcp/keys/{key['id']}/cost?window=24h"))
        assert gone["status"] == "ok" and gone["host"] == "local" and gone["totals"]["statements"] >= 3
    finally:
        drop_key(key["id"])


@needs_profile
def test_a_readonly_1_user_is_named_without_any_setting():
    # readonly = 1: ChDash sends no setting, so no log_comment; the query_id is not a setting, and names the statement all the same.
    if not CLICKHOUSE_URL:
        pytest.skip("needs CLICKHOUSE_URL")
    marker = f"named_{uuid.uuid4().hex[:8]}"
    ok_tool(PROFILE_URL, PROFILE_RO1, "run_query", {"sql": f"SELECT '{marker}' AS v"})
    rows = query_log_rows(
        "SELECT query_id, log_comment, user FROM system.query_log "
        f"WHERE event_date >= yesterday() AND type = 'QueryFinish' AND query LIKE '%{marker}%' AND query NOT LIKE '%system.query_log%'")
    assert rows, "the statement is not in query_log"
    query_id, log_comment, user = rows[-1]
    assert query_id.startswith("chdash-mcp/ro1/run_query/") and log_comment == "" and user == "chdash_mcp_ro1", rows[-1]


# ---- the API tools run as the MCP user -------------------------------------------------------------------------------------------


def _log_users(since: str, like: str, unlike: str = "") -> set[str]:
    ch("SYSTEM FLUSH LOGS")
    text = ch(
        "SELECT DISTINCT user FROM system.query_log WHERE type = 'QueryFinish' AND event_time >= toDateTime('" + since + "') "
        "AND query LIKE '" + like + "' AND query NOT LIKE '%system.query_log%' AND query NOT LIKE 'CHECK GRANT%' " + (("AND query NOT LIKE '" + unlike + "' ") if unlike else "") + "FORMAT TSV"
    )
    return {line for line in text.splitlines() if line}


@needs_mcp
def test_query_execution_tool_finds_a_run_of_the_query_page():
    """The registry keeps a run under its host; the tool asks with the MCP identity of that host (ARCH-B-069)."""
    run = SESSION.post(f"{MCP_URL}/api/query/run", json={"host_id": "local", "sql": "SELECT 1 AS one"}, timeout=15)
    assert run.status_code == 200, run.text
    query_id = run.json()["query_id"]
    with SESSION.get(f"{MCP_URL}/{run.json()['stream_url']}", stream=True, timeout=(10, 60)) as stream:
        assert stream.status_code == 200, stream.text
        for line in stream.iter_lines(decode_unicode=True):
            if line and line.startswith("event:") and line[6:].strip() in ("done", "error"):
                break
    key, secret = make_key(new_key_body("execution", tools=["query_execution"], databases=["*"], hosts=["local"]))
    try:
        found = ok_tool(MCP_URL, secret, "query_execution", {"host": "local", "params": {"query_id": query_id}})
        assert found["terminal_status"] == "finished", found
        assert found["run_mode"] == "normal", found
        # An unknown query is still not found.
        fail_tool(MCP_URL, secret, "query_execution", {"host": "local", "params": {"query_id": str(uuid.uuid4())}},
                  "execution_not_found")
    finally:
        drop_key(key["id"])


@needs_clickhouse
def test_api_tools_run_as_the_mcp_user_not_as_the_runner():
    """The pages read as the runner (visibility, data) and the system user (figures, the otel tables); a tool reads the data as the MCP user and keeps the system user for the rest."""
    key, secret = make_key(new_key_body("api-identity", tools=["*"], databases=["*"], hosts=["local"]))
    try:
        time.sleep(1.1)  # the queries of the test before end in an earlier second than `since`
        since = ch("SELECT toString(now())").strip()
        time.sleep(1.1)
        # The Explorer: what the MCP user may read (chdash_perf, which it cannot, is not there), a preview of rows.
        catalog = ok_tool(MCP_URL, secret, "explorer_catalog", {"host": "local"})
        assert "chdash_ui" in catalog["databases"] and "otel" in catalog["databases"]
        assert "chdash_perf" not in catalog["databases"] and "chdash_rich_scratch" not in catalog["databases"], catalog["databases"]
        assert catalog["host_id"] == "local"  # the identity of the call does not reach the client
        assert ok_tool(MCP_URL, secret, "explorer_table_data", {"host": "local", "body": {"database": "chdash_ui", "table": "weather_observations", "limit": 7}})
        # A table that the MCP user cannot read does not exist for it.
        fail_tool(MCP_URL, secret, "explorer_table", {"host": "local", "params": {"database": "chdash_perf", "table": "events"}}, "object_not_found")
        # The OpenTelemetry pages read with the MCP user too.
        assert isinstance(ok_tool(MCP_URL, secret, "traces_meta", {"host": "local"}), dict)
        users = _log_users(since, "%weather_observations%")
        assert "chdash_mcp" in users and "chdash_runner" not in users, users
        # The OpenTelemetry pages read their tables with the system user, as for the pages (the tools of Traces, Logs and
        # Metrics); the MCP user and the runner never read them for these tools.
        # (The grant checks and the zero-row probes of the Explorer only ask whether a table can be read: they are not a read of its data.)
        otel = _log_users(since, "%otel_traces%", "%LIMIT 0%")
        assert "chdash_system" in otel and "chdash_mcp" not in otel and "chdash_runner" not in otel, otel
    finally:
        drop_key(key["id"])


@needs_mcp
def test_the_identities_of_mcp_exist_only_for_the_tools():
    # A request that names an MCP identity of a host without the internal token of the process: the host is unknown.
    for suffix in ("%1Fmcp", "%1Fmcp-otel"):
        for path in ("/api/explorer/catalog", "/api/system/overview", "/api/traces/meta", "/api/logs/meta", "/api/meta"):
            response = m("GET", f"{path}?host_id=local{suffix}")
            assert response.status_code in (404, 200), (path, suffix, response.status_code)
            if path != "/api/meta":
                assert response.status_code == 404 and response.json()["error_code"] == "unknown_host", (path, suffix, response.text)
        response = SESSION.post(f"{MCP_URL}/api/format", json={"host_id": "local\x1fmcp", "sqls": ["select 1"]}, timeout=30)
        assert response.status_code == 404, response.text
    # A forged token does not help.
    forged = m("GET", "/api/explorer/catalog?host_id=local%1Fmcp", headers={"X-ChDash-Internal": "0" * 32})
    assert forged.status_code == 404
    # They are not listed either.
    hosts = m("GET", "/api/hosts").json()["hosts"]
    assert [h["id"] for h in hosts] == ["local", "second"] or all("\x1f" not in h["id"] for h in hosts)


@needs_mcp
def test_a_tool_that_the_mcp_user_cannot_run_says_which_grant_it_lacks():
    # The fixture user has no SELECT on system.query_log: the Queries tool of System works for the pages, not as the MCP user.
    key, secret = make_key(new_key_body("api-grants", tools=["*"], databases=["*"], hosts=["local"]))
    try:
        result = call_tool(MCP_URL, secret, "system_queries", {"host": "local"})
        if result["isError"]:
            payload = result["structuredContent"]
            assert payload["error"] == "permission_denied" and "GRANT SELECT ON" in payload["message"] and "chdash_mcp" in payload["message"], payload
        else:
            # The Queries panel reports the table that it cannot read inside the answer (not_granted), not as an error.
            assert "not_granted" in json.dumps(result["structuredContent"]) or result["structuredContent"]
    finally:
        drop_key(key["id"])


@needs_mcp
def test_api_tools_need_all_the_data():
    # A key cannot hold a SQL tool unless its data is "*": no table scope can narrow it.
    for name in ("run_query", "explain_query"):
        api_error(m("POST", "/api/mcp/keys", body=new_key_body("api-narrow", tools=[name], databases=["otel"])), 400, "validation",
                  field="tools", reason="needs_all_data")
    # The graph, the storage and the names are read as the pages read them: any key may hold them.
    for name in ("explorer_graph", "explorer_storage", "explorer_names", "system_overview"):
        made, secret_ = make_key(new_key_body("api-pages", tools=[name], databases=["otel"]))
        try:
            # The answer can be larger than the cap of this instance (20 KB): the key is allowed, which is what is tested.
            result = call_tool(MCP_URL, secret_, name, {"host": "local"})
            assert result["isError"] is False or result["structuredContent"]["error"] == "result_too_large", (name, result)
        finally:
            drop_key(made["id"])
    key, secret = make_key(new_key_body("api-wide", tools=["explorer_catalog", "system_overview"], databases=["*"]))
    try:
        assert [t["name"] for t in rpc(MCP_URL, secret, "tools/list").json()["result"]["tools"]] == ["explorer_catalog", "system_overview"]
        assert ok_tool(MCP_URL, secret, "explorer_catalog", {"host": "local"})["host_id"] == "local"
        # A tool that the key does not hold is refused, an API tool as any other.
        fail_tool(MCP_URL, secret, "system_disks", {"host": "local"}, "tool_not_allowed")
    finally:
        drop_key(key["id"])
    # The cap of the key on rows does not cut an API answer: the byte cap of the instance does.
    big = call_tool(MCP_URL, ALL, "explorer_functions", {"host": "local"})
    assert big["isError"] is True and big["structuredContent"]["error"] == "result_too_large"


# ---- users whose settings profile sets readonly ------------------------------------------------------------------------

SETTINGS_SQL = "SELECT getSetting('readonly') AS readonly, getSetting('max_execution_time') AS seconds, getSetting('max_result_rows') AS result_rows"


def profile_settings(key: str) -> dict:
    """What the statement of run_query saw as its own settings (the profile of the user, and what ChDash sent)."""
    result = ok_tool(PROFILE_URL, key, "run_query", {"sql": SETTINGS_SQL})
    return dict(zip([c["name"] for c in result["columns"]], result["rows"][0]))


def never_refused_a_setting(payload: dict) -> None:
    assert "Cannot modify" not in json.dumps(payload), payload


@needs_profile
def test_a_user_with_readonly_2_in_its_profile_serves_mcp():
    # The profile of a production server (readonly = 2): ClickHouse refuses to change `readonly`, even to 1, and a statement
    # that said readonly = 1 failed with "Cannot modify 'readonly' setting in readonly mode". ChDash sends it only to a profile
    # that leaves it at 0.
    databases = ok_tool(PROFILE_URL, PROFILE_RO2, "list_databases")
    never_refused_a_setting(databases)
    names = {d["name"] for d in databases["databases"]}
    # The three databases that the user reads, and system (it reads system.databases); not the fourth.
    assert names == {"chdash_ui", "otel", "otel_alt", "system"}, names
    never_refused_a_setting(ok_tool(PROFILE_URL, PROFILE_RO2, "list_tables", {"database": "chdash_ui"}))
    rows = ok_tool(PROFILE_URL, PROFILE_RO2, "run_query", {"sql": "SELECT count() AS n FROM chdash_ui.weather_observations"})
    assert rows["row_count"] == 1 and rows["rows"][0][0] != 0, rows
    # A fourth database is refused by ClickHouse, as a missing right and not as a refused setting.
    denied = fail_tool(PROFILE_URL, PROFILE_RO2, "run_query", {"sql": "SELECT * FROM chdash_denied.secret"})
    never_refused_a_setting(denied)
    assert denied["error"] == "permission_denied", denied


@needs_profile
def test_the_other_limits_are_still_sent_to_a_readonly_2_user():
    # readonly = 2 allows the other settings: the profile does not set these, so the limits of ChDash apply (this instance:
    # 5 seconds, 100 rows + 1).
    seen = profile_settings(PROFILE_RO2)
    assert seen["readonly"] == 2
    assert seen["seconds"] == 5 and seen["result_rows"] == 101, seen
    # The rows are capped at 100, and the cut is reported.
    result = ok_tool(PROFILE_URL, PROFILE_RO2, "run_query", {"sql": "SELECT number FROM system.numbers LIMIT 500"})
    assert result["row_count"] == 100 and result["truncated"] is True


@needs_profile
def test_a_readonly_2_user_cannot_raise_a_limit():
    # readonly = 2 lets a statement change its settings, and a SETTINGS clause wins over what ChDash sends: it would raise the
    # time, the memory and the rows to read of the key, or rename the statement. The clause is refused before ClickHouse.
    for key in (PROFILE_RO2, PROFILE_RO2CAP):
        for setting in ("max_execution_time = 3600", "max_result_rows = 0", "max_rows_to_read = 0", "max_memory_usage = 0", "log_comment = 'x'"):
            payload = fail_tool(PROFILE_URL, key, "run_query", {"sql": f"SELECT 1 SETTINGS {setting}"})
            assert payload["error"] == "clause_not_allowed", (key, setting, payload)
        fail_tool(PROFILE_URL, key, "explain_query", {"sql": "SELECT 1 SETTINGS max_execution_time = 3600"}, "clause_not_allowed")
    # The limits of ChDash still stand.
    assert profile_settings(PROFILE_RO2)["seconds"] == 5


@needs_profile
def test_the_profile_wins_over_the_configuration_and_a_stricter_key_still_lowers_it():
    # The profile has max_execution_time = 4 and max_result_rows = 7; the configuration says 5 seconds and 100 rows. The
    # profile is not contradicted: its values stand.
    seen = profile_settings(PROFILE_RO2CAP)
    assert seen["readonly"] == 2 and seen["seconds"] == 4 and seen["result_rows"] == 7, seen
    result = ok_tool(PROFILE_URL, PROFILE_RO2CAP, "run_query", {"sql": "SELECT number FROM system.numbers LIMIT 500"})
    assert result["row_count"] == 7 and result["truncated"] is True, result
    never_refused_a_setting(result)
    # A key that is stricter than the profile (3 rows) lowers it: a key can only lower, never raise.
    seen = profile_settings(PROFILE_RO2CAP_LOW)
    assert seen["result_rows"] == 4 and seen["seconds"] == 4, seen
    low = ok_tool(PROFILE_URL, PROFILE_RO2CAP_LOW, "run_query", {"sql": "SELECT number FROM system.numbers LIMIT 500"})
    assert low["row_count"] == 3 and low["truncated"] is True, low
    # Below the profile's cap the result is whole.
    whole = ok_tool(PROFILE_URL, PROFILE_RO2CAP, "run_query", {"sql": "SELECT number FROM system.numbers LIMIT 4"})
    assert whole["row_count"] == 4 and whole["truncated"] is False, whole


@needs_profile
def test_a_user_with_readonly_1_in_its_profile_serves_mcp_without_any_setting():
    # readonly = 1 in the profile: ClickHouse refuses every setting of a statement, so ChDash sends none; the profile holds the
    # limits and the cap on rows is the one of ChDash.
    assert profile_settings(PROFILE_RO1)["readonly"] == 1
    never_refused_a_setting(ok_tool(PROFILE_URL, PROFILE_RO1, "list_databases"))
    result = ok_tool(PROFILE_URL, PROFILE_RO1, "run_query", {"sql": "SELECT number FROM system.numbers LIMIT 500"})
    assert result["row_count"] == 100 and result["truncated"] is True, result


def profile_hosts() -> dict:
    """The hosts of /api/mcp/meta, once the access audit has read the profile of each MCP user."""
    deadline = time.time() + 60
    while True:
        meta = api_ok(m("GET", "/api/mcp/meta", base=PROFILE_URL))
        hosts = {h["name"]: h for h in meta["hosts"]}
        if all(h["mcp"]["state"] == "ok" and h["mcp"]["profile"]["known"] for h in hosts.values()) or time.time() > deadline:
            return hosts
        time.sleep(1)


@needs_profile
def test_the_page_says_what_a_key_can_ask_for_and_who_limits_it():
    # The configuration of the instance: 100 rows and 5 seconds. The profile of ro2cap: 7 rows and 4 seconds, so the ClickHouse user
    # binds; ro2 and ro1 set none of them, so the MCP server does.
    hosts = profile_hosts()
    assert hosts["ro2cap"]["mcp"]["limits"] == {"max_rows": {"value": 7, "source": "clickhouse"}, "timeout_seconds": {"value": 4, "source": "clickhouse"}}
    assert hosts["ro2"]["mcp"]["limits"] == {"max_rows": {"value": 100, "source": "mcp"}, "timeout_seconds": {"value": 5, "source": "mcp"}}
    assert hosts["ro2"]["mcp"]["profile"] == {"known": True, "readonly": 2, "max_execution_time": 0, "max_result_rows": 0}
    assert hosts["ro2cap"]["mcp"]["profile"]["max_result_rows"] == 7 and hosts["ro2cap"]["mcp"]["profile"]["max_execution_time"] == 4
    assert hosts["ro1"]["mcp"]["profile"]["readonly"] == 1


@needs_profile
def test_a_key_above_the_limit_of_the_clickhouse_user_is_refused_and_says_who_limits():
    profile_hosts()
    body = {"name": "above-profile", "hosts": ["ro2cap"], "tools": ["list_hosts"], "databases": ["*"], "max_rows": 8}
    refused = m("POST", "/api/mcp/keys", base=PROFILE_URL, body=body)
    assert refused.status_code == 400, refused.text
    payload = refused.json()
    assert payload["field"] == "max_rows" and payload["reason"] == "range", payload
    assert "between 1 and 7" in payload["message"] and "ClickHouse user" in payload["message"], payload
    body = {**body, "max_rows": 7, "timeout_seconds": 5}
    refused = m("POST", "/api/mcp/keys", base=PROFILE_URL, body=body)
    assert refused.status_code == 400 and refused.json()["field"] == "timeout_seconds", refused.text
    assert "ClickHouse user" in refused.json()["message"]
    # At the limit, and below it, a key is made. On a host without a limit in its profile the MCP configuration is the one that says.
    made = m("POST", "/api/mcp/keys", base=PROFILE_URL, body={**body, "timeout_seconds": 4})
    assert made.status_code == 201, made.text
    assert m("DELETE", f"/api/mcp/keys/{made.json()['key']['id']}", base=PROFILE_URL).status_code == 200
    plain = m("POST", "/api/mcp/keys", base=PROFILE_URL, body={"name": "above-config", "hosts": ["ro2"], "tools": ["list_hosts"], "databases": ["*"], "max_rows": 101})
    assert plain.status_code == 400 and "MCP configuration" in plain.json()["message"], plain.text
