"""The identity mode of POST /mcp (docs/mcp.md, "The identity mode"; ProcurAuth MCP binding, conformance cases U18 to U31 and U85 to U99).

Instances (the tests skip without them; in the official run, CHDASH_REQUIRE_FIXTURES=1 makes a missing one a failure):
- MCP_IDENTITY_BASE_URL: tests/config/mcp.identity.hcl (the compose service chdash_mcp_identity): mcp.auth_mode = "identity", two hosts.
- ACCESS_PDP_URL: the fake PDP (tests/otel-fixture/fake_pdp.py). The tests set its answers and read what it received.

The tokens are signed with the test keys of identity_tokens.py. A key of the portal has a subject such as key:9b1c04e2aa71f0c3: the server
reads no meaning from the subject.
"""
from __future__ import annotations

import os
import time

import pytest
import requests

from identity_tokens import Ed25519Key, make_token

BASE_URL = os.environ.get("MCP_IDENTITY_BASE_URL", "").rstrip("/")
PDP_URL = os.environ.get("ACCESS_PDP_URL", "").rstrip("/")
needs_identity = pytest.mark.skipif(not (BASE_URL and PDP_URL), reason="MCP_IDENTITY_BASE_URL is not set")

ED25519 = Ed25519Key(bytes(range(1, 33)))
ISSUER = "https://access.test"
AUDIENCE = "db"
HEADER = "X-Identity-Token"
CACHE_TTL = 1.0
MODERN = "2026-07-28"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-mcp-identity/1"})
# A standalone key of ChDash (47 characters): the identity mode never checks it.
OWN_KEY = "mcp_" + "A" * 43


def token(sub: str = "alice") -> str:
    now = int(time.time())
    return make_token(ED25519, {"iss": ISSUER, "sub": sub, "aud": AUDIENCE, "iat": now - 5, "exp": now + 240})


def pdp(path: str, body: dict | None = None) -> dict:
    response = SESSION.get(f"{PDP_URL}{path}", timeout=10) if body is None else SESSION.post(f"{PDP_URL}{path}", json=body, timeout=10)
    response.raise_for_status()
    return response.json()


def answer(**order) -> None:
    pdp("/control/answer", order)
    time.sleep(CACHE_TTL + 0.2)


def evaluations() -> list[dict]:
    out = []
    for request in pdp("/control/received")["requests"]:
        body = request["body"]
        if request["path"] == "/access/v1/evaluation":
            out.append({"subject": body["subject"], "action": body["action"], "resource": body["resource"], "context": body.get("context") or {}})
            continue
        for item in body["evaluations"]:
            out.append({"subject": item.get("subject", body.get("subject")), "action": item.get("action", body.get("action")),
                        "resource": item.get("resource", body.get("resource")), "context": item.get("context", body.get("context")) or {}})
    return out


@pytest.fixture(autouse=True)
def fresh_pdp():
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})
        time.sleep(CACHE_TTL + 0.2)
    yield
    if BASE_URL and PDP_URL:
        pdp("/control/reset", {})


def rpc(method: str, params: dict | None = None, *, tok: str | None = "default", headers: dict | None = None, id_=7, name: str | None = None):
    hdrs = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": MODERN,
            "Mcp-Method": method}
    if name is not None:
        hdrs["Mcp-Name"] = name
    hdrs.update(headers or {})
    if tok == "default":
        tok = token()
    if tok is not None:
        hdrs[HEADER] = tok
    body = {"jsonrpc": "2.0", "id": id_, "method": method, "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": MODERN}, **(params or {})}}
    return SESSION.post(f"{BASE_URL}/mcp", json=body, headers=hdrs, timeout=30)


def call_tool(name: str, arguments: dict, **kwargs):
    return rpc("tools/call", {"name": name, "arguments": arguments}, name=name, **kwargs)


# ---- U27, U85, U86, U94, U98, U99: the token, and only the token ---------------------------------------------------------


@needs_identity
def test_u27_a_request_without_a_token_gets_401_with_an_empty_body():
    response = rpc("ping", tok=None)
    assert response.status_code == 401 and response.text == ""
    assert "WWW-Authenticate" in response.headers
    assert response.headers["Cache-Control"] == "no-store"
    assert evaluations() == []


@needs_identity
def test_u85_u86_a_bad_token_gets_401_before_the_body_is_read():
    for bad in ("not-a-token", token().rsplit(".", 1)[0] + ".AAAA"):
        for method in ("ping", "tools/list"):
            response = rpc(method, tok=bad)
            assert response.status_code == 401 and response.text == "", (bad, method)
    # A body that is not JSON gets the 401, not a parse error.
    response = SESSION.post(f"{BASE_URL}/mcp", data="{not json", headers={"Content-Type": "application/json"}, timeout=30)
    assert response.status_code == 401 and response.text == ""
    assert evaluations() == []


