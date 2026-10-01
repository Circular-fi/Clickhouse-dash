#!/usr/bin/env python3
"""Rich OpenTelemetry fixture: a deterministic e-commerce workload on one day.

The bulk fixture (seed.py) holds billions of flat, attribute-poor spans. This
module adds a small dataset whose shapes exercise the Trace Explorer on real
rows: nested traces through an API gateway, a frontend and seven backend
services, HTTP client/server pairs, gRPC, PostgreSQL / Redis / ClickHouse
calls, Kafka producer/consumer spans with cross-trace links, errors deep in
branches with exception events (Java, Python, Go, JavaScript and .NET stack
traces), retries and cache misses, orphan spans, very large traces, resource
attributes (versions switching at known release times, hosts, pods), a slow
cohort that only a span attribute explains, plus correlated logs and metrics.

Every row lies in RICH_DAY (2026-09-12 UTC), a day the bulk fixture never
uses, so the rich data never mixes with the rest. The module only ever writes
inside that window: it inserts, and with OTEL_FIXTURE_RICH_FORCE=1 it first
deletes the window's rows (refused when the window holds rows of services
other than the rich ones). Generation is seeded: the same seed and trace count
always produce the same TraceIds, SpanIds, timestamps and attributes.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone

NS = 1_000_000_000
MS = 1_000_000
US = 1_000
MINUTE = 60 * NS
HOUR = 60 * MINUTE

RICH_DAY = "2026-09-12"
RICH_PARTITION = "20260912"
WINDOW_START_S = int(datetime(2026, 9, 12, tzinfo=timezone.utc).timestamp())
WINDOW_START_NS = WINDOW_START_S * NS
WINDOW_END_NS = WINDOW_START_NS + 24 * HOUR
TRAFFIC_START_NS = WINDOW_START_NS + 5 * MINUTE
TRAFFIC_END_NS = WINDOW_START_NS + 23 * HOUR
MARKER = "chdash-rich-fixture"
MARKER_VERSION = "v2"
SCHEMA_URL = "https://opentelemetry.io/schemas/1.26.0"


def at(hours: int, minutes: int = 0) -> int:
    """Absolute ns of HH:MM on the rich day."""
    return WINDOW_START_NS + hours * HOUR + minutes * MINUTE


# The slow cohort: checkouts evaluated with feature.flag=new_pricing while
# payments 2.4.0 runs (14:00-16:00) spend 2-7 s in payments' fees.compute.
INCIDENT = (at(14), at(16))
# Around the incident no other trace takes 1.5 s or more (no timeouts, no
# slow queries, no batch jobs), so a heatmap box over the slow band holds the
# cohort only.
QUIET = (at(13, 30), at(16, 30))
SLOW_THRESHOLD_MS = 1500

# service -> (telemetry.sdk.language, k8s namespace, pods per version,
#             [(service.version, first active ns)])
SERVICES: dict[str, tuple[str, str, int, list[tuple[str, int]]]] = {
    "api-gateway": ("cpp", "edge", 2, [("1.31.2", 0), ("1.32.0", at(4))]),
    "frontend": ("nodejs", "shop", 3, [("3.8.0", 0), ("3.9.0", at(8))]),
    "checkout": ("java", "shop", 3, [("1.14.2", 0), ("1.15.0", at(10))]),
    "payments": ("go", "shop", 2, [("2.3.1", 0), ("2.4.0", at(14)), ("2.4.1", at(16))]),
    "inventory": ("python", "shop", 2, [("0.9.4", 0), ("0.10.0", at(12))]),
    "auth": ("go", "shop", 2, [("5.2.0", 0), ("5.2.1", at(6))]),
    "search": ("python", "shop", 2, [("4.0.3", 0), ("4.1.0", at(19))]),
    "recommendation": ("python", "shop", 2, [("0.21.0", 0), ("0.22.0", at(11))]),
    "notification": ("dotnet", "shop", 2, [("2.7.5", 0), ("2.8.0", at(17))]),
}
SERVICE_NAMES = tuple(SERVICES)
NODES = (
    "gke-shop-prod-pool-a-5c1e-k2lm",
    "gke-shop-prod-pool-a-5c1e-q7rt",
    "gke-shop-prod-pool-a-5c1e-x9wz",
    "gke-shop-prod-pool-b-81d4-b3cd",
    "gke-shop-prod-pool-b-81d4-h6jn",
    "gke-shop-prod-pool-b-81d4-p4vs",
)
SDK_VERSIONS = {"cpp": "1.16.1", "nodejs": "1.26.0", "java": "1.42.1", "go": "1.31.0", "python": "1.27.0", "dotnet": "1.9.0"}
RUNTIMES = {
    "cpp": ("envoy", "1.31.2"), "nodejs": ("nodejs", "20.17.0"), "java": ("OpenJDK Runtime Environment", "21.0.4+7-LTS"),
    "go": ("go", "go1.23.1"), "python": ("cpython", "3.12.6"), "dotnet": (".NET", "8.0.8"),
}
SCOPES = {
    "cpp": {"*": ("envoy.tracers.opentelemetry", "1.31.2")},
    "nodejs": {"http_server": ("@opentelemetry/instrumentation-http", "0.53.0"),
               "http_client": ("@opentelemetry/instrumentation-undici", "0.6.0"),
               "grpc": ("@opentelemetry/instrumentation-grpc", "0.53.0"),
               "redis": ("@opentelemetry/instrumentation-ioredis", "0.43.0")},
    "java": {"http_server": ("io.opentelemetry.tomcat-10.0", "2.8.0-alpha"),
             "http_client": ("io.opentelemetry.java-http-client", "2.8.0-alpha"),
             "grpc": ("io.opentelemetry.grpc-1.6", "2.8.0-alpha"),
             "postgresql": ("io.opentelemetry.jdbc", "2.8.0-alpha"),
             "redis": ("io.opentelemetry.lettuce-5.1", "2.8.0-alpha"),
             "kafka": ("io.opentelemetry.kafka-clients-2.6", "2.8.0-alpha")},
    "go": {"http_server": ("go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp", "0.55.0"),
           "http_client": ("go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp", "0.55.0"),
           "grpc": ("go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc", "0.55.0"),
           "postgresql": ("github.com/exaring/otelpgx", "0.6.2"),
           "redis": ("github.com/redis/go-redis/extra/redisotel", "9.6.1")},
    "python": {"grpc": ("opentelemetry.instrumentation.grpc", "0.48b0"),
               "postgresql": ("opentelemetry.instrumentation.psycopg", "0.48b0"),
               "redis": ("opentelemetry.instrumentation.redis", "0.48b0"),
               "clickhouse": ("opentelemetry.instrumentation.dbapi", "0.48b0")},
    "dotnet": {"kafka": ("Confluent.Kafka.Extensions.OpenTelemetry", "0.4.0"),
               "http_client": ("System.Net.Http", "8.0.0")},
}
LOGGERS = {
    "api-gateway": "envoy.access_log", "frontend": "frontend:server", "checkout": "com.shop.checkout.service.CheckoutService",
    "payments": "github.com/shop/payments/internal/api", "inventory": "inventory.handlers.stock", "auth": "github.com/shop/auth/internal/session",
    "search": "search.service", "recommendation": "recommendation.model", "notification": "Shop.Notification.Consumers.OrderConsumer",
}

# Large batch jobs (search catalog.reindex): start time and span count. The
# last one exceeds traces.max_spans_per_trace (10,000) of the test config.
LARGE_JOBS = ((at(3), 2000), (at(6, 30), 4000), (at(9, 15), 8000), (at(18), 10000), (at(21), 12000))
CONSUMER_BATCH_NS = 2 * MINUTE
INDEX_BATCH_NS = 5 * NS  # spans ending in the same 5 s export batch share an index row

# (weight, flow)
FLOWS = (
    (6, "health"), (14, "home"), (20, "search"), (18, "product"), (10, "cart"), (10, "login"), (22, "checkout"),
)
OUTCOMES = {
    "health": ((100, "ok"),),
    "home": ((96, "ok"), (4, "rec_deadline")),
    "search": ((94, "ok"), (3, "ch_memory"), (3, "slow_query")),
    "product": ((93, "ok"), (3, "stock_keyerror"), (4, "redis_retry")),
    "cart": ((92, "ok"), (3, "js_typeerror"), (5, "out_of_stock")),
    "login": ((86, "ok"), (14, "bad_password")),
    "checkout": ((80, "ok"), (4, "declined"), (3, "psp_timeout"), (3, "npe"), (4, "out_of_stock"),
                 (3, "smtp_fail"), (3, "inventory_retry")),
}
ROUTES = {
    "health": ("GET", "/healthz"), "home": ("GET", "/api/v1/home"), "search": ("GET", "/api/v1/search"),
    "product": ("GET", "/api/v1/products/{id}"), "cart": ("POST", "/api/v1/cart/items"),
    "login": ("POST", "/api/v1/login"), "checkout": ("POST", "/api/v1/checkout"),
}
USER_AGENTS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    "shop-android/5.12.0 (Pixel 8; Android 14)",
)


def det_hex(*parts, nbytes: int = 8) -> str:
    """Deterministic lowercase hex id from the given parts."""
    digest = hashlib.blake2b(":".join(str(p) for p in parts).encode(), digest_size=nbytes).hexdigest()
    return digest if int(digest, 16) else "1".rjust(nbytes * 2, "0")


def dt64(ns: int) -> str:
    seconds, nanos = divmod(ns, NS)
    day_seconds = seconds - WINDOW_START_S
    if 0 <= day_seconds < 86400:
        hh, rest = divmod(day_seconds, 3600)
        mm, ss = divmod(rest, 60)
        return f"{RICH_DAY} {hh:02d}:{mm:02d}:{ss:02d}.{nanos:09d}"
    base = datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return f"{base}.{nanos:09d}"


def version_index(service: str, ns: int) -> int:
    versions = SERVICES[service][3]
    idx = 0
    for i, (_, since) in enumerate(versions):
        if ns >= since:
            idx = i
    return idx


K8S_ALPHABET = "bcdfghjklmnpqrstvwxz2456789"


def k8s_suffix(seed_text: str, length: int) -> str:
    digest = hashlib.blake2b(seed_text.encode(), digest_size=16).digest()
    return "".join(K8S_ALPHABET[b % len(K8S_ALPHABET)] for b in digest[:length])


def pods() -> list[dict]:
    """Every pod of the day: one ReplicaSet per service version."""
    out = []
    for service, (lang, namespace, count, versions) in SERVICES.items():
        for vi, (version, since) in enumerate(versions):
            until = versions[vi + 1][1] if vi + 1 < len(versions) else WINDOW_END_NS
            rs = k8s_suffix(f"{service}/{version}", 10)
            for p in range(count):
                name = f"{service}-{rs}-{k8s_suffix(f'{service}/{version}/{p}', 5)}"
                node = NODES[int(hashlib.blake2b(name.encode(), digest_size=4).hexdigest(), 16) % len(NODES)]
                runtime = RUNTIMES[lang]
                resource = {
                    "service.name": service,
                    "service.namespace": "shop",
                    "service.version": version,
                    "service.instance.id": det_hex("instance", name, nbytes=16),
                    "deployment.environment.name": "production",
                    "host.name": node,
                    "k8s.node.name": node,
                    "k8s.namespace.name": namespace,
                    "k8s.deployment.name": service,
                    "k8s.pod.name": name,
                    "cloud.region": "europe-west1",
                    "telemetry.sdk.name": "opentelemetry",
                    "telemetry.sdk.language": lang,
                    "telemetry.sdk.version": SDK_VERSIONS[lang],
                    "process.runtime.name": runtime[0],
                    "process.runtime.version": runtime[1],
                }
                out.append({"service": service, "version_index": vi, "version": version, "pod": name, "node": node,
                            "since": max(since, WINDOW_START_NS), "until": until, "resource": resource})
    return out


POD_TABLE: dict[tuple[str, int], list[dict]] = {}
for _pod in pods():
    POD_TABLE.setdefault((_pod["service"], _pod["version_index"]), []).append(_pod)


# ---------------------------------------------------------------- exceptions

def java_npe() -> tuple[str, str, str]:
    message = 'Cannot invoke "com.shop.checkout.model.Address.getCountry()" because "shipping" is null'
    stack = (
        f"java.lang.NullPointerException: {message}\n"
        "\tat com.shop.checkout.pricing.TaxCalculator.compute(TaxCalculator.java:87)\n"
        "\tat com.shop.checkout.service.CheckoutService.placeOrder(CheckoutService.java:214)\n"
        "\tat com.shop.checkout.api.CheckoutController.checkout(CheckoutController.java:61)\n"
        "\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)\n"
        "\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:883)\n"
        "\tat org.apache.catalina.core.ApplicationFilterChain.doFilter(ApplicationFilterChain.java:166)\n"
        "\tat java.base/java.lang.Thread.run(Thread.java:1583)"
    )
    return "java.lang.NullPointerException", message, stack


def java_gateway_timeout() -> tuple[str, str, str]:
    message = '504 Gateway Timeout: "{"error":"psp_timeout"}"'
    kind = "org.springframework.web.client.HttpServerErrorException$GatewayTimeout"
    stack = (
        f"{kind}: {message}\n"
        "\tat org.springframework.web.client.HttpServerErrorException.create(HttpServerErrorException.java:112)\n"
        "\tat org.springframework.web.client.DefaultResponseErrorHandler.handleError(DefaultResponseErrorHandler.java:183)\n"
        "\tat com.shop.checkout.clients.PaymentsClient.charge(PaymentsClient.java:58)\n"
        "\tat com.shop.checkout.service.CheckoutService.placeOrder(CheckoutService.java:231)\n"
        "\tat com.shop.checkout.api.CheckoutController.checkout(CheckoutController.java:61)\n"
        "\tat java.base/java.lang.Thread.run(Thread.java:1583)"
    )
    return kind, message, stack


def go_deadline() -> tuple[str, str, str]:
    message = 'Post "https://api.psp.example/v1/charges": context deadline exceeded'
    stack = (
        "goroutine 1187 [running]:\n"
        "github.com/shop/payments/internal/psp.(*Client).Charge(0xc0001a2000, {0x1b3c4e0, 0xc000412180}, 0xc0003f8000)\n"
        "\t/src/internal/psp/client.go:142 +0x3c5\n"
        "github.com/shop/payments/internal/api.(*Handler).Charge(0xc00011e0f0, {0x1b37a20, 0xc0004a01c0}, 0xc000498000)\n"
        "\t/src/internal/api/charge.go:77 +0x1f4\n"
        "net/http.HandlerFunc.ServeHTTP(0xc000132340, {0x1b37a20, 0xc0004a01c0}, 0xc000498000)\n"
        "\t/usr/local/go/src/net/http/server.go:2171 +0x29\n"
        "net/http.(*conn).serve(0xc0001f6000, {0x1b3c4e0, 0xc0001e8f00})\n"
        "\t/usr/local/go/src/net/http/server.go:2092 +0x5d0"
    )
    return "*url.Error", message, stack


def python_keyerror(sku: str) -> tuple[str, str, str]:
    stack = (
        "Traceback (most recent call last):\n"
        '  File "/app/inventory/handlers/stock.py", line 58, in get_stock\n'
        "    level = self._levels[sku]\n"
        '  File "/usr/local/lib/python3.12/site-packages/cachetools/__init__.py", line 68, in __getitem__\n'
        "    return self.__missing__(key)\n"
        '  File "/usr/local/lib/python3.12/site-packages/cachetools/__init__.py", line 97, in __missing__\n'
        "    raise KeyError(key)\n"
        f"KeyError: '{sku}'"
    )
    return "KeyError", f"'{sku}'", stack


def python_redis_timeout() -> tuple[str, str, str]:
    message = "Timeout reading from redis-stock.shop.svc.cluster.local:6379"
    stack = (
        "Traceback (most recent call last):\n"
        '  File "/usr/local/lib/python3.12/site-packages/redis/connection.py", line 520, in read_response\n'
        "    response = self._parser.read_response(disable_decoding=disable_decoding)\n"
        '  File "/usr/local/lib/python3.12/site-packages/redis/_parsers/resp2.py", line 15, in read_response\n'
        "    result = self._read_response(disable_decoding=disable_decoding)\n"
        '  File "/app/inventory/cache.py", line 31, in get_level\n'
        "    return self._client.get(f\"stock:{sku}\")\n"
        f"redis.exceptions.TimeoutError: {message}"
    )
    return "redis.exceptions.TimeoutError", message, stack


def python_clickhouse_memory() -> tuple[str, str, str]:
    message = ("Code: 241. DB::Exception: Memory limit (for query) exceeded: would use 9.31 GiB "
               "(attempt to allocate chunk of 4194304 bytes), maximum: 9.31 GiB. (MEMORY_LIMIT_EXCEEDED)")
    stack = (
        "Traceback (most recent call last):\n"
        '  File "/app/search/service.py", line 112, in search\n'
        "    rows = self._ch.query(SEARCH_SQL, parameters=params).result_rows\n"
        '  File "/usr/local/lib/python3.12/site-packages/clickhouse_connect/driver/client.py", line 224, in query\n'
        "    return self._query_with_context(query_context)\n"
        '  File "/usr/local/lib/python3.12/site-packages/clickhouse_connect/driver/httpclient.py", line 230, in _query_with_context\n'
        "    response = self._raw_request(body, params, headers, stream=True)\n"
        f"clickhouse_connect.driver.exceptions.DatabaseError: {message}"
    )
    return "clickhouse_connect.driver.exceptions.DatabaseError", message, stack


def js_typeerror() -> tuple[str, str, str]:
    message = "Cannot read properties of undefined (reading 'quantity')"
    stack = (
        f"TypeError: {message}\n"
        "    at CartService.addItem (/app/src/services/cart.js:47:31)\n"
        "    at async /app/src/routes/cart.js:22:5\n"
        "    at async Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)\n"
        "    at async next (/app/node_modules/express/lib/router/route.js:149:13)"
    )
    return "TypeError", message, stack


def js_grpc_error(code: int, name: str, detail: str) -> tuple[str, str, str]:
    message = f"{code} {name}: {detail}"
    stack = (
        f"Error: {message}\n"
        "    at callErrorFromStatus (/app/node_modules/@grpc/grpc-js/build/src/call.js:31:19)\n"
        "    at Object.onReceiveStatus (/app/node_modules/@grpc/grpc-js/build/src/client.js:193:76)\n"
        "    at /app/node_modules/@grpc/grpc-js/build/src/call-interface.js:78:35\n"
        "    at SearchClient.search (/app/src/clients/search.js:28:12)\n"
        "    at async /app/src/routes/search.js:17:20"
    )
    return "Error", message, stack


def dotnet_smtp() -> tuple[str, str, str]:
    message = "Failure sending mail."
    stack = (
        f"System.Net.Mail.SmtpException: {message}\n"
        " ---> System.IO.IOException: Unable to read data from the transport connection: Connection reset by peer.\n"
        "   at System.Net.Sockets.NetworkStream.Read(Span`1 buffer)\n"
        "   --- End of inner exception stack trace ---\n"
        "   at System.Net.Mail.SmtpClient.Send(MailMessage message)\n"
        "   at Shop.Notification.Senders.SmtpSender.SendAsync(OrderPlaced message, CancellationToken ct) in /src/Shop.Notification/Senders/SmtpSender.cs:line 64\n"
        "   at Shop.Notification.Consumers.OrderConsumer.ProcessAsync(ConsumeContext`1 context) in /src/Shop.Notification/Consumers/OrderConsumer.cs:line 38"
    )
    return "System.Net.Mail.SmtpException", message, stack


# --------------------------------------------------------------------- plan

class Plan:
    __slots__ = ("no", "flow", "outcome", "start", "flag", "drop", "links", "spans")

    def __init__(self, no: int, flow: str, outcome: str, start: int, flag: str = "", drop: str = "", spans: int = 0):
        self.no, self.flow, self.outcome, self.start = no, flow, outcome, start
        self.flag, self.drop, self.links, self.spans = flag, drop, [], spans


def trace_id_of(seed: int, no: int) -> str:
    return det_hex(seed, "trace", no, nbytes=16)


def producer_span_of(seed: int, no: int) -> str:
    return det_hex(seed, "publish", no)


def publishes(plan: Plan) -> bool:
    return plan.flow == "checkout" and plan.outcome in ("ok", "smtp_fail", "inventory_retry")


def pick(rng: random.Random, weighted) -> str:
    total = sum(w for w, _ in weighted)
    roll = rng.random() * total
    for weight, value in weighted:
        roll -= weight
        if roll < 0:
            return value
    return weighted[-1][1]


def build_plans(seed: int, request_traces: int) -> list[Plan]:
    """Every trace of the day, in start order; consumer batches carry links."""
    rng = random.Random(f"{seed}:plan")
    plans: list[Plan] = []
    span_ns = TRAFFIC_END_NS - TRAFFIC_START_NS
    for i in range(request_traces):
        start = TRAFFIC_START_NS + int((i + rng.random()) * span_ns / request_traces)
        flow = pick(rng, FLOWS)
        outcome = pick(rng, OUTCOMES[flow])
        quiet = QUIET[0] <= start < QUIET[1]
        if quiet and outcome in ("slow_query", "psp_timeout"):
            outcome = "ok"
        flag = ""
        if flow == "checkout" and start >= INCIDENT[0]:
            flag = "new_pricing" if rng.random() < 0.5 else "control"
        roll = rng.random()
        drop = "mid" if roll < 0.015 and flow != "health" else ("root" if roll < 0.02 and flow != "health" else "")
        plans.append(Plan(i, flow, outcome, start, flag, drop))
    no = request_traces
    for start, spans in LARGE_JOBS:
        plans.append(Plan(no, "reindex", "ok", start, spans=spans))
        no += 1
    # Inventory consumes the orders topic in batches every 2 minutes: the batch
    # root links to every producer span of the previous 2 minutes.
    producers = [p for p in plans if publishes(p)]
    cursor = 0
    t = TRAFFIC_START_NS + CONSUMER_BATCH_NS
    while t < TRAFFIC_END_NS + CONSUMER_BATCH_NS:
        batch = []
        while cursor < len(producers) and producers[cursor].start < t - 10 * NS:
            batch.append(producers[cursor].no)
            cursor += 1
        if batch:
            consumer = Plan(no, "consumer", "ok", t + int(rng.random() * 400 * MS))
            consumer.links = batch
            plans.append(consumer)
            no += 1
        t += CONSUMER_BATCH_NS
    plans.sort(key=lambda p: (p.start, p.no))
    return plans


# ------------------------------------------------------------------- builder

class Span:
    __slots__ = ("span_id", "parent", "service", "pod", "name", "kind", "start", "end", "status", "message",
                 "attrs", "events", "links", "scope")

    def to_row(self, trace_id: str) -> dict:
        return {
            "Timestamp": dt64(self.start),
            "TraceId": trace_id,
            "SpanId": self.span_id,
            "ParentSpanId": self.parent,
            "TraceState": "",
            "SpanName": self.name,
            "SpanKind": self.kind,
            "ServiceName": self.service,
            "ResourceAttributes": self.pod["resource"],
            "ScopeName": self.scope[0],
            "ScopeVersion": self.scope[1],
            "SpanAttributes": self.attrs,
            "Duration": max(1, self.end - self.start),
            "StatusCode": self.status,
            "StatusMessage": self.message,
            "Events.Timestamp": [dt64(e[0]) for e in self.events],
            "Events.Name": [e[1] for e in self.events],
            "Events.Attributes": [e[2] for e in self.events],
            "Links.TraceId": [l[0] for l in self.links],
            "Links.SpanId": [l[1] for l in self.links],
            "Links.TraceState": ["" for _ in self.links],
            "Links.Attributes": [l[2] for l in self.links],
        }


SEVERITY = {"DEBUG": 5, "INFO": 9, "WARN": 13, "ERROR": 17}


class Trace:
    """One trace: spans built top-down, each call returning its end time."""

    def __init__(self, seed: int, plan: Plan):
        self.seed = seed
        self.plan = plan
        self.rng = random.Random(f"{seed}:trace:{plan.no}")
        self.trace_id = trace_id_of(seed, plan.no)
        self.spans: list[Span] = []
        self.logs: list[dict] = []
        self.pod_choice: dict[str, dict] = {}
        self.user = f"u-{self.rng.randrange(10_000, 99_999)}"
        self.sku = f"SKU-{self.rng.randrange(10_000, 99_999)}"

    # -- primitives
    def pod(self, service: str, ns: int) -> dict:
        key = f"{service}:{version_index(service, ns)}"
        if key not in self.pod_choice:
            self.pod_choice[key] = self.rng.choice(POD_TABLE[(service, version_index(service, ns))])
        return self.pod_choice[key]

    def new_id(self) -> str:
        return f"{self.rng.getrandbits(64) | 1:016x}"

    def span(self, parent: Span | None, service: str, name: str, kind: str, start: int, attrs: dict,
             category: str = "manual", span_id: str = "") -> Span:
        s = Span()
        s.span_id = span_id or self.new_id()
        s.parent = parent.span_id if parent else ""
        s.service = service
        s.pod = self.pod(service, start)
        s.name, s.kind, s.start, s.end = name, kind, start, start + 1
        s.status, s.message = "Unset", ""
        s.attrs, s.events, s.links = attrs, [], []
        lang = SERVICES[service][0]
        scopes = SCOPES.get(lang, {})
        s.scope = scopes.get(category) or scopes.get("*") or (f"shop.{service}", SERVICES[service][3][version_index(service, start)][0])
        self.spans.append(s)
        return s

    def error(self, s: Span, message: str, exc: tuple[str, str, str] | None = None, escaped: bool = True,
              as_attributes: bool = False, at_ns: int | None = None) -> None:
        s.status, s.message = "Error", message
        if exc is None:
            return
        when = at_ns if at_ns is not None else max(s.start, s.end - self.rng.randint(1, 50) * US)
        attrs = {"exception.type": exc[0], "exception.message": exc[1], "exception.stacktrace": exc[2],
                 "exception.escaped": "true" if escaped else "false"}
        s.events.append((when, "exception", attrs))
        s.attrs.setdefault("error.type", exc[0])
        if as_attributes:
            s.attrs.update({k: v for k, v in attrs.items() if k != "exception.escaped"})
        self.log(s, when, "ERROR", f"{exc[0]}: {exc[1]}",
                 {"exception.type": exc[0], "exception.message": exc[1], "exception.stacktrace": exc[2]})

    def event(self, s: Span, ns: int, name: str, attrs: dict) -> None:
        s.events.append((ns, name, attrs))

    def log(self, s: Span | None, ns: int, severity: str, body: str, attrs: dict | None = None,
            service: str = "", traced: bool = True) -> None:
        service = s.service if s else service
        pod = s.pod if s else self.pod(service, ns)
        log_attrs = {"code.function": LOGGERS[service].rsplit(".", 1)[-1], "thread.name": f"worker-{self.rng.randrange(1, 17)}"}
        if attrs:
            log_attrs.update(attrs)
        self.logs.append({
            "Timestamp": dt64(ns),
            "TraceId": self.trace_id if (s and traced) else "",
            "SpanId": s.span_id if (s and traced) else "",
            "TraceFlags": 1 if (s and traced) else 0,
            "SeverityText": severity,
            "SeverityNumber": SEVERITY[severity],
            "ServiceName": service,
            "Body": body,
            "ResourceSchemaUrl": SCHEMA_URL,
            "ResourceAttributes": pod["resource"],
            "ScopeSchemaUrl": "",
            "ScopeName": LOGGERS[service],
            "ScopeVersion": "",
            "ScopeAttributes": {},
            "LogAttributes": log_attrs,
        })

    def net(self) -> int:
        return self.rng.randint(150, 1500) * US

    # -- protocol helpers
    def http(self, parent: Span, caller: str, callee: str | None, method: str, route: str, t: int, handler,
             external_url: str = "", port: int = 8080) -> tuple[int, int]:
        """HTTP client span in caller (+ server span in callee unless external)."""
        if callee:
            url = f"http://{callee}.shop.svc.cluster.local:{port}{route.replace('{id}', self.sku)}"
            address = f"{callee}.shop.svc.cluster.local"
        else:
            url, address = external_url, urllib.parse.urlparse(external_url).hostname or ""
        client = self.span(parent, caller, f"{method} {route}" if callee else method, "Client", t, {
            "http.request.method": method, "url.full": url, "server.address": address,
            "server.port": str(port if callee else 443), "network.protocol.version": "1.1",
        }, "http_client")
        if callee:
            server = self.span(client, callee, f"{method} {route}", "Server", t + self.net(), {
                "http.request.method": method, "http.route": route, "url.path": route.replace("{id}", self.sku),
                "url.scheme": "http", "server.address": address, "server.port": str(port),
                "network.protocol.version": "1.1", "client.address": f"10.8.{self.rng.randrange(0, 16)}.{self.rng.randrange(2, 250)}",
            }, "http_server")
            end, code = handler(server, server.start + self.rng.randint(20, 300) * US)
            server.end = end + self.rng.randint(20, 200) * US
            server.attrs["http.response.status_code"] = str(code)
            self.log(server, server.start + 5 * US, "DEBUG", f"{method} {server.attrs['url.path']} received",
                     {"http.request.method": method, "http.route": route})
            if self.rng.random() < 0.6:
                self.log(server, server.end - 5 * US, "INFO" if code < 400 else "WARN",
                         f"{method} {route} completed {code} in {(server.end - server.start) // MS} ms",
                         {"http.request.method": method, "http.route": route, "http.response.status_code": str(code)})
            if code >= 500 and server.status != "Error":
                self.error(server, f"HTTP {code}")
            client.end = server.end + self.net()
        else:
            end, code = handler(client, t)
            client.end = end
        client.attrs["http.response.status_code"] = str(code)
        if code >= 400 and client.status != "Error":
            client.status, client.message = "Error", f"HTTP {code}"
            client.attrs["error.type"] = str(code)
        return client.end, code

    def grpc(self, parent: Span, caller: str, callee: str, service_path: str, method: str, t: int, handler,
             deadline_ns: int = 0) -> tuple[int, int]:
        """gRPC client span in caller and server span in callee."""
        address = f"{callee}.shop.svc.cluster.local"
        rpc = {"rpc.system": "grpc", "rpc.service": service_path, "rpc.method": method,
               "server.address": address, "server.port": "50051"}
        client = self.span(parent, caller, f"{service_path}/{method}", "Client", t, dict(rpc), "grpc")
        server = self.span(client, callee, f"{service_path}/{method}", "Server", t + self.net(), dict(rpc), "grpc")
        end, code = handler(server, server.start + self.rng.randint(20, 200) * US)
        server.end = end + self.rng.randint(10, 100) * US
        server.attrs["rpc.grpc.status_code"] = str(code)
        if self.rng.random() < 0.5:
            self.log(server, server.end - 5 * US, "DEBUG" if code == 0 else "WARN",
                     f"{service_path}/{method} finished code={GRPC_NAMES.get(code, code)} in {(server.end - server.start) // US} us",
                     {"rpc.method": method, "rpc.grpc.status_code": str(code)})
        if code in (2, 4, 12, 13, 14, 15) and server.status != "Error":
            self.error(server, GRPC_NAMES.get(code, "UNKNOWN"))
        client.end = server.end + self.net()
        if deadline_ns and client.end - client.start > deadline_ns:
            client.end = client.start + deadline_ns
            client.attrs["rpc.grpc.status_code"] = "4"
            return client.end, 4
        client.attrs["rpc.grpc.status_code"] = str(code)
        if code != 0 and client.status != "Error":
            client.status, client.message = "Error", f"{GRPC_NAMES.get(code, 'UNKNOWN')}"
        return client.end, code

    def db(self, parent: Span, service: str, system: str, operation: str, target: str, statement: str, t: int,
           duration: int) -> Span:
        if system == "redis":
            attrs = {"db.system": "redis", "db.statement": statement, "db.operation.name": operation,
                     "db.namespace": "0", "server.address": f"redis-{target}.shop.svc.cluster.local", "server.port": "6379"}
            name = operation
        else:
            database = "shop" if system == "postgresql" else "analytics"
            attrs = {"db.system": system, "db.name": database, "db.namespace": database, "db.query.text": statement,
                     "db.operation.name": operation, "db.collection.name": target,
                     "server.address": "postgres-primary.shop.svc.cluster.local" if system == "postgresql" else "clickhouse.analytics.svc.cluster.local",
                     "server.port": "5432" if system == "postgresql" else "8123"}
            name = f"{operation} {database}.{target}"
        s = self.span(parent, service, name, "Client", t, attrs, system)
        s.end = t + max(1, duration)
        return s

    def redis_get(self, parent: Span, service: str, target: str, key: str, t: int, miss_rate: float) -> tuple[int, bool]:
        s = self.db(parent, service, "redis", "GET", target, f"GET {key}", t, self.rng.randint(80, 900) * US)
        miss = self.rng.random() < miss_rate
        if miss:
            self.event(s, s.end - 5 * US, "cache.miss", {"cache.key": key, "cache.name": target})
            if self.rng.random() < 0.5:
                self.log(s, s.end, "DEBUG", f"cache miss for {key}", {"cache.key": key})
        return s.end, miss

    # -- services
    def gateway(self, route_key: str, t: int, frontend_handler) -> None:
        method, route = ROUTES[route_key]
        root = self.span(None, "api-gateway", f"{method} {route}", "Server", t, {
            "http.request.method": method, "http.route": route, "url.path": route.replace("{id}", self.sku),
            "url.scheme": "https", "server.address": "shop.example.com", "server.port": "443",
            "client.address": f"{self.rng.randrange(11, 223)}.{self.rng.randrange(0, 255)}.{self.rng.randrange(0, 255)}.{self.rng.randrange(1, 254)}",
            "user_agent.original": self.rng.choice(USER_AGENTS), "network.protocol.version": "2",
            "user.id": self.user,
        }, "http_server")
        if route_key == "health":
            root.end = t + self.rng.randint(120, 900) * US
            root.attrs["http.response.status_code"] = "200"
            return
        end, code = self.http(root, "api-gateway", "frontend", method, route, t + self.rng.randint(50, 300) * US,
                              frontend_handler, port=3000)
        root.end = end + self.rng.randint(30, 300) * US
        root.attrs["http.response.status_code"] = str(code)
        if code >= 500:
            self.error(root, f"HTTP {code}")
        if self.rng.random() < 0.6:
            self.log(root, root.end, "INFO",
                     f'{root.attrs["client.address"]} "{method} {root.attrs["url.path"]} HTTP/2" {code} '
                     f"{(root.end - root.start) // MS} ms", {"http.response.status_code": str(code)})

    def authorize(self, parent: Span, t: int) -> int:
        def handler(server: Span, t0: int) -> tuple[int, int]:
            end, _ = self.redis_get(server, "auth", "sessions", f"session:{self.user}", t0, 0.02)
            return end, 0
        end, _ = self.grpc(parent, parent.service, "auth", "shop.auth.v1.AuthService", "Authorize", t, handler)
        return end

    def get_stock(self, parent: Span, t: int, outcome: str = "ok") -> tuple[int, int]:
        def handler(server: Span, t0: int) -> tuple[int, int]:
            if outcome == "stock_keyerror":
                end = t0 + self.rng.randint(1, 4) * MS
                self.error(server, "KeyError", python_keyerror(self.sku), at_ns=end - 30 * US)
                server.end = end
                return end, 13
            cursor = t0
            if outcome == "redis_retry":
                failed = self.db(server, "inventory", "redis", "GET", "stock", f"GET stock:{self.sku}", cursor, 250 * MS)
                self.error(failed, "Timeout reading from socket", python_redis_timeout(), escaped=False)
                self.event(server, failed.end + 10 * US, "retry", {"retry.attempt": "1", "retry.reason": "redis timeout",
                                                                  "retry.backoff_ms": "20"})
                self.log(server, failed.end + 20 * US, "WARN", f"redis timeout for stock:{self.sku}, retrying (attempt 1)")
                cursor = failed.end + 20 * MS
            cursor, miss = self.redis_get(server, "inventory", "stock", f"stock:{self.sku}", cursor, 0.3)
            if miss:
                q = self.db(server, "inventory", "postgresql", "SELECT", "stock",
                            "SELECT sku, available, reserved FROM stock WHERE sku = $1", cursor + 30 * US,
                            self.rng.randint(800, 6000) * US)
                s = self.db(server, "inventory", "redis", "SET", "stock", f"SET stock:{self.sku} ? EX 30", q.end + 20 * US,
                            self.rng.randint(80, 600) * US)
                cursor = s.end
            return cursor, 0
        return self.grpc(parent, parent.service, "inventory", "shop.inventory.v1.InventoryService", "GetStock", t, handler)

    def recommendations(self, parent: Span, t: int, deadline_ns: int = 0, slow: bool = False) -> tuple[int, int]:
        def handler(server: Span, t0: int) -> tuple[int, int]:
            cursor, miss = self.redis_get(server, "recommendation", "recs", f"recs:{self.user}", t0, 0.4)
            if miss or slow:
                model = self.span(server, "recommendation", "model.predict", "Internal", cursor + 40 * US,
                                  {"model.name": "two-tower", "model.version": "2026-09-01", "recs.candidates": "500"})
                model.end = model.start + (self.rng.randint(400, 900) if slow else self.rng.randint(5, 40)) * MS
                model.status = "Ok"
                q = self.db(server, "recommendation", "postgresql", "SELECT", "products",
                            "SELECT id, title, price FROM products WHERE id = ANY($1)", model.end + 50 * US,
                            self.rng.randint(1, 8) * MS)
                cursor = q.end
            return cursor, 0
        return self.grpc(parent, parent.service, "recommendation", "shop.recommendation.v1.RecommendationService",
                         "ListRecommendations", t, handler, deadline_ns)

    def search_call(self, parent: Span, t: int, method: str, outcome: str = "ok") -> tuple[int, int]:
        def handler(server: Span, t0: int) -> tuple[int, int]:
            key = f"search:{det_hex(self.trace_id, 'q', nbytes=4)}"
            cursor, miss = self.redis_get(server, "search", "search", key, t0, 0.6 if method == "Search" else 0.2)
            if not miss:
                return cursor, 0
            if outcome == "slow_query":
                duration = self.rng.randint(2000, 4000) * MS
            else:
                duration = self.rng.randint(4, 80) * MS
            q = self.db(server, "search", "clickhouse", "SELECT", "search_index",
                        "SELECT product_id, score FROM analytics.search_index WHERE hasToken(title, {q:String}) "
                        "ORDER BY score DESC LIMIT 50", cursor + 30 * US, duration)
            q.attrs["db.response.returned_rows"] = str(self.rng.randint(0, 50))
            if outcome == "ch_memory":
                exc = python_clickhouse_memory()
                self.error(q, "MEMORY_LIMIT_EXCEEDED", exc, escaped=True)
                return q.end + 100 * US, 13
            s = self.db(server, "search", "redis", "SET", "search", f"SET {key} ? EX 300", q.end + 30 * US,
                        self.rng.randint(80, 500) * US)
            if outcome == "slow_query":
                self.log(server, q.end, "WARN", f"slow search query took {(q.end - q.start) // MS} ms (threshold 1000 ms)")
            return s.end, 0
        return self.grpc(parent, parent.service, "search", "shop.search.v1.SearchService", method, t, handler)

    # -- flows
    def flow_health(self) -> None:
        self.gateway("health", self.plan.start, None)

    def flow_home(self) -> None:
        def frontend(server: Span, t0: int) -> tuple[int, int]:
            deadline = 250 * MS if self.plan.outcome == "rec_deadline" else 0
            rec_end, rec_code = self.recommendations(server, t0, deadline_ns=deadline, slow=bool(deadline))
            trend_end, _ = self.search_call(server, t0 + self.rng.randint(20, 200) * US, "Trending")
            end = max(rec_end, trend_end)
            if rec_code == 4:
                client = next(s for s in self.spans if s.name.endswith("/ListRecommendations") and s.kind == "Client")
                self.error(client, "DEADLINE_EXCEEDED", js_grpc_error(4, "DEADLINE_EXCEEDED", "Deadline exceeded after 0.250s"),
                           escaped=False)
                self.log(server, end, "WARN", "recommendations unavailable, rendering home page without them")
            render = self.span(server, "frontend", "render home", "Internal", end + 50 * US, {"template": "home"})
            render.end = render.start + self.rng.randint(2, 15) * MS
            return render.end, 200
        self.gateway("home", self.plan.start, frontend)

    def flow_search(self) -> None:
        def frontend(server: Span, t0: int) -> tuple[int, int]:
            end, code = self.search_call(server, t0, "Search", self.plan.outcome)
            if code != 0:
                exc = js_grpc_error(13, "INTERNAL", "search backend failed")
                self.error(server, "13 INTERNAL: search backend failed", exc)
                return end + 200 * US, 500
            server.attrs["app.search.results"] = str(self.rng.randint(0, 50))
            return end + self.rng.randint(1, 5) * MS, 200
        self.gateway("search", self.plan.start, frontend)

    def flow_product(self) -> None:
        def frontend(server: Span, t0: int) -> tuple[int, int]:
            stock_end, stock_code = self.get_stock(server, t0, self.plan.outcome)
            rec_end, _ = self.recommendations(server, t0 + self.rng.randint(20, 300) * US)
            end = max(stock_end, rec_end)
            if stock_code != 0:
                self.log(server, stock_end, "WARN", f"stock lookup failed for {self.sku}, showing product without availability")
            render = self.span(server, "frontend", "render product", "Internal", end + 50 * US, {"template": "product"})
            render.end = render.start + self.rng.randint(2, 20) * MS
            return render.end, 200
        self.gateway("product", self.plan.start, frontend)

    def flow_cart(self) -> None:
        def frontend(server: Span, t0: int) -> tuple[int, int]:
            cursor = self.authorize(server, t0)
            cursor, _ = self.get_stock(server, cursor + 50 * US)
            if self.plan.outcome == "js_typeerror":
                self.error(server, "TypeError", js_typeerror(), at_ns=cursor + 200 * US)
                return cursor + 300 * US, 500
            if self.plan.outcome == "out_of_stock":
                self.log(server, cursor, "WARN", f"cannot add {self.sku} to cart: out of stock")
                return cursor + 200 * US, 409
            s = self.db(server, "frontend", "redis", "HSET", "carts", f"HSET cart:{self.user} {self.sku} ?", cursor + 40 * US,
                        self.rng.randint(100, 900) * US)
            server.attrs["app.cart.items"] = str(self.rng.randint(1, 9))
            return s.end + 100 * US, 201
        self.gateway("cart", self.plan.start, frontend)

    def flow_login(self) -> None:
        def auth(server: Span, t0: int) -> tuple[int, int]:
            q = self.db(server, "auth", "postgresql", "SELECT", "users",
                        "SELECT id, password_hash, locked FROM users WHERE email = $1", t0, self.rng.randint(1, 6) * MS)
            bcrypt = self.span(server, "auth", "bcrypt.compare", "Internal", q.end + 30 * US, {"bcrypt.cost": "12"})
            bcrypt.end = bcrypt.start + self.rng.randint(60, 120) * MS
            bcrypt.status = "Ok"
            if self.plan.outcome == "bad_password":
                self.log(server, bcrypt.end, "WARN", f"invalid credentials for user {self.user}",
                         {"enduser.id": self.user, "auth.failure_reason": "password_mismatch"})
                return bcrypt.end + 100 * US, 401
            s = self.db(server, "auth", "redis", "SET", "sessions", f"SET session:{self.user} ? EX 86400", bcrypt.end + 40 * US,
                        self.rng.randint(100, 800) * US)
            self.log(server, s.end, "INFO", f"user {self.user} logged in", {"enduser.id": self.user})
            return s.end + 50 * US, 200

        def frontend(server: Span, t0: int) -> tuple[int, int]:
            end, code = self.http(server, "frontend", "auth", "POST", "/v1/login", t0, auth)
            return end + 300 * US, code
        self.gateway("login", self.plan.start, frontend)

    def flow_checkout(self) -> None:
        outcome = self.plan.outcome
        flag = self.plan.flag
        slow = flag == "new_pricing" and INCIDENT[0] <= self.plan.start < INCIDENT[1]

        def payments(server: Span, t0: int) -> tuple[int, int]:
            if flag:
                server.attrs["feature.flag"] = flag
            cursor, _ = self.redis_get(server, "payments", "idempotency", f"idem:{det_hex(self.trace_id, 'idem', nbytes=6)}", t0, 0.97)
            fees = self.span(server, "payments", "fees.compute", "Internal", cursor + 30 * US,
                             {"payments.currency": "EUR", "payments.method": self.rng.choice(["card", "card", "paypal", "sepa"])})
            fees.end = fees.start + (self.rng.randint(2000, 7000) * MS if slow else self.rng.randint(200, 3000) * US)
            fees.status = "Ok"
            if slow:
                self.log(fees, fees.end, "WARN", f"fee computation took {(fees.end - fees.start) // MS} ms with new_pricing")

            def psp(client: Span, t1: int) -> tuple[int, int]:
                if outcome == "psp_timeout":
                    end = t1 + 5 * NS
                    self.error(client, "context deadline exceeded", go_deadline(), escaped=False, at_ns=end)
                    return end, 504
                return t1 + self.rng.randint(80, 400) * MS, (402 if outcome == "declined" else 201)
            end, code = self.http(server, "payments", None, "POST", "", fees.end + 50 * US, psp,
                                  external_url="https://api.psp.example/v1/charges")
            if code == 504:
                self.error(server, "payment gateway timeout", go_deadline(), escaped=True, at_ns=end + 100 * US)
                return end + 200 * US, 504
            if code == 402:
                self.log(server, end, "WARN", "card declined: insufficient_funds", {"payments.decline_code": "insufficient_funds"})
                return end + 150 * US, 402
            ins = self.db(server, "payments", "postgresql", "INSERT", "payments",
                          "INSERT INTO payments (order_id, amount_cents, currency, psp_ref) VALUES ($1, $2, $3, $4)",
                          end + 50 * US, self.rng.randint(1, 5) * MS)
            return ins.end + 100 * US, 201

        def reserve(server: Span, t0: int) -> tuple[int, int]:
            lock = self.db(server, "inventory", "postgresql", "SELECT", "stock",
                           "SELECT available FROM stock WHERE sku = $1 FOR UPDATE", t0, self.rng.randint(1, 5) * MS)
            if outcome == "out_of_stock":
                self.log(server, lock.end, "WARN", f"reservation refused: {self.sku} out of stock")
                return lock.end + 100 * US, 9
            upd = self.db(server, "inventory", "postgresql", "UPDATE", "stock",
                          "UPDATE stock SET reserved = reserved + $2 WHERE sku = $1", lock.end + 40 * US, self.rng.randint(1, 4) * MS)
            d = self.db(server, "inventory", "redis", "DEL", "stock", f"DEL stock:{self.sku}", upd.end + 30 * US,
                        self.rng.randint(80, 500) * US)
            return d.end, 0

        def checkout(server: Span, t0: int) -> tuple[int, int]:
            if flag:
                server.attrs["feature.flag"] = flag
            place = self.span(server, "checkout", "CheckoutService.placeOrder", "Internal", t0,
                              {"code.function": "placeOrder", "code.namespace": "com.shop.checkout.service.CheckoutService",
                               "app.order.items": str(self.rng.randint(1, 6))})
            self.log(place, t0 + 10 * US, "INFO", f"placing order for user {self.user}", {"enduser.id": self.user})
            cart = self.db(place, "checkout", "postgresql", "SELECT", "carts",
                           "SELECT sku, quantity, unit_price FROM cart_items WHERE cart_id = ?", t0 + 40 * US,
                           self.rng.randint(1, 6) * MS)
            cursor = cart.end
            if outcome == "inventory_retry":
                def unavailable(srv: Span, t1: int) -> tuple[int, int]:
                    return t1 + self.rng.randint(1, 3) * MS, 14
                cursor, _ = self.grpc(place, "checkout", "inventory", "shop.inventory.v1.InventoryService", "Reserve",
                                      cursor + 50 * US, unavailable)
                self.event(place, cursor + 10 * US, "retry", {"retry.attempt": "1", "retry.reason": "UNAVAILABLE",
                                                             "retry.backoff_ms": "50"})
                self.log(place, cursor + 20 * US, "WARN", "inventory unavailable, retrying reservation (attempt 1)")
                cursor += 50 * MS
            cursor, code = self.grpc(place, "checkout", "inventory", "shop.inventory.v1.InventoryService", "Reserve",
                                     cursor + 50 * US, reserve)
            if code == 9:
                place.end = cursor + 100 * US
                self.log(place, place.end, "WARN", "order rejected: item out of stock")
                return place.end + 50 * US, 409
            self.log(place, cursor, "INFO", f"stock reserved for {self.sku}")
            if outcome == "npe":
                place.end = cursor + self.rng.randint(1, 3) * MS
                self.error(place, "NullPointerException", java_npe(), at_ns=place.end - 10 * US)
                self.error(server, "Request processing failed: java.lang.NullPointerException")
                return place.end + 200 * US, 500
            cursor, pay = self.http(place, "checkout", "payments", "POST", "/v1/charges", cursor + 60 * US, payments, port=8443)
            if pay == 504:
                place.end = cursor + 300 * US
                self.error(place, "payment failed", java_gateway_timeout(), at_ns=place.end - 20 * US)
                return place.end + 100 * US, 502
            if pay == 402:
                place.end = cursor + 200 * US
                self.log(place, place.end, "INFO", "payment declined, order not created")
                return place.end + 50 * US, 402
            self.log(place, cursor, "INFO", "payment captured")
            order = self.db(place, "checkout", "postgresql", "INSERT", "orders",
                            "INSERT INTO orders (id, user_id, total_cents, status) VALUES (?, ?, ?, 'placed')",
                            cursor + 50 * US, self.rng.randint(1, 5) * MS)
            publish = self.span(place, "checkout", "publish orders", "Producer", order.end + 40 * US, {
                "messaging.system": "kafka", "messaging.destination.name": "orders",
                "messaging.operation.type": "send", "messaging.operation.name": "publish",
                "messaging.kafka.message.key": f"order-{det_hex(self.trace_id, 'order', nbytes=5)}",
                "messaging.destination.partition.id": str(self.rng.randrange(0, 12)),
                "messaging.message.id": det_hex(self.trace_id, "message", nbytes=8),
                "server.address": "kafka-0.kafka.svc.cluster.local", "server.port": "9092",
            }, "kafka", span_id=producer_span_of(self.seed, self.plan.no))
            publish.end = publish.start + self.rng.randint(300, 2500) * US
            self.consume_notification(publish)
            place.end = publish.end + 100 * US
            place.status = "Ok"
            self.log(place, place.end, "INFO", "order placed", {"app.order.status": "placed"})
            return place.end + 80 * US, 201

        def frontend(server: Span, t0: int) -> tuple[int, int]:
            cursor = self.authorize(server, t0)
            end, code = self.http(server, "frontend", "checkout", "POST", "/v1/checkout", cursor + 60 * US, checkout)
            if code >= 500:
                # Every ERROR record of the fixtures carries exception.* attributes.
                exc = ("Error", f"checkout failed with HTTP {code}",
                       f"Error: checkout failed with HTTP {code}\n"
                       "    at CheckoutClient.placeOrder (/app/src/clients/checkout.js:41:13)\n"
                       "    at async /app/src/routes/checkout.js:29:18")
                self.log(server, end, "ERROR", exc[1],
                         {"exception.type": exc[0], "exception.message": exc[1], "exception.stacktrace": exc[2]})
            return end + self.rng.randint(200, 900) * US, code
        self.gateway("checkout", self.plan.start, frontend)

    def consume_notification(self, publish: Span) -> None:
        process = self.span(publish, "notification", "process orders", "Consumer", publish.end + self.rng.randint(5, 80) * MS, {
            "messaging.system": "kafka", "messaging.destination.name": "orders", "messaging.operation.type": "process",
            "messaging.operation.name": "process", "messaging.consumer.group.name": "notification",
            "messaging.message.id": publish.attrs["messaging.message.id"],
            "messaging.destination.partition.id": publish.attrs["messaging.destination.partition.id"],
        }, "kafka")
        render = self.span(process, "notification", "render order-confirmation", "Internal", process.start + 200 * US,
                           {"template": "order-confirmation", "template.locale": self.rng.choice(["en-GB", "fr-FR", "de-DE"])})
        render.end = render.start + self.rng.randint(2, 12) * MS

        def mail(client: Span, t1: int) -> tuple[int, int]:
            if self.plan.outcome == "smtp_fail":
                end = t1 + self.rng.randint(30, 90) * MS
                return end, 502
            return t1 + self.rng.randint(40, 250) * MS, 202
        end, code = self.http(process, "notification", None, "POST", "", render.end + 60 * US, mail,
                              external_url="https://mail.example/v3/mail/send")
        process.end = end + 300 * US
        if code >= 400:
            self.error(process, "Failure sending mail.", dotnet_smtp(), as_attributes=True, at_ns=end + 100 * US)
        else:
            self.log(process, process.end, "INFO", f"order confirmation sent to user {self.user}")

    def flow_reindex(self) -> None:
        batches = max(1, (self.plan.spans - 1) // 4)
        root = self.span(None, "search", "catalog.reindex", "Internal", self.plan.start,
                         {"job.name": "catalog.reindex", "job.batches": str(batches), "code.function": "reindex"})
        self.log(root, root.start, "INFO", f"catalog reindex started: {batches} batches")
        cursor = root.start + 2 * MS
        for b in range(batches):
            batch = self.span(root, "search", "reindex batch", "Internal", cursor, {"job.batch": str(b), "job.batch_size": "500"})
            ins = self.db(batch, "search", "clickhouse", "INSERT", "search_index",
                          "INSERT INTO analytics.search_index (product_id, title, score) FORMAT RowBinary",
                          cursor + 50 * US, self.rng.randint(3, 12) * MS)
            ins.attrs["db.response.affected_rows"] = "500"

            def refresh(server: Span, t0: int) -> tuple[int, int]:
                return t0 + self.rng.randint(300, 2500) * US, 0
            end, _ = self.grpc(batch, "search", "recommendation", "shop.recommendation.v1.RecommendationService",
                               "RefreshEmbeddings", ins.end + 40 * US, refresh)
            batch.end = end + 100 * US
            batch.status = "Ok"
            cursor = batch.end + self.rng.randint(50, 400) * US
        root.end = cursor + MS
        root.status = "Ok"
        self.log(root, root.end, "INFO", f"catalog reindex finished in {(root.end - root.start) // MS} ms")

    def flow_consumer(self) -> None:
        links = self.plan.links
        root = self.span(None, "inventory", "receive orders", "Consumer", self.plan.start, {
            "messaging.system": "kafka", "messaging.destination.name": "orders", "messaging.operation.type": "receive",
            "messaging.operation.name": "poll", "messaging.consumer.group.name": "inventory-reservations",
            "messaging.batch.message_count": str(len(links)),
        }, "kafka")
        cursor = root.start + 500 * US
        for producer_no in links:
            target = (trace_id_of(self.seed, producer_no), producer_span_of(self.seed, producer_no))
            message_id = det_hex(target[0], "message", nbytes=8)
            root.links.append((target[0], target[1], {"messaging.message.id": message_id}))
            msg = self.span(root, "inventory", "process orders", "Consumer", cursor, {
                "messaging.system": "kafka", "messaging.destination.name": "orders", "messaging.operation.type": "process",
                "messaging.operation.name": "process", "messaging.consumer.group.name": "inventory-reservations",
                "messaging.message.id": message_id,
            }, "kafka")
            msg.links.append((target[0], target[1], {"messaging.message.id": message_id, "link.kind": "follows_from"}))
            upd = self.db(msg, "inventory", "postgresql", "UPDATE", "reservations",
                          "UPDATE reservations SET state = 'confirmed' WHERE order_id = $1", cursor + 100 * US,
                          self.rng.randint(1, 4) * MS)
            msg.end = upd.end + 100 * US
            cursor = msg.end + 50 * US
        root.end = cursor + 200 * US
        self.log(root, root.end, "INFO", f"processed {len(links)} order messages")

    def build(self) -> "Trace":
        getattr(self, f"flow_{self.plan.flow}")()
        if self.plan.drop and len(self.spans) > 3:
            if self.plan.drop == "root":
                dropped = self.spans[0]
            else:
                # The frontend server span: its children keep pointing at it.
                dropped = next((s for s in self.spans if s.service == "frontend" and s.kind == "Server"), self.spans[1])
            self.spans = [s for s in self.spans if s is not dropped]
            self.logs = [l for l in self.logs if l["SpanId"] != dropped.span_id]
        return self


GRPC_NAMES = {0: "OK", 2: "UNKNOWN", 4: "DEADLINE_EXCEEDED", 9: "FAILED_PRECONDITION", 12: "UNIMPLEMENTED",
              13: "INTERNAL", 14: "UNAVAILABLE", 15: "DATA_LOSS"}


def index_rows(trace_id: str, spans: list[Span]) -> list[dict]:
    """One row per export batch, like the exporter's trace_id_ts view:
    Start = min(Timestamp), End = max(Timestamp) of the batch's span starts."""
    groups: dict[int, list[int]] = {}
    for s in spans:
        bucket = s.end // INDEX_BATCH_NS
        lo_hi = groups.get(bucket)
        if lo_hi is None:
            groups[bucket] = [s.start, s.start]
        else:
            lo_hi[0] = min(lo_hi[0], s.start)
            lo_hi[1] = max(lo_hi[1], s.start)
    return [{"TraceId": trace_id, "Start": dt64(lo), "End": dt64(hi)} for lo, hi in groups.values()]


