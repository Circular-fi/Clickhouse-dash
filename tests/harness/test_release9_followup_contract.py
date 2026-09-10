from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_clickhouse_267_column_ttl_does_not_query_missing_system_columns_field() -> None:
    catalog = read("src/explorer_catalog.cpp")
    assert "toString(ttl_expression)" not in catalog
    assert '"DESCRIBE TABLE " + quote_ident(database) + "." + quote_ident(table)' in catalog
    assert "column.ttl_expression = described_ttl" in catalog


def test_storage_topology_is_physical_only_and_ttl_is_rendered_as_tier_lifecycle() -> None:
    backend = read("src/explorer_graph.cpp")
    header = read("src/explorer_graph.hpp")
    api = read("src/api_explorer.cpp")
    graph = read("src/static/app_explorer_graph.js")
    assert "FROM system.storage_policies" in backend
    assert '"volume_tier"' in backend
    assert "previous_volume_id" in backend
    assert "parse_table_ttl_rules" in backend
    assert "ExplorerGraphTtlRule" in header
    assert 'w.Key("ttl_rules")' in api
    assert '["contains", "storage_policy", "policy_volume", "volume_tier", "volume_disk"]' in graph
    assert 'function rawStorageProjection()' in graph
    assert 'function storageProjection()' in graph
    assert 'kind: "storage_tier"' in graph
    assert 'TTL while in ${volumeName}' in graph
    assert 'function drawLifecycleEdgeLabel(' in graph
    raw_projection = graph[graph.index("function rawStorageProjection()") : graph.index("function storageProjection()")]
    assert 'target.layer !== "physical"' in raw_projection


def test_graph_layout_has_barycentric_and_local_transposition_crossing_minimization() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "Sugiyama-style barycentric sweeps" in graph
    assert "const crossingScore = () =>" in graph
    assert "Adjacent transposition after barycentric sweeps" in graph


def test_results_wait_for_shape_before_committing_horizontal_layout_globally_and_multiquery() -> None:
    results = read("src/static/app_results.js")
    assert "if (!livePresentationCommitted && allResultRows.length >= 2)" in results
    assert "renderVerticalSingleRow(allResultRows[0])" in results
    assert "presentationCommitted: false" in results
    assert "commitLocalHorizontalPresentation" in results
    assert "renderVerticalSingleRowLocal(local.allRows[0])" in results


def test_analysis_uses_reusable_jaeger_trace_without_overview() -> None:
    html = read("src/static/index.html")
    analysis = read("src/static/app_analysis.js")
    viewer = read("src/static/app_trace_viewer.js")
    css = read("src/static/style.css")
    assert 'data-analysis-tab=' not in html
    assert 'analysisTabs' not in html
    assert 'ns.traceViewer.render(root' in analysis
    assert 'traceViewer__row' in viewer
    assert 'span.start - model.start' in viewer
    assert 'span.duration / model.window' in viewer
    assert '.traceViewer__bar' in css
    assert 'nameHead.textContent = "Operation"' in viewer
    assert 'traceViewer__serviceMarker' in viewer


def test_explorer_sidebar_primary_selector_uses_space_recovered_by_icon_mode_selector() -> None:
    css = read("src/static/style.css")
    assert ".explorerHeader--sidebar .explorerNavSelect" in css
    selector = css[css.rindex(".explorerHeader--sidebar .explorerNavSelect"):css.index("#explorerTableModeTabs", css.rindex(".explorerHeader--sidebar .explorerNavSelect"))]
    assert "flex: 1 1 auto" in selector
    assert "width: auto" in selector
    tail = css[css.rindex("#explorerTableModeTabs") :]
    assert "border-left: 0" in tail
