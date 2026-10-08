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
- CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD: an admin account, to make the scratch
  database mcp_scratch (and to check what the MCP user could not change).
"""

from __future__ import annotations

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
STARTUP_CMD = os.environ.get("MCP_STARTUP_CMD", "")
# Where the binary sees the directory {dir} of the command (the mount point of a docker run; "{dir}" when the command runs on the host).
STARTUP_CONFIG_DIR = os.environ.get("MCP_STARTUP_CONFIG_DIR", "/cfg")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "").rstrip("/")
CLICKHOUSE_USER = os.environ.get("CLICKHOUSE_USER", "test")
CLICKHOUSE_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "test")

# Secrets of tests/config/mcp.hcl.
ALL = "all-data-secret-0123456789abcdef"
WEATHER = "weather-secret-0123456789abcdef"
OTEL = "otel-reader-secret-0123456789ab"
LIMITED = "limited-secret-0123456789abcdef"
TWO_HOSTS = "two-hosts-secret-0123456789abcd"
HOSTS_ONLY = "hosts-only-secret-0123456789abc"
NO_HOST = "no-host-secret-0123456789abcdef"
HASHED = "hashed-secret-0123456789abcdefgh"
RATE = "rate-test-secret-0123456789abcde"
# Of tests/config/mcp.seed.json.
SEED = "seed-secret-0123456789abcdefABCD"
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
    assert body["error"] == code, body
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
                         ("GET", "/api/mcp/keys/ui_000000000000/secret")]:
        body = {"name": "x"} if method == "POST" else None
        api_error(m(method, path, base=DISABLED_URL, body=body), 404, "mcp_disabled")
    assert m("POST", "/mcp", base=DISABLED_URL, body={}).status_code == 404
    # The page shell is served even when MCP is off (its "disabled" state shows the HCL); 404 only while mcp.html is absent.
    assert m("GET", "/mcp-integration", base=DISABLED_URL).status_code in (200, 404)
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
    tools = {t["name"]: t for t in meta["tools"]}
    assert list(tools)[:5] == ["list_hosts", "list_databases", "list_tables", "describe_table", "query_table"]
    groups = [g["id"] for g in meta["tool_groups"]]
    assert groups == ["schema", "read", "observability", "sql", "explorer", "system", "traces", "logs", "metrics", "library", "query"]
    assert all(set(g) == {"id", "title", "note"} and g["title"] and g["note"] for g in meta["tool_groups"])
    assert {t["group"] for t in meta["tools"]} <= set(groups)
    assert [n for n, t in tools.items() if t["group"] == "observability"] == ["list_services", "search_traces", "get_trace", "search_logs", "list_metrics", "query_metric"]
    assert tools["query_table"]["group"] == "read"
    # The API tools: one for each read function of the API, in the families of the pages; they need all the data.
    api_tools = {n: t for n, t in tools.items() if t["group"] in ("explorer", "system", "traces", "logs", "metrics", "library", "query")}
    assert len(api_tools) >= 40 and all(t["needs_all_data"] for t in api_tools.values())
    for name in ("explorer_catalog", "explorer_table", "system_overview", "traces_search", "logs_search", "metrics_series", "format_sql"):
        assert name in api_tools
    assert [n for n, t in tools.items() if t["needs_all_data"] and t["group"] == "sql"] == ["run_query", "explain_query"]
    assert all(isinstance(t["description"], str) and t["description"] for t in meta["tools"])
    assert meta["limits"] == {
        "max_rows": 100, "max_result_bytes": 20000, "query_timeout_seconds": 5, "max_sql_bytes": 2048,
        "max_memory_bytes": 536870912, "max_rows_to_read": 5000000, "rate_limit_per_minute": 120,
    }
    assert meta["name_pattern"] == "^[a-z0-9][a-z0-9_-]{0,31}$"
    assert meta["secret_min_bytes"] == 24
    assert "allowed_origins" not in meta and ORIGIN not in json.dumps(meta)
    version = m("GET", "/api/version").json()
    assert version["features"]["mcp"] == {"enabled": True}
    # The page route is a normal shell: 200 once the page exists, 404 before (the shell file belongs to the page).
    assert m("GET", "/mcp-integration").status_code in (200, 404)


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
    assert response.json()["error"] == "unauthorized"
    for key in ("", "chm_unknown", ALL[:-1], ALL + "x", ALL.upper()):
        assert post_mcp(MCP_URL, key, body).status_code == 401, key
    assert post_mcp(MCP_URL, None, body, headers={"Authorization": f"Basic {ALL}"}).status_code == 401
    assert post_mcp(MCP_URL, None, body, headers={"Authorization": ALL}).status_code == 401
    # The secret is never accepted in a query string or another header.
    assert SESSION.post(f"{MCP_URL}/mcp?key={ALL}", json=body, timeout=10).status_code == 401
    assert SESSION.post(f"{MCP_URL}/mcp", json=body, headers={"X-Api-Key": ALL}, timeout=10).status_code == 401
    # Secrets of every kind work: plain, hashed (secret_sha256), case of the scheme is free.
    for key in (ALL, HASHED):
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
        assert response.json()["error"] == "origin_not_allowed"
    # Listed (case of the host does not matter).
    assert post_mcp(MCP_URL, ALL, body, headers={"Origin": ORIGIN}).status_code == 200
    assert post_mcp(MCP_URL, ALL, body, headers={"Origin": ORIGIN.upper().replace("HTTPS", "https")}).status_code == 200
    # Even the origin of the server itself is not trusted: only the list counts.
    assert post_mcp(MCP_URL, ALL, body, headers={"Origin": MCP_URL}).status_code == 403


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
    assert response.json()["error"] == "payload_too_large"
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
    assert names(OTEL) == ["list_hosts", "list_databases", "list_tables", "describe_table", "query_table", "list_services", "search_traces", "get_trace", "search_logs", "list_metrics", "query_metric"]
    assert not [n for n in names(OTEL) if n.startswith(("explorer_", "system_", "traces_", "logs_", "metrics_"))]
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


@needs_mcp
def test_rate_limit_per_key():
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    seen = None
    for _ in range(140):  # 120 a minute: a burst of 120
        response = post_mcp(MCP_URL, RATE, body)
        if response.status_code == 429:
            seen = response
            break
        assert response.status_code == 200
    assert seen is not None, "no 429 after 140 calls"
    assert seen.json()["error"] == "rate_limited"
    assert 1 <= int(seen.headers["Retry-After"]) <= 60
    # Another key has its own bucket.
    assert post_mcp(MCP_URL, ALL, body).status_code == 200
    # One token comes back every half second.
    time.sleep(1.2)
    assert post_mcp(MCP_URL, RATE, body).status_code == 200


# ---- schema tools -----------------------------------------------------------------------------------------------------


@needs_mcp
def test_list_hosts():
    result = ok_tool(MCP_URL, ALL, "list_hosts")
    assert [h["name"] for h in result["hosts"]] == ["local", "second"]  # "plain" has no mcp_uri: invisible
    assert result["hosts"][0]["label"] == "Local ClickHouse"
    assert all(h["healthy"] in (True, False, None) for h in result["hosts"])
    only = ok_tool(MCP_URL, WEATHER, "list_hosts")
    assert [h["name"] for h in only["hosts"]] == ["local"]
    assert ok_tool(MCP_URL, NO_HOST, "list_hosts")["hosts"] == []


@needs_mcp
def test_host_resolution():
    # One host: optional. Several: required. A host the key lacks, or one without mcp_uri: refused.
    assert ok_tool(MCP_URL, WEATHER, "list_databases")["host"] == "local"
    assert ok_tool(MCP_URL, WEATHER, "list_databases", {"host": "local"})["host"] == "local"
    fail_tool(MCP_URL, TWO_HOSTS, "list_databases", {}, "host_required")
    assert ok_tool(MCP_URL, TWO_HOSTS, "list_databases", {"host": "second"})["host"] == "second"
    fail_tool(MCP_URL, WEATHER, "list_databases", {"host": "second"}, "host_not_allowed")
    fail_tool(MCP_URL, ALL, "list_databases", {"host": "plain"}, "host_not_allowed")
    fail_tool(MCP_URL, ALL, "list_databases", {"host": "nope"}, "host_not_allowed")
    fail_tool(MCP_URL, ALL, "list_databases", {}, "host_required")  # "*" = both hosts
    fail_tool(MCP_URL, NO_HOST, "list_databases", {}, "no_host")


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
    assert first["engine"] == "MergeTree" and first["total_rows"] > 0 and first["total_bytes"] > 0
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
    assert info["total_rows"] > 0
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
    ids = [r[0] for r in result["rows"]]
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
        return [r[0] for r in ok_tool(MCP_URL, WEATHER, "query_table", {**base, "filters": list(filters)})["rows"]]

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
    assert result["rows"] == [[0, "0", 0.0], [1, "1", 0.5], [2, "2", 1.0]]
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
def test_readonly_is_enforced_by_clickhouse():
    # Settings cannot be changed from inside the statement: readonly = 1 locks them.
    for setting in ("readonly = 0", "max_result_rows = 0", "max_execution_time = 3600", "max_memory_usage = 0", "max_rows_to_read = 0", "result_overflow_mode = 'throw'"):
        payload = fail_tool(MCP_URL, ALL, "run_query", {"host": "local", "sql": f"SELECT 1 SETTINGS {setting}"})
        assert payload["error"] == "readonly", (setting, payload)
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
    time.sleep(0.3)
    log = subprocess.run(LOGS_CMD, shell=True, capture_output=True, text=True, timeout=30)
    text = log.stdout + log.stderr
    assert marker not in text
    lines = [line for line in text.splitlines() if line.startswith("[mcp] ") and "call=tools/call:run_query" in line]
    assert lines
    last = lines[-1]
    assert "key=all-data" in last and "host=local" in last and "status=ok" in last and "duration_ms=" in last and "rows=1" in last
    assert any("status=401_unknown" in line for line in text.splitlines())
    assert ALL not in text and "chm_nope" not in text


# ---- keys: the page API ------------------------------------------------------------------------------------------------------------


KEY_FIELDS = {"id", "name", "source", "secret_hint", "secret_available", "hosts", "tools", "databases", "max_rows",
              "timeout_seconds", "created_at", "last_used_at"}


@needs_mcp
def test_list_keys_config_keys_first():
    body = api_ok(m("GET", "/api/mcp/keys"))
    keys = body["keys"]
    config = [k for k in keys if k["source"] == "config"]
    assert keys[:len(config)] == config  # config keys first
    by_name = {k["name"]: k for k in config}
    assert {"all-data", "weather-only", "otel-reader", "limited", "hashed"} <= set(by_name)
    for key in keys:
        assert set(key) == KEY_FIELDS
    key = by_name["weather-only"]
    # A config key with a plain secret can show it: the page asks for it (GET /api/mcp/keys/<id>/secret).
    assert key["id"] == "weather-only" and key["secret_hint"] == WEATHER[:8] and key["secret_available"] is True
    assert by_name["hashed"]["secret_hint"] == "" and by_name["hashed"]["secret_available"] is False
    assert key["hosts"] == ["local"] and key["databases"] == ["chdash_ui.weather_*"]
    assert key["tools"] == ["list_hosts", "list_databases", "list_tables", "describe_table", "query_table"]
    assert key["max_rows"] is None and key["timeout_seconds"] is None
    assert key["created_at"] is None
    assert by_name["limited"]["max_rows"] == 5 and by_name["limited"]["timeout_seconds"] == 1
    assert by_name["all-data"]["hosts"] == ["*"] and by_name["all-data"]["databases"] == ["*"]
    # The list never carries a secret or a hash: the secret has its own route.
    text = json.dumps(body)
    for secret in (ALL, WEATHER, HASHED, hashlib.sha256(HASHED.encode()).hexdigest()):
        assert secret not in text


@needs_mcp
def test_key_lifecycle():
    # A key is made or deleted: there is no edit, no rotation and no switch.
    key, secret = make_key(new_key_body(
        "lifecycle-a", hosts=["local", "second"], tools=["list_hosts", "query_table"], databases=["otel", "analytics.events"],
        max_rows=7, timeout_seconds=3))
    try:
        assert set(key) == KEY_FIELDS
        assert key["source"] == "ui" and key["id"].startswith("ui_") and len(key["id"]) == 15
        assert key["name"] == "lifecycle-a"
        assert key["hosts"] == ["local", "second"] and key["tools"] == ["list_hosts", "query_table"]
        assert key["databases"] == ["otel", "analytics.events"]
        assert key["max_rows"] == 7 and key["timeout_seconds"] == 3 and key["last_used_at"] is None
        assert key["created_at"].endswith("Z")
        assert UUID4.fullmatch(secret)
        assert key["secret_hint"] == secret[:8] and key["secret_available"] is True
        # Listed with the config keys, after them, without the secret.
        listed = api_ok(m("GET", "/api/mcp/keys"))
        assert secret not in json.dumps(listed)
        assert any(k["id"] == key["id"] for k in listed["keys"])
        # The secret works at once, with the scope of the key.
        assert [t["name"] for t in rpc(MCP_URL, secret, "tools/list").json()["result"]["tools"]] == ["list_hosts", "query_table"]
        assert [h["name"] for h in ok_tool(MCP_URL, secret, "list_hosts")["hosts"]] == ["local", "second"]
        fail_tool(MCP_URL, secret, "query_table", {"host": "local", "database": "chdash_ui", "table": "weather_observations"}, "table_not_allowed")
        again = next(k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["id"] == key["id"])
        assert again["last_used_at"] and again["last_used_at"].endswith("Z")
        # The page can show the secret again: it is the one that works.
        assert api_ok(m("GET", f"/api/mcp/keys/{key['id']}/secret")) == {"id": key["id"], "secret": secret}
        # There is no route to change a key.
        for method, path in (("PATCH", f"/api/mcp/keys/{key['id']}"), ("PUT", f"/api/mcp/keys/{key['id']}"), ("POST", f"/api/mcp/keys/{key['id']}/rotate")):
            assert m(method, path, body={"name": "other"}).status_code in (404, 405)
        assert rpc(MCP_URL, secret, "ping").status_code == 200
        # Delete.
        assert api_ok(m("DELETE", f"/api/mcp/keys/{key['id']}")) == {"ok": True, "id": key["id"]}
        assert rpc(MCP_URL, secret, "ping").status_code == 401
        api_error(m("DELETE", f"/api/mcp/keys/{key['id']}"), 404, "not_found")
        api_error(m("GET", f"/api/mcp/keys/{key['id']}/secret"), 404, "not_found")
        assert key["id"] not in json.dumps(api_ok(m("GET", "/api/mcp/keys")))
    finally:
        drop_key(key["id"])


@needs_mcp
def test_key_validation_errors():
    def invalid(body, field, reason, method="POST", path="/api/mcp/keys"):
        response = m(method, path, body=body)
        api_error(response, 400, "validation", field=field, reason=reason)

    good = new_key_body("validation-key")
    invalid({}, "name", "required")
    invalid({**good, "name": ""}, "name", "required")
    invalid({k: v for k, v in good.items() if k != "hosts"}, "hosts", "required")
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
    invalid({**good, "tools": ["drop_table"]}, "tools", "unknown_tool")
    invalid({**good, "tools": ["run_query"]}, "tools", "needs_all_data")
    invalid({**good, "tools": ["explain_query"], "databases": ["otel"]}, "tools", "needs_all_data")
    invalid({**good, "databases": ["a b"]}, "databases", "invalid")
    invalid({**good, "databases": ["db.", "x"]}, "databases", "invalid")
    invalid({**good, "databases": ["otel", "otel"]}, "databases", "duplicate")
    invalid({**good, "max_rows": 0}, "max_rows", "range")
    invalid({**good, "max_rows": 101}, "max_rows", "range")  # never above the server's cap
    invalid({**good, "timeout_seconds": 6}, "timeout_seconds", "range")
    # A field that no longer exists is ignored, like any unknown field.
    api_ok(m("POST", "/api/mcp/keys", body={**good, "name": "ignored-fields", "description": "x", "expires_at": "2020-01-01"}), 201)
    drop_key(next(k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["name"] == "ignored-fields")["id"])
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
            # A secret is read from the ChDash page only, like a change.
            api_error(m("GET", path + "/secret", headers=headers), 403, "cross_site_request")
        # Same origin passes, by the browser's header or by Origin = Host.
        host = MCP_URL.split("//", 1)[1]
        for headers in ({"Sec-Fetch-Site": "same-origin"}, {"Origin": f"http://{host}"}, {"Sec-Fetch-Site": "none"}):
            assert api_ok(m("GET", path + "/secret", headers=headers))["secret"] == secret
        assert api_ok(m("GET", path + "/secret", headers={"Sec-Fetch-Site": "same-origin"}))["secret"] == secret
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
def test_key_file_holds_the_hash_and_the_secret_and_is_private():
    key, secret = make_key(new_key_body("file-check"))
    try:
        path = Path(DATA_DIR) / "mcp_keys.json"
        assert path.exists()
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        text = path.read_text()
        assert secret in text  # the page shows it again: this file is the only place that has it
        document = json.loads(text)
        assert document["version"] == 1
        stored = next(k for k in document["keys"] if k["id"] == key["id"])
        assert stored["secret_sha256"] == hashlib.sha256(secret.encode()).hexdigest()
        assert stored["secret_hint"] == secret[:8]
        assert stored["name"] == "file-check" and stored["hosts"] == ["local"]
        assert "last_used_at" not in stored and stored["secret"] == secret
        assert "description" not in stored and "expires_at" not in stored
        # Config keys are never written.
        assert "weather-only" not in text and "all-data" not in text
        assert not [p for p in Path(DATA_DIR).iterdir() if ".tmp" in p.name]  # no temporary file is left
        assert "enabled" not in stored and "state" not in stored
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
        assert rpc(MCP_URL, secret, "ping").status_code == 200
        again = next(k for k in api_ok(m("GET", "/api/mcp/keys"))["keys"] if k["id"] == key["id"])
        assert again["max_rows"] == 9 and again["created_at"] == patched["created_at"]
        # The secret is still there to show, after the restart.
        assert api_ok(m("GET", f"/api/mcp/keys/{key['id']}/secret"))["secret"] == secret
        assert again["last_used_at"] is not None  # set by the ping just above, not read from the file
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
    # Showing a secret is a read: it works while the keys are read-only.
    assert api_ok(m("GET", "/api/mcp/keys/ui_0a1b2c3d4e5f/secret", base=RO_URL)) == {"id": "ui_0a1b2c3d4e5f", "secret": SEED}
    assert api_ok(m("GET", "/api/mcp/keys/cfg-reader/secret", base=RO_URL))["secret"] == "cfg-reader-secret-0123456789abc"
    # The keys of the file work.
    assert rpc(RO_URL, SEED, "ping").status_code == 200
    assert [t["name"] for t in rpc(RO_URL, SEED, "tools/list").json()["result"]["tools"]] == ["list_databases", "list_tables", "describe_table", "query_table"]
    assert ok_tool(RO_URL, SEED, "list_tables", {})["tables"]
    # Every write is refused.
    api_error(m("POST", "/api/mcp/keys", base=RO_URL, body=new_key_body()), 403, "manage_disabled")
    api_error(m("DELETE", "/api/mcp/keys/ui_0a1b2c3d4e5f", base=RO_URL), 403, "manage_disabled")
    api_error(m("DELETE", "/api/mcp/keys/cfg-reader", base=RO_URL), 403, "manage_disabled")
    assert rpc(RO_URL, SEED, "ping").status_code == 200
    if RO_DATA_DIR:
        document = json.loads((Path(RO_DATA_DIR) / "mcp_keys.json").read_text())
        assert [k["name"] for k in document["keys"]] == ["seed-key"]  # untouched


@needs_nostorage
def test_no_storage_instance():
    meta = api_ok(m("GET", "/api/mcp/meta", base=NOSTORAGE_URL))
    assert meta["storage_configured"] is False and meta["manage_from_ui"] is True and meta["can_manage"] is False
    assert [k["name"] for k in api_ok(m("GET", "/api/mcp/keys", base=NOSTORAGE_URL))["keys"]] == ["only-key"]
    api_error(m("POST", "/api/mcp/keys", base=NOSTORAGE_URL, body=new_key_body()), 409, "storage_not_configured")
    api_error(m("DELETE", "/api/mcp/keys/only-key", base=NOSTORAGE_URL), 409, "config_key")
    key = "only-key-secret-0123456789abcdef"
    assert rpc(NOSTORAGE_URL, key, "ping").status_code == 200
    assert [h["name"] for h in ok_tool(NOSTORAGE_URL, key, "list_hosts")["hosts"]] == ["local"]
    assert ok_tool(NOSTORAGE_URL, key, "list_databases")["databases"]


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
    secret    = "0123456789abcdef01234567"
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
def test_startup_error_4_same_name_or_same_secret():
    two_names = "mcp {\n enabled = true\n" + KEY % "" + KEY.replace("0123456789abcdef01234567", "abcdef0123456789abcdef01") % "" + "}\n" + HOSTS
    assert_config_error(start_binary(two_names), "two keys have the name k")
    second = KEY.replace('name      = "k"', 'name      = "k2"') % ""
    assert_config_error(start_binary("mcp {\n enabled = true\n" + KEY % "" + second + "}\n" + HOSTS), "same secret")
    # The same secret given as a hash.
    digest = hashlib.sha256(b"0123456789abcdef01234567").hexdigest()
    hashed = (KEY.replace('secret    = "0123456789abcdef01234567"', f'secret_sha256 = "{digest}"').replace('name      = "k"', 'name = "k2"')) % ""
    assert_config_error(start_binary("mcp {\n enabled = true\n" + KEY % "" + hashed + "}\n" + HOSTS), "same secret")
    # A key of the file with the name of a key of the config.
    file_keys = {"version": 1, "keys": [{"id": "ui_0a1b2c3d4e5f", "name": "k", "description": "", "secret_sha256": hashlib.sha256(b"another-secret-0123456789ab").hexdigest(),
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
    assert_config_error(start_binary("mcp {\n enabled = true\n" + (KEY % "").replace('    secret    = "0123456789abcdef01234567"\n', "") + "}\n" + HOSTS), "exactly one of secret, secret_file and secret_sha256")
    two = (KEY % "").replace('secret    = "0123456789abcdef01234567"', 'secret    = "0123456789abcdef01234567"\n secret_file = "/x"')
    assert_config_error(start_binary("mcp {\n enabled = true\n" + two + "}\n" + HOSTS), "exactly one of secret, secret_file and secret_sha256")
    short = (KEY % "").replace("0123456789abcdef01234567", "too-short")
    assert_config_error(start_binary("mcp {\n enabled = true\n" + short + "}\n" + HOSTS), "at least 24 bytes")
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
    # The scope of the key decides: a key with the tools but without the otel data reads nothing.
    key, secret = make_key(new_key_body("obs-no-otel", tools=["list_services", "search_traces", "search_logs", "list_metrics", "query_metric", "get_trace"],
                                        databases=["chdash_ui"]))
    try:
        for tool, arguments in (("list_services", {}), ("search_traces", {}), ("search_logs", {}), ("list_metrics", {}),
                                ("query_metric", {"metric": "x"}), ("get_trace", {"trace_id": uuid.uuid4().hex})):
            fail_tool(MCP_URL, secret, tool, arguments, "table_not_allowed")
    finally:
        drop_key(key["id"])
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
    assert fail_tool(MCP_URL, ALL, "metrics_catalog", {"host": "local"}, "invalid_metrics_range")["message"]
    # A route that this instance does not have (no query_library block): not_enabled.
    fail_tool(MCP_URL, ALL, "query_library", {"host": "local"}, "not_enabled")
    # The arguments are checked first.
    fail_tool(MCP_URL, ALL, "system_overview", {"host": "local", "params": {"host_id": "second"}}, "invalid_argument")
    fail_tool(MCP_URL, ALL, "system_query", {"host": "local"}, "invalid_argument")  # {hash} is required
    fail_tool(MCP_URL, ALL, "system_overview", {"host": "local", "nope": 1}, "invalid_argument")
    fail_tool(MCP_URL, ALL, "system_overview", {"host": "nope"}, "host_not_allowed")


@needs_mcp
def test_api_tools_need_all_the_data():
    # A key cannot hold an API tool unless its data is "*": no table scope can narrow them.
    api_error(m("POST", "/api/mcp/keys", body=new_key_body("api-narrow", tools=["explorer_catalog"], databases=["otel"])), 400, "validation",
              field="tools", reason="needs_all_data")
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
