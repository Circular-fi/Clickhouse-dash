from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_new_query_clears_visible_results_before_loading() -> None:
    src = read("src/static/app_run.js")
    marker = "// Starting a new run behaves exactly like Clear"
    assert marker in src
    block = src[src.index(marker) - 140: src.index(marker) + 380]
    assert "results.clearLiveResults();" in block
    assert "results.setResultsVisible(false);" in block


def test_trace_initial_expansion_uses_visible_span_budget_and_gutter_is_only_on_scroll_owner() -> None:
    js = read("src/static/app_trace_viewer.js")
    css = read("src/static/style.css")
    assert "const INITIAL_VISIBLE_SPAN_LIMIT = 50;" in js
    assert "function initialCollapsedForSpanLimit" in js
    assert ".traceViewer__scroll {\n  scrollbar-gutter: stable !important;" in css
    final_table = css[css.rindex(".traceViewer__table"):] if ".traceViewer__table" in css else ""
    assert "scrollbar-gutter: stable !important" not in final_table.split(".traceViewer__scroll", 1)[0]


def test_storage_tuple_rows_are_collapsed_locally_and_shared_tables_are_used() -> None:
    src = read("src/static/app_explorer.js")
    results = read("src/static/app_results.js")
    assert "tuple_root:" in src and "tuple_parent:" in src
    assert "explorerStorageTupleToggle" in src
    assert "tr.hidden = !(tupleExpanded?.has(item.tuple_parent));" in src
    assert 'className: "explorerResultTable explorerStorageResultTable explorerStorageResultTable--merges"' in src
    assert 'explorerStorageResultTable--parts' in src
    assert 'explorerStorageResultTable--partitions' in src
    assert "decorateRow = null" in results


def test_data_preview_numeric_finalized_states_and_menu_portal_positioning() -> None:
    src = read("src/static/app_explorer.js")
    assert 'values.every((value) => Number.isFinite(Number(value))) ? "Float64" : c.type' in src
    assert 'menu.style.position = "fixed";' in src
    assert 'menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;' in src


def test_storage_graph_and_minimap_share_routed_geometry() -> None:
    src = read("src/static/app_explorer_graph.js")
    assert "const storageRowY = Number.isFinite(storedAnchorY) ? storedAnchorY : cursorY;" in src
    assert "let tierY = storageRowY;" in src
    minimap = src[src.index("function drawMinimap()") : src.index("function draw(now", src.index("function drawMinimap()"))]
    assert "storageRouteGeometry(from, to, edge).points" in minimap
    assert "ensureLineageRouteCache()" in minimap
    assert "bezierRoutePoints" in minimap
