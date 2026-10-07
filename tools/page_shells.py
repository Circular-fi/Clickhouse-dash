"""The generated parts of the page shells (query.html, explorer.html, functions.html, traces.html, logs.html, metrics.html, trace.html, system.html, queries.html, disks.html, shape.html).

Two regions of every shell are written from one source, so the shells cannot drift:

  <!-- shell:header --> ... <!-- /shell:header -->
      src/shell/header.html, the page header (brand, host picker, page and theme
      selects). Its placeholders take the page's values. Expanded at build time
      rather than rendered by a script, so the header is in the HTML the parser
      sees: it paints with the first frame, no flash, and costs no script.

  <!-- shell:fonts --> ... <!-- /shell:fonts -->
      the preloads of the web fonts every page paints first (FONT_PRELOADS, faces of
      src/static/css/00-tokens.css), written next to the stylesheet with the page's base path
      so the fonts download with it rather than after it; and window.__chdashIconSprite, the
      address of the icon sprite (static/icons.svg?v=<hash>, tools/icons.py) for ns.icon().

  <!-- shell:scripts --> ... <!-- /shell:scripts -->
      the page's entry of src/static/modules.json, inlined as
      <script type="application/json" id="chdashModules"> so app_loader.js has
      the module lists without a request, then the two scripts that start the
      page: app_loader.js and the page controller (pages.<page>.bootstrap). Before them, a
      snippet points the shell's static icons at the sprite under the page's base path.

The icons of a shell's static markup name the sprite as /static/icons.svg?v=<hash>#i-<name>;
build() stamps the current hash into every such address (shells and header alike).

tools/build_page_css.py runs this before building the stylesheets (they read
the shells), and its --check fails when a shell is stale.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import icons  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "src" / "static"
MANIFEST = STATIC / "modules.json"
HEADER = ROOT / "src" / "shell" / "header.html"
SHELLS = {
    "query": "Query", "explorer": "Explorer", "functions": "Explorer", "traces": "Observability", "logs": "Observability", "metrics": "Observability",
    "trace": "Observability", "system": "System", "queries": "System", "disks": "System", "shape": "System",
}
# A shell the page switcher files under another page: each Observability view and one trace are
# Observability's, each System section and one query shape System's.
NAV_PAGE = {"functions": "explorer", "traces": "observability", "logs": "observability", "metrics": "observability", "trace": "observability", "queries": "system", "disks": "system", "shape": "system"}
# The faces of the first paint (body text, labels and buttons, code): the other weights and the
# "Pi" symbols load when a page first uses them.
FONT_PRELOADS = ("IBMPlexSans-Regular-Latin1.woff2", "IBMPlexSans-Medium-Latin1.woff2", "IBMPlexMono-Regular-Latin1.woff2")


def manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def page_entry(page: str, data: dict | None = None) -> dict:
    """What a shell inlines for app_loader.js: the page's lists, the common ones first."""
    data = data or manifest()
    entry = data["pages"][page]
    return {
        "name": page,
        "bootstrap": entry["bootstrap"],
        "common": list(data["common"]),
        "modules": list(entry["modules"]),
        "lazy": dict(entry.get("lazy") or {}),
    }


def header_markup(page: str) -> str:
    nav = NAV_PAGE.get(page, page)
    text = HEADER.read_text(encoding="utf-8")
    # The partial's leading comment documents it; the shells get the markup only.
    if text.startswith("<!--"):
        text = text[text.index("-->") + 3 :].lstrip("\n")
    values = {
        "{{page.label}}": SHELLS[page],
        "{{observability.hidden}}": "" if nav == "observability" else " hidden",
        "{{system.hidden}}": "",
    }
    for other in ("query", "explorer", "observability", "system"):
        values[f"{{{{selected.{other}}}}}"] = "true" if other == nav else "false"
    for key, value in values.items():
        text = text.replace(key, value)
    assert "{{" not in text, f"unknown placeholder in {HEADER.name}"
    return text


