from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_trace_filter_cleanup_and_connected_tag_pair():
    html = (ROOT / "src/static/traces.html").read_text()
    css = (ROOT / "src/static/style.css").read_text()

    assert 'traceInfoButton--inline' not in html
    assert 'id="tracesTagKey" type="text" placeholder="Tag"' in html
    assert 'id="tracesTagValue" type="text" placeholder="Value"' in html
    assert '.traceTagSearch__inputs {\n  gap: 0 !important;' in css
    assert 'border-radius: 6px 0 0 6px !important;' in css
    assert 'border-radius: 0 6px 6px 0 !important;' in css
    assert '.traceSearchField--status {\n  width: 120px !important;' in css


def test_trace_pickers_use_page_selector_open_close_motion():
    js = (ROOT / "src/static/app_traces.js").read_text()
    css = (ROOT / "src/static/style.css").read_text()

    assert 'menu.hidden = true;' in js
    assert 'requestAnimationFrame(() => {' in js
    assert 'root.classList.add("themeSelect--closing");' in js
    assert '}, 160);' in js
    assert 'root.classList.add("themeSelect--open");' in js
    assert 'transform: translateY(-6px) scaleY(.98);' in css
    assert 'border-bottom-left-radius: 0 !important;' in css
    assert 'box-shadow: inset 0 1px 0 color-mix(in srgb, white 6%, transparent) !important;' in css
