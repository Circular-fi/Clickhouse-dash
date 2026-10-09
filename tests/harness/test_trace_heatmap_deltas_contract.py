from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def section(text, start, end):
    return text[text.index(start):text.index(end)]


def test_heatmap_counts_traces_in_one_bounded_pass():
    cpp = read("src/api_traces.cpp")
    server = read("src/server.cpp")
    assert '"/api/traces/heatmap"' in server and '"/api/traces/deltas"' in server
    common = section(cpp, "bool trace_window_request", "int64_t grid_floor_ms")
    # Same gates and filters as the analytics: feature flags, allowlist.
    assert '"trace_analytics_disabled"' in common and "feature_param_rejected" in common
    assert "trace_filters_sql(" in common and "service_allowlist_predicate(traces)" in common
    heat = section(cpp, "void Server::handle_traces_heatmap", "void Server::handle_traces_deltas")
    assert "filters_are_broad(" in heat  # the analytics' cheap path for broad key filters
    assert "log2(greatest(duration_ns, 1))" in heat
    assert "kHeatmapTimeBudgetSeconds" in heat and "SETTINGS max_execution_time = " in heat
    assert "std::ceil(static_cast<double>(total) * 0.01)" in heat  # lowest row: the 1 % quantile bin
    assert 'w.Key("unit"); w.String("traces");' in heat


def test_deltas_compare_two_stable_bounded_samples():
    cpp = read("src/api_traces.cpp")
    deltas = cpp[cpp.index("void Server::handle_traces_deltas"):]
    assert "ORDER BY in_box DESC, cityHash64(TraceId) LIMIT " in deltas
    assert "kDeltaMaxCoreMs" in deltas and "kDeltaSlices" in deltas
    assert "kDeltaMaxSample" in deltas and "SETTINGS max_execution_time = " in deltas
    # Only the sampled traces' spans are expanded, allowlisted.
    assert "arrayJoin(arrayConcat(" in deltas and "trace_id_list_sql(all_ids)" in deltas
    assert "scope.visibility" in deltas
    assert "('column', 'ServiceName'" in deltas and "('column', 'StatusCode'" in deltas
    assert "cols.span()" in deltas and "cols.resource()" in deltas
    for reason in ('"id_like"', '"high_cardinality"'):
        assert reason in deltas
    assert "kDeltaMinOccurrences" in deltas and "semconv_key(" in deltas


def test_heatmap_module_is_wired_to_the_duration_chart_and_the_search():
    boot = read("src/static/modules.json")  # the module lists, in load order
    js = read("src/static/app_trace_heatmap.js")
    traces = read("src/static/app_traces.js")
    search = read("src/static/app_trace_search.js")
    html = read("src/static/traces.html")
    assert boot.index('"app_trace_search.js"') < boot.index('"app_trace_heatmap.js"')
    assert 'data-duration-view="heatmap"' in html and 'id="traceDeltaPanel"' in html
    assert "if (ns.traceHeatmap?.active?.()) { ns.traceHeatmap.render(); return; }" in traces
    assert "ns.traceHeatmap?.onSearch?.(analyticsFilters);" in traces
    assert "ns.traceHeatmap?.writeParams?.(params);" in search
    assert '"min_duration_ms", "max_duration_ms", "duration_view"' in search
    assert "filter: (field, value) => applyFilter(field, value, \"include\")" in search
    assert "ns.traceSearch?.filter?.(field, hit.value.value)" in js
    assert "ns.traceSearch?.setDuration?.(" in js
    assert 'const modePref = () => ns.storage.pref(ns.storage.KEYS.traceDurationView, "percentiles", { allowed: MODES });' in js
    assert 'traceDurationView: "chdash.traceDurationView.v1",' in read("src/static/app_state.js")
