"""The stylesheet sources: one file per layer role, cascade layers, one rule per selector, and the rules that keep a page cheap and legible.

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


# The widths at which a layout changes (docs/ui-foundations.md, "Page shell"): --bp-sm, --bp-tab, --bp-md, --bp-lg, --bp-xl.
BREAKPOINTS = {600, 760, 820, 1100, 1279}


def test_a_media_query_names_one_of_the_five_breakpoints():
    offenders = []
    for path, layer, nodes in sources():
        for node in nodes:
            stack = [node]
            while stack:
                current = stack.pop()
                if not isinstance(current, css_tree.AtRule):
                    continue
                if current.name == "media":
                    for kind, value, unit in re.findall(r"\((max|min)-width:\s*([0-9.]+)(px|rem|em)\)", current.prelude):
                        px = float(value) * (1 if unit == "px" else 16)
                        # A min-width is the pixel above a breakpoint (821 pairs with max-width: 820).
                        if px not in (BREAKPOINTS if kind == "max" else {b + 1 for b in BREAKPOINTS}):
                            offenders.append(f"{rel(path)}: @media {current.prelude}")
                stack.extend(current.children or [])
    assert not offenders, "use --bp-sm / --bp-tab / --bp-md / --bp-lg / --bp-xl (600, 760, 820, 1100, 1279):\n" + "\n".join(offenders)


SPACES = {2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80}
SPACING = re.compile(r"(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?")


def test_spacing_is_the_scale_a_hairline_or_an_overlapping_margin():
    tokens = css_sources.tokens()
    for size in SPACES:
        assert f"  --space-{size}: {size}px;" in tokens and tokens.count(f"  --space-{size}:") == 1, size
    assert "--ui-gap-" not in css_sources.text()
    offenders = []
    for path, layer, nodes in sources():
        if layer in ("tokens", "base"):
            continue
        for ctx, rule in walk(nodes):
            for decl in rule.decls:
                if not SPACING.fullmatch(decl.name):
                    continue
                value = " ".join(decl.value.split())
                # What a length function or a relative unit computes is not a step of the scale.
                if re.search(r"calc\(|min\(|max\(|clamp\(|%|\d(ch|em)\b|env\(", value):
                    continue
                for part in value.replace("!important", "").split():
                    token = re.fullmatch(r"var\(--space-(\d+)\)", part)
                    if part in ("0", "auto", "inherit", "initial", "unset", "1px", "-1px") or part.startswith("var(") and not token:
                        continue
                    if token and int(token.group(1)) in SPACES:
                        continue
                    # A negative margin on the scale (the overlap of two borders, a pulled-in icon).
                    negative = re.fullmatch(r"-(\d+)px", part)
                    if negative and int(negative.group(1)) in SPACES:
                        continue
                    offenders.append(f"{rel(path)}:{rule.line} {rule.prelude[:60]} {{{decl.name}: {decl.value.strip()}}}")
                    break
    assert not offenders, "use var(--space-N) (N: 2 4 6 8 10 12 16 20 24 32 40 48 64 80):\n" + "\n".join(offenders)


# ---- breakpoints, motion, contrast --------------------------------------------------------------------------------------------------


def test_the_breakpoints_of_the_scripts_are_the_tokens_of_the_stylesheet():
    # Why: a layout that changes at 820 px in CSS and at 800 px in a script shows a half-switched page between the two.
    tokens = css_sources.tokens()
    css = {name: int(value) for name, value in re.findall(r"--bp-(sm|tab|md|lg|xl):\s*(\d+)px;", tokens)}
    assert set(css) == {"sm", "tab", "md", "lg", "xl"}
    assert {value for value in css.values()} == BREAKPOINTS
    for name in css:
        assert tokens.count(f"--bp-{name}:") == 1, name
    dom = (css_sources.ROOT / "src/static/app_dom.js").read_text(encoding="utf-8")
    script = dict(re.findall(r"(\w+): (\d+)", re.search(r"const BREAKPOINTS = Object\.freeze\(\{([^}]*)\}\);", dom).group(1)))
    assert {key: int(value) for key, value in script.items()} == css


def test_no_infinite_animation_runs_on_a_property_that_repaints_or_relayouts_every_frame():
    # Why: a page at rest must cost nothing (idle CPU): an endless animation of box-shadow or of a box size repaints on the main thread
    # every frame (the host dot once cost 7 to 20 % of a core on every page).
    css = css_sources.text()
    used = set()
    for match in re.finditer(r"animation(?:-name)?:([^;]*);", css):
        if re.search(r"\binfinite\b", match.group(1)):
            used.update(re.findall(r"\b([A-Za-z][\w-]*)\b", match.group(1)))
    keyframes = {}
    for name, body in re.findall(r"@keyframes\s+([\w-]+)\s*\{(.*?\})\s*\}", css, flags=re.S):
        keyframes[name] = body
    checked = 0
    for name in sorted(used & set(keyframes)):
        props = set(re.findall(r"([a-z-]+)\s*:", keyframes[name]))
        assert not props & {"box-shadow", "width", "height", "top", "left", "right", "bottom", "margin", "padding", "filter"}, (name, props)
        checked += 1
    assert checked >= 3


def _luminance(value: str) -> float:
    value = value.lstrip("#")
    channels = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _ratio(a: str, b: str) -> float:
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def test_the_categorical_colours_keep_three_to_one_on_the_panel_and_the_page_in_each_theme():
    # Why: a series that is hard to tell from the surface under it is lost (WCAG 1.4.11 asks 3:1 for the marks of a graphic).
    tokens = css_sources.tokens()
    starts = [m.start() for m in re.finditer(r'^(?::root|@media \(prefers-color-scheme: light\)|html\[data-theme="(?:dark|light)"\]) \{', tokens, flags=re.M)]
    assert len(starts) >= 4
    checked = 0
    for index, start in enumerate(starts):
        body = tokens[start:starts[index + 1] if index + 1 < len(starts) else len(tokens)]
        values = dict(re.findall(r"--(qchart-\d+|panel|bg):\s*(#[0-9a-fA-F]{6});", body))
        if "panel" not in values:
            continue
        for name, value in values.items():
            if not name.startswith("qchart"):
                continue
            for surface in ("panel", "bg"):
                assert _ratio(value, values[surface]) >= 3, (body[:40], name, surface)
            checked += 1
    assert checked >= 4 * 18