def scripts_markup(page: str, data: dict | None = None) -> str:
    entry = page_entry(page, data)
    payload = json.dumps(entry, separators=(",", ":")).replace("</", "<\\/")
    # The shell's static icons name the sprite from the server root; under a reverse-proxy
    # prefix they take the prefixed address before the first paint.
    fixup = (
        "  <script>\n"
        "    (function () {\n"
        "      var sprite = window.__chdashIconSprite;\n"
        '      if (!sprite || sprite.indexOf("/static/") === 0) return;\n'
        "      var uses = document.querySelectorAll('use[href^=\"/static/icons.svg\"]');\n"
        "      for (var i = 0; i < uses.length; i += 1) {\n"
        '        var href = uses[i].getAttribute("href");\n'
        '        uses[i].setAttribute("href", sprite + href.slice(href.indexOf("#")));\n'
        "      }\n"
        "    })();\n"
        "  </script>\n"
    )
    starts = "\n".join(
        f'      start(window.__chdashUrl ? window.__chdashUrl("static/{name}") : "/static/{name}");' for name in ("app_loader.js", entry["bootstrap"])
    )
    return (
        "  <!-- The page's modules (src/static/modules.json), read by app_loader.js. -->\n"
        f'  <script type="application/json" id="chdashModules">{payload}</script>\n'
        + fixup
        + "  <script>\n"
        "    (function () {\n"
        "      // Both download at once and run in this order (async = false).\n"
        "      function start(src) {\n"
        '        var script = document.createElement("script");\n'
        "        script.src = src;\n"
        "        script.async = false;\n"
        "        document.body.appendChild(script);\n"
        "      }\n"
        f"{starts}\n"
        "    })();\n"
        "  </script>\n"
    )


def fonts_markup() -> str:
    names = ", ".join(f'"{name}"' for name in FONT_PRELOADS)
    return (
        "  <script>\n"
        "    (function () {\n"
        "      if (!window.__chdashUrl) return;\n"
        "      // The icon sprite (tools/icons.py): a new drawing is a new address.\n"
        f'      window.__chdashIconSprite = window.__chdashUrl("static/icons.svg?v={icons.version()}");\n'
        "      // Parsed right after the stylesheet link, so the fonts download with it.\n"
        f"      var fonts = [{names}];\n"
        "      for (var i = 0; i < fonts.length; i += 1) {\n"
        '        var href = window.__chdashUrl("static/fonts/" + fonts[i]).replace(/&/g, "&amp;").replace(/"/g, "&quot;");\n'
        "        document.write('<link rel=\"preload\" href=\"' + href + '\" as=\"font\" type=\"font/woff2\" crossorigin>');\n"
        "      }\n"
        "    })();\n"
        "  </script>\n"
    )


def replace_region(html: str, name: str, body: str, source: str) -> str:
    """The text between the region's markers becomes a note and `body`."""
    start, end = f"<!-- shell:{name} -->", f"<!-- /shell:{name} -->"
    a = html.index(start) + len(start)
    b = html.index(end, a)
    note = f"  <!-- Generated by tools/build_page_css.py from {source}: edit it there, then rerun the script. -->\n"
    return html[:a] + "\n" + note + body + "  " + html[b:]


ICON_HREF = re.compile(r'href="/static/icons\.svg(?:\?v=[0-9a-f]*)?#')


def stamp_icons(html: str) -> str:
    """Every static icon address names the current sprite."""
    return ICON_HREF.sub(f'href="/static/icons.svg?v={icons.version()}#', html)


def build() -> dict[Path, str]:
    data = manifest()
    outputs = {}
    for page in SHELLS:
        path = STATIC / f"{page}.html"
        html = path.read_text(encoding="utf-8")
        html = replace_region(html, "header", header_markup(page), "src/shell/header.html")
        html = replace_region(html, "fonts", fonts_markup(), "tools/page_shells.py (FONT_PRELOADS)")
        html = replace_region(html, "scripts", scripts_markup(page, data), "src/static/modules.json")
        outputs[path] = stamp_icons(html)
    return outputs
