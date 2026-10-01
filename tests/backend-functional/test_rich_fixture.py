"""Trace Explorer features on the rich OTel dataset (2026-09-12 UTC).

tests/otel-fixture/rich_fixture.py loads a deterministic e-commerce workload
on that day (tests/README.md, "Rich OTel dataset"): nested traces through
api-gateway -> frontend -> checkout / payments / inventory / auth / search /
recommendation / notification, HTTP / gRPC / database / Kafka spans, errors
deep in branches with exception events, cross-trace links, orphan spans,
very large traces, release versions, a slow cohort explained by one span
attribute, and correlated logs and metrics. Every check compares an API
answer with ground truth read from ClickHouse over the same window. The
module skips when the rich day is not loaded.
"""
from __future__ import annotations

import json
import os
from collections import Counter

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})
CH_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CH_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))

DAY_MS = 1_789_171_200_000  # 2026-09-12 00:00:00 UTC
HOUR = 3_600_000
MINUTE = 60_000
# A busy hour without batch jobs or releases: 09:00-10:00.
H9 = (DAY_MS + 9 * HOUR, DAY_MS + 10 * HOUR)
INCIDENT = (DAY_MS + 14 * HOUR, DAY_MS + 16 * HOUR)
# From 13:30 to 16:30 no trace but the cohort takes 1.5 s or more.
QUIET = (DAY_MS + 13 * HOUR + 30 * MINUTE, DAY_MS + 16 * HOUR + 30 * MINUTE)
RICH_SERVICES = {"api-gateway", "frontend", "checkout", "payments", "inventory", "auth", "search", "recommendation", "notification"}


def get(path: str, **params) -> dict:
    response = SESSION.get(f"{BASE_URL}{path}", params={"host_id": "local", **params}, timeout=120)
    assert response.status_code == 200, (path, params, response.text)
    return response.json()


def ch_rows(sql: str) -> list[dict]:
    response = requests.post(CH_URL + "/", data=(sql + " FORMAT JSONEachRow SETTINGS output_format_json_quote_64bit_integers = 0").encode(),
                             auth=CH_AUTH, timeout=300)
    assert response.status_code == 200, response.text
    return [json.loads(line) for line in response.text.splitlines() if line.strip()]


def lit(value) -> str:
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def window(lo_ms: int, hi_ms: int, column: str = "Timestamp") -> str:
    return f"{column} >= fromUnixTimestamp64Milli({lo_ms}) AND {column} < fromUnixTimestamp64Milli({hi_ms})"


@pytest.fixture(scope="module", autouse=True)
def rich():
    rows = ch_rows("SELECT coalesce(sum(rows), 0) AS n FROM system.parts WHERE active AND database = 'otel' "
                   "AND table = 'otel_traces' AND partition_id = '20260912'")
    if not rows or not rows[0]["n"]:
        pytest.skip("the rich OTel dataset (2026-09-12) is not loaded")
    response = SESSION.get(f"{BASE_URL}/api/traces/meta", params={"host_id": "local"}, timeout=30)
    if response.status_code == 404:
        pytest.skip("Trace Explorer disabled in this configuration")
    assert response.status_code == 200, response.text
    return response.json()


def detail(trace_id: str) -> dict:
    return get("/api/traces/trace", trace_id=trace_id)


def depth_of(spans: list[dict]) -> int:
    by_id = {s["span_id"]: s for s in spans}
    best = 0
    for span in spans:
        d, cur = 1, span
        while cur["parent_span_id"] in by_id and d <= len(spans):
            cur = by_id[cur["parent_span_id"]]
            d += 1
        best = max(best, d)
    return best


def first_trace(sql_where: str, lo_ms: int, hi_ms: int) -> str:
    rows = ch_rows(f"SELECT TraceId FROM otel.otel_traces WHERE {window(lo_ms, hi_ms)} AND {sql_where} "
                   "ORDER BY Timestamp, TraceId LIMIT 1")
    assert rows, sql_where
    return rows[0]["TraceId"]


