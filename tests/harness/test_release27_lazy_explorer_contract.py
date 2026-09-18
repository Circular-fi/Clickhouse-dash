from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_catalog_endpoint_loads_databases_first_then_one_database_with_sidebar_stats() -> None:
    api = read("src/api_explorer.cpp")
    server = read("src/server.hpp")
    catalog = read("src/explorer_catalog.cpp")
    handler = api[api.index("void Server::handle_explorer_catalog"):api.index("void Server::handle_explorer_table")]

    assert "explorer_catalog_list_cache_" in server
    assert "explorer_catalog_list_cache_.get_or_refresh" in handler
    assert "discover_visible_databases(*runner)" in handler
    assert "discover_visible_objects(*runner, database_filter)" in handler
    assert "if (database_filter.empty())" in handler
    assert "load_explorer_catalog_index" in handler
    assert 'w.Key("database")' in handler
    assert 'w.Key("name")' in handler
    assert 'w.Key("engine")' in handler
    assert 'w.Key("rows")' in handler
    assert 'w.Key("bytes")' in handler
    assert 'w.Key("database_summaries")' in handler
    for forbidden in ["engine_full", "client_ingress", "replication"]:
        assert f'w.Key("{forbidden}")' not in handler

    index = catalog[catalog.index("bool load_explorer_catalog_index"):catalog.index("bool load_explorer_table_summary")]
    assert "toString(total_rows), toString(total_bytes)" in index
    assert "FROM system.parts WHERE active AND database = " in index
    assert "load_query_ingress" not in index
    assert "load_part_ingress" not in index
    assert "load_replication" not in index


def test_table_detail_cache_is_30_seconds_and_refreshes_only_on_request() -> None:
    api = read("src/api_explorer.cpp")
    server = read("src/server.hpp")
    app_api = read("src/static/app_api.js")
    handler = api[api.index("void Server::handle_explorer_table"):api.index("void Server::handle_explorer_functions")]

    assert "constexpr uint64_t kExplorerTableDetailCacheTtlMs = 30 * 1000;" in api
    assert "StaleCache<std::string, ExplorerTableDetail> explorer_table_detail_cache_;" in server
    assert "explorer_table_detail_cache_.get_or_refresh" in handler
    assert "detail_key" in handler and "database" in handler and "table" in handler
    assert 'req.has_param("refresh")' in handler
    assert "explorer_table_detail_cache_.erase(detail_key);" in handler
    assert "load_explorer_table_summary" in handler
    assert "load_explorer_catalog(" not in handler
    assert 'if (refresh) query.set("refresh", "1");' in app_api


def test_table_summary_queries_are_scoped_to_requested_object() -> None:
    catalog = read("src/explorer_catalog.cpp")
    summary = catalog[catalog.index("bool load_explorer_table_summary"):catalog.index("bool load_explorer_catalog(")]

    assert '"FROM system.tables WHERE database = " + db + " AND name = " + tbl + " LIMIT 1"' in summary
    assert '"FROM system.parts WHERE active AND database = " + db + " AND `table` = " + tbl' in summary
    assert '"AND database = " + db + " AND `table` = " + tbl' in summary
    assert '"WHERE database = " + db + " AND `table` = " + tbl + " LIMIT 1"' in summary
    assert '"AND has(tables, " + object + ")"' in summary


def test_graph_focus_does_not_fetch_browse_detail_until_browse_is_visible() -> None:
    ui = read("src/static/app_explorer.js")
    select = ui[ui.index("async function selectTable"):ui.index("async function applyRouteFromLocation")]
    set_mode = ui[ui.index("function setMode(mode)"):ui.index("function setWorkspace")]

    graph_return = select.index('if (model.mode === "graph") {')
    detail_fetch = select.index("api.getExplorerTable")
    assert graph_return < detail_fetch
    assert "return;" in select[graph_return:detail_fetch]
    assert "if (table && !model.detailLoading && !model.detail)" in set_mode
    assert "void selectTable(table.database, table.name" in set_mode


def test_table_list_renders_stats_only_for_lazily_loaded_database_branch() -> None:
    ui = read("src/static/app_explorer.js")
    tree = ui[ui.index("function renderTableList"):ui.index("function catalogContainsTable")]
    assert 'model.databaseTablesLoaded.has(database)' in tree
    assert 'loadDatabaseTables(database)' in tree
    assert 'summaryRowsLabel(table' in tree
    assert 'summaryFootprintBytes(table)' in tree
    assert "explorerTreeHealthDot" not in tree


def test_selected_table_keeps_lazy_scope_totals_for_percentages() -> None:
    header = read("src/explorer_catalog.hpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")
    assert "database_footprint_bytes" in header
    assert "clickhouse_footprint_bytes" in header
    assert 'w.Key("footprint_scope")' in api
    assert "detail?.footprint_scope?.database_bytes" in ui
    assert "detail?.footprint_scope?.clickhouse_bytes" in ui
