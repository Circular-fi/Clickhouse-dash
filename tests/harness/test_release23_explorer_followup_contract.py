from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_buffer_lineage_is_reversed_for_destination_details() -> None:
    catalog = read("src/explorer_catalog.cpp")
    # Buffer routing, reverse dependencies_* and view as_select share one
    # server-wide system.tables scan.
    assert "if(engine = 'Buffer', toString(engine_full), '')" in catalog
    # Engine-filtered scan (lets system.tables skip DDL formatting for other
    # objects) plus a separate dependencies_* lookup.
    assert "AND engine IN ('Buffer', 'View', 'MaterializedView', 'LiveView', 'WindowView')" in catalog
    assert "OR notEmpty(as_select)" not in catalog
    assert '"AND has(dependencies_table, " + tbl + ") "' in catalog
    assert 'args.size() >= 2 && args[0] == database && args[1] == table' in catalog
    assert 'append_dependency(buffer_db, buffer_table, "upstream", "buffer")' in catalog
    assert '"Buffer reverse-lineage query failed: "' in catalog


def test_zero_row_tables_keep_columns_lineage_and_ddl_only() -> None:
    ui = read("src/static/app_explorer_detail.js")
    assert 'return optionalNumber(summary?.rows) === 0;' in ui
    tabs = ui[ui.index("function availableTabs"):ui.index("function openTab")]
    assert 'const tabs = ["Columns"];' in tabs
    assert 'if (!viewLike && !empty) tabs.push("Preview");' in tabs
    assert 'if (loading || detail?.ddl) tabs.push("DDL");' in tabs
    # An empty table shows no size chip / tile ("0 B" is meaningless).
    assert 'if (!viewLike && footprint != null && footprint > 0) {' in ui


def test_supplied_network_icon_is_used_and_primary_selector_expands() -> None:
    css = read("src/static/style.css")
    icon = ROOT / "src/static/images/network-wired-svgrepo-com.svg"
    assert icon.is_file()
    assert 'mask-image: url("images/network-wired-svgrepo-com.svg")' in css
    # The primary selector is the #explorerTopBar view tab list now: the old
    # rail dropdown and its fixed widths are gone.
    assert ".explorerNavSelect" not in css
    shell = css[css.index("/* ==== Page shell"):css.index("/* ==== /Page shell")]
    assert ".obsNav,\n.explorerTopBar,\n.explorerModeBar {" in shell


def test_profiling_has_one_vertical_scroll_owner() -> None:
    css = read("src/static/style.css")
    marker = css[css.rindex("/* Profiling has exactly one vertical scroll owner."):css.index("/* Aggregate-state preview annotation", css.rindex("/* Profiling has exactly one vertical scroll owner."))]
    assert '.analysisModal__content {' in marker
    assert 'overflow: hidden;' in marker
    assert '.traceViewer__table {' in marker
    assert 'max-height: none;' in marker
    assert '.traceViewer__scroll {' in marker
    assert 'overflow-y: auto;' in marker
