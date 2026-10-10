"""The multi-word keyword patterns of the highlighter (app_highlight.js) run in linear time.

The gap between two words (`GROUP … BY`) once was `(?:\\s+|comment)+`: a run of n blanks could be split
in 2^n ways, and a failed match (`AS group`, a newline and about 30 blanks, no BY) tried them all,
freezing the tab on each key press. The pattern is run here, as written in the source, on such
inputs with a time budget, and on the gaps it must still accept or refuse.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "src" / "static" / "app_highlight.js"


def gap_pattern() -> str:
    text = SOURCE.read_text(encoding="utf-8")
    unit = re.search(r"const gapUnit = String\.raw`([^`]*)`;", text)
    gap = re.search(r"const ws = String\.raw`([^`]*)`;", text)
    assert unit and gap, "app_highlight.js: the gap patterns (gapUnit, ws) are missing"
    return gap.group(1).replace("${gapUnit}", unit.group(1))


def keyword(first: str, second: str) -> re.Pattern[str]:
    return re.compile(rf"\b{first}{gap_pattern()}{second}\b", re.IGNORECASE)


def test_failed_keyword_matches_are_linear() -> None:
    group_by = keyword("GROUP", "BY")
    left_array_join = re.compile(
        rf"\bLEFT{gap_pattern()}ARRAY{gap_pattern()}JOIN\b", re.IGNORECASE)
    inputs = [
        "SELECT a AS group\n" + " " * 50_000 + "x",
        "SELECT a AS group\n" + "\t \n" * 20_000 + "x",
        "group " + "/* a */ " * 5_000 + "x",
        "group " + "/* a */" * 5_000 + " x",
        "group " + "-- c\n " * 10_000 + "x",
        "group " + "# c\n" * 10_000 + "x",
        "group /*" + " " * 20_000,
        "group /* " + "-- */\n" * 3_000 + "x",
    ]
    for text in inputs:
        for pattern in (group_by, left_array_join):
            started = time.perf_counter()
            pattern.search(text)
            elapsed = time.perf_counter() - started
            assert elapsed < 2.0, f"{elapsed:.2f} s on {text[:30]!r}… ({len(text)} chars)"


def test_gaps_still_accepted_and_refused() -> None:
    group_by = keyword("GROUP", "BY")
    accepted = [
        "GROUP BY", "group   by", "GROUP\n BY", "GROUP\t\r\nBY", "GROUP /* c */ BY",
        "GROUP /* a */ /* b */BY", "GROUP/**/BY", "GROUP /* x*y **/ BY", "GROUP -- c\n BY",
        "GROUP # c\nBY",
        # A block comment may reach a later `*/` (as the WASM kernel reads it, highlight.c ws_loop).
        "GROUP /* x */ y */ BY", "GROUP /* a */ BY */BY",
    ]
    refused = ["GROUPBY", "GROUP /* c BY", "GROUP -- BY", "GROUP x BY", "GROUP # BY"]
    for text in accepted:
        assert group_by.search(text), f"not matched: {text!r}"
    for text in refused:
        assert not group_by.search(text), f"matched: {text!r}"
