from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_deep_routes_and_all_api_calls_are_subpath_aware_and_non_json_shells_fail_closed() -> None:
    html = read("src/static/index.html")
    loader = read("src/static/app.js")
    api = read("src/static/app_api.js")
    server = read("src/server.cpp")

    assert "window.__CHDASH_BASE_PATH__" in html
    assert "window.__chdashUrl" in html
    assert 'window.__chdashUrl("static/style.css")' in html
    assert 'window.__chdashUrl("static/app.js")' in html
    assert 'const bootstrapBaseUrl = (() =>' in loader
    assert 'new URL(window.__chdashUrl("static/"), window.location.href).toString()' in loader
    assert "const getBaseUrl = () => bootstrapBaseUrl;" in loader
    assert "function resolveUrl(path)" in api
    assert "fetch(resolveUrl(url)" in api
    assert 'err.code = "invalid_api_response"' in api
    assert "Check the application/subpath routing" in api
    assert 'shell_req.path = "/query.html";' in server
    assert 'shell_req.path = "/explorer.html";' in server
    assert 'http_.Get(R"(/explorer/.*)", serve_explorer_shell);' in server


def test_editor_keeps_historical_sizing_but_uses_centered_bottom_resize_handle() -> None:
    html = read("src/static/index.html")
    css = read("src/static/style.css")
    ui = read("src/static/app_ui.js")

    assert 'class="editorResizeHandle"' in html
    assert 'aria-orientation="horizontal"' in html
    tail = css[css.rfind('/* 2026-09-06 resize follow-up:') :]
    assert '#queryWorkspace {' in tail and 'align-content: start;' in tail
    assert '.editorWrap {' in tail and 'resize: none;' in tail
    assert 'left: 50%;' in tail and 'transform: translateX(-50%);' in tail
    assert 'cursor: ns-resize;' in tail
    assert 'ResizeObserver' in ui
    assert 'root.classList.remove("chdash-has-initial-editor-height")' in ui
    assert 'root.style.removeProperty("--initialEditorHeight")' in ui
    resize = ui[ui.index('const handle = document.querySelector(".editorResizeHandle")'):]
    assert 'handle.addEventListener("pointerdown"' in resize
    assert 'handle.addEventListener("pointermove"' in resize
    assert 'Math.max(180' in resize
    assert 'storage.saveEditorHeight' in ui

def test_run_button_becomes_cancel_in_place_and_no_duplicate_cancel_control_exists() -> None:
    html = read("src/static/index.html")
    run = read("src/static/app_run.js")
    dom = read("src/static/app_dom.js")

    assert 'id="runButton"' in html
    assert 'id="cancelButton"' not in html
    assert "cancelButton:" not in dom
    assert 'dom.runButton.textContent = state.isRunning ? "Cancel" : "Run";' in run
    assert 'dom.runMenuButton.hidden = state.isRunning;' in run
    assert 'if (state.isRunning) void handleCancelOrClear();' in run


def test_current_analysis_ui_has_no_raw_or_deep_and_uses_honest_processor_duration_profile() -> None:
    html = read("src/static/index.html")
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
    assert 'ns.traceViewer.render(root' in ui
    assert 'traceViewer__row' in viewer
    assert 'start_time_us' in viewer and 'finish_time_us' in viewer

def test_function_search_is_name_only_and_server_description_catalog_is_cached() -> None:
    ui = read("src/static/app_explorer.js")
    api = read("src/api_explorer.cpp")
    header = read("src/server.hpp")
    config = read("config.example.hcl")

    visible = ui[ui.index("function visibleFunctions()") : ui.index("function functionKey", ui.index("function visibleFunctions()"))]
    assert "item.name" in visible
    assert "item.description" not in visible
    assert "name.startsWith(q)" in visible
    assert "model.functionsCatalog" in ui
    assert "if (!force && model.functionsCatalog)" in ui
    assert "cfg_.explorer.function_cache_ttl_ms" in api
    assert "function_cache_ttl_ms = 60 * 60 * 1000" in header
    assert "function_cache_ttl_ms   = 3600000" in config


def test_function_markdown_links_are_off_by_default_and_external_links_never_render() -> None:
    ui = read("src/static/app_explorer.js")
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
    css = read("src/static/style.css")

    assert 'id="explorerTablesSectionButton"' in html
    assert 'id="explorerFunctionsSectionButton"' in html
    assert 'id="explorerDatabasesSectionButton"' not in html
    assert 'id="explorerSearchInput"' in html
    assert 'id="explorerFunctionCategorySelect"' in html
    assert 'id="explorerRefreshButton"' in html
    assert 'id="explorerDatabaseSelect"' not in html
    assert "ACL filtered" not in html
    assert "Runner scoped" not in html
    assert '#explorerTableModeTabs' in css and 'border-left:' in css[css.rindex('#explorerTableModeTabs'):]

