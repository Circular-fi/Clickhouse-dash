from pathlib import Path
import css_sources
import modules
from explorer_sources import read_api, read_catalog, read_graph, read_unit

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_deep_routes_and_all_api_calls_are_subpath_aware_and_non_json_shells_fail_closed() -> None:
    html = read("src/static/query.html")
    loader = read("src/static/app_loader.js")
    api = read("src/static/app_api.js")
    server = read("src/server.cpp")

    assert "window.__CHDASH_BASE_PATH__" in html
    assert "window.__chdashUrl" in html
    assert 'window.__chdashUrl("static/style.query.css")' in html
    # The shell starts the page's entry module at the address under its mount path; the modules import each other by
    # relative address, so they follow the entry wherever it is mounted (a reverse-proxy prefix included).
    assert 'return window.__chdashUrl ? window.__chdashUrl("static/" + file) : "/static/" + file;' in html
    assert "entry.src = url(page.entry);" in html
    assets = read("src/static/app_assets.js")
    assert 'const base = new URL("./", import.meta.url);' in assets
    assert "const out = new URL(name, base);" in assets and "return out.toString();" in assets
    assert "function resolveUrl(path)" in api
    assert "response = await fetch(resolveUrl(path), {" in api
    assert 'err.code = "invalid_api_response"' in api
    assert "Check the application/subpath routing" in api
    assert 'shell_req.path = "/query.html";' in server
    assert 'shell_req.path = "/explorer.html";' in server
    assert 'http_.Get(R"(/explorer/catalog(/.*)?)", serve_explorer_shell);' in server


def test_editor_keeps_historical_sizing_but_uses_centered_bottom_resize_handle() -> None:
    html = read("src/static/query.html")
    css = css_sources.text()
    ui = read("src/static/app_header.js") + read("src/static/app_query_ui.js")

    assert 'class="editorResizeHandle"' in html
    assert 'aria-orientation="horizontal"' in html
    # The workspace's auto rows never stretch (css/20-features/shell.css).
    assert css_sources.decls('.layout')['align-content'] == 'start'
    assert css_sources.decls('.editorWrap')['resize'] == 'none'
    handle = css_sources.decls('.editorResizeHandle')
    assert handle['left'] == '50%' and handle['transform'] == 'translateX(-50%)'
    assert handle['cursor'] == 'ns-resize'
    assert 'ResizeObserver' in ui
    assert 'root.classList.remove("chdash-has-initial-editor-height")' in ui
    assert 'root.style.removeProperty("--initialEditorHeight")' in ui
    resize = ui[ui.index('const handle = $(".editorResizeHandle")'):]
    assert 'handle.addEventListener("pointerdown"' in resize
    assert 'handle.addEventListener("pointermove"' in resize
    assert 'Math.max(180' in resize
    assert 'storage.saveEditorHeight' in ui

def test_run_button_becomes_cancel_in_place_and_no_duplicate_cancel_control_exists() -> None:
    html = read("src/static/query.html")
    run = read("src/static/app_run.js")
    dom = read("src/static/app_dom.js")

    assert 'id="runButton"' in html
    assert 'id="cancelButton"' not in html
    assert "cancelButton:" not in dom
    assert 'const runLabel = state.isRunning ? "Cancel" : "Run";' in run and 'if (dom.runButton.textContent !== runLabel) dom.runButton.textContent = runLabel;' in run
    assert 'dom.runMenuButton.hidden = state.isRunning;' in run
    assert 'if (state.isRunning) void handleCancelOrClear();' in run


def test_current_analysis_ui_has_no_raw_or_deep_and_uses_honest_processor_duration_profile() -> None:
    html = read("src/static/query.html")
    ui = read("src/static/app_analysis.js")
    dom = read("src/static/app_dom.js")
    api = read("src/static/app_api.js")

    assert 'data-analysis-tab="raw"' not in html
    assert 'data-analysis-tab="deep"' not in html
    assert 'id="deepAnalyzeButton"' not in html
    assert "deepAnalyzeButton" not in dom
    assert "deepAnalyzeQuery" not in api
    viewer = read("src/static/app_trace_viewer.js")
    assert 'data-analysis-tab="overview"' not in html
    assert 'traceViewer.render(root' in ui
    assert 'traceViewer__row' in viewer
    assert 'start_time_us' in viewer and 'finish_time_us' in viewer

