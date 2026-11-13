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
                             usage gives the budgets (ProcurAuth section 6): a map from an action name to the rules of its questions with
                             "context": {"usage": {"units": 1}}. A question with usage gets the decision of the grants first; only a true
                             answer takes units (6.5) and has "context": {"usage": {"units": N}} (6.12). The rules of an action:
                             "units": 0 or 1 (default 1) gives the units of the true answer; "amount": N counts the units of each
                             (subject, action) and gives false with "reason": "budget_exceeded" and "retry_after" ("retry_after", default
                             12) when N units are taken; "exceeded": R always gives budget_exceeded with retry_after R; "omit_units": true
                             gives a true answer without usage.units (the PEP must treat it as false); "status": S answers with the HTTP
                             status S; "drop": true closes the connection with no answer; "delay_ms": D waits D ms before the answer. An
                             action with no rule gives units 1. The counters start again at /control/reset and at /control/answer.
                             The PDP follows 6.11: a request with context.usage at any level that is not one evaluation (an
                             Access Evaluation request, or an Access Evaluations request without items), or with "match": "subtree",
                             or with units other than 1, gets HTTP 400 and counts nothing.
                             The PDP follows 5.5a: a question with "context": {"permission_only": true} is the question of an other permission
                             of an operation. It gets a plain decision: the approval gate never answers it (confirm is ignored). The member
                             with another value, or with context.usage or context.approval, gets HTTP 400 (invalid_request in a batch item).
POST /control/approval   {"actions": ["query.run.write", ...] or ["*"], "submit": {"status": 409, "error": "no_device"}, "max_command_bytes": 16384}
                             the approval gate of ProcurAuth section 17 (docs/access.md, "Approval of an action"). An action in "actions"
                             needs an approval for each subject. A question without context.approval.effect gets approval_required; with an
                             effect, the state of the approval gives approval_required (with an evaluation_id), approval_pending,
                             approval_denied, approval_expired (a question with usage) or true; a question with usage consumes a usable
                             approval. "submit" makes the submission answer that status. The routes of the approval API (17.4):
                             POST /approval/v1/requests, GET /approval/v1/requests/<id>?subject=&wait=&renew=true and
                             POST /approval/v1/requests/<id>/keepalive. The test plays the person with
                             POST /control/approval/decide {"request_id": "...", "decision": "approve" | "decline" | "cancel"} and reads
                             GET /control/approval/received {"submissions": [...], "reads": [...]} (the body, the query and the headers of each).
                             /control/reset forgets the approvals too.
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
                             "search": {"by_action": {"explorer.read": [["a"], ["b"]]}} gives other pages to an action (an action that is
                             not in the map gets "pages", or an empty result). "search": {"status": 500} makes only this endpoint answer
                             that HTTP status. The search ignores the chain and the subject, like a PDP that does not read
                             properties.ancestors (the check of the extension in docs/access.md, "Resource Search").

FAKE_PDP_SEARCH (JSON, for example {"pages": []}) is the default value of "search" after each /control/reset, so that the metadata that a
client reads at its start announces the search endpoint.

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
from urllib.parse import parse_qs, quote, urlsplit

MAX_REQUESTS = 2000
MAX_BODY_BYTES = 1024 * 1024
TOKEN = os.environ.get("FAKE_PDP_TOKEN", "pdp-test-token")
SERVICE = os.environ.get("FAKE_PDP_SERVICE", "db")

LOCK = threading.Lock()
RECEIVED: deque = deque(maxlen=MAX_REQUESTS)
PUBLIC_URL = os.environ.get("FAKE_PDP_PUBLIC_URL", "").rstrip("/")
DEFAULT_ANSWER = {"default": True, "deny": [], "allow": [], "deny_subjects": [], "unknown_subjects": [], "subjects": {}, "status": 200,
                  "delay_ms": 0, "parents": {"host": "service", "database": "host"}, "fixed": {}, "metadata": True, "metadata_extra": {},
                  "search": json.loads(os.environ["FAKE_PDP_SEARCH"]) if os.environ.get("FAKE_PDP_SEARCH") else None, "echo_request_id": True,
                  "limits": {}, "usage": {}}
COUNTERS: dict = {}
APPROVAL_CONFIG: dict = {"actions": [], "submit": None, "max_command_bytes": 16384}
APPROVALS: list = []      # one dict for each request that a service submitted
EVALUATIONS: dict = {}    # evaluation_id -> the facts of the question that got it
APPROVAL_RECEIVED: dict = {"submissions": [], "reads": []}
APPROVAL_MEMBERS = {"evaluation_id", "effect", "op", "view", "approval_ref", "lease_s", "until", "supersedes"}
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