def background_logs(seed: int) -> list[dict]:
    """Trace-less logs: pod start/stop at each release and periodic pool stats."""
    rng = random.Random(f"{seed}:background")
    out: list[dict] = []
    for pod in pods():
        service = pod["service"]
        stub = Trace.__new__(Trace)
        stub.rng, stub.logs, stub.pod_choice = rng, out, {f"{service}:{pod['version_index']}": pod}
        stub.trace_id = ""
        if pod["since"] > WINDOW_START_NS:
            stub.log(None, pod["since"], "INFO", f"starting {service} version {pod['version']} on {pod['node']}",
                     {"app.lifecycle": "start"}, service=service)
        if pod["until"] < WINDOW_END_NS:
            stub.log(None, pod["until"] - 2 * NS, "INFO", f"received SIGTERM, shutting down {service} {pod['version']}",
                     {"app.lifecycle": "stop"}, service=service)
        t = max(pod["since"], WINDOW_START_NS) + rng.randint(1, 300) * NS
        while t < min(pod["until"], WINDOW_END_NS) - 10 * NS:
            active = rng.randint(1, 40)
            stub.log(None, t, "DEBUG" if rng.random() < 0.7 else "INFO",
                     f"connection pool stats active={active} idle={rng.randint(0, 20)} waiting={rng.randint(0, 3)}",
                     {"pool.name": "default"}, service=service)
            if rng.random() < 0.03:
                stub.log(None, t + 3 * NS, "WARN", f"slow health probe: {rng.randint(800, 2000)} ms", {"probe": "liveness"},
                         service=service)
            t += 5 * MINUTE + rng.randint(-20, 20) * NS
    return out


