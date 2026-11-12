"""The approval of an action by a person (docs/access.md, "Approval of an action"; ProcurAuth section 17, MCP binding 3.5a, 5.7, 5.7a, 5.7b).

Instances (the tests skip without them; in the official run, CHDASH_REQUIRE_FIXTURES=1 makes a missing one a failure):
- APPROVAL_BASE_URL: tests/config/approval.hcl (the compose service chdash_approval): the identity mode, the host `local` with a write account
  (chdash_mcp_write), the host `other` without one.
- APPROVAL_PDP_URL: a fake portal of its own (tests/otel-fixture/fake_pdp.py): the approval gate and the approval API. A test names the actions that
  need an approval (POST /control/approval), plays the person (POST /control/approval/decide) and reads what the service sent
  (GET /control/approval/received).

The tool run_write_query runs one statement with the write account. The tests make and drop Memory tables of the database `default` only.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid

import pytest
import requests

from identity_tokens import Ed25519Key, make_token

BASE_URL = os.environ.get("APPROVAL_BASE_URL", "").rstrip("/")
PDP_URL = os.environ.get("APPROVAL_PDP_URL", "").rstrip("/")
needs_approval = pytest.mark.skipif(not (BASE_URL and PDP_URL), reason="APPROVAL_BASE_URL is not set")

ED25519 = Ed25519Key(bytes(range(1, 33)))
ISSUER = "https://access.test"
AUDIENCE = "db"
HEADER = "X-Identity-Token"
MODERN = "2026-07-28"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-approval/1"})
SUBJECT = "key:9b1c04e2aa71f0c3"


def token(sub: str = SUBJECT) -> str:
    now = int(time.time())
    return make_token(ED25519, {"iss": ISSUER, "sub": sub, "aud": AUDIENCE, "iat": now - 5, "exp": now + 240})


def pdp(path: str, body: dict | None = None) -> dict:
    response = SESSION.get(f"{PDP_URL}{path}", timeout=10) if body is None else SESSION.post(f"{PDP_URL}{path}", json=body, timeout=10)
    response.raise_for_status()
    return response.json()


def gate(*actions: str, **extra) -> None:
    """The actions that need an approval, and the other settings of the gate."""
    pdp("/control/approval", {"actions": list(actions), **extra})


def decide(request_id: str, decision: str) -> None:
    pdp("/control/approval/decide", {"request_id": request_id, "decision": decision})


def received() -> dict:
    return pdp("/control/approval/received")


def questions() -> list[dict]:
    out = []
    for request in pdp("/control/received")["requests"]:
        body = request["body"]
        if request["path"] == "/access/v1/evaluation":
            out.append({"action": body["action"]["name"], "context": body.get("context") or {}, "subject": body["subject"]["id"]})
    return out


@pytest.fixture(autouse=True)
def fresh_pdp():
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})
        # The cache of the decisions of the service is short: wait until it holds no answer of an earlier test.
        time.sleep(1.2)
    yield
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})


def rpc(method: str, params: dict | None = None, *, tok: str | None = "default", name: str | None = None):
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": MODERN, "Mcp-Method": method}
    if name is not None:
        headers["Mcp-Name"] = name
    if tok == "default":
        tok = token()
    if tok is not None:
        headers[HEADER] = tok
    body = {"jsonrpc": "2.0", "id": 7, "method": method, "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": MODERN}, **(params or {})}}
    return SESSION.post(f"{BASE_URL}/mcp", json=body, headers=headers, timeout=30)


def call(name: str, arguments: dict):
    return rpc("tools/call", {"name": name, "arguments": arguments}, name=name)


def table() -> str:
    return f"default.ap_{uuid.uuid4().hex[:10]}"


def create_sql(name: str) -> str:
    return f"CREATE TABLE {name} (x UInt8) ENGINE = Memory"


def write(sql: str, **controls):
    return call("run_write_query", {"host": "local", "sql": sql, "lease_s": 900, **controls})


def structured(response: requests.Response) -> dict:
    assert response.status_code == 200, response.text
    return response.json()["result"]["structuredContent"]


def error_of(response: requests.Response) -> dict:
    result = response.json()["result"]
    assert result["isError"] is True, result
    return result["structuredContent"]["error"]


def awaiting(response: requests.Response) -> dict:
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result.get("isError") is not True and result["resultType"] == "complete", result
    action = result["structuredContent"]["action"]
    assert action["status"] == "awaiting_approval" and action["executed"] is False
    assert len(result["content"]) == 2 and result["content"][1]["text"].startswith("NOT EXECUTED")
    return action


def drop(name: str) -> None:
    gate()
    assert structured(write(f"DROP TABLE IF EXISTS {name}"))["executed"] is True


# ---- tools/list ---------------------------------------------------------------------------------------------------------------------------


@needs_approval
def test_tools_list_has_the_tools_of_the_flow_and_the_control_arguments_on_each_tool():
    tools = {t["name"]: t for t in rpc("tools/list").json()["result"]["tools"]}
    write_tool, status_tool = tools["run_write_query"], tools["get_action_status"]
    assert write_tool["annotations"]["readOnlyHint"] is False and write_tool["annotations"]["destructiveHint"] is True
    assert write_tool["annotations"]["openWorldHint"] is True
    assert status_tool["annotations"]["readOnlyHint"] is True
    assert set(status_tool["inputSchema"]["properties"]) == {"request_id"}
    controls = {"approval_ref", "lease_s", "until", "wait_s", "supersedes"}
    for name, tool in tools.items():
        if name != "get_action_status":
            assert controls <= set(tool["inputSchema"]["properties"]), name
    # The question of tools/list has the match subtree and no effect: ProcurAuth 17.8 ignores `confirm` there.
    assert all("approval" not in q["context"] for q in questions() if q["context"].get("match") == "subtree")


# ---- the flow -----------------------------------------------------------------------------------------------------------------------------


@needs_approval
def test_a_write_waits_for_the_approval_runs_once_and_asks_again_for_the_next():
    name = table()
    gate("query.run.write")
    first = awaiting(write(create_sql(name)))
    assert first["id"].startswith("apr_") and first["code"]
    # The statement did not run: the person has not answered. The same call gives the same request, with the same code.
    again = awaiting(write(create_sql(name)))
    assert again["id"] == first["id"] and again["code"] == first["code"]
    # The service sent what the person reads: the statement, the host, the user. It sent no text of the agent.
    submission = received()["submissions"][0]["body"]
    assert set(submission) == {"evaluation_id", "effect", "op", "view", "lease_s"} and submission["lease_s"] == 900
    # ProcurAuth 17.3a: the time limit that the call runs with is in the op (mcp.query_timeout_seconds, 30 by default).
    assert submission["op"] == {"tool": "run_write_query", "host": "local", "sql": create_sql(name), "ch_user": "chdash_mcp_write", "timeout_seconds": 30}
    assert submission["view"] == {"title": "ClickHouse write", "fields": [["Host", "/host"], ["Runs as", "/ch_user"]], "body": "/sql", "body_label": "SQL"}
    assert submission["effect"].startswith("sha256:") and len(submission["effect"]) == 71
    # The first question of a call has no effect and has usage (a use of query.run.write). Only after approval_required comes the question with the
    # effect, without usage. No question has op or view.
    asked = [q for q in questions() if q["action"] == "query.run.write"]
    assert "approval" not in asked[0]["context"] and asked[0]["context"].get("usage") == {"units": 1}
    with_effect = [q for q in asked if "approval" in q["context"]]
    assert with_effect and all(q["context"]["approval"] == {"effect": submission["effect"]} for q in with_effect)
    assert all("usage" not in q["context"] for q in with_effect)
    # The person approves; the next call runs the statement one time.
    decide(first["id"], "approve")
    assert structured(write(create_sql(name)))["executed"] is True
    # The approval is consumed: the same statement needs a new approval.
    second = awaiting(write(create_sql(name)))
    assert second["id"] != first["id"]
    decide(second["id"], "decline")
    drop(name)


@needs_approval
def test_the_verdict_tool_reads_the_request_and_renews_it_for_the_subject():
    name = table()
    gate("query.run.write")
    action = awaiting(write(create_sql(name)))
    assert structured(call("get_action_status", {"request_id": action["id"]})) == {"status": "pending"}
    decide(action["id"], "approve")
    assert structured(call("get_action_status", {"request_id": action["id"]})) == {"status": "approved"}
    reads = [r for r in received()["reads"] if r["id"] == action["id"]]
    assert reads and all(r["query"].get("renew") == "true" and r["subject"] == SUBJECT for r in reads)
    # The call of the tool itself never renews: it sent no read at all.
    assert not [r for r in received()["reads"] if r["id"] == action["id"] and "renew" not in r["query"] and r["query"].get("wait") is None]
    decide(action["id"], "cancel")
    assert structured(call("get_action_status", {"request_id": action["id"]})) == {"status": "void"}
    error = error_of(call("get_action_status", {"request_id": "apr_unknown"}))
    assert error["code"] == "invalid_argument" and error["retryable"] is False


@needs_approval
def test_a_refused_approval_is_a_tool_error_with_no_text_of_the_person():
    name = table()
    gate("query.run.write")
    action = awaiting(write(create_sql(name)))
    decide(action["id"], "decline")
    error = error_of(write(create_sql(name)))
    assert error["code"] == "approval_denied" and error["retryable"] is False
    assert set(error) == {"code", "message", "retryable"}
    # No question with usage was a use: the deny time holds, and the tool never ran.
    decide(action["id"], "cancel")


@needs_approval
def test_a_void_approval_never_blocks_a_new_request():
    name = table()
    gate("query.run.write")
    action = awaiting(write(create_sql(name)))
    decide(action["id"], "approve")
    decide(action["id"], "cancel")
    # The approval is void: the question with usage says approval_expired (17.1). ChDash asks without usage and submits a new request.
    again = awaiting(write(create_sql(name)))
    assert again["id"] != action["id"]
    decide(again["id"], "decline")


@needs_approval
def test_the_errors_of_the_approval_api_are_mapped():
    name = table()
    gate("query.run.write", submit={"status": 409, "error": "no_device"})
    error = error_of(write(create_sql(name)))
    assert error["code"] == "approval_unavailable" and error["retryable"] is True
    gate("query.run.write", submit={"status": 429, "error": "rate_limited", "retry_after": 42})
    error = error_of(write(create_sql(name)))
    assert error["code"] == "approval_rate_limited" and error["retryable"] is True and error["retry_after"] == 42
    for status in (500, 503):
        gate("query.run.write", submit={"status": status, "error": "unavailable"})
        response = write(create_sql(name))
        assert response.status_code == 503 and response.json()["error"]["code"] == -32603
    gate("query.run.write", submit={"status": 422, "error": "invalid_lease"})
    assert error_of(write(create_sql(name)))["code"] == "invalid_argument"
    # The faults of the agent are tool errors, never an outage (HTTP 503): the portal asks for the intent of the agent, or the request to replace was used.
    gate("query.run.write", submit={"status": 422, "error": "explanation_required"})
    error = error_of(write(create_sql(name)))
    assert error["code"] == "invalid_argument" and "approval_ref" in error["message"]
    gate("query.run.write", submit={"status": 409, "error": "cannot_supersede"})
    error = error_of(write(create_sql(name)))
    assert error["code"] == "invalid_argument" and "supersedes" in error["message"]
    # A late evaluation_id: ChDash asks the PDP once more and submits again. A second refusal is approval_expired.
    gate("query.run.write", submit={"status": 422, "error": "invalid_evaluation"})
    assert error_of(write(create_sql(name)))["code"] == "approval_expired"
    # Nothing ran: the table does not exist, so the first approved run creates it.
    gate()
    assert structured(write(create_sql(name)))["executed"] is True
    drop(name)


@needs_approval
def test_a_call_that_needs_an_approval_has_one_control_argument_exactly():
    name = table()
    gate("query.run.write")
    for controls in ({"lease_s": 900, "until": "2026-12-01T00:00:00Z"}, {"lease_s": 0}, {"lease_s": "9"}, {"approval_ref": ""}):
        response = call("run_write_query", {"host": "local", "sql": create_sql(name), **controls})
        assert error_of(response)["code"] == "invalid_argument"
    assert error_of(call("run_write_query", {"host": "local", "sql": create_sql(name)}))["code"] == "invalid_argument"
    assert received()["submissions"] == []
    assert awaiting(call("run_write_query", {"host": "local", "sql": create_sql(name), "approval_ref": "ref_opaque_1"}))
    assert received()["submissions"][0]["body"]["approval_ref"] == "ref_opaque_1" and "lease_s" not in received()["submissions"][0]["body"]


@needs_approval
def test_a_statement_above_max_command_bytes_is_refused_and_nothing_is_sent():
    gate("query.run.write")
    sql = f"INSERT INTO {table()} VALUES " + ", ".join("(1)" for _ in range(2000))
    error = error_of(write(sql))
    assert error["code"] == "invalid_argument"
    assert received()["submissions"] == []


@needs_approval
def test_the_call_waits_for_the_verdict_when_the_agent_gives_wait_s():
    name = table()
    gate("query.run.write")
    result: dict = {}
    thread = threading.Thread(target=lambda: result.update(response=write(create_sql(name), wait_s=60)))
    thread.start()
    request_id = None
    for _ in range(40):
        submissions = received()["submissions"]
        if submissions:
            request_id = "apr_1"
            break
        time.sleep(0.1)
    assert request_id
    decide(request_id, "approve")
    thread.join(timeout=30)
    # approved during the wait: the call asked again and ran the statement. The wait never renewed the request.
    assert structured(result["response"])["executed"] is True
    reads = received()["reads"]
    assert reads and all("renew" not in r["query"] and int(r["query"]["wait"]) <= 3 for r in reads)
    drop(name)


# ---- read statements, other actions, other hosts --------------------------------------------------------------------------------------------


@needs_approval
def test_a_read_statement_runs_without_an_approval_while_the_write_action_needs_one():
    gate("query.run.write")
    response = call("run_query", {"host": "local", "sql": "SELECT 1 AS one"})
    assert response.json()["result"]["structuredContent"]["untrusted"]["rows"] == [[1]]
    assert received()["submissions"] == []


@needs_approval
def test_a_write_without_a_grant_that_asks_for_an_approval_runs_after_the_true_answer():
    name = table()
    gate()
    assert structured(write(create_sql(name)))["executed"] is True
    assert received()["submissions"] == []
    drop(name)


@needs_approval
def test_any_action_can_ask_for_an_approval_a_read_tool_too():
    gate("explorer.read")
    action = awaiting(call("list_databases", {"host": "local", "lease_s": 600}))
    submission = received()["submissions"][-1]["body"]
    assert submission["op"]["tool"] == "list_databases" and submission["op"]["host"] == "local"
    assert json.loads(submission["op"]["arguments"]) == {"host": "local"}
    assert submission["view"]["body"] == "/arguments" and submission["view"]["title"]
    decide(action["id"], "approve")
    result = call("list_databases", {"host": "local", "lease_s": 600}).json()["result"]
    assert result.get("isError") is not True and result["structuredContent"]["count"] >= 1
    # The control arguments are not in the effect: the same call without them has the same effect, and needs a new approval now.
    assert awaiting(call("list_databases", {"host": "local", "lease_s": 30}))["id"] != action["id"]


@needs_approval
def test_a_host_without_a_write_account_has_no_write_tool():
    response = call("run_write_query", {"host": "other", "sql": create_sql(table()), "lease_s": 60})
    assert response.json()["error"]["code"] == -32602
    response = call("run_write_query", {"host": "nowhere", "sql": create_sql(table()), "lease_s": 60})
    assert response.json()["error"]["code"] == -32602


@needs_approval
def test_the_write_tool_refuses_what_is_not_one_write_statement():
    for sql, code in (("SELECT 1", "statement_not_allowed"), ("WITH 1 AS x SELECT x", "not_a_write"), ("DROP TABLE a; DROP TABLE b", "multiple_statements"),
                      ("CREATE USER u", "statement_not_allowed"), ("INSERT INTO t SELECT * FROM file('x')", "function_not_allowed"), ("", "empty_sql")):
        assert error_of(write(sql))["code"] == code, sql
    assert questions() == []


@needs_approval
def test_the_write_account_decides_what_a_statement_can_change():
    # The approval gives no right in ClickHouse: the account has no grant outside `default`, so ClickHouse refuses.
    error = error_of(write("CREATE TABLE otel.not_allowed (x UInt8) ENGINE = Memory"))
    assert error["code"] == "permission_denied"


@needs_approval
def test_a_failure_of_the_pdp_is_never_a_result():
    pdp("/control/answer", {"status": 500})
    response = write(create_sql(table()))
    assert response.status_code == 503 and response.json()["error"]["code"] == -32603
    pdp("/control/answer", {"default": False})
    assert write(create_sql(table())).json()["error"]["code"] == -32602


# ---- the pages and the API cannot wait ------------------------------------------------------------------------------------------------------


@needs_approval
def test_a_page_run_of_a_write_that_needs_an_approval_is_refused_approval_cannot_wait():
    gate("query.run.write")
    headers = {HEADER: token("alice"), "Content-Type": "application/json"}
    refused = SESSION.post(f"{BASE_URL}/api/query/run", json={"host_id": "local", "sql": "CREATE TABLE default.ap_page_t (x UInt8) ENGINE = Memory"},
                           headers=headers, timeout=20)
    assert refused.status_code == 403
    body = refused.json()
    assert body == {"error": "approval_cannot_wait"}, body
    # No effect and no submission: the page cannot wait (ProcurAuth 17.7a).
    assert received()["submissions"] == []
    assert not [q for q in questions() if "approval" in q["context"]]
    # A read still runs: the write action is false for it, and readonly = 1 applies.
    ran = SESSION.post(f"{BASE_URL}/api/query/run", json={"host_id": "local", "sql": "SELECT 1"}, headers=headers, timeout=20)
    assert ran.status_code == 200, ran.text


@needs_approval
def test_every_route_and_every_method_without_a_tool_that_cannot_wait_is_refused():
    headers = {HEADER: token("alice")}
    gate("explorer.read", "system.read", "mcp.session")
    for path in ("/api/explorer/functions?host_id=local", "/api/system/overview?host_id=local"):
        response = SESSION.get(f"{BASE_URL}{path}", headers=headers, timeout=20)
        assert response.status_code == 403 and response.json() == {"error": "approval_cannot_wait"}, (path, response.text)
    # An MCP method with no tool (ping): HTTP 403 and -32001 (binding 5.1b). No effect, no submission.
    ping = rpc("ping")
    assert ping.status_code == 403 and ping.json()["error"]["code"] == -32001
    assert received()["submissions"] == []
    assert not [q for q in questions() if "approval" in q["context"]]


@needs_approval
def test_export_query_returns_the_text_of_an_export_and_needs_the_export_and_the_run():
    sql = "SELECT number AS n, toString(number) AS s FROM numbers(2)"
    csv = call("export_query", {"host": "local", "sql": sql})
    assert structured(csv)["untrusted"]["content"] == "n,s\n0,0\n1,1\n" and structured(csv)["format"] == "csv" and structured(csv)["row_count"] == 2
    as_json = structured(call("export_query", {"host": "local", "sql": sql, "format": "json"}))
    # A UInt64 is a string of its digits in the JSON of the tools (docs/telemetry.md, "Result values").
    assert json.loads(as_json["untrusted"]["content"]) == [{"n": "0", "s": "0"}, {"n": "1", "s": "1"}]
    assert error_of(call("export_query", {"host": "local", "sql": "DROP TABLE x"}))["code"] == "statement_not_allowed"
    assert error_of(call("export_query", {"host": "local", "sql": sql, "format": "xml"}))["code"] == "invalid_argument"
    # The other permission (query.run.read) is asked first: without it the call is the answer for a tool that does not exist.
    pdp("/control/answer", {"default": True, "deny": ["query.run.read"]})
    time.sleep(1.2)  # the service keeps an answer for pdp.cache_ttl (1 s)
    assert call("export_query", {"host": "local", "sql": sql}).json()["error"]["code"] == -32602


@needs_approval
def test_the_export_action_asks_for_an_approval_like_any_other_action():
    gate("query.export")
    action = awaiting(call("export_query", {"host": "local", "sql": "SELECT 1", "lease_s": 600}))
    submission = received()["submissions"][-1]["body"]
    assert submission["op"] == {"tool": "export_query", "host": "local", "sql": "SELECT 1", "ch_user": "chdash_mcp", "options": '{"format":"csv"}',
                                "max_rows": 1000, "max_result_bytes": 1048576, "timeout_seconds": 30}
    assert submission["view"]["title"] == "ClickHouse export" and submission["view"]["body"] == "/sql"
    decide(action["id"], "approve")
    assert structured(call("export_query", {"host": "local", "sql": "SELECT 1", "lease_s": 600}))["row_count"] == 1


@needs_approval
def test_the_action_document_has_no_approval_member_and_no_action_of_the_keys():
    document = SESSION.get(f"{BASE_URL}/.well-known/procurauth/actions", timeout=10).json()
    names = {a["name"] for a in document["actions"]}
    assert "query.export" in names and "mcp.session" in names
    assert not {"mcp.keys.read", "mcp.keys.write"} & names
    assert all("approval" not in a for a in document["actions"])
