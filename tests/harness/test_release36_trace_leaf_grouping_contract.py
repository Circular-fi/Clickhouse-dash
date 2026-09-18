from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_only_leaf_spans_are_grouped_by_trace_parent_operation() -> None:
    api = read("src/api_analysis.cpp")
    assert "const bool has_children = parent_keys.find(own_key) != parent_keys.end();" in api
    assert "if (has_children)" in api
    assert "node.source_span_id = row.span_id;" in api
    assert "leaf_group_key(row.trace_id, row.parent_span_id, operation_name)" in api
    assert "key.append(trace_id)" in api
    assert "key.append(parent_span_id)" in api
    assert "key.append(operation_name)" in api
    assert "group_key.append(row.hostname)" not in api
    assert "if (!node.leaf_group || node.segments.size() < 2) continue;" in api


def test_leaf_ids_are_omitted_and_intervals_share_one_compact_json_row() -> None:
    api = read("src/api_analysis.cpp")
    frontend = read("src/static/app_analysis.js")
    assert "local parent references" in api
    assert 'writer.Uint64(node.parent_ref);' in api
    assert 'writer.Uint(node.leaf_group ? 1u : 0u);' in api
    assert 'writer.String("segments_px")' in api
    assert 'const leafGroup = (Number(row[4]) & 1) !== 0;' in frontend
    assert 'compact_leaf_group: leafGroup' in frontend
    assert 'segments,' in frontend


def test_dense_leaf_groups_render_as_one_row_without_thousands_of_dom_bars() -> None:
    viewer = read("src/static/app_trace_viewer.js")
    css = read("src/static/style.css")
    assert "renderSegments.length > 96" in viewer
    assert 'traceViewer__segmentSvg' in viewer
    assert 'commands.push(`M${x1.toFixed(2)} 6H${x2.toFixed(2)}V14H${x1.toFixed(2)}Z`);' in viewer
    assert ".traceViewer__segmentSvg" in css
    assert ".traceViewer__segmentPath" in css
