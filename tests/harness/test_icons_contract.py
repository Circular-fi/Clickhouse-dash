"""Icons: one sprite (src/static/icons.svg), one helper (ns.icon, app_ui_icon.js), one paint
(.icon, css/10-components/icon.css). docs/ui-foundations.md, "Icons"."""
from __future__ import annotations

import html.parser
import importlib.util
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"
SHELL_PAGES = ("query", "explorer", "traces", "logs", "metrics", "trace", "system", "shape")


def tools_module(name: str):
    sys.path.insert(0, str(ROOT / "tools"))
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


icons = tools_module("icons")


def sources() -> dict[str, str]:
    out = {}
    for path in [*STATIC.glob("*.js"), *STATIC.glob("*.html"), ROOT / "src" / "shell" / "header.html", *(STATIC / "css").rglob("*.css")]:
        out[str(path.relative_to(ROOT))] = path.read_text(encoding="utf-8")
    return out


def test_the_sprite_is_ascii_geometry_on_the_24_grid():
    raw = (STATIC / "icons.svg").read_bytes()
    raw.decode("ascii")
    text = raw.decode("ascii")
    ids = re.findall(r'<symbol id="([^"]+)"', text)
    assert len(ids) == len(set(ids)) and len(ids) >= 40
    assert all(re.fullmatch(r"i-[a-z0-9]+(?:-[a-z0-9]+)*", i) for i in ids), ids
    assert text.count('viewBox="0 0 24 24"') == len(ids)
    # Geometry only: the .icon rule paints every symbol (a 1.5 stroke in currentColor).
    markup = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    for attr in ("fill=", "stroke=", "stroke-width=", "style=", "class="):
        assert attr not in markup, attr
    assert "Tabler Icons" in text and "icons.LICENSE.txt" in text
    licence = (STATIC / "icons.LICENSE.txt").read_text(encoding="utf-8")
    assert licence.startswith("MIT License") and "Permission is hereby granted" in licence


def test_the_icon_rule_paints_a_1_5_stroke_in_current_color():
    css = (STATIC / "css" / "10-components" / "icon.css").read_text(encoding="utf-8")
    rule = css[css.index(".icon {"):css.index("}", css.index(".icon {"))]
    for decl in ("width: var(--icon-md);", "height: var(--icon-md);", "flex-shrink: 0;", "vertical-align: middle;",
                 "fill: none;", "stroke: currentColor;", "stroke-width: 1.5;", "stroke-linecap: round;", "stroke-linejoin: round;"):
        assert decl in rule, decl
    tokens = (STATIC / "css" / "00-tokens.css").read_text(encoding="utf-8")
    for size, px in (("sm", 14), ("md", 16), ("lg", 18)):
        assert f"--icon-{size}: {px}px;" in tokens
    # No component restyles the stroke of an icon.
    for name, text in sources().items():
        if name.endswith(".css") and not name.endswith("icon.css"):
            assert not re.search(r"\.icon[^{]*\{[^}]*stroke-width", text), name


def test_no_svg_data_uri_outside_the_generated_masks():
    # The only data: SVGs are the --icon-* masks generated from the sprite (00-tokens.css,
    # tools/icons.py) and the editor's wavy error underline, a repeating decoration.
    allowed = {"src/static/css/00-tokens.css": len(icons.MASK_ICONS), "src/static/css/20-features/query.css": 1}
    for name, text in sources().items():
        count = text.count("data:image/svg")
        assert count == allowed.get(name, 0), (name, count)
    query = (STATIC / "css" / "20-features" / "query.css").read_text(encoding="utf-8")
    wave = query[query.index(".editorDiagnostic::after {"):]
    assert "data:image/svg" in wave[:wave.index("}")]


def test_the_masks_and_the_shells_follow_the_sprite():
    tokens = (STATIC / "css" / "00-tokens.css").read_text(encoding="utf-8")
    assert icons.tokens_css(tokens) == tokens, "run python3 tools/build_page_css.py"
    for name in icons.MASK_ICONS:
        assert f"var(--icon-{name})" in "".join(t for n, t in sources().items() if n.endswith(".css") and "00-tokens" not in n), name
    version = icons.version()
    for page in SHELL_PAGES:
        shell = (STATIC / f"{page}.html").read_text(encoding="utf-8")
        hrefs = re.findall(r'href="([^"]*icons\.svg[^"]*)"', shell)
        assert hrefs and all(h.startswith(f"/static/icons.svg?v={version}#i-") for h in hrefs), page
        assert f'window.__chdashIconSprite = window.__chdashUrl("static/icons.svg?v={version}");' in shell, page


