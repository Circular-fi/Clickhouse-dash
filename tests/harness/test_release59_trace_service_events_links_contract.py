from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_trace_service_filters_and_time_window_hide_irrelevant_spans():
    html = read('src/static/trace.html')
    ui = read('src/static/app_traces.js')
    assert 'traceServiceFilters' in html
    assert 'disabledServices' in ui
    assert 'serviceEnabled(node.span.service_name) && spanEnd > start && spanStart < end' in ui
    assert 'data-trace-service-filter' in ui

def test_trace_events_errors_and_links_are_visible_and_actionable():
    ui = read('src/static/app_traces.js')
    css = css_sources.text()
    assert 'traceSpanEventMarker' in ui and '.traceSpanEventMarker' in css
    assert 'traceSpanRow__errorBadge' in ui and '.traceSpanRow__errorBadge' in css
    assert 'data-linked-trace' in ui and 'loadTrace(traceId, { push: true })' in ui

def test_trace_service_name_stays_whole_before_the_operation():
    # Audit 2 I-O4: the service keeps its name (up to 16ch, never shrunk) and
    # the operation after it takes the ellipsis.
    css = css_sources.text()
    assert '.traceSpanRow__service {' in css
    service = css_sources.decls(".traceSpanRow__service")
    assert service.get("flex") == "0 0 auto" and service.get("max-width") == "16ch", service
    name = css_sources.decls(".traceSpanRow__name")
    assert name.get("flex") == "1 1 auto" and name.get("text-overflow") == "ellipsis", name