def test_function_search_is_name_only_and_server_description_catalog_is_cached() -> None:
    ui = (modules.read_explorer() + modules.read_explorer_detail())
    api = read_api()
    header = read("src/server.hpp")
    config = read("config.example.hcl")

    visible = ui[ui.index("function visibleFunctions()") : ui.index("function selectFunction", ui.index("function visibleFunctions()"))]
    assert "item.name" in visible
    assert "item.description" not in visible
    assert "name.startsWith(q)" in visible
    assert "model.functionsCatalog" in ui
    assert "if (!force && model.functionsCatalog)" in ui
    assert "stores_.functions.get(" in api
    assert "std::chrono::milliseconds(std::max(1000, cfg_.explorer.function_cache_ttl_ms))" in header
    assert "function_cache_ttl_ms = 60 * 60 * 1000" in header
    assert "function_cache_ttl_ms   = 3600000" in config


def test_function_markdown_links_are_off_by_default_and_external_links_never_render() -> None:
    ui = (modules.read_explorer() + modules.read_explorer_detail())
    header = read("src/server.hpp")
    config = read("config.example.hcl")

    assert "bool function_markdown_links = false;" in header
    assert "function_markdown_links = false" in config
    assert "markdown_links_enabled !== true" in ui
    assert 'value.startsWith("/") && !value.startsWith("//")' in ui
    assert 'value.startsWith("./")' in ui
    assert "return null;" in ui[ui.index("function safeDocHref"):ui.index("function renderHighlightedCode")]


def test_explorer_toolbar_has_tables_functions_search_filter_reload_and_no_standalone_database_tab() -> None:
    html = read("src/static/explorer.html")
    css = css_sources.text()

    assert 'id="explorerCatalogTab"' in html
    assert 'id="explorerFunctionsTab"' in html
    assert 'id="explorerDatabasesSectionButton"' not in html
    assert 'id="explorerSearchInput"' in html
    assert 'id="explorerFunctionCategorySelect"' in read("src/static/functions.html")
    assert 'id="explorerRefreshButton"' in html
    assert 'id="explorerDatabaseSelect"' not in html
    assert "ACL filtered" not in html
    assert "Runner scoped" not in html
    assert '.contentTabs--nav {' in css and '.explorerTreeFilters {' in css

def test_explorer_uses_the_sans_token_for_ui_and_only_code_surfaces_keep_monospace() -> None:
    css = css_sources.text()
    graph = (modules.read_explorer_graph() + read("src/static/app_graph_kit.js"))

    assert css_sources.decls(".explorerWorkspace button")["font-family"] == "var(--font-sans)"
    assert css_sources.decls(".functionDoc__code")["font"].endswith("var(--font-mono)")
    assert "const FONT = '\"IBM Plex Sans\", " in graph
    assert "ui-monospace" not in graph


def test_table_header_owns_state_and_codec_empty_value_uses_observed_part_default() -> None:
    ui = modules.read_explorer_detail()
    header = modules.read_card_module("header")
    assert 'detail.metric_scope || "local-replica"' in header
    assert "healthLabel(s)" in header
    assert "active_parts" in header
    assert "partitions" in header
    assert 'dom.explorerHealthBadge.hidden = true' in header
    assert 'host.hidden = true;' in header
    assert 'detail.default_compression_codecs' in ui
    assert '? [observedDefaults[0], "default"]' in ui


def test_operations_include_one_hour_totals_and_ddl_uses_shared_formatter_and_highlighter() -> None:
    header = read("src/explorer_catalog.hpp")
    catalog = read_catalog()
    api = read_api()
    ui = (modules.read_explorer() + modules.read_explorer_detail())

    assert "rows_total_1h" in header and "bytes_total_1h" in header
    assert "toString(sum(written_rows)), toString(sum(written_bytes))" in catalog
    assert 'w.Key("rows_total_1h")' in api
    assert '`1 h client total ${format.count(client.rows_total_1h)} rows' in ui
    assert '`1 h persisted total ${format.count(physical.rows_total_1h)} rows' in ui
    assert "api.formatSqls(hostId" in ui
    assert "detail.formatted_ddl" in ui
    assert "sqlBlock({ sql: ddl, gutter: true, copy: true" in ui


