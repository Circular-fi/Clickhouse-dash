import json
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
    query = json.loads(read("src/static/modules.json"))["pages"]["query"]
    # The engine is not part of the eager Query bundle: the controller loads it
    # (its lazy group) when a panel first shows (or is about to show) a chart.
    assert "app_chart_core.js" not in query["modules"]
    assert query["lazy"]["chart"] == ["app_chart_core.js"]
    assert 'const CORE_GROUP = "chart";' in chart
    assert "ns.loader.loadGroup(CORE_GROUP)" in chart
    assert "function loadCore()" in chart
    assert "core.create(stageEl, {" in chart
    # No SVG strings are built per render any more: the only SVG markup is
    # the two sprite icons of the Table / Chart switch, built once.
    icons = chart[chart.index("const VIEW_ICONS = {"):chart.index("const VIEW_OPTIONS = [")]
    assert "insertAdjacentHTML" not in chart and "<svg" not in chart
    assert icons.count("ns.icon(") == 2
    # Canvas engine: devicePixelRatio-correct backing stores, per-pixel min/max
    # decimation, a cursor overlay, resize through ResizeObserver.
    assert "ns.chartCore = {" in engine
    assert "ctx.setTransform(dpr, 0, 0, dpr, 0, 0);" in engine
    assert "const c = Math.floor(x * dpr);" in engine
    assert "new ResizeObserver(" in engine
    assert "chartCore__overlay" in engine
    # A hidden chart gives its canvas memory back.
    assert "canvas.width = 0; canvas.height = 0;" in engine


def test_logs_and_metrics_draw_on_the_engine_without_the_legacy_axis_helpers():
    chart = read("src/static/app_query_chart.js")
    engine = read("src/static/app_chart_core.js")
    logs = read("src/static/app_logs.js")
    metrics = read("src/static/app_metrics.js")
    views = json.loads(read("src/static/modules.json"))["pages"]["observability"]["views"]
    # The Logs and Metrics views load the engine, not the Query chart module.
    assert views["logs"] == ["app_chart_core.js", "app_facet_panel.js", "app_logs.js"]
    assert views["metrics"] == ["app_chart_core.js", "app_metrics.js"]
    # The SVG axis helpers metrics used to borrow are gone with their last reader.
    exports = chart[chart.index("ns.queryChart = {"):]
    for name in ["niceTicks", "timeAxisTicks", "compactUnitFor", "formatTickNumber"]:
        assert name not in exports, name
    assert "ns.queryChart" not in metrics
    # Logs: stacked bars on the requested range; a drag searches that range.
    assert "histogramChart = ns.chartCore.create(box, {" in logs
    assert 'type: "bar",' in logs and "stack: true," in logs and "onZoom: onHistogramZoom," in logs
    assert "<svg" not in logs[logs.index("// --- Histogram"):logs.index("function syncLegend()")]
    # Metrics: one engine chart per panel, shared crosshair, exemplar markers.
    assert "panel.chart = core.create(plot, {" in metrics
    assert "syncKey: SYNC_KEY," in metrics and 'legendClick: "toggle",' in metrics
    assert "nulls: core.bridgeGaps(values)" in metrics
    assert 'className: "metricsExemplar",' in metrics
    assert "SVG_NS" not in metrics and "createElementNS" not in metrics
    # Engine options those views need (additive: the Query chart ignores them).
    for option in ["opts.xDomain", "opts.yInclude", "opts.yUnit", "opts.formatY", "opts.barWidthRatio",
                   "opts.tooltipSort", "opts.tooltipMaxRows", "opts.tooltipTitle", "opts.legendClick", "opts.markers"]:
        assert option in engine, option
    assert "function bridgeGaps(values, factor = 2) {" in engine
    assert "ctx.setLineDash(dash);" in engine


def test_explorer_skips_the_result_chart_and_its_engine():
    builder = load_builder()
    explorer = builder.page_modules("explorer")
    query = builder.page_modules("query")
    assert "app_query_chart.js" not in explorer
    assert "app_query_chart.js" in query and "app_chart_core.js" in query
    # The engine never reaches the Explorer; the System page (its
    # performance, queries and disks charts) loads it.
    pages = json.loads(read("src/static/modules.json"))["pages"]
    assert "app_chart_core.js" not in pages["explorer"]["modules"] and "lazy" not in pages["explorer"]
    assert "app_chart_core.js" in pages["system"]["modules"]


def test_streamed_charts_draw_once_per_frame_and_only_while_visible():
    chart = read("src/static/app_query_chart.js")
    engine = read("src/static/app_chart_core.js")
    segmented = read("src/static/app_ui_segmented.js")
    # Engine: setData schedules one draw per animation frame; reads flush it.
    set_data = engine[engine.index("    function setData(next = {}) {"):engine.index("    function flushDraw(force = false) {")]
    assert "scheduleDraw();" in set_data and "draw();" not in set_data.replace("scheduleDraw();", "")
    assert "layout: () => { flushDraw(); return layout; }," in engine
    # Long series: block summaries that grow with appended rows, and dense
    # lines drawn as pixel-aligned column rects instead of a zigzag stroke.
    assert "const BLOCK = 64;" in engine and "function extendSummary(sum, values, n) {" in engine
    assert "const appended = next.append === true;" in engine
    assert "function traceColumns(L, ys, nulls, sum) {" in engine
    assert "ctx.fillRect((colDev[k] - ((wide - 1) >> 1)) / dpr, y0, w / dpr, y1 - y0);" in engine
    assert "counters: () => ({ ...counters })," in engine
    # Query chart: no work while hidden, an x scan resumed per build, a
    # parse budget per frame, and the arrays handed over as appended.
    assert 'const canWork = () => !destroyed && effective === "chart" && hostVisible && !document.hidden;' in chart
    assert "const PARSE_BUDGET = 240000;" in chart
    assert "model = buildModel(cfg, meta, rows, store, scan, limit);" in chart
    assert "append: !!model.appended" in chart and "chart.flush();" in chart
    # Table | Chart: icon options of the shared segmented control.
    assert 'ns.segmented.render(toggleEl, VIEW_OPTIONS, { attr: "view", value: "table", label: "Result view" });' in chart
    assert 'ns.segmented.bind(toggleEl, { attr: "view"' in chart
    assert "option.iconOnly && option.label ? ` aria-label=" in segmented
