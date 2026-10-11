"""One manifest of pages, one entry module per page, one generated header for every page shell.

src/static/modules.json lists the pages and their lazy groups; a page is its entry module (app_page_<page>.js) and the ES
modules it imports (tools/module_graph.py). tools/page_shells.py writes the generated regions of the shells (the header from
src/shell/header.html, the script block with the page's modules) and tools/build_page_css.py reads the same graph. These checks
keep the manifest, the shells and the entries in step: they compare generated output with what is committed and the shells
with one another, they do not freeze the text of a shell.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import modules

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"
PAGES = modules.PAGES


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def load_tool(name: str):
    sys.path.insert(0, str(ROOT / "tools"))
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_page_has_one_shell_one_entry_and_every_module_is_on_a_page():
    graph = load_tool("module_graph")
    data = graph.manifest()
    assert {path.stem for path in STATIC.glob("*.html")} == set(PAGES)
    assert graph.problems() == []
    for page, entry in data["pages"].items():
        assert entry["entry"] == f"app_page_{page}.js", page
        assert set(entry) <= {"entry", "label", "main", "nav", "lazy"}, page
        assert entry["label"] and entry["main"], page
        assert entry.get("nav", "") in ("", "explorer", "observability", "system"), page
    # The Worker script of the WebAssembly kernels is the one script that is on no page (app_wasm.js starts it by name).
    shipped = {path.name for path in STATIC.glob("app_*.js")}
    on_pages = set().union(*(set(graph.page_modules(page, data)) for page in PAGES))
    assert shipped - on_pages == {"app_wasm_worker.js"}


def test_the_shells_carry_the_generated_header_and_the_manifest_entry():
    shells = load_tool("page_shells")
    for path, text in shells.build().items():
        assert path.read_text(encoding="utf-8") == text, f"{path.name} is stale: run python3 tools/build_page_css.py"
    headers = {}
    for page in PAGES:
        html = read(f"src/static/{page}.html")
        region = html[html.index("<!-- shell:header -->"):html.index("<!-- /shell:header -->")]
        assert region.count('<header class="appHeader" role="banner">') == 1, page
        headers[page] = region.splitlines()
        scripts = html[html.index("<!-- shell:scripts -->"):html.index("<!-- /shell:scripts -->")]
        payload = re.search(r'<script type="application/json" id="chdashModules">(.*?)</script>', scripts).group(1)
        assert json.loads(payload) == shells.page_entry(page), page
        entry = shells.page_entry(page)
        assert entry["files"][-1] == entry["entry"] and "app_loader.js" in entry["files"], page
    # One header: the shells differ only in the page they name (the page select's label and its options' state).
    for page in ("explorer", "traces", "logs", "metrics"):
        assert len(headers[page]) == len(headers["query"]), page
        for mine, other in zip(headers[page], headers["query"]):
            if mine != other:
                assert re.search(r'id="(pageSelectButton|nav(Query|Explorer|Observability|System|Mcp)Link)"|class="skipLink"', mine), (page, mine)


def test_every_shell_lists_every_page_and_has_one_h1_in_its_main():
    # Why: the page switcher is the same everywhere; a shell that misses a link strands the person on it. One h1 inside the main landmark.
    shells = load_tool("page_shells")
    for page in PAGES:
        html = read(f"src/static/{page}.html")
        for link in ("navQueryLink", "navExplorerLink", "navObservabilityLink", "navSystemLink", "navMcpLink"):
            assert f'id="{link}"' in html, (page, link)
        assert len(re.findall(r"<h1\b", html)) == 1, page
    assert set(shells.MAIN_ID) == set(shells.SHELLS)
    assert not (STATIC / "index.html").exists(), "the former index.html copy of query.html is gone (it drifted)"


def test_every_shell_loads_its_own_stylesheet_with_a_parser_inserted_link():
    # Why: a link written by document.write blocks the first paint, so the page never shows unstyled; a script-inserted one does not.
    for page in PAGES:
        html = read(f"src/static/{page}.html")
        assert f'window.__chdashUrl("static/style.{page}.css")' in html, page
        assert "document.write('<link rel=\"stylesheet\" href=\"' + cssHref + '\">');" in html, page