@needs_identity
def test_u98_u99_the_keys_of_chdash_are_ignored():
    answer(default=True)
    # A good token and a key of ChDash: the subject is the one of the token.
    response = rpc("ping", headers={"Authorization": f"Bearer {OWN_KEY}"})
    assert response.status_code == 200
    assert {e["subject"]["id"] for e in evaluations()} == {"alice"}
    # A key of ChDash and no token: 401.
    response = rpc("ping", tok=None, headers={"Authorization": f"Bearer {OWN_KEY}"})
    assert response.status_code == 401 and response.text == ""


@needs_identity
def test_u94_an_error_copies_nothing_of_the_request():
    answer(default=True)
    marker = "INJECTED-MARKER-7f3a"
    response = call_tool(marker, {"x": marker})
    assert response.status_code == 200 and marker not in response.text
    assert response.json()["error"]["code"] == -32602 and response.json()["error"]["message"] == "Unknown tool"
    response = rpc(marker)
    assert marker not in response.text


# ---- U29, U31, U91, U95: mcp.session --------------------------------------------------------------------------------------


@needs_identity
def test_u29_u31_a_request_without_a_tool_asks_mcp_session():
    answer(default=True, deny=["mcp.session"])
    for method in ("ping", "server/discover"):
        response = rpc(method)
        assert response.status_code == 403, method
        assert response.json() == {"jsonrpc": "2.0", "id": 7, "error": {"code": -32001, "message": "forbidden"}}
    asked = [e for e in evaluations() if e["action"]["name"] == "mcp.session"]
    assert asked and all(e["resource"] == {"type": "service", "id": AUDIENCE} for e in asked)
    answer(default=True)
    assert rpc("ping").status_code == 200
    assert rpc("server/discover").json()["result"]["resultType"] == "complete"


@needs_identity
def test_u91_u28_a_pdp_that_fails_gives_503_never_403():
    answer(default=True, status=500)
    response = rpc("ping")
    assert response.status_code == 503 and response.json()["error"]["code"] == -32603
    response = rpc("tools/list")
    assert response.status_code == 503 and response.json()["error"]["code"] == -32603
    response = call_tool("list_databases", {"host": "local"})
    assert response.status_code == 503 and response.json()["error"]["code"] == -32603


@needs_identity
def test_u25_the_header_and_the_meta_version_must_agree():
    response = SESSION.post(f"{BASE_URL}/mcp", json={"jsonrpc": "2.0", "id": 7, "method": "ping", "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": "2025-11-25"}}},
                            headers={"Content-Type": "application/json", HEADER: token(), "MCP-Protocol-Version": MODERN, "Mcp-Method": "ping"}, timeout=30)
    assert response.status_code == 400 and response.json()["error"]["code"] == -32020


# ---- U26, U88, U89: tools/list and the refusal of a tool ------------------------------------------------------------------


@needs_identity
def test_u88_tools_list_sends_one_item_for_each_action_on_the_service():
    answer(default=True)
    assert rpc("tools/list").status_code == 200
    items = [e for e in evaluations() if e["subject"]["id"] == "alice" and e["action"]["name"] != "mcp.session"] or evaluations()
    names = [e["action"]["name"] for e in evaluations()]
    assert len(names) == len(set(names))  # one item for each action
    for e in evaluations():
        assert e["resource"] == {"type": "service", "id": AUDIENCE}
        assert e["context"].get("match") == "subtree" and "usage" not in e["context"]
    assert items


@needs_identity
def test_u26_u89_a_refused_tool_is_not_listed_and_looks_like_an_unknown_tool():
    answer(default=True, deny=["system.read"])
    names = {t["name"] for t in rpc("tools/list").json()["result"]["tools"]}
    assert "list_databases" in names and "system_overview" not in names
    refused = call_tool("system_overview", {"host": "local"})
    unknown = call_tool("no_such_tool", {})
    assert refused.status_code == unknown.status_code == 200
    assert refused.json()["error"] == unknown.json()["error"]
    assert refused.json()["error"]["code"] == -32602


