from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_duration_ticks_helper_exists_for_trace_overview_and_waterfall():
    ui = read("src/static/app_traces.js")
    assert "function durationTicks(" in ui
    assert "durationTicks(bounds.duration, 5)" in ui
    assert "durationTicks(total, 5)" in ui

def test_service_operation_placeholders_are_clean_and_status_labels_uppercase():
    html = read("src/static/traces.html")
    assert 'placeholder="Service"' in html
    assert 'placeholder="Operation"' in html
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

def test_custom_range_commits_label_into_picker_and_closes_popover():
    ui = read("src/static/app_traces.js")
    assert 'function formatCustomRangeLabel()' in ui
    assert 'option.textContent = formatCustomRangeLabel()' in ui
    assert 'dom.tracesCustomRange.hidden = true' in ui
