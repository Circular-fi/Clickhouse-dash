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
    # The toggles are the shared badges (no error styling on the names).
    assert 'class="badge badge--md badge--neutral traceServiceFilter' in js
    assert '.badge.traceServiceFilter[aria-pressed="false"]' in css

def test_analytics_axes_use_nice_round_ticks_and_more_time_labels():
    js = read("src/static/app_traces.js")
    engine = read("src/static/app_chart_core.js")
    assert 'function durationAxis(' in js
    assert 'durationScaleAxis.values.map' in js
    # Counts: the engine's nice 1-2-2.5-5 ticks; time labels adapt to the range
    # and the chart width (local wall clock, calendar-aligned).
    assert 'function niceStep(' in engine and 'function linearTicks(' in engine
    assert 'function timeTicks(startMs, endMs, plotWidthPx, measure)' in engine
    assert 'xKind: "time", xs, xDomain: [start, end]' in js
