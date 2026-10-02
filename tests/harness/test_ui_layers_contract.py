"""One dismiss stack for every page (app_ui_layers.js): ns.layers owns the
only Escape and click-outside listeners, ns.dialog is a modal layer, and
ns.lifecycle scopes bind a view's listeners to its visibility."""

from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_layers_load_first_on_every_page():
    app = read("src/static/app.js")
    files = app[app.index("const files = ["):app.index("];", app.index("const files = ["))]
    assert files.index('"app_dom.js"') < files.index('"app_ui_layers.js"') < files.index('"app_state.js"')
    assert 'layers: "app_ui_layers.js"' in app
    skipped = app[app.index("PAGE_SKIPPED_MODULES = {"):app.index("};", app.index("PAGE_SKIPPED_MODULES = {"))]
    assert "app_ui_layers.js" not in skipped
    obs = read("src/static/app_observability.js")
    common = obs[obs.index("const COMMON_MODULES = ["):obs.index("];", obs.index("const COMMON_MODULES = ["))]
    assert common.index('"app_dom.js"') < common.index('"app_ui_layers.js"') < common.index('"app_ui.js"')


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


def test_observability_views_get_a_lifecycle_scope():
    obs = read("src/static/app_observability.js")
    assert "window.ChDash.lifecycle?.leave(leaving);" in obs
    assert "module?.onShow?.(window.ChDash.lifecycle?.enter(view) || null);" in obs
    assert obs.index("viewModule(leaving)?.onHide?.();") < obs.index("window.ChDash.lifecycle?.leave(leaving);")
