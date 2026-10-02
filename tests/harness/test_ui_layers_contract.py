"""One dismiss stack for every page (app_ui_layers.js): ns.layers owns the
only Escape and click-outside listeners, ns.dialog is a modal layer, and
ns.lifecycle scopes bind a view's listeners to its visibility."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def common_modules() -> list[str]:
    """The modules every page loads first (src/static/modules.json, read by
    app_loader.js, app.js, app_observability.js and build_page_css.py)."""
    manifest = json.loads(read("src/static/modules.json"))
    for name, page in manifest["pages"].items():
        listed = page["modules"] + [f for group in page.get("lazy", {}).values() for f in group] + [f for view in page.get("views", {}).values() for f in view]
        assert not {"app_ui_layers.js", "app_ui_popover.js", "app_ui_panel.js"} & set(listed), name
    return manifest["common"]


def test_layers_load_first_on_every_page():
    common = common_modules()
    assert common.index("app_dom.js") < common.index("app_ui_layers.js") < common.index("app_state.js")


def test_layers_own_one_escape_and_one_outside_listener():
    layers = read("src/static/app_ui_layers.js")
    assert "ns.layers = Object.freeze({ push, top, handleOf, isOpen, closeAll, size: () => stack.length, debug });" in layers
    assert "ns.lifecycle = Object.freeze({ scope, enter, leave, current, bind });" in layers
    assert layers.count('document.addEventListener("keydown", onKeydown);') == 1
    assert layers.count('document.addEventListener("pointerdown", onPointerdown, true);') == 1
    assert layers.count("document.addEventListener(") == 2
    # Escape: the top layer only, a consumed key or a page field keeps it.
    on_key = layers[layers.index("function onKeydown(event) {"):layers.index("function trap(event) {")]
    assert "if (event.defaultPrevented || event.isComposing) return;" in on_key
    assert "if (target && textField(target) && !insideAny(target)) return;" in on_key
    assert on_key.count("dismiss(") == 1
    assert "new AbortController()" in layers


def test_dialog_is_a_modal_layer():
    dialog = read("src/static/app_ui_dialog.js")
    assert "layer = ns.layers.push({" in dialog
    assert "modal: true," in dialog
    assert "onDismiss: () => close()," in dialog
    assert "layer?.close({ restoreFocus: restore, force: true });" in dialog


# Escape comparisons left outside ns.layers, per file: keys a component
# consumes first (an editor's suggestions, a drag or a chart cursor to cancel,
# a canvas selection, a data table cell going back to its row, a filter
# field's text, the tooltip hide, a panel letting
# the key go on to the layers), and the Query page's menus and editor, which
# move onto ns.menu / ns.layers with the Query revamp; ns.search empties a
# filled search field on Escape and consumes the key (preventDefault), so the
# layers leave it and a second Escape closes what holds the field. A new local Escape
# handler fails here: push an ns.layers layer instead.
ESCAPE_ALLOWED = {
    "app_ui_layers.js": 1,
    "app_ui_popover.js": 1,
    "app_ui_search.js": 1,
    "app_autocomplete.js": 2,
    "app_chart_core.js": 3,
    "app_graph_kit.js": 1,
    "app_ui_table.js": 1,
    "app_trace_heatmap.js": 1,
    "app_trace_logs.js": 1,
    "app_trace_insights.js": 1,
    "app_ui.js": 2,
    "app_results.js": 4,
    "app_query_chart.js": 1,
    "app_query_library.js": 4,
}

# Document-level press listeners: the layers' outside press, the
# Observability shell's link interception, and the Query page's own (editor
# suggestions, header menus, result and chart menus, library menu).
OUTSIDE_ALLOWED = {
    "app_ui_layers.js", "app_observability.js",
    "app_autocomplete.js", "app_ui.js", "app_results.js", "app_query_chart.js", "app_query_library.js",
}


def test_no_new_local_escape_or_click_outside_handler():
    for path in sorted(STATIC.glob("*.js")):
        text = path.read_text(encoding="utf-8")
        count = text.count('"Escape"')
        assert count <= ESCAPE_ALLOWED.get(path.name, 0), f"{path.name}: {count} Escape comparisons (use ns.layers)"
        presses = re.findall(r'document\.addEventListener\("(?:click|pointerdown|mousedown)"', text)
        assert not presses or path.name in OUTSIDE_ALLOWED, f"{path.name}: a document press listener (use ns.layers)"


def test_views_bind_their_global_listeners_while_shown():
    # Observability views and the Explorer modes: ns.lifecycle scopes.
    explorer = read("src/static/app_explorer.js")
    assert "ns.lifecycle?.enter(next);" in explorer and "ns.lifecycle?.leave(lifecycleName);" in explorer
    # (The Explorer graph has no global listener left: its Lineage | Storage
    # choice is a segmented control, not a menu.)
    for module, view in (("app_traces.js", "traces"), ("app_trace_spans.js", "traces"), ("app_trace_search.js", "traces")):
        assert f'ns.lifecycle.bind("{view}", (scope) =>' in read(f"src/static/{module}"), module
    for module in ("app_logs.js", "app_metrics.js", "app_trace_services.js", "app_trace_map.js", "app_trace_views.js", "app_trace_insights.js", "app_explorer_detail.js"):
        text = read(f"src/static/{module}")
        assert not re.search(r'document\.addEventListener\("keydown"', text), module


def test_observability_views_get_a_lifecycle_scope():
    obs = read("src/static/app_observability.js")
    assert "window.ChDash.lifecycle?.leave(leaving);" in obs
    assert "module?.onShow?.(window.ChDash.lifecycle?.enter(view) || null);" in obs
    assert obs.index("viewModule(leaving)?.onHide?.();") < obs.index("window.ChDash.lifecycle?.leave(leaving);")
