"""The colour and treemap kernels (docs/wasm.md): each has a lazy group, an adapter, and the JavaScript reference kept as the
answer for a short batch, a missing kernel and the items the kernel hands back."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text(encoding="latin-1")


def modules():
    return json.loads(read("src/static/modules.json"))


def test_the_treemap_kernel_is_loaded_on_the_pages_that_draw_a_treemap_and_keeps_its_reference():
    data = modules()
    drawing = {page for page, entry in data["pages"].items() if "app_explorer_treemap.js" in entry["modules"]}
    assert drawing == {"explorer", "system", "disks"}
    for page in drawing:
        assert data["pages"][page]["lazy"]["wasm-treemap"] == ["app_wasm.js", "app_wasm_treemap.js"], page
    source = read("src/static/app_explorer_treemap.js")
    # The reference keeps its name and its body; the dispatcher falls back to it.
    assert "function layoutTreemapNodesJs(nodes, x, y, width, height) {" in source
    assert "return layoutTreemapNodesJs(nodes, x, y, width, height);" in source
    assert 'ns.loader.loadGroup("wasm-treemap")' in source
    assert "WASM_MIN_NODES = 48" in source
    adapter = read("src/static/app_wasm_treemap.js")
    assert "ns.wasm.ops.treemap = {" in adapter and "k.exports.tm_layout(" in adapter
    c = read("src/wasm/treemap.c")
    assert "Number.EPSILON" not in c and "EPS 2.220446049250313e-16" in c


def test_the_colour_kernel_is_a_lazy_group_of_the_pages_with_batches_and_the_batches_fall_back():
    data = modules()
    for page, entry in data["pages"].items():
        has = "wasm-color" in entry.get("lazy", {})
        assert has == (page != "functions"), page
        if has:
            assert entry["lazy"]["wasm-color"] == ["app_wasm.js", "app_wasm_color.js"], page
    palette = read("src/static/app_palette.js")
    for name in ("normalizeBatch", "readableTextBatch", "hashSlotBatch", "sequentialBatch", "categoricalBatch"):
        assert f"function {name}(" in palette, name
    # One entry point: a short batch, a missing kernel and a failure give null, and then the single function runs.
    assert "if (!force && count < (COLOR_MIN_ITEMS[op] || Infinity)) return null;" in palette
    assert "return list.map(normalize);" in palette
    assert 'ns.loader.loadGroup("wasm-color")' in palette
    assert "batch: Object.freeze({" in palette
    kit = read("src/static/app_graph_kit.js")
    assert "function mixColorBatch(a, b, weights, force) {" in kit and "return list.map((t) => mixColor(a, b, t));" in kit
    chart = read("src/static/app_chart_core.js")
    assert "function parseColors(texts, force) {" in chart and "return list.map(parseColor);" in chart
    assert "function rgbaBatch(colors, alpha = 1, force) {" in chart and "return list.map((c) => rgba(c, alpha));" in chart
    views = read("src/static/app_trace_views.js")
    assert "kit.mixColorBatch(kit.color(\"nodeBg\")" in views and "palette.batch.readableTextBatch(" in views
    adapter = read("src/static/app_wasm_color.js")
    for op in ("normalize", "parseChart", "rgba", "mix", "readable", "hashSlots", "steps", "categorical"):
        assert re.search(rf"^    {op}: ", adapter, re.M), op


def test_the_colour_kernel_takes_its_numbers_from_the_host_not_from_its_own_maths():
    c = read("src/wasm/color.c")
    # Math.pow of the host gives the digits of the JavaScript luminance; the rest is plain arithmetic.
    assert "js_pow(" in c and "__builtin_pow" not in c and "sqrt" not in c
    # A number the kernel cannot convert exactly, or round with certainty, goes back to JavaScript (status 2).
    assert "ostatus[i] = 2;" in c and "plain_number" in c
