"""Source contract: span insights (exceptions, highlighted attributes,
linked-from lookups, surrounding context) keep their bounded, allowlisted SQL
and their configuration and page wiring."""
from pathlib import Path
from trace_sources import read_traces, read_unit
import modules
import re
import config_keys

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
    sql = read_unit("trace_sql.cpp")
    service = read_unit("trace_service.cpp")

    linked_sql = sql[sql.index("std::string linked_from_sql"):sql.index("std::string context_filter_sql")]
    linked = service[service.index("TraceService::linked_from"):service.index("TraceService::context")]
    assert "service_allowlist_predicate(traces)" in linked
    assert "time_predicate(lo_ms, hi_ms)" in linked_sql
    assert "linked_from_margin_minutes" in linked
    assert 'PREWHERE has(Links.TraceId, trace)' in linked_sql
    assert "arrayExists((t, s) -> " in linked_sql
    assert "TraceId != trace" in linked_sql
    assert "LIMIT \" + std::to_string(kLinkedFromLimit + 1)" in linked_sql
    assert "max_execution_time" in linked_sql
    assert "features.links" in linked
    assert "max_lookback_minutes" in linked

    context_sql = sql[sql.index("std::string context_filter_sql"):sql.index("// ---- the span search ----")]
    context = service[service.index("TraceService::context"):service.index("TraceService::spans")]
    assert "service_allowlist_predicate(traces)" in context
    assert "Timestamp >= \" + ns_time(lo_ns) + \" AND Timestamp <= \" + ns_time(hi_ns)" in context_sql
    assert "kContextWindowsMs" in read_unit("trace_request.cpp")
    assert "max_execution_time" in context_sql
    assert "int_param(req, \"limit\", 50, 1, 200)" in read_unit("trace_request.cpp")
    assert "ORDER BY Timestamp DESC, SpanId DESC" in context_sql and "ORDER BY Timestamp ASC, SpanId ASC" in context_sql
    assert "features.resource_attributes" in context and "features.span_attributes" in context
    assert re.search(r"kContextWindowsMs\[\] = \{1000, 10000, 60000, 300000\}", read_unit("trace_sql.hpp"))


def test_trace_insight_settings_are_configured_validated_and_documented():
    header = read("src/otel_settings.hpp")
    config = read("src/config.cpp")
    api = read_traces()
    example = read("config.example.hcl")
    docs = read("docs/traces.md")
    assert "highlighted_attributes" in header and "linked_from_margin_minutes = 60" in header
    assert '"highlighted_attributes"' in config
    assert "highlighted_attributes accepts at most 32 keys" in config
    assert config_keys.bounds("observability.traces", "linked_from_margin_minutes") == (1, 1440)
    assert 'w.Key("highlighted_attributes")' in api and 'w.Key("context_windows_ms")' in api
    assert "highlighted_attributes" in example and "linked_from_margin_minutes" in example
    for text in ("highlighted_attributes", "linked_from_margin_minutes", "/api/traces/linked_from", "/api/traces/context"):
        assert text in docs, text


def test_trace_page_loads_the_insights_module():
    trace_page = modules.page_files("trace")
    traces = read("src/static/app_traces.js")
    insights = read("src/static/app_trace_insights.js")
    html = read("src/static/trace.html")
    assert "app_trace_views.js" in trace_page and "app_trace_insights.js" in trace_page
    assert 'id="traceHighlights"' in html
    for hook in ("exceptionBadgeHtml(span)", "exceptionSectionHtml(span, bounds)", "traceExceptionTagHtml(cache)",
                 "renderHighlights(cache)", "linkedFromRemoteHtml(span, cache)", "handleInspectorClick(event, target)",
                 "onSectionToggle(spanId, key, details.open)", "data-span-context"):
        assert hook in traces, hook
    assert "traceInsights = {" in insights
    assert "getTraceLinkedFrom" in insights and "getTraceContext" in insights
