from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_finalize_hint_uses_svg_not_text_i() -> None:
    ui = read("src/static/app_explorer.js")
    block = ui[ui.index("function appendFinalizePreviewInfo"):ui.index("function persistFlattenTuple")]
    assert 'createElementNS("http://www.w3.org/2000/svg", "svg")' in block
    assert 'viewBox", "0 0 416.979 416.979"' in block
    assert 'node("span", "explorerFinalizeInfo__icon", "i")' not in block


def test_non_storing_toggle_filters_sidebar_objects() -> None:
    ui = read("src/static/app_explorer.js")
    assert "function sidebarObjectVisible(table)" in ui
    assert "!model.includeNonStoring && nonStoringSummary(table)" in ui
    assert "table.database === database && sidebarObjectVisible(table)" in ui
    assert "item.database === name && sidebarObjectVisible(item)" in ui


def test_non_storing_toggle_is_locked_while_selected_object_is_non_storing() -> None:
    ui = read("src/static/app_explorer.js")
    graph = read("src/static/app_explorer_graph.js")
    assert "includeNonStoring: !!table && nonStoringSummary(table)" in ui
    assert "const nextIncludeNonStoring = required.includeNonStoring || options.includeNonStoring !== false;" in graph
    assert "includeNonStoring: !!node && isNonStoringNode(node)" in graph


def test_storage_metric_columns_share_query_style_background_gauges() -> None:
    ui = read("src/static/app_explorer.js")
    block = ui[ui.index("function renderStorageMetricTable"):ui.index("function renderColumns")]
    assert 'classList.add("resultTable__gaugeCell", "resultTable__numeric", "explorerStorageGaugeCell")' in block
    assert "applyGauge(td, ctx.value, compressedMax" in block
    assert "applyGauge(td, ctx.value, uncompressedMax" in block
    assert "applyGauge(td, ctx.value, 100" in block


def test_storage_shares_database_and_clickhouse_use_readable_scope_meters() -> None:
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    footprint = ui[ui.index("function renderTableFootprint"):ui.index("function structureCompressedBytes")]
    assert "explorerShareList--footprint" in footprint
    assert 'scopeMeter("Table / Database"' in footprint
    assert 'scopeMeter("Table / ClickHouse"' in footprint
    assert "explorerScopeMeter__track" in footprint
    assert ".explorerScopeMeter__track" in css


def test_columns_indexes_projections_live_in_storage_not_overview() -> None:
    ui = read("src/static/app_explorer.js")
    overview = ui[ui.index("function renderOverview"):ui.index("function isImplementationSubcolumn")]
    storage = ui[ui.index("function renderStorageCombined"):ui.index("function renderOperations")]
    assert "renderColumns(container, detail);" not in overview
    assert 'renderColumns(container, detail);' in storage
    assert 'sectionTitle("Columns, indexes & projections")' not in storage
    assert "renderColumns(container, detail);" in storage
    assert "Compact parts share one physical data stream" not in ui


def test_buffer_detail_subtracts_target_rows_lazily() -> None:
    catalog = read("src/explorer_catalog.cpp")
    detail = catalog[catalog.index("bool load_explorer_table_summary"):catalog.index("bool load_explorer_catalog(", catalog.index("bool load_explorer_table_summary"))]
    assert 'if (out.engine == "Buffer")' in detail
    assert "resolve_buffer_database_arg(args[0], database)" in detail
    assert 'SELECT toString(total_rows) FROM system.tables WHERE database = ' in detail
    assert "*out.rows - *target_rows" in detail


def test_query_and_explorer_keep_stable_right_scrollbar_lane() -> None:
    css = read("src/static/style.css")
    tail = css[css.index("/* Release 30: keep a permanent right-side scrollbar lane") :]
    assert "#queryWorkspace" in tail
    assert ".explorerDetailPane" in tail
    assert "scrollbar-gutter: stable !important;" in tail


def test_query_metrics_use_two_decimals_and_keep_magnitude_with_number() -> None:
    run = read("src/static/app_run.js")
    util = read("src/static/app_util.js")
    assert 'units = ["K", "M", "B", "T"]' in run
    assert "v.toFixed(fixed)" in run
    assert 'formatShort(value, 1024, ["KiB", "MiB", "GiB", "TiB"], 2, "B")' in run
    assert '`${formatRows(rowsPerSec)}/s`' in run
    assert "(Ki|Mi|Gi|Ti|K|M|B|T)?" in util
    assert "const magnitude = `${match[1]}${match[2] || \"\"}`;" in util
