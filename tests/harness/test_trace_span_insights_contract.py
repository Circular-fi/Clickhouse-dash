"""Source contract: span insights (exceptions, highlighted attributes,
linked-from lookups, surrounding context) keep their bounded, allowlisted SQL
and their configuration and page wiring."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def handler(api: str, name: str) -> str:
    start = api.index(f"void Server::{name}(")
    end = api.find("\nvoid Server::", start + 1)
    return api[start:end if end > 0 else len(api)]


def test_linked_from_and_context_sql_is_bounded_and_allowlisted():
    api = read("src/api_traces.cpp")
    server = read("src/server.cpp")
    assert '"/api/traces/linked_from"' in server and '"/api/traces/context"' in server

    linked = handler(api, "handle_traces_linked_from")
    assert "service_allowlist_predicate(cfg_.traces)" in linked
    assert "trace_time_predicate(lo_ms, hi_ms)" in linked
    assert "linked_from_margin_minutes" in linked
    assert 'PREWHERE has(Links.TraceId, trace)' in linked
    assert "arrayExists((t, s) -> " in linked
    assert "TraceId != trace" in linked
    assert "LIMIT \" + std::to_string(kLinkedFromLimit + 1)" in linked
    assert "max_execution_time" in linked
    assert "features.links" in linked
    assert "max_lookback_minutes" in linked

    context = handler(api, "handle_traces_context")
    assert "service_allowlist_predicate(cfg_.traces)" in context
    assert "Timestamp >= \" + ns_time(lo_ns) + \" AND Timestamp <= \" + ns_time(hi_ns)" in context
    assert "kContextWindowsMs" in context
    assert "max_execution_time" in context
    assert "int_param(req, \"limit\", 50, 1, 200)" in context
    assert "ORDER BY Timestamp DESC, SpanId DESC" in context and "ORDER BY Timestamp ASC, SpanId ASC" in context
    assert "features.resource_attributes" in context and "features.span_attributes" in context
    assert re.search(r"kContextWindowsMs\[\] = \{1000, 10000, 60000, 300000\}", api)


def test_trace_insight_settings_are_configured_validated_and_documented():
    header = read("src/server.hpp")
    config = read("src/config.cpp")
    api = read("src/api_traces.cpp")
    example = read("config.example.hcl")
    docs = read("docs/traces.md")
    assert "highlighted_attributes" in header and "linked_from_margin_minutes = 60" in header
    assert '"highlighted_attributes", "linked_from_margin_minutes"' in config
    assert "traces.highlighted_attributes accepts at most 32 keys" in config
    assert "traces.linked_from_margin_minutes must be between 1 and 1440" in config
    assert 'w.Key("highlighted_attributes")' in api and 'w.Key("context_windows_ms")' in api
    assert "highlighted_attributes" in example and "linked_from_margin_minutes" in example
    for text in ("highlighted_attributes", "linked_from_margin_minutes", "/api/traces/linked_from", "/api/traces/context"):
        assert text in docs, text


def test_trace_page_loads_the_insights_module():
    bootstrap = read("src/static/modules.json")  # the module lists, in load order
    traces = read("src/static/app_traces.js")
    insights = read("src/static/app_trace_insights.js")
    html = read("src/static/observability.html")
    assert '"app_trace_views.js", "app_trace_insights.js"' in bootstrap
    assert 'id="traceHighlights"' in html
    for hook in ("exceptionBadgeHtml(span)", "exceptionSectionHtml(span, bounds)", "traceExceptionTagHtml(cache)",
                 "renderHighlights(cache)", "linkedFromRemoteHtml(span, cache)", "handleInspectorClick(event, target)",
                 "onSectionToggle(spanId, key, details.open)", "data-span-context"):
        assert hook in traces, hook
    assert "ns.traceInsights = {" in insights
    assert "getTraceLinkedFrom" in insights and "getTraceContext" in insights
