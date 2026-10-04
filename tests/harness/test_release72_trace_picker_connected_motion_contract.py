from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def test_trace_filter_cleanup_and_connected_tag_pair():
    html = (ROOT / "src/static/observability.html").read_text()
    css = css_sources.text()

    assert 'traceInfoButton--inline' not in html
    assert 'id="tracesTagKey" class="obsFilterBar__input" type="text" placeholder="Tag"' in html
    assert 'id="tracesTagValue" class="obsFilterBar__input" type="text" placeholder="Value"' in html
    assert css_sources.decls('.traceTagSearch__inputs')['gap'] == '0'
    assert css_sources.declared("border-radius: var(--r-md) 0 0 var(--r-md)")
    assert css_sources.declared("border-radius: 0 var(--r-md) var(--r-md) 0")
    assert css_sources.decls('.traceSearchField--status')['width'] == '120px'


def test_trace_pickers_use_page_selector_open_close_motion():
    # The open / close motion of every picker is ns.menu's (app_ui_menu.js).
    js = (ROOT / "src/static/app_ui_menu.js").read_text()
    css = css_sources.text()

    assert 'menu.hidden = true;' in js
    assert 'const CLOSE_MS = 160;' in js
    assert 'const openClass = options.openClass ?? (themed ? "themeSelect--open" : root ? "is-open" : "");' in js
    assert 'const closingClass = options.closingClass ?? (themed ? "themeSelect--closing" : "");' in js
    assert 'if (closingClass) root?.classList.add(closingClass);' in js
    assert 'transform: translateY(-6px) scaleY(0.98);' in css
    assert css_sources.override('border-bottom-left-radius: 0')
    # Flat controls: no inset top sheen on a focused search bar button.
    assert 'inset 0 1px 0 color-mix(in srgb, var(--c-white)' not in css and '--c-white' not in css
