"""Shared UI infrastructure: one way to do each of these, and no local copy.

- ns.uiState (app_ui_state.js): empty, error and loading states, the error
  banner, the busy convention and the one spinner.
- ns.features (app_state.js): every feature flag read, one defaults table.
- api.request (app_api.js): every request, an AbortSignal on each call;
  util.latest: superseded requests are aborted and their answers ignored.
- storage.pref and storage.KEYS (app_state.js): every browser storage access.
- ns.search (app_ui_search.js): every search field, one delay, one look.
- util.escapeHtml: the one escaper.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def sources() -> dict[str, str]:
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(STATIC.glob("*.js"))}


def shells() -> str:
    return "".join(read(f"src/static/{page}.html") for page in ("query", "explorer", "observability"))


def block(css: str, name: str) -> str:
    return css[css.index(f"/* ==== Components: {name}"):css.index(f"/* ==== /Components: {name}")]


def test_one_state_component_and_no_local_state_markup():
    state = read("src/static/app_ui_state.js")
    assert "ns.uiState = Object.freeze({ empty, error, loading, block, emptyHtml, errorHtml, loadingHtml, banner, busy, spinnerHtml, announce });" in state
    # Errors are alerts, loading is a busy status; a banner with Retry handles its own click.
    assert '''const role = kind === "error" ? ' role="alert"' : kind === "loading" ? ' role="status" aria-busy="true"' : "";''' in state
    assert 'container.setAttribute("role", level === "info" ? "status" : "alert");' in state
    assert 'el.setAttribute("aria-busy", "true");' in state
    css = read("src/static/style.css")
    comp = block(css, "state")
    for rule in (".uiState {", ".uiState__title {", ".uiBanner {", ".uiBanner--verbatim {", ".uiSpin {", "@keyframes uiSpin"):
        assert rule in comp, rule
    # One spinner keyframe, no raw colour in the block.
    assert len(re.findall(r"@keyframes \w*[Ss]pin\b", css)) == 1
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(", comp)
    # The former local states are gone (class names, helpers, markup).
    code = "".join(sources().values()) + shells()
    for gone in ("tracesEmpty", "class=\"tracesError", "tracesError__", "class=\"errorBanner", "className = \"errorBanner", "logsEmpty", "metricsEmpty", "traceSvcEmpty",
                 "traceMap__message", "class=\"explorerEmptyState", "traceChartError", "traceUnavailable",
                 "traceButtonSpinner", "traceDeltaSpinner", "traceSpanTable__spinner", "analysisEmpty", "traceViewer__empty",
                 "explorerEmptySection", "class=\"traceLogsState", "function setButtonLoading", "LOGS_RETRY"):
        assert gone not in code, gone
    for gone in (".tracesEmpty", ".tracesError", ".errorBanner", ".logsEmpty", ".metricsEmpty", ".traceSvcEmpty", ".traceMap__message",
                 ".explorerEmptyState", ".traceButtonSpinner", "traceSpin", "metricsSpin", "traceDeltaSpin", "traceSpanSpin"):
        assert gone not in css, gone
    # No jargon in the empty states.
    for jargon in ("runner ACL", "ACL boundary", "Map column", "ResourceAttributes[", "db.query.text / db.statement"):
        assert jargon not in code, jargon


def test_live_regions_are_small_and_tooltips_are_not_status():
    html = shells()
    # No whole pane is live: the Explorer detail panes and the trace detail.
    assert 'class="explorerDetailPane" aria-live' not in html and 'id="explorerDetailPane" class="explorerDetailPane" aria-live' not in html
    assert 'id="traceDetail" class="traceDetailPane traceDetailPane--jaeger" aria-live' not in html
    # One polite region for short status sentences (ns.uiState.announce).
    assert 'live.setAttribute("aria-live", "polite");' in read("src/static/app_ui_state.js")
    code = sources()
    for name in ("app_chart_core.js", "app_explorer_treemap.js"):
        assert not re.search(r"""tip\.setAttribute\("role", "status"\)|role="status"[^>]*Tip|Tip[^>]*role="status\"""", code[name]), name


