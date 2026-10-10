"""Source contract: the trace search page's Spans mode keeps its keyset paged,
time-sliced, guarded and allowlisted span search, its single-span lookup by
row key, and its page wiring (URL state, module order, test suite)."""
from pathlib import Path
from trace_sources import read_traces, read_unit

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def handler(api: str, name: str) -> str:
    start = api.index(f"void Server::{name}(")
    end = api.find("\nvoid Server::", start + 1)
    return api[start:end if end > 0 else len(api)]


def test_span_search_routes_are_registered():
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    assert '"/api/traces/spans"' in server and '"/api/traces/span"' in server
    assert "void handle_traces_spans(" in header and "void handle_traces_span(" in header


def test_span_search_is_keyset_paged_over_newest_first_slices():
    sql = read_unit("trace_sql.cpp")
    spans = read_unit("trace_spans.cpp")
    header = read_unit("trace_spans.hpp")
    # Keyset on (Timestamp, SpanId, TraceId): never OFFSET.
    assert "ORDER BY Timestamp DESC, SpanId DESC, TraceId DESC LIMIT" in sql
    assert "OFFSET" not in sql[sql.index("// ---- the span search ----"):] and "OFFSET" not in spans
    assert "(Timestamp < \" + ts + \" OR (Timestamp = \" + ts + \" AND (SpanId < " in sql
    # Exact copies of the boundary key stay on one page.
    assert "same_key(boundary)" in spans
    # Slices: 15 min, 1 h, 6 h, 24 h, widened within the page budget.
    assert "kSpanSlicesNs[] = {15 * kNsPerMinute, 60 * kNsPerMinute, 360 * kNsPerMinute, 1440 * kNsPerMinute}" in header
    assert "kSpanPageBudgetMs" in header and "budget_ms - spent" in spans
    assert 'stop_reason = "time_budget"' in spans
    # Guards: per-slice time and read caps in throw mode (never a truncated top-N).
    assert "timeout_overflow_mode = 'throw'" in sql and "read_overflow_mode = 'throw'" in sql
    assert "max_rows_to_read" in sql and "max_execution_time" in sql
    assert "kSpanPageMaxLimit = 500" in header


def test_span_search_filters_are_span_level_and_allowlisted():
    sql = read_unit("trace_sql.cpp")
    service = read_unit("trace_service.cpp")
    spans = service[service.index("TraceService::spans"):]
    request = read_unit("trace_request.cpp")
    parse = request[request.index("bool parse_spans"):request.index("bool parse_span_columns")]
    assert "service_allowlist_predicate(traces)" in spans
    assert "parse_trace_filters(req, &out->filters, &message)" in parse
    assert "span_filters_sql(request.filters, \"\")" in spans and "tag_filters_sql(request.filters.tags" in spans
    assert "feature_param_rejected(traces, req" in parse
    assert 'exact_values_predicate("SpanKind", kinds)' in sql
    assert "Duration >= " in sql and "Duration <= " in sql
    # Column predicates (primary key ServiceName / SpanName first) in PREWHERE.
    assert '" AND " + q.visibility + q.column_filters' in sql
    # A restricted allowlist hides parent ids (as trace detail does).
    assert "answer.all_services = visibility == \"1\";" in spans
    assert "visible_parent(row.parent_span_id, answer.all_services)" in read_unit("trace_json.cpp")


def test_single_span_lookup_is_bounded_by_its_row_key():
    sql = read_unit("trace_sql.cpp")
    span = sql[sql.index("std::string span_sql"):sql.index("std::string trace_index_bounds_sql")]
    service = read_unit("trace_service.cpp")
    assert "PREWHERE Timestamp = \" + ns_time(timestamp_ns)" in span
    assert "service_allowlist_predicate(traces)" in service[service.index("TraceService::span("):service.index("TraceService::linked_from")]
    assert "f.span_attributes" in span and "f.events" in span and "f.links" in span


def test_spans_mode_page_wiring():
    html = read("src/static/traces.html")
    assert 'data-results-mode="traces"' in html and 'data-results-mode="spans"' in html
    assert 'id="traceSpanTools"' in html and 'id="traceSpanKind"' in html and 'id="traceSpanColumnsButton"' in html
    bootstrap = read("src/static/modules.json")  # the module lists, in load order
    assert bootstrap.index('"app_trace_search.js"') < bootstrap.index('"app_trace_spans.js"') < bootstrap.index('"app_trace_logs.js"')
    search = read("src/static/app_trace_search.js")
    params = search[search.index("const SEARCH_PARAMS"):search.index("const PIN_STORE_KEY")]
    for name in ('"mode"', '"kind"', '"span_min_duration_ms"', '"span_max_duration_ms"'):
        assert name in params
    assert "ns.traceSpans?.urlParams?.(params)" in search and "ns.traceSpans?.applyParams?.(params)" in search
    traces = read("src/static/app_traces.js")
    assert "await ns.traceSpans.search(filters)" in traces
    assert "ns.traceSpans.hasResults()" in traces
    spans = read("src/static/app_trace_spans.js")
    api = read("src/static/app_api.js")
    assert "api/traces/spans?" in api and "api/traces/span?" in api
    assert "ctx.api.searchTraceSpans(" in spans and "ctx.api.getTraceSpan(" in spans
    assert "`api/traces/span" not in spans
    assert "ns.storage.KEYS.traceSpanColumns" in spans
    assert 'traceSpanColumns: "chdash.traceSpanColumns.v1",' in read("src/static/app_state.js")
    assert "ROW_HEIGHT" in spans and "updateWindow" in spans


def test_spans_mode_tests_are_in_the_suite():
    suite = read("tests/test-suite/run-all-tests.py")
    assert "'specs/trace-spans.spec.js'" in suite
    assert "'test_trace_spans.py'" in suite
    assert (ROOT / "tests/frontend/specs/trace-spans.spec.js").exists()
    assert (ROOT / "tests/backend-functional/test_trace_spans.py").exists()
