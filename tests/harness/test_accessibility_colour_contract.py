"""Colour source rules (docs/ui-foundations.md, "Accessibility"): the edge of a field is a token, the SQL colours reach 4.5:1 in the
light theme, a placeholder and the text that was dimmed by opacity are --muted at full strength. What a user sees is measured in the
browser by tests/frontend/specs/a11y-contract.spec.js; this file keeps the rules that the browser tests cannot see in the sources (a
selector that a new component adds, a rule that no page state reaches)."""
import re
import sys
from pathlib import Path

import css_sources

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import css_tree  # noqa: E402

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


