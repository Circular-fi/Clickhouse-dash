"""Visual foundations (docs/ui-foundations.md, "Type, shape, motion and stacking").

Two families, six text sizes (and one display size), three weights, three radii and a pill, one
overlay shadow, two durations and one easing, one stacking scale. Every stylesheet declaration names
those tokens: no font size, weight or family, radius, z-index or blurred shadow is written as a
literal outside src/static/css/00-tokens.css, and the canvas fonts of the scripts follow the same
families, weights and sizes.
"""
import re
import sys
from pathlib import Path

import css_sources

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"
FONTS = STATIC / "fonts"
sys.path.insert(0, str(ROOT / "tools"))
import css_tree  # noqa: E402

FONT_SIZES = {"--fs-xs": "11px", "--fs-sm": "12px", "--fs-md": "13px", "--fs-lg": "14px", "--fs-xl": "16px", "--fs-2xl": "20px", "--fs-display": "32px"}
FONT_WEIGHTS = {"--fw-regular": "400", "--fw-medium": "500", "--fw-semibold": "600"}
RADII = {"--r-xs": "3px", "--r-sm": "4px", "--r-md": "6px", "--r-lg": "8px", "--r-pill": "999px"}
MOTION = {"--dur-quick": "120ms", "--dur-base": "160ms"}
# The pill: status badges, filter chips, status dots' containers and scrollbar thumbs.
PILL_SELECTORS = {
    "::-webkit-scrollbar-thumb", ".autocompleteMenu::-webkit-scrollbar-thumb", ".badge--pill", ".traceSpanRow__errorBadge",
    ".traceSvcPill__error", ".graphKitStatus", ".explorerHealthBadge", ".statusPill", ".qhItem__status",
}
# What opens over the page: the only rules that cast --shadow-overlay.
OVERLAY_WORDS = ("menu", "Menu", "popover", "Popover", "Tip", "tooltip", "Tooltip", "Dialog", "dialog", "Toast", "toast",
                 "uiSide", "uiDetail", "ContextPanel", "timeRangePanel")
# A blurred shadow that is not elevation: the fade over the autocomplete list's last row.
BLUR_ALLOWED = {(".autocompleteMore", "0 -0.35rem 0.55rem var(--buttonBg)")}


def walk(nodes, ctx=()):
    for node in nodes:
        if isinstance(node, css_tree.Rule):
            yield ctx, node
        elif isinstance(node, css_tree.AtRule) and node.children is not None:
            yield from walk(node.children, ctx + (node.header(),))


def declarations():
    """(file, selector list, property, value) of every declaration of the sources, @font-face aside."""
    for path, _ in css_sources.files():
        for _, rule in walk(css_tree.parse(css_sources.read(path))):
            for decl in rule.decls:
                yield path.relative_to(css_sources.CSS).as_posix(), rule.prelude, decl.name, decl.value


def token_definitions() -> dict[str, set[str]]:
    """Every custom property and the values it is given anywhere (tokens or a component)."""
    out: dict[str, set[str]] = {}
    for _, _, name, value in declarations():
        if name.startswith("--"):
            out.setdefault(name, set()).add(" ".join(value.split()))
    return out


DEFS = token_definitions()


def resolves_to(value: str, prefix: str, seen=()) -> bool:
    """`value` is var(--<prefix>...) or a var() of a custom property whose every value resolves so."""
    match = re.fullmatch(r"var\((--[\w-]+)\)", value.strip())
    if not match:
        return False
    name = match.group(1)
    if name.startswith(prefix):
        return name in DEFS
    if name in seen or name not in DEFS:
        return False
    return all(resolves_to(v, prefix, seen + (name,)) for v in DEFS[name])


def font_shorthand_ok(value: str) -> bool:
    value = " ".join(value.split())
    if value == "inherit":
        return True
    match = re.fullmatch(r"var\((--[\w-]+)\)", value)
    if match:
        return all(font_shorthand_ok(v) for v in DEFS.get(match.group(1), {"?"}))
    parts = value.split()
    family = parts.pop() if parts else ""
    if not resolves_to(family, "--font-"):
        return False
    size = parts.pop() if parts else ""
    if not resolves_to(size.split("/")[0], "--fs-"):
        return False
    for word in parts:
        if word not in ("italic", "normal") and not resolves_to(word, "--fw-"):
            return False
    return True


def tokens_block() -> str:
    return css_sources.tokens()


def test_the_scales_are_defined_once_in_the_tokens():
    text = tokens_block()
    for table in (FONT_SIZES, FONT_WEIGHTS, RADII, MOTION):
        for name, value in table.items():
            assert f"  {name}: {value};" in text, name
            assert text.count(f"  {name}:") == 1, f"{name} is themed: it must have one value"
    assert re.search(r"  --ease: cubic-bezier\([^)]*\);", text)
    assert '  --font-sans: "IBM Plex Sans", ' in text and '  --font-mono: "IBM Plex Mono", ' in text
    # Nothing below 11 px: the smallest size token.
    assert min(int(v[:-2]) for v in FONT_SIZES.values()) == 11


