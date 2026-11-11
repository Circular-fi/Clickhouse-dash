"""The approval of an action by a person for the MCP keys of the page (docs/access.md, "Approval of an action"; docs/mcp.md, "Keys and the access
of humans"; ProcurAuth section 17, MCP binding 3.5a, 5.7, 5.7a, 5.7b).

Instances (the tests skip without them; in the official run, CHDASH_REQUIRE_FIXTURES=1 makes a missing one a failure):
- APPROVAL_KEYS_BASE_URL: tests/config/approval.keys.hcl (the compose service chdash_approval_keys): the mode keys with the authzen mode. A key of the
  page has a creator, and the creator is the subject of each question to the PDP. The key `standalone` of the configuration has no creator.
- APPROVAL_KEYS_PDP_URL: a fake portal of its own (tests/otel-fixture/fake_pdp.py): the approval gate and the approval API.

A key of the page has the lazy flow of the identity mode for its creator. The write tool and the export tool exist in the identity mode only.
A key of the configuration has no subject and no PDP: it stays outside the approval.
"""
from __future__ import annotations

import os
import time
import uuid

import pytest
import requests

from identity_tokens import Ed25519Key, make_token

BASE_URL = os.environ.get("APPROVAL_KEYS_BASE_URL", "").rstrip("/")
PDP_URL = os.environ.get("APPROVAL_KEYS_PDP_URL", "").rstrip("/")
needs_keys = pytest.mark.skipif(not (BASE_URL and PDP_URL), reason="APPROVAL_KEYS_BASE_URL is not set")

ED25519 = Ed25519Key(bytes(range(1, 33)))
ISSUER = "https://access.test"
AUDIENCE = "db"
HEADER = "X-Identity-Token"
MODERN = "2026-07-28"
CREATOR = "integrator"
# The token of the key `standalone` of the configuration (the file mcp-key-second-host).
STANDALONE = "mcp_5ec0d000SecondHost0000000000000000000000000"
CACHE_TTL = 1.0
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-approval-keys/1"})


def token(sub: str = CREATOR) -> str:
    now = int(time.time())
    return make_token(ED25519, {"iss": ISSUER, "sub": sub, "aud": AUDIENCE, "iat": now - 5, "exp": now + 240})


def pdp(path: str, body: dict | None = None) -> dict:
    response = SESSION.get(f"{PDP_URL}{path}", timeout=10) if body is None else SESSION.post(f"{PDP_URL}{path}", json=body, timeout=10)
    response.raise_for_status()
    return response.json()


def gate(*actions: str, **extra) -> None:
    """The actions that need an approval, and the other settings of the gate. The cache of the service forgets the former answers first."""
    pdp("/control/approval", {"actions": list(actions), **extra})
    time.sleep(CACHE_TTL + 0.2)


def decide(request_id: str, decision: str) -> None:
    pdp("/control/approval/decide", {"request_id": request_id, "decision": decision})


def received() -> dict:
    return pdp("/control/approval/received")


def questions() -> list[dict]:
    out = []
    for request in pdp("/control/received")["requests"]:
        body = request["body"]
        if request["path"] == "/access/v1/evaluation":
            out.append({"action": body["action"]["name"], "context": body.get("context") or {}, "subject": body["subject"]["id"],
                        "resource": body["resource"]})
    return out


@pytest.fixture(autouse=True)
def fresh_pdp():
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})
        time.sleep(CACHE_TTL + 0.2)
    yield
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})


def page(method: str, path: str, *, sub: str = CREATOR, **kwargs) -> requests.Response:
    headers = {HEADER: token(sub), "Sec-Fetch-Site": "same-origin"}
    return SESSION.request(method, f"{BASE_URL}{path}", headers=headers, timeout=30, **kwargs)


@pytest.fixture
def key():
    """A key of the page whose creator is `integrator`: three tools, the host `local`, every database."""
    made = page("POST", "/api/mcp/keys", json={"name": f"ap-{uuid.uuid4().hex[:8]}", "hosts": ["local"], "databases": ["*"],
                                              "tools": ["list_hosts", "list_databases", "run_query", "system_overview"]})
    assert made.status_code == 201, made.text
    body = made.json()
    assert body["key"]["creator"] == CREATOR
    yield body["secret"]
    page("DELETE", f"/api/mcp/keys/{body['key']['id']}")


