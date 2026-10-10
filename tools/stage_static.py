#!/usr/bin/env python3
"""Prepare the staged static files (the directory CMake embeds into the binary) for the network.

Run by CMake after tools/build_page_css.py has written the page stylesheets into the stage; it never
touches src/static itself.

  1. Asset versions. Every script, stylesheet and WebAssembly kernel is addressed as static/<file>?v=<hash> (the first 12 hex
     digits of the SHA-256 of its bytes), which the server answers `public, max-age=31536000, immutable`
     (serve_embedded_static.hpp), and only when the hash is the one of the bytes it serves: a page that was loaded
     once asks for none of them again until the binary changes. The map is injected as
     `window.__chdashAssetVersions = { "static/app_header.js": "..." }` right after <head> of every staged shell,
     before the head script whose __chdashUrl() reads it; the shell starts the page's entry module with it and
     app_assets.js reads it for the lazy modules, the kernels and the Worker. The shells HTML itself still revalidates,
     so a new binary is never paired with scripts of an older one. Served from the file system (no stage) the map
     is absent and the addresses are plain.

     The modules import each other by `./app_x.js`. The stage writes the hash of the imported module into every import
     (`./app_x.js?v=<hash>`), in dependency order, so the hash of a module covers the modules under it: the same
     address always means the same bytes, and the browser never runs a module of one build with a module of another.
     That needs the imports to have no cycle (tools/module_graph.py checks it).

  2. Pre-compressed copies. Text assets (HTML, JS, CSS, SVG, JSON) get a `<name>.gz` beside them (gzip
     level 9, no timestamp: the same bytes on every build), embedded like any other file; the server
     sends it to a client that accepts gzip (about a quarter of the bytes: 5 MB of text to 1.2 MB).

    python3 tools/stage_static.py DIR
"""
from __future__ import annotations

import gzip
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import module_graph  # noqa: E402

VERSIONED = (".js", ".css", ".wasm")
COMPRESSED = (".html", ".js", ".css", ".svg", ".json", ".txt", ".wasm")
# A copy that is not at least a tenth smaller is not worth a second embedded file.
MIN_BYTES = 512
MIN_GAIN = 0.9
VERSION_DIGITS = 12
MARKER = "<head>"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:VERSION_DIGITS]


def version_modules(stage: Path) -> dict[str, str]:
    """Write the hash of each imported module into the imports of the staged modules, dependencies first.
    Returns { "app_x.js": hash } for every module of the stage."""
    texts = {path.name: path.read_text(encoding="utf-8") for path in sorted(stage.glob("app_*.js"))}
    imports = {name: module_graph.static_imports(name, text) for name, text in texts.items()}
    if (cycle := module_graph.cycle_in(imports)) is not None:
        raise ValueError("the modules import each other in a cycle: " + " -> ".join(cycle))
    done: dict[str, str] = {}
    visiting: list[str] = []

    def visit(name: str) -> None:
        if name in done:
            return
        visiting.append(name)
        for dep in imports[name]:
            if dep in imports:
                visit(dep)
        visiting.pop()
        text = module_graph.rewrite(texts[name], done)
        if text != texts[name]:
            (stage / name).write_text(text, encoding="utf-8")
        done[name] = digest(text.encode("utf-8"))

    for name in imports:
        visit(name)
    return done


def versions(stage: Path) -> dict[str, str]:
    """{ "static/<path>": hash } for every script and stylesheet of the stage."""
    modules = version_modules(stage)
    out = {}
    for path in sorted(stage.rglob("*")):
        if not path.is_file() or path.suffix not in VERSIONED:
            continue
        relative = path.relative_to(stage).as_posix()
        out["static/" + relative] = modules[path.name] if path.parent == stage and path.name in modules else digest(path.read_bytes())
    return out


def inject(html: str, mapping: dict[str, str]) -> str:
    """The versions map right after <head> (once)."""
    script = "<script>window.__chdashAssetVersions=" + json.dumps(mapping, separators=(",", ":"), sort_keys=True) + ";</script>"
    # A shell that was staged before takes the new map (a second run changes nothing but the map).
    html = re.sub(r"\n  <script>window\.__chdashAssetVersions=.*?;</script>", "", html, count=1, flags=re.S)
    at = html.index(MARKER) + len(MARKER)
    return html[:at] + "\n  " + script + html[at:]


def compress(stage: Path) -> int:
    count = 0
    for path in sorted(stage.rglob("*")):
        if not path.is_file() or path.suffix not in COMPRESSED:
            continue
        raw = path.read_bytes()
        if len(raw) < MIN_BYTES:
            continue
        packed = gzip.compress(raw, compresslevel=9, mtime=0)
        if len(packed) <= len(raw) * MIN_GAIN:
            path.with_name(path.name + ".gz").write_bytes(packed)
            count += 1
    return count


def stage(directory: Path) -> tuple[int, int]:
    """Version the staged shells and write the compressed copies: (versioned files, .gz files)."""
    for stale in directory.rglob("*.gz"):
        stale.unlink()
    mapping = versions(directory)
    for shell in sorted(directory.glob("*.html")):
        shell.write_text(inject(shell.read_text(encoding="utf-8"), mapping), encoding="utf-8")
    return len(mapping), compress(directory)


def main(argv: list[str]) -> int:
    if len(argv) != 1 or not Path(argv[0]).is_dir():
        print(__doc__, file=sys.stderr)
        return 2
    versioned, packed = stage(Path(argv[0]))
    print(f"stage_static: {versioned} versioned files, {packed} compressed copies", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
