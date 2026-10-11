"""Structural rules of the frontend sources (src/static): what no module may do, whatever it draws.

A behaviour test cannot see that some module opened a second history listener, wrote localStorage directly or built its own
tab row: the page still works, and the next change breaks the shared component. So these rules read the sources, and each
says why. What a page or a component does is tested by tests/frontend/model (Node), tests/frontend/specs (Playwright) and
tests/backend-functional; none of that is asserted here. Markup written as a string is in test_dom_builder_contract.py, the
local formatters and colours in test_frontend_format_colour_rules.py.
"""
from __future__ import annotations

import re
from pathlib import Path

import modules

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def scripts() -> dict[str, str]:
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(STATIC.glob("*.js"))}


def shells() -> dict[str, str]:
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(STATIC.glob("*.html"))}


def code(text: str) -> str:
    """The script without its comments (a comment may name the APIs)."""
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    return re.sub(r"(?m)(^|[^:\\'\"`])//.*$", r"\1", text)


# ---- loading ---------------------------------------------------------------------------------------------------------------------


def test_the_common_modules_load_in_dependency_order_on_every_page():
    # Why: app_common.js is the one list of what every page runs first; an import that is evaluated too late is a ReferenceError at load.
    common = modules.common_modules()
    assert common[:3] == ["app_format.js", "app_palette.js", "app_dom.js"]
    assert common.index("app_router.js") == common.index("app_dom.js") + 1
    assert common.index("app_dom.js") < common.index("app_ui_layers.js") < common.index("app_ui_popover.js") < common.index("app_ui_panel.js") < common.index("app_state.js")
    assert common.index("app_dom.js") < common.index("app_ui_tabs.js") < common.index("app_ui_segmented.js") < common.index("app_ui_menu.js")
    for module in ("app_ui_table.js", "app_ui_badge.js", "app_ui_copy.js", "app_ui_sql.js", "app_ui_kv.js", "app_ui_stat.js", "app_ui_chart.js"):
        assert common.index("app_util.js") < common.index(module), module
    for page in modules.PAGES:
        text = read(f"app_page_{page}.js")
        assert text.index('import "./app_common.js";') < text.index("boot("), page
        for component in ("app_ui_layers.js", "app_ui_popover.js", "app_ui_panel.js"):
            assert component not in modules.lazy_groups(page).get("lazy", []), (page, component)


def test_a_page_does_not_load_the_modules_of_another_family():
    # Why: one page per view (modules.json): a page ships and runs only the modules of its own family.
    families = {
        "system": {"system", "queries", "disks", "shape"},
        "mcp": {"mcp"},
        "logs": {"logs"},
        "metrics": {"metrics"},
        "traces": {"traces", "trace"},
    }
    for family, allowed in families.items():
        pattern = re.compile(rf"app_{family}(_|\.)")
        for page in modules.PAGES:
            if page in allowed:
                continue
            loaded = [name for name in modules.page_modules(page) if pattern.match(name)]
            assert not loaded, (page, loaded)
    # The Query page has no Explorer; the Explorer has no editor, no profiling dialog and no download.
    assert not any(name.startswith("app_explorer") for name in modules.page_modules("query"))
    for name in ("app_autocomplete.js", "app_run.js", "app_analysis.js", "app_pipeline_viewer.js", "app_trace_viewer.js", "app_download.js"):
        assert name not in modules.page_modules("explorer"), name


def test_no_module_builds_a_script_element_or_imports_dynamically_but_the_loader():
    # Why: the loader is the one place that starts modules and lazy groups (by name, from modules.json); the shell adds the entry.
    for name, text in scripts().items():
        assert 'createElement("script")' not in text, name
        assert "startModules" not in text, name
        if name not in ("app_loader.js", "app_wasm_worker.js"):
            assert not re.search(r"\bimport\(", text), name


# ---- the address bar, layers, popups -----------------------------------------------------------------------------------------------

HISTORY_WRITES = re.compile(r"history\s*(?:\.\s*|\[\s*['\"])(?:pushState|replaceState|back|go|forward)\b")
POPSTATE = re.compile(r"['\"]popstate['\"]|\bonpopstate\b")


def inline_scripts():
    for path in sorted(STATIC.glob("*.html")):
        html = path.read_text(encoding="utf-8")
        for block in re.findall(r"<script(?![^>]*type=\"application/json\")[^>]*>(.*?)</script>", html, flags=re.S):
            yield path.name, block
    for path in sorted((ROOT / "src" / "shell").glob("*.html")):
        yield path.name, path.read_text(encoding="utf-8")