def referenced_icons() -> dict[str, set[str]]:
    """Every sprite name the sources ask for: <use href="...#i-name">, ns.icon("name") and
    ns.icon.el("name"), and the icon tables that feed ns.icon a variable."""
    out: dict[str, set[str]] = {}
    tables = {
        "src/static/app_explorer.js": r"icon: \"([a-z0-9-]+)\", label:",
        "src/static/app_explorer_detail.js": r"(?:table|view|mv|dictionary|buffer|distributed|unknown): \"([a-z0-9-]+)\"",
        "src/static/app_query_library.js": r"\b(?:search|lock|folder|folderOpen|folderPlus|query|plus|back|server|local|edit|move|remove|save): \"([a-z0-9-]+)\"",
        "src/static/app_pipeline_viewer.js": r"\(\) => [^,]+, \"([a-z0-9-]+)\"(?:, true)?\);",
        "src/static/app_trace_spans.js": r"`Move \$\{column\.key\} (?:left|right)`, \"([a-z0-9-]+)\"",
        "src/static/app_timerange.js": r"nav\(\"Range\w+\", \"[^\"]+\", \"([a-z0-9-]+)\"\)",
        "src/static/app_query_chart.js": r"\[\"(?:line|area|bar|number)\", \"[^\"]+\", \"[^\"]+\", \"([a-z0-9-]+)\"\],",
    }
    for name, text in sources().items():
        found = set(re.findall(r"#i-([a-z0-9-]+)", text))
        found |= set(re.findall(r"ns\.icon(?:\.el)?\(\s*\"([a-z0-9-]+)\"", text))
        found |= set(re.findall(r"ChDash\.icon(?:\.el)?\(\s*\"([a-z0-9-]+)\"", text))
        if name in tables:
            table = set(re.findall(tables[name], text))
            assert table, name
            found |= table
        found.discard("name")  # the helper's own documentation
        if found:
            out[name] = found
    return out


def test_every_icon_the_sources_name_is_in_the_sprite():
    have = set(icons.symbols())
    refs = referenced_icons()
    missing = {name: sorted(found - have) for name, found in refs.items() if found - have}
    assert not missing, missing
    used = set().union(*refs.values()) | set(icons.MASK_ICONS)
    # The sprite carries no drawing nobody uses.
    assert have - used == set(), sorted(have - used)


def test_no_unicode_glyph_stands_in_for_an_icon():
    # Close crosses, chevrons, arrows on buttons, the object-kind shapes, the editor glyphs:
    # the sprite draws them. Typographic characters stay text: the "·" separator,
    # "≈" estimates, "×" multipliers ("×691", "1 shard × 2 replicas"),
    # arrows in prose and ranges ("12:30 → 13:30"), "⌘" in shortcut hints, and
    # the canvas group labels of the Explorer graph ("▾"/"▸", drawn as text).
    glyphs = ["\\u2304", "\\u203a", "\\u2315", "\\u2197", "\\u25a6", "\\u25c7", "\\u25c6", "\\u25c8", "\\u25a4", "\\u25a5",
              "\\u25a2", "\\u229e", "\\u22ef", "\\u2195", "\\u25b2", "\\u25bc", "&times;", "&minus;", "&uarr;"]
    for name, text in sources().items():
        code = text if name.endswith((".html", ".css")) else re.sub(r"^\s*//.*$", "", text, flags=re.M)
        for glyph in glyphs:
            if glyph in ("\\u25b2", "\\u25bc") and name.endswith(".js"):
                continue
            assert glyph not in code, (name, glyph)
        # A close button holds the x icon, not the multiplication sign.
        assert not re.search(r">\s*(?:×|\\u00d7)\s*</button>", code), name
        assert not re.search(r"\"(?:×|\\u00d7)\"\)", code), name
    graph = (STATIC / "app_explorer_graph.js").read_text(encoding="utf-8")
    assert graph.count("ctx.fillText(") >= 2 and "\\u25be" in graph and "\\u25b8" in graph


class Buttons(html.parser.HTMLParser):
    """Each <button>: its attributes, whether it holds an icon, and its own text (a child
    element other than an icon counts as text: scripts fill it)."""

    def __init__(self) -> None:
        super().__init__()
        self.buttons: list[dict] = []
        self.stack: list[dict] = []
        self.in_svg = 0

    def handle_starttag(self, tag, attrs):
        if tag == "button":
            self.stack.append({"attrs": dict(attrs), "icon": False, "text": ""})
        elif tag == "svg" and self.stack:
            self.in_svg += 1
            if "icon" in (dict(attrs).get("class") or "").split():
                self.stack[-1]["icon"] = True
        elif self.stack and not self.in_svg and tag != "use":
            self.stack[-1]["text"] += f"<{tag}>"

    def handle_startendtag(self, tag, attrs):
        if tag == "svg":
            self.handle_starttag(tag, attrs)
            self.handle_endtag(tag)
        elif tag != "use" and self.stack and not self.in_svg:
            self.stack[-1]["text"] += f"<{tag}>"

    def handle_endtag(self, tag):
        if tag == "svg" and self.in_svg:
            self.in_svg -= 1
        if tag == "button" and self.stack:
            self.buttons.append(self.stack.pop())

    def handle_data(self, data):
        if self.stack:
            self.stack[-1]["text"] += data


