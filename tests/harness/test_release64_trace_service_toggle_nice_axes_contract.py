from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_service_filter_toggle_is_contextual_and_names_are_not_error_badges():
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert 'const toggleLabel = allSelected ? "Deselect all" : "Select all"' in js
    assert 'data-trace-toggle-all' in js
    assert 'model.disabledServices = allSelected ? new Set(services) : new Set()' in js
    assert '.traceServiceFilter.traceServiceStat > b' in css
    assert 'background: transparent !important;' in css

def test_analytics_axes_use_nice_round_ticks_and_more_time_labels():
    js = read("src/static/app_traces.js")
    assert 'function niceStep(' in js
    assert 'function countAxis(' in js
    assert 'function durationAxis(' in js
    assert 'timeTickRatios(7)' in js
    assert 'countScale.values.map' in js
    assert 'durationScaleAxis.values.map' in js
