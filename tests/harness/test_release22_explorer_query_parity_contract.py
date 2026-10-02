from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_card_uses_ram_labels_without_resident_runtime_cards_or_extra_section_titles() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    assert '`${format.bytes(rawBytes)}${memoryResident ? " RAM" : " logical"}`' in graph
    ui = read("src/static/app_explorer_detail.js")
    assert "renderResidentRuntime" not in ui
    assert '"Resident rows"' not in ui
    assert '"Resident memory"' not in ui
    # One size label: RAM for resident engines, disk otherwise; 0 B is hidden.
    assert '`${format.bytes(footprint)} ${resident ? "RAM" : "on disk"}`' in ui
    assert 'if (!viewLike && footprint != null && footprint > 0) {' in ui
    assert 'sectionTitle("Storage breakdown")' not in ui
    assert 'sectionTitle("CREATE statement")' not in ui


def test_lineage_chips_keep_the_plain_qualified_name_as_tooltip() -> None:
    ui = read("src/static/app_explorer_detail.js")
    chip = ui[ui.index("function dependencyChip"):ui.index("// ---- tabs")]
    assert 'const qualified = `${dep.database || DASH}.${dep.table || DASH}`;' in chip
    assert 'button.title = [qualified,' in chip
    assert 'const qualified = `<${dep.database' not in chip


def test_data_preview_has_compact_finalize_marker_and_open_in_query_formats_equivalent_sql() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    data = ui[ui.index("function aggregatePreviewColumn"):ui.index("function renderDdl")]
    assert "Preview executes SELECT" not in data
    assert "Finalized for preview" not in data
    assert 'finalizeAggregation(${quoted}) AS ${quoted}' in data
    assert 'api.formatSqls(state.selectedHostId, [String(sql || "")])' in data
    assert 'await openFormattedSqlInQuery(buildPreviewSelectSql(detail));' in data
    assert 'finalizeAggregation() used so Explorer can display the value of a single row' in data
    assert 'node("div", "explorerFinalizeInfo__tooltip", text)' in data


def test_browse_graph_switch_uses_icon_theme_selector_grammar() -> None:
    html = read("src/static/explorer.html")
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    css = read("src/static/style.css")
    # The Browse/Graph icon selector became segmented tabs: the top views and
    # the Catalog's Browse / Graph / Storage mode bar share the pill look.
    assert 'id="explorerTableModeTabs"' not in html
    assert 'id="explorerViewTabs" class="viewTabs" role="tablist"' in html
    for view in ['catalog', 'functions', 'operations']:
        assert f'data-view="{view}"' in html
    # The mode bar is a nav row like #obsNav: full-size tabs, no compact pill.
    assert 'id="explorerModeTabs" class="viewTabs explorerModeTabs" role="tablist"' in html
    assert 'viewTabs--compact' not in html + css
    for mode in ['browse', 'graph', 'storage']:
        assert f'data-mode="{mode}"' in html
    assert 'ns.tabs?.select(tabs, model.mode, "mode");' in ui
    assert '.viewTab.is-active' in css


def test_storage_metric_tables_reuse_query_result_component() -> None:
    ui = read("src/static/app_explorer_detail.js")
    results = read("src/static/app_results.js")
    block = ui[ui.index("function staticTable"):ui.index("function section(")]
    assert 'ns.results?.createStaticResultTable?.({' in block
    assert 'explorerStorageTableTitle' not in ui
    assert 'renderCell: (td, cellCtx) =>' in block
    assert 'td.classList.add("explorerStoragePercentCell")' in ui
    assert 'th.className = "resultTable__thSortable";' in results
    assert 'decorateHeader = null' in results and 'renderCell = null' in results


def test_create_statement_reuses_query_editor_gutter_and_sql_highlighter() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    css = read("src/static/style.css")
    ddl = ui[ui.index("function renderDdl"):ui.index("function renderTabContent", ui.index("function renderDdl"))]
    assert 'node("div", "editorWrap explorerDdlWrap")' in ddl
    assert 'node("pre", "editorGutter explorerDdlGutter")' in ddl
    assert 'node("pre", "editorHighlight explorerDdl")' in ddl
    assert 'renderHighlightedCode(pre, ddl)' in ddl
    assert '.explorerDdlWrap .editorGutter.explorerDdlGutter' in css
    assert '.explorerDdlWrap .editorHighlight.explorerDdl' in css


def test_flow_emission_is_time_based_and_zoom_out_is_clamped_to_fit_scale() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    assert "const FLOW_EMISSION_INTERVAL_MS = 900;" in graph
    assert "const travelMs = metric.total / FLOW_SPEED_WORLD_PER_SECOND * 1000;" in graph
    assert "newestAgeMs" in graph and "markerCount" in graph
    assert "function minimumZoomScale()" in graph
    assert "model.fitScale" in graph
    # One zoom range for every graph: the kit clamps to the client's minimum
    # (the Explorer: its fit scale) and to MAX_SCALE.
    assert "minScale: minimumZoomScale," in graph and "const MAX_SCALE = 3.2;" in graph
    assert "view.scale = Math.max(minScale(), Math.min(MAX_SCALE, view.scale * factor));" in graph
    assert "Math.max(0.06, Math.min(3.2, model.scale * factor))" not in graph


def test_storage_layout_places_buffers_before_downstream_targets() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    align = graph[graph.index("function alignPhysicalStorageRows"):graph.index("function computeLayout")]
    assert 'edge.kind === "buffer"' in align
    assert "const maxSourceY = target.y - source.height - rowGap;" in align
    assert "source.y = maxSourceY;" in align
    assert "Topologically order only" in align
    assert "indegree.set(edge.to" in align


def test_log_family_keeps_clickhouse_uncompressed_total_when_clickhouse_exposes_it() -> None:
    catalog = read("src/explorer_catalog.cpp")
    ui = read("src/static/app_explorer_detail.js")
    assert "toString(total_rows), toString(total_bytes), toString(total_bytes_uncompressed)" in catalog
    assert "summary.uncompressed_bytes = total_uncompressed_bytes;" in catalog
    assert 'summary.engine == "TinyLog" || summary.engine == "Log" || summary.engine == "StripeLog"' in catalog
    assert 'aboutTile("Uncompressed", format.bytes(s.uncompressed_bytes), "data before compression"' in ui
