"""The access of humans (docs/access.md; MCP server contract section 11, conformance cases U02 to U10).

Instances (the tests skip without them; in the official run, CHDASH_REQUIRE_FIXTURES=1 makes a missing one a failure):
- ACCESS_BASE_URL: tests/config/access.authzen.hcl (the compose service chdash_access), in the authzen mode, with two hosts on the
  same ClickHouse (local and other).
- ACCESS_PDP_URL: the fake PDP (tests/otel-fixture/fake_pdp.py, the compose service access_pdp). The tests set its answers and read
  what it received. It applies the prefix rule of the grants: "action@host:local" covers the host local and its databases.
- ACCESS_OTLP_URL: the fake OTLP receiver of that server (the compose service access_otlp_receiver), for the CLIENT spans.
- ACCESS_LOGS_CMD (optional): a command that prints the log of that server, for the decision records (U10).

The identity tokens are signed here with the test keys (identity_tokens.py); the server has their public keys
(tests/config/secrets/access-identity-keys.pem). U01 (no access block) is a unit test (tests/native/config_test.cpp) and a start of
the binary below when MCP_STARTUP_CMD is set.
"""
from __future__ import annotations

import http.client
import json
import os
import shlex
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import pytest
import requests

from identity_tokens import Ed25519Key, P256Key, b64url, make_token

BASE_URL = os.environ.get("ACCESS_BASE_URL", "").rstrip("/")
PDP_URL = os.environ.get("ACCESS_PDP_URL", "").rstrip("/")
OTLP_URL = os.environ.get("ACCESS_OTLP_URL", "").rstrip("/")
LOGS_CMD = os.environ.get("ACCESS_LOGS_CMD", "")
# The start of the binary on a configuration file (as in test_mcp.py): {dir} and {name} are the directory and the file.
STARTUP_CMD = os.environ.get("MCP_STARTUP_CMD", "")
STARTUP_CONFIG_DIR = os.environ.get("MCP_STARTUP_CONFIG_DIR", "/cfg")

needs_access = pytest.mark.skipif(not (BASE_URL and PDP_URL), reason="ACCESS_BASE_URL is not set")

# The test keys: their public keys are in tests/config/secrets/access-identity-keys.pem.
ED25519 = Ed25519Key(bytes(range(1, 33)))
P256 = P256Key(0x6D1E6A2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4D5E6F708192A3B4C5D6E7)
ISSUER = "https://access.test"
AUDIENCE = "db"
HEADER = "X-Identity-Token"
# The token of the MCP key "access" of the configuration (the file mcp-key-second-host).
MCP_TOKEN = "mcp_5ec0d000SecondHost0000000000000000000000000"
# The cache of the decisions of the instance (pdp.cache_ttl).
CACHE_TTL = 1.0

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})


def token(sub: str = "alice", *, key=ED25519, **changes) -> str:
    now = int(time.time())
    claims = {"iss": ISSUER, "sub": sub, "aud": AUDIENCE, "iat": now - 5, "exp": now + 240}
    claims.update(changes)
    return make_token(key, {k: v for k, v in claims.items() if v is not None})


def call(method: str, path: str, *, tok: str | None = "default", headers: dict | None = None, **kwargs) -> requests.Response:
    hdrs = dict(headers or {})
    if tok == "default":
        tok = token()
    if tok is not None:
        hdrs[HEADER] = tok
    return SESSION.request(method, f"{BASE_URL}{path}", headers=hdrs, timeout=kwargs.pop("timeout", 30), **kwargs)


def pdp(path: str, body: dict | None = None) -> dict:
    if body is None:
        response = SESSION.get(f"{PDP_URL}{path}", timeout=10)
    else:
        response = SESSION.post(f"{PDP_URL}{path}", json=body, timeout=10)
    response.raise_for_status()
    return response.json()


def answer(**order) -> None:
    """Sets the answers of the fake PDP, then waits for the cache of the server to forget the former ones."""
    pdp("/control/answer", order)
    time.sleep(CACHE_TTL + 0.2)


def received() -> list[dict]:
    return pdp("/control/received")["requests"]


def evaluations(request: dict) -> list[dict]:
    """The evaluations of one request to the PDP, with the defaults of the batch filled in."""
    body = request["body"]
    if request["path"] == "/access/v1/evaluation":
        return [{"subject": body["subject"], "action": body["action"], "resource": body["resource"]}]
    return [{"subject": item.get("subject", body.get("subject")), "action": item.get("action", body.get("action")),
             "resource": item.get("resource", body.get("resource"))} for item in body["evaluations"]]


def asked(action: str, since: int = 0) -> list[dict]:
    return [e for r in received()[since:] for e in evaluations(r) if e["action"]["name"] == action]


@pytest.fixture(autouse=True)
def fresh_pdp():
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})
        time.sleep(CACHE_TTL + 0.2)
    yield
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})


SYSTEM = "/api/system/overview?host_id=local"
# The resources that the server sends (docs/access.md, "Hosts").
SERVICE = {"type": "service", "id": AUDIENCE}


def host_resource(host: str) -> dict:
    return {"type": "host", "id": host, "properties": {"ancestors": [SERVICE]}}


def database_resource(host: str, database: str) -> dict:
    return {"type": "database", "id": database, "properties": {"ancestors": [SERVICE, {"type": "host", "id": host}]}}


# ---- U02, U03, U04: the identity token ----------------------------------------------------------------------------------


@needs_access
def test_u02_a_request_without_a_token_gets_401():
    for path in (SYSTEM, "/api/version", "/api/hosts", "/query", "/static/app_common.js"):
        response = call("GET", path, tok=None)
        assert response.status_code == 401, (path, response.status_code)
        assert response.json()["error_code"] == "unauthenticated"
    response = call("POST", "/api/query/run", tok=None, json={"host_id": "local", "sql": "SELECT 1"})
    assert response.status_code == 401
    # The server does not show a login page and does not redirect: the access gateway does that.
    assert "Location" not in response.headers