# ------------------------------------------------------------- trace shapes

def test_checkout_trace_is_nested_across_services_and_protocols():
    # A complete checkout: its order message was processed by notification.
    trace_id = first_trace("SpanName = 'process orders' AND ServiceName = 'notification' AND StatusCode != 'Error'", *H9)
    body = detail(trace_id)
    spans = body["spans"]
    truth = ch_rows(f"SELECT count() AS n FROM otel.otel_traces WHERE {window(*H9)} AND TraceId = {lit(trace_id)}")[0]["n"]
    assert body["truncated"] is False and len(spans) == truth
    assert depth_of(spans) >= 9
    assert {"api-gateway", "frontend", "auth", "checkout", "inventory", "payments", "notification"} <= {s["service_name"] for s in spans}
    assert {s["span_kind"] for s in spans} == {"Server", "Client", "Internal", "Producer", "Consumer"}
    by_id = {s["span_id"]: s for s in spans}
    attrs = {s["span_id"]: json.loads(s["span_attributes"]) for s in spans}
    # Every non-root Server span is called by a Client span of another service.
    servers = [s for s in spans if s["span_kind"] == "Server" and s["parent_span_id"]]
    assert servers
    for s in servers:
        parent = by_id[s["parent_span_id"]]
        assert parent["span_kind"] == "Client" and parent["service_name"] != s["service_name"], s["span_name"]
    # Semantic-convention attributes of each protocol.
    systems = {a.get("db.system") for a in attrs.values()} - {None}
    assert {"postgresql", "redis"} <= systems
    assert any(a.get("rpc.system") == "grpc" and a.get("rpc.service") == "shop.inventory.v1.InventoryService" for a in attrs.values())
    assert any(a.get("http.route") == "/v1/charges" and a.get("http.response.status_code") == "201" for a in attrs.values())
    producer = next(s for s in spans if s["span_kind"] == "Producer")
    consumer = next(s for s in spans if s["span_kind"] == "Consumer")
    assert consumer["parent_span_id"] == producer["span_id"]
    assert attrs[producer["span_id"]]["messaging.destination.name"] == "orders" == attrs[consumer["span_id"]]["messaging.destination.name"]
    resource = json.loads(spans[0]["resource_attributes"])
    for key in ("service.version", "host.name", "k8s.pod.name", "k8s.namespace.name", "deployment.environment.name",
                "telemetry.sdk.language"):
        assert resource.get(key), key


def test_orphan_spans_make_incomplete_traces():
    rows = ch_rows(
        "SELECT TraceId, length(arrayDistinct(arrayFilter(p -> p != '' AND NOT has(ids, p), parents))) AS missing, "
        "length(arrayFilter(p -> p = '' OR NOT has(ids, p), parents)) AS roots FROM ("
        f"SELECT TraceId, groupArray(SpanId) AS ids, groupArray(ParentSpanId) AS parents FROM otel.otel_traces "
        f"WHERE {window(*H9)} GROUP BY TraceId) WHERE missing > 0 ORDER BY TraceId LIMIT 3")
    assert len(rows) == 3, "the rich hour holds traces with dropped spans"
    for row in rows:
        spans = detail(row["TraceId"])["spans"]
        # Detail shows the spans of a dropped parent as extra roots.
        assert sum(1 for s in spans if not s["parent_span_id"]) == row["roots"] >= 1
        start = min(int(s["start_ns"]) for s in spans) // 1_000_000
        found = get("/api/traces/search", start_ms=start - 1, end_ms=start + MINUTE, limit=100)
        assert len(found["rows"]) < 100
        cols = found["columns"]
        listed = {r[cols.index("trace_id")]: r[cols.index("missing_parents")] for r in found["rows"]}
        assert listed.get(row["TraceId"]) == row["missing"], (row, listed)


