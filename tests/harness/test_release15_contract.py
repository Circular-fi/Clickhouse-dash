from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_dictionary_reports_allocated_size_without_pretending_it_is_compressed() -> None:
    catalog = read("src/explorer_catalog.cpp")
    header = read("src/explorer_catalog.hpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")
    assert "bytes_allocated" in catalog
    assert "resident_bytes" in header
    assert 'w.Key("resident_bytes")' in api
    assert "isDictionarySummary(summary)" in ui
    assert "summary.resident_bytes" in ui
    assert "summaryFootprintBytes" in ui


def test_overview_embeds_lineage_and_uses_compact_rows_without_duplicate_engine_metrics() -> None:
    ui = read("src/static/app_explorer.js")
    overview = ui[ui.index('function renderOverview'):ui.index('function renderColumns')]
    assert 'simpleRows(' not in overview
    assert '["Primary key"' not in overview
    assert '["Partition key"' not in overview
    assert '["TTL"' not in overview
    assert 'renderTableFootprint(container, detail);' in overview
    assert 'renderStorageComposition(container, detail);' in overview
    assert 'if (deps.length) renderDependencies(container, detail);' in overview
    assert 'sectionTitle("Lineage")' not in overview
    assert 'explorerKvGrid' not in ui
    available = ui[ui.index("function availableTabs"):ui.index("function visibleFunctions")]
    assert 'tabs.push("Lineage")' not in available


def test_storage_mode_rejects_non_storage_focus_but_keeps_disabled_context() -> None:
    graph = read("src/static/app_explorer_graph.js")
    explorer = read("src/static/app_explorer.js")
    assert "function canUseStorageForId" in graph
    assert 'model.detailMode === "physical" && !canUseStorageForId(id)' in graph
    assert 'node.storage_disabled === true' in graph
    assert 'function nodeIsStorageDisabled(node)' in graph
    assert 'function nodeIsClickable(node)' in graph
    clickable = graph[graph.index('function nodeIsClickable(node)'):graph.index('function updateCanvasPointerState')]
    assert '!nodeIsStorageDisabled(node)' in clickable
    assert 'graph?.canUseStorageForTable?.(database, table) === false' in explorer
    assert 'button.disabled = !!storageBlocked;' in explorer


def test_explorer_url_persists_view_graph_type_depth_and_subpage() -> None:
    ui = read("src/static/app_explorer.js")
    graph = read("src/static/app_explorer_graph.js")
    assert 'params.set("view", model.mode === "graph" ? "graph" : "browse")' in ui
    assert 'params.set("graph", route.mode === "physical" ? "storage" : "lineage")' in ui
    assert 'params.set("depth", String(route.depth ?? 1))' in ui
    assert 'const requestedTab = String(parts[2] || "overview")' in ui
    assert "function getRouteState()" in graph
    assert "function applyRouteState(route = {})" in graph


def test_table_visibility_cog_controls_system_and_non_storing_objects() -> None:
    html = read("src/static/explorer.html")
    ui = read("src/static/app_explorer.js")
    assert 'id="explorerTableSettingsButton"' in html
    assert 'id="explorerIncludeSystem"' in html
    assert 'id="explorerIncludeNonStoring"' in html
    assert 'chdash.explorer.includeSystem' in ui
    assert 'chdash.explorer.includeNonStoring' in ui
    assert 'if (!model.includeSystem' in ui
    assert 'if (!model.includeNonStoring && nonStoringSummary(table) && !storageBuffer)' in ui


def test_create_statement_has_no_internal_vertical_height_limit() -> None:
    css = read("src/static/style.css")
    tail = css[css.rfind("/* Release 15") :]
    assert ".explorerDdlWrap .explorerDdl" in tail
    assert "max-height: none;" in tail
    assert "overflow: visible;" in tail


def test_graph_camera_controls_are_separate_and_buffer_ttl_metadata_is_exposed() -> None:
    html = read("src/static/explorer.html")
    graph_cpp = read("src/explorer_graph.cpp")
    graph_js = read("src/static/app_explorer_graph.js")
    assert 'class="explorerGraphCameraControls"' in html
    assert 'id="explorerGraphZoomOutButton"' in html
    assert 'id="explorerGraphZoomInButton"' in html
    assert 'id="explorerGraphFitButton"' in html
    assert 'node.buffer_min_time = parse_u64(args[3]);' in graph_cpp
    assert 'node.buffer_max_rows = parse_u64(args[6]);' in graph_cpp
    assert 'function drawTtlSummary(' in graph_js
    assert 'function drawStorageTierNode(' in graph_js
    assert 'TTL while in ${volumeName}' in graph_js
    assert 'ttlActionSummary(event)' in graph_js
    assert 'node.kind === "buffer"' in graph_js


def test_formatter_multilines_ttl_and_aligns_settings_when_comma_separated() -> None:
    formatter = read("src/format_postprocess.cpp")
    assert "format_comma_clause_body" in formatter
    assert 'poses[i].second == "TTL"' in formatter
    assert 'format_comma_clause_body(body, true)' in formatter
    assert "align_multiline_settings" in formatter


def test_analysis_dialog_is_inset_blurred_and_backdrop_click_dismisses() -> None:
    css = read("src/static/style.css")
    analysis = read("src/static/app_analysis.js")
    tail = css[css.rfind("/* Release 15") :]
    assert "backdrop-filter: blur(7px);" in tail
    assert "padding: 96px 72px;" in tail
    assert "height: calc(100vh - 192px);" in tail
    assert 'event.target === dom.analysisModalBackdrop' in analysis


def test_log_family_storage_uses_data_paths_instead_of_parts() -> None:
    graph = read("src/explorer_graph.cpp")
    assert "arrayStringConcat(data_paths, char(31))" in graph
    assert 'table.engine == "TinyLog" || table.engine == "Log" || table.engine == "StripeLog"' in graph
    assert 'add_edge_unique(out, seen_edges, {{}, physical_parent, disk_id, "contains", "data path", false});' in graph


def test_legacy_schema_canonicalization_preserves_explorer_query_state() -> None:
    ui = read("src/static/app_explorer.js")
    assert 'const canonicalParams = new URLSearchParams(window.location.search || "");' in ui
    assert 'canonicalParams.set("view", route.viewMode === "graph" ? "graph" : "browse")' in ui
    graph = read("src/static/app_explorer_graph.js")
    assert "model.onStateChange?.();" in graph
