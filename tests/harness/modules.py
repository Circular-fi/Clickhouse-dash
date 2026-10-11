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


# The modules of the Explorer controller family, in the order of the former app_explorer.js (the card, the graph, the storage views and the
# treemap are modules of their own and are not part of it).
EXPLORER_CORE = ("app_explorer_summary.js", "app_explorer_route.js", "app_explorer_store.js", "app_explorer_shell.js", "app_explorer_doc.js",
                 "app_explorer_functions.js", "app_explorer_tree.js", "app_explorer_data.js", "app_explorer_database.js", "app_explorer_table.js",
                 "app_explorer.js")


def read_explorer() -> str:
    """The text of the Explorer controller and of the modules it was split into, for a contract on the Explorer as one unit."""
    return "\n".join((STATIC / name).read_text(encoding="utf-8") for name in EXPLORER_CORE)


def read_explorer_detail() -> str:
    """The text of the table card (app_explorer_detail.js and the modules it was split into: model, cells, header, about, columns, storage,
    operations, preview), for a contract on the card as one unit."""
    return read_family("app_explorer_detail")


def read_card_module(part: str = "") -> str:
    """One module of the table card: "" is app_explorer_detail.js (tabs, body, facade); "model", "cells", "about", "columns", "storage",
    "operations", "preview" or "header" is app_explorer_detail_<part>.js."""
    name = f"app_explorer_detail{'_' + part if part else ''}.js"
    return (STATIC / name).read_text(encoding="utf-8")


def function_text(source: str, name: str) -> str:
    """The text of one function (`function name(`, `async function name(` or `const name =`) of a module's source, up to its closing line."""
    match = re.search(rf"^(?:async )?function {re.escape(name)}\(|^const {re.escape(name)}\b", source, flags=re.M)
    assert match, name
    end = re.compile(r"^[}\]];?$", re.M).search(source, match.start())
    assert end, name
    return source[match.start():end.end()]