STACK_MARKERS = {
    "java.lang.NullPointerException": "\tat com.shop.checkout.pricing.TaxCalculator.compute(TaxCalculator.java:87)",
    "KeyError": "Traceback (most recent call last):",
    "*url.Error": "goroutine 1187 [running]:",
    "TypeError": "    at CartService.addItem (/app/src/services/cart.js:47:31)",
    "System.Net.Mail.SmtpException": "   at Shop.Notification.Senders.SmtpSender.SendAsync",
}


@pytest.mark.parametrize("exception_type", sorted(STACK_MARKERS))
def test_exception_events_carry_language_stack_traces(exception_type):
    rows = ch_rows(
        f"SELECT TraceId, SpanId FROM otel.otel_traces WHERE {window(DAY_MS, DAY_MS + 24 * HOUR)} "
        f"AND arrayExists((n, a) -> n = 'exception' AND a['exception.type'] = {lit(exception_type)}, Events.Name, Events.Attributes) "
        "ORDER BY Timestamp, SpanId LIMIT 1")
    assert rows, exception_type
    spans = detail(rows[0]["TraceId"])["spans"]
    span = next(s for s in spans if s["span_id"] == rows[0]["SpanId"])
    assert span["status_code"] == "Error" and span["status_message"]
    names = json.loads(span["events_name"])
    events = [a for n, a in zip(names, json.loads(span["events_attributes"])) if n == "exception"]
    assert events and events[0]["exception.type"] == exception_type
    assert STACK_MARKERS[exception_type] in events[0]["exception.stacktrace"]
    assert events[0]["exception.escaped"] in ("true", "false") and events[0]["exception.message"]
    root = next(s for s in spans if not s["parent_span_id"]) if any(not s["parent_span_id"] for s in spans) else None
    if root is not None and exception_type == "System.Net.Mail.SmtpException":
        # Deep in the order-confirmation branch: the request itself succeeded.
        assert root["status_code"] != "Error"
    if root is not None and exception_type == "java.lang.NullPointerException":
        assert root["status_code"] == "Error"


def test_large_traces_and_the_span_limit(rich):
    jobs = ch_rows(
        f"SELECT TraceId, count() AS n FROM otel.otel_traces WHERE {window(DAY_MS, DAY_MS + 24 * HOUR)} AND ServiceName = 'search' "
        "AND TraceId IN (SELECT TraceId FROM otel.otel_traces WHERE " + window(DAY_MS, DAY_MS + 24 * HOUR) +
        " AND SpanName = 'catalog.reindex') GROUP BY TraceId ORDER BY n")
    jobs_all = {r["TraceId"]: ch_rows(f"SELECT count() AS n FROM otel.otel_traces WHERE {window(DAY_MS, DAY_MS + 24 * HOUR)} "
                                      f"AND TraceId = {lit(r['TraceId'])}")[0]["n"] for r in jobs}
    sizes = sorted(jobs_all.values())
    assert len(sizes) == 5 and sizes[0] >= 1900 and sizes[-1] > rich["max_spans_per_trace"]
    for trace_id, n in jobs_all.items():
        body = detail(trace_id)
        if n > rich["max_spans_per_trace"]:
            assert body["truncated"] is True and len(body["spans"]) == rich["max_spans_per_trace"]
        else:
            assert body["truncated"] is False and len(body["spans"]) == n
        # Tens of seconds, exported in several batches: several index rows.
        index = ch_rows(f"SELECT count() AS n FROM otel.otel_traces_trace_id_ts WHERE TraceId = {lit(trace_id)}")[0]["n"]
        assert index > 1


# ------------------------------------------------------------ links / context

