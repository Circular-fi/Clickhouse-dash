"""The stylesheet sources: one file per layer role, cascade layers, one rule per selector.

src/static/css/index.css declares the layers (tokens, base, components,
features, overrides) and imports every source file into its layer, layer by
layer. A file's place says its layer: 00-tokens.css, 01-base.css,
10-components/<component>.css, 20-features/<feature>.css, 30-overrides.css.
Inside a layer a selector is written once per @-context (its declarations
merged into one rule; a list only groups selectors that share every declaration), no selector matches nothing on every page,
!important is kept only where a layer cannot replace it (IMPORTANT below,
with the reason), and colour literals live in the tokens file only.
"""
import re
import sys
from pathlib import Path

import css_sources

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import css_tree  # noqa: E402

LAYER_DIRS = {"tokens": "00-tokens.css", "base": "01-base.css", "components": "10-components/", "features": "20-features/", "overrides": "30-overrides.css"}

# (file, selector list, property): why it stays !important. Everything else that
# used to be !important is a plain declaration of the overrides layer now; the
# displays nothing hides with [hidden] any more (the trace header stats and
# title, the filter bars, the tag inputs, the pipeline head) are plain
# declarations of their feature files.
_SHOWS_HIDDEN = "a more specific !important display than [hidden]: the element shows even with the attribute, as before"
_FIRST_PAINT = "shows the view from the first paint, before the script removes [hidden]"
IMPORTANT: dict[tuple[str, str, str], str] = {
    ("30-overrides.css", "[hidden]", "display"):
        "[hidden] wins over every display a rule or an inline style sets; as the weakest !important layer, the rules below still win",
    ("20-features/traces.css", "html.chdash-trace-analytics .traceAnalyticsGrid[hidden]", "display"): _FIRST_PAINT,
    ("20-features/traces.css", "html.chdash-trace-tab-map #traceMapView[hidden]", "display"): _FIRST_PAINT,
    ("20-features/traces.css", "html.chdash-trace-tab-services #traceServicesView[hidden]", "display"): _FIRST_PAINT,
    ("20-features/traces.css", ".traceDetailPane.is-unavailable .traceTimelineFrame", "display"): _SHOWS_HIDDEN,
    ("20-features/traces.css", ".tracePageHeader__traceId", "display"): "wins over the display of the trace header's copy group the id sits in",
    ("20-features/traces.css", ".traceInspectorHead__meta", "display"): "wins over the grid of the span inspector's meta rows the row also is",
    ("20-features/traces.css", ".traceSpanRow.is-deep-linked", "background"):
        "wins over the traceDeepLinkFlash animation of the row (an animation beats any normal declaration)",
}

COLOUR_FUNCS = ("rgb(", "rgba(", "hsl(", "hsla(", "hwb(", "lab(", "lch(", "oklab(", "oklch(")
NAMED_COLOURS = {
    "black", "white", "red", "green", "blue", "gray", "grey", "orange", "yellow", "purple", "pink", "navy",
    "silver", "gold", "teal", "cyan", "magenta", "lime", "maroon", "olive", "aqua", "fuchsia",
}


def walk(nodes, ctx=()):
    for node in nodes:
        if isinstance(node, css_tree.Rule):
            yield ctx, node
        elif isinstance(node, css_tree.AtRule) and node.children is not None:
            yield from walk(node.children, ctx + (node.header(),))


def sources():
    for path, layer in css_sources.files():
        yield path, layer, css_tree.parse(css_sources.read(path))


def rel(path: Path) -> str:
    return path.relative_to(css_sources.CSS).as_posix()


def test_index_imports_every_source_file_once_into_the_layer_its_place_names():
    files = css_sources.files()
    assert files, "src/static/css/index.css imports nothing"
    names = [rel(path) for path, _ in files]
    assert len(names) == len(set(names)), "a file is imported twice"
    on_disk = sorted(p.relative_to(css_sources.CSS).as_posix() for p in css_sources.CSS.rglob("*.css") if p.name != "index.css")
    assert sorted(names) == on_disk, "every source file is imported, and only those"
    for path, layer in files:
        expected = LAYER_DIRS[layer]
        name = rel(path)
        assert name == expected or (expected.endswith("/") and name.startswith(expected) and "/" not in name[len(expected):]), (name, layer)
    assert [layer for _, layer in files] == sorted((layer for _, layer in files), key=list(LAYER_DIRS).index)


