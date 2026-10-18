"""A fake AuthZEN PDP for the tests of the access of humans (docs/access.md, contract 11.5).

It answers POST /access/v1/evaluation and POST /access/v1/evaluations, and keeps each request that it receives (the path,
the headers that matter and the body). The tests set its answers and read what it received:

    GET  /control/received   {"requests": [{"path", "authorization", "request_id", "traceparent", "body"}, ...]}
    POST /control/reset      forgets the requests and sets the default answers again
    POST /control/answer     {"default": true, "deny": ["query.export", ...], "allow": [...], "deny_subjects": ["leaver"],
                              "subjects": {"querier": ["query.run.read", ...]}, "status": 500, "delay_ms": 2000}
                             deny and allow are lists of action names, or of "action@type:id" for one resource. deny_subjects
                             lists the subjects that the PDP does not know: false for every action. subjects gives the whole
                             grant of a subject: true for the actions of its list only. status and delay_ms apply to every
                             evaluation request until the next /control/answer or /control/reset.
    GET  /healthz            200

A request with a wrong token (Authorization: Bearer <FAKE_PDP_TOKEN>) gets 401. It uses the standard library only. The port is
FAKE_PDP_PORT (default 8181).
"""

import json
import os
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_REQUESTS = 2000
MAX_BODY_BYTES = 1024 * 1024
TOKEN = os.environ.get("FAKE_PDP_TOKEN", "pdp-test-token")

LOCK = threading.Lock()
RECEIVED: deque = deque(maxlen=MAX_REQUESTS)
DEFAULT_ANSWER = {"default": True, "deny": [], "allow": [], "deny_subjects": [], "subjects": {}, "status": 200, "delay_ms": 0}
ANSWER = dict(DEFAULT_ANSWER)


def decide(subject: dict, action: dict, resource: dict) -> bool:
    name = str((action or {}).get("name", ""))
    target = f"{name}@{(resource or {}).get('type', '')}:{(resource or {}).get('id', '')}"
    with LOCK:
        answer = dict(ANSWER)
    subject_id = str((subject or {}).get("id", ""))
    if subject_id in answer["deny_subjects"]:
        return False
    grant = (answer["subjects"] or {}).get(subject_id)
    if isinstance(grant, list):
        return target in grant or name in grant
    if target in answer["deny"] or name in answer["deny"]:
        return False
    if target in answer["allow"] or name in answer["allow"]:
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
            return self.reply(200, {"decision": decide(body.get("subject"), body.get("action"), body.get("resource"))})
        out = []
        for item in body.get("evaluations") or []:
            subject = item.get("subject") or body.get("subject")
            action = item.get("action") or body.get("action")
            resource = item.get("resource") or body.get("resource")
            out.append({"decision": decide(subject, action, resource)})
        return self.reply(200, {"evaluations": out})


def main() -> None:
    port = int(os.environ.get("FAKE_PDP_PORT", "8181"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
