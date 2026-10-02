from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_trace_analytics_buckets_cast_datetime_to_datetime64_before_millis_conversion():
    cpp = read('src/api_traces.cpp')
    # Buckets are computed on the DateTime64 millis (a grid anchored at the
    # browser's local midnight), never on a DateTime-typed toStartOfInterval.
    assert '" + intDiv(toUnixTimestamp64Milli(" + column + ") - "' in cpp
    assert 'grid_bucket_sql("trace_start", quantile_bucket_ms, quantile_origin_ms)' in cpp
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
    html = read('src/static/observability.html')
    ui = read('src/static/app_traces.js')
    css = read('src/static/style.css')
    assert 'tracePageHeader__titleRow' in html
    assert 'traceSpanSearch' not in html
    assert 'traceIdLookupInput' not in html
    assert 'traceOverview' in html
    assert 'Trace Start' in ui and '["Duration", fmt.duration(bounds.duration)]' in ui
    # Jaeger's header items: services, depth and span count are back.
    assert '["Services", fmt.count(cache.serviceCount)]' in ui and '["Depth", fmt.count(cache.maxLevel + 1)]' in ui and '["Total Spans", fmt.count(spans.length)]' in ui
    assert 'data-trace-collapse-all' in ui and 'data-trace-expand-all' in ui
    assert 'grid-template-columns: minmax(285px, 25%) minmax(0, 75%);' in css
