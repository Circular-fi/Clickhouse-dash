"""Source contract: the Traces service map keeps its bounded, allowlisted SQL
(time slices, consistent trace sampling, hashed parent join, time budget) and
its page wiring (tab registry, ?tab= in the URL, search hand-off)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def handler(api: str, name: str) -> str:
    start = api.index(f"void Server::{name}(")
    end = api.find("\nvoid Server::", start + 1)
    return api[start:end if end > 0 else len(api)]


def test_service_map_sql_is_bounded_sampled_and_allowlisted():
    api = read("src/api_traces.cpp")
    body = handler(api, "handle_traces_service_map")
    assert 'http_.Get("/api/traces/service_map"' in read("src/server.cpp")
    assert "void handle_traces_service_map(" in read("src/server.hpp")
    # Same filters, validation and allowlist as search.
    for text in ("feature_param_rejected(cfg_.traces, req", "trace_time_range(cfg_.traces, req", "parse_trace_filters(req, &filters",
                 "trace_filters_sql(*client, *host, cfg_.traces, filters", "service_allowlist_predicate(cfg_.traces)"):
        assert text in body, text
    # Both join sides read the same allowlisted, sliced, sampled scan.
    assert 'const std::string scan = " FROM " + table + " PREWHERE " + time_predicate + sample_sql + " WHERE " + visibility;' in body
    assert body.count("+ side +") == 2
    # Budgets: EXPLAIN ESTIMATE rows -> time slices; consistent trace sampling.
    assert '"EXPLAIN ESTIMATE SELECT 1 FROM "' in body
    assert "constexpr uint64_t kServiceMapReadRows = 12000000;" in api
    assert "constexpr uint64_t kServiceMapJoinRows = 3000000;" in api
    assert "constexpr int kServiceMapMaxSlices = 48;" in api
    assert '" AND cityHash64(TraceId) % " + std::to_string(trace_factor) + " = 0"' in body
    assert "max_execution_time = \" + std::to_string(kServiceMapTimeBudgetSeconds)" in body
    # Parent lookup on a 64-bit key, one parent per child, both result levels in one query.
    assert "if(ParentSpanId = '', 0, cityHash64(TraceId, ParentSpanId)) AS pk" in body
    assert "cityHash64(TraceId, SpanId) AS k" in body
    assert "ANY LEFT JOIN" in body
    assert "GROUP BY GROUPING SETS ((if(p.parent_service != c.service, p.parent_service, '') AS caller, service), (service))" in body
    # The estimate is reported.
    for key in ('w.Key("sampled")', 'w.Key("sample_factor")', 'w.Key("trace_factor")', 'w.Key("time_coverage")', 'w.Key("slices")'):
        assert key in body, key


def test_service_map_tab_is_registered_and_lives_in_the_url():
    boot = read("src/static/app_observability.js")
    tabs = read("src/static/app_trace_tabs.js")
    mapjs = read("src/static/app_trace_map.js")
    search = read("src/static/app_trace_search.js")
    traces = read("src/static/app_traces.js")
    html = read("src/static/observability.html")
    api = read("src/static/app_api.js")
    assert boot.index('"app_trace_search.js"') < boot.index('"app_trace_tabs.js"') < boot.index('"app_trace_map.js"')
    assert "ns.traceTabs = {" in tabs and "register," in tabs
    assert 'ns.traceTabs.register({\n    id: "map",' in mapjs
    assert 'params.set("tab", current)' in tabs
    assert "ns.traceTabs?.writeParams?.(params);" in search
    assert "ns.traceTabs?.applyParams?.(params, { initial });" in search
    assert 'params.delete("tab");' in search  # the tab is not part of the search identity
    assert "applyFilter," in search
    assert "const tabSearch = ns.traceTabs?.activeSearch?.();" in traces
    assert "ns.traceTabs?.install?.({" in traces
    assert "api/traces/service_map?" in api
    for element in ('id="tracesTabs"', 'id="traceMapView"', 'id="traceMapCanvas"', 'id="traceMapSampled"', 'id="traceMapPanel"',
                    'id="traceMapFit"', 'id="traceMapMinimap"', 'role="tablist"', "chdash-trace-tab-"):
        assert element in html, element
    for text in ("Search this service", "Search errors", "Focus map", "Search calls", "sampled ×", "Loading service map",
                 "No services in this time range", "Health dot: error rate", "asynchronous message (producer"):
        assert text in mapjs, text
    # The map is drawn by the shared canvas graph kit, like the Explorer graph.
    assert boot.index('"app_graph_kit.js"') < boot.index('"app_trace_map.js"')
    for text in ("kit.mount({", "kit.layered({", "kit.routeEdges(positions", "kit.placeLabels(requests", "kit.drawCard(context, item, card)",
                 "kit.drawMinimap(minimap", "kit.panelHeader({"):
        assert text in mapjs, text
    # The canvas is the only view (no Graph / List switch, no list), on phones too.
    assert 'id="traceMapList"' not in html
    for text in ("viewSwitch", "graphKitList", "renderList"):
        assert text not in mapjs, text
    assert "<svg" not in mapjs and "createElementNS" not in mapjs
    assert "ns.traceSearch.applyFilter({ kind: \"service\" }, service, \"include\")" in mapjs
    assert "ctx.serviceColor(node.service)" in mapjs


def test_service_map_is_documented_and_tested():
    docs = read("docs/traces.md")
    assert "## Service map" in docs and "/api/traces/service_map" in docs and "?tab=map" in docs
    assert "'specs/trace-service-map.spec.js'" in read("tests/test-suite/run-all-tests.py")
    assert (ROOT / "tests/backend-functional/test_trace_service_map.py").exists()