# ----------------------------------------------------------------- inserting

def _post(conn: dict, query: str, body: bytes = b"", timeout: int = 600) -> bytes:
    url = f"{conn['url']}/?{urllib.parse.urlencode({'query': query})}"
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("X-ClickHouse-User", conn["user"])
    req.add_header("X-ClickHouse-Key", conn["password"])
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"ClickHouse HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')}") from exc


def _rows_bytes(rows) -> bytes:
    return b"".join(json.dumps(r, separators=(",", ":")).encode() + b"\n" for r in rows)


def generate_chunk(seed: int, plans: list[Plan]) -> tuple[list[dict], list[dict], list[dict]]:
    spans, index, logs = [], [], []
    for plan in plans:
        trace = Trace(seed, plan).build()
        trace.spans.sort(key=lambda s: (s.start, s.span_id))
        spans.extend(s.to_row(trace.trace_id) for s in trace.spans)
        index.extend(index_rows(trace.trace_id, trace.spans))
        logs.extend(trace.logs)
    return spans, index, logs


def _insert_chunk(conn: dict, seed: int, plans: list[Plan], traces: bool, logs: bool, logs_table: str) -> tuple[int, int, int]:
    spans, index, log_rows = generate_chunk(seed, plans)
    if traces:
        _post(conn, "INSERT INTO otel.otel_traces FORMAT JSONEachRow", _rows_bytes(spans))
        _post(conn, "INSERT INTO otel.otel_traces_trace_id_ts FORMAT JSONEachRow", _rows_bytes(index))
    if logs and log_rows:
        _post(conn, f"INSERT INTO {logs_table} FORMAT JSONEachRow", _rows_bytes(log_rows))
    return len(spans), len(index), len(log_rows)


