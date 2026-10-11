import json
import modules
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text(encoding="utf-8")


def test_one_query_shape_is_its_own_html_page_without_the_system_tabs():
    html = read("src/static/shape.html")
    system = read("src/static/system.html")
    assert '<body data-page="shape">' in html
    assert "static/style.shape.css" in html
    # The page header stays, filed under System; the section tabs and the list do not.
    assert '<header class="appHeader" role="banner">' in html
    assert 'id="navSystemLink" class="pageNav__link" href="/system" aria-current="page"' in html
    assert 'id="systemTabs"' not in html and "systemTab-" not in html and 'class="systemPage__nav"' not in html
    assert 'id="systemPage" class="systemPage" aria-label="Query shape page"></section>' in html
    assert 'id="systemTabs"' in system
    assert '"/system/queries/' not in system


def test_the_shape_page_loads_the_queries_section_and_no_other():
    files = modules.page_files("shape")
    assert files[-1] == "app_page_shape.js"
    for name in ("app_system_view.js", "app_system_queries.js", "app_timerange.js", "app_chart_core.js", "app_ui_filterbar.js"):
        assert name in files, name
    for name in ("app_system_overview.js", "app_system_disks.js", "app_system_activity.js", "app_system_perf.js", "app_explorer_treemap.js"):
        assert name not in files, name
    view = read("src/static/app_system_view.js")
    assert "function mountSection(root, options = {}) {" in view
    assert "if (nav) nav.after(bar.form);" in view and "shape: String(options.shape || \"\")," in view
    assert "const nav = options.shape ? null : $(\".systemPage__nav\", root);" in view
    # The shape's time range and refresh button live in its head (systemQuery__head), no title or hash copy.
    queries = read("src/static/app_system_queries.js")
    assert 'h("div", { class: "systemQuery__tools traceSearchBar obsFilterBar" }, pickerRoot.parentElement, controls.button)' in queries
    head = queries[queries.index('const head = h("header", { class: "systemQuery__head" },'):queries.index("const children = [head];")]
    assert "shapeTools," in head and "drillActions(data)" in head
    # The same arrow as the trace page's (.pageBack), no "All queries" label, no example note, no raw copy.
    assert 'class: "pageBack", id: "systemQueryBack"' in queries and 'icon.el("arrow-left", { size: "lg" })' in queries
    assert 'class="pageBack"' in read("src/static/trace.html")
    assert "All queries" not in queries.replace("// \"All queries\"", "") and "Copy as logged" not in queries and "systemQuery__example" not in queries
    # The figures sit beside the query on a wide screen, under it otherwise.
    assert 'h("div", { class: "systemQuery__top" }, sql, drillTiles(data), drillCharts()), drillRuns(data)' in queries
    assert 'grid-template-areas: "sql tiles" "charts charts";' in read("src/static/css/20-features/system.css")
    # The SQL has line numbers and the Query editor's colours (function and keyword lists of the host), no wrapping.
    assert "gutter: true, copy: true, maxLines: 14" in queries and "wrap: true, maxLines" not in queries
    assert "sqlBlock.highlighter()?.renderInto?.(code, code.textContent || \"\")" in queries and "ensureHighlighterMeta();" in queries
    shape = modules.page_files("shape")
    assert shape.index("app_api.js") < shape.index("app_meta.js")
    # No gap on a shape's page, and the light SQL colours reach 4.5:1 (tests/frontend/specs/ui-accessibility.spec.js measures them).
    css = read("src/static/css/20-features/system.css")
    assert ".systemQueries--shape {\n  gap: 0;\n}" in css and 'shapeMode && "systemQueries--shape"' in queries
    tokens = read("src/static/css/00-tokens.css")
    assert tokens.count("--sql-keyword: color-mix(in srgb, #60a5fa 60%, var(--text));") == 2 and tokens.count("--sql-keyword: color-mix(in srgb, #60a5fa 75%, var(--text));") == 2
    assert "document.title = `${line.length > 70 ? `${line.slice(0, 69)}\\u2026` : line} \\u00b7 Query shape`;" in queries
    assert "systemQuery__name" not in queries and "systemQuery__kind" not in queries and "systemQuery__copyHash" not in queries and "Copy the query hash" not in queries


def test_the_server_serves_the_shape_page_before_the_system_catch_all_and_redirects_the_former_address():
    server = read("src/server.cpp")
    assert 'shell_req.path = "/shape.html";' in server
    shape = server.index('http_.Get(R"(/system/queries/[0-9]{1,20}/?)", serve_shape_shell);')
    assert shape < server.index('http_.Get(R"(/system/.*)", redirect_to_system_overview);')
    assert "if (cfg_.system.top_queries_enabled()) {\n      // Registered before /system/.*" in server
    assert "query_shape_location(req.target, req.get_param_value(\"q\"))" in server
    assert 'return "queries/" + hash + rest;' in server


def test_a_row_opens_the_shape_page_and_the_shape_page_returns_to_the_list():
    queries = read("src/static/app_system_queries.js")
    assert "const shapeMode = !!ctx.shape;" in queries and 'q: shapeMode ? ctx.shape : "",' in queries
    assert "ctx.openShape(String(hash));" in queries and "ctx.back();" in queries
    assert 'if (state.q) params.set("q", state.q);' not in queries
    assert "ctx.openShape(former, { replace: true });" in queries
    controller = read("src/static/app_page_shape.js")
    assert 'const SHAPE_PATH = /^\\/system\\/queries\\/(\\d{1,20})\\/?$/;' in controller
    assert "function markOpenedFromList()" in controller and "router().back(steps);" in controller
    assert "window.location.assign(listHref());" in controller
    assert 'router().on("/system", onPopState);' in controller
    system = read("src/static/app_system.js")
    assert "onOpenShape: (hash, { replace = false } = {}) => {" in system
    ui = read("src/static/app_header.js") + read("src/static/app_query_ui.js")
    assert '["system", "shape"].includes(document.body?.dataset?.page)' in ui
