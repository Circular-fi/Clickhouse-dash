import json
import importlib.util
import re
from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def load_builder():
    spec = importlib.util.spec_from_file_location("build_page_css", ROOT / "tools" / "build_page_css.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def section(text, start, end):
    return text[text.index(start):text.index(end, text.index(start))]


def test_traces_view_loads_the_canvas_engine_before_its_charts():
    assert json.loads(read("src/static/modules.json"))["pages"]["observability"]["views"]["traces"][:3] == ["app_chart_core.js", "app_facet_panel.js", "app_traces.js"]
    builder = load_builder()
    traces = builder.observability_modules("traces")
    assert traces.index("app_chart_core.js") < traces.index("app_traces.js")
    # The views that can load the engine keep its rules.
    for view in ("traces", "logs", "metrics"):
        assert ".chartCore__overlay" in css_sources.sheets()[f"style.observability.{view}.css"], view


def test_trace_charts_draw_on_the_engine_without_svg():
    traces = read("src/static/app_traces.js")
    heatmap = read("src/static/app_trace_heatmap.js")
    services = read("src/static/app_trace_services.js")
    charts = section(traces, "function renderServiceChart()", "function rememberAnalyticsEnabled(")
    assert "<svg" not in charts and "<rect" not in charts and "<circle" not in charts
    # Drag on a time chart searches that range.
    assert "onZoom: (zoomed, fromUser) => { if (fromUser && zoomed) zoomSearchRange(zoomed); }," in charts
    assert 'void applyCustomRange({ from: format(from), to: format(to) }, "chart");' in traces
    # A scatter dot opens its trace.
    assert "onPick: (hit) => { const trace = traceAt(hit); if (trace) loadTrace(trace.trace_id, { push: true }); }," in charts
    # The heatmap: canvas cells on a log axis, a 2-D brush, DOM regions.
    render = section(heatmap, "function render()", "// ------------------------------------------------------- hit testing")
    assert "<svg" not in render and "<rect" not in render
    assert 'yScale: "log"' in render and "cells: box," in render and 'brush: "xy"' in render
    assert "onBrush: (r) => { hm.anchor = null; hm.cursor = null; select(r.box); }," in render
    assert "chart.setRegions(regions());" in heatmap
    # Services detail: rate bars (stacked), error-rate and latency lines, releases as annotations.
    detail = section(services, "function detailChart(", "function endpointsHtml(")
    assert "<svg" not in detail and "chart.mountChart(container, \"service\", {" in detail
    assert 'className: "traceSvcRelease"' in detail
    # The row sparklines stay static SVG (two per row, no interaction): the
    # shared ui.sparkline.
    assert "ns.ui.sparkline.html(" in services and "className: `traceSvcSpark ${cls}`" in services


def test_engine_extensions_are_additive_options():
    engine = read("src/static/app_chart_core.js")
    ext = section(engine, "// --- Extensions: own-x and per-point marks", "const api = {")
    for name in ("function drawCells(", "function drawPoints(", "function pickAt(", "function startBox(",
                 "function placeAnnotations(", "function placeRegions(", "function applyLogScale(", "function customYAxis("):
        assert name in ext, name
    for option in ("series[k].xs", "pickTooltip(hit)", "yAxis(min, max, plotH)", 'yScale: "log"', "cells:", "annotations:", "regions:", 'brush: "xy"', "keyboard: false"):
        assert option in ext, option
    assert "Object.assign(api, extraApi);" in engine
    assert re.search(r"Object\.assign\(ns\.chartCore, \{\s*logTicks,", engine)