def test_only_the_router_writes_history_or_listens_to_popstate():
    # Why: two writers of the session history fight over Back; ns.router owns it and the one popstate listener.
    offenders = []
    for name, text in [*scripts().items(), *inline_scripts()]:
        if name == "app_router.js":
            continue
        body = code(text)
        if HISTORY_WRITES.search(body):
            offenders.append(f"{name}: {HISTORY_WRITES.search(body).group(0)}")
        if POPSTATE.search(body):
            offenders.append(f"{name}: popstate")
    assert not offenders, offenders


def test_the_base_path_is_read_by_the_router_and_the_api_only():
    # Why: the app may be mounted under a prefix; one place derives it, everything else asks the router or the api.
    for name, text in scripts().items():
        if name not in ("app_router.js", "app_api.js"):
            assert "__CHDASH_BASE_PATH__" not in code(text), name


def test_the_time_range_parameters_go_through_the_timerange_helper():
    # Why: from / to are read and written by ns.timeRange.url, which knows the formats and the rounding.
    for name in ("app_traces.js", "app_trace_search.js", "app_logs.js", "app_metrics.js", "app_obs_page.js"):
        assert not re.search(r"""\.(?:get|set|has|delete)\(["'](?:from|to)["']""", read(name)), name


# Escape comparisons left outside ns.layers, per file: keys a component consumes first (an editor's suggestions, a drag or a chart cursor to
# cancel, a canvas selection, a table cell going back to its row, a filter field's text, a tooltip hide). A new local Escape handler fails here:
# push an ns.layers layer instead.
ESCAPE_ALLOWED = {
    "app_ui_layers.js": 1, "app_ui_popover.js": 1, "app_ui_search.js": 1, "app_autocomplete.js": 2, "app_chart_core.js": 3, "app_graph_kit.js": 1,
    "app_ui_table.js": 1, "app_trace_heatmap.js": 1, "app_trace_logs.js": 1, "app_trace_insights.js": 1, "app_query_ui.js": 1, "app_results.js": 3,
    "app_results_rowdetails.js": 1, "app_query_chart.js": 1, "app_query_library.js": 4,
}
# Document-level press listeners: the layers' outside press and the Query page's own (editor suggestions, header menus, result and chart menus, library menu).
OUTSIDE_ALLOWED = {"app_ui_layers.js", "app_autocomplete.js", "app_results.js", "app_results_rowdetails.js", "app_query_chart.js", "app_query_library.js"}


def test_no_new_local_escape_or_click_outside_handler():
    # Why: one dismiss stack (ns.layers): the top layer takes Escape and the outside press, focus goes back to the opener.
    for name, text in scripts().items():
        count = text.count('"Escape"')
        assert count <= ESCAPE_ALLOWED.get(name, 0), f"{name}: {count} Escape comparisons (use ns.layers)"
        presses = re.findall(r'document\.addEventListener\("(?:click|pointerdown|mousedown)"', text)
        assert not presses or name in OUTSIDE_ALLOWED, f"{name}: a document press listener (use ns.layers)"


CLAMP = re.compile(r"window\.innerWidth\s*-\s*[\w.]+\s*-\s*(?:8|margin)\b")


def test_no_local_viewport_clamp():
    # Why: ns.popover.place is the one placement (flip, clamp, scroll); a copy drifts at the edges of the window.
    offenders = sorted(name for name, text in scripts().items() if CLAMP.search(text) and name not in {"app_results.js", "app_ui_popover.js"})
    assert not offenders, f"place popovers with ns.popover.place: {offenders}"


def test_menus_have_no_motion_or_outside_click_closer_of_their_own():
    # Why: ns.menu owns open / close, placement, keys and focus of every popup list.
    for name, text in scripts().items():
        if name == "app_ui_menu.js":
            continue
        assert 'classList.add("themeSelect--open")' not in text and 'classList.add("themeSelect--closing")' not in text, name
        assert "}, 160);" not in text, name


def test_every_modal_is_the_shared_dialog():
    # Why: ns.dialog is the one modal (a layer: Escape, backdrop, focus in and back); a bare <dialog> would miss the layer stack.
    for name, text in scripts().items():
        if name != "app_ui_dialog.js":
            assert "showModal" not in text and 'h("dialog"' not in text, name


# ---- live regions, tooltips, close buttons -----------------------------------------------------------------------------------------


def test_only_the_announce_region_is_live_and_hover_tooltips_are_not_status():
    # Why: one polite region (#uiLiveStatus, ns.uiState.announce); a hover tooltip announced as status talks over the reader.
    for name, text in {**scripts(), **shells()}.items():
        if name != "app_ui_state.js":
            assert "aria-live" not in text, name
    for name, text in scripts().items():
        for line in text.splitlines():
            if re.search(r"(?i)(tooltip|__tip|Tip\b)", line):
                assert not re.search(r"""role["'=, ]+["']?status""", line), f"{name}: {line.strip()[:120]}"


