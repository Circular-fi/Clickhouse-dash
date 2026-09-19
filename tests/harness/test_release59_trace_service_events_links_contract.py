from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_trace_service_filters_and_time_window_hide_irrelevant_spans():
    html = read('src/static/traces.html')
    ui = read('src/static/app_traces.js')
    assert 'traceServiceFilters' in html
    assert 'disabledServices' in ui
    assert 'serviceEnabled(node.span.service_name) && spanEnd > start && spanStart < end' in ui
    assert 'data-trace-service-filter' in ui

def test_trace_events_errors_and_links_are_visible_and_actionable():
    ui = read('src/static/app_traces.js')
    css = read('src/static/style.css')
    assert 'traceSpanEventMarker' in ui and '.traceSpanEventMarker' in css
    assert 'traceSpanRow__errorBadge' in ui and '.traceSpanRow__errorBadge' in css
    assert 'data-linked-trace' in ui and 'loadTrace(traceId, { push: true })' in ui

def test_trace_service_name_can_expand_with_resized_label_column():
    css = read('src/static/style.css')
    assert '.traceSpanRow__service {' in css
    assert 'max-width: none !important;' in css
