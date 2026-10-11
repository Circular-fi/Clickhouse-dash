from pathlib import Path
from trace_sources import read_traces, read_unit
import modules
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_services_endpoints_are_routed_bounded_and_allowlisted():
    server = read("src/server.cpp")
    cpp = read("src/api_traces.cpp")
    assert '"/api/traces/services"' in server and '"/api/traces/services/db"' in server
    assert "trace_service_.services(" in cpp and "trace_service_.services_db(" in cpp
    sql = read_unit("trace_sql.cpp")
    header = read_unit("trace_sql.hpp")
    run = read_unit("trace_services.cpp")
    service = read_unit("trace_service.cpp")
    services = sql[sql.index("std::string services_sql"):sql.index("std::string services_slowest_sql")]
    db = sql[sql.index("std::string services_db_sql"):]
    # Entry spans: Server / Consumer in both spellings, or root spans.
    assert "SpanKind IN ('Server', 'Consumer', 'SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = ''" in header
    assert "quantilesTDigestState(0.5, 0.95, 0.99)(Duration)" in services
    assert "GROUP BY GROUPING SETS ((svc), (svc, b), (svc, op))" in services
    assert "services_settings_sql()" in services and "estimate_window_rows" in run
    # One allowlist for the two routes: the query that they share (open_services).
    assert service[service.index("TraceService::open_services"):service.index("TraceService::services(")].count("service_allowlist_predicate(traces)") == 1
    assert "ResourceAttributes['service.version']" in sql
    assert "facet_settings_sql(kServicesReleaseReadRowsCap, true)" in sql
    assert "coalesce(nullif(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])" in db
    assert "facet_settings_sql(kServicesDbReadRowsCap, true)" in db
    settings = sql[sql.index("std::string services_settings_sql"):sql.index("std::string services_from")]
    for fragment in ("max_execution_time = ", "timeout_overflow_mode = 'break'", "max_rows_to_group_by = ", "group_by_overflow_mode = 'any'"):
        assert fragment in settings
    # Large windows are sampled by time, never silently truncated.
    assert "constexpr uint64_t kServicesExactRows = 150000000;" in header
    json = read_unit("trace_json.cpp")
    assert 'w.Key("estimated"); w.Bool(out.window.sampled);' in json
    assert 'w.Key("partial"); w.Bool(out.partial);' in json
    request = read_unit("trace_request.cpp")
    assert "traces.analytics" in request[request.index("bool parse_services"):request.index("bool parse_prefill")]


def test_traces_tabs_registry_and_services_view_are_wired():
    boot = modules.page_files("traces")  # the modules of the page, dependencies first
    html = read("src/static/traces.html")
    tabs = read("src/static/app_trace_tabs.js")
    view = read("src/static/app_trace_services.js")
    traces = modules.read_family("app_trace")
    search = read("src/static/app_trace_search.js")
    # One registry: Search | Services | Service map, static buttons for the first paint.
    assert boot.index("app_trace_tabs.js") < boot.index("app_trace_services.js") and boot.index("app_trace_tabs.js") < boot.index("app_trace_map.js")
    assert 'import "./app_trace_services.js";' in read("src/static/app_page_traces.js")
    assert html.index('id="tracesTab-search"') < html.index('id="tracesTab-services"') < html.index('id="tracesTab-map"')
    assert 'id="traceServicesView"' in html
    assert "chdash-trace-tab-services #traceServicesView[hidden]" in css_sources.text()
    assert 'if (current !== SEARCH_TAB) params.set("tab", current);' in tabs
    assert "find(current)?.writeParams?.(params);" in tabs and "find(current)?.applyParams?.(params, { initial });" in tabs
    assert "function onMeta(value)" in tabs and "function viewParams()" in tabs
    assert "traceTabs.register({" in view and 'id: "services"' in view and 'panelId: "traceServicesView"' in view
    assert 'params: ["svc", "svc_sort"]' in view and "available: (meta) => meta?.analytics_enabled === true" in view
    assert "const tabSearch = traceTabs.activeSearch();" in traces and "traceTabs.onMeta(meta);" in traces
    assert "for (const name of traceTabs?.viewParams?.() || []) params.delete(name);" in search
    # P99 links reuse the duration filter chip (min_duration_ms).
    assert "setDuration(ms > 0 ? { min: Math.round(ms * 1000) / 1000, max: 0 } : null);" in search
    assert "applySearch," in search
    assert "getTraceServices, getTraceServicesDb," in read("src/static/app_api.js")