@needs_identity
def test_a_key_of_the_portal_is_a_subject_like_a_person():
    answer(default=True, subjects={"key:9b1c04e2aa71f0c3": ["mcp.session@service:db", "explorer.read@host:local"]})
    key = token("key:9b1c04e2aa71f0c3")
    names = {t["name"] for t in rpc("tools/list", tok=key).json()["result"]["tools"]}
    assert "list_databases" in names and "run_query" not in names
    assert {e["subject"]["id"] for e in evaluations()} >= {"key:9b1c04e2aa71f0c3"}


# ---- U87: the resource of a call comes from the arguments; the host is never a default ----------------------------


@needs_identity
def test_u87_the_host_and_the_database_of_a_call_name_its_resource():
    answer(default=True)
    response = call_tool("describe_table", {"host": "local", "database": "chdash_ui", "table": "nope"})
    assert response.status_code == 200
    asked = [e for e in evaluations() if e["action"]["name"] == "explorer.read" and e["resource"]["type"] == "database"]
    assert asked and asked[-1]["resource"]["id"] == "chdash_ui"
    assert asked[-1]["resource"]["properties"]["ancestors"] == [{"type": "service", "id": AUDIENCE}, {"type": "host", "id": "local"}]
    # No host: the tool says host_required and reads nothing, also when the configuration has a host that it could take.
    result = call_tool("list_databases", {}).json()["result"]
    assert result["isError"] is True and result["structuredContent"]["error"]["code"] == "host_required"
    # A host that the configuration does not have: the PDP receives no such host.
    call_tool("list_databases", {"host": "attacker-chose-this"})
    assert all(e["resource"]["id"] != "attacker-chose-this" for e in evaluations())


@needs_identity
def test_a_grant_on_one_host_hides_the_other_host_in_list_hosts():
    answer(default=False, subjects={"alice": ["mcp.hosts.read@service:db", "explorer.read@host:local"]})
    result = call_tool("list_hosts", {}).json()["result"]["structuredContent"]
    assert [h["name"] for h in result["hosts"]] == ["local"]
    # A call on the other host looks like a tool that does not exist.
    response = call_tool("list_databases", {"host": "other"})
    assert response.json()["error"]["code"] == -32602


# ---- U92: a ceiling that the service cannot apply ----------------------------------------------------------------------


@needs_identity
def test_u92_a_true_answer_with_an_unknown_ceiling_is_a_refusal():
    answer(default=True, fixed={"explorer.read": {"decision": True, "context": {"limits": {"max_conformance_unknown": 5}}}})
    response = call_tool("list_databases", {"host": "local"})
    assert response.status_code == 200 and response.json()["error"]["code"] == -32602


@needs_identity
def test_the_declared_ceilings_of_the_action_of_a_tool_bound_the_call():
    # query.run.read declares the six ceilings (docs/access.md, "Actions that list ceilings"). max_rows lowers the rows of the call.
    answer(default=True, limits={"query.run.read": {"max_rows": 2, "max_read_size": 1_000_000_000}})
    response = call_tool("run_query", {"host": "local", "sql": "SELECT number FROM numbers(10)"})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert not result.get("isError"), result  # the identity mode has no isError member in a success (binding 5.7)
    assert result["structuredContent"]["row_count"] == 2 and result["structuredContent"]["truncated"] is True, result
    # max_read_size is max_bytes_to_read of the statement: a read of more bytes fails.
    answer(default=True, limits={"query.run.read": {"max_read_size": 1}})
    response = call_tool("run_query", {"host": "local", "sql": "SELECT sum(number) FROM numbers(1000000)"})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["isError"] is True and result["structuredContent"]["error"]["code"] == "read_limit", result
    # explorer.read does not declare max_read_size: the true answer is a refusal, the same as for an unknown tool (ProcurAuth 7.5).
    answer(default=True, limits={"explorer.read": {"max_read_size": 1000}})
    response = call_tool("list_databases", {"host": "local"})
    assert response.status_code == 200 and response.json()["error"]["code"] == -32602, response.text


