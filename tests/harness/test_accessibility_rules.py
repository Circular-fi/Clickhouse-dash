"""Accessibility rules read from the sources (docs/ui-foundations.md, "Accessibility").

What a user sees and hears is measured in the browser by tests/frontend/specs/a11y-contract.spec.js and accessibility.spec.js (axe,
contrast, keyboard, forced colours). This file keeps the rules that the browser tests cannot see in the sources, each with its reason:
the edge of a field is a token (3:1 in every palette), the SQL colours reach 4.5:1 in the light theme, text is dimmed by --muted never
by opacity, a placeholder is --muted at full strength, every shell starts with a skip link and holds its h1 in its main, the
forced-colors block colours every mask icon, and one global :focus-visible ring that no rule can remove.
"""
import re
import sys
from pathlib import Path

import css_sources

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import css_tree  # noqa: E402
import page_shells  # noqa: E402

STATIC = ROOT / "src" / "static"
SQL_TOKENS = ("--sql-string", "--sql-keyword", "--sql-function", "--sql-number", "--sql-null", "--sql-type")


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


def test_the_edge_of_a_field_is_a_token_in_every_palette():
    tokens = css_sources.tokens()
    for name in ("--control-border", "--control-border-hover"):
        # The dark :root, the System light block, the forced dark and the forced light blocks.
        assert len(re.findall(rf"^\s*{name}:", tokens, re.M)) == 4, name


def test_the_sql_colours_are_set_for_the_light_theme_and_reset_by_the_forced_dark_one():
    tokens = css_sources.tokens()
    for name in SQL_TOKENS:
        # :root (dark), the light media block, forced dark, forced light.
        assert len(re.findall(rf"^\s*{name}:", tokens, re.M)) == 4, name
    # The light values are literals that reach 4.5:1 (tests/frontend/specs/a11y-contract.spec.js measures them).
    for name, value in (("--sql-string", "#9a3412"), ("--sql-function", "#6d28d9"), ("--sql-number", "#047857"), ("--sql-null", "#b91c1c"), ("--sql-type", "#0f766e")):
        assert tokens.count(f"{name}: {value};") == 2, name


FIELDS = {
    ".uiInput": "border",
    ".uiSearch": "border",
    ".obsFilterBar .obsFilterBar__input": "border",
    ".traceSearchBar .timeRangeField__input": "border",
    ".tracePicker__button": "border",
    ".traceSearchBar .tracePicker__button": "border",
    ".metricsFilterForm__key": "border",
    ".logsColumnsAdd > input": "border",
    ".qlSearch": "border",
    ".editorWrap": "border",
    ".traceTagSearch__op": "border",
}


def test_a_field_draws_its_edge_with_the_control_border_token():
    for selector, prop in FIELDS.items():
        found = [value for _, ctx, rule in rules() if not ctx and any(s == selector or s.endswith(" " + selector) or selector in s.split(", ") for s in rule.selectors)
                 for decl in rule.decls if decl.name == prop for value in [decl.value]]
        assert found, f"{selector} has no {prop}"
        assert any("--control-border" in value for value in found), f"{selector}: {found}"


# Text that was once dimmed with `opacity` (33 rules, UI-116): the contrast then depended on what was behind it.
NO_OPACITY = (
    ".hostVersion", ".hostPing", ".pickerOption__version", ".pickerOption__meta", ".queryChart__rangeHint", ".autocompleteGhost__missing",
    ".mcpGrantGroup.is-empty", ".explorerTreeObject.is-storage-blocked", ".traceFacet__pin", ".traceFacetValue__exclude", ".traceLog__span.is-missing",
    ".traceSpanListRow__cell--attr.is-missing", ".badge.traceServiceFilter[aria-pressed=\"false\"]",
)


def test_the_text_that_was_dimmed_by_opacity_uses_muted_at_full_strength():
    for selector in NO_OPACITY:
        values = [decl.value for _, ctx, rule in rules() if not ctx and selector in rule.selectors for decl in rule.decls if decl.name == "opacity"]
        assert not values, f"{selector} dims its text with opacity {values}: use --muted"


def test_a_placeholder_is_muted_at_full_opacity_everywhere():
    for file, ctx, rule in rules():
        for selector in rule.selectors:
            if "::placeholder" not in selector:
                continue
            for decl in rule.decls:
                if decl.name in ("color", "-webkit-text-fill-color"):
                    assert decl.value == "var(--muted)", f"{file}: {selector} {{ {decl.text()} }}"
                if decl.name == "opacity":
                    assert decl.value in ("1", "0"), f"{file}: {selector} dims the placeholder (0 is the editor's first-paint state)"
    assert declared("::placeholder", "color") == "var(--muted)" and declared("::placeholder", "opacity") == "1"




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


# ---- the keyboard focus ring ----------------------------------------------------------------------------------------
FOCUS_CSS = css_sources.text()
# The Query editor textarea keeps its own focus treatment (Query page).
EXEMPT = "#queryTextArea"


def focus_rules():
    text = re.sub(r"/\*.*?\*/", " ", FOCUS_CSS, flags=re.S)
    for match in re.finditer(r"([^{}]*)\{([^{}]*)\}", text):
        selector = " ".join(match.group(1).split())
        if selector and not selector.startswith("@"):
            yield selector, match.group(2)


def test_global_focus_visible_ring_is_the_only_override_outline():
    # The ring lives in the overrides layer: it wins over every component and
    # feature rule without !important, and it is the only outline there.
    overrides = (css_sources.CSS / "30-overrides.css").read_text(encoding="utf-8")
    ring = re.search(r":where\(a\[href\], [^{]*\):focus-visible \{\n  outline: 2px solid var\(--focus-ring-color\);", overrides)
    assert ring, "the global :focus-visible ring is missing"
    assert "textarea:not(#queryTextArea)" in ring.group(0)
    # The forced-colors block (Windows high contrast) outlines the selected states: that is not a focus ring.
    outside_forced = re.sub(r"@media \(forced-colors: active\) \{.*?\n\}\n", "", overrides, flags=re.S)
    assert len(re.findall(r"\boutline\s*:", outside_forced)) == 1
    important = [selector for selector, body in focus_rules() if re.search(r"outline\s*:[^;]*!important", body)]
    assert not important, important


def test_no_focus_rule_removes_the_outline():
    kills = [
        selector
        for selector, body in focus_rules()
        if ":focus" in selector and EXEMPT not in selector and re.search(r"outline\s*:\s*(none|0)\b", body)
    ]
    assert not kills, kills
    assert "Keep keyboard focus neutral" not in FOCUS_CSS


def test_ring_token_is_the_same_two_pixel_ring_in_every_theme():
    assert "--ring: 0 0 0 2px var(--focus-ring-color);" in FOCUS_CSS
    assert FOCUS_CSS.count("--ring:") == 1
    for block in ('html[data-theme="dark"] {', 'html[data-theme="light"] {'):
        start = FOCUS_CSS.index(block)
        assert "--focus-ring-color:" in FOCUS_CSS[start : FOCUS_CSS.index("}", start)], block
