from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_layout_transposition_uses_incremental_crossing_delta() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    layout = graph[graph.index("function layered(options)"):graph.index("function cycleBackEdges(")]
    assert "kit.layered({" in graph[graph.index("function computeLayout("):graph.index("function overviewScale()")]
    # Re-scoring every crossing twice per adjacent swap froze a 2k-node catalog
    # for a minute; the swap decision must use the exact incremental delta.
    assert "const before = crossingScore();" not in layout
    assert "if (swapDelta(group[i].id, group[i + 1].id) < 0)" in layout
    # Monotone row assignment keeps a running prefix minimum, not an inner scan.
    assert "for (let pr = i - 1; pr < row; pr += 1)" not in layout


def test_projection_colors_and_route_scoring_are_cached_or_pruned() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    projection = graph[graph.index("function logicalProjection()"):graph.index("function canUseStorageForId")]
    assert projection.index("logicalProjectionCacheValid(model.logicalProjectionCache)") < projection.index("resolveBufferRepresentative")
    assert "function visibleSet()" in graph
    assert "themeCache.colors.get(name)" in graph
    assert "kit.theme.invalidate();" in graph[graph.index("function redrawThemeNow()"):]
    # Pair conflicts through the segment index, not every pair of routes.
    assert "const index = createSegmentIndex(all);" in graph
    assert "if (segmentsApart(a, b, segment.a, segment.b, LANE_GAP)) continue;" in graph
    # Every route owns its lane: parallel runs closer than LANE_GAP cost more
    # than a crossing (the index returns the lines within LANE_GAP too).
    assert "const LANE_GAP = 12;" in graph and "const FAN_STEP = LANE_GAP;" in graph
    # One scoring of a step against a segment (segmentConflictTerm) for the
    # A* steps, the cheap routes and the fallback; the pair scoring keeps
    # orthogonalSegmentConflict().
    assert "if (gap > 0.001) return NEAR_BASE + shared * NEAR_PER_PX;" in graph
    assert "const value = segmentConflictTerm(a.x, a.y, b.x, b.y, segment, currentEdge);" in graph
    assert "if (conflict.near > 0.5) return NEAR_BASE + conflict.near * NEAR_PER_PX;" in graph
    assert "setInterval" not in graph


def test_explorer_search_debounces_graph_focus() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    # The tree filter follows every key; the graph focus waits for the one
    # search delay (util.debounce, util.SEARCH_DEBOUNCE_MS = 200 ms).
    assert "const graphSearch = util.debounce(() => graph?.searchFocus());" in ui
    assert "ns.search.bind(dom.explorerSearchInput, () => { renderTableList(); graphSearch(); }, { debounceMs: 0 });" in ui
    assert "const SEARCH_DEBOUNCE_MS = 200;" in read("src/static/app_util.js")


def test_orthogonal_router_hot_paths_are_indexed_without_changing_routes() -> None:
    graph = ((ROOT / "src/static/app_explorer_graph.js").read_text(encoding="utf-8") + (ROOT / "src/static/app_graph_kit.js").read_text(encoding="utf-8"))
    router = graph[graph.index("function orthogonalRouteForEdge("):graph.index("function cheapRouteBody(")]
    # The indexed grid (typed arrays, reused buffers) gives the same routes as
    # the keyed reference search, kept for points off the deduplicated grid.
    assert "found = searchIndexedGrid();" in router and "found = searchKeyedGrid();" in router
    assert "const buffers = gridBuffers(total);" in router
    # Heap on (f, insertion order) == the former stable sort + shift(): the
    # keyed search's objects, the indexed search's typed entries ((f, entry
    # number) order).
    assert "const queue = createRouteQueue();" in router and "const queue = createStateQueue();" in router
    assert "queue.sort(" not in router and "queue.shift()" not in router
    assert "a.f < b.f || (a.f === b.f && a.seq < b.seq)" in graph
    assert "if (!(value < f[p] || (value === f[p] && n < p))) break;" in graph
    # Lane distance by binary search; conflicts only against nearby segments,
    # per grid row / column of the A* (the index keeps each line it was asked
    # about), the non-zero terms summed in segment order.
    assert "sortedLaneYs" in router and "Math.min(...preferredHorizontalYs" not in router
    assert "corridorSegmentIndex.penalty(currentPoint.x, currentPoint.y, nextPoint.x, nextPoint.y, edge, segmentConflictTerm)" in router
    assert "corridorSegmentIndex.penalty(cx, cy, nx, ny, edge, segmentConflictTerm, Infinity, dir === 1 ? id % NY : NY + ((id / NY) | 0))" in router
    assert "if (cached === undefined) cached = lineCache[line] = cacheLine(side, along);" in graph
    assert "if (integral && partial < 2 ** 53) return partial;" in graph
    assert "const order = found.slice(0, count).sort();" in graph
    # A link's conflict is only scored when the link could improve its state
    # without it (the conflict is >= 0).
    assert "if (currentCost + length + bend + reverse + boundary + lane + 0.001 >= best[nextState]) continue;" in router
    assert router.index("+ reverse + boundary + lane + 0.001 >= best[nextState]) continue;") < router.index("conflict = corridorSegmentIndex.penalty(cx, cy")
    assert "ROUTE_GRID_POINT_BUDGET" in router


def test_dense_map_cheap_routes_and_labels_skip_the_work_they_do_not_use() -> None:
    graph = (ROOT / "src/static/app_graph_kit.js").read_text(encoding="utf-8")
    cheap = graph[graph.index("function cheapRouteBody("):graph.index("// --------------------------------------------------- route set scoring")]
    # Candidates as numbers and bases, taken from a heap in the stable-sort
    # order; a step's scoring stops once the candidate cannot win.
    assert "const before = (i, j) => bases[i] < bases[j] || (bases[i] === bases[j] && i < j);" in cheap
    assert "candidates.sort(" not in cheap and "polylineMetric(route)" not in cheap
    assert "const route = routeOf(next);" in cheap
    assert "cost += index.penalty(a.x, a.y, b.x, b.y, edge, segmentConflictTerm, bestCost - cost);" in cheap
    # Label anchors one at a time; rectangles hashed by number, not string.
    labels = graph[graph.index("function visitLabelAnchors("):graph.index("function drawLabel(")]
    assert "visitLabelAnchors(request.points, height, width, (ax, ay) => {" in labels
    assert "keys.push(`${x}:${y}`)" not in labels and "const key = x * ROW + y;" in labels
