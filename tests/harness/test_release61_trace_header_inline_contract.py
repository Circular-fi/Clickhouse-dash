from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_trace_stats_share_title_row_and_trace_id_is_not_duplicated():
    html = read("src/static/traces.html")
    js = read("src/static/app_traces.js")
    title_row = html.split('<div class="tracePageHeader__titleRow">', 1)[1].split('</div>\n          <div id="traceOverview"', 1)[0]
    assert 'id="traceDetailTitle"' in title_row
    assert 'id="traceDetailStats"' in title_row
    render_header = js.split('function renderTraceHeader()', 1)[1].split('function renderWaterfall()', 1)[0]
    assert 'tracePageHeader__traceId' in render_header
    assert 'shortId(trace.trace_id, 10)' in render_header
    assert 'title="${esc(trace.trace_id)}"' in render_header
    assert 'data-copy-active-trace="${esc(trace.trace_id)}"' in render_header

def test_span_inspector_meta_forced_inline_and_service_bar_is_continuous():
    css = read("src/static/style.css")
    assert '.traceInspectorHead__meta {' in css
    assert 'flex-direction: row !important;' in css
    assert 'flex-wrap: nowrap !important;' in css
    assert '.traceSpanRow.is-active .traceSpanRow__serviceDot {' in css
    assert 'align-self: flex-end !important;' in css
    assert 'height: calc(100% - 5px) !important;' in css
    assert '.traceSpanInspectorRow__spacer::after {' in css
    assert 'top: -1px !important;' in css
    assert 'bottom: -1px !important;' in css
