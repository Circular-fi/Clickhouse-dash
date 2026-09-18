from pathlib import Path

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
    css = read("src/static/style.css")
    assert 'html.chdash-has-initial-editor-height .editorWrap.explorerDdlWrap' in css
    assert 'height: auto !important;' in css
    assert 'max-height: none !important;' in css


def test_data_settings_cog_has_no_select_caret() -> None:
    css = read("src/static/style.css")
    assert '.explorerDataSettings__button::after' in css
    assert 'content: none !important;' in css


def test_collapsing_selected_database_switches_to_database_view_without_reopening() -> None:
    ui = read("src/static/app_explorer.js")
    assert 'function selectDatabase(database, { historyMode = "push", expand = true } = {})' in ui
    assert 'selectDatabase(database, { expand: false });' in ui
    assert 'model.expandedDatabases.delete(name);' in ui


def test_storage_vertical_stacks_use_equal_width_and_straight_overlap_route() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert 'const logicalStackWidth = Math.max' in graph
    assert 'item.width = logicalStackWidth;' in graph
    assert 'const maxTierWidth = Math.max' in graph
    assert 'item.width = maxTierWidth;' in graph
    route = graph[graph.index('function storageRouteGeometry'):graph.index('function storagePolylineMetric')]
    assert 'const overlapLeft = Math.max(from.x, to.x);' in route
    assert 'const x = (overlapLeft + overlapRight) / 2;' in route
    assert '{ x, y: from.y + from.height }' in route
    assert '{ x, y: to.y }' in route


def test_footprint_scope_uses_two_readable_share_meters() -> None:
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    footprint = ui[ui.index("function renderTableFootprint"):ui.index("function structureCompressedBytes")]
    assert 'explorerScopeMeter__track' in footprint
    assert 'Table / Database' in footprint
    assert 'Table / ClickHouse' in footprint
    assert 'explorerScopeMeter--${variant}' in footprint
    assert '.explorerScopeMeter__track' in css
