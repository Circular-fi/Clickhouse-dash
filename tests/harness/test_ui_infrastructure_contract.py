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
import css_sources

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def sources() -> dict[str, str]:
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(STATIC.glob("*.js"))}


def shells() -> str:
    return "".join(read(f"src/static/{page}.html") for page in ("query", "explorer", "traces", "logs", "metrics", "system"))


def block(css: str, name: str) -> str:
    return css_sources.component(name)


def test_one_state_component_and_no_local_state_markup():
    state = read("src/static/app_ui_state.js")
    assert "ns.uiState = Object.freeze({ empty, error, loading, block, emptyHtml, errorHtml, loadingHtml, banner, busy, spinnerHtml, announce });" in state
    # Errors are alerts, loading is a busy status; a banner with Retry handles its own click.
    assert '''const role = kind === "error" ? ' role="alert"' : kind === "loading" ? ' role="status" aria-busy="true"' : options.role === "status" ? ' role="status"' : "";''' in state
    assert 'container.setAttribute("role", level === "info" ? "status" : "alert");' in state
    assert 'el.setAttribute("aria-busy", "true");' in state
    css = css_sources.text()
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
    # The Explorer tree and lists, the System activity and the query library use it too.
    explorer = read("src/static/app_explorer.js")
    assert 'return ns.uiState.block(kind, kind === "loading" ? { label: text, compact: true } : { body: text, compact: true, retry, action });' in explorer
    assert 'label: "Clear the search"' in explorer
    # A failed database load waits for Retry: no reload on every render.
    assert "if (!loaded && !loading && !model.databaseLoadErrors.has(database)) queueMicrotask(() => void loadDatabaseTables(database));" in explorer
    assert "if (!error && !model.databaseTablesLoading.has(name)) void loadDatabaseTables(name);" in explorer
    assert 'listState("error", "Unable to load tables", () => void loadDatabaseTables(database, true))' in explorer
    ops = read("src/static/app_system_activity.js")
    assert "ns.uiState.busy(body, true);" in ops and 'setAttribute("aria-live"' not in ops
    library = read("src/static/app_query_library.js")
    assert "retry: () => void reloadStore(store).then(() => renderLibrary())" in library and "retry: () => void loadHistory()" in library
    assert 'retry: () => withQueryLibrary(fn)' in read("src/static/app_ui.js")
    for gone in ("explorerListEmpty", "explorerOpsView__error", "qlEmpty", "qlNotice--error", "explorerUnavailable"):
        assert gone not in code and gone not in css, gone
    # A refresh button is busy (spinner, aria-busy) while it reloads.
    assert "ns.uiState.busy(dom.explorerRefreshButton, true);" in explorer
    assert ".refreshButton.is-loading .refreshGlyph { display: none; }" in css
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
    assert "enabled: true, activity: true, keeper: true, top_queries: true, cluster_fanout: false," in state
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
    assert "async function request(path, { method = \"GET\", body, headers, signal } = {}) {" in api
    # Two fetch calls: the one request path, and the reader of the result event stream
    # (openEventStream: Chrome's EventSource takes as long again as the bytes do).
    assert api.count("fetch(") == 2
    assert 'const response = await fetch(this.url, { signal: this.abort.signal, headers: { Accept: "text/event-stream" }, cache: "no-store" });' in api
    # An HTTP error carries its status and the answer as sent (the library's
    # 409 conflict and validation fields).
    assert "err.status = response.status;" in api and "err.body = payload;" in api
    for name, text in sources().items():
        # app_wasm.js fetches the kernels (static files, never an API route).
        if name in ("app_api.js", "app_wasm.js"):
            continue
        assert not re.search(r"(?<![.\w])fetch\(", text), name
    # Routes are named endpoints of app_api.js: no module builds an "api/..."
    # URL, apart from the hosts EventSource and the query library's REST
    # adapter (its base path, through api.request).
    for name, text in sources().items():
        if name == "app_api.js":
            continue
        routes = re.findall(r"""["'`]api/[\w/-]*""", text)
        allowed = {"app_ui.js": ['"api/hosts/stream'], "app_query_library.js": ['"api/query-library']}.get(name, [])
        assert sorted(routes) == sorted(allowed), (name, routes)
    # The query library sends its If-Match revision through api.request, and
    # its list reloads are util.latest requests.
    library = sources()["app_query_library.js"]
    assert "ns.api.request(`${API_BASE}${path}`, { method, body, headers, signal })" in library
    assert "util.latest(`${LIBRARY_REQUEST}:${store.kind}`)" in library and "util.latest(HISTORY_REQUEST)" in library
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
                         ("app_facet_panel.js", 'ns.search.bind(part("search")'), ("app_timerange.js", "search.bind(quickSearch"),
                         ("app_trace_views.js", 'ns.search.within(tools, "#traceSpansFilter"'), ("app_trace_logs.js", 'ns.search.within(panel, "#traceLogsFilter"'),
                         ("app_query_library.js", "ns.search.bind(input,")):
        assert needle in code[name], name
    # No other debounce delay for typed input.
    for name, text in code.items():
        assert "const SEARCH_DEBOUNCE_MS = " not in text or name == "app_util.js", name
        # The former per-field timers (graph focus 200, picker search 350, library 160 / 260).
        for timer in ("graphSearchTimer", "filterSearchTimer", "searchTimer = setTimeout", "? 260 :"):
            assert timer not in text, (name, timer)
    css = css_sources.text()
    comp = block(css, "search")
    assert ".uiSearch {" in comp and ".uiSearch--compact {" in comp


