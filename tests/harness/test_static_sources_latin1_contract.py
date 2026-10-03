import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


# Binary assets (the web fonts, images) and the font licence (verbatim, UTF-8) are not sources.
BINARY = {".woff2", ".woff", ".ico", ".png", ".svg"}


def text_sources():
    """The scripts, the stylesheet sources and a sheet a local build left at the top."""
    return sorted([*STATIC.glob("*.js"), *STATIC.glob("*.css"), *(STATIC / "css").rglob("*.css")])


def test_binary_assets_are_not_read_as_sources():
    sources = text_sources()
    assert sources and all(path.suffix in (".js", ".css") for path in sources)
    fonts = sorted((STATIC / "fonts").iterdir())
    assert {path.suffix for path in fonts} == {".woff2", ".txt"} and not set(fonts) & set(sources)
    assert {path.suffix for path in fonts if path.suffix != ".txt"} <= BINARY


def test_scripts_and_stylesheets_stay_latin1_so_chrome_keeps_them_one_byte():
    # Chrome keeps every script and stylesheet source in memory for the life of
    # the page, as one byte per character only when no character is above
    # U+00FF. A single "..." (U+2026) or arrow doubles the whole file. Write such
    # characters as escapes instead: "…" in JavaScript, "\2026" in CSS.
    offenders = []
    for path in text_sources():
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            match = re.search(r"[^\x00-\xff]", line)
            if match:
                offenders.append(f"{path.name}:{number}: U+{ord(match.group(0)):04X}")
    assert not offenders, "\n".join(offenders[:20])