def test_font_sizes_and_weights_name_the_tokens():
    offenders = []
    for name, prelude, prop, value in declarations():
        v = " ".join(value.split())
        if prop == "font-size" and v not in ("inherit", "0") and not resolves_to(v, "--fs-"):
            offenders.append(f"{name}: {prelude[:70]} {{font-size: {v}}}")
        if prop == "font-weight" and v != "inherit" and not resolves_to(v, "--fw-"):
            offenders.append(f"{name}: {prelude[:70]} {{font-weight: {v}}}")
        if prop == "font" and not font_shorthand_ok(v):
            offenders.append(f"{name}: {prelude[:70]} {{font: {v}}}")
    # Component size tokens (--dt-font, --explorer-section-title-weight...) alias the scale.
    for token, values in DEFS.items():
        if re.search(r"(-font|-font-size|-size|-weight)$", token) and token.startswith(("--dt-", "--explorer-")):
            for v in values:
                assert resolves_to(v, "--fs-") or resolves_to(v, "--fw-"), f"{token}: {v} is not a type token"
    assert not offenders, "use --fs-* / --fw-* / --font-*:\n" + "\n".join(offenders)


def test_font_families_are_the_two_tokens():
    offenders = []
    for name, prelude, prop, value in declarations():
        v = " ".join(value.split())
        if prop == "font-family" and v != "inherit" and not resolves_to(v, "--font-"):
            offenders.append(f"{name}: {prelude[:70]} {{font-family: {v}}}")
    assert not offenders, "\n".join(offenders)
    css = re.sub(r"/\*.*?\*/", "", css_sources.text(), flags=re.S)
    # Family names appear in the two stacks and the @font-face rules only.
    for family in ("Arial", "ui-monospace", "Menlo", "Consolas", "system-ui"):
        assert css.count(family) == 1, f"{family} outside the --font-sans / --font-mono stacks"
    assert "Helvetica" not in css
    assert "var(--mono)" not in css


def test_web_fonts_are_shipped_with_their_licence():
    faces = re.findall(r"@font-face \{(.*?)\}", tokens_block(), flags=re.S)
    assert faces
    shipped = set()
    for face in faces:
        assert "font-display: swap;" in face
        src = re.search(r'src: url\("fonts/([\w-]+\.woff2)"\) format\("woff2"\);', face)
        assert src, face
        shipped.add(src.group(1))
        assert re.search(r"font-weight: (400|500|600)( (500|600))?;", face), face
        assert "unicode-range:" in face
    on_disk = {p.name for p in FONTS.glob("*.woff2")}
    assert shipped == on_disk, (shipped, on_disk)
    total = sum((FONTS / name).stat().st_size for name in on_disk)
    assert total <= 125 * 1024, f"{total} bytes of web fonts"
    licence = (FONTS / "LICENSE.txt").read_text(encoding="utf-8")
    assert "SIL OPEN FONT LICENSE Version 1.1" in licence and 'Reserved Font Name "Plex"' in licence
    # The shells preload the first-paint faces (tools/page_shells.py, FONT_PRELOADS).
    for page in ("query", "explorer", "traces", "logs", "metrics", "system"):
        html = (STATIC / f"{page}.html").read_text(encoding="utf-8")
        region = html[html.index("<!-- shell:fonts -->"):html.index("<!-- /shell:fonts -->")]
        assert 'as="font" type="font/woff2" crossorigin' in region, page
        for name in ("IBMPlexSans-Regular-Latin1.woff2", "IBMPlexSans-Medium-Latin1.woff2", "IBMPlexMono-Regular-Latin1.woff2"):
            assert f'"{name}"' in region and name in shipped, (page, name)
    server = (ROOT / "src" / "serve_embedded_static.hpp").read_text(encoding="utf-8")
    assert 'if (ext == "woff2")return "font/woff2";' in server
    assert '== "woff2") return "public, max-age=604800";' in server


def test_radii_are_the_tokens_and_the_pill_is_for_status_and_chips():
    offenders, pills = [], []
    for name, prelude, prop, value in declarations():
        if not re.fullmatch(r"(border-([a-z]+-)*)?radius", prop):
            continue
        for part in value.split():
            if part in ("0", "50%", "inherit") or resolves_to(part, "--r-"):
                if part == "var(--r-pill)":
                    pills.extend(s.strip() for s in prelude.split(","))
                continue
            offenders.append(f"{name}: {prelude[:70]} {{{prop}: {value}}}")
    assert not offenders, "use --r-sm / --r-md / --r-lg (50% for a dot):\n" + "\n".join(offenders)
    assert set(pills) <= PILL_SELECTORS, sorted(set(pills) - PILL_SELECTORS)


def shadow_layers(value: str) -> list[str]:
    layers, depth, current = [], 0, ""
    for ch in value:
        depth += {"(": 1, ")": -1}.get(ch, 0)
        if ch == "," and depth == 0:
            layers.append(current.strip())
            current = ""
        else:
            current += ch
    layers.append(current.strip())
    return layers


