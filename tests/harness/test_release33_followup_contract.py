from pathlib import Path
import css_sources
import modules

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_trace_initial_fit_is_bounded_by_visible_span_budget() -> None:
    viewer = read("src/static/app_trace_viewer.js")
    assert "const INITIAL_VISIBLE_SPAN_LIMIT = 50;" in viewer
    assert "function initialCollapsedForSpanLimit" in viewer
    assert "if (visibleRows(model, collapsed).length <= maxVisible) continue;" in viewer
    assert "ResizeObserver" not in viewer


def test_ddl_preview_does_not_inherit_query_editor_height() -> None:
    css = css_sources.text()
    # The DDL is a read-only SQL block, not an .editorWrap: the editor's
    # initial height cannot reach it.
    ui = modules.read_explorer_detail()
    ddl = ui[ui.index("function renderDdl"):ui.index("function renderTabContent")]
    assert "editorWrap" not in ddl and "sqlBlock(" in ddl
    assert '.sqlBlock' in css


def test_data_settings_cog_has_no_select_caret() -> None:
    css = css_sources.text()
    assert '.explorerDataSettings__button::after' in css
    assert css_sources.declared("content: none")


def test_collapsing_selected_database_switches_to_database_view_without_reopening() -> None:
    ui = (modules.read_explorer() + modules.read_explorer_detail())
    assert 'function selectDatabase(database, { history = "push", expand = true } = {})' in ui
    assert 'selectDatabase(database, { expand: false });' in ui
    assert 'model.expandedDatabases.delete(name);' in ui


def test_storage_vertical_stacks_use_equal_width_and_straight_overlap_route() -> None:
    graph = modules.read_explorer_graph()
    assert 'const logicalStackWidth = Math.max' in graph
    assert 'item.width = logicalStackWidth;' in graph
    assert 'const maxTierWidth = Math.max' in graph
    assert 'item.width = maxTierWidth;' in graph
    route = modules.function_text(graph, "storageRouteGeometry")
    assert 'const overlapLeft = Math.max(from.x, to.x);' in route
    assert 'const x = (overlapLeft + overlapRight) / 2;' in route
    assert '{ x, y: from.y + from.height }' in route
    assert '{ x, y: to.y }' in route


def test_footprint_scope_is_one_readable_share_tile() -> None:
    ui = modules.read_explorer_detail()
    css = css_sources.text()
    about = ui[ui.index("function aboutTiles"):ui.index("function renderAbout")]
    assert 'aboutTile("Share", `${percentText(dbShare)} of ${database}`' in about
    assert '`${percentText(allShare)} of all databases`' in about
    assert "explorerScopeMeter" not in ui
    assert ".explorerAboutTile__context" in css
