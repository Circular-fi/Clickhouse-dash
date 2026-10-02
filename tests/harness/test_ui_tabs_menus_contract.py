"""Navigation and choice controls: one component per family.

- Tabs (app_ui_tabs.js, ns.tabs): tier 1 page / view tabs (.viewTabs /
  .viewTab) and tier 2 in-content tabs (.contentTabs / .contentTabs__tab),
  one keyboard implementation.
- Segmented controls (app_ui_segmented.js, ns.segmented): .segmented /
  .segmented__option, two sizes, role=group of aria-pressed buttons, the
  pressed option on --seg-active-bg.
- Menus, pickers and dropdowns (app_ui_menu.js, ns.menu): open / close,
  placement, keys, focus and one dismiss layer for every popup list.

Each test fails when a local copy of a family comes back (a tab key handler,
a segmented look, a menu's own open / close motion or outside-click closer).
"""
from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"
COMPONENTS = ["app_ui_tabs.js", "app_ui_segmented.js", "app_ui_menu.js"]


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def scripts() -> dict[str, str]:
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(STATIC.glob("*.js"))}


def shells() -> dict[str, str]:
    return {path.name: path.read_text(encoding="utf-8") for path in sorted(STATIC.glob("*.html"))}


def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def component_block(css: str, name: str) -> str:
    start = css.index(f"/* ==== Components: {name} ")
    end = css.index(f"/* ==== /Components: {name} ", start)
    return css[start:end]


# ---------------------------------------------------------------- loading


def test_components_load_on_every_page_after_the_foundations_and_before_app_ui():
    app = read("app.js")
    files = app[app.index("const files = ["):app.index("];", app.index("const files = ["))]
    order = [files.index(f'"{name}"') for name in ["app_dom.js", *COMPONENTS, "app_ui.js"]]
    assert order == sorted(order)
    skipped = app[app.index("const PAGE_SKIPPED_MODULES = {"):app.index("};", app.index("const PAGE_SKIPPED_MODULES = {"))]
    for name in COMPONENTS:
        assert f'"{name}"' not in skipped, name
    obs = read("app_observability.js")
    common = re.findall(r'"([^"]+)"', re.search(r"const COMMON_MODULES = \[([^\]]*)\];", obs).group(1))
    assert common.index("app_dom.js") < common.index("app_ui_tabs.js") < common.index("app_ui_segmented.js") < common.index("app_ui_menu.js") < common.index("app_ui.js")
    views = obs[obs.index("const VIEW_MODULES = {"):obs.index("};", obs.index("const VIEW_MODULES = {"))]
    for name in COMPONENTS:
        assert name not in views, name


def test_component_sources_are_ascii():
    for name in COMPONENTS:
        assert not re.search(r"[^\x00-\x7f]", read(name)), name


# ---------------------------------------------------------------- tabs


def test_tabs_component_owns_roles_state_and_keys():
    tabs = read("app_ui_tabs.js")
    assert "ns.tabs = { bind, select, render };" in tabs
    assert 'const KEYS = ["ArrowRight", "ArrowLeft", "Home", "End"];' in tabs
    assert 'const TAB_CLASS = { view: "viewTab", content: "contentTabs__tab" };' in tabs
    assert "Promise.resolve(onSelect?.(value, { via: \"key\" })).then(refocus, refocus);" in tabs


def test_every_tab_row_is_one_of_the_two_tiers():
    for name, html in shells().items():
        for list_tag in re.findall(r"<div[^>]*role=\"tablist\"[^>]*>", html):
            classes = re.search(r'class="([^"]*)"', list_tag).group(1).split()
            assert "viewTabs" in classes or "contentTabs" in classes or "uiDialog__tabs" in classes, (name, list_tag)
        for tab in re.findall(r"<button[^>]*role=\"tab\"[^>]*>", html):
            classes = re.search(r'class="([^"]*)"', tab).group(1).split()
            assert "viewTab" in classes or "contentTabs__tab" in classes or "uiDialog__tab" in classes, (name, tab)


def test_no_module_builds_tabs_or_handles_tab_keys_itself():
    allowed = {"app_ui_tabs.js", "app_ui_dialog.js"}
    for name, source in scripts().items():
        if name in allowed:
            continue
        assert not re.search(r'<[a-z]+[^>]*role="tab"', source), name
        assert '"role", "tab"' not in source and 'role = "tab"' not in source, name
        assert "aria-selected" not in source or "[data-obs-tab]" not in source, name
        # A tab row's own Left / Right / Home / End handler.
        for match in re.finditer(r"ArrowRight", source):
            window = source[max(0, match.start() - 600):match.end() + 600]
            assert not ("Home" in window and "End" in window and re.search(r"\btab", window)), (name, window[:200])


def test_old_tab_families_are_gone():
    css = strip_comments(read("style.css"))
    sources = "".join(scripts().values()) + "".join(shells().values())
    for old in [r"\.explorerViewTab", r"\.explorerDetailTab(?!s)", r"\.logsTabs__tab", r"\.explorerModeTab\b(?!s)", r"\.traceTabs__tab"]:
        assert not re.search(old, css), old
    for old in ["explorerViewTab", "logsTabs__tab", '"explorerDetailTab', "explorerDetailTab${"]:
        assert old not in sources, old
    block = component_block(read("style.css"), "tabs")
    for rule in [".viewTabs {", ".viewTab {", ".viewTab.is-active {", ".contentTabs {", ".contentTabs__tab {", ".contentTabs__tab.is-active {"]:
        assert rule in block, rule
    # Each family is defined once, in the block.
    for rule in [".viewTab {", ".contentTabs__tab {"]:
        assert css.count(f"\n{rule}") == 1, rule


def test_tab_rows_bind_through_the_component():
    assert 'ns.tabs?.bind(shellEl("explorerViewTabs"), {' in read("app_explorer.js")
    assert 'ns.tabs?.bind(shellEl("explorerModeTabs"), {' in read("app_explorer.js")
    assert 'ns.tabs?.bind(dom.explorerDetailTabs, { onSelect: (label) => openTab(label) });' in read("app_explorer_detail.js")
    assert 'ns.tabs?.bind(document.getElementById("obsTabs"), { attr: "obsTab", onSelect: (view) => show(view) });' in read("app_observability.js")
    assert 'ns.tabs?.bind(byId("tracesTabs"), { attr: "traceTab", onSelect: (id) => select(id) });' in read("app_trace_tabs.js")
    logs = read("app_logs.js")
    assert 'ns.tabs?.bind(document.querySelector(".logsTabs"),' in logs
    assert 'sideTabs = ns.tabs?.bind(document.querySelector(".logsSideTabs"), {' in logs
