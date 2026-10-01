"""One keyboard focus ring: a global :focus-visible outline no rule can remove."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSS = (ROOT / "src" / "static" / "style.css").read_text(encoding="latin-1")
# The Query editor textarea keeps its own focus treatment (Query page).
EXEMPT = "#queryTextArea"


def rules():
    text = re.sub(r"/\*.*?\*/", " ", CSS, flags=re.S)
    for match in re.finditer(r"([^{}]*)\{([^{}]*)\}", text):
        selector = " ".join(match.group(1).split())
        if selector and not selector.startswith("@"):
            yield selector, match.group(2)


def test_global_focus_visible_ring_is_the_only_important_outline():
    ring = re.search(r":where\(a\[href\], [^{]*\):focus-visible \{\n  outline: 2px solid var\(--focusRingColor\) !important;", CSS)
    assert ring, "the global :focus-visible ring is missing"
    assert "textarea:not(#queryTextArea)" in ring.group(0)
    important = [selector for selector, body in rules() if re.search(r"outline\s*:[^;]*!important", body)]
    assert len(important) == 1 and important[0].startswith(":where(a[href]"), important


def test_no_focus_rule_removes_the_outline():
    kills = [
        selector
        for selector, body in rules()
        if ":focus" in selector and EXEMPT not in selector and re.search(r"outline\s*:\s*(none|0)\b", body)
    ]
    assert not kills, kills
    assert "Keep keyboard focus neutral" not in CSS


def test_ring_token_is_the_same_two_pixel_ring_in_every_theme():
    assert "--ring: 0 0 0 2px var(--focusRingColor);" in CSS
    assert CSS.count("--ring:") == 1
    for block in ('html[data-theme="dark"] {', 'html[data-theme="light"] {'):
        start = CSS.index(block)
        assert "--focusRingColor:" in CSS[start : CSS.index("}", start)], block
