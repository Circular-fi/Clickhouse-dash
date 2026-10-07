from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_services_endpoints_are_routed_bounded_and_allowlisted():
    server = read("src/server.cpp")
    cpp = read("src/api_traces.cpp")
    assert '"/api/traces/services"' in server and '"/api/traces/services/db"' in server
    services = cpp[cpp.index("void Server::handle_traces_services("):cpp.index("void Server::handle_traces_services_db(")]
    db = cpp[cpp.index("void Server::handle_traces_services_db("):cpp.index("// Spans of OTHER traces whose Links")]
    # Entry spans: Server / Consumer in both spellings, or root spans.
    assert "SpanKind IN ('Server', 'Consumer', 'SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = ''" in cpp
    assert "quantilesTDigestState(0.5, 0.95, 0.99)(Duration)" in services
    assert "GROUP BY GROUPING SETS ((svc), (svc, b), (svc, op))" in services
    assert "services_settings_sql()" in services and "estimate_window_rows" in services
    assert "service_allowlist_predicate(cfg_.traces)" in services and "service_allowlist_predicate(cfg_.traces)" in db
    assert "ResourceAttributes['service.version']" in services
    assert "facet_settings_sql(kServicesReleaseReadRowsCap, true)" in services
    assert "coalesce(nullif(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])" in db
    assert "facet_settings_sql(kServicesDbReadRowsCap, true)" in db
    settings = cpp[cpp.index("std::string services_settings_sql"):cpp.index("struct ServiceStats")]
    for fragment in ("max_execution_time = ", "timeout_overflow_mode = 'break'", "max_rows_to_group_by = ", "group_by_overflow_mode = 'any'"):
        assert fragment in settings
    # Large windows are sampled by time, never silently truncated.
    assert "constexpr uint64_t kServicesExactRows = 150000000;" in cpp
    assert 'w.Key("estimated"); w.Bool(window.sampled);' in services
    assert 'w.Key("partial"); w.Bool(partial);' in services
    assert "cfg.traces.analytics" in cpp[cpp.index("bool services_scope"):cpp.index("struct ServicesWindow")]


def test_traces_tabs_registry_and_services_view_are_wired():
    boot = read("src/static/modules.json")  # the module lists, in load order
    html = read("src/static/traces.html")
    tabs = read("src/static/app_trace_tabs.js")
    view = read("src/static/app_trace_services.js")
    traces = read("src/static/app_traces.js")
    search = read("src/static/app_trace_search.js")
    # One registry: Search | Services | Service map, static buttons for the first paint.
    assert boot.index('"app_trace_tabs.js"') < boot.index('"app_trace_services.js"') < boot.index('"app_trace_map.js"')
    assert html.index('id="tracesTab-search"') < html.index('id="tracesTab-services"') < html.index('id="tracesTab-map"')
    assert 'id="traceServicesView"' in html
    assert "chdash-trace-tab-services #traceServicesView[hidden]" in css_sources.text()
    assert 'if (current !== SEARCH_TAB) params.set("tab", current);' in tabs
    assert "find(current)?.writeParams?.(params);" in tabs and "find(current)?.applyParams?.(params, { initial });" in tabs
    assert "function onMeta(value)" in tabs and "function viewParams()" in tabs
    assert "ns.traceTabs.register({" in view and 'id: "services"' in view and 'panelId: "traceServicesView"' in view
    assert 'params: ["svc", "svc_sort"]' in view and "available: (meta) => meta?.analytics_enabled === true" in view
    assert "const tabSearch = ns.traceTabs?.activeSearch?.();" in traces and "ns.traceTabs?.onMeta?.(meta);" in traces
    assert "for (const name of ns.traceTabs?.viewParams?.() || []) params.delete(name);" in search
    # P99 links reuse the duration filter chip (min_duration_ms).
    assert "setDuration(ms > 0 ? { min: Math.round(ms * 1000) / 1000, max: 0 } : null);" in search
    assert "applySearch," in search
    assert "getTraceServices, getTraceServicesDb," in read("src/static/app_api.js")
