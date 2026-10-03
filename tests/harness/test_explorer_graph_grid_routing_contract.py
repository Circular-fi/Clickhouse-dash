from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_lineage_layout_uses_shared_row_grid_and_top_anchored_ports() -> None:
    js = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    assert 'const LINEAGE_NODE_PORT_TOP_OFFSET = 36;' in js
    assert 'const lineageRowPitch = model.detailMode === "logical"' in js
    assert 'origin + gridRow * lineageRowPitch' in js and 'origin: 70,' in js
    assert 'const lineageRows = new Map();' in js
    assert 'const betweenRowYs = [];' in js
    assert 'nodePort(item, "right")' in js
    assert 'nodePort(item, "left")' in js


def test_materialized_views_keep_dashed_node_outline() -> None:
    js = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    # The card outline is dashed for View / MV objects, focused or not: the focus is
    # the same outline, 2 px and in the accent.
    assert 'const viewLike = node.kind === "view" || node.kind === "materialized_view" || node.kind === "refreshable_materialized_view";' in js
    assert 'dashed: viewLike || storageDisabled,' in js and 'if (card.dashed) ctx.setLineDash([5, 4]);' in js
    assert 'focused: isFocus,' in js
    assert 'ctx.lineWidth = card.focused ? 2 : card.borderWidth ?? 1.2;' in js


def test_visibility_toggles_lock_for_selected_system_or_non_storing_object() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    explorer = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    assert 'function visibilityRequirements()' in graph
    assert 'required.includeSystem || options.includeSystem === true' in graph
    assert 'const nextIncludeNonStoring = required.includeNonStoring || options.includeNonStoring !== false;' in graph
    assert 'includeNonStoring: !!node && isNonStoringNode(node)' in graph
    assert 'function syncVisibilityOptionLocks' in explorer
    # The tree filter chips replace the settings checkboxes: the System chip and
    # the chip of the selected object's type are pressed and locked.
    assert 'const locked = system ? !!required.includeSystem : required.kind === key;' in explorer
    assert 'chip.disabled = locked;' in explorer
    assert 'if (required.kind && model.filters[required.kind] === false) { model.filters[required.kind] = true; changed = true; }' in explorer
    assert 'model.filters.views !== false || model.filters.mv !== false || required.includeNonStoring' in explorer
    assert 'syncVisibilityOptionLocks({ propagate: true });' in explorer


def test_manual_graph_refresh_reflows_current_projection() -> None:
    js = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    assert 'async function refresh(force = false, { reflow = false } = {})' in js
    assert 'computeLayout({ preserveExisting: hadLayout && !reflow });' in js
    assert 'refresh(true, { reflow: true })' in js
    assert 'if (reflow) {' in js
    assert 'fitToScreen();' in js


def test_lineage_routes_are_directionally_monotone_except_same_row_obstacles() -> None:
    js = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    assert 'const verticalDirection = verticalDelta < -0.001 ? -1 : (verticalDelta > 0.001 ? 1 : 0);' in js
    assert 'const sameRowNeedsDetour = verticalDirection === 0 && !clearSegment(sourceFan, targetFan);' in js
    # One relaxation rule (stepCost) for both grid searches of the kit router.
    assert 'if (direction > 0 && dx < -0.001) return null;' in js
    assert 'if (direction < 0 && dx > 0.001) return null;' in js
    assert 'if (dy > 0.001 || nextPoint.y < targetFan.y - 0.001) return null;' in js
    assert 'if (dy < -0.001 || nextPoint.y > targetFan.y + 0.001) return null;' in js
    assert 'Same-row obstacle exception' in js
