"""A fake OTLP/HTTP receiver for the tests of the server export (docs/server-telemetry.md).

It takes POST /v1/traces and POST /v1/logs with an OTLP JSON body and keeps each body in memory (at most MAX_BODIES; the oldest go
first). The tests read what it took:

    GET  /received          {"traces": [<body>, ...], "logs": [<body>, ...]}
    POST /reset             forgets every body
    POST /answer            {"status": 503, "count": 2}: the next `count` export requests get `status` (then 200 again)
    GET  /healthz           200

It uses the standard library only. The port is OTLP_RECEIVER_PORT (default 4318).
"""

import json
import os
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODIES = 2000
MAX_BODY_BYTES = 16 * 1024 * 1024

LOCK = threading.Lock()
TRACES: deque = deque(maxlen=MAX_BODIES)
LOGS: deque = deque(maxlen=MAX_BODIES)
ANSWERS: list = []


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

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            raise ValueError("body too large")
        return self.rfile.read(length)

    def do_GET(self):  # noqa: N802 - the name of the base class
        if self.path == "/healthz":
            self.reply(200, {"ok": True})
        elif self.path == "/received":
            with LOCK:
                self.reply(200, {"traces": list(TRACES), "logs": list(LOGS)})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802 - the name of the base class
        try:
            raw = self.read_body()
        except ValueError:
            self.reply(413, {"error": "too large"})
            return
        if self.path == "/reset":
            with LOCK:
                TRACES.clear()
                LOGS.clear()
                ANSWERS.clear()
            self.reply(200, {"ok": True})
            return
        if self.path == "/answer":
            order = json.loads(raw or b"{}")
            with LOCK:
                ANSWERS.clear()
                ANSWERS.extend([int(order.get("status", 200))] * int(order.get("count", 1)))
            self.reply(200, {"ok": True})
            return
        if self.path not in ("/v1/traces", "/v1/logs"):
            self.reply(404, {"error": "not found"})
            return
        if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
            self.reply(415, {"error": "the receiver takes OTLP JSON only"})
            return
        with LOCK:
            status = ANSWERS.pop(0) if ANSWERS else 200
        if status != 200:
            self.reply(status, {"error": "an answer that the test asked for"})
            return
        try:
            body = json.loads(raw)
        except ValueError:
            self.reply(400, {"error": "not JSON"})
            return
        with LOCK:
            (TRACES if self.path == "/v1/traces" else LOGS).append(body)
        self.reply(200, {})


def main() -> None:
    port = int(os.environ.get("OTLP_RECEIVER_PORT", "4318"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    print(f"otlp_receiver: listening on {port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
