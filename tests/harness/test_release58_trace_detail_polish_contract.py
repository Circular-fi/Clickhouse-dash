from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_trace_detail_serializes_otel_structures_as_json_for_readable_inspector():
    cpp = read('src/api_traces.cpp')
    assert 'toJSONString(SpanAttributes)' in cpp
    assert 'toJSONString(ResourceAttributes)' in cpp
    assert 'toJSONString(Events.Timestamp)' in cpp
    assert 'toJSONString(Events.Name)' in cpp
    assert 'toJSONString(Events.Attributes)' in cpp


def test_trace_duration_label_switches_side_and_waterfall_has_no_horizontal_scroll():
    ui = read('src/static/app_traces.js')
    css = read('src/static/style.css')
    assert 'const labelLeft = left + (width / 2) >= 62;' in ui
    assert 'traceSpanBar--labelLeft' in ui
    assert '.traceSpanBar--labelLeft > span' in css
    assert 'overflow-x: hidden;' in css
    assert '.traceWaterfallBody {' in css


def test_trace_inspector_formats_tags_process_and_events_like_jaeger_rows():
    ui = read('src/static/app_traces.js')
    css = read('src/static/style.css')
    assert 'renderJaegerAttributes' in ui
    assert '>Process:</b>' in ui
    assert 'renderJaegerEvents' in ui
    assert 'traceInspectorIdentity' in ui
    assert '.traceJaegerTags' in css
    assert '.traceJaegerGroup' in css
    assert '.traceInspector--jaeger {' in css and 'padding-bottom: 3px !important;' in css


def test_trace_pickers_keep_explorer_connected_dropdown_language():
    css = read('src/static/style.css')
    assert 'linear-gradient(180deg, var(--panelTopSheen), transparent 22%)' in css
    assert '.traceRangeCompact > .tracePicker' in css
    assert '.traceTagSearch__inputs > .tracePicker:first-child' in css
    assert '.traceTagSearch__inputs > .tracePicker:last-child' in css
