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
                             apply to every evaluation request until the next /control/answer or /control/reset. fixed gives the
                             whole answer of each evaluation of an action, for a known subject and a valid chain, for example
                             {"fixed": {"system.read": {"decision": false, "context": {"reason": "budget_exceeded", "retry_after": 7}}}}.
                             limits gives the ceilings of the true answers (ProcurAuth 7.3): a map from an entry ("action" or
                             "action@<path>", the same forms as allow) to {"max_rows": 100, ...}. A true answer holds in
                             "context": {"limits": {...}} the lowest value of each ceiling over the entries that cover the question
                             (ProcurAuth 8.1). A false answer has no limits (7.6). Example:
                             {"limits": {"query.run.read": {"max_rows": 100}, "query.run.read@host:local": {"max_rows": 10}}}.
    GET  /healthz            200
    GET  /.well-known/authzen-configuration
                             404 by default (a PDP without metadata). With FAKE_PDP_PUBLIC_URL (the base URL that the clients
                             use, for example "https://pdp:8443") it gives the metadata of AuthZEN 1.0 (l.1271-1366): the endpoints under
                             that URL, and the members procurauth_* that /control/answer "metadata_extra" holds. "metadata": false
                             in /control/answer gives 404 again; "metadata": {...} gives that whole document.
    POST /access/v1/search/resource
                             the Resource Search of AuthZEN 1.0 (l.1151-1210): /control/answer "search": {"pages": [["a", "b"], ["c"]]}
                             gives each page of ids as results of the type that the request names; page.next_token is "p<N>" and the
                             request page.token "p<N>" asks page N. The metadata names this endpoint only when "search" is set.

The PDP echoes the X-Request-ID of a request in its response (AuthZEN 1.0, l.1449-1451) unless /control/answer has
"echo_request_id": false.

TLS: FAKE_PDP_TLS_CERT and FAKE_PDP_TLS_KEY (PEM files) make the server speak https. The handshake runs in the thread of the connection, so a
client that does not speak TLS never blocks the other clients. FAKE_PDP_HOST is the address that the server binds (default 0.0.0.0).

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
import ssl
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
PUBLIC_URL = os.environ.get("FAKE_PDP_PUBLIC_URL", "").rstrip("/")
DEFAULT_ANSWER = {"default": True, "deny": [], "allow": [], "deny_subjects": [], "unknown_subjects": [], "subjects": {}, "status": 200,
                  "delay_ms": 0, "parents": {"host": "service", "database": "host"}, "fixed": {}, "metadata": True, "metadata_extra": {},
                  "search": None, "echo_request_id": True, "limits": {}}
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
    fixed = (answer["fixed"] or {}).get(str((action or {}).get("name", "")))
    if isinstance(fixed, dict):
        return json.loads(json.dumps(fixed))
    granted = allowed(answer, subject, action, chain, match == "subtree")
    out: dict = {"decision": granted}
    limits = ceilings_of(answer, str((action or {}).get("name", "")), chain, match == "subtree") if granted else {}
    if limits:
        out["context"] = {"limits": limits}
    return out


def ceilings_of(answer: dict, name: str, chain: list[str], subtree: bool) -> dict:
    """The ceilings of a true answer: for each name, the lowest value of the entries of "limits" that cover the question."""
    out: dict = {}
    for entry, values in (answer["limits"] or {}).items():
        if not matches(entry, name, chain, subtree) or not isinstance(values, dict):
            continue
        for ceiling, value in values.items():
            out[ceiling] = min(out.get(ceiling, value), value)
    return out


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

    def reply(self, status: int, payload, echo: bool = False) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        request_id = self.headers.get("X-Request-ID")
        if echo and request_id:
            self.send_header("X-Request-ID", request_id)
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
        if self.path.startswith("/.well-known/authzen-configuration"):
            with LOCK:
                answer = dict(ANSWER)
            if answer["metadata"] is False or not (PUBLIC_URL or isinstance(answer["metadata"], dict)):
                return self.reply(404, {"error": "no metadata"})
            if isinstance(answer["metadata"], dict):
                return self.reply(200, answer["metadata"])
            document = {
                "policy_decision_point": PUBLIC_URL,
                "access_evaluation_endpoint": f"{PUBLIC_URL}/access/v1/evaluation",
                "access_evaluations_endpoint": f"{PUBLIC_URL}/access/v1/evaluations",
            }
            if answer["search"]:
                document["search_resource_endpoint"] = f"{PUBLIC_URL}/access/v1/search/resource"
            document.update(answer["metadata_extra"] or {})
            return self.reply(200, document)
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
        if self.path not in ("/access/v1/evaluation", "/access/v1/evaluations", "/access/v1/search/resource"):
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
        echo = bool(answer["echo_request_id"])
        if self.path == "/access/v1/search/resource":
            return self.reply(200, search(answer, body), echo)
        if self.path == "/access/v1/evaluation":
            return self.reply(200, decide(body.get("subject"), body.get("action"), body.get("resource"), body.get("context")), echo)
        out = []
        for item in body.get("evaluations") or []:
            subject = item.get("subject") or body.get("subject")
            action = item.get("action") or body.get("action")
            resource = item.get("resource") or body.get("resource")
            # AuthZEN 1.0, 7.1: the context of an item replaces the default context of the batch.
            context = item["context"] if "context" in item else body.get("context")
            out.append(decide(subject, action, resource, context))
        return self.reply(200, {"evaluations": out}, echo)


def search(answer: dict, body: dict) -> dict:
    """The page of a Resource Search: the ids of the page named by page.token ("p<N>"), as results of the type of the request."""
    pages = (answer["search"] or {}).get("pages") or [[]]
    token = str(((body.get("page") or {}).get("token")) or "")
    index = int(token[1:]) if token.startswith("p") and token[1:].isdigit() else 0
    if index >= len(pages):
        return {"results": []}
    kind = str((body.get("resource") or {}).get("type", ""))
    out = {"results": [{"type": kind, "id": ident} for ident in pages[index]]}
    out["page"] = {"next_token": f"p{index + 1}" if index + 1 < len(pages) else ""}
    return out


class TlsServer(ThreadingHTTPServer):
    """An https server: the handshake happens at the first read, in the thread of the connection."""

    context: ssl.SSLContext

    def get_request(self):
        sock, address = self.socket.accept()
        return self.context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), address


def main() -> None:
    port = int(os.environ.get("FAKE_PDP_PORT", "8181"))
    host = os.environ.get("FAKE_PDP_HOST", "0.0.0.0")
    cert, key = os.environ.get("FAKE_PDP_TLS_CERT"), os.environ.get("FAKE_PDP_TLS_KEY")
    if cert or key:
        if not (cert and key):
            raise SystemExit("FAKE_PDP_TLS_CERT and FAKE_PDP_TLS_KEY go together")
        server = TlsServer((host, port), Handler)
        server.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server.context.load_cert_chain(cert, key)
    else:
        server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
