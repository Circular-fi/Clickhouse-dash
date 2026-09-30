from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_duration_ticks_helper_exists_for_trace_overview_and_waterfall():
    ui = read("src/static/app_traces.js")
    assert "function durationTicks(" in ui
    assert "durationTicks(bounds.duration, 5)" in ui
    assert "durationTicks(total, TIMELINE_TICKS, offset)" in ui

def test_service_operation_are_selection_only_and_status_labels_uppercase():
    html = read("src/static/traces.html")
    assert '<select id="tracesService" data-field-label="Service"' in html
    assert '<select id="tracesOperation" data-field-label="Operation"' in html
    assert '<input id="tracesService"' not in html
    assert '<input id="tracesOperation"' not in html
    assert 'optional · contains match' not in html
    assert '<option value="Ok">OK</option>' in html
    assert '<option value="Error">ERROR</option>' in html
    assert '<option value="Unset">UNSET</option>' in html

def test_tag_filter_is_free_form_and_exact_across_attribute_maps():
    html = read("src/static/traces.html")
    ui = read("src/static/app_traces.js")
    cpp = read("src/api_traces.cpp")
    assert 'id="tracesTagKey"' in html and 'type="text"' in html
    assert 'id="tracesTagValue"' in html and 'type="text"' in html
    assert 'scope: "any"' in ui
    assert 'tag_scope == "any"' in cpp
    assert 'SpanAttributes[' in cpp and 'ResourceAttributes[' in cpp
    assert '] = ' in cpp

def test_custom_range_inputs_take_dates_or_expressions_and_update_picker_label():
    ui = read("src/static/app_traces.js")
    picker = read("src/static/app_timerange.js")
    html = read("src/static/traces.html")
    # Free text From / To (absolute dates or Grafana expressions such as
    # now-6h), no native datetime control with min / max fighting the user.
    assert 'type="datetime-local"' not in html
    assert '<input id="tracesRangeStart" class="timeRangeField__input" type="text"' in html
    assert '<input id="tracesRangeEnd" class="timeRangeField__input" type="text"' in html
    assert 'function parseTime(text, roundUp, nowMs = Date.now())' in picker
    assert 'function applyDateMath(source, math, roundUp)' in picker
    assert 'function formatCustomRangeLabel()' in ui
    assert 'function refreshCustomRangeLabel()' in ui
    assert 'option.textContent = formatCustomRangeLabel()' in ui
    assert 'button.textContent = relative ? `Time range · ${text}` : text;' in picker
    assert 'id="tracesCustomRangeApply"' in html
    assert 'async function applyCustomRange(raw, source = "form")' in ui