def test_lineage_hides_row_pseudo_objects_and_storage_is_a_separate_physical_projection() -> None:
    ui = modules.read_explorer_detail()
    graph = (modules.read_explorer_graph() + read("src/static/app_graph_kit.js"))
    graph_backend = read_graph()

    assert '!/^_?row$/i.test(String(d.table || ""))' in ui
    lineage = modules.function_text(ui, "renderLineageTab")
    assert "renderCluster" not in lineage
    operations = modules.read_card_module("operations")
    assert "replication: renderReplication," in operations
    assert "cluster: renderCluster," in operations
    assert "ingestion: renderIngestion," in operations
    assert "merges: renderMerges," in operations
    assert 'if (model.detailMode === "physical")' in graph
    assert 'target.layer !== "physical"' in graph
    assert "model.focusDepth -= 1" in graph
    assert "replica.parent_id = parent" in graph_backend
    assert 'std::unordered_set<std::string> disk_nodes_created;' in graph_backend
    assert 'const std::string disk_id = "physical:database:" + database + ":disk:" + disk;' in graph_backend
    assert 'add_edge_unique(out, seen_edges, {{}, physical_parent, disk_id, "contains", "disk", false});' in graph_backend


def test_database_inventory_stays_navigation_only_and_table_details_are_lazy() -> None:
    api = read_api()
    ui = (modules.read_explorer() + modules.read_explorer_detail())
    html = read("src/static/explorer.html")

    service = read_unit("explorer_service.cpp")
    catalog_handler = service[service.index("ExplorerService::catalog("):service.index("ExplorerService::storage(")]
    json = read_unit("explorer_json.cpp")
    catalog_writer = json[json.index("std::string catalog_json("):json.index("std::string storage_json(")]
    assert "load_explorer_catalog_index" in catalog_handler
    assert 'w.Key("database_summaries")' in catalog_writer
    assert 'w.Key("engine_full")' not in catalog_writer
    assert 'w.Key("database")' in catalog_writer and 'w.Key("name")' in catalog_writer and 'w.Key("engine")' in catalog_writer
    assert 'id="explorerDatabasesSectionButton"' not in html
    assert 'id="explorerDatabaseCards"' not in html
    assert "function renderDatabaseDetail(database)" in ui
    assert "function selectDatabase(database" in ui
    assert 'model.selectedDatabase = name;' in ui
    assert 'format.countLabel(tables.length, "object")' in ui
    assert 'button.addEventListener("click", () => void actions.selectTable(table.database, table.name));' in ui

def test_table_switch_requires_requested_identity_instead_of_rendering_undefined() -> None:
    ui = (modules.read_explorer() + modules.read_explorer_detail())
    start = ui.index("async function selectTable")
    end = ui.index("function renderListView", start) if "function renderListView" in ui[start:] else len(ui)
    block = ui[start:end]
    assert "detail.summary.database" in block
    assert "detail.summary.name" in block
    assert "requested database/table" in block or "Invalid Explorer detail response" in block

def test_host_bootstrap_uses_api_resolver_instead_of_falling_offline_from_reference_error() -> None:
    ui = read("src/static/app_header.js") + read("src/static/app_query_ui.js")
    assert 'import { api } from "./app_api.js";' in ui and 'import { state, storage } from "./app_state.js";' in ui
    # /api/version and /api/hosts go through the one request path of app_api.js.
    assert "data = await api.getVersion();" in ui
    assert "useSnapshot(await api.getHosts());" in ui
    api = read("src/static/app_api.js")
    assert 'const getVersion = ({ signal } = {}) => getJson("api/version", { signal });' in api
    assert 'const getHosts = ({ signal } = {}) => getJson("api/hosts", { signal });' in api
    assert "fetch(" not in ui


def test_preview_ignores_empty_callback_blocks_before_validating_selected_column_width() -> None:
    catalog = read_catalog()
    start = catalog.index("bool load_explorer_preview(")
    block = catalog[start:]
    zero = block.index("if (block.GetRowCount() == 0) return;")
    width = block.index("if (block.GetColumnCount() != columns.size())")
    assert zero < width
    assert 'columns; expected ' in block


