"""One manifest of pages, one entry module per page, one header partial for every page shell.

src/static/modules.json lists the pages and their lazy groups; a page is its entry module
(app_page_<page>.js) and the ES modules it imports (tools/module_graph.py). The browser loads them in dependency order;
app_loader.js loads the lazy groups with import(); the shell adds the entry as a module script (tools/page_shells.py) and
tools/build_page_css.py reads the same graph. No loader keeps a list of its own and nothing parses a list out of code.
The same script writes the generated regions of the shells: the header from src/shell/header.html and the page's
description.
"""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def load_tool(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_shells():
    import sys

    sys.path.insert(0, str(ROOT / "tools"))
    return load_tool("page_shells")


def manifest() -> dict:
    return json.loads(read("src/static/modules.json"))


PAGES = tuple(manifest()["pages"])


def test_every_page_has_one_entry_and_every_module_is_on_a_page():
    graph = load_tool("module_graph")
    data = manifest()
    # The manifest is the one list of pages: one shell (<page>.html) and one entry module for each, and no other shell.
    assert {path.stem for path in STATIC.glob("*.html")} == set(PAGES)
    assert graph.problems() == []
    for page, entry in data["pages"].items():
        assert entry["entry"] == f"app_page_{page}.js", page
        assert set(entry) <= {"entry", "label", "main", "nav", "lazy"}, page
        assert entry["label"] and entry["main"], page
        assert entry.get("nav", "") in ("", "explorer", "observability", "system"), page
        text = read(f"src/static/{entry['entry']}")
        # Every entry runs the common modules first and ends with boot(): the document is parsed, the handle is set, a
        # failing start is shown.
        assert text.index('import "./app_common.js";') < text.index("boot("), page
        if page not in ("trace", "shape", "mcp"):
            assert "boot(" in text.split("import ")[-1], page
    # The Worker script of the WebAssembly kernels is the one script that is on no page (app_wasm.js starts it by name).
    shipped = {path.name for path in STATIC.glob("app_*.js")}
    on_pages = set().union(*(set(graph.page_modules(page, data)) for page in PAGES))
    assert shipped - on_pages == {"app_wasm_worker.js"}


def test_one_loader_and_no_script_tag_or_module_list_in_code():
    loader = read("src/static/app_loader.js")
    assert "export const loader = Object.freeze({ page, url: assetUrl, loadGroup, expose: exposeNamespaces });" in loader
    assert 'document.getElementById("chdashModules")' in loader
    assert "import(address.toString())" in loader
    for path in sorted(STATIC.glob("*.js")):
        text = path.read_text(encoding="utf-8")
        # Modules import their siblings; no file builds a <script> and nothing lists the modules of a page in code.
        assert 'createElement("script")' not in text, path.name
        assert "startModules" not in text, path.name
        if path.name not in ("app_loader.js", "app_wasm_worker.js"):
            assert not re.search(r"\bimport\(", text), path.name
    # Lazy groups load through the loader, by group name.
    assert "loader.loadGroup(QUERY_LIBRARY_GROUP)" in read("src/static/app_query_ui.js")
    assert "loader.loadGroup(CORE_GROUP)" in read("src/static/app_query_chart.js")
    assert 'loader.loadGroup("wasm-highlight")' in read("src/static/app_highlight.js")
    # The entries of the Observability and System pages hand their view to one controller.
    assert 'startObservabilityPage("traces", traces)' in read("src/static/app_page_traces.js")
    assert 'startSystemPage("queries")' in read("src/static/app_page_queries.js")


def test_css_builder_reads_the_module_graph_not_code():
    builder = read("tools/build_page_css.py")
    for gone in ("COMMON_MODULES", "VIEW_MODULES", "PAGE_SKIPPED_MODULES", "SCRIPT_NAME", "SKIPPED_ENTRY", "LOADER"):
        assert gone not in builder, gone
    assert "module_graph.page_modules(page)" in builder
    assert "page_shells.page_entry" in read("tools/page_shells.py") or "def page_entry" in read("tools/page_shells.py")


def test_shells_carry_the_current_header_and_manifest_entry():
    shells = load_shells()
    outputs = shells.build()
    for path, text in outputs.items():
        assert path.read_text(encoding="utf-8") == text, f"{path.name} is stale: run python3 tools/build_page_css.py"
    headers = {}
    for page in PAGES:
        html = read(f"src/static/{page}.html")
        region = html[html.index("<!-- shell:header -->"):html.index("<!-- /shell:header -->")]
        assert region.count('<header class="appHeader" role="banner">') == 1, page
        assert html.count('<header class="appHeader"') == 1, page
        # The theme button holds the three sprite icons; CSS shows the head script's
        # mode (html[data-theme-mode]) from the first paint on every page.
        for mode, name in (("system", "device-desktop"), ("dark", "moon"), ("light", "sun")):
            assert f'themeIcon themeIcon--{mode}" aria-hidden="true"><use href="/static/icons.svg?v=' in region, (page, mode)
            assert f'#i-{name}"/>' in region, (page, name)
        assert 'class="appBrand__logo"' in region, page
        headers[page] = region.splitlines()
        scripts = html[html.index("<!-- shell:scripts -->"):html.index("<!-- /shell:scripts -->")]
        payload = re.search(r'<script type="application/json" id="chdashModules">(.*?)</script>', scripts).group(1)
        assert json.loads(payload) == shells.page_entry(page), page
        entry = shells.page_entry(page)
        assert entry["files"][-1] == entry["entry"] and "app_loader.js" in entry["files"], page
        # The shell preloads the modules and imports the entry; a failure to load shows the page's own message.
        assert 'link.rel = "modulepreload";' in scripts and 'entry.type = "module";' in scripts and "window.__chdashFatal(" in scripts, page
    # One header: the shells differ only in the page they name (the page
    # select's label and its options' state).
    for page in ("explorer", "traces", "logs", "metrics"):
        assert len(headers[page]) == len(headers["query"]), page
        for mine, other in zip(headers[page], headers["query"]):
            if mine != other:
                assert re.search(r'id="(pageSelectButton|navQueryButton|navExplorerButton|navObservabilityButton)"|class="skipLink"', mine), (page, mine)
