from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_tag_filters_are_parsed_server_side_and_quoted():
    cpp = read("src/api_traces.cpp")
    parse = cpp[cpp.index("bool parse_trace_filters"):cpp.index("struct AttributeColumns")]
    for param in ('"tag", TagOp::Eq', '"tag_not", TagOp::Ne', '"tag_exists", TagOp::Exists', '"tag_missing", TagOp::Missing',
                  '"service_not"', '"operation_not"', '"status_not"'):
        assert param in parse
    assert "kMaxTagFilters" in parse and "kMaxTagKeyBytes" in parse
    tags = cpp[cpp.index("bool tag_filters_sql"):cpp.index("std::string span_filters_sql")]
    # Values reach SQL only through quote_string; one key's values are ORed.
    assert "quote_string(group.key)" in tags
    assert "map_values_predicate(c, group.key, group.eq)" in tags
    assert '" AND NOT " + per_column' in tags
    assert "trace_filter_disabled" in tags and "trace_tag_search_unsupported" in tags


def test_facet_queries_are_capped_allowlisted_and_cached():
    cpp = read("src/api_traces.cpp")
    limits = read("src/facet_limits.hpp")
    server = read("src/server.cpp")
    assert '"/api/traces/facets"' in server and '"/api/traces/facet_values"' in server
    facets = cpp[cpp.index("void Server::handle_traces_facets"):cpp.index("void Server::handle_traces_search")]
    assert facets.count("service_allowlist_predicate(cfg_.traces)") == 2
    assert facets.count("std::to_string(kFacetSampleRows)") == 2
    assert "SpanAttributes.keys AS sk" in facets and "ResourceAttributes.keys AS rk" in facets
    assert "facet_settings_sql(kFacetReadRowsCap, false)" in facets
    assert "facet_settings_sql(kFacetReadRowsCap, true)" in facets
    assert "&key_scope, &key" in facets  # a facet's values ignore its own filters
    # One set of caps for the trace and log facets (facet_limits.hpp).
    assert '#include "facet_limits.hpp"' in cpp and "std::string facet_settings_sql" not in cpp
    settings = limits[limits.index("inline std::string facet_settings_sql"):limits.index("inline bool timed_out")]
    for fragment in ("timeout_overflow_mode = 'break'", "max_rows_to_read = ", "read_overflow_mode = 'break'",
                     "max_rows_to_group_by = ", "group_by_overflow_mode = 'any'", "max_execution_time = "):
        assert fragment in settings
    assert "constexpr uint64_t kFacetTtlMs = 60 * 1000;" in limits
    assert "g_trace_facet_keys_cache.get_or_refresh" in facets and "g_trace_facet_values_cache.get_or_refresh" in facets
    # Estimates come from the progress packets, never from a guess.
    assert "bool partial() const { return read_rows < total_rows; }" in limits
    assert 'w.Key("estimated")' in cpp


def test_search_state_lives_in_the_url_and_the_facets_sidebar_is_bounded():
    js = read("src/static/app_trace_search.js")
    traces = read("src/static/app_traces.js")
    html = read("src/static/observability.html")
    boot = read("src/static/modules.json")  # the module lists, in load order
    assert '"app_trace_search.js"' in boot
    assert boot.index('"app_traces.js"') < boot.index('"app_trace_search.js"')
    for name in ('"from"', '"to"', '"status"', '"service"', '"operation"', '"limit"', '"sort"', '"results"',
                 '"tag"', '"tag_not"', '"tag_exists"', '"tag_missing"', '"service_not"', '"operation_not"', '"status_not"'):
        assert name in js[js.index("const SEARCH_PARAMS"):js.index("const PIN_STORE_KEY")]
    # The search page's address: the Traces owner of ns.router.
    assert 'ns.router.owner("traces", { path: "/observability/traces", params: () => (ctx ? currentParams() : null) });' in js
    assert "ns.traceSearch?.applyLocation?.({ initial: true });" in traces
    assert "ns.traceSearch?.contextQuery?.()" in traces  # trace URLs keep the search context
    # The sidebar is the facets panel shared with the Logs Fields panel.
    panel = read("src/static/app_facet_panel.js")
    assert 'const VALUE_LIMITS = [10, 50, 200, 500];' in panel
    assert "ns.facetPanel.create({" in js and 'ids: { panel: "traceFacets",' in js
    assert boot.index('"app_facet_panel.js"') < boot.index('"app_trace_search.js"')
    assert 'id="traceFacets"' in html and 'id="tracesFilterChips"' in html and 'id="tracesTagOp"' in html
    assert "chdash-trace-facets-collapsed" in html
    for action in ("Filter for this value", "Exclude this value", "Search only this", "Copy"):
        assert action in js


def test_logs_fields_panel_reuses_the_facets_panel_and_the_trace_caps():
    """Logs Fields: /api/logs/facets and facet_values on the facet caps, the
    allowlist and the logs guards; the panel is the Traces Attributes one."""
    cpp = read("src/api_logs.cpp")
    server = read("src/server.cpp")
    assert '"/api/logs/facets"' in server and '"/api/logs/facet_values"' in server
    assert '#include "facet_limits.hpp"' in cpp
    facets = cpp[cpp.index("void Server::handle_logs_facets"):]
    # Filters (allowlist included) and range limits come from open_request.
    assert facets.count("open_request(cfg_, client_pool_,") == 2
    assert "service_allowlist_predicate(cfg.traces)" in cpp[cpp.index("bool build_filters"):cpp.index("std::string time_predicate")]
    assert facets.count("std::to_string(kFacetSampleRows)") == 2
    assert "facet_settings_sql(kFacetReadRowsCap, false)" in facets and "facet_settings_sql(kFacetReadRowsCap, true)" in facets
    assert "g_log_facet_keys_cache.get_or_refresh" in facets and "g_log_facet_values_cache.get_or_refresh" in facets
    assert "without_own_filters(req, scope, key)" in facets  # a field's values ignore its own filters
    assert "facet_column_known(key)" in facets  # a column facet names a known column only
    assert "quote(key)" in facets and "quote_ident(key)" in facets
    js = read("src/static/app_logs.js")
    html = read("src/static/observability.html")
    assert "fields = ns.facetPanel.create({" in js and 'api.getLogs("facets"' in js and 'api.getLogs("facet_values"' in js
    assert 'id="logsFacets" class="uiSide traceFacets logsFacets"' in html
    assert "chdash-logs-facets-collapsed" in html


def test_trace_views_are_tabs_with_a_dropdown_on_narrow_windows():
    html = read("src/static/observability.html")
    views = read("src/static/app_trace_views.js")
    tabs = read("src/static/app_ui_tabs.js")
    css = css_sources.text()
    assert 'id="traceViewTabs" class="contentTabs traceViewTabs" role="tablist"' in html
    row = html[html.index('id="traceViewTabs"'):html.index('id="traceViewSelect"')]
    for name in ("timeline", "graph", "statistics", "spans", "flamegraph"):
        assert 'data-tab="' + name + '"' in row
    assert 'id="traceViewSelect"' in html  # the dropdown below 820 px
    assert 'viewTabs = ns.tabs?.bind(byId("traceViewTabs")' in views
    for key in ('"ArrowRight"', '"ArrowLeft"', '"Home"', '"End"'):
        assert key in tabs
    narrow = css[css.index("/* Trace detail views: the tab row"):]
    assert "@media (max-width: 820px)" in narrow[:600]