def usage_of(context) -> dict | None:
    """The context.usage of an evaluation context, or None."""
    usage = context.get("usage") if isinstance(context, dict) else None
    return usage if isinstance(usage, dict) else None


def take_units(answer: dict, subject: dict, action: dict, out: dict) -> dict:
    """Add the units of a use to a true answer, or turn it into budget_exceeded (ProcurAuth 6.5, 6.12, 11.1). `out` is the true answer."""
    name = str((action or {}).get("name", ""))
    rules = (answer["usage"] or {}).get(name) or {}
    if rules.get("exceeded"):
        return {"decision": False, "context": {"reason": "budget_exceeded", "retry_after": int(rules["exceeded"])}}
    units = int(rules.get("units", 1))
    if rules.get("amount") is not None and units > 0:
        key = (str((subject or {}).get("id", "")), name)
        with LOCK:
            used = COUNTERS.get(key, 0)
            if used + units > int(rules["amount"]):
                return {"decision": False, "context": {"reason": "budget_exceeded", "retry_after": int(rules.get("retry_after", 12))}}
            COUNTERS[key] = used + units
    context = dict(out.get("context") or {})
    if not rules.get("omit_units"):
        context["usage"] = {"units": units}
    return {"decision": True, "context": context}


def permission_only_valid(context) -> bool:
    """ProcurAuth 5.5a: context.permission_only has the only valid value true, and no context.usage and no context.approval with it.
    A context without the member is valid."""
    if not isinstance(context, dict) or "permission_only" not in context:
        return True
    return context["permission_only"] is True and "usage" not in context and "approval" not in context


def decide(subject: dict, action: dict, resource: dict, context: dict | None = None) -> dict:
    """Return the AuthZEN answer of one evaluation: {"decision": bool}, with a context for an unknown subject, resource or match.
    A question with context.usage takes units from a true answer (take_units)."""
    with LOCK:
        answer = dict(ANSWER)
    if context is None:
        context = {}
    match = context.get("match", "node") if isinstance(context, dict) else None
    if match not in ("node", "subtree"):
        return dict(INVALID_REQUEST)
    if not permission_only_valid(context):
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
    # 5.5a, 17.1: the question of an other permission has context.permission_only. The PDP ignores `confirm` for it: a plain decision.
    permission_only = isinstance(context, dict) and context.get("permission_only") is True
    if granted and match == "node" and not permission_only:
        gated = approval_gate(subject, action, chain, context)
        if gated is not None:
            return gated
    out: dict = {"decision": granted}
    limits = ceilings_of(answer, str((action or {}).get("name", "")), chain, match == "subtree") if granted else {}
    if limits:
        out["context"] = {"limits": limits}
    if granted and usage_of(context) is not None:
        return take_units(answer, subject, action, out)
    return out