def test_sources_hold_rules_only_and_no_conflict_markers():
    for path, _ in css_sources.files():
        text = css_sources.read(path)
        for line in text.splitlines():
            assert not re.match(r"^(<{7}|={7}|>{7})( |$)", line), f"{rel(path)}: merge conflict marker"
        text.encode("latin-1")  # static sources stay Latin-1 (CONTRIBUTING.md)
        for node in css_tree.parse(text):
            if isinstance(node, css_tree.AtRule):
                # The web fonts are declared once, with the tokens.
                allowed = ("media", "supports", "container", "keyframes") + (("font-face",) if rel(path) == "00-tokens.css" else ())
                assert node.name in allowed, f"{rel(path)}: @{node.name} (layers come from index.css)"


def test_a_selector_is_written_once_per_layer_and_context():
    seen = {}
    for path, layer, nodes in sources():
        for ctx, rule in walk(nodes):
            for selector in rule.selectors:
                key = (layer, ctx, selector)
                assert key not in seen, f"{rel(path)}:{rule.line} repeats {selector!r} ({seen[key]}): add to that rule"
                seen[key] = f"{rel(path)}:{rule.line}"
            names = [d.name for d in rule.decls]
            assert len(names) == len(set(names)), f"{rel(path)}:{rule.line} {rule.prelude}: a property twice in one rule"


def test_no_rule_matches_nothing():
    assert css_sources.builder().dead_rules() == []


def test_important_only_where_a_layer_cannot_do_it():
    found = {}
    for path, _, nodes in sources():
        for ctx, rule in walk(nodes):
            for decl in rule.decls:
                if decl.important:
                    found[(rel(path), rule.prelude, decl.name)] = True
    assert set(found) == set(IMPORTANT), (
        "unexpected !important: " + str(sorted(set(found) - set(IMPORTANT)))
        + "; allow-listed but gone: " + str(sorted(set(IMPORTANT) - set(found)))
    )


def colour_literals(value: str) -> list[str]:
    out, i, n = [], 0, len(value)
    while i < n:
        ch = value[i]
        if ch in "\"'":
            i = css_tree.skip_string(value, i)
            continue
        if value.startswith("url(", i):
            i = css_tree.scan(value, i + 4, ")", n) + 1
            continue
        if ch == "#":
            j = i + 1
            while j < n and value[j] in css_tree.HEX:
                j += 1
            if j - i - 1 in (3, 4, 6, 8) and (j == n or value[j] not in css_tree.NAME_CHARS):
                out.append(value[i:j])
            i = j
            continue
        if ch in css_tree.NAME_CHARS and (i == 0 or value[i - 1] not in css_tree.NAME_CHARS):
            j = i
            while j < n and value[j] in css_tree.NAME_CHARS:
                j += 1
            word = value[i:j].lower()
            if j < n and value[j] == "(" and word + "(" in COLOUR_FUNCS:
                out.append(value[i : css_tree.scan(value, j + 1, ")", n) + 1])
            elif word in NAMED_COLOURS and not (j < n and value[j] == "("):
                out.append(value[i:j])
            i = j
            continue
        i += 1
    return out


def test_colour_literals_live_in_the_tokens_file_only():
    offenders = []
    for path, layer, nodes in sources():
        if layer == "tokens":
            continue
        for ctx, rule in walk(nodes):
            for decl in rule.decls:
                for literal in colour_literals(decl.value):
                    offenders.append(f"{rel(path)}:{rule.line} {rule.prelude[:60]} {{{decl.name}: {literal}}}")
        for node in nodes:
            if isinstance(node, css_tree.AtRule) and node.name == "keyframes":
                for literal in colour_literals(node.raw):
                    offenders.append(f"{rel(path)}: @keyframes {node.prelude}: {literal}")
    assert not offenders, "name a token (00-tokens.css) instead:\n" + "\n".join(offenders)


def test_every_page_sheet_declares_the_layers_once_and_keeps_them_in_order():
    for name, text in css_sources.sheets().items():
        body = text.split("\n", 1)[1]
        assert body.startswith("@layer tokens, base, components, features, overrides;\n"), name
        blocks = re.findall(r"^@layer (\w+) \{$", body, flags=re.M)
        assert blocks == sorted(blocks, key=list(LAYER_DIRS).index) and len(blocks) == len(set(blocks)), (name, blocks)
