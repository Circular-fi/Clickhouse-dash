"""The access of humans (docs/access.md; MCP server contract section 11, conformance cases U02 to U10).

Instances (the tests skip without them; in the official run, CHDASH_REQUIRE_FIXTURES=1 makes a missing one a failure):
- ACCESS_BASE_URL: tests/config/access.authzen.hcl (the compose service chdash_access), in the authzen mode.
- ACCESS_PDP_URL: the fake PDP (tests/otel-fixture/fake_pdp.py, the compose service access_pdp). The tests set its answers and read
  what it received.
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
    for name in ("query.run.read", "query.run.write", "query.export", "explorer.read"):
        assert actions[name]["resource_types"] == ["service", "database"], name
    assert actions["system.read"]["resource_types"] == ["service"]
    assert all(a["description"] for a in actions.values())
    # The probes need no token either.
    assert call("GET", "/livez", tok=None).status_code == 200


# ---- U06, U07, U08, U09: the decisions ----------------------------------------------------------------------------------


@needs_access
def test_u06_the_pdp_receives_the_subject_the_action_and_the_service():
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
    assert evaluation["resource"] == {"type": "service", "id": AUDIENCE}


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
    assert decisions[0]["resource"] == f"service:{AUDIENCE}" and decisions[0]["decision"] is False
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
    answer(deny=["query.export"])
    response = call("POST", "/api/export/run", json={"host_id": "local", "queries": ["SELECT 1"], "format": "csv"})
    assert response.status_code == 403 and response.json()["action"] == "query.export"


@needs_access
def test_explorer_read_on_one_database():
    # A grant on the database chdash_ui only: its table opens, the database system does not, and the whole catalog neither.
    answer(default=False, allow=["explorer.read@database:chdash_ui"])
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
    resources = {(e["action"]["name"], e["resource"]["type"], e["resource"]["id"]) for r in received() for e in evaluations(r)}
    assert ("explorer.read", "database", "chdash_ui") in resources


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
    batches = received()[before:]
    assert len(batches) == 1 and batches[0]["path"] == "/access/v1/evaluations", batches
    assert len(evaluations(batches[0])) == 12


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
