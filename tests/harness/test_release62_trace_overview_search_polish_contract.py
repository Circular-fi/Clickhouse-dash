from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()


def test_trace_overview_is_full_width_scrubbable_and_ticks_use_one_scale():
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert "traceViewRange: [0, 1]" in js
    assert "data-trace-overview-selection" in js
    assert "data-overview-handle=\"start\"" in js
    assert "graph.addEventListener(\"dblclick\"" in js
    assert "durationTicks(bounds.duration, 5)" in js
    assert "durationTicks(total, 5)" in js
    assert ".traceOverview__ticks," in css
    assert "margin-left: 0 !important;" in css


def test_span_hover_label_orders_service_and_duration_around_bar():
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert "const spanRef = `${span.service_name || \"unknown\"}::${span.span_name || \"span\"}`" in js
    assert "traceSpanBar__label" in js
    assert ".traceSpanRow:hover .traceSpanBar__label i" in css
    assert "height: 14px !important;" in css
    assert "height: calc(100% - 5px) !important;" in css


def test_search_controls_embed_field_names_and_use_theme_colors():
    html = read("src/static/traces.html")
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert '<span class="traceFieldLabel">' not in html
    assert 'data-field-label="Time range"' in html
    assert 'placeholder="Service"' in html
    assert 'placeholder="Operation"' in html
    assert 'id="tracesTagKey"' in html and 'placeholder="Tag"' in html
    assert 'data-field-label="Status"' in html
    assert 'data-field-label="Results"' in html
    assert "`${fieldLabel} · ${selectedText}`" in js
    assert "background: var(--buttonBg) !important;" in css
    assert "background: var(--panel) !important;" in css


def test_chart_hover_highlights_and_duration_axis_has_more_uniform_ticks():
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert "durationAxis(yMax, 7)" in js
    assert "countAxis(maxTotal, 7)" in js
    assert "timeTickRatios(7)" in js
    assert "data-count-bar" in js
    assert "traceQuantileHover" in js
    assert "data-q-hover" in js
    assert ".traceCountBar.is-hovered" in css
    assert ".traceQuantileHover.is-active" in css
