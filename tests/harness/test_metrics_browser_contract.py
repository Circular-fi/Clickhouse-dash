"""Source contract of the metrics browser API (src/api_metrics.cpp and the units src/metrics_*.cpp)."""
import modules
import json
from pathlib import Path
from metrics_sources import read_metrics
from trace_sources import read_traces, read_unit

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_routes_are_registered_only_when_metrics_are_enabled():
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    block = server[server.index("  if (cfg_.metrics_on()) {\n    http_.Get(\"/api/metrics/catalog\""):]
    block = block[:block.index("  }\n")]
    for route, handler in [
        ("/api/metrics/catalog", "handle_metrics_catalog"),
        ("/api/metrics/attributes", "handle_metrics_attributes"),
        ("/api/metrics/series", "handle_metrics_series"),
        ("/api/metrics/exemplars", "handle_metrics_exemplars"),
    ]:
        assert f'http_.Get("{route}"' in block, route
        assert f"void {handler}(const httplib::Request& req, httplib::Response& res);" in header, handler
    # The page is /observability/metrics (metrics.html); /metrics is the Prometheus text of the server
    # (docs/operations.md, "Metrics"), never the page.
    assert 'if (cfg_.metrics_on()) http_.Get(R"(/observability/metrics/?)", serve_view_shell("metrics.html"));' in server
    assert 'http_.Get(R"(/observability/.*)", redirect_to_first_view);' in server
    assert 'if (cfg_.server.metrics) http_.Get("/metrics", [&](const auto& req, auto& res) { handle_metrics(req, res); });' in server
    assert 'http_.Get("/metrics", serve' not in server
    cmake = read("src/CMakeLists.txt")
    for unit in ("api_metrics.cpp", "metrics_request.cpp", "metrics_sql.cpp", "metrics_aggregate.cpp", "metrics_service.cpp", "metrics_json.cpp"):
        assert unit in cmake, unit


def test_shared_service_allowlist_header():
    header = read("src/otel_allowlist.hpp")
    assert "inline std::string service_allowlist_predicate(const TraceSettings& cfg) {" in header
    assert '#include "otel_allowlist.hpp"' in read_unit("trace_service.cpp")
    assert "std::string service_allowlist_predicate(" not in read_traces()
    service = read_unit("metrics_service.cpp")
    assert '#include "otel_allowlist.hpp"' in service
    # Every route of the page passes the allowlist to its statements: the catalog, the attributes, the series and the exemplars.
    assert service.count("service_allowlist_predicate(host.otel.traces)") >= 4


def test_queries_use_the_primary_key_prefix_and_bounded_windows():
    api = read_metrics()
    # Catalog: one branch per existing kind table, TimeUnix window, grouped by the key prefix.
    assert '" UNION ALL "' in api
    assert '" PREWHERE " + window_sql + " WHERE " +' in api
    assert '" GROUP BY ServiceName, MetricName"' in api
    assert "constexpr size_t kCatalogLimit = 5000;" in api
    assert "constexpr uint64_t kCatalogReadRowsCap = 200'000'000;" in api
    assert "constexpr auto kCatalogTtl = std::chrono::seconds(60);" in read("src/otel_caches.hpp")
    # Series / attributes / exemplars: ServiceName + MetricName + TimeUnix.
    # The service, the metric and the attribute values are query parameters ({pN:String}), never inside the SQL text.
    assert '"ServiceName = " + service + " AND MetricName = " + metric + " AND " + time_predicate(start_ms, end_ms);' in api
    assert "const std::string service = params.text(request.service);" in api
    assert "const std::string metric = params.text(request.metric);" in api
    assert '(key_op.second == "=" ? "IN (" : "NOT IN (") + list + ")"' in api
    assert "quote_string(service)" not in api and "quote_string(values" not in api and "quote_string(key)" not in api
    assert '"TimeUnix >= fromUnixTimestamp64Milli("' in api
    assert 'constexpr const char* kQuerySettings = " SETTINGS max_execution_time = 30";' in api
    assert "DISTINCT toString(arrayJoin(mapKeys(Attributes)))" in api
    assert "constexpr size_t kMaxSeriesRows = 300000;" in api
    # The statements that group and rank the points of a window bound their memory; the groups are ranked in ClickHouse (ARCH-B-025).
    assert "max_memory_usage = 2000000000, max_bytes_before_external_group_by = 1000000000" in api
    assert "SeriesStatements::ranking(" in api and 'sumKahanIf(abs(v), isFinite(v)) AS score' in api
    assert "ORDER BY score DESC, g LIMIT" in api and "kOtherGroupKey" in api


