"""Source contract of the Observability page: Traces, Logs and Metrics as views of /observability."""
import re
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VIEWS = ("traces", "logs", "metrics")


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_one_shell_is_served_while_a_view_is_enabled_and_the_old_pages_are_gone():
    server = read("src/server.cpp")
    block = server[server.index("  if (cfg_.traces.enabled || cfg_.logs.enabled || cfg_.metrics.enabled) {"):]
    block = block[:block.index("  }\n")]
    assert 'http_.Get("/observability", serve_observability_shell);' in block
    assert 'http_.Get(R"(/observability/.*)", serve_observability_shell);' in block
    assert 'shell_req.path = "/observability.html";' in server
    for old in ('"/traces"', '"/logs"', '"/metrics"', 'R"(/traces/.*)"', 'R"(/metrics/.*)"', "traces.html", "logs.html", "metrics.html"):
        assert old not in server, old
    for name in ("traces.html", "logs.html", "metrics.html", "app_traces_bootstrap.js", "app_logs_bootstrap.js", "app_metrics_bootstrap.js",
                 "style.traces.css", "style.logs.css", "style.metrics.css"):
        assert not (ROOT / "src/static" / name).exists(), name


def test_shell_holds_every_view_marked_and_shows_one_from_the_first_paint():
    html = read("src/static/observability.html")
    assert '<body data-page="observability">' in html
    for view in VIEWS:
        start = html.index(f"<!-- observability:{view} -->")
        end = html.index(f"<!-- /observability:{view} -->")
        assert f'data-obs-panel="{view}" class="obsView ' in html[start:end], view
        assert f'id="obsTab-{view}" data-obs-tab="{view}"' in html, view
    # The head script picks the view (path, else the first enabled one) before the first paint.
    assert "var match = /^\\/observability\\/(traces|logs|metrics)(?:\\/|$)/.exec(" in html
    assert "document.documentElement.dataset.obsView = view;" in html
    assert 'window.__chdashUrl("static/app_loader.js")' in html
    assert 'window.__chdashUrl("static/app_observability.js")' in html
    css = read("src/static/style.css")
    assert 'html:not([data-obs-view="logs"]) .obsView[data-obs-panel="logs"],' in css
    # The view tabs are a row under the header (not in it), the Explorer view
    # tab component, with the Traces sub-tabs after them on the same row.
    header = html[html.index('<header class="appHeader"'):html.index("</header>")]
    assert "data-obs-tab" not in header and "data-trace-tab" not in header
    nav = html[html.index('<nav id="obsNav" class="obsNav"'):html.index("</nav>")]
    assert html.index("</header>") < html.index('<nav id="obsNav"') < html.index("<!-- observability:traces -->")
    assert '<div id="obsTabs" class="viewTabs obsNav__views" role="tablist"' in nav
    assert '<div id="tracesTabs" class="viewTabs obsNav__sub" role="tablist"' in nav
    assert nav.index('id="obsTabs"') < nav.index('class="obsNav__sep"') < nav.index('id="tracesTabs"')
    # The inline script marks the view's tab and hides the disabled ones before the first paint.
    assert 'tabs[i].hidden = enabled.indexOf(name) < 0;' in nav
    assert 'tabs[i].classList.toggle("is-active", selected);' in nav
    assert 'html:not([data-obs-view="traces"]) .obsNav__sub,' in css
    assert ".obsNav__sep:has(+ .obsNav__sub[hidden])" in css
    assert '{ attr: "traceTab", tier: "view", selected: current }' in read("src/static/app_trace_tabs.js")


def test_views_load_lazily_once_with_their_stylesheet():
    js = read("src/static/app_observability.js")
    views = json.loads(read("src/static/modules.json"))["pages"]["observability"]["views"]
    assert sorted(views) == sorted(VIEWS)
    assert "const loading = loader.loadGroup(view);" in js
    assert "if (!viewLoads.has(view)) {" in js
    assert "await Promise.all([loadView(view), ensureSheet(view)]);" in js
    # The page starts on the common modules only; a view's modules come with its first show.
    start = js[js.index("async function start() {"):]
    assert "await loader.startModules();" in start
    # The other views' markup leaves the document before any module runs, and comes back on first show.
    assert start.index("detachViews(view);") < start.index("await loader.startModules();")
    assert "window.ChDash.dom?.refresh?.();" in js
    assert "dom.refresh = () => {" in read("src/static/app_dom.js")
    assert "loadGroup(" not in start
    # A view is initialised once, then told about the location.
    assert "if (!ctl.started.has(view)) {" in js
    assert "module?.init?.();" in js and "module?.onLocation?.();" in js


def test_one_history_listener_drives_the_views():
    js = read("src/static/app_observability.js")
    # Back / Forward reach the controller through ns.router (the one popstate
    # listener); it writes the view switches.
    assert 'router().on("/observability", onPopState);' in js
    assert "router().write(history, null, { href: targetUrl(view, url), view, state: fresh });" in js
    # The view's lifecycle scope opens before its module runs: it owns its URL from init() on.
    show = js[js.index("async function show("):js.index("// An observability URL of another view")]
    assert show.index("window.ChDash.lifecycle?.enter(view)") < show.index("module?.init?.();")
    for name, module in (("traces", "app_traces.js"), ("logs", "app_logs.js"), ("metrics", "app_metrics.js")):
        source = read(f"src/static/{module}")
        assert '"popstate"' not in source and "ownsUrl" not in source, module
        assert f'ns.router.owner("{name}"' in source, module
        exported = source[source.index(f"ns.{name} = {{"):]
        for hook in ("init", "onLocation", "onShow", "onHide", "getContext", "applyContext"):
            assert re.search(rf"\b{hook}\b", exported[:exported.index("}")]), (module, hook)
    # Hidden views never write the location: every Traces module writes
    # through the Traces owner, which is active only while its scope shows.
    assert 'ns.router.owner("traces", { path: "/observability/traces"' in read("src/static/app_trace_search.js")
    assert 'const address = ns.router.owner("traces");' in read("src/static/app_trace_views.js")


def test_time_range_and_service_are_shared_and_other_filters_stay_per_view():
    js = read("src/static/app_observability.js")
    assert "function publish(view) {" in js
    assert "const context = viewModule(view)?.getContext?.();" in js
    assert "shared.rangeRev > seen.rangeRev" in js and "shared.serviceRev > seen.serviceRev" in js
    assert "viewModule(view)?.applyContext?.(url.searchParams, context);" in js
    # The last URL of each view restores its filters.
    assert "ctl.urls[leaving] = currentUrl();" in js
    assert "const url = new URL(explicit || ctl.urls[view] || viewRoute(view), window.location.href);" in js


def test_switcher_is_the_same_in_every_shell_and_links_open_views_in_place():
    for page in ("query.html", "explorer.html", "observability.html"):
        html = read(f"src/static/{page}")
        assert 'id="navObservabilityButton" class="themeSelect__option" type="button" role="option" data-value="observability"' in html, page
        for old in ("navTracesButton", "navLogsButton", "navMetricsButton"):
            assert old not in html, (page, old)
    for module in ("app_dom.js", "app_ui.js", "app_explorer.js", "app_traces.js", "app_logs.js", "app_metrics.js"):
        source = read(f"src/static/{module}")
        for old in ("navTracesButton", "navLogsButton", "navMetricsButton", 'route("traces")', 'route("logs")', 'route("metrics")'):
            assert old not in source, (module, old)
    js = read("src/static/app_observability.js")
    assert 'document.addEventListener("click", onDocumentClick);' in js
    assert "if (open(link.getAttribute(\"href\"))) event.preventDefault();" in js
