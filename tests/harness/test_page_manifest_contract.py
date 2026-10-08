"""One module manifest and one header partial for every page shell.

src/static/modules.json lists the modules of every page (common first, then the
page's own, its lazy groups and, on Observability, each view's). app_loader.js
(ns.loader) loads them, app.js and app_obs_page.js start from it, and
tools/build_page_css.py reads it as JSON: no loader keeps a list of its own and
nothing parses a list out of code. The same script writes the generated regions
of the shells: the header from src/shell/header.html and the page's manifest
entry.
"""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"
PAGES = ("query", "explorer", "functions", "traces", "logs", "metrics", "trace", "system", "queries", "disks", "shape")
# Shipped but listed nowhere (none: the former Server operations is the
# System Overview's Activity, app_system_activity.js).
# The Worker script of the WebAssembly kernels (ns.wasm.worker): not a module of a page.
UNLISTED: set[str] = {"app_wasm_worker.js"}


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def load_shells():
    spec = importlib.util.spec_from_file_location("page_shells", ROOT / "tools" / "page_shells.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def manifest() -> dict:
    return json.loads(read("src/static/modules.json"))


def listed(data: dict) -> set[str]:
    names = set(data["common"]) | {"app_loader.js"}
    for page in data["pages"].values():
        names |= {page["bootstrap"], *page["modules"]}
        for group in ("lazy", "views"):
            for files in (page.get(group) or {}).values():
                names |= set(files)
    return names


def test_every_module_is_listed_once_per_page_and_exists():
    data = manifest()
    assert set(data["pages"]) == set(PAGES)
    names = listed(data)
    for name in names:
        assert (STATIC / name).is_file(), name
    shipped = {path.name for path in STATIC.glob("*.js")}
    assert shipped - names == UNLISTED, sorted(shipped - names)
    for page, entry in data["pages"].items():
        eager = data["common"] + entry["modules"]
        assert len(eager) == len(set(eager)), page
        assert not set(data["common"]) & set(entry["modules"]), page


def test_one_loader_and_no_module_list_or_script_tag_in_code():
    loader = read("src/static/app_loader.js")
    assert "ns.loader = Object.freeze({ page, base: () => base, url, load, startModules, group, loadGroup });" in loader
    assert 'document.getElementById("chdashModules")' in loader
    assert "el.async = false;" in loader
    for path in sorted(STATIC.glob("*.js")):
        if path.name == "app_loader.js":
            continue
        text = path.read_text(encoding="utf-8")
        # Modules come from the manifest: no file names a script, none inserts one.
        # The one script that no page lists is the Worker of the WebAssembly kernels: app_wasm.js starts it by name
        # and gives it its own file name to load.
        assert not re.search(r"""["'`]app_[a-z_]*\.js["'`]""", text.replace('"app_wasm_worker.js"', "").replace('"app_wasm.js"', "")), path.name
        assert 'createElement("script")' not in text, path.name
    assert "return loader.startModules();" in read("src/static/app.js")
    obs = read("src/static/app_obs_page.js")
    assert "await ns.loader.startModules();" in obs
    assert "ns.loader.loadGroup(QUERY_LIBRARY_GROUP)" in read("src/static/app_ui.js")
    assert "ns.loader.loadGroup(CORE_GROUP)" in read("src/static/app_query_chart.js")


def test_css_builder_reads_the_manifest_not_code():
    builder = read("tools/build_page_css.py")
    for gone in ("COMMON_MODULES", "VIEW_MODULES", "PAGE_SKIPPED_MODULES", "SCRIPT_NAME", "SKIPPED_ENTRY"):
        assert gone not in builder, gone
    assert "page_shells.page_entry(page)" in builder


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
        assert scripts.index('static/app_loader.js") :') < scripts.index(f'static/{shells.page_entry(page)["bootstrap"]}") :'), page
    # One header: the shells differ only in the page they name (the page
    # select's label and its options' state).
    for page in ("explorer", "traces", "logs", "metrics"):
        assert len(headers[page]) == len(headers["query"]), page
        for mine, other in zip(headers[page], headers["query"]):
            if mine != other:
                assert re.search(r'id="(pageSelectButton|navQueryButton|navExplorerButton|navObservabilityButton)"', mine), (page, mine)