def test_one_error_message_helper():
    # util.errorText turns an error into the reader's sentence; the Query
    # result (app_run.js) alone shows a server error verbatim, code included.
    util = read("src/static/app_util.js")
    assert 'function errorText(error, fallback = "The request failed.") {' in util
    assert "error.message = ns.util.errorText(error);" in read("src/static/app_api.js")
    verbatim = {"app_util.js": 1, "app_api.js": 1, "app_run.js": 5, "app_ui_state.js": 1, "app_download.js": 1}
    for name, text in sources().items():
        found = len(re.findall(r"instanceof Error \?", text))
        assert found <= verbatim.get(name, 0), (name, found)
        # app_api.js builds the errors; app_run.js keeps the Query result's.
        assert name in ("app_api.js", "app_run.js") or not re.search(r"\b(?:e|err|error)\??\.message \|\| ", text), name


def test_one_html_escaper():
    for name, text in sources().items():
        if name == "app_util.js":
            continue
        assert not re.search(r"""replace\(/&/g, ["']&amp;["']\)""", text), name
        assert not re.search(r"""\[&<>"']/g""", text), name


def test_frame_coalescing_uses_util_raf_once():
    """One animation-frame coalescer (util.rafOnce): no hand-written
    `if (!frame) frame = requestAnimationFrame(...)` in the migrated modules."""
    code = sources()
    for name, needle in (("app_logs.js", "util.rafOnce(() => renderWindow())"), ("app_traces.js", "util.rafOnce(() => renderWaterfall())"),
                         ("app_traces.js", "util.rafOnce(() => updateVirtualWindow())"), ("app_trace_views.js", "ns.util.rafOnce(() => markFocusedSpan())"),
                         ("app_trace_spans.js", "ns.util.rafOnce(() => updateWindow())"), ("app_chart_core.js", "ns.util.rafOnce(() => drawOverlay())"),
                         ("app_chart_core.js", "ns.util.rafOnce((p) => updateBox(p))"), ("app_pipeline_viewer.js", "ns.util.rafOnce(() => { if (root.isConnected) mountRows(); })")):
        assert needle in code[name], (name, needle)
    for name in ("app_logs.js", "app_traces.js", "app_trace_views.js", "app_trace_spans.js", "app_chart_core.js", "app_pipeline_viewer.js"):
        assert not re.search(r"if \(!\w+\) \w+ = requestAnimationFrame\(\(\) => \{ \w+ = 0;", code[name]), name
        assert not re.search(r"= requestAnimationFrame\(\(\) => \{\s*\w+(Frame|Raf) = 0;", code[name]), name


def test_plain_debounces_use_util_debounce():
    """A plain trailing delay is util.debounce (.cancel/.flush), not a
    hand-written clearTimeout/setTimeout pair."""
    code = sources()
    for name, needle in (("app_query_library.js", "util.debounce(() => loadHistory(), 150)"),
                         ("app_ui.js", "util.debounce(() => saveEditorDraft(dom.queryTextArea.value), 200)")):
        assert needle in code[name], (name, needle)
    for name, timer in (("app_query_library.js", "historyTimer"), ("app_ui.js", "draftSaveTimer")):
        assert timer not in code[name], (name, timer)
