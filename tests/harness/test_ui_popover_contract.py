"""One placement, tooltip and popover shell (app_ui_popover.js): no local
viewport clamp, no hover tooltip announced as a live region, no local
popover shell."""

from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def scripts():
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(STATIC.glob("*.js"))}


def test_popover_loads_after_layers_on_every_page():
    app = read("src/static/app.js")
    files = app[app.index("const files = ["):app.index("];", app.index("const files = ["))]
    assert files.index('"app_ui_layers.js"') < files.index('"app_ui_popover.js"') < files.index('"app_state.js"')
    assert 'popover: "app_ui_popover.js"' in app
    obs = read("src/static/app_observability.js")
    common = obs[obs.index("const COMMON_MODULES = ["):obs.index("];", obs.index("const COMMON_MODULES = ["))]
    assert common.index('"app_ui_layers.js"') < common.index('"app_ui_popover.js"') < common.index('"app_ui.js"')


def test_popover_api():
    popover = read("src/static/app_ui_popover.js")
    assert "ns.popover = Object.freeze({ place, tip, follow, open, flash, hideTip: hideShared });" in popover
    assert 'shared.setAttribute("role", "tooltip");' in popover
    assert "const layer = ns.layers.push({" in popover
    css = read("src/static/style.css")
    block = css[css.index("/* ==== Components: popover"):css.index("/* ==== /Components: popover")]
    assert "z-index: var(--z-tooltip);" in block and "z-index: var(--z-dropdown);" in block
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(", block)


# The viewport clamp `Math.max(8, Math.min(window.innerWidth - w - 8, x))` is
# ns.popover.place. Menus still placing themselves wait for ns.menu.
CLAMP = re.compile(r"window\.innerWidth\s*-\s*[\w.]+\s*-\s*(?:8|margin)\b")
CLAMP_ALLOWED = {"app_results.js", "app_ui_popover.js"}


def test_no_local_viewport_clamp():
    offenders = sorted(name for name, text in scripts().items() if CLAMP.search(text) and name not in CLAMP_ALLOWED)
    assert not offenders, f"place popovers with ns.popover.place: {offenders}"


def test_hover_tooltips_are_not_live_regions():
    offenders = []
    for name, text in scripts().items():
        for line in text.splitlines():
            if re.search(r"(?i)(tooltip|__tip|Tip\b)", line) and re.search(r"""role["'=, ]+["']?status""", line):
                offenders.append(f"{name}: {line.strip()[:120]}")
    assert not offenders, offenders
    assert '<div class="chartCore__tooltip" role="tooltip" hidden></div>' in read("src/static/app_chart_core.js")
    treemap = read("src/static/app_explorer_treemap.js")
    assert "ns.popover.follow({" in treemap and 'tooltip.setAttribute("role", "status")' not in treemap


def test_migrated_popovers_use_the_shell():
    views = read("src/static/app_trace_views.js")
    assert "ns.popover.open(marker, html, {" in views and "ns.popover.follow({" in views
    assert 'document.addEventListener("click", onDocClick, true);' not in views
    traces = read("src/static/app_traces.js")
    assert "serviceTip = ns.popover.tip(root, hiddenPills, {" in traces and "servicePopover" not in traces
    spans = read("src/static/app_trace_spans.js")
    assert "const popover = ns.popover.open(button, \"\", {" in spans
    search = read("src/static/app_trace_search.js")
    assert "ns.popover.place(anchor, menu, {" in search and "menuLayer = ns.layers.push({" in search
    css = read("src/static/style.css")
    for gone in (".traceFlame__tip {", ".explorerTreemap__tooltip {\n  position: absolute;", ".traceEventPopover__close {", ".traceSvcPopover {\n  position: fixed;", ".editorDiagnosticTooltip {\n  position: fixed;"):
        assert gone not in css, gone