# ---------------------------------------------------------------- state

def _scalar(conn: dict, sql: str) -> str:
    return _post(conn, sql + " FORMAT TSV").decode().strip()


def table_exists(conn: dict, database: str, table: str) -> bool:
    return _scalar(conn, f"SELECT count() FROM system.tables WHERE database = '{database}' AND name = '{table}'") == "1"


def partition_rows(conn: dict, database: str, table: str) -> int:
    """Rows of the rich day's partition, from system.parts only."""
    return int(_scalar(conn, "SELECT coalesce(sum(rows), 0) FROM system.parts WHERE active "
                             f"AND database = '{database}' AND table = '{table}' AND partition_id = '{RICH_PARTITION}'") or "0")


def window_literal(column: str) -> str:
    return (f"{column} >= fromUnixTimestamp64Nano(toInt64({WINDOW_START_NS})) "
            f"AND {column} < fromUnixTimestamp64Nano(toInt64({WINDOW_END_NS}))")


def index_rows_in_window(conn: dict) -> int:
    if not table_exists(conn, "otel", "otel_traces_trace_id_ts"):
        return 0
    return int(_scalar(conn, f"SELECT count() FROM otel.otel_traces_trace_id_ts WHERE {window_literal('Start')}") or "0")


def window_counts(conn: dict) -> tuple[int, int]:
    """(spans, index rows) of the rich window: seed.py leaves them out of the
    bulk fixture's own counts."""
    if not table_exists(conn, "otel", "otel_traces"):
        return 0, 0
    return partition_rows(conn, "otel", "otel_traces"), index_rows_in_window(conn)


