"""The OTLP export of the server (docs/server-telemetry.md; contract 7.4 and 7.5), against a fake OTLP receiver.

Instances (the tests skip without them; in the official run, CHDASH_REQUIRE_FIXTURES=1 makes a missing one a failure):
- TELEMETRY_BASE_URL: tests/config/mcp.telemetry.hcl (the compose service chdash_mcp_telemetry), which exports to the receiver.
- OTLP_RECEIVER_URL: the fake receiver (tests/otel-fixture/otlp_receiver.py, the compose service otlp_receiver). GET /received gives
  the bodies that it took.
"""

from __future__ import annotations

import json
import os
import time
import uuid

import pytest
import requests

TELEMETRY_URL = os.environ.get("TELEMETRY_BASE_URL", "").rstrip("/")
RECEIVER_URL = os.environ.get("OTLP_RECEIVER_URL", "").rstrip("/")
# The token of the key "telemetry" of tests/config/mcp.telemetry.hcl (the file mcp-key-second-host).
TOKEN = "mcp_5ec0d000SecondHost0000000000000000000000000"

needs_telemetry = pytest.mark.skipif(not (TELEMETRY_URL and RECEIVER_URL), reason="TELEMETRY_BASE_URL is not set")

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})


def new_trace() -> tuple[str, str, str]:
    """A trace id, a parent span id and the traceparent header (sampled)."""
    trace_id = uuid.uuid4().hex
    parent = uuid.uuid4().hex[:16]
    return trace_id, parent, f"00-{trace_id}-{parent}-01"


def post(body: dict, *, token: str | None = TOKEN, headers: dict | None = None) -> requests.Response:
    hdrs = {"Content-Type": "application/json"}
    if token is not None:
        hdrs["Authorization"] = f"Bearer {token}"
    hdrs.update(headers or {})
    return SESSION.post(f"{TELEMETRY_URL}/mcp", data=json.dumps(body), headers=hdrs, timeout=30)


def attributes(item: dict) -> dict:
    out = {}
    for a in item.get("attributes", []):
        value = a["value"]
        out[a["key"]] = next(iter(value.values())) if value else None
    return out


def spans_of(trace_id: str) -> list[dict]:
    received = SESSION.get(f"{RECEIVER_URL}/received", timeout=10).json()
    out = []
    for body in received["traces"]:
        for resource in body["resourceSpans"]:
            for scope in resource["scopeSpans"]:
                for span in scope["spans"]:
                    if span["traceId"] == trace_id:
                        out.append({**span, "_resource": attributes(resource["resource"]), "_scope": scope["scope"]})
    return out


def logs_of(trace_id: str) -> list[dict]:
    received = SESSION.get(f"{RECEIVER_URL}/received", timeout=10).json()
    out = []
    for body in received["logs"]:
        for resource in body["resourceLogs"]:
            for scope in resource["scopeLogs"]:
                out += [r for r in scope["logRecords"] if r.get("traceId") == trace_id]
    return out


def wait_for(read, predicate, timeout: float = 15.0):
    """Reads until `predicate` holds for the value; the last value after `timeout`."""
    end = time.monotonic() + timeout
    value = read()
    while not predicate(value) and time.monotonic() < end:
        time.sleep(0.2)
        value = read()
    return value


def server_span(spans: list[dict]) -> dict:
    found = [s for s in spans if s["kind"] == 2]
    assert len(found) == 1, spans
    return found[0]


