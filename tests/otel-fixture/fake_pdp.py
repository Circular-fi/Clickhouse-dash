"""A fake AuthZEN PDP for the tests of the access of humans (docs/access.md, contract 11.5).

It answers POST /access/v1/evaluation and POST /access/v1/evaluations, and keeps each request that it receives (the path,
the headers that matter and the body). The tests set its answers and read what it received:

    GET  /control/received   {"requests": [{"path", "authorization", "request_id", "traceparent", "body"}, ...]}
    POST /control/reset      forgets the requests and sets the default answers again
    POST /control/answer     {"default": true, "deny": ["query.export", ...], "allow": [...], "deny_subjects": ["stayer"],
                              "unknown_subjects": ["leaver"], "subjects": {"querier": ["query.run.read", ...]}, "status": 500,
                              "delay_ms": 2000}
                             deny and allow are lists of action names (every resource), or of "action@<path>" for one resource
                             and every resource below it (the prefix rule of the grants, docs/access.md "Hosts"). The path is
                             "service:<id>/host:<id>/database:<id>" with the ids percent-encoded; a path that does not start with
                             "service:" starts below the service of the PDP ("host:local" is "service:db/host:local"). deny_subjects
                             lists the subjects that exist and hold no action: false for every action, with no reason.
                             unknown_subjects lists the subjects that the PDP does not know: false for every action, with
                             "context": {"reason": "unknown_subject"} (contract 11.5). subjects gives the whole grant of a
                             subject: true for the entries of its list only (the same forms as allow). parents gives the tree of
                             the types under the service (default {"host": "service", "database": "host"}). status and delay_ms
                             apply to every evaluation request until the next /control/answer or /control/reset.
    GET  /healthz            200

Each evaluation follows the rules of contract 11.4: the chain of the resource (properties.ancestors and the resource) must start with
the service of the PDP (FAKE_PDP_SERVICE, default "db") and follow the parents; a resource without ancestors is read as
[service] + resource. A chain that is not valid gives false with "context": {"reason": "invalid_resource"}. The context of an
evaluation (the item, else the default of the batch) can have "match": "node" (the default: the prefix rule) or "subtree" (a grant
below the resource also gives true; addendum 1). Any other match gives false with "context": {"reason": "invalid_request"}.

A request with a wrong token (Authorization: Bearer <FAKE_PDP_TOKEN>) gets 401. It uses the standard library only. The port is
FAKE_PDP_PORT (default 8181).
"""

import json
import os
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote

MAX_REQUESTS = 2000
MAX_BODY_BYTES = 1024 * 1024
TOKEN = os.environ.get("FAKE_PDP_TOKEN", "pdp-test-token")
SERVICE = os.environ.get("FAKE_PDP_SERVICE", "db")

LOCK = threading.Lock()
RECEIVED: deque = deque(maxlen=MAX_REQUESTS)
DEFAULT_ANSWER = {"default": True, "deny": [], "allow": [], "deny_subjects": [], "unknown_subjects": [], "subjects": {}, "status": 200,
                  "delay_ms": 0, "parents": {"host": "service", "database": "host"}}
UNKNOWN_SUBJECT = {"decision": False, "context": {"reason": "unknown_subject"}}
INVALID_RESOURCE = {"decision": False, "context": {"reason": "invalid_resource"}}
INVALID_REQUEST = {"decision": False, "context": {"reason": "invalid_request"}}
ANSWER = dict(DEFAULT_ANSWER)


def encode(value: str) -> str:
    """The id of a segment, percent-encoded (RFC 3986): every byte outside A-Z a-z 0-9 - . _ ~ is %XX."""
    return quote(value, safe="-._~")


def chain_of(resource: dict, parents: dict) -> list[str] | None:
    """The segments "type:<encoded id>" from the service to the resource, or None when the chain is not valid (contract 11.4)."""
    resource = resource or {}
    kind, ident = str(resource.get("type", "")), str(resource.get("id", ""))
    ancestors = ((resource.get("properties") or {}).get("ancestors")) or []
    nodes = [(str(n.get("type", "")), str(n.get("id", ""))) for n in ancestors if isinstance(n, dict)]
    if kind != "service" and not nodes:
        nodes = [("service", SERVICE)]
    nodes.append((kind, ident))
    if nodes[0] != ("service", SERVICE):
        return None
    for (parent, _), (child, _) in zip(nodes, nodes[1:]):
        if parents.get(child) != parent:
            return None
    return [f"{k}:{encode(i)}" for k, i in nodes]


