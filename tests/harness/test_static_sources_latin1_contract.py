import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def test_scripts_and_stylesheets_stay_latin1_so_chrome_keeps_them_one_byte():
    # Chrome keeps every script and stylesheet source in memory for the life of
    # the page, as one byte per character only when no character is above
    # U+00FF. A single "..." (U+2026) or arrow doubles the whole file. Write such
    # characters as escapes instead: "…" in JavaScript, "\2026" in CSS.
    offenders = []
    for path in sorted([*STATIC.glob("*.js"), *STATIC.glob("*.css")]):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            match = re.search(r"[^\x00-\xff]", line)
            if match:
                offenders.append(f"{path.name}:{number}: U+{ord(match.group(0)):04X}")
    assert not offenders, "\n".join(offenders[:20])
