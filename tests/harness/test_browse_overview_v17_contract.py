from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_storage_composition_is_one_stacked_bar_with_compact_legend() -> None:
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    assert 'explorerStorageStackedBar' in ui
    assert 'explorerStorageCompositionLegend' in ui
    for variant in ["wide", "compact", "projection", "index"]:
        assert f'explorerStorageStackedBar__segment--${{item.variant}}' in ui or variant in ui
        assert f'.explorerStorageStackedBar__segment--{variant}' in css
    assert "Shares use the table's local bytes_on_disk footprint" not in ui


def test_storage_tables_are_separate_and_use_shared_query_sorting() -> None:
    ui = read("src/static/app_explorer.js")
    results = read("src/static/app_results.js")
    assert 'ns.results?.createStaticResultTable?.({' in ui
    assert 'th.className = "resultTable__thSortable";' in results
    assert 'renderStorageMetricTable(container, "Columns", "columns"' in ui
    assert 'renderStorageMetricTable(container, "Indexes", "indexes"' in ui
    assert 'renderStorageMetricTable(container, "Projections", "projections"' in ui
    assert 'explorerStorageTableTitle' not in ui


def test_storage_sizes_use_fixed_two_decimal_format_and_lineage_footnote_is_removed() -> None:
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    assert 'return `${sign}${v.toFixed(2)}${units[unit]}`;' in ui
    assert 'fmtStorageBytes(ctx.value)' in ui
    assert 'min-width: 9.5ch;' in css
    assert 'font-variant-numeric: tabular-nums;' in css
    assert 'Upstream objects feed this object; downstream objects consume or are populated by it.' not in ui


def test_storage_mode_cross_database_navigation_treats_missing_scope_as_unknown_not_blocked() -> None:
    graph = read("src/static/app_explorer_graph.js")
    block = graph[graph.index("function canUseStorageForTable"):graph.index("function rawStorageProjection")]
    assert 'const exists = (model.graph.nodes || []).some' in block
    assert 'if (!exists) return null;' in block
    assert 'return canUseStorageForId(id);' in block
