"""Repository hygiene: what must never be in the authored sources, whatever the feature.

These are code rules, not contracts of a feature: a leaked business name or fixture schema, or a merge marker, is a
fault in whatever file it sits.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def test_project_authored_sources_do_not_embed_business_fixture_names() -> None:
    # Why: the project is generic; a name of a customer or a dataset in a source or a fixture is a leak.
    def word(*parts: str) -> re.Pattern[str]:
        return re.compile(r"\b" + "".join(parts) + r"\b", re.I)

    needles = [
        word("cir", "cular"),
        word("kev", "red"),
        word("nan", "sen"),
        word("raku", "rai"),
        word("fa", "st"),
        word("pro", "vider"),
        word("tip", "share"),
        word("user", "_plans"),
        re.compile("dark" + "_tip", re.I),
        word("blocks", "_markets"),
    ]
    roots = [ROOT / "src", ROOT / "tests", ROOT / "README.md"]
    offenders = []
    for root in roots:
        paths = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
        for path in paths:
            if any(part in {"build", "node_modules", "third_party", "__pycache__", "artifacts"} for part in path.parts):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            # The slug of the repository's own organisation (clone and release URLs, the address of the Pages site) is not a leak.
            text = re.sub(r"circular-fi", "", text, flags=re.I)
            for needle in needles:
                if needle.search(text):
                    offenders.append(f"{path.relative_to(ROOT)}: {needle.pattern}")
    assert offenders == []


def test_production_source_has_no_fixture_database_coupling() -> None:
    # Why: chdash_ui is the test fixture database; production code that names it would only work on the test stack.
    matches = []
    for path in (ROOT / "src").rglob("*"):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if "chdash_ui" in text:
            matches.append(str(path.relative_to(ROOT)))
    assert not matches, f"fixture database leaked into production source: {matches}"


def test_no_merge_conflict_marker_in_static_sources() -> None:
    # Why: a stray marker line invalidates the CSS rule after it (the data table tokens once went missing that way).
    marker = re.compile(r"^(<{7}|={7}|>{7})( |$)", re.M)
    for path in sorted(STATIC.glob("*")):
        if path.suffix in {".css", ".js", ".html", ".json"}:
            assert not marker.search(path.read_text(encoding="utf-8")), path.name