def test_feature_flags_are_read_through_ns_features():
    state = read("src/static/app_state.js")
    assert "const FEATURE_DEFAULTS = Object.freeze({" in state
    assert "operations: { enabled: true, keeper: true }," in state
    assert "traces: { enabled: false }," in state
    assert "ns.features = Object.freeze(features);" in state
    for name, text in sources().items():
        if name == "app_state.js":
            continue
        assert "state.features" not in text and "state?.features" not in text, name
        assert '"chdash:features-changed", ' not in text or name == "app_ui.js", name
        assert "featuresLoaded" not in text, name


def test_requests_go_through_api_and_superseded_ones_are_aborted():
    api = read("src/static/app_api.js")
    assert "async function request(path, { method = \"GET\", body, signal } = {}) {" in api
    assert api.count("fetch(") == 1
    for name, text in sources().items():
        if name in ("app_api.js",):
            continue
        # The query library keeps its own request (If-Match revisions, LibraryError).
        if name != "app_query_library.js":
            assert not re.search(r"(?<![.\w])fetch\(", text), name
    util = read("src/static/app_util.js")
    assert "function latest(key) {" in util and "latestByKey.get(key)?.controller.abort();" in util
    # The views' stale-answer guards are util.latest, not hand-rolled sequences.
    code = sources()
    for name in ("app_logs.js", "app_metrics.js", "app_traces.js", "app_trace_logs.js", "app_trace_heatmap.js", "app_trace_map.js",
                 "app_trace_services.js", "app_trace_insights.js", "app_facet_panel.js"):
        assert not re.search(r"\bconst seq = \+\+", code[name]), name
        assert "util.latest(" in code[name], name


def test_browser_storage_goes_through_storage_pref():
    state = read("src/static/app_state.js")
    assert "const KEYS = Object.freeze({" in state and "function pref(key, fallback, options = {}) {" in state
    for name, text in sources().items():
        if name == "app_state.js":
            continue
        code = re.sub(r"//[^\n]*", "", text)
        assert "localStorage." not in code and "sessionStorage." not in code, name
        # Keys come from the one table.
        assert not re.search(r"""["']chdash\.[A-Za-z]+[A-Za-z0-9_.]*["']""", code.replace('"chdash.processors.json.v1"', "").replace('"chdash.trace.json.lod.v2"', "")), name


def test_search_fields_share_one_helper_one_delay_and_one_look():
    search = read("src/static/app_ui_search.js")
    assert "ns.search = Object.freeze({ bind, within });" in search
    assert "debounceMs = ns.util.SEARCH_DEBOUNCE_MS" in search
    code = sources()
    for name, needle in (("app_explorer.js", "ns.search.bind(dom.explorerFunctionSearchInput"), ("app_metrics.js", "ns.search.bind(search,"),
                         ("app_facet_panel.js", 'ns.search.bind(byId("search")'), ("app_timerange.js", "search.bind(quickSearch"),
                         ("app_trace_views.js", 'ns.search.within(tools, "#traceSpansFilter"'), ("app_trace_logs.js", 'ns.search.within(panel, "#traceLogsFilter"'),
                         ("app_query_library.js", "ns.search.bind(input,")):
        assert needle in code[name], name
    # No other debounce delay for typed input.
    for name, text in code.items():
        assert "const SEARCH_DEBOUNCE_MS = " not in text or name == "app_util.js", name
        # The former per-field timers (graph focus 200, picker search 350, library 160 / 260).
        for timer in ("graphSearchTimer", "filterSearchTimer", "searchTimer = setTimeout", "? 260 :"):
            assert timer not in text, (name, timer)
    css = read("src/static/style.css")
    comp = block(css, "search")
    assert ".uiSearch {" in comp and ".uiSearch--compact {" in comp


def test_one_html_escaper():
    for name, text in sources().items():
        if name == "app_util.js":
            continue
        assert not re.search(r"""replace\(/&/g, ["']&amp;["']\)""", text), name
        assert not re.search(r"""\[&<>"']/g""", text), name
