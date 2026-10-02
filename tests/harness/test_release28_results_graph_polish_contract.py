from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def test_finished_results_virtualize_against_real_scroll_owner() -> None:
    results = read("src/static/app_results.js")
    assert "function findVerticalScrollOwner(el)" in results
    assert "function getVirtualRange(rowsLength, rowH, bodyEl)" in results
    assert "const owner = findVerticalScrollOwner(bodyEl);" in results
    assert 'document.addEventListener("scroll", handleVirtualScroll, { passive: true, capture: true });' in results
    assert "getVirtualRange(rows.length, rowH, tbody)" in results


def test_flatten_tuple_is_shared_enabled_by_default_and_used_by_query_and_data() -> None:
    state = read("src/static/app_state.js")
    dom = read("src/static/app_dom.js")
    ui = read("src/static/app_ui.js")
    explorer = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    results = read("src/static/app_results.js")
    query_html = read("src/static/query.html")

    assert "flattenTuple: true" in state
    assert "flattenTuple: obj.flattenTuple !== false" in state
    assert "runOptFlattenTuple: runOpts.flattenTuple" in state
    assert 'runOptFlattenTuple: byId("runOptFlattenTuple")' in dom
    assert "toggleRunOption(\"flattenTuple\")" in ui
    assert 'id="runOptFlattenTuple"' in query_html
    assert ">Flatten tuple<" in query_html
    assert "function createTupleFlattenPlan" in results
    assert 'if (ast.kind === "Array") return containsTuple(ast.inner);' in results
    assert 'type: `Array(${leaf.type})`' in results
    assert 'return parsed.map((item) => leaf.extract(item));' in results
    assert 'name: `${safeColumns[columnIndex]}.${leaf.path.join(".")}`' in results
    assert "flattenTupleRow(sourceRow, resultTupleFlattenPlan)" in results
    assert "function createDataSettingsControl()" in explorer
    assert 'node("span", "runMenu__optText", "Flatten tuple")' in explorer
    assert "storage?.saveRunOptions?." in explorer
    assert "ns.results?.flattenTupleTableData?." in explorer


def test_single_row_single_column_is_name_then_value_without_row_number() -> None:
    results = read("src/static/app_results.js")
    assert "function simplifySingleValueTable()" in results
    assert "if (resultColumns.length === 1)" in results
    assert 'table.classList.add("resultTable--singleValue")' in results
    single_start = results.index('if (safeRows.length === 1 && safeColumns.length === 1)')
    single_end = results.index('table.classList.remove("resultTable--singleValue")', single_start)
    block = results[single_start:single_end]
    assert 'th.textContent = safeColumns[0];' in block
    assert 'head.appendChild(th);' in block
    assert 'tr.appendChild(td);' in block
    assert 'resultTable__rowIndex' not in block


def test_finalize_info_does_not_displace_sort_marker() -> None:
    css = read("src/static/style.css")
    assert ".explorerFinalizeInfo {\n  position: absolute;" in css
    assert "right: 2px;" in css
    # The sort marker is inline in the sort button, after the label.
    assert ".dataTable__sort::after {\n  content: \"\\2195\";" in css
    assert ".explorerCard .explorerPreviewTable .resultTable thead th.has-finalize-info {\n  padding-right: 16px;\n}" in css


def test_graph_animation_is_topological_without_background_activity_polling() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    api = read("src/static/app_api.js")
    server = read("src/server.cpp")
    assert "getExplorerActivity" not in api
    assert "api.getExplorerActivity" not in graph
    assert '/api/explorer/activity' not in server
    assert "isFocusedDepthOneEdge(edge)" in graph


def test_noninteractive_lineage_control_has_no_hover_chrome() -> None:
    css = read("src/static/style.css")
    # A disabled segmented option (Storage for a view) takes no hover look.
    assert ".segmented__option:hover:not(:disabled) {" in css
    assert ".segmented__option:disabled {\n  opacity: 0.45;\n  cursor: not-allowed;\n}" in css


def test_graph_pan_is_clamped_and_minimap_contains_arrows() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    assert "function clampViewportToGraph()" in graph
    assert "view.offsetX = Math.max(Math.min(minX, maxX), Math.min(Math.max(minX, maxX), view.offsetX));" in graph
    assert "view.offsetY = Math.max(Math.min(minY, maxY), Math.min(Math.max(minY, maxY), view.offsetY));" in graph
    assert "kit.clampView(model, model.worldBounds, rect.width, rect.height);" in graph
    # Pan and zoom clamp in the kit controller (clamp()), the Explorer camera moves here.
    assert graph.count("clampViewportToGraph();") >= 3 and graph.count("      clamp();") >= 2
    minimap = graph[graph.index("function drawMinimap(frame)") : graph.index("function draw(ctx, frame)", graph.index("function drawMinimap(frame)"))]
    minimap += graph[graph.index("function drawMinimap(canvas, options)") : graph.index("function fitTransform(")]
    assert "for (const edge of visibleEdges())" in minimap
    assert "storageRouteGeometry(from, to, edge).points" in minimap
    assert "ensureLineageRouteCache()" in minimap
    assert "strokePolyline(ctx, mapped);" in minimap
    assert "Math.atan2(tip.y - near.y, tip.x - near.x)" in minimap


def test_storage_buffer_uses_vertical_ports_and_horizontal_peers_align() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    route_start = graph.index("function storageRouteGeometry")
    route_end = graph.index("function drawStorageRoute", route_start)
    route = graph[route_start:route_end]
    assert 'String(edge?.kind || "") === "buffer"' in route
    assert "x: from.x + from.width / 2, y: from.y + from.height" in route
    assert "x: to.x + to.width / 2, y: to.y" in route
    assert "function alignPhysicalHorizontalPeers(positions, edges)" in graph
    assert "to.y = from.y;" in graph
    assert "alignPhysicalHorizontalPeers(positions, edges);" in graph


def test_explorer_refresh_and_gear_match_chromeless_editor_gear_hover() -> None:
    css = read("src/static/style.css")
    assert ".explorerTableSettings__button,\n.explorerRefreshButton {" in css
    assert "border: 0 !important;" in css
    assert "background: transparent !important;" in css
    assert ".explorerRefreshButton:hover:not(:disabled) .refreshGlyph" in css
    assert "opacity: 1;" in css
