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
    js = read("src/static/app_traces.js")
    picker = read("src/static/app_timerange.js")
    # Date and time of day (hh:mm:ss) in From / To, plus a range calendar,
    # in the panel app_timerange.js builds for each view.
    assert picker.count('class="timeRangeField__input" type="text"') == 1
    assert '${field("Start", "From", "YYYY-MM-DD hh:mm:ss or now-6h")}${field("End", "To", "YYYY-MM-DD hh:mm:ss or now")}' in picker
    assert 'id="${p}TimeCalendar"' in picker
    assert 'fromInput.value = `${dayKey(day)} 00:00:00`;' in picker
    assert 'id="${p}CustomRangeApply"' in picker
    assert 'timePicker = ns.timeRange.create(root, {\n      idPrefix: "traces",' in js
    assert 'async function applyCustomRange(raw, source = "form")' in js
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
