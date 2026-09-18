from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")

def test_trace_json_uses_one_origin_and_4k_temporal_buckets() -> None:
    api = read("src/api_analysis.cpp")
    assert "uint64_t trace_origin_us(" in api
    assert "out.origin_us = trace_origin_us(rows);" in api
    assert "kTraceTimelinePixels = 3840" in api
    assert "trace_bucket_floor" in api and "trace_bucket_ceil" in api
    assert 'writer.Key("origin_us")' in api
    assert 'writer.Key("duration_us")' in api

def test_frontend_rehydrates_4k_trace_buckets() -> None:
    analysis = read("src/static/app_analysis.js")
    assert "const origin = Number(compact.origin_us) || 0;" in analysis
    assert "const timelinePx = Math.max(1, Number(compact.timeline_px) || 3840);" in analysis
    assert "Math.floor((startPx * duration) / timelinePx)" in analysis
    assert "Math.ceil((finishPx * duration) / timelinePx)" in analysis
