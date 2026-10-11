from pathlib import Path
from logs_sources import read_unit as read_logs_unit
from trace_sources import read_traces, read_unit
import modules
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_tag_filters_are_parsed_server_side_and_quoted():
    cpp = read_traces()
    request_unit = read_unit("trace_request.cpp")
    parse = request_unit[request_unit.index("bool parse_trace_filters"):request_unit.index("bool parse_window")]
    for param in ('"tag", TagOp::Eq', '"tag_not", TagOp::Ne', '"tag_exists", TagOp::Exists', '"tag_missing", TagOp::Missing',
                  '"service_not"', '"operation_not"', '"status_not"'):
        assert param in parse
    assert "kMaxTagFilters" in parse and "kMaxTagKeyBytes" in parse
    filters_unit = read_unit("trace_filters.cpp")
    tags = filters_unit[filters_unit.index("bool tag_filters_sql"):filters_unit.index("std::string span_filters_sql")]
    # Values reach SQL only through quote_string; one key's values are ORed.
    assert "quote_string(group.key)" in tags
    assert "map_values_predicate(c, group.key, group.eq)" in tags
    assert '" AND NOT " + per_column' in tags
    assert "set_attribute_scope_error(" in tags
    assert "trace_filter_disabled" in cpp and "trace_tag_search_unsupported" in cpp and "trace_schema_unavailable" in cpp


def test_facet_queries_are_capped_allowlisted_and_cached():
    cpp = read_traces()
    limits = read("src/facet_limits.hpp")
    server = read("src/server.cpp")
    assert '"/api/traces/facets"' in server and '"/api/traces/facet_values"' in server
    sql = read_unit("trace_facets.cpp")
    service = read_unit("trace_service.cpp")
    facets = service[service.index("TraceService::facet_keys"):service.index("TraceService::trace_detail")]
    assert facets.count("service_allowlist_predicate(traces)") == 2
    assert sql.count("std::to_string(kFacetSampleRows)") == 2
    assert "SpanAttributes.keys AS sk" in sql and "ResourceAttributes.keys AS rk" in sql
    assert "facet_settings_sql(read_cap, false)" in sql and "read_rows_limit_param(req, kFacetReadRowsCap)" in read_unit("trace_request.cpp")
    assert "facet_settings_sql(read_cap, true)" in sql
    assert "&request.key_scope, &request.key" in facets  # a facet's values ignore its own filters
    # One set of caps for the trace and log facets (facet_limits.hpp).
    assert '#include "facet_limits.hpp"' in read_unit("trace_facets.hpp") and "std::string facet_settings_sql" not in cpp
    settings = limits[limits.index("inline std::string facet_settings_sql"):limits.index("inline bool timed_out")]
    for fragment in ("timeout_overflow_mode = 'break'", "max_rows_to_read = ", "read_overflow_mode = 'break'",
                     "max_rows_to_group_by = ", "group_by_overflow_mode = 'any'", "max_execution_time = "):
        assert fragment in settings
    assert "constexpr uint64_t kFacetTtlMs = 60 * 1000;" in limits
    # Server-owned caches (single-flight); the client's text enters the keys as a digest, and a value keeps the served
    # keys only (kFacetMaxKeys + 1, ordered and cut in SQL too).
    assert "facet_keys_.get(" in facets and "facet_values_.get(" in facets
    assert "trace_facet_keys_cache_" in read("src/server.hpp") and "trace_facet_values_cache_" in read("src/server.hpp")
    assert "sha256_hex(span_filters)" in facets and "sha256_hex(request.key + '\\0' + span_filters)" in facets
    assert '" ORDER BY t.3 DESC, t.2 ASC, t.1 DESC LIMIT " + std::to_string(kFacetMaxKeys + 1)' in sql
    assert "if (value.keys.size() > kFacetMaxKeys + 1) value.keys.resize(kFacetMaxKeys + 1);" in sql
    # Estimated when a bound stopped the scan (the read cap reached, the
    # sample full, the time budget), never from total_rows_to_read, which
    # counts the granules the skip indexes drop afterwards.
    assert "bool capped(uint64_t read_rows_cap) const { return read_rows_cap > 0 && read_rows >= read_rows_cap; }" in limits
    assert "partial()" not in cpp and "partial()" not in limits
    assert "value.sampled_spans >= kFacetSampleRows || read.capped(read_cap) || value.timed_out" in sql
    assert 'w.Key("estimated")' in cpp


