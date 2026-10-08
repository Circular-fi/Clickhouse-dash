"""Source contract of the Observability pages: Traces, Logs and Metrics, each a page of its own."""
import re
import json
from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]
VIEWS = ("traces", "logs", "metrics")


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_each_view_is_served_as_its_own_page_and_the_bare_address_redirects():
    server = read("src/server.cpp")
    block = server[server.index('  if (cfg_.traces.enabled) {\n    http_.Get(R"(/observability/traces/?)"'):]
    block = block[:block.index("\n\n")]
    assert 'http_.Get(R"(/observability/traces/?)", serve_view_shell("traces.html"));' in block
    assert 'http_.Get(R"(/observability/traces/[^/]+/?)", serve_trace_shell);' in block
    assert 'if (cfg_.logs.enabled) http_.Get(R"(/observability/logs/?)", serve_view_shell("logs.html"));' in block
    assert 'if (cfg_.metrics.enabled) http_.Get(R"(/observability/metrics/?)", serve_view_shell("metrics.html"));' in block
    # The bare address, a view turned off and an unknown one go to the first enabled view, the query kept.
    assert 'http_.Get("/observability", redirect_to_first_view);' in block
    assert 'http_.Get(R"(/observability/.*)", redirect_to_first_view);' in block
    assert "location += req.target.substr(mark);" in server
    assert "observability.html" not in server
    for old in ('"/traces"', '"/logs"', '"/metrics"', 'R"(/traces/.*)"', 'R"(/metrics/.*)"'):
        assert old not in server, old
    for name in ("observability.html", "app_observability.js", "app_traces_bootstrap.js", "app_logs_bootstrap.js", "app_metrics_bootstrap.js",
                 "style.observability.css", "style.observability.traces.css"):
        assert not (ROOT / "src/static" / name).exists(), name


def test_each_page_shell_holds_one_view_and_links_the_others():
    for view in VIEWS:
        html = read(f"src/static/{view}.html")
        assert '<body data-page="observability">' in html, view
        # Only this view's markup is in the page.
        assert f'data-obs-panel="{view}" class="obsView ' in html, view
        for other in VIEWS:
            if other != view:
                assert f'data-obs-panel="{other}"' not in html, (view, other)
                assert f'id="{other}Workspace"' not in html, (view, other)
        assert "<!-- observability:" not in html, view
        # The head script fixes the view before the first paint.
        assert f'var view = "{view}";' in html, view
        assert "document.documentElement.dataset.obsView = view;" in html, view
        assert f'window.__chdashUrl("static/style.{view}.css")' in html, view
        assert 'window.__chdashUrl("static/app_loader.js")' in html and 'window.__chdashUrl("static/app_obs_page.js")' in html, view
        # The row under the header: three links, this one current.
        header = html[html.index('<header class="appHeader"'):html.index("</header>")]
        assert "data-obs-tab" not in header and "data-trace-tab" not in header, view
        nav = html[html.index('<nav id="obsNav" class="obsNav"'):html.index("</nav>")]
        assert '<div id="obsTabs" class="contentTabs contentTabs--nav obsNav__views" role="group"' in nav, view
        for name in VIEWS:
            link = re.search(rf'<a class="contentTabs__tab([^"]*)"( aria-current="page")? id="obsTab-{name}" data-obs-tab="{name}" href="/observability/{name}">', nav)
            assert link, (view, name)
            assert ("is-active" in link.group(1)) == (name == view), (view, name)
            assert bool(link.group(2)) == (name == view), (view, name)
        assert 'tabs[i].setAttribute("href", window.__chdashUrl("observability/" + name));' in nav, view
        # Traces alone has its Search / Services / Service map tabs on the row.
        assert ('<div id="tracesTabs" class="contentTabs contentTabs--nav obsNav__sub" role="tablist"' in nav) == (view == "traces"), view
        assert html.index("</header>") < html.index('<nav id="obsNav"') < html.index('<main id="'), view
    css = css_sources.text()
    assert 'html:not([data-obs-view="logs"]) .obsView[data-obs-panel="logs"],' in css
    assert 'html:not([data-obs-view="traces"]) .obsNav__sub,' in css
    assert ".obsNav__sep:has(+ .obsNav__sub[hidden])" in css
    assert '{ attr: "traceTab", selected: current }' in read("src/static/app_trace_tabs.js")


