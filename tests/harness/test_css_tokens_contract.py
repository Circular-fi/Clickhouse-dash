"""Stylesheet tokens (src/static/css/): every var() is defined, and the forced themes match the OS themes.

The palette is written for four contexts: ``:root`` (dark, the default),
``@media (prefers-color-scheme: light) :root`` (System on a light OS),
``html[data-theme="dark"]`` and ``html[data-theme="light"]`` (Dark / Light
forced in the app). A token the light media block sets must be reset by the
forced-dark block (otherwise Dark on a light OS keeps the light value), and the
forced-light block must set the same tokens to the same values. Component
overrides follow the same rule: ``html[data-theme="light"] X`` needs its System
twin ``html:not([data-theme="dark"]) X`` under the light media query.
"""
import re
from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"

# Read through a name assembled from a prefix at run time ("--qchart-" + n):
# the scan cannot see the full names, which 00-tokens.css defines.
RUNTIME_TOKENS = {
    "--qchart-",  # app_query_chart.js: `--qchart-${n}`
    "--trace-span-color-",  # trace service palette: `--trace-span-color-${n}`
    "--trace-heat-",  # heatmap ramp: `--trace-heat-${n}`
}

LIGHT_MEDIA = "@media (prefers-color-scheme: light)"
DARK_ATTR = 'html[data-theme="dark"]'
LIGHT_ATTR = 'html[data-theme="light"]'
LIGHT_GUARD = 'html:not([data-theme="dark"])'


def read(path: Path) -> str:
    return path.read_text(encoding="latin-1")


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)


def rules(text: str, media: str = ""):
    """(media, selector, body) for every style rule, @media blocks flattened."""
    i = 0
    while True:
        j = text.find("{", i)
        if j < 0:
            return
        selector = " ".join(text[i:j].split())
        depth, k = 1, j + 1
        while depth:
            depth += {"{": 1, "}": -1}.get(text[k], 0)
            k += 1
        body = text[j + 1 : k - 1]
        if selector.startswith("@media"):
            yield from rules(body, selector)
        elif not selector.startswith("@"):
            yield media, selector, body
        i = k


def declarations(body: str) -> dict[str, str]:
    return {name: " ".join(value.split()) for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", body)}


def css_rules():
    return list(rules(strip_comments(css_sources.text())))


def palettes():
    root, light_media, light_guard, dark_attr, light_attr = {}, {}, {}, {}, {}
    for media, selector, body in css_rules():
        tokens = declarations(body)
        if not tokens:
            continue
        if not media and selector == ":root":
            root.update(tokens)
        elif media == LIGHT_MEDIA and selector == ":root":
            light_media.update(tokens)
        elif media == LIGHT_MEDIA and selector == LIGHT_GUARD:
            light_guard.update(tokens)
        elif not media and selector == DARK_ATTR:
            dark_attr.update(tokens)
        elif not media and selector == LIGHT_ATTR:
            light_attr.update(tokens)
    return root, light_media, light_guard, dark_attr, light_attr


def test_forced_dark_resets_every_token_the_light_os_theme_sets():
    root, light_media, _, dark_attr, _ = palettes()
    missing = sorted(name for name in light_media if name not in dark_attr)
    assert not missing, f'html[data-theme="dark"] does not reset {missing}'
    drift = sorted(name for name in light_media if dark_attr[name] != root.get(name))
    assert not drift, f'html[data-theme="dark"] differs from the :root dark value for {drift}'


def test_forced_light_matches_the_light_os_theme():
    root, light_media, light_guard, _, light_attr = palettes()
    system_light = {**light_media, **light_guard}
    assert sorted(system_light) == sorted(light_attr), (
        sorted(set(system_light) ^ set(light_attr)),
        "tokens set by only one of the System-light and Light-forced blocks",
    )
    drift = sorted(name for name in light_attr if light_attr[name] != system_light[name])
    assert not drift, f"System light and forced Light disagree on {drift}"
    # Every themed token has a dark default (the guarded light block never
    # applies under forced Dark, so it needs no reset there).
    assert not sorted(set(light_attr) - set(root)), sorted(set(light_attr) - set(root))


def test_light_component_overrides_have_a_system_twin():
    found = {(media, selector): " ".join(body.split()) for media, selector, body in css_rules()}
    forced = [(selector, body) for (media, selector), body in found.items() if not media and selector.startswith(LIGHT_ATTR + " ")]
    assert forced, "expected component overrides for the forced Light theme"
    for selector, body in forced:
        twin = selector.replace(LIGHT_ATTR, LIGHT_GUARD)
        assert found.get((LIGHT_MEDIA, twin)) == body, f"{selector} has no identical System twin under {LIGHT_MEDIA}: {twin}"
    dark_only = [selector for (media, selector) in found if not media and selector.startswith(DARK_ATTR + " ")]
    assert not dark_only, f"dark overrides belong in the :root default: {dark_only}"


def defined_tokens() -> set[str]:
    names = set(re.findall(r"(--[\w-]+)\s*:", strip_comments(css_sources.text())))
    for path in list(STATIC.glob("*.js")) + list(STATIC.glob("*.html")):
        text = read(path)
        names |= set(re.findall(r"""setProperty\(\s*["'`](--[\w-]+)["'`]""", text))
        # Inline style strings: style="--x:..." or `--x:${...}`.
        names |= set(re.findall(r"""[;"'`\s](--[\w-]+):""", text))
    return names


def used_tokens() -> dict[str, list[str]]:
    used: dict[str, list[str]] = {}
    sources = [path for path, _ in css_sources.files()] + sorted(STATIC.glob("*.js")) + sorted(STATIC.glob("*.html"))
    for path in sources:
        text = strip_comments(read(path)) if path.suffix == ".css" else read(path)
        for name in re.findall(r"var\(\s*(--[\w-]+)", text):
            used.setdefault(name, []).append(path.name)
    return used


def test_every_css_variable_read_is_defined():
    defined = defined_tokens()
    undefined = {
        name: sorted(set(files))
        for name, files in used_tokens().items()
        if name not in defined and name not in RUNTIME_TOKENS
    }
    assert not undefined, f"var() of an undefined custom property (define it or add it to RUNTIME_TOKENS): {undefined}"
    # The allowlist only names prefixes, each of which has defined members.
    for prefix in RUNTIME_TOKENS:
        assert prefix.endswith("-") and any(name.startswith(prefix) for name in defined), prefix


def test_text_uses_the_two_font_tokens():
    css = css_sources.text()
    assert css.count("ui-monospace") == 1, "write font stacks as var(--font-mono) / var(--font-sans)"
    assert '--font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;' in css
    assert '--font-sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;' in css