def rpc(secret: str, method: str, params: dict | None = None, *, name: str | None = None):
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": MODERN,
               "Mcp-Method": method, "Authorization": f"Bearer {secret}"}
    if name is not None:
        headers["Mcp-Name"] = name
    body = {"jsonrpc": "2.0", "id": 7, "method": method, "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": MODERN}, **(params or {})}}
    return SESSION.post(f"{BASE_URL}/mcp", json=body, headers=headers, timeout=30)


def call(secret: str, name: str, arguments: dict):
    return rpc(secret, "tools/call", {"name": name, "arguments": arguments}, name=name)


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


# ---- tools/list ---------------------------------------------------------------------------------------------------------------------------


@needs_keys
def test_a_key_of_the_page_lists_get_action_status_and_the_controls_but_not_the_identity_tools(key):
    tools = {t["name"]: t for t in rpc(key, "tools/list").json()["result"]["tools"]}
    assert {"list_hosts", "list_databases", "run_query", "system_overview", "get_action_status"} <= set(tools)
    assert "run_write_query" not in tools and "export_query" not in tools
    assert set(tools["get_action_status"]["inputSchema"]["properties"]) == {"request_id"}
    assert tools["get_action_status"]["annotations"]["readOnlyHint"] is True
    controls = {"approval_ref", "lease_s", "until", "wait_s", "supersedes"}
    for name, tool in tools.items():
        if name != "get_action_status":
            assert controls <= set(tool["inputSchema"]["properties"]), name
    # The tools of the identity mode do not exist for a key: the answer of a tool that the key does not have.
    for name, arguments in (("run_write_query", {"host": "local", "sql": "CREATE TABLE default.nope (x UInt8) ENGINE = Memory"}),
                            ("export_query", {"host": "local", "sql": "SELECT 1"})):
        assert call(key, name, arguments).json()["error"]["code"] == -32602


@needs_keys
def test_a_key_that_needs_an_approval_keeps_its_tools_in_tools_list(key):
    gate("explorer.read", "query.run.read", "system.read")
    tools = {t["name"] for t in rpc(key, "tools/list").json()["result"]["tools"]}
    assert {"list_databases", "run_query", "system_overview", "get_action_status"} <= tools


@needs_keys
def test_the_key_of_the_configuration_stays_outside_the_approval():
    gate("*")
    tools = {t["name"]: t for t in rpc(STANDALONE, "tools/list").json()["result"]["tools"]}
    assert "get_action_status" not in tools and "run_write_query" not in tools
    assert all("lease_s" not in t["inputSchema"]["properties"] for t in tools.values())
    response = call(STANDALONE, "list_hosts", {})
    assert response.json()["result"]["isError"] is False
    # It has no subject: the PDP is not asked for a use of this key, and the tool runs as before.
    before = len(questions())
    response = call(STANDALONE, "list_databases", {"host": "local"})
    assert response.status_code == 200 and response.json()["result"]["isError"] is False, response.text
    assert len(questions()) == before and received()["submissions"] == []
    assert call(STANDALONE, "get_action_status", {"request_id": "apr_1"}).json()["error"]["code"] == -32602


# ---- the flow -----------------------------------------------------------------------------------------------------------------------------


@needs_keys
def test_the_creator_makes_a_key_for_an_action_that_needs_an_approval():
    # The key never has more than its creator, and a grant with a confirmation is a grant. The action of the page itself (mcp.keys.write)
    # is a use of the person now: it cannot wait.
    gate("explorer.read")
    made = page("POST", "/api/mcp/keys", json={"name": f"ap-{uuid.uuid4().hex[:8]}", "hosts": ["local"], "databases": ["*"], "tools": ["list_databases"]})
    assert made.status_code == 201, made.text
    page("DELETE", f"/api/mcp/keys/{made.json()['key']['id']}")
    gate("mcp.keys.write")
    refused = page("POST", "/api/mcp/keys", json={"name": f"ap-{uuid.uuid4().hex[:8]}", "hosts": ["local"], "databases": ["*"], "tools": ["list_databases"]})
    assert refused.status_code == 403 and refused.json() == {"error": "approval_cannot_wait"}, refused.text


