"""Accessibility source rules (docs/ui-foundations.md, "Accessibility"): the skip link, the landmarks of the shells and the
forced-colors block. What a user sees is measured in the browser by tests/frontend/specs/a11y-contract.spec.js; this file keeps
the rules that the browser tests cannot see in the sources (a mask icon that a new component adds, a shell that a page adds)."""
import re
import sys
from pathlib import Path

import css_sources

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import css_tree  # noqa: E402
import page_shells  # noqa: E402

STATIC = ROOT / "src" / "static"


def rules():
    """(file, @-context, rule) of every style rule of the sources."""
    def walk(nodes, ctx):
        for node in nodes:
            if isinstance(node, css_tree.Rule):
                yield ctx, node
            elif isinstance(node, css_tree.AtRule) and node.children is not None:
                yield from walk(node.children, ctx + (node.header(),))

    for path, _ in css_sources.files():
        for ctx, rule in walk(css_tree.parse(css_sources.read(path)), ()):
            yield path.relative_to(css_sources.CSS).as_posix(), ctx, rule


def declared(selector, prop, ctx=()):
    """The value of `prop` that the rules for `selector` (a whole selector of a list) give, the last one winning."""
    value = None
    for _, rule_ctx, rule in rules():
        if rule_ctx == ctx and selector in rule.selectors:
            for decl in rule.decls:
                if decl.name == prop:
                    value = decl.value
    return value


def test_every_shell_starts_with_the_skip_link_and_holds_its_one_h1_in_its_main():
    header = (ROOT / "src" / "shell" / "header.html").read_text(encoding="utf-8")
    assert '<a id="skipLink" class="skipLink" href="#{{main.id}}">Skip to content</a>' in header
    assert header.index('class="skipLink"') < header.index('<header class="appHeader"')
    for page, main_id in page_shells.MAIN_ID.items():
        html = (STATIC / f"{page}.html").read_text(encoding="utf-8")
        assert f'<a id="skipLink" class="skipLink" href="#{main_id}">' in html, page
        main = re.search(rf'<main id="{main_id}"[^>]*>(.*?)</main>', html, re.S)
        assert main, f"{page}: no main#{main_id}"
        assert len(re.findall(r"<h1\b", html)) == 1 and "<h1" in main.group(1), f"{page}: the h1 is not in the main"
    # Every shell is listed: a new one needs its main.
    assert set(page_shells.MAIN_ID) == set(page_shells.SHELLS)


def test_the_skip_link_is_hidden_until_it_has_the_focus():
    assert declared(".skipLink", "transform") == "translateY(-300%)"
    assert declared(".skipLink:focus-visible", "transform") == "none"


def test_the_forced_colors_block_gives_every_mask_icon_a_colour_and_lists_the_data_marks():
    forced = {}
    for file, ctx, rule in rules():
        if ctx == ("@media (forced-colors: active)",):
            assert file == "30-overrides.css", file
            for selector in rule.selectors:
                forced[selector] = {decl.name: decl.value for decl in rule.decls}
    assert forced, "no forced-colors block"
    # A rule that draws an icon with a mask draws it with a background colour: forced colors would paint it Canvas.
    masked = []
    for file, ctx, rule in rules():
        if ctx != () and not all(c.startswith("@media (max-width") or c.startswith("@media (min-width") for c in ctx):
            continue
        if any(decl.name in ("mask", "-webkit-mask", "mask-image") for decl in rule.decls) and any(decl.name in ("background", "background-color") for decl in rule.decls):
            masked.extend(selector for selector in rule.selectors if "has-edge" not in selector)
    assert masked
    # An icon rule at a breakpoint has its twin outside it: look the selector up wherever the block lists it.
    missing = sorted({selector for selector in masked if not any(selector == listed or selector.split(" ")[-1] == listed.split(" ")[-1] and selector.endswith(listed) for listed in forced)})
    assert not missing, f"a mask icon the forced-colors block does not colour: {missing}"
    for selector, decls in forced.items():
        if "background-color" in decls:
            assert decls["background-color"] in ("CanvasText", "Canvas"), selector
    assert forced[".cellBar"]["forced-color-adjust"] == "none"
    # The colour probes of canvas charts opt out of the forcing, or every series would be the text colour.
    assert declared(".chartCore__probe", "forced-color-adjust") == "none"
    assert "forced-color-adjust:none" in (STATIC / "app_palette.js").read_text(encoding="utf-8")
