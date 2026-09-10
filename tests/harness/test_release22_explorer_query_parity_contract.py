from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_overview_uses_ram_labels_without_resident_runtime_cards_or_extra_section_titles() -> None:
    ui = read("src/static/app_explorer.js")
    graph = read("src/static/app_explorer_graph.js")
    overview = ui[ui.index("function renderOverview"):ui.index("function isImplementationSubcolumn")]
    assert '"Resident rows"' not in ui
    assert '"Resident memory"' not in ui
    assert "renderResidentRuntime" not in ui
    assert '`${fmtBytes(bytes)} RAM`' in ui
    assert '`${util.formatBytes(rawBytes)}${memoryResident ? " RAM" : " logical"}`' in graph
    assert 'sectionTitle("Storage breakdown")' not in overview
    assert 'sectionTitle("CREATE statement")' not in overview


def test_lineage_cards_show_plain_database_dot_table_names() -> None:
    ui = read("src/static/app_explorer.js")
    deps = ui[ui.index("function renderDependencies"):ui.index("function renderParts")]
    assert 'const qualified = `${dep.database || "—"}.${dep.table || "—"}`;' in deps
    assert 'const qualified = `<${dep.database' not in deps


def test_data_preview_has_compact_finalize_marker_and_open_in_query_formats_equivalent_sql() -> None:
    ui = read("src/static/app_explorer.js")
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
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    assert 'id="explorerTableModeTabs" class="themeSelect themeSelect--icons explorerModeSelect"' in html
    assert 'themeSelect__button--icon explorerModeSelect__button' in html
    assert 'themeSelect__option themeSelect__option--icon' in html
    assert 'explorerModeIcon--browse' in html and 'explorerModeIcon--graph' in html
    assert 'icon.className = `explorerModeIcon explorerModeIcon--${graphMode ? "graph" : "browse"}`;' in ui
    assert '.explorerModeIcon--browse' in css and '.explorerModeIcon--graph' in css


def test_storage_metric_tables_reuse_query_result_component_and_keep_only_percent_custom() -> None:
    ui = read("src/static/app_explorer.js")
    results = read("src/static/app_results.js")
    block = ui[ui.index("function renderStorageMetricTable"):ui.index("function renderColumns")]
    assert 'ns.results?.createStaticResultTable?.({' in block
    assert 'explorerStorageTableTitle' not in ui
    assert 'renderCell: (td, ctx) =>' in block
    assert 'td.classList.add("explorerStoragePercentCell")' in block
    assert 'th.className = "resultTable__thSortable";' in results
    assert 'decorateHeader = null' in results and 'renderCell = null' in results


def test_create_statement_reuses_query_editor_gutter_and_sql_highlighter() -> None:
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    ddl = ui[ui.index("function renderDdl"):ui.index("function renderTabContent")]
    assert 'node("div", "editorWrap explorerDdlWrap")' in ddl
    assert 'node("pre", "editorGutter explorerDdlGutter")' in ddl
    assert 'node("pre", "editorHighlight explorerDdl")' in ddl
    assert 'renderHighlightedCode(pre, ddl)' in ddl
    assert '.explorerDdlWrap .editorGutter.explorerDdlGutter' in css
    assert '.explorerDdlWrap .editorHighlight.explorerDdl' in css


def test_flow_emission_is_time_based_and_zoom_out_is_clamped_to_fit_scale() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "const FLOW_EMISSION_INTERVAL_MS = 900;" in graph
    assert "const travelMs = metric.total / FLOW_SPEED_WORLD_PER_SECOND * 1000;" in graph
    assert "newestAgeMs" in graph and "markerCount" in graph
    assert "function minimumZoomScale()" in graph
    assert "model.fitScale" in graph
    assert "Math.max(minimumZoomScale(), Math.min(3.2, model.scale * factor))" in graph
    assert "Math.max(0.06, Math.min(3.2, model.scale * factor))" not in graph


def test_storage_layout_places_buffers_before_downstream_targets() -> None:
    graph = read("src/static/app_explorer_graph.js")
    align = graph[graph.index("function alignPhysicalStorageRows"):graph.index("function computeLayout")]
    assert 'edge.kind === "buffer"' in align
    assert "const maxSourceY = target.y - source.height - rowGap;" in align
    assert "source.y = maxSourceY;" in align
    assert "Topologically order only" in align
    assert "indegree.set(edge.to" in align


def test_log_family_keeps_clickhouse_uncompressed_total_when_clickhouse_exposes_it() -> None:
    catalog = read("src/explorer_catalog.cpp")
    ui = read("src/static/app_explorer.js")
    assert "toString(total_rows), toString(total_bytes), toString(total_bytes_uncompressed)" in catalog
    assert "summary.uncompressed_bytes = total_uncompressed_bytes;" in catalog
    assert 'summary.engine == "TinyLog" || summary.engine == "Log" || summary.engine == "StripeLog"' in catalog
    assert '["Data uncompressed", s.uncompressed_bytes == null ? "unknown" : fmtBytes(s.uncompressed_bytes)]' in ui
