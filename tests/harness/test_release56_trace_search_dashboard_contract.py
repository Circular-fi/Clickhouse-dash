from pathlib import Path
import modules
from trace_sources import read_traces, read_unit
import css_sources

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()


def test_trace_search_supports_ranges_prefill_exact_sets_tags_and_compact_rows():
    cpp = read_traces()
    server = read('src/server.cpp')
    api = read('src/static/app_api.js')
    ui = modules.read_family("app_trace")

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
    assert 'tag_value' in read_traces()
    assert 'candidate_ids' in cpp
    assert 'TraceId IN (SELECT TraceId FROM candidate_ids)' in cpp
    assert 'w.Key("columns")' in cpp and 'w.Key("rows")' in cpp
    json = read_unit('trace_json.cpp')
    search = json[json.index('std::string search_json'):json.index('std::string analytics_json')]
    analytics = json[json.index('std::string analytics_json'):json.index('std::string service_map_json')]
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
    ui = modules.read_family("app_trace")
    html = read('src/static/traces.html')
    css = css_sources.text()

    assert 'traceResult__fullId' in ui
    assert 'data-copy-trace' in ui
    assert 'service_stats' in ui
    assert 'stat.spans' in ui
    assert 'stat.errors' in ui
    assert '.traceServiceFilter' in css
    assert 'points + P50 / P90 / P95 / P99' in html


def test_otel_status_ui_does_not_invent_warning():
    html = read('src/static/traces.html')
    assert '<option value="Ok">OK</option>' in html
    # Status casing as the badges print it (ns.badge.statusLabel): OK, Error, Unset.
    assert '<option value="Error">Error</option>' in html
    assert '<option value="Unset">Unset</option>' in html
    assert '<option value="Warning"' not in html


def test_unfiltered_trace_search_uses_trace_index_fast_path_and_bounded_enrichment():
    cpp = read_traces()
    assert 'index_fast_path_eligible' in cpp
    assert 'trace_index_table' in cpp
    # The index is walked newest-first through bounded Start slices (keyset),
    # never by re-sorting the whole window per page.
    assert 'class TraceIndexCursor' in cpp
    assert '" PREWHERE " + window + " AND Start >= " + ns_time(lo_ns) + " AND Start <= " + ns_time(hi_ns)' in cpp
    assert 'ORDER BY Start DESC LIMIT 1 BY TraceId' in cpp  # documented rank order of TraceIndexCursor
    assert '" WHERE " + scope.visibility + " AND TraceId IN {ids:Array(String)}"' in cpp
    assert 'duration_quantiles_source' in cpp
    assert 'analytics_enabled' in cpp
    assert 'span_bounds' in cpp
    assert 'w.Key("timing_ms")' in cpp
    assert 'w.Key("search_path")' in cpp
