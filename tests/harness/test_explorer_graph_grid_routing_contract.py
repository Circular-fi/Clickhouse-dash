from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_lineage_layout_uses_shared_row_grid_and_top_anchored_ports() -> None:
    js = read("src/static/app_explorer_graph.js")
    assert 'const LINEAGE_NODE_PORT_TOP_OFFSET = 36;' in js
    assert 'const lineageRowPitch = model.detailMode === "logical"' in js
    assert '70 + gridRow * lineageRowPitch' in js
    assert 'const lineageRows = new Map();' in js
    assert 'const betweenRowYs = [];' in js
    assert 'lineageNodePort(item, "right")' in js
    assert 'lineageNodePort(item, "left")' in js


def test_materialized_views_keep_dashed_node_outline() -> None:
    js = read("src/static/app_explorer_graph.js")
    expected = '["view", "materialized_view", "refreshable_materialized_view"].includes(node.kind)'
    assert js.count(expected) >= 2
    assert 'ctx.setLineDash([5, 4]);' in js


def test_visibility_toggles_lock_for_selected_system_or_non_storing_object() -> None:
    graph = read("src/static/app_explorer_graph.js")
    explorer = read("src/static/app_explorer.js")
    assert 'function visibilityRequirements()' in graph
    assert 'required.includeSystem || options.includeSystem === true' in graph
    assert 'const nextIncludeNonStoring = required.includeNonStoring || options.includeNonStoring !== false;' in graph
    assert 'includeNonStoring: !!node && isNonStoringNode(node)' in graph
    assert 'function syncVisibilityOptionLocks' in explorer
    assert 'dom.explorerIncludeSystem.disabled = required.includeSystem;' in explorer
    assert 'dom.explorerIncludeNonStoring.disabled = required.includeNonStoring;' in explorer
    assert 'syncVisibilityOptionLocks({ propagate: true });' in explorer


def test_manual_graph_refresh_reflows_current_projection() -> None:
    js = read("src/static/app_explorer_graph.js")
    assert 'async function refresh(force = false, { reflow = false } = {})' in js
    assert 'computeLayout({ preserveExisting: hadLayout && !reflow });' in js
    assert 'refresh(true, { reflow: true })' in js
    assert 'if (reflow) {' in js
    assert 'fitToScreen();' in js


def test_lineage_routes_are_directionally_monotone_except_same_row_obstacles() -> None:
    js = read("src/static/app_explorer_graph.js")
    assert 'const verticalDirection = verticalDelta < -0.001 ? -1 : (verticalDelta > 0.001 ? 1 : 0);' in js
    assert 'const sameRowNeedsDetour = verticalDirection === 0 && !clearSegment(sourceFan, targetFan);' in js
    assert 'if (direction > 0 && dx < -0.001) continue;' in js
    assert 'if (direction < 0 && dx > 0.001) continue;' in js
    assert 'if (dy > 0.001 || nextPoint.y < targetFan.y - 0.001) continue;' in js
    assert 'if (dy < -0.001 || nextPoint.y > targetFan.y + 0.001) continue;' in js
    assert 'Same-row obstacle exception' in js
