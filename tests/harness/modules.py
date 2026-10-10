"""The module graph of the frontend, for the contract tests (tools/module_graph.py: ES modules and the pages built from them)."""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"

_spec = importlib.util.spec_from_file_location("module_graph", ROOT / "tools" / "module_graph.py")
graph = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(graph)


def common_modules() -> list[str]:
    """The modules every page runs first, in the order app_common.js imports them."""
    return re.findall(r'^import "\./(app_[a-z_]+\.js)";', (STATIC / "app_common.js").read_text(encoding="utf-8"), flags=re.M)


def page_files(page: str) -> list[str]:
    """The modules the page's entry imports, dependencies first, the entry last."""
    return graph.page_files(page)


def page_modules(page: str) -> list[str]:
    """Everything the page can run: its modules, its lazy groups and what those import."""
    return graph.page_modules(page)


def lazy_groups(page: str) -> dict[str, list[str]]:
    return dict(graph.manifest()["pages"][page].get("lazy") or {})


def imports(name: str) -> list[str]:
    return graph.static_imports(name)


PAGES = tuple(graph.manifest()["pages"])  # the one list of pages: src/static/modules.json


def read_family(prefix: str) -> str:
    """The text of the modules that one module was split into (app_results.js, app_results_values.js, ...), for a contract on the family."""
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(STATIC.glob(f"{prefix}*.js")))
