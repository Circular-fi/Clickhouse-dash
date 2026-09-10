from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_theme_change_repaints_graph_in_same_ui_transaction() -> None:
    ui = read("src/static/app_ui.js")
    graph = read("src/static/app_explorer_graph.js")
    assert "ns.explorerGraph?.redrawThemeNow?.();" in ui
    assert "function redrawThemeNow()" in graph
    assert "cancelAnimationFrame(model.animationFrame)" in graph
    assert "draw(performance.now());" in graph
    assert "redrawThemeNow," in graph


def test_aggregate_function_preview_is_explicitly_marked_as_finalized() -> None:
    header = read("src/explorer_catalog.hpp")
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    explorer = read("src/static/app_explorer.js")
    assert "bool finalized_for_preview = false;" in header
    assert 'out.columns[i].finalized_for_preview = declared_type.rfind("AggregateFunction(", 0) == 0;' in catalog
    assert 'w.Key("finalized_for_preview")' in api
    assert "Finalized for preview" not in explorer
    assert "ClickHouse stores AggregateFunction state" not in explorer
    assert 'finalizeAggregation(${quoted}) AS ${quoted}' in explorer
    assert 'finalizeAggregation() used so Explorer can display the value of a single row' in explorer
    assert 'explorerFinalizeInfo__tooltip' in explorer


def test_storage_graph_has_no_depth_controls_and_switch_preserves_focused_screen_position() -> None:
    html = read("src/static/explorer.html")
    graph = read("src/static/app_explorer_graph.js")
    dom = read("src/static/app_dom.js")
    assert 'id="explorerGraphDepthControls"' in html
    assert 'explorerGraphDepthControls: byId("explorerGraphDepthControls")' in dom
    assert 'dom.explorerGraphDepthControls.hidden = model.detailMode !== "logical";' in graph
    assert 'if (model.focusedId) recomputePreservingFocus();' in graph
    assert "stabilizeLayoutPositions" in graph
    assert "model.offsetX" not in graph[graph.index("function recomputePreservingFocus()"):graph.index("function setFocus(")]


def test_graph_click_then_browse_sync_preserves_canvas_camera_but_offscreen_sidebar_focus_can_fit() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert 'function setFocus(id, center = false, { preserveDepth = true } = {})' in graph
    assert 'const needsFit = shouldEnsure && !nodeIsOnScreen(id);' in graph
    assert 'setFocus(id, needsFit, { preserveDepth: true });' in graph
    pointer = graph[graph.index('const endDrag = (event) =>'):graph.index('canvas.addEventListener("pointerup"', graph.index('const endDrag = (event) =>'))]
    assert 'setFocus(node.id, true' not in pointer


def test_zero_row_table_has_no_data_or_storage_tab() -> None:
    explorer = read("src/static/app_explorer.js")
    block = explorer[explorer.index("function isEmptyRowSummary"):explorer.index("function visibleFunctions()")]
    assert 'return optionalNumber(summary?.rows) === 0;' in block
    assert 'if (isEmptyRowSummary(summary)) return ["Overview"];' in block


def test_run_settings_cog_is_after_queries_and_reuses_editor_gear() -> None:
    html = read("src/static/index.html")
    css = read("src/static/style.css")
    assert html.index('id="queryLibrary"') < html.index('id="runSettings"')
    run_block = html[html.index('id="runSettings"'):html.index('</div>\n        </div>\n      </div>', html.index('id="runSettings"'))]
    assert 'class="runSettings__button"' in run_block
    assert 'editorAutocompleteControl__gear' in run_block
    assert '.runSettings .runSettings__button {' in css
    assert 'border: 0;' in css[css.rindex('.runSettings .runSettings__button {'):]


def test_trace_is_real_otel_wall_clock_timeline() -> None:
    analysis = read("src/static/app_analysis.js")
    viewer = read("src/static/app_trace_viewer.js")
    css = read("src/static/style.css")
    collector = read("src/query_analysis.cpp")
    assert "traceViewer__row" in viewer
    assert "start_time_us" in viewer and "finish_time_us" in viewer
    assert "system.opentelemetry_span_log" in collector
    assert ".traceViewer__bar" in css
    assert "ns.traceViewer.render(root" in analysis

