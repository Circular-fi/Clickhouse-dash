"""One side panel and one detail panel shell (app_ui_panel.js): the left
lists and the right entity panels are ns.sidePanel / ns.detailPanel shells,
with one close button (.closeCross), the width tokens, Escape through
ns.layers and one URL parameter per entity panel. A new local drawer, panel
shell or close-button style fails here."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)


def rules(css: str):
    """(selector, body) of every style rule, @media blocks flattened."""
    text = strip_comments(css)
    i = 0
    stack = [(text, 0)]
    out = []

    def walk(block: str):
        j0 = 0
        while True:
            j = block.find("{", j0)
            if j < 0:
                return
            selector = " ".join(block[j0:j].split())
            depth, k = 1, j + 1
            while depth:
                depth += {"{": 1, "}": -1}.get(block[k], 0)
                k += 1
            body = block[j + 1:k - 1]
            if selector.startswith("@media") or selector.startswith("@supports"):
                walk(body)
            elif not selector.startswith("@"):
                out.append((selector, body))
            j0 = k

    walk(text)
    return out


def block(css: str, name: str) -> str:
    start = css.index(f"/* ==== Components: {name}")
    return css[start:css.index(f"/* ==== /Components: {name}", start)]


def test_panel_module_loads_after_popover_on_every_page():
    # The modules every page loads first (src/static/modules.json).
    common = json.loads(read("src/static/modules.json"))["common"]
    assert common.index("app_ui_popover.js") < common.index("app_ui_panel.js") < common.index("app_state.js")


def test_panel_api_and_tokens():
    panel = read("src/static/app_ui_panel.js")
    assert "ns.sidePanel = Object.freeze({ mount: mountSide });" in panel
    assert "ns.detailPanel = Object.freeze({ create, head, closeButton });" in panel
    assert 'const button = h("button", { class: "closeCross uiDetail__close" }, "×");' in panel
    # Escape and focus return through ns.layers.
    assert panel.count("ns.layers.push({") == 2
    css = read("src/static/style.css")
    shell = block(css, "panels")
    assert "--side-w: 288px;" in shell and "--side-rail-w: 32px;" in shell
    assert "--detail-w: min(600px, 45vw);" in shell
    # Only tokens: raw colours live in the :root definitions, z-indexes and
    # breakpoints come from the shell scale.
    body = shell[shell.index(":root {"):]
    body = body[body.index("}") + 1:]
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(", body)
    for value in re.findall(r"z-index:\s*([^;]+);", shell):
        assert "var(--z-" in value, value
    for query in re.findall(r"@media \(([^)]*)\)", shell):
        assert query in ("min-width: 821px", "max-width: 820px", "prefers-reduced-motion: reduce") or "820px" in query, query


def test_the_left_lists_are_side_panel_shells():
    obs = read("src/static/observability.html")
    explorer = read("src/static/explorer.html")
    assert '<aside id="traceFacets" class="uiSide uiSide--sticky traceFacets"' in obs
    assert '<aside id="logsFacets" class="uiSide traceFacets logsFacets"' in obs
    assert '<aside id="metricsSidebar" class="uiSide metricsSidebar"' in obs
    assert '<aside id="explorerListPane" class="uiSide explorerListPane"' in explorer
    assert '<aside id="explorerFunctionListPane" class="uiSide explorerListPane"' in explorer
    for html in (obs, explorer):
        for head in re.findall(r'<div[^>]*class="uiSide__head[^"]*"', html):
            assert head
        assert html.count('class="uiSide__search') == html.count('class="uiSide__head')
    facets = read("src/static/app_facet_panel.js")
    assert "const side = ns.sidePanel.mount(byId(\"panel\"), {" in facets
    assert "ns.sidePanel.mount(document.getElementById(\"metricsSidebar\"), {" in read("src/static/app_metrics.js")
    assert "sidePanels[id] = ns.sidePanel.mount(pane, {" in read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    # The former per-panel frames are gone.
    for gone in (".traceFacets {\n  position: sticky;", ".metricsSidebar {\n  min-width: 0;", ".explorerSidebarToolbar",
                 "html.chdash-trace-facets-collapsed #traceFacets .traceFacets__body", "minmax(260px, 310px)", "minmax(230px, 290px)"):
        assert gone not in css, gone


def test_the_right_panels_are_detail_panel_shells():
    obs = read("src/static/observability.html")
    assert '<aside id="logsSidePanel" class="uiDetail uiDetail--docked logsSidePanel"' in obs
    spans = read("src/static/app_trace_spans.js")
    services = read("src/static/app_trace_services.js")
    assert 'className: "uiDetail--sticky traceSpanPanel",' in spans and "ns.detailPanel.create({" in spans
    assert 'className: "uiDetail--sticky traceSvcDetail",' in services and "ns.detailPanel.create({" in services
    kit = read("src/static/app_graph_kit.js")
    assert 'return ns.detailPanel.head({ eyebrow, title, subtitle, dot, onClose, closeLabel, graphKit: true });' in kit
    assert 'const shell = ns.detailPanel.create({ el: panel, layout: "floating", onClose, returnFocus: opener });' in kit
    for module in ("app_trace_map.js", "app_trace_views.js", "app_explorer_graph.js"):
        assert "panelShell(" in read(f"src/static/{module}"), module


def test_one_close_button_class():
    css = read("src/static/style.css")
    selectors = " ".join(selector for selector, _ in rules(css))
    for gone in ("traceSpanPanel__close", "traceSvcDetail__close", "logsSidePanel__close", "traceContextPanel__close",
                 "traceLogsPanel__close", "graphKitPanel__close", "traceEventPopover__close", "explorerGraphPanel__close", "traceMapPanel__close"):
        assert gone not in selectors, gone
    # Every close of a panel or popover template is the shared .closeCross.
    for path in sorted(STATIC.glob("*.js")):
        for match in re.finditer(r'class="([^"]*__close[^"]*)"', path.read_text(encoding="utf-8")):
            assert "closeCross" in match.group(1), (path.name, match.group(1))


# A fixed drawer or sheet of its own (position: fixed on a panel / drawer /
# detail / sidebar / pane selector) outside the shell.
FIXED_PANEL = re.compile(r"(?i)(panel|drawer|detail|sidebar|pane|sheet)\b")
FIXED_ALLOWED = {".traceContextPanel"}


def test_no_local_fixed_drawer():
    css = read("src/static/style.css")
    shell = block(css, "panels")
    outside = css.replace(shell, "")
    offenders = []
    for selector, body in rules(outside):
        if re.search(r"position:\s*fixed", body) and FIXED_PANEL.search(selector) and selector not in FIXED_ALLOWED:
            offenders.append(selector)
    assert not offenders, offenders


def test_entity_panels_write_one_url_parameter():
    # One helper for every panel parameter: ns.router.panel (app_router.js).
    router = read("src/static/app_router.js")
    assert "function panel(name, { owner: own = null } = {}) {" in router
    assert 'return push({ [param]: next }, { ...view(), state: { detail: marker, detailOf: of } });' in router
    assert "back();" in router[router.index("      close() {"):]
    assert "urlParam" not in read("src/static/app_ui_panel.js")
    logs = read("src/static/app_logs.js")
    assert 'const logParam = address.panel("log");' in logs
    spans = read("src/static/app_trace_spans.js")
    assert 'if (span) params.set("span", span);' in spans
    assert 'const spanParam = ns.router.owner("traces").panel("span");' in spans
    search = read("src/static/app_trace_search.js")
    # span= is the panel's, never part of the search key or a trace URL's context.
    assert search.count('params.delete("span");') == 2
    trace_map = read("src/static/app_trace_map.js")
    assert 'params: ["node"],' in trace_map and 'const nodeParam = ns.router.owner("traces").panel("node");' in trace_map
    services = read("src/static/app_trace_services.js")
    assert 'const svcParam = ns.router.owner("traces").panel("svc");' in services
    for source in (logs, spans, trace_map, services):
        assert "history.state" not in source and '"detail:' not in source