@needs_keys
def test_a_tool_of_a_key_waits_for_the_approval_runs_once_and_asks_again_for_the_next(key):
    gate("explorer.read")
    first = awaiting(call(key, "list_databases", {"host": "local", "lease_s": 900}))
    assert first["id"].startswith("apr_") and first["code"]
    again = awaiting(call(key, "list_databases", {"host": "local", "lease_s": 900}))
    assert again["id"] == first["id"] and again["code"] == first["code"]
    # What the person reads: the host and the arguments of the call. The subject is the creator of the key, never the key.
    submission = received()["submissions"][0]
    body = submission["body"]
    assert set(body) == {"evaluation_id", "effect", "op", "view", "lease_s"} and body["lease_s"] == 900
    assert body["op"]["tool"] == "list_databases" and body["op"]["host"] == "local"
    assert body["view"]["body"] == "/arguments" and body["effect"].startswith("sha256:") and len(body["effect"]) == 71
    asked = [q for q in questions() if q["action"] == "explorer.read"]
    assert asked and all(q["subject"] == CREATOR for q in asked)
    with_effect = [q for q in asked if "approval" in q["context"]]
    assert with_effect and all(q["context"]["approval"] == {"effect": body["effect"]} and "usage" not in q["context"] for q in with_effect)
    # The same call without the host: a key of one host. The effect is the same, because the op names the host of the call.
    same = awaiting(call(key, "list_databases", {"lease_s": 900}))
    assert same["id"] == first["id"]
    # The person approves: the next call runs the tool one time, and the result is the result of the tool.
    decide(first["id"], "approve")
    response = call(key, "list_databases", {"host": "local", "lease_s": 900})
    assert response.status_code == 200 and response.json()["result"]["isError"] is False, response.text
    assert response.json()["result"]["structuredContent"]["host"] == "local" and response.json()["result"]["structuredContent"]["databases"]
    # The approval is consumed.
    second = awaiting(call(key, "list_databases", {"host": "local", "lease_s": 900}))
    assert second["id"] != first["id"]
    decide(second["id"], "decline")
    assert error_of(call(key, "list_databases", {"host": "local", "lease_s": 900}))["code"] == "approval_denied"


@needs_keys
def test_a_call_that_needs_an_approval_has_one_control_argument_exactly(key):
    gate("explorer.read")
    for controls in ({"lease_s": 900, "until": "2026-12-01T00:00:00Z"}, {"lease_s": 0}, {"lease_s": "9"}, {"approval_ref": ""}, {}):
        assert error_of(call(key, "list_databases", {"host": "local", **controls}))["code"] == "invalid_argument"
    assert received()["submissions"] == []
    assert awaiting(call(key, "list_databases", {"host": "local", "approval_ref": "ref_opaque_1"}))
    assert received()["submissions"][0]["body"]["approval_ref"] == "ref_opaque_1"


@needs_keys
def test_the_controls_are_optional_and_never_reach_a_tool_that_needs_no_approval(key):
    response = call(key, "list_databases", {"host": "local", "lease_s": 30, "wait_s": 1})
    assert response.status_code == 200 and response.json()["result"]["isError"] is False, response.text
    assert error_of(call(key, "list_databases", {"host": "local", "lease_s": 0}))["code"] == "invalid_argument"
    # A tool that uses no action takes them too.
    assert call(key, "list_hosts", {"lease_s": 30}).json()["result"]["isError"] is False
    assert received()["submissions"] == []


