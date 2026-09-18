from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_pipeline_summary_preserves_temporal_gaps_with_bounded_bucketing() -> None:
    cpp = read("src/query_analysis.cpp")
    pipeline = read("src/static/app_pipeline_viewer.js")
    docs = read("docs/query-analysis.md")

    assert "processor_trace_bucket_us" in cpp
    assert "target_rows = 32768" in cpp
    assert "min_buckets_per_processor = 4" in cpp
    assert "max_buckets_per_processor = 512" in cpp
    assert "GROUP BY trace_id, parent_span_id, normalized_operation_name, intDiv(start_time_us," in cpp
    api = read("src/api_analysis.cpp")
    analysis = read("src/static/app_analysis.js")
    assert 'writer.Key("processor_trace_bucket_us")' in api
    assert "summaryBucketUs: Number(payload?.processor_trace_bucket_us) || 0" in analysis
    assert "activity windows" in pipeline
    assert "not CPU utilization" in pipeline
    assert "gaps within a window are unknown" in pipeline
    assert "adaptive temporal buckets" in docs
    assert "real gaps between periods of activity" in docs