def test_icon_only_buttons_in_the_shells_have_a_label_and_a_title():
    for page in SHELL_PAGES:
        parser = Buttons()
        parser.feed((STATIC / f"{page}.html").read_text(encoding="utf-8"))
        icon_only = [b for b in parser.buttons if b["icon"] and not b["text"].strip()]
        # The System shell ships its header only (its sections draw their controls); the
        # trace shell its header and the back arrow of the trace; Logs and Metrics their header
        # and a few controls of their own.
        assert len(icon_only) >= (3 if page in ("system", "trace", "shape", "logs", "metrics") else 6), page
        for button in icon_only:
            attrs = button["attrs"]
            assert attrs.get("aria-label") and attrs.get("title"), (page, attrs)


def test_the_helper_is_one_common_module():
    import json

    manifest = json.loads((STATIC / "modules.json").read_text(encoding="utf-8"))
    common = manifest["common"]
    assert common.index("app_ui_icon.js") == common.index("app_util.js") + 1
    helper = (STATIC / "app_ui_icon.js").read_text(encoding="utf-8")
    assert "ns.icon = Object.freeze(icon);" in helper
    assert 'return `<svg class="${esc(classOf(opts))}"${a11y}><use href="${esc(href(name))}"/></svg>`;' in helper
    assert "window.__chdashIconSprite" in helper
    # No other module builds an inline <svg> icon: they ask ns.icon.
    for name, text in sources().items():
        if name.endswith(".js") and not name.endswith(("app_ui_icon.js", "app_ui_chart.js", "app_dom.js")):
            assert 'viewBox="0 0 16 16"' not in text and "viewBox: \"0 0 16 16\"" not in text, name


def test_the_builds_ship_the_icon_tool():
    # tools/build_page_css.py imports tools/icons.py (through page_shells.py): every build that
    # runs it copies it, and CMake restages when it changes.
    docker = (ROOT / "tests" / "Dockerfile.source").read_text(encoding="utf-8")
    copy = next(line for line in docker.splitlines() if line.startswith("COPY tools/build_page_css.py"))
    for tool in ("build_page_css.py", "css_tree.py", "icons.py", "page_shells.py"):
        assert f"tools/{tool}" in copy, tool
    cmake = (ROOT / "src" / "CMakeLists.txt").read_text(encoding="utf-8")
    assert '"${CMAKE_CURRENT_LIST_DIR}/../tools/icons.py"' in cmake


def test_the_logo_mark_and_the_favicon_are_one_drawing_on_every_page():
    header = (ROOT / "src" / "shell" / "header.html").read_text(encoding="utf-8")
    mark = re.search(r'<svg class="appBrand__logo" viewBox="0 0 18 18" aria-hidden="true">(.*?)</svg>', header).group(1)
    bars = re.findall(r'<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" rx="1"/>', mark)
    assert len(bars) == 4 and "".join(bars) == mark
    favicon = (STATIC / "images" / "logo.svg").read_text(encoding="ascii")
    assert all(bar in favicon for bar in bars)
    assert "prefers-color-scheme:dark" in favicon
    ico = (STATIC / "images" / "favicon.ico").read_bytes()
    assert ico[:4] == b"\x00\x00\x01\x00" and int.from_bytes(ico[4:6], "little") == 3
    shell_css = (STATIC / "css" / "20-features" / "shell.css").read_text(encoding="utf-8")
    logo_rule = shell_css[shell_css.index(".appBrand__logo {"):]
    logo_rule = logo_rule[:logo_rule.index("}")]
    assert "width: 18px;" in logo_rule and "height: 18px;" in logo_rule and "fill: var(--accent-fill);" in logo_rule
    for page in SHELL_PAGES:
        shell = (STATIC / f"{page}.html").read_text(encoding="utf-8")
        assert 'favicon.href = window.__chdashUrl("static/images/logo.svg");' in shell, page
        assert 'fallbackIcon.href = window.__chdashUrl("static/images/favicon.ico");' in shell, page
        assert shell.count('class="appBrand__logo"') == 1, page


def test_an_inline_chip_with_an_icon_does_not_grow_its_line():
    # An <svg> has no baseline: an inline-flex chip whose first item is an icon sits on the
    # icon's bottom edge. The trace header's Logs chip is centred instead, or its 14 px icon
    # grew the header and moved the graph under it.
    traces = (STATIC / "css" / "20-features" / "traces.css").read_text(encoding="utf-8")
    rule = traces[traces.index("\n.traceLogsToggle {"):]
    rule = rule[:rule.index("}")]
    assert "display: inline-flex;" in rule and "vertical-align: middle;" in rule