@needs_keys
def test_the_verdict_tool_reads_the_request_of_the_creator_and_renews_it(key):
    gate("explorer.read")
    action = awaiting(call(key, "list_databases", {"host": "local", "lease_s": 900}))
    assert structured(call(key, "get_action_status", {"request_id": action["id"]})) == {"status": "pending"}
    decide(action["id"], "approve")
    assert structured(call(key, "get_action_status", {"request_id": action["id"]})) == {"status": "approved"}
    reads = [r for r in received()["reads"] if r["id"] == action["id"]]
    assert reads and all(r["query"].get("renew") == "true" and r["subject"] == CREATOR for r in reads)
    decide(action["id"], "cancel")
    assert structured(call(key, "get_action_status", {"request_id": action["id"]})) == {"status": "void"}
    assert error_of(call(key, "get_action_status", {"request_id": "apr_unknown"}))["code"] == "invalid_argument"
    # The result has no isError member (binding 5.7b), and the tool asked the PDP no question.
    result = call(key, "get_action_status", {"request_id": action["id"]}).json()["result"]
    assert "isError" not in result


@needs_keys
def test_a_run_query_of_a_key_is_a_use_with_a_budget_and_an_approval(key):
    gate("query.run.read")
    action = awaiting(call(key, "run_query", {"host": "local", "sql": "SELECT 41 + 1 AS answer", "lease_s": 900}))
    body = received()["submissions"][-1]["body"]
    assert body["op"] == {"tool": "run_query", "host": "local", "sql": "SELECT 41 + 1 AS answer", "ch_user": "chdash_mcp"}
    assert body["view"]["title"] == "ClickHouse read"
    asked = [q for q in questions() if q["action"] == "query.run.read"]
    # The first question of the call has usage and no effect (a use of an action that lists a budget).
    assert "approval" not in asked[0]["context"] and asked[0]["context"].get("usage") == {"units": 1}
    decide(action["id"], "approve")
    response = call(key, "run_query", {"host": "local", "sql": "SELECT 41 + 1 AS answer", "lease_s": 900})
    assert response.json()["result"]["structuredContent"]["untrusted"]["rows"] == [[42]], response.text
    # Another statement is another effect: it asks again.
    other = awaiting(call(key, "run_query", {"host": "local", "sql": "SELECT 1", "lease_s": 900}))
    assert other["id"] != action["id"]


@needs_keys
def test_the_errors_of_the_approval_api_are_mapped(key):
    gate("explorer.read", submit={"status": 409, "error": "no_device"})
    error = error_of(call(key, "list_databases", {"host": "local", "lease_s": 900}))
    assert error["code"] == "approval_unavailable" and error["retryable"] is True
    gate("explorer.read", submit={"status": 429, "error": "rate_limited", "retry_after": 42})
    error = error_of(call(key, "list_databases", {"host": "local", "lease_s": 900}))
    assert error["code"] == "approval_rate_limited" and error["retry_after"] == 42
    gate("explorer.read", submit={"status": 503, "error": "unavailable"})
    response = call(key, "list_databases", {"host": "local", "lease_s": 900})
    assert response.status_code == 503 and response.json()["error"]["code"] == -32603


@needs_keys
def test_a_creator_with_no_grant_is_refused_and_a_call_without_an_approval_costs_one_question(key):
    # No approval: the call costs the question of 10.1 and runs the tool, as before.
    before = len(questions())
    assert call(key, "list_databases", {"host": "local"}).json()["result"]["isError"] is False
    assert len(questions()) - before <= 2 and received()["submissions"] == []
    # A creator that the PDP refuses without a reason: the answer of a tool that the key does not have.
    pdp("/control/answer", {"default": True, "deny": ["explorer.read"]})
    time.sleep(CACHE_TTL + 0.2)
    assert call(key, "list_databases", {"host": "local"}).json()["error"]["code"] == -32602
    pdp("/control/answer", {"default": True})
    time.sleep(CACHE_TTL + 0.2)


@needs_keys
def test_the_pages_of_a_person_cannot_wait_and_get_approval_cannot_wait():
    gate("explorer.read")
    response = page("GET", "/api/explorer/catalog?host_id=local&database=default")
    assert response.status_code == 403 and response.json() == {"error": "approval_cannot_wait"}, response.text
    assert received()["submissions"] == []
