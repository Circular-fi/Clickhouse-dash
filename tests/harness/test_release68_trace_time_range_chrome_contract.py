from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_custom_range_cross_bounds_prevent_inverted_dates():
    js = read("src/static/app_traces.js")
    assert "function syncCustomRangeBounds()" in js
    assert "startInput.max = toLocalDateTime" in js
    assert "endInput.min = Number.isFinite(startMs)" in js
    assert "endInput.max = toLocalDateTime" in js
    assert "startInput.min = Number.isFinite(endMs)" in js

def test_trace_source_badge_and_section_rules_are_removed():
    html = read("src/static/traces.html")
    css = read("src/static/style.css")
    assert 'id="tracesSourceMeta"' not in html
    tail = css[css.rfind("/* Trace polish:"):]
    assert 'body[data-page="traces"] .appHeader' in tail
    assert 'border-bottom: 0 !important;' in tail
    assert 'body[data-page="traces"] .traceSearchResults__toolbar' in tail
    assert 'body[data-page="traces"] .tracesResults--wide' in tail

def test_range_picker_has_no_internal_scrollbar_and_theme_focus_is_neutral():
    css = read("src/static/style.css")
    tail = css[css.rfind("/* Trace polish:"):]
    assert '.tracePicker--range .tracePicker__menu' in tail
    assert 'max-height: none !important;' in tail
    assert 'overflow: visible !important;' in tail
    assert '.themeSelect--icons .themeSelect__button--icon:focus-visible' in tail
    assert 'border-color: var(--buttonBorderHover) !important;' in tail
    assert 'box-shadow: none !important;' in tail
