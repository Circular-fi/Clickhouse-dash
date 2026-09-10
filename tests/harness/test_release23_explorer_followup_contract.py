from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_buffer_lineage_is_reversed_for_destination_details() -> None:
    catalog = read("src/explorer_catalog.cpp")
    assert 'FROM system.tables WHERE engine = \'Buffer\'' in catalog
    assert 'if (args[0] == database && args[1] == table)' in catalog
    assert 'append_dependency(buffer_db, buffer_table, "upstream")' in catalog
    assert '"Buffer reverse-lineage query failed: "' in catalog


def test_zero_row_tables_keep_only_overview_without_footprint_columns_or_storage() -> None:
    ui = read("src/static/app_explorer.js")
    tabs = ui[ui.index("function isEmptyRowSummary"):ui.index("function visibleFunctions")]
    overview = ui[ui.index("function renderOverview"):ui.index("function isImplementationSubcolumn")]
    assert 'return optionalNumber(summary?.rows) === 0;' in tabs
    assert 'if (isEmptyRowSummary(summary)) return ["Overview"];' in tabs
    assert 'const empty = isEmptyRowSummary(s);' in overview
    assert 'if (!empty && !resident && !viewLike)' in overview
    assert 'if (viewLike || resident || empty)' in overview


def test_supplied_network_icon_is_used_and_primary_selector_expands() -> None:
    css = read("src/static/style.css")
    icon = ROOT / "src/static/images/network-wired-svgrepo-com.svg"
    assert icon.is_file()
    assert 'mask-image: url("images/network-wired-svgrepo-com.svg")' in css
    start = css.rindex(".explorerHeader--sidebar .explorerNavSelect")
    nav = css[start:css.index("#explorerTableModeTabs", start)]
    assert 'flex: 1 1 auto;' in nav
    assert 'width: auto;' in nav
    assert '143px' not in nav


def test_profiling_has_one_vertical_scroll_owner() -> None:
    css = read("src/static/style.css")
    marker = css[css.rindex("/* Profiling has exactly one vertical scroll owner."):css.index("/* Aggregate-state preview annotation", css.rindex("/* Profiling has exactly one vertical scroll owner."))]
    assert '.analysisModal__content {' in marker
    assert 'overflow: hidden;' in marker
    assert '.traceViewer__table {' in marker
    assert 'max-height: none;' in marker
    assert '.traceViewer__scroll {' in marker
    assert 'overflow-y: auto;' in marker