def test_every_close_of_a_panel_or_popover_is_the_shared_close_cross():
    # Why: one close button (look, size, label); a per-panel copy comes back one class at a time.
    for name, text in scripts().items():
        for match in re.finditer(r'class="([^"]*__close[^"]*)"', text):
            assert "closeCross" in match.group(1), (name, match.group(1))


# ---- shared components: no local copy ----------------------------------------------------------------------------------------------


def test_no_module_builds_tabs_or_handles_tab_keys_itself():
    # Why: ns.tabs is the one tab row (roles, aria-selected, arrow / Home / End keys).
    for name, source in scripts().items():
        if name == "app_ui_tabs.js":
            continue
        assert not re.search(r'<[a-z]+[^>]*role="tab"', source), name
        assert '"role", "tab"' not in source and 'role = "tab"' not in source, name
        for match in re.finditer(r"[\"']ArrowRight[\"']", source):
            window = source[max(0, match.start() - 600):match.end() + 600]
            assert not (re.search(r"[\"']Home[\"']", window) and re.search(r"\b(tabs?|tablist|aria-selected)\b", window)), (name, window[:200])


def test_every_tab_row_and_segmented_group_of_a_shell_is_the_shared_markup():
    # Why: the shells ship the final markup of the components; a plain tablist or a group without aria-pressed is not the component.
    for name, html in shells().items():
        for list_tag in re.findall(r"<div[^>]*role=\"tablist\"[^>]*>", html):
            assert "contentTabs" in re.search(r'class="([^"]*)"', list_tag).group(1).split(), (name, list_tag)
        for tab in re.findall(r"<button[^>]*role=\"tab\"[^>]*>", html):
            assert "contentTabs__tab" in re.search(r'class="([^"]*)"', tab).group(1).split(), (name, tab)
        for group in re.findall(r'<(?:div|span) class="segmented[^"]*"[^>]*>', html):
            assert 'role="group"' in group and "aria-label=" in group, group
        for option in re.findall(r'<button[^>]*class="segmented__option"[^>]*>', html):
            assert "aria-pressed=" in option, option
        for tag in re.findall(r'<select[^>]*class="tracePicker__native"[^>]*>', html):
            assert 'tabindex="-1"' in tag and 'aria-hidden="true"' in tag, (name, tag)


def test_every_table_is_a_data_table():
    # Why: one table component (sorting, keys, bars, density); a plain <table> would miss all of it.
    tables = re.compile(r"""<table class="([^"]*)"|node\("table", [`"]([^`"]*)[`"]\)|createElement\("table"\)""")
    bad = []
    for name, text in scripts().items():
        for number, line in enumerate(text.splitlines(), 1):
            for match in tables.finditer(line):
                classes = match.group(1) or match.group(2) or ""
                if "chartCore__legendTable" in classes:
                    continue
                if match.group(0).startswith("createElement"):
                    if name not in ("app_results.js", "app_results_static.js", "app_results_table.js"):
                        bad.append(f"{name}:{number}")
                    continue
                if "dataTable" not in classes:
                    bad.append(f"{name}:{number}: {classes}")
    assert not bad, bad


def offenders(pattern: str, allowed: set[str] = frozenset()) -> list[str]:
    regex = re.compile(pattern)
    return [f"{name}:{number}: {line.strip()[:120]}" for name, text in scripts().items() if name not in allowed
            for number, line in enumerate(text.splitlines(), 1) if regex.search(line)]


def test_one_copy_helper_one_sparkline_and_one_sort_indicator():
    # Why: ns.copy owns the clipboard and its feedback, app_ui_chart.js the sparkline, ns.table the sort state (aria-sort).
    assert not offenders(r"navigator\.clipboard|execCommand\(\"copy\"\)", {"app_ui_copy.js"})
    assert not offenders(r"<polyline", {"app_ui_chart.js"})
    assert not offenders(r"dataset\.sort\s*=|data-sort=\"\$\{")


def test_no_module_keeps_a_local_frame_coalescer_or_a_hand_written_debounce():
    # Why: util.rafOnce and util.debounce (cancel / flush) are the shared timers; the hand-written pair leaks a frame or a timer on teardown.
    for name in ("app_logs.js", "app_trace_waterfall.js", "app_trace_views.js", "app_trace_spans.js", "app_chart_core.js", "app_pipeline_viewer.js"):
        text = read(name)
        assert not re.search(r"if \(!\w+\) \w+ = requestAnimationFrame\(\(\) => \{ \w+ = 0;", text), name
        assert not re.search(r"= requestAnimationFrame\(\(\) => \{\s*\w+(Frame|Raf) = 0;", text), name