def test_column_metadata_uses_technical_account_and_reports_compact_storage_without_fake_per_column_bytes() -> None:
    api = read_api()
    ui = modules.read_explorer_detail()
    # The reader of the table detail (explorer_detail.cpp) and its statements (explorer_sql.cpp).
    detail = read_unit("explorer_detail.cpp")
    statements = read_unit("explorer_sql.cpp")
    assert 'bool columns_loaded = load_columns(system_,' in detail
    assert 'columns_loaded = load_columns(runner_,' in detail
    assert 'if (!allowed_.allows_column(database_, table_, name)) continue;' in detail
    assert "countIf(part_type = 'Compact')" in statements
    assert 'FROM system.parts WHERE active' in statements
    assert 'FROM system.parts_columns WHERE active' in statements
    assert "part_type = 'Wide'" in statements
    assert 'column.compressed_bytes.reset();' in detail
    assert 'column_sizes_compact_shared' in detail
    assert 'column_sizes_mixed_shared' in detail
    assert 'w.Key("column_storage")' in api
    assert 'compact_compressed_bytes' in api and 'wide_compressed_bytes' in api
    render = modules.function_text(ui, "columnRows") + modules.function_text(ui, "renderColumnsTab")
    composition = ui[ui.index("function storageComposition("):ui.index("function buildStorageComposition", ui.index("function storageComposition("))]
    assert 'const compactParts = Number(storage.compact_parts || 0);' in composition
    assert 'const wideParts = Number(storage.wide_parts || 0);' in composition
    assert '["Wide", wideBytes, "wide"]' in composition
    assert '["Compact", compactBytes, "compact"]' in composition
    assert 'results?.createStaticResultTable?.({' in ui
    assert 'detail.default_compression_codecs' in render
    assert '? [observedDefaults[0], "default"]' in render
    assert 'item.compressed == null ? DASH : format.bytes(item.compressed)' in render
    assert 'item.percent == null ? DASH : percentText(item.percent)' in render
    assert 'percentValue(compressed, tableFootprint)' in render
    assert 'Compact parts share one physical data stream' not in render
    assert 'Wide ratio' not in render and 'Wide weight' not in render


def test_theme_dropdown_is_vertical_and_keeps_the_current_choice() -> None:
    css = css_sources.text()
    assert css_sources.decls('.themeSelect__menu--icons')['grid-template-columns'] == '34px'
    # The current choice stays in its list (UI-004): marked as selected, never taken out of it.
    current = css_sources.decls('.themeSelect__option--icon[aria-selected="true"]')
    assert current['background'] == 'var(--selected-bg)'
    assert 'themeSelect--open .themeSelect__option[aria-selected="true"]' not in css


def test_graph_controls_live_in_viewport_and_depth_can_increase_or_decrease() -> None:
    html = read("src/static/explorer.html")
    graph = (modules.read_explorer_graph() + read("src/static/app_graph_kit.js"))
    css = css_sources.text()
    assert 'class="explorerGraphViewportControls graphKitBar"' in html
    assert '<span class="explorerGraphDepthControls__name">Depth</span>' in html
    assert 'id="explorerGraphContractButton"' in html
    assert 'id="explorerGraphExpandButton"' in html
    assert 'id="explorerGraphFitButton"' in html
    assert 'id="explorerGraphClearFocusButton"' not in html
    assert 'model.focusDepth -= 1' in graph
    assert 'model.focusDepth = Math.min(8, model.focusDepth + 1)' in graph
    assert '.graphKitBar {' in css


def test_acl_discovery_falls_back_to_zero_row_column_probe_without_widening_permissions() -> None:
    source = read("src/allowed_objects.cpp")
    assert 'SELECT ignore(' in source
    assert 'LIMIT 0' in source
    # Only ACCESS_DENIED (AclDenied, code 497) means "not readable": never a message match.
    assert 'is_access_denied_message' not in source
    assert '} catch (const AclDenied&) {\n    return false;\n  }' in source
    assert 'const bool granted = checked ? *checked : zero_row_column_probe(source, database, table, columns, begin, end);' in source
    assert 'result.all_columns = true' in source
    # A CHECK GRANT that cannot be read falls back to the probes; the connection is opened again first.
    assert 'client_->ResetConnection();' in source and 'check_grant_unreadable_ = true;' in source


def test_preview_finalizes_aggregate_function_states_only_inside_bounded_limit() -> None:
    source = read_catalog()
    block = source[source.index("bool load_explorer_preview("):]
    assert 'declared_type.rfind("AggregateFunction(", 0) == 0' in block
    assert 'toString(finalizeAggregation(' in block
    assert 'write_cell_json(cell_writer, block[i], row);' in block
    assert 'LIMIT " + std::to_string(limit)' in block
    assert 'limit = std::max<size_t>(1, std::min<size_t>(limit, 500));' in block


