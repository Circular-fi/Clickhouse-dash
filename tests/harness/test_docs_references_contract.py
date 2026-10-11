"""The documents name files of src/static: each name must exist (ARCH-F-287: docs/ui-foundations.md named
app_observability.js, which was gone, and a sheet that no page loads)."""
import re
from pathlib import Path

import css_sources

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src/static"
DOCS = sorted((ROOT / "docs").glob("*.md")) + [ROOT / "README.md", ROOT / "CONTRIBUTING.md", ROOT / "tests/README.md"]
# A name in a document that is not a file on purpose: the placeholder of an example.
EXAMPLES = {"app_x.js"}


def cited(pattern):
    found = []
    for doc in DOCS:
        for number, line in enumerate(doc.read_text(encoding="utf-8").splitlines(), start=1):
            for match in re.finditer(pattern, line):
                found.append((doc.relative_to(ROOT).as_posix(), number, match.group(1)))
    return found


def test_every_script_a_document_names_exists():
    scripts = {path.name for path in STATIC.glob("*.js")}
    missing = [(doc, line, name) for doc, line, name in cited(r"\b(app_[a-z0-9_]+\.js)\b") if name not in scripts and name not in EXAMPLES]
    assert missing == []


def test_every_stylesheet_source_a_document_names_exists():
    sources = {path.relative_to(STATIC / "css").as_posix() for path in (STATIC / "css").rglob("*.css")}
    missing = []
    for doc, line, name in cited(r"`(?:css/)?((?:10-components|20-features)/[a-z0-9-]+\.css)`"):
        if name not in sources:
            missing.append((doc, line, name))
    assert missing == []


def test_every_page_sheet_a_document_names_is_one_that_a_page_loads():
    sheets = set(css_sources.sheets())
    named = {name for _doc, _line, name in cited(r"`(style\.[a-z]+\.css)`")}
    assert named <= sheets, sorted(named - sheets)


def test_the_component_and_feature_files_of_the_foundations_table_are_the_files_of_the_directories():
    doc = (ROOT / "docs/ui-foundations.md").read_text(encoding="utf-8")
    row = lambda start: next(line for line in doc.splitlines() if line.startswith(start))
    components = set(re.findall(r"`([a-z-]+)`", row("| `10-components/<name>.css`").split("one file per shared component:", 1)[1].split(".", 1)[0]))
    assert components == {path.stem for path in (STATIC / "css/10-components").glob("*.css")}
    features = set(re.findall(r"`([a-z-]+)`", row("| `20-features/<name>.css`").split("| features |", 1)[1]))
    assert features == {path.stem for path in (STATIC / "css/20-features").glob("*.css")}