def test_explorer_uses_arial_for_ui_and_only_code_surfaces_keep_monospace() -> None:
    css = read("src/static/style.css")
    graph = read("src/static/app_explorer_graph.js")

    tail = css[css.rindex("/* Explorer typography is explicitly Arial") :]
    assert "font-family: Arial, Helvetica, sans-serif;" in tail
    assert ".explorerDdl" in tail and ".functionDoc__code" in tail
    assert "Arial, Helvetica, sans-serif" in graph
    assert "ui-monospace" not in graph


def test_table_header_owns_state_and_codec_empty_value_uses_observed_part_default() -> None:
    ui = read("src/static/app_explorer.js")

    header = ui[ui.index("function renderDetailHeader()") : ui.index("function renderTabs()")]
    assert 'detail.metric_scope || "local-replica"' in header
    assert "healthLabel(s).toLowerCase()" in header
    assert "active_parts" in header
    assert "partitions" in header
    assert 'dom.explorerHealthBadge.hidden = true' in header
    assert 'dom.explorerSummaryCards.hidden = true' in header
    assert 'detail.default_compression_codecs' in ui
    assert '`${observedDefaults[0]} (default)`' in ui


def test_operations_include_one_hour_totals_and_ddl_uses_shared_formatter_and_highlighter() -> None:
    header = read("src/explorer_catalog.hpp")
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")

    assert "rows_total_1h" in header and "bytes_total_1h" in header
    assert "toString(sum(written_rows)), toString(sum(written_bytes))" in catalog
    assert 'w.Key("rows_total_1h")' in api
    assert 'Client ingress · total · 1h' in ui
    assert 'Physical writes · total · 1h' in ui
    assert "api.formatSqls(hostId" in ui
    assert "detail.formatted_ddl" in ui
    assert "renderHighlightedCode(pre, ddl)" in ui


def test_lineage_hides_row_pseudo_objects_and_storage_is_a_separate_physical_projection() -> None:
    ui = read("src/static/app_explorer.js")
    graph = read("src/static/app_explorer_graph.js")
    graph_backend = read("src/explorer_graph.cpp")

    assert '!/^_?row$/i.test(String(d.table || ""))' in ui
    lineage = ui[ui.index("function renderLineage") : ui.index("function renderStorageCombined")]
    assert "renderTopology" not in lineage
    storage = ui[ui.index("function renderStorageCombined") : ui.index("function renderOperations")]
    assert 'sectionTitle("Ingestion activity")' in storage
    assert 'sectionTitle("Merge activity")' in storage
    assert 'sectionTitle("Topology")' in storage
    assert 'sectionTitle("Replication")' in storage
    assert "renderTopology(container, detail)" in storage
    assert "renderReplication(container, detail)" in storage
    assert 'if (model.detailMode === "physical")' in graph
    assert 'target.layer !== "physical"' in graph
    assert "model.focusDepth -= 1" in graph
    assert "replica.parent_id = parent" in graph_backend
    assert 'std::unordered_set<std::string> disk_nodes_created;' in graph_backend
    assert 'const std::string disk_id = "physical:database:" + database + ":disk:" + disk;' in graph_backend
    assert 'add_edge_unique(out, seen_edges, {{}, physical_parent, disk_id, "contains", "disk", false});' in graph_backend


def test_database_inventory_is_integrated_into_table_tree_with_totals_and_navigable_tables() -> None:
    header = read("src/explorer_catalog.hpp")
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")
    html = read("src/static/explorer.html")

    assert "struct ExplorerDatabaseSummary" in header
    assert "struct ExplorerDatabaseDisk" in header
    assert "std::vector<ExplorerDatabaseSummary> database_summaries" in header
    assert "toString(hostName())" in catalog
    assert "FROM system.disks" in catalog
    assert "sum(bytes_on_disk)" in catalog
    assert 'w.Key("database_summaries")' in api
    assert 'id="explorerDatabasesSectionButton"' not in html
    assert 'id="explorerDatabaseCards"' not in html
    assert "function renderDatabaseDetail(database)" in ui
    assert "function selectDatabase(database" in ui
    assert 'model.selectedDatabase = name;' in ui
    assert 'databaseInfo ? fmtInt(databaseInfo.tables) : fmtInt(items.length)' in ui
    assert 'tables · ${databaseInfo ? fmtBytes(databaseInfo.bytes)' in ui
    assert "disk.host_name" in ui
    assert "disk.free_space" in ui
    assert 'button.addEventListener("click", () => void selectTable(table.database, table.name));' in ui