def test_linked_from_finds_the_consumer_batch_of_a_producer():
    batch = ch_rows(
        f"SELECT TraceId, SpanId, Links.TraceId AS lt, Links.SpanId AS ls FROM otel.otel_traces WHERE {window(*H9)} "
        "AND SpanName = 'receive orders' AND length(Links.TraceId) >= 2 ORDER BY Timestamp LIMIT 1")[0]
    target_trace, target_span = batch["lt"][0], batch["ls"][0]
    producer = detail(target_trace)["spans"]
    assert any(s["span_id"] == target_span and s["span_kind"] == "Producer" for s in producer)
    truth = {(r["TraceId"], r["SpanId"]) for r in ch_rows(
        f"SELECT TraceId, SpanId FROM otel.otel_traces WHERE {window(H9[0] - 2 * HOUR, H9[1] + 2 * HOUR)} "
        f"AND arrayExists((t, s) -> t = {lit(target_trace)} AND s = {lit(target_span)}, Links.TraceId, Links.SpanId)")}
    # The batch root and the per-message span (follows-from) both link to it.
    assert len(truth) == 2 and (batch["TraceId"], batch["SpanId"]) in truth
    for params in ({"trace_id": target_trace, "span_id": target_span}, {"trace_id": target_trace}):
        body = get("/api/traces/linked_from", **params)
        assert body["range_source"] == "trace_index"
        assert {(r["trace_id"], r["span_id"]) for r in body["rows"]} == truth
        assert all(r["span_kind"] == "Consumer" and r["service_name"] == "inventory" for r in body["rows"])


def _context_truth(anchor_ns: int, window_ms: int, predicate: str, keyset: str, order: str, limit: int) -> list[tuple[str, str]]:
    w = window_ms * 1_000_000
    return [(str(r["ts"]), r["SpanId"]) for r in ch_rows(
        f"SELECT toString(toUnixTimestamp64Nano(Timestamp)) AS ts, SpanId FROM otel.otel_traces "
        f"WHERE Timestamp >= fromUnixTimestamp64Nano({anchor_ns - w}) AND Timestamp <= fromUnixTimestamp64Nano({anchor_ns + w}) "
        f"AND {predicate} AND {keyset} ORDER BY Timestamp {order}, SpanId {order} LIMIT {limit}")]


@pytest.mark.parametrize("filter_name,key", [("host", "host.name"), ("pod", "k8s.pod.name")])
def test_context_same_host_and_same_pod(filter_name, key):
    trace_id = first_trace("SpanName = 'POST /v1/checkout' AND SpanKind = 'Server'", *H9)
    span = next(s for s in detail(trace_id)["spans"] if s["service_name"] == "checkout" and s["span_kind"] == "Server")
    value = json.loads(span["resource_attributes"])[key]
    anchor = int(span["start_ns"])
    body = get("/api/traces/context", timestamp_ns=anchor, window_ms=60_000, filter=filter_name, value=value, limit=20)
    predicate = f"ResourceAttributes[{lit(key)}] = {lit(value)}"
    newer = _context_truth(anchor, 60_000, predicate, f"Timestamp > fromUnixTimestamp64Nano({anchor})", "ASC", 11)
    older = _context_truth(anchor, 60_000, predicate, f"Timestamp <= fromUnixTimestamp64Nano({anchor})", "DESC", 11)
    assert [(r["start_ns_text"], r["span_id"]) for r in body["rows"]] == list(reversed(newer[:10])) + older[:10]
    assert len(body["rows"]) == 20 and span["span_id"] in {r["span_id"] for r in body["rows"]}
    # A node hosts several services; a pod runs one.
    services = {r["service_name"] for r in body["rows"]}
    assert len(services) >= 2 if filter_name == "host" else services == {"checkout"}


# ------------------------------------------------------------- search pages

