from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_trace_header_searches_removed_and_custom_range_does_not_reflow():
    html = read("src/static/observability.html")
    css = read("src/static/style.css")
    assert 'traceIdLookupInput' not in html
    assert 'traceSpanSearch' not in html
    # No in-trace span search or trace id lookup left anywhere: no DOM
    # handles, wiring, match state or styles.
    js = read("src/static/app_traces.js")
    dom = read("src/static/app_dom.js")
    for source in (js, dom, css):
        for dead in ('traceSpanSearch', 'traceIdLookup', 'spanSearchText', 'is-search-match', 'tracePageFind'):
            assert dead not in source
    # The time range panel is the range picker's dropdown (absolutely
    # positioned menu), so editing a range never reflows the search bar.
    assert 'class="themeSelect__menu tracePicker__menu timeRangePanel"' in read("src/static/app_timerange.js")
    assert '.traceSearchBar .tracePicker--range .tracePicker__menu.timeRangePanel {' in css
    assert '.themeSelect__menu {\n  position: absolute;' in css

def test_trace_graphs_have_hover_tooltips_and_one_minute_floor():
    js = read("src/static/app_traces.js")
    cpp = read("src/api_traces.cpp")
    # The charts draw on the shared canvas engine: its tooltip reads the
    # bucket (count and percentile charts) or the picked trace (scatter).
    assert 'mountChart(container, "counts", {' in js and 'mountChart(container, "percentiles", {' in js
    # The engine's bucket readout (ns.format.range of the bucket).
    assert 'bucketMs, bucketAlign: "center",' in js
    assert 'bucketMs: qBucketMs, bucketAlign: "center",' in js
    assert "pickTooltip: (hit) => {" in js
    assert 'range_ms / 1000 / 60' in cpp
    assert 'range_ms / 1000 / 120' in cpp

def test_span_inspector_preview_table_tint_and_resizable_waterfall():
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert 'renderAttributePreview' in js
    assert 'renderAttributeTable' in js
    assert 'renderJaegerAttributes("Tags", span.span_attributes, ' in js
    assert 'renderJaegerAttributes("Process", span.resource_attributes, ' in js
    assert 'data-trace-waterfall-resizer' in js
    assert '--trace-label-width' in css
    assert '.traceWaterfallResizer' in css
    assert '.kvList__row' in css
    assert '--trace-depth-x' in css

def test_selection_picker_closes_menu():
    js = read("src/static/app_traces.js")
    menu = read("src/static/app_ui_menu.js")
    # A pick fires the select's change and closes the list (ns.menu.select).
    assert 'if (changed) selectEl.dispatchEvent(new Event("change", { bubbles: true }));' in menu
    assert "handle.close({ focus: document.activeElement === document.body" in menu
    assert 'enhanceTraceCombo' not in js