def test_only_overlays_cast_a_shadow():
    offenders = []
    for name, prelude, prop, value in declarations():
        if prop != "box-shadow" or prop.startswith("--"):
            continue
        v = " ".join(value.split())
        if v == "var(--shadow-overlay)":
            first = re.split(r"[\s>+~]+", prelude.split(",")[0].strip())[-1]
            if not any(word in first for word in OVERLAY_WORDS):
                offenders.append(f"{name}: {prelude[:70]} casts the overlay shadow")
            continue
        for layer in shadow_layers(v):
            if layer.startswith("inset") or layer in ("none", "var(--ring)") or (prelude, layer) in BLUR_ALLOWED:
                continue
            lengths = re.findall(r"-?\d*\.?\d+(?:px|rem|em)?", re.sub(r"(var|color-mix|calc)\([^)]*\)+", "", layer))
            # x y [blur [spread]]: a blur above 0 is elevation.
            if len(lengths) >= 3 and float(re.sub(r"[a-z]+", "", lengths[2]) or 0) > 0:
                offenders.append(f"{name}: {prelude[:70]} {{box-shadow: {v}}}")
    assert not offenders, "only what opens over the page casts var(--shadow-overlay):\n" + "\n".join(offenders)
    css = re.sub(r"/\*.*?\*/", "", css_sources.text(), flags=re.S)
    for gone in ("--buttonSheen", "--panelTopSheen", "--shadow1", "--shadow2"):
        assert gone not in css, gone
    # The dialog backdrop dims without a blur.
    assert not re.search(r"backdrop-filter:(?!\s*none)", css)
    assert css_sources.rules(".uiDialog::backdrop")[0][3] == {"background": "var(--backdrop)"}


def test_z_index_names_the_stacking_scale():
    offenders = []
    for name, prelude, prop, value in declarations():
        v = " ".join(value.split())
        if prop == "z-index" and not (resolves_to(v, "--z-") or re.fullmatch(r"calc\(var\(--z-[\w-]+\) [-+] \d+\)", v)):
            offenders.append(f"{name}: {prelude[:70]} {{z-index: {v}}}")
    assert not offenders, "name a --z-* step (00-tokens.css):\n" + "\n".join(offenders)


def test_transitions_use_the_motion_tokens_and_infinite_animations_stop_on_reduced_motion():
    offenders = []
    for name, prelude, prop, value in declarations():
        if prop == "transition":
            for ms in re.findall(r"(?<![\w-])(\d*\.?\d+m?s)\b", value):
                if ms not in ("0s",):
                    offenders.append(f"{name}: {prelude[:70]} {{transition: {value}}}")
    assert not offenders, "transitions take var(--dur-quick) / var(--dur-base) and var(--ease):\n" + "\n".join(offenders)
    css = css_sources.text()
    infinite = []
    for path, _ in css_sources.files():
        for ctx, rule in walk(css_tree.parse(css_sources.read(path))):
            for decl in rule.decls:
                if decl.name == "animation" and "infinite" in decl.value and not ctx:
                    infinite.append(rule.prelude)
    reduced = set()
    for path, _ in css_sources.files():
        for ctx, rule in walk(css_tree.parse(css_sources.read(path))):
            if ctx and "prefers-reduced-motion: reduce" in ctx[-1]:
                for decl in rule.decls:
                    if decl.name in ("animation", "animation-name") and decl.value.strip() == "none":
                        reduced.update(rule.selectors)
    missing = [p for p in infinite if not {s.strip() for s in p.split(",")} <= reduced]
    assert not missing, f"infinite animations without a reduced-motion stop: {missing}"
    # The healthy host dot's ring (three pulses, not endless) stops too; the Explorer tree's dot uses it.
    assert ".hostDot--good::after" in reduced


def test_editor_frame_carries_the_focus_mark():
    rules = css_sources.rules(".editorWrap:focus-within")
    assert rules and rules[0][3].get("border-color") == "var(--accent-fill)"


def test_canvas_fonts_follow_the_tokens():
    kit = (STATIC / "app_graph_kit.js").read_text(encoding="latin-1")
    sans = re.search(r"  --font-sans: (.*);", tokens_block()).group(1)
    assert f"  const FONT = '{sans}';" in kit
    sizes = {int(v[:-2]) for v in FONT_SIZES.values()}
    offenders = []
    for path in sorted(STATIC.glob("*.js")):
        text = path.read_text(encoding="latin-1")
        for match in re.finditer(r"\.font = `([^`]*)`|font(?:Bold)?: `([^`]*)`", text):
            spec = match.group(1) or match.group(2)
            for weight in re.findall(r"(?<![\w$])(\d{3})(?= )", spec):
                if weight not in FONT_WEIGHTS.values():
                    offenders.append(f"{path.name}: {spec}")
            for size in re.findall(r"(?<![\w.$])(\d+)px", spec):
                if int(size) not in sizes:
                    offenders.append(f"{path.name}: {spec}")
        if re.search(r"Arial|Helvetica|monospace", text.replace(f"  const FONT = '{sans}';", "")):
            offenders.append(f"{path.name}: a raw font family")
    assert not offenders, "\n".join(offenders)