def table_comment(conn: dict, database: str, table: str) -> str:
    raw = _post(conn, f"SELECT comment FROM system.tables WHERE database = '{database}' AND name = '{table}' FORMAT JSONEachRow")
    line = raw.decode().strip().splitlines()
    return json.loads(line[0])["comment"] if line else ""


def marker_of(conn: dict, database: str, table: str) -> str:
    for token in table_comment(conn, database, table).split():
        if token.startswith(MARKER + "="):
            return token.split("=", 1)[1]
    return ""


def set_marker(conn: dict, database: str, table: str, value: str) -> None:
    """Add (or with value '' remove) the rich marker, keeping the rest of the
    comment (seed.py's logs/metrics completion marker lives there too)."""
    kept = [t for t in table_comment(conn, database, table).split() if not t.startswith(MARKER + "=")]
    if value:
        kept.append(f"{MARKER}={value}")
    text = " ".join(kept).replace("\\", "\\\\").replace("'", "\\'")
    _post(conn, f"ALTER TABLE `{database}`.`{table}` MODIFY COMMENT '{text}'")


METRIC_TABLES = ("otel_metrics_histogram", "otel_metrics_sum", "otel_metrics_gauge")


def foreign_rows(conn: dict, database: str, table: str, time_column: str) -> int:
    """Rows of the rich day that belong to a service the rich fixture does not
    generate (a FORCE rebuild refuses to delete them)."""
    names = ",".join(f"'{s}'" for s in SERVICE_NAMES)
    return int(_scalar(conn, f"SELECT count() FROM `{database}`.`{table}` WHERE {window_literal(time_column)} "
                             f"AND ServiceName NOT IN ({names})") or "0")