def test_counter_and_histogram_math_is_reset_aware():
    api = read_metrics()
    assert "PARTITION BY \" + series_id" in api
    assert '"cityHash64(Attributes, ResourceAttributes)"' in api
    assert "multiIf(temporality = 1, v1, rn = 1, nan, ps != StartTimeUnix OR" in api
    assert "lagInFrame(BucketCounts) OVER w AS pc" in api
    assert "sumForEach(dc)" in api
    assert "double explicit_quantile(double q, const std::vector<double>& bounds, const std::vector<double>& counts)" in api
    assert "return std::exp2(std::ldexp(static_cast<double>(index), -scale));" in api
    assert "void downscale(ExpState& state, int scale)" in api
    assert "Summary quantiles are precomputed per series and cannot be aggregated across series" in api


def test_exemplars_query_shape():
    api = read_metrics()
    assert "arrayJoin(arrayZip(`Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.TraceId`, `Exemplars.SpanId`))" in api
    assert 'WHERE notEmpty(e.3) AND e.1 >= "' in api
    assert '" ORDER BY e.2 DESC, e.1 LIMIT " + std::to_string(request.per_bucket) + " BY b LIMIT "' in api


def test_docs_describe_the_browser_api():
    docs = read("docs/metrics.md")
    for text in ["GET /api/metrics/catalog", "GET /api/metrics/attributes", "GET /api/metrics/series",
                 "GET /api/metrics/exemplars", "counter reset", "histogram_quantile"]:
        assert text in docs, text


def test_metrics_view_shell_and_switcher():
    html = read("src/static/metrics.html")
    section = html
    assert '<main id="metricsWorkspace" data-obs-panel="metrics" class="obsView metricsWorkspace" role="main">' in section
    # The filter bar spans the catalog and the panels: it comes before the sidebar.
    assert '<form id="metricsToolbar" class="obsFilterBar traceSearchBar metricsToolbar" autocomplete="off">' in section
    assert section.index('id="metricsToolbar"') < section.index('id="metricsSidebar"')
    assert 'id="obsTab-metrics" data-obs-tab="metrics" href="/observability/metrics"' in html
    files = modules.page_files("metrics")
    assert files[-1] == "app_page_metrics.js" and {"app_obs_page.js", "app_chart_core.js", "app_metrics.js"} <= set(files)
    assert "app_traces.js" not in files and "app_logs.js" not in files
    # Query and Explorer: one Observability entry, hidden until /api/version reveals it.
    for page in ["query.html", "explorer.html"]:
        shell = read(f"src/static/{page}")
        assert 'id="navObservabilityLink" class="pageNav__link" href="/observability" hidden>Observability</a>' in shell, page
        # The shell hides the switcher only when no other page is enabled.
        assert "pageNav.traces !== true" in shell and "pageNav.metrics !== true" in shell, page
    ui = read("src/static/app_header.js") + read("src/static/app_query_ui.js")
    assert "if (dom.navObservabilityLink) dom.navObservabilityLink.hidden = !observabilityEnabled;" in ui
    assert 'href="/observability"' in read("src/shell/header.html") and "navObservabilityLink.addEventListener" not in ui
    assert "metrics: nav?.metrics === true" in read("src/static/app_state.js")


def test_metrics_page_keeps_its_state_in_the_url_and_links_exemplars_to_spans():
    js = read("src/static/app_metrics.js")
    for param in ['timeRange.url.write(new URLSearchParams(), model.range)', 'timeRange.url.read(params)', 'params.set("group_by"', '"filter_not" : "filter"', 'params.append("panel"',
                  'params.set("exemplars", "0")']:
        assert param in js, param
    assert "bucket_origin_ms: timeRange.localMidnight(range.start_ms)" in js
    assert 'const address = router.owner("metrics", { path: "/observability/metrics", params: () => urlQuery() });' in js
    assert '`${router.url(`/observability/traces/${encodeURIComponent(ex.trace_id)}`)}${ex.span_id ? `?span=${encodeURIComponent(ex.span_id)}` : ""}`' in js
    # The routes are named endpoints of app_api.js.
    api = read("src/static/app_api.js")
    for route, call in [("api/metrics/meta?", "api.getMetricsMeta("), ("api/metrics/catalog?", "api.getMetricsCatalog("),
                        ("api/metrics/series?", "api.getMetricsSeries("), ("api/metrics/exemplars?", "api.getMetricsExemplars("),
                        ("api/metrics/attributes?", "api.getMetricsAttributes(")]:
        assert route in api and route not in js, route
        assert call in js, call
