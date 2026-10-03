from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_trace_truncation_preserves_shallow_depths_and_autofit_opens_whole_depths() -> None:
    cpp = read("src/query_analysis.cpp")
    js = read("src/static/app_trace_viewer.js")
    block = cpp[cpp.index("std::vector<OpenTelemetrySpanAnalysisRow> load_otel_spans"):cpp.index("std::vector<QueryViewAnalysisRow> load_views")]
    assert "breadth-first" in block
    assert "root_predicate" in block
    assert "tuple(toString(trace_id), toString(parent_span_id)) IN " in block
    assert "remaining + 1" in block
    assert "if (truncated) *truncated = true;" in block
    assert "const INITIAL_VISIBLE_SPAN_LIMIT = 50;" in js
    assert "const beforeDepth = new Set(collapsed);" in js
    assert "for (const span of candidates) collapsed.delete(span.key);" in js
    assert "if (visibleRows(model, collapsed).length <= maxVisible) continue;" in js


def test_profiling_label_and_function_description_centering() -> None:
    query = read("src/static/query.html")
    results = read("src/static/app_results.js")
    css = css_sources.text()
    assert '>Profiling</button>' in query
    assert 'analyzeBtn.textContent = "Profiling";' in results
    assert "#explorerFunctionDetail {" in css
    assert "align-items: center;" in css
    assert "#explorerFunctionDetail .explorerFunctionDescription" in css


def test_database_catalog_includes_only_database_level_size_summaries() -> None:
    api = read("src/api_explorer.cpp")
    catalog = read("src/explorer_catalog.cpp")
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    handler = api[api.index("void Server::handle_explorer_catalog"):api.index("void Server::handle_explorer_table")]
    assert "load_explorer_database_summaries" in handler
    assert 'w.Key("database_summaries")' in handler
    assert 'w.Key("engine_full")' not in handler
    assert "GROUP BY database ORDER BY database" in catalog
    assert "discover_visible_databases(runner)" in catalog
    assert "out.database_footprint_bytes = summary_row.bytes;" in catalog
    assert "format.bytes(databaseSummary.bytes)" in ui
    assert "const dbShare = percentValue(footprint, dbBytes);" in ui


def test_data_settings_is_portalled_and_storage_tuple_geometry_is_stable() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    css = css_sources.text()
    menu = read("src/static/app_ui_menu.js")
    assert 'ns.menu?.bind(button, menu, { root, portal: true, portalAlign: "end", closeOnSelect: true })' in ui
    assert "host(button).appendChild(menu);" in menu
    assert 'if (portal) menu.classList.add("is-open");' in menu
    assert "if (menu.parentNode !== home.parent) home.parent.insertBefore(menu, home.next?.parentNode === home.parent ? home.next : null);" in menu
    assert 'indexCell.textContent = "";' in ui
    assert "table-layout: fixed;" in css
    assert "body > .explorerDataSettings__menu.is-open" in css


def test_light_minimap_viewport_is_darker_and_icon_selectors_keep_outline() -> None:
    graph = (read("src/static/app_explorer_graph.js") + read("src/static/app_graph_kit.js"))
    css = css_sources.text()
    # The light viewport rectangle is a darker fill and stroke, now tokens.
    assert 'ctx.fillStyle = color("minimapViewFill");' in graph and 'ctx.strokeStyle = color("minimapView");' in graph
    assert '--graph-minimap-view-fill: rgba(21, 24, 29, 0.1);' in css and '--graph-minimap-view: rgba(21, 24, 29, 0.92);' in css
    assert ".themeSelect--icons .themeSelect__button--icon {" in css
    icon = css_sources.decls(".themeSelect--icons .themeSelect__button--icon")
    assert icon["border"] == "1px solid var(--buttonBorder)"
    assert icon["transition"].startswith("border-radius var(--dur-base) var(--ease)")
