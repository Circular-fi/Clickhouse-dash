"""Logs in the trace detail page: GET /api/traces/logs and its UI hooks."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_trace_logs_route_is_registered_with_the_trace_routes():
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    traces_block = server.split('http_.Get("/api/traces/meta"', 1)[1].split("  }\n", 1)[0]
    assert 'http_.Get("/api/traces/logs"' in traces_block
    assert "void handle_trace_logs(const httplib::Request& req, httplib::Response& res);" in header
    assert "api_trace_logs.cpp" in read("src/CMakeLists.txt")


def test_trace_logs_query_is_bounded_on_every_side():
    source = read("src/api_trace_logs.cpp")
    # Time range first (partition key + primary key), then the trace's
    # services (primary key prefix), the TraceId bloom filter and the allowlist.
    assert '" PREWHERE " + time_range' in source
    assert '"TimestampTime BETWEEN toDateTime("' in source
    assert '"Timestamp BETWEEN toDateTime64("' in source
    assert 'where += "ServiceName IN ("' in source
    assert 'where += "TraceId = " + allowlist_quote_string(trace_id);' in source
    assert 'where += " AND SpanId = " + allowlist_quote_string(span_id);' in source
    assert 'where += " AND " + otel::service_allowlist_predicate(cfg_.traces);' in source
    assert '" ORDER BY Timestamp LIMIT " + std::to_string(limit + 1)' in source
    assert "max_execution_time = " in source
    assert "const bool truncated = records.size() > limit;" in source
    # No request reads logs without a time range; the range is clamped.
    assert '"missing_time_range"' in source
    assert "logs.max_lookback_minutes" in source and "clamped = true;" in source
    assert "logs.trace_margin_before_seconds" in source and "logs.trace_margin_after_seconds" in source
    # Exact timestamps as text; Map / JSON attributes detected per table.
    assert "toString(toUnixTimestamp64Nano(Timestamp))" in source
    assert 'starts_with(type, "Map(")' in source and 'starts_with(type, "JSON")' in source
    assert "kLogColumnsCacheTtl = std::chrono::seconds(60)" in source
    # Disabled / missing / mismatched sources answer 200 with a reason, never 500.
    for code in ("logs_disabled", "logs_table_missing", "logs_schema_mismatch", "logs_trace_correlation_unavailable"):
        assert f'"{code}"' in source, code
    assert "json_error(res, 500" not in source
    assert "host->system_uri" in source and "runner_uri" not in source


def test_service_allowlist_predicate_is_shared_by_traces_and_logs():
    allowlist = read("src/otel_allowlist.hpp")
    traces = read("src/api_traces.cpp")
    logs = read("src/api_trace_logs.cpp")
    assert "inline std::string service_allowlist_predicate(const std::vector<std::string>& allowlist)" in allowlist
    assert "using otel::service_allowlist_predicate;" in traces
    assert "std::string service_pattern_predicate(" not in traces
    assert '#include "otel_allowlist.hpp"' in traces and '#include "otel_allowlist.hpp"' in logs


def test_trace_logs_config_keys():
    config = read("src/config.cpp")
    header = read("src/server.hpp")
    assert "size_t trace_logs_limit = 1000;" in header
    assert "int trace_margin_before_seconds = 5;" in header
    assert "int trace_margin_after_seconds = 30;" in header
    assert 'cfg.logs.trace_logs_limit = std::max<size_t>(1, std::min<size_t>(10000, cfg.logs.trace_logs_limit));' in config
    example = read("config.example.hcl")
    assert "trace_logs_limit            = 1000" in example
    assert "trace_margin_after_seconds" in read("docs/logs.md")


def test_trace_page_loads_logs_after_the_trace_and_hooks_them_into_the_waterfall():
    traces = read("src/static/app_traces.js")
    logs = read("src/static/app_trace_logs.js")
    html = read("src/static/traces.html")
    api = read("src/static/app_api.js")
    bootstrap = read("src/static/app_traces_bootstrap.js")
    assert '"app_trace_logs.js"' in bootstrap
    assert bootstrap.index('"app_traces.js"') < bootstrap.index('"app_trace_logs.js"')
    assert 'id="traceLogsPanel"' in html
    assert "async function getTraceLogs(" in api and "api/traces/logs?" in api
    # The logs request starts once the trace has rendered.
    load = traces.split("async function loadTrace(", 1)[1].split("function backToSearch(", 1)[0]
    assert load.index("renderTrace();") < load.index("void ns.traceLogs?.load?.(trace);")
    for hook in ("headerItemHtml", "spanBadgeHtml", "spanMarkersHtml", "inlineRowHtml", "inlineHeight", "inspectorSectionHtml"):
        assert f"ns.traceLogs?.{hook}?.(" in traces or f"logs?.{hook}?.(" in traces, hook
        assert f"{hook}," in logs or f"{hook}(" in logs, hook
    # Hidden when /api/version says logs are disabled.
    assert "state?.features?.logs?.enabled !== false" in logs
    assert "state.features.logs = { enabled: logs.enabled === true" in read("src/static/app_ui.js")
    # A log opens its span through the ?span= deep link.
    assert "ctx.focusSpanInTimeline(id, { push: true });" in logs
    # Spans sharing a SpanId: containment, else the nearest span.
    assert "record.ns < start ? start - record.ns : record.ns > end ? record.ns - end : 0" in logs


def test_trace_logs_spec_runs_in_the_suite():
    suite = read("tests/test-suite/run-all-tests.py")
    assert "'specs/trace-logs.spec.js'" in suite
    assert (ROOT / "tests/frontend/specs/trace-logs.spec.js").exists()
    assert (ROOT / "tests/backend-functional/test_trace_logs.py").exists()
