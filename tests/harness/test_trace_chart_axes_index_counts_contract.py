from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def analytics_handler():
    cpp = read("src/api_traces.cpp")
    return cpp[cpp.index("void Server::handle_traces_analytics"):cpp.index("void Server::handle_trace_detail")]


def test_count_only_requests_read_the_trace_index_and_durations_stay_on_spans():
    analytics = analytics_handler()
    # Unfiltered count charts come from the index (first start per trace);
    # anything that restricts traces keeps the span aggregation.
    assert "const bool index_counts_eligible = want_counts && !want_durations && !index_table.empty() &&" in analytics
    assert "!has_candidate_filters && having.empty() && visibility == \"1\"" in analytics
    assert "SELECT min(Start) AS first_start FROM \" + index_table" in analytics
    assert 'trace_count_source = "trace_index"' in analytics
    assert 'w.Key("charts")' in analytics
    assert "invalid_trace_charts" in analytics
    # Percentiles never come from the index (its End is the last span start).
    assert 'quantile_source = "span_bounds"' in analytics
    assert "End" not in analytics[analytics.index("const std::string index_sql"):analytics.index("std::map<int64_t, uint64_t> count_by_bucket;\n      client->Select(index_sql")]


def test_buckets_follow_the_browser_origin_grid():
    analytics = analytics_handler()
    js = read("src/static/app_traces.js")
    assert 'parse_i64_param(req, "bucket_origin_ms", &bucket_origin_ms)' in analytics
    assert "grid_floor(q_bucket_ms, bucket_ms, count_origin_ms)" in analytics
    assert 'w.Key("bucket_origin_ms")' in analytics
    assert "bucket_origin_ms: String(localMidnight(Number(filters.start_ms)))" in js
    assert '"bucket_origin_ms", "charts"' in read("src/static/app_api.js")


def test_charts_load_counts_first_and_surface_errors():
    js = read("src/static/app_traces.js")
    assert 'charts: "counts"' in js and 'charts: "durations"' in js
    assert "model.durationsError = message(error)" in js
    # A failed chart is an error state with Retry (ns.uiState), not an empty one.
    assert "state.errorHtml({ body: text, compact: true, retry: retry ? { attrs: { \"data-chart-retry\": retry } } : null })" in js
    assert ".uiState--error .uiState__title" in css_sources.text()


def test_charts_are_drawn_at_pixel_size_and_hover_snaps_to_the_nearest_point():
    js = read("src/static/app_traces.js")
    engine = read("src/static/app_chart_core.js")
    assert 'preserveAspectRatio="none"' not in js
    # Canvas charts at their pixel width, resized by the engine; the cursor
    # snaps to the nearest bucket anywhere over the plot.
    assert "ns.chartCore.create(container, { height: CHART_HEIGHT, ...options })" in js
    assert "new ResizeObserver(" in engine and "ctx.setTransform(dpr, 0, 0, dpr, 0, 0);" in engine
    assert "function nearestIndex(px)" in engine


def test_durations_use_whole_units_and_results_flag_errors_by_the_title():
    js = read("src/static/app_traces.js")
    css = css_sources.text()
    assert "const DURATION_AXIS_STEPS_NS" in js
    # Whole units ("8 min 30 s") are ns.format.duration's, which Traces uses.
    assert "`${whole} ${big} ${rest} ${small}`" in read("src/static/app_format.js")
    assert "const fmt = ns.format;" in js and "function formatDuration(" not in js
    assert "formatDurationScaled" not in js
    assert 'traceResult__wideTitle">${esc(title)}</strong>${errors ?' in js
    assert 'ns.badge.html(label, { tone: "error", className: "traceTag traceTag--error traceErrorCount--title", title' in js and ".badge--error" in css
    assert "tracesResultCount__errors" in js and ".tracesResultCount__errors" in css
    assert "traceErrorCount--total" not in js
