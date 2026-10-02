from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_trace_filter_cleanup_and_connected_tag_pair():
    html = (ROOT / "src/static/observability.html").read_text()
    css = (ROOT / "src/static/style.css").read_text()

    assert 'traceInfoButton--inline' not in html
    assert 'id="tracesTagKey" class="obsFilterBar__input" type="text" placeholder="Tag"' in html
    assert 'id="tracesTagValue" class="obsFilterBar__input" type="text" placeholder="Value"' in html
    assert '.traceTagSearch__inputs {\n  gap: 0 !important;' in css
    assert 'border-radius: 6px 0 0 6px !important;' in css
    assert 'border-radius: 0 6px 6px 0 !important;' in css
    assert '.traceSearchField--status {\n  width: 120px !important;' in css


def test_trace_pickers_use_page_selector_open_close_motion():
    # The open / close motion of every picker is ns.menu's (app_ui_menu.js).
    js = (ROOT / "src/static/app_ui_menu.js").read_text()
    css = (ROOT / "src/static/style.css").read_text()

    assert 'menu.hidden = true;' in js
    assert 'const CLOSE_MS = 160;' in js
    assert 'const openClass = options.openClass ?? (themed ? "themeSelect--open" : root ? "is-open" : "");' in js
    assert 'const closingClass = options.closingClass ?? (themed ? "themeSelect--closing" : "");' in js
    assert 'if (closingClass) root?.classList.add(closingClass);' in js
    assert 'transform: translateY(-6px) scaleY(.98);' in css
    assert 'border-bottom-left-radius: 0 !important;' in css
    assert 'box-shadow: inset 0 1px 0 color-mix(in srgb, white 6%, transparent) !important;' in css
