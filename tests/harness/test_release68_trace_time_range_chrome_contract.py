from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_custom_range_validation_rejects_inverted_and_too_wide_ranges():
    js = read("src/static/app_traces.js")
    picker = read("src/static/app_timerange.js")
    # Validated on Apply with inline errors instead of input min / max, so
    # the start of an older window is never bounded by the current end.
    assert ".min = " not in picker and ".max = " not in picker
    assert "function syncCustomRangeBounds()" not in js
    assert "if (startMs >= endMs) errors.range = '\"From\" must be before \"To\".';" in picker
    # The Logs page mounts the same picker and names its own setting.
    assert "else if (endMs - startMs > maxMs()) errors.range = `Max range is ${formatMinutes(options.getMaxMinutes())} (server setting ${options.settingName || \"traces.max_lookback_minutes\"}).`;" in picker
    assert "setError(rangeError, null, result.errors.range);" in picker
    # The calendar disables end days past start + max range, never start days.
    assert "const disabled = picking && t - startMs >= limit;" in picker

def test_trace_source_badge_and_section_rules_are_removed():
    html = read("src/static/observability.html")
    css = read("src/static/style.css")
    assert 'id="tracesSourceMeta"' not in html
    tail = css[css.rfind("/* Trace polish:"):]
    # The header keeps its border on every view: #obsNav sits under it (Page
    # shell block), so no view drops it any more.
    assert 'html[data-obs-view="traces"] .appHeader' not in css
    assert 'html[data-obs-view="logs"] .appHeader' not in css
    assert 'border-bottom: 0 !important;' in tail
    assert 'html[data-obs-view="traces"] .traceSearchResults__toolbar' in tail
    assert 'html[data-obs-view="traces"] .tracesResults--wide' in tail

def test_range_picker_has_no_internal_scrollbar_and_theme_focus_is_neutral():
    css = read("src/static/style.css")
    tail = css[css.rfind("/* Trace polish:"):]
    assert '.tracePicker--range .tracePicker__menu' in tail
    assert 'max-height: none' in tail  # the menu-family cleanup dropped !important where the value already wins
    assert 'overflow: visible !important;' in tail
    assert '.themeSelect--icons .themeSelect__button--icon:focus-visible' in tail
    assert 'border-color: var(--buttonBorderHover) !important;' in tail
    assert 'box-shadow: none !important;' in tail
