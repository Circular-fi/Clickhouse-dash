from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]
PAGES = ["query.html", "explorer.html", "observability.html", "trace.html", "system.html", "shape.html"]


def read(rel):
    return (ROOT / rel).read_text()


def test_page_switcher_ships_visible_in_every_shell():
    for page in PAGES:
        html = read(f"src/static/{page}")
        assert '<div id="pageSelect" class="themeSelect pageSelect" aria-label="Page">' in html, page
        assert 'aria-label="Page" hidden' not in html, page
        # The System page (and a query shape's, which belongs to it) is itself an entry: its switcher never hides.
        if page in ("system.html", "shape.html"):
            continue
        assert 'localStorage.getItem("chdash.pageNav.v1")' in html, page
        assert 'classList.add("chdash-page-select-hidden")' in html, page
        assert "pageNav.system === false" in html, page
    ui = read("src/static/app_ui.js")
    state = read("src/static/app_state.js")
    css = css_sources.text()
    assert "function applyPageNavigation(nav)" in ui
    assert 'dom.root?.classList.toggle("chdash-page-select-hidden", hidden);' in ui
    assert "storage?.savePageNav?.({ explorer: explorerEnabled, system: systemEnabled, traces: tracesEnabled, logs: logsEnabled, metrics: metricsEnabled });" in ui
    assert "const hidden = !explorerEnabled && !systemEnabled && !observabilityEnabled;" in ui
    assert "if (dom.navSystemButton) dom.navSystemButton.hidden = !systemEnabled;" in ui
    # The Observability shell picks its view, and the tabs of the enabled views, from the same cache.
    html = read("src/static/observability.html")
    assert 'var enabled = views.filter(function (name) { return !pageNav || pageNav[name] === true; });' in html
    assert "document.documentElement.dataset.obsView = view;" in html
    assert 'document.documentElement.dataset.obsEnabled = enabled.join(" ");' in html
    assert 'const PAGE_NAV_STORAGE_KEY = "chdash.pageNav.v1";' in state
    assert "html.chdash-page-select-hidden .pageSelect {" in css


def test_stylesheet_is_parser_inserted_so_it_blocks_first_paint():
    for page in PAGES:
        html = read(f"src/static/{page}")
        assert "document.write('<link rel=\"stylesheet\" href=\"' + cssHref + '\">');" in html, page
        assert 'css.href = window.__chdashUrl("static/style.css");' not in html, page


def test_trace_pickers_ship_in_their_final_markup():
    html = read("src/static/observability.html")
    js = read("src/static/app_traces.js")
    for select_id in ["tracesRangeUnit", "tracesStatus", "tracesService", "tracesOperation", "tracesLimit", "tracesSort"]:
        start = html.index(f'<select id="{select_id}"')
        root = html.rindex('<div class="themeSelect tracePicker', 0, start)
        assert html.index("</select>", start) < html.index('class="button themeSelect__button tracePicker__button"', start), select_id
        assert html[root:start].count("<") == 1, select_id
        assert 'class="tracePicker__native"' in html[start:html.index(">", start)], select_id
    assert '<div class="themeSelect tracePicker tracePicker--range">' in html
    assert 'Time range · Last 1 hour</button>' in html
    assert 'Status · All</button>' in html
    assert 'Results · 50</button>' in html
    # ns.menu.select (app_ui_menu.js) adopts the shipped markup.
    assert "return ns.menu?.select(select) || null;" in js
    menu = read("src/static/app_ui_menu.js")
    assert 'const shipped = selectEl.parentElement?.classList.contains("tracePicker") ? selectEl.parentElement : null;' in menu


def test_every_shell_header_lists_every_page_and_no_legacy_shell_remains():
    # "/" is served by the Query shell (serve_query_shell): the former
    # index.html copy of query.html drifted (no Observability entry) and is gone.
    assert not (ROOT / "src/static/index.html").exists()
    server = read("src/server.cpp")
    assert 'http_.Get("/", serve_query_shell);' in server
    assert 'path = "/index.html"' not in server + read("src/serve_embedded_static.hpp")
    for page in PAGES:
        html = read(f"src/static/{page}")
        for button in ("navQueryButton", "navExplorerButton", "navObservabilityButton", "navSystemButton"):
            assert f'id="{button}"' in html, (page, button)
