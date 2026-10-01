from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_strict_trace_ranges_and_selection_only_prefill_pickers():
    html = read('src/static/observability.html')
    js = read('src/static/app_traces.js')
    picker = read('src/static/app_timerange.js')
    # Quick ranges (Grafana's list) are offered only when their width fits
    # traces.max_lookback_minutes; any other window goes through From / To.
    for value in ('now-5m', 'now-15m', 'now-30m', 'now-1h', 'now-3h', 'now-12h', 'now-24h', 'now-2d', 'now-7d', 'now-30d', 'now-90d', 'now-6M', 'now-1y'):
        assert f'["{value}", "now", ' in picker
    assert 'QUICK_RANGES.filter((option) => fits(option, now)' in picker
    assert 'endMs - startMs <= maxMs()' in picker
    assert 'id="tracesRangeStart"' in html and 'id="tracesRangeEnd"' in html
    assert 'enhanceTraceCombo' not in js
    assert 'traceCombo__menu' not in js
    assert '<select id="tracesService"' in html
    assert '<select id="tracesOperation"' in html
    assert 'data-field-label="Service"' in html
    assert 'data-field-label="Operation"' in html
    assert 'align_buckets' in js

def test_analytics_count_matching_traces_and_dense_quantiles():
    cpp = read('src/api_traces.cpp')
    js = read('src/static/app_traces.js')
    assert 'trace_count_chart' in cpp
    assert 'choose_trace_quantile_bucket_seconds' in cpp
    assert '/ 120' in cpp
    assert '/ 60' in cpp
    assert 'analytics_end_ms' in cpp and 'bucket_ms - 1' in cpp
    assert 'trace_count_chart' in js
    assert 'returned traces' not in js

def test_inline_multi_span_inspectors_and_compact_error_badges():
    js = read('src/static/app_traces.js')
    css = read('src/static/style.css')
    assert 'openSpanIds: new Set()' in js
    assert 'traceSpanInspectorRow' in js
    assert 'traceJaegerGroup--summary' in js
    assert 'renderAttributePreview' in js
    assert 'traceErrorCount' in js
    assert 'editorCopyButton__icon' in js
    assert '.traceSpanRow__serviceDot' in css
    assert 'width: 3px;' in css
    assert '.traceJaegerGroup--summary' in css
