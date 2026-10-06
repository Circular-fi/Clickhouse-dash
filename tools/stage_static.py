#!/usr/bin/env python3
"""Prepare the staged static files (the directory CMake embeds into the binary) for the network.

Run by CMake after tools/build_page_css.py has written the page stylesheets into the stage; it never
touches src/static itself.

  1. Asset versions. Every script and stylesheet is addressed as static/<file>?v=<hash> (the first 12 hex
     digits of the SHA-256 of its bytes), which the server answers `public, max-age=31536000, immutable`
     (serve_embedded_static.hpp): a page that was loaded once asks for none of them again until the
     binary changes. The map is injected as `window.__chdashAssetVersions = { "static/app.js": "..." }`
     right after <head> of every staged shell, before the head script whose __chdashUrl() reads it, and
     app_loader.js reads it for the modules it loads. The shells HTML itself still revalidates, so a new
     binary is never paired with scripts of an older one. Served from the file system (no stage) the map
     is absent and the addresses are plain.

  2. Pre-compressed copies. Text assets (HTML, JS, CSS, SVG, JSON) get a `<name>.gz` beside them (gzip
     level 9, no timestamp: the same bytes on every build), embedded like any other file; the server
     sends it to a client that accepts gzip (about a quarter of the bytes: 5 MB of text to 1.2 MB).

    python3 tools/stage_static.py DIR
"""
from __future__ import annotations

import gzip
import hashlib
import json
import sys
from pathlib import Path

VERSIONED = (".js", ".css")
COMPRESSED = (".html", ".js", ".css", ".svg", ".json", ".txt")
# A copy that is not at least a tenth smaller is not worth a second embedded file.
MIN_BYTES = 512
MIN_GAIN = 0.9
VERSION_DIGITS = 12
MARKER = "<head>"


def versions(stage: Path) -> dict[str, str]:
    """{ "static/<path>": hash } for every script and stylesheet of the stage."""
    out = {}
    for path in sorted(stage.rglob("*")):
        if path.is_file() and path.suffix in VERSIONED:
            out["static/" + path.relative_to(stage).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()[:VERSION_DIGITS]
    return out


def inject(html: str, mapping: dict[str, str]) -> str:
    """The versions map right after <head> (once)."""
    script = "<script>window.__chdashAssetVersions=" + json.dumps(mapping, separators=(",", ":"), sort_keys=True) + ";</script>"
    if "window.__chdashAssetVersions=" in html:
        raise ValueError("the shell already carries an asset version map")
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
