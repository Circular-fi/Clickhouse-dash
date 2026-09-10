from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_query_reload_does_not_mark_known_relation_unknown_before_metadata_arrives() -> None:
    autocomplete = read("src/static/app_autocomplete.js")
    ui = read("src/static/app_ui.js")
    functional = read("tests/frontend/specs/functional.spec.js")
    assert 'if (!Array.isArray(meta?.tables?.items)) return { ok: true, pending: true };' in autocomplete
    assert 'Array.isArray(meta?.tables?.items)' in autocomplete
    assert 'ns.meta.activateHost(state.selectedHostId)' in ui
    assert 'ns.meta.maybeRefreshOnLoad()' in ui
    assert 'chdash_ui.weather_daily_summary' in functional
    assert ".editorDiagnostic--unknown_table" in functional
    assert 'await page.reload();' in functional


def test_graph_focus_freezes_camera_and_retained_node_coordinates_and_has_selected_halo() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert 'function stabilizeLayoutPositions(' in graph
    assert 'item.x = previous.x;' in graph and 'item.y = previous.y;' in graph
    set_focus = graph[graph.index('function setFocus('):graph.index('function defaultFocusId', graph.index('function setFocus('))]
    assert 'model.offsetX' not in set_focus and 'model.offsetY' not in set_focus and 'model.scale' not in set_focus
    assert 'shadowBlur = 18' in graph
    assert 'ctx.strokeStyle = css("--accent"' in graph


def test_analysis_is_trace_first_and_uses_reusable_foldable_viewer() -> None:
    html = read("src/static/query.html")
    analysis = read("src/static/app_analysis.js")
    viewer = read("src/static/app_trace_viewer.js")
    app = read("src/static/app.js")
    assert 'data-analysis-tab=' not in html
    assert 'analysisTabs' not in html
    assert 'activeTab' not in analysis
    assert 'ns.traceViewer.render(root' in analysis
    assert 'ns.traceViewer = { render, durationLabel, buildModel };' in viewer
    assert 'shouldCollapseByDefault' in viewer
    assert 'collapsed.has(span.key)' in viewer
    assert 'Attempt ${index + 1}' in viewer
    assert 'analysisFlowIntro' not in viewer
    assert 'app_trace_viewer.js' in app


def test_profiling_auto_opens_analysis_and_debug_exports_full_profiling_file() -> None:
    run = read("src/static/app_run.js")
    download = read("src/static/app_download.js")
    functional = read("tests/frontend/specs/functional.spec.js")
    assert 'dom.runWithProfilingButton.hidden = editorIsMulti;' in run
    assert 'runMode === "profiling" && statements.length !== 1' in run
    assert 'await analysis.open({ hostId, queryId: out.queryId, runMode: "profiling" });' in run
    assert 'runMode,' in run
    assert 'async function profilingFiles(entry, prefix)' in download
    assert '`${prefix}profiling.json`' in download
    assert 'api.analyzeQuery(entry.hostId || runHostId, entry.queryId)' in download
    assert 'files.push(...await profilingFiles(entry, prefix));' in download
    assert 'profiling is unavailable for multiquery editor content' in functional
