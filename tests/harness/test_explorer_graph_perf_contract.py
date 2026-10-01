from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_layout_transposition_uses_incremental_crossing_delta() -> None:
    graph = read("src/static/app_explorer_graph.js")
    layout = graph[graph.index("function computeLayout("):graph.index("function fitToScreen()")]
    # Re-scoring every crossing twice per adjacent swap froze a 2k-node catalog
    # for a minute; the swap decision must use the exact incremental delta.
    assert "const before = crossingScore();" not in layout
    assert "if (swapDelta(group[i].id, group[i + 1].id) < 0)" in layout
    # Monotone row assignment keeps a running prefix minimum, not an inner scan.
    assert "for (let pr = i - 1; pr < row; pr += 1)" not in layout


def test_projection_colors_and_route_scoring_are_cached_or_pruned() -> None:
    graph = read("src/static/app_explorer_graph.js")
    projection = graph[graph.index("function logicalProjection()"):graph.index("function canUseStorageForId")]
    assert projection.index("logicalProjectionCacheValid(model.logicalProjectionCache)") < projection.index("resolveBufferRepresentative")
    assert "function visibleSet()" in graph
    assert "themeCache.colors.get(name)" in graph
    assert "invalidateThemeCache();" in graph[graph.index("function redrawThemeNow()"):]
    assert "if (routeBoxesApart(routeBox(routeA), routeBox(routeB))) return score;" in graph
    assert "if (segmentsApart(a, b, segment.a, segment.b)) continue;" in graph
    assert "setInterval" not in graph


def test_explorer_search_debounces_graph_focus() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    assert "graphSearchTimer = setTimeout(() => graph?.searchFocus(), 200);" in ui


def test_orthogonal_router_hot_paths_are_indexed_without_changing_routes() -> None:
    graph = (ROOT / "src/static/app_explorer_graph.js").read_text(encoding="utf-8")
    router = graph[graph.index("function orthogonalRouteForEdge("):graph.index("function assembleOrthogonalRoute(")]
    # Heap on (f, insertion order) == the former stable sort + shift().
    assert "const queue = createRouteQueue();" in router
    assert "queue.sort(" not in router and "queue.shift()" not in router
    assert "a.f < b.f || (a.f === b.f && a.seq < b.seq)" in graph
    # Lane distance by binary search; conflicts only against nearby segments.
    assert "sortedLaneYs" in router and "Math.min(...preferredHorizontalYs" not in router
    assert "corridorSegmentIndex.near(currentPoint, nextPoint)" in router
    assert "return [...seen].sort((x, y) => x - y).map((index) => segments[index]);" in graph
    assert "ROUTE_GRID_POINT_BUDGET" in router