# ---- requests, storage, features, escaping -----------------------------------------------------------------------------------------


def test_every_request_goes_through_app_api():
    # Why: api.request owns the timeout, the abort, the JSON check and the error shape; a bare fetch() skips them.
    for name, text in scripts().items():
        if name in ("app_api.js", "app_wasm.js"):  # app_wasm.js fetches the kernels (static files, never an API route)
            continue
        assert not re.search(r"(?<![.\w])fetch\(", text), name
    # Routes are named endpoints of app_api.js: no module builds an "api/..." URL, apart from the hosts EventSource and the library's base path.
    for name, text in scripts().items():
        if name == "app_api.js":
            continue
        routes = re.findall(r"""["'`]api/[\w/-]*""", text)
        allowed = {"app_header.js": ['"api/hosts/stream'], "app_query_library.js": ['"api/query-library']}.get(name, [])
        assert sorted(routes) == sorted(allowed), (name, routes)
    for name, text in scripts().items():
        if name != "app_api.js":
            assert not re.search(r"[\"'`]/?api/mcp", text), name


def test_browser_storage_goes_through_storage_pref():
    # Why: storage.pref / KEYS own the key names, the defaults, the quota handling and the retired keys; a direct access skips them.
    for name, text in scripts().items():
        if name == "app_state.js":
            continue
        body = re.sub(r"//[^\n]*", "", text)
        assert "localStorage." not in body and "sessionStorage." not in body, name
        stripped = body.replace('"chdash.processors.json.v1"', "").replace('"chdash.trace.json.lod.v2"', "")
        assert not re.search(r"""["']chdash\.[A-Za-z]+[A-Za-z0-9_.]*["']""", stripped), name


def test_feature_flags_are_read_through_ns_features():
    # Why: ns.features holds the one defaults table and completes the flags (graph.enabled needs lineage or storage_topology).
    for name, text in scripts().items():
        if name == "app_state.js":
            continue
        assert "state.features" not in text and "state?.features" not in text, name
        assert "featuresLoaded" not in text, name


def test_one_html_escaper():
    # Why: util.escapeHtml is the one escaper; a second one is a second place to get the five characters wrong.
    for name, text in scripts().items():
        if name == "app_util.js":
            continue
        assert not re.search(r"""replace\(/&/g, ["']&amp;["']\)""", text), name
        assert not re.search(r"""\[&<>"']/g""", text), name


def test_the_views_guard_stale_answers_with_obs_view_read():
    # Why: obsView.read(slot) is a util.latest read that is also stale once the host changed; a hand-rolled sequence misses the host.
    for name in ("app_logs.js", "app_metrics.js", "app_traces.js", "app_trace_detail.js", "app_trace_logs.js", "app_trace_heatmap.js", "app_trace_map.js",
                 "app_trace_services.js", "app_trace_insights.js", "app_facet_panel.js", "app_trace_spans.js"):
        text = read(name)
        if name != "app_trace_spans.js":  # the span search keeps a cursor of its own
            assert not re.search(r"\bconst seq = \+\+", text), name
        assert "obsView.read(" in text and "= util.latest(" not in text, name


def test_no_module_scans_sql_quotes_and_comments_by_hand():
    # Why: app_sql_lex.js is the one SQL lexer (the reference of the WebAssembly kernels); a second scanner disagrees on `$$`, nested comments and `#`.
    scanner = re.compile(r"\b(?:inSingle|inDouble|inBacktick|inLineComment|inBlockComment|lineComment|blockComment)\b")
    for name, text in scripts().items():
        if name.startswith("app_"):
            assert not scanner.search(text), f"{name} scans SQL by hand: use app_sql_lex.js"


# ---- CSS that lives in the shared components -----------------------------------------------------------------------------------------


def test_no_local_fixed_drawer_outside_the_panel_shell():
    # Why: ns.sidePanel / ns.detailPanel own the drawers; a position: fixed panel of its own skips the width tokens, the fold and the focus return.
    import css_sources

    shell = css_sources.component("panels")
    outside = css_sources.text().replace(shell, "")
    text = re.sub(r"/\*.*?\*/", "", outside, flags=re.S)
    offenders = []
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", text):
        selector = " ".join(match.group(1).split())
        if re.search(r"position:\s*fixed", match.group(2)) and re.search(r"(?i)(panel|drawer|detail|sidebar|pane|sheet)\b", selector) and selector != ".traceContextPanel":
            offenders.append(selector)
    assert not offenders, offenders
