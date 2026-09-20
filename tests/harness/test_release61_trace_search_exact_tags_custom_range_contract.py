from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_duration_ticks_helper_exists_for_trace_overview_and_waterfall():
    ui = read("src/static/app_traces.js")
    assert "function durationTicks(" in ui
    assert "durationTicks(bounds.duration, 5)" in ui
    assert "durationTicks(total, 5)" in ui

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

def test_custom_range_keeps_datetime_inputs_visible_and_updates_picker_label():
    ui = read("src/static/app_traces.js")
    html = read("src/static/traces.html")
    assert 'type="datetime-local"' in html
    assert 'function formatCustomRangeLabel()' in ui
    assert 'function refreshCustomRangeLabel()' in ui
    assert 'option.textContent = formatCustomRangeLabel()' in ui
    assert 'dom.tracesCustomRange.hidden = !(custom && model.customRangeOpen)' in ui
    assert 'id="tracesCustomRangeApply"' in html
    assert 'function applyCustomRange()' in ui