@needs_identity
def test_the_ceilings_apply_on_the_client_side_when_the_profile_has_readonly_1():
    # The host ro1 has an MCP user whose profile has readonly = 1: ClickHouse takes no setting (docs/mcp.md, "The settings profile of the user").
    # ChDash counts the rows and bytes read and the time of a statement itself, and it refuses a ceiling on the memory that it cannot count.
    answer(default=True, limits={"query.run.read": {"max_rows_read": 100}})
    response = call_tool("run_query", {"host": "ro1", "sql": "SELECT sum(number) FROM numbers(100000000)"})
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["isError"] is True and result["structuredContent"]["error"]["code"] == "read_limit", result
    answer(default=True, limits={"query.run.read": {"max_read_size": 1}})
    result = call_tool("run_query", {"host": "ro1", "sql": "SELECT sum(number) FROM numbers(100000000)"}).json()["result"]
    assert result["isError"] is True and result["structuredContent"]["error"]["code"] == "read_limit", result
    answer(default=True, limits={"query.run.read": {"max_memory": 100_000_000}})
    result = call_tool("run_query", {"host": "ro1", "sql": "SELECT 1"}).json()["result"]
    assert result["isError"] is True and result["structuredContent"]["error"]["code"] == "ceiling_unenforceable", result
    # A ceiling that is not breached lets the statement run.
    answer(default=True, limits={"query.run.read": {"max_rows_read": 1_000_000_000, "max_duration": 60}})
    result = call_tool("run_query", {"host": "ro1", "sql": "SELECT 1 AS one"}).json()["result"]
    assert not result.get("isError") and result["structuredContent"]["untrusted"]["rows"] == [[1]], result


@needs_identity
def test_the_export_applies_the_ceilings_of_the_other_permission():
    # export_query needs query.export and query.run.read (ProcurAuth 5.5a). The ceilings of the other permission lower the ceilings of the call.
    answer(default=True, limits={"query.run.read": {"max_rows": 3}})
    result = call_tool("export_query", {"host": "local", "sql": "SELECT number FROM numbers(10)"}).json()["result"]
    assert not result.get("isError"), result
    assert result["structuredContent"]["row_count"] == 3 and result["structuredContent"]["truncated"] is True, result
    # A bad argument asks the PDP nothing, not even the other permission (contract 9.4, step 1).
    before = len(evaluations())
    result = call_tool("export_query", {"host": "local", "sql": "SELECT 1", "lease_s": 0}).json()["result"]
    assert result["isError"] is True and result["structuredContent"]["error"]["code"] == "invalid_argument", result
    assert len(evaluations()) == before


# ---- the budgets: binding 3.4, 3.6a, 5.3, 5.4 (cases U18, U23, U92, U93, U95) --------------------------------------------------


def usage_questions(action: str | None = None) -> list[dict]:
    """The questions that the PDP got with context.usage, for one action or for every action."""
    return [e for e in evaluations() if "usage" in e["context"] and (action is None or e["action"]["name"] == action)]


@needs_identity
def test_u18_the_tool_that_runs_sql_is_one_use_and_the_other_tools_are_not():
    answer(default=True)
    response = call_tool("run_query", {"host": "local", "sql": "SELECT 1"})
    assert response.status_code == 200 and not response.json()["result"].get("isError"), response.text
    # One question with usage 1 for the action of the tool, on the host of the call, and no question without usage before it.
    runs = [e for e in evaluations() if e["action"]["name"] == "query.run.read"]
    assert len(runs) == 1 and runs[0]["context"] == {"usage": {"units": 1}}, runs
    assert runs[0]["resource"]["type"] == "host" and runs[0]["resource"]["id"] == "local"
    # tools/list, a tool of the Explorer and a call without a host are no use: no question with usage.
    pdp("/control/reset", {})
    time.sleep(CACHE_TTL + 0.2)
    answer(default=True)
    assert rpc("tools/list").status_code == 200
    assert call_tool("list_databases", {"host": "local"}).status_code == 200
    assert call_tool("run_query", {"sql": "SELECT 1"}).status_code == 200  # host_required: nothing runs
    assert usage_questions() == [], usage_questions()
    # The other tools of query.run.read are uses too (owner decision of 2026-11-07): explain_query and the API tools of the Query page
    # take one unit for each call, with one question with usage on the host of the call.
    for tool, arguments in (("explain_query", {"host": "local", "sql": "SELECT 1"}), ("format_sql", {"host": "local", "body": {"sql": "select 1"}}),
                            ("explorer_names", {"host": "local", "params": {}})):
        pdp("/control/reset", {})
        time.sleep(CACHE_TTL + 0.2)
        answer(default=True)
        assert call_tool(tool, arguments).status_code == 200, tool
        uses = usage_questions()
        assert len(uses) == 1 and uses[0]["action"]["name"] == "query.run.read", (tool, uses)
        assert uses[0]["resource"]["type"] == "host" and uses[0]["resource"]["id"] == "local", (tool, uses)


