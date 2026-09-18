from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_analysis_response_is_normal_json_not_binary() -> None:
    api = read("src/api_analysis.cpp")
    frontend = read("src/static/app_api.js")
    assert 'res.set_content(buffer.GetString(), buffer.GetSize(), "application/json; charset=utf-8");' in api
    assert 'response.append("CDA1"' not in api
    assert 'wire.append("CTR1"' not in api
    assert 'decodeAnalysisEnvelope' not in frontend
    assert 'response.arrayBuffer()' not in frontend
    assert 'const payload = await readJsonBody(response);' in frontend


def test_temporal_lod_is_fixed_to_4k_and_only_merges_leaf_pixel_segments() -> None:
    api = read("src/api_analysis.cpp")
    assert 'constexpr uint64_t kTraceTimelinePixels = 3840;' in api
    assert 'trace_bucket_floor(start_offset, out.duration_us)' in api
    assert 'trace_bucket_ceil(finish_offset, out.duration_us)' in api
    assert 'source.leaf_group && !buckets.empty() && pixel_interval.first <= buckets.back().second' in api
    assert 'writer.Key("segment_count_before_lod")' in api
    assert 'writer.Key("segment_count_after_lod")' in api
    assert 'writer.String("segments_px")' in api


def test_compact_json_keeps_tree_structure_with_local_parent_refs() -> None:
    api = read("src/api_analysis.cpp")
    analysis = read("src/static/app_analysis.js")
    assert 'local_parent_index.emplace' in api
    assert 'node.parent_ref = it->second + 1;' in api
    assert 'writer.String("parent_ref")' in api
    assert 'parent_span_id: parentRef > 0 ? `__trace_node_${parentRef - 1}` : ""' in analysis
    assert 'span_id: leafGroup ? `__leaf_group_${index}` : `__trace_node_${index}`' in analysis


def test_debug_archive_documents_lod_and_keeps_exact_original_spans() -> None:
    download = read("src/static/app_download.js")
    assert 'trace_compact' in download
    assert 'trace_spans_original' in download
    assert 'fixed at 3840' in download
    assert 'Exact original timings and real span IDs remain available' in download