def clear_window(conn: dict, logs_table: tuple[str, str], metrics_db: str, parts: set[str]) -> None:
    """OTEL_FIXTURE_RICH_FORCE: delete the rich day's rows of the given parts only."""
    checks = []
    if "traces" in parts:
        checks.append(("otel", "otel_traces", "Timestamp"))
    if "logs" in parts:
        checks.append((logs_table[0], logs_table[1], "Timestamp"))
    if "metrics" in parts:
        checks += [(metrics_db, t, "TimeUnix") for t in METRIC_TABLES]
    for database, table, column in checks:
        if table_exists(conn, database, table) and foreign_rows(conn, database, table, column):
            raise RuntimeError(f"{database}.{table} holds rows of other services on {RICH_DAY}: refusing to clear the rich window")
    for database, table, _ in checks:
        if not table_exists(conn, database, table):
            continue
        print(f"OTEL rich fixture: dropping partition {RICH_DAY} of {database}.{table}", flush=True)
        _post(conn, f"ALTER TABLE `{database}`.`{table}` DROP PARTITION '{RICH_DAY}'")
        set_marker(conn, database, table, "")
    if "traces" in parts and index_rows_in_window(conn):
        print("OTEL rich fixture: deleting the rich window's otel_traces_trace_id_ts rows", flush=True)
        _post(conn, f"ALTER TABLE otel.otel_traces_trace_id_ts DELETE WHERE {window_literal('Start')} "
                    "SETTINGS mutations_sync = 2", timeout=1800)


