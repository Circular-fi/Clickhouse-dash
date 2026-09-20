from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")

def test_run_with_profiling_requires_both_sources_but_debug_does_not():
    run = read("src/static/app_run.js")
    assert "selectedHostSupportsFullProfiling" in run
    assert "tables.processors_profile_log === true && tables.opentelemetry_span_log === true" in run
    assert "const profilingHidden = editorIsMulti || !profilingAvailable" in run
    assert "dom.runWithProfilingButton.hidden = profilingHidden" in run
    debug_block = run[run.index("if (dom.downloadDebugButton)"):run.index("const editorEmpty", run.index("if (dom.downloadDebugButton)"))]
    assert "profilingAvailable" not in debug_block

def test_analysis_tab_selector_only_appears_when_both_views_exist():
    analysis = read("src/static/app_analysis.js")
    assert "const showSelector = views.pipeline && views.tracing" in analysis
    assert "dom.analysisTabs.hidden = !showSelector" in analysis
    assert "availability.processors_profile_log === true" in analysis
    assert "availability.opentelemetry_span_log === true" in analysis

def test_trace_source_always_uses_selected_host_system_connection():
    header = read("src/server.hpp")
    config = read("src/config.cpp")
    api = read("src/api_traces.cpp")
    example = read("config.example.hcl")
    trace_section = example[example.index("traces {"):example.index("analysis {")]
    trace_struct = header[header.index("struct TraceSettings"):header.index("struct AnalysisSettings")]
    assert "credential_scope" not in trace_struct
    assert "std::string host_id;" not in header[header.index("struct TraceSettings"):header.index("struct AnalysisSettings")]
    assert '"host_id", "credential_scope"' not in config
    assert "host.system_uri.empty()" in api
    assert "const std::string& uri = host.system_uri" in api
    assert "credential_scope" not in trace_section
    assert "host_id" not in trace_section

def test_direct_trace_url_lookup_is_not_bounded_by_search_lookback():
    api = read("src/api_traces.cpp")
    detail = api[api.index("void Server::handle_trace_detail"): ]
    assert "full_trace_id_lookup" not in detail
    assert 'WITH " + trace_literal + " AS trace' in detail
    assert "PREWHERE Timestamp >= trace_start AND Timestamp <= trace_end" in detail
    assert 'WHERE TraceId = trace AND' in detail
    assert "trace_index_lookup_failed" in detail
    assert "max_lookback_minutes" not in detail
    ui = read("src/static/app_traces.js")
    assert r"pathname.match(/\/traces\/([^/]+)\/?$/)" in ui
    assert "await loadTrace(id, { push: false })" in ui
