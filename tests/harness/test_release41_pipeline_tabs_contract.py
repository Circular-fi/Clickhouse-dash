from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_profiling_modal_opens_pipeline_first_and_tracing_second() -> None:
    html = read("src/static/index.html")
    dom = read("src/static/app_dom.js")
    analysis = read("src/static/app_analysis.js")

    assert html.index('id="analysisPipelineTab"') < html.index('id="analysisTraceTab"')
    assert 'id="analysisPipelineTab" class="analysisTab is-active"' in html
    assert 'id="analysisTraceTab" class="analysisTab"' in html
    assert 'analysisPipelineTab: byId("analysisPipelineTab")' in dom
    assert 'analysisTraceTab: byId("analysisTraceTab")' in dom
    assert 'let activeTab = "pipeline";' in analysis
    assert 'activeTab = "pipeline";' in analysis
    assert 'if (activeTab === "tracing") renderTrace();' in analysis
    assert 'else renderPipeline();' in analysis
    assert 'dom.analysisTraceTab?.addEventListener("click", () => setActiveTab("tracing"));' in analysis


def test_pipeline_viewer_combines_processor_cost_with_otel_wall_clock() -> None:
    app = read("src/static/app.js")
    analysis = read("src/static/app_analysis.js")
    pipeline = read("src/static/app_pipeline_viewer.js")

    assert '"app_pipeline_viewer.js"' in app
    assert 'ns.pipelineViewer.render(root' in analysis
    assert 'processors: decodedProcessors.processors' in analysis
    assert 'spans: decodedSpans()' in analysis
    assert 'Activity density over time' in pipeline
    assert 'Work Σ · share' in pipeline
    assert 'group.elapsedSum += elapsed;' in pipeline
    assert 'group.inputWaitMax = Math.max' in pipeline
    assert 'group.outputWaitMax = Math.max' in pipeline
    assert 'parent_ids point to downstream processors' in pipeline
    assert 'const timeSegments = summarySegments.length ? summarySegments' in pipeline


def test_pipeline_timing_does_not_fake_distinct_windows_for_duplicate_processor_names() -> None:
    pipeline = read("src/static/app_pipeline_viewer.js")
    assert 'const score = Math.abs(elapsed - active) / scale;' in pipeline
    assert 'best.group.segments.push(...instance.segments.map' in pipeline
    assert 'best.group.traceActiveUs' in pipeline
    assert 'Backward-compatible fallback' in pipeline
    assert 'Timing unavailable' in pipeline


def test_pipeline_and_trace_have_separate_lazy_mount_surfaces() -> None:
    analysis = read("src/static/app_analysis.js")
    css = read("src/static/style.css")

    assert 'root.classList.remove("traceViewerHost")' in analysis
    assert 'root.classList.remove("pipelineViewerHost")' in analysis
    assert '.analysisModal__content.pipelineViewerHost {' in css
    assert '.pipelineViewer__scroll {' in css
    assert 'scrollbar-gutter: stable;' in css[css.index('.pipelineViewer__scroll {'):]
    assert '.analysisTabs {' in css
    assert '.analysisTab.is-active {' in css


def test_pipeline_model_behavior() -> None:
    result = subprocess.run(
        ["node", "--test", "tests/frontend/model/pipeline.test.cjs"],
        cwd=ROOT, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