def test_table_switch_requires_requested_identity_instead_of_rendering_undefined() -> None:
    ui = read("src/static/app_explorer.js")
    start = ui.index("async function selectTable")
    end = ui.index("function renderListView", start) if "function renderListView" in ui[start:] else len(ui)
    block = ui[start:end]
    assert "detail.summary.database" in block
    assert "detail.summary.name" in block
    assert "requested database/table" in block or "Invalid Explorer detail response" in block

def test_host_bootstrap_uses_api_resolver_instead_of_falling_offline_from_reference_error() -> None:
    ui = read("src/static/app_ui.js")
    assert 'const { dom, state, storage, util, api } = ns;' in ui
    assert 'fetch(api.resolveUrl("api/version")' in ui
    assert 'fetch(api.resolveUrl("api/hosts")' in ui


def test_preview_ignores_empty_callback_blocks_before_validating_selected_column_width() -> None:
    catalog = read("src/explorer_catalog.cpp")
    start = catalog.index("bool load_explorer_preview(")
    block = catalog[start:]
    zero = block.index("if (block.GetRowCount() == 0) return;")
    width = block.index("if (block.GetColumnCount() != columns.size())")
    assert zero < width
    assert 'columns; expected ' in block


def test_column_metadata_uses_technical_account_and_reports_compact_storage_without_fake_per_column_bytes() -> None:
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")
    start = catalog.index("bool load_explorer_table_detail(")
    detail = catalog[start:catalog.index("bool load_explorer_functions", start)]
    assert 'bool columns_loaded = load_columns(system,' in detail
    assert 'columns_loaded = load_columns(runner,' in detail
    assert 'if (!allowed.allows_column(database, table, name)) continue;' in detail
    assert "countIf(part_type = 'Compact')" in detail
    assert 'FROM system.parts WHERE active' in detail
    assert 'FROM system.parts_columns WHERE active' in detail
    assert "part_type = 'Wide'" in detail
    assert 'column.compressed_bytes.reset();' in detail
    assert 'column_sizes_compact_shared' in detail
    assert 'column_sizes_mixed_shared' in detail
    assert 'w.Key("column_storage")' in api
    assert 'compact_compressed_bytes' in api and 'wide_compressed_bytes' in api
    render = ui[ui.index("function renderColumns("):ui.index("function renderStorage", ui.index("function renderColumns("))]
    composition = ui[ui.index("function storageComposition("):ui.index("function renderOverview", ui.index("function storageComposition("))]
    assert 'const compactParts = Number(storage.compact_parts || 0);' in composition
    assert 'const wideParts = Number(storage.wide_parts || 0);' in composition
    assert '["Wide", wideBytes, "wide"]' in composition
    assert '["Compact", compactBytes, "compact"]' in composition
    assert 'ns.results?.createStaticResultTable?.({' in ui
    assert 'detail.default_compression_codecs' in render
    assert '`${observedDefaults[0]} (default)`' in render
    assert 'ctx.value == null ? "-" : fmtStorageBytes(ctx.value)' in ui
    assert 'unknownText: "-"' in ui
    assert 'percentValue(compressed, tableFootprint)' in render
    assert 'Compact parts share one physical data stream' in render
    assert 'Wide ratio' not in render and 'Wide weight' not in render


def test_theme_dropdown_is_vertical_and_hides_current_choice() -> None:
    css = read("src/static/style.css")
    tail = css[css.rindex('.themeSelect__menu--icons {'):]
    assert 'grid-template-columns: 34px;' in tail
    assert '.themeSelect--icons.themeSelect--open .themeSelect__option[aria-selected="true"]' in tail
    assert 'display: none !important;' in tail


def test_graph_controls_live_in_viewport_and_depth_can_increase_or_decrease() -> None:
    html = read("src/static/explorer.html")
    graph = read("src/static/app_explorer_graph.js")
    css = read("src/static/style.css")
    assert 'class="explorerGraphViewportControls"' in html
    assert '>Depth:<' in html
    assert 'id="explorerGraphContractButton"' in html
    assert 'id="explorerGraphExpandButton"' in html
    assert 'id="explorerGraphFitButton"' in html
    assert 'id="explorerGraphClearFocusButton"' not in html
    assert 'model.focusDepth -= 1' in graph
    assert 'model.focusDepth += 1' in graph
    assert '.explorerGraphViewportControls' in css


def test_acl_discovery_falls_back_to_zero_row_column_probe_without_widening_permissions() -> None:
    source = read("src/allowed_objects.cpp")
    assert 'SELECT ignore(' in source
    assert 'LIMIT 0' in source
    assert 'is_access_denied_message' in source
    assert 'granted = zero_row_column_probe' in source
    assert 'result.all_columns = true' in source
    assert 'Fall through to exact column discovery' in source


