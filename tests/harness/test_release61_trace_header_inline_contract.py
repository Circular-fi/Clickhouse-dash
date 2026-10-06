from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_trace_stats_share_title_row_and_trace_id_is_not_duplicated():
    html = read("src/static/trace.html")
    js = read("src/static/app_traces.js")
    title_row = html.split('<div class="tracePageHeader__titleRow">', 1)[1].split('</div>\n          <div id="traceOverview"', 1)[0]
    assert 'id="traceDetailTitle"' in title_row
    assert 'id="traceDetailStats"' in title_row
    render_header = js.split('function renderTraceHeader()', 1)[1].split('function renderWaterfall()', 1)[0]
    assert 'tracePageHeader__traceId' in render_header
    # The complete trace id, like the result list.
    assert '<code title="${esc(trace.trace_id)}">${esc(trace.trace_id)}</code>' in render_header
    assert 'shortId(trace.trace_id, 10)' not in render_header
    assert 'title="${esc(trace.trace_id)}"' in render_header
    assert 'attrs: { "data-copy-active-trace": trace.trace_id }' in render_header

def test_span_inspector_meta_forced_inline_and_service_bar_is_continuous():
    css = css_sources.text()
    assert '.traceInspectorHead__meta {' in css
    # Folded into traces.css (audit 2 I-O2): a phone stacks the facts.
    meta = css_sources.decls(".traceInspectorHead__meta")
    assert meta.get("flex-direction") == "row" and meta.get("flex-wrap") == "nowrap", meta
    assert ".traceInspectorHead__meta {" not in css_sources.overrides()
    assert '.traceSpanRow.is-active .traceSpanRow__serviceDot {' in css
    assert css_sources.declared("align-self: flex-end")
    assert css_sources.declared("height: calc(100% - 5px)")
    assert '.traceSpanInspectorRow__spacer::after {' in css
    assert css_sources.declared("top: -1px")
    assert css_sources.declared("bottom: -1px")
