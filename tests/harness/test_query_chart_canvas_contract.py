import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def load_builder():
    spec = importlib.util.spec_from_file_location("build_page_css", ROOT / "tools" / "build_page_css.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_query_chart_draws_on_the_shared_canvas_engine_loaded_on_first_chart_view():
    chart = read("src/static/app_query_chart.js")
    engine = read("src/static/app_chart_core.js")
    app = read("src/static/app.js")
    # The engine is not part of the eager Query bundle: the controller loads it
    # when a panel first shows (or is about to show) a chart.
    assert '"app_chart_core.js"' not in app
    assert 'const CORE_SCRIPT = "app_chart_core.js";' in chart
    assert "function loadCore()" in chart
    assert "core.create(stageEl, {" in chart
    # No SVG strings are built per render any more.
    assert "insertAdjacentHTML" not in chart and "<svg" not in chart
    # Canvas engine: devicePixelRatio-correct backing stores, per-pixel min/max
    # decimation, a cursor overlay, resize through ResizeObserver.
    assert "ns.chartCore = {" in engine
    assert "ctx.setTransform(dpr, 0, 0, dpr, 0, 0);" in engine
    assert "const c = Math.floor(x * dpr);" in engine
    assert "new ResizeObserver(" in engine
    assert "chartCore__overlay" in engine
    # A hidden chart gives its canvas memory back.
    assert "canvas.width = 0; canvas.height = 0;" in engine


def test_query_chart_keeps_the_axis_helpers_the_metrics_page_reads():
    chart = read("src/static/app_query_chart.js")
    for name in ["niceTicks,", "timeAxisTicks,", "compactUnitFor,", "formatTickNumber,", "formatFullNumber,"]:
        assert name in chart[chart.index("ns.queryChart = {"):], name


def test_explorer_skips_the_result_chart_and_its_engine():
    builder = load_builder()
    explorer = builder.page_modules("explorer")
    query = builder.page_modules("query")
    assert "app_query_chart.js" not in explorer and "app_chart_core.js" not in explorer
    assert "app_query_chart.js" in query and "app_chart_core.js" in query