def test_search_state_lives_in_the_url_and_the_facets_sidebar_is_bounded():
    js = read("src/static/app_trace_search.js")
    traces = modules.read_family("app_trace")
    html = read("src/static/traces.html")
    boot = modules.page_files("traces")  # the modules of the page, dependencies first
    assert "app_trace_search.js" in boot and "app_trace_search.js" in modules.imports("app_traces.js")
    for name in ('"from"', '"to"', '"status"', '"service"', '"operation"', '"limit"', '"sort"', '"results"',
                 '"tag"', '"tag_not"', '"tag_exists"', '"tag_missing"', '"service_not"', '"operation_not"', '"status_not"'):
        assert name in js[js.index("const SEARCH_PARAMS"):js.index("const PIN_STORE_KEY")]
    # The search page's address: the Traces owner of ns.router.
    assert 'router.owner("traces", { path: SEARCH_ROUTE, params: () => (DETAIL_PAGE ? null : currentParams()) });' in js
    assert "traceSearch.applyLocation({ initial: true });" in traces
    assert "traceSearch.contextQuery()" in traces  # trace URLs keep the search context
    # The sidebar is the facets panel shared with the Logs Fields panel.
    panel = read("src/static/app_facet_panel.js")
    assert 'const VALUE_LIMITS = [10, 50, 200, 500];' in panel
    assert "facetPanel.create({" in js and 'ids: { panel: "traceFacets",' in js
    assert "app_facet_panel.js" in boot and "facetPanel" in read("src/static/app_page_traces.js")
    assert 'id="traceFacets"' in html and 'id="tracesFilterChips"' in html and 'id="tracesTagOp"' in html
    assert "chdash-trace-facets-collapsed" in html
    for action in ("Filter for this value", "Exclude this value", "Search only this", "Copy"):
        assert action in js


def test_logs_fields_panel_reuses_the_facets_panel_and_the_trace_caps():
    """Logs Fields: /api/logs/facets and facet_values on the facet caps, the
    allowlist and the logs guards; the panel is the Traces Attributes one."""
    service = read_logs_unit("logs_service.cpp")
    sql = read_logs_unit("logs_sql.cpp")
    request = read_logs_unit("logs_request.cpp")
    server = read("src/server.cpp")
    assert '"/api/logs/facets"' in server and '"/api/logs/facet_values"' in server
    assert '#include "facet_limits.hpp"' in sql
    facets = service[service.index("LogsService::facets"):]
    # Filters (allowlist included) and range limits come from build_filters, after the schema of the table is known.
    assert facets.count("build_filters(host.otel, o.schema, request.filter,") == 2
    assert "otel::service_allowlist_predicate(otel.traces)" in read_logs_unit("logs_filters.cpp")
    assert sql.count("std::to_string(kFacetSampleRows)") == 2
    assert "facet_settings_sql(kFacetReadRowsCap, false)" in sql and "facet_settings_sql(kFacetReadRowsCap, true)" in sql
    assert "caches_.facet_keys.get(" in facets and "caches_.facet_values.get(" in facets
    # The values of the filters are query parameters: they are part of the key of the cache with the text of the filters.
    assert "sha256_hex(q.where + '\\0' + q.params.key())" in facets
    assert "sha256_hex(key + '\\0' + q.where + '\\0' + q.params.key())" in facets
    assert "if (value.keys.size() > kFacetMaxKeys + 1) value.keys.resize(kFacetMaxKeys + 1);" in facets
    assert "drop_own_filters(&request.filter, request.scope, request.key)" in request  # a field's values ignore its own filters
    assert "facet_column_known(key)" not in facets and 'request.key != "ServiceName"' in request  # a column facet names a known column only
    assert "statement.params.text(key)" in sql and "quote_ident(key)" in sql
    js = read("src/static/app_logs.js")
    html = read("src/static/logs.html")
    assert "fields = facetPanel.create({" in js and 'api.getLogs("facets"' in js and 'api.getLogs("facet_values"' in js
    assert 'id="logsFacets" class="uiSide traceFacets logsFacets"' in html
    assert "chdash-logs-facets-collapsed" in html


def test_trace_views_are_tabs_with_a_dropdown_on_narrow_windows():
    html = read("src/static/trace.html")
    views = read("src/static/app_trace_views.js")
    tabs = read("src/static/app_ui_tabs.js")
    css = css_sources.text()
    assert 'id="traceViewTabs" class="contentTabs traceViewTabs" role="tablist"' in html
    row = html[html.index('id="traceViewTabs"'):html.index('id="traceViewSelect"')]
    for name in ("timeline", "graph", "statistics", "spans", "flamegraph"):
        assert 'data-tab="' + name + '"' in row
    assert 'id="traceViewSelect"' in html  # the dropdown below 820 px
    assert 'viewTabs = tabs?.bind(byId("traceViewTabs")' in views
    for key in ('"ArrowRight"', '"ArrowLeft"', '"Home"', '"End"'):
        assert key in tabs
    narrow = css[css.index("/* Trace detail views: the tab row"):]
    assert "@media (max-width: 820px)" in narrow[:600]