@needs_telemetry
def test_tools_list_span_continues_the_trace_of_the_headers():
    trace_id, parent, traceparent = new_trace()
    response = post({"jsonrpc": "2.0", "id": "req-17", "method": "tools/list"},
                    headers={"traceparent": traceparent, "baggage": "agent.run_id=run-tl,agent.caller=planner,agent.on_behalf_of=alice"})
    assert response.status_code == 200, response.text
    spans = wait_for(lambda: spans_of(trace_id), lambda s: len(s) >= 1)
    span = server_span(spans)
    assert span["name"] == "tools/list"
    assert span["parentSpanId"] == parent
    assert len(span["spanId"]) == 16
    assert int(span["endTimeUnixNano"]) >= int(span["startTimeUnixNano"]) > 0
    a = attributes(span)
    assert a["mcp.method.name"] == "tools/list"
    assert a["jsonrpc.request.id"] == "req-17"
    assert a["client.address"]
    assert a["gen_ai.conversation.id"] == "run-tl"
    assert a["agent.run_id"] == "run-tl"
    assert a["agent.caller"] == "planner"
    assert a["agent.on_behalf_of"] == "alice"
    assert "error.type" not in a and "gen_ai.tool.name" not in a and "mcp.session.id" not in a
    assert "status" not in span
    assert span["_resource"]["service.name"] == "chdash-telemetry-test"
    assert span["_resource"]["service.instance.id"] == "chdash-telemetry-test"
    assert span["_resource"]["service.version"]
    assert span["_scope"]["name"] == "chdash"


@needs_telemetry
def test_tool_call_has_child_spans_and_no_arguments():
    trace_id, parent, traceparent = new_trace()
    marker = "telemetry-marker-" + uuid.uuid4().hex[:8]
    body = {
        "jsonrpc": "2.0", "id": 5, "method": "tools/call",
        "params": {"name": "run_query", "arguments": {"sql": f"SELECT '{marker}' AS m"},
                   "_meta": {"traceparent": traceparent, "baggage": "agent.run_id=run-q"}},
    }
    response = post(body)
    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["isError"] is False, result
    spans = wait_for(lambda: spans_of(trace_id), lambda s: len(s) >= 2)
    span = server_span(spans)
    assert span["name"] == "tools/call run_query"
    assert span["parentSpanId"] == parent
    a = attributes(span)
    assert a["mcp.method.name"] == "tools/call"
    assert a["gen_ai.tool.name"] == "run_query"
    assert a["gen_ai.operation.name"] == "execute_tool"
    assert a["jsonrpc.request.id"] == "5"
    assert a["gen_ai.conversation.id"] == "run-q"
    children = [s for s in spans if s["kind"] == 3]
    assert children, spans
    for child in children:
        assert child["parentSpanId"] == span["spanId"]
        assert child["traceId"] == trace_id
        c = attributes(child)
        assert c["db.system.name"] == "clickhouse"
        assert c["server.address"] == "clickhouse"
        assert int(c["server.port"]) == 9000
        assert int(span["startTimeUnixNano"]) <= int(child["startTimeUnixNano"]) <= int(child["endTimeUnixNano"]) <= int(span["endTimeUnixNano"])
    assert any(child["name"] == "SELECT" for child in children), [c["name"] for c in children]
    # The arguments and the result (and so the SQL text) are never recorded.
    assert marker not in json.dumps(spans)
    assert "gen_ai.tool.call.arguments" not in a and "gen_ai.tool.call.result" not in a

    # The call log as an OTLP log record, with the identifiers of the SERVER span.
    logs = wait_for(lambda: logs_of(trace_id), lambda r: len(r) >= 1)
    assert len(logs) == 1, logs
    record = logs[0]
    assert record["eventName"] == "mcp.call"
    assert record["spanId"] == span["spanId"]
    la = attributes(record)
    assert la["key"] == "telemetry"
    assert la["subject"] == "telemetry-team"
    assert la["status"] == "ok"
    assert la["mcp.method.name"] == "tools/call"
    assert la["gen_ai.tool.name"] == "run_query"
    assert la["trace_id"] == trace_id
    assert la["span_id"] == span["spanId"]
    assert la["instance"] == "chdash-telemetry-test"
    assert marker not in json.dumps(logs)


@needs_telemetry
def test_api_tool_statements_are_child_spans():
    """An API tool runs its route in the process: the statements of that route are children of the SERVER span too."""
    trace_id, _parent, traceparent = new_trace()
    body = {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "system_overview", "arguments": {"host": "local"}}}
    response = post(body, headers={"traceparent": traceparent})
    assert response.status_code == 200, response.text
    spans = wait_for(lambda: spans_of(trace_id), lambda s: len([x for x in s if x["kind"] == 3]) >= 1)
    span = server_span(spans)
    assert span["name"] == "tools/call system_overview"
    children = [s for s in spans if s["kind"] == 3]
    assert children and all(c["parentSpanId"] == span["spanId"] for c in children)