@needs_access
def test_u03_a_token_that_is_not_valid_gets_401():
    now = int(time.time())
    other = Ed25519Key(bytes(32))
    bad = {
        "signature": token(key=other),
        "issuer": token(iss="https://other"),
        "audience": token(aud="other"),
        "audience list": token(aud=["other", "x"]),
        "expired": token(iat=now - 100, exp=now - 1),
        "max_age": token(iat=now - 5, exp=now + 3600),
        "no subject": token(sub=None),
        "no iat": token(iat=None),
        "alg none": b64url(b'{"alg":"none"}') + "." + token().split(".")[1] + ".",
        "garbage": "not-a-token",
    }
    for name, value in bad.items():
        response = call("GET", SYSTEM, tok=value)
        assert response.status_code == 401, (name, response.status_code, response.text)
    # The valid forms: EdDSA, ES256, an audience in a list.
    for name, value in {"eddsa": token(), "es256": token(key=P256), "list": token(aud=["x", AUDIENCE])}.items():
        response = call("GET", "/api/version", tok=value)
        assert response.status_code == 200, (name, response.status_code, response.text)


@needs_access
def test_u04_a_token_in_a_cookie_or_a_query_parameter_gets_401():
    valid = token()
    response = SESSION.get(f"{BASE_URL}{SYSTEM}", cookies={HEADER: valid}, timeout=30)
    assert response.status_code == 401
    response = SESSION.get(f"{BASE_URL}{SYSTEM}&{HEADER}={valid}", timeout=30)
    assert response.status_code == 401
    response = SESSION.get(f"{BASE_URL}{SYSTEM}", headers={"Authorization": f"Bearer {valid}"}, timeout=30)
    assert response.status_code == 401
    # Two copies of the header: the reverse proxy must replace a header that a client sends, so two copies are refused.
    url = urlsplit(BASE_URL)
    connection = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=30)
    connection.putrequest("GET", SYSTEM)
    connection.putheader(HEADER, valid)
    connection.putheader(HEADER, valid)
    connection.endheaders()
    assert connection.getresponse().status == 401
    connection.close()


# ---- U05: the list of actions -------------------------------------------------------------------------------------------


@needs_access
def test_u05_the_actions_are_published_without_a_token():
    response = call("GET", "/.well-known/access-actions", tok=None)
    assert response.status_code == 200
    doc = response.json()
    assert doc["server"] == AUDIENCE
    actions = {a["name"]: a for a in doc["actions"]}
    assert "access" not in actions
    assert set(actions) == {
        "query.run.read", "query.run.write", "query.export", "library.read", "library.write", "explorer.read", "system.read",
        "system.kill_query", "observability.read", "mcp.keys.read", "mcp.keys.write", "mcp.usage.read",
    }
    # The tree under the service: host, then database (contract 11.4).
    assert doc["resource_types"] == [
        {"name": "host", "parent": "service", "description": doc["resource_types"][0]["description"]},
        {"name": "database", "parent": "host", "description": doc["resource_types"][1]["description"]},
    ]
    for name in ("query.run.read", "query.run.write", "explorer.read"):
        assert actions[name]["resource_types"] == ["service", "host", "database"], name
    for name in ("query.export", "system.read", "system.kill_query", "observability.read"):
        assert actions[name]["resource_types"] == ["service", "host"], name
    for name in ("library.read", "library.write", "mcp.keys.read", "mcp.keys.write", "mcp.usage.read"):
        assert actions[name]["resource_types"] == ["service"], name
    assert all(a["description"] for a in actions.values())
    # The probes need no token either.
    assert call("GET", "/livez", tok=None).status_code == 200


# ---- U06, U07, U08, U09: the decisions ----------------------------------------------------------------------------------


@needs_access
def test_u06_the_pdp_receives_the_subject_the_action_and_the_host():
    response = call("GET", SYSTEM, tok=token("bob"))
    assert response.status_code == 200, response.text
    requests_ = received()
    assert requests_, "the PDP received nothing"
    last = requests_[-1]
    assert last["authorization"] == "Bearer pdp-test-token"
    assert last["request_id"] == response.headers["X-Request-Id"]
    assert last["traceparent"].startswith("00-")
    [evaluation] = [e for e in evaluations(last) if e["action"]["name"] == "system.read"]
    assert evaluation["subject"] == {"type": "user", "id": "bob"}
    # System reads one host: the question names the host, with the service as its ancestor.
    assert evaluation["resource"] == host_resource("local")


@needs_access
def test_u07_a_false_decision_gives_403_with_the_action_and_a_true_one_200():
    answer(deny=["system.read"])
    response = call("GET", SYSTEM)
    assert response.status_code == 403
    body = response.json()
    assert body["error_code"] == "forbidden" and body["action"] == "system.read"
    assert "system.read" in body["message"]
    # Another action of the same user is not touched.
    assert call("GET", "/api/query-library").status_code in (404, 200)
    answer(default=True)
    assert call("GET", SYSTEM).status_code == 200


@needs_access
def test_u08_no_answer_or_an_error_of_the_pdp_gives_403():
    answer(status=500)
    assert call("GET", SYSTEM).status_code == 403
    answer(delay_ms=1500)  # pdp.timeout is 500ms
    started = time.monotonic()
    assert call("GET", SYSTEM).status_code == 403
    assert time.monotonic() - started < 1.4
    # The failure is never kept: the next answer applies at once.
    pdp("/control/answer", {"default": True})
    assert call("GET", SYSTEM).status_code == 200


@needs_access
def test_u09_a_change_of_the_answer_applies_after_cache_ttl_at_most():
    assert call("GET", SYSTEM).status_code == 200
    pdp("/control/answer", {"deny": ["system.read"]})
    deadline = time.monotonic() + CACHE_TTL + 1.0
    status = 200
    while time.monotonic() < deadline:
        status = call("GET", SYSTEM).status_code
        if status == 403:
            break
        time.sleep(0.1)
    assert status == 403