def matches(entry: str, name: str, chain: list[str], subtree: bool = False) -> bool:
    """True when the entry ("action" or "action@<path>") covers the action on the chain: the path is a prefix of the chain, or
    with the match "subtree" the chain is a prefix of the path (a grant below the resource)."""
    action, _, path = str(entry).partition("@")
    if action != name:
        return False
    if not path:
        return True
    if not path.startswith("service:"):
        path = f"service:{encode(SERVICE)}/{path}"
    granted = path.split("/")
    if len(granted) <= len(chain):
        return chain[: len(granted)] == granted
    return subtree and granted[: len(chain)] == chain


def decide(subject: dict, action: dict, resource: dict, context: dict | None = None) -> dict:
    """Return the AuthZEN answer of one evaluation: {"decision": bool}, with a context for an unknown subject, resource or match."""
    with LOCK:
        answer = dict(ANSWER)
    if context is None:
        context = {}
    match = context.get("match", "node") if isinstance(context, dict) else None
    if match not in ("node", "subtree"):
        return dict(INVALID_REQUEST)
    if str((subject or {}).get("id", "")) in answer["unknown_subjects"]:
        return dict(UNKNOWN_SUBJECT)
    chain = chain_of(resource, answer["parents"] or {})
    if chain is None:
        return dict(INVALID_RESOURCE)
    return {"decision": allowed(answer, subject, action, chain, match == "subtree")}


def allowed(answer: dict, subject: dict, action: dict, chain: list[str], subtree: bool = False) -> bool:
    name = str((action or {}).get("name", ""))
    subject_id = str((subject or {}).get("id", ""))
    if subject_id in answer["deny_subjects"]:
        return False
    grant = (answer["subjects"] or {}).get(subject_id)
    if isinstance(grant, list):
        return any(matches(entry, name, chain, subtree) for entry in grant)
    # A deny entry applies by the prefix rule only: a deny below the resource does not hide the resource.
    if any(matches(entry, name, chain) for entry in answer["deny"]):
        return False
    if any(matches(entry, name, chain, subtree) for entry in answer["allow"]):
        return True
    return bool(answer["default"])


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 - the name of the base class
        return

    def reply(self, status: int, payload) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        return json.loads(raw or b"{}")

    def do_GET(self):  # noqa: N802 - the name of the base class
        if self.path == "/healthz":
            return self.reply(200, {"ok": True})
        if self.path == "/control/received":
            with LOCK:
                return self.reply(200, {"requests": list(RECEIVED)})
        return self.reply(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802 - the name of the base class
        global ANSWER
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError):
            return self.reply(400, {"error": "bad body"})
        if self.path == "/control/reset":
            with LOCK:
                RECEIVED.clear()
                ANSWER = dict(DEFAULT_ANSWER)
            return self.reply(200, {"ok": True})
        if self.path == "/control/answer":
            with LOCK:
                ANSWER = dict(DEFAULT_ANSWER)
                ANSWER.update({k: v for k, v in body.items() if k in DEFAULT_ANSWER})
            return self.reply(200, {"ok": True})
        if self.path not in ("/access/v1/evaluation", "/access/v1/evaluations"):
            return self.reply(404, {"error": "not found"})
        with LOCK:
            RECEIVED.append(
                {
                    "path": self.path,
                    "authorization": self.headers.get("Authorization", ""),
                    "request_id": self.headers.get("X-Request-ID", ""),
                    "traceparent": self.headers.get("traceparent", ""),
                    "body": body,
                    "at": time.time(),
                }
            )
            answer = dict(ANSWER)
        if self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
            return self.reply(401, {"error": "unauthorized"})
        if answer["delay_ms"]:
            time.sleep(answer["delay_ms"] / 1000.0)
        if answer["status"] != 200:
            return self.reply(int(answer["status"]), {"error": "test status"})
        if self.path == "/access/v1/evaluation":
            return self.reply(200, decide(body.get("subject"), body.get("action"), body.get("resource"), body.get("context")))
        out = []
        for item in body.get("evaluations") or []:
            subject = item.get("subject") or body.get("subject")
            action = item.get("action") or body.get("action")
            resource = item.get("resource") or body.get("resource")
            # AuthZEN 1.0, 7.1: the context of an item replaces the default context of the batch.
            context = item["context"] if "context" in item else body.get("context")
            out.append(decide(subject, action, resource, context))
        return self.reply(200, {"evaluations": out})


def main() -> None:
    port = int(os.environ.get("FAKE_PDP_PORT", "8181"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
