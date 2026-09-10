from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_lineage_routes_detour_around_cards_and_penalize_edge_crossings() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert 'function segmentHitsItem(' in graph
    assert 'function orthogonalSegmentConflict(' in graph
    assert 'function routeConflictPenalty(' in graph
    assert 'function orthogonalRouteForEdge(' in graph
    assert 'function ensureLineageRouteCache()' in graph
    assert 'conflict.crossings * 28_000' in graph
    assert '1_000_000_000 + conflict.overlap * 100_000' in graph
    assert 'const lineageRoute = straightStorage ? null : ensureLineageRouteCache().get(edge.id);' in graph


def test_logical_dependencies_never_animate_but_selected_dependency_gets_blue_dash_halo() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert 'function isLogicalDependencyEdge(edge)' in graph
    assert '["view", "dependency"]' in graph
    assert 'function drawSelectedLogicalDependencyHalo(' in graph
    halo = graph[graph.index('function drawSelectedLogicalDependencyHalo('):graph.index('function drawEdge(')]
    assert 'ctx.strokeStyle = css("--accent", "#7c9cff");' in halo
    assert 'ctx.shadowBlur = 7 / Math.max' in halo
    assert 'edge.from !== model.focusedId && edge.to !== model.focusedId' in halo
    flow = graph[graph.index('function isInsertFlowEdge(edge)'):graph.index('function isStorageRouteEdge(edge)')]
    assert 'kind === "view"' not in flow
    assert 'kind === "dependency"' not in flow


def test_flow_dot_emission_is_time_based_across_zoom_changes() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert 'flowMarkerState: new Map()' in graph
    marker = graph[graph.index('function drawNormalizedFlowMarker('):graph.index('function drawStorageFlowMarker(')]
    assert 'const newestAgeMs = (now + state.phaseOffsetMs) % FLOW_EMISSION_INTERVAL_MS;' in marker
    assert 'const markerCount = Math.min(' in marker
    assert 'const worldDistance = ageMs / 1000 * FLOW_SPEED_WORLD_PER_SECOND;' in marker
    assert 'ctx.arc(point.x, point.y, FLOW_DOT_RADIUS_WORLD' in marker
    assert '/ scale' not in marker


def test_storage_includes_buffer_and_automatically_retains_flush_destination() -> None:
    graph = read("src/static/app_explorer_graph.js")
    projection = graph[graph.index('function rawStorageProjection()'):graph.index('function storageProjection()')]
    eligibility = graph[graph.index('function canUseStorageForId('):graph.index('function canUseStorageForTable(')]
    assert 'current.kind !== "buffer"' in eligibility
    assert 'edge.kind === "buffer" && visit(edge.to)' in eligibility
    assert 'const addBufferRoute = (bufferId' in projection
    assert 'keep.add(target.id);' in projection
    assert 'edge.kind === "buffer" && target.layer === "logical"' in projection
    assert 'return !isNonStoringNode(node) || node.kind === "buffer";' in projection
    assert '"contains", "buffer"' in graph
    assert 'const bufferIds = logicalIds.filter((id) => byId.get(id)?.kind === "buffer");' in graph


def test_storage_sidebar_keeps_buffer_available_while_other_non_storing_objects_are_blocked() -> None:
    ui = read("src/static/app_explorer.js")
    assert 'const storageBuffer = storageMode && engineKey(table) === "buffer";' in ui
    assert 'if (!model.includeNonStoring && nonStoringSummary(table) && !storageBuffer) return false;' in ui
    assert 'function storageCatalogEligible(summary)' in ui
    assert '&& !storageCatalogEligible(table);' in ui


def test_legend_is_vertical_and_explorer_health_dot_is_smaller() -> None:
    css = read("src/static/style.css")
    legend = css[css.index('.explorerGraphLegend {'):css.index('.explorerGraphLegend span')]
    assert 'grid-template-columns: 1fr;' in legend
    start = css.index('.explorerTreeHealthDot {')
    health = css[start:css.index('.explorerDetailPane {', start)]
    assert 'width: 0.42rem;' in health
    assert 'height: 0.42rem;' in health
    assert '@keyframes explorerTreeHealthPulse' in health
