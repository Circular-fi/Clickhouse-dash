from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_live_trace_is_classic_json_with_compact_dictionaries_and_local_parents() -> None:
    api = read("src/api_analysis.cpp")
    frontend = read("src/static/app_api.js")
    assert 'writer.Key("trace_compact")' in api
    assert 'writer.String("chdash.trace.json.lod.v2")' in api
    assert 'writer.Key("hosts")' in api
    assert 'writer.Key("traces")' in api
    assert 'writer.Key("operations")' in api
    assert 'writer.String("parent_ref")' in api
    assert 'res.set_content(buffer.GetString(), buffer.GetSize(), "application/json; charset=utf-8");' in api
    assert 'const payload = await readJsonBody(response);' in frontend
    assert 'response.arrayBuffer()' not in frontend


def test_debug_json_keeps_compact_and_original_trace_and_readme_is_english() -> None:
    api = read("src/api_analysis.cpp")
    download = read("src/static/app_download.js")
    assert 'include_original_trace' in api
    assert 'writer.Key("trace_spans_original")' in api
    assert 'options.include_original_trace_fields = include_original_trace;' in api
    assert 'writer.Key("thread_id")' in api
    assert '{ includeOriginalTrace: true }' in download
    assert 'trace_compact' in download
    assert 'trace_spans_original' in download
    assert 'files.push({ name: "README.md", text: debugArchiveReadme(many) });' in download
    assert '# ChDash Debug Archive' in download
    assert 'Compact live trace JSON (`chdash.trace.json.lod.v2`)' in download
    assert 'The normal live API does not send `trace_spans_original`' in download
