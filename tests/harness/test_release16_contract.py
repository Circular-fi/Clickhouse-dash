from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_default_graph_depth_is_one_when_url_parameter_is_absent() -> None:
    ui = read("src/static/app_explorer.js")
    graph = read("src/static/app_explorer_graph.js")
    assert 'const hasDepth = params.has("depth");' in ui
    assert 'const parsedDepth = hasDepth ? Number(params.get("depth")) : Number.NaN;' in ui
    assert ': 1;' in ui[ui.index('const graphDepth'):ui.index('if (path === "/explorer")')]
    assert 'focusDepth: 1' in graph


def test_graph_click_does_not_restart_catalog_and_route_intent_is_one_shot() -> None:
    ui = read("src/static/app_explorer.js")
    assert 'if (model.section !== "tables") setSection("tables");' in ui
    assert 'selectTable(database, table, false, { graphOrigin: true });' in ui
    assert 'model.routeIntent = null;' in ui
    assert 'Route intent is a one-shot bootstrap instruction.' in ui
    assert ui.count('model.routeIntent = null;') >= 4


def test_graph_has_no_hover_popup_and_camera_controls_are_inline_after_depth() -> None:
    html = read("src/static/explorer.html")
    graph = read("src/static/app_explorer_graph.js")
    assert 'id="explorerGraphTooltip"' not in html
    assert 'explorerGraphTooltip' not in graph
    assert 'showTooltip(node' not in graph[graph.index('canvas.addEventListener("pointermove"'):graph.index('const endDrag')]
    type_pos = html.index('id="explorerGraphTypeSelect"')
    depth_pos = html.index('id="explorerGraphDepthControls"')
    camera_pos = html.index('class="explorerGraphCameraControls"')
    refresh_pos = html.index('id="explorerGraphRefreshButton"')
    assert type_pos < depth_pos < camera_pos < refresh_pos
    assert '>Storage<' in html
    assert 'Storage topology' not in html


def test_hidden_views_and_materialized_views_are_contracted_before_depth() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert 'function logicalProjection()' in graph
    assert 'const projection = logicalProjection();' in graph
    assert 'if (!model.includeNonStoring && isNonStoringNode(node))' in graph
    assert 'id: `collapsed:${source}:${target}:${kind}:${hidden.join(">")}`' in graph
    assert 'via hidden object' in graph
    assert 'resolveBufferRepresentative' in graph
    assert 'walkProjectedPath(representative, edge, [node.id]);' in graph
    assert 'logicalNeighborhoodIds' in graph


def test_storage_ttl_parser_builds_ordered_timeline_actions() -> None:
    cpp = read("src/explorer_graph.cpp")
    assert 'std::optional<std::string> parse_ttl_destination' in cpp
    assert "if (text[pos] != '\\'') return parse_identifier_token(text, pos);" in cpp
    assert 'parse_table_ttl_rules' in cpp
    assert 'add_action("RECOMPRESS", "recompress", "codec")' in cpp
    assert 'add_action("TO VOLUME", "move", "volume")' in cpp
    assert 'add_action("TO DISK", "move", "disk")' in cpp
    assert 'add_action("DELETE", "delete")' in cpp
    assert 'derive_ttl_timing' in cpp


def test_function_filter_cog_reuses_query_run_settings_menu_structure() -> None:
    html = read("src/static/explorer.html")
    assert 'id="explorerFunctionSettings" class="themeSelect runSettings explorerFunctionSettings"' in html
    assert 'id="explorerFunctionSettingsButton" class="runSettings__button' in html
    assert 'id="explorerFunctionSettingsMenu" class="themeSelect__menu runSettings__menu' in html
    assert 'class="runMenu__opt' in html


def test_terminal_single_query_failure_never_reopens_result_table() -> None:
    run = read("src/static/app_run.js")
    block = run[run.index('} else if (statusIsStopping(terminalStatus))'):run.index('if (runMode === "profiling"', run.index('} else if (statusIsStopping(terminalStatus))'))]
    assert 'dom.liveResultsWrap.hidden = true' in block
    catch_block = run[run.index('} catch (err) {', run.index('async function handleRunMode')):run.index('} finally {', run.index('async function handleRunMode'))]
    assert 'dom.liveResultsWrap.hidden = true' in catch_block


def test_compact_overview_does_not_repeat_engine_rows_or_bytes() -> None:
    ui = read("src/static/app_explorer.js")
    block = ui[ui.index('function renderOverview'):ui.index('function renderColumns')]
    assert '["Engine"' not in block
    assert '["Rows"' not in block
    assert '["Logical size"' not in block
    assert 'if (deps.length) renderDependencies(container, detail);' in block
    assert 'sectionTitle("Lineage")' not in block


def test_analysis_modal_has_large_desktop_inset() -> None:
    css = read("src/static/style.css")
    tail = css[css.rfind('/* Release 16: analysis') :]
    assert '.analysisModalBackdrop { padding: 96px 72px; }' in tail
    assert 'width: min(1460px, calc(100vw - 144px));' in tail
    assert 'height: calc(100vh - 192px);' in tail


def test_legacy_schema_rewrite_injects_default_browse_parameter() -> None:
    ui = read("src/static/app_explorer.js")
    block = ui[ui.index('if (route.workspace === "explorer" && route.legacySchema'):ui.index('model.routeIntent = route;')]
    assert 'if (!canonicalParams.has("view")) canonicalParams.set("view", route.viewMode === "graph" ? "graph" : "browse");' in block
