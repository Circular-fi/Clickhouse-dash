from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_search_reports_missing_parent_spans_per_trace():
    cpp = read("src/api_traces.cpp")
    assert "uniqExactArray(arrayFilter(id -> notEmpty(id), [toString(SpanId), toString(ParentSpanId)]))" in cpp
    assert '"service_stats", "missing_parents"' in cpp
    assert "w.Uint64(row.missing_parents);" in cpp
    js = read("src/static/app_traces.js")
    assert "missing_parents: Number(row?.[8] || 0)" in js


def test_result_items_follow_jaeger_result_item():
    js = read("src/static/app_traces.js")
    css = css_sources.text()
    assert "traceResultItem__durationBar" in js and ".traceResultItem__durationBar" in css
    assert "color-mix(in srgb, var(--accentBorder) 15%, transparent)" in css
    assert "color-mix(in srgb, var(--accentBorder) 25%, transparent)" in css
    assert "Span${spans === 1 ? \"\" : \"s\"}" in js
    assert "Error${errors === 1 ? \"\" : \"s\"}" in js
    assert "traceTag--incomplete" in js and ".traceTag--incomplete" in css
    assert '<code class="traceResult__fullId">${esc(trace.trace_id)}</code>' in js
    assert "function layoutServicePills(scope)" in js
    assert "traceSvcPill__error" in js and "traceSvcMore" in js and ".traceSvcPopover" in css
    assert "(in ${fmt.duration.fromMs(model.searchLatencyMs)})" in js
    assert "data-results-zoom-out" in js and "dom.tracesRangeZoomOut?.click()" in js


def test_results_have_a_sortable_table_view_remembered_per_browser():
    js = read("src/static/app_traces.js")
    html = read("src/static/traces.html")
    assert 'data-results-view="list"' in html and 'data-results-view="table"' in html
    assert "const RESULTS_VIEW_KEY = ns.storage.KEYS.traceResultsView;" in js
    assert 'traceResultsView: "chdash.traceResultsView.v1",' in read("src/static/app_state.js")
    assert 'class="dataTable traceTable"' in js
    for key in ("name", "services", "spans", "errors", "duration", "start"):
        assert f'{{ key: "{key}", label: ' in js
    assert "function sortTableBy(key)" in js
    assert "data-start-toggle" in js


def test_duration_chart_plots_listed_traces_over_a_padded_axis():
    js = read("src/static/app_traces.js")
    css = css_sources.text()
    assert "function durationAxis(minNsValue, maxNsValue, targetIntervals = 7)" in js
    assert "const pad = hi > lo ? (hi - lo) * 0.05 : Math.max(1, hi * 0.1);" in js
    engine = read("src/static/app_chart_core.js")
    # One dot per listed trace on the engine's scatter (own x column, radius
    # by span count, red with errors), picked under the pointer.
    assert 'pointColor: (i) => (Number(scatterTraces[i].error_count || 0) > 0 ? "var(--danger)" : null),' in js
    assert 'id: "traces", label: "Listed traces", type: "points", xs: dotXs' in js
    assert "function pickPoint(p)" in engine and "const score = d / (r + 3) + r / 100;" in engine
    assert ".chartCore__tipRow.is-error" in css
