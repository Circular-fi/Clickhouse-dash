from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_pipeline_uses_full_trace_processor_summary_independent_of_trace_cap() -> None:
    hpp = read("src/query_analysis.hpp")
    cpp = read("src/query_analysis.cpp")
    api = read("src/api_analysis.cpp")
    analysis = read("src/static/app_analysis.js")
    pipeline = read("src/static/app_pipeline_viewer.js")

    assert "struct ProcessorTraceSummaryRow" in hpp
    assert "processor_trace_summary" in hpp
    assert "load_processor_trace_summary" in cpp
    assert "min(start_time_us)" in cpp
    assert "max(finish_time_us)" in cpp
    assert "sum(finish_time_us - start_time_us)" in cpp
    assert "GROUP BY trace_id, parent_span_id, normalized_operation_name" in cpp
    assert "system.processors_profile_log PREWHERE" in cpp
    assert "system.opentelemetry_span_log PREWHERE" in cpp
    assert "finish_date BETWEEN" in cpp
    assert "finish_time_us BETWEEN" in cpp
    assert 'writer.Key("processor_trace_summary")' in api
    assert "processorTraceSummary: decodedProcessors.processorTraceSummary" in analysis
    assert "buildProcessorTraceSummary(options?.processorTraceSummary" in pipeline
    assert "summarySegments.length ? summarySegments" in pipeline


def test_pipeline_matches_duplicate_processor_names_by_exact_active_work() -> None:
    pipeline = read("src/static/app_pipeline_viewer.js")
    assert "const scale = Math.max(100, elapsed, active);" in pipeline
    assert "const score = Math.abs(elapsed - active) / scale;" in pipeline
    assert "best.group.traceActiveUs" in pipeline
    assert "best.group.traceOperations.add(instance.operation);" in pipeline
