from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_trace_header_searches_removed_and_custom_range_does_not_reflow():
    html = read("src/static/traces.html")
    css = read("src/static/style.css")
    assert 'traceIdLookupInput' not in html
    assert 'traceSpanSearch' not in html
    # The time range panel is the range picker's dropdown (absolutely
    # positioned menu), so editing a range never reflows the search bar.
    assert 'class="themeSelect__menu tracePicker__menu timeRangePanel"' in html
    assert '.traceSearchBar .tracePicker--range .tracePicker__menu.timeRangePanel {' in css
    assert '.themeSelect__menu {\n  position: absolute;' in css

def test_trace_graphs_have_hover_tooltips_and_one_minute_floor():
    js = read("src/static/app_traces.js")
    cpp = read("src/api_traces.cpp")
    assert 'attachChartTooltips' in js
    assert 'traceChartTooltip' in js
    assert 'data-count-ts' in js
    assert 'data-q-ts' in js
    assert 'range_ms / 1000 / 60' in cpp
    assert 'range_ms / 1000 / 120' in cpp

def test_span_inspector_preview_table_tint_and_resizable_waterfall():
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert 'renderAttributePreview' in js
    assert 'renderAttributeTable' in js
    assert '>Tags:</b>' in js
    assert '>Process:</b>' in js
    assert 'data-trace-waterfall-resizer' in js
    assert '--trace-label-width' in css
    assert '.traceWaterfallResizer' in css
    assert '.traceAttributeTable__row' in css
    assert '--trace-depth-x' in css

def test_selection_picker_closes_menu():
    js = read("src/static/app_traces.js")
    assert 'select.dispatchEvent(new Event("change", { bubbles: true }))' in js
    assert 'closeTracePickers();' in js
    assert 'enhanceTraceCombo' not in js
