from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_status_and_limit_dropdowns_match_button_width():
    css = read("src/static/style.css")
    assert ".traceSearchField--status > .tracePicker" in css
    assert ".traceSearchField--limit > .tracePicker" in css
    assert "width: 120px !important;" in css
    assert "max-width: 120px !important;" in css
    assert "max-width: 100% !important;" in css
    assert "border-top: 0 !important;" in css
    assert "margin-top: -1px !important;" in css


def test_trace_picker_hover_and_close_motion_follow_page_selector():
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert 'root.classList.add("themeSelect--closing");' in js
    assert 'requestAnimationFrame(() => root.classList.remove("themeSelect--open"));' in js
    assert "border-color: var(--buttonBorderHover) !important;" in css
    assert "border-bottom-color: transparent !important;" in css
    assert "border-bottom-left-radius: 0 !important;" in css
    assert "border-bottom-right-radius: 0 !important;" in css


def test_custom_range_exposes_date_and_time_inputs():
    html = read("src/static/traces.html")
    js = read("src/static/app_traces.js")
    assert html.count('type="datetime-local"') == 2
    assert 'step="1"' in html
    assert 'dom.tracesCustomRange.hidden = !(custom && model.customRangeOpen)' in js
    assert 'id="tracesCustomRangeApply"' in html
    assert 'function applyCustomRange()' in js
    assert 'closeCustomRangeEditor();' in js


def test_service_and_operation_choices_are_bidirectionally_compatible():
    js = read("src/static/app_traces.js")
    assert 'function updateServiceOptions()' in js
    assert 'filter((pair) => !operation || String(pair?.[1] || "") === operation)' in js
    assert 'filter((pair) => !service || String(pair?.[0] || "") === service)' in js
    assert 'function serviceOperationPairExists(service, operation)' in js
    assert 'function syncServiceOperationPair(preferred = "service")' in js
    assert 'syncServiceOperationPair("service")' in js
    assert 'syncServiceOperationPair("operation")' in js
    assert 'Selected service / operation combination does not exist in this time range.' in js