def approval_gate(subject: dict, action: dict, chain: list[str], context: dict) -> dict | None:
    """The answer of the approval gate (ProcurAuth 17.1) for a true decision, or None when the action needs no approval or an approval that
    can be used is there for a question without usage."""
    name = str((action or {}).get("name", ""))
    with LOCK:
        actions = list(APPROVAL_CONFIG["actions"])
    if "*" not in actions and name not in actions:
        return None
    effect = ((context or {}).get("approval") or {}).get("effect") if isinstance(context, dict) else None
    if effect is None:
        return {"decision": False, "context": {"reason": "approval_required"}}
    subject_id = str((subject or {}).get("id", ""))
    path = "/".join(chain)
    with LOCK:
        found = [a for a in APPROVALS if (a["subject"], a["action"], a["path"], a["effect"]) == (subject_id, name, path, effect)]
        latest = found[-1] if found else None
        status = latest["status"] if latest else "none"
        usage = isinstance(context, dict) and usage_of(context) is not None
        if status in ("none", "consumed") or (status == "void" and not usage):
            ident = f"ev-{len(EVALUATIONS) + 1}"
            EVALUATIONS[ident] = {"subject": subject_id, "action": name, "path": path, "effect": effect}
            return {"decision": False, "context": {"reason": "approval_required", "evaluation_id": ident}}
        if status == "pending":
            ident = f"ev-{len(EVALUATIONS) + 1}"
            EVALUATIONS[ident] = {"subject": subject_id, "action": name, "path": path, "effect": effect}
            return {"decision": False, "context": {"reason": "approval_pending", "evaluation_id": ident}}
        if status == "denied":
            return {"decision": False, "context": {"reason": "approval_denied"}}
        if status == "void":
            return {"decision": False, "context": {"reason": "approval_expired"}}
        if status == "approved" and usage:
            latest["status"] = "consumed"
    return None


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

    def approval_submit(self, body: dict):
        """POST /approval/v1/requests (17.4). The checks follow the portal: the members, the control, the evaluation, the effect, the size, the view."""
        if not self.approval_auth():
            return
        with LOCK:
            APPROVAL_RECEIVED["submissions"].append({"body": body, "authorization": self.headers.get("Authorization", ""), "at": time.time()})
            config = dict(APPROVAL_CONFIG)
        forced = config["submit"]
        if isinstance(forced, dict):
            payload = {"error": forced.get("error", "unavailable")}
            if forced.get("retry_after"):
                payload["retry_after"] = forced["retry_after"]
            return self.reply(int(forced["status"]), payload)
        if not isinstance(body, dict) or not set(body) <= APPROVAL_MEMBERS:
            return self.reply(422, {"error": "invalid_argument"})
        controls = [k for k in ("approval_ref", "lease_s", "until") if k in body]
        if len(controls) != 1:
            return self.reply(422, {"error": "lease_required" if not controls else "invalid_lease"})
        if len(json.dumps(body.get("op"), separators=(",", ":"))) + len(json.dumps(body.get("view"), separators=(",", ":"))) > int(config["max_command_bytes"]):
            return self.reply(413, {"error": "command_too_large"})
        with LOCK:
            facts = EVALUATIONS.get(body.get("evaluation_id"))
        if not facts or facts["effect"] != body.get("effect"):
            return self.reply(422, {"error": "invalid_evaluation"})
        if not isinstance(body.get("op"), dict):
            return self.reply(422, {"error": "invalid_op"})
        if not pointers_ok(body.get("view"), body["op"]):
            return self.reply(422, {"error": "invalid_view"})
        with LOCK:
            for a in APPROVALS:
                if a["status"] == "pending" and (a["subject"], a["action"], a["path"], a["effect"]) == (facts["subject"], facts["action"], facts["path"], facts["effect"]):
                    return self.reply(200, {"request_id": a["id"], "code": a["code"], "verdict": "pending"})
            number = len(APPROVALS) + 1
            request = {"id": f"apr_{number}", "code": f"K7Q{number}", "status": "pending", "body": body, **{k: facts[k] for k in ("subject", "action", "path", "effect")}}
            APPROVALS.append(request)
        return self.reply(201, {"request_id": request["id"], "code": request["code"], "verdict": "pending"})

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
        if self.path == "/control/approval/received":
            with LOCK:
                return self.reply(200, json.loads(json.dumps(APPROVAL_RECEIVED)))
        if self.path.startswith("/approval/v1/requests/"):
            return self.approval_read()
        return self.reply(404, {"error": "not found"})

    def approval_auth(self) -> bool:
        if self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
            self.reply(401, {"error": "unauthorized"})
            return False
        return True

    def approval_read(self, keepalive: bool = False, body: dict | None = None):
        """GET /approval/v1/requests/<id>?subject=&wait=&renew=true, and the keepalive (17.4). The answer is the verdict only."""
        if not self.approval_auth():
            return
        url = urlsplit(self.path)
        parts = url.path.split("/")
        request_id = parts[4] if len(parts) > 4 else ""
        query = parse_qs(url.query)
        subject = (body or {}).get("subject") if keepalive else (query.get("subject") or [""])[0]
        with LOCK:
            APPROVAL_RECEIVED["reads"].append(
                {"id": request_id, "keepalive": keepalive, "query": {k: v[0] for k, v in query.items()}, "subject": subject,
                 "authorization": self.headers.get("Authorization", ""), "at": time.time()})
        wait = min(int((query.get("wait") or ["0"])[0] or 0), 5)
        deadline = time.time() + wait
        while True:
            with LOCK:
                found = [a for a in APPROVALS if a["id"] == request_id and a["subject"] == subject]
                verdict = verdict_of(found[0]) if found else None
            if verdict is None:
                return self.reply(404, {"error": "not_found"})
            if verdict != "pending" or time.time() >= deadline:
                return self.reply(200, {"verdict": verdict})
            time.sleep(0.1)

    def do_POST(self):  # noqa: N802 - the name of the base class
        global ANSWER
        try:
            body = self.read_json()
        except (ValueError, json.JSONDecodeError):
            return self.reply(400, {"error": "bad body"})
        if self.path == "/control/reset":
            with LOCK:
                RECEIVED.clear()
                COUNTERS.clear()
                APPROVALS.clear()
                EVALUATIONS.clear()
                APPROVAL_RECEIVED["submissions"].clear()
                APPROVAL_RECEIVED["reads"].clear()
                APPROVAL_CONFIG.update({"actions": [], "submit": None, "max_command_bytes": 16384})
                ANSWER = dict(DEFAULT_ANSWER)
            return self.reply(200, {"ok": True})
        if self.path == "/control/approval":
            with LOCK:
                APPROVAL_CONFIG.update({"actions": [], "submit": None, "max_command_bytes": 16384})
                APPROVAL_CONFIG.update({k: v for k, v in body.items() if k in APPROVAL_CONFIG})
            return self.reply(200, {"ok": True})
        if self.path == "/control/approval/decide":
            with LOCK:
                found = [a for a in APPROVALS if a["id"] == body.get("request_id")]
                if not found:
                    return self.reply(404, {"error": "unknown request"})
                found[0]["status"] = {"approve": "approved", "decline": "denied", "cancel": "void"}[str(body.get("decision"))]
            return self.reply(200, {"ok": True})
        if self.path == "/approval/v1/requests":
            return self.approval_submit(body)
        if self.path.startswith("/approval/v1/requests/") and self.path.endswith("/keepalive"):
            return self.approval_read(True, body)
        if self.path == "/control/answer":
            with LOCK:
                COUNTERS.clear()
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
        if not usage_request_valid(self.path, body):
            # ProcurAuth 6.11: the PDP counts nothing.
            return self.reply(400, {"error": "context.usage is not valid here"}, echo)
        rules = usage_rules(answer, self.path, body)
        if rules.get("delay_ms"):
            time.sleep(int(rules["delay_ms"]) / 1000.0)
        if rules.get("drop"):
            # No answer: the connection closes. The units of this request are not taken here, but the PEP cannot know it.
            self.close_connection = True
            return
        if rules.get("status"):
            return self.reply(int(rules["status"]), {"error": "test status"}, echo)
        if self.path == "/access/v1/search/resource":
            if (answer["search"] or {}).get("status"):
                return self.reply(int(answer["search"]["status"]), {"error": "test search status"})
            return self.reply(200, search(answer, body), echo)
        if self.path == "/access/v1/evaluation":
            if not permission_only_valid(body.get("context")):
                # 5.5a: a bad context.permission_only is HTTP 400 for one evaluation (invalid_request in an item of a batch).
                return self.reply(400, {"error": "context.permission_only is not valid here"}, echo)
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


