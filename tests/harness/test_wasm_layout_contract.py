"""The layout kernels of the graph kit (docs/wasm.md): the orthogonal router, the layered layout and the label placement run on
WebAssembly, with the JavaScript code kept as the reference and as the fallback, and a Worker for the long run."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KERNELS = {
    "router": ("rt_route", "wasm-router", "app_wasm_router.js"),
    "layered": ("ly_run", "wasm-layered", "app_wasm_layered.js"),
    "labels": ("lb_run", "wasm-labels", "app_wasm_labels.js"),
}
GRAPH_PAGES = ("explorer", "traces", "trace")


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def test_each_graph_page_lists_the_lazy_group_of_every_layout_kernel():
    pages = json.loads(read("src/static/modules.json"))["pages"]
    for page in GRAPH_PAGES:
        assert "app_graph_kit.js" in pages[page]["modules"], page
        for name, (_, group, adapter) in KERNELS.items():
            assert pages[page]["lazy"][group] == ["app_wasm.js", adapter], (page, name)
    # A page that draws no graph does not carry them.
    for page in ("query", "logs", "metrics", "system", "queries", "disks", "shape", "functions"):
        assert not [g for g in pages[page].get("lazy", {}) if g in {k[1] for k in KERNELS.values()}], page


def test_each_kernel_is_one_freestanding_c_file_with_its_adapter_and_its_binary():
    for name, (entry, _, adapter) in KERNELS.items():
        source = read(f"src/wasm/{name}.c")
        assert '#include "rt.h"' in source and "#include <" not in source, name
        assert f"EXPORT({entry})" in source, name
        assert (ROOT / f"src/static/wasm/{name}.wasm").exists(), name
        text = read(f"src/static/{adapter}")
        assert f"ns.wasm.ops.{name} = {{" in text and entry.split("_")[0] in text, name
        assert f"ns.wasm.{name} = {{ " in text, name


def test_the_javascript_layout_stays_as_the_reference_and_the_fallback():
    kit = read("src/static/app_graph_kit.js")
    for name in ("routeEdgesJs", "layeredOrderJs", "placeLabelsJs"):
        assert f"function {name}(" in kit and f"    {name},\n" in kit, name
    # Each public function tries the kernel and ends on the reference.
    assert "const order = layeredOrderWasm(options) || layeredOrderJs(options);" in kit
    assert "return placeLabelsJs(requests, obstacles);" in kit
    assert "return routeEdgesJs(items, edges, options);" in kit
    assert "const routed = routeEdgesWasm(items, edges, options);" in kit
    # A kernel that cannot take a run answers null (a status other than 0), never throws into the page.
    for name in ("routeEdgesWasm", "layeredOrderWasm"):
        body = kit[kit.index(f"function {name}("):]
        assert "catch (error) {" in body[:1800] and "return null;" in body[:1800], name
    # Equal inputs the kernel cannot judge go back to the reference: two edges with one id, two cards with one id.
    assert "if (ids.size !== edges.length) return null;" in read("src/static/app_wasm_router.js")
    assert "if (edgeIds.size !== edges.length) return null;" in read("src/static/app_wasm_layered.js")


def test_a_long_routing_runs_in_a_worker_and_the_page_shows_it():
    kit = read("src/static/app_graph_kit.js")
    assert "const WORKER_ROUTER_MIN_EDGES = 24;" in kit and "function routeEdgesJob(items, edges, options = {}) {" in kit
    assert 'handle = await ns.wasm.worker("router");' in kit
    assert "handle.call(\"route\", input, [input.items.buffer, input.edges.buffer])" in kit
    # The Worker is prepared when a graph mounts, after the first paint, and stops by itself.
    assert "window.requestIdleCallback(start" in kit and "prewarmRouter();" in kit
    assert "entry.idle = setTimeout(stop, IDLE_MS)" in read("src/static/app_wasm.js")
    # runSliced waits for a promise a generator yields, and a cancelled run closes the generator (the job stops its Worker).
    assert 'typeof step.value.then === "function"' in kit and "steps.return?.()" in kit
    assert "yield* kit.routeEdgesAuto(positions," in read("src/static/app_trace_map.js")
    explorer = read("src/static/app_explorer_graph.js")
    assert "kit.routeEdgesJob(layout, edges, options)" in explorer
    assert 'dom.explorerGraphStatus.textContent = "Routing edges\\u2026";' in explorer
    assert "model.routeJob?.cancel();" in explorer
    # A stale answer is dropped: the placeholder stands for the routes of its own layout only.
    assert "if (model.lineageRouteCache !== placeholder) return;" in explorer


def test_the_kernels_match_the_reference_on_the_documented_inputs_only():
    router = read("src/wasm/router.c")
    # The keyed grid (a fan point not on the grid) and a run past the tables go to the reference.
    assert "fail(RT_NEEDS_JS)" in router and "RT_NEEDS_JS (-2)" in router
    # Ties follow the JavaScript's: a stable merge sort, ranks of the ids sent by the page (localeCompare stays in JavaScript).
    assert "static void sort_idx(" in router and "erank(" in router
    # The host's hypot, so that the floating point sums are the engine's.
    assert "IMPORT(hypot)" in read("src/wasm/rt.h") and "js_hypot" in router
    pack = read("src/static/app_wasm_router.js")
    assert "String(edges[a].id).localeCompare(String(edges[b].id))" in pack
    assert not re.search(r"\beval\s*\(|new Function\s*\(", pack)
