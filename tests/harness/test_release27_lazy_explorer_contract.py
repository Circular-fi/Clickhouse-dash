from pathlib import Path
import modules
from explorer_sources import read_api, read_unit

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_catalog_endpoint_loads_databases_first_then_one_database_with_sidebar_stats() -> None:
    api = read_api()
    server = read("src/server.hpp")
    service = read_unit("explorer_service.cpp")
    handler = service[service.index("ExplorerService::catalog("):service.index("ExplorerService::storage(")]
    json = read_unit("explorer_json.cpp")
    writer = json[json.index("std::string catalog_json("):json.index("std::string storage_json(")]

    assert "explorer_catalog_list_cache_" in server
    assert "explorer_catalog_list_cache_, explorer_catalog_cache_" in server  # the sidebar cache is the `list` store of the service
    assert "stores_.list.get_revalidating" in handler
    assert "acl_.databases(access)" in handler
    assert "acl_.objects(access, database_filter)" in handler
    assert "if (database_filter.empty())" in handler
    assert "load_explorer_catalog_index" in handler
    assert 'w.Key("database")' in writer
    assert 'w.Key("name")' in writer
    assert 'w.Key("engine")' in writer
    assert 'w.Key("rows")' in writer
    assert 'w.Key("bytes")' in writer
    assert 'w.Key("database_summaries")' in writer
    for forbidden in ["engine_full", "client_ingress", "replication"]:
        assert f'w.Key("{forbidden}")' not in writer

    # The sidebar reader (explorer_index.cpp) asks for its statements in explorer_sql.cpp: identity and small statistics, one database at a time.
    index = read_unit("explorer_index.cpp")
    statements = read_unit("explorer_sql.cpp")
    sidebar = statements[statements.index("// ---- the sidebar ----"):statements.index("// ---- the storage map ----")]
    assert "index_tables_ordered_sql(out.databases)" in index
    assert "database_parts_sql(database)" in index
    assert "toString(total_rows), toString(total_bytes)" in sidebar
    assert "FROM system.parts WHERE active AND database = " in sidebar
    assert 'if (databases.size() == 1) filter += "AND database = " + out.params.text(databases.front()) + " ";' in sidebar
    for unit in (index, sidebar):
        assert "load_query_ingress" not in unit
        assert "load_part_ingress" not in unit
        assert "load_replication" not in unit
        assert "query_ingress_sql" not in unit
        assert "part_ingress_sql" not in unit


def test_table_detail_cache_is_30_seconds_and_refreshes_only_on_request() -> None:
    api = read_api()
    server = read("src/server.hpp")
    app_api = read("src/static/app_api.js")
    route = read_unit("api_explorer.cpp")
    route_handler = route[route.index("void Server::handle_explorer_table("):route.index("void Server::handle_explorer_functions")]
    service = read_unit("explorer_service.cpp")
    handler = service[service.index("ExplorerService::table("):service.index("ExplorerService::functions(")]

    assert "constexpr uint64_t kTableDetailCacheTtlMs = 30 * 1000;" in read_unit("explorer_service.hpp")
    assert "explorer::kTableDetailCacheTtlMs" in route_handler
    assert "TtlCache<std::string, ExplorerTableDetail> explorer_table_detail_cache_{cache_options<ExplorerTableDetail>(\n      std::chrono::seconds(30)," in server
    assert "stores_.table_detail.get(" in handler
    assert "detail_key" in handler and "database" in handler and "table" in handler
    assert 'req.has_param("refresh")' in read_unit("api_explorer.cpp")
    assert "explorer_service_.table(" in route_handler and "refresh_of(req)" in route_handler
    # refresh=1 reads again (the single-flight is kept), with the privileges of that database.
    assert "acl_.invalidate(access, database);" in handler and "      refresh);" in handler
    assert "load_explorer_table_summary" in handler
    assert "load_explorer_catalog(" not in handler
    assert 'if (refresh) query.set("refresh", "1");' in app_api


def test_table_summary_queries_are_scoped_to_requested_object() -> None:
    # The reader (explorer_table.cpp) calls the statements of the card of one table (explorer_sql.cpp); every one is scoped to the object, and
    # the names are bound parameters of the statement.
    reader = read_unit("explorer_table.cpp")
    statements = read_unit("explorer_sql.cpp")
    summary = statements[statements.index("// ---- the card of a table ----"):statements.index("SqlStatement table_ddl_sql")]

    for call in ["table_summary_sql(database, table)", "table_parts_sql(database, table)", "table_query_ingress_sql(database, table)",
                 "table_part_ingress_sql(database, table)", "table_replica_detail_sql(database, table)"]:
        assert call in reader
    assert '"FROM system.tables WHERE database = " + db + " AND name = " + tbl + " LIMIT 1"' in summary
    assert 'return "database = " + db + " AND `" + table_column + "` = " + tbl;' in statements
    assert '"FROM system.parts WHERE active AND " + scope' in summary
    assert '" FROM system.replicas WHERE " + scope_of(out.params, "table", database, table) + " LIMIT 1"' in summary
    assert '"AND has(tables, " + object + ")"' in summary
    assert "quote_string" not in statements

def test_graph_focus_does_not_fetch_browse_detail_until_browse_is_visible() -> None:
    ui = (modules.read_explorer() + read("src/static/app_explorer_detail.js"))
    select = read("src/static/app_explorer_table.js")
    show_mode = ui[ui.index("function showMode()"):ui.index("function openCard(")]

    # Graph and Storage keep the selection only; Browse loads the card.
    graph_return = select.index('if (model.mode !== "browse") {')
    detail_fetch = select.index("api.getExplorerTable")
    assert graph_return < detail_fetch
    assert "return;" in select[graph_return:detail_fetch]
    assert "if (!model.detailLoading && !model.detail) void selectTable(scope.database, scope.table" in show_mode


def test_table_list_renders_stats_only_for_lazily_loaded_database_branch() -> None:
    ui = (modules.read_explorer() + read("src/static/app_explorer_detail.js"))
    tree = ui[ui.index("function renderTableList"):ui.index("function catalogContainsTable")]
    assert 'model.databaseTablesLoaded.has(database)' in tree
    assert 'loadDatabaseTables(database)' in tree
    # One line per object: the size badge and the tooltip carry the stats.
    assert 'treeBadge(table)' in tree and 'treeObjectTitle(table)' in tree
    badge = ui[ui.index("function treeBadge"):][:1600]
    assert 'summaryRowsLabel(table' in badge
    assert 'summaryFootprintBytes(table)' in badge
    assert "explorerTreeHealthDot" not in tree


def test_selected_table_keeps_lazy_scope_totals_for_percentages() -> None:
    header = read("src/explorer_catalog.hpp")
    api = read_api()
    ui = read("src/static/app_explorer_detail.js")
    assert "database_footprint_bytes" in header
    assert "clickhouse_footprint_bytes" in header
    assert 'w.Key("footprint_scope")' in api
    assert "detail.footprint_scope?.database_bytes" in ui
    assert "detail.footprint_scope?.clickhouse_bytes" in ui