@needs_access
def test_u10_the_log_has_each_decision():
    if not LOGS_CMD:
        pytest.skip("ACCESS_LOGS_CMD is not set")
    answer(deny=["system.read"])
    response = call("GET", SYSTEM, tok=token("dora"))
    assert response.status_code == 403
    request_id = response.headers["X-Request-Id"]
    time.sleep(0.5)
    log = subprocess.run(LOGS_CMD, shell=True, capture_output=True, text=True, timeout=60)
    records = [json.loads(line) for line in (log.stdout + log.stderr).splitlines() if line.startswith("{")]
    decisions = [r for r in records if r.get("event") == "access.decision" and r.get("request_id") == request_id]
    assert decisions, "no access.decision record"
    assert decisions[0]["subject"] == "dora" and decisions[0]["action"] == "system.read"
    assert decisions[0]["resource"] == f"service:{AUDIENCE}/host:local" and decisions[0]["decision"] is False
    access = [r for r in records if r.get("event") == "http.request" and r.get("request_id") == request_id]
    assert access and access[0]["subject"] == "dora" and access[0]["status"] == 403


# ---- the enforcement in the operation (11.6) ----------------------------------------------------------------------------


def run_sql(sql: str, tok: str) -> list[dict]:
    response = call("POST", "/api/query/run", tok=tok, json={"host_id": "local", "sql": sql})
    assert response.status_code == 200, response.text
    stream = urljoin(BASE_URL + "/", response.json()["stream_url"])
    events = []
    with SESSION.get(stream, headers={HEADER: tok, "Accept": "text/event-stream"}, stream=True, timeout=(10, 60)) as reply:
        assert reply.status_code == 200, reply.text
        name, data = "message", []
        for raw in reply.iter_lines(decode_unicode=True):
            line = raw or ""
            if not line:
                if data:
                    events.append({"event": name, "data": json.loads("\n".join(data))})
                    if name in ("done", "error"):
                        break
                name, data = "message", []
                continue
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
    return events


def cells(events: list[dict]) -> list:
    return [cell for e in events if e["event"] == "result_rows" for row in e["data"]["rows"] for cell in (row if isinstance(row, list) else row.values())]


@needs_access
def test_query_run_read_runs_with_readonly_1_and_query_run_write_without():
    answer(deny=["query.run.write"])
    tok = token("reader")
    events = run_sql("SELECT toString(getSetting('readonly')) AS ro", tok)
    assert any(str(c) == "1" for c in cells(events)), events
    # A statement that changes a setting fails in ClickHouse.
    events = run_sql("SET max_threads = 1", tok)
    assert any(e["event"] == "error" for e in events), events
    answer(default=True)
    events = run_sql("SELECT toString(getSetting('readonly')) AS ro", token("writer"))
    assert any(str(c) == "0" for c in cells(events)), events


@needs_access
def test_a_run_needs_query_run_read_or_query_run_write():
    answer(deny=["query.run.read", "query.run.write"])
    response = call("POST", "/api/query/run", json={"host_id": "local", "sql": "SELECT 1"})
    assert response.status_code == 403 and response.json()["action"] == "query.run.read"
    # An export runs SQL: query.export alone is not enough.
    for path in ("/api/export/run", "/api/export/stream"):
        response = call("POST", path, json={"host_id": "local", "queries": ["SELECT 1"], "format": "csv"})
        assert response.status_code == 403 and response.json()["action"] == "query.run.read", (path, response.text)
    answer(deny=["query.export"])
    response = call("POST", "/api/export/run", json={"host_id": "local", "queries": ["SELECT 1"], "format": "csv"})
    assert response.status_code == 403 and response.json()["action"] == "query.export"


# ---- the hosts (docs/access.md, "Hosts") ---------------------------------------------------------------------------------


def run_sql_on(host: str, sql: str, tok: str) -> list[dict]:
    response = call("POST", "/api/query/run", tok=tok, json={"host_id": host, "sql": sql})
    assert response.status_code == 200, response.text
    stream = urljoin(BASE_URL + "/", response.json()["stream_url"])
    events = []
    with SESSION.get(stream, headers={HEADER: tok, "Accept": "text/event-stream"}, stream=True, timeout=(10, 60)) as reply:
        assert reply.status_code == 200, reply.text
        name, data = "message", []
        for raw in reply.iter_lines(decode_unicode=True):
            line = raw or ""
            if not line:
                if data:
                    events.append({"event": name, "data": json.loads("\n".join(data))})
                    if name in ("done", "error"):
                        break
                name, data = "message", []
                continue
            if line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
    return events


def first_hosts_event(tok: str) -> dict:
    with SESSION.get(f"{BASE_URL}/api/hosts/stream", headers={HEADER: tok, "Accept": "text/event-stream"}, stream=True,
                     timeout=(10, 30)) as reply:
        assert reply.status_code == 200, reply.text
        name, data = "message", []
        for raw in reply.iter_lines(decode_unicode=True):
            line = raw or ""
            if not line and data:
                if name == "hosts":
                    return json.loads("\n".join(data))
                name, data = "message", []
            elif line.startswith("event:"):
                name = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
    raise AssertionError("no hosts event")


