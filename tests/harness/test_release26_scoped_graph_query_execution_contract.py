from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_graph_api_is_server_scoped_to_focus_depth_and_mode() -> None:
    cpp = read("src/api_explorer.cpp")
    api = read("src/static/app_api.js")

    assert "struct ExplorerGraphRequestScope" in cpp
    for token in ('"focus_database"', '"focus_table"', '"depth"', '"mode"', '"include_system"'):
        assert token in cpp
    assert "std::clamp(std::stoi(req.get_param_value(\"depth\")), 0, 8)" in cpp
    assert "ExplorerGraph scope_graph(" in cpp
    assert "std::deque<std::string> queue" in cpp
    assert "const int next_depth = current_depth + cost;" in cpp
    assert "if (next_depth > scope.depth) continue;" in cpp
    assert 'scope.physical && storage_enabled' in cpp
    assert '!scope.physical && lineage_enabled' in cpp
    assert "const ExplorerGraph scoped_graph = scope_graph(" in cpp
    assert "for (const auto& node : scoped_graph.nodes)" in cpp
    assert "for (const auto& edge : scoped_graph.edges)" in cpp

    assert 'query.set("focus_database", focusDatabase)' in api
    assert 'query.set("focus_table", focusTable)' in api
    assert 'query.set("depth", String(Math.max(0, Math.min(8, Number(options.depth) || 0))))' in api
    assert 'query.set("mode", options.mode === "physical" ? "physical" : "logical")' in api


def test_live_activity_endpoint_is_not_exposed_or_polled() -> None:
    server = read("src/server.cpp")
    api = read("src/static/app_api.js")
    graph = read("src/static/app_explorer_graph.js")

    assert '/api/explorer/activity' not in server
    assert 'getExplorerActivity' not in api
    assert 'api.getExplorerActivity' not in graph
    assert 'setInterval' not in graph


def test_focused_graph_requests_exact_depth_and_groups_databases() -> None:
    graph = read("src/static/app_explorer_graph.js")

    assert "options.depth = model.detailMode === \"logical\" ? Math.min(8, model.focusDepth) : 0;" in graph
    assert "groupLogicalPositionsByDatabase(positions);" in graph
    assert "function groupLogicalPositionsByDatabase(positions)" in graph
    assert "function drawDatabaseGroups(ctx)" in graph
    assert "drawDatabaseGroups(ctx);" in graph
    assert "maxRowsPerSubcolumn = 6" in graph
    assert "scope_has_more" in read("src/api_explorer.cpp")
    assert "model.graph?.scope_has_more === true" in graph
    assert "model.graph?.scope_focus_id === model.focusedId" in graph
    assert "model.scale < 0.23 && model.detailMode === \"logical\" && !model.focusedId" in graph


def test_logical_node_labels_are_database_qualified() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert '`${node.database}.${baseName}`' in graph
    assert "NODE_WIDTH = 240" in graph


def test_focus_animation_cannot_escape_selected_table_edges() -> None:
    graph = read("src/static/app_explorer_graph.js")
    start = graph.index("function lineageEdgeShouldAnimate")
    end = graph.index("function drawEdge", start)
    block = graph[start:end]

    assert "model.focusedId" in block
    assert "isFocusedDepthOneEdge(edge)" in block
    assert "return edge.from === model.focusedId || edge.to === model.focusedId;" in graph
    assert "isInsertFlowEdge(edge) || isRefreshFlowEdge(edge)" in block
    assert "activity" not in block
    assert "return false;" in block


def test_logical_payload_retains_storage_availability_without_physical_batch() -> None:
    cpp = read("src/api_explorer.cpp")
    graph = read("src/static/app_explorer_graph.js")
    assert "logical_storage_available_ids" in cpp
    assert 'w.Key("storage_available")' in cpp
    assert 'typeof root.storage_available === "boolean"' in graph


def test_query_execution_stats_are_opt_in_and_disabled_by_default() -> None:
    state = read("src/static/app_state.js")
    ui = read("src/static/app_ui.js")
    run = read("src/static/app_run.js")
    dom = read("src/static/app_dom.js")
    html = read("src/static/query.html")
    index = read("src/static/index.html")

    assert "executionStats: false" in state
    assert "executionStats: obj.executionStats === true" in state
    assert "runOptExecutionStats: runOpts.executionStats" in state
    assert 'runOptExecutionStats: byId("runOptExecutionStats")' in dom
    assert 'toggleRunOption("executionStats")' in ui
    assert 'if (!state.runOptExecutionStats && dom.clickhouseElapsedWrap) dom.clickhouseElapsedWrap.hidden = true;' in ui
    assert "executionStats: state.runOptExecutionStats" in ui
    assert "if (!state.runOptExecutionStats)" in run
    assert "if (out && out.queryId && state.runOptExecutionStats)" in run
    for document in (html, index):
        assert 'id="runOptExecutionStats"' in document
        assert "Load execution stats" in document
        assert 'aria-checked="false"' in document
