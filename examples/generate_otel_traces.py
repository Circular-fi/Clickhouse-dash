#!/usr/bin/env python3
"""Generate realistic synthetic OpenTelemetry traces for ClickHouse.

The dataset is deliberately domain-neutral. It models a typical distributed
backend with HTTP ingress, authentication, Kafka hand-offs, processing and
enrichment workers, cache/database calls, ClickHouse writes, events, links,
parallel branches and occasional errors.

The output targets the columns used by the OpenTelemetry Collector ClickHouse
exporter and by ChDash Trace Explorer.
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

NS = 1_000_000_000
US = 1_000
MS = 1_000_000

SERVICES = [
    "edge_gateway",
    "api_service",
    "auth_service",
    "event_ingest",
    "processing_worker",
    "enrichment_worker",
    "cache_service",
    "clickhouse_writer",
    "notification_worker",
    "test_ingest",
    "test_worker",
    "test_enrichment",
]

OPERATIONS: Dict[str, List[Tuple[str, str]]] = {
    "edge_gateway": [
        ("HTTP POST /v1/events", "Server"),
        ("gateway.route", "Internal"),
        ("gateway.response", "Internal"),
    ],
    "api_service": [
        ("request.validate", "Internal"),
        ("auth.check", "Client"),
        ("events.raw send", "Producer"),
        ("request.serialize", "Internal"),
    ],
    "auth_service": [
        ("POST /internal/authorize", "Server"),
        ("session.lookup", "Client"),
        ("policy.evaluate", "Internal"),
    ],
    "event_ingest": [
        ("events.raw receive", "Consumer"),
        ("event.decode", "Internal"),
        ("event.normalize", "Internal"),
        ("events.normalized send", "Producer"),
    ],
    "processing_worker": [
        ("events.normalized receive", "Consumer"),
        ("job.process", "Internal"),
        ("job.validate", "Internal"),
        ("cache.lookup", "Client"),
        ("enrichment.request send", "Producer"),
        ("analytics.write send", "Producer"),
    ],
    "enrichment_worker": [
        ("enrichment.request receive", "Consumer"),
        ("enrichment.fetch", "Client"),
        ("enrichment.merge", "Internal"),
        ("enrichment.result send", "Producer"),
    ],
    "cache_service": [
        ("cache.get", "Client"),
        ("cache.set", "Client"),
        ("cache.refresh", "Internal"),
    ],
    "clickhouse_writer": [
        ("analytics.write receive", "Consumer"),
        ("clickhouse.decode", "Internal"),
        ("clickhouse.insert", "Client"),
        ("clickhouse.commit", "Internal"),
    ],
    "notification_worker": [
        ("notifications send", "Producer"),
        ("notifications receive", "Consumer"),
        ("notification.render", "Internal"),
        ("notification.deliver", "Client"),
    ],
    "test_ingest": [
        ("test.input receive", "Consumer"),
        ("test.input.validate", "Internal"),
        ("test.input send", "Producer"),
    ],
    "test_worker": [
        ("test.worker receive", "Consumer"),
        ("test.worker.process", "Internal"),
        ("test.worker.persist", "Client"),
    ],
    "test_enrichment": [
        ("test.enrichment.fetch", "Client"),
        ("test.enrichment.merge", "Internal"),
        ("test.enrichment send", "Producer"),
    ],
}

KAFKA_TOPICS = [
    "events.raw",
    "events.normalized",
    "enrichment.request",
    "enrichment.result",
    "analytics.write",
    "notifications",
    "test.events",
]

DB_TABLES = [
    "analytics.events_buffer",
    "analytics.events_enriched",
    "analytics.request_metrics",
    "analytics.delivery_log",
    "analytics.worker_metrics",
]

HTTP_ENDPOINTS = [
    "https://profile.internal/v1/batch",
    "https://catalog.internal/v2/items",
    "https://rules.internal/v1/evaluate",
    "https://metadata.internal/v1/lookup",
]

EVENT_NAMES = [
    "cache.hit",
    "cache.miss",
    "batch.joined",
    "request.retry",
    "payload.normalized",
    "record.enriched",
    "queue.drained",
    "write.completed",
]


def hex_id(rng: random.Random, nbytes: int) -> str:
    return "".join(f"{rng.randrange(256):02x}" for _ in range(nbytes))


def dt64(ns: int) -> str:
    sec, nano = divmod(ns, NS)
    base = datetime.fromtimestamp(sec, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return f"{base}.{nano:09d}"


def rand_duration(rng: random.Random, operation: str) -> int:
    op = operation.lower()
    if "insert" in op or "persist" in op or "write" in op:
        return rng.randint(35, 240) * MS
    if "fetch" in op or "deliver" in op or "authorize" in op:
        return rng.randint(5, 360) * MS
    if "process" in op or "normalize" in op or "enrichment.merge" in op:
        return rng.randint(2, 190) * MS
    if "send" in op or "receive" in op or "commit" in op:
        return rng.randint(20, 2200) * US
    if "cache" in op or "session.lookup" in op:
        return rng.randint(30, 18_000) * US
    return rng.randint(10, 120_000) * US


@dataclass
class Span:
    trace_id: str
    span_id: str
    parent_span_id: str
    service: str
    name: str
    kind: str
    start_ns: int
    duration_ns: int
    status: str = "Ok"
    status_message: str = ""
    attrs: Dict[str, str] = field(default_factory=dict)
    resource_attrs: Dict[str, str] = field(default_factory=dict)
    events: List[Tuple[int, str, Dict[str, str]]] = field(default_factory=list)
    links: List[Tuple[str, str, Dict[str, str]]] = field(default_factory=list)

    def end_ns(self) -> int:
        return self.start_ns + self.duration_ns

    def row(self) -> dict:
        return {
            "Timestamp": dt64(self.start_ns),
            "TraceId": self.trace_id,
            "SpanId": self.span_id,
            "ParentSpanId": self.parent_span_id,
            "TraceState": "",
            "SpanName": self.name,
            "SpanKind": self.kind,
            "ServiceName": self.service,
            "ResourceAttributes": self.resource_attrs,
            "ScopeName": self.attrs.get("otel.scope.name", self.service),
            "ScopeVersion": "1.0.0",
            "SpanAttributes": self.attrs,
            "Duration": self.duration_ns,
            "StatusCode": self.status,
            "StatusMessage": self.status_message,
            "Events.Timestamp": [dt64(ts) for ts, _, _ in self.events],
            "Events.Name": [name for _, name, _ in self.events],
            "Events.Attributes": [attrs for _, _, attrs in self.events],
            "Links.TraceId": [trace_id for trace_id, _, _ in self.links],
            "Links.SpanId": [span_id for _, span_id, _ in self.links],
            "Links.TraceState": ["" for _ in self.links],
            "Links.Attributes": [attrs for _, _, attrs in self.links],
        }


def span_attributes(rng: random.Random, service: str, operation: str, request_id: str) -> Dict[str, str]:
    attrs: Dict[str, str] = {
        "app.request_id": request_id,
        "otel.scope.name": service,
    }
    low = operation.lower()

    if "http " in low or "authorize" in low or "fetch" in low or "deliver" in low:
        attrs.update({
            "http.request.method": "POST" if "post" in low or "authorize" in low else "GET",
            "http.response.status_code": "200",
            "server.address": "internal.service",
        })
        if "fetch" in low or "deliver" in low:
            attrs["url.full"] = rng.choice(HTTP_ENDPOINTS)

    if "send" in low or "receive" in low:
        topic = rng.choice(KAFKA_TOPICS)
        attrs.update({
            "messaging.system": "kafka",
            "messaging.destination.name": topic,
            "messaging.destination.partition.id": str(rng.randrange(0, 24)),
            "messaging.kafka.message.offset": str(rng.randrange(1_000_000, 25_000_000)),
            "messaging.message.id": f"{topic}.{rng.randrange(0,24)}.{rng.randrange(1_000_000,25_000_000)}",
            "messaging.operation.type": "receive" if "receive" in low else "publish",
        })

    if "clickhouse" in low or "persist" in low or "write" in low:
        table = rng.choice(DB_TABLES)
        namespace, name = table.split(".", 1)
        attrs.update({
            "db.system": "clickhouse",
            "db.namespace": namespace,
            "db.collection.name": name,
            "db.table": table,
            "db.operation.name": "insert" if any(token in low for token in ("insert", "persist", "write")) else "select",
            "db.rows_affected": str(rng.choice([1, 1, 4, 16, 128, 1024, 12_480])),
            "server.address": "clickhouse",
            "server.port": "9000",
        })

    if "cache" in low or "session.lookup" in low:
        attrs.update({
            "db.system": "redis",
            "cache.hit": "true" if rng.random() < 0.78 else "false",
            "server.address": "redis",
            "server.port": "6379",
        })

    if "worker" in service or "worker" in low:
        attrs["worker.id"] = str(rng.randrange(0, 32))

    return attrs


def add_event(rng: random.Random, span: Span) -> None:
    if span.duration_ns <= 2:
        return
    at = span.start_ns + rng.randint(1, max(1, span.duration_ns - 1))
    name = rng.choice(EVENT_NAMES)
    attrs = {
        "event": name,
        "synthetic": "true",
        "sequence": str(rng.randrange(1, 10_000)),
    }
    if "batch" in name:
        attrs["batch.size"] = str(rng.randrange(1, 32))
    span.events.append((at, name, attrs))


def create_span(
    rng: random.Random,
    trace_id: str,
    service: str,
    operation: str,
    kind: str,
    start_ns: int,
    duration_ns: int,
    parent: Optional[Span],
    request_id: str,
    error_rate: float,
) -> Span:
    status = "Error" if rng.random() < error_rate else "Ok"
    message = rng.choice([
        "upstream timeout",
        "dependency unavailable",
        "write rejected",
        "payload decode failed",
        "queue deadline exceeded",
    ]) if status == "Error" else ""

    span = Span(
        trace_id=trace_id,
        span_id=hex_id(rng, 8),
        parent_span_id=parent.span_id if parent else "",
        service=service,
        name=operation,
        kind=kind,
        start_ns=start_ns,
        duration_ns=max(1, duration_ns),
        status=status,
        status_message=message,
        attrs=span_attributes(rng, service, operation, request_id),
        resource_attrs={
            "service.name": service,
            "service.instance.id": f"{service}.i{rng.randrange(0, 12):02d}",
            "deployment.environment.name": "test",
            "telemetry.synthetic": "true",
        },
    )
    if rng.random() < 0.28:
        add_event(rng, span)
    return span


def child_window(rng: random.Random, parent: Span, duration: int, skew_ns: int = 0) -> int:
    room = max(1, parent.duration_ns - max(1, duration))
    return parent.start_ns + rng.randint(0, room) + skew_ns


def generate_trace(
    rng: random.Random,
    base_ns: int,
    min_spans: int,
    max_spans: int,
    error_rate: float,
    trace_index: int,
) -> List[Span]:
    trace_id = hex_id(rng, 16)
    request_id = f"req-{trace_index:06d}-{hex_id(rng, 4)}"
    root_duration = rng.randint(1_500, 4_600) * MS
    root = create_span(
        rng, trace_id, "edge_gateway", "HTTP POST /v1/events", "Server",
        base_ns, root_duration, None, request_id, error_rate * 0.25,
    )
    spans: List[Span] = [root]

    def add(service: str, op: str, kind: str, parent: Span, duration: Optional[int] = None, skew_ms: int = 0) -> Span:
        d = duration if duration is not None else rand_duration(rng, op)
        d = min(d, max(1, parent.duration_ns))
        start = child_window(rng, parent, d, skew_ms * MS)
        s = create_span(rng, trace_id, service, op, kind, start, d, parent, request_id, error_rate)
        spans.append(s)
        return s

    # Main synchronous ingress path.
    route = add("edge_gateway", "gateway.route", "Internal", root, rng.randint(2, 20) * MS)
    validate = add("api_service", "request.validate", "Internal", root, rng.randint(1, 30) * MS)
    auth_client = add("api_service", "auth.check", "Client", root, rng.randint(20, 180) * MS)
    auth_server = add("auth_service", "POST /internal/authorize", "Server", auth_client, rng.randint(15, 160) * MS)
    session = add("auth_service", "session.lookup", "Client", auth_server, rng.randint(100, 9000) * US)
    policy = add("auth_service", "policy.evaluate", "Internal", auth_server, rng.randint(300, 20_000) * US)

    # Asynchronous Kafka pipeline.
    raw_send = add("api_service", "events.raw send", "Producer", root, rng.randint(30, 300) * US)
    ingest_receive = add("event_ingest", "events.raw receive", "Consumer", root, rng.randint(40, 500) * US, skew_ms=rng.randint(-15, 15))
    decode = add("event_ingest", "event.decode", "Internal", ingest_receive, rng.randint(1, 45) * MS)
    normalize = add("event_ingest", "event.normalize", "Internal", root, rng.randint(25, 240) * MS)
    normalized_send = add("event_ingest", "events.normalized send", "Producer", normalize, rng.randint(30, 250) * US)

    worker_receive = add("processing_worker", "events.normalized receive", "Consumer", root, rng.randint(40, 500) * US, skew_ms=rng.randint(-20, 20))
    job = add("processing_worker", "job.process", "Internal", root, rng.randint(500, 1_900) * MS)
    job_validate = add("processing_worker", "job.validate", "Internal", job, rng.randint(1, 35) * MS)
    cache_lookup = add("processing_worker", "cache.lookup", "Client", job, rng.randint(100, 12_000) * US)
    cache_get = add("cache_service", "cache.get", "Client", cache_lookup, rng.randint(100, 9000) * US)
    if rng.random() < 0.45:
        add("cache_service", "cache.set", "Client", cache_lookup, rng.randint(100, 9000) * US)

    enrich_send = add("processing_worker", "enrichment.request send", "Producer", job, rng.randint(20, 180) * US)
    enrich_receive = add("enrichment_worker", "enrichment.request receive", "Consumer", root, rng.randint(30, 300) * US, skew_ms=rng.randint(-20, 20))
    enrich_fetch = add("enrichment_worker", "enrichment.fetch", "Client", root, rng.randint(20, 320) * MS)
    enrich_merge = add("enrichment_worker", "enrichment.merge", "Internal", root, rng.randint(5, 120) * MS)
    enrich_result = add("enrichment_worker", "enrichment.result send", "Producer", root, rng.randint(20, 180) * US)

    write_send = add("processing_worker", "analytics.write send", "Producer", job, rng.randint(20, 220) * US)
    write_receive = add("clickhouse_writer", "analytics.write receive", "Consumer", root, rng.randint(40, 400) * US, skew_ms=rng.randint(-20, 20))
    decode_write = add("clickhouse_writer", "clickhouse.decode", "Internal", root, rng.randint(1, 70) * MS)
    for _ in range(rng.randint(2, 5)):
        add("clickhouse_writer", "clickhouse.insert", "Client", root, rng.randint(40, 240) * MS)
    commit = add("clickhouse_writer", "clickhouse.commit", "Internal", root, rng.randint(100, 7000) * US)

    notify_send = add("notification_worker", "notifications send", "Producer", job, rng.randint(20, 180) * US)
    notify_receive = add("notification_worker", "notifications receive", "Consumer", root, rng.randint(30, 300) * US)
    render = add("notification_worker", "notification.render", "Internal", root, rng.randint(2, 50) * MS)
    deliver = add("notification_worker", "notification.deliver", "Client", root, rng.randint(15, 260) * MS)

    # test_* branch exists intentionally to exercise service_allowlist globs.
    test_ingest = add("test_ingest", "test.input receive", "Consumer", root, rng.randint(10, 80) * MS)
    test_worker = add("test_worker", "test.worker.process", "Internal", test_ingest, rng.randint(5, 60) * MS)
    test_enrich = add("test_enrichment", "test.enrichment.fetch", "Client", test_worker, rng.randint(1, 30) * MS)

    # Links model asynchronous hand-offs without turning them into parent edges.
    for source, target in [
        (ingest_receive, raw_send),
        (worker_receive, normalized_send),
        (enrich_receive, enrich_send),
        (write_receive, write_send),
        (notify_receive, notify_send),
        (test_enrich, test_worker),
    ]:
        source.links.append((trace_id, target.span_id, {"link.type": "synthetic_async_handoff"}))

    target_count = rng.randint(min_spans, max_spans)
    candidates = spans[:]
    while len(spans) < target_count:
        parent = rng.choice(candidates)
        service = rng.choice(SERVICES)
        operation, kind = rng.choice(OPERATIONS[service])
        duration = min(rand_duration(rng, operation), max(1, int(parent.duration_ns * rng.uniform(0.12, 0.82))))
        child = add(service, operation, kind, parent, max(duration, 1))
        candidates.append(child)
        if rng.random() < 0.12 and len(spans) > 3:
            other = rng.choice(spans[:-1])
            child.links.append((trace_id, other.span_id, {"link.type": "synthetic_dependency"}))

    if not any(s.events for s in spans):
        add_event(rng, rng.choice(spans))
    return spans


def write_json_line(fh, row: dict) -> None:
    fh.write(json.dumps(row, separators=(",", ":"), sort_keys=False))
    fh.write("\n")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--traces", type=int, default=100, help="number of traces (default: 100)")
    p.add_argument("--min-spans", type=int, default=60, help="minimum spans per trace (default: 60)")
    p.add_argument("--max-spans", type=int, default=90, help="maximum spans per trace (default: 90)")
    p.add_argument("--spread-minutes", type=int, default=55, help="spread trace starts over the previous N minutes")
    p.add_argument("--error-rate", type=float, default=0.0002, help="per-span error probability")
    p.add_argument("--seed", type=int, default=20260918, help="deterministic RNG seed")
    p.add_argument("--output-dir", default="./generated-otel-traces", help="output directory")
    p.add_argument("--progress-every", type=int, default=250, help="print progress every N traces (default: 250)")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    if args.traces < 1:
        raise SystemExit("--traces must be >= 1")
    if args.min_spans < 10 or args.max_spans < args.min_spans:
        raise SystemExit("require 10 <= --min-spans <= --max-spans")
    if args.spread_minutes < 0:
        raise SystemExit("--spread-minutes must be >= 0")
    if not 0.0 <= args.error_rate <= 1.0:
        raise SystemExit("--error-rate must be between 0 and 1")
    if args.progress_every < 1:
        raise SystemExit("--progress-every must be >= 1")

    rng = random.Random(args.seed)
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)

    now_ns = int(datetime.now(tz=timezone.utc).timestamp() * NS)
    manifest_traces: List[dict] = []
    services = set()
    span_count = 0

    traces_path = output / "otel_traces.jsonl"
    index_path = output / "otel_traces_trace_id_ts.jsonl"
    manifest_path = output / "manifest.json"

    with traces_path.open("w", encoding="utf-8") as traces_fh, index_path.open("w", encoding="utf-8") as index_fh:
        for i in range(args.traces):
            back_ns = rng.randint(0, args.spread_minutes * 60 * NS) if args.spread_minutes else 0
            base_ns = now_ns - back_ns
            spans = generate_trace(rng, base_ns, args.min_spans, args.max_spans, args.error_rate, i)
            spans.sort(key=lambda s: (s.start_ns, s.span_id))

            for span in spans:
                write_json_line(traces_fh, span.row())
                services.add(span.service)
            span_count += len(spans)

            start_ns = min(s.start_ns for s in spans)
            end_ns = max(s.end_ns() for s in spans)
            write_json_line(index_fh, {"TraceId": spans[0].trace_id, "Start": dt64(start_ns), "End": dt64(end_ns)})
            manifest_traces.append({
                "trace_id": spans[0].trace_id,
                "span_count": len(spans),
                "service_count": len({s.service for s in spans}),
                "start": dt64(start_ns),
                "end": dt64(end_ns),
                "error_count": sum(1 for s in spans if s.status == "Error"),
            })

            completed = i + 1
            if completed % args.progress_every == 0 or completed == args.traces:
                print(f"generated {completed}/{args.traces} traces / {span_count} spans", flush=True)

    manifest_path.write_text(json.dumps({
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "seed": args.seed,
        "trace_count": args.traces,
        "span_count": span_count,
        "services": sorted(services),
        "traces": manifest_traces,
    }, indent=2), encoding="utf-8")

    print(f"generated {args.traces} traces / {span_count} spans")
    print(f"traces:   {traces_path}")
    print(f"index:    {index_path}")
    print(f"manifest: {manifest_path}")
    print("first trace URL id:", manifest_traces[0]["trace_id"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
