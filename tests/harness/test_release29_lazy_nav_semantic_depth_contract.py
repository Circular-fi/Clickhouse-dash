from pathlib import Path
import css_sources
import modules
from explorer_sources import read_api, read_catalog

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_run_menu_font_size_is_class_scoped() -> None:
    css = css_sources.text()
    block = css[css.index(".runMenu__opt {"):css.index(".runMenu__opt:hover")]
    assert "font-size: var(--fs-md);" in block
    assert "#runOptAutoFormat" not in css
    assert "#runOptMultiQuery" not in css
    assert "#runOptExecutionStats" not in css


def test_virtual_results_are_jump_safe_and_ingest_cooperatively() -> None:
    results = modules.read_family("app_results")
    assert "createCooperativeRowQueue" in results
    assert "scheduler.postTask" in results
    assert "navigator?.scheduling?.isInputPending?.()" in results
    assert "function handleVirtualScroll()" in results
    assert "target.start >= virtualLastEnd || target.end <= virtualLastStart" in results
    assert 'document.addEventListener("scroll", handleVirtualScroll, { passive: true, capture: true });' in results
    # One implementation of the table: the statements of a batch have the same virtual scroll as the main result.
    assert "handleLocalVirtualScroll" not in results and "function createLiveTable(" in results


def test_explorer_data_static_numeric_columns_get_gauges() -> None:
    results = modules.read_family("app_results")
    explorer = (modules.read_explorer() + modules.read_explorer_detail())
    assert "const staticNumericCols = typeAsts.map(isScalarNumericType);" in results
    assert "setGaugeCell(td, entry.row[index], index, text, staticMax, staticMin, safeColumns[index]);" in results
    assert "createStaticResultTable" in explorer
    assert "explorerResultTable--preview" in explorer


def test_hidden_non_storing_nodes_cost_zero_semantic_depth() -> None:
    cpp = read_api()
    api = read("src/static/app_api.js")
    graph = modules.read_explorer_graph()
    assert 'scope.include_non_storing = !req.has_param("include_non_storing")' in cpp
    assert "is_non_storing_graph_node" in cpp
    assert "? 0 : 1" in cpp
    assert "const int next_depth = current_depth + cost;" in cpp
    assert 'query.set("include_non_storing", options.includeNonStoring === false ? "0" : "1")' in api
    assert "function logicalProjection()" in graph
    assert "walkProjectedPath" in graph


def test_sidebar_loads_database_names_then_only_expanded_database_tables_with_stats() -> None:
    api_cpp = read_api()
    catalog_cpp = read_catalog()
    ui = (modules.read_explorer() + modules.read_explorer_detail())
    assert "acl_.databases(access)" in api_cpp
    assert "acl_.objects(access, database_filter)" in api_cpp
    assert 'w.Key("rows")' in api_cpp
    assert 'w.Key("bytes")' in api_cpp
    assert "FROM system.parts WHERE active AND database = " in catalog_cpp
    assert "async function loadDatabaseTables(database, force = false)" in ui
    assert "if (!loaded) void loadDatabaseTables(database);" in ui
    # The tree's figure column is bytes only (audit 2 T-E5): rows are in the title.
    assert "`${format.compact(rows)} rows`" not in ui
    assert "`${format.bytes(footprint)} RAM`" in ui
    assert "summaryRowsLabel(table)" in ui
    assert "summaryFootprintBytes(table)" in ui


def test_query_row_totals_use_compact_two_decimal_counts_without_repeating_rows_unit() -> None:
    run = read("src/static/app_run.js")
    # Totals are grouped counts ("120,064"), rates compact ("1.2K/s"): ns.format.
    assert "function formatRows(value)" not in run
    assert "util.setMetricText(dom.readRowsTotalText, format.count(readRowsTotal));" in run
    assert "util.setMetricText(dom.writtenRowsTotalText, format.count(writtenRowsTotal));" in run
    assert 'const rowsRate = (value) => `${format.compact(value)}/s`;' in run


def test_graph_live_activity_is_removed_entirely() -> None:
    for path in [
        "src/server.cpp",
        "src/server.hpp",
        "src/api_explorer.cpp",
        "src/explorer_service.cpp",
        "src/explorer_json.cpp",
        "src/explorer_graph_scope.cpp",
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
