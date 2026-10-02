"""The page shell: one full-bleed chrome for Query, Explorer and Observability.

style.css owns it in one delimited block ("Page shell"): layout tokens, the
header, the nav rows, each page's frame and the scroll model. These checks
keep it in one place: no page card or rounded inset comes back elsewhere, the
superseded duplicates stay deleted, and the breakpoints scripts use mirror
the CSS ones.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="latin-1")


def shell_block(css: str) -> str:
    return css[css.index("/* ==== Page shell"):css.index("/* ==== /Page shell")]


def top_level_rules(css: str, selector: str) -> list[str]:
    """Bodies of the rules whose whole selector list includes `selector` at the top level or in an @media."""
    text = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    out = []
    for match in re.finditer(r"([^{};]+)\{([^{}]*)\}", text):
        selectors = [part.strip() for part in match.group(1).split(",")]
        if selector in selectors:
            out.append(match.group(2))
    return out


def test_layout_tokens_and_breakpoints_are_defined_once():
    css = read("src/static/style.css")
    shell = shell_block(css)
    for token in ("--gutter: 12px;", "--nav-row-h: 46px;", "--shell-border: 1px solid var(--border);",
                  "--bp-sm: 600px;", "--bp-md: 820px;", "--bp-lg: 1100px;",
                  "--z-nav: 12;", "--z-drawer: 30;", "--z-header: 50;", "--z-modal: 120;"):
        assert token in shell, token
        assert css.count(token) == 1, token
    dom = read("src/static/app_dom.js")
    assert "const BREAKPOINTS = Object.freeze({ sm: 600, md: 820, lg: 1100 });" in dom
    assert "ns.shell = Object.freeze({ BREAKPOINTS, mediaQuery, isAtMost, trackShellTop });" in dom
    explorer = read("src/static/app_explorer.js")
    assert 'return !!ns.shell?.isAtMost("md");' in explorer
    assert 'window.matchMedia(ns.shell.mediaQuery("md"))' in explorer
    assert '"(max-width: 820px)"' not in explorer
    # The Query layout stacks at --bp-lg, not at a page-specific 72rem.
    assert "@media (max-width: 72rem)" not in css


def test_one_shared_shell_top_measurement():
    dom = read("src/static/app_dom.js")
    obs = read("src/static/app_observability.js")
    assert 'const SHELL_ROWS = ["body > .appHeader", "#obsNav", "#explorerTopBar"];' in dom
    assert 'root.style.setProperty("--shell-top", value)' in dom
    assert "function trackShellTop" not in obs
    css = read("src/static/style.css")
    # No literal header height left in a page frame.
    for literal in ("calc(100vh - 62px)", "calc(100dvh - 62px)", "calc(100dvh - 280px)", "--explorer-mode-bar-height"):
        assert literal not in css, literal


def test_no_page_card_or_rounded_inset_outside_the_shell_block():
    css = read("src/static/style.css")
    shell = shell_block(css)
    outside = css.replace(shell, "")
    for selector in (".layout", ".panel", ".panel--query", ".panel--metrics", ".panel--results",
                     ".appHeader", ".obsNav", ".explorerTopBar", ".explorerModeBar",
                     ".explorerWorkspace", ".explorerShell", ".explorerGrid", ".explorerListPane",
                     ".explorerCatalogMain", ".explorerDetailPane", ".tracesWorkspace", ".tracesShell"):
        rules = top_level_rules(shell, selector)
        assert rules, selector
        for body in rules:
            assert "border-radius" not in body or "border-radius: 0;" in body, selector
            assert "box-shadow: var(--shadow" not in body, selector
        # The superseded duplicates stay deleted: each frame selector has
        # its box model in the shell block only.
        for body in top_level_rules(outside, selector):
            for prop in ("padding:", "border:", "border-radius:", "box-shadow:", "grid-template-columns:", "height:", "min-height:"):
                assert prop not in body, (selector, prop, body)
    # Flat page background, no gradient card behind the pages.
    assert "radial-gradient(60rem 35rem" not in css
    assert "html,\nbody {\n  height: 100%;\n  min-height: 0;\n  overflow: hidden;\n  background: var(--bg);\n}" in shell
    assert ".tracesWorkspace--jaeger {" not in css and ".tracesShell--jaeger {" not in css


def test_nav_rows_share_the_tokens():
    css = read("src/static/style.css")
    shell = shell_block(css)
    rows = shell[shell.index(".obsNav,\n.explorerTopBar,\n.explorerModeBar {"):]
    rows = rows[:rows.index("}")]
    assert "min-height: var(--nav-row-h);" in rows
    assert "padding: 4px var(--gutter);" in rows
    assert "border-bottom: var(--shell-border);" in rows
    assert "background: var(--panelBg);" in rows
    html = read("src/static/explorer.html")
    assert 'class="explorerViewTabs explorerModeTabs"' in html
    assert "explorerViewTabs--compact" not in html + css
