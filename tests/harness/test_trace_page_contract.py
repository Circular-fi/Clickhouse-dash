import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def test_one_trace_is_its_own_html_page_without_the_observability_tabs():
    html = read("src/static/trace.html")
    obs = read("src/static/observability.html")
    assert '<body data-page="trace">' in html
    assert "static/style.trace.css" in html
    # The page header stays; the Observability view tabs (Traces, Logs, Metrics) and the search do not.
    assert '<header class="appHeader" role="banner">' in html
    assert 'id="navObservabilityButton" class="themeSelect__option" type="button" role="option" data-value="observability" aria-selected="true"' in html
    for token in ('id="obsNav"', 'id="obsTabs"', 'id="tracesTabs"', 'id="tracesForm"', 'data-obs-panel', 'id="logsWorkspace"', 'id="metricsWorkspace"'):
        assert token not in html, token
    # The trace pane lives in trace.html only; observability.html keeps the search.
    for token in ('id="traceDetail"', 'id="traceBackButton"', 'id="traceWaterfall"', 'id="traceLogsPanel"'):
        assert token in html and token not in obs, token
    # Both pages show errors in the same banner.
    assert 'id="tracesError" class="uiBanner" role="alert" hidden' in html and 'id="tracesError" class="uiBanner" role="alert" hidden' in obs
    assert 'id="traceDetail" class="traceDetailPane traceDetailPane--jaeger" aria-label="Trace">' in html
    assert 'id="tracesForm"' in obs and 'id="obsNav"' in obs


def test_the_trace_page_loads_the_trace_modules_without_the_search_ones():
    data = json.loads(read("src/static/modules.json"))
    page = data["pages"]["trace"]
    assert page["bootstrap"] == "app_trace_page.js"
    for name in ("app_traces.js", "app_trace_views.js", "app_trace_insights.js", "app_trace_logs.js", "app_trace_search.js", "app_graph_kit.js", "app_timerange.js"):
        assert name in page["modules"], name
    for name in ("app_trace_spans.js", "app_trace_tabs.js", "app_trace_services.js", "app_trace_map.js", "app_trace_heatmap.js", "app_facet_panel.js", "app_ui_filterbar.js"):
        assert name not in page["modules"], name
    # The search view no longer loads the trace-only views and logs modules for a trace pane it does not hold.
    controller = read("src/static/app_trace_page.js")
    assert "ns.lifecycle.enter(\"traces\")" in controller and "ns.traces.init();" in controller
    assert 'ns.router.on("/observability", () => ns.traces.onLocation());' in controller
    assert "ns.api.humanizeErrors();" in controller and "ns.api.humanizeErrors();" not in read("src/static/app_api.js")
    assert "window.ChDash.api.humanizeErrors();" in read("src/static/app_observability.js")


def test_the_server_serves_the_trace_page_before_the_observability_catch_all():
    server = read("src/server.cpp")
    assert 'shell_req.path = "/trace.html";' in server
    trace = server.index('http_.Get(R"(/observability/traces/[^/]+/?)", serve_trace_shell);')
    assert trace < server.index('http_.Get(R"(/observability/.*)", serve_observability_shell);')
    assert "if (cfg_.traces.enabled) {\n    // Registered before /observability/.*" in server


def test_the_search_opens_a_trace_by_navigating_and_the_trace_page_returns_the_same_way():
    js = read("src/static/app_traces.js")
    assert 'const DETAIL_PAGE = document.body?.dataset?.page === "trace";' in js
    load = js.split("async function loadTrace(", 1)[1].split("// The detail pane of a trace that could not be loaded", 1)[0]
    assert "if (!DETAIL_PAGE) {\n      // The search opens a trace as the page of that trace" in load
    assert "window.location.assign(spanTraceUrl(id, pendingSpanId));" in load
    back = js.split("function returnToSearch(", 1)[1].split("function restoreSearch(", 1)[0]
    assert "ns.router.back(steps);" in back and "window.location.assign(searchHref());" in back
    # The trace page marks the search page it came from as the entry right before it.
    assert "function markOpenedFromSearch()" in js and "if (DETAIL_PAGE) markOpenedFromSearch();" in js
    assert "if (!DETAIL_PAGE) ns.traceSearch?.applyLocation?.({ initial: true });" in js
    # The observability controller leaves a link to a trace to the browser.
    obs = read("src/static/app_observability.js")
    assert "isTracePath(url.pathname)" in obs


def test_the_trace_page_keeps_the_search_context_and_a_filter_opens_the_search():
    search = read("src/static/app_trace_search.js")
    assert "function carriedParams()" in search and 'name !== "tab" && SEARCH_PARAMS.includes(name)' in search
    assert "if (ctx.detail) return carriedParams().toString();" in search
    assert "function filterHref(field, value, action)" in search
    assert "window.location.assign(filterHref(field, value, action));" in search
    assert "if (!ctx.detail) facets = createFacets();" in search


def test_the_time_range_of_an_observability_page_goes_to_a_trace_through_the_tab_storage():
    state = read("src/static/app_state.js")
    assert 'observabilityContext: "chdash.observability.context.v1",' in state
    assert "const observabilityContext = pref(KEYS.observabilityContext, { range: null }, {\n    session: true," in state
    # Written when an Observability page is left, whatever the way.
    obs = read("src/static/app_observability.js")
    assert 'window.addEventListener("pagehide", persistContext);' in obs
    assert "window.ChDash.storage.observabilityContext.set({ range:" in obs
    # Read by the trace page when its address has no time range: the back arrow and the wider search.
    search = read("src/static/app_trace_search.js")
    assert "if (stored && !ns.timeRange.url.has(out)) ns.timeRange.url.write(out, stored);" in search
    assert "tr.url.read() || ns.storage.observabilityContext.get().range ||" in read("src/static/app_traces.js")
    # The links of Logs and Metrics stay plain: no range in the address.
    assert "?span=${encodeURIComponent(row.span_id)}` : \"\"}`);" in read("src/static/app_logs.js")
    assert "traceParams" not in read("src/static/app_metrics.js")
