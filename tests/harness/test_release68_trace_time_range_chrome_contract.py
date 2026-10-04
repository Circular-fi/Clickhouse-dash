from pathlib import Path
import css_sources

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
    css = css_sources.text()
    assert 'id="tracesSourceMeta"' not in html
    # The header keeps its border on every view: #obsNav sits under it (Page
    # shell block), so no view drops it any more.
    assert 'html[data-obs-view="traces"] .appHeader' not in css
    assert 'html[data-obs-view="logs"] .appHeader' not in css
    assert css_sources.declared("border-bottom: 0")
    assert css_sources.decls('html[data-obs-view="traces"] .traceSearchResults__toolbar')['border-bottom'] == '0'
    assert css_sources.decls('html[data-obs-view="traces"] .tracesResults--wide')['border-top'] == '0'

def test_range_picker_has_no_internal_scrollbar_and_theme_focus_is_neutral():
    css = css_sources.text()
    # The range picker's menu (.traceSearchBar .tracePicker--range) never scrolls.
    menu = css_sources.decls('.traceSearchBar.obsFilterBar .tracePicker--range .tracePicker__menu')
    assert menu['max-height'] == 'none' and menu['overflow'] == 'visible'
    assert '.themeSelect--icons .themeSelect__button--icon:focus-visible' in css
    assert css_sources.override('border-color: var(--buttonBorderHover)')
    assert css_sources.override('box-shadow: none')
