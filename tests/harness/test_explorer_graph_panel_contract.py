from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_graph_definition_route_stands_on_the_runner_acl_snapshot_and_runs_no_sql() -> None:
    server = read("src/server.cpp")
    api = read("src/api_explorer.cpp")
    assert 'http_.Get("/api/explorer/graph/definition"' in server
    handler = api[api.index("void Server::handle_explorer_graph_definition"):]
    handler = handler[:handler.index("\n}\n")]
    # Same AllowedObjectSet boundary as the graph route, served from the
    # cached authorized graph: no caller-supplied SQL, no new query.
    assert "explorer_graph_snapshot(req, res, host_id, graph, stale)" in handler
    assert ".Select(" not in handler and "try_select" not in handler
    assert 'candidate.layer == "logical" && candidate.id == id' in handler
    assert "unknown_object" in handler
    assert "definition.target_visible && !definition.target_table.empty()" in handler
    snapshot = api[api.index("bool Server::explorer_graph_snapshot"):]
    assert "discover_allowed_objects(*runner)" in snapshot
    assert "explorer_graph_cache_.get_or_refresh" in snapshot


def test_graph_definitions_never_name_objects_outside_the_allowed_set() -> None:
    graph = read("src/explorer_graph.cpp")
    header = read("src/explorer_graph.hpp")
    assert "std::unordered_map<std::string, ExplorerGraphDefinition> definitions;" in header
    assert "definition.target_visible = allowed.allows_table(database, name);" in graph
    assert "definition.target_database = definition.target_visible ? database : std::string{};" in graph
    # Dictionary SOURCE() keeps only its kind: host, user and the masked
    # password are connection arguments, not graph metadata.
    assert "definition.dictionary_source_kind = leading_identifier(*source);" in graph
    assert "loading_dependencies_database, loading_dependencies_table" in graph
    assert '"dictionary_source"' in graph
    assert "kDefinitionSqlLimit" in graph


def test_graph_expansions_are_bounded_and_only_grow_from_shown_anchors() -> None:
    api = read("src/api_explorer.cpp")
    assert "constexpr size_t kMaxGraphExpansions = 64;" in api
    assert 'req.get_param_value_count("expand")' in api
    assert "if (!included.count(anchor)) continue;" in api
    assert 'w.Key("hidden_upstream")' in api and 'w.Key("hidden_downstream")' in api
    app_api = read("src/static/app_api.js")
    assert 'query.append("expand", String(item))' in app_api
    assert "getExplorerGraphDefinition" in app_api


def test_graph_frontend_has_panel_groups_list_and_readable_fit() -> None:
    js = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    css = css_sources.text()
    assert "const READABLE_TEXT_PX = 11;" in js
    # Fit shows the whole graph; only one too large for the compact titles
    # opens at the readable scale (kit.fitScale, FIT_FLOOR).
    assert "model.scale = kit.fitScale(overview, readableScale());" in js
    assert "return overview >= FIT_FLOOR - 1e-9 ? overview : Math.max(overview, readable);" in js
    assert "function groupedOverview(nodes, edges)" in js
    assert 'kind: "database_group"' in js
    assert "function drawNodeExpandControls(ctx, compact)" in js
    assert "function renderNodePanel(body, node)" in js
    assert "function renderEdgePanel(body, edge)" in js
    assert 'const MOBILE_QUERY = "(max-width: 720px)";' in js
    # The canvas is the only view, on phones too: no Graph / List switch, no
    # impact list (keyboard access and the live region stay).
    for gone in ("renderImpactList", "impactRows", "viewSwitch", "graphKitList", "currentViewMode"):
        assert gone not in js, gone
    assert 'live.setAttribute("aria-live", "polite");' in js
    assert "model.openCard(node.database, node.name)" in js
    # Canvas colours come from graph tokens defined for both themes.
    for token in ("--graph-muted", "--graph-accent-text", "--graph-halo", "--graph-edge"):
        assert f"{token}:" in css
        assert f'color("' not in token
    assert "--graph-grid" in css_sources.decls('html[data-theme="light"]')
    # No colour literal in the canvas code: every colour is a --graph-* token.
    assert "graphColor(role) {\n    return kit.color(role);" in js
    ui = read("src/static/app_explorer.js")
    assert "openCard: openTableCardFromGraph" in ui
