from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_graph_routes_share_runner_scoped_acl_boundary() -> None:
    server = read("src/server.cpp")
    api = read("src/api_explorer.cpp")

    assert 'http_.Get("/api/explorer/graph"' in server
    assert 'http_.Get("/api/explorer/activity"' in server
    assert "handle_explorer_graph" in api
    assert "handle_explorer_activity" in api
    # Each route establishes the same runner ACL boundary before using system metadata.
    graph_handler = api[api.index("void Server::handle_explorer_graph"):]
    assert "authenticate_request" not in graph_handler
    assert "discover_allowed_objects(*runner)" in graph_handler
    assert "explorer_graph_cache_.get_or_refresh" in graph_handler


def test_graph_backend_normalizes_dependencies_and_filters_both_ends() -> None:
    graph = read("src/explorer_graph.cpp")

    assert "dependencies_database" in graph
    assert "dependencies_table" in graph
    assert "allowed.allows_table(source_db, source_table)" in graph
    assert "allowed.allows_table(dep_db, dep_table)" in graph
    assert '"materialized_view"' in graph
    assert '"refreshable_mv"' in graph
    assert '"view"' in graph
    assert '"buffer"' in graph
    assert '"distributed_route"' in graph
    assert '"contains"' in graph
    assert "system_uri" not in graph


def test_graph_uses_structured_metadata_and_only_targeted_sql_parsing() -> None:
    graph = read("src/explorer_graph.cpp")

    assert "FROM system.tables" in graph
    assert "FROM system.clusters" in graph
    assert "parse_engine_arguments" in graph
    assert "parse_select_sources" in graph
    assert "qualified_after_keyword" in graph
    assert "unknown" in graph and "omitted rather than guessed" in graph


def test_activity_overlay_is_independent_and_never_swallows_clickhouse_errors() -> None:
    graph = read("src/explorer_graph.cpp")
    frontend = read("src/static/app_explorer_graph.js")

    assert "FROM system.query_log" in graph
    assert "FROM system.part_log" in graph
    assert "FROM system.replicas" in graph
    assert "FROM system.view_refreshes" in graph
    assert "Graph query activity query failed:" in graph
    assert "Graph part activity query failed:" in graph
    assert "Graph replication activity query failed:" in graph
    assert "Graph refresh activity query failed:" in graph
    assert "Activity is best-effort" not in graph
    assert "api.getExplorerActivity" in frontend
    assert "setInterval" in frontend
    assert "lineageEdgeShouldAnimate(edge, activity)" in frontend
    assert "activity?.active === true" in frontend


def test_graph_frontend_uses_canvas_dag_lod_zoom_pan_focus_and_minimap() -> None:
    html = read("src/static/explorer.html")
    js = read("src/static/app_explorer_graph.js")

    assert '<canvas id="explorerGraphCanvas"' in html
    assert '<canvas id="explorerGraphMinimap"' in html
    assert "computeLayout" in js
    assert "indegree" in js
    assert "model.scale < 0.23" in js
    assert "drawDatabaseLod" in js
    assert 'addEventListener("wheel"' in js
    assert 'addEventListener("pointerdown"' in js
    assert "fitToScreen" in js
    assert "setFocus" in js
    assert "drawMinimap" in js
    assert "document.createElement" not in js[js.index("function draw("):js.index("function scheduleDraw")]


def test_logical_lineage_and_physical_storage_are_separate_projections_of_one_backend_model() -> None:
    graph_h = read("src/explorer_graph.hpp")
    graph_cpp = read("src/explorer_graph.cpp")
    frontend = read("src/static/app_explorer_graph.js")

    assert 'std::string layer = "logical"' in graph_h
    assert 'replica.layer = "physical"' in graph_cpp
    assert 'disk_node.layer = "physical"' in graph_cpp
    assert 'shard.layer = "physical"' in graph_cpp
    assert 'if (model.detailMode === "physical")' in frontend
    assert 'target.layer !== "physical"' in frontend
    assert 'const projection = logicalProjection();' in frontend
    assert 'return projection.nodes' in frontend
    assert 'setDetailMode("logical")' in frontend
    assert 'setDetailMode("physical")' in frontend
    assert 'contractNeighborhood' in frontend
    assert 'model.focusDepth -= 1' in frontend


def test_ttl_is_serialized_as_ordered_metadata_and_projected_onto_storage_lifecycle() -> None:
    graph_h = read("src/explorer_graph.hpp")
    graph_cpp = read("src/explorer_graph.cpp")
    api = read("src/api_explorer.cpp")
    frontend = read("src/static/app_explorer_graph.js")

    assert "struct ExplorerGraphTtlRule" in graph_h
    assert "std::vector<ExplorerGraphTtlRule> ttl_rules" in graph_h
    assert "parse_table_ttl_rules" in graph_cpp
    assert "derive_ttl_timing" in graph_cpp
    assert 'node.ttl_rules = parse_table_ttl_rules(table.ddl);' in graph_cpp
    # The backend remains a stable metadata/topology model. TTL lifecycle edges
    # are a frontend projection so temporal annotations never pollute the API DAG.
    assert '"ttl_move"' not in graph_cpp
    assert 'w.Key("ttl_rules")' in api
    assert 'function storageProjection()' in frontend
    assert 'kind: "storage_tier"' in frontend
    assert 'tier_disks: disks' in frontend
    assert 'current.ttl_events.push(event);' in frontend
    assert 'addTtlEdgeEvent(current, target, event);' in frontend
    assert 'kind: "ttl_delete"' in frontend
    assert 'function drawStorageTierNode(' in frontend
    assert 'function drawLifecycleEdgeLabel(' in frontend
    assert 'function drawTtlSummary(' in frontend
    assert 'function drawTtlTimeline(' not in frontend


def test_hidden_buffer_projection_uses_forwarding_table_as_representative() -> None:
    frontend = read("src/static/app_explorer_graph.js")
    projection = frontend[frontend.index("function logicalProjection()"):frontend.index("function canUseStorageForId")]

    assert "resolveBufferRepresentative" in projection
    assert 'if (edge.kind !== "buffer") continue;' in projection
    assert 'walkProjectedPath(representative, edge, [node.id]);' in projection
    assert 'if (targetNode.kind === "buffer")' in projection
    assert 'addCollapsed(source, representative, current.path, hidden);' in projection
    assert 'const key = `${edge.from}\\u0000${edge.to}\\u0000${edge.kind}`;' in projection


def test_visibility_toggle_recomputes_canonical_layout_and_only_preserves_camera_anchor() -> None:
    frontend = read("src/static/app_explorer_graph.js")
    recompute = frontend[frontend.index("function recomputePreservingFocusAnchorOnly"):frontend.index("function logicalFocusId")]
    visibility = frontend[frontend.index("function setVisibilityOptions"):frontend.index("function activate", frontend.index("function setVisibilityOptions"))]

    assert "computeLayout();" in recompute
    assert "computeLayout({ preserveExisting: true" not in recompute
    assert "restoreViewportAnchor(anchor);" in recompute
    assert "captureViewportAnchor" in visibility
    assert "projectionChanged" in visibility


def test_storage_node_selection_keeps_logical_neighborhood_anchor() -> None:
    frontend = read("src/static/app_explorer_graph.js")

    assert "function logicalFocusId" in frontend
    assert 'const incoming = new Map();' in frontend
    assert 'incoming.get(edge.to).push(edge.from);' in frontend
    assert "const nextId = logicalFocusId(id);" in frontend
    assert "model.focusedId = nextId;" in frontend