def test_service_map_edges_equal_the_parent_child_calls():
    body = get("/api/traces/service_map", start_ms=H9[0], end_ms=H9[1])
    assert body["sampled"] is False
    got = {(e["source"], e["target"]): e["calls"] for e in body["edges"]}
    truth = {(r["a"], r["b"]): r["n"] for r in ch_rows(
        f"SELECT p.svc AS a, c.svc AS b, count() AS n FROM "
        f"(SELECT TraceId, ParentSpanId, toString(ServiceName) AS svc FROM otel.otel_traces WHERE {window(*H9)}) AS c "
        f"INNER JOIN (SELECT TraceId, SpanId, toString(ServiceName) AS svc FROM otel.otel_traces WHERE {window(*H9)}) AS p "
        "ON c.TraceId = p.TraceId AND c.ParentSpanId = p.SpanId WHERE a != b GROUP BY a, b")}
    assert got == truth
    for edge in [("api-gateway", "frontend"), ("frontend", "checkout"), ("checkout", "payments"), ("checkout", "inventory"),
                 ("checkout", "notification"), ("frontend", "auth"), ("frontend", "search"), ("frontend", "recommendation"),
                 ("frontend", "inventory")]:
        assert got.get(edge, 0) > 0, edge
    nodes = {n["service"] if "service" in n else n.get("name"): n for n in body["nodes"]}
    assert RICH_SERVICES <= set(nodes)


def test_facets_list_semantic_convention_keys():
    body = get("/api/traces/facets", start_ms=H9[0], end_ms=H9[1])
    keys = {(scope, key) for scope, key, _ in body["keys"]}
    for wanted in [("span", "http.route"), ("span", "http.response.status_code"), ("span", "db.system"), ("span", "db.query.text"),
                   ("span", "rpc.method"), ("span", "messaging.system"), ("span", "error.type"),
                   ("resource", "host.name"), ("resource", "k8s.pod.name"), ("resource", "service.version")]:
        assert wanted in keys, wanted
    values = get("/api/traces/facet_values", start_ms=H9[0], end_ms=H9[1], scope="span", key="db.system")
    truth = {r["v"]: r["n"] for r in ch_rows(
        f"SELECT SpanAttributes['db.system'] AS v, count() AS n FROM otel.otel_traces WHERE {window(*H9)} "
        "AND mapContains(SpanAttributes, 'db.system') GROUP BY v")}
    assert set(truth) == {"postgresql", "redis", "clickhouse"}
    assert {v: n for v, n in values["values"]} == truth


def _search_ids(params: list[tuple[str, str]]) -> set[str]:
    response = SESSION.get(f"{BASE_URL}/api/traces/search", params=[("host_id", "local"), ("start_ms", str(H9[0])),
                                                                     ("end_ms", str(H9[1] - 1)), ("limit", "100")] + params, timeout=120)
    assert response.status_code == 200, response.text
    found = response.json()
    assert len(found["rows"]) < 100, "the filter must stay selective to compare whole sets"
    return {r[found["columns"].index("trace_id")] for r in found["rows"]}


def _traces_with_span(predicate: str) -> set[str]:
    return {r["TraceId"] for r in ch_rows(
        f"SELECT DISTINCT TraceId FROM otel.otel_traces WHERE {window(H9[0], H9[1] - 1)} AND {predicate}")}


def test_multi_tag_filters_on_status_codes():
    # = and != on different keys: one span must satisfy both.
    got = _search_ids([("tag", "span:http.response.status_code=500"), ("tag_not", "resource:service.name=api-gateway")])
    truth = _traces_with_span("SpanAttributes['http.response.status_code'] = '500' "
                              "AND NOT (mapContains(ResourceAttributes, 'service.name') AND ResourceAttributes['service.name'] = 'api-gateway')")
    assert truth and got == truth
    # Several values of one key: any of them.
    got = _search_ids([("tag", "http.response.status_code=402"), ("tag", "http.response.status_code=409")])
    truth = _traces_with_span("(SpanAttributes['http.response.status_code'] IN ('402', '409') "
                              "OR ResourceAttributes['http.response.status_code'] IN ('402', '409'))")
    assert truth and got == truth
    # != alone on a declined payment: client spans of other services remain.
    got = _search_ids([("tag", "span:http.response.status_code=402"), ("tag_not", "resource:service.name=checkout"),
                       ("status", "Error")])
    truth = _traces_with_span("SpanAttributes['http.response.status_code'] = '402' AND ResourceAttributes['service.name'] != 'checkout' "
                              "AND StatusCode = 'Error'")
    assert truth and got == truth


# ------------------------------------------------------ heatmap / comparison

