from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text()


def test_explorer_and_results_modules_import_every_namespace_they_use() -> None:
    explorer = read('src/static/app_explorer.js')
    results = read('src/static/app_results.js')
    assert 'const { dom, state, api, util, ui } = ns;' in explorer
    assert 'const { dom, util, state } = ns;' in results
    assert 'ui?.setPageSelectorValue?.' in explorer
    assert 'state.suppressResultsVisibility' in results


def test_page_selector_navigation_pushes_real_query_and_explorer_routes() -> None:
    explorer = read('src/static/app_explorer.js')
    block = explorer[explorer.index('function setWorkspace('):explorer.index('function visibleTables()', explorer.index('function setWorkspace('))]
    assert 'appRoute("/explorer")' in block
    assert 'appRoute("/query")' in block
    assert 'window.history.pushState' in block
    assert 'historyMode !== "none"' in block


def test_materialized_view_target_is_added_as_downstream_and_select_sources_remain_upstream() -> None:
    catalog = read('src/explorer_catalog.cpp')
    assert 'parse_materialized_view_target' in catalog
    assert 'append_dependency(target->database, target->table, "downstream")' in catalog
    assert 'append_dependency(source.database, source.table, "upstream")' in catalog
    assert 'append_dependency(view_db, view_table, "downstream")' in catalog


def test_create_statement_uses_editor_copy_icon_gutter_and_highlighting() -> None:
    ui = read('src/static/app_explorer.js')
    css = read('src/static/style.css')
    render = ui[ui.index('function renderDdl('):ui.index('function renderTabContent', ui.index('function renderDdl('))]
    assert 'explorerDdlGutter' in render
    assert 'editorCopyButton explorerDdlCopy' in render
    assert 'editorCopyButton__icon' in render
    assert 'renderHighlightedCode(pre, ddl)' in render
    assert 'Copy DDL' not in render
    assert '.explorerDdlGutter' in css


def test_engine_specific_explorer_surfaces_do_not_assume_mergetree() -> None:
    ui = read('src/static/app_explorer.js')
    catalog = read('src/explorer_catalog.cpp')
    assert 'isDictionarySummary' in ui
    assert 'isMemorySummary' in ui
    assert 'isBufferSummary' in ui
    assert 'isLogFamilySummary' in ui
    assert 'const hasStorage = isMergeTreeSummary(summary) || isDistributedSummary(summary) || isLogFamilySummary(summary);' in ui
    assert 'if (hasStorage) tabs.push("Storage")' in ui
    assert 'else if (!isDictionarySummary(summary)) tabs.push("Operations")' in ui
    assert 'bufferTarget' not in ui
    assert '["Target", buffer ? bufferTarget(s) || null : null]' not in ui
    assert "normalize_buffer_runtime_rows" in read("src/explorer_catalog.cpp")
    assert 'toString(total_rows), toString(total_bytes), toString(total_bytes_uncompressed)' in catalog


def test_ttl_uses_version_stable_describe_metadata_and_table_ddl() -> None:
    catalog = read('src/explorer_catalog.cpp')
    api = read('src/api_explorer.cpp')
    ui = read('src/static/app_explorer.js')
    assert 'toString(ttl_expression)' not in catalog
    assert 'DESCRIBE TABLE ' in catalog
    assert 'describe_include_subcolumns = 0' in catalog
    assert 'column.ttl_expression = described_ttl' in catalog
    assert 'w.Key("ttl_expression")' in api
    assert '["TTL", tableTtl || null]' not in ui
    assert 'container.appendChild(sectionTitle("CREATE statement"));' not in ui
    assert 'function extractTableTtl' in ui
    assert '["TTL", tableTtl || null]' not in ui
    assert 'container.appendChild(sectionTitle("CREATE statement"));' not in ui


def test_graph_click_updates_browser_selection_and_reset_focus_is_gone() -> None:
    html = read('src/static/index.html')
    graph = read('src/static/app_explorer_graph.js')
    explorer = read('src/static/app_explorer.js')
    assert 'explorerGraphClearFocusButton' not in html
    assert 'function resetFocus()' not in graph
    assert 'model.openTable(node.database, node.name);' in graph
    assert 'function openTableFromGraph(database, table)' in explorer
    open_from_graph = explorer[explorer.index('function openTableFromGraph'):explorer.index('function init()', explorer.index('function openTableFromGraph'))]
    assert 'selectTable(database, table, false, { graphOrigin: true });' in open_from_graph
    assert 'button.classList.toggle("is-selected", key === model.selectedKey);' in explorer


def test_function_navigation_is_grouped_by_category_without_counts_and_meta_is_origin_first() -> None:
    ui = read('src/static/app_explorer.js')
    render = ui[ui.index('function renderFunctionList()'):ui.index('async function refreshFunctions', ui.index('function renderFunctionList()'))]
    detail = ui[ui.index('function renderFunctionDetail()'):ui.index('function renderFunctionList()', ui.index('function renderFunctionDetail()'))]
    assert 'const groups = new Map()' in render
    assert 'functionCategory(item)' in render
    assert 'explorerTreeDatabase__count' not in render
    assert 'uniqueMetaBits([functionOrigin(item), functionCategory(item), item.kind || "Function"])' in detail


def test_overview_and_column_storage_are_compact_one_line_lists() -> None:
    ui = read('src/static/app_explorer.js')
    overview = ui[ui.index('function renderOverview('):ui.index('function renderColumns(', ui.index('function renderOverview('))]
    columns = ui[ui.index('function renderColumns('):ui.index('function renderStorage', ui.index('function renderColumns('))]
    assert 'sectionTitle("Storage breakdown")' not in overview
    assert 'sectionTitle("CREATE statement")' not in overview
    assert 'explorerSchemaColumn' not in columns
    assert 'ns.results?.createStaticResultTable?.({' in ui
    assert 'columns: [firstLabel, group === "columns" ? "Codec" : "Type", "Compressed", "Uncompressed", "% table"]' in ui
    assert 'explorerStoragePercentCell' in ui
    assert 'percentValue(compressed, tableFootprint)' in columns
    assert 'relative_weight' not in columns


def test_fixture_stack_covers_ttl_memory_buffer_tinylog_dictionary_and_materialized_view() -> None:
    sql = read('tests/clickhouse-init/02-frontend-fixtures.sql')
    assert "observed_at + INTERVAL 30 DAY RECOMPRESS CODEC(ZSTD(3))" in sql
    assert "observed_at + INTERVAL 60 DAY TO VOLUME 'warm'" in sql
    assert "observed_at + INTERVAL 365 DAY DELETE" in sql
    assert 'ENGINE = Memory' in sql
    assert 'ENGINE = Buffer(chdash_ui, weather_observations' in sql
    assert 'ENGINE = Buffer(chdash_ui, weather_alert_target' in sql
    assert 'ENGINE = TinyLog' in sql
    assert 'CREATE DICTIONARY chdash_ui.station_dictionary' in sql
    assert 'CREATE MATERIALIZED VIEW chdash_ui.weather_daily_summary_mv' in sql
    assert 'CREATE MATERIALIZED VIEW chdash_ui.weather_buffer_city_mv' in sql
    assert 'CREATE MATERIALIZED VIEW chdash_ui.weather_buffer_alert_mv' in sql