@needs_access
def test_a_grant_on_one_host_shows_and_allows_that_host_only():
    answer(default=False, allow=["system.read@host:local", "explorer.read@host:local", "mcp.keys.read", "mcp.keys.write"])
    tok = token("host-tenant")
    # The host list, its stream and the MCP page name only the host of the grant.
    hosts = call("GET", "/api/hosts", tok=tok)
    assert hosts.status_code == 200 and [h["id"] for h in hosts.json()["hosts"]] == ["local"], hosts.text[:300]
    assert [h["id"] for h in first_hosts_event(tok)["hosts"]] == ["local"]
    meta = call("GET", "/api/mcp/meta", tok=tok).json()
    assert [h["name"] for h in meta["hosts"]] == ["local"], meta["hosts"]
    # The page of the actions: one batch with the hosts, and the decisions of the visible host only.
    access = call("GET", "/api/version", tok=tok).json()["features"]["access"]
    assert set(access["hosts"]) == {"local"} and access["hosts"]["local"]["system.read"] is True, access
    assert access["actions"]["system.read"] is True and access["actions"]["query.run.read"] is False
    # The routes of the host of the grant work; the other host is refused like a host that does not exist.
    assert call("GET", SYSTEM, tok=tok).status_code == 200
    hidden = call("GET", "/api/system/overview?host_id=other", tok=tok)
    unknown = call("GET", "/api/system/overview?host_id=nosuch", tok=tok)
    assert hidden.status_code == unknown.status_code == 403, (hidden.text, unknown.text)
    assert hidden.json() == unknown.json() and hidden.json()["action"] == "system.read"
    assert call("GET", "/api/explorer/catalog?host_id=local", tok=tok).status_code == 200
    assert call("GET", "/api/explorer/catalog?host_id=other", tok=tok).status_code == 403
    # The pages: System and Explorer, not Query.
    assert call("GET", "/system", tok=tok).status_code == 200
    assert call("GET", "/query", tok=tok).status_code == 403
    # An MCP key on the hidden host is refused, as on a host that does not exist.
    for host in ("other", "nosuch"):
        refused = make_mcp_key(tok, f"hidden-{uuid.uuid4().hex[:8]}", ["system_overview"], ["*"], host=host)
        assert refused.status_code == 403 and refused.json()["action"] == "system.read", (host, refused.text)


@needs_access
def test_a_grant_on_one_database_of_one_host_allows_that_database_only():
    answer(default=False, allow=["explorer.read@host:other/database:chdash_ui"])
    tok = token("db-tenant")
    assert call("GET", "/api/explorer/table?host_id=other&database=chdash_ui&table=weather_buffer", tok=tok).status_code == 200
    preview = call("POST", "/api/explorer/table/data", tok=tok,
                   json={"host_id": "other", "database": "chdash_ui", "table": "weather_buffer", "limit": 1})
    assert preview.status_code == 200, preview.text[:300]
    # The same database of the other host, another database of the same host, and the whole host are refused.
    assert call("GET", "/api/explorer/table?host_id=local&database=chdash_ui&table=weather_buffer", tok=tok).status_code == 403
    preview = call("POST", "/api/explorer/table/data", tok=tok,
                   json={"host_id": "local", "database": "chdash_ui", "table": "weather_buffer", "limit": 1})
    assert preview.status_code == 403
    assert call("GET", "/api/explorer/table?host_id=other&database=system&table=one", tok=tok).status_code == 403
    assert call("GET", "/api/explorer/catalog?host_id=other", tok=tok).status_code == 403
    # A grant below a host does not show the host: the PDP answers no question on the host itself.
    assert call("GET", "/api/hosts", tok=tok).json()["hosts"] == []
    # The question named the database under its host.
    resources = [e["resource"] for e in asked("explorer.read")]
    assert database_resource("other", "chdash_ui") in resources and database_resource("local", "chdash_ui") in resources


@needs_access
def test_the_one_level_grant_of_1_0_8_covers_no_host():
    # Before 1.1.0, a grant on database:chdash_ui covered that database on every host. The path service/database now names no
    # resource of the tree (the parent of a database is its host): it covers nothing.
    answer(default=False, allow=["explorer.read@database:chdash_ui"])
    tok = token("legacy-tenant")
    for host in ("local", "other"):
        response = call("GET", f"/api/explorer/table?host_id={host}&database=chdash_ui&table=weather_buffer", tok=tok)
        assert response.status_code == 403, (host, response.text)
    assert call("GET", "/api/hosts", tok=tok).json()["hosts"] == []


@needs_access
def test_readonly_follows_the_host_of_the_run():
    # query.run.read on local, query.run.write on other: a run on local has readonly = 1, a run on other has not.
    answer(default=False, allow=["query.run.read@host:local", "query.run.write@host:other"])
    tok = token("split-runner")
    events = run_sql_on("local", "SELECT toString(getSetting('readonly')) AS ro", tok)
    assert any(str(c) == "1" for c in cells(events)), events
    events = run_sql_on("other", "SELECT toString(getSetting('readonly')) AS ro", tok)
    assert any(str(c) == "0" for c in cells(events)), events
    # The names of the editor follow the same rule for one database: write on one database of local lifts readonly there only.
    answer(default=False, allow=["query.run.read@host:local", "query.run.write@host:local/database:chdash_ui"])
    meta = call("GET", "/api/meta?host_id=local&database=chdash_ui&types=databases", tok=tok)
    assert meta.status_code == 200, meta.text[:300]
    # A run on a host without a run action is refused, and so is an export there.
    answer(default=False, allow=["query.run.read@host:local", "query.export@host:local"])
    refused = call("POST", "/api/query/run", tok=tok, json={"host_id": "other", "sql": "SELECT 1"})
    assert refused.status_code == 403 and refused.json()["action"] == "query.run.read", refused.text
    export = call("POST", "/api/export/run", tok=tok, json={"host_id": "other", "queries": ["SELECT 1"], "format": "csv"})
    assert export.status_code == 403 and export.json()["action"] == "query.export", export.text
    # Without a run action on any host, the run is refused before the server reads the body.
    answer(default=False, allow=["system.read@host:local"])
    refused = call("POST", "/api/query/run", tok=tok, json={"host_id": "local", "sql": "SELECT 1"})
    assert refused.status_code == 403 and "close" in refused.headers.get("Connection", "").lower(), refused.headers


