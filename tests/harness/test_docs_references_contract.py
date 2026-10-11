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


def test_the_foundations_doc_lists_every_export_of_format_and_palette_and_every_semantic_token():
    # Why: docs/ui-foundations.md is the reference of ns.format and ns.palette; an export that it does not list is one that nobody knows to use.
    from test_css_tokens_contract import SEMANTIC_TOKENS

    doc = (ROOT / "docs/ui-foundations.md").read_text(encoding="utf-8")

    def exported(source: str, namespace: str) -> list[str]:
        block = re.search(rf"export const {namespace} = Object\.freeze\(\{{(.*?)\}}\);", source, re.S).group(1)
        return re.findall(r"^\s*(\w+),?$", block, re.M)

    fmt_source = (STATIC / "app_format.js").read_text(encoding="utf-8")
    fmt = exported(fmt_source, "format")
    pal = exported((STATIC / "app_palette.js").read_text(encoding="utf-8"), "palette")
    assert {"duration", "count", "compact", "bytes", "percent", "time", "range"} <= set(fmt) and {"categorical", "service", "severity"} <= set(pal)
    adapters = re.findall(r"^\s*duration\.(\w+) = ", fmt_source, re.M)
    names = [f"format.{n}" for n in fmt] + [f"format.duration.{n}" for n in adapters] + [f"palette.{n}" for n in pal]
    missing = [name for name in names if f"`{name}" not in doc]
    assert not missing, f"docs/ui-foundations.md does not list {missing}"
    missing_tokens = [token for token in SEMANTIC_TOKENS if f"`{token}`" not in doc]
    assert not missing_tokens, missing_tokens


def test_every_test_file_a_document_names_exists():
    # Why: the documents send a reader to a test; a renamed or retired file leaves a pointer to nothing (this cleanup left a dozen).
    tests = ROOT / "tests"
    present = {path.name for pattern in ("test_*.py", "*.spec.js", "*.test.cjs", "*_test.cpp") for path in tests.rglob(pattern) if "node_modules" not in path.parts}
    missing = []
    for doc, line, name in cited(r"\b(test_[a-z0-9_]+\.py|[a-z0-9-]+\.spec\.js|[a-z0-9-]+\.test\.cjs|[a-z0-9_]+_test\.cpp)\b"):
        if name not in present:
            missing.append((doc, line, name))
    assert missing == [], missing