def test_heatmap_and_deltas_isolate_the_slow_cohort(rich):
    if not rich.get("analytics_enabled"):
        pytest.skip("Trace analytics disabled in this configuration")
    lo, hi = QUIET
    heat = get("/api/traces/heatmap", start_ms=lo, end_ms=hi, rows=30)
    truth = ch_rows(f"SELECT count() AS n, countIf(d >= 1500000000) AS slow, countIf(d >= 1500000000 AND s >= fromUnixTimestamp64Milli({INCIDENT[0]}) "
                    f"AND s < fromUnixTimestamp64Milli({INCIDENT[1]})) AS slow_in FROM (SELECT min(Timestamp) AS s, "
                    "toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - toInt64(min(toUnixTimestamp64Nano(Timestamp))) AS d "
                    f"FROM otel.otel_traces WHERE {window(lo, hi)} GROUP BY TraceId)")[0]
    assert heat["total"] == truth["n"]
    assert truth["slow"] == truth["slow_in"] > 50
    edges = heat["y_edges_ns"]
    # Cells are [bucket_ms, row, traces]: the slow band lies in the incident.
    slow_cells = [c for c in heat["cells"] if edges[c[1]] >= 1.5e9]
    assert slow_cells and all(INCIDENT[0] <= c[0] < INCIDENT[1] for c in slow_cells)
    assert sum(c[2] for c in slow_cells) <= truth["slow"]

    body = get("/api/traces/deltas", start_ms=lo, end_ms=hi, t0=INCIDENT[0], t1=INCIDENT[1], d0=1500, d1=30000)
    assert body["selection"]["sampled"] > 0 and body["baseline_sample"]["sampled"] > 0
    top = body["keys"][0]
    assert (top["scope"], top["key"]) == ("span", "feature.flag"), [(k["scope"], k["key"], k["score"]) for k in body["keys"][:5]]
    assert top["values"][0]["value"] == "new_pricing" and top["values"][0]["selection_pct"] == 100
    assert top["values"][0]["baseline_pct"] < 5
    # The release that shipped the flag is the next best explanation.
    ranked = [(k["scope"], k["key"]) for k in body["keys"]]
    assert ("resource", "service.version") in ranked


def test_release_versions_switch_at_known_times():
    rows = ch_rows(
        f"SELECT ResourceAttributes['service.version'] AS v, toUnixTimestamp64Milli(min(Timestamp)) AS lo, "
        f"toUnixTimestamp64Milli(max(Timestamp)) AS hi FROM otel.otel_traces WHERE {window(DAY_MS, DAY_MS + 24 * HOUR)} "
        "AND ServiceName = 'payments' GROUP BY v ORDER BY lo")
    assert [r["v"] for r in rows] == ["2.3.1", "2.4.0", "2.4.1"]
    assert rows[0]["hi"] < INCIDENT[0] <= rows[1]["lo"] and rows[1]["hi"] < INCIDENT[1] <= rows[2]["lo"]
    values = get("/api/traces/facet_values", start_ms=DAY_MS + 13 * HOUR, end_ms=DAY_MS + 17 * HOUR, scope="resource",
                 key="service.version", service="payments")
    assert {v for v, _ in values["values"]} == {"2.3.1", "2.4.0", "2.4.1"}


# ---------------------------------------------------------------- signals