def test_graph_keeps_browser_visible_has_inline_topology_controls_and_no_reset_focus() -> None:
    html = read("src/static/explorer.html")
    ui = (modules.read_explorer() + modules.read_explorer_detail())
    graph = (modules.read_explorer_graph() + read("src/static/app_graph_kit.js"))
    assert html.index('id="explorerTableList"') < html.index('id="explorerGraphPane"')
    assert 'id="explorerGraphLogicalButton"' in html
    assert 'id="explorerGraphPhysicalButton"' in html
    assert 'id="explorerGraphRefreshButton"' in html
    assert 'explorerGraphClearFocusButton' not in html
    assert 'function resetFocus()' not in graph
    set_mode = ui[ui.index("function setMode("):ui.index("function setWorkspace", ui.index("function setMode("))]
    assert 'dom.explorerListView.hidden = !tables;' in set_mode
    assert 'dom.explorerDetailPane.hidden = !browse;' in set_mode
    assert 'model.openTable(node.database, node.name)' in graph
    assert 'setFocus(node.id);' in graph


def test_graph_depth_preserves_focus_and_disables_plus_when_no_new_nodes() -> None:
    graph = (modules.read_explorer_graph() + read("src/static/app_graph_kit.js"))
    assert 'function recomputePreservingFocus()' in graph
    assert 'stabilizeLayoutPositions' in graph
    recompute = modules.function_text(graph, "recomputePreservingFocus")
    assert 'model.offsetX' not in recompute and 'model.offsetY' not in recompute
    assert 'model.graph?.scope_has_more === true' in graph
    assert 'Number(model.graph?.scope_depth) === model.focusDepth' in graph
    assert 'fitToScreen();' not in modules.function_text(graph, "contractNeighborhood")


def test_graph_uses_full_object_names_hides_view_storage_metrics_and_enriches_disks() -> None:
    graph = (modules.read_explorer_graph() + read("src/static/app_graph_kit.js"))
    backend = read_graph()
    api = read_api()
    assert 'materialized_view: "MaterializedView"' in graph
    assert 'mergetree: "MergeTree"' in graph
    assert 'materialized_view: "MV"' not in graph
    assert 'const viewLike = node.kind === "view"' in graph
    assert 'disk_free_space' in graph and 'disk_total_space' in graph
    assert 'disk_path' in backend
    assert 'disk_node.disk_free_space = info.free_space' in backend
    assert 'w.Key("disk_free_space")' in api


def test_view_like_details_have_no_preview_and_lineage_tab_is_conditional() -> None:
    ui = modules.read_explorer_detail()
    tabs = modules.function_text(ui, "availableTabs")
    assert 'if (!viewLike && !empty) tabs.push("Preview");' in tabs
    assert 'if (loading || visibleDependencies(detail).length) tabs.push("Lineage");' in tabs
    assert 'container.appendChild(sectionTitle("CREATE statement"));' not in ui
    assert 'sectionTitle("Lineage")' not in ui


def test_explorer_tools_live_in_sidebar_and_table_tree_is_minimal() -> None:
    html = read("src/static/explorer.html")
    ui = (modules.read_explorer() + modules.read_explorer_detail())
    assert 'class="uiSide__head explorerSideHead"' in html
    functions = read("src/static/functions.html")
    assert 'id="explorerFunctionSearchInput"' in functions
    assert 'id="explorerFunctionCategorySelect"' in functions
    assert 'id="explorerFunctionRefreshButton"' in functions
    tree = ui[ui.index("function renderTableList"):ui.index("function catalogContainsTable")]
    # Bytes only in the figure column; the object count is in the title.
    assert 'h("span", { class: "explorerTreeDatabase__count" }, countText)' in tree
    assert 'const countText = loading ? "Loading\\u2026" : "";' in tree
    assert 'format.bytes(bytes)' in tree
    assert 'treeObjectTitle(table)' in tree and 'treeBadge(table)' in tree
    helpers = ui[ui.index("function treeBadge"):ui.index("function renderTableList")]
    assert 'humanEngine(table.engine)' in helpers
    assert 'summaryRowsLabel(table' in helpers
    assert 'summaryFootprintBytes(table)' in helpers
    assert 'explorerTreeHealthDot' not in tree
