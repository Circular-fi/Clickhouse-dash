from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_trace_analytics_buckets_cast_datetime_to_datetime64_before_millis_conversion():
    cpp = read('src/api_traces.cpp')
    assert 'toUnixTimestamp64Milli(toDateTime64(toStartOfInterval(trace_start' in cpp
    assert 'toUnixTimestamp64Milli(toStartOfInterval(trace_start' not in cpp


def test_trace_selectors_reuse_custom_dropdown_visual_language():
    ui = read('src/static/app_traces.js')
    css = read('src/static/style.css')
    assert 'enhanceTraceSelect' in ui
    assert 'themeSelect__button tracePicker__button' in ui
    assert 'themeSelect__menu tracePicker__menu' in ui
    assert '.tracePicker__button' in css
    assert '.tracePicker__option' in css


def test_trace_detail_has_jaeger_style_overview_and_dense_timeline():
    html = read('src/static/traces.html')
    ui = read('src/static/app_traces.js')
    css = read('src/static/style.css')
    assert 'tracePageHeader__titleRow' in html
    assert 'traceSpanSearch' not in html
    assert 'traceIdLookupInput' not in html
    assert 'traceOverview' in html
    assert 'Trace Start' in ui and '["Duration", formatDuration(bounds.duration)]' in ui
    assert '["Services"' not in ui and '["Depth"' not in ui and '["Total Spans"' not in ui
    assert 'data-trace-collapse-all' in ui and 'data-trace-expand-all' in ui
    assert 'grid-template-columns: minmax(285px, 25%) minmax(0, 75%);' in css
