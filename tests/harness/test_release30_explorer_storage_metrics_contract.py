from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_finalize_hint_uses_svg_not_text_i() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    block = ui[ui.index("function appendFinalizePreviewInfo"):ui.index("function persistFlattenTuple")]
    assert 'createElementNS("http://www.w3.org/2000/svg", "svg")' in block
    assert 'viewBox", "0 0 416.979 416.979"' in block
    assert 'node("span", "explorerFinalizeInfo__icon", "i")' not in block


def test_non_storing_toggle_filters_sidebar_objects() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    assert "function sidebarObjectVisible(table)" in ui
    assert "!model.includeNonStoring && nonStoringSummary(table)" in ui
    # Tables are grouped per database once per catalog payload; the visibility
    # filter still applies to every rendered database group.
    assert "grouped.set(table.database, [])" in ui
    assert "(groupedTables.get(database) || []).filter((table) => sidebarObjectVisible(table))" in ui
    assert "item.database === name && sidebarObjectVisible(item)" in ui


def test_non_storing_toggle_is_locked_while_selected_object_is_non_storing() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    graph = read("src/static/app_explorer_graph.js")
    assert "includeNonStoring: !!table && nonStoringSummary(table)" in ui
    assert "const nextIncludeNonStoring = required.includeNonStoring || options.includeNonStoring !== false;" in graph
    assert "includeNonStoring: !!node && isNonStoringNode(node)" in graph


def test_storage_metric_columns_share_query_style_background_gauges() -> None:
    ui = read("src/static/app_explorer_detail.js")
    gauge = ui[ui.index("function gaugeCell"):ui.index("function numericCell")]
    assert 'td.classList.add("num");' in gauge
    assert "ns.table.cellBar(td, ns.table.barPercent(optionalNumber(value), max));" in gauge
    # Bars are normalised to the column maximum.
    assert "gaugeCell(td, item.compressed, compressedMax" in ui
    assert "gaugeCell(td, part.bytes, max" in ui
    assert "gaugeCell(td, value, 100" in ui


def test_storage_shares_of_database_and_server_are_one_about_tile() -> None:
    ui = read("src/static/app_explorer_detail.js")
    css = css_sources.text()
    about = ui[ui.index("function aboutTiles"):ui.index("function renderAbout")]
    assert 'aboutTile("Share", `${percentText(dbShare)} of ${database}`' in about
    assert '`${percentText(allShare)} of all databases`' in about
    assert "explorerScopeMeter" not in ui
    assert ".explorerAboutTile__context" in css


def test_columns_tab_comes_first_and_indexes_projections_live_in_storage() -> None:
    ui = read("src/static/app_explorer_detail.js")
    tabs = ui[ui.index("function availableTabs"):ui.index("function openTab")]
    assert 'const tabs = ["Columns"];' in tabs
    content = ui[ui.index("function renderTabContent"):]
    assert "default: renderColumnsTab(main, detail); break;" in content
    storage = ui[ui.index("function renderStorageTab"):ui.index("function ingestionState")]
    assert "renderColumnsTab" not in storage
    assert 'id: "indexes"' in storage and 'id: "projections"' in storage
    assert "Compact parts share one physical data stream" not in ui



def test_tuple_storage_accounts_for_hidden_array_offsets_and_array_tuple_roots() -> None:
    ui = read("src/static/app_explorer_detail.js")
    block = ui[ui.index("function columnRows"):ui.index("function renderColumnsTab")]
    assert '/Tuple\\s*\\(/i.test(String(column?.type || ""))' in block
    assert "const implementationByRoot = new Map();" in block
    assert 'name: `${tupleRoot}.[offsets]`' in block
    assert "Physical Array offset stream" in block
    assert "tuple_parent: tupleRoot" in block

def test_buffer_detail_subtracts_target_rows_lazily() -> None:
    catalog = read("src/explorer_catalog.cpp")
    detail = catalog[catalog.index("bool load_explorer_table_summary"):catalog.index("bool load_explorer_catalog(", catalog.index("bool load_explorer_table_summary"))]
    assert 'if (out.engine == "Buffer")' in detail
    assert "resolve_buffer_database_arg(args[0], database)" in detail
    assert 'SELECT toString(total_rows) FROM system.tables WHERE database = ' in detail
    assert "*out.rows - *target_rows" in detail


def test_query_and_explorer_keep_stable_right_scrollbar_lane() -> None:
    css = css_sources.text()
    for selector in ("#queryWorkspace", ".explorerDetailPane"):
        assert css_sources.decls(selector)["scrollbar-gutter"] == "stable", selector


def test_query_metrics_use_shared_formats_and_keep_magnitude_with_number() -> None:
    run = read("src/static/app_run.js")
    util = read("src/static/app_util.js")
    # The rail uses ns.format: "15.2 KB", "1.7 KB/s", "1.2K/s".
    assert 'KiB' not in run and 'formatShort' not in run
    assert 'util.setMetricText(dom.readBytesRateText, format.bytesRate(bytesPerSec));' in run
    assert 'util.setMetricText(dom.readRowsRateText, rowsRate(rowsPerSec));' in run
    assert "(Ki|Mi|Gi|Ti|K|M|B|T)?" in util
    assert "const magnitude = `${match[1]}${match[2] || \"\"}`;" in util