@needs_telemetry
def test_refused_request_has_a_span_with_error_type():
    trace_id, parent, traceparent = new_trace()
    response = post({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token=None, headers={"traceparent": traceparent})
    assert response.status_code == 401
    spans = wait_for(lambda: spans_of(trace_id), lambda s: len(s) >= 1)
    span = server_span(spans)
    assert span["name"] == "request"
    assert span["parentSpanId"] == parent
    assert attributes(span)["error.type"] == "401"
    assert span["status"]["code"] == 2
    logs = wait_for(lambda: logs_of(trace_id), lambda r: len(r) >= 1)
    assert attributes(logs[0])["status"] == "401"
    assert attributes(logs[0])["key"] == "-"


@needs_telemetry
def test_unknown_method_error_type_and_new_trace_without_context():
    response = post({"jsonrpc": "2.0", "id": 3, "method": "nope/never"}, headers={"traceparent": "00-" + "0" * 32 + "-" + "1" * 16 + "-01"})
    assert response.status_code == 200
    assert response.json()["error"]["code"] == -32601
    # The traceparent is not valid (a trace id of zeros): the span starts a new trace. Find it by its request id.
    def find():
        received = SESSION.get(f"{RECEIVER_URL}/received", timeout=10).json()
        out = []
        for body in received["traces"]:
            for resource in body["resourceSpans"]:
                for scope in resource["scopeSpans"]:
                    out += [s for s in scope["spans"] if attributes(s).get("mcp.method.name") == "nope/never"]
        return out
    spans = wait_for(find, lambda s: len(s) >= 1)
    assert spans, "no span for the unknown method"
    span = spans[-1]
    assert "parentSpanId" not in span
    assert span["traceId"] != "0" * 32 and len(span["traceId"]) == 32
    assert attributes(span)["error.type"] == "rpc_-32601"


@needs_telemetry
def test_unsampled_parent_exports_no_span_but_the_log_record():
    trace_id = uuid.uuid4().hex
    traceparent = f"00-{trace_id}-{uuid.uuid4().hex[:16]}-00"
    response = post({"jsonrpc": "2.0", "id": 4, "method": "tools/list"}, headers={"traceparent": traceparent})
    assert response.status_code == 200
    logs = wait_for(lambda: logs_of(trace_id), lambda r: len(r) >= 1)
    assert len(logs) == 1
    time.sleep(0.6)
    assert spans_of(trace_id) == []


@needs_telemetry
def test_metrics_count_the_export():
    def exported():
        text = SESSION.get(f"{TELEMETRY_URL}/metrics", timeout=10).text
        for line in text.splitlines():
            if line.startswith('chdash_telemetry_exported_total{signal="spans"}'):
                return float(line.rsplit(" ", 1)[1])
        return 0.0
    _trace_id, _parent, traceparent = new_trace()
    assert post({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={"traceparent": traceparent}).status_code == 200
    assert wait_for(exported, lambda v: v > 0) > 0
    text = SESSION.get(f"{TELEMETRY_URL}/metrics", timeout=10).text
    for family in ("chdash_telemetry_exported_total", "chdash_telemetry_dropped_total", "chdash_telemetry_export_requests_total",
                   "chdash_telemetry_queue_items"):
        assert f"# TYPE {family} " in text
    assert 'chdash_telemetry_dropped_total{signal="spans",reason="queue_full"}' in text


@needs_telemetry
def test_receiver_refusal_is_retried():
    """503 can be repaired by a retry: the spans arrive after the receiver accepts again."""
    assert SESSION.post(f"{RECEIVER_URL}/answer", data=json.dumps({"status": 503, "count": 1}), timeout=10).status_code == 200
    trace_id, _parent, traceparent = new_trace()
    assert post({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={"traceparent": traceparent}).status_code == 200
    spans = wait_for(lambda: spans_of(trace_id), lambda s: len(s) >= 1)
    assert len(spans) == 1