@needs_identity
def test_u23_u93_a_spent_budget_gives_a_tool_error_on_a_call_and_429_on_another_request():
    answer(default=True, usage={"query.run.read": {"exceeded": 12}, "mcp.session": {"exceeded": 12}})
    response = call_tool("run_query", {"host": "local", "sql": "SELECT 1"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert "error" not in body and body["result"]["resultType"] == "complete" and body["result"]["isError"] is True
    error = body["result"]["structuredContent"]["error"]
    assert error["code"] == "budget_exceeded" and error["retryable"] is True and error["retry_after"] == 12 and error["message"]
    text = body["result"]["content"][0]["text"]
    assert text.startswith('{"error":{') and '"retry_after":12' in text and " " not in text.split('"message":"')[0]
    assert json_loads(text) == body["result"]["structuredContent"]
    # A request with no tool: HTTP 429 with Retry-After, the code -31429 and data.retry_after.
    response = rpc("ping")
    assert response.status_code == 429 and response.headers["Retry-After"] == "12", response.text
    assert response.json() == {"jsonrpc": "2.0", "id": 7, "error": {"code": -31429, "message": "rate_limited", "data": {"retry_after": 12}}}
    # The reason of the PDP never reaches the client.
    assert "budget_exceeded" not in rpc("ping").text


@needs_identity
def test_u92_a_true_answer_without_units_is_a_refusal_and_asks_nothing_more():
    answer(default=True, usage={"query.run.read": {"omit_units": True}, "mcp.session": {"omit_units": True}})
    response = call_tool("run_query", {"host": "local", "sql": "SELECT 1"})
    assert response.status_code == 200 and response.json()["error"]["code"] == -32602 and "result" not in response.json()
    assert len(usage_questions("query.run.read")) == 1
    response = rpc("ping")
    assert response.status_code == 403 and response.json()["error"]["code"] == -32001


@needs_identity
def test_u95_a_request_with_no_tool_is_one_use_of_mcp_session():
    answer(default=True)
    assert rpc("ping").status_code == 200
    asked = usage_questions("mcp.session")
    assert len(asked) == 1 and asked[0]["context"] == {"usage": {"units": 1}} and asked[0]["resource"] == {"type": "service", "id": AUDIENCE}
    # mcp.session is never the action of a tool: list_hosts asks mcp.hosts.read and the analysis of the caller asks mcp.analysis.read, with no usage.
    assert call_tool("list_hosts", {}).status_code == 200
    assert call_tool("mcp_analysis_my_limits", {}).status_code == 200
    assert len(usage_questions("mcp.session")) == 1
    named = {e["action"]["name"] for e in evaluations()}
    assert {"mcp.hosts.read", "mcp.analysis.read"} <= named
    assert not usage_questions("mcp.hosts.read") and not usage_questions("mcp.analysis.read")


@needs_identity
def test_u68_a_lost_answer_gives_503_and_the_question_is_never_sent_again():
    for rules in ({"status": 500}, {"drop": True}, {"delay_ms": 2000}):
        pdp("/control/reset", {})
        answer(default=True, usage={"query.run.read": rules})
        response = call_tool("run_query", {"host": "local", "sql": "SELECT 1"})
        assert response.status_code == 503 and response.json()["error"]["code"] == -32603, (rules, response.text)
        time.sleep(0.3)
        assert len(usage_questions("query.run.read")) == 1, (rules, usage_questions())


def json_loads(text: str):
    import json

    return json.loads(text)


# ---- the page API ----------------------------------------------------------------------------------------------------------


@needs_identity
def test_the_keys_page_has_no_key_of_chdash():
    answer(default=True)
    meta = SESSION.get(f"{BASE_URL}/api/mcp/meta", headers={HEADER: token()}, timeout=30).json()
    assert meta["auth_mode"] == "identity" and meta["auth_header"] == HEADER and meta["can_manage"] is False
    # The identity mode does not publish mcp.keys.write (the keys live in the portal): the route is a plain denial with no question to the PDP.
    refused = SESSION.post(f"{BASE_URL}/api/mcp/keys", json={"name": "x"}, headers={HEADER: token()}, timeout=30)
    assert refused.status_code == 403 and refused.json()["error_code"] == "forbidden" and refused.json()["action"] == "mcp.keys.write", refused.text


@needs_identity
def test_the_usage_groups_the_requests_by_subject():
    answer(default=True)
    assert rpc("ping", tok=token("key:usage-subject")).status_code == 200
    overview = SESSION.get(f"{BASE_URL}/api/mcp/usage/overview?window=1h", headers={HEADER: token()}, timeout=30).json()
    sources = {row["source"] for row in overview["keys"]}
    assert "identity" in sources
    assert any(row["name"] == "key:usage-subject" and row["id"].startswith("sub_") for row in overview["keys"])
