from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_pipeline_is_dense_and_does_not_repeat_metric_labels_per_row() -> None:
    pipeline = read("src/static/app_pipeline_viewer.js")
    css = read("src/static/style.css")
    assert 'element("div", "metricsHead")' in pipeline
    assert '["In wait max", "Out wait max", "Input", "Output"]' in pipeline
    assert 'Work Σ · share' in pipeline
    assert 'k.className = "pipelineViewer__metricLabel srOnly"' in pipeline
    assert '"Timing unavailable"' in pipeline
    assert 'min-height: 40px;' in css[css.index('.pipelineViewer__row {'):css.index('.pipelineViewer__row:hover')]
    assert 'grid-template-columns: .8fr .8fr 1.2fr 1.2fr;' in css[css.index('.pipelineViewer__metricsHead {'):]


def test_truncated_trace_uses_full_processor_summary_for_leaf_activity() -> None:
    api = read("src/api_analysis.cpp")
    analysis = read("src/static/app_analysis.js")
    trace = read("src/static/app_trace_viewer.js")
    docs = read("docs/query-analysis.md")
    assert 'processor_summary_overlay' in api
    assert 'trace_operation_family' in api
    assert 'analysis.trace_truncated &&' in api
    assert 'analysis.processor_trace_summary_available && !analysis.processor_trace_summary_truncated' in api
    assert 'node.segments.clear();' in api
    assert 'row.first_start_time_us, row.last_finish_time_us' in api
    assert 'processorSummaryOverlay: payload?.trace_compact?.processor_summary_overlay === true' in analysis
    assert 'processor activity is filled from the full time-bucketed OTel summary' in trace
    assert 'processor leaves would otherwise be a chronological' in docs
