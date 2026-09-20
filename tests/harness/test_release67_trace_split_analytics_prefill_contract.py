from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()

def test_trace_analytics_can_be_disabled_and_has_own_route():
    cfg = read("src/config.cpp")
    server_h = read("src/server.hpp")
    server = read("src/server.cpp")
    cpp = read("src/api_traces.cpp")
    example = read("config.example.hcl")
    assert "bool analytics = false;" in server_h
    assert '"analytics"' in cfg
    assert 'http_.Get("/api/traces/analytics"' in server
    assert "trace_analytics_disabled" in cpp
    assert 'w.Key("analytics_enabled")' in cpp
    assert "analytics                = false" in example

def test_search_route_never_runs_graph_analytics():
    cpp = read("src/api_traces.cpp")
    search = cpp[cpp.index("void Server::handle_traces_search"):cpp.index("void Server::handle_traces_analytics")]
    assert "quantileTDigest" not in search
    assert "trace_count_chart" not in search
    assert "duration_quantiles" not in search
    assert "read_analytics" not in search

def test_time_range_change_prefills_automatically_and_manual_prefill_button_is_gone():
    html = read("src/static/traces.html")
    js = read("src/static/app_traces.js")
    api = read("src/static/app_api.js")
    assert 'id="tracesPrefillButton"' not in html
    assert 'id="tracesTagsButton"' not in html
    assert 'getTraceTags' not in api
    assert "prefillForSelectedRange" in js
    assert 'tracesRangeUnit?.addEventListener("change"' in js
    assert 'tracesRangeStart?.addEventListener("input", refreshCustomInputs)' in js
    assert 'tracesRangeStart?.addEventListener("change", refreshCustomInputs)' in js
    assert 'tracesRangeEnd?.addEventListener("input", refreshCustomInputs)' in js
    assert 'tracesRangeEnd?.addEventListener("change", refreshCustomInputs)' in js
    assert 'syncCustomRangeBounds();' in js
    assert 'tracesCustomRangeApply?.addEventListener("click"' in js
    assert 'await prefillForSelectedRange();' in js
    assert "getTraceAnalytics" in api
    assert "void loadAnalytics(filters);" in js


def test_empty_trace_period_disables_service_operation_pickers_without_chevron():
    html = read("src/static/traces.html")
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert 'id="tracesService" data-field-label="Service" data-disable-when-empty="1"' in html
    assert 'id="tracesOperation" data-field-label="Operation" data-disable-when-empty="1"' in html
    assert 'const disableWhenEmpty = select.dataset.disableWhenEmpty === "1";' in js
    assert 'const unavailable = !!select.disabled || (disableWhenEmpty && !hasValues);' in js
    assert 'root.classList.toggle("is-empty", disableWhenEmpty && !hasValues);' in js
    assert '.tracePicker.is-empty .tracePicker__button::after' in css
    assert 'display: none !important;' in css

def test_status_and_results_are_fixed_120px_and_search_button_is_fixed():
    html = read("src/static/traces.html")
    css = read("src/static/style.css")
    assert html.index('traceSearchField--status') < html.index('traceSearchField--service')
    assert '.traceSearchField--status > .tracePicker {' in css
    assert 'width: 120px !important;' in css
    assert '.traceSearchField--limit,' in css
    assert 'width: 160px !important;' in css
    assert 'grid-template-areas:' in css
    assert '"range status service operation"' in css
    assert '"tags tags limit search"' in css


def test_result_limit_hides_values_above_server_limit():
    html = read("src/static/traces.html")
    js = read("src/static/app_traces.js")
    assert '<option value="250" hidden disabled>250</option>' in html
    assert '<option value="500" hidden disabled>500</option>' in html
    assert 'option.hidden = unavailable;' in js
    assert 'dom.tracesLimit.dispatchEvent(new Event("tracepicker-refresh"));' in js


def test_analytics_is_hidden_until_meta_explicitly_enables_it():
    html = read("src/static/traces.html")
    js = read("src/static/app_traces.js")
    css = read("src/static/style.css")
    assert 'id="traceAnalyticsGrid" class="traceAnalyticsGrid" aria-label="Trace analytics" hidden' in html
    assert 'const enabled = model.meta?.analytics_enabled === true;' in js
    assert 'if (model.meta?.analytics_enabled !== true)' in js
    assert '.traceAnalyticsGrid[hidden]' in css