@needs_access
def test_explorer_read_on_one_database():
    # A grant on the database chdash_ui only: its table opens, the database system does not, and the whole catalog neither.
    answer(default=False, allow=["explorer.read@host:local/database:chdash_ui"])
    ok = call("GET", "/api/explorer/table?host_id=local&database=chdash_ui&table=weather_buffer")
    assert ok.status_code != 403, ok.text
    denied = call("GET", "/api/explorer/table?host_id=local&database=system&table=one")
    assert denied.status_code == 403 and denied.json()["action"] == "explorer.read"
    assert call("GET", "/api/explorer/catalog?host_id=local").status_code == 403
    # The data preview names its database in the body.
    preview = call("POST", "/api/explorer/table/data", json={"host_id": "local", "database": "system", "table": "one", "limit": 1})
    assert preview.status_code == 403
    preview = call("POST", "/api/explorer/table/data", json={"host_id": "local", "database": "chdash_ui", "table": "weather_buffer", "limit": 1})
    assert preview.status_code != 403, preview.text
    resources = [(e["action"]["name"], e["resource"]) for r in received() for e in evaluations(r)]
    assert ("explorer.read", database_resource("local", "chdash_ui")) in resources
    # The same database of the other host is another resource.
    assert call("GET", "/api/explorer/table?host_id=other&database=chdash_ui&table=weather_buffer").status_code == 403


@needs_access
def test_a_grant_on_one_database_keeps_only_that_database_in_each_answer():
    # storage, graph and the names of the editor read every database: their answers keep only the databases that the PDP allows.
    answer(default=False, allow=["explorer.read@host:local/database:chdash_ui", "query.run.read@host:local/database:chdash_ui"])
    tok = token("tenant")
    storage = call("GET", "/api/explorer/storage?host_id=local&database=chdash_ui", tok=tok)
    assert storage.status_code == 200, storage.text
    names = {d["name"] for d in storage.json()["databases"]}
    assert names <= {"chdash_ui"} and "otel" not in storage.text, names
    # A focus in another database is refused; the unfocused graph names no other database.
    focused = call("GET", "/api/explorer/graph?host_id=local&database=chdash_ui&focus_database=otel&focus_table=otel_traces", tok=tok)
    assert focused.status_code == 403 and focused.json()["action"] == "explorer.read", focused.text
    graph = call("GET", "/api/explorer/graph?host_id=local&database=chdash_ui", tok=tok)
    assert graph.status_code == 200, graph.text
    assert {n.get("database", "") for n in graph.json()["nodes"]} <= {"chdash_ui", ""}, graph.text[:500]
    meta = call("GET", "/api/meta?host_id=local&database=chdash_ui&types=databases,tables", tok=tok)
    assert meta.status_code == 200, meta.text
    body = meta.json()["data"]
    assert {i["name"] for i in body["databases"]["items"]} == {"chdash_ui"}, body["databases"]
    assert {i["database"] for i in body["tables"]["items"]} == {"chdash_ui"}, body["tables"]["items"][:5]
    # The decisions came in one batch for each answer, with each database of the answer.
    asked_databases = {e["resource"]["id"] for e in asked("explorer.read") if e["resource"]["type"] == "database"}
    assert "chdash_ui" in asked_databases and len(asked_databases) > 1, asked_databases
    # With the service, nothing is cut.
    answer(default=True)
    full = call("GET", "/api/explorer/storage?host_id=local", tok=tok)
    assert full.status_code == 200 and len(full.json()["databases"]) > 1, full.text[:300]


CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "").rstrip("/")