# ---------------------------------------------------------------- metrics

HISTOGRAM_BOUNDS_S = (0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0)


def resource_sql() -> str:
    """Service-level resource of an aggregated point (no pod or host keys)."""
    return ("mapFilter((k, v) -> k NOT IN ('host.name', 'k8s.node.name', 'k8s.pod.name', 'service.instance.id'), "
            "CAST(ResourceAttributes, 'Map(String, String)'))")


def histogram_sql(database: str) -> str:
    """http.server.request.duration (delta, 60 s) per HTTP server span name.

    The span name fixes the route and method, so each point counts exactly the
    spans of its (ServiceName, span.name) minute. One exemplar per point, like
    the bulk signals: the slowest span, with its start and duration.
    """
    le = ", ".join(f"countIf(Duration <= {int(round(b * NS))})" for b in HISTOGRAM_BOUNDS_S)
    buckets = len(HISTOGRAM_BOUNDS_S) + 1
    bounds = "[" + ", ".join(repr(b) for b in HISTOGRAM_BOUNDS_S) + "]"
    return f"""
INSERT INTO `{database}`.otel_metrics_histogram
(
    ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes,
    ScopeDroppedAttrCount, ScopeSchemaUrl, ServiceName, MetricName, MetricDescription, MetricUnit,
    Attributes, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds,
    `Exemplars.FilteredAttributes`, `Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.SpanId`, `Exemplars.TraceId`,
    Flags, Min, Max, AggregationTemporality
)
SELECT
    resource, '{SCHEMA_URL}', 'io.opentelemetry.http', '1.0.0', CAST(map(), 'Map(String, String)'),
    0, '', service_name, 'http.server.request.duration', 'Duration of HTTP server requests.', 's',
    map('span.name', span_name, 'http.route', route, 'http.request.method', method),
    minute, minute + toIntervalSecond(60), cnt, total_s,
    arrayMap(i -> toUInt64(if(i = 1, le[1], if(i <= {buckets - 1}, le[i] - le[i - 1], cnt - le[{buckets - 1}]))), range(1, {buckets + 1})),
    {bounds},
    arrayResize([CAST(map(), 'Map(String, String)')], length(ex)),
    arrayMap(e -> e.3, ex), arrayMap(e -> e.4 / 1e9, ex), arrayMap(e -> e.2, ex), arrayMap(e -> e.1, ex),
    0, min_s, max_s, 1
FROM
(
    SELECT
        toStartOfMinute(Timestamp) AS minute,
        toString(ServiceName) AS service_name,
        toString(SpanName) AS span_name,
        any(SpanAttributes['http.route']) AS route,
        any(SpanAttributes['http.request.method']) AS method,
        any({resource_sql()}) AS resource,
        count() AS cnt,
        sum(Duration) / 1e9 AS total_s,
        min(Duration) / 1e9 AS min_s,
        max(Duration) / 1e9 AS max_s,
        [{le}] AS le,
        [argMax(tuple(TraceId, SpanId, Timestamp, Duration), Duration)] AS ex
    FROM otel.otel_traces
    WHERE {window_literal('Timestamp')} AND SpanKind = 'Server' AND mapContains(SpanAttributes, 'http.route')
      AND ServiceName IN ({",".join(f"'{s}'" for s in SERVICE_NAMES)})
    GROUP BY minute, service_name, span_name
)
""".strip()


