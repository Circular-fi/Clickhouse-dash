from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()


def test_trace_search_supports_ranges_prefill_exact_sets_tags_and_compact_rows():
    cpp = read('src/api_traces.cpp')
    server = read('src/server.cpp')
    api = read('src/static/app_api.js')
    ui = read('src/static/app_traces.js')

    assert 'http_.Get("/api/traces/prefill"' in server
    assert 'http_.Get("/api/traces/tags"' not in server
    assert 'http_.Get("/api/traces/analytics"' in server
    assert 'start_ms' in cpp and 'end_ms' in cpp
    assert 'max_lookback_minutes' in cpp
    assert ' ILIKE ' not in cpp
    assert 'service_match' not in cpp and 'operation_match' not in cpp
    assert 'exact_values_predicate' in cpp
    assert ' IN (' in cpp
    assert 'mapKeys(' not in cpp
    assert 'SpanAttributes' in cpp and 'ResourceAttributes' in cpp
    assert 'mapContains(' in cpp
    assert 'tag_value' in cpp
    assert 'candidate_ids' in cpp
    assert 'TraceId IN (SELECT TraceId FROM candidate_ids)' in cpp
    assert 'w.Key("columns")' in cpp and 'w.Key("rows")' in cpp
    search = cpp[cpp.index('void Server::handle_traces_search'):cpp.index('void Server::handle_traces_analytics')]
    analytics = cpp[cpp.index('void Server::handle_traces_analytics'):cpp.index('void Server::handle_trace_detail')]
    assert 'w.Key("trace_count_chart")' not in search
    assert 'w.Key("duration_quantiles")' not in search
    assert 'w.Key("trace_count_chart")' in analytics
    assert 'w.Key("duration_quantiles")' in analytics
    assert 'quantileTDigest(0.99)' in cpp
    assert 'prefillTraces' in api and 'getTraceTags' not in api and 'getTraceAnalytics' in api
    assert 'fuzzyExactValues' not in ui
    assert 'resolvedServiceValues' in ui and 'resolvedOperationValues' in ui
    assert 'replaceSelectOptions(dom.tracesService' in ui
    assert 'replaceSelectOptions(dom.tracesOperation' in ui


def test_trace_results_show_full_id_and_per_service_span_error_counts():
    ui = read('src/static/app_traces.js')
    html = read('src/static/traces.html')
    css = read('src/static/style.css')

    assert 'traceResult__fullId' in ui
    assert 'data-copy-trace' in ui
    assert 'service_stats' in ui
    assert 'stat.spans' in ui
    assert 'stat.errors' in ui
    assert 'traceServiceStat' in css
    assert 'points + P50 / P90 / P95 / P99' in html


def test_otel_status_ui_does_not_invent_warning():
    html = read('src/static/traces.html')
    assert '<option value="Ok">OK</option>' in html
    assert '<option value="Error">ERROR</option>' in html
    assert '<option value="Unset">UNSET</option>' in html
    assert '<option value="Warning"' not in html


def test_unfiltered_trace_search_uses_trace_index_fast_path_and_bounded_enrichment():
    cpp = read('src/api_traces.cpp')
    assert 'index_fast_path_eligible' in cpp
    assert 'trace_index_table' in cpp
    assert 'PREWHERE " + index_time_predicate' in cpp
    assert 'ORDER BY Start DESC LIMIT 1 BY TraceId LIMIT' in cpp
    assert '" WHERE " + visibility + " AND TraceId IN " + trace_id_list' in cpp
    assert 'trace_bounds AS (SELECT TraceId, Start AS trace_start, End AS trace_end' in cpp
    assert 'duration_quantiles_source' in cpp
    assert 'analytics_enabled' in cpp
    assert 'trace_index_bounds' in cpp
    assert 'w.Key("timing_ms")' in cpp
    assert 'w.Key("search_path")' in cpp
