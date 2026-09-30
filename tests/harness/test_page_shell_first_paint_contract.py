from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGES = ["index.html", "query.html", "explorer.html", "traces.html"]


def read(rel):
    return (ROOT / rel).read_text()


def test_page_switcher_ships_visible_in_every_shell():
    for page in PAGES:
        html = read(f"src/static/{page}")
        assert '<div id="pageSelect" class="themeSelect pageSelect" aria-label="Page">' in html, page
        assert 'aria-label="Page" hidden' not in html, page
        assert 'localStorage.getItem("chdash.pageNav.v1")' in html, page
        assert 'classList.add("chdash-page-select-hidden")' in html, page
    ui = read("src/static/app_ui.js")
    state = read("src/static/app_state.js")
    css = read("src/static/style.css")
    assert "function applyPageNavigation(nav)" in ui
    assert 'dom.root?.classList.toggle("chdash-page-select-hidden", hidden);' in ui
    assert "storage?.savePageNav?.({ explorer: explorerEnabled, traces: tracesEnabled });" in ui
    assert 'const PAGE_NAV_STORAGE_KEY = "chdash.pageNav.v1";' in state
    assert "html.chdash-page-select-hidden .pageSelect {" in css


def test_stylesheet_is_parser_inserted_so_it_blocks_first_paint():
    for page in PAGES:
        html = read(f"src/static/{page}")
        assert "document.write('<link rel=\"stylesheet\" href=\"' + cssHref + '\">');" in html, page
        assert 'css.href = window.__chdashUrl("static/style.css");' not in html, page


def test_trace_pickers_ship_in_their_final_markup():
    html = read("src/static/traces.html")
    js = read("src/static/app_traces.js")
    for select_id in ["tracesRangeUnit", "tracesStatus", "tracesService", "tracesOperation", "tracesLimit", "tracesSort"]:
        start = html.index(f'<select id="{select_id}"')
        root = html.rindex('<div class="themeSelect tracePicker', 0, start)
        assert html.index("</select>", start) < html.index('class="button themeSelect__button tracePicker__button"', start), select_id
        assert html[root:start].count("<") == 1, select_id
        assert 'class="tracePicker__native"' in html[start:html.index(">", start)], select_id
    assert '<div class="themeSelect tracePicker tracePicker--range">' in html
    assert 'Time range · Last 1 hour</button>' in html
    assert 'Status · ALL</button>' in html
    assert 'Results · 50</button>' in html
    assert 'const shipped = select.parentElement?.classList.contains("tracePicker") ? select.parentElement : null;' in js
