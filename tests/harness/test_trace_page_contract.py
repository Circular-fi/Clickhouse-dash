import json
import modules
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def test_one_trace_is_its_own_html_page_without_the_observability_tabs():
    html = read("src/static/trace.html")
    obs = read("src/static/traces.html")
    assert '<body data-page="trace">' in html
    assert "static/style.trace.css" in html
    # The page header stays; the Observability view tabs (Traces, Logs, Metrics) and the search do not.
    assert '<header class="appHeader" role="banner">' in html
    assert 'id="navObservabilityButton" class="themeSelect__option" type="button" role="option" data-value="observability" aria-selected="true"' in html
    for token in ('id="obsNav"', 'id="obsTabs"', 'id="tracesTabs"', 'id="tracesForm"', 'data-obs-panel', 'id="logsWorkspace"', 'id="metricsWorkspace"'):
        assert token not in html, token
    # The trace pane lives in trace.html only; traces.html keeps the search.
    for token in ('id="traceDetail"', 'id="traceBackButton"', 'id="traceWaterfall"', 'id="traceLogsPanel"'):
        assert token in html and token not in obs, token
    # Both pages show errors in the same banner.
    assert 'id="tracesError" class="uiBanner" role="alert" hidden' in html and 'id="tracesError" class="uiBanner" role="alert" hidden' in obs
    assert 'id="traceDetail" class="traceDetailPane traceDetailPane--jaeger" aria-label="Trace">' in html
    assert 'id="tracesForm"' in obs and 'id="obsNav"' in obs


def test_the_trace_page_loads_the_trace_modules_without_the_search_ones():
    page = modules.page_files("trace")
    assert page[-1] == "app_page_trace.js"
    for name in ("app_trace_detail.js", "app_trace_model.js", "app_trace_store.js", "app_trace_waterfall.js", "app_trace_inspector.js", "app_trace_views.js", "app_trace_insights.js", "app_trace_logs.js", "app_trace_search.js", "app_graph_kit.js", "app_timerange.js"):
        assert name in page, name
    for name in ("app_traces.js", "app_trace_results.js", "app_trace_analytics.js", "app_trace_charts.js", "app_trace_spans.js", "app_trace_tabs.js", "app_trace_services.js", "app_trace_map.js", "app_trace_heatmap.js", "app_facet_panel.js", "app_ui_filterbar.js"):
        assert name not in page, name
    # The search view no longer loads the trace-only views and logs modules for a trace pane it does not hold.
    controller = read("src/static/app_page_trace.js")
    assert "lifecycle.enter(\"traces\")" in controller and "traceDetail.init();" in controller
    assert 'router.on("/observability", () => traceDetail.onLocation());' in controller
    assert "api.humanizeErrors();" in controller and "api.humanizeErrors();" not in read("src/static/app_api.js")
    assert "api.humanizeErrors();" in read("src/static/app_obs_page.js")


def test_the_server_serves_the_trace_page_before_the_observability_catch_all():
    server = read("src/server.cpp")
    assert 'shell_req.path = "/trace.html";' in server
    trace = server.index('http_.Get(R"(/observability/traces/[^/]+/?)", serve_trace_shell);')
    assert trace < server.index('http_.Get(R"(/observability/.*)", redirect_to_first_view);')
    assert trace > server.index('http_.Get(R"(/observability/traces/?)", serve_view_shell("traces.html"));')


def test_the_search_opens_a_trace_by_navigating_and_the_trace_page_returns_the_same_way():
    js = modules.read_family("app_trace")
    assert 'const DETAIL_PAGE = document.body?.dataset?.page === "trace";' in js
    # The search page opens a trace as the page of that trace (app_traces.js); only the trace page loads one in place.
    opened = read("src/static/app_traces.js").split("function openTrace(", 1)[1].split("// The search view shows again", 1)[0]
    assert "window.location.assign(spanTraceUrl(id, pendingSpanId));" in opened and "api.getTrace(" not in opened
    assert "api.getTrace(" in read("src/static/app_trace_detail.js") and "api.getTrace(" not in read("src/static/app_traces.js")
    back = read("src/static/app_trace_nav.js")
    assert "router.back(steps);" in back and "window.location.assign(searchHref());" in back
    # The trace page marks the search page it came from as the entry right before it.
    assert "function markOpenedFromSearch()" in js and "markOpenedFromSearch();" in read("src/static/app_trace_detail.js")
    assert "traceSearch.applyLocation({ initial: true });" in read("src/static/app_traces.js")
    assert "applyLocation" not in read("src/static/app_trace_detail.js").replace("traceViews.applyLocation", "")
    # The Observability controller intercepts no link: a link to a trace is the browser's.
    assert "onDocumentClick" not in read("src/static/app_obs_page.js")


def test_the_trace_page_keeps_the_search_context_and_a_filter_opens_the_search():
    search = read("src/static/app_trace_search.js")
    assert "function carriedParams()" in search and 'name !== "tab" && SEARCH_PARAMS.includes(name)' in search
    assert "if (DETAIL_PAGE) return carriedParams().toString();" in search
    assert "function filterHref(field, value, action)" in search
    assert "window.location.assign(filterHref(field, value, action));" in search
    assert "if (!DETAIL_PAGE) facets = createFacets();" in search


def test_the_time_range_of_an_observability_page_goes_to_a_trace_through_the_tab_storage():
    state = read("src/static/app_state.js")
    assert 'observabilityContext: "chdash.observability.context.v1",' in state
    assert "const observabilityContext = pref(KEYS.observabilityContext, { range: null, service: null, rangeRev: 0, serviceRev: 0, seen: {}, urls: {} }, {\n  session: true," in state
    # Written when an Observability page is left, whatever the way.
    obs = read("src/static/app_obs_page.js")
    assert 'window.addEventListener("pagehide", publish);' in obs
    assert "store().set(next);" in obs and "next.range = { from: String(context.range.from), to: String(context.range.to) };" in obs
    # Read by the trace page when its address has no time range: the back arrow and the wider search.
    search = read("src/static/app_trace_search.js")
    assert "if (stored && !timeRange.url.has(out)) timeRange.url.write(out, stored);" in search
    assert "tr.url.read() || storage.observabilityContext.get().range ||" in modules.read_family("app_trace")
    # The links of Logs and Metrics stay plain: no range in the address.
    assert "?span=${encodeURIComponent(row.span_id)}` : \"\"}`);" in read("src/static/app_logs.js")
    assert "traceParams" not in read("src/static/app_metrics.js")