def verdict_of(approval: dict) -> str:
    """The verdict of a request (17.6): pending, approved, denied or void."""
    return {"pending": "pending", "approved": "approved", "consumed": "approved", "denied": "denied", "void": "void"}[approval["status"]]


def pointers_ok(view: dict, op: dict) -> bool:
    """17.9: each pointer of the view names a value of op; the view has no other member."""
    if not isinstance(view, dict) or not set(view) <= {"title", "fields", "body", "body_label"}:
        return False
    pointers = [view["body"]] if "body" in view else []
    for pair in view.get("fields") or []:
        if not (isinstance(pair, list) and len(pair) == 2 and all(isinstance(x, str) for x in pair)):
            return False
        pointers.append(pair[1])
    for pointer in pointers:
        node = op
        for part in [x.replace("~1", "/").replace("~0", "~") for x in pointer.split("/")[1:]]:
            if not isinstance(node, dict) or part not in node:
                return False
            node = node[part]
    return True


def usage_request_valid(path: str, body: dict) -> bool:
    """ProcurAuth 6.11: context.usage only in a request with one evaluation, never with the match "subtree", units 1."""
    contexts = [body.get("context")] + [item.get("context") for item in (body.get("evaluations") or []) if isinstance(item, dict)]
    usages = [usage_of(c) for c in contexts if isinstance(c, dict) and "usage" in c]
    if not usages:
        return True
    if path == "/access/v1/search/resource" or body.get("evaluations"):
        return False
    context = body.get("context") or {}
    if context.get("match", "node") != "node":
        return False
    usage = usage_of(context)
    return usage is not None and usage.get("units") == 1 and len(usage) == 1


def usage_rules(answer: dict, path: str, body: dict) -> dict:
    """The rules of /control/answer "usage" for the action of a request with context.usage (delay, drop, status), else {}."""
    if path != "/access/v1/evaluation" or usage_of(body.get("context")) is None:
        return {}
    rules = (answer["usage"] or {}).get(str((body.get("action") or {}).get("name", "")))
    return rules if isinstance(rules, dict) else {}


def search(answer: dict, body: dict) -> dict:
    """The page of a Resource Search: the ids of the page named by page.token ("p<N>"), as results of the type of the request."""
    config = answer["search"] or {}
    action = str((body.get("action") or {}).get("name", ""))
    pages = (config.get("by_action") or {}).get(action) or config.get("pages") or [[]]
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
