"""Source contract of the Observability page: Traces, Logs and Metrics as views of /observability."""
import re
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
    assert 'window.__chdashUrl("static/app_observability.js")' in html
    css = read("src/static/style.css")
    assert 'html:not([data-obs-view="logs"]) .obsView[data-obs-panel="logs"],' in css
    assert 'html[data-obs-view="metrics"] .obsTabs__tab[data-obs-tab="metrics"] {' in css
    assert 'html:not([data-obs-enabled~="traces"]) .obsTabs__tab[data-obs-tab="traces"],' in css


def test_views_load_lazily_once_with_their_stylesheet():
    js = read("src/static/app_observability.js")
    assert "const VIEW_MODULES = {" in js
    assert "if (!viewLoads.has(view)) {" in js
    assert "await Promise.all([loadView(view), ensureSheet(view)]);" in js
    # The page starts on the common modules only; a view's modules come with its first show.
    start = js[js.index("async function start() {"):]
    assert "await loadModules(COMMON_MODULES);" in start
    assert "VIEW_MODULES[" not in start
    # A view is initialised once, then told about the location.
    assert "if (!ctl.started.has(view)) {" in js
    assert "module?.init?.();" in js and "module?.onLocation?.();" in js


def test_one_history_listener_drives_the_views():
    js = read("src/static/app_observability.js")
    assert 'window.addEventListener("popstate", onPopState);' in js
    assert 'window.history.pushState({ obsView: view }, "", next);' in js
    for name, module in (("traces", "app_traces.js"), ("logs", "app_logs.js"), ("metrics", "app_metrics.js")):
        source = read(f"src/static/{module}")
        assert '"popstate"' not in source, module
        assert f'const ownsUrl = () => !ns.observability || ns.observability.isActive("{name}");' in source, module
        exported = source[source.index(f"ns.{name} = {{"):]
        for hook in ("init", "onLocation", "onShow", "onHide", "getContext", "applyContext"):
            assert re.search(rf"\b{hook}\b", exported[:exported.index("}")]), (module, hook)
    # Hidden views never write the location.
    assert 'if (ns.observability && !ns.observability.isActive("traces")) return;' in read("src/static/app_trace_search.js")
    assert 'if (ns.observability && !ns.observability.isActive("traces")) return;' in read("src/static/app_trace_views.js")


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
