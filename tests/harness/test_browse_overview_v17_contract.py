from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_storage_composition_is_one_stacked_bar_with_compact_legend() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    css = read("src/static/style.css")
    assert 'explorerStorageStackedBar' in ui
    assert 'explorerStorageCompositionLegend' in ui
    for variant in ["wide", "compact", "projection", "index"]:
        assert f'explorerStorageStackedBar__segment--${{item.variant}}' in ui or variant in ui
        assert f'.explorerStorageStackedBar__segment--{variant}' in css
    assert "Shares use the table's local bytes_on_disk footprint" not in ui


def test_storage_tables_are_separate_and_use_shared_query_sorting() -> None:
    ui = read("src/static/app_explorer_detail.js")
    results = read("src/static/app_results.js")
    assert 'ns.results?.createStaticResultTable?.({' in ui
    assert 'th.className = "resultTable__thSortable";' in results
    assert 'className: "explorerStorageResultTable--columns explorerColumnsTable"' in ui
    assert 'renderStructures(body, indexes, "indexes")' in ui
    assert 'renderStructures(body, projections, "projections")' in ui
    assert 'explorerStorageTableTitle' not in ui


def test_storage_sizes_use_fixed_two_decimal_format_and_lineage_footnote_is_removed() -> None:
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    css = read("src/static/style.css")
    # One byte format everywhere: one decimal from KB up, "0 B" for zero; the
    # storage helper keeps its name and delegates to it.
    assert 'return `${sign}${v.toFixed(1)} ${BYTE_UNITS[unit]}`;' in ui
    assert 'if (v < 1024) return `${sign}${Math.round(v)} B`;' in ui
    assert 'function fmtStorageBytes(value) {\n    return fmtBytes(value);' in ui
    assert 'fmtStorageBytes(item.compressed)' in ui
    assert 'min-width: 9.5ch;' in css
    assert 'font-variant-numeric: tabular-nums;' in css
    assert 'Upstream objects feed this object; downstream objects consume or are populated by it.' not in ui


def test_storage_mode_cross_database_navigation_treats_missing_scope_as_unknown_not_blocked() -> None:
    graph = read("src/static/app_explorer_graph.js")
    block = graph[graph.index("function canUseStorageForTable"):graph.index("function rawStorageProjection")]
    assert 'const exists = (model.graph.nodes || []).some' in block
    assert 'if (!exists) return null;' in block
    assert 'return canUseStorageForId(id);' in block
