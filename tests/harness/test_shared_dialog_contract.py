"""The Query page has one modal dialog component (app_ui_dialog.js): the
profiling dialog, the query library and their prompts share it."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_dialog_module_is_loaded_by_query_only():
    app = read("src/static/app.js")
    files = app[app.index("const files = ["):app.index("];", app.index("const files = ["))]
    assert files.index('"app_ui_dialog.js"') < files.index('"app_ui.js"') < files.index('"app_analysis.js"')
    explorer = app[app.index("explorer: ["):app.index("]", app.index("explorer: ["))]
    assert '"app_ui_dialog.js"' in explorer


def test_dialog_is_a_native_modal_with_backdrop_escape_and_focus_return():
    dialog = read("src/static/app_ui_dialog.js")
    assert "ns.dialog = { shell, bind, open, confirm, host };" in dialog
    assert "dialog.showModal();" in dialog
    assert 'el("dialog", `uiDialog uiDialog--${size}' in dialog
    # Escape (cancel), backdrop click, focus in on open and back on close.
    assert 'dialog.addEventListener("cancel", (ev) => {' in dialog
    assert "const backdrop = pressedBackdrop && ev.target === dialog;" in dialog
    assert "(isFocusable(target) ? target : dialog).focus({ preventScroll: true });" in dialog
    # The focus goes back through its ns.layers layer: opener, else fallback.
    assert "opener: returnTo," in dialog and "layer?.close({ restoreFocus: restore, force: true });" in dialog
    layers = read("src/static/app_ui_layers.js")
    assert "const target = [layer.opener, ...(Array.isArray(fallback) ? fallback : [fallback])].find(focusable);" in layers


def test_profiling_and_library_share_the_large_shell():
    html = read("src/static/query.html")
    analysis = read("src/static/app_analysis.js")
    ui = read("src/static/app_ui.js")
    assert '<dialog id="analysisModal" class="uiDialog uiDialog--lg analysisModal"' in html
    assert 'class="uiDialog__tabs analysisTabs" role="tablist"' in html
    assert "analysisModalBackdrop" not in html and "analysisModalBackdrop" not in analysis
    assert "dialog = ns.dialog?.bind(dom.analysisModal, {" in analysis
    # The library dialog: the same shell and size, built on first open.
    library = ui[ui.index("function buildQueryLibraryDialog() {"):ui.index("function openQueryLibrary(")]
    assert "ns.dialog.shell({" in library and 'id: "queryLibraryMenu",' in library and 'size: "lg",' in library
    assert 'id="queryLibraryMenu"' not in html
    assert "positionQueryLibrary" not in ui


def test_library_prompts_use_the_shared_dialog():
    lib = read("src/static/app_query_library.js")
    assert "return ns.dialog.open({" in lib
    assert "return ns.dialog.confirm({ title, message, confirmLabel, danger, className: \"qlDialog\" });" in lib
    assert "showModal" not in lib and 'el("dialog"' not in lib
    # Import asks first, like the deletes.
    body = lib[lib.index("async function importBrowserQueries() {"):lib.index("// ------------------------------------------------------------ library view")]
    assert body.index("await confirmDialog({") < body.index("ctl.adapter.importLibrary(payload)")


def test_no_shortcut_hint_beside_run():
    html = read("src/static/query.html")
    actions = html[html.index('<div class="queryActions">'):html.index('id="runSettings"')]
    assert "runShortcutHint" not in html and "<kbd>" not in actions
    css = read("src/static/style.css")
    assert ".queryActions__hint" not in css
    # The shortcut stays, in the Run tooltip.
    assert "dom.runButton.title = `Run (${mod}+Enter)`;" in read("src/static/app_ui.js")
