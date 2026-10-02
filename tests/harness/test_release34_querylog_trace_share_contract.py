from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")

def test_execution_stats_prune_query_log_by_order_by_prefix() -> None:
    cpp = read("src/query_execution.cpp")
    hpp = read("src/query_registry.hpp")
    assert "created_at_wall" in hpp and "updated_at_wall" in hpp
    assert "FROM system.query_log PREWHERE " in cpp
    assert "event_date BETWEEN toDate(toDateTime(" in cpp
    assert "event_time BETWEEN toDateTime(" in cpp
    assert "WHERE type != 'QueryStart' AND query_id IN " in cpp

def test_trace_initial_expansion_is_whole_depths_under_50_visible_spans() -> None:
    js = read("src/static/app_trace_viewer.js")
    assert "const INITIAL_VISIBLE_SPAN_LIMIT = 50;" in js
    assert "function initialCollapsedForSpanLimit" in js
    assert "Commit complete breadth levels only" in js
    assert "collapsed.clear();" in js
    assert "for (const key of beforeDepth) collapsed.add(key);" in js

def test_browse_share_ui_is_reworked_and_tuple_names_have_no_angle_wrappers() -> None:
    ui = read("src/static/app_explorer_detail.js")
    css = read("src/static/style.css")
    about = ui[ui.index("function aboutTiles"):ui.index("function renderAbout")]
    assert 'aboutTile("Share", `${percentText(dbShare)} of ${database}`' in about
    assert '`${percentText(allShare)} of all databases`' in about
    assert "explorerScopeMeter" not in ui
    assert ".explorerAboutTile__context" in css
    assert '"explorerStorageTupleName explorerStorageTupleName--child" : "explorerStorageTupleName" }, item.name' in ui
    assert "`<${item.name}>`" not in ui

def test_storage_static_tables_do_not_sort_the_row_number_column() -> None:
    explorer = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    results = read("src/static/app_results.js")
    assert "indexSortable: false" in explorer
    assert "indexSortable = true" in results
    assert 'indexHead.className = "dataTable__rowNum";\n      if (indexSortable) {\n        ns.table.sortHeader(indexHead, {' in results

def test_aggregate_info_icon_keeps_more_edge_spacing() -> None:
    css = read("src/static/style.css")
    marker = "/* Keep the AggregateFunction info affordance comfortably away from the table borders. */"
    block = css[css.index(marker):css.index("/* Expanding Tuple", css.index(marker))]
    assert "top: 8px;" in block
    assert "right: 8px;" in block