def clickhouse(sql: str) -> None:
    response = SESSION.post(CLICKHOUSE_URL, data=sql.encode(), timeout=60,
                            auth=(os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test")))
    assert response.status_code == 200, response.text


@needs_access
@pytest.mark.skipif(not CLICKHOUSE_URL, reason="CLICKHOUSE_URL is not set")
def test_a_grant_on_one_database_hides_the_targets_in_other_databases():
    # The card of a table and the definition of a graph object name other databases: the related objects and the target of a
    # Distributed table. A grant on the database of the table keeps only what it names in that database (user decision 2026-10-18).
    clickhouse("CREATE DATABASE IF NOT EXISTS chdash_access_cross")
    clickhouse("CREATE TABLE IF NOT EXISTS chdash_access_cross.to_ui AS chdash_ui.weather_observations "
               "ENGINE = Distributed(chdash_cluster, chdash_ui, weather_observations)")
    try:
        answer(default=False, allow=["explorer.read@host:local/database:chdash_access_cross"])
        tok = token("cross-tenant")
        card = call("GET", "/api/explorer/table?host_id=local&database=chdash_access_cross&table=to_ui&refresh=1", tok=tok)
        assert card.status_code == 200, card.text[:300]
        detail = card.json()
        assert detail["distributed"]["cluster"] == "chdash_cluster", detail.get("distributed")
        assert detail["distributed"]["database"] == "" and detail["distributed"]["table"] == "", detail["distributed"]
        assert all(d["database"] != "chdash_ui" for d in detail["dependencies"]), detail["dependencies"]
        # The DDL text and engine_full mask the target database and its table (user decision 2026-10-18).
        assert "chdash_ui" not in detail["ddl"] and "weather_observations" not in detail["ddl"], detail["ddl"]
        assert "[HIDDEN]" in detail["ddl"] and "chdash_cluster" in detail["ddl"], detail["ddl"]
        assert "chdash_ui" not in detail["summary"]["engine_full"] and "[HIDDEN]" in detail["summary"]["engine_full"], detail["summary"]
        assert "chdash_ui" not in card.text and "weather_observations" not in card.text
        # The catalog of the database gives no engine_full and no DDL: it names no other database.
        catalog = call("GET", "/api/explorer/catalog?host_id=local&database=chdash_access_cross&refresh=1", tok=tok)
        assert catalog.status_code == 200, catalog.text[:300]
        listed = [t for t in catalog.json()["tables"] if t["name"] == "to_ui"]
        assert listed and "chdash_ui" not in json.dumps(listed), listed
        definition = call("GET", "/api/explorer/graph/definition?host_id=local&database=chdash_access_cross&table=to_ui&refresh=1", tok=tok)
        assert definition.status_code == 200, definition.text[:300]
        assert definition.json()["target_visible"] is False and definition.json()["target"] is None, definition.text[:300]
        asked_databases = {e["resource"]["id"] for e in asked("explorer.read") if e["resource"]["type"] == "database"}
        assert "chdash_ui" in asked_databases, asked_databases
        # With a grant on the two databases, the targets are there.
        answer(default=False, allow=["explorer.read@host:local/database:chdash_access_cross", "explorer.read@host:local/database:chdash_ui"])
        card = call("GET", "/api/explorer/table?host_id=local&database=chdash_access_cross&table=to_ui", tok=tok).json()
        assert card["distributed"]["database"] == "chdash_ui" and card["distributed"]["table"] == "weather_observations", card["distributed"]
        assert "chdash_ui" in card["ddl"] and "[HIDDEN]" not in card["ddl"], card["ddl"]
        assert "chdash_ui" in card["summary"]["engine_full"], card["summary"]
        definition = call("GET", "/api/explorer/graph/definition?host_id=local&database=chdash_access_cross&table=to_ui", tok=tok).json()
        assert definition["target"] == {"database": "chdash_ui", "table": "weather_observations"}, definition
    finally:
        clickhouse("DROP DATABASE IF EXISTS chdash_access_cross SYNC")


def make_mcp_key(tok: str, name: str, tools: list[str], databases: list[str], host: str = "local") -> requests.Response:
    body = {"name": name, "hosts": [host], "tools": tools, "databases": databases}
    return call("POST", "/api/mcp/keys", tok=tok, headers={"Sec-Fetch-Site": "same-origin"}, json=body)


def mcp_call(secret: str, tool: str, arguments: dict | None = None) -> requests.Response:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments or {}}}
    return SESSION.post(f"{BASE_URL}/mcp", data=json.dumps(body), timeout=30,
                        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"})


@needs_access
def test_an_mcp_key_never_has_more_than_its_creator():
    # mcp.keys.write alone does not give a key the read actions that the PDP refuses to its creator.
    answer(default=False, allow=["mcp.keys.read", "mcp.keys.write"])
    tok = token("integrator")
    for tools, action in ((["system_overview"], "system.read"), (["query_library"], "library.read"),
                          (["mcp_analysis_all_usage"], "mcp.usage.read"), (["traces_search"], "observability.read"),
                          (["list_databases"], "explorer.read")):
        refused = make_mcp_key(tok, f"refused-{uuid.uuid4().hex[:8]}", tools, ["*"])
        assert refused.status_code == 403 and refused.json()["action"] == action, (tools, refused.text)
    # With explorer.read on one database, a key on that database is made, and it names its creator.
    answer(default=False, allow=["mcp.keys.read", "mcp.keys.write", "explorer.read@host:local/database:chdash_ui"])
    assert make_mcp_key(tok, f"wide-{uuid.uuid4().hex[:8]}", ["list_databases"], ["*"]).status_code == 403
    # The same database on the other host: the creator holds nothing there.
    assert make_mcp_key(tok, f"elsewhere-{uuid.uuid4().hex[:8]}", ["list_databases"], ["chdash_ui"], host="other").status_code == 403
    made = make_mcp_key(tok, f"bound-{uuid.uuid4().hex[:8]}", ["list_hosts", "list_databases", "list_tables"], ["chdash_ui"])
    assert made.status_code == 201, made.text
    key, secret = made.json()["key"], made.json()["secret"]
    try:
        assert key["creator"] == "integrator" and key["source"] == "ui"
        listed = call("GET", "/api/mcp/keys", tok=tok).json()["keys"]
        assert [k["creator"] for k in listed if k["id"] == key["id"]] == ["integrator"]
        time.sleep(CACHE_TTL + 0.2)  # the decisions of the creation are in the cache: let them expire
        before = len(received())
        working = mcp_call(secret, "list_databases")
        assert working.status_code == 200 and "error" not in working.json(), working.text
        assert working.json()["result"]["isError"] is False, working.text
        # The use asks the PDP for the creator.
        uses = [e for r in received()[before:] for e in evaluations(r)]
        assert any(e["subject"]["id"] == "integrator" and e["action"]["name"] == "explorer.read"
                   and e["resource"] == database_resource("local", "chdash_ui") for e in uses), uses
        # The creator loses the grant but still exists (a false decision without a reason): the key keeps its creator and is not an
        # orphan. Its tool of the lost action is refused, and the tool that uses no action still works (user decision 2026-10-18).
        answer(default=False, allow=["mcp.keys.read", "mcp.keys.write"])
        stopped = mcp_call(secret, "list_databases")
        assert stopped.status_code == 200 and stopped.json()["error"]["code"] == -32602, stopped.text
        assert mcp_call(secret, "list_hosts").json()["result"]["isError"] is False
        listed = [k for k in call("GET", "/api/mcp/keys", tok=tok).json()["keys"] if k["id"] == key["id"]]
        assert listed[0]["orphan"] is None and listed[0]["creator"] == "integrator", listed
        # The key of the configuration has no creator and keeps working.
        assert mcp_call(MCP_TOKEN, "list_hosts").status_code == 200
    finally:
        answer(default=True)
        call("DELETE", f"/api/mcp/keys/{key['id']}", tok=tok, headers={"Sec-Fetch-Site": "same-origin"})


def mcp_rpc(secret: str, method: str, params: dict | None = None) -> requests.Response:
    body = {"jsonrpc": "2.0", "id": 1, "method": method, **({"params": params} if params is not None else {})}
    return SESSION.post(f"{BASE_URL}/mcp", data=json.dumps(body), timeout=30,
                        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"})


def listed_tools(secret: str) -> list[str]:
    response = mcp_rpc(secret, "tools/list", {})
    assert response.status_code == 200, response.text
    return [tool["name"] for tool in response.json()["result"]["tools"]]


@needs_access
def test_an_mcp_key_loses_only_the_tools_whose_action_its_creator_lost():
    # User decision 2026-10-18: tools/call checks the called tool only; tools/list shows the tools whose action the creator holds.
    answer(default=False, allow=["mcp.keys.read", "mcp.keys.write", "explorer.read", "system.read"])
    tok = token("operator")
    made = make_mcp_key(tok, f"partial-{uuid.uuid4().hex[:8]}", ["list_hosts", "list_databases", "system_overview"], ["*"])
    assert made.status_code == 201, made.text
    key, secret = made.json()["key"], made.json()["secret"]
    try:
        assert {"list_hosts", "list_databases", "system_overview"} <= set(listed_tools(secret))
        # The creator loses system.read: the key keeps its other tools.
        answer(default=False, allow=["mcp.keys.read", "mcp.keys.write", "explorer.read"])
        tools = listed_tools(secret)
        assert "system_overview" not in tools and "list_databases" in tools and "list_hosts" in tools, tools
        refused = mcp_call(secret, "system_overview")
        assert refused.status_code == 200 and refused.json()["error"]["code"] == -32602, refused.text
        working = mcp_call(secret, "list_databases")
        assert working.status_code == 200 and working.json()["result"]["isError"] is False, working.text
        # The key is not an orphan: the list has no warning for it.
        listed = [k for k in call("GET", "/api/mcp/keys", tok=tok).json()["keys"] if k["id"] == key["id"]]
        assert listed and listed[0]["orphan"] is None, listed
        # The PDP fails: fail closed for every tool that uses an action, and the key is not called an orphan.
        answer(status=500)
        assert mcp_call(secret, "list_databases").json()["error"]["code"] == -32602
        assert mcp_call(secret, "list_hosts").json()["result"]["isError"] is False
    finally:
        answer(default=True)
        call("DELETE", f"/api/mcp/keys/{key['id']}", tok=tok, headers={"Sec-Fetch-Site": "same-origin"})


@needs_access
def test_a_creator_without_permissions_keeps_the_key():
    # User decision 2026-10-18 (contract 11.5, case U11): a false decision with no reason means "no permission". The creator still
    # exists: the key is not an orphan, nobody can adopt it, and each tool of a refused action is refused one by one.
    answer(default=True)
    made = make_mcp_key(token("stayer"), f"kept-{uuid.uuid4().hex[:8]}", ["list_hosts", "list_databases"], ["chdash_ui"])
    assert made.status_code == 201, made.text
    key, secret = made.json()["key"], made.json()["secret"]
    heir = token("heir")
    try:
        answer(deny_subjects=["stayer"])
        assert mcp_call(secret, "list_hosts").json()["result"]["isError"] is False
        refused = mcp_call(secret, "list_databases")
        assert refused.status_code == 200 and refused.json()["error"]["code"] == -32602, refused.text
        assert "list_databases" not in listed_tools(secret)
        listed = [k for k in call("GET", "/api/mcp/keys", tok=heir).json()["keys"] if k["id"] == key["id"]]
        assert listed[0]["orphan"] is None and listed[0]["creator"] == "stayer", listed
        adopt = call("POST", f"/api/mcp/keys/{key['id']}/adopt", tok=heir, headers={"Sec-Fetch-Site": "same-origin"})
        assert adopt.status_code == 409 and adopt.json()["error_code"] == "not_adoptable", adopt.text
    finally:
        answer(default=True)
        call("DELETE", f"/api/mcp/keys/{key['id']}", tok=heir, headers={"Sec-Fetch-Site": "same-origin"})


@needs_access
def test_an_orphan_mcp_key_is_refused_until_a_person_adopts_it():
    # User decision 2026-10-18: a key whose creator the PDP does not know (false with "context": {"reason": "unknown_subject"}) is
    # refused (401) and listed as an orphan. A person with mcp.keys.write and every action of its tools adopts it: the person becomes
    # the creator, and the secret does not change.
    answer(default=True)
    made = make_mcp_key(token("leaver"), f"orphan-{uuid.uuid4().hex[:8]}", ["list_hosts", "list_databases"], ["chdash_ui"])
    assert made.status_code == 201, made.text
    key, secret = made.json()["key"], made.json()["secret"]
    heir = token("heir")
    adopt = lambda tok: call("POST", f"/api/mcp/keys/{key['id']}/adopt", tok=tok, headers={"Sec-Fetch-Site": "same-origin"})  # noqa: E731
    try:
        assert mcp_call(secret, "list_hosts").status_code == 200
        # The creator still holds the actions: nobody can adopt the key.
        refused = adopt(heir)
        assert refused.status_code == 409 and refused.json()["error_code"] == "not_adoptable", refused.text
        answer(unknown_subjects=["leaver"])
        stopped = mcp_call(secret, "list_hosts")
        assert stopped.status_code == 401, stopped.text
        listed = [k for k in call("GET", "/api/mcp/keys", tok=heir).json()["keys"] if k["id"] == key["id"]]
        assert listed[0]["orphan"] == "creator_gone" and listed[0]["creator"] == "leaver", listed
        # A person without an action of the key cannot adopt it: the key would have more than its creator.
        answer(unknown_subjects=["leaver"], deny=["explorer.read"])
        lacking = adopt(heir)
        assert lacking.status_code == 403 and lacking.json()["action"] == "explorer.read", lacking.text
        # Nor without mcp.keys.write.
        answer(unknown_subjects=["leaver"], deny=["mcp.keys.write"])
        assert adopt(heir).status_code == 403
        answer(unknown_subjects=["leaver"])
        before = len(received())
        adopted = adopt(heir)
        assert adopted.status_code == 200, adopted.text
        assert adopted.json()["key"]["creator"] == "heir" and "secret" not in adopted.json(), adopted.text
        # One batch for the person: mcp.keys.write and the actions of the tools of the key.
        batches = [r for r in received()[before:] if any(e["subject"]["id"] == "heir" and e["action"]["name"] == "explorer.read"
                                                         for e in evaluations(r))]
        assert len(batches) == 1, batches
        names = {e["action"]["name"] for e in evaluations(batches[0])}
        assert {"explorer.read"} <= names, names
        # The same secret works again, for the new creator.
        working = mcp_call(secret, "list_databases")
        assert working.status_code == 200 and working.json()["result"]["isError"] is False, working.text
        listed = [k for k in call("GET", "/api/mcp/keys", tok=heir).json()["keys"] if k["id"] == key["id"]]
        assert listed[0]["orphan"] is None and listed[0]["creator"] == "heir", listed
        if LOGS_CMD:
            logs = subprocess.run(shlex.split(LOGS_CMD), capture_output=True, text=True, timeout=30).stdout
            assert '"event":"mcp.key_refused"' in logs and '"reason":"creator_gone"' in logs
            assert '"reason":"unknown_subject"' in logs
            assert '"event":"mcp.key_adopted"' in logs
    finally:
        answer(default=True)
        call("DELETE", f"/api/mcp/keys/{key['id']}", tok=heir, headers={"Sec-Fetch-Site": "same-origin"})


@needs_access
def test_one_batch_for_the_page_hides_what_is_denied():
    answer(deny=["system.read", "mcp.keys.write"])
    before = len(received())
    response = call("GET", "/api/version", tok=token("erin"))
    assert response.status_code == 200
    access = response.json()["features"]["access"]
    assert access["mode"] == "authzen" and access["subject"] == "erin"
    assert access["actions"]["system.read"] is False and access["actions"]["mcp.keys.write"] is False
    assert access["actions"]["query.run.read"] is True and len(access["actions"]) == 12
    # The decisions of each visible host: the actions that take a host (seven), on local and on other.
    assert set(access["hosts"]) == {"local", "other"}, access
    assert access["hosts"]["local"]["system.read"] is False and access["hosts"]["other"]["explorer.read"] is True
    assert len(access["hosts"]["local"]) == 7
    batches = received()[before:]
    assert len(batches) == 1 and batches[0]["path"] == "/access/v1/evaluations", batches
    # One batch: the five actions without a host on the service, the seven others on each of the two hosts.
    asked_ = evaluations(batches[0])
    assert len(asked_) == 5 + 7 * 2
    assert {e["resource"]["type"] for e in asked_} == {"service", "host"}


@needs_access
def test_the_mcp_endpoint_keeps_its_keys_and_needs_no_identity_token():
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_hosts", "arguments": {}}}
    response = SESSION.post(f"{BASE_URL}/mcp", data=json.dumps(body), timeout=30,
                            headers={"Content-Type": "application/json", "Authorization": f"Bearer {MCP_TOKEN}"})
    assert response.status_code == 200, response.text
    assert "error" not in response.json(), response.text
    # The API tool ran in the process without a token, and the PDP was not asked.
    assert not received()
    # A wrong key is refused by MCP, not by the access of humans.
    response = SESSION.post(f"{BASE_URL}/mcp", data=json.dumps(body), timeout=30,
                            headers={"Content-Type": "application/json", "Authorization": "Bearer mcp_wrong"})
    assert response.status_code == 401
    assert response.json().get("error_code") != "unauthenticated"


@needs_access
def test_the_call_to_the_pdp_is_a_client_span_child_of_the_request():
    if not OTLP_URL:
        pytest.skip("ACCESS_OTLP_URL is not set")
    trace_id = uuid.uuid4().hex
    parent = uuid.uuid4().hex[:16]
    response = call("GET", SYSTEM, headers={"traceparent": f"00-{trace_id}-{parent}-01"})
    assert response.status_code == 200
    spans = []
    deadline = time.monotonic() + 10
    while not spans and time.monotonic() < deadline:
        time.sleep(0.3)
        for body in SESSION.get(f"{OTLP_URL}/received", timeout=10).json()["traces"]:
            for resource in body["resourceSpans"]:
                for scope in resource["scopeSpans"]:
                    spans += [s for s in scope["spans"] if s["traceId"] == trace_id]
    assert spans, "no span of the call to the PDP"
    span = spans[0]
    assert span["parentSpanId"] == parent
    assert span["kind"] in (3, "SPAN_KIND_CLIENT")
    assert span["name"].startswith("POST /access/v1/evaluation")
    # The PDP received the trace context of that span.
    assert any(r["traceparent"] == f"00-{trace_id}-{span['spanId']}-01" for r in received())


@pytest.mark.skipif(not STARTUP_CMD, reason="MCP_STARTUP_CMD is not set")
def test_u01_a_configuration_without_an_access_block_does_not_start():
    with tempfile.TemporaryDirectory() as tmp:
        os.chmod(tmp, 0o755)
        seen = tmp if STARTUP_CONFIG_DIR == "{dir}" else STARTUP_CONFIG_DIR
        (Path(tmp) / "pw").write_text("pw\n")
        os.chmod(Path(tmp) / "pw", 0o644)
        config = ('clickhouse {\n host {\n name = "p"\n runner_uri = "clickhouse://r@clickhouse:9000"\n'
                  ' system_uri = "clickhouse://s@clickhouse:9000"\n password_file = "' + seen + '/pw"\n }\n}\n')
        (Path(tmp) / "chdash.hcl").write_text(config)
        os.chmod(Path(tmp) / "chdash.hcl", 0o644)
        command = STARTUP_CMD.format(dir=shlex.quote(tmp), name=shlex.quote("chdash.hcl"))
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=60)
    assert result.returncode != 0
    assert "the access block is missing" in result.stderr
