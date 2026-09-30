from pathlib import Path

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
    server = read("src/server.cpp")
    assert '"/api/traces/facets"' in server and '"/api/traces/facet_values"' in server
    facets = cpp[cpp.index("void Server::handle_traces_facets"):cpp.index("void Server::handle_traces_search")]
    assert facets.count("service_allowlist_predicate(cfg_.traces)") == 2
    assert facets.count("std::to_string(kFacetSampleRows)") == 2
    assert "SpanAttributes.keys AS sk" in facets and "ResourceAttributes.keys AS rk" in facets
    assert "facet_settings_sql(kFacetReadRowsCap, false)" in facets
    assert "facet_settings_sql(kFacetReadRowsCap, true)" in facets
    assert "&key_scope, &key" in facets  # a facet's values ignore its own filters
    settings = cpp[cpp.index("std::string facet_settings_sql"):cpp.index("bool timed_out")]
    for fragment in ("timeout_overflow_mode = 'break'", "max_rows_to_read = ", "read_overflow_mode = 'break'",
                     "max_rows_to_group_by = ", "group_by_overflow_mode = 'any'", "max_execution_time = "):
        assert fragment in settings
    assert "constexpr uint64_t kFacetTtlMs = 60 * 1000;" in cpp
    assert "g_trace_facet_keys_cache.get_or_refresh" in facets and "g_trace_facet_values_cache.get_or_refresh" in facets
    # Estimates come from the progress packets, never from a guess.
    assert "bool partial() const { return read_rows < total_rows; }" in cpp
    assert 'w.Key("estimated")' in cpp


def test_search_state_lives_in_the_url_and_the_facets_sidebar_is_bounded():
    js = read("src/static/app_trace_search.js")
    traces = read("src/static/app_traces.js")
    html = read("src/static/traces.html")
    boot = read("src/static/app_traces_bootstrap.js")
    assert '"app_trace_views.js", "app_trace_search.js"' in boot
    for name in ('"from"', '"to"', '"status"', '"service"', '"operation"', '"limit"', '"sort"', '"results"',
                 '"tag"', '"tag_not"', '"tag_exists"', '"tag_missing"', '"service_not"', '"operation_not"', '"status_not"'):
        assert name in js[js.index("const SEARCH_PARAMS"):js.index("const PIN_STORE_KEY")]
    assert "window.history.pushState({ workspace: \"traces\" }, \"\", next)" in js
    assert "ns.traceSearch?.applyLocation?.({ initial: true });" in traces
    assert "ns.traceSearch?.contextQuery?.()" in traces  # trace URLs keep the search context
    assert 'const VALUE_LIMITS = [10, 50, 200, 500];' in js
    assert 'id="traceFacets"' in html and 'id="tracesFilterChips"' in html and 'id="tracesTagOp"' in html
    assert "chdash-trace-facets-collapsed" in html
    for action in ("Filter for this value", "Exclude this value", "Search only this", "Copy"):
        assert action in js
