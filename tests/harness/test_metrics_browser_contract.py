"""Source contract of the metrics browser API (src/api_metrics.cpp)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_routes_are_registered_only_when_metrics_are_enabled():
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    block = server[server.index("  if (cfg_.metrics.enabled) {\n    http_.Get(\"/api/metrics/catalog\""):]
    block = block[:block.index("  }\n")]
    for route, handler in [
        ("/api/metrics/catalog", "handle_metrics_catalog"),
        ("/api/metrics/attributes", "handle_metrics_attributes"),
        ("/api/metrics/series", "handle_metrics_series"),
        ("/api/metrics/exemplars", "handle_metrics_exemplars"),
    ]:
        assert f'http_.Get("{route}"' in block, route
        assert f"void {handler}(const httplib::Request& req, httplib::Response& res);" in header, handler
    # The page is the Observability shell; /metrics is gone.
    assert 'http_.Get(R"(/observability/.*)", serve_observability_shell);' in server
    assert 'http_.Get("/metrics"' not in server
    assert "api_metrics.cpp" in read("src/CMakeLists.txt")


def test_shared_service_allowlist_header():
    header = read("src/otel_allowlist.hpp")
    assert "inline std::string service_allowlist_predicate(const TraceSettings& cfg) {" in header
    assert '#include "otel_allowlist.hpp"' in read("src/api_traces.cpp")
    assert "std::string service_allowlist_predicate(" not in read("src/api_traces.cpp")
    api = read("src/api_metrics.cpp")
    assert '#include "otel_allowlist.hpp"' in api
    assert api.count("service_allowlist_predicate(cfg_.traces)") >= 4


def test_queries_use_the_primary_key_prefix_and_bounded_windows():
    api = read("src/api_metrics.cpp")
    # Catalog: one branch per existing kind table, TimeUnix window, grouped by the key prefix.
    assert '" UNION ALL "' in api
    assert '" PREWHERE " + window_sql + " WHERE " +' in api
    assert '" GROUP BY ServiceName, MetricName"' in api
    assert "constexpr size_t kCatalogLimit = 5000;" in api
    assert "constexpr auto kCatalogTtl = std::chrono::seconds(60);" in api
    # Series / attributes / exemplars: ServiceName + MetricName + TimeUnix.
    assert '"ServiceName = " + quote_string(service) + " AND MetricName = " + quote_string(metric) + " AND " +' in api
    assert '"TimeUnix >= fromUnixTimestamp64Milli("' in api
    assert 'constexpr const char* kQuerySettings = " SETTINGS max_execution_time = 30";' in api
    assert "DISTINCT toString(arrayJoin(mapKeys(Attributes)))" in api
    assert "constexpr size_t kMaxSeriesRows = 300000;" in api


def test_counter_and_histogram_math_is_reset_aware():
    api = read("src/api_metrics.cpp")
    assert "PARTITION BY \" + series_id" in api
    assert 'const std::string series_id = "cityHash64(Attributes, ResourceAttributes)";' in api
    assert "multiIf(temporality = 1, v1, rn = 1, nan, ps != StartTimeUnix OR" in api
    assert "lagInFrame(BucketCounts) OVER w AS pc" in api
    assert "sumForEach(dc)" in api
    assert "double explicit_quantile(double q, const std::vector<double>& bounds, const std::vector<double>& counts)" in api
    assert "return std::exp2(std::ldexp(static_cast<double>(index), -scale));" in api
    assert "void downscale(ExpState& state, int scale)" in api
    assert "Summary quantiles are precomputed per series and cannot be aggregated across series" in api


def test_exemplars_query_shape():
    api = read("src/api_metrics.cpp")
    assert "arrayJoin(arrayZip(`Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.TraceId`, `Exemplars.SpanId`))" in api
    assert 'WHERE notEmpty(e.3) AND e.1 >= "' in api
    assert '" ORDER BY e.2 DESC, e.1 LIMIT " + std::to_string(per_bucket) + " BY b LIMIT "' in api


def test_docs_describe_the_browser_api():
    docs = read("docs/metrics.md")
    for text in ["GET /api/metrics/catalog", "GET /api/metrics/attributes", "GET /api/metrics/series",
                 "GET /api/metrics/exemplars", "counter reset", "histogram_quantile"]:
        assert text in docs, text


def test_metrics_view_shell_and_switcher():
    html = read("src/static/observability.html")
    section = html[html.index("<!-- observability:metrics -->"):html.index("<!-- /observability:metrics -->")]
    assert '<main id="metricsWorkspace" data-obs-panel="metrics" class="obsView metricsWorkspace" role="main">' in section
    assert '<form id="metricsToolbar" class="traceSearchBar metricsToolbar" autocomplete="off">' in section
    assert 'id="obsTab-metrics" data-obs-tab="metrics" aria-controls="metricsWorkspace"' in html
    assert not (ROOT / "src/static/metrics.html").exists()
    controller = read("src/static/app_observability.js")
    assert '    metrics: ["app_chart_core.js", "app_metrics.js"],' in controller
    # Query and Explorer: one Observability entry, hidden until /api/version reveals it.
    for page in ["query.html", "explorer.html"]:
        shell = read(f"src/static/{page}")
        assert 'data-value="observability" aria-selected="false" hidden>Observability</button>' in shell, page
        # The shell hides the switcher only when no other page is enabled.
        assert "pageNav.traces !== true" in shell and "pageNav.metrics !== true" in shell, page
    ui = read("src/static/app_ui.js")
    assert "if (dom.navObservabilityButton) dom.navObservabilityButton.hidden = !observabilityEnabled;" in ui
    assert 'window.location.assign(api.resolveUrl("observability"))' in ui
    assert "metrics: nav?.metrics === true" in read("src/static/app_state.js")


def test_metrics_page_keeps_its_state_in_the_url_and_links_exemplars_to_spans():
    js = read("src/static/app_metrics.js")
    for param in ['params.set("from"', 'params.set("group_by"', '"filter_not" : "filter"', 'params.append("panel"',
                  'params.set("exemplars", "0")']:
        assert param in js, param
    assert "bucket_origin_ms: localMidnight(range.start_ms)" in js
    assert 'const url = `${route("observability/metrics")}?${urlQuery()}`;' in js
    assert '`${route(`observability/traces/${encodeURIComponent(ex.trace_id)}`)}${ex.span_id ? `?span=${encodeURIComponent(ex.span_id)}` : ""}`' in js
    for route in ["api/metrics/catalog?", "api/metrics/series?", "api/metrics/exemplars?", "api/metrics/attributes?"]:
        assert route in js, route
