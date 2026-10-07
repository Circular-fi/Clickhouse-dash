"""One router (app_router.js, ns.router) owns the address bar and the session
history: no other script pushes or replaces history entries, goes Back, or
listens to popstate, and the per-module copies (ownsUrl, writeUrl, the base
path, the panel URL helpers) stay gone. The route scheme is documented in
docs/ui-foundations.md ("Routes")."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"
ROUTER = "app_router.js"

# Scripts that may touch the history or derive the base path besides the
# router. app_api.js builds API request URLs from the base path (resolveUrl).
BASE_PATH_ALLOWED = {ROUTER, "app_api.js"}

HISTORY_WRITES = re.compile(r"history\s*(?:\.\s*|\[\s*['\"])(?:pushState|replaceState|back|go|forward)\b")
POPSTATE = re.compile(r"['\"]popstate['\"]|\bonpopstate\b")


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def scripts():
    for path in sorted(STATIC.glob("*.js")):
        yield path.name, path.read_text(encoding="latin-1")


def inline_scripts():
    for path in sorted(STATIC.glob("*.html")):
        html = path.read_text(encoding="utf-8")
        for block in re.findall(r"<script(?![^>]*type=\"application/json\")[^>]*>(.*?)</script>", html, flags=re.S):
            yield path.name, block
    for path in sorted((ROOT / "src" / "shell").glob("*.html")):
        yield path.name, path.read_text(encoding="utf-8")


def code(text: str) -> str:
    """The script without its comments (a comment may name the APIs)."""
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return re.sub(r"(?m)(^|[^:\\'\"`])//.*$", r"\1", text)


def test_only_the_router_writes_history_or_listens_to_popstate():
    offenders = []
    for name, text in [*scripts(), *inline_scripts()]:
        if name == ROUTER:
            continue
        body = code(text)
        if HISTORY_WRITES.search(body):
            offenders.append(f"{name}: {HISTORY_WRITES.search(body).group(0)}")
        if POPSTATE.search(body):
            offenders.append(f"{name}: popstate")
    assert not offenders, offenders


def test_the_router_holds_the_one_popstate_listener():
    router = code(read(f"src/static/{ROUTER}"))
    assert router.count('window.addEventListener("popstate", onPopState);') == 1
    assert len(POPSTATE.findall(router)) == 1
    for api in ("pushState", "replaceState"):
        assert router.count(f"window.history.{api}(") == 1, api
    assert "ns.router = Object.freeze({ base, url, path, href, current, state, push, replace, write, back, on, owner, panel, debug });" in router
    # One history state shape: { chdash: 1, view, ...owner state }.
    assert "clean({ chdash: 1, view, ...(opts.state || {}) })" in router
    assert "clean({ ...prev, chdash: 1, view, ...(opts.state || {}) })" in router
    # Hidden owners never write: the owner's lifecycle scope must be shown.
    assert "return !life || !!life.current(String(view));" in router
    assert 'if (mode === "none" || !active()) return false;' in router


def test_router_loads_right_after_app_dom_on_every_page():
    common = json.loads(read("src/static/modules.json"))["common"]
    assert common.index(ROUTER) == common.index("app_dom.js") + 1
    for page in ("query", "explorer", "traces", "logs", "metrics", "system"):
        html = read(f"src/static/{page}.html")
        manifest = json.loads(re.search(r'<script type="application/json" id="chdashModules">(.*?)</script>', html, flags=re.S).group(1))
        assert ROUTER in manifest["common"], page


def test_module_copies_of_the_url_helpers_are_gone():
    offenders = []
    for name, text in scripts():
        if name == ROUTER:
            continue
        body = code(text)
        for pattern in (r"\bownsUrl\b", r"\bfunction writeUrl\b", r"\.writeUrl\b", r"\bfunction appBasePath\b",
                        r"\burlParam\(", r"\bobsView:\s"):
            if re.search(pattern, body):
                offenders.append(f"{name}: {pattern}")
        if "__CHDASH_BASE_PATH__" in body and name not in BASE_PATH_ALLOWED:
            offenders.append(f"{name}: __CHDASH_BASE_PATH__")
    assert not offenders, offenders


def test_the_time_range_parameters_go_through_one_helper():
    # from / to are read and written by ns.timeRange.url (app_timerange.js),
    # which reads the current address through ns.router.
    timerange = read("src/static/app_timerange.js")
    assert "read(params = ns.router.current().params) {" in timerange
    for name in ("app_traces.js", "app_trace_search.js", "app_logs.js", "app_metrics.js", "app_obs_page.js"):
        body = read(f"src/static/{name}")
        assert not re.search(r"""\.(?:get|set|has|delete)\(["'](?:from|to)["']""", body), name
        assert "timeRange.url." in body, name
    for name in ("app_logs.js", "app_metrics.js"):
        assert "window.location.search" not in read(f"src/static/{name}"), name


def test_every_writer_is_an_owner_or_a_panel():
    owners = {
        "app_logs.js": 'ns.router.owner("logs", { path: "/observability/logs", params: () => urlParams() })',
        "app_metrics.js": 'ns.router.owner("metrics", { path: "/observability/metrics", params: () => urlQuery() })',
        "app_trace_search.js": 'ns.router.owner("traces", { path: SEARCH_ROUTE, params: () => (ctx && !ctx.detail ? currentParams() : null) })',
        "app_explorer.js": 'router.owner("explorer", { view: () => model.active })',
        "app_ui.js": 'ns.router.owner("query", { view: null }).replace({ saved: savedId, sql })',
    }
    for name, owner in owners.items():
        assert owner in read(f"src/static/{name}"), name
    panels = {
        "app_logs.js": 'address.panel("log")',
        "app_trace_spans.js": 'ns.router.owner("traces").panel("span")',
        "app_trace_map.js": 'ns.router.owner("traces").panel("node")',
        "app_trace_services.js": 'ns.router.owner("traces").panel("svc")',
    }
    for name, panel in panels.items():
        assert panel in read(f"src/static/{name}"), name
    # Back / Forward handlers: the Observability controller, the Explorer and
    # the query result's row details.
    assert 'ns.router.on("/observability", () => viewModule()?.onLocation?.());' in read("src/static/app_obs_page.js")
    assert 'router.on("/explorer", () => { void applyRouteFromLocation(); });' in read("src/static/app_explorer.js")
    assert 'disposers.push(ns.router.on("", () => closeRowDetails()));' in read("src/static/app_results.js")


def test_routes_are_documented():
    doc = read("docs/ui-foundations.md")
    assert "\n## Routes\n" in doc
    routes = doc[doc.index("\n## Routes\n"):]
    routes = routes[: routes.find("\n## ", 1)] if routes.find("\n## ", 1) > 0 else routes
    for token in ("`/explorer/catalog/<db>/<object>", "`?tab=", "`?mode=", "`?graph=", "`?depth=", "`/observability/traces/<traceId>",
                  "`span=", "`log=", "`node=", "`svc=", "`panel=", "`?saved=", "`?sql=", "?view=", "ns.router"):
        assert token in routes, token