def test_preview_finalizes_aggregate_function_states_only_inside_bounded_limit() -> None:
    source = read("src/explorer_catalog.cpp")
    block = source[source.index("bool load_explorer_preview("):]
    assert 'declared_type.rfind("AggregateFunction(", 0) == 0' in block
    assert 'toString(finalizeAggregation(' in block
    assert 'write_cell_json(cell_writer, block[i], row);' in block
    assert 'LIMIT " + std::to_string(limit)' in block
    assert 'limit = std::max<size_t>(1, std::min<size_t>(limit, 500));' in block


def test_graph_keeps_browser_visible_has_inline_topology_controls_and_no_reset_focus() -> None:
    html = read("src/static/explorer.html")
    ui = read("src/static/app_explorer.js")
    graph = read("src/static/app_explorer_graph.js")
    assert html.index('id="explorerTableList"') < html.index('id="explorerGraphPane"')
    assert 'id="explorerGraphLogicalButton"' in html
    assert 'id="explorerGraphPhysicalButton"' in html
    assert 'id="explorerGraphRefreshButton"' in html
    assert 'explorerGraphClearFocusButton' not in html
    assert 'function resetFocus()' not in graph
    set_mode = ui[ui.index("function setMode("):ui.index("function setWorkspace", ui.index("function setMode("))]
    assert 'dom.explorerListView.hidden = !tables;' in set_mode
    assert 'dom.explorerDetailPane.hidden = !tables || graphMode;' in set_mode
    assert 'model.openTable(node.database, node.name)' in graph
    assert 'setFocus(node.id);' in graph


def test_graph_depth_preserves_focus_and_disables_plus_when_no_new_nodes() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert 'function recomputePreservingFocus()' in graph
    assert 'stabilizeLayoutPositions' in graph
    recompute = graph[graph.index('function recomputePreservingFocus()'):graph.index('function setFocus(')]
    assert 'model.offsetX' not in recompute and 'model.offsetY' not in recompute
    assert 'next.size > current.size' in graph
    assert 'next.size <= current.size' in graph
    assert 'fitToScreen();' not in graph[graph.index("function contractNeighborhood"):graph.index("function defaultFocusId")]


def test_graph_uses_full_object_names_hides_view_storage_metrics_and_enriches_disks() -> None:
    graph = read("src/static/app_explorer_graph.js")
    backend = read("src/explorer_graph.cpp")
    api = read("src/api_explorer.cpp")
    assert 'materialized_view: "Materialized View"' in graph
    assert 'mergetree: "Merge Tree"' in graph
    assert 'materialized_view: "MV"' not in graph
    assert 'const viewLike = node.kind === "view"' in graph
    assert 'disk_free_space' in graph and 'disk_total_space' in graph
    assert 'disk_path' in backend
    assert 'disk_node.disk_free_space = info.free_space' in backend
    assert 'w.Key("disk_free_space")' in api


def test_view_like_details_are_single_overview_and_lineage_tab_is_conditional() -> None:
    ui = read("src/static/app_explorer.js")
    assert 'if (isViewLikeSummary(detail?.summary)) return ["Overview"];' in ui
    assert 'if (visibleDependencies(detail).length) tabs.push("Lineage");' not in ui
    assert 'container.appendChild(sectionTitle("CREATE statement"));' not in ui
    overview = ui[ui.index("function renderOverview"):ui.index("function isImplementationSubcolumn")]
    assert 'if (deps.length) renderDependencies(container, detail);' in overview
    assert 'sectionTitle("Lineage")' not in overview


def test_explorer_tools_live_in_sidebar_and_database_nodes_show_total_size() -> None:
    html = read("src/static/explorer.html")
    ui = read("src/static/app_explorer.js")
    assert 'class="explorerSidebarToolbar"' in html
    assert 'id="explorerFunctionSearchInput"' in html
    assert 'id="explorerFunctionCategorySelect"' in html
    assert 'id="explorerFunctionRefreshButton"' in html
    assert '${databaseInfo ? fmtBytes(databaseInfo.bytes) : "—"}' in ui
    assert 'const metaBits = [humanEngine(table.engine)];' in ui
    assert 'summaryRowsLabel(table, { compact: true })' in ui
    assert 'const bytes = summaryFootprintBytes(table);' in ui
    assert 'if (bytes != null) metaBits.push(isResidentMemorySummary(table) ? `${fmtBytes(bytes)} RAM` : fmtBytes(bytes));' in ui