def test_each_page_lists_its_own_modules_and_the_controller_starts_them_once():
    manifest = json.loads(read("src/static/modules.json"))["pages"]
    assert "observability" not in manifest
    base = ["app_api.js", "app_ui.js", "app_ui_filterbar.js", "app_timerange.js"]
    own = {
        "traces": ["app_chart_core.js", "app_facet_panel.js", "app_traces.js"],
        "logs": ["app_chart_core.js", "app_facet_panel.js", "app_logs.js"],
        "metrics": ["app_chart_core.js", "app_metrics.js"],
    }
    for view, names in own.items():
        page = manifest[view]
        assert page["bootstrap"] == "app_obs_page.js", view
        assert page["modules"][:4] == base, view
        for name in names:
            assert name in page["modules"], (view, name)
        for other, others in own.items():
            if other != view:
                for name in others:
                    if name not in names:
                        assert name not in page["modules"], (view, name)
        assert {name: files for name, files in page["lazy"].items() if not name.startswith("wasm-")} == {"highlight": ["app_highlight.js"]}, view
    js = read("src/static/app_obs_page.js")
    start = js[js.index("async function start() {"):]
    assert "await ns.loader.startModules();" in start
    assert start.index("await ns.loader.startModules();") < start.index("module?.init?.();")
    # The view's lifecycle scope opens before its module runs: it owns its URL from init() on.
    assert start.index("ns.lifecycle?.enter(view)") < start.index("module?.init?.();")
    assert "module?.onShow?.(scope);" in start
    assert 'const view = ns.loader.page.name;' in js


def test_one_history_listener_drives_the_page():
    js = read("src/static/app_obs_page.js")
    # Back / Forward reach the controller through ns.router (the one popstate listener).
    assert 'ns.router.on("/observability", () => viewModule()?.onLocation?.());' in js
    for name, module in (("traces", "app_traces.js"), ("logs", "app_logs.js"), ("metrics", "app_metrics.js")):
        source = read(f"src/static/{module}")
        assert '"popstate"' not in source and "ownsUrl" not in source, module
        assert f'ns.router.owner("{name}"' in source, module
        exported = source[source.index(f"ns.{name} = {{"):]
        for hook in ("init", "onLocation", "onShow", "onHide", "getContext", "applyContext"):
            assert re.search(rf"\b{hook}\b", exported[:exported.index("}")]), (module, hook)
    assert 'ns.router.owner("traces", { path: SEARCH_ROUTE' in read("src/static/app_trace_search.js")
    assert 'const address = ns.router.owner("traces");' in read("src/static/app_trace_views.js")


def test_time_range_and_service_follow_from_page_to_page_and_other_filters_stay_per_view():
    js = read("src/static/app_obs_page.js")
    assert "function publish() {" in js and 'window.addEventListener("pagehide", publish);' in js
    assert "const context = viewModule()?.getContext?.();" in js
    assert "stored.rangeRev > seen.rangeRev" in js and "stored.serviceRev > seen.serviceRev" in js
    assert "viewModule()?.applyContext?.(url.searchParams, context);" in js
    # The last query string of each view restores its filters, when a page is reached from another one.
    assert "next.urls[view] = `${window.location.search}${window.location.hash}`;" in js
    assert "if (!fromObservability()) {" in js
    state = read("src/static/app_state.js")
    assert "const observabilityContext = pref(KEYS.observabilityContext," in state
    assert "session: true," in state[state.index("const observabilityContext"):state.index("const storage = {")]


def test_switcher_is_the_same_in_every_shell_and_the_row_is_plain_links():
    for page in ("query.html", "explorer.html", "traces.html", "logs.html", "metrics.html", "system.html"):
        html = read(f"src/static/{page}")
        assert 'id="navObservabilityButton" class="themeSelect__option" type="button" role="option" data-value="observability"' in html, page
        for old in ("navTracesButton", "navLogsButton", "navMetricsButton"):
            assert old not in html, (page, old)
    for module in ("app_dom.js", "app_ui.js", "app_explorer.js", "app_traces.js", "app_logs.js", "app_metrics.js"):
        source = read(f"src/static/{module}")
        for old in ("navTracesButton", "navLogsButton", "navMetricsButton", 'route("traces")', 'route("logs")', 'route("metrics")'):
            assert old not in source, (module, old)
    js = read("src/static/app_obs_page.js")
    # A view link is followed by the browser: nothing intercepts it, nothing switches views in place.
    assert "onDocumentClick" not in js and "detachViews" not in js and "ensureSheet" not in js
    # A view turned off by the server sends the page to the first enabled one.
    assert 'window.location.replace(ns.api.resolveUrl(`observability/${enabled[0]}`))' in js


def test_a_route_handler_never_calls_a_local_lambda_it_holds_by_reference():
    # The handlers outlive the Server constructor: a [&] handler that calls another local lambda keeps a
    # reference to a destroyed object (v2.16.3 answered /observability with "no observability view is
    # enabled" in the release build, whatever the configuration said).
    server = read("src/server.cpp")
    assert "first_observability_view" not in server
    view = server[server.index("const auto redirect_to_first_view = [&](const auto& req, auto& res) {"):]
    view = view[:view.index("  // One trace is a page of its own")]
    assert "cfg_.traces.enabled" in view and "cfg_.logs.enabled" in view and "cfg_.metrics.enabled" in view
    assert "[&, serve_view_shell](const auto& req, auto& res) {" in server
    for handler in re.findall(r"http_\.Get\([^\n]*\[(&[^\]]*)\]\(const auto& req, auto& res\)[^\n]*redirect_in_explorer\(", server):
        assert handler == "&, redirect_in_explorer", handler
    assert server.count("[&, redirect_in_explorer]") >= 5