def calls_sql(database: str) -> str:
    """traces.span.metrics.calls (cumulative, monotonic, 60 s): each release
    restarts the service's pods, so its counters reset at the release time."""
    switches = "map(" + ", ".join(
        f"'{svc}', [{', '.join(f'toInt64({max(since, WINDOW_START_NS)})' for _, since in spec[3])}]"
        for svc, spec in SERVICES.items()) + ")"
    return f"""
INSERT INTO `{database}`.otel_metrics_sum
(
    ResourceAttributes, ResourceSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes,
    ScopeDroppedAttrCount, ScopeSchemaUrl, ServiceName, MetricName, MetricDescription, MetricUnit,
    Attributes, StartTimeUnix, TimeUnix, Value, Flags,
    `Exemplars.FilteredAttributes`, `Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.SpanId`, `Exemplars.TraceId`,
    AggregationTemporality, IsMonotonic
)
SELECT
    resource, '{SCHEMA_URL}', 'spanmetricsconnector', '0.110.0', CAST(map(), 'Map(String, String)'),
    0, '', service_name, 'traces.span.metrics.calls', 'Number of spans per span name, kind and status.', '{{call}}',
    map('span.name', span_name, 'span.kind', concat('SPAN_KIND_', upper(span_kind)),
        'status.code', concat('STATUS_CODE_', upper(status_code))),
    fromUnixTimestamp64Nano(epoch_start), minute + toIntervalSecond(60),
    toFloat64(sum(cnt) OVER (PARTITION BY service_name, span_name, span_kind, status_code, epoch_start
                            ORDER BY minute ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)),
    0,
    CAST([], 'Array(Map(String, String))'), CAST([], 'Array(DateTime64(9))'), CAST([], 'Array(Float64)'),
    CAST([], 'Array(String)'), CAST([], 'Array(String)'),
    2, true
FROM
(
    SELECT
        toStartOfMinute(Timestamp) AS minute,
        toString(ServiceName) AS service_name,
        toString(SpanName) AS span_name,
        toString(SpanKind) AS span_kind,
        toString(StatusCode) AS status_code,
        any({resource_sql()}) AS resource,
        arrayMax(arrayFilter(s -> s <= toInt64(toUnixTimestamp(minute)) * 1000000000, {switches}[service_name])) AS epoch_start,
        count() AS cnt
    FROM otel.otel_traces
    WHERE {window_literal('Timestamp')} AND ServiceName IN ({",".join(f"'{s}'" for s in SERVICE_NAMES)})
    GROUP BY minute, service_name, span_name, span_kind, status_code
)
""".strip()


def gauge_rows(seed: int) -> list[dict]:
    """process.cpu.utilization per pod every 60 s (host.name and k8s.pod.name
    attributes); payments pods run hot during the incident."""
    rng = random.Random(f"{seed}:gauges")
    rows = []
    for pod in pods():
        resource = pod["resource"]
        phase = rng.random() * 6.283
        t = (max(pod["since"], WINDOW_START_NS) // MINUTE + 1) * MINUTE
        while t < min(pod["until"], WINDOW_END_NS):
            hours = (t - WINDOW_START_NS) / HOUR
            value = 0.25 + 0.15 * math.sin(hours / 24 * 6.283 + phase) + rng.uniform(-0.04, 0.04)
            if pod["service"] == "payments" and INCIDENT[0] <= t < INCIDENT[1]:
                value += 0.45
            rows.append({
                "ResourceAttributes": resource, "ResourceSchemaUrl": SCHEMA_URL,
                "ScopeName": "io.opentelemetry.runtime-telemetry", "ScopeVersion": "2.8.0-alpha", "ScopeAttributes": {},
                "ScopeDroppedAttrCount": 0, "ScopeSchemaUrl": "", "ServiceName": pod["service"],
                "MetricName": "process.cpu.utilization",
                "MetricDescription": "Difference in process.cpu.time since the last measurement, divided by the elapsed time and number of CPUs.",
                "MetricUnit": "1", "Attributes": {"host.name": pod["node"], "k8s.pod.name": pod["pod"]},
                "StartTimeUnix": dt64(max(pod["since"], WINDOW_START_NS)), "TimeUnix": dt64(t),
                "Value": round(min(0.99, max(0.01, value)), 4), "Flags": 0,
                "Exemplars.FilteredAttributes": [], "Exemplars.TimeUnix": [], "Exemplars.Value": [],
                "Exemplars.SpanId": [], "Exemplars.TraceId": [],
            })
            t += MINUTE
    return rows


# ------------------------------------------------------------------- driver

def _env_flag(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def settings() -> dict:
    return {
        "traces": int(os.environ.get("OTEL_FIXTURE_RICH_TRACES", "40000")),
        "seed": int(os.environ.get("OTEL_FIXTURE_RICH_SEED", "20260912")),
        "force": _env_flag("OTEL_FIXTURE_RICH_FORCE"),
        "logs": _env_flag("OTEL_FIXTURE_RICH_LOGS", "1"),
        "metrics": _env_flag("OTEL_FIXTURE_RICH_METRICS", "1"),
        "metrics_database": os.environ.get("OTEL_FIXTURE_RICH_METRICS_DATABASE", "otel").strip() or "otel",
        "processes": max(1, int(os.environ.get("OTEL_FIXTURE_RICH_PROCESSES", "4"))),
        "chunk_traces": max(1, int(os.environ.get("OTEL_FIXTURE_RICH_CHUNK_TRACES", "1500"))),
    }


def populate(conn: dict, ensure_signal_tables) -> None:
    """Idempotently load the rich day (OTEL_FIXTURE_RICH=1).

    Each part (traces + index, logs, metrics) is complete when its table
    carries the marker and the rich day holds rows. A part whose day is
    empty is generated; a complete part is kept; a part holding rows
    without a marker (an interrupted load) is left untouched unless
    OTEL_FIXTURE_RICH_FORCE=1, which deletes the rich day's rows first.
    """
    cfg = settings()
    if cfg["traces"] < 1:
        raise RuntimeError("OTEL_FIXTURE_RICH_TRACES must be >= 1")
    if not cfg["metrics_database"].replace("_", "").isalnum():
        raise RuntimeError("OTEL_FIXTURE_RICH_METRICS_DATABASE must be a plain identifier")
    started = time.monotonic()
    marker = f"{MARKER_VERSION}/seed-{cfg['seed']}/traces-{cfg['traces']}"
    logs_table = ("otel", "otel_logs")
    if cfg["logs"]:
        ensure_signal_tables("otel")
    if cfg["metrics"]:
        ensure_signal_tables(cfg["metrics_database"])

    def state(part: str) -> str:
        """empty | complete | stale (another marker) | partial."""
        if part == "traces":
            rows = sum(window_counts(conn))
            mark = marker_of(conn, "otel", "otel_traces")
        elif part == "logs":
            rows = partition_rows(conn, *logs_table)
            mark = marker_of(conn, *logs_table)
        else:
            rows = sum(partition_rows(conn, cfg["metrics_database"], t) for t in METRIC_TABLES)
            marks = {marker_of(conn, cfg["metrics_database"], t) for t in METRIC_TABLES}
            mark = marks.pop() if len(marks) == 1 else ""
        if rows == 0:
            return "empty"
        if mark == marker:
            return "complete"
        return "stale" if mark else "partial"

    parts = ["traces"] + (["logs"] if cfg["logs"] else []) + (["metrics"] if cfg["metrics"] else [])
    states = {part: state(part) for part in parts}
    if cfg["force"]:
        clear_window(conn, logs_table, cfg["metrics_database"], set(parts))
        states = {part: "empty" for part in parts}
    for part, value in states.items():
        if value in ("stale", "partial"):
            print(f"OTEL rich fixture: {part} of {RICH_DAY} hold "
                  f"{'another rich dataset' if value == 'stale' else 'rows without a completion marker'}; "
                  "keeping them. Set OTEL_FIXTURE_RICH_FORCE=1 to rebuild the rich day.", flush=True)
    if states["traces"] in ("stale", "partial"):
        return
    print(f"OTEL rich fixture: {RICH_DAY}, seed={cfg['seed']}, request traces={cfg['traces']}, states={states}", flush=True)

    write_traces = states["traces"] == "empty"
    write_logs = states.get("logs") == "empty"
    if write_traces or write_logs:
        plans = build_plans(cfg["seed"], cfg["traces"])
        chunks = [plans[i:i + cfg["chunk_traces"]] for i in range(0, len(plans), cfg["chunk_traces"])]
        totals = [0, 0, 0]
        with ProcessPoolExecutor(max_workers=cfg["processes"]) as pool:
            futures = [pool.submit(_insert_chunk, conn, cfg["seed"], chunk, write_traces, write_logs, "otel.otel_logs")
                       for chunk in chunks]
            for done, future in enumerate(as_completed(futures), 1):
                for i, value in enumerate(future.result()):
                    totals[i] += value
                if done % 5 == 0 or done == len(futures):
                    print(f"OTEL rich fixture: chunks {done}/{len(futures)}: spans={totals[0]} index_rows={totals[1]} "
                          f"logs={totals[2]} ({time.monotonic() - started:.1f}s)", flush=True)
        if write_logs:
            background = background_logs(cfg["seed"])
            _post(conn, "INSERT INTO otel.otel_logs FORMAT JSONEachRow", _rows_bytes(background))
            totals[2] += len(background)
        if write_traces:
            set_marker(conn, "otel", "otel_traces", marker)
            print(f"OTEL rich fixture: traces ready: {len(plans)} traces, {totals[0]} spans, {totals[1]} index rows", flush=True)
        if write_logs:
            set_marker(conn, *logs_table, marker)
            print(f"OTEL rich fixture: logs ready: {totals[2]} records", flush=True)

    if states.get("metrics") == "empty":
        database = cfg["metrics_database"]
        t0 = time.monotonic()
        _post(conn, histogram_sql(database), timeout=1800)
        _post(conn, calls_sql(database), timeout=1800)
        gauges = gauge_rows(cfg["seed"])
        _post(conn, f"INSERT INTO `{database}`.otel_metrics_gauge FORMAT JSONEachRow", _rows_bytes(gauges))
        for table in METRIC_TABLES:
            set_marker(conn, database, table, marker)
        rows = {t: partition_rows(conn, database, t) for t in METRIC_TABLES}
        print(f"OTEL rich fixture: metrics ready in {database}: {rows} ({time.monotonic() - t0:.1f}s)", flush=True)
    print(f"OTEL rich fixture: done in {time.monotonic() - started:.1f}s", flush=True)
