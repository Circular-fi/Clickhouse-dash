from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_non_storing_toggle_is_required_for_non_storing_focus() -> None:
    ui = read("src/static/app_explorer.js")
    graph = read("src/static/app_explorer_graph.js")
    assert "includeNonStoring: !!table && nonStoringSummary(table)" in ui
    assert "includeNonStoring: !!node && isNonStoringNode(node)" in graph
    assert "required.includeNonStoring || options.includeNonStoring !== false" in graph


def test_storage_copy_and_extra_heading_are_removed() -> None:
    ui = read("src/static/app_explorer.js")
    assert "Storage values are local-replica values. Capacity and paths are only exposed for disks used by this visible table." not in ui
    storage = ui[ui.index("function renderStorageCombined"):ui.index("function renderOperations")]
    assert 'sectionTitle("Columns, indexes & projections")' not in storage


def test_tuple_subcolumns_do_not_consume_row_numbers() -> None:
    ui = read("src/static/app_explorer.js")
    results = read("src/static/app_results.js")
    assert "let topLevelColumnPosition = 0;" in ui
    assert "const displayPosition = c.is_subcolumn ? null : ++topLevelColumnPosition;" in ui
    assert 'rowIndexValue: (row) => row?.__explorerStorageItem?.position ?? ""' in ui
    assert "rowIndexValue = null" in results


def test_trace_transport_is_json_compact_grouped_and_lod() -> None:
    api = read("src/api_analysis.cpp")
    frontend = read("src/static/app_analysis.js")
    collector = read("src/query_analysis.cpp")
    assert 'writer.Key("trace_compact")' in api
    assert 'writer.String("chdash.trace.json.lod.v2")' in api
    assert 'kTraceTimelinePixels = 3840' in api
    assert 'writer.String("parent_ref")' in api
    assert 'writer.String("segments_px")' in api
    assert 'writer.Key("trace_spans")' not in api
    assert 'build_trace_json(' in api
    assert 'analysis.trace_spans, analysis.processor_trace_summary, analysis.processors' in api
    assert 'String(compact.format || "") === "chdash.trace.json.lod.v2"' in frontend
    assert 'compact_leaf_group: leafGroup' in frontend
    assert "include_original_fields" in collector
    assert "attribute['clickhouse.thread_id']" in collector
    assert "attribute['thread_number']" in collector


def test_trace_initial_state_is_computed_before_first_dom_paint() -> None:
    viewer = read("src/static/app_trace_viewer.js")
    assert "function initialCollapsedForSpanLimit" in viewer
    assert "const collapsed = initialCollapsedForSpanLimit(model);" in viewer
    assert "expandWholeDepthsWithinSpanLimit" not in viewer
    assert "visibleRows(model, collapsed).length <= maxVisible" in viewer
    assert "for (const span of model.spans.slice().sort(stableCompare)) visit(span);" not in viewer


def test_storage_row_number_header_cannot_ellipsize() -> None:
    css = read("src/static/style.css")
    assert ".explorerStorageResultTable .resultTable > thead > tr > th.resultTable__rowIndex" in css
    assert "text-overflow: clip;" in css