def test_logs_of_a_failed_checkout_carry_the_exception():
    trace_id = first_trace("arrayExists((n, a) -> n = 'exception' AND a['exception.type'] = 'java.lang.NullPointerException', "
                           "Events.Name, Events.Attributes)", DAY_MS, DAY_MS + 24 * HOUR)
    spans = detail(trace_id)["spans"]
    start_ns = min(int(s["start_ns"]) for s in spans)
    end_ns = max(int(s["start_ns"]) + int(s["duration_ns"]) for s in spans)
    params = [("host_id", "local"), ("trace_id", trace_id), ("start_ns", str(start_ns)), ("end_ns", str(end_ns))]
    params += [("service", s) for s in sorted({s["service_name"] for s in spans})]
    response = SESSION.get(f"{BASE_URL}/api/traces/logs", params=params, timeout=60)
    if response.status_code == 404:
        pytest.skip("logs are disabled in this configuration")
    assert response.status_code == 200, response.text
    body = response.json()
    if not body.get("enabled") or not body.get("table_exists"):
        pytest.skip("logs are disabled in this configuration")
    truth = ch_rows(
        f"SELECT SpanId, SeverityText FROM otel.otel_logs WHERE TimestampTime >= toDateTime({start_ns // 10**9 - 5}) "
        f"AND TimestampTime <= toDateTime({end_ns // 10**9 + 31}) AND TraceId = {lit(trace_id)}")
    assert body["count"] == len(truth) >= 5
    severities = Counter(r["severity_text"] for r in body["logs"])
    assert severities["ERROR"] >= 1 and severities["INFO"] >= 1
    errors = [r for r in body["logs"] if r["severity_text"] == "ERROR" and
              json.loads(r["log_attributes"]).get("exception.type") == "java.lang.NullPointerException"]
    assert errors
    span = next(s for s in spans if s["span_id"] == errors[0]["span_id"])
    event = json.loads(span["events_attributes"])[json.loads(span["events_name"]).index("exception")]
    assert json.loads(errors[0]["log_attributes"])["exception.stacktrace"] == event["exception.stacktrace"]
    # Trace-less records of the same day (pod lifecycle, pool stats) exist too.
    assert ch_rows(f"SELECT count() AS n FROM otel.otel_logs WHERE {window(DAY_MS, DAY_MS + 24 * HOUR, 'TimestampTime')} "
                   "AND TraceId = ''")[0]["n"] > 1000


def _rich_metrics(meta: dict) -> bool:
    rows = ch_rows(f"SELECT coalesce(sum(rows), 0) AS n FROM system.parts WHERE active AND database = {lit(meta['database'])} "
                   f"AND table = {lit(meta['table_prefix'] + '_histogram')} AND partition_id = '20260912'")
    return bool(rows and rows[0]["n"])


def test_metrics_exemplars_resolve_to_rich_traces():
    meta = get("/api/metrics/meta", refresh="1")
    if not meta.get("enabled") or not _rich_metrics(meta):
        pytest.skip("the rich metrics are not loaded in the configured metrics database")
    body = get("/api/metrics/exemplars", kind="histogram", service="checkout", metric="http.server.request.duration",
               start_ms=H9[0], end_ms=H9[1] - 1, bucket_origin_ms=0, step_ms=5 * MINUTE, per_bucket=2)
    exemplars = body["exemplars"]
    assert len(exemplars) == 24 and body["traces_enabled"] is True
    for e in exemplars[:6]:
        spans = detail(e["trace_id"])["spans"]
        span = next(s for s in spans if s["span_id"] == e["span_id"])
        assert span["service_name"] == "checkout" and span["span_kind"] == "Server"
        assert abs(int(span["duration_ns"]) / 1e9 - e["value"]) < 1e-9
        assert e["attributes"]["span.name"] == span["span_name"]
    # process.cpu.utilization per host: payments runs hot during the incident.
    series = get("/api/metrics/series", kind="gauge", service="payments", metric="process.cpu.utilization",
                 start_ms=DAY_MS + 12 * HOUR, end_ms=DAY_MS + 18 * HOUR - 1, bucket_origin_ms=0, step_ms=HOUR, agg="avg",
                 group_by="host.name")
    assert len(series["series"]) >= 2
    for s in series["series"]:
        values = dict(zip(series["timestamps"], s["values"]))
        hot = [v for t, v in values.items() if v is not None and INCIDENT[0] <= t < INCIDENT[1]]
        cold = [v for t, v in values.items() if v is not None and not INCIDENT[0] <= t < INCIDENT[1]]
        if hot and cold:
            assert min(hot) > max(cold)
