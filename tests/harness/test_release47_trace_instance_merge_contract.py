from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_trace_instance_suffixes_are_normalized_before_compact_leaf_grouping() -> None:
    api = read("src/api_analysis.cpp")
    assert "trace_operation_instance_name" in api
    assert "value[digits - 1] != '_'" in api
    assert "leaf_group_key(row.trace_id, row.parent_span_id, operation_name)" in api
    assert "node.operation_name = operation_name" in api


def test_processor_summary_groups_numbered_instances_server_side() -> None:
    cpp = read("src/query_analysis.cpp")
    assert "replaceRegexpOne(toString(operation_name), '(_[0-9]+)+$', '') AS normalized_operation_name" in cpp
    assert "GROUP BY trace_id, parent_span_id, normalized_operation_name" in cpp


def test_trace_viewer_recursively_merges_same_parent_numbered_siblings() -> None:
    viewer = read("src/static/app_trace_viewer.js")
    assert "function normalizeOperationName" in viewer
    assert "function mergeSiblingInstances" in viewer
    assert "const mergedChildren = siblings.flatMap((span) => span.children);" in viewer
    assert "node.children = mergeSiblingInstances(mergedChildren, node);" in viewer
    assert "span.mergedCount > 1" in viewer


def test_pipeline_uses_normalized_instance_names_for_zero_step_groups_and_summary() -> None:
    pipeline = read("src/static/app_pipeline_viewer.js")
    assert "function operationName" in pipeline
    assert 'planStep === "0" ? processorName : ""' in pipeline
    assert "const operation = operationName(row.operation_name);" in pipeline
