from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_run_menu_font_size_is_class_scoped() -> None:
    css = read("src/static/style.css")
    block = css[css.index(".runMenu__opt {"):css.index(".runMenu__opt:hover")]
    assert "font-size: .8rem;" in block
    assert "#runOptAutoFormat" not in css
    assert "#runOptMultiQuery" not in css
    assert "#runOptExecutionStats" not in css


def test_virtual_results_are_jump_safe_and_ingest_cooperatively() -> None:
    results = read("src/static/app_results.js")
    assert "createCooperativeRowQueue" in results
    assert "scheduler.postTask" in results
    assert "navigator?.scheduling?.isInputPending?.()" in results
    assert "function handleVirtualScroll()" in results
    assert "target.start >= virtualLastEnd || target.end <= virtualLastStart" in results
    assert 'document.addEventListener("scroll", handleVirtualScroll, { passive: true, capture: true });' in results
    assert "function handleLocalVirtualScroll()" in results


def test_explorer_data_static_numeric_columns_get_gauges() -> None:
    results = read("src/static/app_results.js")
    explorer = read("src/static/app_explorer.js")
    assert "const staticNumericCols = typeAsts.map(isScalarNumericType);" in results
    assert "setGaugeCell(td, entry.row[index], index, text, staticMaxPos, staticMaxAbs);" in results
    assert "createStaticResultTable" in explorer
    assert "explorerResultTable--preview" in explorer


def test_hidden_non_storing_nodes_cost_zero_semantic_depth() -> None:
    cpp = read("src/api_explorer.cpp")
    api = read("src/static/app_api.js")
    graph = read("src/static/app_explorer_graph.js")
    assert 'scope.include_non_storing = !req.has_param("include_non_storing")' in cpp
    assert "is_non_storing_graph_node" in cpp
    assert "? 0 : 1" in cpp
    assert "const int next_depth = current_depth + cost;" in cpp
    assert 'query.set("include_non_storing", options.includeNonStoring === false ? "0" : "1")' in api
    assert "function logicalProjection()" in graph
    assert "walkProjectedPath" in graph


def test_sidebar_loads_database_names_then_only_expanded_database_tables_with_stats() -> None:
    api_cpp = read("src/api_explorer.cpp")
    catalog_cpp = read("src/explorer_catalog.cpp")
    ui = read("src/static/app_explorer.js")
    assert "discover_visible_databases(*runner)" in api_cpp
    assert "discover_visible_objects(*runner, database_filter)" in api_cpp
    assert 'w.Key("rows")' in api_cpp
    assert 'w.Key("bytes")' in api_cpp
    assert "FROM system.parts WHERE active AND database = " in catalog_cpp
    assert "async function loadDatabaseTables(database, force = false)" in ui
    assert "if (!loaded) void loadDatabaseTables(database);" in ui
    assert "summaryRowsLabel(table, { compact: true })" in ui
    assert "summaryFootprintBytes(table)" in ui


def test_query_row_totals_use_compact_two_decimal_counts_without_repeating_rows_unit() -> None:
    run = read("src/static/app_run.js")
    assert "function formatRows(value)" in run
    assert 'return formatShort(value, 1000, ["K", "M", "B", "T"], 2, "");' in run
    assert "formatRows(readRowsTotal)" in run
    assert "formatRows(writtenRowsTotal)" in run
    assert '`${formatRows(rowsPerSec)}/s`' in run


def test_graph_live_activity_is_removed_entirely() -> None:
    for path in [
        "src/server.cpp",
        "src/server.hpp",
        "src/api_explorer.cpp",
        "src/explorer_graph.cpp",
        "src/explorer_graph.hpp",
        "src/static/app_api.js",
        "src/static/app_explorer_graph.js",
    ]:
        text = read(path)
        assert "/api/explorer/activity" not in text
        assert "handle_explorer_activity" not in text
        assert "load_explorer_graph_activity" not in text
        assert "ExplorerGraphActivity" not in text
